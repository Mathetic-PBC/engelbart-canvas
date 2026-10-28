import Foundation
import EngelbartCore

/// An AbortController/AbortSignal: one-way, thread-safe, with handlers run once on abort (at once when already aborted).
public final class CancelSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var aborted = false
    private var handlers: [UUID: () -> Void] = [:]

    public init() {}

    public var isAborted: Bool { lock.lock(); defer { lock.unlock() }; return aborted }

    public func abort() {
        lock.lock()
        if aborted { lock.unlock(); return }
        aborted = true
        let run = Array(handlers.values)
        handlers = [:]
        lock.unlock()
        run.forEach { $0() }
    }

    @discardableResult
    public func onAbort(_ handler: @escaping () -> Void) -> UUID? {
        lock.lock()
        if aborted { lock.unlock(); handler(); return nil }
        let id = UUID()
        handlers[id] = handler
        lock.unlock()
        return id
    }

    public func remove(_ id: UUID?) {
        guard let id else { return }
        lock.lock(); handlers[id] = nil; lock.unlock()
    }
}

/// A child process started with posix_spawn, optionally the leader of a session (and so a process group) of its own:
/// Node's `spawn(…, { detached: true })`, which run-processes.cjs and the check shell (manager.cjs createShell) rely on
/// so that stopping one stops everything it started, and an interactive shell never reads the terminal Engelbart was
/// started from. Foundation's Process cannot make a new session, hence this.
final class ChildProcess: @unchecked Sendable {
    let pid: pid_t
    private let lock = NSLock()
    private var exit: ProcessExit?
    private var waiters: [CheckedContinuation<ProcessExit, Never>] = []
    private var outHandle: FileHandle?
    private var errHandle: FileHandle?
    private var inHandle: FileHandle?
    private var openStreams = 0
    private var streamWaiters: [CheckedContinuation<Void, Never>] = []

    /// `onOut`/`onErr` are called on a background queue with each chunk as it arrives.
    init(executable: String, arguments: [String], environment: [String: String], directory: String?,
         newSession: Bool, stdin: Bool, onOut: ((Data) -> Void)? = nil, onErr: ((Data) -> Void)? = nil) throws {
        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }

        var outPipe: [Int32] = [0, 0], errPipe: [Int32] = [0, 0], inPipe: [Int32] = [-1, -1]
        guard pipe(&outPipe) == 0, pipe(&errPipe) == 0 else { throw ChildProcess.error("pipe failed") }
        if stdin { guard pipe(&inPipe) == 0 else { throw ChildProcess.error("pipe failed") } }
        if stdin { posix_spawn_file_actions_adddup2(&fileActions, inPipe[0], 0) }
        else { posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0) }
        posix_spawn_file_actions_adddup2(&fileActions, outPipe[1], 1)
        posix_spawn_file_actions_adddup2(&fileActions, errPipe[1], 2)
        if let directory { posix_spawn_file_actions_addchdir_np(&fileActions, directory) }
        // POSIX_SPAWN_SETSID (0x0400): a session and process group of its own. CLOEXEC_DEFAULT (0x4000): nothing but the
        // three standard streams is inherited.
        var flags: Int32 = 0x4000
        if newSession { flags |= 0x0400 }
        posix_spawnattr_setflags(&attr, Int16(flags))
        // Signals: defaults restored and none blocked, as a shell started from launchd has them.
        var all = sigset_t()
        sigfillset(&all)
        posix_spawnattr_setsigdefault(&attr, &all)
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigmask(&attr, &none)
        posix_spawnattr_setflags(&attr, Int16(flags | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

        let argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
        var child: pid_t = 0
        let rc = posix_spawn(&child, executable, &fileActions, &attr, argv, envp)
        close(outPipe[1]); close(errPipe[1])
        if stdin { close(inPipe[0]) }
        if rc != 0 {
            close(outPipe[0]); close(errPipe[0]); if stdin { close(inPipe[1]) }
            throw ChildProcess.error(String(cString: strerror(rc)), code: rc)
        }
        pid = child
        openStreams = 2
        let out = FileHandle(fileDescriptor: outPipe[0], closeOnDealloc: true)
        let err = FileHandle(fileDescriptor: errPipe[0], closeOnDealloc: true)
        outHandle = out; errHandle = err
        if stdin { inHandle = FileHandle(fileDescriptor: inPipe[1], closeOnDealloc: true) }
        out.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; self?.streamClosed() } else { onOut?(data) }
        }
        err.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; self?.streamClosed() } else { onErr?(data) }
        }
        let pid = child
        DispatchQueue.global().async { [weak self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            let exited = (status & 0x7f) == 0
            let result = ProcessExit(status: exited ? (status >> 8) & 0xff : 0, signal: exited ? nil : status & 0x7f)
            self?.finish(result)
        }
    }

    static func error(_ text: String, code: Int32 = 0) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [NSLocalizedDescriptionKey: text])
    }

    private func streamClosed() {
        lock.lock()
        openStreams -= 1
        let done = openStreams <= 0 ? streamWaiters : []
        if openStreams <= 0 { streamWaiters = [] }
        lock.unlock()
        done.forEach { $0.resume() }
    }

    private func finish(_ result: ProcessExit) {
        lock.lock()
        exit = result
        let waiting = waiters
        waiters = []
        lock.unlock()
        waiting.forEach { $0.resume(returning: result) }
    }

    var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return exit == nil }
    var exitStatus: ProcessExit? { lock.lock(); defer { lock.unlock() }; return exit }

    func write(_ data: Data) { try? inHandle?.write(contentsOf: data) }
    func closeInput() { try? inHandle?.close(); inHandle = nil }

    /// The leader's exit (Node's 'exit').
    func wait() async -> ProcessExit {
        await withCheckedContinuation { (c: CheckedContinuation<ProcessExit, Never>) in
            lock.lock()
            if let exit { lock.unlock(); c.resume(returning: exit); return }
            waiters.append(c)
            lock.unlock()
        }
    }

    /// Its output streams closed, or `limit` seconds passed (a grandchild holding the pipe open never hangs a caller).
    func drained(limit: TimeInterval = 2) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    self.lock.lock()
                    if self.openStreams <= 0 { self.lock.unlock(); c.resume(); return }
                    self.streamWaiters.append(c)
                    self.lock.unlock()
                }
            }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000)) }
            await group.next()
            group.cancelAll()
        }
        // A waiter left behind by the timeout is resumed when the streams do close; nothing else waits on it.
    }

    func signal(_ sig: Int32) { kill(pid, sig) }

    /// The whole process group (the leader's pid is its group id when it was started with a session of its own); the
    /// leader alone when that fails.
    func signalGroup(_ sig: Int32) {
        if kill(-pid, sig) != 0 { kill(pid, sig) }
    }
}

/// What `execFile` gives back: the exit code (nil when killed by a timeout or a signal), the output, and why it ended.
struct ExecResult {
    var code: Int32?
    var signal: Int32?
    var stdout: String
    var stderr: String
    var timedOut = false
    var aborted = false
    var notFound = false
    var spawnError: String?
    var ok: Bool { code == 0 && !timedOut && !aborted && !notFound && spawnError == nil }
}

enum Exec {
    /// Runs to its end (Node's execFile): output collected, an optional timeout (SIGTERM, as execFile kills), an
    /// optional abort signal, optional input. `onStdout` sees each chunk as it arrives.
    static func run(_ executable: String, _ arguments: [String], environment: [String: String], directory: String? = nil,
                    input: Data? = nil, timeout: TimeInterval? = nil, signal: CancelSignal? = nil, newSession: Bool = false,
                    killGroup: Bool = false, onStdout: ((Data) -> Void)? = nil) async -> ExecResult {
        let outBuffer = LockedData(), errBuffer = LockedData()
        let child: ChildProcess
        do {
            child = try ChildProcess(executable: executable, arguments: arguments, environment: environment, directory: directory,
                                     newSession: newSession, stdin: input != nil,
                                     onOut: { data in outBuffer.append(data); onStdout?(data) },
                                     onErr: { data in errBuffer.append(data) })
        } catch {
            let code = (error as NSError).code
            return ExecResult(code: nil, signal: nil, stdout: "", stderr: "", notFound: code == Int(ENOENT) || code == Int(EACCES),
                              spawnError: error.localizedDescription)
        }
        if let input {
            DispatchQueue.global().async { child.write(input); child.closeInput() }
        }
        let flags = ExecFlags()
        let stop: (Int32) -> Void = { sig in if killGroup || newSession { child.signalGroup(sig) } else { child.signal(sig) } }
        let token = signal?.onAbort { flags.set(aborted: true); stop(SIGTERM) }
        var timer: DispatchWorkItem?
        if let timeout {
            let work = DispatchWorkItem { flags.set(timedOut: true); stop(SIGTERM) }
            timer = work
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: work)
        }
        let exit = await child.wait()
        timer?.cancel()
        signal?.remove(token)
        await child.drained()
        var result = ExecResult(code: exit.signal == nil ? exit.status : nil, signal: exit.signal,
                                stdout: outBuffer.text, stderr: errBuffer.text)
        result.timedOut = flags.timedOut
        result.aborted = flags.aborted
        if result.timedOut || result.aborted { result.code = nil }
        return result
    }
}

final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
    var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    var bytes: Data { lock.lock(); defer { lock.unlock() }; return data }
}

final class ExecFlags: @unchecked Sendable {
    private let lock = NSLock()
    private var t = false, a = false
    func set(timedOut: Bool) { lock.lock(); t = timedOut; lock.unlock() }
    func set(aborted: Bool) { lock.lock(); a = aborted; lock.unlock() }
    var timedOut: Bool { lock.lock(); defer { lock.unlock() }; return t }
    var aborted: Bool { lock.lock(); defer { lock.unlock() }; return a }
}

/// `setTimeout` as an awaitable pause that a signal cuts short.
func pause(_ seconds: Double, _ signal: CancelSignal? = nil) async {
    if seconds <= 0 { return }
    if let signal {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = OnceFlag()
            let work = DispatchWorkItem { if once.claim() { c.resume() } }
            let token = signal.onAbort { if once.claim() { work.cancel(); c.resume() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: work)
            if once.isClaimed { signal.remove(token) }
        }
    } else {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}

/// Async work run one after another in the order it was pushed, from any thread; `drain()` waits for all pushed so far.
final class OrderedSink: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    func push(_ work: @escaping @Sendable () async -> Void) {
        lock.lock()
        let previous = tail
        tail = Task { await previous?.value; await work() }
        lock.unlock()
    }
    func drain() async {
        lock.lock(); let t = tail; lock.unlock()
        await t?.value
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
    var isClaimed: Bool { lock.lock(); defer { lock.unlock() }; return done }
}
