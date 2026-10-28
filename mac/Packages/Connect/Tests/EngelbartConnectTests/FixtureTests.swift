import XCTest
import SQLite3
import Security
import EngelbartCore
@testable import EngelbartConnect

/// The readers on fixture files the shapes Electron's tests use: exports in a folder and a zip, PDF titles from XMP and
/// UTF-16 hex, Apple Notes' pictures and its script compiled, staged notes, a browser history database, the chat counts;
/// the fake browse and recall agents; the `--mcp import` stdio loop over pipes; the connectors' key in a keychain.
final class FixtureTests: XCTestCase {
    let export = #"[{"uuid":"c1","name":"Claude chat","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z","chat_messages":[{"sender":"human","text":"Hi"},{"sender":"assistant","text":"Hello"}]}]"#

    func run(_ tool: String, _ args: [String], cwd: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try p.run(); p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "\(tool) \(args)")
    }

    // connect.test.cjs "Claude and ChatGPT exports: conversations.json read from the file, a folder, or a zip".
    func testExportsFromFolderAndZip() throws {
        let dir = TempDir()
        dir.write("export/conversations.json", export)
        XCTAssertEqual(try Readers.exportChats(dir.url.appendingPathComponent("export").path).map { JS.string($0["id"]) }, ["c1"])
        // An export's zip holds conversations.json at its top (unzip -p <zip> conversations.json, as Electron reads it).
        try run("/usr/bin/zip", ["-q", "../export.zip", "conversations.json"], cwd: dir.url.appendingPathComponent("export").path)
        let zip = dir.url.appendingPathComponent("export.zip").path
        XCTAssertEqual(try Readers.exportChats(zip).map { JS.string($0["id"]) }, ["c1"])
        XCTAssertEqual(try Readers.exportTranscript(zip, "c1").turns.map(\.text), ["Hi", "Hello"])
        XCTAssertEqual(try Readers.exportCounts(zip)["total"]?.int, 1)
        XCTAssertThrowsError(try Readers.exportChats(dir.url.appendingPathComponent("missing").path)) { XCTAssertTrue(($0 as? ConnectError)?.message.hasPrefix("Nothing is at") == true, "\($0)") }
        dir.mkdir("empty")
        XCTAssertThrowsError(try Readers.exportChats(dir.url.appendingPathComponent("empty").path))
    }

    func testPdfTitlesXmpAndHex() {
        let dir = TempDir()
        let xmp = dir.write("scan.pdf", "%PDF-1.4\n<x:xmpmeta><dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Working Spheres in Information Work</rdf:li></rdf:Alt></dc:title></x:xmpmeta>")
        XCTAssertEqual(Readers.pdfTitle(xmp), "Working Spheres in Information Work")
        // "Hé" in UTF-16BE with its byte-order mark.
        let hex = dir.write("hex.pdf", "%PDF-1.4\n1 0 obj << /Title <FEFF004800E9006C006C006F> >> endobj")
        XCTAssertEqual(Readers.pdfTitle(hex), "Héllo")
        let escaped = dir.write("esc.pdf", "%PDF-1.4\n1 0 obj << /Title (A \\(draft\\) title) >> endobj")
        XCTAssertEqual(Readers.pdfTitle(escaped), "A (draft) title")
        XCTAssertEqual(Readers.pdfTitle(dir.write("none.pdf", "%PDF-1.4\n")), "")
        // pdfRoots: the folders that are there, those macOS keeps out left out.
        let home = TempDir()
        home.mkdir("Downloads"); home.mkdir("Research"); home.mkdir("Documents")
        let roots = Readers.pdfRoots(home.path, readable: { !$0.hasSuffix("/Documents") })
        XCTAssertTrue(roots.contains(home.url.appendingPathComponent("Downloads").path))
        XCTAssertTrue(roots.contains(home.url.appendingPathComponent("Research").path))
        XCTAssertFalse(roots.contains(home.url.appendingPathComponent("Documents").path))
    }

    func testAppleNotesReadWritesPicturesAndTheScriptCompiles() async throws {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        let calls = Box<[[String]]>([])
        let notes = AppleNotes(run: { args in
            calls.set(calls.get() + [args])
            let ids = (try? JSONValue.parse(Data(args[5].utf8)))?["ids"]?.array?.compactMap(\.string) ?? []
            let rows: [JSONValue] = ids.map { id in id.hasSuffix("bad") ? ["id": .string(id), "error": "locked"] : ["id": .string(id), "name": "Trip", "folder": "Notes", "modified": "2026-10-01T00:00:00Z", "body": .string("<div>Plan</div><img src=\"data:image/png;base64,\(png)\">")] }
            return (JSONValue.array(rows).text(), "", nil)
        })
        let dir = TempDir()
        let pictures = dir.url.appendingPathComponent("pics").path
        let ids = (0..<30).map { "x-coredata://A/ICNote/p\($0)" } + ["x-coredata://A/ICNote/bad", "not-an-id"]
        let read = try await notes.read(ids, pictureDir: pictures)
        XCTAssertEqual(read.count, 31, "the malformed id never asked for")
        XCTAssertEqual(calls.get().count, 2, "batches of 25")
        XCTAssertEqual(calls.get()[0][4], "read")
        XCTAssertEqual(read.last?.error, "locked")
        let first = read[0]
        XCTAssertEqual(first.name, "Trip")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: pictures)) ?? []
        XCTAssertEqual(files.count, 30, "one picture per note")
        XCTAssertTrue(files.allSatisfy { JS.test($0, "^[0-9a-f]{10}-1\\.png$") }, "\(files.prefix(3))")
        XCTAssertTrue(first.markdown.contains("Plan"))
        XCTAssertTrue(first.markdown.contains(pictures), first.markdown)
        let mode = (try? FileManager.default.attributesOfItem(atPath: pictures + "/" + files[0]))?[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        // The script itself compiles as JavaScript for Automation (running it needs Notes and the person's consent).
        let script = dir.write("notes.js", Texts.appleNotesScript)
        try run("/usr/bin/osacompile", ["-l", "JavaScript", "-o", dir.url.appendingPathComponent("notes.scpt").path, script], cwd: dir.path)
        let off = AppleNotes(run: nil, isMac: false)
        let p = await off.permission()
        XCTAssertEqual(p.error, "Apple Notes is only on a Mac")
    }

    func testNotesIndexPicturesAndStaging() async throws {
        let vault = TempDir()
        vault.write("attachments/Pic.PNG", "x"); vault.write("deep/a/b/other.png", "y"); vault.write(".hidden/secret.png", "z"); vault.write("Notes/n.md", "t")
        let index = Notes.Index()
        XCTAssertEqual(index.find(root: vault.path, name: "pic.png"), vault.url.appendingPathComponent("attachments/Pic.PNG").path, "by name, case aside")
        XCTAssertNil(index.find(root: vault.path, name: "secret.png"), "dot folders skipped")
        let note = vault.url.appendingPathComponent("Notes/n.md").path
        XCTAssertEqual(Notes.findPicture("../attachments/Pic.PNG", sourcePath: note, root: vault.path), vault.url.appendingPathComponent("attachments/Pic.PNG").path)
        XCTAssertEqual(Notes.findPicture("other.png|300", sourcePath: note, root: vault.path, index: index), vault.url.appendingPathComponent("deep/a/b/other.png").path)
        XCTAssertNil(Notes.findPicture("https://x.org/a.png", root: vault.path, index: index))
        XCTAssertEqual(Notes.findPicture("attachments/Pic%2EPNG", root: vault.path), vault.url.appendingPathComponent("attachments/Pic.PNG").path)
        // Staged notes (sessions from before 2026-10-08): kept, counted, flushed into the project oldest first.
        let session = TempDir()
        try Notes.stageNote(session.url, title: "First", body: "one ![p](tok1)", images: [.init(token: "tok1", file: vault.url.appendingPathComponent("attachments/Pic.PNG").path, alt: "p")])
        try? await Task.sleep(nanoseconds: 5_000_000)
        try Notes.stageNote(session.url, title: "Second", body: "two")
        XCTAssertEqual(Notes.stagedCount(session.url), 2)
        let store = FakeStore(root: session.path)
        let written = try await Notes.flushStaged(session.url, projectId: "p1", projects: store)
        XCTAssertEqual(written.map(\.name), ["First", "Second"])
        XCTAssertTrue(store.notes[0].text.hasPrefix("one ![p](img:"), "the picture saved into the project: \(store.notes[0].text)")
        XCTAssertEqual(Notes.stagedCount(session.url), 0)
    }

    func testBrowserHistoryFromACopyOfItsDatabase() throws {
        let home = TempDir()
        let dir = home.mkdir("Library/Application Support/Google/Chrome/Default")
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(dir + "/History", &db), SQLITE_OK)
        let now = Readers.chromeTime(Time.ms())
        let old = Readers.chromeTime(Time.ms() - 200 * 86_400_000)
        let sql = """
        CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
        INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES
        ('https://www.arxiv.org/abs/1', 'Paper 1', 5, \(Int64(now)), 0), ('https://arxiv.org/abs/2', 'Paper 2', 3, \(Int64(now)), 0),
        ('https://mail.google.com/mail/u/0', 'Inbox', 50, \(Int64(now)), 0), ('https://old.example/x', 'Old', 9, \(Int64(old)), 0),
        ('https://hidden.example/', 'Hidden', 9, \(Int64(now)), 1), ('chrome://settings', 'Settings', 9, \(Int64(now)), 0);
        """
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)
        let sites = try Readers.browserHistory(dir, days: 90, exclude: ["google.com"])
        XCTAssertEqual(sites.map { JS.string($0["host"]) }, ["arxiv.org"], "\(sites)")
        XCTAssertEqual(sites.first?["pages"]?.int, 2)
        XCTAssertEqual(sites.first?["visits"]?.int, 8)
        let pages = try Readers.browserHistory(dir, days: 90, by: "page")
        XCTAssertEqual(pages.map { JS.string($0["title"]) }, ["Inbox", "Paper 1", "Paper 2"])
        XCTAssertThrowsError(try Readers.browserHistory(home.path)) { XCTAssertEqual(($0 as? ConnectError)?.message, "This browser profile has no history") }
        XCTAssertEqual(Readers.profileOf(home.path, browser: "chrome")?.profile, "Default")
    }

    func testChatCountsGlanceAndCache() {
        let home = TempDir()
        let file = home.write(".claude/projects/-w-app/s1.jsonl", #"{"type":"user","cwd":"/w/app","entrypoint":"cli","message":{"role":"user","content":"Fix it"}}"# + "\n")
        try? FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -100 * 86_400)], ofItemAtPath: file)
        home.write(".claude/projects/-w-app/s2.jsonl", #"{"type":"user","cwd":"/w/app","entrypoint":"cli","message":{"role":"user","content":"Another"}}"# + "\n")
        let counts = Readers.localChatCounts("Claude Code", homeDir: home.path, env: [:], days: 7)
        XCTAssertEqual(counts["total"]?.int, 2); XCTAssertEqual(counts["last30Days"]?.int, 1); XCTAssertEqual(counts["last180Days"]?.int, 2); XCTAssertEqual(counts["inPeriod"]?.int, 1)
        let glance = Scan.chatsAtAGlance("Claude Code", homeDir: home.path, env: [:], days: nil)
        XCTAssertEqual(glance["typedByYou"]?.int, 2)
        XCTAssertEqual(glance["folders"]?[0]?.string, "/w/app (2)")
        XCTAssertEqual(Scan.chatsAtAGlance("Cursor", homeDir: home.path, env: [:], days: nil)["error"]?.string?.isEmpty, false)
        // The scanner's 60 s cache: a new session is not seen until the cache is dropped.
        Readers.keepLocalChats(true)
        defer { Readers.keepLocalChats(false) }
        XCTAssertEqual(Readers.localChats("Claude Code", homeDir: home.path, env: [:]).count, 2)
        home.write(".claude/projects/-w-app/s3.jsonl", #"{"type":"user","cwd":"/w/app","entrypoint":"cli","message":{"role":"user","content":"Third"}}"# + "\n")
        XCTAssertEqual(Readers.localChats("Claude Code", homeDir: home.path, env: [:]).count, 2, "cached")
        Readers.keepLocalChats(false)
        XCTAssertEqual(Readers.localChats("Claude Code", homeDir: home.path, env: [:]).count, 3)
    }

    // fake.cjs: the browse and recall agents call the job's tools for real.
    func testFakeBrowseAndRecall() async throws {
        let calls = Box<[(String, JSONValue)]>([])
        var commands: [String] = []
        let meta = { (kind: String, apps: [String]) in AgentMeta(kind: kind, callTool: { name, args in calls.set(calls.get() + [(name, args)]); return name == "needs_you" ? ["status": "skipped"] : ["added": true] },
                                                                  info: ["job": ["apps": .array(apps.map { .string($0) })], "browserName": "Brave"]) }
        let fake = FakeAgents(delayMs: 0, env: ["ENGELBART_CONNECT_FAKE_NEEDS": "Notion"])
        let out = try await fake.turn(AgentTurnInput(choice: ConnectModels.choice("anthropic", models: nil), kind: "browse", system: "", message: "", onUpdate: { if let c = $0.command { commands.append(c) } }, meta: meta("browse", ["Google Docs", "Notion"])))
        XCTAssertEqual(out.text, "Brought in 1 pages from Brave.")
        XCTAssertEqual(calls.get().map(\.0), ["add_note", "needs_you"])
        XCTAssertEqual(calls.get()[0].1["source"]?.string, "fake-browser:Google Docs")
        XCTAssertEqual(commands, ["fake browser agent in Brave"])
        calls.set([])
        let recall = try await fake.turn(AgentTurnInput(choice: ConnectModels.choice("anthropic", models: nil), kind: "recall", system: "", message: "", meta: meta("recall", ["ChatGPT"])))
        XCTAssertEqual(recall.text, "Saved ChatGPT's answer.")
        XCTAssertEqual(calls.get().first?.0, "save_memory")
        XCTAssertTrue(JS.string(calls.get().first?.1["text"]).hasPrefix("# Research profile"))
    }

    // import-mcp.cjs: `--mcp import <connection file>` over stdio, relayed to the session's tool bridge.
    func testImportMCPStdioLoop() async throws {
        let bridge = try await ToolBridge.open({ name, args in
            if name == "browser_screenshot" { return MCPContent([["type": "image", "data": "AAAA", "mimeType": "image/jpeg"]]) }
            return ["called": .string(name), "args": args] as JSONValue
        })
        defer { bridge.close() }
        let dir = TempDir()
        let file = dir.write("conn.json", JSONValue.object(["url": .string(bridge.connection.url), "token": .string(bridge.connection.token), "kind": "survey", "tools": ["list_chats", "needs_you"]]).text())
        XCTAssertEqual(ImportMCP.definitions(connectionFile: file).compactMap { $0["name"]?.string }, ["list_chats", "needs_you"])
        XCTAssertEqual(ImportMCP.definitions(connectionFile: "/missing").count, Tools.definitions.count)
        let input = Pipe(), output = Pipe()
        let finished = Box<Int32?>(nil)
        Thread.detachNewThread { finished.set(ImportMCP.run(arguments: [file], input: input.fileHandleForReading, output: output.fileHandleForWriting)) }
        let lines = [#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
                     #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                     #"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
                     #"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_chats","arguments":{"app":"Codex"}}}"#,
                     #"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}"#]
        input.fileHandleForWriting.write(Data((lines.joined(separator: "\n") + "\n").utf8))
        var replies: [Int: JSONValue] = [:]
        var buffer = Data()
        let end = Date().addingTimeInterval(15)
        while replies.count < 4 && Date() < end {
            let chunk = output.fileHandleForReading.availableData
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                if let v = try? JSONValue.parse(Data(buffer[buffer.startIndex..<nl])), let id = v["id"]?.int { replies[id] = v }
                buffer.removeSubrange(buffer.startIndex...nl)
            }
        }
        XCTAssertEqual(replies[1]?["result"]?["serverInfo"]?["name"]?.string, "engelbart")
        XCTAssertEqual(replies[2]?["result"]?["tools"]?.array?.count, 2)
        let text = JS.string(replies[3]?["result"]?["content"]?[0]?["text"])
        XCTAssertEqual(try? JSONValue.parse(Data(text.utf8))["called"]?.string, "list_chats")
        XCTAssertEqual(replies[4]?["result"]?["content"]?[0]?["type"]?.string, "image")
        try input.fileHandleForWriting.close()
        let closed = await eventually(5) { finished.get() != nil }
        XCTAssertTrue(closed); XCTAssertEqual(finished.get(), 0, "served until stdin closed")
        // A connection file that is not Engelbart's loopback bridge: refused to start.
        let bad = dir.write("bad.json", #"{"url":"http://example.com/tools","token":"x"}"#)
        XCTAssertEqual(ImportMCP.run(arguments: [bad], input: FileHandle.nullDevice, output: FileHandle.nullDevice), 1)
    }

    // connectors.cjs sealed by the system keychain: a temporary keychain made for the test.
    func testKeychainCryptSealsTokens() throws {
        let dir = TempDir()
        let path = dir.url.appendingPathComponent("t.keychain").path
        var keychain: SecKeychain?
        let password = "x"
        XCTAssertEqual(SecKeychainCreate(path, UInt32(password.utf8.count), password, false, nil, &keychain), errSecSuccess)
        defer { if let keychain { SecKeychainDelete(keychain) } }
        let crypt = KeychainCrypt(service: "Engelbart connectors test", account: "key", keychain: keychain)
        XCTAssertTrue(crypt.available())
        let sealed = try crypt.encrypt(#"{"tokens":{"access_token":"secret"}}"#)
        XCTAssertFalse(sealed.contains("secret"))
        XCTAssertEqual(try crypt.decrypt(sealed), #"{"tokens":{"access_token":"secret"}}"#)
        let again = KeychainCrypt(service: "Engelbart connectors test", account: "key", keychain: keychain)
        XCTAssertEqual(try again.decrypt(sealed), #"{"tokens":{"access_token":"secret"}}"#, "the same key, read back from the keychain")
        XCTAssertThrowsError(try again.decrypt("bm90IHNlYWxlZA=="))
        // Connectors over it: the file never holds a token in the clear.
        let file = dir.url.appendingPathComponent("connectors.json")
        let c = Connectors(file: { file }, crypt: crypt, openExternal: { _ in })
        c.save("Granola", ["tokens": ["access_token": "tok-123"], "obtainedAt": .number(Time.ms())])
        XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("tok-123"))
        XCTAssertTrue(try c.status("Granola").connected)
        // No keychain at all: tokens kept for the run only.
        let plain = Connectors(file: { file }, crypt: PlainCrypt(available: false), openExternal: { _ in })
        plain.save("Notion", ["tokens": ["access_token": "n"], "obtainedAt": .number(Time.ms())])
        XCTAssertTrue(try plain.status("Notion").connected)
        XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("Notion"))
    }
}
