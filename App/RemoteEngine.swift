import Foundation
import UIKit

@MainActor
final class RemoteEngine: ObservableObject {
    @Published var running = false
    @Published var log: [String] = []
    /// 机器人模式的脸，指令执行时跟着变表情（见 RobotFace.swift）
    let face = FaceBridge()

    private let store: Store
    private var task: Task<Void, Never>?

    init(store: Store) { self.store = store }

    func start() {
        guard !running else { return }
        guard !store.token.isEmpty else { push("先填云盘令牌"); return }
        running = true
        UIApplication.shared.isIdleTimerDisabled = true   // 待命时屏幕不自动锁
        push("开始待命")
        task = Task { await loop() }
    }

    func stop() {
        running = false
        task?.cancel()
        task = nil
        UIApplication.shared.isIdleTimerDisabled = false
        push("已停止")
    }

    private func push(_ s: String) {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
        log.append("\(f.string(from: Date()))  \(s)")
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }

    private func loop() async {
        let cloud = Cloud(base: store.base, token: store.token)
        let device = store.device
        let inbox = "/小橘推送/遥控/\(device)/收件"
        let filesDir = "/小橘推送/遥控/\(device)/文件"

        if let name = try? await cloud.me() { push("云盘：\(name)") } else { push("连不上云盘") }

        var useRelay = true
        var lastFileCheck = Date.distantPast
        var lastError = ""

        while !Task.isCancelled {
            // 快路：即时信箱，长轮询，指令一到马上执行
            if useRelay {
                do {
                    let msgs = try await cloud.relayWait(RemoteBox.inbox(device))
                    lastError = ""
                    for cmd in msgs { await execute(cloud, cmd, device: device, viaRelay: true, filesDir: filesDir) }
                } catch {
                    if Cloud.relayMissing(error) {
                        useRelay = false
                        push("云盘服务端还没有即时信箱，用文件信箱（会慢几秒）")
                    } else {
                        let msg = error.localizedDescription
                        if msg != lastError { push("收件箱读不了：\(msg)") }
                        lastError = msg
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                    }
                }
                // 旧的发送端还会写文件信箱，每 30 秒看一眼
                if Date().timeIntervalSince(lastFileCheck) < 30 { continue }
            }
            lastFileCheck = Date()
            let items = await cloud.list(inbox)
                .filter { !$0.isFolder && $0.name.hasSuffix(".json") }
                .sorted { $0.name < $1.name }
            for it in items where !store.isSeen(it.id) {
                store.markSeen(it.id)
                guard let data = try? await cloud.download(it.id),
                      var cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    push("收到一条看不懂的指令，跳过"); continue
                }
                if cmd["id"] == nil { cmd["id"] = it.name.replacingOccurrences(of: ".json", with: "") }
                await execute(cloud, cmd, device: device, viaRelay: false, filesDir: filesDir)
            }
            if !useRelay { try? await Task.sleep(nanoseconds: 2_000_000_000) }
        }
    }

    /// 执行一条指令。回执原路返回：从即时信箱来的回到即时信箱（照片 base64 直接放在回执里），从文件来的写回执文件。
    private func execute(_ cloud: Cloud, _ cmd: [String: Any], device: String, viaRelay: Bool, filesDir: String) async {
        let id = (cmd["id"] as? String) ?? UUID().uuidString
        let outbox = "/小橘推送/遥控/\(device)/回执"

        func reply(_ r: [String: Any]) async {
            do {
                if viaRelay { try await cloud.relaySend(RemoteBox.receipt(device, id), r) }
                else { try await cloud.uploadText("\(outbox)/\(id).json", jsonString(r)) }
            } catch { push("传回执失败：\(error.localizedDescription)") }
        }

        if !store.pair.isEmpty, (cmd["pair"] as? String) != store.pair {
            push("有一条指令口令不对，拒绝")
            face.commandRejected()
            await reply(["id": id, "ok": false, "text": "配对口令不对"])
            return
        }

        let action = cmd["do"] as? String ?? ""
        push("执行：\(action)")
        face.commandStarted(action)
        let result = await Commands.run(cmd)
        face.commandFinished(ok: !result.text.hasPrefix("执行出错"))

        var files: [Any] = []
        for (name, bytes) in result.files {
            if viaRelay && bytes.count <= RemoteBox.inlineLimit {
                files.append(["name": name, "data": bytes.base64EncodedString()])
                continue
            }
            let path = "\(filesDir)/\(id)-\(name)"
            let ctype = name.hasSuffix(".jpg") ? "image/jpeg" : "application/octet-stream"
            if (try? await cloud.upload(path, bytes, contentType: ctype)) != nil { files.append(path) }
            else { push("传文件失败：\(name)") }
        }

        let f = DateFormatter(); f.dateFormat = "MM-dd HH:mm:ss"
        await reply(["id": id, "do": action, "ok": true,
                     "text": result.text, "files": files, "at": f.string(from: Date())])
        push("完成：\(action) — \(result.text.split(separator: "\n").first.map(String.init) ?? "")")
    }

    private func jsonString(_ obj: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}

/// 即时信箱的名字。要和「小橘推送」控制端、scripts/遥控.py 保持一致（协议见 AGENTS.md）。
enum RemoteBox {
    static func inbox(_ dev: String) -> String { "遥控/\(dev)/收件" }
    static func receipt(_ dev: String, _ id: String) -> String { "遥控/\(dev)/回执/\(id)" }
    /// 回执里直接带的文件最大多少（base64 之后要小于服务端单条 8 MB）
    static let inlineLimit = 5 << 20
}
