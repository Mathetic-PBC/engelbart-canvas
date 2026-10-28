import Foundation
import EngelbartCore

// src/main/sandbox/pty.cjs: a shell in a repository's E2B sandbox, shaped like the part of node-pty the terminal's
// SessionManager uses (pid, onData, onExit, write, resize, kill, pause, resume) plus wake().
//
// What a live sandbox did (engelbart-runner, 2026-10-03): a pty is an interactive bash that resizes and prints UTF-8 as
// any terminal. It outlives its sandbox's pause, shell state and all, but its output stream does not: wait() fails
// ("[unavailable] … ended before the stream completed") within seconds of the pause. Once Sandbox.connect has resumed
// the sandbox, pty.connect(pid) takes the same shell back; what it printed in between is lost. So a dropped stream is
// sleep, not an exit: the terminal says so, and the next keystroke, or opening it again, wakes it ("Waking…" until the
// shell answers). An exit is an exit code. A pid the sandbox no longer has gets a new shell; a sandbox E2B no longer has
// ends the session. The E2B key is asked for at each connection, never kept. Saved values go in as the pty's
// environment, never on a command line. Flow control cannot hold back a remote shell: pause/resume do nothing.

public enum SandboxPtyText {
    static func dim(_ text: String) -> String { "\u{1b}[2m\(text)\u{1b}[0m" }
    static func red(_ text: String) -> String { "\u{1b}[31m\(text)\u{1b}[0m" }
    static let clearLine = "\r\u{1b}[2K"
    public static let asleep = "[sandbox asleep · press Enter to wake it]"
}

/// How a shell ended (node-pty's `{ exitCode }`; nil when its sandbox is gone).
public struct SandboxShellExit: Equatable, Sendable { public var exitCode: Int? }

/// One shell in a sandbox.
public final class SandboxShell: @unchecked Sendable {
    public struct Options: @unchecked Sendable {
        public var cols: Int = 80
        public var rows: Int = 24
        public var cwd: String?
        public var env: [String: String] = [:]
        /// The E2B key, asked for at each connection.
        public var apiKey: () async throws -> String
        /// Shown once, above the first shell's prompt.
        public var banner: String = ""
        public init(cols: Int = 80, rows: Int = 24, cwd: String? = nil, env: [String: String] = [:], banner: String = "", apiKey: @escaping () async throws -> String) {
            self.cols = cols; self.rows = rows; self.cwd = cwd; self.env = env; self.banner = banner; self.apiKey = apiKey
        }
    }

    static let maxPending = 64 * 1024

    private let e2b: E2BService
    private let sandboxId: String
    private let options: Options
    private let idleMs: Int
    private let requestTimeoutMs: Int
    private let lock = NSRecursiveLock()
    private var state = "connecting" // connecting | live | asleep | closed
    private var sandbox: E2BSandbox?
    private var _pid: Int?
    private var generation = 0
    private var connecting: Task<Void, Never>?
    private var opened = false
    private var size: (cols: Int, rows: Int)
    private var pending: [String] = []
    private var pendingBytes = 0
    private let sending = SerialChain()
    private var dataListeners: [UUID: (String) -> Void] = [:]
    private var exitListeners: [UUID: (SandboxShellExit) -> Void] = [:]

    init(e2b: E2BService, sandboxId: String, options: Options, idleMs: Int, requestTimeoutMs: Int) {
        self.e2b = e2b; self.sandboxId = sandboxId; self.options = options; self.idleMs = idleMs; self.requestTimeoutMs = requestTimeoutMs
        size = (options.cols, options.rows)
    }

    public var pid: Int? { lock.withLock { _pid } }
    /// connecting | live | asleep | closed.
    public var status: String { lock.withLock { state } }

    @discardableResult public func onData(_ handler: @escaping (String) -> Void) -> UUID { let id = UUID(); lock.withLock { dataListeners[id] = handler }; return id }
    @discardableResult public func onExit(_ handler: @escaping (SandboxShellExit) -> Void) -> UUID { let id = UUID(); lock.withLock { exitListeners[id] = handler }; return id }
    public func removeListener(_ id: UUID) { lock.withLock { dataListeners[id] = nil; exitListeners[id] = nil } }

    private func emit(_ text: String) { for listener in lock.withLock({ Array(dataListeners.values) }) { listener(text) } }

    private func finish(_ event: SandboxShellExit) {
        let listeners: [(SandboxShellExit) -> Void]? = lock.withLock {
            if state == "closed" { return nil }
            state = "closed"; pending = []; pendingBytes = 0
            return Array(exitListeners.values)
        }
        guard let listeners else { return }
        DispatchQueue.global().async { listeners.forEach { $0(event) } }
    }

    private func fallAsleep(_ gen: Int) {
        let changed: Bool = lock.withLock {
            guard gen == generation, state == "live" else { return false }
            state = "asleep"
            return true
        }
        if changed { emit("\r\n\(SandboxPtyText.dim(SandboxPtyText.asleep))\r\n") }
    }

    private func watch(_ handle: E2BCommandHandle, _ gen: Int) {
        Task {
            do {
                _ = try await handle.wait()
                if lock.withLock({ gen == generation }) { finish(SandboxShellExit(exitCode: 0)) }
            } catch {
                guard lock.withLock({ gen == generation }) else { return }
                if let code = exitCodeOf(error) { finish(SandboxShellExit(exitCode: code)) } else { fallAsleep(gen) }
            }
        }
    }

    private func send(_ data: String) {
        let (target, at, gen) = lock.withLock { (sandbox, _pid, generation) }
        guard let target, let at else { return }
        _ = sending.enqueue { [self] in
            do { try await target.ptySendInput(pid: at, Data(data.utf8), requestTimeoutMs: requestTimeoutMs) } catch { fallAsleep(gen) }
        }
    }

    private func flush() {
        let queued: [String] = lock.withLock { let q = pending; pending = []; pendingBytes = 0; return q }
        queued.forEach(send)
    }

    @discardableResult
    func connect() -> Task<Void, Never> {
        // One locked section until `connecting` holds the task: a connection that fails at once must not finish (and
        // clear `connecting`) before it is recorded, or every later keystroke would get the finished one back.
        lock.lock()
        defer { lock.unlock() }
        if let connecting { return connecting }
        if state == "closed" { return Task {} }
        state = "connecting"
        generation += 1
        let gen = generation
        emit(SandboxPtyText.dim("Waking…"))
        let task = Task { [self] in
            let decoder = UTF8StreamDecoder()
            let early = Locked<[String]>([])
            let shown = Locked(false)
            let onData: @Sendable (Data) -> Void = { [weak self] bytes in
                guard let self, self.lock.withLock({ gen == self.generation && self.state != "closed" }) else { return }
                let text = decoder.decode(bytes)
                if text.isEmpty { return }
                if shown.value { self.emit(text) } else { early.with { $0.append(text) } }
            }
            defer { lock.withLock { if gen == generation || state == "closed" { connecting = nil } } }
            do {
                let key = try await options.apiKey()
                let box: E2BSandbox
                do { box = try await e2b.connect(sandboxId, apiKey: key, timeoutMs: idleMs, requestTimeoutMs: requestTimeoutMs) }
                catch let error as SandboxError where error.isNotFound {
                    guard lock.withLock({ gen == generation }) else { return }
                    emit("\(SandboxPtyText.clearLine)\(SandboxPtyText.red("This sandbox is gone. Build the repository again from its build details."))\r\n")
                    finish(SandboxShellExit(exitCode: nil))
                    return
                }
                lock.withLock { sandbox = box }
                var handle: E2BCommandHandle?
                var fresh = false
                if let pid = lock.withLock({ _pid }) {
                    do { handle = try await box.ptyConnect(pid: pid, timeoutMs: 0, requestTimeoutMs: requestTimeoutMs, onData: onData) }
                    catch let error as SandboxError where error.isNotFound {}
                }
                if handle == nil {
                    let s = lock.withLock { size }
                    handle = try await box.ptyCreate(cols: s.cols, rows: s.rows, cwd: options.cwd, envs: options.env, timeoutMs: 0,
                                                     requestTimeoutMs: requestTimeoutMs, onData: onData)
                    fresh = true
                }
                let live = handle!
                let stale = lock.withLock { state == "closed" || gen != generation }
                if stale { _ = try? await box.ptyKill(pid: live.pid, requestTimeoutMs: requestTimeoutMs); return }
                let (replaced, showBanner): (Bool, Bool) = lock.withLock {
                    let replaced = fresh && _pid != nil
                    _pid = live.pid
                    state = "live"
                    let banner = fresh && !opened && !options.banner.isEmpty
                    opened = true
                    return (replaced, banner)
                }
                emit(SandboxPtyText.clearLine)
                if replaced { emit("\(SandboxPtyText.dim("[the shell had ended while the sandbox slept; this is a new one]"))\r\n") }
                if showBanner { emit(options.banner) }
                shown.with { $0 = true }
                for text in early.with({ let e = $0; $0 = []; return e }) { emit(text) }
                watch(live, gen)
                // A size changed while it slept; and a full-screen program redraws on the change.
                if !fresh {
                    let s = lock.withLock { size }
                    Task { try? await box.ptyResize(pid: live.pid, cols: s.cols, rows: s.rows, requestTimeoutMs: requestTimeoutMs) }
                }
                flush()
            } catch {
                let current = lock.withLock { () -> Bool in
                    if state == "closed" || gen != generation { return false }
                    state = "asleep"
                    return true
                }
                guard current else { return }
                emit("\(SandboxPtyText.clearLine)\(SandboxPtyText.red("Could not reach the sandbox: \(message(of: error).head(200))"))\r\n\(SandboxPtyText.dim("[press Enter to try again]"))\r\n")
            }
        }
        connecting = task
        return task
    }

    public func write(_ data: String) {
        let action: String = lock.withLock {
            if state == "closed" { return "none" }
            if state == "live" { return "send" }
            let bytes = data.utf8.count
            if pendingBytes + bytes <= Self.maxPending { pending.append(data); pendingBytes += bytes }
            return state == "asleep" ? "wake" : "none"
        }
        if action == "send" { send(data) } else if action == "wake" { connect() }
    }

    public func resize(cols: Int, rows: Int) {
        let target: (E2BSandbox, Int)? = lock.withLock {
            size = (cols, rows)
            guard state == "live", let sandbox, let _pid else { return nil }
            return (sandbox, _pid)
        }
        if let (box, pid) = target { Task { try? await box.ptyResize(pid: pid, cols: cols, rows: rows, requestTimeoutMs: requestTimeoutMs) } }
    }

    /// Ends the shell, never the sandbox. One asleep is left in its sandbox rather than waking it to end it.
    public func kill() {
        let target: (E2BSandbox?, Int?, Bool)? = lock.withLock {
            if state == "closed" { return nil }
            let live = state == "live"
            generation += 1
            return (sandbox, _pid, live)
        }
        guard let (box, pid, live) = target else { return }
        finish(SandboxShellExit(exitCode: 0))
        if live, let box, let pid { Task { _ = try? await box.ptyKill(pid: pid, requestTimeoutMs: requestTimeoutMs) } }
    }

    public func pause() {}
    public func resume() {}

    /// Asleep, connected again (opening its tab again does this); otherwise nothing.
    public func wake() async {
        let asleep = lock.withLock { state == "asleep" }
        if asleep { await connect().value }
    }

    func begin() { DispatchQueue.global().async { [self] in connect() } }
}

/// TextDecoder's stream mode: an incomplete UTF-8 sequence at a chunk's end waits for the next chunk.
final class UTF8StreamDecoder: @unchecked Sendable {
    private var carry = Data()
    private let lock = NSLock()

    func decode(_ data: Data) -> String {
        lock.withLock {
            var bytes = carry + data
            var cut = bytes.count
            var i = bytes.count - 1, back = 0
            while i >= 0, back < 3, (bytes[bytes.startIndex + i] & 0xC0) == 0x80 { i -= 1; back += 1 }
            if i >= 0 {
                let lead = bytes[bytes.startIndex + i]
                let need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
                if need > back + 1 { cut = i }
            }
            let text = String(decoding: bytes.prefix(cut), as: UTF8.self)
            bytes = Data(bytes.suffix(from: bytes.startIndex + cut))
            carry = bytes
            return text
        }
    }
}

/// `createSandboxPty`.
public final class SandboxPty: @unchecked Sendable {
    let e2b: E2BService
    let idleMs: Int
    let requestTimeoutMs: Int

    public init(e2b: E2BService, idleMs: Int = SandboxWorker.idleMs, requestTimeoutMs: Int = 30_000) {
        self.e2b = e2b; self.idleMs = idleMs; self.requestTimeoutMs = requestTimeoutMs
    }

    /// A shell, connecting at once (after the caller has subscribed, so "Waking…" is seen: subscribe right away).
    public func spawn(_ sandboxId: String, _ options: SandboxShell.Options) -> SandboxShell {
        let shell = SandboxShell(e2b: e2b, sandboxId: sandboxId, options: options, idleMs: idleMs, requestTimeoutMs: requestTimeoutMs)
        shell.begin()
        return shell
    }

    /// session-manager.cjs's `createSandbox`: the checked spec, its environment and its hint as a banner, then the shell.
    /// The Terminal package registers the shell as a session (provider `sandbox`, `title`, `cwd`, shell `bash`).
    public func spawnSession(_ spec: SandboxShellSpec, cols: Int = 100, rows: Int = 30) throws -> SandboxShell {
        try spec.validate()
        var env = spec.envs
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        return spawn(spec.sandboxId, SandboxShell.Options(cols: cols, rows: rows, cwd: spec.cwd, env: env, banner: spec.banner, apiKey: spec.apiKey))
    }
}

/// What opens a sandbox's shell (manager.cjs's `terminal` → terminals.cjs → SessionManager.createSandbox).
public struct SandboxShellSpec: @unchecked Sendable {
    public var libraryId: String
    public var sandboxId: String
    public var title: String
    public var cwd: String
    public var envs: [String: String]
    public var hint: String
    public var apiKey: () async throws -> String

    public init(libraryId: String, sandboxId: String, title: String, cwd: String, envs: [String: String], hint: String, apiKey: @escaping () async throws -> String) {
        self.libraryId = libraryId; self.sandboxId = sandboxId; self.title = title; self.cwd = cwd; self.envs = envs; self.hint = hint; self.apiKey = apiKey
    }

    public func validate() throws {
        if !sandboxId.matches(#"^[\w-]{1,200}$"#) { throw SandboxError("Invalid sandbox") }
        if libraryId.isEmpty || libraryId.count > 64 { throw SandboxError("Invalid library id") }
        if !cwd.hasPrefix("/") || cwd.contains("\0") || cwd.utf16.count > 4096 { throw SandboxError("Invalid sandbox directory") }
    }

    /// The tab's title: control characters out, at most 200.
    public var sessionTitle: String { stripControlCharacters(title.isEmpty ? "Sandbox" : title).head(200) }

    /// The hint, an example command, shown as a comment above the first prompt and never run.
    public var banner: String {
        let line = stripControlCharacters(hint, replacement: " ").trimmed.head(200)
        return line.isEmpty ? "" : "\u{1b}[2m# Try: \(line)\u{1b}[0m\r\n"
    }
}

/// The terminal pane's sessions, as the sandbox terminals need them (the Terminal package's SessionManager, adapted by
/// the app). Snapshots are the session's JSON (`id`, `status`, `provider`, `title`…).
public protocol SandboxSessions: AnyObject {
    func get(_ id: String) -> JSONValue?
    /// Registers a sandbox shell as a session (provider `sandbox`) and answers its snapshot.
    func createSandbox(_ spec: SandboxShellSpec) throws -> JSONValue
    func wake(_ id: String) async throws
    func close(_ id: String) async throws
}

/// The terminals the manager opens and closes (terminals.cjs's `{ open, close, closeAll }`).
public protocol SandboxTerminalControl: AnyObject {
    func open(_ spec: SandboxShellSpec) throws -> JSONValue
    func close(_ libraryId: String) async
    func closeAll() async
}

/// terminals.cjs: the shells open in repositories' sandboxes: one per repository, a session of the terminal pane, so it
/// follows its window and ends with the app like any other. Opening it again shows the same session, woken if its sandbox
/// slept. Closing its tab ends the shell, never the sandbox; stopping, replacing or releasing the sandbox ends the shell
/// and takes its tab away. `own(id)`: the session's output goes to the window that asked. `closed(id)`: its tab goes.
public final class SandboxTerminals: SandboxTerminalControl, @unchecked Sendable {
    private let sessions: () -> SandboxSessions?
    private let own: (String) -> Void
    private let closed: (String) -> Void
    private let open = Locked<[String: (id: String, sandboxId: String)]>([:])

    public init(sessions: @escaping () -> SandboxSessions?, own: @escaping (String) -> Void = { _ in }, closed: @escaping (String) -> Void = { _ in }) {
        self.sessions = sessions; self.own = own; self.closed = closed
    }

    private func snapshot(_ id: String) -> JSONValue? { sessions()?.get(id) }

    public func open(_ spec: SandboxShellSpec) throws -> JSONValue {
        if let current = open.value[spec.libraryId] {
            let session = snapshot(current.id)
            if let session, session["status"]?.string == "running", current.sandboxId == spec.sandboxId {
                own(current.id)
                let s = sessions()
                Task { try? await s?.wake(current.id) }
                return session
            }
            open.with { $0[spec.libraryId] = nil }
            if session != nil { Task { await end(current.id) } }
        }
        guard let manager = sessions() else { throw SandboxError("Sandbox terminals are unavailable") }
        let session = try manager.createSandbox(spec)
        let id = session["id"]?.string ?? ""
        open.with { $0[spec.libraryId] = (id, spec.sandboxId) }
        own(id)
        return session
    }

    private func end(_ id: String) async {
        try? await sessions()?.close(id)
        closed(id)
    }

    public func close(_ libraryId: String) async {
        let current = open.with { o -> (id: String, sandboxId: String)? in let c = o[libraryId]; o[libraryId] = nil; return c }
        if let current, snapshot(current.id) != nil { await end(current.id) }
    }

    public func closeAll() async {
        for libraryId in open.value.keys { await close(libraryId) }
    }
}
