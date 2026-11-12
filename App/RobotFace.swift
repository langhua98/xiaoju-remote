import SwiftUI
import WebKit

/// 机器人模式：整个屏幕是 3D 角色（Yuki）（打包进 App 的 Robot/live2d 网页）。
/// 待命循环收到指令时，通过 FaceBridge 告诉脸，让表情跟着变。
@MainActor
final class FaceBridge: ObservableObject {
    weak var webView: WKWebView?
    private var ready = false
    private var pending: [String] = []

    /// 发一条消息给脸，格式见 Robot/README.md（robot_state、sensing 等）
    func send(_ msg: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: msg),
              let s = String(data: d, encoding: .utf8) else { return }
        let js = "window.YunlaiFace && window.YunlaiFace.apply(\(s))"
        if ready, let w = webView {
            w.evaluateJavaScript(js, completionHandler: nil)
        } else {
            pending.append(js)
            if pending.count > 20 { pending.removeFirst() }
        }
    }

    func pageLoaded(_ w: WKWebView) {
        webView = w
        ready = true
        for js in pending { w.evaluateJavaScript(js, completionHandler: nil) }
        pending.removeAll()
    }

    func pageClosed() {
        ready = false
        webView = nil
    }

    // MARK: 待命循环里的事件 → 表情

    func commandStarted(_ action: String) {
        switch action {
        case "photo":
            send(["type": "sensing", "camera": true])
            send(["type": "robot_state", "state": "observing", "emotion": "neutral"])
        case "audio":
            send(["type": "sensing", "mic": true])
            send(["type": "robot_state", "state": "listening", "emotion": "neutral"])
        case "ring":
            send(["type": "robot_state", "state": "speaking", "emotion": "surprised"])
        case "gimbal":
            send(["type": "robot_state", "state": "observing", "emotion": "neutral"])
        default:
            send(["type": "robot_state", "state": "thinking", "emotion": "neutral"])
        }
    }

    func commandFinished(ok: Bool) {
        send(["type": "sensing", "camera": false, "mic": false])
        send(["type": "robot_state", "state": "idle", "emotion": ok ? "happy" : "confused", "duration_ms": 1500])
    }

    func commandRejected() {
        send(["type": "robot_state", "state": "idle", "emotion": "confused", "duration_ms": 2000])
    }
}

/// 全屏的脸。连点三下退出；底部一直有一行淡淡的待命状态，被远程使用时看得出来。
struct RobotModeView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var engine: RemoteEngine
    var onExit: () -> Void
    @State private var taps: [Date] = []
    @State private var tapGen = 0

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            FaceWebView(face: engine.face, query: "&outfit=\(store.outfit)" + Store.faceQuery(quality: store.faceQuality),
                        onMessage: handle, onCrash: crashed).ignoresSafeArea()
            StatusLine(talk: engine.talk, live: engine.talk.live, prefix: engine.running ? "● 待命中 · \(store.device)" : "○ 未待命")
                .font(.caption2)
                .foregroundColor(.white.opacity(0.35))
                .padding(.bottom, 6)
                .allowsHitTesting(false)
        }
        .statusBar(hidden: true)
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            engine.talk.warmUp()
            engine.face.send(["type": "outfit", "id": store.outfit])
        }
        .onDisappear {
            engine.talk.cancel()
            if !engine.running { UIApplication.shared.isIdleTimerDisabled = false }
        }
    }

    /// 网页进程被系统关掉（多半是内存不够）后已经用省电画质重新打开：记一笔，把衣服再发一次
    private func crashed() {
        engine.record("画面进程被系统关掉了（多半是内存不够），已用省电画质重新打开")
        engine.face.send(["type": "outfit", "id": store.outfit])
    }

    /// 点一下：说话 / 打断；连点三下：退出。等 0.45 秒看还有没有下一下，避免两种操作打架。
    /// 闲着的时候点到她的头或手（消息里的 part），她自己会有反应，这一下不算「开始聊天」。
    private func handle(_ msg: [String: Any]) {
        if (msg["type"] as? String) == "outfit_done" {
            let id = msg["id"] as? String ?? ""
            if (msg["ok"] as? Bool) == true { engine.record("换上了：\(Store.outfitName(id))") }
            else { engine.record("换装失败（\(id)）：\(msg["error"] as? String ?? "不知道为什么")") }
            return
        }
        guard (msg["type"] as? String) == "touch" else { return }
        let part = msg["part"] as? String ?? ""
        let petting = ["head", "hand_l", "hand_r"].contains(part) && engine.talk.phase == .idle && engine.talk.live.phase == .off
        let now = Date()
        taps = taps.filter { now.timeIntervalSince($0) < 1.2 } + [now]
        if taps.count >= 3 {
            taps = []
            tapGen += 1
            engine.talk.cancel()
            onExit()
            return
        }
        tapGen += 1
        let gen = tapGen
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            guard gen == tapGen else { return }
            if taps.count == 1 && !petting { engine.talk.tap() }
            taps = []
        }
    }
}

/// 底部那行淡淡的状态：待命情况 + 对话进行到哪一步
private struct StatusLine: View {
    @ObservedObject var talk: Talk
    @ObservedObject var live: LiveTalk
    let prefix: String

    var body: some View {
        Text("\(prefix) · \(hint) · 连点三下退出")
    }

    private var hint: String {
        switch live.phase {
        case .connecting: return "正在连实时语音"
        case .listening: return "实时对话中，直接说话，点一下结束"
        case .speaking: return "直接说话就能打断她"
        case .off: break
        }
        switch talk.phase {
        case .idle: return "点一下开始聊天"
        case .listening: return talk.conversing ? "在听，说「再见」结束" : "正在听"
        case .thinking: return "在想"
        case .speaking: return "点一下打断"
        }
    }
}

/// WKWebView 用自定义的 yunlai:// 地址读 App 里的网页文件，这样模型、贴图都算同源，不会被浏览器拦。
struct FaceWebView: UIViewRepresentable {
    let face: FaceBridge
    /// 加在网址后面的参数（穿哪套衣服、画质），比如 "&outfit=outfit2&outline=0"
    var query: String = ""
    var onMessage: ([String: Any]) -> Void
    var onCrash: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(face: face, onMessage: onMessage, onCrash: onCrash) }

    static func pageURL(_ query: String) -> URL? {
        URL(string: "\(BundleSchemeHandler.scheme)://face/index.html?demo=0\(query)")
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.userContentController.add(context.coordinator, name: "yunlai")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let w = WKWebView(frame: .zero, configuration: config)
        w.isOpaque = false
        w.backgroundColor = .black
        w.scrollView.backgroundColor = .black
        w.scrollView.isScrollEnabled = false
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.navigationDelegate = context.coordinator
        if let url = Self.pageURL(query) {
            w.load(URLRequest(url: url))
        }
        return w
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.onMessage = onMessage
        context.coordinator.onCrash = onCrash
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "yunlai")
        coordinator.face.pageClosed()
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let face: FaceBridge
        var onMessage: ([String: Any]) -> Void
        var onCrash: () -> Void
        private var crashes = 0
        private var reloading = false

        init(face: FaceBridge, onMessage: @escaping ([String: Any]) -> Void, onCrash: @escaping () -> Void) {
            self.face = face
            self.onMessage = onMessage
            self.onCrash = onCrash
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if let body = message.body as? [String: Any] { onMessage(body) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            face.pageLoaded(webView)
            if reloading {
                reloading = false
                onCrash()
            }
        }

        /// 网页进程被系统关掉（iPhone 7 Plus 只有 2 GB 内存，模型加贴图吃紧时会这样）：
        /// 屏幕会变成一片黑。用省电画质重新打开，最多试 3 次。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            face.pageClosed()
            crashes += 1
            guard crashes <= 3, let url = FaceWebView.pageURL(Store.faceQuery(quality: "low")) else { return }
            reloading = true
            webView.load(URLRequest(url: url))
        }
    }
}

/// 把 yunlai://face/<路径> 映射到 App 里的 live2d 文件夹（来自仓库的 Robot/live2d）。
@MainActor
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "yunlai"
    private let root = Bundle.main.url(forResource: "live2d", withExtension: nil)

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, let root = root else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        // 只允许读 live2d 文件夹里面的东西
        guard file.path.hasPrefix(root.standardizedFileURL.path + "/"),
              let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let headers = ["Content-Type": Self.mime(file.pathExtension), "Content-Length": String(data.count)]
        if let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(resp)
        }
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "glb": return "model/gltf-binary"
        default: return "application/octet-stream"
        }
    }
}
