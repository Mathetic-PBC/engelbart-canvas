import XCTest
import EngelbartCore
import EngelbartStore
@testable import EngelbartSidebar

// Ports of test/sidebar-model.test.cjs, sidebar-plan.test.cjs, rail-model.test.cjs (the sidebar's searches),
// nav-model.test.cjs, add-or-find.test.cjs and getting-started.test.cjs (the model part).

func row(_ id: String, _ name: String, _ type: String, _ tags: [String] = [], url: String? = nil, path: String? = nil, folderPath: String? = nil,
         summary: String? = nil, created: String = "", lastEdited: String = "") -> LibraryRow {
    LibraryRow(id: id, name: name, type: type, path: path, url: url, folderPath: folderPath, created: created, lastEdited: lastEdited, summary: summary, tags: tags)
}

func ws(_ id: String, _ name: String, _ edited: String? = nil, _ children: [ProjectNode] = [], archives: [ArchiveEntry] = []) -> ProjectNode {
    ProjectNode(id: id, name: name, edited: edited, archives: archives, children: children)
}

/// 2026-10-07 12:00 UTC less `minutes`.
func at(_ minutes: Double) -> String { JSTime.iso(Date(timeIntervalSince1970: 1_791_374_400).timeIntervalSince1970 * 1000 - minutes * 60000) }

final class SidebarModelTests: XCTestCase {
    let rows = [
        row("n1", "Sidebar requirements", "md", ["note"]),
        row("p1", "Working spheres", "pdf", ["paper"], path: "/Users/h/spheres.pdf"),
        row("g1", "Papert-Lab/notes", "website", ["git"], url: "https://github.com/Papert-Lab/notes"),
        row("g2", "engelbart-canvas", "folder", ["git"], folderPath: "/Users/h/engelbart-canvas"),
        row("w1", "Magic Ink", "website", url: "https://worrydream.com/MagicInk/"),
        row("m1", "README", "md"),
        row("c1", "survey.csv", "csv"),
        row("f1", "fixtures", "folder", folderPath: "/Users/h/fixtures"),
        row("i1", "Attachment 1", "image"),
    ]

    func testJSTime() {
        XCTAssertEqual(JSTime.parse("2026-10-13T10:00:00Z"), 1_791_885_600_000)
        XCTAssertEqual(JSTime.parse("2026-10-13T10:00:00.500Z"), 1_791_885_600_500)
        XCTAssertEqual(JSTime.parse("2026-10-13"), 1_791_849_600_000)
        XCTAssertNil(JSTime.parse("nope")); XCTAssertNil(JSTime.parse(nil)); XCTAssertEqual(JSTime.ms(""), 0)
        XCTAssertEqual(JSTime.iso(1_791_885_600_500), "2026-10-13T10:00:00.500Z")
    }

    func testSourceGroups() {
        XCTAssertEqual(SidebarModel.SOURCE_GROUPS.map(\.label), ["Starred", "Notes", "Sources"])
        let groups = SidebarModel.sourceGroups(rows, starredIds: [], library: rows)
        XCTAssertEqual(groups.map { [$0.key] + $0.rows.map(\.id) }, [["starred"], ["notes", "n1"], ["other", "p1", "g1", "g2", "w1", "m1", "c1", "f1", "i1"]])
        XCTAssertEqual(["n1", "w1", "g1", "g2", "p1"].map { id in SidebarModel.sourceKind(rows.first { $0.id == id }!) }, ["notes", "websites", "code", "code", "files"])
        XCTAssertEqual(SidebarModel.sourceKind(row("m2", "README", "md")), "files")
        let elsewhere = row("x1", "As We May Think", "website", url: "https://www.w3.org/History/1945/vbush/")
        let starred = SidebarModel.sourceGroups(Array(rows.prefix(2)), starredIds: ["x1", "gone", "p1"], library: [elsewhere] + rows).first { $0.key == "starred" }!
        XCTAssertEqual(starred.rows.map(\.id), ["x1", "p1"])
    }

    func testFitGroups() {
        let groups: [(key: String, count: Int, header: Bool?)] = [("starred", 2, nil), ("notes", 7, nil), ("other", 6, false)]
        let fit = SidebarModel.fitGroups(groups, room: 12, cap: 5)
        XCTAssertEqual(fit.shown, ["starred": 2, "notes": 3, "other": 3])
        XCTAssertEqual(fit.more, ["starred": false, "notes": true, "other": true])
        XCTAssertEqual(fit.lines, 12); XCTAssertTrue(fit.fits)
        XCTAssertEqual(SidebarModel.fitGroups(groups, room: 40).shown["notes"], 5)
        XCTAssertEqual(SidebarModel.fitGroups(groups, room: 40).more["notes"], true)
        let open: [(key: String, count: Int, header: Bool?)] = ["a", "b", "c"].map { ($0, 9, nil) }
        XCTAssertEqual(SidebarModel.fitGroups(open, room: 14).shown, ["a": 3, "b": 3, "c": 2])
        XCTAssertEqual(SidebarModel.fitGroups(open, room: 12).shown, ["a": 2, "b": 2, "c": 2])
        XCTAssertEqual(SidebarModel.fitGroups([("a", 2, nil)], room: 3).shown, ["a": 2])
        let one = SidebarModel.fitGroups([("a", 3, nil)], room: 3)
        XCTAssertEqual(one.shown, ["a": 1]); XCTAssertEqual(one.more, ["a": true]); XCTAssertEqual(one.lines, 3); XCTAssertTrue(one.fits)
        XCTAssertEqual(SidebarModel.fitGroups([("a", 3, false)], room: 3).shown, ["a": 3])
        let tight = SidebarModel.fitGroups(["a", "b", "c"].map { ($0, 4, nil) }, room: 6)
        XCTAssertFalse(tight.fits); XCTAssertEqual(tight.shown, ["a": 1, "b": 1, "c": 1])
        let empty = SidebarModel.fitGroups([("starred", 0, nil), ("other", 0, false)], room: 10)
        XCTAssertEqual(empty.lines, 2); XCTAssertEqual(empty.shown, ["starred": 0, "other": 0])
    }

    func tree() -> [ProjectNode] {
        [ws("gs", "Getting started", at(600)),
         ws("ui", "User Interface", at(500), [ws("sb", "Sidebar", at(5), [ws("ic", "Iconography", at(400))]), ws("mc", "Middle Canvas", at(50)), ws("fa", "Focusing attention", at(300))]),
         ws("ag", "Agents", at(450), [ws("bb", "Bart build agents", at(30))]),
         ws("lb", "Library", at(100)),
         ws("ob", "Onboarding", at(700))]
    }

    func testRecentWorkspaces() {
        let listed = SidebarModel.recentWorkspaces(roots: tree(), hereId: "sb")
        XCTAssertEqual(listed.map(\.node.id), ["ui", "ag", "lb"])
        XCTAssertEqual(listed[0].children.map(\.node.id), ["sb", "mc", "fa"])
        XCTAssertTrue(listed[0].holdsHere); XCTAssertFalse(listed[1].holdsHere)
        let recent = [RecentPlace(projectId: "p", workspaceId: "ob", at: at(1))]
        XCTAssertEqual(SidebarModel.recentWorkspaces(roots: tree(), recent: recent, hereId: "sb").map(\.node.id), ["ob", "ui", "ag"])
        XCTAssertEqual(SidebarModel.recentWorkspaces(roots: tree(), hereId: "gs").map(\.node.id), ["ui", "ag", "gs"])
        XCTAssertEqual(SidebarModel.recentWorkspaces(roots: tree(), hereId: "ic").map { "\($0.node.id)\($0.holdsHere)" }, ["uitrue", "agfalse", "lbfalse"])
        XCTAssertEqual(SidebarModel.recentWorkspaces(roots: [], hereId: nil).count, 0)
        XCTAssertEqual(SidebarModel.fitChildren([("ui", true, 3), ("ag", true, 1), ("lb", false, 4)], room: 3), ["ui": 2, "ag": 1, "lb": 0])
        XCTAssertEqual(SidebarModel.fitChildren([("ui", true, 5)], room: 3), ["ui": 3])
        XCTAssertEqual(SidebarModel.pathTo(tree(), "ic").map(\.id), ["ui", "sb", "ic"])
        XCTAssertEqual(SidebarModel.pathTo(tree(), "nope").count, 0)
        XCTAssertEqual(SidebarModel.countWorkspaces(tree()), 10)
        let (own, within) = SidebarModel.workspaceActivity(tree())
        XCTAssertGreaterThan(within["ui"]!, own["ui"]!)
        XCTAssertEqual(within["ui"], own["sb"])
    }

    func testInboxAndAgentGroups() {
        let agents = [
            NavAgent(id: "a1", kind: "bart", projectId: "p", workspaceId: "ag", status: "waiting", finished: at(10), name: "Agents"),
            NavAgent(id: "a2", kind: "build", projectId: "p", workspaceId: "sb", status: "waiting", finished: at(2), name: "Sidebar"),
            NavAgent(id: "a3", kind: "bart", projectId: "p", workspaceId: "mc", status: "running", started: at(1)),
            NavAgent(id: "a4", kind: "discover", projectId: "other", workspaceId: "x", status: "waiting", finished: at(1)),
            NavAgent(id: "a5", kind: "build", projectId: "p", workspaceId: nil, status: "waiting", finished: at(1)),
        ]
        XCTAssertEqual(SidebarModel.inboxEntries(agents, projectId: "p").map { "\($0.id):\($0.did)" }, ["a2:Build finished a turn", "a1:Bart answered"])
        let asks = [NavAgent(id: "q1", kind: "discover", projectId: "p", workspaceId: "lb", status: "running", started: at(3)),
                    NavAgent(id: "q2", kind: "build", projectId: "p", workspaceId: "sb", status: "running", started: at(4)),
                    NavAgent(id: "q3", kind: "bart", projectId: "p", workspaceId: "sb", status: "waiting", finished: at(4))]
        let builds = [BuildInfo(id: "b1", projectId: "p", workspaceId: "sb", title: "New sidebar", status: "running", updated: at(1)),
                      BuildInfo(id: "b2", projectId: "p", workspaceId: "mc", title: "Copy button", status: "needs-you", updated: at(20)),
                      BuildInfo(id: "b3", kind: "quick", projectId: "p", title: "Fix the tabs", status: "accepted", updated: at(90)),
                      BuildInfo(id: "b4", projectId: "other", workspaceId: "x", title: "Elsewhere", status: "running", updated: at(1))]
        let groups = SidebarModel.agentGroups(agents: asks, builds: builds, projectId: "p")
        XCTAssertEqual(groups.running.map { [$0.id, $0.title, $0.state] }, [["build:b1", "New sidebar", "Working"], ["agent:q1", "Discover", "Working"]])
        XCTAssertEqual(groups.waiting.map { [$0.id, $0.state] }, [["build:b2", "Needs you"]])
        XCTAssertEqual(groups.done.map { [$0.id, $0.kind, $0.state] }, [["build:b3", "quick", "Accepted"]])
    }

    func testArchivedAndSinceWords() {
        let roots = [ws("a", "A", nil, [ws("b", "B", nil, [], archives: [ArchiveEntry(file: "2.md", clearedAt: at(10), title: "")])], archives: [ArchiveEntry(file: "1.md", clearedAt: at(300), title: "First")])]
        XCTAssertEqual(SidebarModel.archivedVersions(roots).map { [$0.workspaceId, $0.file, $0.title] }, [["b", "2.md", "Untitled"], ["a", "1.md", "First"]])
        let now = JSTime.ms(at(0))
        XCTAssertEqual([at(0), at(4), at(130), at(3000)].map { SidebarModel.sinceWords($0, now: now) } + [SidebarModel.sinceWords(nil, now: now)], ["just now", "4 min ago", "2 h ago", "2 d ago", ""])
        let node = ws("a", "A", nil, [ws("b", "B", nil, [], archives: [ArchiveEntry(file: "3.md", clearedAt: at(1), title: "Child")])],
                      archives: [ArchiveEntry(file: "1.md", clearedAt: at(300), title: "Old"), ArchiveEntry(file: "2.md", clearedAt: at(10), title: "")])
        XCTAssertEqual(SidebarModel.versionsOf(node).map { [$0.workspaceId, $0.file, $0.title] }, [["a", "2.md", "Untitled"], ["a", "1.md", "Old"]])
        XCTAssertEqual(SidebarModel.versionsOf(ws("c", "C")).count, 0)
        XCTAssertEqual([at(0), at(4), at(130), at(3000)].map { SidebarModel.since($0, now: now) } + [SidebarModel.since("x", now: now)], ["now", "4m", "2h", "2d", ""])
    }

    func testKeptAgents() {
        let now = JSTime.ms("2026-10-16T12:00:00Z")
        func ago(_ hours: Double) -> String { JSTime.iso(now - hours * 3_600_000) }
        let entries = [AgentEntry(id: "fresh", state: "failed", at: ago(2)), AgentEntry(id: "old", state: "needs", at: ago(80)),
                       AgentEntry(id: "oldrun", state: "running", at: ago(200)), AgentEntry(id: "clicked", state: "unseen", at: ago(30)),
                       AgentEntry(id: "clickedlong", state: "done", at: ago(50)), AgentEntry(id: "gone", state: "failed", at: ago(1)),
                       AgentEntry(id: "again", state: "failed", at: ago(1)), AgentEntry(id: "ranthen", state: "unseen", at: ago(1))]
        let marks = ["clicked": AgentMark(clicked: ago(3)), "clickedlong": AgentMark(clicked: ago(25)), "gone": AgentMark(dismissed: ago(0.5)),
                     "again": AgentMark(dismissed: ago(5)), "ranthen": AgentMark(clicked: ago(4))]
        let kept = SidebarModel.keptAgents(entries, marks: marks, now: now)
        XCTAssertEqual(kept.map(\.id), ["fresh", "oldrun", "clicked", "again", "ranthen"])
        XCTAssertTrue(kept.first { $0.id == "clicked" }!.viewed)
        XCTAssertFalse(kept.first { $0.id == "ranthen" }!.viewed)
        XCTAssertEqual(SidebarModel.summarize(kept), AgentSummary(total: 4, running: 1, ready: 3))
        let next = SidebarModel.markAgent(["stale": AgentMark(clicked: ago(24 * 9)), "kept": AgentMark(dismissed: ago(1))], "new", "clicked", at: ago(0))
        XCTAssertEqual(next.keys.sorted(), ["kept", "new"])
        XCTAssertEqual(next["new"]?.clicked, ago(0))
    }

    func testBuildInProgressStays() {
        let now = JSTime.ms("2026-10-17T12:00:00Z")
        func ago(_ minutes: Double) -> String { JSTime.iso(now - minutes * 60000) }
        func task(_ id: String, _ status: String, _ kind: String = "build", _ updated: String? = nil) -> BuildInfo {
            BuildInfo(id: id, kind: kind, projectId: "p1", workspaceId: kind == "quick" ? nil : "w1", title: "Build \(id)", status: status, updated: updated ?? ago(40), created: ago(60))
        }
        let builds = [task("b1", "setting-up"), task("b2", "queued"), task("b3", "running"), task("b4", "accepting"), task("q1", "running", "quick"),
                      task("d1", "accepted"), task("f1", "failed"), task("n1", "needs-you")]
        var marks: [String: AgentMark] = [:]
        for id in ["b1", "b2", "b3", "b4", "q1", "d1", "f1", "n1"] { marks = SidebarModel.markAgent(marks, "build:\(id)", "dismissed", at: ago(10)) }
        marks = SidebarModel.markAgent(marks, "build:b3", "clicked", at: ago(5))
        let kept = SidebarModel.keptAgents(SidebarModel.agentEntries(builds: builds, projectId: "p1"), marks: marks, now: now)
        XCTAssertEqual(kept.map { "\($0.id) \($0.state) \($0.title)" }.sorted(), ["build:b1 running Build b1", "build:b2 running Build b2", "build:b3 running Build b3",
                                                                                 "build:b4 running Build b4", "build:q1 running Build q1"])
        XCTAssertEqual(SidebarModel.summarize(kept), AgentSummary(total: 5, running: 5, ready: 0))
        let after = SidebarModel.keptAgents(SidebarModel.agentEntries(builds: [task("b3", "review", "build", ago(1)), task("d1", "accepted")], projectId: "p1"), marks: marks, now: now)
        XCTAssertEqual(after.map { "\($0.id) \($0.state)" }, ["build:b3 needs"])
        let others = SidebarModel.keptAgents([AgentEntry(id: "agent:a1", kind: "bart", state: "running", at: ago(40)), AgentEntry(id: "repo:r1", kind: "repo", state: "running", at: ago(40)),
                                              AgentEntry(id: "build:old", kind: "build", state: "done", at: JSTime.iso(now - SidebarModel.AGENT_KEPT_MS - 60000))],
                                             marks: ["agent:a1": AgentMark(dismissed: ago(10)), "repo:r1": AgentMark(dismissed: ago(10))], now: now)
        XCTAssertEqual(others.count, 0)
    }

    func testRepoEntries() {
        let notes = [RepoNotification(id: "n1", libraryId: "r1", at: "2026-10-16T10:00:00Z"), RepoNotification(id: "n2", libraryId: "r2", at: "2026-10-16T09:00:00Z", read: true),
                     RepoNotification(id: "n3", libraryId: "r3", at: "2026-10-16T08:00:00Z"), RepoNotification(id: "n4", libraryId: "gone", at: "2026-10-16T08:00:00Z")]
        let items = ["r1": RepoItem(run: ["status": "starting"]), "r2": RepoItem(run: ["status": "ready"], sandbox: "asleep"), "r3": RepoItem(run: ["status": "failed"])]
        let out = SidebarModel.repoEntries(notes, items: items, library: [row("r1", "mqo00/rope", "folder", ["git"])])
        XCTAssertEqual(out.map { "\($0.id) \($0.title) \($0.state) \($0.viewed)" }, ["repo:n1 mqo00/rope running false", "repo:n2 Repository unseen true", "repo:n3 Repository failed false"])
        XCTAssertEqual(out[1].sandbox, "asleep")
    }

    func testByOpened() {
        let list = [row("a", "A", "md", created: "2026-10-01T00:00:00Z"), row("b", "B", "md", created: "2026-10-02T00:00:00Z"), row("c", "C", "md"), row("d", "D", "md")]
        XCTAssertEqual(SidebarModel.byOpened(list, opened: ["a": "2026-10-15T00:00:00Z"]).map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(SidebarModel.byOpened(list, opened: ["d": "2026-10-15T00:00:00Z", "c": "2026-10-14T00:00:00Z"]).map(\.id), ["d", "c", "b", "a"])
        let many = SidebarModel.noteOpened(["x": "2026-10-01T00:00:00Z", "y": "2026-10-03T00:00:00Z"], "z", at: "2026-10-05T00:00:00Z", max: 2)
        XCTAssertEqual(many.keys.sorted(), ["y", "z"])
    }

    func testAgentGroupsOrderInPanel() {
        XCTAssertEqual(AgentsPanelModel.GROUPS.map(\.title), ["Running", "Failed", "Needs you", "Finished"])
        XCTAssertEqual(AgentsPanelModel.GROUPS.map(\.states), [["running"], ["failed"], ["needs"], ["unseen", "done"]])
        XCTAssertFalse(AgentsPanelModel.canDismiss(AgentEntry(id: "b", kind: "build", state: "running"), dismissable: true))
        XCTAssertTrue(AgentsPanelModel.canDismiss(AgentEntry(id: "b", kind: "bart", state: "running"), dismissable: true))
    }
}

final class SidebarPlanTests: XCTestCase {
    struct Walk: Decodable { let target: String; let held: [String]?; let order: [String]; let expanded: [String]; let openPath: [String]; let visible: [String]; let hidden: [String]; let guide: String?; let rows: Int }
    struct Toggle: Decodable { let id: String?; let start: [String]?; let expanded: [String]?; let order: [String]?; let visible: [String]? }
    struct Node: Decodable { let id: String; let name: String; let children: [Node] }
    struct Fixture: Decodable { let roots: [Node]; let walk: [Walk]; let toggles: [Toggle] }

    func fixture() throws -> Fixture {
        let url = try XCTUnwrap(ResourceBundle.named("Sidebar_EngelbartSidebarTests", fallback: Bundle.module).url(forResource: "mockup-walk", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    func nodes(_ list: [Node]) -> [ProjectNode] { list.map { ProjectNode(id: $0.id, name: $0.name, children: nodes($0.children)) } }

    func testEveryProjectOfTheMockup() throws {
        let fx = try fixture()
        let roots = nodes(fx.roots)
        let index = SidebarModel.indexTree(roots)
        XCTAssertEqual(index.count, 38)
        XCTAssertEqual(fx.walk.count, 79)
        for step in fx.walk {
            if let held = step.held {
                XCTAssertEqual(SidebarModel.projectSlots(roots: roots, index: index, focusId: step.target, held: held), step.order, "shortlist after \(step.target)")
            }
            XCTAssertEqual(SidebarModel.openPath(index, step.target).sorted(), step.expanded, "open after \(step.target)")
            let plan = SidebarModel.projectPlan(index: index, order: step.order, expanded: Set(step.expanded))
            XCTAssertEqual(plan.visible, step.visible, "rows after \(step.target)")
            XCTAssertEqual(plan.hidden, step.hidden, "More after \(step.target)")
            XCTAssertEqual(plan.guide, step.guide, "guide after \(step.target)")
            XCTAssertEqual(plan.rows, step.rows)
            XCTAssertLessThanOrEqual(plan.rows, 10)
        }
    }

    func testChevronsOpenOneBranch() throws {
        let fx = try fixture()
        let index = SidebarModel.indexTree(nodes(fx.roots))
        var expanded = Set(fx.toggles[0].start ?? [])
        for toggle in fx.toggles.dropFirst() {
            expanded = SidebarModel.toggleOpen(index, expanded, toggle.id!)
            XCTAssertEqual(expanded.sorted(), toggle.expanded, "after toggling \(toggle.id!)")
            XCTAssertEqual(SidebarModel.projectPlan(index: index, order: toggle.order!, expanded: expanded).visible, toggle.visible)
        }
    }

    func testCounts() {
        let roots = [ws("ui", "UI", nil, [ws("sb", "Sidebar", nil, [ws("nt", "Notifications")])]), ws("ag", "Agents")]
        let index = SidebarModel.indexTree(roots)
        let entries = SidebarModel.agentEntries(
            agents: [NavAgent(id: "a", projectId: "p", workspaceId: "nt", status: "running", started: "2026-10-13T10:00:00Z"),
                     NavAgent(id: "b", projectId: "p", workspaceId: "sb", status: "waiting", finished: "2026-10-13T11:00:00Z"),
                     NavAgent(id: "c", projectId: "other", workspaceId: "sb", status: "waiting")],
            builds: [BuildInfo(id: "b1", kind: nil, projectId: "p", workspaceId: "ag", title: "Pills", status: "review", updated: "2026-10-13T12:00:00Z"),
                     BuildInfo(id: "b2", kind: nil, projectId: "p", workspaceId: "ui", title: "Old", status: "accepted"),
                     BuildInfo(id: "b3", kind: "quick", projectId: "p", workspaceId: nil, title: "A post-it", status: "failed")],
            connect: [ConnectNote(id: "connect:s", sessionId: "s", name: "Connect your library", tone: "warn", at: "2026-10-13T09:00:00Z")],
            projectId: "p")
        XCTAssertEqual(entries.map { "\($0.id) \($0.state)" }, ["build:b1 needs", "agent:b unseen", "agent:a running", "connect:s needs", "build:b2 done", "build:b3 failed"])
        XCTAssertEqual(SidebarModel.summarize(entries), AgentSummary(total: 5, running: 1, ready: 4))
        let rolled = SidebarModel.rollUp(index, entries)
        XCTAssertEqual(rolled["ui"], AgentSummary(total: 2, running: 1, ready: 1))
        XCTAssertEqual(rolled["nt"], AgentSummary(total: 1, running: 1, ready: 0))
        XCTAssertEqual(SidebarModel.summaryOf(index, entries, ["sb", "nt", "ag"]), AgentSummary(total: 3, running: 1, ready: 2))
        XCTAssertEqual([SidebarModel.countLabel(9), SidebarModel.countLabel(10), SidebarModel.libraryLabel(999), SidebarModel.libraryLabel(1000)], ["9", "9+", "999", "999+"])
        XCTAssertEqual(["queued", "needs-you", "review", "conflict", "stopped"].map(SidebarModel.buildState), ["running", "needs", "needs", "failed", "done"])
    }

    func testShortcuts() {
        let roots = (0..<11).map { ws("p\($0)", "P\($0)", nil, [ws("c\($0)", "child")]) }
        XCTAssertEqual(SidebarModel.shortcutProjects(roots), roots.prefix(9).map(\.id))
        XCTAssertEqual(SidebarModel.shortcutOf(roots, "p0"), 1)
        XCTAssertEqual(SidebarModel.shortcutOf(roots, "p9"), 0)
        XCTAssertEqual(SidebarModel.shortcutOf(roots, "c0"), 0)
    }

    func testTheClock() {
        let index = SidebarModel.indexTree([ws("ui", "UI", nil, [ws("sb", "Sidebar")])])
        func t(_ n: Int) -> String { String(format: "2026-10-13T10:%02d:00.000Z", n) }
        var visits: [Visit] = []
        visits = SidebarModel.visited(visits, kind: "project", id: "ui", at: t(1))
        visits = SidebarModel.visited(visits, kind: "note", id: "n1", at: t(2))
        visits = SidebarModel.visited(visits, kind: "project", id: "gone", at: t(3))
        visits = SidebarModel.visited(visits, kind: "project", id: "sb", at: t(4))
        visits = SidebarModel.visited(visits, kind: "project", id: "ui", at: t(5))
        XCTAssertEqual(SidebarModel.recentPages(visits: visits, index: index, notes: ["n1"]).map { "\($0.kind):\($0.id)" }, ["top:top", "project:ui", "project:sb", "note:n1"])
        let many = (0..<20).map { Visit(kind: "note", id: "n\($0)", at: t($0)) }
        XCTAssertEqual(SidebarModel.recentPages(visits: many, index: index, notes: Set(many.map(\.id))).count, 10)
        XCTAssertEqual([SidebarModel.crumbFrom(["Engelbart", "User Interface"], 0), SidebarModel.crumbFrom(["Engelbart", "User Interface"], 1)], ["Engelbart/User Interface", "./User Interface"])
    }

    func testSourceIcons() {
        let list = [row("", "", "md", ["note"]), row("", "", "md"), row("", "", "image"), row("", "", "html"), row("", "", "website"), row("", "", "folder"),
                    row("", "", "pdf", ["paper"]), row("", "", "folder", ["git"]), row("", "", "csv")]
        XCTAssertEqual(list.map(SidebarModel.sourceIcon), ["note", "file", "image", "html", "website", "folder", "pdf", "git", "file"])
        let five = SidebarModel.folderRows([1, 2, 3, 4, 5]); XCTAssertEqual(five.shown, [1, 2, 3, 4, 5]); XCTAssertFalse(five.more)
        let six = SidebarModel.folderRows([1, 2, 3, 4, 5, 6]); XCTAssertEqual(six.shown, [1, 2, 3, 4]); XCTAssertTrue(six.more)
    }

    func testProjectCounts() {
        let entries = [AgentEntry(id: "x", state: "running")]
        let counts = SidebarModel.projectCounts(agents: [NavAgent(id: "a", projectId: "q", workspaceId: "w", status: "waiting", finished: JSTime.iso(JSTime.now())),
                                                         NavAgent(id: "b", projectId: "q", workspaceId: "w", status: "done")], entries: entries, projectId: "p")
        XCTAssertEqual(counts["q"], AgentSummary(total: 1, running: 0, ready: 1))
        XCTAssertEqual(counts["p"], AgentSummary(total: 1, running: 1, ready: 0))
    }
}

final class RailModelTests: XCTestCase {
    let library = [
        row("n1", "Saving and importing library items", "md", ["note"]),
        row("p1", "ColBERT", "pdf", ["paper"], path: "/Users/h/ColBERT.pdf"),
        row("g1", "VectifyAI/PageIndex", "website", ["git"], url: "https://github.com/VectifyAI/PageIndex"),
        row("w1", "Contextual Retrieval", "website", url: "https://www.anthropic.com/engineering/contextual-retrieval"),
        row("i1", "Attachment 1", "image"),
        row("c1", "problems.csv", "csv", path: "/Users/h/problems.csv"),
        row("f1", "fixtures", "folder", folderPath: "/Users/h/fixtures"),
    ]

    func testLooksAddable() {
        for yes in ["https://example.org/a", "arxiv:2310.05292", "2310.05292v2", "doi:10.1145/3544548.3580919", "git@github.com:o/r.git", "ssh://git@host/o/r", "~/papers/x.pdf", "/Users/h/x", "file:///Users/h/x.html", "\"https://example.org/q\"",
                    "github.com", "github.com/anthropics/claude-code", "www.example.org/a?b=1", "example.co.uk"] { XCTAssertTrue(RailModel.looksAddable(yes), yes) }
        for no in ["", "colbert", "Contextual Retrieval", "notes/today.md", "https://", "a b", "notes.md", "paper.pdf", "localhost", "hello"] { XCTAssertFalse(RailModel.looksAddable(no), no) }
    }

    func testSearch() {
        let inRail: (String) -> Bool = { $0 == "p1" }
        let empty = RailModel.searchRows(query: "", library: library, inRail: inRail)
        XCTAssertEqual(empty.map(\.key), ["g1", "w1", "c1", "f1"])
        XCTAssertEqual(empty.map(\.tag), ["link · git", "link", "csv", "folder"])
        XCTAssertEqual(RailModel.searchRows(query: "retriev", library: library, inRail: inRail).map(\.key), ["w1"])
        XCTAssertEqual(RailModel.searchRows(query: "colbert", library: library, inRail: inRail).map { "\($0.key) \($0.tag)" }, ["p1 here"])
        XCTAssertEqual(RailModel.searchRows(query: "import", library: library, inRail: inRail).first?.key, "n1")
        XCTAssertEqual(RailModel.searchRows(query: "anthropic.com", library: library, inRail: inRail).first?.key, "w1")
        let many = (0..<60).map { row("m\($0)", "Match \($0)", "website", url: "https://example.org/\($0)") }
        XCTAssertEqual(RailModel.searchRows(query: "match", library: many, inRail: inRail).count, 60)
    }

    func testSearchAddress() {
        let inRail: (String) -> Bool = { $0 == "p1" }
        let query = "https://example.org/new-page"
        XCTAssertEqual(RailModel.searchRows(query: query, library: library, inRail: inRail, found: nil).count, 0)
        XCTAssertEqual(RailModel.searchRows(query: query, library: library, inRail: inRail, found: StoreValues.lookup(error: "Nothing is at that path")).count, 0)
        let fresh = RailModel.searchRows(query: query, library: library, inRail: inRail, found: StoreValues.lookup(found: Library.Found(type: "website", tags: [], name: "example.org/new-page", url: query)))
        XCTAssertEqual(fresh.count, 1); XCTAssertEqual(fresh[0].kind, .fresh); XCTAssertEqual(fresh[0].name, "example.org/new-page"); XCTAssertEqual(fresh[0].tag, "new link")
        XCTAssertEqual(RailModel.searchRows(query: "/Users/h/ColBERT.pdf", library: library, inRail: inRail, found: StoreValues.lookup(row: library[1], found: Library.Found(type: "pdf", tags: [], name: ""))).map { "\($0.key) \($0.tag)" }, ["p1 here"])
        XCTAssertEqual(RailModel.searchRows(query: "https://github.com/VectifyAI/PageIndex", library: library, inRail: inRail, found: StoreValues.lookup(row: library[2])).map { "\($0.key) \($0.tag)" }, ["g1 link · git"])
        // a bare address is found as text first, then the row main found for it
        let pages = [row("w1", "Contextual Retrieval", "website", url: "https://www.anthropic.com/news/contextual-retrieval")]
        XCTAssertEqual(RailModel.searchRows(query: "anthropic.com", library: pages, inRail: { _ in false }).map(\.key), ["w1"])
        let both = RailModel.searchRows(query: "anthropic.com", library: pages, inRail: { _ in false }, found: StoreValues.lookup(found: Library.Found(type: "website", tags: [], name: "anthropic.com", url: "https://anthropic.com/")))
        XCTAssertEqual(both.map { "\($0.kind == .item ? "item" : "fresh") \($0.key)" }, ["item w1", "fresh fresh:anthropic.com"])
    }

    func testBodiesAndSummary() {
        let inRail: (String) -> Bool = { $0 == "p1" }
        let summed = library + [row("s1", "Lewis et al.", "website", ["paper"], url: "https://arxiv.org/abs/2005.11401", summary: "Retrieval-Augmented GENERATION for knowledge-intensive tasks.")]
        XCTAssertEqual(RailModel.searchRows(query: "augmented generation", library: summed, inRail: { _ in false }).map(\.key), ["s1"])
        let bodies = RailModel.bodyMaps(StoreValues.bodies(items: ["p1": "Late Interaction over BERT, for passage RETRIEVAL.", "n1": "Notes on retrieval at scale.", "c1": "id,title"]))
        XCTAssertEqual(bodies.items["p1"], "late interaction over bert, for passage retrieval.")
        let found = RailModel.searchRows(query: "retrieval", library: library, inRail: inRail, bodies: bodies)
        XCTAssertEqual(found.map(\.key), ["w1", "n1", "p1"])
        XCTAssertEqual(found.map(\.tag), ["link", "md · note", "here"])
        XCTAssertEqual(RailModel.searchRows(query: "PASSAGE Retrieval", library: library, inRail: inRail, bodies: bodies).map(\.key), ["p1"])
        XCTAssertEqual(RailModel.searchRows(query: "passage retrieval", library: library, inRail: inRail).count, 0)
        for query in ["retrieval", "colbert", "import", "", "xyz"] {
            let before = RailModel.searchRows(query: query, library: library, inRail: inRail).map(\.key)
            XCTAssertEqual(RailModel.searchRows(query: query, library: library, inRail: inRail, bodies: Bodies()).map(\.key), before, query)
        }
    }

    func testLibraryPanelChips() {
        let inRail: (String) -> Bool = { _ in false }
        func day(_ n: Int) -> String { String(format: "2026-10-%02dT00:00:00.000Z", n) }
        let notes = (0..<60).map { row("n\($0)", "Note \($0) on retrieval", "md", ["note"], lastEdited: day(10 + ($0 % 15))) }
        let papers = [3, 1, 5, 2, 4].map { row("p\($0)", "Retrieval paper \($0)", "pdf", ["paper"], lastEdited: day($0)) }
        let all = papers + notes + [row("i1", "Attachment 1", "image", lastEdited: day(30))]
        let recent = RailModel.libraryPanelRows(query: "", library: all, inRail: inRail)
        XCTAssertEqual(recent.count, RailModel.LIBRARY_RECENT)
        XCTAssertTrue(recent.allSatisfy { $0.row?.type == "md" })
        XCTAssertEqual(RailModel.libraryPanelRows(query: "", library: all, chip: "papers", inRail: inRail).map(\.key), ["p5", "p4", "p3", "p2", "p1"])
        XCTAssertEqual(RailModel.libraryPanelRows(query: "", library: all, chip: "notes", inRail: inRail).count, 40)
        XCTAssertEqual(RailModel.libraryPanelRows(query: "retrieval", library: all, chip: "papers", inRail: inRail).map(\.key).sorted(), ["p1", "p2", "p3", "p4", "p5"])
        XCTAssertTrue(RailModel.libraryPanelRows(query: "retrieval", library: all, inRail: inRail).contains { $0.key == "n0" })
        XCTAssertEqual(RailModel.libraryPanelRows(query: "Note 1", library: all, chip: "papers", inRail: inRail).count, 0)
        let fresh = RailModel.libraryPanelRows(query: "https://example.org/new", library: all, chip: "papers", inRail: inRail, found: StoreValues.lookup(found: Library.Found(type: "website", tags: [], name: "New page")))
        XCTAssertEqual(fresh.map(\.kind), [.fresh])
    }

    func testParseSources() {
        func of(_ raw: String) -> [String] { RailModel.parseSources(raw).map { "\($0.text) \($0.ok)" } }
        XCTAssertEqual(of("example.org, https://a.com/x\n~/papers/x.pdf"), ["example.org true", "https://a.com/x true", "~/papers/x.pdf true"])
        XCTAssertEqual(of("github.com/o/r arxiv:2310.05292 doi:10.1145/3544548.3580919"), ["github.com/o/r true", "arxiv:2310.05292 true", "doi:10.1145/3544548.3580919 true"])
        XCTAssertEqual(of("~/Desktop/Screen Shot 2026-10-15.png"), ["~/Desktop/Screen Shot 2026-10-15.png true"])
        XCTAssertEqual(of("~/a.pdf ~/b.pdf"), ["~/a.pdf true", "~/b.pdf true"])
        XCTAssertEqual(of("github.com notes.md"), ["github.com true", "notes.md false"])
        let both = RailModel.parseSources("~/notes/plan.md notes.md")[0]
        XCTAssertEqual(both.text, "~/notes/plan.md notes.md")
        XCTAssertEqual(both.split?.map { "\($0.text) \($0.ok)" }, ["~/notes/plan.md true", "notes.md false"])
        XCTAssertNil(RailModel.parseSources("~/a.pdf")[0].split)
        XCTAssertEqual(RailModel.parseSources("notes.md")[0].why, "\"notes.md\" is not a link or a path")
        XCTAssertEqual(RailModel.parseSources("  \n , ").count, 0)
    }

    func testLetGoNotes() throws {
        func node(_ id: String, context: [String], removed: [String]) throws -> WorkspaceNode {
            try JSONValue.object(["id": .string(id), "name": .string(id), "context": .array(context.map { .string($0) }), "removed": .array(removed.map { .string($0) }),
                                  "picked": [], "chars": 0, "builds": [], "archives": [], "created": .null, "folder": .string(id), "edited": .null, "children": []]).decode(WorkspaceNode.self)
        }
        func note(_ id: String, _ ws: String?) throws -> NoteInfo {
            try JSONValue.object(["id": .string(id), "name": .string(id), "path": .string("\(id).md"), "workspaceId": ws.map { .string($0) } ?? .null,
                                  "created": "2026-10-01T00:00:00.000Z", "lastEdited": "2026-10-01T00:00:00.000Z"]).decode(NoteInfo.self)
        }
        let workspaces = [try node("a", context: [], removed: ["n1", "p1"]), try node("b", context: ["n2"], removed: ["n2x"])]
        let gone = RailModel.letGoNotes(workspaces: workspaces, notes: [try note("n1", "a"), try note("n2", "a")])
        XCTAssertEqual(gone, ["n1"], "a paper in no workspace is still found; a note held elsewhere stays")
    }
}

final class NavModelTests: XCTestCase {
    func place(_ ws: String, _ at: String, _ pid: String = "p") -> RecentPlace { RecentPlace(projectId: pid, workspaceId: ws, at: at, name: ws.uppercased(), path: ws, projectName: pid) }
    func agent(_ id: String, _ ws: String?, _ status: String, _ finished: String?, _ pid: String = "p") -> NavAgent {
        NavAgent(id: id, kind: "bart", projectId: pid, workspaceId: ws, status: status, started: "2026-09-22T10:00:00.000Z", finished: finished, name: ws?.uppercased() ?? "")
    }

    func testNextRecent() {
        let recent = [place("a", "2026-09-22T12:00:00.000Z"), place("b", "2026-09-22T11:00:00.000Z"), place("c", "2026-09-22T10:00:00.000Z")]
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "a"), recent: recent)?.workspaceId, "b")
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "b"), recent: recent)?.workspaceId, "c")
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "c"), recent: recent)?.workspaceId, "a")
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "z"), recent: recent)?.workspaceId, "a")
        let afterEdit = [place("b", "2026-09-22T12:05:00.000Z"), place("a", "2026-09-22T12:00:00.000Z"), place("c", "2026-09-22T10:00:00.000Z")]
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "b"), recent: afterEdit)?.workspaceId, "a")
        XCTAssertNil(NavModel.nextPlace(here: ("p", "a"), recent: [place("a", "2026-09-22T12:00:00.000Z")]))
        XCTAssertNil(NavModel.nextPlace(here: ("p", "a"), recent: []))
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "a"), recent: recent)?.why, "recent")
        XCTAssertEqual(NavModel.nextPlace(here: ("q", "a"), recent: recent)?.workspaceId, "a")
    }

    func testNextAgent() {
        let recent = [place("a", "2026-09-22T12:00:00.000Z"), place("b", "2026-09-22T11:00:00.000Z")]
        let agents = [agent("1", "c", "waiting", "2026-09-22T12:10:00.000Z"), agent("2", "d", "waiting", "2026-09-22T12:02:00.000Z"), agent("3", "e", "running", nil),
                      agent("4", "a", "waiting", "2026-09-22T12:00:00.000Z"), agent("5", "d", "waiting", "2026-09-22T12:05:00.000Z"), agent("6", nil, "waiting", "2026-09-22T11:00:00.000Z")]
        let next = NavModel.nextPlace(here: ("p", "a"), recent: recent, agents: agents)
        XCTAssertEqual(next?.workspaceId, "d"); XCTAssertEqual(next?.why, "agent"); XCTAssertEqual(next?.waiting, 2); XCTAssertEqual(next?.at, "2026-09-22T12:02:00.000Z")
        XCTAssertEqual(NavModel.nextPlace(here: ("p", "a"), recent: recent, agents: agents.filter { $0.workspaceId != "d" && $0.workspaceId != "c" })?.why, "recent")
    }

    func testAgoAndFind() {
        let now = JSTime.ms("2026-09-22T12:00:00.000Z")
        XCTAssertEqual(["2026-09-22T11:59:40.000Z", "2026-09-22T11:56:00.000Z", "2026-09-22T09:00:00.000Z", "2026-09-19T12:00:00.000Z", "nope"].map { NavModel.ago($0, now: now) }, ["now", "4 min", "3 h", "3 d", ""])
        let tree = [ws("1", "User Interface", nil, [ws("2", "Improving workspace navigation"), ws("3", "Focusing the attention of the user")]),
                    ws("4", "Library", nil, [ws("5", "Library context", nil, [ws("6", "Navigation of papers")])])]
        let all = NavModel.flatWorkspaces(tree)
        XCTAssertEqual(all.map { "\($0.id):\($0.above.joined(separator: " / "))" }, ["1:", "2:User Interface", "3:User Interface", "4:", "5:Library", "6:Library / Library context"])
        XCTAssertEqual(NavModel.findWorkspaces(all, "navigation").map(\.id), ["6", "2"])
        XCTAssertEqual(NavModel.findWorkspaces(all, "lib").map(\.id), ["4", "5"])
        XCTAssertEqual(NavModel.findWorkspaces(all, "user attention").map(\.id), ["3"])
        XCTAssertEqual(NavModel.findWorkspaces(all, "  ").count, 0)
    }

    func testPlacesToGo() {
        let recent = [place("a", "2026-09-22T12:00:00.000Z"), place("b", "2026-09-22T11:00:00.000Z"), place("c", "2026-09-22T10:00:00.000Z")]
        let agents = [agent("1", "d", "waiting", "2026-09-22T12:10:00.000Z"), agent("2", "c", "waiting", "2026-09-22T12:02:00.000Z"), agent("3", "e", "running", nil), agent("4", "d", "waiting", "2026-09-22T12:20:00.000Z")]
        let list = NavModel.placesToGo(here: ("p", "a"), recent: recent, agents: agents)
        XCTAssertEqual(list.map { $0.workspaceId! }, ["c", "d", "b"])
        XCTAssertEqual(list.map(\.why), ["agent", "agent", "recent"])
        XCTAssertEqual(list.filter(\.next).map { $0.workspaceId! }, [NavModel.nextPlace(here: ("p", "a"), recent: recent, agents: agents)!.workspaceId!])
        let quiet = NavModel.placesToGo(here: ("p", "b"), recent: recent)
        XCTAssertEqual(quiet.map { $0.workspaceId! }, ["a", "c"])
        XCTAssertEqual(quiet.filter(\.next).map { $0.workspaceId! }, ["c"])
        XCTAssertEqual(NavModel.placesToGo(here: ("p", "a"), recent: [place("a", "2026-09-22T12:00:00.000Z")]).count, 0)
        XCTAssertEqual(NavModel.placesToGo(here: ("q", "a"), recent: recent).count, 3)
    }
}

final class AddOrFindTests: XCTestCase {
    func testNewRow() async throws {
        var calls: [String] = []
        let made = try await AddOrFind.addOrFind("https://example.org/a", add: { calls.append($0); return row("new", "A", "website") }, lookup: { _ in XCTFail("not asked"); return StoreValues.lookup() })
        XCTAssertEqual(made.id, "new"); XCTAssertEqual(calls, ["https://example.org/a"])
    }
    func testHeldRow() async throws {
        var asked: [String] = []
        let held = try await AddOrFind.addOrFind("~/files/Attention.pdf", add: { _ in throw StoreError("Already in the library as “Attention”") },
                                                 lookup: { asked.append($0); return StoreValues.lookup(row: row("held", "Attention", "pdf")) })
        XCTAssertEqual(held.id, "held"); XCTAssertEqual(asked, ["~/files/Attention.pdf"])
        // the EXISTS refusal carries its row: no lookup
        let carried = try await AddOrFind.addOrFind("x", add: { _ in throw StoreError("Already in the library as “B”", code: "EXISTS", row: row("b", "B", "pdf")) }, lookup: { _ in XCTFail(); return StoreValues.lookup() })
        XCTAssertEqual(carried.id, "b")
    }
    func testOtherRefusals() async {
        do { _ = try await AddOrFind.addOrFind("/nowhere", add: { _ in throw StoreError("Nothing at that path") }, lookup: { _ in StoreValues.lookup() }); XCTFail() }
        catch { XCTAssertTrue("\(error)".contains("Nothing at that path")) }
        do { _ = try await AddOrFind.addOrFind("/gone", add: { _ in throw StoreError("Already in the library as “Gone”") }, lookup: { _ in StoreValues.lookup() }); XCTFail() }
        catch { XCTAssertTrue("\(error)".contains("Already in the library as “Gone”")) }
        do { _ = try await AddOrFind.addOrFind("/gone", add: { _ in throw StoreError("Already in the library as “Gone”") }, lookup: { _ in throw StoreError("ipc down") }); XCTFail() }
        catch { XCTAssertTrue("\(error)".contains("Already in the library as “Gone”")) }
    }
}

final class GettingStartedModelTests: XCTestCase {
    func testSteps() {
        XCTAssertEqual(GettingStartedModel.STEPS.map(\.title), ["See what came in", "Brainstorm what to do next", "Find prior work"])
        let state = WalkState(workspaceId: "w", ticked: [1])
        XCTAssertEqual(GettingStartedModel.stepsHere(state, "w").map { [$0.n, $0.shown] }, [[1, 1], [2, 2], [3, 3]])
        XCTAssertEqual(GettingStartedModel.stepsHere(state, "other").count, 0)
        XCTAssertEqual(GettingStartedModel.stepsHere(WalkState(workspaceId: "w", hidden: true), "w").count, 0)
        XCTAssertEqual(GettingStartedModel.stepsHere(nil, "w").count, 0)
        XCTAssertEqual(GettingStartedModel.firstOpen(GettingStartedModel.stepsHere(state, "w"), [1]), 2)
        XCTAssertNil(GettingStartedModel.firstOpen(GettingStartedModel.stepsHere(state, "w"), [1, 2, 3]))
    }
    func testTabsAndMeta() {
        let rows = [row("a", "A note", "md", ["note"]), row("b", "Another", "md", ["note"]), row("c", "A paper", "pdf"), row("d", "A page", "website")]
        let (tabs, total) = GettingStartedModel.libraryTabs(rows)
        XCTAssertEqual(tabs.map { "\($0.id) \($0.label) \($0.count)" }, ["notes Notes 2", "papers Papers 1", "web Web 1"])
        XCTAssertEqual(total, 4)
        XCTAssertEqual(GettingStartedModel.libraryTabs([]).total, 0)
        XCTAssertEqual(GettingStartedModel.stepMeta(1, items: 4), "4 items")
        XCTAssertEqual(GettingStartedModel.stepMeta(1, items: 0), "Library")
        XCTAssertEqual(GettingStartedModel.stepMeta(3, papers: 1), "1 paper")
        XCTAssertEqual(GettingStartedModel.stepMeta(3), ""); XCTAssertEqual(GettingStartedModel.stepMeta(2), "")
    }
    func testDiscoverPapers() {
        let doc = ["@discover how transfer was measured", "bart> ## Start here",
                   "bart> **[Productive failure](https://doi.org/10.1/kapur)** · Kapur et al. · 2008",
                   "bart> **Read:** [Method](https://doi.org/10.1/kapur#find=tested%20on%20new&to=problems)",
                   "bart> **Why:** Struggle first, then tested on new problems.", "bart>",
                   "bart> **[Generative AI can harm learning](https://arxiv.org/abs/2501.1)** · Bastani · 2025",
                   "bart> **Read:** abstract only", "bart> **Why:** Practice with AI, then an exam without it.", "",
                   "bart> **[Productive failure](https://doi.org/10.1/kapur#find=again)** · Kapur et al. · 2008",
                   "A line of mine: **[Not a guide](https://example.org)** · Me · 2026"].joined(separator: "\n")
        XCTAssertEqual(GettingStartedModel.discoverPapers(doc), [
            DiscoverPaper(key: "https://doi.org/10.1/kapur", title: "Productive failure", why: "Struggle first, then tested on new problems.", address: "https://doi.org/10.1/kapur#find=tested%20on%20new&to=problems", byline: "Kapur · 2008 · Method"),
            DiscoverPaper(key: "https://arxiv.org/abs/2501.1", title: "Generative AI can harm learning", why: "Practice with AI, then an exam without it.", address: "https://arxiv.org/abs/2501.1", byline: "Bastani · 2025"),
        ])
        XCTAssertEqual(GettingStartedModel.discoverPapers("").count, 0)
        XCTAssertEqual(GettingStartedModel.discoverPapers(doc, max: 1).count, 1)
    }
}

final class StorageTests: XCTestCase {
    func testKeysRoundTrip() {
        let s = MemoryStorage()
        s.setOpened(["section:projects": false, "folder:x": true])
        XCTAssertEqual(s.opened(), ["section:projects": false, "folder:x": true])
        s.setSlots(["p": ["a", "b"]]); XCTAssertEqual(s.slots(), ["p": ["a", "b"]])
        XCTAssertFalse(s.tourSeen()); s.markTourSeen(); XCTAssertTrue(s.tourSeen())
        XCTAssertEqual(s.values[StorageKeys.tourSeen], "1")
        s.setAgentMarks(["a": AgentMark(clicked: "2026-10-01T00:00:00.000Z")]); XCTAssertEqual(s.agentMarks()["a"]?.clicked, "2026-10-01T00:00:00.000Z")
        s.setVisits("p", [Visit(kind: "note", id: "n", at: "t")]); s.setVisits("q", []); XCTAssertEqual(s.visits("p"), [Visit(kind: "note", id: "n", at: "t")])
        s.set(StorageKeys.open, "not json"); XCTAssertEqual(s.opened(), [:])
    }
}
