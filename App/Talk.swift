import AVFoundation
import Foundation
import Speech

/// 和机器人对话：点一下屏幕 → iOS 语音识别听你说 → 大模型（OpenAI 兼容接口，流式）→ 逐句交给 Kokoro 合成并播放。
/// 大模型写出第一句就开始合成、播放，后面的边播边合成，等待只取决于第一句。
/// Kokoro 连不上的那句改用 iOS 自带语音读，机器人不会哑。脸的状态：倾听 → 思考 → 说话（嘴跟着真实音量）→ 待机。
@MainActor
final class Talk: NSObject, ObservableObject {
    enum Phase { case idle, listening, thinking, speaking }
    @Published private(set) var phase: Phase = .idle
    /// 连续对话：点一下开始，之后她说完自动接着听；说「再见」或者 8 秒不说话就结束
    @Published private(set) var conversing = false
    private static let byeWords = ["再见", "拜拜", "不聊了", "晚安", "先这样", "退下"]

    private let store: Store
    private let face: FaceBridge
    private let log: (String) -> Void
    private var history: [[String: String]] = []

    // 听
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    /// 普通模式录音用的引擎：要听的时候才建，用完就扔（不然会和实时语音的引擎抢麦克风）
    private var audio: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recTask: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var heard = ""

    // 想：流式回答拆句
    private var llmTask: Task<Void, Never>?
    private var buffer = ""
    private var emotion = "neutral"
    private var emotionKnown = false
    private var reply = ""

    // 说：一句一句排队
    private var queue: [(text: String, audio: Task<Data?, Never>)] = []
    private var llmDone = true
    private var playLoop: Task<Void, Never>?
    private var queueWaiter: CheckedContinuation<Void, Never>?
    private var player: AVAudioPlayer?
    private var playerDone: CheckedContinuation<Bool, Never>?
    private var meterTimer: Timer?
    private let synth = AVSpeechSynthesizer()
    private var synthDone: CheckedContinuation<Void, Never>?
    private var startedSpeaking = false

    /// 实时语音（Gemini Live）：填了 Gemini 密钥就优先用它，连不上退回下面的普通模式
    let live: LiveTalk

    /// 机器人的身体（大疆云台）：大模型回答里的动作标签会让它转
    private let gimbal: Gimbal
    private var gimbalChain: Task<Void, Never>?

    init(store: Store, face: FaceBridge, gimbal: Gimbal, log: @escaping (String) -> Void) {
        self.store = store
        self.face = face
        self.log = log
        self.gimbal = gimbal
        self.live = LiveTalk(store: store, face: face, gimbal: gimbal, log: log)
        super.init()
        synth.delegate = self
        live.onFail = { [weak self] _ in
            guard let self = self else { return }
            self.log("改用普通对话模式")
            self.conversing = true
            self.startListening()
        }
    }

    /// 进机器人模式时叫醒语音服务（Space 上的 Kokoro 闲了会关掉，第一次加载要十几秒）
    func warmUp() {
        guard let url = Voice.url(base: Voice.defaultBase, path: "health") else { return }
        URLSession.shared.dataTask(with: URLRequest(url: url, timeoutInterval: 10)).resume()
    }

    /// 点了一下屏幕：没事时开始听；正在听就结束；正在想或正在说就打断。
    /// 点了一下屏幕：没事时开始连续对话；正在听就当说完了；正在想或正在说就打断她，接着听你说。
    func tap() {
        // 实时语音：点一下开始，再点一下结束（中间直接说话就行，能随时插话）
        if live.phase != .off { live.stop(); return }
        if phase == .idle && live.available { live.start(); return }
        switch phase {
        case .idle:
            conversing = true
            startListening()
        case .listening: finishListening()
        case .thinking, .speaking:
            if conversing { interrupt() } else { cancel() }
        }
    }

    /// 打断：她马上停下，转去听你说（连续对话里）
    private func interrupt() {
        llmTask?.cancel()
        llmTask = nil
        stopSpeaking()
        phase = .idle
        beginRecording()
    }

    func cancel() {
        live.stop()
        conversing = false
        llmTask?.cancel()
        llmTask = nil
        stopAudio()
        stopSpeaking()
        phase = .idle
        face.send(["type": "robot_state", "state": "idle", "emotion": "neutral"])
    }

    // MARK: 听

    private func startListening() {
        guard !store.llmBase.isEmpty, !store.llmModel.isEmpty, !store.llmKey.isEmpty else {
            conversing = false
            say("请先在设置里填好大模型的接口地址、模型名和密钥。", emotion: "confused")
            return
        }
        warmUp()
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                guard status == .authorized else {
                    self.conversing = false
                    self.say("请先在设置里允许语音识别。", emotion: "confused")
                    return
                }
                self.beginRecording()
            }
        }
    }

    private func beginRecording() {
        guard phase == .idle else { return }
        guard let recognizer = recognizer, recognizer.isAvailable else {
            conversing = false
            say("语音识别现在用不了。", emotion: "confused")
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            audio = engine
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                req.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            stopAudio()
            conversing = false
            say("麦克风打不开。", emotion: "confused")
            return
        }
        request = req
        heard = ""
        phase = .listening
        face.send(["type": "sensing", "mic": true])
        face.send(["type": "robot_state", "state": "listening", "emotion": "neutral"])
        recTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let done = (result?.isFinal ?? false) || error != nil
            Task { @MainActor in self?.onRecognized(text, done: done) }
        }
        armSilence(conversing ? 8 : 5)   // 这么久一句话都没说，就不听了（连续对话也就此结束）
    }

    private func onRecognized(_ text: String?, done: Bool) {
        guard phase == .listening else { return }
        if let text = text, !text.isEmpty {
            heard = text
            armSilence(0.8)   // 停顿 0.8 秒算说完
        }
        if done { finishListening() }
    }

    private func armSilence(_ seconds: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finishListening() }
        }
    }

    private func stopAudio() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        if let engine = audio {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            audio = nil
        }
        request?.endAudio()
        request = nil
        recTask?.cancel()
        recTask = nil
        face.send(["type": "sensing", "mic": false])
    }

    private func finishListening() {
        guard phase == .listening else { return }
        stopAudio()
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            if conversing { log("一直没说话，对话结束") }
            conversing = false
            phase = .idle
            face.send(["type": "robot_state", "state": "idle", "emotion": "neutral"])
            return
        }
        log("听到：\(text)")
        // 说「再见」：这一句还是让她回答（道个别），回答完不再接着听
        if Self.byeWords.contains(where: { text.contains($0) }) { conversing = false }
        phase = .thinking
        // 换装直接办，不问大模型
        if let id = Store.outfitCommand(text, current: store.outfit) {
            store.outfit = id
            log("换装：\(Store.outfitName(id))")
            say(id == "default" ? "好，换回原来的衣服啦。" : "好呀，换上\(Store.outfitName(id))啦，好看吗？", emotion: "happy")
            return
        }
        face.send(["type": "robot_state", "state": "thinking", "emotion": "neutral"])
        llmTask = Task { await self.ask(text) }
    }

    // MARK: 想（流式，边收边拆句）

    private func ask(_ text: String) async {
        history.append(["role": "user", "content": text])
        if history.count > 12 { history.removeFirst(history.count - 12) }
        let messages = [["role": "system", "content": Chat.persona + "\n" + Body.personaForTags]] + history
        beginSpeaking()
        buffer = ""; reply = ""; emotion = "neutral"; emotionKnown = false
        do {
            try await Chat.stream(base: store.llmBase, key: store.llmKey, model: store.llmModel, messages: messages) { piece in
                self.onPiece(piece)
            }
            guard !Task.isCancelled else { return }
            flush(final: true)
            history.append(["role": "assistant", "content": reply.isEmpty ? "嗯。" : reply])
            log("回答：\(reply)")
        } catch {
            guard !Task.isCancelled else { return }
            history.removeLast()
            log("大模型出错：\(error.localizedDescription)")
            if reply.isEmpty {
                emotion = "confused"; emotionKnown = true
                enqueue("我好像连不上大脑了。")
            }
        }
        llmDone = true
        wakeQueue()
    }

    private func onPiece(_ piece: String) {
        guard phase == .thinking || phase == .speaking else { return }
        buffer += piece
        flush(final: false)
    }

    /// 从 buffer 里切出完整的句子交给语音；final 时把剩下的也交出去
    private func flush(final: Bool) {
        // 有的模型先输出 <think>…</think>，想完之前什么都不读
        buffer = buffer.replacingOccurrences(of: #"(?s)<think>.*?</think>"#, with: "", options: .regularExpression)
        if buffer.contains("<think>") && !final { return }
        if !emotionKnown {
            let head = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
            if head.hasPrefix("[") {
                guard let close = head.firstIndex(of: "]") else {
                    if !final && head.count < 16 { return }
                    emotionKnown = true
                    return flush(final: final)
                }
                let tag = String(head[head.index(after: head.startIndex)..<close]).lowercased()
                // 只拿走情绪标签；开头要是动作标签（[左转 30]）就留着，后面照样执行
                if Chat.emotions.contains(tag) {
                    emotion = tag
                    buffer = String(head[head.index(after: close)...])
                }
                emotionKnown = true
            } else if !head.isEmpty || final {
                emotionKnown = true
            } else {
                return
            }
        }
        while let cut = Self.sentenceEnd(in: buffer) {
            let sentence = String(buffer[..<cut])
            buffer = String(buffer[cut...])
            enqueue(sentence)
        }
        if final {
            enqueue(buffer)
            buffer = ""
        }
    }

    /// 句号、问号、感叹号、换行处断句；太长的句子在逗号处先断，让第一句尽快读出来
    private static func sentenceEnd(in s: String) -> String.Index? {
        let hard: Set<Character> = ["。", "！", "？", "!", "?", "；", ";", "\n", "…"]
        let soft: Set<Character> = ["，", ",", "、", "："]
        var count = 0
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i]
            count += 1
            let next = s.index(after: i)
            if hard.contains(c) && count >= 2 { return next }
            if soft.contains(c) && count >= 14 { return next }
            i = next
        }
        return nil
    }

    /// 大模型说要换装：按名字换
    private func applyOutfit(_ name: String) {
        guard let id = Store.outfitID(named: name) else { return log("换装：没有叫「\(name)」的衣服") }
        store.outfit = id
        log("换装：\(Store.outfitName(id))")
    }

    // MARK: 说（一句一句排队，下载下一句时播这一句）

    private func beginSpeaking() {
        stopSpeaking()
        llmDone = false
        startedSpeaking = false
        playLoop = Task { await self.runQueue() }
    }

    /// 别人（遥控指令）让她说一句话。text 里也可以带动作、镜头、转身标签。
    /// 实时语音（Gemini）进行中不插话，返回 false；普通对话进行中会被打断。
    @discardableResult
    func speak(_ text: String, emotion: String = "neutral") -> Bool {
        guard live.phase == .off else { return false }
        conversing = false
        llmTask?.cancel()
        llmTask = nil
        stopAudio()
        phase = .idle
        say(text, emotion: emotion)
        return true
    }

    private func say(_ text: String, emotion: String) {
        beginSpeaking()
        self.emotion = emotion
        enqueue(text)
        llmDone = true
        wakeQueue()
    }

    private func enqueue(_ raw: String) {
        // 动作标签：一个接一个转（上一个转完再转下一个），不耽误说话
        for tag in Body.tags(in: raw) {
            let previous = gimbalChain
            gimbalChain = Task { @MainActor in
                await previous?.value
                let r = await Body.perform(self.gimbal, direction: tag.direction, degrees: tag.degrees)
                self.log("云台（\(tag.direction) \(tag.degrees.map { String(Int($0)) } ?? "")）：\(r)")
            }
        }
        for name in Body.outfitTags(in: raw) { applyOutfit(name) }
        for name in Body.viewTags(in: raw) {
            guard let shot = Body.shotID(named: name) else { log("镜头：没有「\(name)」"); continue }
            face.send(["type": "view", "shot": shot])
            log("镜头：\(name)")
        }
        for yaw in Body.turnTags(in: raw) {
            face.send(["type": "turn", "yaw": yaw])
            log("转身：\(Int(yaw))°")
        }
        for name in Body.actionTags(in: raw) {
            guard let id = Body.actionID(named: name) else { log("动作：不会做「\(name)」"); continue }
            face.send(["type": "action", "name": id])
            log("动作：\(name)")
        }
        let text = Chat.clean(Body.strip(raw))
        guard text.rangeOfCharacter(from: .letters) != nil || text.rangeOfCharacter(from: .decimalDigits) != nil else { return }
        reply += text
        let fetch = Task.detached { await Voice.fetchWithBackup(text: text) }
        queue.append((text, fetch))
        wakeQueue()
    }

    private func wakeQueue() {
        queueWaiter?.resume()
        queueWaiter = nil
    }

    private func runQueue() async {
        while !Task.isCancelled {
            if queue.isEmpty {
                if llmDone { break }
                await withCheckedContinuation { queueWaiter = $0 }
                continue
            }
            let item = queue.removeFirst()
            let data = await item.audio.value
            if Task.isCancelled { break }
            if !startedSpeaking {
                startedSpeaking = true
                phase = .speaking
                face.send(["type": "robot_state", "state": "speaking", "emotion": emotion])
            }
            if let data = data, await play(data) { continue }
            if Task.isCancelled { break }
            await speakWithSystemVoice(item.text)
        }
        guard !Task.isCancelled else { return }
        doneSpeaking()
    }

    private func stopSpeaking() {
        playLoop?.cancel()
        playLoop = nil
        for item in queue { item.audio.cancel() }
        queue.removeAll()
        llmDone = true
        wakeQueue()
        meterTimer?.invalidate()
        meterTimer = nil
        player?.stop()
        player = nil
        playerDone?.resume(returning: false)
        playerDone = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        synthDone?.resume()
        synthDone = nil
    }

    private func useSpeaker() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
    }

    /// 播一段 Kokoro 的 WAV，嘴跟着真实音量动；播完返回 true
    private func play(_ data: Data) async -> Bool {
        useSpeaker()
        guard let p = try? AVAudioPlayer(data: data) else { return false }
        p.delegate = self
        p.isMeteringEnabled = true
        guard p.play() else { return false }
        player = p
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sendMouth() }
        }
        let ok = await withCheckedContinuation { playerDone = $0 }
        meterTimer?.invalidate()
        meterTimer = nil
        player = nil
        face.send(["type": "robot_state", "mouth_level": 0])
        return ok
    }

    private func sendMouth() {
        guard let p = player, p.isPlaying else { return }
        p.updateMeters()
        let db = p.averagePower(forChannel: 0)            // -160…0 dB
        let level = max(0, min(1, (db + 45) / 35))          // 说话一般在 -40…-10 dB
        face.send(["type": "robot_state", "mouth_level": Double(level)])
    }

    fileprivate func playerFinished(_ ok: Bool) {
        playerDone?.resume(returning: ok)
        playerDone = nil
    }

    /// Kokoro 连不上时用 iOS 自带语音读这一句（嘴型由脸自己按节奏动）
    private func speakWithSystemVoice(_ text: String) async {
        useSpeaker()
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        u.rate = 0.52
        u.pitchMultiplier = 1.15
        synth.speak(u)
        await withCheckedContinuation { synthDone = $0 }
    }

    fileprivate func synthFinished() {
        synthDone?.resume()
        synthDone = nil
    }

    private func doneSpeaking() {
        playLoop = nil
        guard phase == .speaking || phase == .thinking else { return }
        phase = .idle
        if conversing {
            // 连续对话：说完马上接着听（留一点点时间让声音彻底停下，免得把自己的声音录进去）
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self, self.conversing, self.phase == .idle else { return }
                self.beginRecording()
            }
            return
        }
        face.send(["type": "robot_state", "state": "idle"])
        // 说完保持一会儿情绪，再回到平静
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.phase == .idle else { return }
            self.face.send(["type": "robot_state", "emotion": "neutral"])
        }
    }
}

extension Talk: AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.synthFinished() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.synthFinished() }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.playerFinished(flag) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.playerFinished(false) }
    }
}

/// Kokoro 语音服务（默认是 xiaoju-video 的流式服务 Space 上的 /tts，见那个仓库的 streamer/tts_proxy.py）
enum Voice {
    // 地址固定写在这里，不在设置页填（William 的要求）
    /// 默认：Cloudflare Workers AI 上的 MeloTTS 女声（langhua98/xiaoju-music 的 yunlai-tts/），不会冷启动
    static let defaultBase = "https://yunlai-tts.langhua98.workers.dev"
    /// 备用：小橘视频流式服务 Space 上的 Kokoro 女声 zf_088（langhua98/xiaoju-video 的 streamer/tts_proxy.py），闲了会关，叫醒要十几秒
    static let backupBase = "https://langhua1998-douyin-proxy.hf.space/tts"
    static let backupVoice = "zf_088"

    /// 先问 Cloudflare（8 秒内没回音就算失败），不行再问备用的 Space；都不行返回 nil，调用方改用 iOS 自带语音。
    static func fetchWithBackup(text: String) async -> Data? {
        if let data = await fetch(base: defaultBase, voice: backupVoice, text: text, timeout: 8) { return data }
        if Task.isCancelled { return nil }
        return await fetch(base: backupBase, voice: backupVoice, text: text, timeout: 45)
    }

    static func url(base: String, path: String, query: [URLQueryItem] = []) -> URL? {
        var b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !b.isEmpty else { return nil }
        while b.hasSuffix("/") { b.removeLast() }
        var c = URLComponents(string: b + "/" + path)
        if !query.isEmpty { c?.queryItems = query }
        return c?.url
    }

    /// 合成一句，拿到 WAV；失败返回 nil（调用方改用 iOS 自带语音）
    static func fetch(base: String, voice: String, text: String, timeout: TimeInterval = 45) async -> Data? {
        guard let url = url(base: base, path: "tts", query: [
            URLQueryItem(name: "text", value: String(text.prefix(300))),
            URLQueryItem(name: "voice", value: voice.isEmpty ? backupVoice : voice),
            URLQueryItem(name: "speed", value: "1.05"),
        ]) else { return nil }
        // 服务刚被叫醒时要等模型加载（服务端最多等 40 秒），再长就不等了
        guard let result = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: timeout)),
              let http = result.1 as? HTTPURLResponse, http.statusCode == 200,
              (http.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("audio"),
              result.0.count > 44 else { return nil }
        return result.0
    }
}

/// 大模型：OpenAI 兼容的 /chat/completions 接口（DeepSeek、智谱、通义、Kimi、OpenAI 等都行），流式输出。
enum Chat {
    static let emotions: Set<String> = ["neutral", "happy", "surprised", "confused", "alert"]

    static let persona = """
    你是云来（Yunlai Robot），一个住在手机屏幕里的数字生命体。手机是你的脸，摄像头是你的眼睛，麦克风是你的耳朵，云台是你的身体。
    你的回答会被直接读出来，所以：
    - 用自然的口语中文，一般一到两句话，最多三句。
    - 不要用列表、表格、markdown、表情符号。
    - 回答最前面先写一个情绪标签，只能是这五个之一：[neutral] [happy] [surprised] [confused] [alert]，然后再写回答。
    """

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// 流式请求，每收到一段文字就交给 onPiece（在主线程上调）
    static func stream(base: String, key: String, model: String, messages: [[String: String]],
                       onPiece: @MainActor @escaping (String) -> Void) async throws {
        var b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        guard let url = URL(string: b + "/chat/completions") else { throw Failure(message: "接口地址不对") }
        let reasoner = model.contains("reasoner")
        var req = URLRequest(url: url, timeoutInterval: reasoner ? 120 : 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        // deepseek-reasoner 不认 temperature，而且 max_tokens 把思考过程也算进去，给少了会只想不答；
        // 它先流出 reasoning_content（思考，不读），再流出 content（回答）
        let body: [String: Any] = reasoner
            ? ["model": model, "messages": messages, "max_tokens": 4000, "stream": true]
            : ["model": model, "messages": messages, "temperature": 0.8, "max_tokens": 400, "stream": true]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure(message: "接口返回 \(code)") }
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let d = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let choices = obj["choices"] as? [[String: Any]],
                  let delta = choices.first?["delta"] as? [String: Any],
                  let piece = delta["content"] as? String, !piece.isEmpty else { continue }
            await onPiece(piece)
        }
    }

    /// 去掉朗读时不该念的东西
    static func clean(_ s: String) -> String {
        var t = s.replacingOccurrences(of: #"\[[A-Za-z]+\]"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"[*#`>_|]"#, with: "", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
