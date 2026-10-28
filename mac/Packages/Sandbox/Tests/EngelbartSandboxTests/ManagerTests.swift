import XCTest
import EngelbartCore
@testable import EngelbartSandbox

final class FakeWorker: SandboxWorkerHandle, @unchecked Sendable {
    let done = Deferred<Void>()
    let request: JSONValue
    let onEvent: (JSONValue) async throws -> JSONValue?
    init(request: JSONValue, onEvent: @escaping (JSONValue) async throws -> JSONValue?) { self.request = request; self.onEvent = onEvent }
    @discardableResult func receive(_ event: JSONValue) async throws -> JSONValue? {
        var o = event.object ?? [:]
        o["run_id"] = request["run_id"]
        return try await onEvent(.object(o))
    }
    func finish() { done.resolve(()) }
    func detach() async throws { finish() }
    func stop() async throws { _ = try? await receive(["event": "stopped"]); finish() }
}

final class FakeTerminals: SandboxTerminalControl, @unchecked Sendable {
    let opened = Locked<[SandboxShellSpec]>([])
    let closed = Locked<[String]>([])
    let order: Locked<[String]>?
    init(order: Locked<[String]>? = nil) { self.order = order }
    func open(_ spec: SandboxShellSpec) throws -> JSONValue { opened.with { $0.append(spec) }; return ["id": .string("session-\(opened.value.count)"), "provider": "sandbox"] }
    func close(_ libraryId: String) async { closed.with { $0.append(libraryId) } }
    func closeAll() async { order?.with { $0.append("terminals") } }
}

// test/sandbox-manager.test.cjs
final class ManagerTests: XCTestCase {
    final class Fixture: @unchecked Sendable {
        let ctx: SandboxContext
        var manager: SandboxManager!
        let events = Locked<[JSONValue]>([])
        let starts = Locked<[FakeWorker]>([])
        let controls = Locked<[JSONValue]>([])
        let envs = Locked<[(String, [String: String])]>([])
        let probe = Locked<Result<JSONValue, SandboxError>>(.success(["state": "ready"]))
        let order = Locked<[String]>([])
        let repo: String
        var store: RunStore { RunStore(ctx.db) }
        init(ctx: SandboxContext, repo: String) { self.ctx = ctx; self.repo = repo }
        var lastEvent: JSONValue? { events.value.last }
    }

    func fixture(readEnv: [String: String] = [:], e2bKey: @escaping () async throws -> String? = { "e2b_signed_in" }, githubLogin: String = "octocat",
                 repoAccess: SandboxRepoAccess? = nil, claudeReady: @escaping () async throws -> Void = {}, e2b: E2BService? = nil,
                 terminals: SandboxTerminalControl? = nil, now: @escaping Clock = systemClock) throws -> Fixture {
        let db = try database()
        let root = temporaryDirectory()
        let repo = try db.insertLibrary(name: "owner/app", url: "https://github.com/owner/app")
        let f = Fixture(ctx: SandboxContext(dataRoot: root, db: db), repo: repo)
        var o = SandboxManager.Options(notify: { e in f.events.with { $0.append(e) } }, launch: { request, env, onEvent in
            f.envs.with { $0.append((request["command"]!.string!, env)) }
            let command = request["command"]!.string!
            let worker = FakeWorker(request: request, onEvent: onEvent)
            if !["start", "restart"].contains(command) {
                f.controls.with { $0.append(request) }
                Task {
                    if command == "pause" { f.order.with { $0.append("pause") } }
                    do {
                        let result: JSONValue
                        if command == "kill" { result = ["state": "gone"] } else {
                            switch f.probe.value {
                            case .success(let v): result = v
                            case .failure(let e): if ["probe", "can_restart"].contains(command) { throw e }; result = ["state": "ready"]
                            }
                        }
                        var o = result.object!; o["event"] = "result"
                        _ = try await worker.receive(.object(o))
                        worker.finish()
                    } catch { worker.done.reject(error) }
                }
                return worker
            }
            f.starts.with { $0.append(worker) }
            return worker
        })
        o.readEnv = { _ in readEnv }
        o.secure = MemorySecure()
        o.e2bKey = e2bKey
        o.githubLogin = { githubLogin }
        o.repoAccess = repoAccess
        o.claudeReady = claudeReady
        o.e2b = e2b
        o.terminals = terminals
        o.now = now
        o.pollEvery = nil
        f.manager = SandboxManager(o)
        return f
    }

    func id(_ run: SandboxRun?) -> String { run!["id"]!.string! }

    func testDuplicateStartsReuseOneRunProgressReadyAndStop() async throws {
        let f = try fixture()
        async let a = f.manager.start(f.ctx, f.repo)
        async let b = f.manager.start(f.ctx, f.repo)
        let (ra, rb) = try await (a, b)
        XCTAssertEqual(id(ra), id(rb))
        XCTAssertEqual(f.starts.value.count, 1)
        let worker = f.starts.value[0]
        XCTAssertEqual(worker.request["github_login"], "octocat")
        try await worker.receive(["event": "sandbox_created", "sandbox_id": "sb-123"])
        try await worker.receive(["event": "progress", "message": "Installing dependencies", "kind": "command", "data": ["phase": "stage", "stage": "install", "command": "npm ci"]])
        XCTAssertEqual(try f.store.get(id(ra))?["build_log"]?.array?.last?["data"], ["phase": "stage", "stage": "install", "command": "npm ci"])
        XCTAssertEqual(f.lastEvent?["run"]?["build_log"]?.array?.last?["kind"], "command")
        XCTAssertEqual(try f.store.get(id(ra))?["sandbox_id"], "sb-123")
        try await worker.receive(["event": "ready", "preview_url": "https://preview.example", "port": 3000])
        XCTAssertEqual(try f.store.get(id(ra))?["status"], "ready")
        XCTAssertEqual(try f.store.get(id(ra))?["preview_url"], "https://preview.example/")
        XCTAssertEqual(f.lastEvent?["notification"], "preview-ready", "completion notifies without changing panes")
        XCTAssertFalse(f.events.value.contains { $0["open"] != nil })
        XCTAssertEqual(try f.store.get(id(ra))?["build_log"]?.array?.map { $0["message"]!.string! }, ["Starting repository setup", "Sandbox created", "Installing dependencies", "Preview ready"])
        try await worker.receive(["event": "ready", "preview_url": "https://preview.example", "port": 3000])
        XCTAssertEqual(try f.store.get(id(ra))?["build_log"]?.array?.filter { $0["message"] == "Preview ready" }.count, 1, "duplicates ignored")
        _ = try await f.manager.start(f.ctx, f.repo)
        XCTAssertEqual(f.starts.value.count, 1, "a ready run is probed and reused")
        XCTAssertTrue(f.controls.value.contains { $0["command"] == "probe" })
        _ = try await f.manager.stop(f.ctx, id(ra))
        try? await worker.receive(["event": "ready", "preview_url": "https://preview.example", "port": 3000])
        XCTAssertEqual(try f.store.get(id(ra))?["status"], "stopped", "late events cannot revive a stopped run")
        XCTAssertEqual(try f.ctx.db.libraryRow(f.repo)?["name"], "owner/app")
    }

    func testEnvironmentRestartHandsOffTheSameSandbox() async throws {
        let f = try fixture()
        let first = try await f.manager.saveEnvironment(f.ctx, f.repo, [EnvironmentChange(name: "KEY", value: "old-secret")], revision: nil)
        let run = try await f.manager.start(f.ctx, f.repo)
        XCTAssertEqual(f.starts.value[0].request["environment"]?["values"]?["KEY"], "old-secret")
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "retained-sandbox"])
        try await f.starts.value[0].receive(["event": "ready", "preview_url": "https://preview.example", "port": 3000])
        let saved = try await f.manager.saveEnvironment(f.ctx, f.repo, [EnvironmentChange(name: "KEY", value: nil), EnvironmentChange(name: "NEXT", value: "new-secret")], revision: first.revision)
        let restarted = try await f.manager.restart(f.ctx, f.repo)
        XCTAssertEqual(id(restarted), id(run))
        XCTAssertEqual(restarted["sandbox_id"], "retained-sandbox")
        XCTAssertEqual(restarted["status"], "starting")
        XCTAssertEqual(restarted["env_revision"]?.string, saved.revision)
        XCTAssertEqual(f.starts.value[1].request["command"], "restart")
        XCTAssertEqual(f.starts.value[1].request["environment"]?["values"], ["NEXT": "new-secret"])
        XCTAssertEqual(f.starts.value[1].request["environment"]?["removed"], ["KEY"])
        XCTAssertFalse(f.controls.value.contains { $0["command"] == "kill" })
        XCTAssertFalse(JSONValue.array(f.events.value).text().contains("new-secret"))
        try await f.starts.value[1].receive(["event": "ready", "preview_url": "https://preview.example/v2", "port": 3000])
        XCTAssertEqual(f.lastEvent?["notification"], "preview-ready")
        XCTAssertEqual(try f.ctx.db.query("select * from sandbox_runs", []).count, 1)
    }

    func testRestartPreflightFailureLeavesThePreview() async throws {
        let f = try fixture()
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "same-machine"])
        try await f.starts.value[0].receive(["event": "ready", "preview_url": "https://preview.example", "port": 3000])
        f.probe.with { $0 = .failure(SandboxError("Cannot confirm the adapter")) }
        await assertThrows(try await f.manager.restart(f.ctx, f.repo), "Cannot confirm")
        XCTAssertEqual(try f.store.get(id(run))?["status"], "ready")
        XCTAssertEqual(f.starts.value.count, 1)
        f.probe.with { $0 = .success(["state": "restartable"]) }
        _ = try await f.manager.restart(f.ctx, f.repo)
        XCTAssertEqual(f.starts.value[1].request["sandbox_id"], "same-machine")
        try await f.starts.value[1].receive(["event": "failed", "error": "bad config"])
        _ = try await f.manager.restart(f.ctx, f.repo)
        XCTAssertEqual(f.starts.value.count, 3, "a failed restart can retry")
        _ = try await f.manager.stop(f.ctx, id(run))
        XCTAssertEqual(try f.store.get(id(run))?["status"], "stopped")
    }

    func testAutomaticPreparationOncePerSessionRespectsStopAndFailures() async throws {
        let f = try fixture()
        let first = try await f.manager.start(f.ctx, f.repo, automatic: true)
        let duplicate = try await f.manager.start(f.ctx, f.repo, automatic: true)
        XCTAssertEqual(id(first), id(duplicate))
        _ = try await f.manager.stop(f.ctx, id(first))
        try await assertEqualAsync(try await f.manager.start(f.ctx, f.repo, automatic: true)?["status"], "stopped")
        XCTAssertEqual(f.starts.value.count, 1)
        let retry = try await f.manager.start(f.ctx, f.repo)
        XCTAssertNotEqual(id(retry), id(first))
        // As manager.cjs: a failed retry is not prepared again in the same session (closing would stop the starting run,
        // so a "new session" cannot reuse it; the Electron test checks this instead).
        try await f.starts.value[1].receive(["event": "failed", "error": "Build failed"])
        f.starts.value[1].finish()
        try await assertEqualAsync(id(try await f.manager.start(f.ctx, f.repo, automatic: true)), id(retry))
        XCTAssertEqual(f.starts.value.count, 2)
    }

    func testFailedAttemptsStayAndRetryCreatesNewRun() async throws {
        let f = try fixture()
        let first = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "failed", "error": "Install failed"])
        f.starts.value[0].finish()
        let retry = try await f.manager.start(f.ctx, f.repo)
        XCTAssertNotEqual(id(retry), id(first))
        XCTAssertEqual(try f.store.get(id(first))?["error"], "Install failed")
        XCTAssertNotEqual(try f.store.get(id(first))?["finished_at"], .null)
        XCTAssertEqual(try f.ctx.db.query("select * from sandbox_runs", []).count, 2)
    }

    func testDesktopFailuresAndExpiredRunsAreNotRebuiltAutomatically() async throws {
        let f = try fixture()
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "failed", "error": "Desktop apps are not supported yet: this repository is an Electron app"])
        f.starts.value[0].finish()
        await f.manager.close()
        try await assertEqualAsync(id(try await f.manager.start(f.ctx, f.repo, automatic: true)), id(run))
        XCTAssertEqual(f.starts.value.count, 1)
        try await assertEqualAsync(try await f.manager.start(f.ctx, f.repo)?["status"], "starting", "Run still does")
    }

    func testUncertainChecksNeverDuplicateAndStaleRunsRetry() async throws {
        let f = try fixture()
        let stale = try f.store.create(f.repo)!
        try f.store.update(id(stale), [("sandbox_id", "sb-old")])
        f.probe.with { $0 = .failure(SandboxError("Network timeout")) }
        await assertThrows(try await f.manager.start(f.ctx, f.repo), "Network timeout")
        XCTAssertEqual(f.starts.value.count, 0)
        XCTAssertEqual(try f.store.get(id(stale))?["status"], "starting")
        f.probe.with { $0 = .success(["state": "inactive"]) }
        let retry = try await f.manager.start(f.ctx, f.repo)
        XCTAssertNotEqual(id(retry), id(stale))
        XCTAssertEqual(try f.store.get(id(stale))?["status"], "failed")
        XCTAssertEqual(try f.store.get(id(stale))?["error"], "Setup was interrupted. Retry to start a new run.")
        XCTAssertTrue(f.controls.value.contains { $0["command"] == "kill" && $0["sandbox_id"] == "sb-old" })
    }

    func testNonGithubEntriesAndLaunchErrors() async throws {
        let f = try fixture()
        let other = try (f.ctx.db as! SQLiteSandboxDatabase).insertLibrary(name: "notes", url: "https://example.com", tags: [])
        try await assertNilAsync(try await f.manager.start(f.ctx, other))
        var o = SandboxManager.Options(notify: { _ in }, launch: { _, _, _ in throw SandboxError("Cannot launch worker") })
        o.e2bKey = { "k" }; o.pollEvery = nil; o.secure = MemorySecure()
        let broken = SandboxManager(o)
        let run = try await broken.start(f.ctx, f.repo)
        XCTAssertEqual(run?["status"], "failed")
        XCTAssertEqual(try f.store.get(id(run))?["error"], "Cannot launch worker")
    }

    func testRecoveryPersistsAnOrphanHandleThenCleansUp() async throws {
        let f = try fixture()
        let previous = try f.store.create(f.repo)!
        f.probe.with { $0 = .success(["state": "interrupted", "sandbox_id": "sb-recovered"]) }
        _ = try await f.manager.start(f.ctx, f.repo)
        let saved = try f.store.get(id(previous))!
        XCTAssertEqual(saved["sandbox_id"], "sb-recovered")
        XCTAssertEqual(saved["status"], "failed")
        XCTAssertTrue(f.controls.value.contains { $0["command"] == "kill" && $0["sandbox_id"] == "sb-recovered" })
    }

    func testOnlyTheSignedInKeyReachesWorkers() async throws {
        let f = try fixture(readEnv: ["E2B_API_KEY": "e2b_configured", "E2B_TEMPLATE": "custom"], e2bKey: { "e2b_from_github" })
        let run = try await f.manager.start(f.ctx, f.repo)
        XCTAssertEqual(f.envs.value[0].1, ["E2B_TEMPLATE": "custom", "E2B_API_KEY": "e2b_from_github"])
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb"])
        _ = try await f.manager.stop(f.ctx, id(run))
        XCTAssertEqual(f.envs.value.first { $0.0 == "kill" }?.1["E2B_API_KEY"], "e2b_from_github")
        XCTAssertFalse(f.envs.value.contains { $0.1["E2B_API_KEY"] == "e2b_configured" })
    }

    func testExplicitStartWithoutKeyOrClaudeRecordsNothing() async throws {
        let signedOut = try fixture(e2bKey: { nil })
        await assertThrows(try await signedOut.manager.start(signedOut.ctx, signedOut.repo), "^Sign in to GitHub in Engelbart to use sandboxes\\.$")
        XCTAssertEqual(signedOut.starts.value.count, 0)
        XCTAssertEqual(try signedOut.store.latest().count, 0)
        let refused = try fixture(e2bKey: { throw SandboxError("E2B key request failed (401)") })
        await assertThrows(try await refused.manager.start(refused.ctx, refused.repo), "Could not get the E2B key for your GitHub sign-in: E2B key request failed \\(401\\)")
        XCTAssertEqual(try refused.store.latest().count, 0)
        let claude = try fixture(claudeReady: { throw SandboxError(LocalClaude.notInstalled) })
        await assertThrows(try await claude.manager.start(claude.ctx, claude.repo), "^Claude Code is not installed yet")
        XCTAssertEqual(try claude.store.latest().count, 0)
    }

    func testAutomaticAndSaveStartsWaitForKeyAndClaude() async throws {
        let key = Locked<String?>(nil)
        let f = try fixture(e2bKey: { key.value })
        try await assertNilAsync(try await f.manager.start(f.ctx, f.repo, automatic: true))
        XCTAssertEqual(try f.store.latest().count, 0, "no failed run while signed out")
        key.with { $0 = "e2b" }
        try await assertEqualAsync(try await f.manager.start(f.ctx, f.repo, automatic: true)?["status"], "starting")
        _ = try await f.manager.start(f.ctx, f.repo, automatic: true)
        XCTAssertEqual(f.starts.value.count, 1, "still once per session after the key arrived")
        let ready = Locked(false)
        let g = try fixture(claudeReady: { if !ready.value { throw SandboxError(LocalClaude.signedOut) } })
        try await assertNilAsync(try await g.manager.start(g.ctx, g.repo, waitForClaude: true))
        try await assertNilAsync(try await g.manager.start(g.ctx, g.repo, automatic: true))
        XCTAssertEqual(try g.store.latest().count, 0)
        ready.with { $0 = true }
        try await assertEqualAsync(try await g.manager.start(g.ctx, g.repo, automatic: true)?["status"], "starting", "the preparation after the sign-in starts it")
        XCTAssertEqual(g.starts.value.count, 1)
    }

    func testRestartWithoutKeyInterruptsNothing() async throws {
        let key = Locked<String?>("e2b")
        let f = try fixture(e2bKey: { key.value })
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb"])
        try await f.starts.value[0].receive(["event": "ready", "preview_url": "https://p.example", "port": 3000])
        key.with { $0 = nil }
        await assertThrows(try await f.manager.restart(f.ctx, f.repo), "Sign in to GitHub")
        XCTAssertFalse(f.controls.value.contains { $0["command"] == "can_restart" })
        XCTAssertEqual(try f.store.get(id(run))?["status"], "ready")
    }

    func testGithubLoginOnlyValid() async throws {
        for login in ["bad login", "-starts", String(repeating: "a", count: 40)] {
            let g = try fixture(githubLogin: login)
            _ = try await g.manager.start(g.ctx, g.repo)
            XCTAssertNil(g.starts.value[0].request["github_login"], login)
        }
    }

    func testSignedOutStopsLiveRunsThroughTheirWorkers() async throws {
        let asked = Locked(0)
        let signedIn = Locked(true)
        let f = try fixture(e2bKey: { if !signedIn.value { asked.with { $0 += 1 }; return nil }; return "e2b" })
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb-signed-out"])
        f.controls.with { $0 = [] }
        signedIn.with { $0 = false }
        await f.manager.signedOut()
        let stopped = try f.store.get(id(run))!
        XCTAssertEqual(stopped["status"], "stopped")
        XCTAssertEqual(stopped["sandbox_id"], "sb-signed-out")
        XCTAssertTrue(stopped["build_log"]!.array!.contains { $0["message"] == "Stopping: signed out of GitHub" })
        XCTAssertEqual(f.controls.value.count, 0, "the worker stopped its own sandbox")
        XCTAssertEqual(asked.value, 0)
        await f.manager.poll()
        XCTAssertEqual(f.controls.value.count, 0, "checks wait while signed out")
    }

    func testReleaseStopsAndForgetsOrKeepsEverything() async throws {
        let f = try fixture()
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb-release"])
        XCTAssertThrowsError(try f.ctx.db.query("delete from library where id = ?", [.string(f.repo)]))
        try await f.manager.release(f.ctx, f.repo)
        XCTAssertTrue(f.controls.value.contains { $0["command"] == "kill" && $0["sandbox_id"] == "sb-release" })
        XCTAssertNil(try f.store.get(id(run)))
        XCTAssertNoThrow(try f.ctx.db.query("delete from library where id = ?", [.string(f.repo)]))
        let g = try fixture()
        let stuck = try g.store.create(g.repo)!
        try g.store.update(id(stuck), [("status", "failed")])
        _ = try g.ctx.db.query("update sandbox_runs set sandbox_id = 'sb-stuck' where id = ?", [.string(id(stuck))])
        g.probe.with { $0 = .failure(SandboxError("E2B unreachable")) }
        var o = g.manager.o
        o.launch = { request, _, onEvent in
            let w = FakeWorker(request: request, onEvent: onEvent)
            w.done.reject(SandboxError("E2B unreachable"))
            return w
        }
        let failing = SandboxManager(o)
        await assertThrows(try await failing.release(g.ctx, g.repo), "E2B unreachable")
        XCTAssertEqual(try g.store.get(id(stuck))?["sandbox_id"], "sb-stuck")
    }

    final class Access: SandboxRepoAccess, @unchecked Sendable {
        let asked = Locked<[String]>([])
        var info = RepoAccessInfo(isPrivate: true, docker: true, branch: "main")
        var fail: String?
        func describe(_ repo: GithubRepo) async throws -> RepoAccessInfo {
            asked.with { $0.append("describe \(repo.url)") }
            if let fail { throw SandboxError(fail) }
            return info
        }
        func archive(_ repo: GithubRepo) async throws -> String { asked.with { $0.append("archive \(repo.url)") }; return "https://codeload.github.com/owner/app/legacy.tar.gz/main?token=LINK" }
    }

    func testPrivateRepositoryLinkRidesTheAckOnly() async throws {
        let access = Access()
        let f = try fixture(repoAccess: access)
        let run = try await f.manager.start(f.ctx, f.repo)
        let worker = f.starts.value[0]
        XCTAssertEqual(worker.request["docker"], true)
        XCTAssertEqual(access.asked.value, ["describe https://github.com/owner/app"])
        XCTAssertNil(worker.request["archive_url"])
        let reply = try await worker.receive(["event": "sandbox_created", "sandbox_id": "sb"])
        XCTAssertEqual(reply, ["archive_url": "https://codeload.github.com/owner/app/legacy.tar.gz/main?token=LINK", "branch": "main"])
        XCTAssertEqual(access.asked.value.last, "archive https://github.com/owner/app")
        try await assertNilAsync(try await worker.receive(["event": "progress", "message": "Cloning repository"]))
        XCTAssertFalse(try f.store.get(id(run))!.text().contains("token=LINK"))
        XCTAssertFalse(JSONValue.array(f.events.value).text().contains("token=LINK"))
        let hidden = Access(); hidden.fail = "Engelbart's GitHub App cannot see owner/app."
        let h = try fixture(repoAccess: hidden)
        let failed = try await h.manager.start(h.ctx, h.repo)
        XCTAssertEqual(failed?["status"], "failed")
        XCTAssertEqual(failed?["error"], "Engelbart's GitHub App cannot see owner/app.")
        XCTAssertEqual(h.starts.value.count, 0)
    }

    func testSleepingSandboxKeepsItsRunReady() async throws {
        let f = try fixture()
        let run = try await f.manager.start(f.ctx, f.repo)
        let worker = f.starts.value[0]
        try await worker.receive(["event": "sandbox_created", "sandbox_id": "sb"])
        try await worker.receive(["event": "ready", "preview_url": "https://p.example", "port": 3000])
        XCTAssertEqual(f.lastEvent?["sandbox"], "running", "ready is running")
        try await worker.receive(["event": "paused"])
        worker.finish()
        await settle()
        let asleep = try f.store.get(id(run))!
        XCTAssertEqual(asleep["status"], "ready")
        XCTAssertEqual(asleep["build_log"]?.array?.last?["message"], "Paused after 10 minutes unused")
        XCTAssertEqual(f.lastEvent?["sandbox"], "asleep")
        f.probe.with { $0 = .success(["state": "paused"]) }
        await f.manager.poll()
        XCTAssertEqual(try f.store.get(id(run))?["status"], "ready")
        XCTAssertFalse(f.controls.value.contains { $0["command"] == "kill" })
        XCTAssertFalse(f.events.value.contains { ($0["message"]?.string ?? "").matches("unreachable|failed", options: .caseInsensitive) })
        try await assertEqualAsync(id(try await f.manager.start(f.ctx, f.repo)), id(run), "opening it again reuses it")
        XCTAssertEqual(f.lastEvent?["message"], "Paused; opening the preview wakes it")
        XCTAssertEqual(f.starts.value.count, 1)
        f.probe.with { $0 = .success(["state": "ready"]) }
        await f.manager.poll()
        XCTAssertEqual(f.lastEvent?["sandbox"], "running")
        try await assertEqualAsync(try f.manager.list(f.ctx).first?["sandbox"], "running")
    }

    func testTouchIsThrottledAndNeverWakes() async throws {
        let clock = Locked(Time.ms(Time.parse("2026-10-02T12:00:00.000Z")!))
        let e2b = FakeE2B()
        let f = try fixture(e2b: e2b, now: { clock.value })
        try await f.manager.touch(f.ctx, f.repo)
        XCTAssertEqual(e2b.calls.value.count, 0, "no run")
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb-sleepy"])
        try await f.starts.value[0].receive(["event": "ready", "preview_url": "https://p.example", "port": 3000])
        try await f.manager.touch(f.ctx, f.repo)
        XCTAssertEqual(e2b.calls.value, ["setTimeout sb-sleepy 600000"])
        XCTAssertEqual(e2b.keys.value, ["e2b_signed_in"])
        XCTAssertEqual(try f.store.get(id(run))?["last_opened_at"], "2026-10-02T12:00:00.000Z")
        clock.with { $0 += 10_000 }
        try await f.manager.touch(f.ctx, f.repo)
        XCTAssertEqual(e2b.calls.value.count, 1, "throttled")
        clock.with { $0 += 25_000 }
        try await f.manager.touch(f.ctx, f.repo)
        XCTAssertEqual(e2b.calls.value.count, 2)
        XCTAssertEqual(try f.store.get(id(run))?["last_opened_at"], "2026-10-02T12:00:35.000Z")
        e2b.setTimeoutHandler = { _, _ in throw SandboxError("Sandbox not found", name: "SandboxNotFoundError", status: 404) }
        clock.with { $0 += 60_000 }
        try await f.manager.touch(f.ctx, f.repo)
        XCTAssertEqual(try f.store.get(id(run))?["status"], "ready")
        XCTAssertFalse(f.controls.value.contains { $0["command"] == "kill" })
        XCTAssertEqual(f.starts.value.count, 1, "no worker for a ping")
        XCTAssertFalse(e2b.calls.value.contains { $0.hasPrefix("connect") }, "a ping never wakes")
    }

    func testQuitSleepsReadyPreviewsAndStopsSetups() async throws {
        let f = try fixture()
        let ready = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb-ready"])
        try await f.starts.value[0].receive(["event": "ready", "preview_url": "https://p.example", "port": 3000])
        let other = try (f.ctx.db as! SQLiteSandboxDatabase).insertLibrary(name: "owner/other", url: "https://github.com/owner/other")
        let starting = try await f.manager.start(f.ctx, other)
        try await f.starts.value[1].receive(["event": "sandbox_created", "sandbox_id": "sb-starting"])
        f.probe.with { $0 = .success(["state": "paused", "paused": true]) }
        await f.manager.dispose()
        XCTAssertTrue(f.controls.value.contains { $0["command"] == "pause" && $0["sandbox_id"] == "sb-ready" })
        let asleep = try f.store.get(id(ready))!
        XCTAssertEqual(asleep["status"], "ready")
        XCTAssertEqual(asleep["build_log"]?.array?.last?["message"], "Paused when Engelbart quit")
        XCTAssertEqual(try f.store.get(id(starting))?["status"], "stopped", "its own worker stopped it")
    }

    func testSweepEndsSandboxesAsleepAndUnopenedForSevenDays() async throws {
        let now = Time.ms(Time.parse("2026-10-20T12:00:00.000Z")!)
        let f = try fixture(now: { now })
        func readyRun(_ name: String, sandbox: String, opened: String?, created: String) throws -> String {
            let lib = try (f.ctx.db as! SQLiteSandboxDatabase).insertLibrary(name: name, url: "https://github.com/owner/\(name)")
            let run = try f.store.create(lib)!
            _ = try f.ctx.db.query("update sandbox_runs set status = 'ready', sandbox_id = ?, preview_url = 'https://p.example/', port = 3000, created_at = ?, last_opened_at = ? where id = ?",
                                   [.string(sandbox), .string(created), opened.map { .string($0) } ?? .null, run["id"]!])
            return run["id"]!.string!
        }
        let old = try readyRun("old", sandbox: "sb-old", opened: "2026-10-10T12:00:00.000Z", created: "2026-10-01T00:00:00.000Z")
        let neverOpened = try readyRun("never", sandbox: "sb-sleepy", opened: nil, created: "2026-10-05T00:00:00.000Z")
        let recent = try readyRun("recent", sandbox: "sb-recent", opened: "2026-10-18T12:00:00.000Z", created: "2026-10-01T00:00:00.000Z")
        _ = try f.manager.list(f.ctx)
        f.probe.with { $0 = .success(["state": "paused"]) }
        await f.manager.poll()
        let ended = try f.store.get(old)!
        XCTAssertEqual(ended["status"], "stopped")
        XCTAssertEqual(ended["error"], .null)
        XCTAssertEqual(ended["build_log"]?.array?.last?["message"], "Stopped after 7 days unopened")
        XCTAssertEqual(ended["build_log"]?.array?.last?["data"]?["lifecycle"], "expired")
        XCTAssertTrue(SandboxSleep.expiredRun(ended))
        XCTAssertEqual(try f.store.get(neverOpened)?["status"], "stopped", "never opened: counted from its creation")
        XCTAssertEqual(try f.store.get(recent)?["status"], "ready")
        XCTAssertEqual(Set(f.controls.value.filter { $0["command"] == "kill" }.map { $0["sandbox_id"]!.string! }), ["sb-old", "sb-sleepy"])
        // An expired preview is not rebuilt by a new session's preparation, only when it is opened.
        let lib = try f.store.get(old)!["library_id"]!.string!
        try await assertEqualAsync(id(try await f.manager.start(f.ctx, lib, automatic: true)), old)
        XCTAssertEqual(f.starts.value.count, 0)
        try await assertEqualAsync(try await f.manager.start(f.ctx, lib)?["status"], "starting")
    }

    let terminal: JSONValue = ["cwd": "cli", "hint": "python main.py --help"]

    func testDeclaredKindAndTerminalReady() async throws {
        let f = try fixture()
        let run = try await f.manager.start(f.ctx, f.repo)
        let worker = f.starts.value[0]
        try await worker.receive(["event": "sandbox_created", "sandbox_id": "sb-terminal"])
        try await worker.receive(["event": "progress", "message": "Used from a terminal", "data": ["phase": "kind", "kind": "terminal", "reason": "A Python CLI with no server"]])
        var current = try f.store.get(id(run))!
        XCTAssertEqual([current["status"], current["kind"], current["kind_reason"]], ["starting", "terminal", "A Python CLI with no server"])
        try await worker.receive(["event": "progress", "message": "x", "data": ["phase": "kind", "kind": "desktop", "reason": "?"]])
        XCTAssertEqual(try f.store.get(id(run))?["kind"], "terminal", "an unknown kind is not kept")
        for bad: JSONValue in [["kind": "terminal"], ["kind": "terminal", "terminal": ["cwd": "../out", "hint": "x"]], ["kind": "terminal", "terminal": ["cwd": ".", "hint": "a\nb"]],
                               ["kind": "interface"], ["kind": "nope", "port": 3000, "preview_url": "https://p.example"]] {
            var event = bad.object!; event["event"] = "ready"
            await assertThrows(try await worker.receive(.object(event)), "Invalid ready event")
        }
        XCTAssertEqual(try f.store.get(id(run))?["status"], "starting")
        try await worker.receive(["event": "ready", "kind": "terminal", "terminal": terminal])
        current = try f.store.get(id(run))!
        XCTAssertEqual([current["status"], current["kind"], current["terminal"], current["preview_url"], current["port"]], ["ready", "terminal", terminal, .null, .null])
        XCTAssertEqual(current["build_log"]?.array?.last?["message"], "Terminal ready")
        XCTAssertEqual(current["build_log"]?.array?.last?["data"], ["phase": "ready", "kind": "terminal"])
        XCTAssertEqual(f.lastEvent?["notification"], "preview-ready")
        worker.finish()
        await settle()
        XCTAssertEqual(try f.store.get(id(run))?["status"], "ready", "a ready terminal's worker leaving is not a failure")
        for state in ["running", "inactive", "unreachable", "ready"] {
            f.probe.with { $0 = .success(["state": .string(state)]) }
            await f.manager.poll()
            XCTAssertEqual(try f.store.get(id(run))?["status"], "ready", state)
        }
        XCTAssertTrue(f.controls.value.filter { $0["command"] == "probe" }.allSatisfy { $0["kind"] == "terminal" && $0["preview_url"] == .null })
        XCTAssertFalse(f.controls.value.contains { $0["command"] == "kill" })
        f.probe.with { $0 = .success(["state": "gone"]) }
        await f.manager.poll()
        XCTAssertEqual(try f.store.get(id(run))?["status"], "stopped")
    }

    func testTerminalOpensWithSavedValuesAndClosesWithItsSandbox() async throws {
        let terminals = FakeTerminals()
        let f = try fixture(terminals: terminals)
        await assertThrows(try await f.manager.terminal(f.ctx, f.repo), "no sandbox terminal yet")
        _ = try await f.manager.saveEnvironment(f.ctx, f.repo, [EnvironmentChange(name: "API_TOKEN", value: "saved-secret")], revision: nil)
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb-terminal"])
        try await f.starts.value[0].receive(["event": "ready", "kind": "terminal", "terminal": terminal])
        let session = try await f.manager.terminal(f.ctx, f.repo)
        XCTAssertEqual(session["provider"], "sandbox")
        let spec = terminals.opened.value[0]
        XCTAssertEqual([spec.libraryId, spec.sandboxId, spec.title, spec.cwd, spec.hint], [f.repo, "sb-terminal", "owner/app (sandbox)", "/home/user/repository/cli", "python main.py --help"])
        XCTAssertEqual(spec.envs, ["API_TOKEN": "saved-secret"])
        try await assertEqualAsync(try await spec.apiKey(), "e2b_signed_in")
        XCTAssertNotEqual(try f.store.get(id(run))?["last_opened_at"], .null, "opening it counts as opening the run")
        let before = terminals.closed.value.count
        _ = try await f.manager.stop(f.ctx, id(run))
        XCTAssertGreaterThan(terminals.closed.value.count, before, "Stop")
        await assertThrows(try await f.manager.terminal(f.ctx, f.repo), "no sandbox terminal yet")
        var o = f.manager.o; o.terminals = nil
        await assertThrows(try await SandboxManager(o).terminal(f.ctx, f.repo), "Sandbox terminals are unavailable")
    }

    func testBothAndTerminalRestartRestartsTheShell() async throws {
        let terminals = FakeTerminals()
        let f = try fixture(terminals: terminals)
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb-both"])
        try await f.starts.value[0].receive(["event": "ready", "kind": "both", "preview_url": "https://preview.example", "port": 5173, "terminal": terminal])
        let current = try f.store.get(id(run))!
        XCTAssertEqual([current["kind"], current["preview_url"], current["port"], current["terminal"]], ["both", "https://preview.example/", 5173, terminal])
        let other = try (f.ctx.db as! SQLiteSandboxDatabase).insertLibrary(name: "owner/cli", url: "https://github.com/owner/cli")
        let shell = try await f.manager.start(f.ctx, other)
        try await f.starts.value[1].receive(["event": "sandbox_created", "sandbox_id": "sb-cli"])
        try await f.starts.value[1].receive(["event": "ready", "kind": "terminal", "terminal": terminal])
        let saved = try await f.manager.saveEnvironment(f.ctx, other, [EnvironmentChange(name: "K", value: "v")], revision: nil)
        let starts = f.starts.value.count
        terminals.closed.with { $0 = [] }
        let restarted = try await f.manager.restart(f.ctx, other)
        XCTAssertEqual(id(restarted), id(shell))
        XCTAssertEqual(restarted["status"], "ready")
        XCTAssertEqual(restarted["env_revision"]?.string, saved.revision)
        XCTAssertEqual(f.starts.value.count, starts, "no worker: there is no app to restart")
        XCTAssertFalse(f.controls.value.contains { $0["command"] == "can_restart" })
        XCTAssertEqual(terminals.closed.value, [other])
        XCTAssertEqual(restarted["build_log"]?.array?.last?["message"], "Saved environment applies to the next terminal opened")
    }

    func testQuitClosesShellsBeforeSleeping() async throws {
        let f0 = try fixture()
        let order = f0.order
        let terminals = FakeTerminals(order: order)
        var o = f0.manager.o; o.terminals = terminals
        let manager = SandboxManager(o)
        _ = try await manager.start(f0.ctx, f0.repo)
        try await f0.starts.value[0].receive(["event": "sandbox_created", "sandbox_id": "sb"])
        try await f0.starts.value[0].receive(["event": "ready", "kind": "terminal", "terminal": terminal])
        f0.starts.value[0].finish()
        await settle()
        f0.probe.with { $0 = .success(["state": "paused", "paused": true]) }
        await manager.close()
        XCTAssertEqual(order.value, ["terminals", "pause"])
    }

    func testShutdownWaitsForWorkersAfterTheirTerminalEvent() async throws {
        let f = try fixture()
        let run = try await f.manager.start(f.ctx, f.repo)
        try await f.starts.value[0].receive(["event": "failed", "error": "boom"])
        let closing = Task { await f.manager.close() }
        await settle()
        f.starts.value[0].finish()
        await closing.value
        XCTAssertEqual(try f.store.get(id(run))?["status"], "failed")
        // An ended run ignores whatever its worker still says.
        try await f.manager.receive(f.ctx, id(run), ["event": "nonsense"])
        XCTAssertEqual(try f.store.get(id(run))?["status"], "failed")
    }
}
