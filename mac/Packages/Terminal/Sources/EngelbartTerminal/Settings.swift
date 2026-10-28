import EngelbartCore
import Foundation

// Port of src/main/terminal/settings.cjs: the terminal's own settings in <userData>/settings.json (Electron:
// `terminal:save-settings`). Values that are missing or corrupt fall back to app-owned defaults; an update may name only
// the three keys, and each is validated.

public struct TerminalSettings: Equatable, Sendable {
    public static let defaultFontSize = 14
    public static let minFontSize = 10
    public static let maxFontSize = 24

    public var fontSize: Int
    public var lastCwd: String
    public var sidebarVisible: Bool

    public init(fontSize: Int, lastCwd: String, sidebarVisible: Bool) {
        self.fontSize = fontSize; self.lastCwd = lastCwd; self.sidebarVisible = sidebarVisible
    }

    static func isDirectory(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.utf16.count <= 4096, !value.contains("\0") else { return false }
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: value, isDirectory: &dir) && dir.boolValue
    }

    /// Integers only: a JSON number with a fraction is not one (`Number.isInteger`).
    static func integer(_ value: JSONValue?) -> Int? {
        guard let n = value?.double, n.rounded() == n, abs(n) < 1e15 else { return nil }
        return Int(n)
    }

    public static func normalize(_ value: JSONValue?, home: String) -> TerminalSettings {
        let input = value?.object ?? [:]
        let size = integer(input["fontSize"]).flatMap { (minFontSize...maxFontSize).contains($0) ? $0 : nil } ?? defaultFontSize
        let cwd = input["lastCwd"]?.string
        return TerminalSettings(fontSize: size, lastCwd: isDirectory(cwd) ? Launch.resolvePath(cwd!) : home,
                                sidebarVisible: input["sidebarVisible"]?.bool ?? true)
    }

    public static func merge(_ current: TerminalSettings, patch: [String: JSONValue], home: String) throws -> TerminalSettings {
        let supported: Set<String> = ["fontSize", "lastCwd", "sidebarVisible"]
        for key in patch.keys.sorted() where !supported.contains(key) { throw TerminalError("Unsupported setting: \(key)") }
        var next = current
        if let raw = patch["fontSize"] {
            guard let size = integer(raw), (minFontSize...maxFontSize).contains(size) else {
                throw TerminalError("fontSize must be an integer between \(minFontSize) and \(maxFontSize)")
            }
            next.fontSize = size
        }
        if let raw = patch["lastCwd"] {
            guard let cwd = raw.string, isDirectory(cwd) else { throw TerminalError("lastCwd must be an existing directory") }
            next.lastCwd = Launch.resolvePath(cwd)
        }
        if let raw = patch["sidebarVisible"] {
            guard let visible = raw.bool else { throw TerminalError("sidebarVisible must be a boolean") }
            next.sidebarVisible = visible
        }
        return normalize(next.json, home: home)
    }

    public var json: JSONValue {
        .object(["fontSize": .number(Double(fontSize)), "lastCwd": .string(lastCwd), "sidebarVisible": .bool(sidebarVisible)])
    }
}

public final class TerminalSettingsStore: @unchecked Sendable {
    public let home: String
    public let file: URL
    private let lock = NSLock()
    private var value: TerminalSettings

    public init(userData: URL = TerminalPaths.userData, home: String = TerminalPaths.home) {
        self.home = home
        self.file = userData.appendingPathComponent("settings.json")
        let parsed = (try? Data(contentsOf: file)).flatMap { try? JSONValue.parse($0) }
        value = TerminalSettings.normalize(parsed, home: home)
    }

    public func get() -> TerminalSettings { lock.lock(); defer { lock.unlock() }; return value }

    /// Validates and writes `patch`; → the settings now. Throws the Electron messages.
    @discardableResult
    public func save(_ patch: [String: JSONValue]) throws -> TerminalSettings {
        lock.lock(); defer { lock.unlock() }
        let next = try TerminalSettings.merge(value, patch: patch, home: home)
        let dir = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = dir.appendingPathComponent("settings.json.\(getpid()).tmp")
        try Data((next.json.text(pretty: true) + "\n").utf8).write(to: temporary)
        chmod(temporary.path, 0o600)
        if rename(temporary.path, file.path) != 0 { throw TerminalError(String(cString: strerror(errno))) }
        value = next
        return next
    }
}
