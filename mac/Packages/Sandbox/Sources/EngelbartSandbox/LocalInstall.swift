import Foundation
import EngelbartCore

// src/main/sandbox/local-install.cjs: the worker-owned dependency job in the sandbox (install-job.py does the work there).

public enum InstallPlanner {
    /// A conservative semver subset, not a guess: unsupported syntax defers to Claude.
    public static func satisfies(_ version: String?, _ range: String?) -> Bool {
        guard let version, let range, version.matches(#"^v?\d+\.\d+\.\d+$"#) else { return false }
        let actual = version.replacingOccurrences(of: "^v", with: "", options: .regularExpression).split(separator: ".").map { Int($0) ?? 0 }
        func compare(_ a: [Int], _ b: [Int]) -> Int { a[0] != b[0] ? a[0] - b[0] : a[1] != b[1] ? a[1] - b[1] : a[2] - b[2] }
        return range.components(separatedBy: "||").contains { alternative in
            let squeezed = alternative.trimmed.replacingOccurrences(of: #"(>=|<=|>|<|=|\^|~)\s+"#, with: "$1", options: .regularExpression)
            let tokens = squeezed.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
            if tokens.isEmpty { return false }
            return tokens.allSatisfy { token in
                if token == "*" { return true }
                guard let m = token.captures(#"^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$"#, options: .caseInsensitive) else { return false }
                let op = m[1] ?? "", major = Int(m[2]!)!, minor = m[3], patch = m[4]
                let wild: (String?) -> Bool = { $0 == nil || $0!.lowercased() == "x" || $0 == "*" }
                let count = wild(minor) ? 1 : wild(patch) ? 2 : 3
                if count == 1 && patch != nil { return false }
                let low = [major, count >= 2 ? Int(minor!)! : 0, count == 3 ? Int(patch!)! : 0]
                let high = count == 1 ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0]
                let diff = compare(actual, low)
                switch op {
                case ">=": return diff >= 0
                case ">": return count == 3 ? diff > 0 : compare(actual, high) >= 0
                case "<": return diff < 0
                case "<=": return count == 3 ? diff <= 0 : compare(actual, high) < 0
                case "^":
                    let upper = (low[0] != 0 || count == 1) ? [low[0] + 1, 0, 0] : (low[1] != 0 || count == 2) ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1]
                    return diff >= 0 && compare(actual, upper) < 0
                case "~": return diff >= 0 && compare(actual, high) < 0
                default: return count == 3 ? diff == 0 : diff >= 0 && compare(actual, high) < 0
                }
            }
        }
    }

    /// `installPlan(facts)`: `{ status: 'planned', command, cwd: '.', manager }`, or `{ status: 'needs_agent', reason }`.
    public static func plan(_ facts: JSONValue) -> JSONValue {
        func defer_(_ reason: String) -> JSONValue { ["status": "needs_agent", "reason": .string(reason)] }
        guard let pkg = facts["package"], !pkg.isNull else { return defer_("No root Node manifest; choose the appropriate install directory and command.") }
        if (pkg["workspaces"].map { !$0.isNull } ?? false) || (pkg["devEngines"].map { !$0.isNull } ?? false) || !(facts["nestedManifests"]?.array ?? []).isEmpty
            || (facts["scanTruncated"]?.truthy ?? false) || (facts["files"]?["truncated"]?.truthy ?? false) {
            return defer_("Workspace or multi-package layout needs agent inspection.")
        }
        if let custom = facts["customFiles"]?.array, !custom.isEmpty {
            return defer_("Custom setup/configuration needs inspection: \(custom.compactMap(\.string).joined(separator: ", ")).")
        }
        if ["preinstall", "install", "postinstall", "prepare"].contains(where: { pkg["scripts"]?[$0]?.truthy ?? false }) {
            return defer_("Root install lifecycle scripts may have prerequisites; inspect them before installing.")
        }
        let managers = ["package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "bun.lockb": "bun"]
        guard let locks = facts["lockfiles"]?.array, locks.count == 1 else { return defer_("A single unambiguous lockfile is required for automatic installation.") }
        guard let manager = locks[0].string.flatMap({ managers[$0] }) else { return defer_("Unknown lockfile.") }
        let versions = facts["versions"]?.object ?? [:]
        guard let node = versions["node"]?.string, !node.isEmpty, let tool = versions[manager]?.string, !tool.isEmpty else {
            return defer_("Required runtime or package manager is unavailable.")
        }
        if let declaredValue = pkg["packageManager"], !declaredValue.isNull {
            guard let declared = declaredValue.string?.captures(#"^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?$"#, options: .caseInsensitive),
                  declared[1] == manager, satisfies(tool, declared[2]) else {
                return defer_("Declared package manager/version does not match the available tool and lockfile.")
            }
        }
        var runtime: [JSONValue] = [pkg["engines"]?["node"], pkg["volta"]?["node"]].compactMap { $0 }
        runtime += (facts["runtimeFiles"]?.object ?? [:]).sorted { $0.key < $1.key }.map(\.value)
        if runtime.contains(where: { !satisfies(node, $0.string) }) { return defer_("Node runtime requirements need to be resolved before installing.") }
        for requirement in [pkg["engines"]?[manager], pkg["volta"]?[manager]].compactMap({ $0 }) where !satisfies(tool, requirement.string) {
            return defer_("Package-manager runtime requirements need to be resolved before installing.")
        }
        let yarnMajor = Int(tool.replacingOccurrences(of: "^v", with: "", options: .regularExpression).split(separator: ".").first ?? "") ?? 0
        let command = ["npm": "npm ci", "pnpm": "pnpm install --frozen-lockfile",
                       "yarn": yarnMajor >= 2 ? "yarn install --immutable" : "yarn install --frozen-lockfile",
                       "bun": "bun install --frozen-lockfile"][manager]!
        return ["status": "planned", "command": .string(command), "cwd": ".", "manager": .string(manager)]
    }
}

/// `createDependencyInstall`: one managed install job at a time in the sandbox.
public final class DependencyInstall: SandboxInstallControl, @unchecked Sendable {
    static let root = SandboxToolsSpec.root
    static let state = "/home/user/.engelbart-canvas"
    static let helper = "\(state)/install-job.py"
    static let active: Set<String> = ["starting", "running", "stopping", "blocked"]

    final class Job: @unchecked Sendable {
        let id = IDs.new()
        var status = "starting"
        let command: String
        let cwd: String
        let parallel: JSONValue?
        var output = ""
        let startedMs = Time.ms()
        let startedAt = Time.iso()
        var finishedAt: String?
        var exitCode: Int?
        var error: String?
        var stopping = false
        var handle: E2BCommandHandle?
        var cleanup: Task<Void, Error>?
        let done = Deferred<Void>()
        init(command: String, cwd: String, parallel: JSONValue?) { self.command = command; self.cwd = cwd; self.parallel = parallel }
    }

    let sandbox: E2BSandbox
    let environment: [String: String]
    let secrets: [String]
    let signal: AbortSignal?
    let onEvent: (JSONValue) -> Void
    private let lock = NSRecursiveLock()
    private var current: Job?
    private var initial: JSONValue = ["status": "needs_agent", "reason": "Preflight has not run."]
    private var facts: JSONValue = .object([:])
    private var closed = false

    public init(sandbox: E2BSandbox, environment: [String: String] = [:], secrets: [String] = [], signal: AbortSignal? = nil, onEvent: @escaping (JSONValue) -> Void = { _ in }) {
        self.sandbox = sandbox; self.environment = environment; self.secrets = secrets; self.signal = signal; self.onEvent = onEvent
    }

    private func emit(_ event: JSONValue) {
        if !lock.withLock({ closed }) && !(signal?.aborted ?? false) { onEvent(Redact.value(event, secrets)) }
    }

    public func status() -> JSONValue {
        lock.withLock {
            guard let job = current else { return Redact.value(initial, secrets) }
            var o: [String: JSONValue] = ["id": .string(job.id), "status": .string(job.status), "command": .string(job.command), "cwd": .string(job.cwd),
                                          "started_at": .string(job.startedAt), "finished_at": job.finishedAt.map { .string($0) } ?? .null,
                                          "exitCode": job.exitCode.map { .number(Double($0)) } ?? .null, "error": job.error.map { .string($0) } ?? .null,
                                          "output": .string(job.output)]
            if let parallel = job.parallel { o["parallel"] = parallel }
            return Redact.value(.object(o), secrets)
        }
    }

    private func event(_ job: Job) {
        let (status, exit, error) = lock.withLock { (job.status, job.exitCode, job.error) }
        emit(["phase": "setup", "status": .string(["failed", "blocked"].contains(status) ? "failed" : "working"), "stage": "install", "job_id": .string(job.id),
              "install_status": .string(status), "exit_code": exit.map { .number(Double($0)) } ?? .null, "duration_ms": .number(Time.ms() - job.startedMs),
              "message": .string("Dependency installation \(status)\(exit == nil ? "" : " (exit \(exit!))")\(error.map { ": \($0)" } ?? "")")])
    }

    private func cleanup(_ job: Job) async throws {
        let task: Task<Void, Error> = lock.withLock {
            if let existing = job.cleanup { return existing }
            let task = Task { [sandbox] in
                let result = try await sandbox.run("python3 \(Self.helper) stop \(job.id)", timeoutMs: 15_000, requestTimeoutMs: 20_000)
                if result.exitCode != 0 { throw SandboxError("Could not confirm the dependency install stopped") }
            }
            job.cleanup = task
            return task
        }
        do { try await task.value } catch {
            lock.withLock { if job.cleanup == task { job.cleanup = nil } }
            throw error
        }
    }

    private func finish(_ job: Job, _ status: String, _ error: Error? = nil) {
        lock.withLock {
            job.status = status
            job.error = error.map { Redact.string(message(of: $0), secrets).tail(2000) }
            job.finishedAt = status == "blocked" ? nil : Time.iso()
        }
        event(job)
        job.done.resolve(())
    }

    private func completed(_ job: Job, _ result: CommandResult?, _ error: Error?) async {
        let proceed = lock.withLock { () -> Bool in
            guard Self.active.contains(job.status), !job.stopping else { return false }
            job.exitCode = result?.exitCode ?? error.flatMap(exitCodeOf)
            return true
        }
        guard proceed else { return }
        do {
            try await cleanup(job) // also clears any orphaned package-manager children
            if !lock.withLock({ job.stopping }) { finish(job, job.exitCode == 0 ? "succeeded" : "failed", error) }
        } catch { if !lock.withLock({ job.stopping }) { finish(job, "blocked", error) } }
    }

    @discardableResult
    func stop() async throws -> JSONValue {
        let job: Job? = lock.withLock {
            guard let job = current, Self.active.contains(job.status) else { return nil }
            job.stopping = true; job.status = "stopping"
            return job
        }
        guard let job else { return status() }
        do {
            try await cleanup(job)
            await job.handle?.disconnect()
            finish(job, "stopped")
        } catch { finish(job, "blocked", error); throw error }
        return status()
    }

    func start(command commandIn: String?, cwd: String = ".", parallel: JSONValue? = nil, timeoutSeconds: Int = 600) async throws -> JSONValue {
        if lock.withLock({ closed }) { throw SandboxError("Dependency installer is closed") }
        try signal?.throwIfAborted()
        var command = commandIn
        if let parallel {
            guard commandIn == nil, cwd == ".", let items = parallel.array, items.count == 2,
                  items.allSatisfy({ $0["cwd"]?.string != nil && ["npm", "pip"].contains($0["manager"]?.string ?? "") }),
                  Set(items.compactMap { $0["manager"]?.string }).count == 2 else { throw SandboxError("Invalid parallel dependency install plan") }
            command = "Parallel dependency installs: " + items.map { "\($0["manager"]!.string!) (\($0["cwd"]!.string!))" }.joined(separator: " + ")
        }
        let target = SandboxToolsSpec.posixResolve(Self.root, cwd)
        guard target == Self.root || target.hasPrefix(Self.root + "/"), let command, !command.trimmed.isEmpty, command.utf16.count <= 8000,
              !command.contains("\0"), (1...600).contains(timeoutSeconds) else { throw SandboxError("Invalid dependency install plan") }
        try await stop() // a replacement is forbidden until its predecessor is gone
        try signal?.throwIfAborted()
        let job = Job(command: command, cwd: target, parallel: parallel)
        lock.withLock { current = job }
        emit(["phase": "stage", "stage": "install", "status": "running", "job_id": .string(job.id), "command": .string(command)])
        do {
            let spec = "\(Self.state)/install-\(job.id).json"
            let specValue: JSONValue = parallel.map { ["parallel": $0] } ?? ["command": .string(command), "cwd": .string(target)]
            try await sandbox.writeFile(spec, specValue.text())
            _ = try await sandbox.run("chmod 600 \(spec)", timeoutMs: 10_000)
            if parallel != nil {
                let result: CommandResult
                do { result = try await sandbox.run("python3 \(Self.helper) plan \(job.id)", timeoutMs: 20_000) }
                catch {
                    let stderr = (error as? SandboxError)?.details["stderr"]?.string ?? message(of: error)
                    throw SandboxError("Parallel install needs sequential agent inspection: \(stderr.tail(2000))")
                }
                if result.exitCode != 0 || result.stdout.utf16.count > 64_000 { throw SandboxError("Parallel install needs sequential agent inspection") }
                let plan = InstallPlanner.plan((try? JSONValue.parse(result.stdout))?["npmFacts"] ?? .null)
                if plan["status"]?.string != "planned" || plan["manager"]?.string != "npm" {
                    throw SandboxError("Parallel install needs sequential agent inspection: \(plan["reason"]?.string ?? "npm lockfile required")")
                }
            }
            try signal?.throwIfAborted()
            let receive: (String) -> (String) -> Void = { stream in { [self] chunk in
                let safe = Redact.output(chunk, secrets)
                lock.withLock { job.output = (job.output + safe).tail(32_000) }
                emit(["phase": "log", "stage": "install", "job_id": .string(job.id), "stream": .string(stream), "text": .string(safe.tail(2000))])
            } }
            var envs = environment
            envs["npm_config_audit"] = "false"
            envs["ENGELBART_CANVAS_INSTALL_JOB"] = job.id
            let handle = try await sandbox.start("python3 -u \(Self.helper) run \(job.id)",
                                                 CommandOptions(timeoutMs: timeoutSeconds * 1000, requestTimeoutMs: 20_000, envs: envs,
                                                                onStdout: receive("stdout"), onStderr: receive("stderr")))
            lock.withLock { job.handle = handle; if job.status == "starting" { job.status = "running" } }
            Task { [self] in
                do { let result = try await handle.wait(); await completed(job, result, nil) }
                catch { await completed(job, nil, error) }
            }
        } catch { await completed(job, nil, error) }
        return status()
    }

    func statusWait(_ waitSeconds: Int) async -> JSONValue {
        let job = lock.withLock { current }
        if let job, Self.active.contains(lock.withLock { job.status }), waitSeconds > 0 {
            let abort = AbortSignal()
            let id = signal?.onAbort { abort.abort() }
            Task { _ = await job.done.settled(); abort.abort() }
            await abort.sleep(Double(waitSeconds))
            if let id { signal?.removeListener(id) }
        }
        return status()
    }

    public func assertIdle() throws {
        try lock.withLock {
            if let job = current, Self.active.contains(job.status) {
                throw SandboxError("Dependency installation is \(job.status). Use read_file/list_files to inspect in parallel, or dependency_install action=stop before commands or file edits.")
            }
        }
    }

    public func assertReady() throws {
        try assertIdle()
        if !["succeeded", "skipped"].contains(status()["status"]?.string ?? "") {
            throw SandboxError("Dependency installation has not succeeded. Use dependency_install to start/retry it, or explicitly skip it with a reason after verifying no install is needed.")
        }
    }

    /// Writes the helper, inspects the repository and starts the planned install when the plan is clear.
    public func prepare() async throws -> JSONValue {
        try await sandbox.writeFile(Self.helper, try SandboxResources.text("install-job.py"))
        do {
            let result = try await sandbox.run("python3 \(Self.helper) inspect", timeoutMs: 20_000)
            if result.exitCode != 0 || result.stdout.utf16.count > 64_000 { throw SandboxError("Preflight needs agent inspection") }
            let parsed = try JSONValue.parse(result.stdout)
            lock.withLock { facts = parsed; initial = InstallPlanner.plan(parsed) }
        } catch {
            lock.withLock { initial = ["status": "needs_agent", "reason": "Automatic preflight was inconclusive; inspect the repository and choose an install plan."] }
        }
        try signal?.throwIfAborted()
        let plan = lock.withLock { initial }
        if plan["status"]?.string == "planned" {
            _ = try await start(command: plan["command"]?.string, cwd: plan["cwd"]?.string ?? ".")
        } else { emit(["phase": "setup", "status": "working", "message": plan["reason"] ?? .null]) }
        return Redact.value(["install": status(), "repository": lock.withLock { facts }], secrets)
    }

    public func list(_ path: String = ".") async throws -> JSONValue {
        let result = try await sandbox.run("python3 \(Self.helper) list \(Shell.quote(path))", timeoutMs: 10_000, signal: signal)
        if result.exitCode != 0 || result.stdout.utf16.count > 64_000 { throw SandboxError("Could not list repository files") }
        guard let value = try? JSONValue.parse(result.stdout) else { throw SandboxError("Could not list repository files") }
        return Redact.value(value, secrets)
    }

    public func control(_ args: [String: JSONValue]) async throws -> JSONValue {
        switch args["action"]?.string {
        case "start":
            return try await start(command: args["command"]?.string, cwd: args["cwd"]?.string ?? ".", parallel: args["parallel"],
                                   timeoutSeconds: args["timeout_seconds"]?.int ?? 600)
        case "stop": return try await stop()
        case "status": return await statusWait(args["wait_seconds"]?.int ?? 0)
        default:
            try assertIdle()
            let reason = args["reason"]?.string ?? ""
            let previous = status()["status"] ?? .null
            lock.withLock { initial = ["status": "skipped", "reason": .string(reason), "previous_status": previous]; current = nil }
            emit(["phase": "setup", "status": "working", "stage": "install", "message": .string("Dependency installation skipped: \(reason)")])
            return status()
        }
    }

    public func close() async throws {
        lock.withLock { closed = true }
        try await stop()
    }
}
