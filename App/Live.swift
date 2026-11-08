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

    init(store: Store, face: FaceBridge, log: @escaping (String) -> Void) {
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
            "systemInstruction": ["parts": [["text": Self.persona]]],
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
                    if self.phase == .connecting { self.fail(e.localizedDescription) }
                    else if self.phase != .off { self.log("实时语音断开：\(e.localizedDescription)"); self.stop() }
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
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        if obj["setupComplete"] != nil { ready() }
        if let err = obj["error"] as? [String: Any] {
            let m = (err["message"] as? String) ?? "出错"
            return phase == .connecting ? fail(m) : log("实时语音：\(m)")
        }
        if obj["goAway"] != nil { log("实时语音：服务器说快要断开了（单次连接有时长上限）") }
        guard let sc = obj["serverContent"] as? [String: Any] else { return }
        if (sc["interrupted"] as? Bool) == true { interrupted() }
        if let t = (sc["inputTranscription"] as? [String: Any])?["text"] as? String, !t.isEmpty {
            heard += t
            lastActivity = Date()
        }
        if let t = (sc["outputTranscription"] as? [String: Any])?["text"] as? String { said += t }
        if let parts = (sc["modelTurn"] as? [String: Any])?["parts"] as? [[String: Any]] {
            for p in parts {
                guard let inline = p["inlineData"] as? [String: Any], let b64 = inline["data"] as? String,
                      let pcm = Data(base64Encoded: b64) else { continue }
                play(pcm)
            }
        }
        if (sc["turnComplete"] as? Bool) == true { turnComplete() }
    }

    private func ready() {
        guard phase == .connecting else { return }
        do { try startAudio() } catch { return fail("麦克风打不开：\(error.localizedDescription)") }
        phase = .listening
        lastActivity = Date()
        log("实时语音已连上（\(modelName.replacingOccurrences(of: "models/", with: ""))，声音 \(Self.voice)）")
        face.send(["type": "sensing", "mic": true])
        face.send(["type": "robot_state", "state": "listening", "emotion": "neutral"])
        idleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, self.phase == .listening else { return }
                if Date().timeIntervalSince(self.lastActivity) > Self.idleLimit {
                    self.log("\(Int(Self.idleLimit)) 秒没说话，实时对话结束")
                    self.stop()
                }
            }
        }
    }

    private func turnComplete() {
        let h = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        let s = said.trimmingCharacters(in: .whitespacesAndNewlines)
        if !h.isEmpty { log("听到：\(h)") }
        if !s.isEmpty { log("回答：\(s)") }
        if let id = Store.outfitCommand(h) {
            store.outfit = id
            face.send(["type": "outfit", "id": id])
            log("换装：\(Store.outfitName(id))")
        }
        if Self.byeWords.contains(where: { h.contains($0) }) { ending = true }
        heard = ""; said = ""
        turnFinished = true
        lastActivity = Date()
        if pending == 0 { doneSpeaking() }
    }

    /// 你插话了：服务器让停，排着的音频全扔掉
    private func interrupted() {
        player?.stop()
        player?.play()
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
    }

    // MARK: 声音

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)
        let e = AVAudioEngine()
        let input = e.inputNode
        try? input.setVoiceProcessingEnabled(true)   // 回声消除：她的声音不会被当成你在说话
        let p = AVAudioPlayerNode()
        e.attach(p)
        e.connect(p, to: e.mainMixerNode, format: playFormat)
        let inFormat = input.outputFormat(forBus: 0)
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
        meter.onLevel = { [weak self] level in
            Task { @MainActor in
                guard let self = self, self.phase == .speaking else { return }
                self.face.send(["type": "robot_state", "mouth_level": Double(level)])
            }
        }
        e.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in meter.push(buf) }
        e.prepare()
        try e.start()
        p.play()
        engine = e; player = p; mic = pipe
    }

    private func stopAudio() {
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

    init?(from: AVAudioFormat) {
        guard let c = AVAudioConverter(from: from, to: target) else { return nil }
        converter = c
    }

    func push(_ buf: AVAudioPCMBuffer) {
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
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        acc.append(Data(bytes: ch[0], count: Int(out.frameLength) * 2))
        if acc.count >= 3200 {
            send?(acc)
            acc.removeAll(keepingCapacity: true)
        }
    }
}

/// 算一段声音的音量（0…1），大约每 60 毫秒报一次
final class LevelMeter {
    var onLevel: ((Float) -> Void)?
    private var last = Date.distantPast

    func push(_ buf: AVAudioPCMBuffer) {
        guard Date().timeIntervalSince(last) > 0.06, let ch = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
        last = Date()
        var sum: Float = 0
        let n = Int(buf.frameLength)
        for i in 0..<n { sum += ch[i] * ch[i] }
        let rms = (sum / Float(n)).squareRoot()
        onLevel?(min(1, rms * 6))
    }
}
