import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// provider-connect.test.cjs: an import whose CLI is not signed in waits for it (one failed turn, not every job) and goes on
/// once connected; started with no CLI able to run it starts waiting; and the session's limits (session.cjs MAX_*).
@MainActor
final class SessionProviderTests: XCTestCase {
    func vault(_ home: TempDir) -> String {
        home.write("Vault/.obsidian/app.json", "{}")
        for n in 1...3 { home.write("Vault/Note \(n).md", "Note \(n)") }
        return home.url.appendingPathComponent("Vault").path
    }

    func testAnImportWaitsForItsProvider() async throws {
        XCTAssertEqual(Connect.maxRunning, 6); XCTAssertEqual(Connect.maxJobs, 40); XCTAssertEqual(Connect.maxLog, 400); XCTAssertEqual(Connect.shownLog, 150)
        let home = TempDir(), root = TempDir()
        let path = vault(home)
        let signedIn = Box<Bool?>(nil) // the check could not tell: usable says ready
        let ready = Box(["anthropic"])
        let turns = Box(0)
        final class Counting: ConnectAgents, @unchecked Sendable { let inner: ConnectAgents; let n: Box<Int>; init(_ i: ConnectAgents, _ n: Box<Int>) { inner = i; self.n = n }
            func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput { n.set(n.get() + 1); return try await inner.turn(input) } }
        let gated = CliGatedAgents(FakeAgents(delayMs: 5, env: [:]), state: { _ in (true, false, signedIn.get()) }, delayMs: 1)
        var deps = ConnectDeps(agents: Counting(gated, turns), store: FakeStore(root: root.path), homeDir: home.path)
        deps.env = [:]; deps.allowedAll = true; deps.ready = { ready.get() }
        let checks = Box<[String]>([])
        deps.providerCheck = { checks.set(checks.get() + [$0]) }
        let connect = Connect(deps)
        let started = try await connect.start(["provider": "anthropic", "direct": ["mode": "manual", "projects": [["id": "p", "title": "Study"]], "apps": ["Obsidian", "Claude Code"], "scopes": ["Obsidian": ["folders": [["path": .string(path)]], "note": ""]]]])
        let id = JS.string(started["id"])
        let blocked = await eventually(15) { (try? connect.state(id))?["blocked"]?.isNull == false }
        XCTAssertTrue(blocked)
        let b = try connect.state(id)["blocked"]
        XCTAssertEqual([b?["provider"], b?["name"], b?["error"]].map { JS.string($0) }, ["anthropic", "Claude Code", "Not logged in · Please run /login"])
        try await Task.sleep(nanoseconds: 100_000_000)
        let now = try connect.state(id)
        XCTAssertFalse((now["jobs"]?.array ?? []).contains { $0["status"]?.string == "failed" }, "nothing failed: the jobs wait")
        XCTAssertTrue((now["jobs"]?.array ?? []).allSatisfy { $0["status"]?.string == "queued" }, now["jobs"]?.text() ?? "")
        XCTAssertLessThanOrEqual(turns.get(), 2, "no cascade of failing turns")
        XCTAssertEqual(checks.get(), ["anthropic"], "its CLI is checked again")
        XCTAssertThrowsError(try connect.unblock(id, provider: "openai")) { XCTAssertTrue(($0 as? ConnectError)?.message.contains("Codex is not connected yet") == true, "\($0)") }
        signedIn.set(true)
        _ = try connect.unblock(id)
        let done = await eventually(20) { ((try? connect.state(id))?["jobs"]?.array ?? []).filter { $0["kind"]?.string == "import" }.allSatisfy { $0["status"]?.string == "done" } }
        XCTAssertTrue(done, (try? connect.state(id).text()) ?? "")
        XCTAssertEqual(try connect.state(id)["blocked"], .null)
        _ = try connect.stop(id)
    }

    func testNeitherCLIStartsWaiting() async throws {
        let home = TempDir(), root = TempDir()
        let path = vault(home)
        var deps = ConnectDeps(agents: FakeAgents(delayMs: 5, env: [:]), store: FakeStore(root: root.path), homeDir: home.path)
        deps.env = [:]; deps.allowedAll = true; deps.ready = { [] }
        let connect = Connect(deps)
        let started = try await connect.start(["provider": "openai", "direct": ["mode": "manual", "projects": [["id": "p", "title": "Study"]], "apps": ["Obsidian"], "scopes": ["Obsidian": ["folders": [["path": .string(path)]], "note": ""]]]])
        XCTAssertEqual(started["blocked"]?["provider"]?.string, "openai", "the one the person chose")
        do { _ = try await connect.start(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]]]); XCTFail() }
        catch { XCTAssertEqual((error as? ConnectError)?.message, "Sign in to Claude Code or Codex first: the agents run on one of them.") }
        _ = try connect.stop(JS.string(started["id"]))
    }
}
