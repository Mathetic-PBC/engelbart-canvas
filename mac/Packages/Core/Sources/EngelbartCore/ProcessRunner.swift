import Foundation

/// How a child process ended. `signal` is set when it was killed: node-pty reported exitCode 0 for a killed process
/// (memory note, 2026-09-23), so callers must treat a signal as cancelled, never as success.
public struct ProcessExit: Sendable, Equatable {
    public var status: Int32
    public var signal: Int32?
    public var succeeded: Bool { signal == nil && status == 0 }
    public init(status: Int32, signal: Int32?) { self.status = status; self.signal = signal }
}

public struct ProcessResult: Sendable {
    public var exit: ProcessExit
    public var stdout: String
    public var stderr: String
}

public enum ProcessRunnerError: Error, LocalizedError {
    case notFound(String)
    case timedOut(String)
    case failed(String, ProcessExit, String)

    public var errorDescription: String? {
        switch self {
        case .notFound(let name): return "\(name) was not found"
        case .timedOut(let name): return "\(name) took too long"
        case .failed(let name, let exit, let stderr):
            let tail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(name) exited with \(exit.signal.map { "signal \($0)" } ?? "status \(exit.status)")\(tail.isEmpty ? "" : ": \(tail)")"
        }
    }
}

/// A child process with line-by-line output, the Swift counterpart of the `execFile`/`spawn` + readline pattern the
/// Electron main process uses for `claude -p`, `codex exec`, git and the tool installers.
public final class RunningProcess: @unchecked Sendable {
    public let process = Process()
    private let outPipe = Pipe()
    private let errPipe = Pipe()
    private let inPipe = Pipe()
    private let lock = NSLock()
    private var outBuffer = Data()
    private var errBuffer = Data()
    private var stdoutAll = Data()
    private var stderrAll = Data()
    private var finished: ProcessExit?
    private var waiters: [CheckedContinuation<ProcessExit, Never>] = []
    private var cancelled = false

    /// Called on a background queue with each complete line (without the newline).
    public var onStdoutLine: ((String) -> Void)?
    public var onStderrLine: ((String) -> Void)?

    public init(executable: URL, arguments: [String], environment: [String: String]? = nil, directory: URL? = nil) {
        process.executableURL = executable
        process.arguments = arguments
        if let environment { process.environment = environment }
        if let directory { process.currentDirectoryURL = directory }
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = inPipe
    }

    public func start() throws {
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.take(handle.availableData, stderr: false)
        }
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.take(handle.availableData, stderr: true)
        }
        process.terminationHandler = { [weak self] p in
            guard let self else { return }
            // Drain what is left before announcing the end.
            self.outPipe.fileHandleForReading.readabilityHandler = nil
            self.errPipe.fileHandleForReading.readabilityHandler = nil
            self.take(self.outPipe.fileHandleForReading.readDataToEndOfFile(), stderr: false)
            self.take(self.errPipe.fileHandleForReading.readDataToEndOfFile(), stderr: true)
            self.flushPartialLines()
            let exit = ProcessExit(status: p.terminationReason == .exit ? p.terminationStatus : 0,
                                   signal: p.terminationReason == .uncaughtSignal ? p.terminationStatus : nil)
            self.lock.lock()
            self.finished = exit
            let waiting = self.waiters
            self.waiters = []
            self.lock.unlock()
            waiting.forEach { $0.resume(returning: exit) }
        }
        try process.run()
    }

    public func write(_ text: String) {
        inPipe.fileHandleForWriting.write(Data(text.utf8))
    }

    public func closeInput() {
        try? inPipe.fileHandleForWriting.close()
    }

    /// SIGTERM, then SIGKILL after `grace` seconds if it is still running.
    public func terminate(grace: TimeInterval = 3) {
        lock.lock(); cancelled = true; lock.unlock()
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + grace) { [weak self] in
            if self?.process.isRunning == true { kill(pid, SIGKILL) }
        }
    }

    public var wasCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    public func wait() async -> ProcessExit {
        await withCheckedContinuation { (c: CheckedContinuation<ProcessExit, Never>) in
            lock.lock()
            if let finished { lock.unlock(); c.resume(returning: finished); return }
            waiters.append(c)
            lock.unlock()
        }
    }

    public var stdoutText: String { lock.lock(); defer { lock.unlock() }; return String(decoding: stdoutAll, as: UTF8.self) }
    public var stderrText: String { lock.lock(); defer { lock.unlock() }; return String(decoding: stderrAll, as: UTF8.self) }

    private func take(_ data: Data, stderr: Bool) {
        guard !data.isEmpty else { return }
        var lines: [String] = []
        lock.lock()
        if stderr { stderrAll.append(data); errBuffer.append(data) } else { stdoutAll.append(data); outBuffer.append(data) }
        var buffer = stderr ? errBuffer : outBuffer
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            lines.append(String(decoding: line, as: UTF8.self).replacingOccurrences(of: "\r", with: ""))
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        if stderr { errBuffer = buffer } else { outBuffer = buffer }
        lock.unlock()
        let handler = stderr ? onStderrLine : onStdoutLine
        lines.forEach { handler?($0) }
    }

    private func flushPartialLines() {
        lock.lock()
        let out = outBuffer.isEmpty ? nil : String(decoding: outBuffer, as: UTF8.self)
        let err = errBuffer.isEmpty ? nil : String(decoding: errBuffer, as: UTF8.self)
        outBuffer.removeAll(); errBuffer.removeAll()
        lock.unlock()
        if let out { onStdoutLine?(out) }
        if let err { onStderrLine?(err) }
    }
}

public enum ProcessRunner {
    /// Runs to completion and collects output. `name` may be a bare command (resolved on the login-shell PATH) or a path.
    public static func run(_ name: String, _ arguments: [String] = [], environment: [String: String]? = nil,
                           directory: URL? = nil, input: String? = nil, timeout: TimeInterval? = nil) async throws -> ProcessResult {
        guard let executable = ShellEnvironment.resolve(name, environment: environment) else { throw ProcessRunnerError.notFound(name) }
        let child = RunningProcess(executable: executable, arguments: arguments,
                                   environment: environment ?? ShellEnvironment.environment(), directory: directory)
        try child.start()
        if let input { child.write(input) }
        child.closeInput()
        var timedOut = false
        var timer: DispatchWorkItem?
        if let timeout {
            let work = DispatchWorkItem { timedOut = true; child.terminate(grace: 1) }
            timer = work
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: work)
        }
        let exit = await child.wait()
        timer?.cancel()
        if timedOut { throw ProcessRunnerError.timedOut(name) }
        return ProcessResult(exit: exit, stdout: child.stdoutText, stderr: child.stderrText)
    }

    /// Like `run`, but throws unless the process exits 0.
    @discardableResult
    public static func check(_ name: String, _ arguments: [String] = [], environment: [String: String]? = nil,
                             directory: URL? = nil, input: String? = nil, timeout: TimeInterval? = nil) async throws -> String {
        let result = try await run(name, arguments, environment: environment, directory: directory, input: input, timeout: timeout)
        guard result.exit.succeeded else { throw ProcessRunnerError.failed(name, result.exit, result.stderr) }
        return result.stdout
    }
}
