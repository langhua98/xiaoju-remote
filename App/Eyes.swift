import AVFoundation
import Foundation
import UIKit
import Vision

/// 她的眼睛：拍一张照片，变成一段文字交给聊天的大模型（聊天的模型自己不用会看图）。
/// 见 Robot/GIMBAL_MODEL_PLAN.md 的「看」。两层：
/// 1. 手机自带的识别（系统的 Vision，在手机里算，不联网、不要密钥）：有几个人、画面大概是什么东西、看到什么字。比较粗。
/// 2. 设置里填了「眼睛」模型（能看图的大模型，OpenAI 兼容接口）就把照片发给它，让它描述，细得多；发不通时退回第 1 层。
///
/// 规则（AGENTS.md）：设置里「允许她用摄像头看」默认关；只在 App 在前台时拍；拍的时候屏幕上方亮摄像头的提示；
/// 照片不存到手机上，只在填了「眼睛」模型时发给主人自己配的那个接口；日志里只记拍了多大，不记内容。
enum Eyes {
    /// 长边缩到多少像素、JPEG 质量：够看清东西，又不至于传得慢
    static let maxSide: CGFloat = 768, quality: CGFloat = 0.6
    /// 手机自带的识别：一类东西至少多大把握才算、最多说几样、最多读几行字
    static let minConfidence: Float = 0.3, maxLabels = 8, maxLines = 8

    /// 跟随开着的时候前摄被它占着，从它那里拿一帧（RemoteEngine 启动时填上）
    static var borrowFrame: (() async -> Data?)?

    /// 看一眼。front：用前摄（屏幕朝着的方向）还是后摄。返回给大模型看的一段话，和给记录用的一句话
    @MainActor
    static func look(front: Bool, store: Store, face: FaceBridge) async -> (text: String, log: String) {
        guard store.allowSee else {
            return ("主人没有打开「允许她用摄像头看」，你现在看不见。可以请主人到设置里打开。", "没开「允许她用摄像头看」")
        }
        guard UIApplication.shared.applicationState == .active else {
            return ("App 不在前台，摄像头用不了。", "App 不在前台")
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            return ("没有相机权限，看不了。请主人在 设置 → Vania 里打开相机。", "没有相机权限")
        case .notDetermined:
            if !(await AVCaptureDevice.requestAccess(for: .video)) { return ("主人没有允许用相机，看不了。", "没有相机权限") }
        default:
            break
        }
        face.send(["type": "sensing", "camera": true])
        defer { face.send(["type": "sensing", "camera": false]) }

        var usedFront = front
        var raw: Data?
        if let borrowed = await borrowFrame?() {
            raw = borrowed; usedFront = true          // 跟随开着：只能用它正在用的前摄
        } else {
            raw = try? await PhotoCapturer().capture(front: front)
        }
        guard let data = raw, let image = UIImage(data: data), let jpeg = shrink(image) else {
            return ("摄像头没拍到画面，看不了。", "没拍到")
        }
        let which = usedFront ? "前面的摄像头（屏幕朝着的方向）" : "后面的摄像头（手机背面朝着的方向）"
        let size = "\(jpeg.count / 1024) KB"

        // 第 2 层：填了「眼睛」模型就问它
        if !store.eyeBase.isEmpty, !store.eyeModel.isEmpty, !store.eyeKey.isEmpty {
            do {
                let said = try await describe(jpeg, base: store.eyeBase, model: store.eyeModel, key: store.eyeKey)
                return ("你用\(which)看了一眼，看到的是：\(said)", "看了一眼（\(usedFront ? "前" : "后")摄，\(size)，眼睛模型）")
            } catch {
                let local = await recognize(jpeg)
                return ("你用\(which)看了一眼。眼睛模型没连上，下面是手机自己认出来的，比较粗：\(local)",
                        "看了一眼（\(usedFront ? "前" : "后")摄，\(size)，眼睛模型出错：\(error.localizedDescription)，改用手机自带的识别）")
            }
        }
        // 第 1 层
        let local = await recognize(jpeg)
        return ("你用\(which)看了一眼。下面是手机自己认出来的，比较粗，只有大类，没有细节：\(local)", "看了一眼（\(usedFront ? "前" : "后")摄，\(size)，手机自带的识别）")
    }

    /// 缩小并压成 JPEG（顺便把方向摆正）
    static func shrink(_ image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let k = min(1, maxSide / longest)
        let size = CGSize(width: (image.size.width * k).rounded(), height: (image.size.height * k).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return small.jpegData(compressionQuality: quality)
    }

    // MARK: 第 1 层：手机自带的识别

    /// 认出来的东西写成一句话。东西的名字是系统给的英文词（比如 bookshelf、bed），聊天的大模型看得懂
    static func recognize(_ jpeg: Data) async -> String {
        await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                c.resume(returning: recognizeNow(jpeg))
            }
        }
    }

    private static func recognizeNow(_ jpeg: Data) -> String {
        let faces = VNDetectFaceRectanglesRequest()
        let people = VNDetectHumanRectanglesRequest()
        let things = VNClassifyImageRequest()
        let animals = VNRecognizeAnimalsRequest()
        let words = VNRecognizeTextRequest()
        words.recognitionLevel = .accurate
        words.recognitionLanguages = ["zh-Hans", "en-US"]
        words.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(data: jpeg, options: [:])
        // 一个一个跑：哪个不支持（比如旧系统不认中文）也不影响别的
        for r in [faces, people, things, animals, words] as [VNRequest] { try? handler.perform([r]) }

        var parts: [String] = []
        let faceCount = faces.results?.count ?? 0, peopleCount = people.results?.count ?? 0
        if faceCount > 0 || peopleCount > 0 {
            let n = max(faceCount, peopleCount)
            parts.append("有 \(n) 个人" + (faceCount > 0 ? "（看得到 \(faceCount) 张脸）" : "（看不到正脸）"))
        } else {
            parts.append("没有看到人")
        }
        let pets = (animals.results ?? []).flatMap { $0.labels }.filter { $0.confidence >= 0.5 }.map { $0.identifier }
        if !pets.isEmpty { parts.append("有动物：" + Array(Set(pets)).joined(separator: "、")) }
        let labels = (things.results ?? []).filter { $0.confidence >= minConfidence }
            .sorted { $0.confidence > $1.confidence }.prefix(maxLabels).map { $0.identifier.replacingOccurrences(of: "_", with: " ") }
        if !labels.isEmpty { parts.append("画面里可能有（英文是系统给的类别名）：" + labels.joined(separator: "、")) }
        let lines = (words.results ?? []).compactMap { $0.topCandidates(1).first }.filter { $0.confidence >= 0.4 }
            .map { $0.string.trimmingCharacters(in: .whitespaces) }.filter { $0.count >= 2 }.prefix(maxLines)
        if !lines.isEmpty { parts.append("看到的字：" + lines.joined(separator: "；")) }
        if labels.isEmpty && lines.isEmpty && faceCount == 0 && peopleCount == 0 { parts.append("认不出画面里是什么（可能太暗或者太近）") }
        return parts.joined(separator: "。") + "。"
    }

    // MARK: 第 2 层：「眼睛」模型（OpenAI 兼容接口，能看图的）

    private struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func describe(_ jpeg: Data, base: String, model: String, key: String) async throws -> String {
        var b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        guard let url = URL(string: b + "/chat/completions") else { throw Failure(message: "接口地址不对") }
        var req = URLRequest(url: url, timeoutInterval: 25)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let prompt = "用两三句中文口语说出这张照片里有什么：有没有人、人在做什么、主要的东西和它们的位置（左边、右边、中间）、看得清的文字。只说看得到的，看不清就说看不清，不要猜，不要用列表。"
        let content: [[String: Any]] = [
            ["type": "text", "text": prompt],
            ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64," + jpeg.base64EncodedString()]],
        ]
        let body: [String: Any] = ["model": model, "messages": [["role": "user", "content": content]], "max_tokens": 300, "temperature": 0.2]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure(message: "接口返回 \(code)") }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let text = (message["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            throw Failure(message: "接口没有给出描述")
        }
        return text
    }
}
