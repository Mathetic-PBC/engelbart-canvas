import EngelbartDoc
import XCTest
import EngelbartCore
@testable import EngelbartBart

final class FakeTools: BartTools, @unchecked Sendable {
    var used: [String] = [], ensured: [String] = []
    let lock = NSLock()
    func binaryFor(_ name: String) -> String? { name == "codex" ? "/opt/codex/bin/codex" : nil }
    func environment() -> [String: String] { ["ENGELBART_GIT_BIN": "/g"] }
    func use<T: Sendable>(_ name: String, _ body: @Sendable () async throws -> T) async throws -> T { lock.withLock { used.append(name) }; return try await body() }
    func ensure(_ name: String) async throws { lock.withLock { ensured.append(name) } }
    func check(_ names: [String]) async {}
    func usableAgents() -> [String]? { ["codex", "claude"] }
}

final class MoreTests: XCTestCase {
    func testToolLockAndBinary() async throws {
        let store = TestStore(document: "@chat why?\nbart~> t1")
        let root = tempDir("tools").path
        let auth = root + "/auth.json"
        try #"{"auth_mode":"chatgpt","tokens":{"a":1}}"#.write(toFile: auth, atomically: true, encoding: .utf8)
        let runner = StubRunner { _, _ in (["{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}"], "ok") }
        let tools = FakeTools()
        var c = Bart.Config(readModels: { MODELS }, environment: ["SHELL": "/bin/zsh"], runDirectory: root + "/runs", codexHome: root + "/ch", brainstormCodexHome: root + "/b",
                            discoverCodexHome: root + "/d", createCodexHome: root + "/c", routerCodexHome: root + "/r", makingCodexHome: root + "/m")
        c.runner = runner; c.codexAuthFile = auth; c.tools = tools
        _ = try await Bart(c).ask(store: store, projectId: "p1", AskRequest(askId: "t1", ref: .workspace("w1"), workspaceId: "w1", text: "why?")) { _ in }
        XCTAssertEqual(tools.ensured, ["codex"]); XCTAssertEqual(tools.used, ["codex"])
        let call = runner.calls[0]
        XCTAssertTrue(call.args[1].hasPrefix("PATH=\"$ENGELBART_GIT_BIN:$PATH\"; exec \"$ENGELBART_CODEX_BIN\" exec "), call.args[1])
        XCTAssertEqual(call.env["ENGELBART_CODEX_BIN"], "/opt/codex/bin/codex")
    }

    func testPerAgentClaudeFlags() async throws {
        let store = TestStore(document: "@discover x\nbart~> a1")
        let root = tempDir("agents").path
        final class Seen: @unchecked Sendable { var mcp: String?; var rules: String? }
        let seen = Seen()
        let runner = StubRunner { _, env in
            if let f = env["ENGELBART_BART_MCP"] { seen.mcp = try? String(contentsOfFile: f, encoding: .utf8) }
            if let r = env["ENGELBART_BART_RULES"] { seen.rules = r }
            return (["{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"## Start here\\nx\"}"], nil)
        }
        var c = Bart.Config(readModels: { DEFAULTS }, environment: ["SHELL": "/bin/zsh", "OPENALEX_API_KEY": "ok"], runDirectory: root + "/runs", codexHome: root + "/ch",
                            brainstormCodexHome: root + "/b", discoverCodexHome: root + "/d", createCodexHome: root + "/c", routerCodexHome: root + "/r", makingCodexHome: root + "/m")
        c.runner = runner; c.papersCommand = "/App/Engelbart"
        let bart = Bart(c)
        _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "a1", ref: .workspace("w1"), workspaceId: "w1", text: "--research tutors", agent: "discover")) { _ in }
        let search = runner.calls[0].args[1]
        XCTAssertTrue(search.contains("--strict-mcp-config --mcp-config \"$ENGELBART_BART_MCP\" --tools \"Read,Grep,Glob,WebSearch,WebFetch\" --allowedTools \"Read,Grep,Glob,WebSearch,WebFetch,mcp__papers__*\""), search)
        XCTAssertEqual(seen.mcp, #"{"mcpServers":{"papers":{"command":"/App/Engelbart","args":["--mcp","papers"],"env":{"OPENALEX_API_KEY":"ok"}}}}"#)
        _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "a2", ref: .workspace("w1"), workspaceId: "w1", text: "tutors", agent: "discover")) { _ in }
        XCTAssertTrue(runner.calls[1].args[1].contains("--strict-mcp-config --tools \"Read,Grep,Glob\" --allowedTools \"Read,Grep,Glob\""), "talking, no paper tools or web")
        _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "a3", ref: .workspace("w1"), workspaceId: "w1", text: "", agent: "brainstorm")) { _ in }
        XCTAssertTrue(runner.calls[2].args[1].contains("--tools \"Read,Grep,Glob\" --allowedTools \"Read,Grep,Glob\""))
        XCTAssertTrue(runner.calls[2].args[1].contains("--model \"$ENGELBART_BART_MODEL\" --effort high"))
        _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "a4", ref: .workspace("w1"), workspaceId: "w1", text: "a chart", agent: "create")) { _ in }
        let create = runner.calls.last { $0.args[1].contains("--permission-mode dontAsk") }
        XCTAssertNotNil(create)
        XCTAssertTrue(create!.args[1].contains("--tools \"Read,Grep,Glob,WebSearch,WebFetch,Write,Edit\" --allowedTools \"$ENGELBART_BART_RULES\" --permission-mode dontAsk"))
        XCTAssertEqual(seen.rules, AskPlan.createRules(create!.cwd))
        XCTAssertTrue(create!.cwd.hasSuffix("/.create/a4"))
    }

    /// A reply under a running search stops it, and the run that goes on resumes its session told what was added.
    func testSteerResumesTheStoppedSearch() async throws {
        let store = TestStore(document: "@discover --research tutors\nbart~> s1")
        let root = tempDir("steer").path
        final class Steering: AgentRunner, @unchecked Sendable {
            var calls: [(args: [String], env: [String: String], input: String)] = []
            let lock = NSLock()
            func run(shell: String, args: [String], cwd: String, env: [String: String], timeout: TimeInterval, stopper: AgentShell.Stopper?, onLine: ((String) -> Void)?) async -> (stdout: String, failure: AgentShell.Failure?) {
                let input = (try? String(contentsOfFile: env["ENGELBART_BART_INPUT"] ?? "", encoding: .utf8)) ?? ""
                let n = lock.withLock { calls.append((args, env, input)); return calls.count }
                if n == 1 {
                    onLine?("{\"type\":\"system\",\"session_id\":\"0199aaaa-bbbb-cccc-dddd-eeeeffff0001\"}")
                    while stopper?.isStopped != true { try? await Task.sleep(nanoseconds: 20_000_000) }
                    return ("", AgentShell.Failure(code: nil, notFound: false, killed: true, message: "killed"))
                }
                return ("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"## Start here\\nx\"}\n", nil)
            }
        }
        let runner = Steering()
        var c = Bart.Config(readModels: { DEFAULTS }, environment: ["SHELL": "/bin/zsh"], runDirectory: root + "/runs", codexHome: root + "/ch",
                            brainstormCodexHome: root + "/b", discoverCodexHome: root + "/d", createCodexHome: root + "/c", routerCodexHome: root + "/r", makingCodexHome: root + "/m")
        c.runner = runner
        let bart = Bart(c)
        let first = Task { try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "s1", ref: .workspace("w1"), workspaceId: "w1", text: "--research tutors", agent: "discover")) { _ in } }
        while runner.lock.withLock({ runner.calls.isEmpty }) { try await Task.sleep(nanoseconds: 20_000_000) }
        try await Task.sleep(nanoseconds: 100_000_000)
        let second = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "s2", ref: .workspace("w1"), workspaceId: "w1", text: "--research tutors --steer kids", agent: "discover", steer: Steer(after: "s1", words: "kids"))) { _ in }
        do { _ = try await first.value; XCTFail("the first search was stopped") } catch { XCTAssertEqual((error as? BartError)?.kind, "stopped") }
        XCTAssertEqual(second.lines[0], "bart> ## Start here")
        let goes = runner.calls[1]
        XCTAssertTrue(goes.args[1].contains("--resume \"$ENGELBART_BART_SESSION\""))
        XCTAssertEqual(goes.env["ENGELBART_BART_SESSION"], "0199aaaa-bbbb-cccc-dddd-eeeeffff0001")
        XCTAssertTrue(goes.input.contains("<question>\nWhile you were searching, the person added this:\n\nkids\n\nTake it into account"), goes.input)
        XCTAssertFalse(goes.input.contains("<search>"), "no <mode>/<search> again: the session has them")
    }

    func testMentionedFilesKeepDocumentOrder() {
        let store = TestStore(document: "x")
        let rows = [LibraryRow(id: "f1", name: "Folder", type: "folder", path: "/data", folderPath: "/data")]
        let files = Context.mentionedFiles(store, rows, ["f1", "file:f1:z.md", "file:f1:a.md", "file:gone:b.md"])
        XCTAssertEqual(files.map { $0.path }, ["/data/z.md", "/data/a.md"], "as the documents mention them, not sorted")
        XCTAssertEqual(Context.mentionedFilesBlock(files), "<mentioned_files>\n[\n {\n  \"path\": \"/data/z.md\",\n  \"folder\": \"Folder\",\n  \"exists\": false\n },\n {\n  \"path\": \"/data/a.md\",\n  \"folder\": \"Folder\",\n  \"exists\": false\n }\n]\n</mentioned_files>")
    }

    final class Lib: CreatedLibrary, @unchecked Sendable {
        let dir: String; var rows: [String: LibraryRow] = [:]; var saved: [(String, String)] = []
        init(_ dir: String) { self.dir = dir }
        func projectDir(projectId: String) throws -> String { dir }
        func row(id: String) async -> LibraryRow? { rows[id] }
        func saveCreated(projectId: String, workspaceId: String?, file: String, name: String, type: String) async throws -> LibraryRow {
            let row = LibraryRow(id: "row-\(rows.count + 1)", name: name, type: type, path: file)
            rows[row.id] = row; saved.append((name, type)); return row
        }
    }

    func testCreatedSaveOnce() async throws {
        let project = tempDir("created").path
        let draft = tempDir("draft").path
        try "# r".write(toFile: draft + "/report.md", atomically: true, encoding: .utf8)
        try "x".write(toFile: draft + "/a.exe", atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: draft + "/link.md", withDestinationPath: "/etc/hosts")
        let kept = try Create.keepCreated(projectDir: project, askId: "k1", draft: draft)
        XCTAssertEqual(kept.files.map { $0.rel }, ["report.md"])
        XCTAssertEqual(kept.skipped, ["link.md: not a plain file", "a.exe: .exe is not a format the library keeps"])
        let lib = Lib(project)
        let first = try await Create.saveCreated(projectDir: project, projectId: "p", workspaceId: "w", askId: "k1", rel: "report.md", library: lib)
        let again = try await Create.saveCreated(projectDir: project, projectId: "p", workspaceId: "w", askId: "k1", rel: "report.md", library: lib)
        XCTAssertEqual(first.id, again.id); XCTAssertEqual(lib.saved.count, 1, "saved once")
        XCTAssertEqual(lib.saved.first?.0, "report"); XCTAssertEqual(lib.saved.first?.1, "md")
        let read = try await Create.readCreated(projectDir: project, askId: "k1", rel: "report.md", library: lib)
        XCTAssertEqual(read["text"], "# r"); XCTAssertEqual(read["saved"]?["id"], .string(first.id)); XCTAssertEqual(read["missing"], false)
        let gone = try await Create.readCreated(projectDir: project, askId: "k1", rel: "nope.md", library: lib)
        XCTAssertEqual(gone["missing"], true)
        XCTAssertEqual(Create.createdBody("Made it.", kept, "k1"), "Made it.\n\n@[report.md](made:k1/report.md)\n\nNot kept: link.md: not a plain file; a.exe: .exe is not a format the library keeps.")
    }

    func testHighlightAskLandsOnItsMark() async throws {
        let store = TestStore(document: "@chat q")
        let hub = EventHub()
        let done = expectation(description: "paper-ask-done")
        hub.on(BartEvents.paperAskDone) { payload in if payload["entry"] != nil { done.fulfill() } }
        let ipc = BartIPC(bart: fakeBart(), store: store, readModels: { MODELS }, home: { tempDir("ipc") }, hub: hub)
        let out = try await ipc.askBart(window: "w", pid: "p1", input: j(#"{"askId":"h1","ref":{"kind":"mark","id":"m1","url":"https://x.org/p.pdf","page":3},"workspaceId":"w1","text":"what does it mean?","highlight":{"quote":"a passage","note":"my note","paper":"Paper"}}"#))
        XCTAssertEqual(out["entry"]?["question"], "what does it mean?")
        XCTAssertTrue(out["entry"]?["meta"]?["foot"]?.string?.hasPrefix("Chat · Sol · medium") == true)
        XCTAssertEqual(store.markAnswers.first?.0, "m1")
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(try ipc.runningPaperAsks(window: "w", pid: "p1").count, 0)
        // The document it saw: the passage as <highlight>, asked from the highlight.
        let c = try await Context.build(store: store, projectId: "p1", ref: DocRef(kind: "mark", id: "m1", url: "https://x.org/p.pdf", page: 3), workspaceId: "w1", askId: "h1",
                                        highlight: HighlightInput(quote: "a passage", note: "my note", paper: "Paper", pageText: "around it"))
        XCTAssertTrue(c.documents.contains("<highlight paper=\"Paper\" path=\"https://x.org/p.pdf\" page=\"3\">\n<quote>\na passage\n</quote>\n<note>\nmy note\n</note>\n<page_text>\naround it\n</page_text>\n</highlight>"))
        XCTAssertTrue(c.head.contains("asked from: a highlight on page 3 of \"Paper\", opened from the workspace \"W\""))
    }

    func testStageInFront() async throws {
        let store = TestStore(document: "@chat q\nbart~> s1")
        let shot = Data([0x89, 0x50, 0x4E, 0x47])
        let live = LivePage(selection: { ["quote": ["exact": "selected words"], "pageText": "around"] }, screenshot: { shot })
        let c = try await Context.build(store: store, projectId: "p1", ref: .workspace("w1"), workspaceId: "w1", askId: "s1",
                                        stage: StageInput(kind: "web", url: "https://x.org/a", title: "A page"), live: live)
        XCTAssertTrue(c.now.hasPrefix("<stage source=\"web\" title=\"A page\" address=\"https://x.org/a\" highlights=\"0\">\n<selection>\n<quote>\nselected words\n</quote>\n<page_text>\naround\n</page_text>\n</selection>\n<screenshot path=\"\(store.dataRoot)/bart-shots/s1.png\"/>\n</stage>"), c.now)
        // Other agents see no Stage.
        let b = try await Context.build(store: store, projectId: "p1", ref: .workspace("w1"), workspaceId: "w1", askId: "s1", agent: "discover", stage: StageInput(kind: "web", url: "https://x.org/a"))
        XCTAssertEqual(b.now, ""); XCTAssertFalse(b.documents.contains("<stage"))
    }
}
