import XCTest
import EngelbartCore
@testable import EngelbartConnect

final class ReadersTests: XCTestCase {
    func claudeSession(_ home: TempDir, _ project: String, _ id: String, entry: String = "cli", first: String, title: String? = nil) {
        var lines = [#"{"type":"user","cwd":"\#(home.path)/\#(project)","entrypoint":"\#(entry)","message":{"role":"user","content":"\#(first)"}}"#,
                     #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure."}]}}"#,
                     #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#]
        if let title { lines.append(#"{"type":"custom-title","customTitle":"\#(title)"}"#) }
        home.write(".claude/projects/\(project.replacingOccurrences(of: "/", with: "-"))/\(id).jsonl", lines.joined(separator: "\n") + "\n")
    }

    func testLocalChats() throws {
        let home = TempDir()
        home.mkdir("work/app/.git")
        claudeSession(home, "work/app", "s1", first: "Fix the login bug", title: "Login fix")
        claudeSession(home, "work/app", "s2", entry: "sdk-cli", first: "Automated run")
        claudeSession(home, "work/app", "s3", first: "<command-name>/clear</command-name>")
        let chats = Readers.localChats("Claude Code", homeDir: home.path, env: [:])
        XCTAssertEqual(chats.map(\.title), ["Login fix"])
        XCTAssertEqual(chats[0].first, "Fix the login bug")
        XCTAssertEqual(chats[0].project, "~/work/app")
        XCTAssertEqual(Readers.localChats("Claude Code", homeDir: home.path, env: [:], automated: true).count, 2)
        let t = try Readers.localTranscript("Claude Code", chats[0].id, homeDir: home.path, env: [:])
        XCTAssertEqual(t.turns.map(\.role), ["user", "assistant"])
        XCTAssertThrowsError(try Readers.localTranscript("Claude Code", "../etc/passwd", homeDir: home.path, env: [:]))
        let repos = Scan.localRepos(homeDir: home.path, env: [:])
        XCTAssertEqual(repos.map(\.name), ["app"])
        XCTAssertEqual(repos[0].sessions, 1)
    }

    func testCodexChats() {
        let home = TempDir()
        home.write(".codex/sessions/2026/10/01/rollout-a.jsonl", [#"{"type":"session_meta","payload":{"cwd":"/tmp/x","originator":"codex_cli"}}"#,
                                                                   #"{"type":"event_msg","payload":{"type":"user_message","message":"<environment_context>x</environment_context>"}}"#,
                                                                   #"{"type":"event_msg","payload":{"type":"user_message","message":"<html> pasted page"}}"#].joined(separator: "\n"))
        home.write(".codex/sessions/2026/10/01/rollout-b.jsonl", [#"{"type":"session_meta","payload":{"cwd":"/tmp/x","originator":"codex_exec"}}"#,
                                                                   #"{"type":"event_msg","payload":{"type":"user_message","message":"exec run"}}"#].joined(separator: "\n"))
        let chats = Readers.localChats("Codex", homeDir: home.path, env: [:])
        XCTAssertEqual(chats.map(\.first), ["<html> pasted page"])
        XCTAssertEqual(chats[0].id, "2026/10/01/rollout-a")
    }

    func testExports() throws {
        let dir = TempDir()
        let file = dir.write("conversations.json", #"[{"uuid":"c1","name":"Claude chat","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z","chat_messages":[{"sender":"human","text":"Hi"},{"sender":"assistant","text":"Hello"}]},{"conversation_id":"g1","title":"GPT chat","create_time":1700000000,"update_time":1700000100,"current_node":"n2","mapping":{"n1":{"message":{"author":{"role":"user"},"content":{"parts":["Q"]}}},"n2":{"parent":"n1","message":{"author":{"role":"assistant"},"content":{"parts":["A"]}}}}}]"#)
        let chats = try Readers.exportChats(file)
        XCTAssertEqual(chats.map { JS.string($0["id"]) }, ["c1", "g1"])
        XCTAssertEqual(try Readers.exportTranscript(file, "g1").turns.map(\.text), ["Q", "A"])
        XCTAssertThrowsError(try Readers.exportChats(dir.write("x.json", "{}"))) { XCTAssertTrue(($0 as? ConnectError)?.message.contains("is not a Claude or ChatGPT export") == true) }
    }

    func testFolderOverviewAndNotes() {
        let vault = TempDir()
        vault.mkdir(".obsidian")
        vault.write(".obsidian/daily-notes.json", #"{"folder":"/Daily/"}"#)
        for d in 1...6 { vault.write("Daily/2026-10-0\(d).md", "d") }
        vault.write("Projects/plan.md", "p")
        vault.write("Projects/paper.pdf", "%PDF")
        vault.write("top.md", "t")
        let o = Readers.folderOverview(vault.path, homeDir: "/nowhere")
        XCTAssertEqual(o["notes"]?.int, 8)
        XCTAssertEqual(o["pdfs"]?.int, 1)
        XCTAssertEqual(o["rootNotes"]?.int, 1)
        XCTAssertEqual(o["dailyFolder"]?.string, "Daily")
        XCTAssertEqual(o["folders"]?[0]?["name"]?.string, "Daily")
        XCTAssertEqual(o["folders"]?[0]?["dated"]?.double, 1)
        XCTAssertEqual(Readers.noteFiles(vault.path, exclude: ["Daily"]).count, 2)
        XCTAssertEqual(Readers.noteFiles(vault.path, include: ["Projects"]).count, 1)
    }

    func testPdfGuessAndTitles() {
        XCTAssertEqual(Readers.pdfGuess("2401.12345v2.pdf"), "paper")
        XCTAssertEqual(Readers.pdfGuess("Invoice 2024.pdf"), "personal")
        XCTAssertEqual(Readers.pdfGuess("smith2021_learning.pdf"), "paper")
        XCTAssertEqual(Readers.pdfGuess("Lecture 3 slides.pdf"), "book")
        XCTAssertEqual(Readers.pdfGuess("random.pdf"), "unclear")
        let dir = TempDir()
        let file = dir.write("t.pdf", "%PDF-1.4\n1 0 obj << /Title (Novice Help Seeking) >> endobj")
        XCTAssertEqual(Readers.pdfTitle(file), "Novice Help Seeking")
        XCTAssertEqual(Readers.sharedWords(Readers.wordsOf("debug novice programmers"), "debugging_tips.pdf"), 1)
        dir.write("papers/2401.12345.pdf", "%PDF")
        dir.write("papers/receipt.pdf", "%PDF")
        let f = Readers.pdfFolders([dir.url.appendingPathComponent("papers").path], homeDir: dir.path)
        XCTAssertEqual(f["pdfs"]?.int, 2)
        XCTAssertEqual(f["folders"]?[0]?["examples"]?.array?.count, 1) // the receipt is never offered
        XCTAssertEqual(Readers.pdfFiles(dir.path, kind: "paper").pdfs.count, 1)
    }

    func testBookmarksVaultsZotero() throws {
        let home = TempDir()
        home.write("Library/Application Support/Google/Chrome/Default/Bookmarks", #"{"roots":{"bookmark_bar":{"type":"folder","name":"Bar","children":[{"type":"folder","name":"Research","children":[{"type":"url","name":"arXiv","url":"https://arxiv.org"}]},{"type":"url","name":"js","url":"javascript:x"}]}}}"#)
        let profiles = Readers.browserProfiles(home.path)
        XCTAssertEqual(profiles.first?.browser, "Chrome")
        let marks = Readers.browserBookmarks(profiles[0].dir)
        XCTAssertEqual(marks.count, 1)
        XCTAssertEqual(marks[0]["folder"]?.string, "Bookmarks bar / Bar / Research") // the root folder keeps its own name, as in Electron
        let vault = home.mkdir("Vault")
        home.write("Library/Application Support/obsidian/obsidian.json", #"{"vaults":{"a":{"path":"\#(vault)","ts":1700000000000,"open":true},"b":{"path":"/missing"}}}"#)
        XCTAssertEqual(Readers.obsidianVaults(home.path).map(\.name), ["Vault"])
        let z = home.mkdir("zot")
        home.write("zot/items.json", #"[{"key":"K1","title":"Paper one","year":"2020","creators":[{"type":"author","last":"Ng"}],"collections":["C1"],"attachments":[{"contentType":"application/pdf","linkMode":"imported_file"}]},{"key":"K2","title":"Loose","collections":[]}]"#)
        home.write("zot/collections.json", #"[{"key":"C1","name":"Reading","path":"Reading"},{"key":"C2","name":"Sub","path":"Reading/Sub","parent":"C1"}]"#)
        let c = try Readers.zoteroCollections(z)
        XCTAssertEqual(c.items, 2); XCTAssertEqual(c.unfiled, 1)
        let items = try Readers.zoteroItems(z, collection: "C1")
        XCTAssertEqual(items.first?["authors"]?.string, "Ng")
        XCTAssertEqual(items.first?["attachment"]?.string, "pdf")
        XCTAssertEqual(Readers.authorsOf(["creators": [["type": "author", "last": "A"], ["type": "author", "last": "B"], ["type": "author", "last": "C"]]]), "A, B and C")
        XCTAssertEqual(Readers.linksIn(vault).count, 0)
    }

    func testScanDetectAndScanFor() async {
        let home = TempDir()
        home.mkdir(".claude/projects")
        home.mkdir("Documents/Zoom")
        let apps = home.mkdir("Applications")
        home.mkdir("Applications/Notion.app")
        let d = Scan.detect(homeDir: home.path, env: [:], signedIn: ["ChatGPT"], applications: [apps])
        XCTAssertEqual(d.apps["Claude Code"]?.found, true)
        XCTAssertEqual(d.apps["Zoom"]?.where, "~/Documents/Zoom")
        XCTAssertEqual(d.apps["ChatGPT"]?.where, "signed in to Engelbart")
        XCTAssertEqual(d.apps["Notion"]?.where, "on this Mac")
        XCTAssertEqual(d.apps["Apple Notes"]?.found, false)
        let found = await Scan.scanFor(["sources": ["notes": ["on": true, "apps": ["Obsidian", "Notion", "Apple Notes"]], "papers": ["on": true, "apps": ["Zotero"]]]], homeDir: home.path)
        XCTAssertEqual(found["notes"]?["Obsidian"]?["needs"]?.string, "folder")
        XCTAssertEqual(found["notes"]?["Notion"]?["reach"]?.string, "connector")
        XCTAssertEqual(found["notes"]?["Apple Notes"]?["needs"]?.string, "permission")
        XCTAssertEqual(found["papers"]?["Zotero"]?["needs"]?.string, "signin")
        home.mkdir("code/a/.git"); home.mkdir("code/b/c/.git")
        XCTAssertEqual(Scan.gitFolders(home.url.appendingPathComponent("code").path).count, 2)
    }

    func testDigestAndObsidianTree() {
        let home = TempDir()
        home.mkdir("proj/.git")
        home.write("proj/.git/HEAD", "ref")
        home.write("proj/README.md", "# My project\n")
        let repos = Digest.recentRepos(homeDir: home.path)
        XCTAssertEqual(repos.first?["readme"]?.string, "My project")
        let digest = Digest.projectDigest(homeDir: home.path, env: [:], existing: ["Old"])
        XCTAssertFalse(Digest.digestEmpty(digest))
        let vault = home.mkdir("Vault")
        home.write("Vault/Note 10.md", "x"); home.write("Vault/Note 2.md", "x"); home.mkdir("Vault/Folder"); home.write("Vault/.hidden.md", "x")
        home.write("Library/Application Support/obsidian/obsidian.json", #"{"vaults":{"a":{"path":"\#(vault)"}}}"#)
        let tree = ObsidianTree.tree(homeDir: home.path)
        XCTAssertEqual(tree["vaults"]?[0]?["tree"]?.array?.map { JS.string($0["name"]) }, ["Folder", "Note 2", "Note 10"])
    }
}
