import AppKit
import Foundation
import SwiftUI
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/connections-ui.test.cjs (the rows' words and buttons), test/chat-benchmark.test.cjs (applyChange, the export page),
// test/agent-viewer.test.cjs (keys, selection following the filters), test/agent-map.test.cjs (design, the window, the
// export name), and the trace window's save.

@MainActor
final class ConnectionRowTests: XCTestCase {
    func testGithubRowWordsAndButtons() {
        var d = GithubConnectionRow.describe(nil, busy: nil, error: "")
        XCTAssertEqual(d.description, "Checking connection…"); XCTAssertTrue(d.disabled)
        d = GithubConnectionRow.describe(GithubStatus(configured: true), busy: nil, error: "")
        XCTAssertEqual([d.description, d.action, d.label], ["Not connected", "connect", "Connect"]); XCTAssertFalse(d.disabled)
        d = GithubConnectionRow.describe(GithubStatus(configured: true, error: "GitHub no longer accepts the sign-in. Sign in again."), busy: nil, error: "")
        XCTAssertEqual(d.label, "Reconnect"); XCTAssertEqual(d.problem, "GitHub no longer accepts the sign-in. Sign in again.")
        d = GithubConnectionRow.describe(GithubStatus(configured: false), busy: nil, error: "")
        XCTAssertEqual(d.description, "Not configured"); XCTAssertTrue(d.disabled)
        let pending = GithubStatus(configured: true, pending: GithubPending(kind: "browser", userCode: nil, verificationUri: "https://x", expiresAt: 1))
        d = GithubConnectionRow.describe(pending, busy: nil, error: "")
        XCTAssertEqual([d.description, d.action], ["Waiting for sign-in…", "cancel"]); XCTAssertTrue(d.connecting)
        d = GithubConnectionRow.describe(GithubStatus(configured: true, connected: true, login: "hudsonmp"), busy: nil, error: "")
        XCTAssertEqual(d.description, "Connected · @hudsonmp")
        d = GithubConnectionRow.describe(GithubStatus(configured: true, connected: true, login: "hudsonmp"), busy: "disconnect", error: "")
        XCTAssertEqual(d.description, "Disconnecting…")
        d = GithubConnectionRow.describe(GithubStatus(configured: true), busy: "connect", error: "")
        XCTAssertTrue(d.disabled, "busy: no duplicate action")
    }

    func testZoteroRowWords() {
        XCTAssertEqual(ZoteroConnectionRow.describe(nil, busy: nil).description, "Checking connection…")
        XCTAssertEqual(ZoteroConnectionRow.describe(ZoteroStatus(configured: true), busy: nil).description, "Not connected")
        XCTAssertEqual(ZoteroConnectionRow.describe(ZoteroStatus(configured: true), busy: "connect").description, "Connecting…")
        let waiting = ZoteroConnectionRow.describe(ZoteroStatus(configured: true, pending: ZoteroPending(kind: "browser", expiresAt: 1)), busy: nil)
        XCTAssertEqual(waiting.description, "Finish signing in in your browser"); XCTAssertTrue(waiting.spinning)
        XCTAssertEqual(ZoteroConnectionRow.describe(ZoteroStatus(configured: true, connected: true, username: "researcher"), busy: nil).description, "Connected · researcher")
        XCTAssertEqual(ZoteroConnectionRow.describe(ZoteroStatus(configured: false), busy: nil).description, "Not configured")
        XCTAssertEqual(ZoteroChips.syncLine(ZoteroSyncStatus(state: "syncing"))?.text, "Syncing…")
        XCTAssertEqual(ZoteroChips.syncLine(ZoteroSyncStatus(state: "error", error: "Zotero refused the key."))?.error, true)
        XCTAssertEqual(ZoteroChips.syncLine(ZoteroSyncStatus(state: "synced", items: 1)), ZoteroSyncLine(text: "Synced · 1 item", busy: false, error: false, groups: ""))
        let many = ZoteroChips.syncLine(ZoteroSyncStatus(state: "synced", items: 3, groups: 4, problems: [.init(name: "A", error: "x"), .init(name: "B", error: ""), .init(name: "C", error: "z"), .init(name: "D", error: "w")]))
        XCTAssertEqual(many?.groups, "A: x B: could not be synced. And 2 more groups could not be synced.")
        XCTAssertNil(ZoteroChips.syncLine(nil))
    }

    func testConnectionsModelActsThroughTheChannels() async throws {
        let opened = Box<[String]>([])
        let (http, _) = fakeHTTP { call in
            call.url.hasSuffix("/device/code") ? reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 5]) : reply(200, ["error": "authorization_pending"])
        }
        let hub = EventHub()
        let github = GithubConnection(http: http, settings: { .init(clientId: "x", appSlug: "app") }, file: { nil }, onChange: { hub.post("engelbart:github", $0.json) }, sleep: { _ in try await Task.sleep(nanoseconds: 1_000_000_000) })
        let model = ConnectionsModel(github: GithubChannels(github: github, openPage: { opened.value.append($0) }), zotero: nil, copyText: { opened.value.append("copied \($0)") }, hub: hub)
        model.act(github: "connect")
        await until { model.github?.pending != nil && model.githubBusy == nil }
        model.act(github: "copy")
        await until { model.githubBusy == nil && opened.value.contains("copied AAAA-BBBB") }
        model.act(github: "manage")
        await until { model.githubBusy == nil && opened.value.contains("https://github.com/apps/app/installations/new") }
        model.act(github: "cancel")
        await until { model.github?.pending == nil }
        model.act(zotero: "sync")
        XCTAssertNil(model.zoteroBusy, "no Zotero: nothing to do")
    }
}

@MainActor
final class BenchmarkPageTests: XCTestCase {
    private let data: JSONValue = ["running": false, "agents": [["id": "bart", "name": "Chat"], ["id": "brainstorm", "name": "Brainstorm"]], "agent": "bart",
                                   "runs": [["id": "run-1", "name": "Run 1", "at": "2026-10-14T15:02:00.000Z"]], "current": "run-1", "live": true,
                                   "groups": [["name": "plan", "rel": "p/plan/workspace.md", "entries": [
                                       ["key": "k1", "question": "why <blue>?", "old": "# Because\n- light", "new": ["answer": "scattering"], "note": "kept"],
                                       ["key": "k2", "question": "and then?", "old": "x", "new": ["running": true], "note": ""]]]]]

    func testApplyChangeOnlyTheEntryOfTheRunShown() {
        let changed = BenchmarkPage.applyChange(data, ["run": "run-1", "key": "k2", "new": ["answer": "done"], "running": false])!
        XCTAssertEqual(changed["groups"]![0]!["entries"]![1]!["new"], ["answer": "done"])
        XCTAssertEqual(changed["running"], false)
        let other = BenchmarkPage.applyChange(data, ["run": "run-9", "key": "k2", "new": ["answer": "no"], "running": true])!
        XCTAssertEqual(other["groups"]![0]!["entries"]![1]!["new"], ["running": true])
        XCTAssertEqual(other["running"], true)
    }

    func testExportPage() {
        let page = BenchmarkPage.html(data, notes: ["k2": "typed"], exported: "2026-10-14T16:00:00.000Z")
        XCTAssertTrue(page.hasPrefix("<!doctype html>"))
        XCTAssertTrue(page.contains("<title>Chat benchmark: Run 1</title>"))
        XCTAssertTrue(page.contains("why &lt;blue&gt;?"))
        XCTAssertTrue(page.contains("Still running when exported."))
        XCTAssertTrue(page.contains("<div class=\"note\">typed</div>"), "a note typed and not saved yet goes ahead of what is kept")
        XCTAssertTrue(page.contains("font:600 17px"))
        XCTAssertEqual(page.components(separatedBy: "</script>").count - 1, 1)
        let json = page.components(separatedBy: "id=\"chat-benchmark\">")[1].components(separatedBy: "</script>")[0]
        let parsed = try! JSONValue.parse(json)
        XCTAssertEqual(parsed["entries"]![0]!["new"], "scattering")
        XCTAssertEqual(parsed["entries"]![1]!["notes"], "typed")
        XCTAssertEqual(BenchmarkPage.agentName(data), "Chat")
        XCTAssertFalse(BenchmarkPage.runWhen("2026-10-14T15:02:00.000Z").isEmpty)
    }
}

final class FakeDesignSource: AgentDesignSource {
    var providers = ["anthropic", "openai"]
    var providerInForce: String? = "anthropic"
    var questionAgents = ["bart", "brainstorm", "discover", "create"]
    var routePrompt = "ROUTE"
    func routeStep(provider: String) -> DesignStep? { provider == "anthropic" ? DesignStep(name: "Haiku", model: "claude-haiku", effort: "low") : nil }
    var routeTimeoutMs: Double = 20_000
    var sectionChars = 200_000
    var sureEnough = 0.6
    func promptFileName(_ agent: String) -> String { "\(agent)-system-prompt.md" }
    func systemPrompt(_ agent: String, dataRoot: String?) -> String { "PROMPT \(agent)" }
    var claudeTools = "Read,Grep"
    var brainstormTools = "Read"
    var createTools = "Write,Edit"
    var createCodex = ["sandbox_mode=workspace-write"]
    func createRules(_ draft: String) -> String { "Write(\(draft)/**)" }
    var paperTools = "mcp__papers__search"
    func steps(agent: String, provider: String) -> DesignSteps {
        agent == "discover" ? .modes([("quick", [DesignStep(name: "Sonnet", model: "s", effort: "low")]), ("deep", [DesignStep(name: "Opus", model: "o", effort: "high")])])
            : .steps([DesignStep(name: "Sonnet", model: "s", effort: "medium"), DesignStep(name: "Opus", model: "o", effort: "high")])
    }
    var stepTimeoutMs: Double = 600_000
    var discoverTimeoutMs: Double = 900_000
    var deepDiscoverTimeoutMs: Double = 1_800_000
    var createTimeoutMs: Double = 1_200_000
    var maxCreated = 5
    var maxCreatedBytes = 25 * 1024 * 1024
    var scoped: Set<String> = ["brainstorm"]
    var zoteroReaders: Set<String> = ["bart"]
    var libraryReaders: Set<String> = ["bart", "discover"]
    var replyBudget = 40_000
    var modeLimits = ["quick: 3", "standard: 6", "deep: 12"]
    var welcomeCards = 4
    func buildPrompt(dataRoot: String?, quick: Bool) -> String { quick ? "BUILD quick" : "BUILD" }
    var buildPolicy: (folders: [String], writable: [String], kept: [String], records: [String], gitDir: String, personal: Bool, subagents: Bool, computerUse: Bool) {
        (["<project folder>"], ["<data root>/assets"], ["notes"], ["*.pglite"], "<repository>/.git", true, false, false)
    }
    var buildTools = "Bash,Read,Write"
    var settingSources = "user,project"
    var engelbartToolNames = ["library_add"]
    var buildDeny = ["Edit(**/*.pglite)"]
    var buildCodexOverrides = ["a=1", "b=2"]
    var buildModels: (inForce: String?, providers: [(provider: String, step: DesignStep, models: [(name: String, model: String, use: String)], efforts: [String])], error: String?)? {
        ("anthropic", [("anthropic", DesignStep(name: "Opus", model: "o", effort: "high"), [("Opus", "o", "hard")], ["high", "xhigh"])], nil)
    }
    var buildTurnMs: (build: Double, quick: Double) = (3_600_000, 600_000)
    var buildSlots: (build: Int, quick: Int) = (2, 3)
    var runStepTemplate = "RUN STEP"
    var runTools = ["runnable_declare"]
    var runStepFallback: (step: DesignStep, provider: String)? = (DesignStep(name: "Opus", model: "o", effort: "high"), "anthropic")
    var runStepLimits: (runnable: Double, declare: Double, install: Double, windDown: Double) = (600_000, 60_000, 300_000, 30_000)
    var runStepMaxTurns = 40
}

@MainActor
final class AgentViewerModelTests: XCTestCase {
    func testDesignEntries() throws {
        let root = tempDir("design")
        FileOps.mkdir(join(root, ".context"))
        try "my own chat prompt".write(toFile: join(root, ".context", "bart-system-prompt.md"), atomically: true, encoding: .utf8)
        let design = AgentDesign.agentDesign(FakeDesignSource(), dataRoot: root)
        let agents = design["agents"]!.array!
        XCTAssertEqual(agents.map { $0["agent"]!.string! }, ["router", "bart", "brainstorm", "discover", "create", "build", "run step"])
        XCTAssertEqual(agents[0]["title"], "Bart (classifier)")
        XCTAssertEqual(agents[0]["rules"]!.array!.count, 9)
        XCTAssertTrue(agents[0]["rules"]![5]!["to"]!.string!.contains("sure < 0.6"))
        XCTAssertEqual(agents[0]["calls"]!.array!.map { $0["to"]!.string! }, ["chat", "brainstorm", "discover", "create", "build"])
        XCTAssertEqual(agents[1]["prompt"]!["custom"], true, "a custom .context prompt is marked custom")
        XCTAssertEqual(agents[2]["prompt"]!["custom"], false)
        XCTAssertEqual(agents[3]["tools"]!["anthropic"]!["allowedTools"], "Read,Grep,mcp__papers__search")
        XCTAssertNotNil(agents[3]["models"]!["providers"]!["anthropic"]!["modes"])
        XCTAssertEqual(agents[4]["models"]!["rule"], "@chat's models and efforts (no setting of its own)")
        XCTAssertTrue(agents[4]["keeps"]!.string!.contains("at most 5 of its files, each at most 25 MB"))
        XCTAssertEqual(agents[5]["prompt"]!["quick"], "BUILD quick")
        XCTAssertEqual(agents[5]["ends"]![0]!["line"], "NEEDS YOU: <question>")
        XCTAssertEqual(agents[5]["slots"], ["build": 2, "quick": 3])
        XCTAssertEqual(agents[5]["calls"]![0]!["to"], "run step")
        XCTAssertTrue(agents[5]["reach"]!.string!.contains("Subagents: no."))
        XCTAssertEqual(agents[6]["tools"]!["openai"], .null, "the run step: Claude Code only")
        XCTAssertEqual(agents[6]["tools"]!["anthropic"]!["allowedTools"], "mcp__canvas__runnable_declare")
    }

    private func channels(_ runs: [JSONValue], saved: Box<[String]> = Box([])) -> AgentMapChannels {
        AgentMapChannels(runLog: FakeRunLog(runs), design: { AgentDesign.agentDesign(FakeDesignSource(), dataRoot: nil) },
                         saveFile: { text, name in saved.value.append(name); return "/tmp/\(name)" })
    }

    func testModelSelectionKeysExport() async {
        let runs: [JSONValue] = [
            ["id": "c1", "agent": "bart", "at": 3, "status": "done", "question": "q1", "projectId": "p1", "projectName": "Engelbart", "workspaceName": "One", "system": "SYS", "steps": []],
            ["id": "c2", "agent": "bart", "at": 2, "status": "done", "question": "q2", "projectId": "p1", "projectName": "Engelbart", "workspaceName": "Two", "steps": []],
            ["id": "d1", "agent": "discover", "at": 1, "status": "done", "question": "q3", "projectId": "p2", "projectName": "Papers", "workspaceName": "One", "steps": []],
        ]
        let saved = Box<[String]>([])
        var copied = ""
        let hub = EventHub()
        let model = AgentMapModel(channels: channels(runs, saved: saved), copyText: { copied = $0 }, hub: hub)
        XCTAssertEqual(model.selected, "c1", "the first row shown is selected")
        XCTAssertNil(model.open, "a run opens with its sections closed")
        XCTAssertTrue(model.key("j")); XCTAssertEqual(model.selected, "c2")
        XCTAssertTrue(model.key("k")); XCTAssertEqual(model.selected, "c1")
        XCTAssertTrue(model.key("1")); XCTAssertEqual(model.open, "system")
        XCTAssertTrue(model.key("c")); XCTAssertEqual(copied, "SYS"); XCTAssertEqual(model.note, "Copied System prompt.")
        XCTAssertFalse(model.key("x"))
        model.filter = RunFilter(project: "Papers")
        XCTAssertEqual(model.selected, "d1", "selection follows the filters")
        model.filter = RunFilter(project: "Nope")
        XCTAssertNil(model.selected)
        model.filter = .all
        hub.post("engelbart:agent-run", ["id": "n1", "agent": "create", "at": 9, "status": "running", "question": "new"])
        XCTAssertEqual(model.runs.first?["id"], "n1", "a change is put first")
        model.select("c1")
        model.exportRuns(all: false)
        await until { !saved.value.isEmpty }
        XCTAssertEqual(saved.value, ["agent-run-bart-c1.html"])
        await until { model.note == "Saved /tmp/agent-run-bart-c1.html" }
        model.showDesign()
        XCTAssertEqual(model.design?["agents"]?.array?.count, 7)
    }

    func testRoutedQuestionHasItsClassification() {
        let runs: [JSONValue] = [
            ["id": "rt-1", "agent": "router", "at": 5, "status": "done", "by": "model", "sure": 0.85, "pick": "chat", "question": "why?", "system": "ROUTER", "steps": []],
            ["id": "ch-1", "agent": "bart", "at": 6, "status": "done", "question": "why?", "routedFrom": "rt-1", "system": "CHAT", "steps": []],
        ]
        let model = AgentMapModel(channels: channels(runs), hub: EventHub())
        XCTAssertEqual(model.shown.map { $0["id"]!.string! }, ["ch-1"], "one row per question")
        XCTAssertEqual(model.panelRoute?["id"], "rt-1")
        XCTAssertEqual(RunText.classificationLine(model.panelRoute, model.record), "Bart sent this to Chat (0.85 sure)")
        XCTAssertFalse(model.parts.route); XCTAssertTrue(model.parts.agent)
        model.parts.agent = false
        _ = model.key("3")
        XCTAssertTrue(model.parts.agent, "pressing 3 opens the Agent part")
        XCTAssertEqual(model.open, "steps")
        model.toggle("route:system")
        XCTAssertEqual(model.routeOpen, "route:system")
        XCTAssertEqual(model.open, "steps", "the router's sections open apart from the agent's")
    }

    func testChannelsExportNameAndBenchmarkUnavailable() async throws {
        let saved = Box<[String]>([])
        let c = channels([], saved: saved)
        _ = try await c.export("<html>", name: "a b/c?")
        XCTAssertEqual(saved.value, ["a-b-c-.html"])
        _ = try await c.export("<html>", name: nil)
        XCTAssertEqual(saved.value.last, "agent-runs.html")
        await assertThrows({ try await c.benchmarkList() }, "not available")
        XCTAssertFalse(c.revealAsk("p"))
        let hold = AgentRevealHold()
        hold.keep(["place": ["projectId": "p"]])
        XCTAssertNil(hold.take(projectId: "q"))
        XCTAssertNotNil(hold.take(projectId: "p"))
        XCTAssertNil(hold.take(projectId: "p"), "taken once")
    }

    func testWindowOpensOnlyWhenAvailable() {
        var available = false
        let window = AgentMapWindow(available: { available }, makeContent: { NSView() })
        XCTAssertFalse(window.open())
        available = true
        XCTAssertTrue(window.open())
        XCTAssertEqual(window.nsWindow?.title, "Agent Viewer")
        XCTAssertEqual(window.nsWindow?.minSize, NSSize(width: 720, height: 420))
        XCTAssertTrue(window.open(), "open again focuses it")
        XCTAssertTrue(window.closeUnlessAvailable())
        available = false
        XCTAssertFalse(window.closeUnlessAvailable())
        XCTAssertFalse(AgentsButton.shown, "App.jsx keeps the Agents button hidden in 0.1.25")
    }

    func testTraceSaveRefusesWhatIsNoPageAndWritesWhatIs() async throws {
        await assertThrows({ try await TraceWindow.save("<html>", in: nil, choose: { _, _ in nil }) }, "html is invalid")
        let none = try await TraceWindow.save("<!doctype html><p>x", in: nil, choose: { _, _ in nil })
        XCTAssertEqual(none, "")
        let target = join(tempDir("trace"), "t.html")
        var name = ""
        let path = try await TraceWindow.save("<!doctype html><p>x", in: nil, choose: { panel, _ in name = panel.nameFieldStringValue; return URL(fileURLWithPath: target) })
        XCTAssertEqual(path, target)
        XCTAssertTrue(name.hasPrefix("Engelbart agent trace ") && name.hasSuffix(".html"))
        XCTAssertEqual(FileOps.read(target), "<!doctype html><p>x")
        XCTAssertNotNil(TraceWindow.page, "trace.html is bundled")
    }
}
