import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// test/sandbox-worker.test.cjs, test/sandbox-provider.test.cjs, test/sandbox-transport.test.cjs
final class WorkerTests: XCTestCase {
    func runtime(_ e2b: FakeE2B, env: [String: String] = ["E2B_API_KEY": "test"], events: Locked<[JSONValue]>, ack: @escaping () async throws -> JSONValue? = { nil },
                 setup: ((LocalSetupRequest) async throws -> LocalSetup.Ready)? = nil, check: @escaping (String) async -> Bool = { _ in true },
                 onEmit: ((JSONValue) -> Void)? = nil) -> WorkerRuntime {
        WorkerRuntime(e2b: e2b, emit: { e in events.with { $0.append(e) }; onEmit?(e) }, env: env, waitForAck: ack, detectDocker: { _ in false },
                      checkPreview: check, prepareClaude: { _ in LocalClaudeAuth(file: "claude", env: [:]) },
                      localSetup: setup ?? { _ in throw SandboxError("no setup") }, audit: { _, _, _ in }, delay: { _ in })
    }

    func testStartWaitsForAckSetsUpAndCleansUpWhenTheAppEnds() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox()
        let acked = Locked(false)
        sandbox.runHandler = { command, _ in XCTAssertTrue(acked.value, "the sandbox is persisted before any command"); return CommandResult(exitCode: 0) }
        e2b.createHandler = { template, options in
            XCTAssertEqual(template, "engelbart-runner")
            XCTAssertEqual(options.metadata["canvasRunId"], "run-test")
            XCTAssertNil(options.metadata["runId"], "the web worker must not adopt or sweep Engelbart's sandboxes")
            XCTAssertEqual(options.timeoutMs, 3_600_000)
            XCTAssertTrue(options.pauseOnTimeout && options.autoResume)
            return sandbox
        }
        let app = FakeHandle(pid: 9)
        let events = Locked<[JSONValue]>([])
        let rt = runtime(e2b, events: events, ack: { XCTAssertEqual(events.value.last?["event"], "sandbox_created"); acked.with { $0 = true }; return nil },
                         setup: { r in
            r.onEvent(["phase": "stage", "stage": "install", "command": "npm ci", "status": "installing"])
            return LocalSetup.Ready(kind: "interface", reason: "web", previewURL: "https://preview.example/app", port: 3000, terminal: nil, done: app)
        }, onEmit: { e in if e["event"] == "ready" { app.exit(0) } })
        await rt.run(["run_id": "run-test", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(events.value.compactMap { e -> String? in let k = e["event"]!.string!; return ["sandbox_created", "ready", "stopped"].contains(k) ? k : nil },
                       ["sandbox_created", "ready", "stopped"])
        XCTAssertEqual(events.value.first { $0["event"] == "ready" }, ["event": "ready", "kind": "interface", "preview_url": "https://preview.example/app", "port": 3000])
        XCTAssertTrue(sandbox.commands.value[0].hasPrefix("mkdir") == false && sandbox.commands.value[0].hasPrefix("git clone"))
        XCTAssertFalse(sandbox.commands.value.contains { $0.hasSuffix("launch.py") }, "no hc setup")
        XCTAssertEqual(sandbox.kills.value, 1)
        let install = events.value.first { $0["kind"] == "command" }!
        XCTAssertEqual(install["message"], "npm ci")
        XCTAssertEqual(install["data"]?["stage"], "install")
        XCTAssertTrue(events.value.contains { $0["data"]?["lifecycle"] == "cloned" })
        XCTAssertTrue(events.value.contains { $0["data"]?["phase"] == "check" })
        XCTAssertEqual(sandbox.timeouts.value, [600_000], "ready puts it on the 10-minute sleep, once")
        XCTAssertEqual(sandbox.files.value["/home/user/.engelbart-canvas/environment.json"], #"{"removed":[],"values":{}}"#)
    }

    func testRestartStreamsSplitEventsAndVerifiesThePreview() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox("existing")
        let exited = FakeHandle()
        sandbox.startHandler = { command, options in
            if command.contains("--restart") {
                XCTAssertTrue(options.envs.keys.filter { $0.matches("ANTHROPIC|HC_USE_API_KEY|HC_CHAT_PROVIDER|_MODEL$|_BUDGET_USD$") }.isEmpty)
                options.onStdout?(#"{"phase":"stage","stage":"start","command":"npm start","status":"running"}"# + "\n" + #"{"phase":"rea"#)
                options.onStdout?(#"dy","port":3000,"url":"http://localhost:3000/app"}"# + "\n")
                return exited
            }
            return FakeHandle()
        }
        e2b.connectHandler = { _, _ in sandbox }
        let events = Locked<[JSONValue]>([])
        let rt = runtime(e2b, env: ["E2B_API_KEY": "test", "ANTHROPIC_API_KEY": "unused", "HC_SETUP_MODEL": "unused"], events: events,
                         setup: { _ in XCTFail("a restart runs no setup"); throw SandboxError("x") },
                         check: { url in XCTAssertEqual(url, "https://preview.example/app"); return true },
                         onEmit: { e in if e["event"] == "ready" { exited.exit(0) } })
        await rt.run(["command": "restart", "sandbox_id": "existing", "run_id": "run-test", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(events.value.filter { $0["event"] != "progress" }.map { $0["event"]!.string! }, ["sandbox_created", "ready", "stopped"])
        XCTAssertEqual(events.value.first { $0["kind"] == "command" }?["message"], "npm start")
        XCTAssertEqual(sandbox.kills.value, 1)
        XCTAssertTrue(sandbox.commands.value.contains("node /opt/engelbart/proxy.mjs '43110:3000:127.0.0.1'"))
        XCTAssertFalse(sandbox.commands.value.contains { $0.hasPrefix("git clone") }, "no clone on restart")
    }

    func testRestartConfigurationFailureKeepsTheSandbox() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox("existing")
        sandbox.startHandler = { command, options in
            options.onStdout?(#"{"phase":"usable","message":"No web preview in this repository"}"# + "\n")
            return FakeHandle()
        }
        e2b.connectHandler = { _, _ in sandbox }
        let events = Locked<[JSONValue]>([])
        await runtime(e2b, events: events).run(["command": "restart", "sandbox_id": "existing", "run_id": "r", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(events.value.last?["event"], "failed")
        XCTAssertEqual(events.value.last?["error"], "No web preview in this repository")
        XCTAssertEqual(sandbox.kills.value, 0, "the machine and its files are kept")
        XCTAssertTrue(sandbox.commands.value.filter { $0.hasSuffix("launch.py --stop") }.count >= 2)
    }

    func testCloneFailureKillsTheSandbox() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox()
        sandbox.runHandler = { command, _ in if command.hasPrefix("git clone") { throw SandboxError("Repository not found", exitCode: 128) }; return CommandResult(exitCode: 0) }
        e2b.createHandler = { _, _ in sandbox }
        let events = Locked<[JSONValue]>([])
        await runtime(e2b, events: events).run(["run_id": "r", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(events.value.last?["event"], "failed")
        XCTAssertEqual(events.value.last?["error"], "Repository not found")
        XCTAssertEqual(sandbox.kills.value, 1)
    }

    func testLocalSetupFailureIsShortAndNeverFallsBack() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox()
        e2b.createHandler = { _, _ in sandbox }
        let events = Locked<[JSONValue]>([])
        await runtime(e2b, events: events, setup: { _ in throw SandboxError("Claude finished without a verified web preview.") })
            .run(["run_id": "r", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(events.value.last?["event"], "failed")
        XCTAssertEqual(events.value.last?["error"], "Claude finished without a verified web preview. Retry from build details.")
        XCTAssertEqual(sandbox.kills.value, 1)
        XCTAssertFalse(sandbox.commands.value.contains { $0.contains("launch.py") && $0.contains("--restart") })
        let unsigned = Locked<[JSONValue]>([])
        let rt = WorkerRuntime(e2b: e2b, emit: { e in unsigned.with { $0.append(e) } }, env: ["E2B_API_KEY": "k"], waitForAck: { nil }, detectDocker: { _ in false },
                               checkPreview: { _ in true }, prepareClaude: { _ in throw SandboxError(LocalClaude.signedOut) })
        await rt.run(["run_id": "r", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(unsigned.value.last?["error"]?.string, LocalClaude.signedOut)
        XCTAssertFalse(e2b.calls.value.filter { $0.hasPrefix("create") }.count > 1, "no sandbox is made before Claude is ready")
    }

    func testProbeStates() async throws {
        let e2b = FakeE2B()
        let events = Locked<[JSONValue]>([])
        let check = Locked(true)
        let rt = WorkerRuntime(e2b: e2b, emit: { e in events.with { $0.append(e) } }, env: ["E2B_API_KEY": "k"], checkPreview: { _ in check.value })
        e2b.infoHandler = { _ in throw SandboxError("not found", name: "NotFoundError", status: 404) }
        try await assertEqualAsync(try await rt.probe(["sandbox_id": "gone", "preview_url": "https://p.example/"])["state"], "gone")
        e2b.infoHandler = { _ in throw SandboxError("Network timeout", name: "TimeoutError") }
        await assertThrows(try await rt.probe(["sandbox_id": "x", "preview_url": "https://p.example/"]), "Network timeout")
        e2b.infoHandler = { E2BSandboxInfo(sandboxId: $0, state: "paused") }
        try await assertEqualAsync(try await rt.probe(["sandbox_id": "x", "preview_url": "https://p.example/"])["state"], "paused")
        e2b.infoHandler = { E2BSandboxInfo(sandboxId: $0, state: "running", endAt: Time.ms() + 3_600_000) }
        check.with { $0 = false }
        try await assertEqualAsync(try await rt.probe(["sandbox_id": "x", "preview_url": "https://p.example/"])["state"], "unreachable")
        try await assertEqualAsync(try await rt.probe(["sandbox_id": "x", "kind": "terminal"])["state"], "ready")
        try await assertEqualAsync(try await rt.probe(["sandbox_id": "x"])["state"], "interrupted")
        e2b.infoHandler = { E2BSandboxInfo(sandboxId: $0, state: "running", endAt: Time.ms() + 10_000) }
        try await assertEqualAsync(try await rt.probe(["sandbox_id": "x", "preview_url": "https://p.example/"])["state"], "ready", "about to sleep: no request")
        e2b.listHandler = { metadata in XCTAssertEqual(metadata, ["canvasRunId": "run-1", "app": "engelbart-canvas"]); return [E2BSandboxInfo(sandboxId: "sb-recovered", state: "running")] }
        try await assertEqualAsync(try await rt.probe(["run_id": "run-1"]), ["state": "interrupted", "sandbox_id": "sb-recovered"])
        e2b.listHandler = { _ in [] }
        try await assertEqualAsync(try await rt.probe(["run_id": "run-1"]), ["state": "gone"])
        e2b.pauseHandler = { _ in false }
        try await assertEqualAsync(try await rt.pause(["sandbox_id": "x"]), ["state": "paused", "paused": false])
        let keyless = WorkerRuntime(e2b: e2b, emit: { _ in }, env: [:])
        for command in ["probe", "kill", "pause"] {
            await assertThrows(try await command == "probe" ? keyless.probe([:]) : command == "kill" ? keyless.kill([:]) : keyless.pause([:]), "Sign in to GitHub")
        }
        await assertThrows(try await keyless.canRestart(["sandbox_id": "x"]), "Sign in to GitHub")
    }

    func testGithubLoginAndPrivateArchives() async throws {
        let e2b = FakeE2B()
        let seen = Locked<[String: String]>([:])
        let sandbox = FakeSandbox()
        e2b.createHandler = { _, options in seen.with { $0 = options.metadata }; return sandbox }
        sandbox.runHandler = { command, options in
            if command.contains("curl") {
                XCTAssertFalse(command.contains("codeload"), "the link is never on the command line")
                XCTAssertEqual(options.envs["ENGELBART_ARCHIVE_URL"], "https://codeload.github.com/owner/app/legacy.tar.gz/main?token=ABCDEFGHIJKLMNOPQRSTUV")
                XCTAssertEqual(options.envs["ENGELBART_BRANCH"], "main")
                options.onStderr?("curl failed for token=ABCDEFGHIJKLMNOPQRSTUV")
                throw SandboxError("curl: (22) 404", exitCode: 22)
            }
            return CommandResult(exitCode: 0)
        }
        let events = Locked<[JSONValue]>([])
        let rt = runtime(e2b, events: events, ack: { ["archive_url": "https://codeload.github.com/owner/app/legacy.tar.gz/main?token=ABCDEFGHIJKLMNOPQRSTUV", "branch": "main"] })
        await rt.run(["run_id": "r", "github_url": "https://github.com/owner/app", "github_login": "octocat"])
        XCTAssertEqual(seen.value["githubLogin"], "octocat")
        XCTAssertFalse(JSONValue.array(events.value).text().contains("ABCDEFGHIJKLMNOPQRSTUV"))
        await runtime(e2b, events: Locked([]), ack: { nil }).run(["run_id": "r", "github_url": "https://github.com/owner/app", "github_login": "bad login!"])
        XCTAssertNil(seen.value["githubLogin"])
        let refused = Locked<[JSONValue]>([])
        let other = FakeSandbox()
        e2b.createHandler = { _, _ in other }
        await runtime(e2b, events: refused, ack: { ["archive_url": "https://evil.example/repo.tar.gz"] }).run(["run_id": "r", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(refused.value.last?["error"], "Invalid repository download link")
        XCTAssertEqual(other.kills.value, 1)
        XCTAssertTrue(other.commands.value.isEmpty, "nothing ran")
        XCTAssertThrowsError(try SandboxWorker.archiveSource(["archive_url": "https://user:pw@codeload.github.com/x"]))
        XCTAssertNil(try SandboxWorker.archiveSource(["archive_url": "https://codeload.github.com/x", "branch": "../bad"])?.branch)
    }

    func testAppStreamEndingWhileAsleepIsPausedNotStopped() async throws {
        for (asleep, expected) in [(true, "paused"), (false, "stopped")] {
            let e2b = FakeE2B()
            let sandbox = FakeSandbox()
            e2b.createHandler = { _, _ in sandbox }
            e2b.infoHandler = { E2BSandboxInfo(sandboxId: $0, state: asleep ? "paused" : "running") }
            let app = FakeHandle()
            let events = Locked<[JSONValue]>([])
            await runtime(e2b, events: events, setup: { _ in LocalSetup.Ready(kind: "interface", reason: "", previewURL: "https://p.example/", port: 3000, terminal: nil, done: app) },
                          onEmit: { e in if e["event"] == "ready" { if asleep { app.drop() } else { app.exit(0) } } })
                .run(["run_id": "r", "github_url": "https://github.com/owner/app"])
            XCTAssertEqual(events.value.last?["event"]?.string, expected)
            XCTAssertEqual(sandbox.kills.value, asleep ? 0 : 1)
        }
    }

    func testTerminalOnlyReadyLeavesWithoutKilling() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox()
        e2b.createHandler = { _, _ in sandbox }
        let events = Locked<[JSONValue]>([])
        await runtime(e2b, events: events, setup: { _ in LocalSetup.Ready(kind: "terminal", reason: "CLI", previewURL: nil, port: nil, terminal: ["cwd": "cli", "hint": "make"], done: nil) })
            .run(["run_id": "r", "github_url": "https://github.com/owner/app"])
        XCTAssertEqual(events.value.last?["event"], "ready")
        XCTAssertEqual(events.value.last, ["event": "ready", "kind": "terminal", "terminal": ["cwd": "cli", "hint": "make"]])
        XCTAssertTrue(events.value.contains { $0["message"] == "Terminal verified" })
        XCTAssertFalse(events.value.contains { $0["message"] == "Preview verified" })
        XCTAssertEqual(sandbox.kills.value, 0)
        XCTAssertEqual(sandbox.timeouts.value, [600_000])
    }

    func testInProcessTransportChecksAckAndStop() async throws {
        let e2b = FakeE2B()
        let sandbox = FakeSandbox()
        e2b.createHandler = { _, _ in sandbox }
        let launch = InProcessWorker.launcher(e2b: e2b) { o in
            o.prepareClaude = { _ in LocalClaudeAuth(file: "c", env: [:]) }
            o.detectDocker = { _ in false }
            o.localSetup = { r in try await r.signal.sleep(30); throw SandboxError("Setup stopped") }
        }
        let received = Locked<[JSONValue]>([])
        let worker = try launch(["command": "start", "run_id": "run-1", "github_url": "https://github.com/owner/app", "environment": ["values": ["K": "secret-v"], "removed": []]],
                                ["E2B_API_KEY": "k"]) { event in
            received.with { $0.append(event) }
            return event["event"] == "sandbox_created" ? ["archive_url": nil] : nil
        }
        await eventually(3, "the setup") { received.value.contains { $0["message"] == "Repository cloned" } }
        XCTAssertTrue(received.value.allSatisfy { $0["run_id"] == "run-1" })
        try await worker.stop()
        XCTAssertEqual(received.value.last?["event"], "stopped")
        XCTAssertEqual(sandbox.kills.value, 1)
        let probe = try launch(["command": "probe", "run_id": "run-2", "sandbox_id": "sb"], ["E2B_API_KEY": "k"]) { event in received.with { $0.append(event) }; return nil }
        try await probe.done.wait()
        XCTAssertEqual(received.value.last?["event"], "result")
        XCTAssertEqual(received.value.last?["state"], "interrupted", "running, with no preview to check and no kind")
        let failing = try launch(["command": "probe", "run_id": "run-3", "sandbox_id": "sb"], ["E2B_API_KEY": "k"]) { _ in throw SandboxError("handler broke") }
        await assertThrows(try await failing.done.wait(), "handler broke")
        await assertThrows(try await failing.detach(), "no longer connected")
    }

    func testSafePreviewAndRespondsAt() async throws {
        XCTAssertEqual(try SandboxWorker.safePreview("https://preview.example"), "https://preview.example/")
        XCTAssertThrowsError(try SandboxWorker.safePreview("http://preview.example/"))
        XCTAssertThrowsError(try SandboxWorker.safePreview("https://user:pw@preview.example/"))
        let page = FakeFetcher { _ in (200, Data("<html>".utf8)) }
        let refusing = FakeFetcher { _ in (403, Data("Invalid Host header".utf8)) }
        let broken = FakeFetcher { _ in (502, Data()) }
        let ok = await SandboxWorker.respondsAt("http://localhost:3000/", fetcher: page)
        let host = await SandboxWorker.respondsAt("http://localhost:3000/", fetcher: refusing)
        let down = await SandboxWorker.respondsAt("http://localhost:3000/", fetcher: broken)
        XCTAssertEqual([ok, host, down], [true, false, false])
        let docker = FakeFetcher { _ in (200, Data(#"{"tree":[{"path":"web/docker-compose.yml"}]}"#.utf8)) }
        let dockerAnswer = await SandboxWorker.wantsDocker(GithubRepo(owner: "o", name: "a", url: "https://github.com/o/a"), fetcher: docker)
        XCTAssertTrue(dockerAnswer)
        XCTAssertEqual(docker.requests.value.first?.url?.absoluteString, "https://api.github.com/repos/o/a/git/trees/HEAD?recursive=1")
    }
}
