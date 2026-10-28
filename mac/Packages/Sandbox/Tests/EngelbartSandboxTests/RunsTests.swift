import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// test/sandbox-runs.test.cjs (the store's part), test/github-e2b-key.test.cjs, config
final class RunsTests: XCTestCase {
    func testGithubRepo() {
        XCTAssertEqual(GithubRepo.parse("https://github.com/owner/app/"), GithubRepo(owner: "owner", name: "app", url: "https://github.com/owner/app"))
        XCTAssertEqual(GithubRepo.parse("HTTPS://GitHub.com/o.x/a-b")?.url, "https://github.com/o.x/a-b")
        for bad in ["https://github.com/../app", "https://github.com/owner/.", "http://github.com/a/b", "https://github.com/a/b/c", "git@github.com:a/b"] {
            XCTAssertNil(GithubRepo.parse(bad), bad)
        }
    }

    func testConstraintsOneActiveRunAndRestrict() throws {
        let db = try database()
        let repo = try db.insertLibrary(name: "owner/app", url: "https://github.com/owner/app")
        let store = RunStore(db)
        XCTAssertThrowsError(try db.query("insert into sandbox_runs (id, library_id) values (?, ?)", [.string(IDs.new()), .string(IDs.new())]))
        let first = try store.create(repo)!
        XCTAssertEqual(first["status"], "starting")
        for key in ["sandbox_id", "preview_url", "port", "error", "finished_at"] { XCTAssertEqual(first[key], .null) }
        XCTAssertNil(try store.create(repo), "a second active attempt is refused")
        XCTAssertThrowsError(try db.query("insert into sandbox_runs (id, library_id) values (?, ?)", [.string(IDs.new()), .string(repo)]))
        XCTAssertThrowsError(try db.query("insert into sandbox_runs (id, library_id, status) values (?, ?, 'unknown')", [.string(IDs.new()), .string(repo)]))
        for port in [0, -1, 65536] {
            XCTAssertThrowsError(try db.query("insert into sandbox_runs (id, library_id, status, port) values (?, ?, 'stopped', ?)", [.string(IDs.new()), .string(repo), .number(Double(port))]))
        }
        XCTAssertThrowsError(try db.query("delete from library where id = ?", [.string(repo)]), "runs hold the library row")
        XCTAssertThrowsError(try store.update(first["id"]!.string!, [("library_id", "x")])) { XCTAssertEqual(message(of: $0), "Invalid sandbox run update") }
        XCTAssertThrowsError(try store.update(first["id"]!.string!, [("kind", "desktop")])) { XCTAssertEqual(message(of: $0), "Invalid sandbox run kind") }
        let terminal = try store.update(first["id"]!.string!, [("kind", "terminal"), ("terminal", ["cwd": "cli", "hint": "make"])])!
        XCTAssertEqual(terminal["terminal"], ["cwd": "cli", "hint": "make"])
        try store.update(first["id"]!.string!, [("status", "failed")])
        XCTAssertNil(try store.update(first["id"]!.string!, [("error", "late")]), "only active runs change")
        XCTAssertEqual(try store.stoppedAfterFailure(first["id"]!.string!)?["status"], "stopped")
        XCTAssertNotNil(try store.create(repo), "a retry is another run")
        XCTAssertEqual(try store.latest().count, 1)
    }

    func testLogMilestonesSeqAndReopen() throws {
        let db = try database()
        let repo = try db.insertLibrary(name: "owner/app", url: "https://github.com/owner/app")
        let store = RunStore(db)
        let run = try store.create(repo)!["id"]!.string!
        func record(_ message: String, _ data: JSONValue? = nil, kind: String = "status") throws -> SandboxRun {
            var details: [String: JSONValue] = ["kind": .string(kind)]
            if let data { details["data"] = data }
            return try store.record(run, message, details)!
        }
        _ = try record("Creating sandbox")
        _ = try record("Repository cloned", ["lifecycle": "cloned"])
        _ = try record("Launch hints ready", ["phase": "plan", "source": "railpack", "status": "ok", "elapsed_ms": 2345])
        _ = try record("npm ci", ["phase": "stage", "stage": "install"], kind: "command")
        _ = try record("Dependency installation failed", ["phase": "setup", "stage": "install", "status": "failed", "install_status": "failed"])
        _ = try record("Dependency installation succeeded", ["phase": "setup", "stage": "install", "status": "working", "install_status": "succeeded"])
        try store.update(run, [("status", "ready"), ("sandbox_id", "test-sandbox"), ("preview_url", "https://preview.example"), ("port", 3000)])
        let ready = try record("Preview ready")
        let milestones = ready["build_milestones"]!
        XCTAssertNotNil(milestones["lifecycle:cloned"])
        XCTAssertNotNil(milestones["plan:railpack::ok"])
        XCTAssertNotNil(milestones["setup::install:failed"])
        XCTAssertNotNil(milestones["message:Preview ready"])
        var latest = ready
        for _ in 0..<310 { latest = try record("Application healthy", ["phase": "app_status", "status": "healthy"]) }
        XCTAssertEqual(latest["build_log"]?.array?.count, 300)
        XCTAssertEqual(latest["build_milestones"], milestones)
        XCTAssertEqual(latest["build_log"]!.array!.last!["seq"]!.double!, ready["build_log"]!.array!.last!["seq"]!.double! + 310)
        try store.update(run, [("status", "failed")])
        XCTAssertEqual(try store.reopen(run, revision: nil)?["build_milestones"], .object([:]))
        XCTAssertEqual(try store.get(run)?["status"], "starting")
    }

    func testAgentActivityTailIsBounded() throws {
        let db = try database()
        let repo = try db.insertLibrary(name: "owner/app", url: "https://github.com/owner/app")
        let store = RunStore(db)
        let run = try store.create(repo)!["id"]!.string!
        var latest: SandboxRun?
        for i in 0..<(BuildHistory.agentLogLimit + 5) { latest = try store.record(run, "Agent activity \(i)", ["data": ["phase": "agent", "status": "working"]]) }
        let entries = latest!["build_milestones"]!["agent:activity"]!["entries"]!.array!
        XCTAssertEqual(entries.count, BuildHistory.agentLogLimit)
        XCTAssertEqual(entries[0]["message"], "Agent activity 5")
        latest = try store.record(run, "Services observed", ["data": ["phase": "app_status", "app": ["running": true, "listeners": [["port": 3000]]]]])
        XCTAssertNotNil(latest!["build_milestones"]!["services:observed"])
        XCTAssertEqual(latest!["env_report"], .null, "injection metadata is not a requirement scan")
    }

    func testE2BKeySharesOneRequestAndForgets() async throws {
        let token = Locked<String?>("ghu_test")
        let gate = Deferred<Void>()
        let fetcher = FakeFetcher { _ in try await gate.wait(); return (200, Data(#"{"e2bApiKey":"e2b_test"}"#.utf8)) }
        let key = try E2BKey(token: { token.value }, version: "1.2.3", fetcher: fetcher)
        async let a = key.get()
        async let b = key.get()
        try await Task.sleep(nanoseconds: 50_000_000)
        gate.resolve(())
        let both = try await [a, b]
        XCTAssertEqual(both, ["e2b_test", "e2b_test"])
        try await assertEqualAsync(try await key.get(), "e2b_test")
        XCTAssertEqual(fetcher.requests.value.count, 1)
        let request = fetcher.requests.value[0]
        XCTAssertEqual(request.url?.absoluteString, "https://mathetic.com/api/e2b/key")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer ghu_test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-engelbart-client"), "engelbart-desktop/1.2.3")
        token.with { $0 = nil }
        try await assertNilAsync(try await key.get())
        token.with { $0 = "ghu_test" }
        try await assertEqualAsync(try await key.get(), "e2b_test")
        XCTAssertEqual(fetcher.requests.value.count, 2, "signed out drops the cached key")
        key.forget()
        _ = try await key.get()
        XCTAssertEqual(fetcher.requests.value.count, 3)
    }

    func testE2BKeyFailuresAreNotKeptAndOverride() async throws {
        let answers = Locked([(401, #"{"error":"invalid_token"}"#), (200, "{}"), (200, #"{"e2bApiKey":"e2b_test"}"#)])
        let fetcher = FakeFetcher { _ in let a = answers.with { $0.removeFirst() }; return (a.0, Data(a.1.utf8)) }
        let key = try E2BKey(token: { "ghu_test" }, version: "1.2.3", fetcher: fetcher)
        await assertThrows(try await key.get(), "401")
        await assertThrows(try await key.get(), "no key")
        try await assertEqualAsync(try await key.get(), "e2b_test")
        let asked = Locked(0)
        let developer = try E2BKey(token: { nil }, version: "1", fetcher: FakeFetcher { _ in asked.with { $0 += 1 }; return (500, Data()) }, override: "e2b_developer")
        try await assertEqualAsync(try await developer.get(), "e2b_developer")
        developer.forget()
        try await assertEqualAsync(try await developer.get(), "e2b_developer")
        XCTAssertEqual(asked.value, 0)
        XCTAssertThrowsError(try E2BKey(token: { nil }, version: "1", host: "http://mathetic.com")) { XCTAssertTrue(message(of: $0).contains("HTTPS")) }
        XCTAssertNoThrow(try E2BKey(token: { nil }, version: "1", host: "http://127.0.0.1:3000"))
    }

    func testSandboxConfigPrecedenceAndAllowList() throws {
        let root = temporaryDirectory()
        let selected = (root as NSString).appendingPathComponent("selected.env")
        try "E2B_TEMPLATE=selected\nANTHROPIC_API_KEY=no\n".write(toFile: selected, atomically: true, encoding: .utf8)
        try "E2B_DOCKER_TEMPLATE=personal-docker\nENGELBART_SANDBOX_ENV_FILE=\(selected)\n# comment\nexport ENGELBART_SANDBOX_CLAUDE_MODEL=\"model-x\"\n"
            .write(toFile: (root as NSString).appendingPathComponent("sandbox.env"), atomically: true, encoding: .utf8)
        let values = try SandboxConfig.read(root: root, env: ["E2B_API_KEY": "from-env", "HC_MODEL": "x"])
        XCTAssertEqual(values, ["E2B_TEMPLATE": "selected", "E2B_DOCKER_TEMPLATE": "personal-docker", "ENGELBART_SANDBOX_CLAUDE_MODEL": "model-x", "E2B_API_KEY": "from-env"])
        XCTAssertEqual(SandboxConfig.parseEnv("A=1 # note\nB='two words'\nC=\"x\\ny\""), ["A": "1", "B": "two words", "C": "x\ny"])
        XCTAssertEqual(try SandboxConfig.read(root: temporaryDirectory(), env: [:]), [:])
    }
}
