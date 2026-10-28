import XCTest
import SQLite3
import EngelbartCore
@testable import EngelbartConnect

/// tools.cjs as connect.test.cjs drives it ("the import tools", "each kind of agent is served its own tools", "a browser
/// agent's tools", the Drive approvals): every tool over fixture files, a fake library and a fake page.
final class ImportToolsTests: XCTestCase {
    struct Kit { let home: TempDir; let root: TempDir; let store: FakeStore; let session: ToolSession; let counted: Box<[String: Int]>; let logged: Box<[String]> }

    func kit(approved: [String: Set<String>] = [:], exports: [String: String] = [:], days: Double? = nil) -> Kit {
        let home = TempDir(), root = TempDir()
        let store = FakeStore(root: root.path)
        let session = ToolSession(dataRoot: root.path, homeDir: home.path, dir: root.url.appendingPathComponent(".connect/tools-test").path, downloads: root.url.appendingPathComponent("dl").path,
                                  apps: ["Google Docs"], approvedFor: approved.isEmpty ? nil : { approved[$0] }, exports: { exports }, days: { days })
        return Kit(home: home, root: root, store: store, session: session, counted: Box([:]), logged: Box([]))
    }
    func tools(_ k: Kit, kind: String = "import", page: AgentPage? = nil, needs: ToolNeeds? = nil, recall: ((String, String) async -> Void)? = nil,
               appleNotes: AppleNotes? = nil, zotero: ConnectZotero = .none, github: ConnectGitHub = .none) -> ImportTools {
        ImportTools(session: k.session, store: k.store, kind: kind, page: page, needs: needs, recall: recall, appleNotes: appleNotes, zotero: zotero, github: github, env: [:],
                    added: { kind, n, _ in var c = k.counted.get(); c[kind, default: 0] += n; k.counted.set(c) }, log: { k.logged.set(k.logged.get() + [$0]) })
    }
    func call(_ t: ImportTools, _ name: String, _ args: JSONValue) async throws -> JSONValue {
        let v = try await t.call(name, args)
        return (v as? JSONValue) ?? ((v as? MCPContent).map { ["content": $0.content] } ?? .null)
    }
    func message(_ work: () async throws -> Any) async -> String {
        do { _ = try await work(); return "" } catch { return (error as? ConnectError)?.message ?? "\(error)" }
    }

    func testNotesChatsAndTheLibrary() async throws {
        let k = kit()
        for day in ["2026-10-01", "2026-10-02"] { k.home.write("Vault/Journal/\(day).md", "# \(day)\n") }
        k.home.write("Vault/Research/Idea.md", "Builds on [[Other note]].\n\n![[pic.png|300]]\n")
        k.home.write("Vault/Research/Other note.md", "The other note.\n")
        k.home.write("Vault/attachments/pic.png", "png")
        k.home.write("Vault/Personal/Secret.md", "private\n")
        k.home.write(".claude/projects/-w-app/s1.jsonl", #"{"type":"user","cwd":"/w/app","entrypoint":"cli","message":{"role":"user","content":"Fix it"}}"# + "\n" + #"{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}"# + "\n")
        let t = tools(k)
        let listed = try await call(t, "list_note_files", ["folder": "~/Vault", "exclude": ["Journal", "Personal"]])
        XCTAssertEqual(listed["total"]?.int, 2)
        let first = try await call(t, "import_note_files", ["files": listed["files"] ?? [], "root": .string(k.home.url.appendingPathComponent("Vault").path)])
        XCTAssertEqual(first["added"]?.int, 2)
        let idea = k.store.added.first { $0.name == "Idea" }
        XCTAssertTrue(idea?.text.contains("@[Other note]") == true, idea?.text ?? "")
        let again = try await call(t, "import_note_files", ["files": .array((listed["files"]?.array ?? []) + ["/etc/hosts"])])
        XCTAssertEqual(again["added"]?.int, 0)
        let why = await message { try await self.call(t, "folder_overview", ["path": "relative"]) }
        XCTAssertTrue(why.contains("absolute"), why)
        let chats = try await call(t, "list_chats", ["app": "Claude Code"])
        XCTAssertEqual(chats.array?.count, 1); XCTAssertEqual(chats[0]?["imported"], false)
        let ids: JSONValue = .array((chats.array ?? []).map { $0["id"] ?? .null })
        let read = try await call(t, "read_chat", ["app": "Claude Code", "id": ids[0] ?? .null])
        XCTAssertTrue(JS.string(read["text"]).contains("user: Fix it"))
        let imported1 = try await call(t, "import_chats", ["app": "Claude Code", "ids": ids])
        let imported2 = try await call(t, "import_chats", ["app": "Claude Code", "ids": ids])
        XCTAssertEqual(imported1["added"]?.int, 1); XCTAssertEqual(imported2["added"]?.int, 0)
        let hoisted1 = try await call(t, "list_chats", ["app": "Claude Code"])[0]?["imported"]
        XCTAssertEqual(hoisted1, true)
        XCTAssertTrue(k.store.added.last?.text.hasPrefix("*Claude Code · ") == true)
        let claude = await message { try await self.call(t, "list_chats", ["app": "Claude"]) }
        XCTAssertEqual(claude, "There is no Claude export on this Mac; use web_chats for Claude.")
        let noBrowser = await message { try await self.call(t, "web_chats", ["app": "ChatGPT"]) }
        XCTAssertTrue(noBrowser.contains("browser is not available"), noBrowser)
        let nobody = await message { try await self.call(t, "needs_you", ["kind": "signin", "reason": "x"]) }
        XCTAssertEqual(nobody, "Nobody can be asked from here. Say what you could not do in your reply.")
        let site = try await call(t, "add_to_library", ["input": "https://distill.pub/", "name": "Distill"])
        XCTAssertEqual(site["added"], true)
        let dup = try await call(t, "add_to_library", ["input": "https://distill.pub/"])
        XCTAssertEqual(dup["added"], false)
        XCTAssertEqual(k.counted.get(), ["notes": 3, "items": 1])
        let zotero = await message { try await self.call(t, "zotero_collections", .object([:])) }
        XCTAssertTrue(zotero.contains("Zotero is not signed in"), zotero)
        let github = await message { try await self.call(t, "github_repos", .object([:])) }
        XCTAssertEqual(github, "GitHub is not signed in. Call needs_you with kind \"signin\" and reason \"Sign in to GitHub\".")
        // Library switched mid-run: the tools stop.
        let other = ImportTools(session: k.session, store: FakeStore(root: TempDir().path), kind: "import", env: [:])
        let switched = await message { try await self.call(other, "add_note", ["title": "x", "markdown": "y"]) }
        XCTAssertEqual(switched, "Engelbart switched to another library while this import ran; it stopped.")
    }

    func testKindsAndRecall() async throws {
        let names = { (kind: String) in Tools.toolsFor(kind).compactMap { $0["name"]?.string } }
        XCTAssertTrue(names("survey").contains("browser_read") && !names("survey").contains("import_note_files") && !names("survey").contains("save_memory"))
        XCTAssertEqual(names("recall").filter { !$0.hasPrefix("browser_") }, ["needs_you", "wait_for_you", "save_memory"])
        XCTAssertTrue(!names("import").contains("save_memory") && names("import").contains("import_google_files"))
        XCTAssertEqual(Set(Tools.definitions.compactMap { $0["name"]?.string }).count, Tools.definitions.count)
        for name in ["add_note", "add_to_library", "import_pdfs", "unpack", "import_note_files", "needs_you", "wait_for_you"] { XCTAssertTrue(names("browse").contains(name), name) }
        for name in ["browser_open", "browser_eval", "browser_type", "browser_download", "web_chats", "import_google_files", "import_gmail_threads", "save_memory"] { XCTAssertFalse(names("browse").contains(name), name) }
        XCTAssertTrue(Prompts.browseSystemPrompt("openai").contains("search your tools for \"node_repl js\""))
        XCTAssertTrue(Prompts.browseSystemPrompt("anthropic").contains("tabs_create_mcp"))
        XCTAssertTrue(Texts.browseRules.contains("Close every tab you opened before you reply"))
        let k = kit()
        let kept = Box<[[String]]>([])
        let recall = tools(k, kind: "recall", recall: { app, text in kept.set(kept.get() + [[app, text]]) })
        let short = await message { try await self.call(recall, "save_memory", ["app": "ChatGPT", "text": "short"]) }
        XCTAssertTrue(short.contains("too short"))
        let saved = try await call(recall, "save_memory", ["app": "ChatGPT", "text": "# Research profile\nStudies help-seeking."])
        XCTAssertEqual(saved, ["saved": true, "chars": 40])
        XCTAssertEqual(kept.get(), [["ChatGPT", "# Research profile\nStudies help-seeking."]])
        let notAllowed = await message { try await self.call(recall, "add_note", ["title": "x", "markdown": "y"]) }
        XCTAssertTrue(notAllowed.contains("not one of this agent's tools"), notAllowed)
    }

    func testNeedsYouWaits() async throws {
        let k = kit()
        let asked = Box<[String]>([])
        let waits = Box(0)
        let needs = ToolNeeds(ask: { kind, reason in asked.set(asked.get() + ["\(kind): \(reason)"]); return ["status": "waiting"] },
                              wait: { waits.set(waits.get() + 1); return waits.get() < 2 ? ["status": "waiting"] : ["status": "done"] })
        let t = tools(k, needs: needs)
        let bad = await message { try await self.call(t, "needs_you", ["kind": "nope", "reason": "x"]) }
        XCTAssertTrue(bad.hasPrefix("kind must be one of"))
        let out = try await call(t, "needs_you", ["kind": "signin", "reason": "Sign in   to\nNotion"])
        XCTAssertEqual(out["status"]?.string, "waiting"); XCTAssertEqual(asked.get(), ["signin: Sign in to Notion"])
        let hoisted2 = try await call(t, "wait_for_you", .object([:]))["status"]?.string
        XCTAssertEqual(hoisted2, "waiting")
        let hoisted3 = try await call(t, "wait_for_you", .object([:]))["status"]?.string
        XCTAssertEqual(hoisted3, "done")
        let hoisted4 = try await call(t, "wait_for_you", .object([:]))["note"]?.string
        XCTAssertEqual(hoisted4, "Nothing is waiting on the person.")
    }

    func testPdfsUnpackAndLinks() async throws {
        let k = kit(days: 30)
        k.home.write("Papers/2401.12345.pdf", "%PDF-1.4"); k.home.write("Papers/paper-two.pdf", "%PDF-1.4"); k.home.write("Papers/notes.txt", "x")
        k.home.write("Notes/a.md", "See https://arxiv.org/abs/1 and https://arxiv.org/abs/1.")
        let t = tools(k)
        let listed = try await call(t, "list_pdfs", ["folder": "~/Papers", "check": true])
        XCTAssertEqual(listed["total"]?.int, 2); XCTAssertEqual(listed["checked"]?.int, 2)
        XCTAssertTrue((listed["pdfs"]?.array ?? []).contains { $0["paper"] == true })
        let files: JSONValue = ["~/Papers/2401.12345.pdf", "~/Papers/notes.txt", "~/Papers/missing.pdf", "/etc/hosts"]
        let out = try await call(t, "import_pdfs", ["files": files])
        XCTAssertEqual(out["added"]?.int, 1)
        XCTAssertEqual(out["skippedCount"]?.int, 3)
        let again = try await call(t, "import_pdfs", ["files": ["~/Papers/2401.12345.pdf"]])
        XCTAssertEqual(again["skipped"]?[0]?["why"]?.string, "in the library already")
        XCTAssertTrue(k.logged.get().contains("Brought in 1 PDF"))
        // unpack: a zip into the session's downloads, names kept safe.
        k.home.write("dl/export/a.md", "A"); k.home.write("dl/export/sub/b.md", "B")
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/zip"); p.arguments = ["-q", "-r", "../Export (1).zip", "."]
        p.currentDirectoryURL = k.home.url.appendingPathComponent("dl/export"); try p.run(); p.waitUntilExit()
        let unpacked = try await call(t, "unpack", ["file": "~/dl/Export (1).zip"])
        XCTAssertEqual(unpacked["files"]?.int, 2)
        XCTAssertTrue(JS.string(unpacked["folder"]).hasSuffix("/dl/Export -1-"), JS.string(unpacked["folder"]))
        XCTAssertEqual(unpacked["overview"]?["notes"]?.int, 2)
        let notZip = await message { try await self.call(t, "unpack", ["file": "~/Notes/a.md"]) }
        XCTAssertEqual(notZip, "Only a .zip can be unpacked")
        let links = try await call(t, "links_in_notes", ["folder": "~/Notes"])
        XCTAssertEqual(links[0]?["url"]?.string, "https://arxiv.org/abs/1"); XCTAssertEqual(links[0]?["count"]?.int, 2)
    }

    func testAppleNotesHistoryBookmarksZoteroGitHub() async throws {
        let k = kit()
        let notes = AppleNotes(run: { args in
            switch args[4] {
            case "folders": return (#"[{"name":"Notes","count":2}]"#, "", nil)
            case "list": return (#"[{"id":"x-coredata://A/ICNote/p1","name":"Trip","folder":"Notes","modified":"2026-10-01T00:00:00Z"}]"#, "", nil)
            default: return (#"[{"id":"x-coredata://A/ICNote/p1","name":"Trip","folder":"Notes","modified":"2026-10-01T00:00:00Z","body":"<div>Plan the trip</div>"},{"id":"x-coredata://A/ICNote/p2","error":"locked"}]"#, "", nil)
            }
        })
        let t = tools(k, appleNotes: notes)
        let hoisted5 = try await call(t, "apple_notes_folders", .object([:]))[0]?["name"]?.string
        XCTAssertEqual(hoisted5, "Notes")
        let hoisted6 = try await call(t, "apple_notes_list", .object([:])).array?.count
        XCTAssertEqual(hoisted6, 1)
        let imported = try await call(t, "import_apple_notes", ["ids": ["x-coredata://A/ICNote/p1", "x-coredata://A/ICNote/p2"]])
        XCTAssertEqual(imported["added"]?.int, 1)
        XCTAssertEqual(k.store.added.last?.name, "Trip"); XCTAssertEqual(k.store.added.last?.about?["source"]?.string, "Apple Notes")
        let twice = try await call(t, "import_apple_notes", ["ids": ["x-coredata://A/ICNote/p1"]])
        XCTAssertEqual(twice["skipped"]?[0]?["why"]?.string, "brought in before")
        // A Chromium profile's history and bookmarks.
        let dir = k.home.mkdir("Library/Application Support/Google/Chrome/Default")
        var db: OpaquePointer?
        sqlite3_open(dir + "/History", &db)
        sqlite3_exec(db, "CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER); INSERT INTO urls VALUES ('https://arxiv.org/abs/1','Paper',4,\(Int64(Readers.chromeTime(Time.ms()))),0);", nil, nil, nil)
        sqlite3_close(db)
        k.home.write("Library/Application Support/Google/Chrome/Default/Bookmarks", #"{"roots":{"bookmark_bar":{"type":"folder","name":"","children":[{"type":"url","name":"Distill","url":"https://distill.pub"}]}}}"#)
        let history = try await call(t, "browser_history", ["by": "page"])
        XCTAssertEqual(history["browser"]?.string, "Chrome"); XCTAssertEqual(history["entries"]?[0]?["title"]?.string, "Paper")
        let hoisted7 = try await call(t, "browser_bookmarks", .object([:]))["bookmarks"]?[0]?["title"]?.string
        XCTAssertEqual(hoisted7, "Distill")
        // Zotero through its mirror; GitHub through the Integrations adapter.
        let z = k.home.mkdir("zot")
        k.home.write("zot/items.json", #"[{"key":"K1","title":"Paper one","creators":[{"type":"author","last":"Ng"}],"collections":["C1"]}]"#)
        k.home.write("zot/collections.json", #"[{"key":"C1","name":"Reading","path":"Reading"}]"#)
        var zotero = ConnectZotero.none
        zotero.status = { ZoteroStatus(connected: true) }
        zotero.root = { z }
        var github = ConnectGitHub.none
        github.status = { GitHubStatus(connected: true) }
        github.repos = { _ in ["repos": [["fullName": "a/b", "url": "https://github.com/a/b", "private": true]]] }
        let t2 = tools(k, zotero: zotero, github: github)
        let hoisted8 = try await call(t2, "zotero_collections", .object([:]))["collections"]?[0]?["path"]?.string
        XCTAssertEqual(hoisted8, "Reading")
        let hoisted9 = try await call(t2, "zotero_items", ["collection": "C1"])[0]?["title"]?.string
        XCTAssertEqual(hoisted9, "Paper one")
        let hoisted10 = try await call(t2, "github_repos", .object([:]))[0]?["fullName"]?.string
        XCTAssertEqual(hoisted10, "a/b")
    }

    // The Drive approvals: an id the person did not tick is skipped before anything is fetched.
    func testDriveApprovalsAndOverleafAndWebChats() async throws {
        let k = kit(approved: ["Google Docs": ["google-docs-2"]])
        let page = FakePage([])
        let t = tools(k, page: page)
        let out = try await call(t, "import_google_files", ["items": [["id": "google-docs-1", "kind": "doc", "name": "One"], ["id": "google-docs-3", "kind": "doc", "name": "Three"]]])
        XCTAssertEqual(out["skipped"]?.array?.map { [JS.string($0["id"]), JS.string($0["why"])] }, [["google-docs-1", "the person did not approve it: only what they ticked comes in"], ["google-docs-3", "the person did not approve it: only what they ticked comes in"]])
        XCTAssertTrue(page.evaluated.isEmpty)
        XCTAssertEqual(Tools.toolNamesFor("import", apps: ["Google Docs"], approvals: true).filter { $0 == "browser_open" }, [])
        XCTAssertEqual(Tools.toolNamesFor("survey", apps: ["Google Docs"], approvals: true).filter { $0 == "browser_open" }, ["browser_open"])
        // Overleaf's list through the page; signed out said so.
        let overleaf = FakePage([{ s in s.contains("ol-prefetchedProjectsBlob") ? ["signedIn": true, "projects": [["id": "64f0c0ffee0123456789abcd", "name": "Thesis"], ["id": "bad", "name": "x"]]] : nil }])
        let listed = try await call(tools(k, page: overleaf), "overleaf_projects", .object([:]))
        XCTAssertEqual(listed["projects"]?.array?.map { JS.string($0["name"]) }, ["Thesis"])
        let signedOut = FakePage([{ s in s.contains("ol-prefetchedProjectsBlob") ? ["signedIn": false] : nil }])
        let said = await message { try await self.call(self.tools(k, page: signedOut), "overleaf_projects", .object([:])) }
        XCTAssertTrue(said.hasPrefix("Not signed in to Overleaf in Engelbart's browser."))
        let tex = TempDir()
        tex.write("a/intro.tex", "\\section{x}"); let paper = tex.write("a/paper.tex", "\\documentclass{article}")
        XCTAssertEqual(Tools.findMainTex(tex.path), paper, "the one with \\documentclass")
        let main = tex.write("main.tex", "\\documentclass{article}\n\\input{a/intro}")
        XCTAssertEqual(Tools.findMainTex(tex.path), main, "main.tex first")
        XCTAssertNil(Tools.findMainTex(TempDir().path))
    }
}
