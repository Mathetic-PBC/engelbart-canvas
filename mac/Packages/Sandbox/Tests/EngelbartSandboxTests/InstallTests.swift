import XCTest
import EngelbartCore
@testable import EngelbartSandbox

/// A background job whose end the test resolves (local-install's fixture `jobs`).
final class JobHandle: E2BCommandHandle, @unchecked Sendable {
    let pid = 7
    let options: CommandOptions
    let end = Deferred<CommandResult>()
    var disconnected = false
    init(options: CommandOptions) { self.options = options }
    func wait() async throws -> CommandResult { try await end.wait() }
    func disconnect() async { disconnected = true; end.reject(SandboxError("Stream disconnected")) }
    func kill() async throws -> Bool { true }
}

// test/sandbox-install.test.cjs, test/sandbox-discovery.test.cjs, test/sandbox-audit.test.cjs
final class InstallTests: XCTestCase {
    static let facts: JSONValue = ["package": ["name": "app", "engines": ["node": ">=20"], "scripts": ["dev": "vite"]], "lockfiles": ["package-lock.json"],
                                   "versions": ["node": "v22.15.0", "npm": "10.9.0"]]

    struct Fixture {
        let sandbox: FakeSandbox
        let install: DependencyInstall
        let events: Locked<[JSONValue]>
        let jobs: Locked<[JobHandle]>
    }

    func fixture(facts: JSONValue = facts, parallelFacts: JSONValue = facts, planError: String? = nil, stopError: String? = nil, signal: AbortSignal? = nil) -> Fixture {
        let sandbox = FakeSandbox()
        let jobs = Locked<[JobHandle]>([])
        sandbox.readHandler = { _, _ in Data("# Read this while installing".utf8) }
        sandbox.runHandler = { command, _ in
            if command.hasSuffix(" inspect") { return CommandResult(exitCode: 0, stdout: facts.text()) }
            if command.contains("install-job.py plan") {
                if let planError { throw SandboxError("Command exited with code 1", details: ["stderr": .string(planError)], exitCode: 1) }
                return CommandResult(exitCode: 0, stdout: JSONValue.object(["npmFacts": parallelFacts]).text())
            }
            if command.contains("install-job.py list") { return CommandResult(exitCode: 0, stdout: #"{"entries":[{"name":"README.md","type":"file"}]}"#) }
            if command.contains("install-job.py stop") { if let stopError { throw SandboxError(stopError) }; return CommandResult(exitCode: 0) }
            return CommandResult(exitCode: 0)
        }
        sandbox.startHandler = { _, options in let job = JobHandle(options: options); jobs.with { $0.append(job) }; return job }
        let events = Locked<[JSONValue]>([])
        let install = DependencyInstall(sandbox: sandbox, environment: ["APP_KEY": "secret-value"], secrets: ["secret-value"], signal: signal,
                                        onEvent: { e in events.with { $0.append(e) } })
        return Fixture(sandbox: sandbox, install: install, events: events, jobs: jobs)
    }

    func with(_ base: JSONValue, _ changes: [String: JSONValue?]) -> JSONValue {
        var o = base.object!
        for (k, v) in changes { o[k] = v ?? nil }
        if changes.keys.contains("package"), changes["package"]! == nil { o["package"] = nil }
        return .object(o)
    }
    func pkg(_ changes: [String: JSONValue]) -> JSONValue {
        var p = Self.facts["package"]!.object!
        for (k, v) in changes { p[k] = v }
        return with(Self.facts, ["package": .object(p)])
    }

    func testAutomaticPlans() {
        XCTAssertEqual(InstallPlanner.plan(Self.facts), ["status": "planned", "command": "npm ci", "cwd": ".", "manager": "npm"])
        for (lock, manager, version, command) in [("pnpm-lock.yaml", "pnpm", "9.15.0", "pnpm install --frozen-lockfile"), ("yarn.lock", "yarn", "1.22.22", "yarn install --frozen-lockfile"),
                                                  ("yarn.lock", "yarn", "4.5.0", "yarn install --immutable"), ("bun.lock", "bun", "1.2.3", "bun install --frozen-lockfile"),
                                                  ("npm-shrinkwrap.json", "npm", "10.9.0", "npm ci")] {
            var o = pkg(["packageManager": .string("\(manager)@\(version)")]).object!
            o["lockfiles"] = [.string(lock)]; o["versions"] = ["node": "22.15.0", .init(stringLiteral: manager): .string(version)]
            XCTAssertEqual(InstallPlanner.plan(.object(o))["command"]?.string, command)
        }
    }

    func testAmbiguousLayoutsDefer() {
        var cases: [JSONValue] = [with(Self.facts, ["package": nil]), with(Self.facts, ["lockfiles": []]), with(Self.facts, ["lockfiles": ["yarn.lock", "package-lock.json"]]),
                                  with(Self.facts, ["versions": [:]]), with(Self.facts, ["nestedManifests": ["client/package.json"]]), with(Self.facts, ["scanTruncated": true]),
                                  with(Self.facts, ["files": ["truncated": true]]), with(Self.facts, ["customFiles": [".npmrc"]]),
                                  with(Self.facts, ["runtimeFiles": [".nvmrc": "18"]]), with(Self.facts, ["runtimeFiles": [".node-version": "lts/*"]])]
        cases += [["workspaces": ["packages/*"]], ["devEngines": [:]], ["scripts": ["postinstall": "node bootstrap.js"]], ["packageManager": "pnpm@9.15.0"],
                  ["packageManager": "npm@9.0.0"], ["packageManager": "npm@latest"], ["engines": ["node": "^18"]], ["engines": ["npm": ">=11"]],
                  ["volta": ["node": "20.0.0"]]].map { pkg($0) }
        for facts in cases { XCTAssertEqual(InstallPlanner.plan(facts)["status"], "needs_agent", facts.text()) }
    }

    func testSemverSubset() {
        let cases: [(String, String, Bool)] = [
            ("22.15.0", ">=20", true), ("22.15.0", ">=18 <23", true), ("22.15.0", "^22.0.0", true), ("22.15.0", "~22.14.0", false),
            ("22.15.0", "22.x", true), ("22.15.0", "18 || >=20", true), ("22.15.0", "22.15.0", true), ("22.15.0", "20", false),
            ("22.15.0", "<=22", true), ("22.15.0", ">22", false), ("0.2.5", "^0.2.0", true), ("0.3.0", "^0.2.0", false),
            ("0.0.4", "^0.0.3", false), ("22.15.0", "lts/*", false), ("22.15.0", "", false), ("22.15.0", ">=20; echo unsafe", false), ("22.15.0-beta", ">=20", false),
        ]
        for (version, range, expected) in cases { XCTAssertEqual(InstallPlanner.satisfies(version, range), expected, "\(version) \(range)") }
    }

    func testManagedInstallStreamsRedactedAndGatesTools() async throws {
        let f = fixture()
        let initial = try await f.install.prepare()
        XCTAssertEqual(initial["install"]?["status"], "running")
        XCTAssertEqual(f.jobs.value.count, 1)
        let tools = SandboxTools(sandbox: f.sandbox, startApp: { _ in ["started": true] }, install: f.install, onEvent: { _ in })
        let readme = try await tools.call("read_file", ["path": "README.md"])
        XCTAssertTrue(readme["content"]!.string!.contains("while installing"))
        try await assertEqualAsync(try await tools.call("list_files", [:])["entries"]?[0]?["name"], "README.md")
        for (name, args) in [("run_command", ["command": "npm ci"] as JSONValue), ("write_file", ["path": "package.json", "content": "{}"]), ("start_app", ["command": "npm start", "port": 3000])] {
            await assertThrows(try await tools.call(name, args), "installation is running")
        }
        let job = f.jobs.value[0]
        job.options.onStdout?("install secret-value\rprogress\n")
        XCTAssertTrue(f.install.status()["output"]!.string!.contains("[redacted]"))
        XCTAssertEqual(job.options.envs["APP_KEY"], "secret-value")
        XCTAssertEqual(job.options.envs["npm_config_audit"], "false")
        XCTAssertNil(job.options.envs["ANTHROPIC_API_KEY"])
        XCTAssertNotNil(job.options.envs["ENGELBART_CANVAS_INSTALL_JOB"])
        let waiting = Task { try await tools.call("dependency_install", ["action": "status", "wait_seconds": 1]) }
        try await Task.sleep(nanoseconds: 20_000_000)
        job.end.resolve(CommandResult(exitCode: 0))
        try await assertEqualAsync(try await waiting.value["status"], "succeeded")
        try await assertEqualAsync(try await tools.call("start_app", ["command": "npm start", "port": 3000])["started"], true)
        XCTAssertTrue(f.events.value.contains { $0["install_status"] == "succeeded" && $0["exit_code"] == 0 })
        XCTAssertFalse(JSONValue.array(f.events.value).text().contains("secret-value"))
        await tools.close(); try await f.install.close()
    }

    func testPreparedLaunchWaitsForSuccessThenStarts() async throws {
        let f = fixture()
        _ = try await f.install.prepare()
        let launches = Locked<[JSONValue]>([])
        let tools = SandboxTools(sandbox: f.sandbox, startApp: { recipe in try f.install.assertReady(); launches.with { $0.append(.object(recipe)) }; return ["ready": true] },
                                 install: f.install, onEvent: { _ in })
        let pending = Task { try await tools.call("start_app", ["command": "npm start", "cwd": ".", "port": 3000, "wait_for_install": true]) }
        await settle()
        XCTAssertEqual(launches.value.count, 0, "the install must finish first")
        f.jobs.value[0].end.resolve(CommandResult(exitCode: 0))
        let result = try await pending.value
        XCTAssertEqual(result["ready"], true)
        XCTAssertEqual(result["dependency_install"]?["status"], "succeeded")
        XCTAssertEqual(launches.value, [["command": "npm start", "cwd": ".", "port": 3000]])
        await tools.close(); try await f.install.close()
    }

    func testNoLaunchAfterFailureOrUnconfirmedCleanup() async throws {
        for stopError in [nil, "Install process still running"] as [String?] {
            let f = fixture(stopError: stopError)
            _ = try await f.install.prepare()
            let tools = SandboxTools(sandbox: f.sandbox, startApp: { _ in XCTFail("no app may start"); return [:] }, install: f.install, onEvent: { _ in })
            let pending = Task { try await tools.call("start_app", ["command": "npm start", "port": 3000, "wait_for_install": true]) }
            await settle()
            f.jobs.value[0].end.resolve(CommandResult(exitCode: stopError == nil ? 1 : 0))
            do { _ = try await pending.value; XCTFail("expected a refusal") } catch {
                XCTAssertEqual((error as? SandboxError)?.details["dependency_install"]?["status"]?.string, stopError == nil ? "failed" : "blocked")
            }
            await tools.close()
            if stopError != nil { await assertThrows(try await f.install.close(), "still running") } else { try await f.install.close() }
        }
    }

    func testExpiredWaitLeavesNoQueuedLaunch() async throws {
        let f = fixture()
        _ = try await f.install.prepare()
        // A 30-second wait is too long for a unit test: the status wait itself is checked with a short one.
        let quick = try await f.install.control(["action": "status", "wait_seconds": 1])
        XCTAssertEqual(quick["status"], "running")
        let tools = SandboxTools(sandbox: f.sandbox, startApp: { _ in XCTFail("no launch"); return [:] }, install: f.install, onEvent: { _ in })
        await assertThrows(try await tools.call("start_app", ["command": "npm start", "port": 3000]), "installation is running")
        await tools.close(); try await f.install.close()
    }

    func testInconclusivePreflightAndSkip() async throws {
        let f = fixture(facts: ["package": nil])
        let initial = try await f.install.prepare()
        XCTAssertEqual(initial["install"]?["status"], "needs_agent")
        XCTAssertEqual(f.jobs.value.count, 0)
        XCTAssertThrowsError(try f.install.assertReady()) { XCTAssertTrue(message(of: $0).contains("has not succeeded")) }
        let skipped = try await f.install.control(["action": "skip", "reason": "Dependencies are vendored"])
        XCTAssertEqual(skipped["status"], "skipped")
        XCTAssertNoThrow(try f.install.assertReady())
        let custom = try await f.install.control(["action": "start", "command": "pip install -r requirements.txt", "cwd": "api"])
        XCTAssertEqual(custom["cwd"], "/home/user/repository/api")
        XCTAssertEqual(f.jobs.value.count, 1)
        try await f.install.close()
    }

    func testReplacementWaitsForConfirmedStop() async throws {
        let f = fixture()
        _ = try await f.install.prepare()
        let replaced = try await f.install.control(["action": "start", "command": "npm ci --legacy-peer-deps"])
        XCTAssertEqual(f.jobs.value.count, 2)
        XCTAssertTrue(f.jobs.value[0].disconnected)
        XCTAssertEqual(replaced["command"], "npm ci --legacy-peer-deps")
        XCTAssertTrue(f.events.value.contains { $0["install_status"] == "stopped" })
        try await f.install.close()
    }

    func testUnconfirmedStopBlocksEverything() async throws {
        let f = fixture(stopError: "remote process still running")
        _ = try await f.install.prepare()
        await assertThrows(try await f.install.control(["action": "start", "command": "npm ci"]), "still running")
        XCTAssertEqual(f.jobs.value.count, 1)
        XCTAssertEqual(f.install.status()["status"], "blocked")
        XCTAssertThrowsError(try f.install.assertIdle()) { XCTAssertTrue(message(of: $0).contains("blocked")) }
        await assertThrows(try await f.install.close(), "still running")
    }

    func testFailedInstallsKeepOutputAndNeedRetry() async throws {
        for error in [SandboxError("Install failed: secret-value", exitCode: 1), SandboxError("Command timed out")] {
            let f = fixture()
            _ = try await f.install.prepare()
            f.jobs.value[0].options.onStderr?("meaningful error\n")
            f.jobs.value[0].end.reject(error)
            let result = try await f.install.control(["action": "status", "wait_seconds": 1])
            XCTAssertEqual(result["status"], "failed")
            XCTAssertTrue(result["output"]!.string!.contains("meaningful error"))
            XCTAssertFalse(result["error"]!.string!.contains("secret-value"))
            XCTAssertThrowsError(try f.install.assertReady())
            XCTAssertNoThrow(try f.install.assertIdle())
            XCTAssertTrue(f.events.value.contains { $0["status"] == "failed" && $0["install_status"] == "failed" })
            try await f.install.close()
        }
    }

    func testParallelInstallsAreOneJobWithChecks() async throws {
        let f = fixture(facts: ["package": nil])
        _ = try await f.install.prepare()
        let started = try await f.install.control(["action": "start", "parallel": [["manager": "npm", "cwd": "web"], ["manager": "pip", "cwd": "api"]]])
        XCTAssertEqual(started["command"], "Parallel dependency installs: npm (web) + pip (api)")
        XCTAssertEqual(f.jobs.value.count, 1)
        XCTAssertTrue(f.sandbox.files.value.keys.contains { $0.hasPrefix("/home/user/.engelbart-canvas/install-") && $0.hasSuffix(".json") })
        try await f.install.close()
        let ws = fixture(facts: ["package": nil], parallelFacts: with(Self.facts, ["nestedManifests": ["a/package.json"]]))
        _ = try await ws.install.prepare()
        let refused = try await ws.install.control(["action": "start", "parallel": [["manager": "npm", "cwd": "web"], ["manager": "pip", "cwd": "api"]]])
        XCTAssertEqual(refused["status"], "failed")
        XCTAssertTrue(refused["error"]!.string!.contains("needs sequential agent inspection"))
        XCTAssertEqual(ws.jobs.value.count, 0)
        let remote = fixture(facts: ["package": nil], planError: "conflict with secret-value")
        _ = try await remote.install.prepare()
        let reason = try await remote.install.control(["action": "start", "parallel": [["manager": "npm", "cwd": "web"], ["manager": "pip", "cwd": "api"]]])
        XCTAssertTrue(reason["error"]!.string!.contains("conflict with [redacted]"))
    }

    func testDiscoveryCapsRedactsAndDegrades() async throws {
        let sandbox = FakeSandbox()
        sandbox.runHandler = { _, _ in CommandResult(exitCode: 0, stdout: #"{"components":[{"cwd":".","scripts":{"start":"SECRET"},"railpack":{"status":"planned","raw_bytes":20000}}]}"#) }
        let events = Locked<[JSONValue]>([])
        let data = try await LaunchDiscovery.discover(sandbox: sandbox, secrets: ["SECRET"]) { e in events.with { $0.append(e) } }
        XCTAssertEqual(data["components"]?[0]?["scripts"]?["start"], "[redacted]")
        XCTAssertEqual(events.value.last?["status"], "ok")
        XCTAssertLessThan(events.value.last!["context_bytes"]!.double!, 12000)
        XCTAssertFalse(JSONValue.array(events.value).text().contains("SECRET"))
        XCTAssertNotNil(sandbox.files.value["/home/user/.engelbart-canvas/launch-discovery.py"])
        for stdout in [String(repeating: "x", count: 12001), "{}", "broken"] {
            sandbox.runHandler = { _, _ in CommandResult(exitCode: 0, stdout: stdout) }
            try await assertEqualAsync(try await LaunchDiscovery.discover(sandbox: sandbox)["status"], "unavailable")
        }
        let aborted = AbortSignal(); aborted.abort()
        await assertThrows(try await LaunchDiscovery.discover(sandbox: sandbox, signal: aborted), "abort")
    }

    func testDiscoverLocalFactsAndWorkspaces() throws {
        let root = temporaryDirectory()
        func write(_ path: String, _ text: String) throws {
            let full = (root as NSString).appendingPathComponent(path)
            try FileManager.default.createDirectory(atPath: (full as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try text.write(toFile: full, atomically: true, encoding: .utf8)
        }
        try write("package.json", #"{"name":"root","workspaces":["packages/*"],"scripts":{"dev":"vite","lint":"x"},"devDependencies":{"vite":"5"},"proxy":"http://localhost:4000"}"#)
        try write("package-lock.json", "{}")
        try write("README.md", "#")
        try write("packages/web/package.json", #"{"name":"web","dependencies":{"electron":"30"}}"#)
        try write("packages/cli/package.json", #"{"name":"cli","bin":"cli.js","main":"index.js"}"#)
        try write("node_modules/x/package.json", "{}")
        let result = LaunchDiscovery.discoverLocal(root)
        let components = result["components"]!.array!
        XCTAssertEqual(components.map { $0["cwd"]!.string! }, [".", "packages/cli", "packages/web"])
        XCTAssertEqual(components[0]["scripts"], ["dev": "vite"])
        XCTAssertEqual(components[0]["hints"]?["web"], ["vite"])
        XCTAssertEqual(components[0]["local_proxy"], "http://localhost:4000")
        XCTAssertEqual(components[0]["lockfiles"], ["package-lock.json"])
        XCTAssertEqual(components[0]["evidence"], ["README.md"])
        XCTAssertEqual(components[1]["hints"]?["bin"], ["cli"])
        XCTAssertEqual(components[1]["workspace_root"], ".")
        XCTAssertEqual(components[2]["hints"]?["desktop"], ["electron"])
        XCTAssertEqual(result["scan_truncated"], false)
        XCTAssertEqual(LocalSetup.desktopApp(result), "Electron")
        XCTAssertEqual(LaunchDiscovery.discoverLocal("relative")["components"], [])
    }

    func testAuditStreamsSplitReports() async throws {
        let sandbox = FakeSandbox()
        sandbox.runHandler = { _, options in
            options.onStdout?(#"{"phase":"audit","status":"checking","message":"Checking"}"# + "\n" + #"{"phase":"audit","sta"#)
            options.onStdout?(#"tus":"findings","message":"2 moderate"}"#)
            return CommandResult(exitCode: 0)
        }
        let events = Locked<[JSONValue]>([])
        try await NpmAudit.run(sandbox: sandbox, signal: AbortSignal()) { e in events.with { $0.append(e) } }
        XCTAssertEqual(events.value.map { $0["status"]!.string! }, ["checking", "findings"])
        XCTAssertNotNil(sandbox.files.value["/home/user/.engelbart-canvas/npm-audit.py"])
        sandbox.runHandler = { _, o in o.onStdout?(#"{"phase":"install","status":"x","message":"y"}"# + "\n"); return CommandResult(exitCode: 0) }
        await assertThrows(try await NpmAudit.run(sandbox: sandbox, signal: AbortSignal()) { _ in }, "Invalid audit event")
        sandbox.runHandler = { _, _ in CommandResult(exitCode: 1) }
        await assertThrows(try await NpmAudit.run(sandbox: sandbox, signal: AbortSignal()) { _ in }, "did not finish")
        sandbox.runHandler = { _, _ in CommandResult(exitCode: 0) }
        await assertThrows(try await NpmAudit.run(sandbox: sandbox, signal: AbortSignal()) { _ in }, "returned no report")
    }
}
