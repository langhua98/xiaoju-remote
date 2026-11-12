import Foundation

/// 遥控指令 `{"do":"robot", "action": …}`：从另一台设备控制屏幕里的 3D 角色。
/// 动作、镜头、转身、视线、表情、换装、说话都能控制，回执里带 `robot`（现在的状态）。
/// 协议说明见 AGENTS.md「机器人（robot 指令）」，网页一侧的消息见 Robot/README.md。
@MainActor
enum RobotCommand {
    static let actionsHelp = "status、act、view、turn、look、emotion、outfit、say、reset"

    static func run(_ cmd: [String: Any], face: FaceBridge, talk: Talk, store: Store) async -> CmdResult {
        let action = (cmd["action"] as? String) ?? "status"
        guard face.isReady else {
            return CmdResult(text: "机器人的脸没打开（App 不在前台，或者页面还在加载）")
        }
        switch action {
        case "status":
            return CmdResult(text: await describe(face))

        case "act":
            let raw = string(cmd["name"])
            guard !raw.isEmpty else { return CmdResult(text: "act 要带 name，可以是：\(Body.actionNames)，或者英文名、动画名") }
            let name = Body.actionID(named: raw) ?? raw
            let ok = await face.request(["type": "action", "name": name]) as? Bool ?? false
            return CmdResult(text: ok ? "在做：\(raw)" : "不会这个动作：\(raw)（会的：\(Body.actionNames)）")

        case "view":
            var msg: [String: Any] = ["type": "view"]
            let shotRaw = string(cmd["shot"])
            if !shotRaw.isEmpty {
                guard let shot = Body.shotID(named: shotRaw) else { return CmdResult(text: "没有这种镜头：\(shotRaw)（有：\(Body.shotNames)，或者 auto、full、bust、face）") }
                msg["shot"] = shot
            }
            if let v = number(cmd["orbit"]) { msg["orbit"] = v }
            if let v = number(cmd["tilt"]) { msg["tilt"] = v }
            guard msg.count > 1 else { return CmdResult(text: "view 要带 shot、orbit、tilt 里至少一个") }
            let r = await face.request(msg) as? [String: Any] ?? [:]
            return CmdResult(text: "镜头：\(shotName(r["shot"] as? String))，绕 \(int(r["orbit"]))°，俯仰 \(int(r["tilt"]))°")

        case "turn":
            var msg: [String: Any] = ["type": "turn"]
            if let by = number(cmd["by"]) { msg["by"] = by }
            else if let yaw = number(cmd["yaw"]) { msg["yaw"] = yaw }
            else if let dir = cmd["direction"] as? String { msg["yaw"] = Body.turnYaw(direction: dir, degrees: number(cmd["degrees"])) }
            else { return CmdResult(text: "turn 要带 yaw（转到多少度）、by（再转多少度）或者 direction（left、right、back、center）") }
            let r = await face.request(msg) as? [String: Any] ?? [:]
            let yaw = int(r["yaw"])
            return CmdResult(text: yaw == 0 ? "面向屏幕" : "转到 \(yaw)°（正 = 转向屏幕右边）")

        case "look":
            var msg: [String: Any] = ["type": "look"]
            if (cmd["free"] as? Bool) == true { msg["free"] = true }
            else {
                msg["x"] = number(cmd["x"]) ?? 0
                msg["y"] = number(cmd["y"]) ?? 0
                if let ms = number(cmd["ms"]) { msg["ms"] = ms }
            }
            _ = await face.request(msg)
            return CmdResult(text: msg["free"] != nil ? "视线放开了" : "看向 x=\(msg["x"]!)，y=\(msg["y"]!)")

        case "emotion":
            let name = string(cmd["name"])
            let all = ["neutral", "happy", "alert", "surprised", "confused"]
            guard all.contains(name) else { return CmdResult(text: "emotion 的 name 只能是：\(all.joined(separator: "、"))") }
            var msg: [String: Any] = ["type": "robot_state", "emotion": name]
            if let ms = number(cmd["ms"]), ms > 0 { msg["duration_ms"] = ms }
            face.send(msg)
            return CmdResult(text: "表情：\(name)")

        case "outfit":
            let raw = string(cmd["id"]).isEmpty ? string(cmd["name"]) : string(cmd["id"])
            guard let id = Store.outfitID(named: raw) else {
                return CmdResult(text: "没有这套衣服：\(raw)（有：\(Store.outfits.map { "\($0.name)（\($0.id)）" }.joined(separator: "、"))）")
            }
            store.outfit = id   // RobotModeView 看到变化会发给脸
            return CmdResult(text: "换装：\(Store.outfitName(id))")

        case "say":
            let text = string(cmd["text"])
            guard !text.isEmpty else { return CmdResult(text: "say 要带 text") }
            let ok = talk.speak(text, emotion: string(cmd["emotion"]).isEmpty ? "neutral" : string(cmd["emotion"]))
            return CmdResult(text: ok ? "在说：\(text)" : "她正在实时语音聊天，没有插话")

        case "reset":
            _ = await face.request(["type": "reset"])
            return CmdResult(text: "回到默认：自动镜头、面向屏幕、平静")

        default:
            return CmdResult(text: "robot 不认识的 action：\(action)（可以用：\(actionsHelp)）")
        }
    }

    /// 回执里的 robot 字段：现在的状态（去掉动画名单，太长）
    static func status(_ face: FaceBridge) async -> [String: Any]? {
        guard var s = await face.status() else { return nil }
        s.removeValue(forKey: "clips")
        s.removeValue(forKey: "stats")
        return s
    }

    private static func describe(_ face: FaceBridge) async -> String {
        guard let s = await face.status() else { return "读不到状态" }
        let view = s["view"] as? [String: Any] ?? [:]
        var lines = [
            "衣服：\(Store.outfitName(s["outfit"] as? String ?? ""))",
            "状态：\(s["state"] as? String ?? "")，表情：\(s["emotion"] as? String ?? "")",
            "镜头：\(shotName(view["shot"] as? String))，绕 \(int(view["orbit"]))°，俯仰 \(int(view["tilt"]))°",
            "朝向：\(int(s["turn"]))°",
        ]
        if let a = s["action"] as? String, !a.isEmpty { lines.append("正在做：\(a)") }
        return lines.joined(separator: "\n")
    }

    private static func shotName(_ id: String?) -> String { Body.shots.first { $0.id == id }?.name ?? (id ?? "?") }
    private static func string(_ v: Any?) -> String { ((v as? String) ?? (v as? NSNumber)?.stringValue ?? "").trimmingCharacters(in: .whitespaces) }
    private static func number(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }
    private static func int(_ v: Any?) -> Int { Int(((v as? NSNumber)?.doubleValue ?? 0).rounded()) }
}
