import Foundation
import EngelbartCore

// The part of E2B's JS SDK (e2b 2.49.1, node_modules/e2b) that Engelbart uses, as Swift protocols. `E2BHTTPClient` is
// the real one (REST + envd Connect-RPC over URLSession); tests use in-process fakes of these protocols, or the real
// client over a fake URLProtocol. Nothing here creates a sandbox in a test.

public struct E2BSandboxInfo: Equatable, Sendable {
    public var sandboxId: String
    /// `running` | `paused` | …
    public var state: String
    /// When it times out (ms since 1970).
    public var endAt: Double
    public var metadata: [String: String]
    public init(sandboxId: String, state: String, endAt: Double = 0, metadata: [String: String] = [:]) {
        self.sandboxId = sandboxId; self.state = state; self.endAt = endAt; self.metadata = metadata
    }
}

/// `commands.run` options. `timeoutMs`: how long the command may live (0 = forever; nil = the SDK's 60 s).
public struct CommandOptions: @unchecked Sendable {
    public var timeoutMs: Int?
    public var requestTimeoutMs: Int?
    public var envs: [String: String]
    public var user: String?
    public var cwd: String?
    public var onStdout: ((String) -> Void)?
    public var onStderr: ((String) -> Void)?
    public var signal: AbortSignal?

    public init(timeoutMs: Int? = nil, requestTimeoutMs: Int? = nil, envs: [String: String] = [:], user: String? = nil, cwd: String? = nil,
                onStdout: ((String) -> Void)? = nil, onStderr: ((String) -> Void)? = nil, signal: AbortSignal? = nil) {
        self.timeoutMs = timeoutMs; self.requestTimeoutMs = requestTimeoutMs; self.envs = envs; self.user = user; self.cwd = cwd
        self.onStdout = onStdout; self.onStderr = onStderr; self.signal = signal
    }
}

public struct CommandResult: Equatable, Sendable {
    public var exitCode: Int
    public var stdout: String
    public var stderr: String
    public var error: String?
    public init(exitCode: Int, stdout: String = "", stderr: String = "", error: String? = nil) {
        self.exitCode = exitCode; self.stdout = stdout; self.stderr = stderr; self.error = error
    }
}

/// A running command or pty (`CommandHandle`). `wait()` throws a `SandboxError` with `exitCode` for a non-zero exit, and
/// one without (`TimeoutError`) when the stream to it broke (its sandbox went to sleep).
public protocol E2BCommandHandle: AnyObject, Sendable {
    var pid: Int { get }
    func wait() async throws -> CommandResult
    /// Stops receiving its output; the command goes on.
    func disconnect() async
    func kill() async throws -> Bool
}

/// A connected sandbox (`Sandbox` instance).
public protocol E2BSandbox: AnyObject, Sendable {
    var sandboxId: String { get }
    func getHost(_ port: Int) -> String
    func setTimeout(_ timeoutMs: Int, requestTimeoutMs: Int?) async throws
    func kill(requestTimeoutMs: Int?) async throws

    /// A foreground command (`commands.run`): its result; throws with `exitCode` when it exits non-zero.
    func run(_ command: String, _ options: CommandOptions) async throws -> CommandResult
    /// A background command (`commands.run(…, { background: true })`).
    func start(_ command: String, _ options: CommandOptions) async throws -> E2BCommandHandle

    func writeFile(_ path: String, _ text: String) async throws
    /// At most `maxBytes` of a file, reading no further than that (`files.read(…, { format: 'stream' })` cancelled).
    func readFile(_ path: String, maxBytes: Int, signal: AbortSignal?, requestTimeoutMs: Int?) async throws -> Data

    func ptyCreate(cols: Int, rows: Int, cwd: String?, envs: [String: String], timeoutMs: Int, requestTimeoutMs: Int?,
                   onData: @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle
    func ptyConnect(pid: Int, timeoutMs: Int, requestTimeoutMs: Int?, onData: @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle
    func ptySendInput(pid: Int, _ data: Data, requestTimeoutMs: Int?) async throws
    func ptyResize(pid: Int, cols: Int, rows: Int, requestTimeoutMs: Int?) async throws
    func ptyKill(pid: Int, requestTimeoutMs: Int?) async throws -> Bool
}

/// What a new sandbox is made with (`Sandbox.create(template, opts)`).
public struct E2BCreateOptions: Equatable, Sendable {
    public var timeoutMs: Int
    public var requestTimeoutMs: Int?
    /// `lifecycle: { onTimeout: 'pause', autoResume: true }`.
    public var pauseOnTimeout: Bool
    public var autoResume: Bool
    public var metadata: [String: String]
    public init(timeoutMs: Int, requestTimeoutMs: Int? = nil, pauseOnTimeout: Bool = false, autoResume: Bool = false, metadata: [String: String] = [:]) {
        self.timeoutMs = timeoutMs; self.requestTimeoutMs = requestTimeoutMs; self.pauseOnTimeout = pauseOnTimeout; self.autoResume = autoResume; self.metadata = metadata
    }
}

/// The static `Sandbox` API, with the key per call (`{ apiKey }`).
public protocol E2BService: AnyObject, Sendable {
    func create(template: String, _ options: E2BCreateOptions, apiKey: String) async throws -> E2BSandbox
    /// `Sandbox.connect`: resumes a paused sandbox; `timeoutMs` nil = the SDK's 5 minutes.
    func connect(_ sandboxId: String, apiKey: String, timeoutMs: Int?, requestTimeoutMs: Int?) async throws -> E2BSandbox
    /// false when it was already gone.
    @discardableResult func kill(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> Bool
    func getInfo(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> E2BSandboxInfo
    /// true when it went to sleep now, false when it already slept.
    func pause(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> Bool
    func setTimeout(_ sandboxId: String, timeoutMs: Int, apiKey: String, requestTimeoutMs: Int?) async throws
    /// The first page of `Sandbox.list({ query: { metadata, state } })`.
    func list(metadata: [String: String], states: [String], apiKey: String, requestTimeoutMs: Int?) async throws -> [E2BSandboxInfo]
}

extension E2BSandbox {
    func run(_ command: String, timeoutMs: Int? = nil, requestTimeoutMs: Int? = nil, envs: [String: String] = [:], user: String? = nil,
             signal: AbortSignal? = nil, onStdout: ((String) -> Void)? = nil, onStderr: ((String) -> Void)? = nil) async throws -> CommandResult {
        try await run(command, CommandOptions(timeoutMs: timeoutMs, requestTimeoutMs: requestTimeoutMs, envs: envs, user: user,
                                              onStdout: onStdout, onStderr: onStderr, signal: signal))
    }
}
