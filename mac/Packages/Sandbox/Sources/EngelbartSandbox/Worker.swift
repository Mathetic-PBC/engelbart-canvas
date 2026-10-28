import Foundation
import EngelbartCore

// src/main/sandbox/worker.cjs: a repository's E2B sandbox, set up by the local Claude Code subscription (LocalSetup). A
// restart with saved environment values replays the saved launch plan through launch.py, which also still restarts
// sandboxes set up by the hc pipeline in engelbart-web's runner template. Electron ran this in a forked worker process;
// here it runs in-process behind the same launch/ack/stop protocol (Transport.swift).

public enum SandboxWorker {
    static let adapterDir = "/home/user/.engelbart-canvas"
    static let adapter = "\(adapterDir)/launch.py"
    static let hour = 60 * 60_000
    /// A ready preview sleeps once nobody has looked at it for 10 minutes (the Stage's ping puts the time back: the
    /// manager's touch). E2B pauses it then, memory and processes kept, at no charge, and the next request to its address
    /// wakes it in about a second. Setup keeps the hour, so a sandbox never sleeps partway through it.
    public static let idleMs = 10 * 60_000
    /// No time limit, for the commands that live as long as the sandbox: across its sleeps, an hour's limit would end them.
    static let forever = 0
    static let proxyPort = 43110
    static let githubLogin = #"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"#
    /// The key comes only from the GitHub sign-in (the manager); without it no E2B call is made.
    public static let missingKey = "Sign in to GitHub in Engelbart to use sandboxes."

    /// `safePreview`: https only, no credentials.
    public static func safePreview(_ value: String?) throws -> String {
        guard let value, let url = URL(string: value), url.scheme?.lowercased() == "https", url.user == nil, url.password == nil, url.host != nil else {
            throw SandboxError("Invalid preview URL")
        }
        var href = url.absoluteString
        if url.path.isEmpty, url.query == nil, url.fragment == nil { href += "/" } // new URL(…).href adds the root path
        return href
    }

    /// Whether an address answers like a page: below 500, and not a dev server turning the host away. A Build's run step
    /// checks a web UI on this Mac with it too.
    public static func respondsAt(_ href: String, fetcher: HTTPFetching = URLSessionFetcher.shared) async -> Bool {
        guard let url = URL(string: href) else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        guard let (status, _, body) = try? await fetcher.fetch(request, followRedirects: false) else { return false }
        let text = String(decoding: body.prefix(4096), as: UTF8.self).head(1000)
        return status < 500 && !text.matches("Invalid Host header|not allowed", options: .caseInsensitive)
    }

    public static func previewResponds(_ url: String, fetcher: HTTPFetching = URLSessionFetcher.shared) async -> Bool {
        guard let safe = try? safePreview(url) else { return false }
        return await respondsAt(safe, fetcher: fetcher)
    }

    /// A private repository comes as GitHub's archive, from the download link the ack carries: one archive, minutes long,
    /// never the GitHub sign-in. Anything else there is refused.
    static let archiveHosts = ["codeload.github.com"]
    static let branchPattern = #"^(?![-/])(?!.*\.\.)(?!.*//)(?!.*/$)[\w./-]{1,200}$"#

    public static func archiveSource(_ ack: JSONValue?) throws -> (url: String, branch: String?)? {
        guard let link = ack?["archive_url"]?.string else { return nil }
        guard let url = URL(string: link), url.scheme == "https", archiveHosts.contains(url.host ?? ""), url.user == nil, url.password == nil else {
            throw SandboxError("Invalid repository download link")
        }
        let branch = ack?["branch"]?.string.flatMap { $0.matches(branchPattern) ? $0 : nil }
        return (url.absoluteString, branch)
    }

    /// Public repositories only: the manager asks GitHub with the sign-in and says (`request.docker`) when it can.
    public static func wantsDocker(_ repo: GithubRepo, fetcher: HTTPFetching = URLSessionFetcher.shared) async -> Bool {
        guard let url = URL(string: "https://api.github.com/repos/\(repo.owner)/\(repo.name)/git/trees/HEAD?recursive=1") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue("engelbart-canvas", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (status, _, body) = try? await fetcher.fetch(request, followRedirects: true), (200..<300).contains(status),
              let tree = (try? JSONValue.parse(body))?["tree"]?.array else { return false }
        return tree.contains { ($0["path"]?.string ?? "").matches(#"(^|/)(docker-compose|compose)\.ya?ml$|(^|/)supabase/config\.toml$"#, options: .caseInsensitive) }
    }
}

/// The setup a new run's worker runs (LocalSetup.run by default; tests pass a fake).
public struct LocalSetupRequest: @unchecked Sendable {
    public var sandbox: E2BSandbox
    public var auth: LocalClaudeAuth?
    public var environment: SavedEnvironment
    public var model: String
    public var signal: AbortSignal
    public var checkPreview: (String) async -> Bool
    public var onReady: (LocalSetup.Ready) -> Void
    public var onEvent: (JSONValue) -> Void
}

/// worker.cjs's `createRuntime`.
public final class WorkerRuntime: @unchecked Sendable {
    public typealias Emit = (JSONValue) -> Void

    let e2b: E2BService
    let send: Emit
    let env: [String: String]
    let waitForAck: () async throws -> JSONValue?
    let detectDocker: (GithubRepo) async -> Bool
    let checkPreview: (String) async -> Bool
    let prepareClaude: ([String: String]) async throws -> LocalClaudeAuth
    let localSetup: (LocalSetupRequest) async throws -> LocalSetup.Ready
    let audit: (E2BSandbox, AbortSignal, @escaping (JSONValue) -> Void) async throws -> Void
    let delay: (Double) async -> Void

    private let secrets: Locked<[String]>
    private let state = Locked((sandbox: E2BSandbox?.none, cancelled: false, ready: false, detached: false))
    private let stopTask = Locked<Task<Void, Error>?>(nil)
    private let localController = AbortSignal()
    private let auditController = AbortSignal()
    private let audited = Locked<Task<Void, Never>?>(nil)
    /// The streams this run holds (its app's command), let go when the worker detaches.
    let tracked = Locked<[E2BCommandHandle]>([])

    public init(e2b: E2BService, emit: @escaping Emit, env: [String: String],
                waitForAck: @escaping () async throws -> JSONValue? = { nil },
                detectDocker: @escaping (GithubRepo) async -> Bool = { await SandboxWorker.wantsDocker($0) },
                checkPreview: @escaping (String) async -> Bool = { await SandboxWorker.previewResponds($0) },
                prepareClaude: @escaping ([String: String]) async throws -> LocalClaudeAuth = { try await LocalClaude.prepare($0) },
                localSetup: @escaping (LocalSetupRequest) async throws -> LocalSetup.Ready = { r in
                    try await LocalSetup.run(sandbox: r.sandbox, auth: r.auth, environment: r.environment, model: r.model, signal: r.signal,
                                             onEvent: r.onEvent, checkPreview: r.checkPreview, onReady: r.onReady)
                },
                audit: @escaping (E2BSandbox, AbortSignal, @escaping (JSONValue) -> Void) async throws -> Void = { sandbox, signal, onEvent in
                    try await NpmAudit.run(sandbox: sandbox, signal: signal, onEvent: onEvent)
                },
                delay: @escaping (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }) {
        self.e2b = e2b; self.send = emit; self.env = env; self.waitForAck = waitForAck; self.detectDocker = detectDocker
        self.checkPreview = checkPreview; self.prepareClaude = prepareClaude; self.localSetup = localSetup; self.audit = audit; self.delay = delay
        secrets = Locked([env["E2B_API_KEY"]].compactMap { $0 }.filter { !$0.isEmpty })
    }

    var key: String { env["E2B_API_KEY"] ?? "" }

    func emit(_ event: JSONValue) { send(Redact.event(event, secrets.value)) }

    private func auditAfterReady() {
        let s = state.value
        guard audited.value == nil, !s.cancelled, !s.detached, let sandbox = s.sandbox else { return }
        let onEvent: (JSONValue) -> Void = { [self] data in
            let s = state.value
            if !auditController.aborted && !s.cancelled && !s.detached {
                emit(["event": "progress", "kind": "status", "message": data["message"] ?? .null, "data": data])
            }
        }
        // No await: registry latency or findings cannot delay the preview or fail setup.
        audited.with { $0 = Task { [self] in
            do { try await audit(sandbox, auditController, onEvent) }
            catch { onEvent(["phase": "audit", "status": "unavailable", "message": "Background npm audit unavailable; the sandbox remains ready. No dependencies changed."]) }
        } }
    }

    public func stop() async throws {
        if state.value.detached { return }
        state.with { $0.cancelled = true }
        localController.abort()
        auditController.abort()
        guard let sandbox = state.value.sandbox else { return }
        let task: Task<Void, Error> = stopTask.with { t in
            if let t { return t }
            let task = Task { try await sandbox.kill(requestTimeoutMs: 10_000) }
            t = task
            return task
        }
        do { try await task.value } catch { stopTask.with { if $0 == task { $0 = nil } }; throw error }
    }

    public func detach() { state.with { $0.detached = true }; auditController.abort() }

    func installAdapter(_ target: E2BSandbox) async throws {
        _ = try await target.run("mkdir -p \(SandboxWorker.adapterDir) && chmod 700 \(SandboxWorker.adapterDir)", timeoutMs: 10_000)
        try await target.writeFile(SandboxWorker.adapter, try SandboxResources.text("launch.py"))
    }

    public func canRestart(_ request: JSONValue) async throws -> JSONValue {
        if key.isEmpty { throw SandboxError(SandboxWorker.missingKey) }
        let target = try await e2b.connect(request["sandbox_id"]?.string ?? "", apiKey: key, timeoutMs: nil, requestTimeoutMs: 10_000)
        try await installAdapter(target)
        _ = try await target.run("python3 \(SandboxWorker.adapter) --check", timeoutMs: 20_000,
                                 envs: ["ENGELBART_CANVAS_PORT": String(request["port"]?.int ?? 0), "HUMAN_COMPACT_HOME": "/home/user/.human-compact"])
        return ["state": "restartable"]
    }

    func checkCancelled() throws { if state.value.cancelled { throw SandboxError("Setup stopped") } }

    public func probe(_ request: JSONValue) async throws -> JSONValue {
        if key.isEmpty { throw SandboxError(SandboxWorker.missingKey) }
        // Recover the handle if Engelbart died between E2B creation and saving the id.
        guard let sandboxId = request["sandbox_id"]?.string, !sandboxId.isEmpty else {
            let found = try await e2b.list(metadata: ["canvasRunId": request["run_id"]?.string ?? "", "app": "engelbart-canvas"], states: ["running", "paused"],
                                           apiKey: key, requestTimeoutMs: 10_000).first
            return found.map { ["state": "interrupted", "sandbox_id": .string($0.sandboxId)] } ?? ["state": "gone"]
        }
        do {
            let info = try await e2b.getInfo(sandboxId, apiKey: key, requestTimeoutMs: 10_000)
            // Asleep is healthy, and is never checked over HTTP: a request to its address would wake it.
            if info.state == "paused" { return ["state": "paused"] }
            if info.state != "running" { return ["state": "inactive"] }
            // A terminal has no preview to check: running is ready.
            guard let preview = request["preview_url"]?.string, !preview.isEmpty else {
                return ["state": request["kind"]?.string == "terminal" ? "ready" : "interrupted"]
            }
            // Nor is one about to sleep, which the request could reach just after it had.
            if info.endAt - Time.ms() < 30_000 { return ["state": "ready"] }
            return ["state": await checkPreview(preview) ? "ready" : "unreachable"]
        } catch let error as SandboxError where error.isNotFound {
            return ["state": "gone"]
        } // a timeout or authentication failure is not proof of a dead sandbox
    }

    public func kill(_ request: JSONValue) async throws -> JSONValue {
        if key.isEmpty { throw SandboxError(SandboxWorker.missingKey) }
        if let id = request["sandbox_id"]?.string, !id.isEmpty { try await e2b.kill(id, apiKey: key, requestTimeoutMs: 10_000) }
        return ["state": "gone"]
    }

    /// Quitting Engelbart puts a ready preview to sleep instead of ending it. `paused`: whether it went to sleep now.
    public func pause(_ request: JSONValue) async throws -> JSONValue {
        if key.isEmpty { throw SandboxError(SandboxWorker.missingKey) }
        var paused = false
        if let id = request["sandbox_id"]?.string, !id.isEmpty { paused = try await e2b.pause(id, apiKey: key, requestTimeoutMs: 30_000) }
        return ["state": "paused", "paused": .bool(paused)]
    }

    /// From ready on, the sandbox sleeps after IDLE unless the Stage's ping puts the time back; no failure here reaches the
    /// verified preview.
    private func sleepWhenIdle() {
        guard let sandbox = state.value.sandbox else { return }
        Task { try? await sandbox.setTimeout(SandboxWorker.idleMs, requestTimeoutMs: 10_000) }
    }

    /// A ready app's stream breaks when its sandbox goes to sleep, a moment before E2B reports it paused (0.1–1.5 s,
    /// measured 2026-10-02). Asleep, the app is kept for the next request to wake, so the worker leaves without stopping
    /// anything. `ended`: how the app's command ended, nil for exit 0; an exit code is the app's own end: one look.
    private func asleep(_ ended: Error?) async -> Bool {
        let s = state.value
        guard s.ready, !s.cancelled, !s.detached, let sandbox = s.sandbox else { return false }
        let looks = ended != nil && exitCodeOf(ended!) == nil ? 5 : 1
        for attempt in 0..<looks {
            if attempt > 0 { await delay(1) }
            guard let info = try? await e2b.getInfo(sandbox.sandboxId, apiKey: key, requestTimeoutMs: 10_000) else { return false }
            if state.value.cancelled || state.value.detached { return false }
            if info.state == "paused" {
                state.with { $0.detached = true }
                auditController.abort()
                emit(["event": "paused"])
                return true
            }
        }
        return false
    }

    /// `run(request)`: a start (`command: 'start'`) or a restart with the saved environment.
    public func run(_ request: JSONValue) async {
        let restarting = request["command"]?.string == "restart"
        let environment = SavedEnvironment(revision: nil,
                                           values: (request["environment"]?["values"]?.object ?? [:]).compactMapValues(\.string),
                                           removed: (request["environment"]?["removed"]?.array ?? []).compactMap(\.string))
        secrets.with { $0 += Array(environment.values.values) }
        var deadline: DispatchWorkItem?
        defer { deadline?.cancel(); auditController.abort() }
        do {
            guard let repo = GithubRepo.parse(request["github_url"]?.string) else { throw SandboxError("A GitHub repository URL is required") }
            if key.isEmpty { throw SandboxError(SandboxWorker.missingKey) }
            // Setup is the local Claude Code subscription's, and nothing else's. A restart replays the saved plan.
            var auth: LocalClaudeAuth?
            if !restarting {
                emit(["event": "progress", "message": "Checking local Claude subscription sign-in"])
                auth = try await prepareClaude(env)
                try checkCancelled()
            }
            emit(["event": "progress", "message": .string(restarting ? "Connecting to existing sandbox" : "Creating sandbox")])
            let docker: Bool
            if restarting { docker = false } else if let d = request["docker"]?.bool { docker = d } else { docker = await detectDocker(repo) }
            try checkCancelled()
            let template = env["E2B_TEMPLATE"].flatMap { $0.isEmpty ? nil : $0 } ?? "engelbart-runner"
            let sandbox: E2BSandbox
            if restarting {
                sandbox = try await e2b.connect(request["sandbox_id"]?.string ?? "", apiKey: key, timeoutMs: nil, requestTimeoutMs: 10_000)
            } else {
                var metadata = ["canvasRunId": request["run_id"]?.string ?? "", "repo": repo.url, "app": "engelbart-canvas"]
                // The web worker sweeps every sandbox carrying `runId` if it is absent from Supabase: Engelbart owns its runs
                // locally and uses a key of its own. githubLogin: who asked, as a hint for tracing, not proof.
                if let login = request["github_login"]?.string, login.matches(SandboxWorker.githubLogin) { metadata["githubLogin"] = login }
                let chosen = docker ? (env["E2B_DOCKER_TEMPLATE"].flatMap { $0.isEmpty ? nil : $0 } ?? "\(template)-docker") : template
                // Its timeout pauses it instead of ending it, and a request to its address wakes it.
                sandbox = try await e2b.create(template: chosen, E2BCreateOptions(timeoutMs: SandboxWorker.hour, requestTimeoutMs: 60_000, pauseOnTimeout: true,
                                                                                 autoResume: true, metadata: metadata), apiKey: key)
            }
            state.with { $0.sandbox = sandbox }
            try checkCancelled()
            emit(["event": "sandbox_created", "sandbox_id": .string(sandbox.sandboxId)])
            let source = try SandboxWorker.archiveSource(try await waitForAck()) // do not clone until the handle is persisted
            // The link's own token is what must not show (the address around it is only the repository's name).
            if let source, let items = URLComponents(string: source.url)?.queryItems {
                secrets.with { $0 += items.compactMap(\.value).filter { $0.count >= 16 } }
            }
            try checkCancelled()
            let workdir = "/home/user/repository"
            let progress: (String) -> Void = { [self] text in
                if !text.trimmed.isEmpty { emit(["event": "progress", "message": .string(Redact.output(text, secrets.value).trimmed.tail(2000))]) }
            }
            if !restarting {
                emit(["event": "progress", "message": "Cloning repository"])
                if let source {
                    // A private repository: its archive, unpacked into a history of one commit as a shallow clone leaves it.
                    // The link is in this one command's environment, never on its command line or in what it prints.
                    let archive = "/tmp/engelbart-repository.tar.gz"
                    var steps = ["mkdir -p \(Shell.quote(workdir))",
                                 "curl -fsS --proto =https --max-time 280 -o \(archive) \"$ENGELBART_ARCHIVE_URL\"",
                                 "tar -xzf \(archive) --strip-components=1 -C \(Shell.quote(workdir))",
                                 "rm -f \(archive)", "cd \(Shell.quote(workdir))", "git init -q"]
                    if source.branch != nil { steps.append("git symbolic-ref HEAD \"refs/heads/$ENGELBART_BRANCH\"") }
                    steps += ["git add -A",
                              "git -c user.name=Engelbart -c user.email=sandbox@engelbart.local commit -q --no-verify --allow-empty -m \(Shell.quote("Snapshot of \(repo.url)"))",
                              "git remote add origin \(Shell.quote("\(repo.url).git"))"]
                    var envs = ["ENGELBART_ARCHIVE_URL": source.url]
                    if let branch = source.branch { envs["ENGELBART_BRANCH"] = branch }
                    _ = try await sandbox.run(steps.joined(separator: " && "), CommandOptions(timeoutMs: 5 * 60_000, envs: envs, onStdout: progress, onStderr: progress))
                } else {
                    _ = try await sandbox.run("git clone --progress --depth 1 \(Shell.quote("\(repo.url).git")) \(Shell.quote(workdir))",
                                              CommandOptions(timeoutMs: 5 * 60_000, envs: ["GIT_TERMINAL_PROMPT": "0"], onStdout: progress, onStderr: progress))
                }
                emit(["event": "progress", "message": "Repository cloned", "kind": "status", "data": ["lifecycle": "cloned"]])
                try checkCancelled()
                // The runner has npm/pnpm/bun but not Yarn: a yarn.lock repository gets it, rather than an npm install that
                // ignores its lockfile.
                _ = try await sandbox.run("if [ -f \(Shell.quote("\(workdir)/yarn.lock")) ]; then command -v yarn >/dev/null 2>&1 || npm install --global yarn@1.22.22; fi",
                                          CommandOptions(timeoutMs: 120_000, envs: ["npm_config_audit": "false"], user: "root", onStdout: progress, onStderr: progress))
                try checkCancelled()
                if docker {
                    emit(["event": "progress", "message": "Starting repository services"])
                    _ = try await sandbox.start("dockerd > /var/log/dockerd.log 2>&1", CommandOptions(timeoutMs: SandboxWorker.forever, user: "root"))
                    _ = try await sandbox.run("for i in $(seq 1 30); do docker info >/dev/null 2>&1 && chmod 666 /var/run/docker.sock && exit 0; sleep 1; done; exit 1",
                                              CommandOptions(timeoutMs: 40_000, user: "root"))
                }
            }
            try await installAdapter(sandbox)
            if restarting {
                _ = try await sandbox.run("python3 \(SandboxWorker.adapter) --stop", timeoutMs: 20_000)
                try await sandbox.setTimeout(SandboxWorker.hour, requestTimeoutMs: nil)
            }
            // Secrets travel as a file, never as shell arguments or template env.
            try await sandbox.writeFile("\(SandboxWorker.adapterDir)/environment.json", environment.json.text())
            _ = try await sandbox.run("chmod 600 \(SandboxWorker.adapterDir)/environment.json", timeoutMs: 10_000)
            if !restarting {
                try await setUp(sandbox: sandbox, auth: auth, environment: environment, deadline: &deadline)
                return
            }
            try await restart(sandbox: sandbox, request: request, deadline: &deadline)
        } catch {
            let wasCancelled = state.value.cancelled
            var cleanupError = ""
            if restarting && !wasCancelled {
                // Keep the machine and installed files on a configuration error.
                if let sandbox = state.value.sandbox {
                    do { _ = try await sandbox.run("python3 \(SandboxWorker.adapter) --stop", timeoutMs: 20_000) }
                    catch { cleanupError = " Application cleanup could not be confirmed." }
                }
                state.with { $0.detached = true }
            } else {
                do { try await stop() } catch { cleanupError = " Sandbox cleanup failed: \(message(of: error))" }
            }
            emit(["event": .string(wasCancelled && cleanupError.isEmpty ? "stopped" : "failed"), "error": .string("\(message(of: error))\(cleanupError)")])
        }
    }

    /// A new sandbox: Claude Code sets it up (LocalSetup); ready is a verified preview, a terminal, or both.
    private func setUp(sandbox: E2BSandbox, auth: LocalClaudeAuth?, environment: SavedEnvironment, deadline: inout DispatchWorkItem?) async throws {
        let timer = DispatchWorkItem { [localController] in localController.abort(SandboxError("Claude Code setup took more than 15 minutes")) }
        deadline = timer
        DispatchQueue.global().asyncAfter(deadline: .now() + 15 * 60, execute: timer)
        let published = Locked<LocalSetup.Ready?>(nil)
        let publishReady: (LocalSetup.Ready) throws -> Void = { [self] result in
            try checkCancelled()
            if state.value.ready { return }
            published.with { $0 = result }
            state.with { $0.ready = true }
            timer.cancel()
            // Supervise the app even while Claude writes its final response. An app exit cancels that response.
            if let done = result.done {
                Task { [localController] in
                    do { _ = try await done.wait(); localController.abort(SandboxError("Application exited")) } catch { localController.abort(error) }
                }
            }
            if result.previewURL != nil {
                emit(["event": "progress", "message": "Preview verified", "kind": "status", "data": ["phase": "check", "status": "ok", "provider": "claude-local"]])
            }
            if let terminal = result.terminal {
                emit(["event": "progress", "message": "Terminal verified", "kind": "status", "data": ["phase": "terminal", "status": "ok", "cwd": terminal["cwd"] ?? .null]])
            }
            var ready: [String: JSONValue] = ["event": "ready", "kind": .string(result.kind)]
            if let url = result.previewURL { ready["preview_url"] = .string(url); ready["port"] = result.port.map { .number(Double($0)) } ?? .null }
            if let terminal = result.terminal { ready["terminal"] = terminal }
            emit(.object(ready))
            sleepWhenIdle()
            auditAfterReady()
        }
        var launched: LocalSetup.Ready
        do {
            let secretsNow = secrets.value
            launched = try await localSetup(LocalSetupRequest(
                sandbox: sandbox, auth: auth, environment: environment,
                model: env["ENGELBART_SANDBOX_CLAUDE_MODEL"].flatMap { $0.isEmpty ? nil : $0 } ?? "claude-sonnet-5-5",
                signal: localController, checkPreview: checkPreview,
                onReady: { result in try? publishReady(result) },
                onEvent: { [self] event in
                    if localController.aborted { return }
                    let phase = event["phase"]?.string
                    let kind = phase == "stage" ? "command" : phase == "log" ? (event["stream"]?.string == "stderr" ? "stderr" : "stdout") : "status"
                    let text = (event["command"]?.string ?? event["text"]?.string ?? event["message"]?.string ?? phase ?? "").tail(2000)
                    var data = event.object ?? [:]
                    for key in ["text", "message", "command"] {
                        if let s = data[key]?.string { data[key] = .string(Redact.output(s.tail(8000), secretsNow)) }
                    }
                    emit(["event": "progress", "message": .string(Redact.output(text, secretsNow)), "kind": .string(kind), "data": Redact.value(.object(data), secretsNow)])
                }))
        } catch {
            timer.cancel()
            // Final-summary errors cannot tear down a ready sandbox. Its app's own end stays authoritative.
            guard let ready = published.value else {
                localController.abort()
                try checkCancelled()
                throw SandboxError("\(Redact.output(message(of: error).isEmpty ? "Claude Code setup failed." : message(of: error), secrets.value).tail(600)) Retry from build details.")
            }
            launched = ready
        }
        timer.cancel()
        try checkCancelled()
        try publishReady(launched)
        if let done = launched.done { tracked.with { $0.append(done) } }
        guard let done = launched.done else {
            // A terminal: no app to watch. The sandbox stays on the same sleep-when-idle lifecycle; this worker lets its
            // audit finish, then leaves without stopping anything (the manager keeps a ready terminal run).
            await audited.value?.value
            try checkCancelled()
            state.with { $0.detached = true }
            return
        }
        // Failures after readiness start no other setup; a sandbox gone to sleep is not a failure at all.
        var ended: Error?
        do { _ = try await done.wait() } catch { ended = error }
        if await asleep(ended) { return }
        if let ended { throw ended }
        try await stop()
        emit(["event": "stopped"])
    }

    /// A restart: the saved launch plan again, with the saved environment, in the same sandbox and files.
    private func restart(sandbox: E2BSandbox, request: JSONValue, deadline: inout DispatchWorkItem?) async throws {
        try checkCancelled()
        emit(["event": "progress", "message": "Restarting application with saved environment"])
        let outcome = Deferred<Void>()
        let timer = DispatchWorkItem { outcome.reject(SandboxError("The restart took more than 45 minutes")) }
        deadline = timer
        DispatchQueue.global().asyncAfter(deadline: .now() + 45 * 60, execute: timer)
        let buffer = Locked("")
        let events = SerialChain()
        let progress: (String) -> Void = { [self] text in
            if !text.trimmed.isEmpty { emit(["event": "progress", "message": .string(Redact.output(text, secrets.value).trimmed.tail(2000))]) }
        }
        let handleEvent: (JSONValue) async throws -> Void = { [self] raw in
            if state.value.ready || state.value.cancelled { return }
            guard var event = raw.object else { return }
            let protocolFields = event.filter { ["phase", "status", "stage", "port", "host", "url", "services"].contains($0.key) }
            event = Redact.value(.object(event), secrets.value).object ?? [:]
            for (k, v) in protocolFields { event[k] = v }
            for key in ["text", "stdout", "stderr", "output"] { if let s = event[key]?.string { event[key] = .string(Redact.output(s, secrets.value)) } }
            let phase = event["phase"]?.string
            // Keep the pipeline phase and stage: the Build UI partitions these same events into steps. "ready" is recorded
            // only after Engelbart verifies the public preview.
            if phase != "ready" {
                let kind = phase == "stage" ? "command" : phase == "log" ? (event["stream"]?.string == "stderr" ? "stderr" : "stdout") : phase == "error" ? "error" : "status"
                let text: String = phase == "stage" ? (event["command"]?.string ?? event["stage"]?.string ?? "")
                    : event["text"]?.string ?? event["message"]?.string ?? event["summary"]?.string ?? event["reason"]?.string
                    ?? [event["phase"]?.string, event["stage"]?.string, event["status"]?.string].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                // Large patches or output must not exceed the transport limit.
                let data: JSONValue = JSONValue.object(event).text().utf16.count <= 64_000 ? .object(event)
                    : .object(event.filter { ["phase", "stage", "status", "step", "attempt", "source"].contains($0.key) })
                emit(["event": "progress", "message": .string(text.tail(2000)), "kind": .string(kind), "data": data])
            }
            if phase == "ready", let port = event["port"]?.integer {
                emit(["event": "progress", "message": "Verifying live preview", "kind": "status", "data": ["phase": "check", "status": "checking"]])
                var wanted: [JSONValue] = [["port": .number(Double(port)), "host": event["host"] ?? .null]]
                if let services = event["services"]?.array, !services.isEmpty {
                    wanted = services.enumerated().sorted { a, b in
                        let ea = a.element["isEntry"]?.truthy ?? false, eb = b.element["isEntry"]?.truthy ?? false
                        return ea != eb ? ea : a.offset < b.offset
                    }.map(\.element)
                }
                for service in wanted {
                    guard let p = service["port"]?.integer, (1...65535).contains(p) else { throw SandboxError("Invalid application port") }
                    if !["localhost", "127.0.0.1", "0.0.0.0", "::1"].contains(service["host"]?.string ?? "127.0.0.1") { throw SandboxError("Invalid application host") }
                }
                let specs = wanted.enumerated().map { i, s in Shell.quote("\(SandboxWorker.proxyPort + i):\(s["port"]!.integer!):\(s["host"]?.string ?? "127.0.0.1")") }.joined(separator: " ")
                _ = try await sandbox.start("node /opt/engelbart/proxy.mjs \(specs)", CommandOptions(timeoutMs: SandboxWorker.forever))
                let local = URL(string: event["url"]?.string ?? "http://localhost:\(port)") ?? URL(string: "http://localhost:\(port)")!
                let pathPart = local.path.isEmpty ? "/" : local.path
                let previewURL = try SandboxWorker.safePreview("https://\(sandbox.getHost(SandboxWorker.proxyPort))\(pathPart)\(local.query.map { "?\($0)" } ?? "")")
                for _ in 0..<10 {
                    try checkCancelled()
                    if await checkPreview(previewURL) {
                        state.with { $0.ready = true }
                        timer.cancel()
                        emit(["event": "progress", "message": "Preview verified", "kind": "status", "data": ["phase": "check", "status": "ok"]])
                        emit(["event": "ready", "preview_url": .string(previewURL), "port": wanted[0]["port"]!])
                        sleepWhenIdle()
                        outcome.resolve(())
                        return
                    }
                    await delay(1)
                }
                throw SandboxError("The application started, but its preview is not reachable")
            } else if phase == "usable" || phase == "error" {
                throw SandboxError(event["message"]?.string ?? event["summary"]?.string ?? "This repository has no running web preview")
            }
        }
        let onStdout: (String) -> Void = { chunk in
            var lines: [String] = []
            let over = buffer.with { b -> Bool in
                b += chunk
                if b.utf16.count > 2_000_000 { return true }
                while let nl = b.firstIndex(of: "\n") { lines.append(String(b[..<nl])); b = String(b[b.index(after: nl)...]) }
                return false
            }
            if over { outcome.reject(SandboxError("Setup event exceeded its size limit")); return }
            for line in lines where !line.trimmed.isEmpty {
                _ = events.enqueue {
                    guard let event = try? JSONValue.parse(line) else { progress(line); return }
                    do { try await handleEvent(event) } catch { outcome.reject(error) }
                }
            }
        }
        // No model call and no key: launch.py replays a saved plan only (a Claude Code one, or an older hc one).
        let handle = try await sandbox.start("python3 -u \(SandboxWorker.adapter) --restart", CommandOptions(
            timeoutMs: SandboxWorker.forever,
            envs: ["HC_EXPERIMENTAL": "1", "HC_DISPOSABLE_HOST": "1", "PIP_NO_CACHE_DIR": "1", "HUMAN_COMPACT_HOME": "/home/user/.human-compact",
                   "npm_config_audit": "false", "ENGELBART_CANVAS_PORT": String(request["port"]?.int ?? 0)],
            onStdout: onStdout, onStderr: progress))
        tracked.with { $0.append(handle) }
        let exited = Deferred<Void>()
        Task { [self] in
            var failure: Error?
            do { _ = try await handle.wait() } catch { failure = error }
            await events.idle()
            if let failure { exited.reject(failure) }
            else if !state.value.ready { exited.reject(SandboxError("The application exited before its preview was ready")) }
            else { exited.resolve(()) }
        }
        // Whichever comes first: ready (or a failure on the way), or the command's end.
        let first = Deferred<Void>()
        Task { first.settle(await outcome.settled()) }
        Task { first.settle(await exited.settled()) }
        try await first.wait()
        // Ready: keep receiving events until the application exits, its sandbox goes to sleep, or it is stopped.
        var ended: Error?
        if case .failure(let error) = await exited.settled() { ended = error }
        if await asleep(ended) { return }
        if let ended { throw ended }
        try await stop()
        emit(["event": "stopped"])
    }
}
