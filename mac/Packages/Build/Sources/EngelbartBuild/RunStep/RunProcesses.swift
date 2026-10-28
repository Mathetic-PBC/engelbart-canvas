import AppKit
import Foundation
import EngelbartCore

/// The processes a Build's run step starts (run-processes.cjs, 2026-09-29): Engelbart's, never the agent's. Each runs in
/// the person's login shell as the leader of a process group of its own, so stopping it stops everything it started;
/// what it prints is kept (the last 32 KB) for the agent to read when a check fails. The checks are Engelbart's own:
///   ui        answers on the port Engelbart gave it (127.0.0.1 or ::1)
///   app       still running 10 seconds after it started
///   terminal  exits 0
public final class RunProcesses: @unchecked Sendable {
    static let outputBytes = 32_000
    public static let appAlive: TimeInterval = 10
    public static let uiReady: TimeInterval = 90
    public static let stopWait: TimeInterval = 5

    final class Record: @unchecked Sendable {
        let key: String
        let command: String
        let cwd: String
        let child: ChildProcess
        let startedAt = Date()
        let tail: OutputTail
        init(key: String, command: String, cwd: String, child: ChildProcess, tail: OutputTail) {
            self.key = key; self.command = command; self.cwd = cwd; self.child = child; self.tail = tail
        }
        var output: String { tail.text }
        var running: Bool { child.isRunning }
        var pid: Int32 { child.pid }
    }

    let environment: [String: String]
    let extraEnvironment: @Sendable () -> [String: String]
    let appAliveTime: TimeInterval
    let uiReadyTime: TimeInterval
    let shell: String
    private let lock = NSLock()
    private var owned: [String: Record] = [:]

    /// `environment`: what every process starts from; `extraEnvironment()`: added at each start (Engelbart's own Git).
    public init(environment: [String: String] = ShellEnvironment.environment(), extraEnvironment: @escaping @Sendable () -> [String: String] = { [:] },
                appAlive: TimeInterval = RunProcesses.appAlive, uiReady: TimeInterval = RunProcesses.uiReady) {
        self.environment = environment
        self.extraEnvironment = extraEnvironment
        self.appAliveTime = appAlive
        self.uiReadyTime = uiReady
        self.shell = LoginShell.resolveShell(environment)
    }

    func envFor(_ extra: [String: String]) -> [String: String] {
        // BROWSER=none: a dev server opens no browser of its own; the Stage shows it.
        var env = LoginShell.sanitize(LoginShell.scrubAgentSession(environment))
        for (k, v) in extraEnvironment() { env[k] = v }
        env["BROWSER"] = "none"
        for (k, v) in extra { env[k] = v }
        return env
    }

    func record(_ key: String) -> Record? { lock.lock(); defer { lock.unlock() }; return owned[key] }

    /// `command` started in `cwd` as `key`'s process (one running per key: an earlier one is stopped first).
    @discardableResult
    func start(_ key: String, _ command: String, _ cwd: String, env: [String: String] = [:]) async throws -> Record {
        await stop(key)
        let full = envFor(env)
        let tail = OutputTail()
        let child = try ChildProcess(executable: shell, arguments: LoginShell.arguments(shell, command, full), environment: full, directory: cwd,
                                     newSession: true, stdin: false, onOut: { tail.take($0) }, onErr: { tail.take($0) })
        let made = Record(key: key, command: command, cwd: cwd, child: child, tail: tail)
        lock.lock(); owned[key] = made; lock.unlock()
        return made
    }

    /// Its whole process group stopped, and confirmed gone. → whether there was one running
    @discardableResult
    public func stop(_ key: String) async -> Bool {
        lock.lock(); let rec = owned.removeValue(forKey: key); lock.unlock()
        guard let rec, rec.running else { return false }
        rec.child.signalGroup(SIGTERM)
        let gone = await RunProcesses.waitExit(rec.child, RunProcesses.stopWait)
        if !gone { rec.child.signalGroup(SIGKILL); _ = await RunProcesses.waitExit(rec.child, 2) }
        rec.child.signalGroup(SIGKILL) // what the leader left behind in its group
        return true
    }

    static func waitExit(_ child: ChildProcess, _ seconds: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while child.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        return !child.isRunning
    }

    public func stopAll() async {
        lock.lock(); let keys = Array(owned.keys); lock.unlock()
        await withTaskGroup(of: Void.self) { group in for key in keys { group.addTask { await self.stop(key) } } }
    }

    /// What the agent is shown of a process.
    public func status(_ key: String) -> JSONValue {
        guard let rec = record(key) else { return ["running": false] }
        let exit = rec.child.exitStatus
        return ["running": .bool(rec.running), "pid": .number(Double(rec.pid)),
                "exit_code": exit.map { $0.signal == nil ? .number(Double($0.status)) : .null } ?? .null,
                "signal": exit?.signal.map { .string(RunProcesses.signalName($0)) } ?? .null,
                "seconds": .number(Date().timeIntervalSince(rec.startedAt).rounded()),
                "output": .string(String(rec.output.suffix(8000)))]
    }

    static func signalName(_ sig: Int32) -> String {
        ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGEMT", "SIGFPE", "SIGKILL", "SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM"]
            .indices.contains(Int(sig) - 1) ? ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGEMT", "SIGFPE", "SIGKILL", "SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM"][Int(sig) - 1] : "SIG\(sig)"
    }

    public struct ExitRun: Sendable { public var code: Int32?; public var output: String; public var timedOut: Bool }

    /// `command` run to its end (an install, a build, a terminal program's check): Engelbart's while it runs.
    public func runToExit(_ key: String, _ command: String, _ cwd: String, timeout: TimeInterval = 120, signal: CancelSignal? = nil, env: [String: String] = [:]) async -> ExitRun {
        let rec: Record
        do { rec = try await start(key, command, cwd, env: env) } catch { return ExitRun(code: -1, output: error.text, timedOut: false) }
        let flags = ExecFlags()
        let timer = DispatchWorkItem { flags.set(timedOut: true); Task { await self.stop(key) } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        let token = signal?.onAbort { Task { await self.stop(key) } }
        let exit = await rec.child.wait()
        timer.cancel()
        signal?.remove(token)
        await rec.child.drained(limit: 0.5)
        lock.lock(); if owned[key] === rec { owned[key] = nil }; lock.unlock()
        let code: Int32? = flags.timedOut ? nil : (exit.signal == nil ? exit.status : nil)
        return ExitRun(code: code, output: rec.output, timedOut: flags.timedOut)
    }

    public struct Check: Sendable { public var ok: Bool; public var url: String?; public var failedCheck: String?; public var output: String }

    /// The check for a runnable just started as `key`. `url`: where a UI is shown. A terminal program is checked by
    /// running it (runToExit), not here.
    public func check(_ key: String, type: String, port: Int? = nil, signal: CancelSignal? = nil) async -> Check {
        guard let rec = record(key) else { return Check(ok: false, url: nil, failedCheck: "The process is not running.", output: "") }
        func exitWords() -> String {
            let exit = rec.child.exitStatus
            let code = exit.map { $0.signal == nil ? String($0.status) : "null" } ?? "null"
            let sig = exit?.signal.map { ", \(RunProcesses.signalName($0))" } ?? ""
            return "exit code \(code)\(sig)"
        }
        if type == "app" {
            let deadline = Date().addingTimeInterval(appAliveTime)
            while rec.running && Date() < deadline && signal?.isAborted != true { try? await Task.sleep(nanoseconds: 50_000_000) }
            if signal?.isAborted == true { return Check(ok: false, url: nil, failedCheck: "Stopped.", output: rec.output) }
            if !rec.running {
                return Check(ok: false, url: nil, failedCheck: "It exited within \(RunProcesses.seconds(appAliveTime)) seconds (\(exitWords())); a desktop app keeps running while its window is open.", output: rec.output)
            }
            return Check(ok: true, url: nil, failedCheck: nil, output: rec.output)
        }
        let until = Date().addingTimeInterval(uiReadyTime)
        let port = port ?? 0
        while Date() < until {
            if signal?.isAborted == true { return Check(ok: false, url: nil, failedCheck: "Stopped.", output: rec.output) }
            if !rec.running { return Check(ok: false, url: nil, failedCheck: "It exited (\(exitWords())) before it answered on port \(port).", output: rec.output) }
            for host in ["127.0.0.1", "[::1]"] where await RunProcesses.respondsAt("http://\(host):\(port)/") {
                return Check(ok: true, url: "http://localhost:\(port)/", failedCheck: nil, output: rec.output)
            }
            await pause(0.5, signal)
        }
        return Check(ok: false, url: nil, failedCheck: "Nothing answered on port \(port) within \(RunProcesses.seconds(uiReadyTime)) seconds. It must listen on the port Engelbart gives it ({port} in its command), on localhost.", output: rec.output)
    }

    /// `ms / 1000` as JavaScript prints it (0.4, 10, 90).
    static func seconds(_ t: TimeInterval) -> String {
        t.rounded() == t ? String(Int(t)) : String(format: "%g", t)
    }

    /// sandbox/worker.cjs respondsAt: an answer under 500 that is not a dev server's "Invalid Host header"/"not allowed".
    static func respondsAt(_ href: String) async -> Bool {
        guard let url = URL(string: href) else { return false }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(from: url)
            guard let http = response as? HTTPURLResponse else { return false }
            var head = Data()
            for try await byte in bytes { head.append(byte); if head.count >= 1000 { break } }
            let text = String(decoding: head, as: UTF8.self)
            return http.statusCode < 500 && text.range(of: "Invalid Host header|not allowed", options: [.regularExpression, .caseInsensitive]) == nil
        } catch { return false }
    }

    /// A running app's window brought to the front (`focus`: the default, or a stand-in). → whether one was
    public func bringForward(_ key: String, focus: @escaping @Sendable ([Int32]) async -> Bool = RunProcesses.focusApp) async -> Bool {
        guard let rec = record(key), rec.running else { return false }
        return await focus(await RunProcesses.groupPids(rec.pid))
    }

    public func isRunning(_ key: String) -> Bool { record(key)?.running == true }

    /// A port nothing listens on now, on 127.0.0.1.
    public static func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    /// The processes of a process group now (its leader's pid), from ps.
    public static func groupPids(_ pgid: Int32) async -> [Int32] {
        let out = await Exec.run("/bin/ps", ["-A", "-o", "pid=,pgid="], environment: ProcessInfo.processInfo.environment, timeout: 5)
        guard out.code == 0 else { return [] }
        return out.stdout.components(separatedBy: "\n").compactMap { line in
            let f = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).compactMap { Int32($0) }
            return f.count == 2 && f[1] == pgid ? f[0] : nil
        }
    }

    /// A desktop app's window to the front: the first of `pids` that is an app with a Dock icon is activated (AppKit
    /// NSRunningApplication; it asks for no permission). → whether there was one
    @Sendable public static func focusApp(_ pids: [Int32]) async -> Bool {
        await MainActor.run {
            for pid in pids where pid > 0 {
                if let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular {
                    app.activate(options: [.activateAllWindows])
                    return true
                }
            }
            return false
        }
    }

    static func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 || errno == EPERM }

    /// A process group an Engelbart that closed without stopping it left behind (it crashed): stopped only while its
    /// leader is still the process that was started, a group leader whose folder is inside `within`. → whether it was
    public static func stopLeftover(_ pgid: Int32, within: String, wait: TimeInterval = stopWait) async -> Bool {
        guard pgid > 1, alive(pgid), let base = NodePath.realOrNil(within) else { return false }
        let out = await Exec.run("/usr/sbin/lsof", ["-a", "-p", String(pgid), "-d", "cwd", "-Fn"], environment: ProcessInfo.processInfo.environment, timeout: 5)
        guard out.code == 0, let line = out.stdout.components(separatedBy: "\n").first(where: { $0.hasPrefix("n") }) else { return false }
        let cwd = String(line.dropFirst())
        guard cwd == base || cwd.hasPrefix(base + "/") else { return false }
        guard await groupPids(pgid).contains(pgid) else { return false }
        if kill(-pgid, SIGTERM) != 0 { return false }
        let until = Date().addingTimeInterval(wait)
        while alive(pgid) && Date() < until { try? await Task.sleep(nanoseconds: 100_000_000) }
        kill(-pgid, SIGKILL)
        return true
    }
}

/// The last 32 KB of what a process printed.
final class OutputTail: @unchecked Sendable {
    private let lock = NSLock()
    private var text_ = ""
    func take(_ data: Data) {
        lock.lock()
        text_ += String(decoding: data, as: UTF8.self)
        if text_.utf8.count > RunProcesses.outputBytes { text_ = String(text_.suffix(RunProcesses.outputBytes)) }
        lock.unlock()
    }
    var text: String { lock.lock(); defer { lock.unlock() }; return text_ }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }
}
