import Foundation
import CryptoKit
import Security
import EngelbartCore

/// Electron's `safeStorage` as the environment store uses it: encrypt/decrypt a string, and whether that is possible now.
public protocol SecureStorage: AnyObject {
    var isEncryptionAvailable: Bool { get }
    func encrypt(_ text: String) throws -> Data
    func decrypt(_ data: Data) throws -> String
}

/// The Keychain-backed secure storage: one AES-256-GCM key, kept as a generic password item (service
/// `Engelbart Swift Safe Storage`, account `sandbox-environments`), made on first use. The ciphertext (nonce + tag +
/// bytes, AES.GCM's combined form) goes in `sandbox_environments.encrypted` as base64, as Electron's did.
public final class KeychainSecureStorage: SecureStorage, @unchecked Sendable {
    public static let defaultService = "Engelbart Swift Safe Storage"
    public static let defaultAccount = "sandbox-environments"
    private let service: String
    private let account: String
    private let lock = NSLock()
    private var cached: SymmetricKey?

    public init(service: String = defaultService, account: String = defaultAccount) {
        self.service = service; self.account = account
    }

    public var isEncryptionAvailable: Bool { (try? key()) != nil }

    public func encrypt(_ text: String) throws -> Data {
        guard let combined = try AES.GCM.seal(Data(text.utf8), using: key()).combined else { throw SandboxError("Encryption failed") }
        return combined
    }

    public func decrypt(_ data: Data) throws -> String {
        let box = try AES.GCM.SealedBox(combined: data)
        return String(decoding: try AES.GCM.open(box, using: key()), as: UTF8.self)
    }

    /// Removes the key (tests only).
    public func deleteKey() {
        lock.lock(); cached = nil; lock.unlock()
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary)
    }

    private func key() throws -> SymmetricKey {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
                                      kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            let key = SymmetricKey(data: data)
            cached = key
            return key
        }
        guard status == errSecItemNotFound else { throw SandboxError("Keychain unavailable (\(status))") }
        let key = SymmetricKey(size: .bits256)
        let bytes = key.withUnsafeBytes { Data($0) }
        let add: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
                                    kSecValueData: bytes, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw SandboxError("Keychain unavailable (\(added))") }
        cached = key
        return key
    }
}

/// A repository's saved environment values.
public struct SavedEnvironment: Equatable, Sendable {
    public var revision: String?
    public var values: [String: String]
    public var removed: [String]

    public init(revision: String? = nil, values: [String: String] = [:], removed: [String] = []) {
        self.revision = revision; self.values = values; self.removed = removed
    }

    public var json: JSONValue {
        ["values": .object(values.mapValues { .string($0) }), "removed": .array(removed.map { .string($0) })]
    }
}

/// One change from the Environment panel: a value to save, or nil to remove the saved one.
public struct EnvironmentChange: Equatable, Sendable {
    public var name: String
    public var value: String?
    public init(name: String, value: String?) { self.name = name; self.value = value }
}

/// What the renderer may see: names, never values.
public struct EnvironmentDescription: Equatable, Sendable {
    public var revision: String?
    public var names: [String]
    public var removed: [String]
    public var report: JSONValue?

    public var json: JSONValue {
        ["revision": revision.map { .string($0) } ?? .null, "names": .array(names.map { .string($0) }),
         "removed": .array(removed.map { .string($0) }), "report": report ?? .null]
    }
}

/// src/main/sandbox/environment.cjs's `environmentStore`.
public struct EnvironmentStore {
    let db: SandboxDatabase
    let secure: SecureStorage?

    public init(db: SandboxDatabase, secure: SecureStorage?) { self.db = db; self.secure = secure }

    static let unavailable = "Secure storage is unavailable. Unlock your system keychain before saving or launching with environment variables."

    private func available() throws {
        guard let secure, secure.isEncryptionAvailable else { throw SandboxError(Self.unavailable) }
    }

    /// `validateChanges`.
    public static func validate(_ changes: [EnvironmentChange]) throws {
        if changes.count > 200 { throw SandboxError("Use at most 200 environment variables.") }
        var seen = Set<String>()
        var bytes = 0
        for change in changes {
            if !EnvironmentNames.isValid(change.name) {
                throw SandboxError("Use a valid application environment name (letters, digits, underscores). Runner configuration names are reserved.")
            }
            if seen.contains(change.name) { throw SandboxError("Each environment name must be unique.") }
            seen.insert(change.name)
            if let value = change.value, value.contains("\0") || value.utf16.count > 16384 {
                throw SandboxError("Environment values must be text of at most 16,384 characters.")
            }
            bytes += (change.value ?? "").byteLength
        }
        if bytes > 128 * 1024 { throw SandboxError("Environment values exceed 128 KB.") }
    }

    public func read(_ libraryId: String) throws -> SavedEnvironment {
        guard GithubRepo.parse(try db.libraryRow(libraryId)?["url"]?.string) != nil else { throw SandboxError("Choose a saved GitHub repository.") }
        guard let row = try db.query("select * from sandbox_environments where library_id = ?", [.string(libraryId)]).first else {
            return SavedEnvironment()
        }
        try available()
        let payload: JSONValue
        do {
            guard let data = Data(base64Encoded: row["encrypted"]?.string ?? "") else { throw SandboxError("bad") }
            payload = try JSONValue.parse(try secure!.decrypt(data))
        } catch { throw SandboxError("Saved environment could not be unlocked. Check your system keychain.") }
        var values: [String: String] = [:]
        for (k, v) in payload["values"]?.object ?? [:] { if let s = v.string { values[k] = s } }
        return SavedEnvironment(revision: row["revision"]?.string, values: values, removed: (payload["removed"]?.array ?? []).compactMap(\.string))
    }

    public func describe(_ libraryId: String) throws -> EnvironmentDescription {
        let saved = try read(libraryId)
        return EnvironmentDescription(revision: saved.revision, names: saved.values.keys.sorted(), removed: saved.removed,
                                      report: try RunStore(db).environment(libraryId))
    }

    public func save(_ libraryId: String, _ changes: [EnvironmentChange], expectedRevision: String?) throws -> EnvironmentDescription {
        try Self.validate(changes)
        let current = try read(libraryId)
        if current.revision != expectedRevision { throw SandboxError("Environment changed elsewhere. Reload the environment panel before saving.") }
        if changes.isEmpty { return try describe(libraryId) }
        try available()
        var values = current.values
        var removed = current.removed
        for change in changes {
            if let value = change.value {
                values[change.name] = value
                removed.removeAll { $0 == change.name }
            } else {
                values[change.name] = nil
                if !removed.contains(change.name) { removed.append(change.name) }
            }
        }
        let valuesJSON = JSONValue.object(values.mapValues { .string($0) })
        if values.count > 200 || removed.count > 500 || valuesJSON.text().byteLength > 128 * 1024 {
            throw SandboxError("Too many environment values or removals.")
        }
        let payload = SavedEnvironment(values: values, removed: removed).json.text()
        let encrypted = try secure!.encrypt(payload).base64EncodedString()
        _ = try db.query("""
            insert into sandbox_environments (library_id, revision, encrypted, updated_at) values (?, ?, ?, ?)
            on conflict (library_id) do update set revision = excluded.revision, encrypted = excluded.encrypted, updated_at = excluded.updated_at
            """, [.string(libraryId), .string(IDs.new()), .string(encrypted), .string(Time.iso())])
        return try describe(libraryId)
    }
}
