import CryptoKit
import Foundation
import Security

// Electron's `safeStorage` (the `crypt` of github/connection.cjs and zotero/connection.cjs): strings sealed with a key
// the macOS Keychain keeps. The sign-in files stay where and as Electron wrote them (<dataRoot>/github.json,
// <dataRoot>/zotero.json, one per data root), their secret fields the base64 of the sealed text. Without a Keychain the
// sign-in lives only in memory (`available()` false), as it did in Electron.

public protocol SecretCrypt: Sendable {
    func available() -> Bool
    func encrypt(_ text: String) throws -> String
    func decrypt(_ text: String) throws -> String
}

public struct NoKeychain: SecretCrypt {
    public init() {}
    public func available() -> Bool { false }
    public func encrypt(_ text: String) throws -> String { throw SecretCryptError.unavailable }
    public func decrypt(_ text: String) throws -> String { throw SecretCryptError.unavailable }
}

public enum SecretCryptError: Error { case unavailable, unreadable }

/// AES-GCM with a 256-bit key kept as a generic password in the login Keychain (made on first use).
public final class KeychainCrypt: SecretCrypt, @unchecked Sendable {
    public static let shared = KeychainCrypt()

    private let service: String
    private let account: String
    private let lock = NSLock()
    private var key: SymmetricKey?
    private var failed = false

    public init(service: String = "Engelbart Swift Safe Storage", account: String = "safe-storage") {
        self.service = service
        self.account = account
    }

    public func available() -> Bool { (try? keyNow()) != nil }

    public func encrypt(_ text: String) throws -> String {
        let sealed = try AES.GCM.seal(Data(text.utf8), using: try keyNow())
        guard let combined = sealed.combined else { throw SecretCryptError.unreadable }
        return combined.base64EncodedString()
    }

    public func decrypt(_ text: String) throws -> String {
        guard let data = Data(base64Encoded: text) else { throw SecretCryptError.unreadable }
        let box = try AES.GCM.SealedBox(combined: data)
        let plain = try AES.GCM.open(box, using: try keyNow())
        return String(decoding: plain, as: UTF8.self)
    }

    private func keyNow() throws -> SymmetricKey {
        lock.lock(); defer { lock.unlock() }
        if let key { return key }
        if failed { throw SecretCryptError.unavailable }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let found = SecItemCopyMatching(query as CFDictionary, &item)
        if found == errSecSuccess, let data = item as? Data, data.count == 32 {
            key = SymmetricKey(data: data)
            return key!
        }
        guard found == errSecItemNotFound else { failed = true; throw SecretCryptError.unavailable }
        let fresh = SymmetricKey(size: .bits256)
        let raw = fresh.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: service,
            kSecValueData as String: raw,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { failed = true; throw SecretCryptError.unavailable }
        key = fresh
        return fresh
    }
}

// MARK: - PKCE and the browser sign-ins' small pieces

enum PKCE {
    /// `randomBytes(n).toString('base64url')`.
    static func random(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return base64url(Data(bytes))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// sha256(verifier), base64url: the challenge sent to the broker.
    static func challenge(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// `timingSafeEqual` of two strings of the same byte length (false for nil or another length).
    static func same(_ a: String?, _ b: String) -> Bool {
        guard let a else { return false }
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}

/// The page the browser shows after a loopback callback: never a token, only words.
func signInPage(_ status: Int, _ text: String) -> LoopbackResponse {
    LoopbackResponse(status: status, headers: [
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
    ], body: Data("<!doctype html><meta charset=\"utf-8\"><title>Engelbart</title><h1>\(text)</h1><p>You can close this tab and return to Engelbart.</p>".utf8))
}
