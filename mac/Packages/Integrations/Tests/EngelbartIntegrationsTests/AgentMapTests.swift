import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/agent-viewer.test.cjs and test/agent-map.test.cjs (the asks, the run text, the export) and
// test/chat-benchmark.test.cjs (runs, notes, replays), against fake run logs and a fake benchmark source.

private func PLACE(_ line: Int, _ text: String) -> JSONValue { ["projectId": "p", "ref": ["kind": "workspace", "workspaceId": "w"], "line": .number(Double(line)), "text": .string(text)] }
private let PANEL: JSONValue = ["projectId": "p", "ref": ["kind": "workspace", "workspaceId": "w"]]

private let RECORDS: [JSONValue] = [
    ["id": "route-1", "agent": "router", "at": 100, "status": "done", "question": "why is the sky blue?", "pick": "chat", "place": PLACE(3, "@bart why is the sky blue?")],
    ["id": "a-1", "agent": "bart", "at": 101, "status": "done", "question": "why is the sky blue?", "routedFrom": "route-1", "place": PLACE(3, "@bart why is the sky blue?")],
    ["id": "route-2", "agent": "router", "at": 200, "status": "done", "question": "build a parser", "pick": "build", "handedTo": "build:b2", "place": PLACE(9, "@bart build a parser")],
    ["id": "b2:1", "agent": "build", "buildId": "b2", "turn": 1, "at": 201, "status": "done", "title": "Parser", "place": PLACE(9, "@bart build a parser")],
    ["id": "b2:run:1", "agent": "run step", "buildId": "b2", "turn": 1, "at": 202, "status": "done"],
    ["id": "b2:2", "agent": "build", "buildId": "b2", "turn": 2, "at": 203, "status": "running"],
    ["id": "a-3", "agent": "discover", "at": 300, "status": "done", "question": "papers on X", "place": PLACE(12, "@discover papers on X")],
    ["id": "b4:1", "agent": "build", "buildId": "b4", "turn": 1, "at": 400, "status": "done", "title": "Thing", "place": PLACE(20, "make the thing")],
    ["id": "b5:1", "agent": "build", "buildId": "b5", "turn": 1, "at": 500, "status": "done", "title": "From the panel", "place": PANEL],
    ["id": "a-6", "agent": "bart", "at": 600, "status": "done", "question": "and at sunset?", "place": PLACE(5, "@chat and at sunset?")],
    ["id": "a-7", "agent": "create", "at": 700, "status": "done", "question": "a figure", "place": PLACE(30, "@create a figure")],
    ["id": "a-8", "agent": "mystery", "at": 800, "status": "failed", "question": "who?"],
    ["id": "b9:1", "agent": "build", "buildId": "b9", "kind": "quick", "turn": 1, "at": 900, "status": "done", "title": "fix the typo", "place": PANEL],
]

final class FakeRunLog: AgentRunLog {
    var records: [JSONValue]
    init(_ records: [JSONValue]) { self.records = records }
    func list() -> [JSONValue] { records }
    func get(_ id: String) -> JSONValue? { records.first { $0["id"]?.string == id } }
}

private func whole(_ id: String, _ records: [JSONValue]) -> JSONValue {
    AgentAsks.group(records).first { $0.id == id }!.json.with("records", .array(records))
}
private func step(_ output: String) -> JSONValue { ["model": "claude-sonnet-5-5", "name": "Sonnet", "effort": "high", "input": "IN", "output": .string(output), "tools": []] }

final class AgentAsksTests: XCTestCase {
    func testOneEntryPerAskNewestFirstNoRecordLeftOut() {
        let asks = AgentAsks.group(RECORDS)
        XCTAssertEqual(asks.map(\.id), ["build:b9", "a-8", "a-7", "a-6", "build:b5", "build:b4", "a-3", "route-2", "route-1"])
        let claimed = asks.flatMap(\.records)
        XCTAssertEqual(claimed.sorted(), RECORDS.map { $0["id"]!.string! }.sorted())
        XCTAssertEqual(Set(claimed).count, claimed.count)
    }

    func testRoutedAndBuildAndDirectEntries() {
        let by = Dictionary(uniqueKeysWithValues: AgentAsks.group(RECORDS).map { ($0.id, $0) })
        let r1 = by["route-1"]!
        XCTAssertEqual([r1.records, [r1.routedTo, r1.via, r1.kind, r1.text]], [["route-1", "a-1"], ["chat", "router", "question", "@bart why is the sky blue?"]])
        XCTAssertEqual(r1.place?["line"], 3)
        let r2 = by["route-2"]!
        XCTAssertEqual(r2.records, ["route-2", "b2:1", "b2:run:1", "b2:2"])
        XCTAssertEqual([r2.routedTo, r2.kind, r2.buildId, r2.status], ["build", "build", "b2", "running"])
        XCTAssertEqual([by["a-3"]!.routedTo, by["a-3"]!.via, by["a-3"]!.text], ["discover", "direct", "@discover papers on X"])
        XCTAssertEqual([by["build:b4"]!.via, by["build:b4"]!.text, by["build:b4"]!.kind], ["button", "make the thing", "build"])
        XCTAssertEqual([by["build:b5"]!.via, by["build:b5"]!.text], ["panel", "From the panel"])
        XCTAssertNil(by["build:b5"]!.place?["line"])
        XCTAssertEqual([by["build:b9"]!.via, by["build:b9"]!.text], ["post-it", "fix the typo"])
        XCTAssertEqual(by["a-6"]!.records, ["a-6"])
        XCTAssertEqual([by["a-7"]!.routedTo, by["a-7"]!.kind], ["create", "question"])
        XCTAssertEqual([by["a-8"]!.routedTo, by["a-8"]!.status, by["a-8"]!.text], ["mystery", "failed", "who?"])
        XCTAssertNil(by["a-8"]!.place)
        let built = AgentAsks.group([["id": "b:1", "agent": "build", "buildId": "b", "turn": 1, "at": 1, "status": "done", "place": PLACE(0, "make it --build")]])
        XCTAssertEqual(built[0].via, "--build")
    }

    func testAskOfAndPromptSource() {
        let log = FakeRunLog(Array(RECORDS.prefix(2)).map { $0.with("system", "BUILT IN") })
        let ask = AgentAsks.askOf(log, "route-1", builtInPrompt: { $0["agent"]?.string == "bart" ? "BUILT IN" : "other" })!
        XCTAssertEqual(ask["records"]!.array!.map { $0["agent"]!.string! }, ["router", "bart"])
        XCTAssertEqual(ask["records"]!.array!.map { $0["promptSource"]!.string! }, ["custom", "built-in"])
        XCTAssertNil(AgentAsks.askOf(log, "nope"))
    }

    func testRevealTarget() {
        let target = AgentAsks.revealTarget(["place": ["projectId": "p", "ref": ["kind": "note", "id": "n1", "extra": "x"], "line": 7, "text": "@bart hi"], "routedTo": "chat", "buildId": nil])
        XCTAssertEqual(target, ["place": ["projectId": "p", "ref": ["kind": "note", "id": "n1"], "line": 7, "text": "@bart hi", "quote": nil], "routedTo": "chat", "buildId": nil])
        XCTAssertNil(AgentAsks.revealTarget(["place": ["ref": ["kind": "note", "id": "n1"]]]))
        XCTAssertNil(AgentAsks.revealTarget("p"))
        XCTAssertEqual(AgentAsks.revealTarget(["place": ["projectId": "p", "ref": ["kind": "shell"], "line": -2]])?["place"], ["projectId": "p", "ref": nil, "line": nil, "text": nil, "quote": nil])
    }
}

final class RunTextTests: XCTestCase {
    func testAskSectionsDirectBrainstormDiscoverBuild() {
        let chat = RunText.askSections(whole("a-6", [RECORDS[9].with("steps", [step("ok")])]))
        XCTAssertEqual(chat.map(\.title), ["1 Input", "2 Bart (classifier)", "3 Chat input", "4 Chat output"])
        XCTAssertEqual(chat[1].nodes[0].label, "Typed directly (@chat)")
        let card = "```json\n{\"say\":\"Pick one\",\"card\":\"questions\",\"questions\":{\"title\":\"Next\",\"items\":[{\"title\":\"What matters?\",\"type\":\"open\"}]}}\n```"
        let brainstorm = RunText.askSections(whole("a-b", [["id": "a-b", "agent": "brainstorm", "at": 1, "status": "done", "question": "hm", "steps": [step(card)], "written": [.string(card)]]]))
        XCTAssertEqual(brainstorm[3].title, "4 Brainstorm output")
        XCTAssertTrue(re("card: questions[\\s\\S]*What matters\\? \\(open\\)").test(RunText.nodesText(brainstorm[3].nodes)))
        let discover = RunText.askSections(whole("a-3", [RECORDS[6].with("steps", [step("three papers")])]))
        XCTAssertEqual([discover[1].nodes[0].label, discover[2].title], ["Typed directly (@discover)", "3 Discover input"])
        let build = RunText.askSections(whole("route-2", RECORDS[2...5].map { r in
            var x = r.with("steps", [step("done")])
            if r["agent"]?.string == "run step" { x = x.with("written", [["name": "tests", "status": "passed", "passed": true]]) }
            return x
        }))
        XCTAssertEqual(build.map(\.title).suffix(2), ["3 Build input", "4 Build output"])
        XCTAssertEqual(build[1].nodes[0].label, "Picked Build")
        XCTAssertTrue(re("turn 1[\\s\\S]*turn 2[\\s\\S]*Run step \\(after turn 1\\)[\\s\\S]*tests: passed").test(RunText.nodesText(build[3].nodes)))
        XCTAssertEqual(RunText.askSections(whole("build:b5", [RECORDS[8].with("steps", [])]))[1].nodes[0].label, "Typed directly (Build panel)")
        XCTAssertEqual(RunText.askSections(whole("a-8", [RECORDS[11].with("steps", [])]))[3].title, "4 mystery output")
    }

    func testExportAskIsOneSelfContainedPage() {
        let html = RunText.exportAsk(whole("a-3", [RECORDS[6].with("steps", [step("</script><b>three</b>")])]))
        XCTAssertTrue(html.hasPrefix("<!doctype html>"))
        XCTAssertTrue(html.contains("<title>Agent Viewer · @discover papers on X</title>"))
        XCTAssertTrue(re("1 Input[\\s\\S]*4 Discover output").test(html))
        XCTAssertFalse(html.contains("<script src") || html.contains("<link "))
        XCTAssertEqual(html.components(separatedBy: "</script>").count - 1, 1)
        let page = RunText.exportPage([["id": "x", "agent": "bart", "at": 0, "status": "done", "question": "q", "system": "", "context": [:], "steps": [], "written": []]])
        XCTAssertTrue(page.contains("Exported from Engelbart's Agent Viewer"))
        XCTAssertFalse(page.contains("Agent map"))
    }

    func testRowsListedRunsTurnLabels() {
        let W: [String: JSONValue] = ["projectId": "p1", "workspaceName": "Concision in Agent Responses"]
        func r(_ o: JSONValue) -> JSONValue { var x = o; for (k, v) in W { x = x.with(k, v) }; return x }
        let runs = [
            r(["id": "rt-1", "agent": "router", "at": 5, "status": "done", "by": "model", "sure": 0.85, "pick": "chat", "question": "why is the sky blue?", "projectName": ""]),
            r(["id": "ch-1", "agent": "bart", "at": 4, "status": "done", "question": "why is the sky blue?", "routedFrom": "rt-1", "reply": 0, "projectName": "Engelbart"]),
            r(["id": "rt-2", "agent": "router", "at": 3, "status": "done", "by": "rule", "rule": "--build", "pick": "build", "handedTo": "build:9f3e2a1b7c", "question": "make the list readable", "projectName": ""]),
            r(["id": "9f3e2a1b7c:1", "agent": "build", "at": 2, "status": "done", "buildId": "9f3e2a1b7c", "turn": 1, "title": "Make the list readable", "projectName": "Engelbart"]),
            r(["id": "rs-1", "agent": "run step", "at": 1, "status": "done", "buildId": "9f3e2a1b7c", "title": "Make the list readable", "projectName": "Engelbart"]),
        ]
        XCTAssertEqual(RunText.listedRuns(runs).map { $0["id"]!.string! }, ["ch-1", "9f3e2a1b7c:1", "rs-1"])
        XCTAssertEqual(RunText.rowLine(runs[1]), "Chat · \(RunText.timeLabel(4)) · first message")
        XCTAssertEqual(RunText.rowLine(runs[3]), "Build · turn 1 · \(RunText.timeLabel(2)) · first message")
        XCTAssertEqual(RunText.rowLine(runs[4]), "Build · run step · \(RunText.timeLabel(1))")
        XCTAssertEqual(RunText.placeLabel(runs[0], RunText.projectNames(runs)), "Engelbart / Concision in Agent Responses")
        XCTAssertTrue(RunText.rowLine(runs[2].with("status", "failed")).hasPrefix("Bart couldn't route this · "))
        XCTAssertEqual(RunText.turnLabel(["agent": "bart", "reply": 2]), "reply 3")
        XCTAssertEqual(RunText.turnLabel(["agent": "router", "current": "chat"]), "reply")
        XCTAssertEqual(RunText.turnLabel(["agent": "build", "turn": 2]), "reply")
        XCTAssertEqual(RunText.turnLabel(["agent": "run step", "turn": 1]), "")
        XCTAssertEqual(RunText.rowLine(["agent": "bart", "reply": 2, "status": "done", "model": "opus", "effort": "high"]), "Chat · reply 3")
        XCTAssertTrue(RunText.rowLine(["agent": "bart", "reply": 0, "status": "done", "stepCount": 2]).hasPrefix("Chat · first message · escalated"))
        XCTAssertEqual(RunText.runLabel(["agent": "run step", "title": "a parser"]), "Build · run step a parser")
        XCTAssertEqual(RunText.modelLabel(["model": "opus", "effort": "high"]), "opus · high")
        XCTAssertFalse(RunText.rowLine(["agent": "router", "by": "model", "sure": 0.9, "pick": "chat", "status": "done", "model": "claude-haiku-5-5"]).contains("claude"))
    }

    func testFiltersAndDays() {
        let day = { (d: Int, h: Int) -> Double in Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: d, hour: h))!.timeIntervalSince1970 * 1000 }
        let now = day(13, 18)
        let runs: [JSONValue] = [
            ["id": "r1", "agent": "router", "by": "model", "at": .number(day(13, 12)), "status": "done", "question": "q", "projectId": "p1", "workspaceName": "oct-12"],
            ["id": "c1", "agent": "bart", "at": .number(day(13, 11)), "status": "done", "question": "q", "projectId": "p1", "projectName": "Engelbart", "workspaceName": "oct-12"],
            ["id": "c2", "agent": "bart", "at": .number(day(12, 9)), "status": "done", "question": "q", "projectId": "p1", "projectName": "Engelbart", "workspaceName": "Concision in Agent Responses"],
            ["id": "d1", "agent": "discover", "at": .number(day(11, 20)), "status": "done", "question": "q", "projectId": "p2", "projectName": "Papers", "workspaceName": "oct-12"],
            ["id": "n1", "agent": "bart", "at": .number(day(11, 8)), "status": "done", "question": "q"],
        ]
        let ids = { (f: RunFilter) in RunText.filterRuns(runs, f).map { $0["id"]!.string! } }
        XCTAssertEqual(ids(.all), ["r1", "c1", "c2", "d1", "n1"])
        XCTAssertEqual(ids(RunFilter(project: "Engelbart")), ["r1", "c1", "c2"])
        XCTAssertEqual(ids(RunFilter(project: "Engelbart", workspace: "oct-12")), ["r1", "c1"])
        XCTAssertEqual(ids(RunFilter(workspace: "oct-12")), ["r1", "c1", "d1"])
        XCTAssertEqual(ids(RunFilter(day: RunText.dayKey(day(11, 0)))), ["d1", "n1"])
        let options = RunText.filterOptions(runs, now: now)
        XCTAssertEqual(options.projects, ["Engelbart", "Papers"])
        XCTAssertEqual(options.workspaces, ["Concision in Agent Responses", "oct-12"])
        XCTAssertEqual(options.days.map(\.label), ["Today", "Yesterday", "Oct 11"])
        XCTAssertEqual(RunText.filterOptions(runs, RunFilter(project: "Papers"), now: now).workspaces, ["oct-12"])
        XCTAssertEqual(RunText.dayLabel("2025-10-11", now: now), "Oct 11, 2025")
    }

    func testSectionTextAndCreatedLines() {
        let record: JSONValue = ["id": "c1", "agent": "create", "system": "SYS", "context": ["head": "<engelbart>"], "steps": [["name": "Opus", "model": "opus", "effort": "high", "input": "IN",
            "tools": [["name": "Read", "input": ["file_path": "/a"], "result": ["size": 3, "excerpt": "abc"]]], "output": "OUT"]],
            "written": ["create> made it"], "created": [["name": "Results chart", "type": "html", "path": "assets/files/chart.html"]], "skipped": ["too big"]]
        XCTAssertEqual(RunText.createdLines(record), "Results chart · html · assets/files/chart.html\nskipped: too big")
        XCTAssertEqual(RunText.sectionText(record, "system"), "SYS")
        XCTAssertTrue(RunText.sectionText(record, "context").hasPrefix("===== <engelbart> ("))
        XCTAssertTrue(RunText.sectionText(record, "steps").contains("--- tool: Read ---\n{\n  \"file_path\": \"/a\"\n}\n--- result (3 chars) ---\nabc"))
        XCTAssertEqual(RunText.toolArg(["name": "Grep", "input": ["pattern": "foo", "path": "src"]]).text, "foo in src")
        XCTAssertTrue(RunText.toolArg(["name": "Bash", "input": ["command": "ls -la"]]).command)
        XCTAssertEqual(RunText.msLabel(1500), "1.5 s")
        XCTAssertEqual(RunText.msLabel(61000), "1 m 1 s")
        XCTAssertEqual(RunText.sizeLabel("abcd"), "4 chars · ~1 tok")
    }
}

// MARK: benchmark

final class FakeBenchmarkSource: BenchmarkSource, @unchecked Sendable {
    let agentNames: [(id: String, name: String)] = [("bart", "Chat"), ("brainstorm", "Brainstorm"), ("discover", "Discover"), ("create", "Create")]
    let dataRoot: String
    let projectDir: String
    var asked: [BenchmarkJob] = []
    var answer: (BenchmarkJob) async throws -> String = { "new answer to \($0.question)" }
    var prompt = "PROMPT"

    init(root: String) {
        dataRoot = root
        projectDir = join(root, "proj")
        FileOps.mkdir(join(projectDir, "plan"))
    }

    func projects() -> [(id: String, name: String, dir: String)] { [("p1", "Project", projectDir)] }
    func workspaces(projectDir: String) -> [(id: String, path: String, context: [String])] { [("w1", "plan", [])] }
    func libraryRows() async -> [(id: String, path: String)] { [] }
    func notesMadeIn(projectDir: String) async -> [String: String] { [:] }
    /// A small reading of the editor's threads: a `@chat q` line, then `bart> ` answer lines, the last a closing line.
    func threads(_ lines: [String]) -> [[BenchmarkTurn]] {
        var thread: [BenchmarkTurn] = []
        var i = 0
        while i < lines.count {
            if lines[i].hasPrefix("@") {
                let q = i
                let question = String(lines[i].drop(while: { $0 != " " }).dropFirst())
                var answer: [String] = []
                i += 1
                while i < lines.count, lines[i].hasPrefix("bart> ") { answer.append(String(lines[i].dropFirst(6))); i += 1 }
                let foot = answer.last.flatMap { $0.hasPrefix("*") ? $0 : nil }
                thread.append(BenchmarkTurn(question: question, answer: answer.joined(separator: "\n"), foot: foot, q: q))
            } else { i += 1 }
        }
        return [thread]
    }
    func systemPrompt(agent: String) -> String { prompt }
    func message(group: BenchmarkGroup, entry: BenchmarkEntry) async throws -> String { "MESSAGE for \(entry.question)" }
    func ask(_ job: BenchmarkJob) async throws -> String { asked.append(job); return try await answer(job) }
}

@MainActor
final class ChatBenchmarkTests: XCTestCase {
    private func note(_ src: FakeBenchmarkSource) throws {
        try "# Plan\n@chat why is the sky blue?\nbart> *Chat · Opus · high · 41 s*\n@chat and at sunset?\nbart> Red.\nbart> *Chat · Sonnet · low · 3 s*\n@brainstorm ideas\nbart> One idea.\nbart> *Brainstorm · 8 s*\n"
            .write(toFile: join(src.projectDir, "plan", "workspace.md"), atomically: true, encoding: .utf8)
    }

    func testQuestionsRunNotesRunsAndAgents() async throws {
        let root = tempDir("bench")
        let src = FakeBenchmarkSource(root: root)
        try note(src)
        let file = join(tempDir("bench-user"), "chat-benchmark.json")
        let bench = ChatBenchmark(file: file, source: src, now: { "2026-10-14T12:00:00.000Z" })
        let list = await bench.list()
        let entries = list["groups"]![0]!["entries"]!.array!
        XCTAssertEqual(entries.map { $0["question"]!.string! }, ["why is the sky blue?", "and at sunset?"])
        XCTAssertEqual(entries[1]["old"], "Red.")
        XCTAssertEqual(entries[0]["key"], "proj/plan/workspace.md\nwhy is the sky blue?")
        XCTAssertEqual(list["live"], true)
        XCTAssertEqual(list["agents"]!.array!.map { $0["name"]!.string! }, ["Chat", "Brainstorm", "Discover", "Create"])
        var changes: [JSONValue] = []
        bench.subscribe { changes.append($0) }
        await bench.run()
        await bench.idle()
        let after = await bench.list()
        XCTAssertEqual(after["groups"]![0]!["entries"]!.array!.map { $0["new"]!["answer"]!.string! }, ["new answer to why is the sky blue?", "new answer to and at sunset?"])
        XCTAssertEqual(src.asked.map(\.message), ["MESSAGE for why is the sky blue?", "MESSAGE for and at sunset?"])
        XCTAssertEqual(src.asked[1].turns.map(\.question), ["why is the sky blue?"])
        XCTAssertTrue(changes.contains { $0["new"]?["running"] == true })
        let saved = readJSONFile(file)
        XCTAssertEqual(saved["runs"]![0]!["entries"]!["proj/plan/workspace.md\nwhy is the sky blue?"]!["promptHash"]?.string, BenchmarkText.hashOf("PROMPT"))
        XCTAssertTrue(bench.setNote("proj/plan/workspace.md\nwhy is the sky blue?", "better"))
        let reread = ChatBenchmark(file: file, source: src)
        let rereadList = await reread.list()
        XCTAssertEqual(rereadList["groups"]![0]!["entries"]![0]!["note"], "better", "a note survives reloading")
        // A new run starts empty and is the one asked into; the earlier one is kept as it was.
        let id = bench.newRun()
        XCTAssertEqual(id, "run-2")
        let fresh = await bench.list()
        XCTAssertEqual(fresh["groups"]![0]!["entries"]![0]!["new"], .object([:]))
        let earlier = await bench.list("run-1")
        XCTAssertEqual(earlier["live"], false)
        let ranOld = await bench.run("run-1")
        XCTAssertFalse(ranOld, "only the newest run is asked into")
        // Another agent's questions, kept apart and remembered.
        let brainstorm = await bench.list(nil, agent: "brainstorm")
        XCTAssertEqual(brainstorm["agent"], "brainstorm")
        XCTAssertEqual(brainstorm["groups"]![0]!["entries"]![0]!["key"], "brainstorm\nproj/plan/workspace.md\nideas")
        XCTAssertEqual(ChatBenchmark(file: file, source: src).load()["agent"], "brainstorm")
    }

    func testFailureShownStopStopsAndOldFileIsRun1() async throws {
        let src = FakeBenchmarkSource(root: tempDir("bench2"))
        try note(src)
        src.answer = { job in
            if job.question.contains("sunset") { throw BenchmarkError(message: "the model timed out") }
            try await Task.sleep(nanoseconds: 50_000_000)
            return "ok"
        }
        let file = join(tempDir("bench2-user"), "chat-benchmark.json")
        try "{\"entries\":{\"x\":{\"answer\":\"a\",\"at\":\"2026-10-13T09:00:00.000Z\"}}}".write(toFile: file, atomically: true, encoding: .utf8)
        let bench = ChatBenchmark(file: file, source: src)
        let first = await bench.list()
        XCTAssertEqual(first["runs"], [["id": "run-1", "name": "Run 1", "at": "2026-10-13T09:00:00.000Z"]])
        await bench.run()
        await bench.idle()
        let after = await bench.list()
        XCTAssertEqual(after["groups"]![0]!["entries"]![1]!["new"], ["error": "the model timed out"])
        src.answer = { _ in try await Task.sleep(nanoseconds: 5_000_000_000); return "late" }
        await bench.runOne("proj/plan/workspace.md\nwhy is the sky blue?")
        await settle(50)
        bench.stop()
        await bench.idle()
        let stopped = await bench.list()
        XCTAssertEqual(stopped["groups"]![0]!["entries"]![0]!["new"], ["answer": "ok"], "a stopped replay keeps nothing new")
    }

    func testHelpers() {
        XCTAssertEqual(BenchmarkText.footChoice("*Chat · Opus · high · 41 s*")?.name, "Opus")
        XCTAssertEqual(BenchmarkText.footChoice("*Chat · Opus · high · 41 s*")?.effort, "high")
        XCTAssertNil(BenchmarkText.footChoice("*Brainstorm · 8 s*"))
        let choice = BenchmarkText.choiceOf("*Chat · Opus · high · 41 s*", models: [(models: [("opus", "Opus")], efforts: ["low", "high"])])
        XCTAssertEqual(choice?.model, "opus"); XCTAssertEqual(choice?.effort, "high")
        XCTAssertEqual(BenchmarkText.withoutFeet("answer\n*Chat · old*\n\n*Chat · new*"), "answer")
        let log = FakeRunLog([["id": "r", "agent": "bart", "question": " why? ", "steps": [["input": "HEAD\n<context_json>x</context_json>\n\n<level>L"]]]])
        XCTAssertEqual(BenchmarkText.recordedMessage(log, question: "why?"), "HEAD\n<context_json>x</context_json>")
        XCTAssertNil(BenchmarkText.recordedMessage(log, question: "other"))
    }
}
