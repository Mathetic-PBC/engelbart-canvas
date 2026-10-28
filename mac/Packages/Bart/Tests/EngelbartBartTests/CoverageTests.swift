import XCTest
import EngelbartCore
import EngelbartDoc
@testable import EngelbartBart

// The rest of the context layer, Chat's citations in a run, the sweep's pdf paths and clock, the IPC handlers and the
// page picture.

final class CoverageTests: XCTestCase {
    func hl(_ id: String, _ text: String, _ extra: String = "") -> String { #"{"id":"\#(id)","rects":[{"x":0}],"y":0.2,"text":"\#(text)"\#(extra.isEmpty ? "" : "," + extra)}"# }

    func testContextDocumentsStageAndGrants() async throws {
        let base = tempDir("ctx").path
        try FileManager.default.createDirectory(atPath: base + "/papers/sub", withIntermediateDirectories: true)
        let rows = [LibraryRow(id: "r1", name: "Front", type: "pdf", path: base + "/papers/front.pdf"),
                    LibraryRow(id: "r2", name: "Mentioned", type: "pdf", path: base + "/papers/sub/m.pdf"),
                    LibraryRow(id: "r3", name: "Pic", type: "image", path: base + "/pics/p.png")]
        let store = TestStore(document: "@chat q\nbart~> k1", rows: rows)
        store.ink["r1"] = j(#"{"2":[\#(hl("a", "in front", #""note":"mine""#))]}"#)
        store.ink["r2"] = j(#"{"5":[\#(hl("b", "mentioned passage"))]}"#)
        store.workspaceMentions = ["r2"]
        try await store.libraryDb.setText("r1", text: "front text", modified: 99)
        let c = try await Context.build(store: store, projectId: "p1", ref: .workspace("w1"), workspaceId: "w1", askId: "k1", stage: StageInput(kind: "pdf", rowId: "r1", page: 2))
        XCTAssertTrue(c.now.hasPrefix("<stage paper=\"Front\" path=\"\(base)/papers/front.pdf\" page=\"2\" annotations=\"\(store.dataRoot)/annotations/r1.json\">\n<highlight page=\"2\">\n<quote>\nin front\n</quote>\n<note>\nmine\n</note>\n</highlight>\n</stage>"), c.now)
        XCTAssertTrue(c.now.contains("<highlights from=\"mentioned\">\n<paper name=\"Mentioned\""))
        XCTAssertFalse(c.contextJson.contains("\"Pic\""), "no pictures in Context.json")
        XCTAssertTrue(c.contextJson.contains("\"text\": \"\(store.dataRoot)/assets/text/r1-99.txt\""))
        XCTAssertTrue(c.contextJson.contains("\"mentioned\": true"))
        XCTAssertEqual(c.dirs, [store.dataRoot, base + "/papers"], "a folder inside another granted one is not granted again; a gone folder never")
        // Brainstorm: this workspace's library alone.
        let b = try await Context.build(store: store, projectId: "p1", ref: .workspace("w1"), workspaceId: "w1", askId: "k1", agent: "brainstorm")
        XCTAssertEqual(b.now, ""); XCTAssertTrue(b.contextJson.contains("\"Front\""))
    }

    func testContextNoteProjectPageAndBox() async throws {
        let store = TestStore(document: "@chat q\nbart~> k1")
        store.bodies["note"] = ("My note", "the note\n@chat q\nbart~> k1", [])
        let n = try await Context.build(store: store, projectId: "p1", ref: DocRef(kind: "note", id: "n9"), workspaceId: "w1", askId: "k1")
        XCTAssertTrue(n.documents.contains("<note name=\"My note\">\nthe note\n@chat q\n\(Context.here)\n</note>"))
        XCTAssertTrue(n.head.contains("asked from: the note \"My note\", opened from the workspace \"W\""))
        try "Project-wide instructions.".write(toFile: store.project.dir + "/.project.md", atomically: true, encoding: .utf8)
        store.bodies["project"] = ("Proj", "Project-wide instructions.", [])
        let p = try await Context.build(store: store, projectId: "p1", ref: DocRef(kind: "project"), workspaceId: "w1", askId: "k1")
        XCTAssertTrue(p.documents.contains("<project_page name=\"Proj\">"))
        XCTAssertFalse(p.head.contains("<project_page"), "the page asked from is not repeated in the head")
        let w = try await Context.build(store: store, projectId: "p1", ref: .workspace("w1"), workspaceId: "w1", askId: "k1")
        XCTAssertTrue(w.head.contains("<project_page name=\"Proj\" note=\"The project page: what the person wants every agent in this project to know.\">\nProject-wide instructions.\n</project_page>"))
        // A box on a web page, read from the page's ink by its id.
        store.webMarks["b1"] = j(#"{"id":"b1","box":{"x":1},"crop":"crops/b1.png","text":"under the box","note":"its note"}"#)
        let box = try await Context.build(store: store, projectId: "p1", ref: DocRef(kind: "mark", id: "b1", url: "https://x.org/a", source: "web"), workspaceId: "w1", askId: "k1",
                                          highlight: HighlightInput(quote: "ignored", note: "", paper: "A page"))
        XCTAssertTrue(box.documents.contains("<highlight source=\"web\" title=\"A page\" address=\"https://x.org/a\">\n<box crop=\"\(store.dataRoot)/annotations/crops/b1.png\">\n<text>\nunder the box\n</text>\n</box>\n<note>\nits note\n</note>\n</highlight>"), box.documents)
        XCTAssertTrue(box.head.contains("asked from: a box on the web page \"A page\""))
    }

    func testChatCitationsInARun() async throws {
        let dir = tempDir("cited").path
        let note = dir + "/note.md"
        try "We chose three retries for the loop.".write(toFile: note, atomically: true, encoding: .utf8)
        let row = LibraryRow(id: "n1", name: "Note", type: "md", tags: ["note"], path: note, created: Time.iso(Date()))
        let store = TestStore(document: "@chat cite it\nbart~> c1", rows: [row])
        let log = RunLog()
        let out = try await fakeBart(runLog: log).ask(store: store, projectId: "p1", AskRequest(askId: "c1", ref: .workspace("w1"), workspaceId: "w1", text: "cite it")) { _ in }
        let body = out.lines.joined(separator: "\n")
        XCTAssertEqual(body.components(separatedBy: "[You · ").count, 2, body)
        XCTAssertTrue(body.contains("And something else."), "the dropped citation's sentence stays")
        XCTAssertEqual(log.get("c1")?["citations"]?["dropped"]?.array?.first?["reason"], "not-found")
        // A whole source is kept only once it was read in the run (the real runner's events).
        let reading = StubRunner { _, _ in ([
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Read","input":{"file_path":"\#(note)"}}]}}"#,
            #"{"type":"result","subtype":"success","is_error":false,"result":"See [Note](\#(note)#cite=source)."}"#], nil) }
        let silent = StubRunner { _, _ in ([#"{"type":"result","subtype":"success","is_error":false,"result":"See [Note](\#(note)#cite=source)."}"#], nil) }
        for (runner, kept) in [(reading, true), (silent, false)] {
            let root = tempDir("citedrun").path
            var c = Bart.Config(readModels: { DEFAULTS }, environment: ["SHELL": "/bin/zsh"], runDirectory: root, codexHome: root + "/a", brainstormCodexHome: root + "/b",
                                discoverCodexHome: root + "/d", createCodexHome: root + "/c", routerCodexHome: root + "/r", makingCodexHome: root + "/m")
            c.runner = runner
            let answer = try await Bart(c).ask(store: store, projectId: "p1", AskRequest(askId: "c2", ref: .workspace("w1"), workspaceId: "w1", text: "what?")) { _ in }
            XCTAssertEqual(answer.lines[0].contains("](\(note)#cite=source)"), kept, answer.lines[0])
        }
    }

    func testSweepPdfsAndClock() async throws {
        let dir = tempDir("sweep").path
        let withAbstract = dir + "/a.pdf", without = dir + "/b.pdf"
        makePdf(withAbstract, pages: [[("Title", 16), ("Abstract", 12), ("We measure tutors.", 10), ("1 Introduction", 12)]])
        makePdf(without, pages: [Array(repeating: ("A line of body text that goes on for a while here.", CGFloat(9)), count: 40)])
        let old = Date(timeIntervalSinceNow: -3600)
        for f in [withAbstract, without] { try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: f) }
        let store = TestStore(document: "x")
        let db = store.libraryDb as! MemoryDB
        db.rows = [LibraryRow(id: "a", name: "A", type: "pdf", path: withAbstract, projectId: "p1"), LibraryRow(id: "b", name: "B", type: "pdf", path: without, projectId: "p1")]
        final class Calls: @unchecked Sendable { var names: [String] = []; var fail = false; let lock = NSLock() }
        let calls = Calls()
        let summarize: Summarize = { name, text, _, _, _ in
            calls.lock.withLock { calls.names.append(name) }
            if calls.lock.withLock({ calls.fail }) { throw SummaryError("failed", "nope") }
            return SummaryResult(summary: "S of \(name) \(text.jsLength)", meta: ["costUsd": 0.5])
        }
        final class Clock: @unchecked Sendable { var ms = Time.ms() }
        let clock = Clock()
        let sweeper = Sweeper(getStore: { store }, summarize: summarize, now: { clock.ms })
        _ = await sweeper.sweep()
        let a = try await db.get("a")!, b = try await db.get("b")!
        XCTAssertEqual(a.summary, "We measure tutors.", "the abstract is the summary, no model")
        XCTAssertTrue(b.summary?.hasPrefix("S of B ") == true)
        XCTAssertEqual(calls.names, ["B"])
        let stamps = try await db.textStamps()
        XCTAssertEqual(stamps["a"], (old.timeIntervalSince1970 * 1000).rounded(.down) == stamps["a"] ? stamps["a"] : stamps["a"])
        XCTAssertNotNil(stamps["a"]); XCTAssertNotNil(stamps["b"])
        XCTAssertEqual(sweeper.status()?["spentUsdThisRun"], 0.5)
        // A failure waits five minutes before the next try.
        let note = dir + "/n.md"
        try String(repeating: "word ", count: 300).write(toFile: note, atomically: true, encoding: .utf8)
        db.rows.append(LibraryRow(id: "n", name: "N", type: "md", tags: ["note"], path: note, charCount: 1500, lastEdited: Time.iso(old), projectId: "p1"))
        calls.fail = true
        _ = await sweeper.sweep()
        XCTAssertEqual(calls.names.last, "N")
        let before = calls.names.count
        let pending = await sweeper.sweep()
        XCTAssertEqual(calls.names.count, before, "not before its retry time")
        XCTAssertEqual(pending?["pending"], ["N"])
        clock.ms += 6 * 60_000
        calls.fail = false
        _ = await sweeper.sweep()
        XCTAssertEqual(calls.names.count, before + 1)
        // The clock of beats: soon after start, then every interval; stop ends it.
        final class Count: @unchecked Sendable { var n = 0; let lock = NSLock() }
        let count = Count()
        var o = Sweeper.Options(); o.firstDelayMs = 10; o.intervalMs = 100; o.summaries = false
        let ticking = Sweeper(getStore: { count.lock.withLock { count.n += 1 }; return store }, summarize: summarize, options: o)
        ticking.start()
        try await Task.sleep(nanoseconds: 450_000_000)
        await ticking.stop()
        try await Task.sleep(nanoseconds: 80_000_000) // a beat already begun reaches its store first
        let seen = count.lock.withLock { count.n }
        XCTAssertGreaterThanOrEqual(seen, 3)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(count.lock.withLock { count.n }, seen, "no beat after stop")
        XCTAssertEqual(Sweeper.Options.from(environment: ["ENGELBART_SUMMARIES": "off", "ENGELBART_SUMMARY_QUIET_MS": "5"]).quietMs, 5)
    }

    func testIPCHandlers() async throws {
        let store = TestStore(document: "@chat q\nbart~> r1")
        let home = tempDir("ipchome")
        let hub = EventHub()
        final class Box: @unchecked Sendable { var changed = 0 }
        let box = Box()
        hub.on(BartEvents.modelsChanged) { _ in box.changed += 1 }
        let bart = fakeBart(delay: 3000)
        let ipc = BartIPC(bart: bart, store: store, readModels: { ModelSettings.modelsInForce(home: home) }, home: { home }, hub: hub)
        let routed = try await ipc.routeLine(pid: "p1", input: j(#"{"text":"find papers on tutors","threads":[{"agent":"chat","question":"q","up":3}],"section":"x"}"#))
        XCTAssertEqual(routed["agent"], "discover")
        XCTAssertTrue(try ipc.routeHanded("route-1", "build:abc"))
        XCTAssertFalse(try ipc.stopBart("none"))
        XCTAssertEqual(try ipc.rememberModelChoice("build", j(#"{"provider":"openai","model":"sol","effort":"high"}"#))["model"], "sol")
        XCTAssertEqual(try ipc.rememberModelChoice("quick", j(#"{"provider":"openai","model":"rm -rf","effort":"high"}"#)), .null)
        XCTAssertEqual(ipc.settingsModels()["choices"]?["build"]?["effort"], "high")
        _ = try ipc.saveSettingsModels(j(#"{"buildProvider":"openai"}"#))
        _ = try ipc.clearModelChoice("bart")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(box.changed, 2)
        XCTAssertThrowsError(try ipc.saveSettingsModels(j(#"{"nope":1}"#)))
        // created-file / created-save
        let draft = tempDir("ipcdraft").path
        try "a,b\n1,2\n".write(toFile: draft + "/t.csv", atomically: true, encoding: .utf8)
        _ = try Create.keepCreated(projectDir: store.project.dir, askId: "k5", draft: draft)
        let lib = MoreTests.Lib(store.project.dir)
        let file = try await ipc.createdFile(pid: "p1", askId: "k5", rel: "t.csv", library: lib)
        XCTAssertEqual(file["text"], "a,b\n1,2\n"); XCTAssertEqual(file["type"], "csv")
        let saved = try await ipc.createdSave(pid: "p1", askId: "k5", rel: "t.csv", workspaceId: "w1", library: lib)
        XCTAssertEqual(saved.name, "t")
        do { _ = try await ipc.createdFile(pid: "p1", askId: "k 5", rel: "t.csv", library: lib); XCTFail() } catch { XCTAssertEqual((error as? IPCError)?.message, "ask id is invalid") }
        // A highlight's question shows again in a reloaded window while it runs; Stop answers { stopped: true }.
        let running = Task { try await ipc.askBart(window: "w", pid: "p1", input: j(#"{"askId":"h9","ref":{"kind":"mark","id":"m1","rowId":"r","page":4},"workspaceId":"w1","text":" what? ","highlight":{"quote":"q"}}"#)) }
        var asks: [OJ] = []
        for _ in 0..<100 { asks = try ipc.runningPaperAsks(window: "w", pid: "p1"); if asks.first?["step"] != nil { break }; try await Task.sleep(nanoseconds: 30_000_000) }
        XCTAssertEqual(asks.first?["question"], "what?"); XCTAssertEqual(asks.first?["page"], 4); XCTAssertEqual(asks.first?["agent"], "bart")
        XCTAssertTrue(try ipc.stopBart("h9"))
        let out = try await running.value
        XCTAssertEqual(out, ["stopped": true])
        XCTAssertEqual(store.stopped, ["h9"])
        XCTAssertEqual(try ipc.runningPaperAsks(window: "w", pid: "p1").count, 0)
    }

    @MainActor
    func testCreatedPreviewPicture() async throws {
        let dir = tempDir("preview").path
        let page = dir + "/chart.html", out = dir + "/.engelbart-previews/chart.html.png"
        try "<!doctype html><html><body style=\"margin:0\"><div style=\"height:1200px;background:#4a6fa5\">x</div><script>location.href='https://example.org'</script></body></html>".write(toFile: page, atomically: true, encoding: .utf8)
        let png = try await CreatedPreview.snapshot(page, out)
        XCTAssertEqual(CreatedPreview.pngWidth(png), CreatedPreview.width)
        XCTAssertTrue(FileManager.default.fileExists(atPath: out))
        let mtime = try FileManager.default.attributesOfItem(atPath: out)[.modificationDate] as! Date
        let again = try await CreatedPreview.snapshot(page, out)
        XCTAssertEqual(again, png, "reused while the page is not newer")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: out)[.modificationDate] as! Date, mtime)
    }
}
