import Foundation
import EngelbartCore

/// A launched worker (transport.cjs's `{ done, detach, stop }`).
public protocol SandboxWorkerHandle: AnyObject, Sendable {
    /// Settles when the worker has ended: rejects with what failed when an event handler failed.
    var done: Deferred<Void> { get }
    /// Lets go of a ready sandbox without stopping it (quit, restart). Throws when it is no longer connected.
    func detach() async throws
    /// Stops the run (and its sandbox), then waits for the end.
    func stop() async throws
}

/// `launch(request, env, onEvent)`: `onEvent` answers `sandbox_created` with the ack (a private repository's download
/// link and branch), nothing else.
public typealias SandboxWorkerLauncher = (_ request: JSONValue, _ env: [String: String], _ onEvent: @escaping (JSONValue) async throws -> JSONValue?) throws -> SandboxWorkerHandle

/// transport.cjs's `launchWorker`, in-process. Electron forked worker.cjs so the E2B SDK and its key stayed out of the main
/// process; here the runtime runs as a task, behind the same protocol: events in order and checked (`run_id`), the ack
/// after `sandbox_created`, `stop` and `detach`. The process mechanics (fork, EPIPE, a moved bundle) have no counterpart.
public final class InProcessWorker: SandboxWorkerHandle, @unchecked Sendable {
    public let done = Deferred<Void>()
    private let runtime: WorkerRuntime
    private let ack = Deferred<JSONValue?>()
    private let chain = SerialChain()
    private let failed = Locked<Error?>(nil)
    private let detached = Locked(false)
    private let finished = Locked(false)

    /// `e2b`: the E2B service the runtime calls; `configure`: test hooks on the runtime's other collaborators.
    public static func launcher(e2b: E2BService, configure: ((inout WorkerRuntimeOptions) -> Void)? = nil) -> SandboxWorkerLauncher {
        { request, env, onEvent in
            var options = WorkerRuntimeOptions()
            configure?(&options)
            return InProcessWorker(request: request, env: env, onEvent: onEvent, e2b: e2b, options: options)
        }
    }

    init(request: JSONValue, env: [String: String], onEvent: @escaping (JSONValue) async throws -> JSONValue?, e2b: E2BService, options: WorkerRuntimeOptions) {
        let runId = request["run_id"]?.string ?? ""
        let secrets = Locked([env["E2B_API_KEY"]].compactMap { $0 } + (request["environment"]?["values"]?.object ?? [:]).values.compactMap(\.string))
        var emitRef: ((JSONValue) -> Void)?
        let ack = self.ack
        runtime = WorkerRuntime(
            e2b: e2b, emit: { event in emitRef?(event) }, env: env,
            waitForAck: {
                let timeout = Deferred<JSONValue?>()
                DispatchQueue.global().asyncAfter(deadline: .now() + options.ackTimeout) { timeout.reject(SandboxError("Canvas did not acknowledge the sandbox")) }
                Task { timeout.settle(await ack.settled()) }
                return try await timeout.wait()
            },
            detectDocker: options.detectDocker, checkPreview: options.checkPreview, prepareClaude: options.prepareClaude,
            localSetup: options.localSetup, audit: options.audit, delay: options.delay)
        emitRef = { [weak self] event in
            guard let self, !self.detached.value else { return }
            var o = Redact.event(event, secrets.value).object ?? [:]
            o["run_id"] = .string(runId)
            let line = JSONValue.object(o)
            _ = chain.enqueue { [weak self] in
                guard let self, self.failed.value == nil else { return }
                do {
                    if line["run_id"]?.string != runId { throw SandboxError("Worker run id does not match") }
                    let reply = try await onEvent(line)
                    // A private repository's download link rides on the ack; nothing else does.
                    if line["event"]?.string == "sandbox_created" {
                        var source: [String: JSONValue] = [:]
                        if let url = reply?["archive_url"]?.string {
                            source["archive_url"] = .string(url)
                            if let branch = reply?["branch"]?.string { source["branch"] = .string(branch) }
                        }
                        self.ack.resolve(.object(source))
                    }
                } catch {
                    self.failed.with { $0 = error }
                    self.ack.resolve(nil)
                    Task { try? await self.runtime.stop() }
                }
            }
        }
        Task { [self] in
            let command = request["command"]?.string ?? ""
            if ["probe", "kill", "pause", "can_restart"].contains(command) {
                do {
                    let result: JSONValue
                    switch command {
                    case "probe": result = try await runtime.probe(request)
                    case "kill": result = try await runtime.kill(request)
                    case "pause": result = try await runtime.pause(request)
                    default: result = try await runtime.canRestart(request)
                    }
                    var o = result.object ?? [:]
                    o["event"] = "result"
                    runtime.emit(.object(o))
                } catch { runtime.emit(["event": "failed", "error": .string(message(of: error))]) }
            } else {
                await runtime.run(request)
            }
            await chain.idle()
            end()
        }
    }

    private func end() {
        guard finished.with({ let was = $0; $0 = true; return !was }) else { return }
        if let error = failed.value { done.reject(error) } else { done.resolve(()) }
    }

    public func detach() async throws {
        if finished.value || detached.value { throw SandboxError("Worker is no longer connected") }
        detached.with { $0 = true }
        await runtime.detachNow()
        await chain.idle()
        end()
    }

    public func stop() async throws {
        if !finished.value {
            ack.resolve(nil)
            Task { try? await runtime.stop() }
        }
        let timeout = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.finished.with({ let was = $0; $0 = true; return !was }) { self.done.reject(SandboxError("Sandbox worker did not stop in time")) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: timeout)
        defer { timeout.cancel() }
        try await done.wait()
    }
}

/// The worker runtime's collaborators, for tests (the real ones by default).
public struct WorkerRuntimeOptions: @unchecked Sendable {
    public var ackTimeout: Double = 30
    public var detectDocker: (GithubRepo) async -> Bool = { await SandboxWorker.wantsDocker($0) }
    public var checkPreview: (String) async -> Bool = { await SandboxWorker.previewResponds($0) }
    public var prepareClaude: ([String: String]) async throws -> LocalClaudeAuth = { try await LocalClaude.prepare($0) }
    public var localSetup: (LocalSetupRequest) async throws -> LocalSetup.Ready = { r in
        try await LocalSetup.run(sandbox: r.sandbox, auth: r.auth, environment: r.environment, model: r.model, signal: r.signal,
                                 onEvent: r.onEvent, checkPreview: r.checkPreview, onReady: r.onReady)
    }
    public var audit: (E2BSandbox, AbortSignal, @escaping (JSONValue) -> Void) async throws -> Void = { sandbox, signal, onEvent in
        try await NpmAudit.run(sandbox: sandbox, signal: signal, onEvent: onEvent)
    }
    public var delay: (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }
    public init() {}
}

extension WorkerRuntime {
    /// The worker process exiting on `detach`: nothing more is said or done, the sandbox and its app are left as they are,
    /// and the streams this worker held are let go.
    func detachNow() async {
        detach()
        for handle in tracked.value { await handle.disconnect() }
    }
}
