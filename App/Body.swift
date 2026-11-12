import Foundation

/// 让大模型控制机器人的身体（大疆 OM 云台，见 Gimbal.swift）。
/// - 普通模式（DeepSeek）：回答里写动作标签 [左转 30] [右转 30] [抬头 15] [低头 15] [回正]，App 照着转，标签不念出来。
/// - 实时模式（Gemini Live）：工具调用 move_gimbal(direction, degrees)，转完把结果告诉模型。
/// 同样的办法也用来换衣服（[换装 洋装] / change_outfit）、让 3D 角色做动作（[动作 跳舞] / play_action）、
/// 转身（[转身 左 90] / turn_body）和换镜头（[镜头 特写] / set_camera）。
/// 方向：左 / 右按 Gimbal 的 yaw 负 / 正，上 / 下按 pitch 正 / 负（Gimbal 会自己学正负号；真机上反了就改这里）。
enum Body {
    static let personaForTags = """
    你能控制自己的身体：手机夹在大疆云台上，云台能左右转、上下抬头低头。主人让你转身、转头、看某个方向、抬头低头时，在回答里写动作标签，App 会照着转：
    [左转 30] [右转 30] [抬头 15] [低头 15] [回正]
    数字是度数，左右 5～90，上下 5～45。比如主人说「往左边看看」，你回答「好，我看看左边。[左转 45]」。不需要转的时候不要写标签，标签不会被念出来。
    你还能换衣服：主人让你换衣服时写 [换装 衣服名]，衣服名只能是：\(outfitNames)。比如「好呀，换上啦。[换装 洋装]」。
    你有一个 3D 的身体，能做动作：写 [动作 名字]，名字只能是：\(actionNames)。主人让你跳舞、挥手、比耶时就做；平时表示同意可以 [动作 点头]，不同意可以 [动作 摇头]，一次回答最多一个动作，不要每句都做。
    屏幕里的你还能转身：[转身 左 90] [转身 右 45] [转身 回正]（数字是度数，0～180，背对主人是 180）；主人让你转过去、给他看看背后、侧过身时用。
    屏幕的镜头也能换：[镜头 全身] [镜头 半身] [镜头 特写] [镜头 自动]；主人想看你全身、想凑近看看你的脸时用。
    """

    static let personaForTool = """
    你能控制自己的身体：手机夹在大疆云台上，云台能左右转、上下抬头低头。主人让你转身、转头、看某个方向、抬头低头、回到正面时，调用 move_gimbal 工具真的去转，再告诉主人转好了。
    你还能换衣服：主人让你换衣服时调用 change_outfit 工具，衣服名只能是：\(outfitNames)；主人没说换哪套就换一套和现在不一样的。
    你有一个 3D 的身体，能做动作：主人让你跳舞、挥手、比耶、点头、摇头等时，调用 play_action 工具，动作名只能是：\(actionNames)。
    屏幕里的你还能转身：主人让你转过去、侧过身、给他看看背后时，调用 turn_body 工具。
    屏幕的镜头也能换：主人想看你全身、半身，或者凑近看你的脸时，调用 set_camera 工具。
    """

    static var outfitNames: String { Store.outfits.map { $0.name }.joined(separator: "、") }

    /// 3D 角色会做的动作：中文名 → 发给脸的名字（见 Robot/live2d/src/motion.js 的 ACTIONS）
    static let actions: [(name: String, id: String)] = [
        ("挥手", "wave"), ("点头", "nod"), ("摇头", "shake"), ("跳舞", "dance"), ("比耶", "peace"), ("飞吻", "kiss"),
        ("生气", "angry"), ("玩手机", "phone"), ("打游戏", "play"), ("看报纸", "read"), ("吃爆米花", "popcorn"),
        ("摆姿势", "pose"), ("打电话", "call"), ("边吃边聊", "Popcorn_talking"),
        ("慢舞", "dance_90bpm"), ("快舞", "dance_120bpm"), ("律动", "f_vibe_dance_60_bpm_002"),
        ("摸头", "touch_head"), ("摸左手", "touch_hand_l"), ("摸右手", "touch_hand_r"), ("摸左腿", "touch_leg_l"), ("摸右腿", "touch_leg_r"),
    ]

    /// 聊天框左边快捷菜单的全部内容，也是能直接打字执行的全部短指令（打名字就行，不问大模型）。
    /// 每一项：名字 + 发给脸的消息；msg 是 nil 的当成一句话交给 Talk（换装）。
    static let menu: [(title: String, items: [(name: String, msg: [String: Any]?)])] = {
        func act(_ names: [String]) -> [(name: String, msg: [String: Any]?)] {
            names.map { n in (n, ["type": "action", "name": actions.first { $0.name == n }?.id ?? n]) }
        }
        func emo(_ name: String, _ id: String) -> (name: String, msg: [String: Any]?) {
            (name, id == "neutral" ? ["type": "robot_state", "emotion": id] : ["type": "robot_state", "emotion": id, "duration_ms": 5000])
        }
        return [
            ("动作", act(["挥手", "点头", "摇头", "比耶", "飞吻", "摆姿势", "生气"])),
            ("舞蹈", act(["跳舞", "慢舞", "快舞", "律动"])),
            ("道具", act(["玩手机", "打电话", "打游戏", "看报纸", "吃爆米花", "边吃边聊"])),
            ("互动", act(["摸头", "摸左手", "摸右手", "摸左腿", "摸右腿"])),
            ("表情", [emo("开心", "happy"), emo("惊讶", "surprised"), emo("疑惑", "confused"), emo("警觉", "alert"), emo("平静", "neutral")]),
            ("镜头", shots.map { s in (s.name, ["type": "view", "shot": s.id]) } + [
                ("正面", ["type": "view", "orbit": 0, "tilt": 0]),
                ("左侧", ["type": "view", "orbit": -45]), ("右侧", ["type": "view", "orbit": 45]),
                ("背面", ["type": "view", "orbit": 180]),
                ("俯视", ["type": "view", "tilt": 25]), ("仰视", ["type": "view", "tilt": -15]), ("平视", ["type": "view", "tilt": 0]),
            ]),
            ("转身", [
                ("向左转", ["type": "turn", "yaw": 90]), ("向右转", ["type": "turn", "yaw": -90]),
                ("左转一点", ["type": "turn", "by": 30]), ("右转一点", ["type": "turn", "by": -30]),
                ("背对", ["type": "turn", "yaw": 180]), ("转回来", ["type": "turn", "yaw": 0]),
            ]),
            ("视线", [
                ("看左边", ["type": "look", "x": -0.9, "y": 0, "ms": 8000]), ("看右边", ["type": "look", "x": 0.9, "y": 0, "ms": 8000]),
                ("看上面", ["type": "look", "x": 0, "y": -0.9, "ms": 8000]), ("看下面", ["type": "look", "x": 0, "y": 0.9, "ms": 8000]),
                ("看我", ["type": "look", "free": true]),
            ]),
            ("换装", outfitsMenu),
            ("其他", [("停下", ["type": "action", "name": "stop"]), ("重置", ["type": "reset"])]),
        ]
    }()
    private static var outfitsMenu: [(name: String, msg: [String: Any]?)] { Store.outfits.map { ("换上" + $0.name, nil) } }
    static var actionNames: String { actions.map { $0.name }.joined(separator: "、") }

    /// 镜头的景别：中文名 → 发给脸的名字（见 Robot/live2d/src/camera.js 的 SHOTS）
    static let shots: [(name: String, id: String, words: [String])] = [
        ("自动", "auto", ["自动", "默认"]),
        ("全身", "full", ["全身", "远景", "远一点", "拉远"]),
        ("半身", "bust", ["半身", "近景", "中景"]),
        ("特写", "face", ["特写", "脸", "大头", "凑近", "拉近"]),
    ]
    static var shotNames: String { shots.map { $0.name }.joined(separator: "、") }

    /// 景别的中文名、叫法或 id → id；不认识返回 nil
    static func shotID(named raw: String) -> String? {
        let text = Store.simplified(raw).lowercased()
        if let s = shots.first(where: { $0.id == text }) { return s.id }
        return shots.first { s in s.words.contains { text.contains($0) } }?.id
    }

    /// 转身：方向（left 她的左边 = 屏幕右边，right，back 背对，center 回正）+ 度数 → 脸的朝向（度，正 = 转向屏幕右边）
    static func turnYaw(direction: String, degrees: Double?) -> Double {
        switch direction {
        case "left": return min(max(degrees ?? 90, 0), 180)
        case "right": return -min(max(degrees ?? 90, 0), 180)
        case "back": return 180
        default: return 0
        }
    }

    /// 聊天框里打的短指令，直接做、不问大模型（没填密钥也能用）：
    /// 「跳舞」「挥手」（动作名）、「特写」「全身」（镜头）、「转身 左 90」「背对」「转回来」、「重置」；前面加 / 也行。
    /// 返回发给脸的消息和记在记录里的说明；普通的话返回 nil，交给大模型。
    static func quickCommand(_ raw: String) -> (msg: [String: Any], label: String)? {
        var t = Store.simplified(raw)
        if t.hasPrefix("/") || t.hasPrefix("／") { t.removeFirst() }
        // 快捷菜单里的名字，原样打出来就执行
        for group in menu {
            if let item = group.items.first(where: { $0.name == t }), let msg = item.msg { return (msg, "\(group.title)：\(item.name)") }
        }
        if ["重置", "复位", "回到默认"].contains(t) { return (["type": "reset"], "回到默认") }
        if let a = actions.first(where: { $0.name == t || $0.id == t.lowercased() }) {
            return (["type": "action", "name": a.id], "动作：\(a.name)")
        }
        if t.hasPrefix("动作"), let id = actionID(named: String(t.dropFirst(2))) {
            return (["type": "action", "name": id], "动作：\(t.dropFirst(2))")
        }
        if let s = shots.first(where: { $0.name == t || "镜头" + $0.name == t || $0.name + "镜头" == t }) {
            return (["type": "view", "shot": s.id], "镜头：\(s.name)")
        }
        if t.hasPrefix("镜头"), let id = shotID(named: String(t.dropFirst(2))) {
            return (["type": "view", "shot": id], "镜头：\(t.dropFirst(2))")
        }
        let turnWords = ["背对": "转身背对", "转回来": "转身回正", "回正": "转身回正"]
        if t.hasPrefix("转身") || turnWords[t] != nil, let yaw = turnTags(in: "[\(turnWords[t] ?? t)]").first {
            return (["type": "turn", "yaw": yaw], yaw == 0 ? "转身：回正" : "转身：\(Int(yaw))°")
        }
        return nil
    }

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
        ], [
            "name": "turn_body",
            "description": "让屏幕里的 3D 身体转身（不是云台）：向左、向右转多少度，背对主人，或者转回来面对主人。",
            "parameters": [
                "type": "OBJECT",
                "properties": [
                    "direction": ["type": "STRING", "enum": ["left", "right", "back", "center"],
                                  "description": "left 向自己的左边转，right 向右边转，back 背对主人，center 转回来面对主人"],
                    "degrees": ["type": "NUMBER", "description": "转多少度，0～180；back、center 不用填"],
                ],
                "required": ["direction"],
            ],
        ], [
            "name": "set_camera",
            "description": "换屏幕的镜头：全身、半身、脸部特写，或者交给自动（聊天时半身、闲着时全身）。",
            "parameters": [
                "type": "OBJECT",
                "properties": [
                    "shot": ["type": "STRING", "enum": shots.map { $0.name }, "description": "景别"],
                ],
                "required": ["shot"],
            ],
        ]],
    ]

    private static let outfitPattern = #"\[\s*换装\s*[:：]?\s*([^\]]+?)\s*\]"#

    private static let actionPattern = #"\[\s*动作\s*[:：]?\s*([^\]]+?)\s*\]"#

    private static let viewPattern = #"\[\s*镜头\s*[:：]?\s*([^\]]+?)\s*\]"#
    private static let turnPattern = #"\[\s*转身\s*[:：]?\s*(左|右|背对|回正|回来)?\s*(\d+(?:\.\d+)?)?\s*度?\s*\]"#

    /// 回答里的镜头标签 → 景别名
    static func viewTags(in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: viewPattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    /// 回答里的转身标签 → 脸的朝向（度）
    static func turnTags(in text: String) -> [Double] {
        guard let re = try? NSRegularExpression(pattern: turnPattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            let verb = m.range(at: 1).location == NSNotFound ? "" : ns.substring(with: m.range(at: 1))
            let deg = m.range(at: 2).location == NSNotFound ? nil : Double(ns.substring(with: m.range(at: 2)))
            let dir = ["左": "left", "右": "right", "背对": "back"][verb] ?? (deg != nil && verb.isEmpty ? "left" : "center")
            return turnYaw(direction: dir, degrees: deg)
        }
    }

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
            .replacingOccurrences(of: viewPattern, with: "", options: .regularExpression)
            .replacingOccurrences(of: turnPattern, with: "", options: .regularExpression)
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
