import Foundation
import EngelbartCore

/// A data root's library, as the manager sees it (Electron's `ctx`: `{ dataRoot, root, libraryDb }`).
public struct SandboxContext: @unchecked Sendable {
    public var dataRoot: String
    public var root: String
    public var db: SandboxDatabase
    public init(dataRoot: String, root: String? = nil, db: SandboxDatabase) { self.dataRoot = dataRoot; self.root = root ?? dataRoot; self.db = db }
}

/// What reading a repository with the GitHub sign-in says (github/repo-access.cjs, owned by the Integrations package).
public struct RepoAccessInfo: Equatable, Sendable {
    public var isPrivate: Bool
    public var docker: Bool?
    public var branch: String?
    public init(isPrivate: Bool, docker: Bool? = nil, branch: String? = nil) { self.isPrivate = isPrivate; self.docker = docker; self.branch = branch }
}

/// github/repo-access.cjs: whether a repository is private and wants Docker (before the sandbox is made), and for a
/// private one a download link for its code (made when the sandbox is ready to use it). Throws, saying what to do, when
/// the GitHub App cannot see it. The sign-in never reaches the sandbox.
public protocol SandboxRepoAccess: AnyObject, Sendable {
    func describe(_ repo: GithubRepo) async throws -> RepoAccessInfo
    func archive(_ repo: GithubRepo) async throws -> String
}

/// src/main/sandbox/manager.cjs: every repository's runs, their workers, the sweep, sleep and wake.
public final class SandboxManager: @unchecked Sendable {
    /// A ready preview sleeps after 10 minutes without a ping (touch). Pings closer together than 30 s change nothing.
    public static let idleMs = 10 * 60_000
    public static let touchEvery: Double = 30_000
    public static let asleepMessage = "Paused after 10 minutes unused"
    public static let terminalReady = "Terminal ready"
    public static let quitAsleep = "Paused when Engelbart quit"
    public static let expiredMessage = "Stopped after 7 days unopened"
    static let githubLogin = #"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"#

    public struct Options {
        public var notify: (JSONValue) -> Void
        public var launch: SandboxWorkerLauncher
        public var readEnv: (String) -> [String: String] = { root in (try? SandboxConfig.read(root: root)) ?? [:] }
        public var secure: SecureStorage?
        /// The E2B key for whoever is signed in to GitHub (E2BKey.get), and the only one a worker gets.
        public var e2bKey: () async throws -> String? = { nil }
        public var githubLogin: () -> String = { "" }
        public var repoAccess: SandboxRepoAccess?
        /// Throws, saying what to do, while Claude Code is not installed or not signed in to a subscription.
        public var claudeReady: () async throws -> Void = {}
        /// E2B, for touch's calls from here (every other E2B call is a worker's, or a terminal's).
        public var e2b: E2BService?
        public var terminals: SandboxTerminalControl?
        public var now: Clock = systemClock
        /// The sweep's period (seconds); nil = no timer (tests call `poll()`).
        public var pollEvery: Double? = 15

        public init(notify: @escaping (JSONValue) -> Void, launch: @escaping SandboxWorkerLauncher) { self.notify = notify; self.launch = launch }
    }

    final class Held: @unchecked Sendable {
        let ctx: SandboxContext
        let libraryId: String
        var worker: SandboxWorkerHandle?
        var detaching = false
        var asleep = false
        var finished: Task<Void, Never>?
        init(ctx: SandboxContext, libraryId: String) { self.ctx = ctx; self.libraryId = libraryId }
    }

    let o: Options
    private let locks = KeyedQueue()
    private let workers = Locked<[String: Held]>([:])
    private let contexts = Locked<[String: SandboxContext]>([:])
    private let messages = Locked<[String: String]>([:])
    private let prepared = Locked<Set<String>>([])
    private let touched = Locked<[String: Double]>([:])
    /// Each ready run's sandbox as last seen, `asleep` or `running` (the bell's status): from every probe, the Stage's ping
    /// and its going to sleep. Waking is no event: the next probe or ping says so.
    private let awake = Locked<[String: String]>([:])
    private let flags = Locked((closing: false, polling: false))
    private let pollDone = Locked<Task<Void, Never>?>(nil)
    private var timer: DispatchSourceTimer?

    public init(_ options: Options) {
        o = options
        if let every = options.pollEvery {
            let t = DispatchSource.makeTimerSource(queue: .global())
            t.schedule(deadline: .now() + every, repeating: every)
            t.setEventHandler { [weak self] in guard let self else { return }; Task { await self.poll() } }
            t.resume()
            timer = t
        }
    }

    deinit { timer?.cancel() }

    func store(_ ctx: SandboxContext) -> RunStore { RunStore(ctx.db) }
    func key(_ ctx: SandboxContext, _ libraryId: String) -> String { "\(ctx.dataRoot):\(libraryId)" }
    var closing: Bool { flags.value.closing }
    func checkOpen() throws { if closing { throw SandboxError("Sandbox workers are shutting down") } }

    /// A worker's environment: the rest of readEnv, and the signed-in key. Throws when there is none to give.
    func environmentFor(_ ctx: SandboxContext) async throws -> [String: String] {
        var env = o.readEnv(ctx.root)
        env["E2B_API_KEY"] = nil
        let key: String?
        do { key = try await o.e2bKey() } catch { throw SandboxError("Could not get the E2B key for your GitHub sign-in: \(message(of: error))") }
        guard let key, !key.isEmpty else { throw SandboxError(SandboxWorker.missingKey) }
        env["E2B_API_KEY"] = key
        return env
    }

    /// A run whose sandbox is stopped, replaced or forgotten: its terminals close with it. Never fails the caller.
    func closeTerminals(_ libraryId: String) async { await o.terminals?.close(libraryId) }

    /// A terminal has no app to watch and no preview to check: its sandbox is healthy unless it is gone.
    static func terminalOnly(_ run: SandboxRun) -> Bool { run["status"]?.string == "ready" && run["kind"]?.string == "terminal" }
    static func keeps(_ run: SandboxRun, _ state: String) -> Bool { ["ready", "paused"].contains(state) || (terminalOnly(run) && state != "gone") }

    func publish(_ ctx: SandboxContext, _ run: SandboxRun?, _ extra: [String: JSONValue] = [:]) {
        guard let run, let id = run["id"]?.string else { return }
        if let m = extra["message"]?.string, !m.isEmpty { messages.with { $0[id] = m } }
        var event: [String: JSONValue] = ["dataRoot": .string(ctx.dataRoot), "run": run, "message": .string(messages.value[id] ?? ""),
                                          "sandbox": awake.value[id].map { .string($0) } ?? .null]
        for (k, v) in extra { event[k] = v }
        if extra["message"] != nil { event["message"] = .string(messages.value[id] ?? extra["message"]?.string ?? "") }
        o.notify(.object(event))
    }

    /// What a probe (or a ping) found of a run's sandbox, told when it changes.
    func seen(_ ctx: SandboxContext, _ run: SandboxRun?, _ state: String?) {
        guard let run, let id = run["id"]?.string, let value = ["paused": "asleep", "ready": "running", "unreachable": "running"][state ?? ""] else { return }
        if awake.value[id] == value { return }
        awake.with { $0[id] = value }
        publish(ctx, run)
    }

    static func request(_ command: String, _ run: SandboxRun) -> JSONValue {
        var r: [String: JSONValue] = ["command": .string(command), "run_id": run["id"] ?? .null, "sandbox_id": run["sandbox_id"] ?? .null,
                                      "preview_url": run["preview_url"] ?? .null, "port": run["port"] ?? .null]
        if let kind = run["kind"], !kind.isNull { r["kind"] = kind }
        return .object(r)
    }

    func control(_ ctx: SandboxContext, _ command: String, _ run: SandboxRun) async throws -> JSONValue {
        let result = Locked<JSONValue?>(nil)
        let worker = try o.launch(Self.request(command, run), try await environmentFor(ctx)) { event in
            if event["event"]?.string == "failed" { throw SandboxError(event["error"]?.string ?? "Sandbox check failed") }
            if event["event"]?.string == "result" { result.with { $0 = event } }
            return nil
        }
        try await worker.done.wait()
        guard let value = result.value else { throw SandboxError("Sandbox worker returned no result") }
        return value
    }

    /// `extra`: what is published with it; its `message` is also recorded, with `data` when there is some.
    @discardableResult
    func update(_ ctx: SandboxContext, _ run: SandboxRun, _ fields: [(String, JSONValue)], _ extra: [String: JSONValue] = [:]) throws -> SandboxRun {
        var rest = extra
        let data = rest.removeValue(forKey: "data")
        var next = try store(ctx).update(run["id"]!.string!, fields)
        if let n = next, let m = rest["message"]?.string { next = try store(ctx).record(n["id"]!.string!, m, data.map { ["data": $0] } ?? [:]) }
        if let next { publish(ctx, next, rest) }
        return next ?? run
    }

    @discardableResult
    func end(_ ctx: SandboxContext, _ run: SandboxRun, _ status: String, _ error: String? = nil) async throws -> SandboxRun {
        await closeTerminals(run["library_id"]?.string ?? "")
        return try update(ctx, run, [("status", .string(status)), ("error", error.map { .string($0) } ?? .null), ("finished_at", .string(Time.iso()))],
                          ["message": .string(error ?? "Sandbox stopped")])
    }

    /// `result`: the probe pollOnce already made, if it did.
    @discardableResult
    func reconcile(_ ctx: SandboxContext, _ runIn: SandboxRun, _ given: JSONValue? = nil) async throws -> SandboxRun {
        var run = runIn
        if workers.value[run["id"]!.string!] != nil { return run }
        let result: JSONValue
        if let given { result = given } else { result = try await control(ctx, "probe", run) }
        let state = result["state"]?.string ?? ""
        if (run["sandbox_id"]?.string ?? "").isEmpty, let id = result["sandbox_id"]?.string, !id.isEmpty { run = try update(ctx, run, [("sandbox_id", .string(id))]) }
        // Asleep is as good as live: the next request to its preview (or its terminal) wakes it.
        if run["status"]?.string == "ready" && Self.keeps(run, state) { return run }
        if state == "unreachable" { throw SandboxError("The preview is temporarily unreachable. Retry the check or stop the run before starting another.") }
        if state != "gone" { _ = try await control(ctx, "kill", run) }
        let starting = run["status"]?.string == "starting"
        return try await end(ctx, run, starting ? "failed" : "stopped", starting ? "Setup was interrupted. Retry to start a new run." : nil)
    }

    func receive(_ ctx: SandboxContext, _ runId: String, _ event: JSONValue) async throws {
        let s = store(ctx)
        guard let run = try s.get(runId), ["starting", "ready"].contains(run["status"]?.string ?? "") else { return }
        switch event["event"]?.string {
        case "progress":
            let text = (event["message"]?.string ?? "").tail(2000)
            var details: [String: JSONValue] = [:]
            if let kind = event["kind"]?.string, ["status", "command", "stdout", "stderr", "error"].contains(kind) { details["kind"] = .string(kind) }
            if let data = event["data"], data.object != nil { details["data"] = data }
            // Claude said how the repository is used: kept on the run, for its build details, as it is said.
            if details["data"]?["phase"]?.string == "kind", let kind = details["data"]?["kind"]?.string, sandboxKinds.contains(kind), run["status"]?.string == "starting" {
                let reason = (details["data"]?["reason"]?.string ?? "").head(500)
                try s.update(runId, [("kind", .string(kind)), ("kind_reason", reason.isEmpty ? .null : .string(reason))])
            }
            publish(ctx, try s.record(runId, text, details), ["message": .string(text)])
        case "sandbox_created":
            guard let id = event["sandbox_id"]?.string, id.matches(#"^[\w-]{1,200}$"#) else { throw SandboxError("Invalid sandbox identifier") }
            try update(ctx, run, [("sandbox_id", .string(id))], ["message": "Sandbox created"])
        case "ready":
            // { kind, preview_url?, port?, terminal? }. A restart's says nothing of its kind: the run keeps its own.
            let kind = event["kind"].map { $0.string ?? "" } ?? (run["kind"]?.string ?? "interface")
            if (run["sandbox_id"]?.string ?? "").isEmpty || !sandboxKinds.contains(kind) { throw SandboxError("Invalid ready event") }
            let preview = kind != "terminal"
            if preview { guard let port = event["port"]?.integer, (1...65535).contains(port) else { throw SandboxError("Invalid ready event") } }
            var terminal: JSONValue = .null
            if kind != "interface" {
                terminal = event["terminal"] == nil && event["kind"] == nil ? (run["terminal"] ?? .null) : (Self.readyTerminal(event["terminal"]) ?? .null)
                if terminal.isNull { throw SandboxError("Invalid ready event") }
            }
            // Completion is an inbox notification, never a navigation request. Duplicates are ignored so the persisted
            // completion time and read state stay stable.
            if run["status"]?.string == "ready" { return }
            awake.with { $0[runId] = "running" }
            let previewURL: JSONValue = preview ? .string(try SandboxWorker.safePreview(event["preview_url"]?.string)) : .null
            try update(ctx, run, [("status", "ready"), ("kind", .string(kind)), ("terminal", terminal), ("preview_url", previewURL),
                                  ("port", preview ? event["port"]! : .null)],
                       preview ? ["message": "Preview ready", "notification": "preview-ready"]
                               : ["message": .string(Self.terminalReady), "data": ["phase": "ready", "kind": .string(kind)], "notification": "preview-ready"])
        case "paused":
            // Asleep, not stopped: the run stays ready, and its worker leaves.
            if run["status"]?.string != "ready" { return }
            awake.with { $0[runId] = "asleep" }
            publish(ctx, try s.record(runId, Self.asleepMessage, ["data": ["lifecycle": "paused"]]), ["message": .string(Self.asleepMessage)])
        case "failed", "stopped":
            let failed = event["event"]?.string == "failed"
            try await end(ctx, run, failed ? "failed" : "stopped", failed ? (event["error"]?.string ?? "Setup failed").head(4000) : nil)
        default: throw SandboxError("Unknown sandbox event")
        }
    }

    /// A ready event's terminal (`{ cwd, hint }`), checked again: a path inside the repository and one line of plain text.
    static func readyTerminal(_ value: JSONValue?) -> JSONValue? {
        guard let cwd = value?["cwd"]?.string, let hint = value?["hint"]?.string else { return nil }
        if hint.utf16.count > SandboxToolsSpec.hintLimit || hasControlCharacters(hint) { return nil }
        guard (try? SandboxToolsSpec.repoPath(cwd)) != nil else { return nil }
        return ["cwd": .string(cwd), "hint": .string(hint)]
    }

    /// `env` was resolved by the caller before anything was recorded or interrupted.
    @discardableResult
    func attach(_ ctx: SandboxContext, _ run: SandboxRun, _ repo: GithubRepo, _ environment: SavedEnvironment, restart: Bool,
                _ env: [String: String], _ access: RepoAccessInfo? = nil) async throws -> SandboxRun {
        let runId = run["id"]!.string!
        let held = Held(ctx: ctx, libraryId: run["library_id"]!.string!)
        let login = o.githubLogin()
        var request: [String: JSONValue] = ["command": .string(restart ? "restart" : "start"), "run_id": .string(runId), "github_url": .string(repo.url),
                                            "sandbox_id": run["sandbox_id"] ?? .null, "port": run["port"] ?? .null,
                                            "environment": ["values": .object(environment.values.mapValues { .string($0) }), "removed": .array(environment.removed.map { .string($0) })]]
        if login.matches(Self.githubLogin) { request["github_login"] = .string(login) }
        if let docker = access?.docker { request["docker"] = .bool(docker) }
        let secrets = Array(environment.values.values)
        // The ack after sandbox_created is the worker's go-ahead to fetch the code: a private repository's download link
        // goes with it, made now because it lasts minutes.
        let onEvent: (JSONValue) async throws -> JSONValue? = { [self] event in
            if held.detaching { return nil }
            if event["event"]?.string == "paused" { held.asleep = true } // its exit, next, is not a failure
            try await receive(ctx, runId, Redact.event(event, secrets))
            guard event["event"]?.string == "sandbox_created", let access, access.isPrivate, !held.detaching, let repoAccess = o.repoAccess else { return nil }
            var ack: [String: JSONValue] = ["archive_url": .string(try await repoAccess.archive(repo))]
            if let branch = access.branch { ack["branch"] = .string(branch) }
            return .object(ack)
        }
        let worker: SandboxWorkerHandle
        do { worker = try o.launch(.object(request), env, onEvent) }
        catch { return try await end(ctx, run, "failed", message(of: error)) }
        held.worker = worker
        workers.with { $0[runId] = held }
        let finish: (Error?) async -> Void = { [self] error in
            if held.detaching || held.asleep { return }
            let current = try? store(ctx).get(runId)
            // A ready terminal's worker leaves once it is ready: its sandbox stays, asleep when unused.
            if let current, Self.terminalOnly(current), error == nil { return }
            guard let current, ["starting", "ready"].contains(current["status"]?.string ?? "") else { return }
            var cleanup = ""
            if !(current["sandbox_id"]?.string ?? "").isEmpty && !restart {
                do { _ = try await control(ctx, "kill", current) } catch { cleanup = " Sandbox cleanup failed: \(message(of: error))" }
            }
            let text = Redact.string("\(error.map { message(of: $0) } ?? "Worker exited before reporting completion")\(cleanup)", secrets)
            do { try await end(ctx, current, "failed", text) }
            catch { publish(ctx, run, ["message": .string("Could not save worker result: \(message(of: error))")]) }
        }
        held.finished = Task { [self] in
            switch await worker.done.settled() {
            case .success: await finish(nil)
            case .failure(let error): await finish(error)
            }
            workers.with { if $0[runId] === held { $0[runId] = nil } }
        }
        return run
    }

    /// `start(ctx, libraryId, { automatic, waitForClaude })`. `waitForClaude`: a start that comes from saving a repository
    /// or linking it to a workspace: until Claude Code is signed in it waits as automatic preparation does, instead of
    /// failing the save with the sign-in message (onboarding saves repositories before its sign-in, 2026-10-02).
    @discardableResult
    public func start(_ ctx: SandboxContext, _ libraryId: String, automatic: Bool = false, waitForClaude: Bool = false) async throws -> SandboxRun? {
        contexts.with { $0[ctx.dataRoot] = ctx }
        let k = key(ctx, libraryId)
        return try await locks.run(k) { [self] in
            try checkOpen()
            guard let repo = GithubRepo.parse(try ctx.db.libraryRow(libraryId)?["url"]?.string) else { return nil }
            let s = store(ctx)
            // Prepare once per app session. Refreshes must not undo Stop or loop on failures.
            if automatic && prepared.value.contains(k) { return try s.latest(for: libraryId) }
            // A preview the sweep ended is built again when it is opened, not by a new session's preparation; nor is a
            // desktop app's failed build: it would only fail again, in a new sandbox, at every launch.
            if automatic, let latest = try s.latest(for: libraryId),
               SandboxSleep.expiredRun(latest) || (latest["status"]?.string == "failed" && (latest["error"]?.string ?? "").hasPrefix(LocalSetup.desktopUnsupported)) {
                return latest
            }
            // The key comes first: without one nothing is recorded. Automatic preparation waits quietly and runs once
            // there is one; an explicit start says why it cannot.
            let env: [String: String]
            do { env = try await environmentFor(ctx) } catch {
                if automatic { return try s.latest(for: libraryId) }
                throw error
            }
            prepared.with { _ = $0.insert(k) }
            if var run = try s.active(libraryId) {
                if run["status"]?.string == "ready" {
                    // A local worker proves setup is active. Ready runs still need a live preview check.
                    let state = try await control(ctx, "probe", run)["state"]?.string ?? ""
                    seen(ctx, run, state)
                    if state == "paused" {
                        publish(ctx, run, ["message": .string("Paused; opening the \(run["kind"]?.string == "terminal" ? "terminal" : "preview") wakes it")])
                        return run
                    }
                    if Self.keeps(run, state) { publish(ctx, run, ["message": .string(Self.terminalOnly(run) ? Self.terminalReady : "Preview ready")]); return run }
                    if state == "unreachable" { throw SandboxError("The preview is temporarily unreachable. Stop the run or retry the check.") }
                    _ = try await stopRun(ctx, run["id"]!.string!)
                } else if workers.value[run["id"]!.string!] != nil { publish(ctx, run); return run }
                else { run = try await reconcile(ctx, run) }
            }
            // Setup is the local Claude subscription's, so it is signed in first. Automatic preparation (and a save's) waits
            // quietly and runs once it is (the renderer prepares again when Claude Code's sign-in changes); Start says why.
            do { try await o.claudeReady() } catch {
                if !automatic && !waitForClaude { throw error }
                prepared.with { _ = $0.remove(k) }
                return try s.latest(for: libraryId)
            }
            // Cleanup may have failed on a previous attempt; retain and use that handle.
            let previous = try s.latest(for: libraryId)
            let environment = try EnvironmentStore(db: ctx.db, secure: o.secure).read(libraryId)
            await closeTerminals(libraryId)
            if let previous, !(previous["sandbox_id"]?.string ?? "").isEmpty, ["failed", "stopped"].contains(previous["status"]?.string ?? "") {
                _ = try await control(ctx, "kill", previous)
            }
            guard var run = try s.create(libraryId) else { return try s.active(libraryId) }
            run = try s.update(run["id"]!.string!, [("env_revision", environment.revision.map { .string($0) } ?? .null)]) ?? run
            run = try s.record(run["id"]!.string!, "Starting repository setup") ?? run
            publish(ctx, run, ["message": "Starting repository setup"])
            var access: RepoAccessInfo?
            if let repoAccess = o.repoAccess {
                do { access = try await repoAccess.describe(repo) } catch { return try await end(ctx, run, "failed", message(of: error)) }
            }
            return try await attach(ctx, run, repo, environment, restart: false, env, access)
        }
    }

    func envStore(_ ctx: SandboxContext) -> EnvironmentStore { EnvironmentStore(db: ctx.db, secure: o.secure) }

    /// The names (never values) of a repository's saved environment, and its last scan.
    public func environment(_ ctx: SandboxContext, _ libraryId: String) throws -> EnvironmentDescription { try envStore(ctx).describe(libraryId) }

    public func saveEnvironment(_ ctx: SandboxContext, _ libraryId: String, _ changes: [EnvironmentChange], revision: String?) async throws -> EnvironmentDescription {
        try await locks.run(key(ctx, libraryId)) { [self] in
            try checkOpen()
            return try envStore(ctx).save(libraryId, changes, expectedRevision: revision)
        }
    }

    /// Restarts the app with the saved environment, in the same sandbox.
    @discardableResult
    public func restart(_ ctx: SandboxContext, _ libraryId: String) async throws -> SandboxRun {
        contexts.with { $0[ctx.dataRoot] = ctx }
        return try await locks.run(key(ctx, libraryId)) { [self] in
            try checkOpen()
            let repo = GithubRepo.parse(try ctx.db.libraryRow(libraryId)?["url"]?.string)
            let values = try envStore(ctx).read(libraryId)
            let s = store(ctx)
            guard var run = try s.latest(for: libraryId), !(run["sandbox_id"]?.string ?? "").isEmpty, ["ready", "failed"].contains(run["status"]?.string ?? "") else {
                throw SandboxError("Wait for a ready preview before restarting the application. Saved values will be used by the next build.")
            }
            // A terminal has no app to restart: its shell is. The open one closes; the next one has the saved values.
            if Self.terminalOnly(run) {
                await closeTerminals(libraryId)
                return try update(ctx, run, [("env_revision", values.revision.map { .string($0) } ?? .null)], ["message": "Saved environment applies to the next terminal opened"])
            }
            // The key, then confirmation that the same machine can relaunch, before interrupting anything.
            let env = try await environmentFor(ctx)
            _ = try await control(ctx, "can_restart", run)
            let runId = run["id"]!.string!
            if let held = workers.value[runId] {
                held.detaching = true
                do { try await held.worker?.detach(); await held.finished?.value }
                catch { held.detaching = false; throw SandboxError("Could not release the current worker. The sandbox has not been rebuilt.") }
            }
            run = try s.reopen(runId, revision: values.revision) ?? run
            run = try s.record(runId, "Restarting app with saved environment (same sandbox)", ["data": ["phase": "setup", "status": "reusing", "lifecycle": "restart"]]) ?? run
            publish(ctx, run, ["message": "Restarting app with saved environment (same sandbox)"])
            guard let repo else { throw SandboxError("Choose a saved GitHub repository.") }
            return try await attach(ctx, run, repo, values, restart: true, env)
        }
    }

    @discardableResult
    func stopRun(_ ctx: SandboxContext, _ id: String) async throws -> SandboxRun? {
        guard let run = try store(ctx).get(id) else { throw SandboxError("Unknown sandbox run") }
        await closeTerminals(run["library_id"]?.string ?? "")
        if let held = workers.value[id] {
            try? await held.worker?.stop()
            await held.finished?.value
        }
        guard let latest = try store(ctx).get(id) else { return nil }
        // Retry cleanup even for a failed run whose sandbox may still exist.
        if !(latest["sandbox_id"]?.string ?? "").isEmpty { _ = try await control(ctx, "kill", latest) }
        if ["starting", "ready"].contains(latest["status"]?.string ?? "") { return try await end(ctx, latest, "stopped") }
        if latest["status"]?.string == "failed" {
            let stopped = try store(ctx).stoppedAfterFailure(id)
            publish(ctx, stopped, ["message": "Sandbox stopped"])
            return stopped
        }
        return latest
    }

    /// Stop (a run id).
    @discardableResult
    public func stop(_ ctx: SandboxContext, _ id: String) async throws -> SandboxRun? {
        guard let run = try store(ctx).get(id) else { throw SandboxError("Unknown sandbox run") }
        return try await locks.run(key(ctx, run["library_id"]!.string!)) { [self] in try await stopRun(ctx, id) }
    }

    /// Every repository's newest run, published, as `[{ run, message, sandbox }]`.
    public func list(_ ctx: SandboxContext) throws -> [JSONValue] {
        contexts.with { $0[ctx.dataRoot] = ctx }
        let runs = try store(ctx).latest()
        for run in runs { publish(ctx, run) }
        return runs.map { run in
            let id = run["id"]!.string!
            return ["run": run, "message": .string(messages.value[id] ?? run["build_log"]?.array?.last?["message"]?.string ?? ""),
                    "sandbox": awake.value[id].map { .string($0) } ?? .null]
        }
    }

    /// The preview or sandbox terminal in front of a focused window (about once a minute): its sandbox's sleep goes back to
    /// 10 minutes away, by one call from here rather than a worker, and the run is marked opened for the sweep. Pings closer
    /// than 30 s apart change nothing. Asleep or gone, E2B says it was not found; a ping never wakes it. This is the only
    /// thing that keeps a sandbox awake (2026-10-09): using Engelbart elsewhere wakes none.
    public func touch(_ ctx: SandboxContext, _ libraryId: String) async throws {
        guard let run = try store(ctx).active(libraryId), run["status"]?.string == "ready", let sandboxId = run["sandbox_id"]?.string, !sandboxId.isEmpty else { return }
        let id = run["id"]!.string!
        let at = o.now()
        if at - (touched.value[id] ?? 0) < Self.touchEvery { return }
        touched.with { $0[id] = at }
        try store(ctx).update(id, [("last_opened_at", .string(Time.iso(Date(timeIntervalSince1970: at / 1000))))])
        guard let env = try? await environmentFor(ctx), let e2b = o.e2b else { return } // signed out: it sleeps at its time
        do { try await e2b.setTimeout(sandboxId, timeoutMs: Self.idleMs, apiKey: env["E2B_API_KEY"]!, requestTimeoutMs: 10_000) }
        catch let error as SandboxError where error.isNotFound { return }
        seen(ctx, run, "ready") // its sleep put off: it is running
    }

    func unopened(_ run: SandboxRun) -> Bool {
        let opened = (run["last_opened_at"]?.string).flatMap(Time.parse) ?? (run["created_at"]?.string).flatMap(Time.parse) ?? Date()
        return o.now() - Time.ms(opened) > SandboxSleep.expireMs
    }

    /// The sweep: a ready preview asleep and not opened for 7 days ends, marked so that opening it builds it again.
    func expire(_ ctx: SandboxContext, _ run: SandboxRun) async throws {
        await closeTerminals(run["library_id"]?.string ?? "")
        _ = try await control(ctx, "kill", run)
        guard let stopped = try store(ctx).update(run["id"]!.string!, [("status", "stopped"), ("finished_at", .string(Time.iso(Date(timeIntervalSince1970: o.now() / 1000))))]) else { return }
        publish(ctx, try store(ctx).record(stopped["id"]!.string!, Self.expiredMessage, ["data": ["lifecycle": .string(SandboxSleep.expired)]]),
                ["message": .string(Self.expiredMessage)])
    }

    func pollOnce() async {
        let go = flags.with { f -> Bool in if f.closing || f.polling { return false }; f.polling = true; return true }
        guard go else { return }
        defer { flags.with { $0.polling = false } }
        for ctx in contexts.value.values {
            var keyed: Bool?
            for run in (try? store(ctx).latest()) ?? [] {
                if closing { return }
                if !["starting", "ready"].contains(run["status"]?.string ?? "") { continue }
                // Every check needs the key: signed out, they wait instead of repeating the sign-in message every 15 s.
                if keyed == nil { keyed = (try? await environmentFor(ctx)) != nil }
                if keyed == false { break }
                _ = try? await locks.run(key(ctx, run["library_id"]!.string!)) { [self] in
                    guard let current = try store(ctx).get(run["id"]!.string!), ["starting", "ready"].contains(current["status"]?.string ?? "") else { return }
                    do {
                        if workers.value[current["id"]!.string!] != nil {
                            // Setup still running, or a ready app its worker watches.
                            if current["status"]?.string != "ready" { return }
                            let state = try await control(ctx, "probe", current)["state"]?.string ?? ""
                            seen(ctx, current, state)
                            if state == "gone" || (state == "inactive" && !Self.terminalOnly(current)) { _ = try await stopRun(ctx, current["id"]!.string!) }
                            else if state == "unreachable" { publish(ctx, current, ["message": "Preview currently unreachable; checking again shortly"]) }
                        } else {
                            let result = try await control(ctx, "probe", current)
                            let state = result["state"]?.string ?? ""
                            if current["status"]?.string == "ready" { seen(ctx, current, state) }
                            if state == "paused" && current["status"]?.string == "ready" && unopened(current) { try await expire(ctx, current) }
                            else { _ = try await reconcile(ctx, current, result) }
                        }
                    } catch { publish(ctx, current, ["message": .string(message(of: error))]) }
                }
            }
        }
    }

    /// One sweep (a running one is joined).
    public func poll() async {
        let task: Task<Void, Never> = pollDone.with { t in
            if flags.value.polling, let t { return t }
            let task = Task { await self.pollOnce() }
            t = task
            return task
        }
        await task.value
    }

    /// Quitting (and a data-mode change): ready previews go to sleep, runs being set up stop.
    public func close() async {
        flags.with { $0.closing = true }
        defer { flags.with { $0.closing = false } }
        await pollDone.value?.value
        await locks.drain()
        // Shells first, while their sandboxes are still awake: ending one later would wake a sandbox put to sleep below.
        await o.terminals?.closeAll()
        // A ready preview's worker lets go of it instead of stopping it: it goes to sleep below.
        for (id, held) in workers.value {
            let run = try? store(held.ctx).get(id)
            if run?["status"]?.string == "ready", !(run?["sandbox_id"]?.string ?? "").isEmpty {
                held.detaching = true
                try? await held.worker?.detach() // fails only when it is already leaving
            } else { try? await held.worker?.stop() }
            await held.finished?.value
        }
        for ctx in contexts.value.values {
            for run in (try? store(ctx).latest()) ?? [] {
                if run["status"]?.string == "ready", !(run["sandbox_id"]?.string ?? "").isEmpty { await sleep(ctx, run) }
                else if ["starting", "ready"].contains(run["status"]?.string ?? "") { _ = try? await stopRun(ctx, run["id"]!.string!) }
            }
        }
        contexts.with { $0 = [:] }; messages.with { $0 = [:] }; prepared.with { $0 = [] }; touched.with { $0 = [:] }; awake.with { $0 = [:] }
    }

    /// Quitting puts a ready preview to sleep, to wake when it is next opened. One that cannot be put to sleep now
    /// (offline, signed out) sleeps by itself within 10 minutes of its last ping.
    func sleep(_ ctx: SandboxContext, _ run: SandboxRun) async {
        guard let result = try? await control(ctx, "pause", run), result["paused"]?.bool == true else { return }
        let id = run["id"]!.string!
        awake.with { $0[id] = "asleep" }
        publish(ctx, try? store(ctx).record(id, Self.quitAsleep, ["data": ["lifecycle": "paused"]]), ["message": .string(Self.quitAsleep)])
    }

    /// Before a library item itself is deleted (onboarding's untick): its sandbox is stopped and confirmed gone first, then
    /// its run history goes with it. A cleanup that cannot be confirmed keeps both, and the item.
    public func release(_ ctx: SandboxContext, _ libraryId: String) async throws {
        try await locks.run(key(ctx, libraryId)) { [self] in
            try checkOpen()
            let runs = try store(ctx).all(for: libraryId)
            for run in runs {
                let status = run["status"]?.string ?? ""
                if ["starting", "ready"].contains(status) || (status == "failed" && !(run["sandbox_id"]?.string ?? "").isEmpty) {
                    _ = try await stopRun(ctx, run["id"]!.string!)
                }
            }
            try store(ctx).deleteAll(libraryId)
            messages.with { m in for run in runs { m[run["id"]!.string!] = nil } }
            prepared.with { _ = $0.remove(key(ctx, libraryId)) }
        }
    }

    /// Signed out of GitHub: each live run is stopped by its own worker, which still holds the key it started with. A run
    /// without a live worker is asleep, or will be at its timeout, and waits there at no charge.
    public func signedOut() async {
        await withTaskGroup(of: Void.self) { group in
            for (id, held) in workers.value {
                group.addTask { [self] in
                    _ = try? await locks.run(key(held.ctx, held.libraryId)) { [self] in
                        if workers.value[id] !== held || held.detaching { return }
                        if let run = try store(held.ctx).get(id), ["starting", "ready"].contains(run["status"]?.string ?? "") {
                            publish(held.ctx, try store(held.ctx).record(id, "Stopping: signed out of GitHub"), ["message": "Stopping: signed out of GitHub"])
                        }
                        try? await held.worker?.stop()
                        await held.finished?.value
                    }
                }
            }
        }
    }

    /// A shell in a ready run's sandbox: the one already open, woken if it slept, else a new one in the directory Claude
    /// chose, with the saved values (never on a command line). Opening it counts as opening the run, for the sweep.
    public func terminal(_ ctx: SandboxContext, _ libraryId: String) async throws -> JSONValue {
        guard let terminals = o.terminals else { throw SandboxError("Sandbox terminals are unavailable") }
        contexts.with { $0[ctx.dataRoot] = ctx }
        return try await locks.run(key(ctx, libraryId)) { [self] in
            try checkOpen()
            guard let repo = GithubRepo.parse(try ctx.db.libraryRow(libraryId)?["url"]?.string) else { throw SandboxError("Choose a saved GitHub repository.") }
            guard let run = try store(ctx).active(libraryId), run["status"]?.string == "ready", let sandboxId = run["sandbox_id"]?.string, !sandboxId.isEmpty,
                  ["terminal", "both"].contains(run["kind"]?.string ?? ""), let terminal = run["terminal"], terminal.object != nil else {
                throw SandboxError("This repository has no sandbox terminal yet.")
            }
            _ = try await environmentFor(ctx) // signed out: say so now, not when the shell connects
            let environment = try envStore(ctx).read(libraryId)
            try store(ctx).update(run["id"]!.string!, [("last_opened_at", .string(Time.iso(Date(timeIntervalSince1970: o.now() / 1000))))])
            return try terminals.open(SandboxShellSpec(
                libraryId: libraryId, sandboxId: sandboxId, title: "\(repo.owner)/\(repo.name) (sandbox)",
                cwd: try SandboxToolsSpec.repoPath(terminal["cwd"]?.string ?? "."), envs: environment.values, hint: terminal["hint"]?.string ?? "",
                apiKey: { [self] in try await environmentFor(ctx)["E2B_API_KEY"]! }))
        }
    }

    /// Quit: the timer stops, then `close()`.
    public func dispose() async {
        timer?.cancel(); timer = nil
        await close()
    }
}
