import Darwin
import Foundation
import SwiftTerm

/// What a session runs on: node-pty's IPty, as the session manager uses it. The local one is `LocalPty`; a shell in a
/// repository's E2B sandbox is the Sandbox package's, adapted to this by the app (Electron: src/main/sandbox/pty.cjs).
/// Callbacks arrive on the queue the process was made with; `onExit` comes after the last `onData`.
public protocol TerminalProcess: AnyObject {
    var pid: Int32 { get }
    /// Output, cut only at UTF-8 character boundaries (node-pty hands strings to its listeners).
    var onData: (([UInt8]) -> Void)? { get set }
    /// (exitCode, signal): node-pty reports exitCode 0 for a process a signal ended (memory note 2026-09-23), so a
    /// signal means cancelled, never success.
    var onExit: ((Int32, Int32?) -> Void)? { get set }
    func write(_ bytes: [UInt8])
    func resize(cols: Int, rows: Int)
    func pause()
    func resume()
    /// node-pty's kill(): SIGHUP unless told otherwise.
    func kill(_ signal: Int32)
    /// A sandbox shell gone quiet because its sandbox slept connects again; a local one does nothing.
    func wake(_ done: @escaping (Error?) -> Void)
}

public extension TerminalProcess {
    func wake(_ done: @escaping (Error?) -> Void) { done(nil) }
}

/// A pseudo-terminal running `file args` with `env` in `cwd` (node-pty's spawn), on SwiftTerm's forkpty helper: the
/// child is a session leader with the PTY as its controlling terminal, and every signal disposition reset.
public final class LocalPty: TerminalProcess, @unchecked Sendable {
    public let pid: Int32
    public var onData: (([UInt8]) -> Void)?
    public var onExit: ((Int32, Int32?) -> Void)?

    private let fd: Int32
    private let callbackQueue: DispatchQueue
    private let ioQueue = DispatchQueue(label: "engelbart.terminal.pty")
    private let writeQueue = DispatchQueue(label: "engelbart.terminal.pty.write")
    private var readSource: DispatchSourceRead?
    private var processSource: DispatchSourceProcess?
    private let lock = NSLock()
    private var paused = false           // the session's flow control
    private var valveShut = false        // too much handed to the callback queue and not yet taken
    private var suspended = false        // whether readSource is suspended now
    private var inFlight = 0
    private var carry: [UInt8] = []      // an incomplete UTF-8 character at the end of the last read
    private var exited = false
    private var closed = false
    private static let valveBytes = 1024 * 1024

    /// Throws the Electron-shaped message when the fork fails.
    public init(file: String, args: [String], env: [String: String], cwd: String, cols: Int, rows: Int, queue: DispatchQueue = .main) throws {
        callbackQueue = queue
        var size = winsize(ws_row: UInt16(clamping: rows), ws_col: UInt16(clamping: cols), ws_xpixel: 0, ws_ypixel: 0)
        let environment = env.map { "\($0.key)=\($0.value)" }
        guard FileManager.default.isExecutableFile(atPath: file) else { throw TerminalError("File not found: \(file)") }
        guard let child = PseudoTerminalHelpers.fork(andExec: file, args: [file] + args, env: environment, currentDirectory: cwd, desiredWindowSize: &size) else {
            throw TerminalError("forkpty(3) failed.")
        }
        pid = child.pid
        fd = child.masterFd
        // Other children the app starts (claude -p, git) must not inherit the master: it would keep the PTY open.
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        start()
    }

    private func start() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: ioQueue)
        source.setEventHandler { [weak self] in self?.readAvailable(estimate: Int(source.data)) }
        let fd = self.fd
        source.setCancelHandler { close(fd) }
        readSource = source
        source.resume()

        let exitSource = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: ioQueue)
        exitSource.setEventHandler { [weak self] in self?.reap() }
        processSource = exitSource
        exitSource.resume()
        ioQueue.async { [weak self] in self?.reap() } // it may have ended before the source was watching
    }

    // MARK: reading (ioQueue)

    private func readAvailable(estimate: Int) {
        let count = max(1, min(estimate, 64 * 1024))
        var buffer = [UInt8](repeating: 0, count: count)
        let n = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, count) }
        if n > 0 {
            deliver(Array(buffer[0..<n]))
        } else if n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR) {
            // EOF / EIO: everything holding the terminal is gone. Stop watching; the exit comes from the process source.
            stopReading()
        }
    }

    /// Reads what is left without blocking (FIONREAD), before the exit is announced.
    private func drain() {
        guard !closed else { return }
        while true {
            let available = PseudoTerminalHelpers.availableBytes(fd: fd)
            guard available.status == 0, available.size > 0 else { break }
            let count = Int(min(available.size, 64 * 1024))
            var buffer = [UInt8](repeating: 0, count: count)
            let n = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, count) }
            if n <= 0 { break }
            deliver(Array(buffer[0..<n]))
        }
        if !carry.isEmpty { let rest = carry; carry = []; post(rest) }
    }

    private func deliver(_ bytes: [UInt8]) {
        var all = carry
        all.append(contentsOf: bytes)
        let cut = UTF8Boundary.completePrefixLength(all)
        carry = Array(all[cut...])
        if cut > 0 { post(Array(all[0..<cut])) }
    }

    private func post(_ bytes: [UInt8]) {
        lock.lock()
        inFlight += bytes.count
        if inFlight > Self.valveBytes && !valveShut { valveShut = true; updateSuspension() }
        lock.unlock()
        callbackQueue.async { [weak self] in
            guard let self else { return }
            self.onData?(bytes)
            self.lock.lock()
            self.inFlight -= bytes.count
            if self.valveShut && self.inFlight <= Self.valveBytes / 4 { self.valveShut = false; self.updateSuspension() }
            self.lock.unlock()
        }
    }

    /// Suspends or resumes the read source to match `paused || valveShut` (lock held).
    private func updateSuspension() {
        guard let source = readSource, !closed else { return }
        let want = paused || valveShut
        if want && !suspended { source.suspend(); suspended = true }
        else if !want && suspended { source.resume(); suspended = false }
    }

    private func stopReading() {
        lock.lock()
        if let source = readSource {
            if suspended { source.resume(); suspended = false }
            source.setEventHandler {}
        }
        lock.unlock()
    }

    private func reap() {
        guard !exited else { return }
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        guard result == pid else { return }
        exited = true
        drain()
        let signaled = (status & 0x7f) != 0 && (status & 0x7f) != 0x7f
        let code: Int32 = signaled ? 0 : (status >> 8) & 0xff
        let signal: Int32? = signaled ? status & 0x7f : nil
        processSource?.cancel()
        callbackQueue.async { [weak self] in self?.onExit?(code, signal) }
    }

    // MARK: TerminalProcess

    public func write(_ bytes: [UInt8]) {
        guard !bytes.isEmpty else { return }
        writeQueue.async { [weak self] in
            guard let self else { return }
            var offset = 0
            while offset < bytes.count {
                self.lock.lock(); let gone = self.closed; self.lock.unlock()
                if gone { return }
                let n = bytes.withUnsafeBytes { Darwin.write(self.fd, $0.baseAddress! + offset, bytes.count - offset) }
                if n > 0 { offset += n; continue }
                if n < 0 && (errno == EAGAIN || errno == EINTR) {
                    var poller = pollfd(fd: self.fd, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&poller, 1, 100)
                    continue
                }
                return
            }
        }
    }

    public func resize(cols: Int, rows: Int) {
        var size = winsize(ws_row: UInt16(clamping: rows), ws_col: UInt16(clamping: cols), ws_xpixel: 0, ws_ypixel: 0)
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        _ = PseudoTerminalHelpers.setWinSize(masterPtyDescriptor: fd, windowSize: &size)
    }

    public func pause() { lock.lock(); paused = true; updateSuspension(); lock.unlock() }
    public func resume() { lock.lock(); paused = false; updateSuspension(); lock.unlock() }

    public func kill(_ signal: Int32 = SIGHUP) {
        guard !exited else { return }
        _ = Darwin.kill(pid, signal)
    }

    /// Lets go of the master (after the process has gone, or when the app gives up on it).
    public func dispose() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        if let source = readSource {
            if suspended { source.resume(); suspended = false }
            source.cancel() // closes fd in its cancel handler
        }
        lock.unlock()
        processSource?.cancel()
    }

    deinit { dispose() }
}

/// Where a byte buffer's last complete UTF-8 character ends (so a multi-byte character is never cut in two).
enum UTF8Boundary {
    static func completePrefixLength(_ bytes: [UInt8]) -> Int {
        let count = bytes.count
        guard count > 0 else { return 0 }
        // Look back at most 3 bytes for a lead byte whose sequence runs past the end.
        var i = count - 1
        var continuation = 0
        while i >= 0 && continuation < 3 && (bytes[i] & 0xC0) == 0x80 { continuation += 1; i -= 1 }
        guard i >= 0 else { return count }
        let lead = bytes[i]
        let need: Int
        if lead & 0x80 == 0 { need = 1 } else if lead & 0xE0 == 0xC0 { need = 2 } else if lead & 0xF0 == 0xE0 { need = 3 } else if lead & 0xF8 == 0xF0 { need = 4 } else { return count }
        return continuation + 1 < need ? i : count
    }

    /// `splitUtf8Prefix` (session-manager.cjs): the first ≤ max bytes ending on a boundary, and the rest.
    static func splitPrefix(_ bytes: [UInt8], max maximum: Int) -> ([UInt8], [UInt8]) {
        guard bytes.count > maximum else { return (bytes, []) }
        var end = maximum
        while end > 0 && (bytes[end] & 0xC0) == 0x80 { end -= 1 }
        if end == 0 { end = maximum }
        return (Array(bytes[0..<end]), Array(bytes[end...]))
    }

    /// `utf8Tail`: the last ≤ max bytes, starting on a boundary.
    static func tail(_ bytes: [UInt8], max maximum: Int) -> [UInt8] {
        guard bytes.count > maximum else { return bytes }
        var start = bytes.count - maximum
        while start < bytes.count && (bytes[start] & 0xC0) == 0x80 { start += 1 }
        return Array(bytes[start...])
    }
}
