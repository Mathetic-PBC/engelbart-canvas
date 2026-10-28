import Foundation
import EngelbartCore

// Port of src/main/onboarding/browser-agents.cjs (2026-10-13, "We will use computer use in my real browser"): whether an
// import of a web app can run in the person's own browser (Claude in Chrome, Codex's Chrome plugin), signed in as they are,
// and whether Engelbart asks first. Allowed by the CLI: Claude Code's claudeInChromeDefaultEnabled; Codex's
// features.browser_use not off and the chrome plugin not disabled. Otherwise the run turns it on for itself, after the
// person said yes. The answer is kept per data root (OnboardingPrefs browserAgents). A "no" wins over the CLI's setting.
public final class BrowserAgents: @unchecked Sendable {
    public static let profileRoots = ["chrome": "Google/Chrome", "edge": "Microsoft Edge", "brave": "BraveSoftware/Brave-Browser", "arc": "Arc/User Data",
                                      "opera": "com.operasoftware.Opera", "chromium": "Chromium", "comet": "Comet", "vivaldi": "Vivaldi"]
    public static let claudeExtension = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
    public static let codexExtensions = ["hehggadaopoacecdllhhajmbjkdcmajg", "odlomjlbamekndcpllcnffbgeohgkmjh"]
    public static let hosts = ["anthropic": "com.anthropic.claude_code_browser_extension.json", "openai": "com.openai.codexextension.json"]
    static let preference = ["chrome", "edge", "brave", "arc", "vivaldi", "opera", "chromium", "comet"]

    public struct CodexConfig: Sendable, Equatable {
        public var features: [String: Bool] = [:]
        public var plugins: [String: Bool] = [:]
        public var servers: [(name: String, enabled: Bool)] = []
        public static func == (a: CodexConfig, b: CodexConfig) -> Bool { a.features == b.features && a.plugins == b.plugins && a.servers.map(\.name) == b.servers.map(\.name) && a.servers.map(\.enabled) == b.servers.map(\.enabled) }
    }

    /// Codex's config.toml → its features, plugins and MCP servers (what this needs).
    public static func readCodexConfig(_ text: String) -> CodexConfig {
        var out = CodexConfig()
        var table = ""
        for raw in text.components(separatedBy: .newlines) {
            let line = JS.replace(raw, #"\s+#.*$"#, "").trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if let header = JS.match(line, #"^\[\s*([^\]]+?)\s*\]$"#)?[1] ?? nil {
                table = header
                if let m = JS.match(table, #"^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$"#) { out.servers.append(((m[1] ?? nil) ?? (m[2] ?? nil) ?? "", true)) }
                continue
            }
            guard let pair = JS.match(line, #"^([A-Za-z0-9_."-]+)\s*=\s*(.+)$"#), let key = pair[1], let value = pair[2] else { continue }
            let bool: Bool? = value == "true" ? true : value == "false" ? false : nil
            if table == "features", let bool { out.features[key] = bool }
            else if table.isEmpty, key.hasPrefix("features."), let bool { out.features[String(key.dropFirst(9))] = bool }
            if let plugin = JS.match(table, #"^plugins\."([^"]+)"$"#)?[1] ?? nil, key == "enabled", let bool { out.plugins[plugin] = bool }
            if let m = JS.match(table, #"^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$"#), key == "enabled", bool == false {
                let name = (m[1] ?? nil) ?? (m[2] ?? nil) ?? ""
                if let i = out.servers.firstIndex(where: { $0.name == name }) { out.servers[i].enabled = false }
            }
        }
        return out
    }

    static func isDir(_ p: String) -> Bool { Readers.isDir(p) }
    static func isFile(_ p: String) -> Bool { Readers.statOf(p)?.isFile == true }

    /// A browser's profile folders (Default, Profile 1…).
    public static func profilesOf(supportDir: String, browserId: String) -> [String] {
        guard let rel = profileRoots[browserId] else { return [] }
        let root = (supportDir as NSString).appendingPathComponent(rel)
        return ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []).sorted().filter { $0 == "Default" || JS.test($0, #"^Profile \d+$"#) }
            .map { (root as NSString).appendingPathComponent($0) }.filter(isDir)
    }

    /// Whether `browserId` has one of `ids` installed in any profile, and the CLI's messaging host registered for it.
    public static func hasExtension(supportDir: String, browserId: String, ids: [String], host: String) -> Bool {
        guard let rel = profileRoots[browserId] else { return false }
        let root = (supportDir as NSString).appendingPathComponent(rel)
        guard isFile((root as NSString).appendingPathComponent("NativeMessagingHosts/\(host)")) else { return false }
        return profilesOf(supportDir: supportDir, browserId: browserId).contains { profile in ids.contains { isDir((profile as NSString).appendingPathComponent("Extensions/\($0)")) } }
    }

    /// Codex's Chrome plugin's browser-client, in its plugin cache.
    public static func codexChromePlugin(_ codexHome: String) -> Bool {
        let dir = (codexHome as NSString).appendingPathComponent("plugins/cache/openai-bundled/chrome")
        return ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).contains { isFile((dir as NSString).appendingPathComponent("\($0)/scripts/browser-client.mjs")) }
    }

    let homeDir: String
    let env: [String: String]
    let prefs: OnboardingPrefs
    let fake: String
    let isMac: Bool

    public init(homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment, prefs: OnboardingPrefs, fake: String? = nil, isMac: Bool = true) {
        self.homeDir = homeDir; self.env = env; self.prefs = prefs; self.fake = fake ?? env["ENGELBART_BROWSER_AGENTS"] ?? ""; self.isMac = isMac
    }

    var supportDir: String { (homeDir as NSString).appendingPathComponent("Library/Application Support") }
    var codexHome: String { env["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (homeDir as NSString).appendingPathComponent(".codex") }

    /// The browsers holding `provider`'s extension, the person's chosen one first, then the preference order.
    public func browsersFor(_ provider: String, chosenId: String?) -> [String] {
        guard isMac else { return [] }
        var ids = provider == "openai" ? Self.codexExtensions : [Self.claudeExtension]
        if provider == "openai", let hosts = Files.readJSON(URL(fileURLWithPath: (codexHome as NSString).appendingPathComponent("chrome-native-hosts-v2.json"))) {
            var listed: [String] = []
            for entry in hosts["entries"]?.array ?? [] { for id in entry["extensionIds"]?.array?.compactMap(\.string) ?? [] where JS.test(id, "^[a-p]{32}$") && !listed.contains(id) { listed.append(id) } }
            if !listed.isEmpty { ids = listed }
        }
        var order: [String] = []
        for id in (chosenId.flatMap { Self.profileRoots[$0] != nil ? [$0] : nil } ?? []) + Self.preference where !order.contains(id) { order.append(id) }
        return order.filter { Self.hasExtension(supportDir: supportDir, browserId: $0, ids: ids, host: Self.hosts[provider] ?? "") }
    }

    /// Whether the person's own CLI configuration already lets its agents drive their browser.
    public func allowedByCli(_ provider: String) -> Bool {
        if provider == "anthropic" { return Files.readJSON(URL(fileURLWithPath: (homeDir as NSString).appendingPathComponent(".claude.json")))?["claudeInChromeDefaultEnabled"] == .bool(true) }
        let config = Self.readCodexConfig((try? String(contentsOfFile: (codexHome as NSString).appendingPathComponent("config.toml"), encoding: .utf8)) ?? "")
        return config.features["browser_use"] != false && config.plugins["chrome@openai-bundled"] != false
    }

    public struct Status: Sendable, Equatable {
        public var available: Bool
        public var provider: String?
        public var browser: (id: String, name: String)?
        public var others: [String]
        public var allowedByCli: Bool
        public var consent: String?
        public var ask: Bool
        public var use: Bool
        public var why: String
        public static func == (a: Status, b: Status) -> Bool { a.json == b.json }
        public var json: JSONValue {
            ["available": .bool(available), "provider": provider.map { .string($0) } ?? .null, "browser": browser.map { ["id": .string($0.id), "name": .string($0.name)] } ?? .null,
             "others": .array(others.map { .string($0) }), "allowedByCli": .bool(allowedByCli), "consent": consent.map { .string($0) } ?? .null, "ask": .bool(ask), "use": .bool(use), "why": .string(why)]
        }
    }

    public func status(provider: String?, browserId: String? = nil) -> Status {
        let consent = prefs.get()["browserAgents"]?.string
        if !fake.isEmpty {
            let available = fake != "none", byCli = fake == "allowed"
            return Status(available: available, provider: provider, browser: available ? ("chrome", "Chrome") : nil, others: [], allowedByCli: byCli, consent: consent,
                          ask: available && !byCli && consent == nil, use: available && (byCli ? consent != "declined" : consent == "allowed"), why: available ? "" : "No browser has the extension (stand-in Mac)")
        }
        guard let provider, provider == "anthropic" || provider == "openai" else {
            return Status(available: false, provider: provider, browser: nil, others: [], allowedByCli: false, consent: consent, ask: false, use: false, why: "No provider yet")
        }
        let ids = browsersFor(provider, chosenId: browserId)
        let pluginOk = provider == "openai" ? Self.codexChromePlugin(codexHome) : true
        let available = !ids.isEmpty && pluginOk
        let byCli = available && allowedByCli(provider)
        let name = { (id: String) in ImportFlow.browserById(id)?.name ?? (id == "vivaldi" ? "Vivaldi" : id) }
        let why = available ? "" : !pluginOk ? "Codex's Chrome plugin is not installed" : provider == "anthropic" ? "The Claude extension is not in a browser on this Mac" : "The Codex extension is not in a browser on this Mac"
        return Status(available: available, provider: provider, browser: available ? (ids[0], name(ids[0])) : nil, others: ids.dropFirst().map(name), allowedByCli: byCli, consent: consent,
                      ask: available && !byCli && consent == nil, use: available && consent != "declined" && (byCli || consent == "allowed"), why: why)
    }

    /// The person's answer to "Let agents use your browser?" ('allowed' | 'declined'), kept; nil forgets it.
    @discardableResult
    public func consent(_ answer: String?) throws -> String? {
        guard answer == nil || answer == "allowed" || answer == "declined" else { throw ConnectError("failed", "answer is invalid") }
        _ = try prefs.set(["browserAgents": answer.map { .string($0) } ?? .null])
        return answer
    }
}

// Port of src/main/onboarding/prefs.cjs: Import your context's remembered answers, `<dataRoot>/.connect/onboarding.json`.
// Ids and short words only: never a cookie, a path the person did not pick, or anything an account holds.
public struct OnboardingPrefs: Sendable {
    public static let file = "onboarding.json"
    static let maxFlowBytes = 200_000
    static let profileId = #"^[\w .@()-]{1,120}$"#
    public var dataRoot: @Sendable () -> String
    public init(dataRoot: @escaping @Sendable () -> String) { self.dataRoot = dataRoot }

    var url: URL { URL(fileURLWithPath: dataRoot()).appendingPathComponent(".connect/\(Self.file)") }
    func read() -> [String: JSONValue] { Files.readJSON(url)?.object ?? [:] }

    static func clean(_ value: [String: JSONValue]) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if let p = value["provider"]?.string, ImportFlow.providerIds.contains(p) { out["provider"] = .string(p) }
        if let b = value["browser"]?.string, ImportFlow.browserById(b) != nil { out["browser"] = .string(b) }
        if let p = value["profile"]?.string, JS.test(p, profileId) { out["profile"] = .string(p) }
        if let k = value["keychain"]?.string, k == "allowed" || k == "declined" { out["keychain"] = .string(k) }
        if let a = value["browserAgents"]?.string, a == "allowed" || a == "declined" { out["browserAgents"] = .string(a) }
        if let flow = value["flow"], case .object = flow, flow.text().utf16.count <= maxFlowBytes { out["flow"] = flow }
        return out
    }

    /// What is remembered → { provider?, browser?, profile?, keychain?, browserAgents?, flow? }
    public func get() -> [String: JSONValue] { Self.clean(read()) }

    /// Remember `patch` (null removes a key) → what is remembered now.
    @discardableResult
    public func set(_ patch: [String: JSONValue]) throws -> [String: JSONValue] {
        var next = read()
        for (k, v) in patch { if v.isNull { next[k] = nil } else { next[k] = v } }
        let kept = Self.clean(next)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Files.writeAtomically(JSONValue.object(kept).text(pretty: true) + "\n", to: url, mode: 0o600)
        return kept
    }
}
