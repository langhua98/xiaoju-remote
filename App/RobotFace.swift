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

    /// 脸的页面已经加载好，可以收发消息
    var isReady: Bool { ready && webView != nil }

    /// 发一条消息给脸，并拿回 apply 的返回值（JSON 转回来的对象：Bool、字典…）。页面没好返回 nil
    func request(_ msg: [String: Any]) async -> Any? {
        guard let d = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: d, encoding: .utf8) else { return nil }
        return await evalJSON("window.YunlaiFace ? JSON.stringify(window.YunlaiFace.apply(\(s))) : null")
    }

    /// 脸现在的状态：衣服、状态、表情、镜头、朝向、正在做的动作…（window.YunlaiFace.get()）
    func status() async -> [String: Any]? {
        await evalJSON("window.YunlaiFace ? JSON.stringify(window.YunlaiFace.get()) : null") as? [String: Any]
    }

    private func evalJSON(_ js: String) async -> Any? {
        guard ready, let w = webView else { return nil }
        let text: String? = await withCheckedContinuation { c in
            w.evaluateJavaScript(js) { r, _ in c.resume(returning: r as? String) }
        }
        guard let data = text?.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
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
        case "robot":
            return   // 直接控制角色的指令，不另外变表情
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

/// 全屏的脸，App 的主界面。左上角齿轮打开设置；底部一直有一行淡淡的待命状态，被远程使用时看得出来。
struct RobotModeView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var engine: RemoteEngine
    var onSettings: () -> Void
    @State private var draft = ""
    @FocusState private var typing: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            // 画面不跟着键盘缩：键盘弹出来时只有下面的聊天框往上走
            FaceWebView(face: engine.face, outfit: store.outfit, quality: store.faceQuality,
                        onMessage: handle, onCrash: crashed).ignoresSafeArea()
            VStack(spacing: 8) {
                Captions(talk: engine.talk, live: engine.talk.live)
                    .padding(.horizontal, 18)
                    .allowsHitTesting(false)
                ChatBar(talk: engine.talk, live: engine.talk.live, draft: $draft, typing: $typing, onSend: submit)
                    .padding(.horizontal, 12)
                StatusLine(talk: engine.talk, live: engine.talk.live, prefix: engine.running ? "● 待命中 · \(store.device)" : "○ 未待命")
                    .font(.caption2)
                    .foregroundColor(.white.opacity(0.35))
                    .allowsHitTesting(false)
            }
            .padding(.bottom, 4)
        }
        .overlay(alignment: .topLeading) {
            Button(action: onSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 17))
                    .foregroundColor(.white.opacity(0.55))
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(Color.black.opacity(0.25)))
            }
            .padding(.leading, 12)
            .padding(.top, 8)
        }
        .statusBar(hidden: true)
        .onChange(of: store.outfit) { id in engine.face.send(["type": "outfit", "id": id]) }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            engine.talk.warmUp()
            engine.face.send(["type": "outfit", "id": store.outfit])
        }
        .onDisappear {
            engine.talk.cancel()
            if !engine.running { UIApplication.shared.isIdleTimerDisabled = false }
        }
        .onChange(of: store.faceQuality) { _ in engine.record("画质改成：\(store.faceQuality == "low" ? "省电" : "高")，重新加载画面") }
    }

    /// 聊天框发送：短指令直接做，其余的话交给她回答（见 Talk.typed）
    private func submit() {
        let text = draft
        draft = ""
        typing = false
        engine.talk.typed(text)
    }

    /// 网页进程被系统关掉（多半是内存不够）后已经用省电画质重新打开：记一笔，把衣服再发一次
    private func crashed() {
        engine.record("画面进程被系统关掉了（多半是内存不够），已用省电画质重新打开")
        engine.face.send(["type": "outfit", "id": store.outfit])
    }

    /// 点一下：正在打字就收起键盘；她在想、在说、在实时聊天时打断 / 结束；闲着时什么都不做（开始聊天用麦克风按钮）。
    /// 闲着的时候点到她的头或手，页面自己会让她做反应。
    private func handle(_ msg: [String: Any]) {
        if (msg["type"] as? String) == "outfit_done" {
            let id = msg["id"] as? String ?? ""
            if (msg["ok"] as? Bool) == true { engine.record("换上了：\(Store.outfitName(id))") }
            else { engine.record("换装失败（\(id)）：\(msg["error"] as? String ?? "不知道为什么")") }
            return
        }
        guard (msg["type"] as? String) == "touch" else { return }
        if typing { typing = false; return }
        let talk = engine.talk
        if talk.phase != .idle || talk.live.phase != .off { talk.tap() }
    }
}

/// 底部那行淡淡的状态：待命情况 + 对话进行到哪一步
private struct StatusLine: View {
    @ObservedObject var talk: Talk
    @ObservedObject var live: LiveTalk
    let prefix: String

    var body: some View {
        Text("\(prefix) · \(hint)")
    }

    private var hint: String {
        switch live.phase {
        case .connecting: return "正在连实时语音"
        case .listening: return "实时对话中，直接说话或打字"
        case .speaking: return "直接说话就能打断她"
        case .off: break
        }
        switch talk.phase {
        case .idle: return "打字或点麦克风聊天"
        case .listening: return talk.conversing ? "在听，说「再见」结束" : "正在听"
        case .thinking: return "在想"
        case .speaking: return "点一下打断"
        }
    }
}

/// 在 SwiftUI 的 View 里写 Body 指的是 View 自己的 Body 类型，所以给 Body.swift 的 Body 起个别名
private typealias RobotBody = Body

/// 聊天框上面的字幕：你刚说的（靠右、淡一点）和她正在说的
private struct Captions: View {
    @ObservedObject var talk: Talk
    @ObservedObject var live: LiveTalk

    var body: some View {
        let her = live.phase != .off ? live.caption : talk.subtitle
        VStack(spacing: 6) {
            if !talk.userLine.isEmpty {
                HStack {
                    Spacer(minLength: 60)
                    Text(talk.userLine)
                        .font(.footnote)
                        .foregroundColor(.white.opacity(0.85))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.16)))
                }
            }
            if !her.isEmpty {
                HStack {
                    Text(her)
                        .font(.subheadline)
                        .foregroundColor(.white)
                        .lineLimit(4)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.42)))
                    Spacer(minLength: 40)
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: talk.userLine)
    }
}

/// 最下面的聊天框：左边是快捷动作菜单，中间打字，右边有字时是发送、没字时是麦克风（语音聊天）。
private struct ChatBar: View {
    @ObservedObject var talk: Talk
    @ObservedObject var live: LiveTalk
    @Binding var draft: String
    var typing: FocusState<Bool>.Binding
    var onSend: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            // 快捷菜单：Body.menu 里的全部短指令，按类分成子菜单，点一下就执行
            Menu {
                ForEach(RobotBody.menu.indices, id: \.self) { g in
                    Menu(RobotBody.menu[g].title) {
                        ForEach(RobotBody.menu[g].items.indices, id: \.self) { i in
                            Button(RobotBody.menu[g].items[i].name) { talk.typed(RobotBody.menu[g].items[i].name) }
                        }
                    }
                }
            } label: {
                icon("sparkles")
            }

            TextField("输入消息……", text: $draft)
                .focused(typing)
                .submitLabel(.send)
                .onSubmit(onSend)
                .disableAutocorrection(true)
                .foregroundColor(.white)
                .padding(.horizontal, 16)
                .frame(height: 42)
                .background(Capsule().fill(Color.black.opacity(0.38)))
                .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1))

            if draft.trimmingCharacters(in: .whitespaces).isEmpty {
                Button { talk.tap() } label: { icon(micIcon, active: micActive) }
            } else {
                Button(action: onSend) { icon("paperplane.fill", active: true) }
            }
        }
        .colorScheme(.dark)
    }

    /// 麦克风按钮：闲着是麦克风（点了开始语音聊天）；在听、在想、在说、实时聊天中是停止（点了结束 / 打断）
    private var micActive: Bool { talk.phase != .idle || live.phase != .off }
    private var micIcon: String {
        if live.phase != .off { return "phone.down.fill" }
        switch talk.phase {
        case .idle: return "mic.fill"
        case .listening: return "waveform"
        case .thinking, .speaking: return "stop.fill"
        }
    }

    private func icon(_ name: String, active: Bool = false) -> some View {
        Image(systemName: name)
            .font(.system(size: 17, weight: .semibold))
            .foregroundColor(active ? .white : .white.opacity(0.8))
            .frame(width: 42, height: 42)
            .background(Circle().fill(active ? brandOrange.opacity(0.85) : Color.black.opacity(0.38)))
            .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 1))
    }
}

/// WKWebView 用自定义的 yunlai:// 地址读 App 里的网页文件，这样模型、贴图都算同源，不会被浏览器拦。
struct FaceWebView: UIViewRepresentable {
    let face: FaceBridge
    /// 一打开就穿哪套衣服（之后换装走消息，不重新加载）
    var outfit: String = "default"
    /// 画质（high / low）：改了会重新加载页面
    var quality: String = "high"
    var onMessage: ([String: Any]) -> Void
    var onCrash: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(face: face, onMessage: onMessage, onCrash: onCrash, quality: quality) }

    static func pageURL(outfit: String, quality: String) -> URL? {
        let o = outfit.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "default"
        return URL(string: "\(BundleSchemeHandler.scheme)://face/index.html?demo=0&outfit=\(o)\(Store.faceQuery(quality: quality))")
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
        if let url = Self.pageURL(outfit: outfit, quality: quality) {
            w.load(URLRequest(url: url))
        }
        return w
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        let c = context.coordinator
        c.onMessage = onMessage
        c.onCrash = onCrash
        // 设置里改了画质：用新的画质重新加载（衣服沿用现在的）
        if quality != c.quality, let url = Self.pageURL(outfit: outfit, quality: quality) {
            c.quality = quality
            face.pageClosed()
            uiView.load(URLRequest(url: url))
        }
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
        /// 设置里选的画质（崩溃后临时降成省电不改这个，免得又被改回去再崩）
        var quality: String
        private var crashes = 0
        private var reloading = false

        init(face: FaceBridge, onMessage: @escaping ([String: Any]) -> Void, onCrash: @escaping () -> Void, quality: String) {
            self.face = face
            self.onMessage = onMessage
            self.onCrash = onCrash
            self.quality = quality
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
            guard crashes <= 3, let url = FaceWebView.pageURL(outfit: "default", quality: "low") else { return }
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
