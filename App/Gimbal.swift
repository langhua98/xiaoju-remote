import CoreBluetooth
import Foundation

/// 大疆 OM 手机云台（OM6 上实测过；协议见 Duml.swift，来源是 langhua98/Linggo 仓库的 ble.html）。
/// 机器人模式里「云台是身体」：远程可以让它转头、转到指定角度、回到归位点；脸跟着云台的朝向转。
///
/// - 蓝牙低功耗：服务 FFF0，往 FFF5 写指令，FFF4 收推送。
/// - 转动只认速度指令 04/0c（OM6 不理绝对角度 04/14）：每 0.1 秒发一帧，停发云台自己停。
/// - 姿态 04/05 大约每秒一帧。「转到指定角度」边发速度边看姿态（闭环），两帧之间按速度标度推算，误差大约 ±2～5°。
/// - 偏航（左右）在 OM6 上验证过很多轮；俯仰（上下）也走同一套，方向不对会自己学（dirSign）。
///
/// 蓝牙回调都在主线程（CBCentralManager 用主队列），控制循环也在主线程跑，所以不用加锁。
final class Gimbal: NSObject, ObservableObject {
    enum Phase: String {
        case off = "未连接", scanning = "在找云台", connecting = "正在连接", ready = "已连接"
        case noBluetooth = "蓝牙关着", denied = "没有蓝牙权限", unsupported = "这台手机不支持蓝牙低功耗"
    }
    enum Axis: String { case yaw, pitch }

    @Published private(set) var phase: Phase = .off
    @Published private(set) var name = ""
    @Published private(set) var model = ""            // 版本应答里认出来的（OM6 的硬件号是 GB66）
    @Published private(set) var battery: Int?
    @Published private(set) var charging = false
    @Published private(set) var asleep = false
    @Published private(set) var attitude: Duml.Attitude?
    @Published private(set) var busy = false           // 正在转（闭环 / 定时转）
    @Published private(set) var note = ""

    /// 朝向变了（大约每秒一次）或者连接断了：(相对归位点的偏航, 相对归位点的俯仰, 连着没有)。给机器人的脸用。
    var onPose: (@Sendable (Double, Double, Bool) -> Void)?
    /// 日志
    var onLog: (@Sendable (String) -> Void)?

    static let service = CBUUID(string: "FFF0")
    static let notifyChar = CBUUID(string: "FFF4")
    static let writeChar = CBUUID(string: "FFF5")
    /// 问 iOS「系统里已经连着哪些设备」时要给服务号，只给 FFF0 常常拿不到：
    /// 在系统设置里连上的云台，iOS 记的多半是它的蓝牙快门（HID 1812）、电池（180F）、设备信息（180A）这些服务
    static let systemServices = [service, CBUUID(string: "1812"), CBUUID(string: "180F"), CBUUID(string: "180A")]
    static let namePrefixes = ["OM", "Osmo", "DJI"]

    // 闭环参数（和 ble.html 的 gotoRelative 一样）
    /// 速度标度：1 单位 ≈ 0.11 °/s（OM6 实测：100 单位连发量到 10.9°/s）
    static let degPerUnit = 0.11
    private static let tolerance = 2.0, lead = 0.8, minUnits = 40, maxUnits = 900, timeout: TimeInterval = 15

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var writer: CBCharacteristic?
    private var parser = Duml.Parser()
    private var seq: UInt16 = 1
    private var wantConnected = false
    private var attSeq = 0
    private var lastAttAt = Date.distantPast
    private var connectTimer: Timer?
    /// 这次找云台时连过、但不是 OM 云台（没有 FFF0/FFF5）的设备，扫描时跳过
    private var notGimbal = Set<UUID>()

    // 定时转（move）：每 0.1 秒发一帧，到时间发零速
    private var driveYaw = 0, drivePitch = 0
    private var driveUntil = Date.distantPast
    private var ticker: Timer?
    private var aborted = false

    /// 归位点（「回中」回到这里）：连上后第一帧姿态自动记下，也可以用 home 指令改
    private(set) var home: (yaw: Double, pitch: Double)?
    /// 速度单位的正负和欧拉角变化方向是否一致（不一致的话自己学，记在手机上）
    private var dirSign: [Axis: Double] = [.yaw: 1, .pitch: 1]

    private let d = UserDefaults.standard

    override init() {
        super.init()
        for ax in [Axis.yaw, .pitch] where d.double(forKey: "gimbalDir." + ax.rawValue) < 0 { dirSign[ax] = -1 }
    }

    var connected: Bool { phase == .ready }

    /// 相对归位点的朝向（度）。没连上返回 nil
    var pose: (yaw: Double, pitch: Double)? {
        guard let a = attitude, let h = home else { return nil }
        return (Duml.wrap(a.yaw - h.yaw), Duml.wrap(a.pitch - h.pitch))
    }

    // MARK: 连接

    func connect() {
        wantConnected = true
        if central == nil {
            // 第一次用才建：建的时候系统会弹蓝牙权限
            central = CBCentralManager(delegate: self, queue: .main)
            return   // 等 centralManagerDidUpdateState 说蓝牙开了再找
        }
        // 正在找、正在连的时候不重来（都有超时）；其他状态（没连上、蓝牙刚打开、上次失败）都重新开始
        if phase == .scanning || phase == .connecting || phase == .ready { return }
        notGimbal.removeAll()
        start()
    }

    func disconnect() {
        wantConnected = false
        stopNow()
        central?.stopScan()
        connectTimer?.invalidate(); connectTimer = nil
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil; writer = nil
        phase = .off
        onPose?(0, 0, false)
    }

    private func start() {
        guard let c = central, wantConnected else { return }
        switch c.state {
        case .poweredOn: break
        case .poweredOff: phase = .noBluetooth; note = "在控制中心或设置里打开蓝牙"; return
        case .unauthorized: phase = .denied; note = "在 设置 → Vania → 蓝牙 里打开权限"; return
        case .unsupported: phase = .unsupported; return
        default: return   // 蓝牙还在启动，centralManagerDidUpdateState 会再叫 start
        }
        // 1. 云台已经和这台手机连着（在系统设置里连的，或者刚用过 Mimo）：这时它不广播，扫描找不到，要直接拿
        if let p = systemConnected(logAll: true) {
            log("云台已经和手机连着：\(p.name ?? "云台")")
            attach(p, fallbackToScan: true)
            return
        }
        // 2. 上次连过的那台（不用扫描）
        if let s = d.string(forKey: "gimbalId"), let id = UUID(uuidString: s), !notGimbal.contains(id),
           let p = c.retrievePeripherals(withIdentifiers: [id]).first {
            attach(p, fallbackToScan: true)
            return
        }
        // 3. 扫描
        scan()
    }

    /// 系统里已经连着的云台（名字是 OM / Osmo / DJI 开头，或者 iOS 知道它有 FFF0）
    private func systemConnected(logAll: Bool = false) -> CBPeripheral? {
        guard let c = central, c.state == .poweredOn else { return nil }
        let all = c.retrieveConnectedPeripherals(withServices: Self.systemServices)
        if logAll {
            let names = all.map { $0.name ?? "（没名字）" }
            log(names.isEmpty ? "系统里没有连着的蓝牙设备（按 FFF0/1812/180F/180A 问）" : "系统里连着：\(names.joined(separator: "、"))")
        }
        let fff0 = Set(c.retrieveConnectedPeripherals(withServices: [Self.service]).map(\.identifier))
        return all.first { p in
            !notGimbal.contains(p.identifier)
                && (fff0.contains(p.identifier) || Self.namePrefixes.contains { (p.name ?? "").hasPrefix($0) })
        }
    }

    private func scan() {
        guard let c = central, c.state == .poweredOn else { return }
        peripheral = nil; writer = nil
        phase = .scanning
        note = "把云台打开、放在手机旁边"
        // OM 系列不一定在广播包里放 FFF0，所以不按服务过滤，按名字认（ble.html 也是这么找的）
        c.scanForPeripherals(withServices: nil, options: nil)
        log("开始扫描云台")
        // 扫描时每 2 秒再看一眼系统连接：在系统设置里连上云台后它就不广播了，只能这样拿到
        let t0 = Date()
        connectTimer?.invalidate()
        connectTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
            guard let self = self, self.phase == .scanning else { t.invalidate(); return }
            if let p = self.systemConnected() {
                t.invalidate()
                self.central?.stopScan()
                self.log("在系统连接里找到云台：\(p.name ?? "云台")")
                self.attach(p)
                return
            }
            guard Date().timeIntervalSince(t0) >= 30 else { return }
            t.invalidate()
            self.central?.stopScan()
            self.phase = .off
            self.note = "30 秒没找到云台：确认云台开着、没被别的手机（Mimo）连着。运行记录里有找到了哪些设备"
            _ = self.systemConnected(logAll: true)
        }
    }

    /// 连一台设备。iOS 的 connect 自己不会超时，所以这里 10 秒没连好就放弃：
    /// fallbackToScan = true（上次那台 / 系统里连着的那台）就改成扫描，否则报连不上。
    private func attach(_ p: CBPeripheral, fallbackToScan: Bool = false) {
        peripheral = p
        p.delegate = self
        name = p.name ?? "云台"
        phase = .connecting
        note = ""
        central?.connect(p, options: nil)
        connectTimer?.invalidate()
        connectTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
            guard let self = self, self.phase == .connecting, self.peripheral === p else { return }
            self.drop(p)
            if fallbackToScan {
                self.log("连不上上次那台云台，改成扫描")
                self.scan()
            } else {
                self.phase = .off
                self.note = "10 秒没连上云台：把云台关机再开，确认没被 Mimo 或别的手机连着"
                self.log("云台连接超时")
            }
        }
    }

    /// 放弃当前这台（之后它的回调都不理）
    private func drop(_ p: CBPeripheral) {
        if peripheral === p { peripheral = nil; writer = nil }
        central?.cancelPeripheralConnection(p)
    }

    /// 连上了却不是 OM 云台：记下来，换一台接着找
    private func notThisOne(_ p: CBPeripheral, _ why: String) {
        log("\(p.name ?? "这台设备")不是 OM 云台（\(why)），接着找")
        notGimbal.insert(p.identifier)
        if d.string(forKey: "gimbalId") == p.identifier.uuidString { d.removeObject(forKey: "gimbalId") }
        drop(p)
        scan()
    }

    private func lost(_ p: CBPeripheral, _ why: String) {
        guard peripheral === p else { return }   // 已经放弃的那台（超时、不是云台）的回调，不管
        connectTimer?.invalidate(); connectTimer = nil
        writer = nil
        busy = false
        ticker?.invalidate(); ticker = nil
        phase = .off
        note = why
        onPose?(0, 0, false)
        log("云台断开：\(why)")
        // 想连着的话 3 秒后重连（云台关机、走远了都会断）
        if wantConnected, let p = peripheral {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self = self, self.wantConnected, self.phase == .off, self.peripheral === p else { return }
                self.attach(p, fallbackToScan: true)
            }
        }
    }

    // MARK: 发帧

    private func nextSeq() -> UInt16 { seq = seq &+ 1; return seq }

    @discardableResult
    private func send(cmdSet: UInt8, cmdId: UInt8, payload: [UInt8] = [], flags: UInt8 = 0x40) -> Bool {
        guard let p = peripheral, let w = writer else { return false }
        let bytes = Duml.frame(seq: nextSeq(), flags: flags, cmdSet: cmdSet, cmdId: cmdId, payload: payload)
        let noResp = w.properties.contains(.writeWithoutResponse)
        let type: CBCharacteristicWriteType = noResp ? .withoutResponse : .withResponse
        // 速度帧是周期性的，发不出去（缓冲满）就丢这一帧，下一帧接上
        if noResp, !p.canSendWriteWithoutResponse { return false }
        let n = max(20, p.maximumWriteValueLength(for: type))
        var i = 0
        while i < bytes.count {
            p.writeValue(Data(bytes[i..<min(i + n, bytes.count)]), for: w, type: type)
            i += n
        }
        return true
    }

    private func sendSpeed(yaw: Int, pitch: Int) {
        let y = Int(Double(yaw) * (dirSign[.yaw] ?? 1)), pt = Int(Double(pitch) * (dirSign[.pitch] ?? 1))
        send(cmdSet: 0x04, cmdId: 0x0c, payload: Duml.speed(yaw: y, pitch: pt))
    }

    /// 马上停（零速），也停掉定时转
    func stopNow() {
        aborted = true
        ticker?.invalidate(); ticker = nil
        driveYaw = 0; drivePitch = 0
        send(cmdSet: 0x04, cmdId: 0x0c, payload: Duml.stop)
    }

    // MARK: 收帧

    private func handle(_ f: Duml.Frame) {
        switch (f.cmdSet, f.cmdId) {
        case (0x04, 0x05):
            guard let a = Duml.attitude(f.payload) else { return }
            attitude = a
            attSeq += 1
            lastAttAt = Date()
            if home == nil { home = (a.yaw, a.pitch); log("记下归位点：偏航 \(fmt(a.yaw))，俯仰 \(fmt(a.pitch))") }
            if let p = pose { onPose?(p.yaw, p.pitch, true) }
        case (0x05, 0x06):
            // 电池：[0] 电量 %，最后一个字节 1 = 在充电
            guard let pct = f.payload.first else { return }
            battery = Int(pct)
            charging = f.payload.last == 1
        case (0x04, 0x27) where f.payload.count >= 5:
            asleep = f.payload[4] & 0x01 != 0   // 第 5 个字节最低位 = 睡眠模式
        case (0x00, 0x01) where f.payload.count >= 6:
            let ascii = String(f.payload.map { (32..<127).contains($0) ? Character(UnicodeScalar($0)) : "." })
            if ascii.contains("GB66") { model = "OM6" }
            else if f.payload.count >= 18 {
                model = String(decoding: f.payload[2..<18].filter { $0 != 0 }, as: UTF8.self)
            }
            log("云台型号：\(model.isEmpty ? "未知" : model)")
        default:
            break
        }
    }

    // MARK: 动作

    /// 按速度转一会儿（°/s，正负见 dirSign），到时间自己停。
    func move(yawSpeed: Double, pitchSpeed: Double, seconds: Double) {
        guard connected else { return }
        aborted = false
        driveYaw = clampUnits(yawSpeed / Self.degPerUnit)
        drivePitch = clampUnits(pitchSpeed / Self.degPerUnit)
        driveUntil = Date().addingTimeInterval(min(max(seconds, 0.1), 5))
        if ticker == nil {
            ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        }
        tick()
    }

    private func tick() {
        if aborted || Date() >= driveUntil || (driveYaw == 0 && drivePitch == 0) {
            ticker?.invalidate(); ticker = nil
            driveYaw = 0; drivePitch = 0
            send(cmdSet: 0x04, cmdId: 0x0c, payload: Duml.stop)
            return
        }
        sendSpeed(yaw: driveYaw, pitch: drivePitch)
    }

    private func clampUnits(_ u: Double) -> Int {
        let v = Int(u.rounded())
        return v == 0 ? 0 : (v > 0 ? 1 : -1) * min(Self.maxUnits, abs(v))
    }

    /// 闭环转动：相对现在转 delta 度（照 ble.html 的 gotoRelative）。返回 (实际转了多少, 结果)。
    /// 结果：done 到了 / stall 转到一半不动（到头了或被卡住）/ noexec 一点没动 / timeout / abort / nofeedback
    @MainActor
    func turn(_ axis: Axis, by delta: Double) async -> (traveled: Double, verdict: String) {
        guard connected, attitude != nil else { return (0, "nofeedback") }
        if abs(delta) < Self.tolerance { return (0, "done") }
        aborted = false
        busy = true
        defer { busy = false; stopNow() }

        func value(_ a: Duml.Attitude) -> Double { axis == .yaw ? a.yaw : a.pitch }
        var prev = value(attitude!), seen = attSeq
        var traveled = 0.0, est = 0.0, units = 0
        var hits = 0, frozen = 0, flipped = false
        var last = Date()
        let t0 = Date()

        while true {
            let now = Date()
            est += Double(units) * Self.degPerUnit * now.timeIntervalSince(last)   // 两帧姿态之间靠推算
            last = now

            if attSeq != seen, let a = attitude {   // 来了新的实测值
                seen = attSeq
                let step = Duml.wrap(value(a) - prev)
                prev = value(a)
                // 方向反了（发正速度角度却在变小）：记下来，以后都反着发
                if !flipped, units != 0, abs(step) >= 1.5, (step > 0) != (units > 0) {
                    flipped = true
                    let s = -(dirSign[axis] ?? 1)
                    dirSign[axis] = s
                    d.set(s, forKey: "gimbalDir." + axis.rawValue)
                    log("云台\(axis == .yaw ? "左右" : "上下")方向和预想的相反，已改过来")
                }
                traveled += step
                est = traveled
                let e = delta - traveled
                hits = abs(e) < Self.tolerance ? hits + 1 : 0                // 到位只认实测
                frozen = (units != 0 && abs(step) < 0.3) ? frozen + 1 : 0   // 还在发速度却连着两帧不动
                if hits >= 2 { return (traveled, "done") }
                if frozen >= 2 { return (traveled, abs(traveled) < 1 ? "noexec" : "stall") }
            }
            if aborted { return (traveled, "abort") }
            if !connected { return (traveled, "abort") }
            if now.timeIntervalSince(t0) > Self.timeout { return (traveled, "timeout") }
            if Date().timeIntervalSince(lastAttAt) > 5 { return (traveled, "nofeedback") }

            let err = delta - est
            if abs(err) < Self.tolerance { units = 0 }                     // 死区：不发速度，等实测确认
            else {
                let want = Int((err / Self.lead / Self.degPerUnit).rounded())   // 比例控制，大约 0.8 秒收敛
                units = (want > 0 ? 1 : -1) * min(Self.maxUnits, max(Self.minUnits, abs(want)))
            }
            if axis == .yaw { sendSpeed(yaw: units, pitch: 0) } else { sendSpeed(yaw: 0, pitch: units) }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    // MARK: 远程指令 {"do":"gimbal","action":…}

    /// 返回回执文字。动作：status / connect / disconnect / turn(yaw,pitch 相对度数) / look(yaw,pitch 相对归位点)
    /// / move(yaw,pitch 度每秒, ms) / stop / center / home（把现在的朝向记成归位点）
    @MainActor
    func command(_ cmd: [String: Any]) async -> String {
        let action = (cmd["action"] as? String) ?? "status"
        func num(_ k: String) -> Double? { (cmd[k] as? NSNumber)?.doubleValue ?? (cmd[k] as? Double) }

        switch action {
        case "connect":
            connect()
            // 最多等 20 秒（上次那台连不上要 10 秒，再扫描找一会儿）
            for _ in 0..<200 where !connected && phase != .off && phase != .noBluetooth && phase != .denied && phase != .unsupported {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            return connected ? "云台已连接。\n" + status() : "还没连上云台：\(phase.rawValue)。\(note)"
        case "disconnect":
            disconnect()
            return "已断开云台"
        case "status":
            return status()
        default:
            break
        }
        guard connected else { return "云台没连上（\(phase.rawValue)）。先发 {\"do\":\"gimbal\",\"action\":\"connect\"}，或者在 App 里点「连接云台」。" }
        if busy, action != "stop" { return "云台正在转，先发 stop" }

        switch action {
        case "stop":
            stopNow()
            return "已停。\n" + status()
        case "home":
            if let a = attitude { home = (a.yaw, a.pitch) }
            return "已把现在的朝向记成归位点"
        case "move":
            let secs = min(max((num("ms") ?? 500) / 1000, 0.1), 5)
            move(yawSpeed: num("yaw") ?? 0, pitchSpeed: num("pitch") ?? 0, seconds: secs)
            try? await Task.sleep(nanoseconds: UInt64((secs + 1.2) * 1e9))   // 等它转完、姿态更新一帧
            return "转了 \(String(format: "%.1f", secs)) 秒。\n" + status()
        case "turn", "look", "center":
            var dy = 0.0, dp = 0.0
            if action == "turn" {
                dy = num("yaw") ?? 0; dp = num("pitch") ?? 0
            } else if let p = pose {
                let ty = action == "center" ? 0 : (num("yaw") ?? p.yaw)
                let tp = action == "center" ? 0 : (num("pitch") ?? p.pitch)
                dy = Duml.wrap(ty - p.yaw); dp = tp - p.pitch
            } else {
                return "还没收到云台姿态，等一两秒再试"
            }
            var lines: [String] = []
            for (ax, delta) in [(Axis.yaw, dy), (Axis.pitch, dp)] where abs(delta) >= Self.tolerance {
                let r = await turn(ax, by: delta)
                lines.append("\(ax == .yaw ? "左右" : "上下") 目标 \(fmt(delta))，实际 \(fmt(r.traveled))：\(verdictText(r.verdict))")
                if r.verdict == "abort" { break }
            }
            return (lines.isEmpty ? "已经在那个方向了" : lines.joined(separator: "\n")) + "\n" + status()
        default:
            return "不认识的云台动作：\(action)（可以用 status、connect、disconnect、turn、look、move、stop、center、home）"
        }
    }

    func status() -> String {
        var s = "云台：\(name.isEmpty ? "大疆 OM" : name)\(model.isEmpty ? "" : "（\(model)）")，\(phase.rawValue)"
        if let b = battery { s += "，电量 \(b)%\(charging ? "（在充电）" : "")" }
        if asleep { s += "，在睡眠" }
        if let p = pose {
            s += "\n朝向（相对归位点）：左右 \(fmt(p.yaw))，上下 \(fmt(p.pitch))"
        }
        if let el = attitude?.elevation { s += "\n镜头仰角：\(fmt(el))" }
        if !note.isEmpty, !connected { s += "\n\(note)" }
        return s
    }

    /// 给回执用的结构化状态
    func statusJSON() -> [String: Any] {
        var o: [String: Any] = ["connected": connected, "phase": phase.rawValue, "name": name, "model": model, "busy": busy]
        if let b = battery { o["battery"] = b; o["charging"] = charging }
        if let p = pose { o["yaw"] = (p.yaw * 10).rounded() / 10; o["pitch"] = (p.pitch * 10).rounded() / 10 }
        if let el = attitude?.elevation { o["elevation"] = (el * 10).rounded() / 10 }
        return o
    }

    private func verdictText(_ v: String) -> String {
        switch v {
        case "done": return "到了"
        case "stall": return "转到一半不动了（可能到头了或被挡住）"
        case "noexec": return "云台一点没动（可能在睡眠，或者被 Mimo 占着）"
        case "timeout": return "15 秒没转到"
        case "nofeedback": return "收不到云台的姿态"
        default: return "停了"
        }
    }

    private func fmt(_ v: Double) -> String { String(format: "%+.0f°", v) }
    private func log(_ s: String) { onLog?(s) }
}

// MARK: - 蓝牙回调（都在主线程）

extension Gimbal: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn: if wantConnected, phase != .ready, phase != .connecting { start() }
        case .poweredOff:
            connectTimer?.invalidate(); connectTimer = nil
            peripheral = nil; writer = nil
            phase = .noBluetooth; note = "在控制中心或设置里打开蓝牙"
            onPose?(0, 0, false)
        case .unauthorized: phase = .denied; note = "在 设置 → Vania → 蓝牙 里打开权限"
        case .unsupported: phase = .unsupported
        default: break
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData ad: [String: Any], rssi RSSI: NSNumber) {
        let n = p.name ?? (ad[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        let svcs = (ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        guard !notGimbal.contains(p.identifier), phase == .scanning,
              Self.namePrefixes.contains(where: { n.hasPrefix($0) }) || svcs.contains(Self.service) else { return }
        c.stopScan()
        connectTimer?.invalidate(); connectTimer = nil
        log("找到云台：\(n)")
        attach(p)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        guard peripheral === p else { return }
        // 连接计时器先留着：找服务、找特征也算在 10 秒里，卡在这一步也会超时
        parser = Duml.Parser()
        p.discoverServices([Self.service])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        lost(p, "连不上：\(error?.localizedDescription ?? "未知原因")")
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        lost(p, error?.localizedDescription ?? "云台关了或走远了")
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === p else { return }
        if let e = error { lost(p, "读不到云台的服务：\(e.localizedDescription)"); drop(p); return }
        guard let s = p.services?.first(where: { $0.uuid == Self.service }) else {
            notThisOne(p, "没有 FFF0 服务")
            return
        }
        p.discoverCharacteristics([Self.notifyChar, Self.writeChar], for: s)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        guard peripheral === p else { return }
        if let e = error { lost(p, "读不到云台的特征：\(e.localizedDescription)"); drop(p); return }
        for ch in s.characteristics ?? [] {
            if ch.uuid == Self.writeChar { writer = ch }
            if ch.uuid == Self.notifyChar { p.setNotifyValue(true, for: ch) }
        }
        guard writer != nil else { notThisOne(p, "没有 FFF5 写特征"); return }
        // 确认是 OM 云台了才记住，下次直接连（以前连上就记，连错一台以后每次都先去连那台）
        connectTimer?.invalidate(); connectTimer = nil
        d.set(p.identifier.uuidString, forKey: "gimbalId")
        phase = .ready
        note = ""
        log("云台已连接：\(name)")
        // 问一次版本（全项目最安全的只读帧），顺便认型号
        send(cmdSet: 0x00, cmdId: 0x01)
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        if let e = error { log("订阅云台推送失败：\(e.localizedDescription)（收不到姿态，转到指定角度会不准）") }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard peripheral === p, let v = ch.value else { return }
        for f in parser.push([UInt8](v)) { handle(f) }
    }
}
