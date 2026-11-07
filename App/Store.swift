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
    /// 打开 App 时自动连大疆云台
    @Published var gimbalAuto: Bool { didSet { save("gimbalAuto", gimbalAuto ? "1" : "") } }

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
        base = load("base") ?? "https://langhua1998-xiaoju-cloud.hf.space"
        device = load("device") ?? UIDeviceName()
        pair = Keychain.get("pair") ?? ""
        token = Keychain.get("token") ?? ""
        // 默认用 DeepSeek；模型只在 Store.llmModels 两个里选
        llmBase = load("llmBase") ?? Store.defaultLLMBase
        llmModel = load("llmModel").flatMap { m in Store.llmModels.contains { $0.id == m } ? m : nil } ?? Store.llmModels[0].id
        llmKey = Keychain.get("llmKey") ?? ""
        gimbalAuto = d.object(forKey: "gimbalAuto") is Bool ? d.bool(forKey: "gimbalAuto") : (load("gimbalAuto") == "1")
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
