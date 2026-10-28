import EngelbartCore
import Foundation

// Running the programs the tool check asks (src/main/tools/run.cjs, 2026-09-23). Everything goes through `exec`, which
// never throws: it resolves to what happened, so a hung, missing or failing program is an answer like any other. `shell`
// runs a command in the login shell, the PATH @bart and the terminal use (an app opened from Finder has no useful PATH of
// its own); values reach it through the environment, never quoted.
//
// The three helpers run.cjs and sign-in.cjs borrow from src/main/terminal/launch.cjs (resolveShell, sanitizeEnvironment,
// loginShellArgs) are copied here as `ToolShell`: the dependency rule keeps this package off the Terminal package.

public let MARK = "__ENGELBART_TOOLS__"

/// What a run did. `code` nil when there is no exit status (killed, not found); `marked`: for `shell`, whether the login
/// shell ran the command at all (its mark was printed).
public struct ExecResult: Sendable, Equatable {
    public var code: Int32?
    public var signal: Int32?
    public var stdout: String
    public var stderr: String
    public var timedOut: Bool
    public var missing: Bool
    public var marked: Bool?

    public init(code: Int32? = 0, signal: Int32? = nil, stdout: String = "", stderr: String = "", timedOut: Bool = false, missing: Bool = false, marked: Bool? = nil) {
        self.code = code; self.signal = signal; self.stdout = stdout; self.stderr = stderr
        self.timedOut = timedOut; self.missing = missing; self.marked = marked
    }
}

/// How the tool check runs programs: the real one below, or a table in tests.
public protocol ToolRunning: AnyObject, Sendable {
    var shellPath: String { get }
    var fish: Bool { get }
    func exec(_ file: String, _ args: [String], env: [String: String], timeout: TimeInterval, cwd: String?, input: String?) async -> ExecResult
    func shell(_ command: String, env: [String: String], timeout: TimeInterval) async -> ExecResult
}

public extension ToolRunning {
    func exec(_ file: String, _ args: [String], env: [String: String] = [:], timeout: TimeInterval = 20) async -> ExecResult {
        await exec(file, args, env: env, timeout: timeout, cwd: nil, input: nil)
    }
    func shell(_ command: String, env: [String: String] = [:], timeout: TimeInterval = 20) async -> ExecResult {
        await shell(command, env: env, timeout: timeout)
    }
}

/// The login shell and its environment (src/main/terminal/launch.cjs).
public enum ToolShell {
    static let transientKeys: Set<String> = [
        "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_ID", "CLAUDE_PARENT_SESSION_ID",
        "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_VERSION", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "NO_COLOR",
    ]
    private static let inspectOption = Rx(#"(?:^|\s)--inspect(?:-brk)?(?:[=\s]|$)"#)

    static func isTransient(_ key: String, _ value: String) -> Bool {
        transientKeys.contains(key) || key.hasPrefix("ELECTRON_") || key.hasPrefix("WARP_") || key.hasPrefix("INSPECT")
            || key.contains("INSPECTOR") || (key.hasPrefix("NODE_") && key.contains("INSPECT"))
            || (key == "NODE_OPTIONS" && inspectOption.test(value))
    }

    /// The environment a child is started with: what the app has, less what belongs to whoever started the app (a Claude
    /// Code or Codex session, an inspector), plus a terminal's TERM and a UTF-8 locale.
    public static func sanitize(_ source: [String: String]) -> [String: String] {
        var environment: [String: String] = [:]
        for (key, value) in source where !isTransient(key, value) { environment[key] = value }
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        environment["TERM_PROGRAM"] = "Engelbart"
        environment["TERM_PROGRAM_VERSION"] = "0.1.0"
        if environment["LANG"] == nil && !environment.keys.contains(where: { $0.hasPrefix("LC_") }) {
            environment["LANG"] = "en_US.UTF-8"
        }
        return environment
    }

    static func isExecutableFile(_ file: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: file, isDirectory: &dir) && !dir.boolValue && FileManager.default.isExecutableFile(atPath: file)
    }

    /// $SHELL when it is an absolute zsh, bash or fish that runs; else /bin/zsh; else /bin/bash.
    public static func resolve(_ environment: [String: String]) -> String {
        let candidate = environment["SHELL"] ?? ""
        let base = (candidate as NSString).lastPathComponent
        if candidate.hasPrefix("/"), ["zsh", "bash", "fish"].contains(base), isExecutableFile(candidate) { return candidate }
        if isExecutableFile("/bin/zsh") { return "/bin/zsh" }
        return "/bin/bash"
    }

    public static func isFish(_ shell: String) -> Bool { (shell as NSString).lastPathComponent == "fish" }

    /// How `command` runs in the person's login shell. ENGELBART_GIT_BIN in `environment` goes first on PATH (after the
    /// startup files, which rebuild PATH with Apple's stub first), ENGELBART_AGENT_PATH's folders last.
    public static func loginShellArgs(_ shell: String, _ command: String, _ environment: [String: String] = [:]) -> [String] {
        let fish = isFish(shell)
        var full = ""
        if let git = environment["ENGELBART_GIT_BIN"], !git.isEmpty { full += fish ? "set -gx PATH $ENGELBART_GIT_BIN $PATH; " : "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; " }
        if let agents = environment["ENGELBART_AGENT_PATH"], !agents.isEmpty { full += fish ? "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); " : "PATH=\"$PATH:$ENGELBART_AGENT_PATH\"; " }
        full += command
        return fish ? ["--login", "--interactive", "--command", full] : ["-ilc", full]
    }
}

/// The real runner. `environment` is read at each run, not once (2026-10-14): a variable set after launch
/// (CLAUDE_CONFIG_DIR, CODEX_HOME) reaches the checks as it reaches the agents, so both say the same about a sign-in.
public final class ToolRunner: ToolRunning, @unchecked Sendable {
    public let shellPath: String
    public let fish: Bool
    private let environment: () -> [String: String]
    static let maxBuffer = 4 * 1024 * 1024

    public init(environment: @escaping () -> [String: String] = { ProcessInfo.processInfo.environment }) {
        self.environment = environment
        self.shellPath = ToolShell.resolve(environment())
        self.fish = ToolShell.isFish(shellPath)
    }

    public func exec(_ file: String, _ args: [String], env: [String: String], timeout: TimeInterval, cwd: String?, input: String?) async -> ExecResult {
        var merged = ToolShell.sanitize(environment())
        for (k, v) in env { merged[k] = v }
        guard ToolShell.isExecutableFile(file) || !file.hasPrefix("/") else { return ExecResult(code: nil, missing: true) }
        let executable = file.hasPrefix("/") ? URL(fileURLWithPath: file) : ShellEnvironment.resolve(file, environment: merged)
        guard let executable else { return ExecResult(code: nil, missing: true) }
        let child = RunningProcess(executable: executable, arguments: args, environment: merged, directory: cwd.map { URL(fileURLWithPath: $0) })
        do { try child.start() } catch { return ExecResult(code: nil, missing: true) }
        if let input { child.write(input) }
        child.closeInput()
        let timer = DispatchWorkItem { child.terminate(grace: 2) }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        let exit = await child.wait()
        timer.cancel()
        let killed = child.wasCancelled
        let cap = { (text: String) -> String in text.utf8.count > ToolRunner.maxBuffer ? String(decoding: Array(text.utf8.prefix(ToolRunner.maxBuffer)), as: UTF8.self) : text }
        return ExecResult(code: exit.signal == nil ? exit.status : nil, signal: exit.signal, stdout: cap(child.stdoutText), stderr: cap(child.stderrText), timedOut: killed, missing: false)
    }

    /// A command in the login shell. Its output is what follows the mark, so whatever the rc files print is skipped.
    public func shell(_ command: String, env: [String: String], timeout: TimeInterval) async -> ExecResult {
        let marked = "printf '\(MARK)\\n'; \(command)"
        let args = fish ? ["--login", "--interactive", "--command", marked] : ["-ilc", marked]
        var out = await exec(shellPath, args, env: env, timeout: timeout, cwd: nil, input: nil)
        return ToolRunner.afterMark(&out)
    }

    static func afterMark(_ out: inout ExecResult) -> ExecResult {
        if let at = out.stdout.range(of: "\(MARK)\n", options: .backwards) {
            out.stdout = String(out.stdout[at.upperBound...])
            out.marked = true
        } else {
            out.stdout = ""
            out.marked = false
        }
        return out
    }
}
