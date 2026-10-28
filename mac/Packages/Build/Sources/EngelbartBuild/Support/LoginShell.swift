import Foundation
import EngelbartCore

/// The login shell as the Electron main process uses it for agents, checks and run-step processes
/// (terminal/launch.cjs resolveShell / sanitizeEnvironment / loginShellArgs, shell-rc.cjs scrubAgentSession,
/// context/summarizer.cjs NOT_THE_SUBSCRIPTION). The Terminal package owns the terminal's copy; these are the same
/// rules, kept here so Build builds on its own (ARCHITECTURE §2 dependency rule).
public enum LoginShell {
    static let transientKeys: Set<String> = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_ID",
        "CLAUDE_PARENT_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_VERSION", "NODE_CHANNEL_FD",
        "NODE_UNIQUE_ID", "NO_COLOR"]

    /// Keys only the subscription's own sign-in may decide: an API key is never used.
    public static let notTheSubscription = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "CODEX_API_KEY"]

    static func isFish(_ shell: String) -> Bool { NodePath.basename(shell) == "fish" }

    /// $SHELL when it is an absolute zsh/bash/fish that runs, else /bin/zsh, else /bin/bash.
    public static func resolveShell(_ environment: [String: String]) -> String {
        let candidate = environment["SHELL"] ?? ""
        if NodePath.isAbsolute(candidate), ["zsh", "bash", "fish"].contains(NodePath.basename(candidate)),
           FileManager.default.isExecutableFile(atPath: candidate), FS.isFile(candidate) { return candidate }
        if FileManager.default.isExecutableFile(atPath: "/bin/zsh") { return "/bin/zsh" }
        return "/bin/bash"
    }

    static func isTransient(_ key: String, _ value: String) -> Bool {
        if transientKeys.contains(key) || key.hasPrefix("ELECTRON_") || key.hasPrefix("WARP_") || key.hasPrefix("INSPECT") || key.contains("INSPECTOR") { return true }
        if key.hasPrefix("NODE_") && key.contains("INSPECT") { return true }
        if key == "NODE_OPTIONS", value.range(of: #"(?:^|\s)--inspect(?:-brk)?(?:[=\s]|$)"#, options: .regularExpression) != nil { return true }
        return false
    }

    public static func sanitize(_ source: [String: String]) -> [String: String] {
        var env = source.filter { !isTransient($0.key, $0.value) }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Engelbart"
        env["TERM_PROGRAM_VERSION"] = "0.1.0"
        if env["LANG"] == nil && !env.keys.contains(where: { $0.hasPrefix("LC_") }) { env["LANG"] = "en_US.UTF-8" }
        return env
    }

    static let sessionScoped: [NSRegularExpression] = [
        #"^CLAUDE_CODE_(CHILD_SESSION|EXECPATH|MESSAGING_|SESSION_|SSE_PORT)"#, #"^CLAUDE_(PID|EFFORT)$"#, #"^CODEX_(SANDBOX|MANAGED_BY)"#,
    ].map { try! NSRegularExpression(pattern: $0) }

    /// `base` without an outer agent session's private variables.
    public static func scrubAgentSession(_ base: [String: String]) -> [String: String] {
        base.filter { key, _ in !sessionScoped.contains { $0.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil } }
    }

    /// `-ilc <command>` (fish: `--login --interactive --command`). ENGELBART_GIT_BIN in the environment goes first on
    /// PATH and ENGELBART_AGENT_PATH's folders last, put there by the command itself, after the startup files.
    public static func arguments(_ shell: String, _ command: String, _ environment: [String: String]) -> [String] {
        let fish = isFish(shell)
        let git = environment["ENGELBART_GIT_BIN"].map { !$0.isEmpty } == true ? (fish ? "set -gx PATH $ENGELBART_GIT_BIN $PATH; " : "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; ") : ""
        let agent = environment["ENGELBART_AGENT_PATH"].map { !$0.isEmpty } == true ? (fish ? "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); " : "PATH=\"$PATH:$ENGELBART_AGENT_PATH\"; ") : ""
        let full = git + agent + command
        return fish ? ["--login", "--interactive", "--command", full] : ["-ilc", full]
    }

    /// The last `{"type":"result"…}` line of Claude Code's stream.
    static func lastResultLine(_ stdout: String) -> JSONValue? {
        let lines = stdout.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.hasPrefix("{") && $0.hasSuffix("}") }
        for line in lines.reversed() {
            if let value = try? JSONValue.parse(line), value["type"]?.string == "result" { return value }
        }
        return nil
    }
}

/// The result of a check or a setup command (manager.cjs createShell): ok, the output as checkOutput keeps it, timed out.
public struct ShellOutcome: Sendable, Equatable {
    public var ok: Bool
    public var output: String
    public var timedOut: Bool
    public init(ok: Bool, output: String, timedOut: Bool = false) { self.ok = ok; self.output = output; self.timedOut = timedOut }
}

/// A shell command in the login shell (the PATH the terminal has), in `cwd`: Accept's checks and `build.setup`.
public typealias BuildShell = @Sendable (_ command: String, _ cwd: String, _ env: [String: String]) async -> ShellOutcome

enum CheckShell {
    static let shellMs: TimeInterval = 10 * 60

    /// `tools`: Engelbart's own Git first on PATH when it stands in. CI=1. A session of its own (2026-09-29): an
    /// interactive zsh a check starts never reads the keyboard of the terminal Engelbart was started from.
    static func make(environment: [String: String] = ShellEnvironment.environment(), toolsEnvironment: @escaping @Sendable () -> [String: String] = { [:] }) -> BuildShell {
        let shell = LoginShell.resolveShell(environment)
        return { command, cwd, env in
            var full = LoginShell.sanitize(LoginShell.scrubAgentSession(environment))
            full["CI"] = "1"
            for (k, v) in toolsEnvironment() { full[k] = v }
            for (k, v) in env { full[k] = v }
            let out = await Exec.run(shell, LoginShell.arguments(shell, command, full), environment: full, directory: cwd,
                                     timeout: shellMs, newSession: true)
            return ShellOutcome(ok: out.ok, output: checkOutput(out.stdout + out.stderr), timedOut: out.timedOut)
        }
    }

    // A failed test's line, in what the common runners print: node's TAP and spec, Jest, pytest.
    static let failedLine = try! NSRegularExpression(pattern: #"^\s*(not ok \d+ - |✖ |FAIL |FAILED |● )"#)
}

/// The last 4000 characters of a check's output, and first the names of what failed before them (2026-09-29): node's TAP
/// reports each failure where it happens, so a long run's failures scroll out of the tail and nobody sees which.
public func checkOutput(_ text: String, _ n: Int = 4000) -> String {
    let value = Array(text)
    let headCount = max(0, value.count - n)
    let head = String(value[0..<headCount])
    var seen = Set<String>()
    var failed: [String] = []
    for line in head.components(separatedBy: "\n") where CheckShell.failedLine.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil {
        let trimmed = String(line.trimmingCharacters(in: .whitespaces).prefix(300))
        if seen.insert(trimmed).inserted { failed.append(trimmed) }
    }
    failed = Array(failed.prefix(40))
    let prefix = failed.isEmpty ? "" : "What failed, before what is shown below:\n\(failed.joined(separator: "\n"))\n\n"
    return prefix + tailText(text, n)
}

/// `…` + the last `n` characters when longer.
func tailText(_ text: String, _ n: Int = 4000) -> String {
    text.count > n ? "…" + String(text.suffix(n)) : text
}
