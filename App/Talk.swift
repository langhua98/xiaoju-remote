import AVFoundation
import Foundation
import Speech

/// 和机器人对话：点一下屏幕 → iOS 语音识别听你说 → 大模型（OpenAI 兼容接口）回答 → iOS 自带语音读出来。
/// 每一步都通过 FaceBridge 让脸变状态：倾听 → 思考 → 说话（带大模型给的情绪）→ 待机。
@MainActor
final class Talk: NSObject, ObservableObject {
    enum Phase { case idle, listening, thinking, speaking }
    @Published private(set) var phase: Phase = .idle

    private let store: Store
    private let face: FaceBridge
    private let log: (String) -> Void
    private var history: [[String: String]] = []

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recTask: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var heard = ""
    private let synth = AVSpeechSynthesizer()
    private var llmTask: Task<Void, Never>?

    init(store: Store, face: FaceBridge, log: @escaping (String) -> Void) {
        self.store = store
        self.face = face
        self.log = log
        super.init()
        synth.delegate = self
    }

    /// 点了一下屏幕：没事时开始听；正在听就结束；正在想或正在说就打断。
    func tap() {
        switch phase {
        case .idle: startListening()
        case .listening: finishListening()
        case .thinking, .speaking: cancel()
        }
    }

    func cancel() {
        llmTask?.cancel()
        llmTask = nil
        stopAudio()
        phase = .idle
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        face.send(["type": "robot_state", "state": "idle", "emotion": "neutral"])
    }

    // MARK: 听

    private func startListening() {
        guard !store.llmBase.isEmpty, !store.llmModel.isEmpty, !store.llmKey.isEmpty else {
            say("请先在设置里填好大模型的接口地址、模型名和密钥。", emotion: "confused")
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                guard status == .authorized else {
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
            say("语音识别现在用不了。", emotion: "confused")
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = audio.inputNode
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                req.append(buffer)
            }
            audio.prepare()
            try audio.start()
        } catch {
            stopAudio()
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
        armSilence(5)   // 5 秒内一句话都没说，就不听了
    }

    private func onRecognized(_ text: String?, done: Bool) {
        guard phase == .listening else { return }
        if let text = text, !text.isEmpty {
            heard = text
            armSilence(1.2)   // 停顿 1.2 秒算说完
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
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
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
            phase = .idle
            face.send(["type": "robot_state", "state": "idle", "emotion": "neutral"])
            return
        }
        log("听到：\(text)")
        phase = .thinking
        face.send(["type": "robot_state", "state": "thinking", "emotion": "neutral"])
        llmTask = Task { await self.ask(text) }
    }

    // MARK: 想

    private func ask(_ text: String) async {
        history.append(["role": "user", "content": text])
        if history.count > 12 { history.removeFirst(history.count - 12) }
        let messages = [["role": "system", "content": Chat.persona]] + history
        do {
            let reply = try await Chat.complete(base: store.llmBase, key: store.llmKey, model: store.llmModel, messages: messages)
            guard phase == .thinking, !Task.isCancelled else { return }
            history.append(["role": "assistant", "content": reply])
            let (emotion, clean) = Chat.parse(reply)
            log("回答：\(clean)")
            say(clean.isEmpty ? "嗯。" : clean, emotion: emotion)
        } catch {
            guard phase == .thinking, !Task.isCancelled else { return }
            history.removeLast()
            log("大模型出错：\(error.localizedDescription)")
            say("我好像连不上大脑了。", emotion: "confused")
        }
    }

    // MARK: 说

    private func say(_ text: String, emotion: String) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        u.rate = 0.52
        u.pitchMultiplier = 1.15
        phase = .speaking
        face.send(["type": "robot_state", "state": "speaking", "emotion": emotion])
        synth.speak(u)
    }

    fileprivate func doneSpeaking() {
        guard phase == .speaking else { return }
        phase = .idle
        face.send(["type": "robot_state", "state": "idle"])
        // 说完保持一会儿情绪，再回到平静
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.phase == .idle else { return }
            self.face.send(["type": "robot_state", "emotion": "neutral"])
        }
    }
}

extension Talk: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.doneSpeaking() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.doneSpeaking() }
    }
}

/// 大模型：OpenAI 兼容的 /chat/completions 接口（DeepSeek、智谱、通义、Kimi、OpenAI 等都行）。
enum Chat {
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

    static func complete(base: String, key: String, model: String, messages: [[String: String]]) async throws -> String {
        var b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        guard let url = URL(string: b + "/chat/completions") else { throw Failure(message: "接口地址不对") }
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["model": model, "messages": messages, "temperature": 0.8, "max_tokens": 400]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure(message: "接口返回 \(code)") }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let msg = choices.first?["message"] as? [String: Any],
              let content = msg["content"] as? String else {
            throw Failure(message: "看不懂接口的回复")
        }
        return content
    }

    /// 取出情绪标签，去掉朗读时不该念的东西
    static func parse(_ reply: String) -> (emotion: String, text: String) {
        var emotion = "neutral"
        if let r = reply.range(of: #"\[[A-Za-z]+\]"#, options: .regularExpression) {
            let tag = String(reply[r].dropFirst().dropLast()).lowercased()
            if ["neutral", "happy", "surprised", "confused", "alert"].contains(tag) { emotion = tag }
        }
        var text = reply.replacingOccurrences(of: #"(?s)<think>.*?</think>"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\[[A-Za-z]+\]"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[*#`>_|]"#, with: "", options: .regularExpression)
        return (emotion, text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
