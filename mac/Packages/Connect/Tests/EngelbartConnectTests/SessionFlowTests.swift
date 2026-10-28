import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// connect.test.cjs fakeSignIn: Chrome chosen for the sign-ins; each browser holds the sign-ins of `apps`; a copy puts the
/// app's cookie in Engelbart's store. Only fakes: no real browser, Keychain or network.
final class AppsImporter: CookieImporter, @unchecked Sendable {
    static let cookies = ["chatgpt.com": "__Secure-next-auth.session-token", "claude.ai": "sessionKey"]
    let lock = NSLock()
    let apps: [String: [String]]
    let jar: FakeJar
    var checked: [String] = [], keychain: [String] = []
    init(_ apps: [String: [String]], jar: FakeJar) { self.apps = apps; self.jar = jar }
    func appOf(_ domains: [String]) -> String { domains.first == "chatgpt.com" ? "ChatGPT" : domains.first == "claude.ai" ? "Claude" : "" }
    func sources() -> [BrowserSource] { apps.keys.sorted().map { BrowserSource(id: $0, name: $0 == "chrome" ? "Chrome" : "Firefox", family: $0 == "chrome" ? "chromium" : "firefox", bundle: nil, profiles: [.init(id: "Default", name: "Me")]) } }
    func installedChromium() -> [BrowserSource] { sources().filter { $0.family == "chromium" } }
    func cookieNames(browser: String, profile: String, domains: [String]) throws -> [(domain: String, name: String, stamp: Double)] {
        let app = appOf(domains)
        lock.lock(); checked.append(app); lock.unlock()
        return (apps[browser] ?? []).contains(app) ? [(domains[0], Self.cookies[domains[0]] ?? "x", 1)] : []
    }
    func checkDetail(_ domain: String) async -> (signedIn: Bool?, status: Int?, location: String?, reason: String?)? { (true, 200, nil, nil) }
    func canRead(_ browserId: String) -> Bool { true }
    func importCookies(browser: String, profile: String, domains: [String], quiet: Bool) async throws -> Int? {
        lock.lock(); keychain.append(browser); lock.unlock()
        await jar.set(StoredCookie(domain: ".\(domains[0])", name: Self.cookies[domains[0]] ?? "x", value: "v"))
        return 1
    }
    func unlock(_ browserId: String) async throws {}
    func ready(_ browserId: String) async -> Bool { true }
}

/// Engelbart's sign-in window answering `status` (signin-window.cjs), what it was asked to open in `opened`.
@MainActor
final class FakeSignInWindow: SignInWindowing {
    var status: String
    var opened: [String] = []
    var closes = 0
    var onSignedIn: (String) async -> Void = { _ in }
    init(_ status: String) { self.status = status }
    func open(_ app: String) async -> String { opened.append(app); if status == "signed-in" { await onSignedIn(app) }; return status }
    func openSite(name: String, url: String, domains: [String]) async -> String { opened.append(name); return status }
    func close() { closes += 1 }
}

@MainActor
final class SessionFlowTests: XCTestCase {
    struct Run { let connect: Connect; let root: TempDir; let home: TempDir; let store: FakeStore }

    func fakeConnect(ask: Bool = false, delayMs: Double = 5, env: [String: String] = [:], webSignIn: WebSignIn? = nil, window: SignInWindowing? = nil,
                     home: TempDir = TempDir(), root: TempDir = TempDir()) -> Run {
        let store = FakeStore(root: root.path)
        var deps = ConnectDeps(agents: FakeAgents(delayMs: delayMs, env: env), store: store, homeDir: home.path)
        deps.env = [:]
        deps.ready = { ["anthropic", "openai"] }
        deps.allowedAll = !ask
        deps.recoverWaitsMs = [0]
        deps.webSignIn = webSignIn
        deps.signInWindow = window
        return Run(connect: Connect(deps), root: root, home: home, store: store)
    }

    func until(_ run: Run, _ id: String, _ what: String, timeout: Double = 20, _ check: (JSONValue) -> Bool) async throws -> JSONValue {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            let s = try run.connect.state(id)
            if check(s) { return s }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what): \(try run.connect.state(id).text())")
        return try run.connect.state(id)
    }
    func saved(_ run: Run, _ id: String) -> JSONValue { Files.readJSON(run.root.url.appendingPathComponent(".connect/\(id)/session.json")) ?? .null }
    func jobs(_ s: JSONValue) -> [JSONValue] { s["jobs"]?.array ?? [] }
    func apps(_ job: JSONValue) -> [String] { job["apps"]?.array?.compactMap(\.string) ?? [] }

    func webSignIn(_ apps: [String: [String]]) -> (WebSignIn, AppsImporter, FakeJar) {
        let jar = FakeJar()
        let importer = AppsImporter(apps, jar: jar)
        let web = WebSignIn(importer: importer, jar: jar, defaultBrowser: { "Safari" }, openExternal: { _ in XCTFail("Safari is never opened") },
                            openIn: { _, _ in }, chosen: { WebSignIn.Chosen(browser: "chrome") }, pollMs: 1, slowPollMs: 1, timeoutMs: 2000, sleep: { _ in await Task.yield() })
        return (web, importer, jar)
    }

    // "Import your context: one import a tool told the projects picked, a manual folder kept to, a signed-out web app waits on
    // a sign-in card, other tools through the browser".
    func testDirectImportWithASignInCard() async throws {
        let home = TempDir()
        home.write("Vault/.obsidian/app.json", "{}")
        home.write("Vault/Research/Idea.md", "An idea.")
        let (web, _, jar) = webSignIn(["chrome": []])
        let window = FakeSignInWindow("closed")
        window.onSignedIn = { _ in await jar.set(StoredCookie(domain: ".chatgpt.com", name: "__Secure-next-auth.session-token", value: "here")) }
        let run = fakeConnect(webSignIn: web, window: window, home: home)
        let started = try await run.connect.start(["provider": "openai", "direct": [
            "mode": "manual", "projects": [["id": "calc", "title": "Calculus tutoring study", "description": "An RCT of an AI tutor in calculus."]],
            "roles": ["Researcher", "Nobody"], "work": "I study how students solve problems.", "apps": ["Obsidian", "ChatGPT", "Not a tool"],
            "scopes": ["Obsidian": ["folders": [["path": "~/Vault"]], "note": ""]],
            "additional": [["name": "Linear", "website": "https://linear.app", "note": "Only the issues about tutoring", "projects": ["Calculus tutoring study"]]]]])
        let id = JS.string(started["id"])
        let now = try await until(run, id, "the run queued") { $0["finished"] == true && $0["thinking"] != true }
        XCTAssertEqual(now["chat"]?.array?.count, 1, "no librarian: the opening line alone")
        XCTAssertEqual(now["chat"]?[0]?["opener"], true)
        let s = saved(run, id)
        XCTAssertEqual(s["choices"]?["direct"]?["roles"], ["Researcher"])
        XCTAssertEqual(s["choices"]?["direct"]?["apps"], ["Obsidian", "ChatGPT"])
        XCTAssertEqual(s["choices"]?["project"]?["name"]?.string, "Calculus tutoring study")
        let obsidian = jobs(s).first { $0["kind"]?.string == "import" && apps($0).contains("Obsidian") }
        let plan = JS.string(obsidian?["plan"])
        XCTAssertTrue(plan.contains("only what pertains to these projects"), plan)
        XCTAssertTrue(plan.contains("Calculus tutoring study: An RCT"), plan)
        XCTAssertTrue(JS.test(plan, "read only these folders and files: .*Vault"), plan)
        XCTAssertEqual(s["picked"]?["folders"]?["Obsidian"]?.string, home.url.appendingPathComponent("Vault").path)
        let linear = jobs(s).first { JS.string($0["label"]).hasPrefix("Other tools") }
        XCTAssertEqual(linear?["source"]?.string, "sites")
        XCTAssertEqual(linear?["extra"], ["sites": ["linear.app"], "tool": ["name": "Linear", "website": "https://linear.app", "sites": ["linear.app"]]])
        XCTAssertTrue(JS.string(linear?["plan"]).contains("Linear (https://linear.app): Only the issues about tutoring; only for these of the projects: Calculus tutoring study"))
        XCTAssertFalse(jobs(s).contains { apps($0).contains("ChatGPT") }, "not queued yet")
        let carded = try await until(run, id, "ChatGPT's card") { ($0["needs"]?.array ?? []).contains { $0["app"]?.string == "ChatGPT" } }
        let card = carded["needs"]!.array!.first { $0["app"]?.string == "ChatGPT" }!
        XCTAssertEqual(card["kind"]?.string, "signin-here"); XCTAssertEqual(card["where"]?.string, "here")
        let cardId = JS.string(card["id"])
        _ = try await run.connect.need(id, cardId, "open")
        _ = try await until(run, id, "said on the card") { ($0["needs"]?.array ?? []).first { $0["id"]?.string == cardId }?["error"]?.string == "Not signed in to ChatGPT yet." }
        window.status = "signed-in"
        _ = try await run.connect.need(id, cardId, "open")
        _ = try await until(run, id, "the step closed") { !($0["needs"]?.array ?? []).contains { $0["id"]?.string == cardId } }
        _ = try await until(run, id, "ChatGPT queued once signed in") { self.jobs($0).contains { $0["kind"]?.string == "import" && self.apps($0).contains("ChatGPT") } }
        XCTAssertEqual(window.opened, ["ChatGPT", "ChatGPT"])
        _ = try run.connect.stop(id)
        _ = try run.connect.dismiss(id)
    }

    // "sign-ins sorted before the run: one signed in is surveyed; one still signed out is brought back, quietly and then by its
    // card, its survey waiting; Skip leaves it out".
    func testSignInsSortedBeforeTheRun() async throws {
        let (web, _, _) = webSignIn(["chrome": ["ChatGPT"]])
        var chats: [JSONValue] = []
        let run = fakeConnect(env: ["ENGELBART_CONNECT_FAKE_NEEDS": "Claude"], webSignIn: web, window: FakeSignInWindow("closed"))
        run.connect.deps.notify = { chats.append($0["chat"] ?? []) }
        let started = try await run.connect.start(["sources": ["chats": ["on": true, "apps": ["ChatGPT", "Claude"]]]])
        let id = JS.string(started["id"])
        XCTAssertEqual(chats.first { ($0.array ?? []).count > 0 }?[0]?["text"]?.string, "Looking at what you picked…")
        let now = try await until(run, id, "the first turn and Claude's card") { ($0["chat"]?.array?.count ?? 0) > 1 && $0["thinking"] != true && $0["needs"]?.array?.count == 1 }
        let need = now["needs"]![0]!
        XCTAssertEqual([need["app"], need["kind"], need["reason"], need["where"]].map { JS.string($0) }, ["Claude", "signin-here", "Sign in to Claude", "here"])
        let log = (now["log"]?.array ?? []).map { JS.string($0["text"]) }
        XCTAssertTrue(log.contains("Signed in to ChatGPT from Chrome"), "\(log)")
        XCTAssertTrue(log.contains("Bringing back the Claude sign-in"), "\(log)")
        XCTAssertEqual(jobs(now).filter { $0["kind"]?.string == "survey" }.map { apps($0).first ?? "" }, ["ChatGPT"])
        XCTAssertFalse(jobs(now).contains { apps($0).contains("Claude") })
        XCTAssertTrue(JS.test(JS.string(now["chat"]?[0]?["text"]), #"^(Found .*|Had a look at what you picked\.) Starting with your ai chats\.\n\nUsing your Chrome sign-ins for ChatGPT\.$"#), JS.string(now["chat"]?[0]?["text"]))
        let after = try await run.connect.need(id, JS.string(need["id"]), "skip")
        XCTAssertEqual(after["needs"], [])
        XCTAssertTrue((after["leftOut"]?.array ?? []).contains { $0["app"]?.string == "Claude" && $0["why"]?.string == "you skipped signing in" })
        _ = try await until(run, id, "ChatGPT's survey") { self.jobs($0).contains { $0["kind"]?.string == "survey" && self.apps($0).first == "ChatGPT" && $0["status"]?.string == "done" } }
        XCTAssertFalse(jobs(try run.connect.state(id)).contains { apps($0).contains("Claude") })
        _ = try run.connect.stop(id)
    }

    // "the librarian must ask, once: one message first, every app unticked; nothing looked at and no librarian before Grant access".
    func testGrantFirst() async throws {
        let (web, importer, _) = webSignIn(["chrome": ["ChatGPT", "Claude"]])
        let run = fakeConnect(ask: true, delayMs: 150, webSignIn: web)
        let started = try await run.connect.start(["sources": ["chats": ["on": true, "apps": ["ChatGPT", "Claude"]]], "provider": "anthropic"])
        let id = JS.string(started["id"])
        var now = try run.connect.state(id)
        XCTAssertEqual(now["chat"]?.array?.map { $0["opener"] == true ? "opener" : JS.truthy($0["grant"]) ? "grant" : "other" }, ["opener", "grant"])
        XCTAssertEqual(now["chat"]?[1]?["grant"], ["rows": [["id": "ChatGPT", "name": "ChatGPT"], ["id": "Claude", "name": "Claude"]], "answered": .null])
        XCTAssertEqual(now["needs"], [])
        now = try await until(run, id, "the scan, behind the grant") { JS.string($0["chat"]?[0]?["text"]) != "Looking at what you picked…" }
        XCTAssertEqual(importer.checked, [], "no sign-in of theirs is looked at before Grant access")
        XCTAssertFalse(jobs(now).contains { apps($0).contains("ChatGPT") || apps($0).contains("Claude") })
        XCTAssertThrowsError(try run.connect.grant(id, ["apps": []])) { XCTAssertTrue(($0 as? ConnectError)?.message.contains("Pick at least one app") == true) }
        _ = try run.connect.grant(id, ["apps": ["ChatGPT", "Not asked"]])
        now = try await until(run, id, "ChatGPT's survey and the librarian") { s in self.jobs(s).contains { $0["kind"]?.string == "survey" && self.apps($0).first == "ChatGPT" } && (s["chat"]?.array ?? []).contains { $0["opener"] != true && !JS.truthy($0["grant"]) } }
        XCTAssertEqual(now["chat"]?[1]?["grant"]?["answered"]?["allowed"], ["ChatGPT"])
        XCTAssertEqual(now["chat"]?[1]?["grant"]?["answered"]?["skipped"], ["Claude"])
        XCTAssertTrue(importer.checked.contains("ChatGPT"))
        XCTAssertTrue((now["log"]?.array ?? []).contains { $0["text"]?.string == "Allowed Engelbart to access ChatGPT" && $0["who"]?.string == "You" })
        XCTAssertTrue((now["leftOut"]?.array ?? []).contains { $0["app"]?.string == "Claude" && $0["why"]?.string == "you didn’t allow Engelbart to access it" })
        _ = try await until(run, id, "the librarian") { $0["thinking"] != true }
        let imported = try run.connect.importNow(id)
        _ = try run.connect.stop(id)
        XCTAssertTrue(jobs(imported).allSatisfy { !apps($0).contains("Claude") })
        XCTAssertFalse(importer.checked.contains("Claude"))
        // Import pressed while the grant is still open: its apps are left out.
        let third = fakeConnect(ask: true)
        let other = try await third.connect.start(["sources": ["chats": ["on": true, "apps": ["ChatGPT", "Claude Code"]]]])
        let oid = JS.string(other["id"])
        _ = try await until(third, oid, "ChatGPT's grant") { s in (s["chat"]?.array ?? []).contains { JS.truthy($0["grant"]) } && JS.string(s["chat"]?[0]?["text"]) != "Looking at what you picked…" }
        let pressed = try third.connect.importNow(oid)
        _ = try third.connect.stop(oid)
        XCTAssertEqual((pressed["chat"]?.array ?? []).first { JS.truthy($0["grant"]) }?["grant"]?["answered"]?["skipped"], ["ChatGPT"])
        XCTAssertTrue((pressed["leftOut"]?.array ?? []).contains { $0["app"]?.string == "ChatGPT" && JS.test(JS.string($0["why"]), "Import before allowing it") })
        XCTAssertTrue(jobs(pressed).allSatisfy { !apps($0).contains("ChatGPT") })
    }

    // "a grant still open when Engelbart quits is open again after, its apps held; answered, they start and so does the librarian".
    func testGrantSurvivesAQuit() async throws {
        let root = TempDir(), home = TempDir()
        let first = fakeConnect(ask: true, delayMs: 40, home: home, root: root)
        let started = try await first.connect.start(["sources": ["notes": ["on": true, "apps": ["Obsidian", "Google Docs", "OneNote"]]], "provider": "openai"])
        let id = JS.string(started["id"])
        _ = try await until(first, id, "the grant") { s in (s["chat"]?.array ?? []).contains { JS.truthy($0["grant"]) } && JS.string(s["chat"]?[0]?["text"]) != "Looking at what you picked…" }
        first.connect.suspendAll()
        XCTAssertEqual(saved(first, id)["allowed"], [])
        let second = fakeConnect(ask: true, delayMs: 5, home: home, root: root)
        let resumed = await second.connect.resume(dataRoot: root.path)
        XCTAssertEqual(resumed, 1)
        var now = try second.connect.state(id)
        let grant = { (s: JSONValue) in (s["chat"]?.array ?? []).first { JS.truthy($0["grant"]) }?["grant"] }
        XCTAssertEqual(grant(now)?["rows"]?.array?.map { JS.string($0["id"]) }, ["Google Docs", "OneNote"])
        XCTAssertEqual(grant(now)?["answered"], .null)
        XCTAssertEqual((now["chat"]?.array ?? []).filter { JS.truthy($0["grant"]) }.count, 1, "not asked twice")
        XCTAssertFalse(jobs(now).contains { apps($0).contains("Google Docs") || apps($0).contains("OneNote") }, "held")
        _ = try second.connect.grant(id, ["apps": ["OneNote"]])
        now = try await until(second, id, "OneNote's survey and the librarian") { s in self.jobs(s).contains { $0["kind"]?.string == "survey" && self.apps($0).first == "OneNote" } && (s["chat"]?.array ?? []).contains { $0["opener"] != true && !JS.truthy($0["grant"]) && !JS.truthy($0["notice"]) } }
        XCTAssertTrue((now["leftOut"]?.array ?? []).contains { $0["app"]?.string == "Google Docs" })
        XCTAssertTrue(second.connect.list(dataRoot: root.path).contains { JS.string($0["id"]) == id })
        _ = try second.connect.stop(id)
    }

    // "what the person ticks is what may be read: Drive ids from the survey kept as approved".
    func testDriveIdsApproved() async throws {
        let run = fakeConnect()
        let started = try await run.connect.start(["sources": ["notes": ["on": true, "apps": ["Google Docs"]]]])
        let id = JS.string(started["id"])
        let card = try await until(run, id, "the Drive question") { s in s["thinking"] != true && (s["chat"]?.array ?? []).contains { $0["ask"]?["kind"]?.string == "multi" } }
        let ask = (card["chat"]?.array ?? []).first { JS.truthy($0["ask"]) }!["ask"]!
        XCTAssertEqual(ask["options"]?.array?.map { JS.string($0["label"]) }, ["Google Drive item 1", "Google Drive item 2", "Google Drive item 3"])
        _ = try run.connect.answer(id, ["picked": ["Google Drive item 2"]])
        XCTAssertEqual(saved(run, id)["approved"], ["Google Docs": ["google-docs-2"]])
        _ = try run.connect.stop(id)
    }

    // Stopping, minimizing, recall answers kept with the session, and what an unknown id is told.
    func testControlsAndRecall() async throws {
        let run = fakeConnect(delayMs: 400)
        XCTAssertThrowsError(try run.connect.state("00000000-0000-0000-0000-000000000000")) { XCTAssertTrue(($0 as? ConnectError)?.message.contains("no longer") == true, "\($0)") }
        let started = try await run.connect.start(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]], "provider": "anthropic"])
        let id = JS.string(started["id"])
        XCTAssertEqual(try run.connect.setMinimized(id, true)["minimized"], true)
        let s = try run.connect.get(id)
        run.connect.keepRecall(s, "ChatGPT", "# Research profile\n\nStudies novices.")
        let file = run.root.url.appendingPathComponent(".connect/\(id)/memories/ChatGPT.md").path
        XCTAssertEqual(try? String(contentsOfFile: file, encoding: .utf8), "# Research profile\n\nStudies novices.\n")
        XCTAssertEqual((try? FileManager.default.attributesOfItem(atPath: file))?[.posixPermissions] as? Int, 0o600)
        let stopped = try run.connect.stop(id)
        XCTAssertEqual(stopped["stopped"], true)
        XCTAssertTrue(jobs(stopped).allSatisfy { ["stopped", "done", "failed"].contains(JS.string($0["status"])) }, "\(jobs(stopped))")
        XCTAssertTrue(try run.connect.dismiss(id))
    }
}
