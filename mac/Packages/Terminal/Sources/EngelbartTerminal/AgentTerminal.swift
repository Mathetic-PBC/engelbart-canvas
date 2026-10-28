import Darwin
import Foundation

// Port of src/main/terminal/agent-terminal.cjs. The Engelbart terminal's agent sessions (2026-10-13, the "Onboarding"
// workspace, second round: "for the import agents they should route through the built-in Engelbart terminal"). A browser
// agent's CLI (Connect's agents, kind 'browse') runs as a terminal session does: a pseudo-terminal, the person's login
// shell, the terminal's environment and PATH (Launch.swift), so Claude Code and Codex see the same setup they see in
// Engelbart's terminal pane. Nobody looks at it: there is no view, so the few questions a CLI asks its terminal on start
// (what terminal it is, its size in pixels, its keyboard protocol) are answered here, as xterm.js answers them in the pane
// (Claude Code waits for those answers before it draws). What the session printed is kept (the last 2 MiB), with escape
// codes taken out, for the Agent trace; each line is handed on as it ends.

/// AbortController/AbortSignal for a run: `stop()` ends it (stopped = true).
public final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var aborted = false
    private var handlers: [() -> Void] = []
    public init() {}
    public var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return aborted }
    public func stop() {
        lock.lock()
        guard !aborted else { lock.unlock(); return }
        aborted = true
        let run = handlers
        handlers = []
        lock.unlock()
        run.forEach { $0() }
    }
    func onStop(_ handler: @escaping () -> Void) {
        lock.lock()
        if aborted { lock.unlock(); return }
        handlers.append(handler)
        lock.unlock()
    }
    func clear() { lock.lock(); handlers = []; lock.unlock() }
}

public final class AgentTerminal: @unchecked Sendable {
    public static let maxKept = 2 * 1024 * 1024
    public static let killGrace: TimeInterval = 2

    /// The questions a full-screen CLI asks its terminal, and xterm's answers.
    public static let queries: [(pattern: NSRegularExpression, reply: String)] = [
        (#"\x1b\[>0?q"#, "\u{1b}P>|xterm.js(6.0.0)\u{1b}\\"), // XTVERSION
        (#"\x1b\[0?c"#, "\u{1b}[?62;22c"), // DA1: a VT220 with colour
        (#"\x1b\[>0?c"#, "\u{1b}[>0;276;0c"), // DA2
        (#"\x1b\[\?u"#, "\u{1b}[?0u"), // the kitty keyboard protocol: off
        (#"\x1b\[6n"#, "\u{1b}[1;1R"), // where the cursor is
        (#"\x1b\[14t"#, "\u{1b}[4;800;1600t"), // the window's size in pixels
        (#"\x1b\[16t"#, "\u{1b}[6;16;8t"), // a cell's size in pixels
        (#"\x1b\]10;\?(?:\x07|\x1b\\)"#, "\u{1b}]10;rgb:1717/1717/1717\u{1b}\\"), // the text colour
        (#"\x1b\]11;\?(?:\x07|\x1b\\)"#, "\u{1b}]11;rgb:ffff/ffff/ffff\u{1b}\\"), // the background
        (#"\x1b\[\?996n"#, "\u{1b}[?997;2n"), // light or dark: light
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    static let plainRules: [(NSRegularExpression, String)] = [
        (#"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"#, ""),
        (#"\x1bP[^\x1b]*\x1b\\"#, ""),
        (#"\x1b_[^\x1b]*\x1b\\"#, ""),
        (#"\x1b\[[0-9;?<>=!]*[ -/]*[@-~]"#, ""),
        (#"\x1b[()][A-Za-z0-9]"#, ""),
        (#"\x1b[=>78DEHMc]"#, ""),
        (#"\r\n"#, "\n"),
        (#"\r"#, "\n"),
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    /// Terminal output → plain text: escape sequences out, carriage returns that end lines out.
    public static func plain(_ text: String) -> String {
        var out = text
        for (pattern, replacement) in plainRules {
            out = pattern.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: replacement)
        }
        return out
    }

    /// The answers owed for the questions in `data` (a chunk the session printed), in the order asked.
    public static func answersFor(_ data: String) -> [String] {
        var found: [(at: Int, order: Int, reply: String)] = []
        let range = NSRange(data.startIndex..., in: data)
        var order = 0
        for (pattern, reply) in queries {
            for match in pattern.matches(in: data, range: range) { found.append((match.range.location, order, reply)); order += 1 }
        }
        return found.sorted { $0.at != $1.at ? $0.at < $1.at : $0.order < $1.order }.map(\.reply)
    }

    public struct Options {
        public var command: String
        /// The whole environment the session starts with (the caller has taken out what must not reach the CLI, such as
        /// API keys); nil = the terminal's own.
        public var env: [String: String]?
        public var cwd: String
        public var stop: StopSignal?
        public var timeout: TimeInterval = 45 * 60
        /// Each line as it ends, and the partial last one at the end. Called on a background queue.
        public var onLine: (String) -> Void = { _ in }
        public var cols = 220
        public var rows = 50
        public init(command: String, env: [String: String]? = nil, cwd: String, stop: StopSignal? = nil, timeout: TimeInterval = 45 * 60,
                    cols: Int = 220, rows: Int = 50, onLine: @escaping (String) -> Void = { _ in }) {
            self.command = command; self.env = env; self.cwd = cwd; self.stop = stop; self.timeout = timeout
            self.cols = cols; self.rows = rows; self.onLine = onLine
        }
    }

    public struct Result: Equatable, Sendable {
        public var output: String
        public var exitCode: Int32
        public var signal: Int32?
        public var timedOut: Bool
        public var stopped: Bool
        public var error: String?
    }

    public typealias Spawn = (_ file: String, _ args: [String], _ env: [String: String], _ cwd: String, _ cols: Int, _ rows: Int, _ queue: DispatchQueue) throws -> TerminalProcess

    let environment: [String: String]
    let extraEnvironment: () -> [String: String]
    let spawn: Spawn

    /// `environment`: the app's (Electron: environmentForSessions(process.env) — SHELL is the launcher); `extraEnvironment`:
    /// what the terminal adds now (Engelbart's Git, the agents' PATH: the Tools package's environment).
    public init(environment: [String: String] = ProcessInfo.processInfo.environment, extraEnvironment: @escaping () -> [String: String] = { [:] },
                spawn: Spawn? = nil) {
        self.environment = environment
        self.extraEnvironment = extraEnvironment
        self.spawn = spawn ?? { file, args, env, cwd, cols, rows, queue in
            try LocalPty(file: file, args: args, env: env, cwd: cwd, cols: cols, rows: rows, queue: queue)
        }
    }

    public func run(_ options: Options) async -> Result {
        await withCheckedContinuation { continuation in run(options) { continuation.resume(returning: $0) } }
    }

    public func run(_ options: Options, completion: @escaping (Result) -> Void) {
        let queue = DispatchQueue(label: "engelbart.agent-terminal")
        let base = options.env ?? Launch.sanitizeEnvironment(environment.merging(extraEnvironment()) { _, b in b })
        let shell: String
        do {
            shell = try Launch.resolveShell(base["SHELL"].map { !$0.isEmpty } == true ? base : environment)
        } catch {
            completion(Result(output: "", exitCode: 127, signal: nil, timedOut: false, stopped: false, error: errorText(error)))
            return
        }
        var merged = base
        merged["TERM"] = "xterm-256color"
        merged["SHELL"] = shell
        merged["TERMINAL_USER_SHELL"] = shell
        let handle: TerminalProcess
        queue.suspend() // nothing it prints is handled before the handlers below are in place
        defer { queue.resume() }
        do {
            handle = try spawn(shell, Launch.loginShellArgs(shell, options.command, environment: merged), merged, options.cwd, options.cols, options.rows, queue)
        } catch {
            completion(Result(output: "", exitCode: 127, signal: nil, timedOut: false, stopped: false, error: errorText(error)))
            return
        }

        // Everything below runs on `queue`.
        var kept = ""
        var keptBytes = 0
        var partial = ""
        var ended = false
        var timedOut = false
        var stopped = false
        var killTimer: DispatchWorkItem?
        var timer: DispatchWorkItem?

        func finish(_ code: Int32, _ signal: Int32?) {
            if ended { return }
            ended = true
            timer?.cancel()
            killTimer?.cancel()
            options.stop?.clear()
            if !partial.isEmpty { options.onLine(partial); partial = "" }
            (handle as? LocalPty)?.dispose()
            completion(Result(output: kept, exitCode: code, signal: signal, timedOut: timedOut, stopped: stopped, error: nil))
        }
        func kill() {
            handle.kill(SIGTERM)
            let work = DispatchWorkItem { handle.kill(SIGKILL) }
            killTimer = work
            queue.asyncAfter(deadline: .now() + Self.killGrace, execute: work)
        }

        queue.async {
            let timeout = DispatchWorkItem { if !ended { timedOut = true; kill() } }
            timer = timeout
            queue.asyncAfter(deadline: .now() + options.timeout, execute: timeout)
            if let stop = options.stop {
                if stop.isStopped { stopped = true; queue.async { kill() } } // the next tick, as setTimeout(kill, 0)
                else { stop.onStop { queue.async { if !ended { stopped = true; kill() } } } }
            }
        }
        handle.onData = { bytes in
            let data = String(decoding: bytes, as: UTF8.self)
            for reply in Self.answersFor(data) { handle.write(Array(reply.utf8)) }
            let text = Self.plain(data)
            kept += text
            keptBytes += text.utf16.count
            if keptBytes > Self.maxKept { // `.slice(-MAX_KEPT)`: the last MAX_KEPT UTF-16 units
                let units = Array(kept.utf16)
                kept = String(decoding: units.suffix(Self.maxKept).map { $0 }, as: UTF16.self)
                keptBytes = Self.maxKept
            }
            var lines = (partial + text).components(separatedBy: "\n")
            partial = lines.removeLast()
            for line in lines { options.onLine(line) }
        }
        handle.onExit = { code, signal in finish(code, signal) }
    }
}
