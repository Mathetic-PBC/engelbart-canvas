import Darwin
import EngelbartCore
import Foundation

// Port of src/main/terminal/session-manager.cjs: the app's terminal sessions (one PTY each), shared by every window.
// Output is batched (8 ms, ≤ 64 KiB, cut at UTF-8 boundaries), numbered, kept as a bounded replay history, and held back
// by flow control while its consumer (the terminal view of the pane that shows it) falls behind: more than 512 KiB not
// yet acknowledged pauses the PTY, ≤ 128 KiB resumes it. In Electron the consumer was a renderer behind IPC; here it is
// the session's SwiftTerm view on the main thread, which acknowledges each batch once it has parsed it.
//
// Main thread only: every public method, and every callback, runs on the main queue.

public struct HistoryEntry: Equatable, Sendable {
    public var sequence: Int
    public var data: String
    public init(sequence: Int, data: String) { self.sequence = sequence; self.data = data }
}

public enum SessionStatus: String, Sendable { case running, exited }

/// What `create`, `get` and `list` hand out (session-manager.cjs #snapshot).
public struct SessionSnapshot: Equatable, Sendable {
    public var id: String
    public var provider: TerminalProvider
    public var libraryId: String?
    public var title: String
    public var cwd: String
    public var shell: String
    public var pid: Int32
    public var cols: Int
    public var rows: Int
    public var status: SessionStatus
    public var exitCode: Int32?
    public var signal: Int32?
    public var createdAt: String
    public var history: [HistoryEntry]
}

/// `terminal:data` {id, sequence, data}.
public struct SessionData: Sendable {
    public var id: String
    public var sequence: Int
    public var bytes: [UInt8]
    public var text: String { String(decoding: bytes, as: UTF8.self) }
}

/// `terminal:exit` {id, exitCode, signal?}.
public struct SessionExit: Equatable, Sendable {
    public var id: String
    public var exitCode: Int32
    public var signal: Int32?
    public init(id: String, exitCode: Int32, signal: Int32? = nil) { self.id = id; self.exitCode = exitCode; self.signal = signal }
}

/// What SessionManager.createSandbox takes (session-manager.cjs createSandbox; the caller is the Sandbox package through
/// the app). `apiKey` is only checked for presence: the sandbox process the app hands in already holds what it needs.
public struct SandboxSessionRequest: Sendable {
    public var sandboxId: String
    public var libraryId: String
    public var title: String?
    public var cwd: String
    public var envs: [String: String]
    public var hint: String
    public var hasApiKey: Bool
    public var cols: Int
    public var rows: Int
    public init(sandboxId: String, libraryId: String, title: String?, cwd: String, envs: [String: String] = [:], hint: String = "",
                hasApiKey: Bool, cols: Int = 100, rows: Int = 30) {
        self.sandboxId = sandboxId; self.libraryId = libraryId; self.title = title; self.cwd = cwd; self.envs = envs
        self.hint = hint; self.hasApiKey = hasApiKey; self.cols = cols; self.rows = rows
    }

    /// What the sandbox PTY is started with: the saved values plus a terminal's TERM.
    public var processEnvironment: [String: String] { envs.merging(["TERM": "xterm-256color", "COLORTERM": "truecolor"]) { _, b in b } }
}

public final class SessionManager {
    public static let defaultMaxSessions = 12
    public static let maxInputBytes = 64 * 1024

    public struct Options {
        public var environment: [String: String]
        /// Read at each start: what changes while the app runs (Engelbart's own Git once the tool check chose it, the
        /// agents' folders) — the Tools package's `environment()`, through the app.
        public var extraEnvironment: () -> [String: String] = { [:] }
        public var maxSessions = SessionManager.defaultMaxSessions
        public var maxReplayBytes = 1024 * 1024
        public var maxReplayEntries = 600
        public var maxUnackedBytes = 512 * 1024
        public var resumeUnackedBytes = 128 * 1024
        public var maxOutputBatchBytes = 64 * 1024
        public var batchDelayMs = 8
        public var closeTimeoutMs = 1500
        public var forceCloseTimeoutMs = 500
        /// Whether the consumer of a session's output is attached (several windows: the pane that holds it). nil: one
        /// switch for all, `attachRenderer`/`detachRenderer`.
        public var attached: ((String) -> Bool)?
        /// How a process starts (tests hand in fakes, as Electron's `pty` option).
        public var spawn: ((Launch.Spec) throws -> TerminalProcess)?
        public init(environment: [String: String]) { self.environment = environment }
    }

    final class Record {
        let id: String
        var provider: TerminalProvider
        var title: String
        var cwd: String
        var shell: String
        var libraryId: String?
        var cols: Int
        var rows: Int
        let pid: Int32
        var status: SessionStatus = .running
        var exitCode: Int32?
        var signal: Int32?
        let createdAt = Time.iso()
        var history: [(sequence: Int, bytes: [UInt8])] = []
        var historyBytes = 0
        var sequence = 0
        var acknowledged = 0
        var outstanding: [Int: Int] = [:]
        var unackedBytes = 0
        var paused = false
        var outputBatch: [UInt8] = []
        var batchTimer: DispatchWorkItem?
        var closeWaiters: [(String) -> Void] = []
        let process: TerminalProcess

        init(id: String, provider: TerminalProvider, title: String, cwd: String, shell: String, libraryId: String?, cols: Int, rows: Int, process: TerminalProcess) {
            self.id = id; self.provider = provider; self.title = title; self.cwd = cwd; self.shell = shell; self.libraryId = libraryId
            self.cols = cols; self.rows = rows; self.process = process; self.pid = process.pid
        }
    }

    public var options: Options
    private var sessions: [String: Record] = [:]
    private var order: [String] = []
    private var rendererAttached = true
    private var dataListeners: [UUID: (SessionData) -> Void] = [:]
    private var exitListeners: [UUID: (SessionExit) -> Void] = [:]

    public init(options: Options) { self.options = options }

    public convenience init(environment: [String: String]) { self.init(options: Options(environment: environment)) }

    // MARK: events

    public struct Listener: Hashable { let id: UUID }

    @discardableResult
    public func onData(_ handler: @escaping (SessionData) -> Void) -> Listener {
        let id = UUID(); dataListeners[id] = handler; return Listener(id: id)
    }

    @discardableResult
    public func onExit(_ handler: @escaping (SessionExit) -> Void) -> Listener {
        let id = UUID(); exitListeners[id] = handler; return Listener(id: id)
    }

    public func off(_ listener: Listener) { dataListeners[listener.id] = nil; exitListeners[listener.id] = nil }

    // MARK: creating

    public func create(_ request: Launch.CreateRequest) throws -> SessionSnapshot {
        if sessions.count >= options.maxSessions { throw TerminalError("At most \(options.maxSessions) sessions may be open") }
        let source = options.environment.merging(options.extraEnvironment()) { _, b in b }
        let launch = try Launch.createLaunchSpec(request, sourceEnvironment: source)
        let process = try (options.spawn ?? Self.spawnLocal)(launch)
        return register(process, provider: launch.provider,
                        title: launch.provider == .shell ? (launch.file as NSString).lastPathComponent : launch.provider.name,
                        cwd: launch.cwd, shell: launch.file, cols: launch.cols, rows: launch.rows, libraryId: nil)
    }

    public static func spawnLocal(_ spec: Launch.Spec) throws -> TerminalProcess {
        try LocalPty(file: spec.file, args: spec.args, env: spec.env, cwd: spec.cwd, cols: spec.cols, rows: spec.rows, queue: .main)
    }

    static let controls = try! NSRegularExpression(pattern: "[\\u0000-\\u001f\\u007f-\\u009f]")

    static func replaceControls(_ value: String, with replacement: String) -> String {
        controls.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..., in: value), withTemplate: replacement)
    }

    /// The validation `createSandbox` does, and the banner it prints (`# Try: <hint>` dimmed, above the first prompt; never
    /// run). → the banner.
    public static func validateSandbox(_ request: SandboxSessionRequest) throws -> String {
        if request.sandboxId.range(of: #"^[A-Za-z0-9_-]{1,200}$"#, options: .regularExpression) == nil { throw TerminalError("Invalid sandbox") }
        if request.libraryId.isEmpty || request.libraryId.count > 64 { throw TerminalError("Invalid library id") }
        if !request.cwd.hasPrefix("/") || request.cwd.contains("\0") || request.cwd.count > 4096 { throw TerminalError("Invalid sandbox directory") }
        if !request.hasApiKey { throw TerminalError("A sandbox terminal needs the E2B key") }
        if !(2...500).contains(request.cols) { throw TerminalError("cols must be an integer between 2 and 500") }
        if !(1...500).contains(request.rows) { throw TerminalError("rows must be an integer between 1 and 500") }
        let line = String(replaceControls(request.hint, with: " ").trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        return line.isEmpty ? "" : "\u{1b}[2m# Try: \(line)\u{1b}[0m\r\n"
    }

    /// A shell in a repository's E2B sandbox (provider 'sandbox'), asked for by the app alone. `process` is the sandbox
    /// PTY the app made from the Sandbox package, started with `request.processEnvironment` and the banner
    /// `validateSandbox` returns (it prints the banner itself, as sandbox/pty.cjs does). No process: "Sandbox terminals
    /// are unavailable".
    public func createSandbox(_ request: SandboxSessionRequest, process: (_ banner: String) throws -> TerminalProcess?) throws -> SessionSnapshot {
        if sessions.count >= options.maxSessions { throw TerminalError("At most \(options.maxSessions) sessions may be open") }
        let banner = try Self.validateSandbox(request)
        guard let handle = try process(banner) else { throw TerminalError("Sandbox terminals are unavailable") }
        let title = String(Self.replaceControls(request.title ?? "", with: "").prefix(200))
        return register(handle, provider: .sandbox, title: title.isEmpty ? "Sandbox" : title, cwd: request.cwd, shell: "bash",
                        cols: request.cols, rows: request.rows, libraryId: request.libraryId)
    }

    /// A sandbox shell gone quiet because its sandbox slept connects again; any other, nothing.
    public func wake(_ id: String, done: @escaping (Error?) -> Void = { _ in }) {
        guard let record = sessions[id], record.status == .running else { done(nil); return }
        record.process.wake(done)
    }

    private func register(_ process: TerminalProcess, provider: TerminalProvider, title: String, cwd: String, shell: String,
                          cols: Int, rows: Int, libraryId: String?) -> SessionSnapshot {
        let id = UUID().uuidString.lowercased()
        let record = Record(id: id, provider: provider, title: title, cwd: cwd, shell: shell, libraryId: libraryId, cols: cols, rows: rows, process: process)
        sessions[id] = record
        order.append(id)
        process.onData = { [weak self, weak record] bytes in
            guard let self, let record else { return }
            self.queueOutput(record, bytes)
        }
        process.onExit = { [weak self, weak record] code, signal in
            guard let self, let record else { return }
            self.handleExit(record, code, signal)
        }
        return snapshot(record)
    }

    // MARK: reading

    public func list() -> [SessionSnapshot] { order.compactMap { sessions[$0] }.map(snapshot) }

    public func get(_ id: String) -> SessionSnapshot? { sessions[id].map(snapshot) }

    /// Sessions still running: quitting ends them.
    public var runningCount: Int { sessions.values.filter { $0.status == .running }.count }

    // MARK: writing

    private func running(_ id: String) throws -> Record {
        guard let record = sessions[id] else { throw TerminalError("Unknown session") }
        guard record.status == .running else { throw TerminalError("Session has exited") }
        return record
    }

    public func write(_ id: String, _ data: String) throws {
        let record = try running(id)
        let bytes = Array(data.utf8)
        if bytes.count > Self.maxInputBytes { throw TerminalError("Terminal input must be a string of at most \(Self.maxInputBytes) bytes") }
        record.process.write(bytes)
    }

    func writeRaw(_ id: String, _ bytes: [UInt8]) throws {
        try running(id).process.write(bytes)
    }

    public func resize(_ id: String, cols: Int, rows: Int) throws {
        let record = try running(id)
        if !(2...500).contains(cols) { throw TerminalError("cols must be an integer between 2 and 500") }
        if !(1...500).contains(rows) { throw TerminalError("rows must be an integer between 1 and 500") }
        record.process.resize(cols: cols, rows: rows)
        record.cols = cols
        record.rows = rows
    }

    // MARK: flow control

    @discardableResult
    public func acknowledge(_ id: String, _ sequence: Int) -> Bool {
        guard let record = sessions[id], sequence > record.acknowledged, sequence <= record.sequence else { return false }
        for (candidate, bytes) in record.outstanding where candidate <= sequence {
            record.unackedBytes -= bytes
            record.outstanding[candidate] = nil
        }
        record.acknowledged = sequence
        record.unackedBytes = max(0, record.unackedBytes)
        if record.paused && record.unackedBytes <= options.resumeUnackedBytes { resume(record) }
        return true
    }

    /// `scope(id)`: only the sessions it names have their flow control reset (one window's); without it, all.
    public func attachRenderer(scope: ((String) -> Bool)? = nil) {
        if scope == nil { rendererAttached = true }
        resetFlow(scope)
    }

    public func detachRenderer(scope: ((String) -> Bool)? = nil) {
        if scope == nil { rendererAttached = false }
        resetFlow(scope)
    }

    private func resetFlow(_ scope: ((String) -> Bool)?) {
        for record in sessions.values {
            if let scope, !scope(record.id) { continue }
            record.acknowledged = record.sequence
            record.outstanding.removeAll()
            record.unackedBytes = 0
            resume(record)
        }
    }

    public struct FlowState: Equatable { public var paused: Bool; public var unackedBytes: Int; public var acknowledged: Int }

    public func flowState(_ id: String) -> FlowState? {
        sessions[id].map { FlowState(paused: $0.paused, unackedBytes: $0.unackedBytes, acknowledged: $0.acknowledged) }
    }

    // MARK: closing

    /// Ends the session's process without asking (SIGHUP, then SIGKILL) and forgets it. → false for an unknown id;
    /// throws "PTY did not exit after termination signals" when even SIGKILL left it running (the record stays).
    public func close(_ id: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        guard let record = sessions[id] else { completion(.success(false)); return }
        let finish = { [weak self] in
            guard let self else { return }
            self.dispose(record)
            self.sessions[id] = nil
            self.order.removeAll { $0 == id }
            completion(.success(true))
        }
        guard record.status == .running else { finish(); return }
        waitForExit(record, timeoutMs: options.closeTimeoutMs) { [weak self] outcome in
            guard let self else { return }
            if outcome == "timeout" && record.status == .running {
                self.waitForExit(record, timeoutMs: self.options.forceCloseTimeoutMs) { forced in
                    if forced == "timeout" && record.status == .running {
                        completion(.failure(TerminalError("PTY did not exit after termination signals")))
                        return
                    }
                    finish()
                }
                record.process.kill(SIGKILL)
                return
            }
            finish()
        }
        record.process.kill(SIGHUP)
    }

    public func close(_ id: String) async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.main.async { self.close(id) { continuation.resume(with: $0) } }
        }
    }

    public func shutdown(completion: @escaping () -> Void = {}) {
        let ids = order
        guard !ids.isEmpty else { completion(); return }
        var left = ids.count
        for id in ids { close(id) { _ in left -= 1; if left == 0 { completion() } } }
    }

    public func shutdown() async {
        await withCheckedContinuation { continuation in DispatchQueue.main.async { self.shutdown { continuation.resume() } } }
    }

    private func waitForExit(_ record: Record, timeoutMs: Int, _ done: @escaping (String) -> Void) {
        var settled = false
        let timer = DispatchWorkItem {
            guard !settled else { return }
            settled = true
            done("timeout")
        }
        record.closeWaiters.append { outcome in
            guard !settled else { return }
            settled = true
            timer.cancel()
            done(outcome)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timer)
    }

    // MARK: output

    private func queueOutput(_ record: Record, _ data: [UInt8]) {
        guard !data.isEmpty, record.status == .running else { return }
        record.outputBatch.append(contentsOf: data)
        while record.outputBatch.count > options.maxOutputBatchBytes {
            let (batch, remainder) = UTF8Boundary.splitPrefix(record.outputBatch, max: options.maxOutputBatchBytes)
            record.outputBatch = batch
            flushOutput(record)
            record.outputBatch = remainder
        }
        if record.batchTimer == nil {
            let work = DispatchWorkItem { [weak self, weak record] in
                guard let self, let record else { return }
                self.flushOutput(record)
            }
            record.batchTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(options.batchDelayMs), execute: work)
        }
    }

    private func flushOutput(_ record: Record) {
        record.batchTimer?.cancel()
        record.batchTimer = nil
        guard !record.outputBatch.isEmpty else { return }
        let data = record.outputBatch
        record.outputBatch = []
        record.sequence += 1
        let sequence = record.sequence
        let replay = UTF8Boundary.tail(data, max: options.maxReplayBytes)
        record.history.append((sequence, replay))
        record.historyBytes += replay.count
        while record.history.count > options.maxReplayEntries || record.historyBytes > options.maxReplayBytes {
            let removed = record.history.removeFirst()
            record.historyBytes -= removed.bytes.count
        }
        let attached = options.attached?(record.id) ?? rendererAttached
        if attached {
            record.outstanding[sequence] = data.count
            record.unackedBytes += data.count
        }
        let event = SessionData(id: record.id, sequence: sequence, bytes: data)
        for listener in Array(dataListeners.values) { listener(event) }
        if attached && record.unackedBytes > options.maxUnackedBytes && !record.paused && sessions[record.id] != nil {
            record.process.pause()
            record.paused = true
        }
    }

    private func handleExit(_ record: Record, _ code: Int32, _ signal: Int32?) {
        flushOutput(record)
        record.status = .exited
        record.exitCode = code
        record.signal = signal
        let event = SessionExit(id: record.id, exitCode: code, signal: signal)
        for listener in Array(exitListeners.values) { listener(event) }
        let waiters = record.closeWaiters
        record.closeWaiters = []
        waiters.forEach { $0("exited") }
    }

    private func resume(_ record: Record) {
        guard record.paused else { return }
        record.process.resume()
        record.paused = false
    }

    private func dispose(_ record: Record) {
        record.batchTimer?.cancel()
        record.batchTimer = nil
        record.process.onData = nil
        record.process.onExit = nil
        (record.process as? LocalPty)?.dispose()
    }

    private func snapshot(_ record: Record) -> SessionSnapshot {
        SessionSnapshot(id: record.id, provider: record.provider, libraryId: record.libraryId, title: record.title, cwd: record.cwd,
                        shell: record.shell, pid: record.pid, cols: record.cols, rows: record.rows, status: record.status,
                        exitCode: record.status == .exited ? record.exitCode : nil, signal: record.status == .exited ? record.signal : nil,
                        createdAt: record.createdAt,
                        history: record.history.map { HistoryEntry(sequence: $0.sequence, data: String(decoding: $0.bytes, as: UTF8.self)) })
    }

    /// Raw replay bytes (for a view adopting the session: fed as they came, without a UTF-8 round trip).
    public func historyBytes(_ id: String) -> [(sequence: Int, bytes: [UInt8])] { sessions[id]?.history ?? [] }

    // MARK: a Build's run step

    /// A shell session in `cwd` (100 × 30) with `command` typed once the shell has drawn its prompt: quiet for 150 ms
    /// after output, at most 3 s after start. Typed sooner, the terminal echoes it and then the shell's line editor draws
    /// it again. (index.cjs runStep.openTerminal)
    public func openCommand(cwd: String, command: String) throws -> SessionSnapshot {
        let session = try create(Launch.CreateRequest(provider: .shell, cwd: cwd, cols: 100, rows: 30))
        var quiet: DispatchWorkItem?
        var cap: DispatchWorkItem?
        var listener: Listener?
        var typed = false
        let type: () -> Void = { [weak self] in
            guard let self, !typed else { return }
            typed = true
            quiet?.cancel(); cap?.cancel()
            if let listener { self.off(listener) }
            try? self.write(session.id, "\(command)\r") // closed already: nothing
        }
        listener = onData { payload in
            guard payload.id == session.id else { return }
            quiet?.cancel()
            let work = DispatchWorkItem(block: type)
            quiet = work
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150), execute: work)
        }
        let capWork = DispatchWorkItem(block: type)
        cap = capWork
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(3), execute: capWork)
        return session
    }
}
