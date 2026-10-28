import Foundation
import EngelbartCore

/// The run step's agent: Claude Code on the person's own subscription, as the sandbox setup runs it
/// (sandbox/local-claude.cjs, which the Sandbox package owns): no API key, restricted, no tools but Engelbart's
/// (`mcp__canvas__*`), the Build's model and effort. Authentication stays in the installed, unmodified CLI: its
/// credential files and keychain are never read.
public enum LocalClaude {
    public struct Auth: Sendable { public var file: String; public var env: [String: String]
        public init(file: String, env: [String: String]) { self.file = file; self.env = env } }

    static func subscriptionEnvironment(_ source: [String: String]) -> [String: String] {
        source.filter { ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "CLAUDE_CONFIG_DIR"].contains($0.key) }
    }

    static func subscriptionStatus(_ status: JSONValue?) -> Bool {
        guard let s = status else { return false }
        return s["loggedIn"]?.bool == true && s["authMethod"]?.string == "claude.ai" && s["apiProvider"]?.string == "firstParty"
            && (s["subscriptionType"]?.string?.range(of: "^(pro|max|team|enterprise)$", options: [.regularExpression, .caseInsensitive]) != nil)
    }

    /// Where the installers put it, when the login shell's PATH misses it (tools/detect.cjs knownPlaces).
    static func knownPlaces(_ home: String) -> [String] {
        ["\(home)/.local/bin/claude", "\(home)/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "\(home)/.npm-global/bin/claude", "\(home)/.bun/bin/claude"]
    }

    /// Resolves `claude` through the same login shell as the terminal, checks its version (2.1.248+) and that it is signed
    /// in to a Claude subscription.
    public static func prepare(_ source: [String: String] = ShellEnvironment.environment()) async throws -> Auth {
        let env = subscriptionEnvironment(source)
        let shell = LoginShell.resolveShell(env)
        let fish = NodePath.basename(shell) == "fish"
        let query = fish ? "command -s claude" : NodePath.basename(shell) == "bash" ? "type -P claude" : "whence -p claude"
        var file: String?
        let found = await Exec.run(shell, fish ? ["--login", "--interactive", "--command", query] : ["-ilc", query], environment: env, directory: NSTemporaryDirectory(), timeout: 15)
        if found.code == 0, let line = found.stdout.components(separatedBy: .newlines).last(where: { NodePath.isAbsolute($0.trimmingCharacters(in: .whitespaces)) }) {
            let path = line.trimmingCharacters(in: .whitespaces)
            if FS.isFile(path) { file = path }
        }
        if file == nil { file = knownPlaces(env["HOME"] ?? NSHomeDirectory()).first { FileManager.default.isExecutableFile(atPath: $0) && FS.isFile($0) } }
        guard let file else { throw BuildError("Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it).") }
        let version = await Exec.run(file, ["--version"], environment: env, timeout: 15)
        let parts = version.stdout.range(of: #"^(\d+)\.(\d+)\.(\d+)"#, options: .regularExpression).map { String(version.stdout[$0]).split(separator: ".").compactMap { Int($0) } } ?? []
        if parts.count != 3 || (parts[0] < 2 || (parts[0] == 2 && (parts[1] < 1 || (parts[1] == 1 && parts[2] < 248)))) {
            throw BuildError(parts.count == 3 ? "Update Claude Code to 2.1.248 or newer for restricted sandbox setup." : "Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it).")
        }
        let status = await Exec.run(file, ["auth", "status", "--json"], environment: env, directory: NSTemporaryDirectory(), timeout: 15)
        guard status.code == 0, subscriptionStatus(try? JSONValue.parse(status.stdout)) else {
            throw BuildError("Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in).")
        }
        return Auth(file: file, env: env)
    }

    /// `maxTurns` and `effort`: a Build's run step works through several runnables, on the Build's own model and effort.
    public static func arguments(_ config: String, model: String = "claude-sonnet-5-5", maxTurns: Int = 32, effort: String? = nil) throws -> [String] {
        if model.range(of: "^[a-zA-Z0-9._:-]{1,100}$", options: .regularExpression) == nil { throw BuildError("Invalid local Claude model") }
        if maxTurns < 1 || maxTurns > 500 { throw BuildError("Invalid local Claude turn limit") }
        if let effort, effort.range(of: "^[a-z]{1,16}$", options: .regularExpression) == nil { throw BuildError("Invalid local Claude effort") }
        return ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
                "--restricted", "--setting-sources", "", "--settings", "{\"disableAllHooks\":true}",
                "--strict-mcp-config", "--mcp-config", config, "--tools", "",
                "--allowedTools", "mcp__canvas__*", "--permission-mode", "dontAsk",
                "--model", model] + (effort.map { ["--effort", $0] } ?? []) + ["--max-turns", String(maxTurns)]
    }

    public struct Run: @unchecked Sendable {
        public var auth: Auth
        public var bridge: BridgeConnection
        public var prompt: String
        public var model: String
        public var effort: String?
        public var maxTurns: Int
        /// The `--mcp <name>` server that serves the tools (`run` for the run step).
        public var server: String
        public var signal: CancelSignal
        public var onEvent: ((JSONValue) -> Void)?
    }

    /// → the final result text. The `canvas` server must report itself connected at init, else it is stopped.
    public static func run(_ input: Run) async throws -> String {
        let directory = NodePath.join(NSTemporaryDirectory(), "canvas-claude-setup-\(TaskStore.newId())")
        try FS.mkdirs(directory, mode: 0o700)
        let config = NodePath.join(directory, "mcp.json"), connection = NodePath.join(directory, "bridge.json")
        defer { FS.unlink(config); FS.unlink(connection); rmdir(directory) }
        try FS.write(connection, JSONValue.object(["url": .string(input.bridge.url), "token": .string(input.bridge.token)]).text(), mode: 0o600)
        try FS.write(config, JSONValue.object(["mcpServers": ["canvas": MCPLaunch.claudeConfigEntry(input.server, [connection])]]).text(), mode: 0o600)
        if input.signal.isAborted { throw BuildError("This operation was aborted") }
        var env = input.auth.env
        env["MCP_TOOL_TIMEOUT"] = "240000"
        let state = LocalRunState()
        let killer = CancelSignal()
        let stopToken = input.signal.onAbort { killer.abort() }
        defer { input.signal.remove(stopToken) }
        let reader = Activity.eventReader { event in
            input.onEvent?(event) // a watcher's problem (the Agent map's record), never the run's
            if event["type"]?.string == "system", event["subtype"]?.string == "init" {
                let servers = event["mcp_servers"]?.array ?? []
                let ok = servers.contains { $0["name"]?.string == "canvas" && $0["status"]?.string == "connected" }
                if !ok || !(event["mcp_server_errors"]?.array ?? []).isEmpty { state.fail("Claude could not connect to the sandbox tools."); killer.abort() }
            }
            if event["type"]?.string == "result" { state.result = event }
            if state.size > 2_000_000 { state.fail("Claude output exceeded its size limit."); killer.abort() }
        }
        let out = await Exec.run(input.auth.file, try arguments(config, model: input.model, maxTurns: input.maxTurns, effort: input.effort),
                                 environment: env, directory: directory, input: Data(input.prompt.utf8), signal: killer, newSession: true,
                                 onStdout: { data in state.add(data.count); reader(data) })
        if input.signal.isAborted { throw BuildError("This operation was aborted") }
        if let failure = state.failure { throw BuildError(failure) }
        let result = state.result
        if out.code != 0 || result == nil || result?["is_error"]?.bool == true || result?["subtype"]?.string != "success" {
            let reason = String((result?["result"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? result?["subtype"]?.string ?? "Claude Code exited without a result").prefix(200))
            throw BuildError("Claude Code did not finish: \(reason).")
        }
        return result?["result"]?.string ?? ""
    }
}

final class LocalRunState: @unchecked Sendable {
    private let lock = NSLock()
    private var r: JSONValue?
    private var f: String?
    private var bytes = 0
    var result: JSONValue? { get { lock.lock(); defer { lock.unlock() }; return r } set { lock.lock(); r = newValue; lock.unlock() } }
    var failure: String? { lock.lock(); defer { lock.unlock() }; return f }
    func fail(_ text: String) { lock.lock(); if f == nil { f = text }; lock.unlock() }
    func add(_ n: Int) { lock.lock(); bytes += n; lock.unlock() }
    var size: Int { lock.lock(); defer { lock.unlock() }; return bytes }
}
