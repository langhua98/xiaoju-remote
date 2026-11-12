import Foundation

/// 让大模型控制机器人的身体（大疆 OM 云台，见 Gimbal.swift）。
/// - 普通模式（DeepSeek）：回答里写动作标签 [左转 30] [右转 30] [抬头 15] [低头 15] [回正]，App 照着转，标签不念出来。
/// - 实时模式（Gemini Live）：工具调用 move_gimbal(direction, degrees)，转完把结果告诉模型。
/// 同样的办法也用来换衣服（[换装 洋装] / change_outfit）和让 3D 角色做动作（[动作 跳舞] / play_action）。
/// 方向：左 / 右按 Gimbal 的 yaw 负 / 正，上 / 下按 pitch 正 / 负（Gimbal 会自己学正负号；真机上反了就改这里）。
enum Body {
    static let personaForTags = """
    你能控制自己的身体：手机夹在大疆云台上，云台能左右转、上下抬头低头。主人让你转身、转头、看某个方向、抬头低头时，在回答里写动作标签，App 会照着转：
    [左转 30] [右转 30] [抬头 15] [低头 15] [回正]
    数字是度数，左右 5～90，上下 5～45。比如主人说「往左边看看」，你回答「好，我看看左边。[左转 45]」。不需要转的时候不要写标签，标签不会被念出来。
    你还能换衣服：主人让你换衣服时写 [换装 衣服名]，衣服名只能是：\(outfitNames)。比如「好呀，换上啦。[换装 洋装]」。
    你有一个 3D 的身体，能做动作：写 [动作 名字]，名字只能是：\(actionNames)。主人让你跳舞、挥手、比耶时就做；平时表示同意可以 [动作 点头]，不同意可以 [动作 摇头]，一次回答最多一个动作，不要每句都做。
    """

    static let personaForTool = """
    你能控制自己的身体：手机夹在大疆云台上，云台能左右转、上下抬头低头。主人让你转身、转头、看某个方向、抬头低头、回到正面时，调用 move_gimbal 工具真的去转，再告诉主人转好了。
    你还能换衣服：主人让你换衣服时调用 change_outfit 工具，衣服名只能是：\(outfitNames)；主人没说换哪套就换一套和现在不一样的。
    你有一个 3D 的身体，能做动作：主人让你跳舞、挥手、比耶、点头、摇头等时，调用 play_action 工具，动作名只能是：\(actionNames)。
    """

    static var outfitNames: String { Store.outfits.map { $0.name }.joined(separator: "、") }

    /// 3D 角色会做的动作：中文名 → 发给脸的名字（见 Robot/live2d/src/motion.js 的 ACTIONS）
    static let actions: [(name: String, id: String)] = [
        ("挥手", "wave"), ("点头", "nod"), ("摇头", "shake"), ("跳舞", "dance"), ("比耶", "peace"), ("飞吻", "kiss"),
        ("生气", "angry"), ("玩手机", "phone"), ("打游戏", "play"), ("看报纸", "read"), ("吃爆米花", "popcorn"),
    ]
    static var actionNames: String { actions.map { $0.name }.joined(separator: "、") }

    /// 动作的中文名（或者直接是 id）→ 发给脸的名字；不认识返回 nil
    static func actionID(named raw: String) -> String? {
        let text = Store.simplified(raw)
        if let a = actions.first(where: { $0.id == text.lowercased() }) { return a.id }
        return actions.first { text.contains($0.name) }?.id
    }

    /// 给 Gemini Live 的工具声明
    static let toolDeclaration: [String: Any] = [
        "functionDeclarations": [[
            "name": "move_gimbal",
            "description": "转动机器人的身体（大疆云台）：左右转、抬头低头，或者回到正面。",
            "parameters": [
                "type": "OBJECT",
                "properties": [
                    "direction": ["type": "STRING", "enum": ["left", "right", "up", "down", "center"],
                                  "description": "left 左转，right 右转，up 抬头，down 低头，center 回到正面"],
                    "degrees": ["type": "NUMBER", "description": "转多少度：左右 5～90，上下 5～45；center 不用填"],
                ],
                "required": ["direction"],
            ],
        ], [
            "name": "change_outfit",
            "description": "给机器人换衣服（3D 角色换装）。",
            "parameters": [
                "type": "OBJECT",
                "properties": [
                    "name": ["type": "STRING", "enum": Store.outfits.map { $0.name }, "description": "衣服名"],
                ],
                "required": ["name"],
            ],
        ], [
            "name": "play_action",
            "description": "让机器人的 3D 身体做一个动作：挥手、点头、摇头、跳舞、比耶等。",
            "parameters": [
                "type": "OBJECT",
                "properties": [
                    "name": ["type": "STRING", "enum": actions.map { $0.name }, "description": "动作名"],
                ],
                "required": ["name"],
            ],
        ]],
    ]

    private static let outfitPattern = #"\[\s*换装\s*[:：]?\s*([^\]]+?)\s*\]"#

    private static let actionPattern = #"\[\s*动作\s*[:：]?\s*([^\]]+?)\s*\]"#

    /// 回答里的动作标签 → 动作名
    static func actionTags(in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: actionPattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    /// 回答里的换装标签 → 衣服名
    static func outfitTags(in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: outfitPattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    /// 语音指令转动的速度（度每秒）
    static let speed = 60.0

    private static let tagPattern = #"\[\s*(左转|右转|抬头|低头|回正)\s*(\d+(?:\.\d+)?)?\s*度?\s*\]"#

    /// 找出一段文字里的动作标签，按出现顺序
    static func tags(in text: String) -> [(direction: String, degrees: Double?)] {
        guard let re = try? NSRegularExpression(pattern: tagPattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            let verb = ns.substring(with: m.range(at: 1))
            let deg = m.range(at: 2).location == NSNotFound ? nil : Double(ns.substring(with: m.range(at: 2)))
            let dir = ["左转": "left", "右转": "right", "抬头": "up", "低头": "down"][verb] ?? "center"
            return (dir, deg)
        }
    }

    /// 去掉动作标签（念出来之前）
    static func strip(_ text: String) -> String {
        text.replacingOccurrences(of: tagPattern, with: "", options: .regularExpression)
            .replacingOccurrences(of: outfitPattern, with: "", options: .regularExpression)
            .replacingOccurrences(of: actionPattern, with: "", options: .regularExpression)
    }

    /// 真的去转。返回一句给模型 / 记录看的结果
    @MainActor
    static func perform(_ gimbal: Gimbal, direction: String, degrees: Double?) async -> String {
        guard gimbal.connected else { return "云台没连上，转不了（请主人在设置页点「连接云台」）" }
        if gimbal.busy { gimbal.stopNow() }
        switch direction {
        case "left", "right", "up", "down":
            // 说话时要快：按固定速度转算好的时间（30° 只要半秒），不用一帧帧等姿态确认（那样每次要多等 2 秒）
            let horizontal = direction == "left" || direction == "right"
            let d = horizontal ? min(max(degrees ?? 30, 5), 90) : min(max(degrees ?? 15, 5), 45)
            // 上下在 OM6 真机上是反的（William 实测），所以「抬头」发负的俯仰速度
            let sign: Double = (direction == "left" || direction == "up") ? -1 : 1
            let seconds = d / speed
            gimbal.move(yawSpeed: horizontal ? sign * speed : 0, pitchSpeed: horizontal ? 0 : sign * speed, seconds: seconds)
            try? await Task.sleep(nanoseconds: UInt64((seconds + 0.2) * 1e9))
            return "转好了，大约\(["left": "左转", "right": "右转", "up": "抬头", "down": "低头"][direction]!) \(Int(d))°"
        default:
            // 回正要准：按姿态闭环转回归位点
            let result = await gimbal.command(["action": "center"])
            return result.components(separatedBy: "\n").first ?? result
        }
    }
}
