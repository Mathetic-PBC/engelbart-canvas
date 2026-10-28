import XCTest
import SQLite3
import EngelbartCore
@testable import EngelbartConnect

final class ModulesTests: XCTestCase {
    // provider-failure.cjs
    func testNeedsProvider() {
        XCTAssertTrue(ProviderFailure.needsProvider(ConnectError("failed", "Not logged in · Please run /login")))
        XCTAssertTrue(ProviderFailure.needsProvider(ConnectError("unavailable", "Claude Code was not found on the login shell PATH.")))
        XCTAssertTrue(ProviderFailure.needsProvider(ConnectError("failed", "Credit balance is too low")))
        XCTAssertFalse(ProviderFailure.needsProvider(ConnectError("failed", "You hit your limit")))
        XCTAssertFalse(ProviderFailure.needsProvider(ConnectError("unavailable", "rate limit reached")))
        XCTAssertFalse(ProviderFailure.needsProvider(ConnectError("stopped", "Not logged in")))
        XCTAssertFalse(ProviderFailure.needsProvider(nil))
        XCTAssertFalse(ProviderFailure.needsProvider(ConnectError("failed", "The model returned no text.")))
    }

    // signin-profiles.cjs
    func testSigninProfiles() {
        let dir = TempDir()
        let p = SigninProfiles(dataRoot: { dir.url })
        XCTAssertNil(p.get("google.com"))
        XCTAssertTrue(p.set("google.com", browser: "chrome", profile: "Profile 1"))
        XCTAssertEqual(p.get("google.com")?.profile, "Profile 1")
        XCTAssertFalse(p.set("google.com", browser: "chrome", profile: "bad/../profile"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.url.appendingPathComponent(".connect/signin-profiles.json").path))
    }

    // memory.cjs
    func testScrubSecrets() {
        let out = Memory.scrubSecrets("password: hunter2\nkey sk-test-0123456789abcdefghij here\nAKIAABCDEFGHIJKLMNOP\nghp_abcdefghijklmnopqrstuvwxyz0123\nplain text")
        XCTAssertFalse(out.text.contains("hunter2"))
        XCTAssertFalse(out.text.contains("sk-test-0123456789"))
        XCTAssertFalse(out.text.contains("AKIAABCD"))
        XCTAssertTrue(out.text.contains("plain text"))
        XCTAssertEqual(out.removed, 4)
        // already removed is not counted again
        XCTAssertEqual(Memory.scrubSecrets("password: [removed]").removed, 0)
    }

    func testSaveMemoryKeepsHistory() throws {
        let dir = TempDir()
        XCTAssertThrowsError(try Memory.save(dir.url, "   "))
        let first = try Memory.save(dir.url, "# Memory\n\nOne.")
        XCTAssertNil(first.previous)
        let second = try Memory.save(dir.url, "# Memory\n\nTwo.")
        XCTAssertNotNil(second.previous)
        XCTAssertEqual(try String(contentsOf: second.previous!, encoding: .utf8), "# Memory\n\nOne.\n")
        XCTAssertEqual(Memory.read(dir.url), "# Memory\n\nTwo.")
        XCTAssertTrue(Memory.block(dir.url).hasPrefix("<memory note=\"MEMORY.md: what Engelbart learned"))
        XCTAssertEqual(Memory.block(TempDir().url), "")
    }

    func testLocalMemories() {
        let home = TempDir()
        home.write(".claude/CLAUDE.md", "be terse")
        home.write("codexhome/AGENTS.md", "codex rules")
        let out = Memory.localMemories(homeDir: home.path, env: ["CODEX_HOME": home.url.appendingPathComponent("codexhome").path])
        XCTAssertEqual(out.map(\.app), ["Claude Code", "Codex"])
        XCTAssertEqual(out[0].file, "~/.claude/CLAUDE.md")
    }

    // cursor.cjs
    func makeCursorDb(_ home: TempDir) {
        let path = home.url.appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/state.vscdb").path
        try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        var db: OpaquePointer?
        sqlite3_open(path, &db)
        sqlite3_exec(db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);", nil, nil, nil)
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let head = #"{"composerId":"abcdef01-2345","name":"Refactor parser","lastUpdatedAt":\#(now),"fullConversationHeadersOnly":[{"bubbleId":"b1","type":1},{"bubbleId":"b2","type":2}]}"#
        for (k, v) in [("composerData:abcdef01-2345", head), ("bubbleId:abcdef01-2345:b1", #"{"type":1,"text":"Please refactor the parser"}"#), ("bubbleId:abcdef01-2345:b2", #"{"type":2,"text":"Done."}"#)] {
            sqlite3_exec(db, "INSERT INTO cursorDiskKV VALUES ('\(k)', '\(v)');", nil, nil, nil)
        }
        sqlite3_close(db)
    }

    func testCursorChats() throws {
        let home = TempDir()
        XCTAssertThrowsError(try Cursor.chats(homeDir: home.path)) { XCTAssertEqual(($0 as? ConnectError)?.message, "Cursor has no chats on this Mac") }
        makeCursorDb(home)
        let chats = try Cursor.chats(homeDir: home.path)
        XCTAssertEqual(chats.count, 1)
        XCTAssertEqual(chats[0].title, "Refactor parser")
        XCTAssertEqual(chats[0].first, "Please refactor the parser")
        XCTAssertEqual(try Cursor.chats(homeDir: home.path, query: "nothing").count, 0)
        let t = try Cursor.transcript(homeDir: home.path, id: "abcdef01-2345")
        XCTAssertEqual(t.turns.map(\.role), ["user", "assistant"])
        XCTAssertThrowsError(try Cursor.transcript(homeDir: home.path, id: "x"))
    }

    // own-connectors.cjs
    func testOwnConnectors() async {
        let home = TempDir()
        home.write(".claude.json", #"{"mcpServers":{"granola":{"type":"http","url":"https://mcp.granola.ai/mcp/"},"bad name":{"type":"http","url":"https://mcp.notion.com/mcp"},"engelbart":{"type":"http","url":"https://mcp.notion.com/mcp"},"local":{"command":"x"}}}"#)
        let own = OwnConnectors(homeDir: home.path, env: [:], codexList: { #"[{"name":"linear","enabled":true,"transport":{"url":"https://mcp.linear.app/mcp"},"auth_status":"o_auth"},{"name":"notion","transport":{"url":"https://mcp.notion.com/mcp"},"auth_status":"not_logged_in"}]"# })
        let claude = await own.serversFor(["Granola", "Notion"], provider: "anthropic")
        XCTAssertEqual(claude.map(\.app), ["Granola"])
        XCTAssertEqual(claude.first?.name, "granola")
        let codex = await own.serversFor(["Linear", "Notion"], provider: "openai")
        XCTAssertEqual(codex.map(\.app), ["Linear"])
        XCTAssertEqual(OwnConnectors.officialServers()["https://mcp.linear.app/sse"], "Linear")
    }

    // apple-notes.cjs
    func testNoteMarkdown() {
        let md = AppleNotes.noteMarkdown("<div><h1>Groceries</h1></div><div>Buy <b>milk</b> &amp; <i>eggs</i></div><ul><li>one</li><li>two</li></ul><a href=\"https://x.org\">link</a>", name: "Groceries")
        XCTAssertFalse(md.hasPrefix("# Groceries"))
        XCTAssertTrue(md.contains("Buy **milk** & *eggs*"))
        XCTAssertTrue(md.contains("- one"))
        XCTAssertTrue(md.contains("[link](https://x.org)"))
    }

    func testAppleNotesRefusal() async {
        let notes = AppleNotes(run: { _ in ("", "execution error: Not authorized to send Apple events to Notes. (-1743)", "failed") })
        let p = await notes.permission()
        XCTAssertFalse(p.allowed)
        XCTAssertTrue(p.refused)
        XCTAssertEqual(p.error, AppleNotes.notAllowed)
        let list = AppleNotes(run: { args in
            XCTAssertEqual(args[4], "list")
            return (#"[{"id":"x-coredata://a/b/p1","name":"Old","folder":"Notes","modified":"2020-01-01T00:00:00Z"},{"id":"x-coredata://a/b/p2","name":"Gone","folder":"Recently Deleted","modified":"2026-01-01T00:00:00Z"},{"id":"bad","name":"x"}]"#, "", nil)
        })
        let rows = try? await list.list()
        XCTAssertEqual(rows?.count, 1)
    }

    // skills.cjs
    func testSkills() throws {
        XCTAssertTrue(Skills.skillsFor(source: "notes", apps: ["Obsidian", "Obsidian"]).contains("# Obsidian"))
        XCTAssertTrue(Skills.skillsFor(source: "sites", apps: []).contains("# Websites"))
        XCTAssertTrue(Skills.skillsFor(source: "code", apps: []).contains("# GitHub"))
        XCTAssertEqual(Skills.skillsFor(source: "notes", apps: ["Nope"]), "")
        let root = TempDir()
        root.write(".context/connect-skills/Obsidian.md", "  my own skill  ")
        XCTAssertEqual(Skills.skillOf("Obsidian", dataRoot: root.url), "my own skill")
        XCTAssertEqual(Texts.skillsOrder.count, Texts.skills.count)
    }

    // folder-access.cjs
    func testFolderAccess() async {
        let home = TempDir()
        home.mkdir("Desktop"); home.mkdir("Documents"); home.mkdir("Library/CloudStorage/GoogleDrive-a@x.com"); home.mkdir("Library/CloudStorage/GoogleDrive-b@x.com"); home.mkdir("code/repo")
        let folders = FolderAccess.protectedFolders(homeDir: home.path)
        XCTAssertEqual(folders.map(\.name), ["Desktop", "Documents", "Google Drive (a@x.com)", "Google Drive (b@x.com)"])
        let root = TempDir()
        let g = FolderAccess.guardFor(homeDir: home.path, dataRoot: root.url, picked: [home.url.appendingPathComponent("Documents/picked").path])
        XCTAssertFalse(g.readable(home.url.appendingPathComponent("Desktop/x").path))
        XCTAssertFalse(g.readable(home.url.appendingPathComponent("Downloads/x").path)) // never present: guarded all the same
        XCTAssertTrue(g.readable(home.url.appendingPathComponent("Documents/picked/inner").path))
        XCTAssertTrue(g.readable(home.url.appendingPathComponent("code/repo").path))
        XCTAssertTrue(g.readable(home.url.appendingPathComponent("Library/CloudStorage").path))
        let needed = FolderAccess.needed(["sources": ["papers": ["on": true, "apps": ["PDFs on this Mac"]]], "permissions": ["files": true]], homeDir: home.path, dataRoot: root.url)
        XCTAssertEqual(needed.count, 4)
        let answers = await FolderAccess.ask(["Desktop", "Missing"], homeDir: home.path, dataRoot: root.url)
        XCTAssertEqual(answers, ["Desktop": "allowed"])
        XCTAssertEqual(FolderAccess.readAnswers(dataRoot: root.url)["Desktop"], "allowed")
        XCTAssertEqual(FolderAccess.needed(["sources": ["papers": ["on": true, "apps": ["PDFs on this Mac"]]], "permissions": ["files": true]], homeDir: home.path, dataRoot: root.url).count, 3)
    }

    // notes.cjs
    func testConvertMarkdown() {
        let vault = TempDir()
        vault.write("img/pic.png", "png")
        vault.write("Notes/a.md", "x")
        let out = Notes.convertMarkdown("See [[Other note|shown]] and ![[pic.png|300]] and ![[Embedded]] and [Title](Notion%20Page%200123456789abcdef0123456789abcdef.md) and ![web](https://x.org/a.png)",
                                        sourcePath: vault.url.appendingPathComponent("Notes/a.md").path, root: vault.path, index: Notes.Index())
        XCTAssertTrue(out.body.contains("@[Other note]"))
        XCTAssertTrue(out.body.contains("@[Embedded]"))
        XCTAssertTrue(out.body.contains("@[Notion Page]"))
        XCTAssertTrue(out.body.contains("![pic](engelbart-image:0)"))
        XCTAssertTrue(out.body.contains("![web](https://x.org/a.png)"))
        XCTAssertEqual(out.images.count, 1)
        let prepared = Notes.prepareFile(body: out.body, images: out.images)
        XCTAssertTrue(prepared.text.contains("![pic](pic.png)"))
        XCTAssertEqual(prepared.pictures.first?.name, "pic.png")
        XCTAssertEqual(Notes.noteName("folder/My: Note.md"), "My Note")
        XCTAssertEqual(Names.sanitize("  ..hidden  "), "hidden")
        XCTAssertEqual(Names.sanitize(""), "Untitled")
    }

    // gmail.cjs
    func testGmail() throws {
        XCTAssertEqual(Gmail.period(365), " newer_than:1y")
        XCTAssertEqual(Gmail.period(182), " newer_than:6m")
        XCTAssertEqual(Gmail.period(30.5), " newer_than:31d")
        XCTAssertEqual(Gmail.period(nil), "")
        XCTAssertThrowsError(try Gmail.accountIndex(10))
        XCTAssertEqual(try Gmail.printUrl(1, ik: "abc123", id: "thread-f:123"), "https://mail.google.com/mail/u/1/?ik=abc123&view=pt&search=all&permthid=thread-f:123")
        XCTAssertThrowsError(try Gmail.printUrl(1, ik: "AB", id: "thread-f:123"))
        let html = """
        <html><head><title>Gmail - Pilot study</title></head><body><font size=+1><b>Pilot study</b></font>
        <table class="message"><tr><td><b>Lee Smith</b> &lt;lee@uni.edu&gt;</td><td align="right">Oct 10, 2025, 3:04 PM</td></tr><tr><td>Hello<br>see <a href="https://x.org">https://x.org</a><blockquote>old</blockquote></td></tr></table>
        <table class="message"><tr><td><b>Ana</b></td><td align="right">Oct 11, 2025, 9:00 AM</td></tr><tr><td>Reply text<br><br>On Oct 10 Lee wrote:</td></tr></table></body></html>
        """
        let t = Gmail.readThread(html)
        XCTAssertEqual(t.subject, "Pilot study")
        XCTAssertEqual(t.messages.map(\.sender), ["Lee Smith", "Ana"])
        XCTAssertTrue(t.messages[0].text.contains("see https://x.org"))
        XCTAssertFalse(t.messages[0].text.contains("old"))
        XCTAssertEqual(t.people, ["Lee Smith", "Ana"])
        let note = Gmail.threadNote(t)
        XCTAssertTrue(note.hasPrefix("*Gmail · Oct 10, 2025, 3:04 PM–Oct 11, 2025, 9:00 AM · Lee Smith, Ana*"))
        XCTAssertTrue(Gmail.isThreadPage(finalUrl: "https://mail.google.com/mail/u/0/", html: html))
        XCTAssertFalse(Gmail.isThreadPage(finalUrl: "https://accounts.google.com/", html: html))
        XCTAssertTrue(Gmail.signedOut("<title>Sign in - Google Accounts</title>"))
        XCTAssertEqual(Gmail.htmlText("a&nbsp;b<br>c &#39;d&#39;"), "a b\nc 'd'")
        XCTAssertNotNil(Gmail.lastDay(t))
    }

    // web-chats.cjs
    func testWebChats() async throws {
        let page = FakePage([{ s in s.contains("/backend-api/conversations?offset=") ? ["signedIn": true, "account": "me@x.org", "items": [["id": "abcdef12", "title": "Thesis plan", "update_time": 1_760_000_000, "project": .null], ["id": "zz", "title": "bad id"]]] : nil }])
        let out = try await WebChats.list(page, "ChatGPT")
        XCTAssertEqual(out["chats"]?.array?.count, 1)
        XCTAssertEqual(out["account"]?.string, "me@x.org")
        XCTAssertTrue(page.evaluated[0].contains("'/backend-api/conversations?offset=' + offset + '&limit=100&order=updated'"))
        let signedOut = FakePage([{ _ in ["signedIn": false] }])
        do { _ = try await WebChats.list(signedOut, "Claude"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.kind, "signed-out") }
        let unsure = FakePage([{ _ in ["signedIn": .null, "status": 403] }])
        do { _ = try await WebChats.list(unsure, "Claude", sleep: { _ in }); XCTFail() } catch { XCTAssertTrue((error as? ConnectError)?.message.contains("twice") == true) }
        XCTAssertEqual(WebChats.chatIdOf("ChatGPT", "https://chatgpt.com/g/g-p-123/c/abc-123456"), "abc-123456")
        XCTAssertEqual(WebChats.chatIdOf("Claude", "https://claude.ai/chat/12345678-1234-1234-1234-123456789abc"), "12345678-1234-1234-1234-123456789abc")
        XCTAssertNil(WebChats.chatIdOf("Claude", "https://claude.ai/new"))
        let one = FakePage([{ s in s.contains("/backend-api/conversation/") ? ["signedIn": true, "conversation": ["title": "T", "current_node": "b", "mapping": ["a": ["message": ["author": ["role": "user"], "content": ["parts": ["Q?"]]]], "b": ["parent": "a", "message": ["author": ["role": "assistant"], "content": ["parts": ["A."]]]]]]] : nil }])
        let chat = try await WebChats.read(one, "ChatGPT", "abcdef12")
        XCTAssertEqual(chat.turns.map(\.text), ["Q?", "A."])
        do { _ = try await WebChats.delete(one, "ChatGPT", "abcdef12", question: "Something else entirely"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "that chat is not the question Engelbart sent, so it was left as it is") }
    }
}
