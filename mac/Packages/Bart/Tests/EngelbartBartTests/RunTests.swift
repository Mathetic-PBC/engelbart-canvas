import XCTest
import EngelbartCore
@testable import EngelbartBart

// Ported from test/bart.test.cjs (climb, threads, the fake agents, the real runner with the CLI stubbed), test/route.test.cjs,
// test/create.test.cjs, test/cite.test.cjs, test/agent-map.test.cjs (run log), test/context.test.cjs (summaries, sweep),
// test/project-library.test.cjs (catalog).

final class MemoryDB: BartLibraryDB, @unchecked Sendable {
    var rows: [LibraryRow]
    var texts: [String: (String, Double)] = [:]
    let lock = NSLock()
    init(_ rows: [LibraryRow] = []) { self.rows = rows }
    func list() async throws -> [LibraryRow] { lock.withLock { rows } }
    func get(_ id: String) async throws -> LibraryRow? { lock.withLock { rows.first { $0.id == id } } }
    func texts(for ids: [String], max: Int) async throws -> [String: String] { lock.withLock { var o: [String: String] = [:]; for id in ids { if let t = texts[id] { o[id] = t.0.jsSlice(0, max) } }; return o } }
    func textStamps() async throws -> [String: Double] { lock.withLock { texts.mapValues { $0.1 } } }
    func setText(_ id: String, text: String, modified: Double) async throws { lock.withLock { texts[id] = (text, modified) } }
    func setSummary(_ id: String, summary: String?, readAt: Date?) async throws {
        lock.withLock { if let i = rows.firstIndex(where: { $0.id == id }) { rows[i].summary = summary; rows[i].summaryEdited = summary == nil ? nil : Time.iso(readAt ?? Date()) } }
    }
    func setCharCount(_ id: String, _ count: Int) async throws { lock.withLock { if let i = rows.firstIndex(where: { $0.id == id }) { rows[i].charCount = count } } }
    func papersWithFiles() async throws -> [LibraryRow] { lock.withLock { rows.filter { $0.type == "pdf" && $0.path != nil } } }
    func uncountedNotes() async throws -> [LibraryRow] { lock.withLock { rows.filter { $0.tags.contains("note") && $0.charCount == nil } } }
    func summaryCandidates(before: Date, minChars: Int) async throws -> [LibraryRow] {
        lock.withLock { rows.filter { $0.tags.contains("note") && ($0.lastEdited.flatMap(Time.parse).map { $0 < before } ?? false) && ($0.summary == nil || ($0.summaryEdited ?? "") < ($0.lastEdited ?? "") || ($0.charCount ?? 0) <= minChars) } }
    }
}

/// A project on disk: <root>/P/ with one workspace "W" whose document is given.
final class TestStore: BartStore, @unchecked Sendable {
    let dataRoot: String
    let homeDir: String
    let libraryDb: BartLibraryDB
    let project: ProjectRecord
    let workspace: WorkspaceRecord
    var started: [String] = [], finished: [String] = [], stopped: [String] = []
    init(document: String, rows: [LibraryRow] = []) {
        let root = tempDir("store").path
        dataRoot = root; homeDir = (root as NSString).appendingPathComponent("home")
        let dir = (root as NSString).appendingPathComponent("P")
        try! FileManager.default.createDirectory(atPath: (dir as NSString).appendingPathComponent("W"), withIntermediateDirectories: true)
        try! document.write(toFile: (dir as NSString).appendingPathComponent("W/workspace.md"), atomically: true, encoding: .utf8)
        project = ProjectRecord(id: "p1", name: "Proj", description: "A test project", directory: nil, dir: dir)
        workspace = WorkspaceRecord(id: "w1", name: "W", path: "W", context: rows.map { $0.id })
        libraryDb = MemoryDB(rows.map { var r = $0; r.projectId = "p1"; return r })
    }
    func findWorkspace(projectId: String, workspaceId: String) throws -> (project: ProjectRecord, workspace: WorkspaceRecord, workspaceDir: String) { (project, workspace, workspace.dir(in: project.dir)) }
    func findProject(projectId: String) throws -> ProjectRecord { project }
    func projects() -> [ProjectRecord] { [project] }
    func flattenWorkspaces(projectDir: String) -> [WorkspaceRecord] { [workspace] }
    func notesMadeIn(projectDir: String, workspaces: [WorkspaceRecord]?) async -> [String: String?] { [:] }
    func recountWorkspaces() {}
    func expandDoc(projectId: String, ref: DocRef, seen: [String]) async throws -> (title: String, body: String, seen: [String]) {
        let body = try String(contentsOfFile: (project.dir as NSString).appendingPathComponent("W/workspace.md"), encoding: .utf8)
        return ("W", body, seen)
    }
    func imagePaths(projectId: String, text: String) async -> String { text.replacingOccurrences(of: "](img:i1)", with: "](/images/i1.png)") }
    func instructionsBlock() -> String { "" }
    func memoryBlock() -> String { "" }
    func zoteroPointerLine() -> String { "" }
    func gettingStarted(projectId: String) -> (hidden: Bool, workspaceId: String?)? { nil }
    func readAnnotations(rowId: String) async throws -> JSONValue? { nil }
    func readPageAnnotations(url: String) async throws -> JSONValue? { nil }
    func annotationsFile(rowId: String?, url: String?) async -> String { "" }
    func lookupItem(url: String) async -> LibraryRow? { nil }
    func readWebMark(rowId: String?, url: String?, markId: String) async -> JSONValue? { nil }
    func inkFile(of row: LibraryRow) -> String? { nil }
    func fileInRow(_ row: LibraryRow, rel: String) -> (path: String, exists: Bool)? { row.folderPath.map { ($0 + "/" + rel, false) } }
    var markAnswers: [(String, JSONValue)] = []
    func addMarkAnswer(rowId: String?, url: String?, page: Int?, markId: String, entry: JSONValue) async throws { markAnswers.append((markId, entry)) }
    func agentStarted(id: String, kind: String, projectId: String, workspaceId: String, doc: DocRef) { started.append(id) }
    func agentFinished(id: String) { finished.append(id) }
    func agentStopped(id: String) { stopped.append(id) }
}

func fakeBart(_ models: ModelsList = MODELS, runLog: RunLog? = nil, delay: Double = 40) -> Bart {
    let root = tempDir("bartrun").path
    var c = Bart.Config(readModels: { models }, runDirectory: root, codexHome: root + "/ch", brainstormCodexHome: root + "/chb", discoverCodexHome: root + "/chd",
                        createCodexHome: root + "/chc", routerCodexHome: root + "/chr", makingCodexHome: root + "/chm", fake: true)
    c.fakeDelayMs = delay
    c.runLog = runLog
    return Bart(c)
}

/// The CLI stubbed: each run answers what `reply` makes of its command and environment (the Electron tests' `run`).
final class StubRunner: AgentRunner, @unchecked Sendable {
    var calls: [(args: [String], env: [String: String], cwd: String)] = []
    let lock = NSLock()
    let reply: ([String], [String: String]) -> (lines: [String], output: String?)
    init(_ reply: @escaping ([String], [String: String]) -> (lines: [String], output: String?)) { self.reply = reply }
    func run(shell: String, args: [String], cwd: String, env: [String: String], timeout: TimeInterval, stopper: AgentShell.Stopper?, onLine: ((String) -> Void)?) async -> (stdout: String, failure: AgentShell.Failure?) {
        lock.withLock { calls.append((args, env, cwd)) }
        let (lines, output) = reply(args, env)
        if let output, let out = env["ENGELBART_BART_OUTPUT"] ?? env["ENGELBART_NAME_OUTPUT"] ?? env["ENGELBART_ROUTE_OUTPUT"] ?? env["ENGELBART_SUMMARY_OUTPUT"] {
            try? output.write(toFile: out, atomically: true, encoding: .utf8)
        }
        for l in lines { onLine?(l) }
        return (lines.joined(separator: "\n") + "\n", nil)
    }
}

final class RunTests: XCTestCase {
    func step(_ name: String, _ effort: String) -> Step { Step(provider: "openai", key: name.lowercased(), model: name.lowercased(), name: name, effort: effort) }

    func testClimb() async throws {
        let steps = Question.readQuestion("q", MODELS).steps
        var seen: [(String, String?, String)] = []
        var progress: [String] = []
        var replies = ["ESCALATE: needs a proof", "ESCALATE: still hard", "ESCALATE: no", "the answer"]
        let out = try await AskPlan.climb(steps: steps, pinned: false, first: { "FIRST \($0)" }, onProgress: { p in
            if case .step(let s, let of, let n, let e, let up) = p { progress.append("\(s)/\(of) \(n!) \(e!) up\(up)") }
        }) { level, message, session in
            seen.append(("\(level.name) \(level.effort)", session, message))
            return (replies.removeFirst(), "s1")
        }
        XCTAssertEqual(out.text, "the answer")
        XCTAssertEqual(seen.map { "\($0.0) \($0.1 ?? "nil")" }, ["Sol medium nil", "Sol high s1", "Astra xhigh s1", "Astra xhigh s1"])
        XCTAssertEqual(seen[0].2, "FIRST <level>You are running as Sol at medium effort, step 1 of 3. A higher step exists: Sol at high effort.</level>")
        XCTAssertTrue(seen[2].2.contains("step 3 of 3. No higher step exists."))
        XCTAssertTrue(seen[3].2.contains("Answer the question now, as well as you can"))
        XCTAssertEqual(out.trail.map { "\($0.name) \($0.effort) \($0.why)" }, ["Sol medium needs a proof", "Sol high still hard"])
        XCTAssertEqual(progress, ["1/3 Sol medium up0", "2/3 Sol high up1", "3/3 Astra xhigh up2", "3/3 Astra xhigh up2"])
        XCTAssertTrue(AskPlan.levelBlock(Question.readQuestion("--opus q", MODELS).steps, 0, pinned: true).contains("chose this model and effort by hand: no higher step exists"))
        let pinned = Question.readQuestion("--sonnet q", MODELS).steps
        let long = "ESCALATE: " + String(repeating: "x", count: 600)
        let answered = try await AskPlan.climb(steps: pinned, pinned: true, first: { _ in "m" }) { _, _, _ in (long, "s") }
        XCTAssertEqual(answered.text, long)
        let stuck = try await AskPlan.climb(steps: pinned, pinned: true, first: { _ in "m" }) { _, _, _ in ("ESCALATE: cannot", "s") }
        XCTAssertEqual(stuck.text, "I could not answer this at the highest step available. cannot")
    }

    func testThreads() throws {
        let t = Threads(idle: 60)
        t.keep("k", provider: "openai", session: "s1", projectId: "p", workspaceId: "w")
        XCTAssertNil(t.take("k", provider: "anthropic"), "only to the provider that made it")
        XCTAssertNil(t.take("k", provider: "openai"), "handed out once: the wrong provider's take removed it too")
        t.keep("k", provider: "openai", session: "s1", projectId: "p", workspaceId: "w")
        XCTAssertEqual(t.take("k", provider: "openai")?.session, "s1")
        XCTAssertEqual(t.size, 0)
        // Outlives the app.
        let file = tempDir("threads").appendingPathComponent("bart-threads.json")
        Threads(idle: 60, file: file).keep("k2", provider: "anthropic", session: "s2", projectId: "p", workspaceId: "w")
        XCTAssertEqual(Threads(idle: 60, file: file).take("k2", provider: "anthropic")?.session, "s2")
        // Past its idle time on disk: gone.
        let old = Threads(idle: 60, file: file, now: { Time.ms() - 120_000 }); old.keep("k3", provider: "openai", session: "s3", projectId: nil, workspaceId: nil)
        XCTAssertNil(Threads(idle: 60, file: file).take("k3", provider: "openai"))
        // An exchange is known by what the document says was said.
        let ref = DocRef.workspace("w")
        XCTAssertEqual(AskPlan.threadKey("p", ref, [Turn(question: "q", answer: "a")]), AskPlan.threadKey("p", ref, [Turn(question: "q", answer: "a", agent: "bart")]))
        XCTAssertNotEqual(AskPlan.threadKey("p", ref, [Turn(question: "q", answer: "a")]), AskPlan.threadKey("p", ref, [Turn(question: "q", answer: "b")]))
        // sha256 of JSON.stringify(["p","workspace","w",[["q","a"]]]), as Node computes it.
        XCTAssertEqual(AskPlan.threadKey("p", ref, [Turn(question: "q", answer: "a")]), THREAD_KEY_P_W_QA)
    }

    func testTurnPlanDiscoverAndBrainstorm() {
        let refine = AskPlan.turnPlan(agent: "discover", text: "--refine not that, tutors", turns: [Turn(question: "--research how tutors help", answer: "## Start here")], choice: nil, welcome: false, models: DEFAULTS)
        XCTAssertTrue(refine.refining && refine.refine && !refine.search)
        XCTAssertEqual(refine.extra, "<refine>The person is refining the research direction. The direction last searched: how tutors help. Their latest words take precedence over anything said before.</refine>")
        let search = AskPlan.turnPlan(agent: "discover", text: "--research how tutors help --deep", turns: [], choice: nil, welcome: false, models: DEFAULTS)
        XCTAssertTrue(search.search)
        XCTAssertTrue(search.extra.hasPrefix("<mode>deep. Up to five starting points"))
        XCTAssertEqual(search.question, "how tutors help")
        let empty = AskPlan.turnPlan(agent: "discover", text: "", turns: [], choice: nil, welcome: false, models: DEFAULTS)
        XCTAssertEqual(empty.asked, AskPlan.discoverOpening)
        let b = AskPlan.turnPlan(agent: "brainstorm", text: "", turns: [], choice: ("opus", "max"), welcome: false, models: DEFAULTS)
        XCTAssertEqual(b.asked, Card.opening)
        XCTAssertEqual(b.steps.map { "\($0.name) \($0.effort)" }, ["Opus max"], "Regenerate's selector picks for that run")
        // The Welcome walkthrough: first, then stage (written, no model), then next, then the result.
        let w1 = AskPlan.turnPlan(agent: "brainstorm", text: "", turns: [], choice: nil, welcome: true, models: DEFAULTS)
        XCTAssertEqual(w1.stage, "first"); XCTAssertNil(w1.written)
        let first = Card.cardBody(AskPlan.welcomeReply("{}", stage: "first")).body
        let w2 = AskPlan.turnPlan(agent: "brainstorm", text: "a tutor study", turns: [Turn(question: "", answer: first)], choice: nil, welcome: true, models: DEFAULTS)
        XCTAssertEqual(w2.stage, "stage"); XCTAssertTrue(w2.written!.contains("Where are you in the process?"))
        let w3 = AskPlan.turnPlan(agent: "brainstorm", text: "picked \"Just exploring\"", turns: [Turn(question: "", answer: first), Turn(question: "a tutor study", answer: w2.written!)], choice: nil, welcome: true, models: DEFAULTS)
        XCTAssertEqual(w3.stage, "next")
        let next = Card.cardBody(AskPlan.welcomeReply("{\"say\":\"Lead.\",\"card\":\"none\"}", stage: "next")).body
        let w4 = AskPlan.turnPlan(agent: "brainstorm", text: "measure it", turns: [Turn(question: "", answer: first), Turn(question: "a tutor study", answer: w2.written!), Turn(question: "picked \"Just exploring\"", answer: next)], choice: nil, welcome: true, models: DEFAULTS)
        XCTAssertEqual(w4.stage, "result"); XCTAssertEqual(w4.written, "measure it\n\(Card.resultOffer)")
        XCTAssertEqual(Bart.resultReply(w4).welcome, "result")
    }

    func testReplyBodyAndTakes() {
        XCTAssertEqual(AskPlan.replyBody("bart", "An answer.\n\n*Chat · Opus · high*"), "An answer.")
        XCTAssertEqual(AskPlan.replyBody("discover", "Searching now.\n## Start here\n- x"), "## Start here\n- x")
        XCTAssertEqual(AskPlan.replyBody("discover", "## This paper\nx"), "## This paper\nx")
        let t = AskPlan.takeTopic("Sure.\n\n<topic>**retry loops**</topic>")
        XCTAssertEqual(t.text, "Sure."); XCTAssertEqual(t.topic, "Retry loops")
        let r = AskPlan.takeResearch("I will look.\n\n<research> how  tutors\nhelp </research>")
        XCTAssertEqual(r.text, "I will look."); XCTAssertEqual(r.research, "how tutors help")
        XCTAssertEqual(AskPlan.steersShown("tutors --steer only kids --steer and adults"), "tutors (also: only kids; and adults)")
        XCTAssertEqual(AskPlan.withoutResearch("--research  tutors"), "tutors")
        XCTAssertTrue(AskPlan.steerMessage("kids", mode: "quick").hasPrefix("While you were searching, the person changed how far to search:\n\n<mode>quick."))
        XCTAssertEqual(AskPlan.createRules("/d/x"), "Read,Grep,Glob,WebSearch,WebFetch,Edit(//d/x/**),Write(//d/x/**)")
    }

    func testFakeChatClimbsOnHardAndFollowsUp() async throws {
        let store = TestStore(document: "My notes.\n@chat why is it hard?\nbart~> k1")
        let log = RunLog()
        let bart = fakeBart(runLog: log)
        let progress = ProgressBox()
        let out = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "k1", ref: .workspace("w1"), workspaceId: "w1", text: "why is it hard?")) { progress.add($0) }
        XCTAssertEqual(out.meta.trail.map { $0.why }, ["the question says it is hard"])
        XCTAssertTrue(out.lines[0].hasPrefix("bart> FAKE ANSWER to \"why is it hard?\"."))
        XCTAssertTrue(out.lines.last!.hasPrefix("bart> *Chat · Sol · high · "))
        XCTAssertTrue(progress.all.contains { if case .lines = $0 { return true }; return false })
        XCTAssertTrue(progress.all.contains(.activity("Reading notes.md", log: true)))
        XCTAssertEqual(log.list().first?["status"], "done")
        // A follow-up inside the window resumes the session: given the question alone.
        let turn = Turn(question: "why is it hard?", answer: Reply.answerText(out.lines.map { $0.replacingOccurrences(of: "bart> ", with: "").replacingOccurrences(of: "bart>", with: "") }.dropLast(2).joined(separator: "\n")))
        let again = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "k2", ref: .workspace("w1"), workspaceId: "w1", text: "and then?", turns: [turn])) { _ in }
        XCTAssertTrue(again.lines.joined().contains("the same session, given the question alone"), again.lines.joined(separator: "\n"))
        // Edited answer: a new session, given the earlier turn.
        let edited = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "k3", ref: .workspace("w1"), workspaceId: "w1", text: "and then?", turns: [Turn(question: "why is it hard?", answer: "edited")])) { _ in }
        XCTAssertTrue(edited.lines.joined().contains("a new session, given 1 earlier turn"))
    }

    func testFakeStops() async throws {
        let store = TestStore(document: "@chat q\nbart~> s1")
        let bart = fakeBart(delay: 2000)
        let task = Task { try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "s1", ref: .workspace("w1"), workspaceId: "w1", text: "q")) { _ in } }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(bart.stop("s1"))
        do { _ = try await task.value; XCTFail("stopped") } catch { XCTAssertEqual((error as? BartError)?.kind, "stopped") }
        XCTAssertFalse(bart.stop("s1"))
    }

    func testFakeDiscoverSettlesThenSearches() async throws {
        let store = TestStore(document: "@discover\nbart~> d1")
        let bart = fakeBart(DEFAULTS)
        let opening = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "d1", ref: .workspace("w1"), workspaceId: "w1", text: "", agent: "discover")) { _ in }
        XCTAssertTrue(opening.lines.joined(separator: "\n").contains("What would you like to research?"))
        let clear = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "d2", ref: .workspace("w1"), workspaceId: "w1", text: "papers on tutoring", agent: "discover")) { _ in }
        XCTAssertEqual(clear.research, "papers on tutoring")
        XCTAssertFalse(clear.lines.joined().contains("<research>"))
        let progress = ProgressBox()
        let search = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "d3", ref: .workspace("w1"), workspaceId: "w1", text: "--research papers on tutoring", agent: "discover")) { progress.add($0) }
        XCTAssertTrue(search.lines[0].hasPrefix("bart> ## Start here"))
        XCTAssertTrue(search.lines.last!.hasPrefix("bart> *Discover · Opus · high · "))
        let stories = progress.all.compactMap { p -> JSONValue? in if case .trace(let s) = p { return s }; return nil }
        XCTAssertFalse(stories.isEmpty)
        let lines = stories.last!["groups"]!.array!.flatMap { $0["lines"]!.array!.map { $0["text"]!.string! } }
        XCTAssertTrue(lines.contains("Picked “A fake paper close to the problem”, the closest of 12"), "\(lines)")
        XCTAssertTrue(lines.contains("Listed the 14 papers “A fake paper of yours” cites"))
        XCTAssertTrue(lines.contains("Found 3 newer papers that cite “A fake paper of yours”"))
    }

    func testFakeBrainstormOpensWithCardThenProse() async throws {
        let store = TestStore(document: "bart# [brainstorm x] Retries\n@brainstorm\nbart~> b1")
        let bart = fakeBart(DEFAULTS)
        let opening = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "b1", ref: .workspace("w1"), workspaceId: "w1", text: "", agent: "brainstorm")) { _ in }
        XCTAssertEqual(opening.lines[0], "bart> ```json")
        XCTAssertTrue(opening.lines.last!.hasPrefix("bart> *Brainstorm · "), "no model named")
        XCTAssertEqual(Card.cardOfAnswer(Reply.answerText(opening.lines.dropLast(2).map { String($0.dropFirst(6)) }.joined(separator: "\n")))?["card"], "focus")
        let next = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "b2", ref: .workspace("w1"), workspaceId: "w1", text: "New topic: loops", turns: [Turn(question: "", answer: "a card")], agent: "brainstorm")) { _ in }
        XCTAssertEqual(next.topic, "Loops")
    }

    func testFakeCreateKeepsFiles() async throws {
        let store = TestStore(document: "@create a chart of visits\nbart~> c1")
        let bart = fakeBart(DEFAULTS)
        let progress = ProgressBox()
        let out = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "c1", ref: .workspace("w1"), workspaceId: "w1", text: "make a chart of visits", agent: "create")) { progress.add($0) }
        let body = out.lines.joined(separator: "\n")
        XCTAssertTrue(body.contains("Created a fake report, a chart page and its data, from made-up numbers."), body)
        XCTAssertTrue(body.contains("@[report.md](made:c1/report.md)") && body.contains("@[chart.html](made:c1/chart.html)") && body.contains("@[data.csv](made:c1/data.csv)"))
        XCTAssertEqual(out.meta.created?.map { $0.path }, ["chart.html", "data.csv", "report.md"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.project.dir + "/.created/c1/chart.html"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.dataRoot + "/.create/c1"), "the draft folder is gone")
        XCTAssertTrue(progress.all.contains(.making("A fake report, a chart page and its data, from made-up numbers.")))
        let refused = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "c2", ref: .workspace("w1"), workspaceId: "w1", text: "change the title", agent: "create")) { _ in }
        XCTAssertTrue(refused.lines[0].contains("This is a Build"))
        do { _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "c3", ref: .workspace("w1"), workspaceId: "w1", text: "", agent: "create")) { _ in }; XCTFail() }
        catch { XCTAssertEqual((error as? BartError)?.message, "There is nothing on the line to make.") }
    }

    func testRealRunnerCommandLines() async throws {
        let store = TestStore(document: "@chat why?\nbart~> r1")
        let root = tempDir("real").path
        let runner = StubRunner { args, env in
            let command = args.last!
            if command.contains(" exec ") || command.contains("codex") {
                return (["{\"type\":\"thread.started\",\"thread_id\":\"0199aaaa-bbbb-cccc-dddd-eeeeffff0000\"}",
                         "{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\",\"command\":\"cat notes.md\"}}",
                         "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"An answer.\"}}"], "An answer.")
            }
            return (["{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"Claude's answer.\"}"], nil)
        }
        let auth = root + "/auth.json"
        try #"{"auth_mode":"chatgpt","tokens":{"a":1}}"#.write(toFile: auth, atomically: true, encoding: .utf8)
        var c = Bart.Config(readModels: { MODELS }, environment: ["SHELL": "/bin/zsh", "HOME": root, "OPENAI_API_KEY": "sk-x", "CLAUDECODE": "1"], runDirectory: root + "/runs",
                            codexHome: root + "/ch", brainstormCodexHome: root + "/chb", discoverCodexHome: root + "/chd", createCodexHome: root + "/chc", routerCodexHome: root + "/chr", makingCodexHome: root + "/chm")
        c.runner = runner; c.codexAuthFile = auth
        let bart = Bart(c)
        let out = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "r1", ref: .workspace("w1"), workspaceId: "w1", text: "why?")) { _ in }
        XCTAssertEqual(out.lines[0], "bart> An answer.")
        let call = runner.calls[0]
        XCTAssertEqual(call.args[0], "-ilc")
        XCTAssertTrue(call.args[1].hasPrefix("exec codex exec --color never --skip-git-repo-check -m \"$ENGELBART_BART_MODEL\" -c 'model_reasoning_effort=\"medium\"' -c 'sandbox_mode=\"read-only\"' -c 'tools.web_search=true' -c project_doc_max_bytes=0 --json -o \"$ENGELBART_BART_OUTPUT\" - < \"$ENGELBART_BART_INPUT\""), call.args[1])
        XCTAssertNil(call.env["OPENAI_API_KEY"], "never an API key"); XCTAssertNil(call.env["CLAUDECODE"])
        XCTAssertEqual(call.env["CODEX_HOME"], root + "/ch")
        XCTAssertEqual(try String(contentsOfFile: root + "/ch/AGENTS.md", encoding: .utf8), Prompts.bart)
        XCTAssertEqual(call.cwd, root + "/runs/p1")
        // The follow-up resumes the thread the events named.
        let turn = Turn(question: "why?", answer: "An answer.")
        _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "r2", ref: .workspace("w1"), workspaceId: "w1", text: "more?", turns: [turn])) { _ in }
        XCTAssertTrue(runner.calls[1].args[1].hasPrefix("exec codex exec resume \"$ENGELBART_BART_SESSION\" "))
        XCTAssertEqual(runner.calls[1].env["ENGELBART_BART_SESSION"], "0199aaaa-bbbb-cccc-dddd-eeeeffff0000")
        // Claude Code, pinned by flag.
        let claude = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "r3", ref: .workspace("w1"), workspaceId: "w1", text: "--opus --max why?")) { _ in }
        XCTAssertEqual(claude.lines[0], "bart> Claude's answer.")
        let cc = runner.calls[2].args[1]
        XCTAssertTrue(cc.hasPrefix("exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id \"$ENGELBART_BART_SESSION\" --restricted --setting-sources \"\" --strict-mcp-config --tools \"Read,Grep,Glob,WebSearch,WebFetch\" --allowedTools \"Read,Grep,Glob,WebSearch,WebFetch\" --add-dir \"$ENGELBART_BART_DIR0\" --model \"$ENGELBART_BART_MODEL\" --effort max --system-prompt-file"), cc)
        XCTAssertEqual(runner.calls[2].env["ENGELBART_BART_DIR0"], store.dataRoot)
    }

    func testCodexNotSignedIn() async {
        let store = TestStore(document: "@chat q\nbart~> n1")
        let root = tempDir("nosign").path
        var c = Bart.Config(readModels: { MODELS }, environment: ["SHELL": "/bin/zsh"], runDirectory: root, codexHome: root + "/ch", brainstormCodexHome: root + "/b", discoverCodexHome: root + "/d", createCodexHome: root + "/c", routerCodexHome: root + "/r", makingCodexHome: root + "/m")
        c.codexAuthFile = root + "/none.json"; c.runner = StubRunner { _, _ in ([], nil) }
        do { _ = try await Bart(c).ask(store: store, projectId: "p1", AskRequest(askId: "n1", ref: .workspace("w1"), workspaceId: "w1", text: "q")) { _ in }; XCTFail() }
        catch { XCTAssertEqual(error as? BartError, BartError("unavailable", "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.")) }
    }

    func testRouter() async {
        XCTAssertEqual(Route.decide(nil), RoutePick(agent: "chat", sure: 0))
        XCTAssertEqual(Route.decide(RoutePick(agent: "discover", sure: 0.5)).agent, "chat")
        XCTAssertEqual(Route.decide(RoutePick(agent: "brainstorm", sure: 0.7), current: "chat").agent, "chat")
        XCTAssertEqual(Route.decide(RoutePick(agent: "brainstorm", sure: 0.85), current: "chat").agent, "brainstorm")
        XCTAssertEqual(Route.decide(RoutePick(agent: "discover", sure: 0.7), current: "discover").agent, "chat")
        XCTAssertEqual(Route.decide(RoutePick(agent: "create", sure: 0.7), current: "discover").agent, "create")
        XCTAssertEqual(Route.parseReply("Sure: {\"agent\": \"@Build\", \"sure\": 1.4, \"spec\": true}"), RoutePick(agent: "build", sure: 1, spec: true))
        XCTAssertNil(Route.parseReply("{\"agent\": \"nobody\", \"sure\": 1}"))
        XCTAssertEqual(Route.routeModel(DEFAULTS)?.name, "Haiku"); XCTAssertEqual(Route.routeModel(MODELS)?.name, "Luna")
        let input = Route.routeInput(text: " q ", section: "# H\n@chat x\nbart> y", workspaceName: "W", threads: [RouteThread(agent: "", question: "a  b", up: 1)], specAbove: true, specTitle: "Spec", current: "@Discover")
        XCTAssertEqual(input, "<workspace>W</workspace>\n\n<section>\n# H\n@chat x\n\(Strip.omitted)\n</section>\n\n<threads>\n- @chat, 1 line up: \"a b\"\n</threads>\n\n<spec_above>yes: \"Spec\"</spec_above>\n\n<current>discover</current>\n\n<line>\nq\n</line>")
        XCTAssertEqual(RouteRules.routeByRule("")?.agent, "brainstorm"); XCTAssertEqual(RouteRules.routeByRule("--build x")?.agent, "build")
        XCTAssertEqual(RouteRules.routeByRule("why --deep")?.agent, "discover"); XCTAssertNil(RouteRules.routeByRule("--sonnet why"))
        XCTAssertEqual(RouteRules.questionLine("@chat --opus **Why** do [runs](x) loop again and again and again and again and again and again and again and more"), "Why do runs loop again and again and again and again and again and again and")
        let log = RunLog()
        let router = Router.fake(runLog: log)
        let picked = await router.route(RouteRequest(projectId: "p", text: "find papers on tutors"))
        XCTAssertEqual(picked.agent, "discover")
        XCTAssertEqual(log.get(picked.id)?["pick"], "discover")
        let byRule = await router.route(RouteRequest(projectId: "p", text: "", rule: ("brainstorm", "empty")))
        XCTAssertEqual(byRule.by, "rule"); XCTAssertEqual(log.get(byRule.id)?["written"], ["@brainstorm"])
        router.corrected(id: nil, projectId: "p", text: "find papers on tutors", agent: "chat")
        XCTAssertEqual(log.get(picked.id)?["corrected"], "chat")
        let goAhead = await router.route(RouteRequest(text: "and go ahead", current: "chat"))
        XCTAssertEqual(goAhead.spec, true)
    }

    func testRunLogFile() {
        let file = tempDir("runlog").appendingPathComponent("agent-runs.jsonl")
        let log = RunLog(file: file)
        log.start(["id": "a", "agent": "bart", "system": "SYS", "question": "q"])
        log.step("a", model: "m", name: "M", effort: "high", input: "hi")
        log.event("a", j(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x"}}]}}"#))
        log.event("a", j(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"body"}]}}"#))
        log.output("a", raw: "ESCALATE: x", escalated: true)
        log.finish("a", status: "done", written: ["bart> x"])
        log.flush()
        let whole = log.get("a")!
        XCTAssertEqual(whole["system"], "SYS")
        XCTAssertEqual(whole["steps"]?.array?.first?["tools"]?.array?.first?["result"]?["excerpt"], "body")
        XCTAssertEqual(log.list().first?["toolCount"], 1)
        XCTAssertEqual(log.list().first?["model"], "m")
        let again = RunLog(file: file)
        XCTAssertEqual(again.get("a")?["status"], "done")
        XCTAssertEqual(again.get("a")?["system"], "SYS")
        // A run the app quit in the middle of never finished.
        log.start(["id": "b", "agent": "bart"]); log.flush()
        XCTAssertEqual(RunLog(file: file).get("b")?["status"], "stopped")
        let codex = ToolCalls.of(j(#"{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"papers","tool":"search","arguments":"{\"query\":\"x\"}","result":{"content":[{"type":"text","text":"ok"}]}}}"#))
        XCTAssertEqual(codex.first?.name, "papers.search"); XCTAssertEqual(codex.first?.input?["query"], "x")
    }

    func testPapersWithFakeFetch() async throws {
        final class Seen: @unchecked Sendable { var urls: [String] = [] }
        let seen = Seen()
        let work = #"{"id":"https://openalex.org/W1","title":"Tutoring at scale","publication_year":2024,"authorships":[{"author":{"display_name":"A. One"}}],"primary_location":{"source":{"display_name":"CHI"}},"doi":"https://doi.org/10.1/x","cited_by_count":5,"abstract_inverted_index":{"Tutors":[0],"help.":[1]},"referenced_works":["https://openalex.org/W2"],"locations":[{"landing_page_url":"https://arxiv.org/abs/2401.00001v2"}]}"#
        let papers = Papers(fetch: { url, _ in
            seen.urls.append(url.absoluteString)
            if url.path == "/works/W1" { return (200, Data(work.utf8)) }
            if url.path == "/works" { return (200, Data(#"{"meta":{"count":1},"results":[{"id":"https://openalex.org/W2","title":"Older","cited_by_count":9}]}"#.utf8)) }
            return (404, Data())
        }, wait: { _ in })
        let r = try await papers.resolve(query: "W1")
        XCTAssertEqual(r["paper"]?["abstract"], "Tutors help.")
        XCTAssertEqual(r["paper"]?["arxiv"], "https://arxiv.org/abs/2401.00001")
        XCTAssertEqual(r["paper"]?["doi"], "10.1/x")
        XCTAssertEqual(r["paper"]?["venue"], "CHI")
        let refs = try await papers.references(id: "W1", limit: nil)
        XCTAssertEqual(refs["results"]?.array?.first?["title"], "Older")
        XCTAssertTrue(seen.urls.contains { $0.contains("filter=openalex%3AW2") }, "\(seen.urls)")
        let s = try await papers.search(query: "how tutors help", limit: 3)
        XCTAssertEqual(s["order"], "closest in meaning first (title and abstract)")
        XCTAssertTrue(seen.urls.last!.contains("search.semantic=how+tutors+help"))
        let bad = await papers.callTool("resolve", j(#"{"nope":1}"#))
        XCTAssertEqual(bad.text, "Invalid argument: nope."); XCTAssertTrue(bad.isError)
        let none = await papers.callTool("resolve", j(#"{"query":"W404"}"#))
        XCTAssertEqual(none.text, #"{"found":false,"query":"W404"}"#)
        let listed = Papers.toolsListJSON.array!
        XCTAssertEqual(listed.map { $0["name"]!.string! }, ["resolve", "references", "citations", "author_works", "related", "search"])
        XCTAssertEqual(listed[0]["annotations"]?["readOnlyHint"], true)
    }

    func testCitations() async throws {
        let dir = tempDir("cite").path
        let note = dir + "/note.md"
        try "I decided the retry loop should stop after three tries.\nbart> Chat said the loop is fine.".write(toFile: note, atomically: true, encoding: .utf8)
        var o = Cite.Options()
        o.library = [LibraryRow(id: "n1", name: "Note", type: "md", path: note, created: "2026-10-12T10:00:00.000Z")]
        o.dataRoot = dir
        o.today = Time.parse("2026-10-28T00:00:00.000Z")!
        let good = PassageLink.citeHref(address: note, find: "the retry loop should stop", cite: "you")
        let wrong = PassageLink.citeHref(address: note, find: "words it never says", cite: "you")
        let theirs = PassageLink.citeHref(address: note, find: "the loop is fine", cite: "you")
        let out = await Cite.checkCitations("You chose a limit [x](\(good)). Not this [y](\(wrong)). Chat said [z](\(theirs)).", o)
        // A library note: whose words is said by the cite, not by its lines (only a workspace's answer lines are Chat's).
        XCTAssertEqual(out.kept.map { $0.label }, ["You · Oct 12", "You · Oct 12"])
        XCTAssertEqual(out.dropped.map { $0.reason }, ["not-found"])
        XCTAssertTrue(out.body.contains("Not this."), out.body)
        XCTAssertTrue(out.body.hasPrefix("You chose a limit [You · Oct 12]("))
        XCTAssertEqual(Cite.tidyAround("Here (x) it is.", 5, 8), "Here it is.")
        XCTAssertEqual(Cite.notCitable("/a/MEMORY.md"), "memory"); XCTAssertEqual(Cite.notCitable("/p/.context/catalog.json"), "catalog")
        // A workspace document: words on its answer lines are Chat's; dated by the workspace's meta.json.
        let wdir = dir + "/P/W"
        try FileManager.default.createDirectory(atPath: wdir, withIntermediateDirectories: true)
        try "@chat is it fine?\nbart> The loop is fine as it is.".write(toFile: wdir + "/workspace.md", atomically: true, encoding: .utf8)
        try #"{"created":"2026-09-02T10:00:00.000Z"}"#.write(toFile: wdir + "/meta.json", atomically: true, encoding: .utf8)
        var w = o
        w.projectDir = dir + "/P"; w.workspaces = [(WorkspaceRecord(id: "w2", name: "W", path: "W"), wdir)]; w.workspaceId = "w1"
        let chat = await Cite.checkCitations("It said so [x](\(PassageLink.citeHref(address: wdir + "/workspace.md", find: "the loop is fine", cite: "you"))).", w)
        XCTAssertEqual(chat.kept.map { "\($0.label) \($0.cite) \($0.relabeled)" }, ["Chat · Sep 2 other true"])
        let malformed = await Cite.checkCitations("[a](/x.md#find=q&cite=nobody)", o)
        XCTAssertEqual(malformed.dropped.first?.reason, "malformed")
    }

    func testNameAndMaking() async {
        XCTAssertEqual(NameChat.plainTitle("@chat --opus **Retry** logic in @[Paper](lib:1)."), "Retry logic in Paper")
        XCTAssertEqual(NameChat.plainTitle("Title: \"## Retry logic.\""), "Retry logic")
        XCTAssertEqual(NameChat.fallbackTitle(""), "New conversation")
        XCTAssertEqual(NameChat.capTitle(String(repeating: "word ", count: 20)), "word word word word word word word word word word word word")
        XCTAssertEqual(NameChat.namingStep(DEFAULTS, "openai").name, "Luna")
        XCTAssertEqual(NameChat.namingStep(DEFAULTS, "anthropic").effort, "low")
        let named = await ChatNamer(readModels: { DEFAULTS }, quickRun: nil)(text: "why do **runs** loop?", provider: "anthropic")
        XCTAssertEqual(named.title, "Why do runs loop?"); XCTAssertFalse(named.named); XCTAssertEqual(named.modelName, "Haiku")
        XCTAssertEqual(Making.cleanMaking("Line: \"a **diagram** of loops\""), "A diagram of loops.")
        XCTAssertEqual(Making.createdLine("An HTML page on loops."), "Created an HTML page on loops.")
        XCTAssertEqual(Making.createdLine("Creating a chart…"), "Created a chart.")
        XCTAssertEqual(Create.requestSentence("can you please make me a chart of visits?"), "A chart of visits.")
        XCTAssertEqual(Create.createdSentence("A chart.", "Done.", "x"), "A chart.")
        XCTAssertEqual(Create.encodeRel("a b/it's(1).md"), "a%20b/it%27s%281%29.md")
        XCTAssertThrowsError(try Create.createdFile("/p", "k", "../x"))
        XCTAssertThrowsError(try Create.createdFile("/p", "k", ".engelbart-saved.json"))
        // A real quick run, the CLI stubbed: Claude Code's json result.
        let root = tempDir("quick").path
        let quick = QuickRun(environment: ["SHELL": "/bin/zsh"], runDirectory: root, codexHome: root + "/ch", runner: StubRunner { _, _ in (["{\"type\":\"result\",\"is_error\":false,\"result\":\"Retry loops\"}"], nil) })
        let real = await ChatNamer(readModels: { DEFAULTS }, quickRun: quick)(text: "why do runs loop?", provider: "anthropic")
        XCTAssertEqual(real.title, "Retry loops"); XCTAssertTrue(real.named)
    }

    func testCatalogAndSweep() async throws {
        let store = TestStore(document: "doc")
        let notePath = store.project.dir + "/n.md"
        try String(repeating: "word ", count: 300).write(toFile: notePath, atomically: true, encoding: .utf8)
        let old = Time.iso(Date(timeIntervalSinceNow: -3600))
        let db = store.libraryDb as! MemoryDB
        db.rows = [LibraryRow(id: "n1", name: "Note", type: "md", tags: ["note"], path: notePath, lastEdited: old, projectId: "p1"),
                   LibraryRow(id: "x", name: "Elsewhere", type: "md", projectId: "p2")]
        let sweeper = Sweeper(getStore: { store }, summarize: Summarizer.fake)
        _ = await sweeper.sweep()
        let row = try await db.get("n1")!
        XCTAssertEqual(row.summary, "FAKE SUMMARY of Note (1500 characters).")
        XCTAssertEqual(row.charCount, 1500)
        let catalog = OJ.read(URL(fileURLWithPath: store.project.dir + "/.context/catalog.json"))!
        XCTAssertEqual(catalog["version"], 2)
        XCTAssertEqual(catalog["entries"]?.array?.map { $0["id"]!.string! }, ["n1"])
        XCTAssertEqual(catalog["entries"]?.array?.first?["path"], "n.md")
        XCTAssertEqual(catalog["entries"]?.array?.first?["summaryStale"], false)
        XCTAssertNotNil(OJ.read(URL(fileURLWithPath: store.dataRoot + "/.context/status.json"))?["summarized"])
        // Unchanged: not written again.
        let again = await sweeper.sweep()
        XCTAssertEqual(again?["catalogs"], [])
        XCTAssertEqual(Summarizer.fitSummary(String(repeating: "Sentence one is here. ", count: 60)).hasSuffix("here."), true)
        XCTAssertEqual(SummarizerSettings.normalize(j(#"{"provider":"Claude","anthropic":{"effort":"ultra"}}"#)), SummarizerSettings(provider: "anthropic", openai: Rung(model: "gpt-6-luna", effort: "high"), anthropic: Rung(model: "claude-opus-5-5", effort: "high")))
        XCTAssertEqual(Summarizer.buildRequest(name: "a<b>", text: "t", currentSummary: "s", systemPrompt: nil).input, "<file name=\"a b \">\nt\n</file>\n\n<current_summary>\ns\n</current_summary>")
    }

    func testContextBlocks() async throws {
        let store = TestStore(document: "Top\n@chat why?\nbart~> k1\n@chat other\nbart~> k9", rows: [LibraryRow(id: "r1", name: "Paper", type: "pdf", path: "/nowhere/p.pdf", summary: "An abstract.", summaryEdited: "2099-01-01T00:00:00.000Z")])
        let c = try await Context.build(store: store, projectId: "p1", ref: .workspace("w1"), workspaceId: "w1", askId: "k1")
        XCTAssertTrue(c.documents.contains("<workspace name=\"W\">\nTop\n@chat why?\n\(Context.here)\n@chat other\n</workspace>"), c.documents)
        XCTAssertTrue(c.documents.hasSuffix(Context.noStage))
        XCTAssertEqual(c.now, "\(Context.noStage)\n\n\(Context.noHighlights)")
        XCTAssertTrue(c.head.hasPrefix("<engelbart>\nproject: Proj\nproject description: A test project\ncode directory: none set\nnotes and workspaces: \(store.project.dir)\nasked from: the workspace \"W\"\nthis workspace's document: \(store.project.dir)/W/workspace.md"))
        XCTAssertTrue(c.contextJson.contains("\"name\": \"Paper\""))
        XCTAssertEqual(c.dirs, [store.dataRoot])
        XCTAssertEqual(Context.conversationBlock([Turn(question: "q", answer: "a", agent: "discover")], agent: "bart"), "<conversation>\n<turn n=\"1\" agent=\"Discover\">\n<asked>\nq\n</asked>\n<answered>\na\n</answered>\n</turn>\n</conversation>")
        XCTAssertEqual(Context.highlightBlock(InkedItem(name: "P", where_: "/p.pdf"), page: 3, quote: " q ", note: "n", pageText: ""), "<highlight paper=\"P\" path=\"/p.pdf\" page=\"3\">\n<quote>\nq\n</quote>\n<note>\nn\n</note>\n</highlight>")
    }

    func testAskInputAndIPC() async throws {
        let (pid, q) = try AskInput.request("p1", j(#"{"askId":"k1","ref":{"kind":"workspace","workspaceId":"w1"},"workspaceId":"w1","text":"q","turns":[{"question":"a","answer":"b","agent":"bart"}],"agent":"discover","steer":{"after":"k0","words":" more "}}"#))
        XCTAssertEqual(pid, "p1"); XCTAssertEqual(q.agent, "discover"); XCTAssertEqual(q.steer, Steer(after: "k0", words: "more"))
        XCTAssertThrowsError(try AskInput.request("p1", j(#"{"askId":"k 1","ref":{"kind":"workspace","workspaceId":"w1"},"workspaceId":"w1","text":"q"}"#))) { XCTAssertEqual(($0 as? IPCError)?.message, "ask id is invalid") }
        XCTAssertThrowsError(try AskInput.request("p1", j(#"{"askId":"k1","ref":{"kind":"mark","id":"m1","rowId":"r","page":2},"workspaceId":"w1","text":"q","agent":"discover"}"#))) { XCTAssertEqual(($0 as? IPCError)?.message, "a highlight asks @bart") }
        XCTAssertEqual(try AskInput.stage(j(#"{"kind":"web","url":" https://x.org ","title":"A\n title"}"#)), StageInput(kind: "web", url: "https://x.org", title: "A title"))
        XCTAssertNil(try AskInput.stage(j(#"{"kind":"html"}"#)))
        XCTAssertEqual(MarkAnswers.answerOf(["bart> One.", "bart>", "bart> *Sol · high · 3 s*"]).foot, "Sol · high · 3 s")
        // The IPC answers a failure with lines, and Stop with nothing to place.
        let store = TestStore(document: "@create\nbart~> c9")
        let ipc = BartIPC(bart: fakeBart(), store: store, readModels: { MODELS }, home: { tempDir("ipc") }, hub: EventHub())
        let failed = try await ipc.askBart(window: "w", pid: "p1", input: j(#"{"askId":"c9","ref":{"kind":"workspace","workspaceId":"w1"},"workspaceId":"w1","text":"","agent":"create"}"#))
        XCTAssertEqual(failed["lines"], ["bart> **No answer.** There is nothing on the line to make."])
        XCTAssertEqual(store.finished, ["c9"])
        let models = ipc.bartModels()
        XCTAssertEqual(models["provider"], "openai")
        XCTAssertEqual(models["discover"]?["providers"]?.keys, ["openai", "anthropic"])
        let named = try await ipc.nameChat(j(#"{"text":"why?","agent":"brainstorm"}"#))
        XCTAssertEqual(named["title"], "Why?")
        XCTAssertThrowsError(try ipc.rememberModelChoice("bart", nil))
    }

    func testSourceTextAndShots() async throws {
        let root = tempDir("st").path
        let db = MemoryDB([LibraryRow(id: "p1", name: "P", type: "pdf", path: "/x.pdf"), LibraryRow(id: "w1", name: "W", type: "website", url: "https://x.org/a")])
        try await db.setText("p1", text: "the pdf's text", modified: 1234.4)
        let texts = await SourceText.sourceTexts(dataRoot: root, db: db, rows: try await db.list())
        XCTAssertEqual(texts["p1"], root + "/assets/text/p1-1234.txt")
        XCTAssertEqual(try String(contentsOfFile: texts["p1"]!, encoding: .utf8), "the pdf's text")
        XCTAssertEqual(SourceText.openedKey("https://www.x.org/a/?utm_source=z#f"), "url:x.org/a")
        let opened = SourceText.openedBy([j(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"\#(texts["p1"]!)"}}]}}"#)], texts: [texts["p1"]!: "/x.pdf"])
        XCTAssertEqual(opened, ["file:/x.pdf"])
        let kept = await SourceText.keepPageTexts(db: db, rows: try await db.list(), opened: ["url:x.org/a"]) { _ in (200, "text/html", Data("<p>Hello <b>there</b></p>".utf8)) }
        XCTAssertEqual(kept, 1)
        let pageText = try await db.texts(for: ["w1"], max: 100)
        XCTAssertEqual(pageText["w1"], "Hello there")
        for n in 0..<22 { _ = Shots.save(root, id: "s\(n)", png: Data([1, 2, 3])) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root + "/bart-shots").count, 20)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root + "/bart-shots/s21.png"))
        XCTAssertNil(Shots.save(root, id: "bad id", png: Data([1])))
    }

    func testAgentShell() {
        XCTAssertEqual(AgentShell.loginShellArgs("/bin/zsh", "exec x", ["ENGELBART_GIT_BIN": "/g", "ENGELBART_AGENT_PATH": "/a"]), ["-ilc", "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; PATH=\"$PATH:$ENGELBART_AGENT_PATH\"; exec x"])
        XCTAssertEqual(AgentShell.loginShellArgs("/opt/homebrew/bin/fish", "exec x", [:]), ["--login", "--interactive", "--command", "exec x"])
        let env = AgentShell.childEnvironment(["ANTHROPIC_API_KEY": "k", "CLAUDE_CODE_SESSION_ID": "s", "ELECTRON_RUN_AS_NODE": "1", "PATH": "/bin", "NODE_OPTIONS": "--inspect"], tools: nil, ["X": "1"])
        XCTAssertEqual(env["PATH"], "/bin"); XCTAssertEqual(env["X"], "1"); XCTAssertEqual(env["TERM_PROGRAM"], "Engelbart")
        XCTAssertNil(env["ANTHROPIC_API_KEY"]); XCTAssertNil(env["CLAUDE_CODE_SESSION_ID"]); XCTAssertNil(env["ELECTRON_RUN_AS_NODE"]); XCTAssertNil(env["NODE_OPTIONS"])
        XCTAssertEqual(lastResultLine("x\n{\"type\":\"result\",\"result\":\"a\"}\n{\"type\":\"other\"}")?["result"], "a")
        let home = tempDir("codexhome").path
        XCTAssertFalse(prepareCodexHome(codexHome: home + "/h", source: home + "/missing.json", instructions: "I"))
        try? #"{"auth_mode":"apikey"}"#.write(toFile: home + "/a.json", atomically: true, encoding: .utf8)
        XCTAssertFalse(prepareCodexHome(codexHome: home + "/h", source: home + "/a.json", instructions: "I"))
        AskPlan.writeCodexConfig(home, servers: [("papers", "/E", ["--mcp", "papers"], [("OPENALEX_API_KEY", "k")])])
        XCTAssertEqual(try? String(contentsOfFile: home + "/config.toml", encoding: .utf8), "# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.\ncli_auth_credentials_store = \"file\"\n\n[mcp_servers.papers]\ncommand = \"/E\"\nargs = [\"--mcp\", \"papers\"]\nenv = { OPENALEX_API_KEY = \"k\" }\nstartup_timeout_sec = 30\ntool_timeout_sec = 90\n")
    }

    func testTraceLines() {
        let trace = Trace(entries: [CatalogEntryView(name: "Tutoring at scale with feedback", type: "pdf")])
        func use(_ id: String, _ name: String, _ input: String) -> JSONValue { j(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"\#(id)","name":"mcp__papers__\#(name)","input":\#(input)}]}}"#) }
        func back(_ id: String, _ value: String) -> JSONValue { (["type": "user", "message": ["content": [["type": "tool_result", "tool_use_id": .string(id), "content": .string(value)]]]] as OJ).jsonValue }
        _ = trace.take(use("1", "resolve", #"{"query":"Tutoring at scale"}"#))
        let s1 = trace.take(back("1", #"{"found":true,"paper":{"id":"W1","title":"Tutoring at scale with feedback"}}"#))!
        XCTAssertEqual(s1["groups"]?[0]?["lines"]?[0]?["text"], "Found “Tutoring at scale with feedback” in your library")
        _ = trace.take(use("2", "references", #"{"id":"W1"}"#))
        _ = trace.take(back("2", #"{"of":{"id":"W1","title":"Tutoring at scale with feedback"},"total":0,"results":[]}"#))
        _ = trace.take(use("3", "resolve", #"{"query":"A"}"#))
        let s = trace.take(use("4", "resolve", #"{"query":"B"}"#))!
        let cites = s["groups"]!.array!.first { $0["key"] == "cites" }!["lines"]!.array!.map { $0["text"]!.string! }
        XCTAssertEqual(cites, ["“Tutoring at scale with feedback” cites no paper OpenAlex knows", "Checking whether “A” and “B” fit"])
        XCTAssertEqual(s["latest"], "cites"); XCTAssertEqual(s["now"], "Checking whether “A” and “B” fit")
        XCTAssertEqual(TraceText.named("SWE-agent: Agent-computer interfaces"), "“SWE-agent”")
    }
}

final class ProgressBox: @unchecked Sendable {
    private var items: [BartProgress] = []
    private let lock = NSLock()
    func add(_ p: BartProgress) { lock.withLock { items.append(p) } }
    var all: [BartProgress] { lock.withLock { items } }
}

/// sha256 of JSON.stringify(["p","workspace","w",[["q","a"]]]) as Node computes it.
let THREAD_KEY_P_W_QA = "33d0e4225522171e40bf4a9a1eb3a15beaf474f0e818da497e8201ab27fef60f"
