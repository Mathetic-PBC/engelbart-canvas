import Darwin
import Foundation

/// A program in a pseudo-terminal: the small forkpty wrapper the hidden sign-in needs (Electron used node-pty). The child
/// gets the terminal as its controlling tty, stdin, stdout and stderr, so a CLI behaves as it does in a terminal window.
/// Everything the child needs is prepared before the fork: after it only async-signal-safe calls run (chdir, execve,
/// _exit).
public final class PtyProcess: @unchecked Sendable {
    public private(set) var pid: pid_t = 0
    private var master: Int32 = -1
    private let lock = NSLock()
    private var exited: (status: Int32, signal: Int32?)?
    private var exitHandlers: [(Int32, Int32?) -> Void] = []
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "engelbart.tools.pty")

    /// Each chunk of output, on a background queue.
    public var onData: ((String) -> Void)?

    public init() {}

    /// Starts `file args` with `env` in `cwd` on a `cols`×`rows` terminal.
    public func spawn(_ file: String, _ args: [String], env: [String: String], cwd: String, cols: UInt16 = 400, rows: UInt16 = 40) throws {
        let argv = ([file] + args).map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        let dir = strdup(cwd)
        let path = strdup(file)
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
            free(dir); free(path)
        }
        var size = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
        var fd: Int32 = -1
        let child = argv.withUnsafeBufferPointer { a in
            envp.withUnsafeBufferPointer { e -> pid_t in
                let pid = forkpty(&fd, nil, nil, &size)
                if pid == 0 {
                    _ = chdir(dir)
                    execve(path, UnsafeMutablePointer(mutating: a.baseAddress!), UnsafeMutablePointer(mutating: e.baseAddress!))
                    _exit(127)
                }
                return pid
            }
        }
        guard child > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        pid = child
        master = fd
        let read = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        read.setEventHandler { [weak self] in self?.drain() }
        read.setCancelHandler { [fd] in close(fd) }
        source = read
        read.resume()
        // The exit, on a thread of its own (waitpid blocks).
        Thread.detachNewThread { [weak self] in
            var status: Int32 = 0
            var result: pid_t
            repeat { result = waitpid(child, &status, 0) } while result == -1 && errno == EINTR
            let signaled = (status & 0x7f) != 0 && (status & 0x7f) != 0x7f
            let code = signaled ? 0 : (status >> 8) & 0xff
            let signal: Int32? = signaled ? status & 0x7f : nil
            // Whatever is still in the terminal is read before the end is announced.
            self?.queue.async { self?.drain(); self?.finish(code, signal) }
        }
    }

    private func drain() {
        guard master >= 0 else { return }
        var buffer = [UInt8](repeating: 0, count: 8192)
        let n = Darwin.read(master, &buffer, buffer.count)
        if n > 0 { onData?(String(decoding: buffer[0..<n], as: UTF8.self)) }
        else if n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR) { source?.cancel(); source = nil; master = -1 }
    }

    private func finish(_ code: Int32, _ signal: Int32?) {
        lock.lock()
        exited = (code, signal)
        let handlers = exitHandlers
        exitHandlers = []
        lock.unlock()
        source?.cancel(); source = nil
        handlers.forEach { $0(code, signal) }
    }

    /// Called once with (exit code, signal) when the child has ended.
    public func onExit(_ handler: @escaping (Int32, Int32?) -> Void) {
        lock.lock()
        if let exited { lock.unlock(); handler(exited.status, exited.signal); return }
        exitHandlers.append(handler)
        lock.unlock()
    }

    public func write(_ text: String) {
        queue.async { [self] in
            guard master >= 0 else { return }
            let bytes = Array(text.utf8)
            _ = bytes.withUnsafeBytes { Darwin.write(master, $0.baseAddress, $0.count) }
        }
    }

    /// SIGHUP, as node-pty's kill() sends by default: the shell and the CLI under it end.
    public func kill(_ sig: Int32 = SIGHUP) {
        guard pid > 0 else { return }
        lock.lock(); let done = exited != nil; lock.unlock()
        if !done { Darwin.kill(pid, sig) }
    }
}
