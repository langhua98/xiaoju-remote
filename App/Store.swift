import Foundation
import Security
import UIKit

/// 令牌存钥匙串，其它设置存 UserDefaults。
final class Store: ObservableObject {
    @Published var base: String { didSet { save("base", base) } }
    @Published var device: String { didSet { save("device", device) } }
    @Published var pair: String { didSet { Keychain.set("pair", pair) } }
    @Published var token: String { didSet { Keychain.set("token", token) } }
    // 机器人对话用的大模型（OpenAI 兼容接口）。密钥只存钥匙串
    @Published var llmBase: String { didSet { save("llmBase", llmBase) } }
    @Published var llmModel: String { didSet { save("llmModel", llmModel) } }
    @Published var llmKey: String { didSet { Keychain.set("llmKey", llmKey) } }
    /// Gemini API 密钥：填了就用实时语音对话（Live.swift），只存钥匙串
    @Published var geminiKey: String { didSet { Keychain.set("geminiKey", geminiKey) } }
    /// 打开 App 时自动连大疆云台
    @Published var gimbalAuto: Bool { didSet { save("gimbalAuto", gimbalAuto ? "1" : "") } }
    /// 机器人穿哪套衣服（default = Yuki_outfit1.glb，outfit2 = Yuki_outfit2.glb，见 Robot/live2d/src/avatar.js 的 OUTFITS）
    @Published var outfit: String { didSet { save("outfit", outfit) } }
    /// 打开 App 时自动开始待命（令牌填了才会开）
    @Published var autoStandby: Bool { didSet { save("autoStandby", autoStandby ? "1" : "") } }
    /// 机器人的画质：high = 全部效果，low = 省电（不描边、不算物理、贴图缩到 1024）
    @Published var faceQuality: String { didSet { save("faceQuality", faceQuality) } }

    /// 画质 → 网页的网址参数（见 Robot/README.md「开关」）
    static func faceQuery(quality: String) -> String {
        quality == "low" ? "&outline=0&spring=0&tex=1024" : ""
    }

    /// 衣服列表：id、名字、对她说话时认的叫法。新加衣服时这里和 Robot/live2d/src/avatar.js 的 OUTFITS、fetch-assets.sh 一起加
    static let outfits: [(id: String, name: String, words: [String])] = [
        ("default", "校服", ["校服", "原版", "原来", "第一套", "一号"]),
        ("outfit2", "洋装", ["洋装", "裙子", "婚纱", "第二套", "二号"]),
    ]

    /// 「换上洋装」「穿黑色的」「换回原来的」→ 衣服 id；不是换装的话返回 nil
    /// current：现在穿的；没说是哪套（「换件衣服」「换一套」）就换下一套
    static func outfitCommand(_ raw: String, current: String = "default") -> String? {
        let text = simplified(raw)
        guard ["换", "穿上", "穿回"].contains(where: { text.contains($0) }) else { return nil }
        if text.contains("换回") || text.contains("穿回") { return "default" }
        if let id = outfitID(named: text) { return id }
        if ["换件衣服", "换个衣服", "换衣服", "换一套", "换套衣服", "换身衣服", "换装", "换一身"].contains(where: { text.contains($0) }) {
            let i = outfits.firstIndex { $0.id == current } ?? 0
            return outfits[(i + 1) % outfits.count].id
        }
        return nil
    }

    /// 名字、叫法或 id → 衣服 id（大模型的换装标签、工具调用也用这个）
    static func outfitID(named raw: String) -> String? {
        let text = simplified(raw)
        if let o = outfits.first(where: { $0.id == text.trimmingCharacters(in: .whitespaces) }) { return o.id }
        return outfits.first { o in o.words.contains { text.contains($0) } }?.id
    }

    /// 语音转写有时给繁体（換、經、黑白經典），先转简体再比
    static func simplified(_ s: String) -> String {
        (s.applyingTransform(StringTransform("Hant-Hans"), reverse: false) ?? s).replacingOccurrences(of: " ", with: "")
    }

    static func outfitName(_ id: String) -> String { outfits.first { $0.id == id }?.name ?? "原版" }

    private let d = UserDefaults.standard

    static let defaultLLMBase = "https://api.deepseek.com/v1"
    /// 可选的两个模型（DeepSeek）
    static let llmModels: [(id: String, name: String)] = [
        ("deepseek-chat", "对话（快）"),
        ("deepseek-reasoner", "深度思考（慢）"),
    ]

    /// 设置填一次就记住：存 UserDefaults，同时在钥匙串里留一份备份（App 设置被清掉时从钥匙串找回来）。
    /// 令牌、口令、API 密钥只存钥匙串。
    private func save(_ key: String, _ value: String) {
        d.set(value, forKey: key)
        Keychain.set("setting." + key, value)
    }

    private static func load(_ key: String) -> String? {
        UserDefaults.standard.string(forKey: key)?.nonEmpty ?? Keychain.get("setting." + key)?.nonEmpty
    }

    init() {
        let load = Store.load
        base = load("base") ?? "https://node.tail823dbd.ts.net"
        device = load("device") ?? UIDeviceName()
        pair = Keychain.get("pair") ?? ""
        token = Keychain.get("token") ?? ""
        // 默认用 DeepSeek；模型只在 Store.llmModels 两个里选
        llmBase = load("llmBase") ?? Store.defaultLLMBase
        llmModel = load("llmModel").flatMap { m in Store.llmModels.contains { $0.id == m } ? m : nil } ?? Store.llmModels[0].id
        llmKey = Keychain.get("llmKey") ?? ""
        geminiKey = Keychain.get("geminiKey") ?? ""
        gimbalAuto = d.object(forKey: "gimbalAuto") is Bool ? d.bool(forKey: "gimbalAuto") : (load("gimbalAuto") == "1")
        outfit = load("outfit").flatMap { id in Store.outfits.contains { $0.id == id } ? id : nil } ?? "default"
        faceQuality = load("faceQuality") == "low" ? "low" : "high"
        autoStandby = load("autoStandby") == "1"
    }

    // 处理过的指令 id（避免重复执行）
    func markSeen(_ id: String) {
        var s = Set(d.stringArray(forKey: "seen") ?? [])
        s.insert(id)
        d.set(Array(s.suffix(500)), forKey: "seen")
    }
    func isSeen(_ id: String) -> Bool {
        (d.stringArray(forKey: "seen") ?? []).contains(id)
    }
}

private func UIDeviceName() -> String {
    #if canImport(UIKit)
    return UIDevice.current.name
    #else
    return "iPhone"
    #endif
}

extension String { var nonEmpty: String? { isEmpty ? nil : self } }

enum Keychain {
    static func set(_ key: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: "xiaoju-remote",
                                kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        guard !value.isEmpty else { return }
        var add = q
        add[kSecValueData as String] = value.data(using: .utf8)!
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock   // 锁屏后台待命时也读得到
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: "xiaoju-remote",
                                kSecAttrAccount as String: key,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
