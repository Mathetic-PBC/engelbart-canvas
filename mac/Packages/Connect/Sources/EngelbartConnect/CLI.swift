import Foundation
import EngelbartCore

// The helpers an agent turn needs from other areas of the Electron app, copied here (the dependency rule keeps Bart and
// Terminal out of this package): terminal/launch.cjs (resolveShell, sanitizeEnvironment, loginShellArgs), shell-rc.cjs
// (scrubAgentSession), context/summarizer.cjs (NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine), bart/ask.cjs
// (writeCodexConfig) and bart/activity.cjs (pathLabeller, claudeUpdate, codexUpdate, commandLabel). Same words, same flags.

/// Electron's AbortController/AbortSignal, as the connect code uses it: one-way, with handlers.
public final class AbortSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var aborted = false
    private var handlers: [() -> Void] = []
    public init() {}
    public var isAborted: Bool { lock.lock(); defer { lock.unlock() }; return aborted }
    public func abort() {
        lock.lock()
        if aborted { lock.unlock(); return }
        aborted = true
        let run = handlers
        handlers = []
        lock.unlock()
        run.forEach { $0() }
    }
    /// Runs `handler` once when aborted (at once when it is already).
    public func onAbort(_ handler: @escaping () -> Void) {
        lock.lock()
        if aborted { lock.unlock(); handler(); return }
        handlers.append(handler)
        lock.unlock()
    }
}

/// `ms` waited, or less when `signal` aborts.
public func waitFor(_ ms: Double, _ signal: AbortSignal? = nil) async {
    if signal?.isAborted == true || ms <= 0 { return }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        let once = OnceFlag()
        let item = DispatchWorkItem { if once.take() { c.resume() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + ms / 1000, execute: item)
        signal?.onAbort { item.cancel(); if once.take() { c.resume() } }
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func take() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

public enum CLI {
    /// context/summarizer.cjs NOT_THE_SUBSCRIPTION: what would make a CLI bill an API key rather than the person's plan.
    public static let notTheSubscription = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                                            "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "CODEX_API_KEY"]

    static let transientKeys: Set<String> = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_ID", "CLAUDE_PARENT_SESSION_ID",
                                            "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_VERSION", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "NO_COLOR"]
    static let sessionScoped = [#"^CLAUDE_CODE_(CHILD_SESSION|EXECPATH|MESSAGING_|SESSION_|SSE_PORT)"#, #"^CLAUDE_(PID|EFFORT)$"#, #"^CODEX_(SANDBOX|MANAGED_BY)"#]

    static func isTransient(_ key: String, _ value: String) -> Bool {
        transientKeys.contains(key) || key.hasPrefix("ELECTRON_") || key.hasPrefix("WARP_") || key.hasPrefix("INSPECT") || key.contains("INSPECTOR")
            || (key.hasPrefix("NODE_") && key.contains("INSPECT")) || (key == "NODE_OPTIONS" && JS.test(value, #"(?:^|\s)--inspect(?:-brk)?(?:[=\s]|$)"#))
    }

    /// terminal/launch.cjs sanitizeEnvironment.
    public static func sanitizeEnvironment(_ source: [String: String]) -> [String: String] {
        var env = source.filter { !isTransient($0.key, $0.value) }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Engelbart"
        env["TERM_PROGRAM_VERSION"] = "0.1.0"
        if env["LANG"] == nil && !env.keys.contains(where: { $0.hasPrefix("LC_") }) { env["LANG"] = "en_US.UTF-8" }
        return env
    }

    /// shell-rc.cjs scrubAgentSession: an outer agent session's private variables out.
    public static func scrubAgentSession(_ base: [String: String]) -> [String: String] {
        base.filter { key, _ in !sessionScoped.contains { JS.test(key, $0) } }
    }

    /// terminal/launch.cjs resolveShell: $SHELL when it is zsh, bash or fish and runs; else /bin/zsh, /bin/bash.
    public static func resolveShell(_ env: [String: String]) -> String {
        let candidate = env["SHELL"] ?? ""
        if candidate.hasPrefix("/"), ["zsh", "bash", "fish"].contains((candidate as NSString).lastPathComponent), FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        if FileManager.default.isExecutableFile(atPath: "/bin/zsh") { return "/bin/zsh" }
        return "/bin/bash"
    }

    static func isFish(_ shell: String) -> Bool { (shell as NSString).lastPathComponent == "fish" }

    /// terminal/launch.cjs loginShellArgs: Engelbart's own git first on PATH, the agents' install folder last.
    public static func loginShellArgs(_ shell: String, _ command: String, _ env: [String: String]) -> [String] {
        let git = env["ENGELBART_GIT_BIN"].map { !$0.isEmpty } == true ? (isFish(shell) ? "set -gx PATH $ENGELBART_GIT_BIN $PATH; " : "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; ") : ""
        let agents = env["ENGELBART_AGENT_PATH"].map { !$0.isEmpty } == true ? (isFish(shell) ? "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); " : "PATH=\"$PATH:$ENGELBART_AGENT_PATH\"; ") : ""
        let full = git + agents + command
        return isFish(shell) ? ["--login", "--interactive", "--command", full] : ["-ilc", full]
    }

    /// context/summarizer.cjs lastResultLine: the last `{"type":"result"}` line of a stream-json run.
    public static func lastResultLine(_ stdout: String) -> JSONValue? {
        let lines = stdout.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix("{") && $0.hasSuffix("}") }
        for line in lines.reversed() {
            if let v = try? JSONValue.parse(line), v["type"]?.string == "result" { return v }
        }
        return nil
    }

    /// context/summarizer.cjs prepareCodexHome: the person's ChatGPT sign-in linked into a private home, AGENTS.md = the
    /// instructions. false when the sign-in is not a ChatGPT one (an API key is never used).
    @discardableResult
    public static func prepareCodexHome(codexHome: String, source: String, instructions: String) -> Bool {
        guard let auth = Files.readJSON(URL(fileURLWithPath: source)), auth["auth_mode"]?.string == "chatgpt", JS.truthy(auth["tokens"]) else { return false }
        let fm = FileManager.default
        try? fm.createDirectory(atPath: codexHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let link = (codexHome as NSString).appendingPathComponent("auth.json")
        let linked = try? fm.destinationOfSymbolicLink(atPath: link)
        if linked != source { try? fm.removeItem(atPath: link); try? fm.createSymbolicLink(atPath: link, withDestinationPath: source) }
        let file = (codexHome as NSString).appendingPathComponent("AGENTS.md")
        if (try? String(contentsOfFile: file, encoding: .utf8)) != instructions { try? Files.writeAtomically(instructions, to: URL(fileURLWithPath: file), mode: 0o600) }
        return true
    }

    static func toml(_ value: String) -> String { JSONValue.string(value).text() }
    static func toml(_ values: [String]) -> String { "[\(values.map { toml($0) }.joined(separator: ", "))]" }

    /// bart/ask.cjs writeCodexConfig (no servers: the librarian's and memory's homes).
    public static func writeCodexConfig(home: String, servers: [(name: String, command: String, args: [String], env: [String: String])] = []) {
        var lines = ["# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.", "cli_auth_credentials_store = \"file\""]
        for s in servers {
            lines += ["", "[mcp_servers.\(s.name)]", "command = \(toml(s.command))", "args = \(toml(s.args))",
                      "env = { \(s.env.sorted { $0.key < $1.key }.map { "\($0.key) = \(toml($0.value))" }.joined(separator: ", ")) }", "startup_timeout_sec = 30", "tool_timeout_sec = 90"]
        }
        writeIfChanged(lines.joined(separator: "\n") + "\n", (home as NSString).appendingPathComponent("config.toml"))
    }

    static func writeIfChanged(_ text: String, _ file: String) {
        if (try? String(contentsOfFile: file, encoding: .utf8)) == text { return }
        try? Files.writeAtomically(text, to: URL(fileURLWithPath: file), mode: 0o600)
    }

    // MARK: bart/activity.cjs

    static func clip(_ value: String?, _ max: Int) -> String { Cursor.clip(value, max) }
    static func quoted(_ value: String?) -> String { let t = clip(value, 40); return t.isEmpty ? "" : " for “\(t)”" }
    static func host(_ url: String?) -> String {
        guard let h = URL(string: url ?? "")?.host, !h.isEmpty else { return "a page" }
        return JS.replace(h, #"^www\."#, "")
    }

    /// A path as the person knows it: relative to a directory the agent was granted, otherwise the file's name.
    public static func pathLabeller(_ dirs: [String]) -> (String?) -> String {
        { file in
            let full = file ?? ""
            if full.isEmpty { return "a file" }
            let tail: (String) -> String = { $0.count > 48 ? "…" + $0.suffix(47) : $0 }
            if !full.hasPrefix("/") { return tail(JS.replace(full, #"^\./"#, "")) }
            for dir in dirs where full.hasPrefix(dir + "/") { return tail(String(full.dropFirst(dir.count + 1))) }
            return (full as NSString).lastPathComponent
        }
    }

    static func claudeTool(_ name: String, _ input: JSONValue?, _ short: (String?) -> String) -> String {
        let given = input ?? .object([:])
        if name == "Agent" || name == "Task" { return "Handing\(JS.replace(quoted(given["description"]?.string), "^ for", "")) to a subagent" }
        if name == "Read" { return "Reading \(short(given["file_path"]?.string))" }
        if name == "Grep" { return "Searching code\(quoted(given["pattern"]?.string))" }
        if name == "Glob" { let p = clip(given["pattern"]?.string, 40); return "Listing \(p.isEmpty ? "files" : p)" }
        if name == "WebSearch" { return "Searching the web\(quoted(given["query"]?.string))" }
        if name == "WebFetch" { return "Reading \(host(given["url"]?.string))" }
        if ["Edit", "MultiEdit", "NotebookEdit"].contains(name) { return "Editing \(short(given["file_path"]?.string ?? given["notebook_path"]?.string))" }
        if name == "Write" { return "Writing \(short(given["file_path"]?.string))" }
        if name == "Bash" { return commandLabel(given["command"]?.string, short) }
        return "Using \(clip(name, 24))"
    }

    /// One Claude Code stream-json event → its activity, or nil.
    public static func claudeUpdate(_ event: JSONValue, _ short: (String?) -> String) -> String? {
        if event["type"]?.string == "assistant", let content = event["message"]?["content"]?.array {
            guard let tool = content.first(where: { $0["type"]?.string == "tool_use" }) else { return nil }
            return claudeTool(tool["name"]?.string ?? "", tool["input"], short)
        }
        guard event["type"]?.string == "stream_event", let inner = event["event"] else { return nil }
        if inner["type"]?.string == "content_block_start", inner["content_block"]?["type"]?.string == "thinking" { return "Thinking" }
        return nil
    }

    static let readers: Set<String> = ["cat", "sed", "head", "tail", "nl", "bat", "less", "wc"]
    static let searchers: Set<String> = ["rg", "grep", "ag", "ack"]
    static let listers: Set<String> = ["ls", "find", "fd", "tree"]

    /// Codex reads through the shell. Only the first command's name and one argument are shown.
    public static func commandLabel(_ command: String?, _ short: (String?) -> String) -> String {
        var text = (command ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let wrapped = JS.match(text, #"^\S*(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$"#), let inner = wrapped[2] { text = inner }
        let first = text.components(separatedBy: CharacterSet(charactersIn: "|&;")).first ?? ""
        let words = first.split(whereSeparator: { $0.isWhitespace }).map { JS.replace(String($0), #"^['"]|['"]$"#, "") }.filter { !$0.isEmpty }
        let name = ((words.first ?? "") as NSString).lastPathComponent
        let plain = words.dropFirst().filter { !$0.hasPrefix("-") }
        if readers.contains(name) { return "Reading \(short(plain.last))" }
        if searchers.contains(name) { return "Searching code\(quoted(plain.first))" }
        if listers.contains(name) { return "Listing files" }
        return name.isEmpty ? "Running a command" : "Running \(clip(name, 24))"
    }

    /// One `codex exec --json` event → its activity, or nil.
    public static func codexUpdate(_ event: JSONValue, _ short: (String?) -> String) -> String? {
        guard let type = event["type"]?.string, type == "item.started" || type == "item.completed", let item = event["item"], case .object = item else { return nil }
        let started = type == "item.started"
        switch item["type"]?.string {
        case "command_execution": return started ? commandLabel(item["command"]?.string, short) : nil
        case "web_search":
            let query = item["query"]?.string ?? item["action"]?["query"]?.string
            if let query, !query.isEmpty { return "Searching the web\(quoted(query))" }
            return started ? "Searching the web" : nil
        case "reasoning": return "Thinking"
        case "mcp_tool_call": return started ? "Using \(clip(item["tool"]?.string, 24))" : nil
        case "file_change":
            if started { return nil }
            return "Editing \(item["changes"]?.array?.first.map { short($0["path"]?.string) } ?? "files")"
        default: return nil
        }
    }
}
