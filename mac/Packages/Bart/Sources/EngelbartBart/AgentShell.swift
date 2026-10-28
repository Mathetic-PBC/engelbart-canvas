import Foundation
import EngelbartDoc
import EngelbartCore

// How Engelbart runs the claude and codex CLIs, hidden, on the person's subscription (ask.cjs, route.cjs, name-chat.cjs,
// making.cjs, summarizer.cjs): through the person's login shell (terminal/launch.cjs resolveShell, loginShellArgs), so
// the CLIs and their PATH are the ones the terminal has; with an environment that is the app's, minus the transient keys
// of an outer agent session (sanitizeEnvironment, shell-rc.cjs scrubAgentSession) and minus anything that would bill an
// API account (summarizer.cjs NOT_THE_SUBSCRIPTION); every flag a literal, every value through the environment, so
// nothing is quoted by hand. Node's `execFile(shell, args, { cwd, env, timeout, maxBuffer, signal })` maps to a
// RunningProcess: a timeout or a stop sends SIGTERM (Node's killSignal), and what came out is read either way.

/// The tool check (tools/manager.cjs), as far as the agents use it.
public protocol BartTools: AnyObject, Sendable {
    /// The full path the check found a CLI at when the login shell's PATH does not reach it, else nil.
    func binaryFor(_ name: String) -> String?
    /// Variables every agent run gets (ENGELBART_GIT_BIN, ENGELBART_AGENT_PATH …).
    func environment() -> [String: String]
    /// Runs `body` holding the CLI's lock: no install or update of it while it runs.
    func use<T: Sendable>(_ name: String, _ body: @Sendable () async throws -> T) async throws -> T
    /// Waits for an install or update of the CLI to end.
    func ensure(_ name: String) async throws
    /// Checks the CLIs again in the background (after one was not found).
    func check(_ names: [String]) async
    /// The CLIs that can run now, nil before the first check.
    func usableAgents() -> [String]?
}

public enum AgentShell {
    /// Anything that would bill an API account, or send the call somewhere other than the subscription.
    public static let notTheSubscription = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "CODEX_API_KEY"]
    static let transientKeys: Set<String> = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_ID", "CLAUDE_PARENT_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_VERSION", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "NO_COLOR"]
    static let sessionScoped = [JSRegex("^CLAUDE_CODE_(CHILD_SESSION|EXECPATH|MESSAGING_|SESSION_|SSE_PORT)"), JSRegex("^CLAUDE_(PID|EFFORT)$"), JSRegex("^CODEX_(SANDBOX|MANAGED_BY)")]

    static func isTransient(_ key: String, _ value: String) -> Bool {
        transientKeys.contains(key) || key.hasPrefix("ELECTRON_") || key.hasPrefix("WARP_") || key.hasPrefix("INSPECT") || key.contains("INSPECTOR")
            || (key.hasPrefix("NODE_") && key.contains("INSPECT"))
            || (key == "NODE_OPTIONS" && JSRegex("(?:^|\\s)--inspect(?:-brk)?(?:[=\\s]|$)").test(value))
    }

    /// terminal/launch.cjs sanitizeEnvironment.
    public static func sanitize(_ source: [String: String]) -> [String: String] {
        var env = source.filter { !isTransient($0.key, $0.value) }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Engelbart"
        env["TERM_PROGRAM_VERSION"] = "0.1.0"
        if env["LANG"] == nil && !env.keys.contains(where: { $0.hasPrefix("LC_") }) { env["LANG"] = "en_US.UTF-8" }
        return env
    }

    /// shell-rc.cjs scrubAgentSession.
    public static func scrub(_ base: [String: String]) -> [String: String] { base.filter { kv in !sessionScoped.contains { $0.test(kv.key) } } }

    /// The environment an agent CLI runs in: sanitized, scrubbed, no API keys, the tool check's variables, then `extra`.
    public static func childEnvironment(_ base: [String: String], tools: BartTools?, _ extra: [String: String]) -> [String: String] {
        var env = sanitize(scrub(base))
        for key in notTheSubscription { env[key] = nil }
        for (k, v) in tools?.environment() ?? [:] { env[k] = v }
        for (k, v) in extra { env[k] = v }
        return env
    }

    /// terminal/launch.cjs resolveShell: $SHELL when it is an absolute zsh, bash or fish that runs, else /bin/zsh, /bin/bash.
    public static func resolveShell(_ environment: [String: String]) -> String {
        let candidate = environment["SHELL"] ?? ""
        if candidate.hasPrefix("/"), ["zsh", "bash", "fish"].contains((candidate as NSString).lastPathComponent),
           FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        if FileManager.default.isExecutableFile(atPath: "/bin/zsh") { return "/bin/zsh" }
        return "/bin/bash"
    }

    static func isFish(_ shell: String) -> Bool { (shell as NSString).lastPathComponent == "fish" }

    /// terminal/launch.cjs loginShellArgs: Engelbart's own Git first on PATH and the agents' folders last when the
    /// environment names them, then the command; fish takes `--login --interactive --command`, the others `-ilc`.
    public static func loginShellArgs(_ shell: String, _ command: String, _ environment: [String: String]) -> [String] {
        let fish = isFish(shell)
        let git = environment["ENGELBART_GIT_BIN"].map { _ in fish ? "set -gx PATH $ENGELBART_GIT_BIN $PATH; " : "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; " } ?? ""
        let agents = environment["ENGELBART_AGENT_PATH"].map { _ in fish ? "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); " : "PATH=\"$PATH:$ENGELBART_AGENT_PATH\"; " } ?? ""
        let full = "\(git)\(agents)\(command)"
        return fish ? ["--login", "--interactive", "--command", full] : ["-ilc", full]
    }

    /// The CLI by name, or by the full path the tool check found it at when PATH misses it (then through the environment).
    public static func program(_ name: String, _ tools: BartTools?) -> String {
        tools?.binaryFor(name) != nil ? "\"$ENGELBART_\(name.uppercased())_BIN\"" : name
    }
    public static func programEnv(_ name: String, _ tools: BartTools?) -> [String: String] {
        tools?.binaryFor(name).map { ["ENGELBART_\(name.uppercased())_BIN": $0] } ?? [:]
    }

    /// What `execFile` passes its callback as `error`: an exit that was not 0, a kill, or a program that could not start.
    public struct Failure: Error, Sendable {
        /// The exit status (127: the shell did not find the command), or nil when killed or not started.
        public var code: Int32?
        public var notFound: Bool
        public var killed: Bool
        public var message: String
        /// `failure.code === 127 || failure.code === 'ENOENT'`.
        public var isNotFound: Bool { notFound || code == 127 }
        /// `failure.message.split('\n')[0]`.
        public var firstLine: String { message.components(separatedBy: "\n")[0] }
    }

    /// A cancel switch shared by a run and its Stop (the AbortController of ask.cjs).
    public final class Stopper: @unchecked Sendable {
        private let lock = NSLock()
        private var stopped = false
        private var children: [RunningProcess] = []
        public init() {}
        public var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
        public func stop() {
            lock.lock(); stopped = true; let running = children; lock.unlock()
            running.forEach { $0.terminate(grace: 3) }
        }
        func attach(_ child: RunningProcess) -> Bool {
            lock.lock(); defer { lock.unlock() }
            if stopped { return false }
            children.append(child)
            return true
        }
        func detach(_ child: RunningProcess) { lock.lock(); children.removeAll { $0 === child }; lock.unlock() }
    }

    /// Runs `command` in the login shell → (stdout, failure). `onLine`: each whole stdout line as it arrives.
    /// `runner` replaces the process for tests (the Electron tests inject `run`).
    public static func execute(shell: String, command: String, cwd: String, env: [String: String], timeout: TimeInterval,
                               stopper: Stopper? = nil, onLine: ((String) -> Void)? = nil, runner: AgentRunner? = nil) async -> (stdout: String, failure: Failure?) {
        let args = loginShellArgs(shell, command, env)
        if let runner { return await runner.run(shell: shell, args: args, cwd: cwd, env: env, timeout: timeout, stopper: stopper, onLine: onLine) }
        try? FileManager.default.createDirectory(atPath: cwd, withIntermediateDirectories: true)
        let child = RunningProcess(executable: URL(fileURLWithPath: shell), arguments: args, environment: env, directory: URL(fileURLWithPath: cwd))
        child.onStdoutLine = onLine
        do { try child.start() } catch {
            return ("", Failure(code: nil, notFound: true, killed: false, message: "spawn \(shell) ENOENT"))
        }
        child.closeInput()
        if let stopper, !stopper.attach(child) { child.terminate(grace: 1) }
        var timedOut = false
        let timer = DispatchWorkItem { timedOut = true; child.terminate(grace: 3) }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        let exit = await child.wait()
        timer.cancel()
        stopper?.detach(child)
        let stdout = child.stdoutText
        if exit.succeeded && !timedOut { return (stdout, nil) }
        let commandLine = ([shell] + args).joined(separator: " ")
        let stderr = child.stderrText
        let killed = exit.signal != nil || timedOut || (stopper?.isStopped ?? false)
        return (stdout, Failure(code: exit.signal == nil ? exit.status : nil, notFound: false, killed: killed,
                                message: "Command failed: \(commandLine)\n\(stderr)"))
    }
}

/// A stand-in for the CLI process (tests; the fake agents do not need one).
public protocol AgentRunner: Sendable {
    func run(shell: String, args: [String], cwd: String, env: [String: String], timeout: TimeInterval, stopper: AgentShell.Stopper?,
             onLine: ((String) -> Void)?) async -> (stdout: String, failure: AgentShell.Failure?)
}

/// summarizer.cjs lastResultLine: the last `{"type":"result"…}` line of Claude Code's output.
public func lastResultLine(_ stdout: String) -> JSONValue? {
    let lines = JSRegex("\\r?\\n").split(stdout).map { $0.jsTrim }.filter { $0.hasPrefix("{") && $0.hasSuffix("}") }
    for line in lines.reversed() {
        if let v = try? JSONValue.parse(line), v["type"]?.string == "result" { return v }
    }
    return nil
}

/// summarizer.cjs lastUsage: the usage of Codex's last turn.completed.
public func lastUsage(_ stdout: String) -> JSONValue? {
    var usage: JSONValue? = nil
    for line in JSRegex("\\r?\\n").split(stdout) where line.hasPrefix("{") {
        if let e = try? JSONValue.parse(line), e["type"]?.string == "turn.completed", let u = e["usage"], !u.isNull { usage = u }
    }
    return usage
}

/// summarizer.cjs prepareCodexHome: a private CODEX_HOME holding a link to the person's Codex sign-in and an AGENTS.md
/// (how `codex exec` is given a system prompt). False when Codex is not signed in with a ChatGPT account.
@discardableResult
public func prepareCodexHome(codexHome: String, source: String, instructions: String) -> Bool {
    guard let data = FileManager.default.contents(atPath: source), let auth = try? JSONValue.parse(data),
          auth["auth_mode"]?.string == "chatgpt", let tokens = auth["tokens"], !tokens.isNull, tokens != .bool(false) else { return false }
    let fm = FileManager.default
    try? fm.createDirectory(atPath: codexHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let link = (codexHome as NSString).appendingPathComponent("auth.json")
    let linked = try? fm.destinationOfSymbolicLink(atPath: link)
    if linked != source {
        try? fm.removeItem(atPath: link)
        try? fm.createSymbolicLink(atPath: link, withDestinationPath: source)
    }
    let file = (codexHome as NSString).appendingPathComponent("AGENTS.md")
    let current = fm.contents(atPath: file).map { String(decoding: $0, as: UTF8.self) }
    if current != instructions { try? Files.writeAtomically(instructions, to: URL(fileURLWithPath: file), mode: 0o600) }
    return true
}

/// The Codex sign-in a private home links to: `codexAuthFile`, else $CODEX_HOME/auth.json, else ~/.codex/auth.json.
public func codexAuthSource(_ environment: [String: String], _ codexAuthFile: String?) -> String {
    if let codexAuthFile { return codexAuthFile }
    let home = environment["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() as NSString).appendingPathComponent(".codex")
    return (home as NSString).appendingPathComponent("auth.json")
}

/// Writes a file 0600 (`fs.writeFileSync(file, text, { mode: 0o600 })`).
func writePrivate(_ path: String, _ text: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
    chmod(path, 0o600)
}

func removeFile(_ path: String) { try? FileManager.default.removeItem(atPath: path) }
