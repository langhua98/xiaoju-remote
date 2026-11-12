import AVFoundation
import Foundation

/// 实时语音对话（Gemini Live API）：一个模型直接「听声音、出声音」，像打电话一样聊。
/// - 一直开着麦克风，iOS 的回声消除（voiceChat + voice processing）让她说话时不会把自己的声音当成你说的，所以你随时可以插话打断她。
/// - 你说完到她开口一般不到 1 秒；她自己判断你说没说完。
/// - 协议：wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent?key=…（和官方 @google/genai SDK 一样）。
///   发 16 kHz 16 位单声道 PCM，收 24 kHz PCM。模型名不写死：每次连接前问一次有哪些支持 bidiGenerateContent 的模型，挑最合适的。
/// - 免费档有用量限制，免费档的数据谷歌可能用来改进产品。连不上（没额度、密钥不对）时 onFail 交回给 Talk，退回普通模式。
@MainActor
final class LiveTalk: NSObject, ObservableObject {
    enum Phase { case off, connecting, listening, speaking }
    @Published private(set) var phase: Phase = .off
    /// 她正在说的话（Gemini 给的文字稿），聊天框上面当字幕
    @Published private(set) var caption = ""

    /// 连不上时调用（参数是原因），Talk 用它退回 DeepSeek + 语音合成的普通模式
    var onFail: ((String) -> Void)?

    static let voice = "Leda"   // Gemini 自带的女声之一（温柔、年轻）
    static let host = "generativelanguage.googleapis.com"
    static let byeWords = ["再见", "拜拜", "不聊了", "晚安", "先这样", "退下"]
    static let idleLimit: TimeInterval = 30

    static let persona = """
    你是云来（Yunlai Robot），一个住在手机屏幕里的数字生命体，声音温柔。手机是你的脸，摄像头是你的眼睛，麦克风是你的耳朵，云台是你的身体。
    你在和主人语音聊天：一直用自然的口语中文，回答简短，一般一两句话，像朋友聊天一样，不要念列表。
    """

    private let store: Store
    private let face: FaceBridge
    private let log: (String) -> Void

    private var socket: URLSessionWebSocketTask?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var mic: MicPipe?
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    private var pending = 0              // 排着队还没播完的音频段
    private var turnFinished = false
    private var lastActivity = Date()
    private var idleTimer: Timer?
    private var heard = ""
    private var said = ""
    private var ending = false           // 说了再见：这一轮说完就挂
    private var modelName = ""
    private var msgCount = 0          // 诊断：收到几条服务器消息
    private var audioIn = 0           // 诊断：收到几段她的声音
    private var statTicks = 0
    private var usedOutfitTool = false  // 这一轮她已经用工具换过装，就不再按关键词换一次
    private var buffered = 0.0          // 这一轮攒了多少秒的声音
    private var playStarted = true
    private var voiceProcessing = true   // 回声消除；这台手机上开着收不到声音就自动关掉
    private var configObserver: NSObjectProtocol?
    private var interruptObserver: NSObjectProtocol?

    private let gimbal: Gimbal

    init(store: Store, face: FaceBridge, gimbal: Gimbal, log: @escaping (String) -> Void) {
        self.gimbal = gimbal
        self.store = store
        self.face = face
        self.log = log
        super.init()
    }

    var available: Bool { !store.geminiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    // MARK: 开始 / 结束

    func start() {
        guard phase == .off, available else { return }
        phase = .connecting
        ending = false
        heard = ""; said = ""
        face.send(["type": "robot_state", "state": "thinking", "emotion": "neutral"])
        Task { await connect() }
    }

    func stop() {
        guard phase != .off else { return }
        phase = .off
        idleTimer?.invalidate(); idleTimer = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        stopAudio()
        face.send(["type": "sensing", "mic": false])
        face.send(["type": "robot_state", "state": "idle", "emotion": "neutral"])
    }

    private func fail(_ reason: String) {
        log("实时语音连不上：\(reason)")
        stop()
        onFail?(reason)
    }

    // MARK: 连接

    private func connect() async {
        let key = store.geminiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            modelName = try await Self.pickModel(key: key)
        } catch {
            return fail(error.localizedDescription)
        }
        guard phase == .connecting else { return }
        var c = URLComponents()
        c.scheme = "wss"; c.host = Self.host
        c.path = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        c.queryItems = [URLQueryItem(name: "key", value: key)]
        guard let url = c.url else { return fail("地址不对") }
        let ws = URLSession.shared.webSocketTask(with: url)
        ws.maximumMessageSize = 8 << 20
        socket = ws
        ws.resume()
        receive()
        let setup: [String: Any] = ["setup": [
            "model": modelName,
            "generationConfig": [
                "responseModalities": ["AUDIO"],
                "speechConfig": ["voiceConfig": ["prebuiltVoiceConfig": ["voiceName": Self.voice]]],
            ],
            "systemInstruction": ["parts": [["text": Self.persona + "\n" + Body.personaForTool]]],
            "tools": [Body.toolDeclaration],
            "inputAudioTranscription": [String: Any](),
            "outputAudioTranscription": [String: Any](),
        ]]
        send(setup)
        // 10 秒还没 setupComplete 就算连不上
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.phase == .connecting else { return }
            self.fail("10 秒没连上")
        }
    }

    /// 问谷歌：这个密钥能用哪些实时（bidiGenerateContent）模型，挑原生语音的、版本新的
    static func pickModel(key: String) async throws -> String {
        var c = URLComponents()
        c.scheme = "https"; c.host = host; c.path = "/v1beta/models"
        c.queryItems = [URLQueryItem(name: "key", value: key), URLQueryItem(name: "pageSize", value: "1000")]
        guard let url = c.url else { throw Chat.Failure(message: "地址不对") }
        let (data, resp) = try await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 15))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Chat.Failure(message: code == 400 || code == 403 ? "Gemini 密钥不对（\(code)）" : "模型列表返回 \(code)") }
        let models = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["models"] as? [[String: Any]] ?? []
        let live = models.compactMap { m -> String? in
            guard let name = m["name"] as? String,
                  let methods = m["supportedGenerationMethods"] as? [String], methods.contains("bidiGenerateContent") else { return nil }
            let n = name.lowercased()
            if n.contains("translate") || n.contains("image") || n.contains("tts") || n.contains("music") { return nil }
            return name
        }
        func score(_ name: String) -> (Int, Double) {
            let n = name.lowercased()
            var s = 0
            if n.contains("native-audio") || n.contains("live") { s += 2 }
            if n.contains("flash") { s += 1 }
            let version = n.range(of: #"\d+(\.\d+)?"#, options: .regularExpression).flatMap { Double(n[$0]) } ?? 0
            return (s, version)
        }
        guard let best = live.max(by: { score($0) < score($1) }) else { throw Chat.Failure(message: "这个密钥没有能实时对话的模型") }
        return best
    }

    private func send(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        socket?.send(.string(s)) { _ in }
    }

    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self = self, self.socket != nil else { return }
                switch result {
                case .failure(let e):
                    let code = self.socket?.closeCode.rawValue ?? 0
                    let why = self.socket?.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    let detail = "\(e.localizedDescription)（关闭码 \(code)\(why.isEmpty ? "" : "：" + why)）"
                    if self.phase == .connecting { self.fail(detail) }
                    else if self.phase != .off { self.log("实时语音断开：\(detail)"); self.stop() }
                case .success(let msg):
                    switch msg {
                    case .data(let d): self.handle(d)
                    case .string(let s): if let d = s.data(using: .utf8) { self.handle(d) }
                    @unknown default: break
                    }
                    self.receive()
                }
            }
        }
    }

    // MARK: 服务器发来的

    private func handle(_ data: Data) {
        msgCount += 1
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return log("实时语音：收到看不懂的消息（\(data.count) 字节）")
        }
        if obj["setupComplete"] != nil { ready() }
        if let err = obj["error"] as? [String: Any] {
            let m = (err["message"] as? String) ?? "出错"
            return phase == .connecting ? fail(m) : log("实时语音：\(m)")
        }
        // 模型要转云台：转完把结果回给它
        if let calls = (obj["toolCall"] as? [String: Any])?["functionCalls"] as? [[String: Any]] {
            for call in calls { runTool(call) }
        }
        if obj["goAway"] != nil { log("实时语音：服务器说快要断开了（单次连接有时长上限）") }
        guard let sc = obj["serverContent"] as? [String: Any] else { return }
        if (sc["interrupted"] as? Bool) == true { interrupted() }
        if let t = (sc["inputTranscription"] as? [String: Any])?["text"] as? String, !t.isEmpty {
            heard += t
            lastActivity = Date()
        }
        if let t = (sc["outputTranscription"] as? [String: Any])?["text"] as? String { said += t; caption = Self.tidy(said) }
        if let parts = (sc["modelTurn"] as? [String: Any])?["parts"] as? [[String: Any]] {
            for p in parts {
                guard let inline = p["inlineData"] as? [String: Any], let b64 = inline["data"] as? String,
                      let pcm = Data(base64Encoded: b64) else { continue }
                audioIn += 1
                play(pcm)
            }
        }
        if (sc["turnComplete"] as? Bool) == true { turnComplete() }
    }

    private func runTool(_ call: [String: Any]) {
        let id = call["id"] as? String ?? ""
        let name = call["name"] as? String ?? ""
        let args = call["args"] as? [String: Any] ?? [:]
        Task { @MainActor in
            var result = "不认识的工具：\(name)"
            if name == "change_outfit" {
                let want = (args["name"] as? String) ?? ""
                if let id = Store.outfitID(named: want) {
                    self.store.outfit = id
                    self.usedOutfitTool = true
                    result = "换好了：\(Store.outfitName(id))"
                } else {
                    result = "没有这套衣服，只有：\(Body.outfitNames)"
                }
                self.log("换装（工具）：\(result)")
            } else if name == "play_action" {
                let want = (args["name"] as? String) ?? ""
                if let action = Body.actionID(named: want) {
                    self.face.send(["type": "action", "name": action])
                    result = "正在做：\(want)"
                } else {
                    result = "不会这个动作，只会：\(Body.actionNames)"
                }
                self.log("动作（工具）：\(result)")
            } else if name == "turn_body" {
                let dir = (args["direction"] as? String) ?? "center"
                let yaw = Body.turnYaw(direction: dir, degrees: (args["degrees"] as? NSNumber)?.doubleValue)
                self.face.send(["type": "turn", "yaw": yaw])
                result = yaw == 0 ? "转回来了" : "转好了（\(Int(yaw))°）"
                self.log("转身（工具）：\(Int(yaw))°")
            } else if name == "set_camera" {
                let want = (args["shot"] as? String) ?? ""
                if let shot = Body.shotID(named: want) {
                    self.face.send(["type": "view", "shot": shot])
                    result = "镜头换成\(want)了"
                } else {
                    result = "没有这种镜头，只有：\(Body.shotNames)"
                }
                self.log("镜头（工具）：\(result)")
            } else if name == "move_gimbal" {
                let dir = (args["direction"] as? String) ?? "center"
                let deg = (args["degrees"] as? NSNumber)?.doubleValue
                result = await Body.perform(self.gimbal, direction: dir, degrees: deg)
                self.log("云台（\(dir) \(deg.map { String(Int($0)) } ?? "")）：\(result)")
            }
            self.lastActivity = Date()
            self.send(["toolResponse": ["functionResponses": [["id": id, "name": name, "response": ["result": result]]]]])
        }
    }

    private func ready() {
        guard phase == .connecting else { return }
        do { try startAudio() } catch { return fail("麦克风打不开：\(error.localizedDescription)") }
        phase = .listening
        lastActivity = Date()
        log("实时语音已连上（\(modelName.replacingOccurrences(of: "models/", with: ""))，声音 \(Self.voice)）")
        face.send(["type": "sensing", "mic": true])
        face.send(["type": "robot_state", "state": "listening", "emotion": "neutral"])
        // 先让她打个招呼：能听到就说明「她的声音 → 扬声器」这条路是通的
        send(["clientContent": ["turns": [["role": "user", "parts": [["text": "（主人刚打开你，用一句很短的话跟主人打个招呼。）"]]]], "turnComplete": true]])
        msgCount = 0; audioIn = 0; statTicks = 0
        idleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, self.phase != .off else { return }
                // 前 30 秒每 5 秒记一次诊断：麦克风有没有声音、发出去没有、服务器回了什么
                // 引擎被停了就拉起来
                if let e = self.engine, !e.isRunning { self.restartEngine("发现引擎停了") }
                if self.statTicks < 6, let s = self.mic?.takeStats() {
                    self.statTicks += 1
                    let running = self.engine?.isRunning == true ? "在跑" : "停了"
                    self.log("实时诊断：引擎\(running)、麦克风 \(s.buffers) 段、音量 \(String(format: "%.3f", s.peak))、发出 \(s.sent) 段、转换失败 \(s.fails)；服务器消息 \(self.msgCount) 条、她的声音 \(self.audioIn) 段")
                    // 5 秒里麦克风一段都没收到：多半是这台手机的回声消除不干活，关掉重来
                    if s.buffers == 0 && self.voiceProcessing { self.rebuildWithoutVoiceProcessing() }
                }
                guard self.phase == .listening else { return }
                if Date().timeIntervalSince(self.lastActivity) > Self.idleLimit {
                    self.log("\(Int(Self.idleLimit)) 秒没说话，实时对话结束")
                    self.stop()
                }
            }
        }
    }

    /// 聊天框里打的字：当成你说的一句话发给 Gemini（她用声音回答）。没连上返回 false
    @discardableResult
    func sendText(_ text: String) -> Bool {
        guard phase == .listening || phase == .speaking else { return false }
        heard += text
        caption = ""
        lastActivity = Date()
        send(["clientContent": ["turns": [["role": "user", "parts": [["text": text]]]], "turnComplete": true]])
        return true
    }

    private func turnComplete() {
        let h = Self.tidy(heard)
        let s = Self.tidy(said)
        if !h.isEmpty { log("听到：\(h)") }
        if !s.isEmpty { log("回答：\(s)") }
        if !usedOutfitTool, let id = Store.outfitCommand(h, current: store.outfit) {
            store.outfit = id
            log("换装：\(Store.outfitName(id))")
        }
        if Self.byeWords.contains(where: { h.contains($0) }) { ending = true }
        heard = ""; said = ""
        usedOutfitTool = false
        turnFinished = true
        lastActivity = Date()
        if !playStarted { player?.play(); playStarted = true }
        if pending == 0 { doneSpeaking() }
    }

    /// 你插话了：服务器让停，排着的音频全扔掉
    private func interrupted() {
        player?.stop()
        player?.play()
        playStarted = true
        pending = 0
        turnFinished = false
        if phase == .speaking { backToListening() }
    }

    private func doneSpeaking() {
        turnFinished = false
        if ending { log("说了再见，实时对话结束"); return stop() }
        if phase == .speaking { backToListening() }
    }

    private func backToListening() {
        phase = .listening
        face.send(["type": "robot_state", "state": "listening", "mouth_level": 0])
        // 她说完 0.4 秒后再让麦克风发声音（喇叭的余音不会被当成你在说话）
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self, self.phase == .listening else { return }
            self.gateMic(open: true)
        }
    }

    /// 没有回声消除时用「对讲机模式」：她说话时麦克风的声音先不发，免得她把自己的声音当成你在插话、一句话被自己打断好几次
    private func gateMic(open: Bool) {
        mic?.muted = !voiceProcessing && !open
    }

    /// 文字稿里汉字之间多出来的空格去掉（「台 岛 啦」→「台岛啦」）
    static func tidy(_ s: String) -> String {
        s.replacingOccurrences(of: #"(?<=[\p{Han}，。！？、])\s+(?=[\p{Han}，。！？、])"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: 声音

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: voiceProcessing ? .voiceChat : .default, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)
        let e = AVAudioEngine()
        let input = e.inputNode
        if voiceProcessing {
            // 回声消除：她的声音不会被当成你在说话
            do { try input.setVoiceProcessingEnabled(true) } catch { log("回声消除打不开：\(error.localizedDescription)") }
        }
        let p = AVAudioPlayerNode()
        e.attach(p)
        e.connect(p, to: e.mainMixerNode, format: playFormat)
        let inFormat = input.outputFormat(forBus: 0)
        log("麦克风格式：\(Int(inFormat.sampleRate)) Hz，\(inFormat.channelCount) 声道")
        guard let pipe = MicPipe(from: inFormat) else { throw Chat.Failure(message: "麦克风格式转不了") }
        let ws = socket
        pipe.send = { pcm in
            let msg: [String: Any] = ["realtimeInput": ["audio": ["data": pcm.base64EncodedString(), "mimeType": "audio/pcm;rate=16000"]]]
            guard let d = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: d, encoding: .utf8) else { return }
            ws?.send(.string(s)) { _ in }
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { buf, _ in pipe.push(buf) }
        // 嘴型：量正在播放的声音有多大
        let meter = LevelMeter()
        meter.onLevel = { [weak self] level, bands in
            Task { @MainActor in
                guard let self = self, self.phase == .speaking else { return }
                self.face.send(["type": "robot_state", "mouth_level": Double(level), "mouth_bands": bands.map { Double($0) }])
            }
        }
        e.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in meter.push(buf) }
        e.prepare()
        try e.start()
        p.play()
        engine = e; player = p; mic = pipe
        // 系统改了音频配置（打开回声消除、插拔耳机、蓝牙等）会把引擎停掉：接着重启
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.restartEngine("系统改了音频配置") }
        }
        interruptObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
            Task { @MainActor in if ended { self?.restartEngine("被别的声音打断后恢复") } }
        }
        log("音频引擎：\(e.isRunning ? "在跑" : "没跑")，回声消除\(voiceProcessing ? "开" : "关")")
    }

    /// 引擎被系统停了：重新启动（排着的声音扔掉，回到听的状态）
    private func restartEngine(_ why: String) {
        guard phase != .off, let e = engine, !e.isRunning else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try e.start()
            player?.play()
            log("音频引擎重新启动（\(why)）")
        } catch {
            log("音频引擎重启失败：\(error.localizedDescription)")
        }
        pending = 0
        if phase == .speaking { backToListening() }
    }

    /// 麦克风一直没声音：关掉回声消除，整个音频重建一遍
    private func rebuildWithoutVoiceProcessing() {
        guard voiceProcessing, phase != .off else { return }
        voiceProcessing = false
        log("开着回声消除时麦克风收不到声音，改成不用回声消除（插话可能没那么灵）")
        stopAudio()
        do { try startAudio() } catch { return fail("麦克风打不开：\(error.localizedDescription)") }
        if phase == .speaking { backToListening() }
    }

    private func stopAudio() {
        if let o = configObserver { NotificationCenter.default.removeObserver(o) }
        if let o = interruptObserver { NotificationCenter.default.removeObserver(o) }
        configObserver = nil; interruptObserver = nil
        guard let e = engine else { return }
        e.inputNode.removeTap(onBus: 0)
        e.mainMixerNode.removeTap(onBus: 0)
        player?.stop()
        e.stop()
        try? e.inputNode.setVoiceProcessingEnabled(false)
        engine = nil; player = nil; mic = nil
        pending = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// 播一段 24 kHz 16 位 PCM
    private func play(_ pcm: Data) {
        guard let p = player else { return }
        let frames = pcm.count / 2
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)),
              let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<frames { dst[i] = Float(Int16(littleEndian: src[i])) / 32768 }
        }
        pending += 1
        lastActivity = Date()
        if phase != .speaking {
            // 新的一轮：先暂停，攒够 0.3 秒再开播，网络偶尔慢一下也不会一卡一卡
            p.pause()
            buffered = 0
            playStarted = false
            gateMic(open: false)
        }
        buffered += Double(frames) / playFormat.sampleRate
        if !playStarted && buffered >= 0.3 { p.play(); playStarted = true }
        p.scheduleBuffer(buf) { [weak self] in
            Task { @MainActor in
                guard let self = self else { return }
                self.pending = max(0, self.pending - 1)
                if self.pending == 0 && self.turnFinished { self.doneSpeaking() }
            }
        }
        if phase != .speaking {
            phase = .speaking
            face.send(["type": "robot_state", "state": "speaking", "emotion": "happy"])
        }
    }
}

/// 麦克风 → 16 kHz 16 位单声道，攒够 100 毫秒发一次（在音频线程上跑，不碰主线程的东西）
final class MicPipe {
    private let converter: AVAudioConverter
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var acc = Data()
    var send: ((Data) -> Void)?
    /// 对讲机模式下她说话时为 true：照收照算音量，就是不发
    var muted: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _muted }
        set { lock.lock(); _muted = newValue; lock.unlock() }
    }
    private var _muted = false

    // 诊断用：收了多少段麦克风、发了多少段、转换失败几次、最近 5 秒最大音量
    private let lock = NSLock()
    private var buffersIn = 0, chunksSent = 0, convertFails = 0
    private var peak: Float = 0

    /// 取出并清零（主线程每 5 秒取一次写进记录）
    func takeStats() -> (buffers: Int, sent: Int, fails: Int, peak: Float) {
        lock.lock(); defer { lock.unlock() }
        let s = (buffersIn, chunksSent, convertFails, peak)
        buffersIn = 0; chunksSent = 0; convertFails = 0; peak = 0
        return s
    }

    init?(from: AVAudioFormat) {
        guard let c = AVAudioConverter(from: from, to: target) else { return nil }
        converter = c
    }

    func push(_ buf: AVAudioPCMBuffer) {
        var level: Float = 0
        if let ch = buf.floatChannelData?[0], buf.frameLength > 0 {
            var sum: Float = 0
            for i in 0..<Int(buf.frameLength) { sum += ch[i] * ch[i] }
            level = (sum / Float(buf.frameLength)).squareRoot()
        }
        lock.lock(); buffersIn += 1; peak = max(peak, level); lock.unlock()
        let cap = AVAudioFrameCount(Double(buf.frameLength) * target.sampleRate / buf.format.sampleRate + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else {
            if err != nil { lock.lock(); convertFails += 1; lock.unlock() }
            return
        }
        acc.append(Data(bytes: ch[0], count: Int(out.frameLength) * 2))
        if acc.count >= 3200 {
            if !muted {
                send?(acc)
                lock.lock(); chunksSent += 1; lock.unlock()
            }
            acc.removeAll(keepingCapacity: true)
        }
    }
}

/// 算一段声音的音量（0…1），大约每 60 毫秒报一次
final class LevelMeter {
    /// 音量（0～1）和低、中、高三个频段的音量（约 700 Hz 以下、700～2500 Hz、2500 Hz 以上）。
    /// 频段给脸分口型用：低频多是「哦、呜」的圆嘴，高频多是「衣、诶」的扁嘴。
    var onLevel: ((Float, [Float]) -> Void)?
    private var last = Date.distantPast

    func push(_ buf: AVAudioPCMBuffer) {
        guard Date().timeIntervalSince(last) > 0.06, let ch = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
        last = Date()
        let n = Int(buf.frameLength)
        let rate = Float(buf.format.sampleRate > 0 ? buf.format.sampleRate : 24000)
        // 两个一阶低通把声音分成三段，不用傅里叶变换
        let k1 = 1 - exp(-2 * Float.pi * 700 / rate)
        let k2 = 1 - exp(-2 * Float.pi * 2500 / rate)
        var lp1: Float = 0, lp2: Float = 0
        var sum: Float = 0, low: Float = 0, mid: Float = 0, high: Float = 0
        for i in 0..<n {
            let x = ch[i]
            lp1 += k1 * (x - lp1)
            lp2 += k2 * (x - lp2)
            sum += x * x
            low += lp1 * lp1
            mid += (lp2 - lp1) * (lp2 - lp1)
            high += (x - lp2) * (x - lp2)
        }
        let scale = 1 / Float(n)
        let rms = (sum * scale).squareRoot()
        let bands = [low, mid, high].map { min(1, ($0 * scale).squareRoot() * 6) }
        onLevel?(min(1, rms * 6), bands)
    }
}
