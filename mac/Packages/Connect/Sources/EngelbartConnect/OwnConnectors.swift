import Foundation
import EngelbartCore

// Port of src/main/connect/own-connectors.cjs: the connectors the person has already signed in to in their own Claude Code
// or Codex (round 3, 2026-10-13: "for Granola I am already signed in … so an agent should just be able to use that
// headlessly"). An app with an official MCP server that the person added to their CLI — matched by that server's address —
// is handed to the import agent under the person's own name for it, with no token of Engelbart's: each CLI finds its own
// sign-in for a server by its name and address.
//   Claude Code  ~/.claude.json mcpServers (user scope), http or sse servers. A server listed counts.
//   Codex        `codex mcp list --json`: only a server whose auth_status says it is signed in (or needs none).
// Read at most every five minutes.

public struct OwnServer: Sendable, Equatable {
    public var app: String
    public var name: String
    public var url: String
    public var type: String
    public var own: Bool = true
}

public final class OwnConnectors: @unchecked Sendable {
    public static let keepMs = 5 * 60_000.0
    static let nameRE = "^[a-z][a-z0-9-]{0,40}$"
    static let signedIn: Set<String> = ["o_auth", "oauth", "bearer_token", "unsupported"]

    static func plain(_ url: String) -> String { JS.replace(url.trimmingCharacters(in: .whitespacesAndNewlines), "/+$", "").lowercased() }

    /// The apps with an official server → [address: app]: its address and its others (`also`).
    public static func officialServers() -> [String: String] {
        var out: [String: String] = [:]
        for name in ConnectSources.appOrder {
            guard let app = ConnectSources.apps[name], let mcp = app.mcp else { continue }
            for url in [mcp] + app.also { out[plain(url)] = name }
        }
        return out
    }

    /// Claude Code's user-scope servers → [(name, url, type)].
    public static func claudeServers(homeDir: String, env: [String: String], readFile: (String) -> String? = { try? String(contentsOfFile: $0, encoding: .utf8) }) -> [(name: String, url: String, type: String)] {
        let file = env["CLAUDE_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : ($0 as NSString).appendingPathComponent(".claude.json") } ?? (homeDir as NSString).appendingPathComponent(".claude.json")
        guard let text = readFile(file), let config = try? JSONValue.parse(text) else { return [] }
        return (config["mcpServers"]?.object ?? [:]).sorted { $0.key < $1.key }.compactMap { name, server in
            guard case .object = server, let type = server["type"]?.string, type == "http" || type == "sse", let url = server["url"]?.string else { return nil }
            return (name, url, type)
        }
    }

    /// Codex's servers as `codex mcp list --json` gives them → [(name, url, signedIn)].
    public static func codexServers(_ text: String?) -> [(name: String, url: String, signedIn: Bool)] {
        guard let list = try? JSONValue.parse(text ?? "[]"), let array = list.array else { return [] }
        return array.compactMap { server in
            guard case .object = server, server["enabled"] != .bool(false), let url = server["transport"]?["url"]?.string else { return nil }
            let auth = JS.string(server["auth_status"]).lowercased()
            let bearerEnv = JS.truthy(server["transport"]?["bearer_token_env_var"])
            return (JS.string(server["name"]), url, signedIn.contains(auth) && !bearerEnv)
        }
    }

    private let homeDir: String
    private let env: [String: String]
    private let codexList: () async throws -> String
    private let readFile: ((String) -> String?)?
    private let now: () -> Double
    private let lock = NSLock()
    private var kept: [String: (at: Double, task: Task<[OwnServer], Never>)] = [:]

    /// `codexList()` gives the JSON of `codex mcp list --json` (the app runs it with the tools' environment).
    public init(homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment,
                codexList: (() async throws -> String)? = nil, readFile: ((String) -> String?)? = nil, now: @escaping () -> Double = { Time.ms() }) {
        self.homeDir = homeDir; self.env = env; self.readFile = readFile; self.now = now
        self.codexList = codexList ?? {
            try await ProcessRunner.check("codex", ["mcp", "list", "--json"], environment: ShellEnvironment.environment(env), timeout: 30)
        }
    }

    private func serversOf(_ provider: String) -> Task<[OwnServer], Never> {
        lock.lock(); defer { lock.unlock() }
        if let hit = kept[provider], now() - hit.at < Self.keepMs { return hit.task }
        let official = Self.officialServers()
        let mine: ([(String, String, String)]) -> [OwnServer] = { list in
            list.filter { JS.test($0.0, Self.nameRE) && $0.0 != "engelbart" && official[Self.plain($0.1)] != nil }
                .map { OwnServer(app: official[Self.plain($0.1)]!, name: $0.0, url: $0.1, type: $0.2.isEmpty ? "http" : $0.2) }
        }
        let homeDir = homeDir, env = env, readFile = readFile, codexList = codexList
        let task = Task<[OwnServer], Never> {
            if provider == "openai" {
                guard let text = try? await codexList() else { return [] }
                return mine(Self.codexServers(text).filter(\.signedIn).map { ($0.name, $0.url, "http") })
            }
            let list = readFile.map { Self.claudeServers(homeDir: homeDir, env: env, readFile: $0) } ?? Self.claudeServers(homeDir: homeDir, env: env)
            return mine(list.map { ($0.name, $0.url, $0.type) })
        }
        kept[provider] = (now(), task)
        return task
    }

    /// The person's own servers for `apps` on `provider` ('anthropic' | 'openai'), one per app.
    public func serversFor(_ apps: [String], provider: String) async -> [OwnServer] {
        let wanted = Set(apps)
        var seen = Set<String>()
        return await serversOf(provider).value.filter { wanted.contains($0.app) && seen.insert($0.app).inserted }
    }

    /// Whether the person's own CLI reaches `app` through its server.
    public func reaches(_ app: String, provider: String) async -> Bool { !(await serversFor([app], provider: provider)).isEmpty }
}
