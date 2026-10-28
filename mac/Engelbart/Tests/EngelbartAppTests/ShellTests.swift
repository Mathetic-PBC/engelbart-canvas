import AppKit
import EngelbartCore
import EngelbartUI
import XCTest
@testable import EngelbartApp

/// A backend that records what the root asked for.
class FakeBackend: ShellBackend {
    var cfg = ShellConfig(dataRoot: "/r", testMode: false, testModeAvailable: true, testRoot: "/r/test")
    var projects: [ProjectSummary] = []
    var trashed: [ProjectSummary] = []
    var trees: [String: ProjectTree] = [:]
    var last: WindowPlace?
    var calls: [String] = []
    var resetAnswer = true
    var offer = false
    var pending: String?

    func config() async throws -> ShellConfig { cfg }
    func trashedProjects() async throws -> [ProjectSummary] { calls.append("trashed"); return trashed }
    func listProjects() async throws -> [ProjectSummary] { calls.append("list"); return projects }
    func library() async throws -> [JSONValue] { [["id": "row", "project_id": "gone"], ["id": "kept", "project_id": "p1"]] }
    func loadProject(_ id: String) async throws -> ProjectTree {
        calls.append("load:\(id)")
        guard let t = trees[id] else { throw NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "No such project"]) }
        return t
    }
    func views(_ id: String) async throws -> JSONValue { .object([:]) }
    func createWorkspace(_ projectId: String, name: String) async throws {
        calls.append("create:\(name)")
        trees[projectId]?.workspaces = [.init(id: "w-new", name: name)]
    }
    func lastOpen() async -> WindowPlace? { last }
    func setLastOpen(_ place: WindowPlace) async { calls.append("setLast:\(place.workspaceId ?? "-")") }
    func setProjectDirectory(_ id: String, _ directory: String) async throws {
        calls.append("dir:\(directory)"); trees[id]?.project.directory = directory
    }
    func setTestMode(_ on: Bool) async throws -> ShellConfig { cfg.testMode = on; calls.append("test:\(on)"); return cfg }
    func resetTestData(fresh: Bool) async throws -> (reset: Bool, config: ShellConfig) { calls.append("reset:\(fresh)"); return (resetAnswer, cfg) }
    func trashProject(_ id: String) async throws { calls.append("trash:\(id)"); projects.removeAll { $0.id == id } }
    func restoreProject(_ id: String) async throws { calls.append("restore:\(id)") }
    func renameProject(_ id: String, _ name: String) async throws {}
    func guidedOffer() async -> Bool { offer }
    func guidedOfferSeen(_ how: String) async { calls.append("offer:\(how)") }
    func pendingImport() async -> String? { pending }
}

@MainActor
final class RootModelTests: XCTestCase {
    func tree(_ id: String, workspaces: [String] = ["w1", "w2"], directory: String? = "/code", notes: [ProjectTree.Note] = []) -> ProjectTree {
        ProjectTree(project: .init(id: id, name: id.uppercased(), directory: directory), workspaces: workspaces.map { .init(id: $0, name: $0) }, notes: notes)
    }

    func model(_ backend: FakeBackend) -> RootModel {
        let m = RootModel(backend: backend, hub: EventHub())
        m.offerDelay = 0.01
        m.projectChangedDelay = 0.01
        return m
    }

    func testNoProjectsIsOnboardingOrHomeWithTrash() async {
        let b = FakeBackend()
        let m = model(b)
        await m.boot()
        XCTAssertEqual(m.phase, .create, "a new install's onboarding")
        XCTAssertEqual(m.onboardMode, .new)
        XCTAssertEqual(Array(b.calls.prefix(1)), ["trashed"], "the trash is read first")
        b.trashed = [ProjectSummary(id: "p9", name: "Old")]
        let m2 = model(b)
        await m2.boot()
        XCTAssertEqual(m2.phase, .home, "every project deleted: all projects, where Recently deleted can bring one back")
        XCTAssertEqual(m2.onboardMode, .existing, "someone whose projects are all in the trash is not new")
    }

    func testStartOpensLastProjectElseFirst() async {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One"), ProjectSummary(id: "p2", name: "Two")]
        b.trees = ["p1": tree("p1"), "p2": tree("p2")]
        b.last = WindowPlace(projectId: "p2", workspaceId: "w2")
        let m = model(b)
        var titles: [String] = []
        m.onTitle = { titles.append($0) }
        await m.boot()
        XCTAssertEqual(m.phase, .workspace)
        XCTAssertEqual(m.tree?.project.id, "p2")
        XCTAssertEqual(m.entry?.workspaceId, "w2")
        XCTAssertEqual(titles.last, "P2 — Engelbart", "the title names it in the Window menu")
        b.last = WindowPlace(projectId: "gone", workspaceId: "w")
        let m2 = model(b)
        await m2.boot()
        XCTAssertEqual(m2.tree?.project.id, "p1", "a last project that is gone: the first")
        XCTAssertEqual(m2.entry?.workspaceId, "w1")
    }

    func testWindowTargetWinsOnFirstStart() async {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One"), ProjectSummary(id: "p2", name: "Two")]
        b.trees = ["p1": tree("p1"), "p2": tree("p2")]
        b.last = WindowPlace(projectId: "p1", workspaceId: "w1")
        let m = model(b)
        var reported: [WindowPlace] = []
        m.reportPlace = { reported.append($0) }
        m.windowTarget = { .home }
        await m.boot()
        XCTAssertEqual(m.phase, .home)
        XCTAssertEqual(reported.last, WindowPlace(), "the projects screen reports {null, null}")
        let m2 = model(b)
        m2.windowTarget = { .place(WindowPlace(projectId: "p2", workspaceId: "w2")) }
        await m2.boot()
        XCTAssertEqual([m2.tree?.project.id, m2.entry?.workspaceId], ["p2", "w2"])
        // Only the first start asks: a data-root change starts over where the app was last.
        await m2.dataRootChanged(b.cfg, fresh: false)
        XCTAssertEqual(m2.tree?.project.id, "p1")
    }

    func testOpenProjectMakesGettingStartedAndLandsNoteInItsWorkspace() async throws {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1", workspaces: [])]
        let m = model(b)
        try await m.openProject("p1")
        XCTAssertTrue(b.calls.contains("create:Getting started"))
        XCTAssertEqual(m.entry?.workspaceId, "w-new")
        b.trees["p1"] = tree("p1", notes: [.init(id: "n1", name: "Plan", workspaceId: "w2")])
        try await m.openProject("p1", prefer: OpenRequest(tab: TabRef(id: "n1", title: "Plan")))
        XCTAssertEqual(m.entry?.workspaceId, "w2", "a note opened from the library lands in the workspace it was made in")
        XCTAssertEqual(m.entry?.tab, TabRef(id: "n1", title: "Plan"))
    }

    func testConfigFailureLandsHomeWithError() async {
        final class Broken: FakeBackend { override func config() async throws -> ShellConfig { throw NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad config"]) } }
        let m = model(Broken())
        await m.boot()
        XCTAssertEqual(m.phase, .home)
        XCTAssertEqual(m.error, "bad config")
    }

    func testVisitDirectoryAndShownLibrary() async throws {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trashed = [ProjectSummary(id: "gone", name: "Gone")]
        b.trees = ["p1": tree("p1", directory: nil)]
        let m = model(b)
        var reported: [WindowPlace] = []
        m.reportPlace = { reported.append($0) }
        await m.boot()
        XCTAssertNil(m.tree?.project.directory, "held behind the DirectoryGate")
        XCTAssertEqual(m.shownLibrary.map { $0["id"]?.string }, ["kept"], "a trashed project's rows are hidden")
        m.onVisit("w2")
        XCTAssertEqual(reported.last, WindowPlace(projectId: "p1", workspaceId: "w2"))
        await m.chooseDirectory("/new")
        XCTAssertEqual(m.tree?.project.directory, "/new", "chosen: the tree is read again")
    }

    func testTestModeToggleAndReset() async {
        let b = FakeBackend()
        let m = model(b)
        await m.boot()
        await m.toggleTest()
        XCTAssertTrue(b.calls.contains("test:true"))
        XCTAssertEqual(m.config?.testMode, true)
        // Reset: confirmed → remembered UI forgotten, onboarding starts over.
        let defaults = UserDefaults(suiteName: "engelbart-test-\(UUID().uuidString)")!
        defaults.set(true, forKey: "engelbart.tour-seen"); defaults.set(1, forKey: "other.key")
        m.defaults = defaults
        m.laterNeeds = ["n1"]
        let run = m.run
        await m.resetTest(fresh: true)
        XCTAssertNil(defaults.object(forKey: "engelbart.tour-seen"))
        XCTAssertNotNil(defaults.object(forKey: "other.key"))
        XCTAssertTrue(m.laterNeeds.isEmpty)
        XCTAssertEqual(m.run, run + 1)
        // Cancelled at the confirmation: nothing is asked of the backend.
        m.confirmReset = { _ in false }
        b.calls = []
        await m.resetTest(fresh: false)
        XCTAssertFalse(b.calls.contains("reset:false"))
    }

    func testProjectTrashedElsewhereSendsHome() async throws {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        let hub = EventHub()
        let m = RootModel(backend: b, hub: hub)
        m.projectChangedDelay = 0.01
        await m.boot()
        hub.post(ShellEvents.projectChanged, ["projectId": "p1", "trashed": true])
        XCTAssertEqual(m.phase, .home)
        XCTAssertNil(m.tree)
    }

    func testDeleteAndRestore() async {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One"), ProjectSummary(id: "p2", name: "Two")]
        b.trees = ["p1": tree("p1"), "p2": tree("p2")]
        let m = model(b)
        await m.boot()
        await m.deleteProject("p1")
        XCTAssertEqual(m.phase, .home, "the project open here is left first")
        XCTAssertEqual(m.projects.map(\.id), ["p2"])
        await m.restoreProject("p1")
        XCTAssertTrue(b.calls.contains("restore:p1"))
    }

    func testGuidedSetupAndImportContext() async {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        let m = model(b)
        await m.boot()
        // In a workspace: Import your context opens over it.
        m.onVisit("w2")
        await m.startGuided()
        XCTAssertEqual(m.importModal, WindowPlace(projectId: "p1", workspaceId: "w2"))
        // From all projects: over the last-open (else first) project.
        m.importModal = nil
        await m.goHome()
        await m.startGuided()
        XCTAssertEqual(m.phase, .workspace)
        XCTAssertEqual(m.importModal?.projectId, "p1")
        // No project at all: onboarding from its first screen.
        let empty = model(FakeBackend())
        await empty.boot()
        await empty.startGuided()
        XCTAssertEqual(empty.phase, .create)
        XCTAssertEqual(empty.guided, .fromHome)
        XCTAssertEqual(empty.onboardMode, .new)
    }

    func testGuidedOfferAfterProjectOpens() async throws {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        b.offer = true
        let m = model(b)
        await m.boot()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(m.guidedOfferShown)
        XCTAssertTrue(b.calls.contains("offer:shown"))
        m.dismissOffer()
        XCTAssertFalse(m.guidedOfferShown)
    }

    func testPendingImportReopens() async throws {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        b.pending = "p1"
        let m = model(b)
        await m.boot()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(m.importModal?.projectId, "p1")
    }

    func testLeaveOnboardingGoesBackToItsWorkspace() async {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        let m = model(b)
        await m.boot()
        m.newProject()
        XCTAssertEqual(m.phase, .create)
        XCTAssertEqual(m.onboardMode, .existing)
        XCTAssertEqual(m.backTitle, "All projects")
        await m.leaveOnboarding()
        XCTAssertEqual(m.phase, .home)
    }

    struct Gate: ToolsGate {
        func launchRows(_ snapshot: JSONValue) -> [String] { (snapshot["need"]?.array ?? []).compactMap(\.string) }
        func installedSignedOut(before: JSONValue?, after: JSONValue) -> [String] { (after["newlySignedOut"]?.array ?? []).compactMap(\.string) }
        func busy(_ snapshot: JSONValue) -> Bool { snapshot["busy"]?.bool == true }
        var order: [String] { ["git", "claude", "codex"] }
    }

    func testToolSetupAtLaunchWaitsForOnboarding() async {
        let b = FakeBackend()
        let m = model(b)
        m.toolsGate = Gate()
        await m.boot() // no projects: a new person's onboarding
        m.takeTools(["tools": [:], "checked": true, "need": ["claude"], "busy": true])
        XCTAssertNil(m.setup, "a new install's onboarding asks on a screen of its own")
        m.onboardingTools(install: true) // Install all
        XCTAssertNil(m.setup)
        // Onboarding made a project and left: the dialog asks what is left, once installs end.
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        await m.onboarded(projectId: "p1", workspaceId: "w1", note: nil, gettingStarted: true)
        m.takeTools(["tools": [:], "checked": true, "need": ["claude"], "busy": true])
        XCTAssertNil(m.setup, "not while installing")
        m.takeTools(["tools": [:], "checked": true, "need": ["claude"]])
        XCTAssertEqual(m.setup, ToolSetupRequest(mode: .launch, ids: ["claude"]))
        m.setup = nil
        m.openToolSetup()
        XCTAssertEqual(m.setup, ToolSetupRequest(mode: .all, ids: ["git", "claude", "codex"]), "Set Up Tools…")
    }

    func testToolSetupAtLaunchForReturningPerson() async {
        let b = FakeBackend()
        b.projects = [ProjectSummary(id: "p1", name: "One")]
        b.trees = ["p1": tree("p1")]
        let m = model(b)
        m.toolsGate = Gate()
        await m.boot()
        m.takeTools(["tools": [:], "checked": false])
        XCTAssertNil(m.setup, "only the check's first answer counts")
        m.takeTools(["tools": [:], "checked": true, "need": []])
        XCTAssertNil(m.setup, "nothing needs the person")
        m.takeTools(["tools": [:], "checked": true, "need": ["codex"], "newlySignedOut": ["codex"]])
        XCTAssertEqual(m.setup?.mode, .launch, "an agent installed later asks for its sign-in")
    }

    func testPopupGateOrder() {
        func g(need: Bool = false, status: Bool = false, offer: Bool = false, provider: Bool = false, setup: Bool = false, importModal: Bool = false) -> PopupGate {
            PopupGate.compute(pendingNeed: need, statusSession: status, inWorkspace: true, importModal: importModal, connectPopup: false,
                              guidedOffer: offer, blockedSession: provider, setupRequested: setup, toolsKnown: true)
        }
        let all = g(need: true, status: true, offer: true, provider: true, setup: true)
        XCTAssertEqual([all.need, all.status, all.offer, all.provider, all.setup], [true, false, false, false, false], "one popup at a time")
        let noNeed = g(status: true, offer: true, provider: true, setup: true)
        XCTAssertEqual([noNeed.status, noNeed.offer, noNeed.provider, noNeed.setup], [true, false, false, false])
        let offer = g(offer: true, provider: true, setup: true)
        XCTAssertEqual([offer.offer, offer.provider, offer.setup], [true, false, true], "the tool setup waits only behind a need, the status and the provider")
        XCTAssertEqual(g(provider: true, setup: true).setup, false)
        XCTAssertFalse(g(offer: true, importModal: true).offer, "no offer over Import your context")
        XCTAssertTrue(g(setup: true).any, "any popup pauses the tour")
        XCTAssertFalse(g().any)
    }
}

final class FakeHandle: WindowHandle {
    var isDestroyed = false
    var isFocused = false
    var normalBounds = CGRect(x: 10.4, y: 20, width: 1200, height: 800)
}

final class WindowRegistryTests: XCTestCase {
    let project = "11111111-2222-4333-8444-555555555555"
    let workspace = "66666666-7777-4888-8999-000000000000"

    func testPlacesTargetsAndFocus() {
        let r = WindowRegistry()
        var changes = 0
        r.onChange = { changes += 1 }
        let a = r.add(FakeHandle(), place: WindowPlace(projectId: project, workspaceId: workspace))
        let b = r.add(FakeHandle(), place: nil)
        let c = r.add(FakeHandle(), place: nil)
        XCTAssertNil(r.target(c), "a window opened without a place: where the app was last")
        r.navigated(b, WindowPlace())
        XCTAssertEqual(r.target(b), .home)
        XCTAssertEqual(r.target(a), .place(WindowPlace(projectId: project, workspaceId: workspace)))
        r.touch(a)
        XCTAssertEqual(r.places().map(\.projectId), [nil, project], "the window focused last at the end; one that has not said where it is is left out")
        XCTAssertEqual(r.places()[1].bounds, SavedWindow.Rect(x: 10, y: 20, width: 1200, height: 800))
        XCTAssertTrue(r.showing(project) === a)
        XCTAssertTrue(r.focused() === a, "none focused: the one focused last")
        (b.handle as! FakeHandle).isFocused = true
        XCTAssertTrue(r.focused() === b)
        XCTAssertGreaterThanOrEqual(changes, 4)
        r.navigated(c, WindowPlace(projectId: "not an id", workspaceId: "x"))
        XCTAssertEqual(c.place, WindowPlace(), "cleaned")
    }

    func testTerminalSessionsFollowTheirWindow() {
        let r = WindowRegistry()
        let a = r.add(FakeHandle()), b = r.add(FakeHandle())
        r.bootstrap(a, sessions: [])
        r.bootstrap(b, sessions: [])
        r.own("s1", a)
        r.own("s2", b)
        XCTAssertTrue(r.ownerOf("s1") === a)
        XCTAssertTrue(r.attached("s1"))
        r.reset(a)
        XCTAssertFalse(r.attached("s1"), "a window reloading is not attached")
        XCTAssertTrue(r.attached("s2"), "the other window's terminal stays attached")
        XCTAssertTrue(r.own("s2", a) === b, "moved: the window it left is named")
        r.own("s2", b)
        // B closes: its session keeps running, held by no window, and the next window to attach takes it.
        (b.handle as! FakeHandle).isDestroyed = true
        r.remove(b)
        XCTAssertNil(r.ownerOf("s2"))
        let c = r.add(FakeHandle())
        XCTAssertEqual(r.bootstrap(c, sessions: ["s1", "s2"]).sorted(), ["s1", "s2"])
        XCTAssertTrue(r.ownerOf("s2") === c)
        XCTAssertTrue(r.ownerOf("s1") === a, "a session its window still holds stays there")
        r.forget("s1")
        XCTAssertNil(r.ownerOf("s1"))
    }

    func testAskingRoutesDialogsAndRuns() {
        let r = WindowRegistry()
        let a = r.add(FakeHandle(), place: WindowPlace(projectId: project, workspaceId: nil))
        let b = r.add(FakeHandle())
        (b.handle as! FakeHandle).isFocused = true
        XCTAssertTrue(r.dialogContext() === b, "the focused one")
        WindowRegistry.$asking.withValue(a) {
            XCTAssertTrue(r.dialogContext() === a, "the window that asked")
            XCTAssertTrue(r.routeTarget(projectId: nil) === a)
        }
        XCTAssertTrue(r.routeTarget(projectId: project) === a, "else the one showing its project")
        XCTAssertTrue(r.routeTarget(projectId: "other") === b, "else the focused one")
    }
}

@MainActor
final class QuitTests: XCTestCase {

    func testAsksOnlyWithRunningSessionsAndShutsDownInOrder() async {
        var order: [String] = []
        final class P: QuitParticipant {
            let name: String; var sessions: Int; var fail: Bool; var fatal: Bool; let record: (String) -> Void
            init(_ n: String, sessions: Int = 0, fail: Bool = false, fatal: Bool = true, record: @escaping (String) -> Void) { name = n; self.sessions = sessions; self.fail = fail; self.fatal = fatal; self.record = record }
            func runningSessions() -> Int { sessions }
            func shutdown() async throws { record(name); if fail { throw NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "broke"]) } }
            var failureIsFatal: Bool { fatal }
        }
        let q = QuitController()
        var asked: [Int] = []
        var answer = false
        var finished: [Bool] = []
        var saved = 0
        q.confirm = { count, _ in asked.append(count); return answer }
        q.finish = { finished.append($0) }
        q.saveWindowsNow = { saved += 1 }
        q.log = { _ in }
        let terminals = P("terminals", sessions: 2) { order.append($0) }
        q.register(P("sweeper") { order.append($0) })
        q.register(P("sandbox", fail: true, fatal: false) { order.append($0) })
        q.register(terminals)
        let cancelled = await q.request(); XCTAssertFalse(cancelled, "Cancel")
        XCTAssertEqual(asked, [2])
        XCTAssertEqual(QuitPrompt.message(2), "Quit and end 2 running terminal sessions?")
        XCTAssertEqual(QuitPrompt.message(1), "Quit and end 1 running terminal session?")
        XCTAssertTrue(order.isEmpty)
        answer = true
        let went = await q.request(); XCTAssertTrue(went)
        XCTAssertEqual(order, ["sweeper", "sandbox", "terminals"], "in order; the sandbox's failure only logged")
        XCTAssertEqual(saved, 1, "windows saved before any closes")
        XCTAssertEqual(finished, [false])
        let again = await q.request(relaunch: true); XCTAssertFalse(again, "a quit already done")
    }

    func testUpdateNeverAsksAndRelaunchIsKept() async {
        let q = QuitController()
        var asked = 0
        var finished: [Bool] = []
        q.confirm = { _, _ in asked += 1; return true }
        q.finish = { finished.append($0) }
        final class T: QuitParticipant { let name = "t"; func runningSessions() -> Int { 3 }; func shutdown() async throws {} }
        q.register(T())
        let updated = await q.request(update: true, relaunch: true); XCTAssertTrue(updated)
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(finished, [true])
    }

    func testFatalFailureCancels() async {
        let q = QuitController()
        var shown: [String] = []
        q.showError = { title, message in shown.append("\(title): \(message)") }
        q.finish = { _ in XCTFail("must not quit") }
        final class F: QuitParticipant { let name = "store"; func shutdown() async throws { throw NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "disk full"]) } }
        q.register(F())
        let failed = await q.request(); XCTAssertFalse(failed)
        XCTAssertEqual(shown, ["Unable to shut down cleanly: disk full"])
        XCTAssertFalse(q.pending, "a later quit may try again")
    }
}

final class ActionsAndMCPTests: XCTestCase {
    func testNewestHandlerFirst() {
        let actions = WindowActions()
        var got: [String] = []
        actions.on(.find) { got.append("stage"); return true }
        let doc = actions.on(.find) { got.append("doc"); return false }
        XCTAssertTrue(actions.send(.find))
        XCTAssertEqual(got, ["doc", "stage"], "a handler that passes hands it on")
        actions.off(doc)
        got = []
        actions.send(.find)
        XCTAssertEqual(got, ["stage"])
        XCTAssertFalse(actions.send(.findNext))
    }

    func testMCPRequestParsing() {
        XCTAssertNil(MCPRegistry.request(in: []))
        XCTAssertNil(MCPRegistry.request(in: ["-NSDocumentRevisionsDebugMode", "YES"]))
        XCTAssertEqual(MCPRegistry.request(in: ["--mcp", "papers", "--root", "/x"])?.name, "papers")
        XCTAssertEqual(MCPRegistry.request(in: ["--mcp", "papers", "--root", "/x"])?.args, ["--root", "/x"])
        XCTAssertEqual(MCPRegistry.request(in: ["--mcp"])?.name, "")
    }

    func testUnknownServerExits2() {
        let err = Pipe()
        XCTAssertEqual(MCPRegistry.serve("nope-\(UUID())", args: [], errors: err.fileHandleForWriting), 2)
        try? err.fileHandleForWriting.close()
        let text = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("Unknown MCP server: nope-"))
    }

    func testServesUntilStdinCloses() throws {
        let input = Pipe(), output = Pipe()
        MCPRegistry.register("test-echo") { _ in MCPServer(name: "echo", tools: [], output: output.fileHandleForWriting) }
        input.fileHandleForWriting.write(Data(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.utf8 + [0x0A]))
        try input.fileHandleForWriting.close()
        XCTAssertEqual(MCPRegistry.serve("test-echo", args: [], input: input.fileHandleForReading), 0)
        try output.fileHandleForWriting.close()
        let reply = try JSONValue.parse(output.fileHandleForReading.readDataToEndOfFile())
        XCTAssertEqual(reply["id"], 1)
        XCTAssertEqual(reply["result"], .object([:]))
    }

    func testResetPromptWords() {
        let fresh = Dialogs.ResetPrompt.make(fresh: true, testRootShown: "~/.engelbart-swift/test")
        XCTAssertEqual(fresh.title, "Start as a new user?")
        XCTAssertEqual(fresh.message, "Delete everything under ~/.engelbart-swift/test?")
        XCTAssertEqual(fresh.confirm, "Start as a new user")
        let reset = Dialogs.ResetPrompt.make(fresh: false, testRootShown: "~/x")
        XCTAssertEqual([reset.title, reset.confirm], ["Reset test data?", "Reset test data"])
        XCTAssertTrue(reset.detail.hasPrefix("Projects, notes, the test library and paper annotations are removed."))
    }

    @MainActor func testPickersAnswerScriptedRuns() async {
        let picked = await Dialogs.pickPaths(pdfOnly: false, window: nil, environment: ["ENGELBART_PICK_PATHS": #"["/a.pdf","/b"]"#])
        XCTAssertEqual(picked, ["/a.pdf", "/b"])
        let dir = await Dialogs.pickDirectory(current: nil, home: URL(fileURLWithPath: "/"), window: nil, environment: ["ENGELBART_PICK_DIRECTORY": "/tmp"])
        XCTAssertEqual(dir, "/tmp")
        let yes = await Dialogs.confirmReset(fresh: true, testRootShown: "~", window: nil, environment: ["ENGELBART_CONFIRM_ALL": "1"])
        XCTAssertTrue(yes)
        XCTAssertEqual(Dialogs.startFolder("/definitely/not/here", home: URL(fileURLWithPath: "/home")).path, "/home")
        XCTAssertEqual(Dialogs.startFolder(NSTemporaryDirectory(), home: URL(fileURLWithPath: "/home")).standardizedFileURL.path,
                       URL(fileURLWithPath: NSTemporaryDirectory()).standardizedFileURL.path)
    }

    func testTitleBarDoubleClickPreference() {
        let d = UserDefaults(suiteName: "eb-dbl-\(UUID().uuidString)")!
        XCTAssertEqual(TitleBarDoubleClick.action(d), .zoom)
        d.set("Minimize", forKey: "AppleActionOnDoubleClick"); XCTAssertEqual(TitleBarDoubleClick.action(d), .minimize)
        d.set("None", forKey: "AppleActionOnDoubleClick"); XCTAssertEqual(TitleBarDoubleClick.action(d), .none)
        d.set("Fill", forKey: "AppleActionOnDoubleClick"); XCTAssertEqual(TitleBarDoubleClick.action(d), .zoom)
        XCTAssertEqual(WindowChrome.leadPadding(fullScreen: false), 84)
        XCTAssertEqual(WindowChrome.leadPadding(fullScreen: true), 0)
        XCTAssertEqual(TestToggle.tooltip(testMode: true, dataRoot: "/r", testRoot: NSHomeDirectory() + "/.engelbart-swift/test"),
                       "Test mode is on — everything lives in ~/.engelbart-swift/test")
    }

    func testSingleInstance() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("eb-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = SingleInstance(userData: dir)
        XCTAssertTrue(first.acquire())
        // flock is per open file description: a second open in this process is refused as another process would be.
        let second = SingleInstance(userData: dir)
        XCTAssertFalse(second.acquire(), "a second copy on the same folder")
        XCTAssertTrue(SingleInstance(userData: dir.appendingPathComponent("other")).acquire(), "another folder is another app")
        XCTAssertNotEqual(first.notification, SingleInstance(userData: dir.appendingPathComponent("other")).notification)
    }
}
