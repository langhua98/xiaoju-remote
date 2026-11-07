import Foundation

/// 大疆 DUML v1 帧（OM 手机云台内部用的协议）。
/// 照着 langhua98/Linggo 仓库里 `ble.html`（「OM BLE 控制台」）在 OM6 上实测过的写法逐字节翻译，别自己改：
/// CRC 初值、字节顺序错一点，云台就不认。Tests/main.swift 拿 ble.html 算出来的帧逐字节核对（编译前在 Mac 上跑）。
///
///     55 | 长度+版本(2,LE：低 10 位 = 总长，高 6 位 = 版本 1) | CRC8(前 3 字节) | src | dst | seq(2,LE) | flags | cmdSet | cmdId | 载荷 | CRC16(2,LE)
///
/// 只用 Foundation，电脑上也能编（swiftc）。
enum Duml {
    // MARK: CRC（查表法，和 ble.html 一样：CRC8 多项式 0x8C 初值 0x77，CRC16 多项式 0x8408 初值 0x3692）

    private static let t8: [UInt8] = (0..<256).map { i -> UInt8 in
        var c = UInt8(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0x8C : c >> 1 }
        return c
    }

    private static let t16: [UInt16] = (0..<256).map { i -> UInt16 in
        var c = UInt16(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0x8408 : c >> 1 }
        return c
    }

    static func crc8(_ bytes: [UInt8]) -> UInt8 {
        var c: UInt8 = 0x77
        for x in bytes { c = t8[Int(x ^ c)] }
        return c
    }

    static func crc16(_ bytes: [UInt8]) -> UInt16 {
        var c: UInt16 = 0x3692
        for x in bytes { c = (c >> 8) ^ t16[Int((UInt16(x) ^ c) & 0xff)] }
        return c
    }

    // MARK: 发

    /// 组一帧。src 0x02 = 手机 App，dst 0x04 = 云台；flags 0x40 = 要应答。
    static func frame(seq: UInt16, flags: UInt8 = 0, cmdSet: UInt8, cmdId: UInt8, payload: [UInt8] = [],
                      src: UInt8 = 0x02, dst: UInt8 = 0x04) -> [UInt8] {
        let total = 13 + payload.count
        let lv = (1 << 10) | total
        let head: [UInt8] = [0x55, UInt8(lv & 0xff), UInt8((lv >> 8) & 0xff)]
        var b = head
        b += [crc8(head), src, dst, UInt8(seq & 0xff), UInt8(seq >> 8), flags, cmdSet, cmdId]
        b += payload
        let c = crc16(b)
        b += [UInt8(c & 0xff), UInt8(c >> 8)]
        return b
    }

    /// 有符号 16 位，小端
    static func i16(_ v: Int) -> [UInt8] {
        let u = UInt16(bitPattern: Int16(clamping: v))
        return [UInt8(u & 0xff), UInt8(u >> 8)]
    }

    /// 速度指令 04/0c 的载荷：偏航、横滚、俯仰（各 2 字节）、模式 0x80（速度）、time。
    /// 单位不是度：OM6 实测 1 单位 ≈ 0.11 °/s（见 Gimbal.degPerUnit）。要每 0.1 秒发一帧，停发云台自己停。
    static func speed(yaw: Int, pitch: Int, roll: Int = 0, time: UInt8 = 15) -> [UInt8] {
        i16(yaw) + i16(roll) + i16(pitch) + [0x80, time]
    }

    /// 停：零速（ble.html 收尾都发这一帧）
    static let stop: [UInt8] = [0, 0, 0, 0, 0, 0, 0x80, 1]

    // MARK: 收

    struct Frame {
        let src: UInt8, dst: UInt8, seq: UInt16, flags: UInt8, cmdSet: UInt8, cmdId: UInt8
        let payload: [UInt8]
        /// flags 最高位 = 这是应答（不是云台自己推的）
        var isAck: Bool { flags & 0x80 != 0 }
    }

    /// 蓝牙通知一包最多二十来个字节：一帧可能分好几包来，也可能几帧粘在一起。攒着拆。
    /// 和 ble.html 一样只验 CRC8（帧头），不验 CRC16。
    struct Parser {
        private var buf: [UInt8] = []

        mutating func push(_ data: [UInt8]) -> [Frame] {
            buf += data
            var out: [Frame] = []
            while buf.count >= 4 {
                guard let i = buf.firstIndex(of: 0x55) else { buf.removeAll(); break }
                if i > 0 { buf.removeFirst(i) }
                if buf.count < 4 { break }
                let len = (Int(buf[1]) | (Int(buf[2]) << 8)) & 0x3ff
                if len < 13 || len > 1024 || crc8(Array(buf[0..<3])) != buf[3] { buf.removeFirst(); continue }
                if buf.count < len { break }   // 半帧，等下一包
                let f = Array(buf[0..<len])
                buf.removeFirst(len)
                out.append(Frame(src: f[4], dst: f[5], seq: UInt16(f[6]) | (UInt16(f[7]) << 8), flags: f[8],
                                 cmdSet: f[9], cmdId: f[10], payload: Array(f[11..<(len - 2)])))
            }
            return out
        }
    }

    // MARK: 姿态 04/05（云台大约每秒推一帧）

    struct Attitude {
        /// 欧拉角（度）。OM6 是「+Y 朝下」装的，所以静止时 roll ≈ −89，不是歪了
        let yaw: Double, pitch: Double, roll: Double
        /// 机体系里的重力方向（单位向量）
        let gravity: [Double]

        /// 仰角（度，抬头为正）：重力落在 +Y 轴附近时，x 分量的反正弦就是俯仰偏差（OM6 实测：俯仰偏 6° → gx = +0.1045）。
        /// 云台被摆成别的姿态（重力不在 Y 轴附近）时测不了，返回 nil。
        var elevation: Double? {
            guard gravity.count == 3, abs(gravity[1]) >= 0.8 else { return nil }
            return asin(max(-1, min(1, gravity[0]))) * 180 / Double.pi
        }
    }

    /// 载荷 [24:40] = 四元数 w,x,y,z（float32，小端），OM6 上验证过模长 = 1。
    static func attitude(_ pl: [UInt8]) -> Attitude? {
        guard pl.count >= 40 else { return nil }
        func f(_ o: Int) -> Double {
            let bits = UInt32(pl[o]) | (UInt32(pl[o + 1]) << 8) | (UInt32(pl[o + 2]) << 16) | (UInt32(pl[o + 3]) << 24)
            return Double(Float(bitPattern: bits))
        }
        let w = f(24), x = f(28), y = f(32), z = f(36)
        let n = (w * w + x * x + y * y + z * z).squareRoot()
        guard n > 0.9, n < 1.1 else { return nil }
        let deg = 180 / Double.pi
        let roll = atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * deg
        let pitch = asin(max(-1, min(1, 2 * (w * y - z * x)))) * deg
        let yaw = atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * deg
        // 世界系的「下」(0,0,-1) 转回机体系 = 旋转矩阵第三行取反
        let g = [-(2 * (x * z - w * y)), -(2 * (y * z + w * x)), -(1 - 2 * (x * x + y * y))]
        return Attitude(yaw: yaw, pitch: pitch, roll: roll, gravity: g)
    }

    /// 角度差折到 -180…180
    static func wrap(_ d: Double) -> Double {
        var v = d.truncatingRemainder(dividingBy: 360)
        if v >= 180 { v -= 360 }
        if v < -180 { v += 360 }
        return v
    }
}
