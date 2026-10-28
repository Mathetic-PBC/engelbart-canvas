import Foundation
import EngelbartCore

/// The Engelbart home and config.json (home.cjs). Everything the app writes lives under the root; in test mode the data
/// root is `<root>/test` (spec §2 #1–2), which only a developer's copy has (Developer.hasTestMode).
public enum Home {
    public struct Layout: Equatable, Sendable {
        public var root: String
        public var testRoot: String
        public var configFile: String
    }

    /// The Swift app's own root (ARCHITECTURE §3): never Electron's `~/.engelbart`.
    public static let rootName = ".engelbart-swift"

    /// Makes the root (0700) and, with `test`, `<root>/test` and `<root>/test/annotations`; carries config.json's
    /// defaults forward (Defaults.carryDefaults, fillMissing, backups in `<root>/.backups`).
    @discardableResult
    public static func ensureHome(_ homeDir: String, rootDir: String? = nil, test: Bool = true) throws -> Layout {
        guard homeDir.hasPrefix("/") else { throw StoreError.type("homeDir must be an absolute path") }
        if let rootDir, !rootDir.hasPrefix("/") { throw StoreError.type("rootDir must be an absolute path") }
        let root = rootDir ?? Paths.join(homeDir, rootName)
        let testRoot = Paths.join(root, "test")
        try JSONFiles.makeDir(root)
        if test {
            try JSONFiles.makeDir(testRoot)
            try JSONFiles.makeDir(Paths.join(testRoot, "annotations"))
        }
        let configFile = Paths.join(root, "config.json")
        // Every setting is in the file to be edited, and a default changed by a later build reaches it wherever the person
        // left that setting alone. A file that does not parse is left for its editor to finish.
        Defaults.carryDefaults(file: configFile, defaults: normalizeConfig(.object([:])), past: pastConfigDefaults,
                               normalize: normalizeConfig, fillMissing: true, backupDir: Paths.join(root, ".backups"))
        return Layout(root: root, testRoot: testRoot, configFile: configFile)
    }

    // MARK: config.json

    /// Which model writes the catalog summaries; both providers are the CLIs on the person's subscription.
    public static let summarizerDefaults: JSONValue = [
        "provider": "openai",
        "openai": ["model": "gpt-6-luna", "effort": "high"],
        "anthropic": ["model": "claude-opus-5-5", "effort": "high"],
    ]
    static let providerAliases = ["openai": "openai", "codex": "openai", "anthropic": "anthropic", "claude": "anthropic"]
    static let efforts = ["low", "medium", "high", "xhigh", "max"]
    static let modelPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$"
    public static let providersDefault = ["openai", "anthropic"]
    /// The GitHub App "Add from GitHub…" signs in to (shared public registration).
    public static let githubDefaults: JSONValue = ["clientId": "Iv23liAZNYl96zlluMDs", "appSlug": "engelbart-mathetic"]

    static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }

    public static func normalizeSummarizer(_ value: JSONValue?) -> JSONValue {
        let input = value?.object ?? [:]
        let provider = providerAliases[(input["provider"]?.string ?? "").lowercased()] ?? "openai"
        var out: [String: JSONValue] = ["provider": .string(provider)]
        for name in ["openai", "anthropic"] {
            let given = input[name]?.object ?? [:]
            let model = given["model"]?.string.flatMap { matches($0, modelPattern) ? $0 : nil } ?? summarizerDefaults[name]!["model"]!.string!
            let effort = given["effort"]?.string.flatMap { efforts.contains($0) ? $0 : nil } ?? summarizerDefaults[name]!["effort"]!.string!
            out[name] = ["model": .string(model), "effort": .string(effort)]
        }
        return .object(out)
    }

    /// Which providers @bart offers: aliases read, each once; a list naming none of them is the default.
    public static func normalizeProviders(_ value: JSONValue?) -> JSONValue {
        var named: [String] = []
        for item in value?.array ?? [] {
            let text: String
            switch item { case .string(let s): text = s; case .number(let n): text = String(n); default: text = "" }
            if let alias = providerAliases[text.lowercased()], !named.contains(alias) { named.append(alias) }
        }
        return .array((named.isEmpty ? providersDefault : named).map { .string($0) })
    }

    public static func normalizeGithub(_ value: JSONValue?) -> JSONValue {
        let input = value?.object ?? [:]
        let id = input["clientId"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = input["appSlug"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        return [
            "clientId": .string(id.flatMap { matches($0, "^[A-Za-z0-9._-]{8,64}$") ? $0 : nil } ?? githubDefaults["clientId"]!.string!),
            "appSlug": .string(slug.flatMap { matches($0, "^[a-z0-9][a-z0-9-]{0,99}$") ? $0 : nil } ?? githubDefaults["appSlug"]!.string!),
        ]
    }

    public static func normalizeConfig(_ value: JSONValue) -> JSONValue {
        let input = value.object ?? [:]
        return [
            // Off by default (2026-09-28): a new install starts on the root. A copy without test mode ignores it.
            "testMode": .bool(input["testMode"]?.bool ?? false),
            "providers": normalizeProviders(input["providers"]),
            "summarizer": normalizeSummarizer(input["summarizer"]),
            "github": normalizeGithub(input["github"]),
            // Git, Claude Code and Codex as the last check saw them, and what the person chose about them.
            "tools": ToolsRecord.normalizeTools(input["tools"]),
        ]
    }

    /// Every config.json default shipped before defaults were carried forward, oldest first.
    public static let pastConfigDefaults: [JSONValue] = {
        let summarizer: JSONValue = ["provider": "openai", "openai": ["model": "gpt-5.6-luna", "effort": "high"], "anthropic": ["model": "claude-opus-5", "effort": "high"]]
        let providers: JSONValue = .array(providersDefault.map { .string($0) })
        return [
            ["testMode": true],
            ["testMode": true, "summarizer": summarizer],
            ["testMode": true, "providers": providers, "summarizer": summarizer],
            ["testMode": true, "providers": providers, "summarizer": summarizer, "github": githubDefaults],
        ]
    }()

    public static func readConfig(_ root: String) -> JSONValue {
        guard let data = FileManager.default.contents(atPath: Paths.join(root, "config.json")), let value = try? JSONValue.parse(data) else {
            return normalizeConfig(.object([:]))
        }
        return normalizeConfig(value)
    }

    static let configKeys: Set<String> = ["testMode", "summarizer", "providers", "github", "tools"]

    @discardableResult
    public static func writeConfig(_ root: String, _ patch: JSONValue) throws -> JSONValue {
        guard case .object(let changes) = patch else { throw StoreError.type("Config update must be an object") }
        for key in changes.keys where !configKeys.contains(key) { throw StoreError.type("Unsupported config key: \(key)") }
        if let mode = changes["testMode"], mode.bool == nil { throw StoreError.type("testMode must be a boolean") }
        let next = normalizeConfig(readConfig(root).merging(changes))
        try JSONFiles.write(Paths.join(root, "config.json"), next)
        return next
    }

    /// The tool check's record, written only while config.json parses as an object: a background check must never
    /// overwrite a file someone is halfway through editing. → the config written, or nil.
    @discardableResult
    public static func writeTools(_ root: String, _ tools: JSONValue) throws -> JSONValue? {
        guard let data = FileManager.default.contents(atPath: Paths.join(root, "config.json")),
              let onDisk = try? JSONValue.parse(data), onDisk.isPlainObject else { return nil }
        return try writeConfig(root, ["tools": tools])
    }
}

/// config.json → `tools` (tools/record.cjs, 2026-09-23; design D5).
public enum ToolsRecord {
    public static let statuses = ["unknown", "checking", "ready", "missing", "outdated", "incompatible", "signed-out", "installing", "updating", "signing-in", "failed"]
    public static let sources = ["apple", "homebrew", "bundled", "native", "standalone", "npm", "bun", "desktop", "other"]
    public static let toolNames = ["git", "claude", "codex"]
    public static let agents = ["claude", "codex"]
    /// tools/requirements.cjs minimums.
    public static let minimums = ["git": "2.30.0", "claude": "2.1.278", "codex": "0.155.0"]

    static func isVersion(_ value: JSONValue?) -> Bool { value?.string.map { Home.matches($0, #"^\d+\.\d+\.\d+$"#) } ?? false }
    static func isoTime(_ value: JSONValue?) -> JSONValue {
        guard let s = value?.string, s.count <= 40, JSDate.parse(s) != nil else { return .null }
        return .string(s)
    }
    static func oneLine(_ value: JSONValue?) -> JSONValue {
        guard let s = value?.string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .null }
        return .string(String(s.collapsingWhitespace().prefix(300)))
    }

    public static func blankTool(_ name: String) -> [String: JSONValue] {
        var out: [String: JSONValue] = [
            "installed": false, "version": .null, "requires": .string(">=\(minimums[name] ?? "0.0.0")"), "status": "unknown",
            "path": .null, "onPath": .null, "source": .null, "untested": false, "updaterOff": false, "checkedAt": .null,
            "error": .null, "note": .null, "failedUpdate": .null, "skip": false, "pin": .null,
        ]
        if agents.contains(name) { out["signedIn"] = .null; out["account"] = .null }
        return out
    }

    public static func normalizeTool(_ name: String, _ value: JSONValue?) -> JSONValue {
        let input = value?.object ?? [:]
        var out = blankTool(name)
        if let b = input["installed"]?.bool { out["installed"] = .bool(b) }
        if isVersion(input["version"]) { out["version"] = input["version"]! }
        if let s = input["status"]?.string, statuses.contains(s) { out["status"] = .string(s) }
        if agents.contains(name), let b = input["signedIn"]?.bool { out["signedIn"] = .bool(b) }
        if agents.contains(name), out["signedIn"] == .bool(true), let account = input["account"]?.string, Home.matches(account, #"^\S{1,254}$"#) { out["account"] = .string(account) }
        if let p = input["path"]?.string, p.count <= 4096, p.hasPrefix("/"), !p.contains("\0") { out["path"] = .string(p) }
        if let b = input["onPath"]?.bool { out["onPath"] = .bool(b) }
        if let s = input["source"]?.string, sources.contains(s) { out["source"] = .string(s) }
        out["untested"] = .bool(input["untested"]?.bool == true)
        out["updaterOff"] = .bool(input["updaterOff"]?.bool == true)
        out["checkedAt"] = isoTime(input["checkedAt"])
        out["error"] = oneLine(input["error"])
        out["note"] = oneLine(input["note"])
        if let failed = input["failedUpdate"]?.object, isVersion(failed["from"]), !isoTime(failed["at"]).isNull {
            out["failedUpdate"] = ["from": failed["from"]!, "at": failed["at"]!]
        }
        out["skip"] = .bool(input["skip"]?.bool == true)
        if isVersion(input["pin"]) { out["pin"] = input["pin"]! }
        return .object(out)
    }

    public static func normalizeTools(_ value: JSONValue?) -> JSONValue {
        let input = value?.object ?? [:]
        var out: [String: JSONValue] = ["updates": .string(["auto", "ask"].contains(input["updates"]?.string ?? "") ? input["updates"]!.string! : "auto")]
        for name in toolNames { out[name] = normalizeTool(name, input[name]) }
        return .object(out)
    }
}

/// `Date.parse` for the shapes the store reads (ISO-8601 with or without fractions, a bare day, RFC 2822-like text).
enum JSDate {
    static func parse(_ text: String) -> Date? {
        let value = text.trimmingCharacters(in: .whitespaces)
        if value.isEmpty { return nil }
        if let date = Time.parse(value) { return date }
        let iso = ISO8601DateFormatter()
        for options: ISO8601DateFormatter.Options in [[.withFullDate], [.withFullDate, .withTime, .withColonSeparatorInTime, .withDashSeparatorInDate, .withTimeZone]] {
            iso.formatOptions = options
            if let date = iso.date(from: value) { return date }
        }
        if value.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$"#, options: .regularExpression) != nil {
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
            for format in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] { f.dateFormat = format; if let d = f.date(from: value) { return d } }
        }
        // Text dates ("Mon, Mar 2, 2026 3:14 PM", "Oct 6, 2025, 3:14 PM", "Tue, 03 Mar 2026 16:45:00 GMT"), local time.
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
        let cleaned = value.replacingOccurrences(of: ",", with: "").collapsingWhitespace()
        for format in ["EEE MMM d yyyy h:mm a", "MMM d yyyy h:mm a", "EEE MMM d yyyy", "MMM d yyyy", "EEE d MMM yyyy HH:mm:ss zzz", "d MMM yyyy", "EEE MMM d yyyy HH:mm:ss", "yyyy/MM/dd", "MM/dd/yyyy"] {
            f.dateFormat = format
            if let d = f.date(from: cleaned) { return d }
        }
        return nil
    }
}
