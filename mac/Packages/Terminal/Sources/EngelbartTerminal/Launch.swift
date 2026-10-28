import Foundation

// Port of src/main/terminal/launch.cjs: how a terminal session starts. The provider is a fixed enum (never text that
// reaches a shell), the environment is the app's minus what belongs to the process Engelbart was started from, and
// Claude Code / Codex run inside the person's login shell so they get the PATH a terminal has (an app opened from Finder
// has none worth using).

/// What a terminal tab runs: the shell, Claude Code or Codex (launch.cjs PROVIDERS). `sandbox` is a shell in a
/// repository's E2B sandbox, which only `SessionManager.createSandbox` makes.
public enum TerminalProvider: String, CaseIterable, Sendable, Codable {
    case shell, claude, codex, sandbox

    /// The three a renderer may ask `create` for.
    public static let launchable: [TerminalProvider] = [.shell, .claude, .codex]

    /// PROVIDERS[id].name; sandbox's is PROVIDER_NAMES' (sessions.js).
    public var name: String {
        switch self {
        case .shell: return "Shell"
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .sandbox: return "Sandbox"
        }
    }

    /// PROVIDERS[id].command.
    public var command: String? {
        switch self {
        case .claude: return "claude"
        case .codex: return "codex"
        default: return nil
        }
    }
}

public enum Launch {
    static let transientKeys: Set<String> = [
        "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_ID", "CLAUDE_PARENT_SESSION_ID",
        "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_VERSION", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "NO_COLOR",
    ]

    static let posixStartupUnset = "unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; "
    static let fishStartupUnset = "set -e CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; "

    // By its full path when its name runs another copy (ENGELBART_CLAUDE_BIN, the Tools package's environment: an old one
    // first on PATH, 2026-09-30); else by its name, which also runs an alias of it.
    static let zshProviderScripts: [TerminalProvider: String] = [
        .claude: posixStartupUnset + #"if [ -n "${ENGELBART_CLAUDE_BIN:-}" ]; then "$ENGELBART_CLAUDE_BIN"; else claude; fi; provider_status=$?; printf "\r\n[Claude Code exited with status %d]\r\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il"#,
        .codex: posixStartupUnset + #"if [ -n "${ENGELBART_CODEX_BIN:-}" ]; then "$ENGELBART_CODEX_BIN"; else codex; fi; provider_status=$?; printf "\r\n[Codex exited with status %d]\r\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il"#,
    ]

    static let fishProviderScripts: [TerminalProvider: String] = [
        .claude: fishStartupUnset + #"if set -q ENGELBART_CLAUDE_BIN; $ENGELBART_CLAUDE_BIN; else; claude; end; set provider_status $status; printf "\r\n[Claude Code exited with status %d]\r\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive"#,
        .codex: fishStartupUnset + #"if set -q ENGELBART_CODEX_BIN; $ENGELBART_CODEX_BIN; else; codex; end; set provider_status $status; printf "\r\n[Codex exited with status %d]\r\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive"#,
    ]

    // Engelbart's own Git, while it stands in for a missing one, goes first on PATH for what a login shell runs. It has to
    // be put there by the command, after the person's startup files: those rebuild PATH (macOS's path_helper puts
    // /usr/bin first, and with it Apple's stub, which opens Apple's installer).
    static let posixGitPath = #"PATH="$ENGELBART_GIT_BIN:$PATH"; "#
    static let fishGitPath = "set -gx PATH $ENGELBART_GIT_BIN $PATH; "

    // Claude Code and Codex where the login shell's PATH does not reach them go last on PATH, so `claude` and `codex` run
    // by name in the terminal as they do anywhere else, and the person's own copies, when PATH has them, still come first.
    static let posixAgentPath = #"PATH="$PATH:$ENGELBART_AGENT_PATH"; "#
    static let fishAgentPath = "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); "

    static func isFish(_ shell: String) -> Bool { (shell as NSString).lastPathComponent == "fish" }

    /// How `command` runs in the person's login shell. `environment`: what the shell will be started with;
    /// ENGELBART_GIT_BIN in it goes first on PATH, ENGELBART_AGENT_PATH's folders last.
    public static func loginShellArgs(_ shell: String, _ command: String, environment: [String: String] = [:]) -> [String] {
        let fish = isFish(shell)
        let git = environment["ENGELBART_GIT_BIN"].map { !$0.isEmpty } == true ? (fish ? fishGitPath : posixGitPath) : ""
        let agents = environment["ENGELBART_AGENT_PATH"].map { !$0.isEmpty } == true ? (fish ? fishAgentPath : posixAgentPath) : ""
        let full = git + agents + command
        return fish ? ["--login", "--interactive", "--command", full] : ["-ilc", full]
    }

    private static let inspectOption = try! NSRegularExpression(pattern: #"(?:^|\s)--inspect(?:-brk)?(?:[=\s]|$)"#)

    static func isTransientEnvironmentKey(_ key: String, _ value: String) -> Bool {
        if transientKeys.contains(key) { return true }
        if key.hasPrefix("ELECTRON_") || key.hasPrefix("WARP_") || key.hasPrefix("INSPECT") || key.contains("INSPECTOR") { return true }
        if key.hasPrefix("NODE_") && key.contains("INSPECT") { return true }
        if key == "NODE_OPTIONS" {
            return inspectOption.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
        }
        return false
    }

    /// The environment a session starts with: `source` without the transients, a terminal's own TERM variables, and a
    /// UTF-8 locale when the source names none.
    public static func sanitizeEnvironment(_ source: [String: String]) -> [String: String] {
        var environment: [String: String] = [:]
        for (key, value) in source where !isTransientEnvironmentKey(key, value) { environment[key] = value }
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
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file, isDirectory: &isDir), !isDir.boolValue else { return false }
        return access(file, X_OK) == 0
    }

    /// $SHELL when it is an absolute zsh, bash or fish that runs; else /bin/zsh; else /bin/bash.
    public static func resolveShell(_ environment: [String: String]) throws -> String {
        let candidate = environment["SHELL"] ?? ""
        let supported: Set<String> = ["zsh", "bash", "fish"]
        if candidate.hasPrefix("/") && supported.contains((candidate as NSString).lastPathComponent) && isExecutableFile(candidate) {
            return candidate
        }
        if isExecutableFile("/bin/zsh") { return "/bin/zsh" }
        if isExecutableFile("/bin/bash") { return "/bin/bash" }
        throw TerminalError("No supported shell found (zsh, bash, or fish)")
    }

    static func assertDimension(_ name: String, _ value: Int, _ minimum: Int, _ maximum: Int) throws {
        if value < minimum || value > maximum {
            throw TerminalError("\(name) must be an integer between \(minimum) and \(maximum)")
        }
    }

    public struct CreateRequest: Equatable, Sendable {
        public var provider: String
        public var cwd: String
        public var cols: Int
        public var rows: Int
        public init(provider: String, cwd: String, cols: Int, rows: Int) {
            self.provider = provider; self.cwd = cwd; self.cols = cols; self.rows = rows
        }
        public init(provider: TerminalProvider, cwd: String, cols: Int, rows: Int) {
            self.init(provider: provider.rawValue, cwd: cwd, cols: cols, rows: rows)
        }
    }

    public struct Validated: Equatable, Sendable {
        public var provider: TerminalProvider
        public var cwd: String
        public var cols: Int
        public var rows: Int
    }

    /// The provider is one of the three a renderer may start; the directory exists; the grid is bounded.
    public static func validateCreateRequest(_ request: CreateRequest) throws -> Validated {
        guard let provider = TerminalProvider(rawValue: request.provider), TerminalProvider.launchable.contains(provider) else {
            throw TerminalError("Unknown provider")
        }
        let cwd = request.cwd
        if cwd.isEmpty || cwd.utf16.count > 4096 || cwd.contains("\0") { throw TerminalError("Working directory must be a valid path") }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir) else { throw TerminalError("Working directory does not exist") }
        guard isDir.boolValue else { throw TerminalError("Working directory must be a directory") }
        try assertDimension("cols", request.cols, 2, 500)
        try assertDimension("rows", request.rows, 1, 500)
        return Validated(provider: provider, cwd: resolvePath(cwd), cols: request.cols, rows: request.rows)
    }

    /// `path.resolve`: absolute, `.`/`..` folded, no trailing slash, symlinks left alone.
    static func resolvePath(_ value: String) -> String {
        let absolute = value.hasPrefix("/") ? value : FileManager.default.currentDirectoryPath + "/" + value
        var parts: [Substring] = []
        for part in absolute.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }

    static func shellArguments(_ shell: String, _ provider: TerminalProvider, environment: [String: String]) -> [String] {
        if provider == .shell {
            // zsh's own startup files put Engelbart's Git first and the agents last (ShellRC.swift)
            return isFish(shell) ? ["--login", "--interactive"] : ["-il"]
        }
        let script = (isFish(shell) ? fishProviderScripts : zshProviderScripts)[provider] ?? ""
        return loginShellArgs(shell, script, environment: environment)
    }

    public struct Spec: Sendable {
        public var file: String
        public var args: [String]
        public var cwd: String
        public var cols: Int
        public var rows: Int
        public var env: [String: String]
        public var provider: TerminalProvider
    }

    public static func createLaunchSpec(_ request: CreateRequest, sourceEnvironment: [String: String]) throws -> Spec {
        let validated = try validateCreateRequest(request)
        let shell = try resolveShell(sourceEnvironment)
        var environment = sanitizeEnvironment(sourceEnvironment)
        environment["SHELL"] = shell
        environment["TERMINAL_USER_SHELL"] = shell
        return Spec(file: shell, args: shellArguments(shell, validated.provider, environment: environment), cwd: validated.cwd,
                    cols: validated.cols, rows: validated.rows, env: environment, provider: validated.provider)
    }
}
