import Foundation
import Security
import UIKit

/// 令牌存钥匙串，其它设置存 UserDefaults。
final class Store: ObservableObject {
    @Published var base: String { didSet { d.set(base, forKey: "base") } }
    @Published var device: String { didSet { d.set(device, forKey: "device") } }
    @Published var pair: String { didSet { Keychain.set("pair", pair) } }
    @Published var token: String { didSet { Keychain.set("token", token) } }
    // 机器人对话用的大模型（OpenAI 兼容接口）。密钥只存钥匙串
    @Published var llmBase: String { didSet { d.set(llmBase, forKey: "llmBase") } }
    @Published var llmModel: String { didSet { d.set(llmModel, forKey: "llmModel") } }
    @Published var llmKey: String { didSet { Keychain.set("llmKey", llmKey) } }
    /// 打开 App 时自动连大疆云台
    @Published var gimbalAuto: Bool { didSet { d.set(gimbalAuto, forKey: "gimbalAuto") } }

    private let d = UserDefaults.standard

    init() {
        base = d.string(forKey: "base")?.nonEmpty ?? "https://langhua1998-xiaoju-cloud.hf.space"
        device = d.string(forKey: "device")?.nonEmpty ?? UIDeviceName()
        pair = Keychain.get("pair") ?? ""
        token = Keychain.get("token") ?? ""
        llmBase = d.string(forKey: "llmBase") ?? ""
        llmModel = d.string(forKey: "llmModel") ?? ""
        llmKey = Keychain.get("llmKey") ?? ""
        gimbalAuto = d.bool(forKey: "gimbalAuto")
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
