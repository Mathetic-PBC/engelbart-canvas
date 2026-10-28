import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// connect.test.cjs "a session with the fake agents": the real session engine, the real tool bridge and import tools,
/// the fake agents (fake.cjs) in place of Claude Code / Codex.
@MainActor
final class SessionTests: XCTestCase {
    func until(_ connect: Connect, _ id: String, _ what: String, timeout: Double = 20, _ check: (JSONValue) -> Bool) async throws -> JSONValue {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            let s = try connect.state(id)
            if check(s) { return s }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what): \(try connect.state(id).text())")
        return try connect.state(id)
    }

    func writeVault(_ home: TempDir) {
        home.write("Vault/.obsidian/daily-notes.json", #"{"folder":"Journal"}"#)
        for day in ["2026-10-01", "2026-10-02", "2026-10-03"] { home.write("Vault/Journal/\(day).md", "# \(day)\nate lunch\n") }
        home.write("Vault/Research/Idea.md", "An idea that builds on [[Other note]] and [[Folder/Third|the third]].\n\nSee https://example.org/paper.\n")
        home.write("Vault/Research/Other note.md", "The other note. ![[Idea]]\n")
        home.write("Vault/Personal/Secret.md", "private\n")
    }

    func testFakeSessionEndToEnd() async throws {
        let home = TempDir()
        let root = TempDir()
        let outside = TempDir()
        writeVault(outside)
        let store = FakeStore(root: root.path)
        var snapshots: [JSONValue] = []
        var deps = ConnectDeps(agents: FakeAgents(delayMs: 5, env: [:]), store: store, homeDir: home.path)
        deps.env = [:]
        deps.ready = { ["anthropic", "openai"] }
        deps.allowedAll = true
        deps.recoverWaitsMs = [0]
        deps.notify = { snapshots.append($0) }
        let connect = Connect(deps)

        do { _ = try await connect.start(["sources": [:]]); XCTFail("no source picked") } catch {
            XCTAssertTrue((error as? ConnectError)?.message.contains("Pick at least one source") == true, "\(error)")
        }
        let started = try await connect.start(["sources": ["notes": ["on": true, "apps": ["Obsidian"]], "sites": ["on": true]], "provider": "openai", "computer": false])
        let id = JS.string(started["id"])
        XCTAssertEqual(started["choice"], ["provider": "openai", "name": "Codex", "modelName": "Sol", "effort": "high"])
        var now = try await until(connect, id, "the first turn") { $0["thinking"] != true && ($0["chat"]?.array?.count ?? 0) > 0 }
        XCTAssertEqual(now["chat"]?[0]?["opener"], true)
        XCTAssertEqual(now["chat"]?[0]?["text"]?.string, "Had a look at what you picked. Starting with your notes.")
        XCTAssertEqual(now["chat"]?[1]?["authorize"], ["source": "notes", "app": "Obsidian", "kind": "folder", "label": "Choose your Obsidian folder…"])

        // A folder outside the home folder is refused; the vault copied into it is taken.
        do { _ = try await connect.authorize(id, ["app": "Obsidian", "kind": "folder", "path": .string(outside.url.appendingPathComponent("Vault").path)]); XCTFail("outside home") } catch {
            XCTAssertTrue((error as? ConnectError)?.message.contains("inside your home folder") == true, "\(error)")
        }
        try FileManager.default.copyItem(at: outside.url.appendingPathComponent("Vault"), to: home.url.appendingPathComponent("Vault"))
        _ = try await connect.authorize(id, ["app": "Obsidian", "kind": "folder", "path": "~/Vault"])
        now = try await until(connect, id, "the notes question") { s in s["thinking"] != true && (s["chat"]?.array ?? []).contains { JS.truthy($0["ask"]) } }
        XCTAssertEqual(now["chat"]?.array?.map { JS.string($0["role"]) }, ["agent", "agent", "user", "agent"])
        XCTAssertEqual(now["chat"]?[3]?["ask"]?["options"]?[0], ["label": "Everything", "why": "all of it", "detail": ""])
        XCTAssertThrowsError(try connect.answer(id, [:])) { XCTAssertTrue(($0 as? ConnectError)?.message.contains("Say something first") == true) }
        _ = try connect.answer(id, ["picked": ["Everything"], "text": "but not Personal"])
        XCTAssertEqual(try connect.state(id)["chat"]?[4]?["text"]?.string, "Everything — but not Personal")

        now = try await until(connect, id, "the notes import") { s in (s["jobs"]?.array ?? []).contains { $0["kind"]?.string == "import" && $0["status"]?.string == "done" } }
        XCTAssertEqual(now["jobs"]?[0]?["notes"]?.int, 5, "the fake brings in five of the vault's notes")
        XCTAssertEqual(now["staged"]?.int, 0)
        XCTAssertEqual(store.added.count, 5)
        XCTAssertTrue(snapshots.contains { ($0["jobs"]?.array ?? []).contains { $0["status"]?.string == "running" } }, "its progress was sent while it ran")
        XCTAssertTrue((now["log"]?.array ?? []).contains { JS.test(JS.string($0["text"]), "Brought in 5 notes") })

        _ = try await until(connect, id, "the websites question") { $0["thinking"] != true }
        now = try connect.importNow(id)
        XCTAssertEqual(now["jobs"]?.array?.filter { $0["kind"]?.string == "import" }.map { JS.string($0["source"]) }, ["notes", "sites"])
        XCTAssertEqual(now["done"], true)
        now = try await until(connect, id, "MEMORY.md") { ["saved", "failed"].contains(JS.string($0["memory"]?["status"])) }
        XCTAssertEqual(now["memory"]?["status"]?.string, "saved", now["memory"]?.text() ?? "")
        let saved = try String(contentsOf: Memory.path(root.url), encoding: .utf8)
        XCTAssertTrue(saved.hasPrefix("# Memory"))
        XCTAssertTrue(saved.contains("password: [removed]"), "the secrets agent took the password out")
        XCTAssertFalse(saved.contains("sk-test"), "the shape check took the key out")
        XCTAssertEqual(now["memory"]?["removed"]?.int, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.url.appendingPathComponent(".connect/\(id)/session.json").path))

        XCTAssertTrue(try connect.dismiss(id))
        XCTAssertFalse(connect.list(dataRoot: root.path).contains { JS.string($0["id"]) == id })
    }

    /// connect.test.cjs "the librarian's reply as it is read".
    func testReadReplyAndSurvey() throws {
        let home = TempDir()
        let vault = home.mkdir("Vault")
        let choices = SessionText.cleanChoices(["sources": ["notes": ["on": true, "apps": ["Obsidian", "Nope"], "folders": ["/etc", "~/Vault"]], "papers": ["on": false]], "permissions": ["browser": false]], homeDir: home.path)
        XCTAssertEqual(choices.sources["notes"]?.json, ["on": true, "apps": ["Obsidian"], "folders": [.string(vault)], "repos": []])
        XCTAssertEqual(choices.permissions.json, ["files": true, "browser": false, "recall": true, "notes": false])
        let raw = "```json\n" + #"{"say":"Found it.","ask":{"source":"notes","kind":"multi","title":"Which folders?","options":["Research",{"label":"Essays","why":"12 notes"},{"label":"Essays"}]},"authorize":{"app":"Zotero","kind":"signin"},"dispatch":[{"source":"notes","apps":["Obsidian"],"label":"Obsidian","plan":"Research only"},{"source":"papers","plan":"all"}],"done":false}"# + "\n```"
        let reply = SessionText.readReply(raw, choices: choices)
        XCTAssertEqual(reply["ask"], ["source": "notes", "kind": "multi", "title": "Which folders?", "options": [["label": "Research", "why": "", "detail": "", "checked": false], ["label": "Essays", "why": "12 notes", "detail": "", "checked": false]], "placeholder": ""])
        XCTAssertEqual(reply["authorize"], .null, "one thing at a time: the question wins")
        XCTAssertEqual(reply["dispatch"]?.array?.map { JS.string($0["source"]) }, ["notes"], "papers was not picked")
        XCTAssertEqual(SessionText.readReply(#"{"say":"","authorize":{"app":"Zotero","kind":"signin"}}"#, choices: choices)["authorize"], ["source": "papers", "app": "Zotero", "kind": "signin", "label": "Sign in to Zotero"])
        XCTAssertEqual(SessionText.readReply(#"{"authorize":{"app":"Granola","kind":"connector"}}"#, choices: choices)["authorize"]?["label"]?.string, "Sign in to Granola")
        XCTAssertEqual(SessionText.readReply(#"{"authorize":{"app":"Apple Notes","kind":"permission"}}"#, choices: choices)["authorize"]?["label"]?.string, "Allow Engelbart to read Apple Notes")
        XCTAssertEqual(SessionText.readReply(#"{"connect":{"app":"Obsidian","kind":"folder"}}"#, choices: choices)["authorize"]?["kind"]?.string, "folder")
        XCTAssertEqual(SessionText.readReply(#"{"authorize":{"app":"ChatGPT","kind":"folder"}}"#, choices: choices)["authorize"], .null)
        XCTAssertEqual(SessionText.readReply(#"{"authorize":{"app":"Obsidian","kind":"signin"}}"#, choices: choices)["authorize"], .null)
        XCTAssertEqual(SessionText.readReply(#"{"say":"Looking.","waiting":true}"#, choices: choices)["waiting"], true)
        let prose = SessionText.readReply("Sorry, I could not read that.", choices: choices)
        XCTAssertEqual(prose["say"]?.string, "Sorry, I could not read that.")
        XCTAssertEqual(prose["unread"], true)
        let survey = SessionText.readSurvey(#"{"app":"Google Docs","signedIn":true,"summary":"40 docs in 6 folders.","total":40,"items":[{"id":"1abcDEF_ghij","label":"Thesis draft","kind":"doc","date":"2026-10-01","why":"research"},{"label":""}]}"#)
        XCTAssertEqual(survey["items"]?.array?.map { [JS.string($0["id"]), JS.string($0["label"])] }, [["1abcDEF_ghij", "Thesis draft"]])
        XCTAssertEqual(SessionText.readSurvey("not json")["summary"]?.string, "not json")
        let report = JSONValue.object(["app": .string(ConnectSources.localPDFs), "summary": "PDFs in 2 folders.", "items": [], "folders": ["~/Vault", .string(vault), "/tmp", .string(home.path + "/nowhere"), "Vault", 7], "searched": "Documents and Desktop"]).text()
        XCTAssertEqual(SessionText.readSurvey(report, homeDir: home.path)["folders"], [.string(vault)])
        XCTAssertEqual(SessionText.readSurvey(report, homeDir: home.path)["searched"]?.string, "Documents and Desktop")
        XCTAssertEqual(SessionText.readSurvey(report)["folders"], [])
        XCTAssertEqual(AgentKinds.importToolLabel("import_google_files", ["items": [[:]]]), "Bringing in 1 Google Drive file")
    }
}
