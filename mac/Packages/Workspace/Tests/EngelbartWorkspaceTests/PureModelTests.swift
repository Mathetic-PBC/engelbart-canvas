import XCTest
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartSandbox
@testable import EngelbartWorkspace

// The pure models: Workspace.jsx's docOf/restoredTabs/madeAt/copiedLabel/describe, DocTabs' reorder, model/notepick.js
// (test/notepick-model.test.cjs), model/nav.js (test/nav-model.test.cjs), the screen-owned parts of model/sidebar.js and
// model/rail.js, model/getting-started.js, model/zotero.js, and the layout's widths.

final class NotePickTests: XCTestCase {
    func note(_ id: String, _ name: String, _ edited: String) -> LibraryRow { Fx.row(id, name, tags: ["note"], edited: edited) }
    lazy var library: [LibraryRow] = [
        note("a", "Middle Canvas (Workspace or Notes)", "2026-09-20T10:00:00Z"),
        note("b", "Tabs", "2026-09-25T10:00:00Z"),
        note("c", "Canvas ideas", "2026-09-24T10:00:00Z"),
        Fx.row("p", "Canvas paper", type: "pdf", tags: ["paper"]),
    ] + (0..<10).map { i in note("old\(i)", "Old \(i)", "2026-01-0\((i % 9) + 1)T00:00:00Z") }

    func testEmptyNewNoteFirstThenEightWrittenInLast() {
        let rows = NotePick.rows(query: "", library: library)
        XCTAssertEqual(rows[0].kind, .new)
        XCTAssertEqual(rows[0].name, "")
        XCTAssertEqual(rows[1...3].map(\.key), ["b", "c", "a"])
        XCTAssertEqual(rows.count, 1 + NotePick.recent)
    }

    func testTypedOnlyNotesEveryWordStartsFirstNewLast() {
        let rows = NotePick.rows(query: "canvas", library: library)
        XCTAssertEqual(rows.map(\.key), ["c", "a", "new"])
        XCTAssertEqual(rows.last?.name, "canvas")
        XCTAssertEqual(NotePick.rows(query: "canvas notes", library: library).map(\.key), ["a", "new"])
        XCTAssertEqual(NotePick.rows(query: "zzz", library: library).map(\.kind), [.new])
    }

    func testTagsOpenElseHere() {
        let rows = NotePick.rows(query: "canvas", library: library, openIds: ["a"], inRail: { $0 == "c" })
        XCTAssertEqual(rows.filter { $0.kind == .note }.map(\.tag), ["here", "open"])
    }
}

final class TabsModelTests: XCTestCase {
    func testDocOfEachTab() {
        XCTAssertEqual(WorkspaceTabs.docOf("ws", topicId: "w").key, "ws:w")
        XCTAssertEqual(WorkspaceTabs.docOf("ws", topicId: "w").workspaceId, "w")
        XCTAssertEqual(WorkspaceTabs.docOf("ws", topicId: nil), .none)
        XCTAssertEqual(WorkspaceTabs.docOf("project", topicId: "w").ref, .project)
        let a = WorkspaceTabs.docOf("archive:2026-10-01.md", topicId: "w")
        XCTAssertEqual(a.key, "archive:w:2026-10-01.md")
        XCTAssertEqual(a.archive, "2026-10-01.md")
        XCTAssertEqual(a.ref, .archive(workspaceId: "w", file: "2026-10-01.md"))
        XCTAssertNil(a.ref?.store)
        XCTAssertEqual(WorkspaceTabs.docOf("n1", topicId: "w").key, "note:n1")
        XCTAssertEqual(WorkspaceTabs.docOf("n1", topicId: "w").ref?.store, .note(id: "n1"))
    }

    func testRestoredTabsDropGoneNotesAndOtherWorkspacesKeepNames() {
        let view: JSONValue = ["active": "n2", "tabs": [["id": "n1", "title": "Old name"], ["id": "gone", "title": "Gone"], ["id": "w9", "title": "Other", "kind": "workspace"], ["id": "n2", "title": "x"], ["id": "project", "title": ""]]]
        let out = WorkspaceTabs.restoredTabs(view: view, notes: ["n1": "Ideas", "n2": "Tabs"], extra: nil)
        XCTAssertEqual(out.tabs.map(\.id), ["ws", "n1", "n2", "project"])
        XCTAssertEqual(out.tabs.map(\.title), ["Project", "Ideas", "Tabs", "Project page"])
        XCTAssertEqual(out.active, "n2")
        let opened = WorkspaceTabs.restoredTabs(view: view, notes: ["n1": "Ideas"], extra: DocTab(id: "n7", title: "New"))
        XCTAssertEqual(opened.active, "n7", "the note being opened comes in front")
        XCTAssertEqual(WorkspaceTabs.restoredTabs(view: ["active": "gone"], notes: [:], extra: nil).active, "ws")
        XCTAssertEqual(WorkspaceTabs.restoredTabs(view: nil, notes: [:], extra: nil).tabs.map(\.id), ["ws"])
    }

    func testMoveTabNeverWorkspace() {
        let tabs = ["ws", "a", "b", "c"].map { DocTab(id: $0, title: $0) }
        XCTAssertEqual(WorkspaceTabs.moveTab(tabs, "c", over: "a")?.map(\.id), ["ws", "c", "a", "b"])
        XCTAssertEqual(WorkspaceTabs.moveTab(tabs, "a", over: "b")?.map(\.id), ["ws", "b", "a", "c"])
        XCTAssertNil(WorkspaceTabs.moveTab(tabs, "a", over: "ws"))
        XCTAssertNil(WorkspaceTabs.moveTab(tabs, "ws", over: "a"))
        XCTAssertNil(WorkspaceTabs.moveTab(tabs, "a", over: "a"))
    }

    func testCloseTabNeverWorkspaceNorTheLastFrontGoesToTheLast() {
        let tabs = ["ws", "a", "b"].map { DocTab(id: $0, title: $0) }
        XCTAssertNil(WorkspaceTabs.closeTab(tabs, active: "a", "ws"))
        let out = WorkspaceTabs.closeTab(tabs, active: "a", "a")!
        XCTAssertEqual(out.tabs.map(\.id), ["ws", "b"])
        XCTAssertEqual(out.active, "b")
        XCTAssertEqual(WorkspaceTabs.closeTab(tabs, active: "ws", "b")?.active, "ws")
        XCTAssertNil(WorkspaceTabs.closeTab([DocTab(id: "a", title: "a")], active: "a", "a"), "the last tab never closes")
    }

    func testProjectTabTakesTheProjectsName() {
        XCTAssertEqual(WorkspaceTabs.shown([DocTab(id: "project", title: "Old")], projectName: "Thesis").first?.title, "Thesis")
    }

    func testWsLabelCutToWorkspacesLength() {
        XCTAssertEqual(Names.wsLabel("Thesis"), "Thesis")
        XCTAssertEqual(Names.wsLabel("Literature"), "Literatu\u{2026}")
        XCTAssertEqual(Names.wsLabel(""), "Workspace")
    }
}

final class TextModelTests: XCTestCase {
    func testCopiedLabel() {
        XCTAssertEqual(WorkspaceText.copiedLabel(files: 0, missing: 0), "Copied")
        XCTAssertEqual(WorkspaceText.copiedLabel(files: 1, missing: 0), "Copied · 1 file")
        XCTAssertEqual(WorkspaceText.copiedLabel(files: 3, missing: 2), "Copied · 3 files · 2 missing")
    }
    func testPaperFailureDropsNoAnswer() {
        XCTAssertEqual(WorkspaceText.paperFailure(["bart> **No answer.** Claude is signed out."]), "Claude is signed out.")
        XCTAssertEqual(WorkspaceText.paperFailure(nil), "")
    }
    func testHighlightAskIdShape() {
        let id = WorkspaceText.highlightAskId()
        XCTAssertTrue(id.hasPrefix("h"))
        XCTAssertNotNil(Rx(#"^h[0-9a-z]+$"#).match(id))
    }
    func testMadeAt() {
        XCTAssertEqual(MadeRef.at("/Users/h/p/.created/abc-1/charts/a.svg"), MadeRef(askId: "abc-1", rel: "charts/a.svg", name: "a.svg"))
        XCTAssertEqual(MadeRef.at("file:///Users/h/p/.created/abc/page%20one.html")?.rel, "page one.html")
        XCTAssertNil(MadeRef.at("/Users/h/p/.created/abc/../x.html"))
        XCTAssertNil(MadeRef.at("https://example.org"))
    }
    func testEmptyProjectAndCopyTitles() {
        XCTAssertEqual(WorkspaceText.emptyProject("Thesis"), "Nothing in Thesis yet. A project holds a document, its sources, and any projects nested inside it.")
        XCTAssertEqual(WorkspaceText.copyTitle(workspaceDoc: true, projectPage: false), "Copy current project")
        XCTAssertEqual(WorkspaceText.copyTitle(workspaceDoc: false, projectPage: true), "Copy the project page")
        XCTAssertEqual(WorkspaceText.copyTitle(workspaceDoc: false, projectPage: false), "Copy current note")
    }
    func testZoteroChipAction() {
        XCTAssertEqual(ZoteroChip.action(["path": "/z/a.pdf"], name: "A"), .pdf("/z/a.pdf"))
        XCTAssertEqual(ZoteroChip.action(["url": "https://doi.org/1"], name: "A"), .external("https://doi.org/1"))
        XCTAssertEqual(ZoteroChip.action(["url": "ftp://x"], name: "A"), .error("\"A\" could not be opened"))
        XCTAssertEqual(ZoteroChip.action(["error": "Gone"], name: ""), .error("Gone"))
        XCTAssertEqual(ZoteroChip.action(nil, name: ""), .error("\"This item\" could not be opened"))
    }
}

final class RowsModelTests: XCTestCase {
    func testMentionedByNameByIdPicturesById() {
        let lib = [Fx.row("a", "Ideas", tags: ["note"]), Fx.row("b", "Attachment 1", type: "image"), Fx.row("c", "Attachment 1", type: "image"), Fx.row("d", "mqo00/repo", type: "website")]
        let text = "see @[ideas] and ![Attachment 1](img:c) and @[mqo00 repo](lib:d) and @[X](ws:zz) and @[f.pdf](lib:folder1:a/f.pdf)"
        XCTAssertEqual(WorkspaceRows.mentioned(text, library: lib).map(\.id), ["a", "c", "d"])
    }
    func testRailRowsContextThenNotesThenMentionsNeverRemovedOnce() {
        let tree = Fx.tree(nodes: [Fx.node(Fx.w1, "Reading", context: [Fx.pdf, Fx.n2], removed: [Fx.n2])])
        let topic = tree.workspaces[0]
        let mentioned = [Fx.library[1], Fx.library[2]]
        let rows = WorkspaceRows.rail(topic: topic, library: Fx.library, notes: tree.notes, mentioned: mentioned)
        XCTAssertEqual(rows.map(\.id), [Fx.pdf, Fx.n1])
    }
    func testDescribe() {
        let note = Fx.row("a", "Ideas", tags: ["note"], edited: "2026-10-02T09:00:00.000Z")
        XCTAssertEqual(WorkspaceRows.describe(note, projectId: Fx.project).summary, "A note in this project.")
        XCTAssertEqual(WorkspaceRows.describe(note, projectId: "other").summary, "A note in another project.")
        XCTAssertTrue(WorkspaceRows.describe(note, projectId: Fx.project).facts.hasSuffix(" · edited 2026-10-02"))
        var repo = Fx.row("r", "o/r", type: "folder", tags: ["git"]); repo.folderPath = "/code/r"
        XCTAssertEqual(WorkspaceRows.describe(repo, projectId: "").summary, "Cloned at /code/r")
        var site = Fx.row("s", "Site", type: "website", url: "https://x.org"); site.summary = "A blurb"
        XCTAssertEqual(WorkspaceRows.describe(site, projectId: "").summary, "A blurb", "the catalog's summary wins")
    }
    func testImageIdsOncePerId() {
        XCTAssertEqual(WorkspaceRows.imageIds("![a](img:x)\n![b](img:y) ![c](img:x)"), ["x", "y"])
    }
}

final class LayoutModelTests: XCTestCase {
    func testDefaultsAndClamps() {
        let l = WorkspaceLayout(viewWidth: 1440, railWidth: 300, railHidden: false, rightWidth: nil, stageFull: false)
        XCTAssertEqual(l.rail, 300)
        XCTAssertEqual(l.railSpace, 301)
        XCTAssertEqual(l.right, ((1440 - 301 - 1) / 2).rounded(), "half of what the sidebar leaves")
        XCTAssertEqual(WorkspaceLayout(viewWidth: 1440, railWidth: 900, railHidden: false, rightWidth: nil, stageFull: false).rail, 520)
        XCTAssertEqual(WorkspaceLayout(viewWidth: 1440, railWidth: 10, railHidden: false, rightWidth: nil, stageFull: false).rail, 220)
        XCTAssertEqual(WorkspaceLayout(viewWidth: 900, railWidth: 520, railHidden: false, rightWidth: nil, stageFull: false).rail, 298, "room for 280 + 320")
        let narrowRight = WorkspaceLayout(viewWidth: 1440, railWidth: 300, railHidden: false, rightWidth: 100, stageFull: false)
        XCTAssertEqual(narrowRight.right, 320)
        let wideRight = WorkspaceLayout(viewWidth: 1440, railWidth: 300, railHidden: false, rightWidth: 5000, stageFull: false)
        XCTAssertEqual(wideRight.right, 1440 - 301 - 1 - 280)
        let folded = WorkspaceLayout(viewWidth: 1440, railWidth: 300, railHidden: true, rightWidth: nil, stageFull: false)
        XCTAssertEqual(folded.railSpace, 0)
        XCTAssertEqual(folded.right, 720)
        XCTAssertEqual(WorkspaceLayout(viewWidth: 1440, railWidth: 300, railHidden: false, rightWidth: nil, stageFull: true).paneWidth, 1440 - 301)
    }
    func testDragging() {
        XCTAssertEqual(WorkspaceLayout.railDragged(x: 400, viewWidth: 1440, right: 569), 400)
        XCTAssertEqual(WorkspaceLayout.railDragged(x: 1000, viewWidth: 1440, right: 569), 520)
        XCTAssertEqual(WorkspaceLayout.railDragged(x: 500, viewWidth: 1200, right: 569), 1200 - 2 - 280 - 569, "the document keeps 280; the right pane its width")
        XCTAssertEqual(WorkspaceLayout.rightDragged(x: 1000, bodyRight: 1440, rightRoom: 858), 439)
        XCTAssertEqual(WorkspaceLayout.rightDragged(x: 1400, bodyRight: 1440, rightRoom: 858), 320)
    }
}

final class NavModelTests: XCTestCase {
    let P = "p", Q = "q"
    func place(_ w: String, _ at: String, _ p: String = "p") -> JSONValue { ["projectId": .string(p), "workspaceId": .string(w), "at": .string(at), "name": .string(w.uppercased())] }
    func agent(_ id: String, _ w: String?, _ status: String, _ finished: String?, _ p: String = "p") -> JSONValue {
        ["id": .string(id), "kind": "bart", "projectId": .string(p), "workspaceId": w.map { .string($0) } ?? .null, "status": .string(status), "started": "2026-09-22T10:00:00.000Z", "finished": finished.map { .string($0) } ?? .null]
    }

    func testRecentTakeTurns() {
        let recent = [place("a", "2026-09-22T12:00:00.000Z"), place("b", "2026-09-22T11:00:00.000Z"), place("c", "2026-09-22T10:00:00.000Z")]
        XCTAssertEqual(Nav.nextPlace(here: (P, "a"), recent: recent, agents: [])?.workspaceId, "b")
        XCTAssertEqual(Nav.nextPlace(here: (P, "b"), recent: recent, agents: [])?.workspaceId, "c")
        XCTAssertEqual(Nav.nextPlace(here: (P, "c"), recent: recent, agents: [])?.workspaceId, "a")
        XCTAssertEqual(Nav.nextPlace(here: (P, "z"), recent: recent, agents: [])?.workspaceId, "a")
        let afterEdit = [place("b", "2026-09-22T12:05:00.000Z"), place("a", "2026-09-22T12:00:00.000Z"), place("c", "2026-09-22T10:00:00.000Z")]
        XCTAssertEqual(Nav.nextPlace(here: (P, "b"), recent: afterEdit, agents: [])?.workspaceId, "a")
        XCTAssertNil(Nav.nextPlace(here: (P, "a"), recent: [place("a", "2026-09-22T12:00:00.000Z")], agents: []))
        XCTAssertNil(Nav.nextPlace(here: (P, "a"), recent: [], agents: []))
        XCTAssertEqual(Nav.nextPlace(here: (P, "a"), recent: recent, agents: [])?.why, "recent")
        XCTAssertEqual(Nav.nextPlace(here: (Q, "a"), recent: recent, agents: [])?.workspaceId, "a")
    }

    func testWaitingAgentFirstLongestWaiting() {
        let recent = [place("a", "2026-09-22T12:00:00.000Z"), place("b", "2026-09-22T11:00:00.000Z")]
        let agents = [agent("1", "c", "waiting", "2026-09-22T12:10:00.000Z"), agent("2", "d", "waiting", "2026-09-22T12:02:00.000Z"), agent("3", "e", "running", nil),
                      agent("4", "a", "waiting", "2026-09-22T12:00:00.000Z"), agent("5", "d", "waiting", "2026-09-22T12:05:00.000Z"), agent("6", nil, "waiting", "2026-09-22T11:00:00.000Z")]
        let next = Nav.nextPlace(here: (P, "a"), recent: recent, agents: agents)!
        XCTAssertEqual([next.workspaceId, next.why, String(next.waiting), next.at ?? ""], ["d", "agent", "2", "2026-09-22T12:02:00.000Z"])
        XCTAssertEqual(Nav.nextPlace(here: (P, "a"), recent: recent, agents: agents.filter { $0["workspaceId"]?.string != "d" && $0["workspaceId"]?.string != "c" })?.why, "recent")
    }

    func testFlatAndFind() {
        let tree = Fx.tree(nodes: [
            Fx.node("1", "User Interface", children: [Fx.node("2", "Improving workspace navigation"), Fx.node("3", "Focusing the attention of the user")]),
            Fx.node("4", "Library", children: [Fx.node("5", "Library context", children: [Fx.node("6", "Navigation of papers")])]),
        ])
        let all = Nav.flatWorkspaces(tree.workspaces)
        XCTAssertEqual(all.map { "\($0.id):\($0.above.joined(separator: " / "))" }, ["1:", "2:User Interface", "3:User Interface", "4:", "5:Library", "6:Library / Library context"])
        XCTAssertEqual(Nav.findWorkspaces(all, "navigation").map(\.id), ["6", "2"])
        XCTAssertEqual(Nav.findWorkspaces(all, "lib").map(\.id), ["4", "5"])
        XCTAssertEqual(Nav.findWorkspaces(all, "user attention").map(\.id), ["3"])
        XCTAssertEqual(Nav.findWorkspaces(all, "  ").count, 0)
        XCTAssertEqual(Visits.shortcutProjects(tree.workspaces), ["1", "4"])
    }
}

final class AgentsModelTests: XCTestCase {
    let now = WorkspaceTime.ms("2026-10-16T12:00:00.000Z")
    func testEntriesAsksBuildsConnectNewestFirst() {
        let agents: [JSONValue] = [
            ["id": "a1", "kind": "discover", "projectId": "p", "workspaceId": "w", "status": "waiting", "started": "2026-10-16T10:00:00.000Z", "finished": "2026-10-16T11:00:00.000Z"],
            ["id": "a2", "kind": "bart", "projectId": "p", "workspaceId": "w", "status": "running", "started": "2026-10-16T11:30:00.000Z"],
            ["id": "a3", "kind": "bart", "projectId": "q", "workspaceId": "w", "status": "running", "started": "2026-10-16T11:30:00.000Z"],
            ["id": "a4", "kind": "bart", "projectId": "p", "workspaceId": "w", "status": "done", "started": "2026-10-16T11:30:00.000Z"],
        ]
        let builds: [JSONValue] = [["id": "b1", "projectId": "p", "workspaceId": "w", "status": "review", "title": "", "updated": "2026-10-16T11:45:00.000Z"]]
        let connect = [ConnectNote(id: "connect:s1", sessionId: "s1", name: "", at: "2026-10-16T09:00:00.000Z", tone: "warn")]
        let list = Agents.entries(agents: agents, builds: builds, connect: connect, projectId: "p")
        XCTAssertEqual(list.map(\.id), ["build:b1", "agent:a2", "agent:a1", "connect:s1"])
        XCTAssertEqual(list.map(\.state), ["needs", "running", "unseen", "needs"])
        XCTAssertEqual(list[0].title, "Untitled Build")
        XCTAssertEqual(list[0].status, "Ready to review")
        XCTAssertEqual(list[2].title, "Discover")
        XCTAssertEqual(list[3].title, "Import your context")
    }

    func testBuildStates() {
        XCTAssertEqual(["setting-up", "queued", "running", "accepting", "needs-you", "review", "failed", "conflict", "interrupted", "escalated", "accepted", "stopped"].map(Agents.buildState),
                       ["running", "running", "running", "running", "needs", "needs", "failed", "failed", "failed", "failed", "done", "done"])
    }

    func testKeptThreeDaysOrADayAfterAClickDismissedUntilItChanges() {
        func e(_ id: String, _ state: String, _ at: String, kind: String = "bart") -> AgentEntry { AgentEntry(id: id, kind: kind, title: "", node: "w", state: state, at: at) }
        let entries = [e("old", "unseen", "2026-10-12T12:00:00.000Z"), e("new", "unseen", "2026-10-16T11:00:00.000Z"), e("run", "running", "2026-10-01T00:00:00.000Z"),
                       e("clicked", "unseen", "2026-10-15T00:00:00.000Z"), e("away", "failed", "2026-10-16T10:00:00.000Z"), e("build", "running", "2026-10-16T10:00:00.000Z", kind: "build")]
        let marks: [String: [String: String]] = ["clicked": ["clicked": "2026-10-15T06:00:00.000Z"], "away": ["dismissed": "2026-10-16T10:30:00.000Z"], "build": ["dismissed": "2026-10-16T10:30:00.000Z"],
                                                 "new": ["clicked": "2026-10-16T11:30:00.000Z"]]
        let kept = Agents.kept(entries, marks: marks, now: now)
        XCTAssertEqual(kept.map(\.id), ["new", "run", "build"], "3 days, a day past the click, × until it changes; a running Build stays")
        XCTAssertTrue(kept[0].viewed)
        XCTAssertEqual(Agents.summarize(kept), AgentSummary(total: 2, running: 2, ready: 0))
    }

    func testMarkDropsWeekOldMarks() {
        let marks = Agents.mark(["x": ["clicked": "2026-10-01T00:00:00.000Z"], "y": ["clicked": "2026-10-15T00:00:00.000Z"]], "z", "dismissed", at: "2026-10-16T00:00:00.000Z")
        XCTAssertEqual(Set(marks.keys), ["y", "z"])
        XCTAssertEqual(marks["z"]?["dismissed"], "2026-10-16T00:00:00.000Z")
    }

    func testQueueFailedThenNeedsThenFinishedOldestFirst() {
        let tree = Fx.tree()
        let index = WorkspaceIndex(tree.workspaces)
        func e(_ id: String, _ state: String, _ at: String, node: String? = Fx.w1, kind: String = "bart", viewed: Bool = false) -> AgentEntry {
            var x = AgentEntry(id: id, kind: kind, title: "", node: node, state: state, at: at); x.viewed = viewed; return x
        }
        let entries = [e("u2", "unseen", "2026-10-16T02:00:00Z"), e("u1", "unseen", "2026-10-16T01:00:00Z"), e("n", "needs", "2026-10-16T03:00:00Z"), e("f", "failed", "2026-10-16T04:00:00Z"),
                       e("r", "running", "2026-10-16T00:00:00Z"), e("v", "failed", "2026-10-16T00:00:00Z", viewed: true), e("gone", "failed", "2026-10-16T00:00:00Z", node: "zz"),
                       e("c", "needs", "2026-10-16T05:00:00Z", node: nil, kind: "connect")]
        XCTAssertEqual(Agents.queue(entries, last: nil, index: index).map(\.id), ["f", "n", "c", "u1", "u2"])
        XCTAssertEqual(Agents.queue(entries, last: "f", index: index).first?.id, "n", "never the one just gone to")
    }

    func testRollUpCountsUnderEveryAncestor() {
        let tree = Fx.tree()
        let index = WorkspaceIndex(tree.workspaces)
        let counts = Agents.rollUp(index, [AgentEntry(id: "1", kind: "bart", title: "", node: Fx.w3, state: "running", at: nil), AgentEntry(id: "2", kind: "bart", title: "", node: Fx.w1, state: "unseen", at: nil)])
        XCTAssertEqual(counts[Fx.w1], AgentSummary(total: 2, running: 1, ready: 1))
        XCTAssertEqual(counts[Fx.w3], AgentSummary(total: 1, running: 1, ready: 0))
        XCTAssertNil(counts[Fx.w2])
    }

    func testRepoEntries() {
        var state = SandboxNotifications.reduce(SandboxProgressState(dataRoot: "/r"), .progress(["dataRoot": "/r", "message": "", "sandbox": "running",
            "run": ["id": "r1", "library_id": "L", "status": "ready", "created_at": "2026-10-16T00:00:00Z", "updated_at": "2026-10-16T00:00:00Z"]]))
        state = SandboxNotifications.reduce(state, .read(state.notifications.map(\.id)))
        let out = Agents.repoEntries(state.notifications, items: state.items, library: [Fx.row("L", "o/r", type: "folder", tags: ["git"])])
        XCTAssertEqual(out.map(\.id), state.notifications.map { "repo:\($0.id)" })
        XCTAssertEqual(out[0].title, "o/r")
        XCTAssertEqual(out[0].state, "unseen")
        XCTAssertTrue(out[0].viewed, "a read notification is viewed")
    }

    func testVisitsAndOpenings() {
        let v = Visits.visited([Visit(kind: "note", id: "a", at: "1"), Visit(kind: "project", id: "b", at: "2")], kind: "note", id: "a", at: "3")
        XCTAssertEqual(v.map(\.id), ["a", "b"])
        XCTAssertEqual(v[0].at, "3")
        let rows = [Fx.row("x", "X"), Fx.row("y", "Y"), Fx.row("z", "Z")]
        XCTAssertEqual(Visits.byOpened(rows, ["z": "2026-10-16T00:00:00Z", "y": "2026-10-15T00:00:00Z"]).map(\.id), ["z", "y", "x"])
        let opened = Visits.noteOpened(["a": "2026-01-01T00:00:00Z", "b": "2026-01-02T00:00:00Z"], "c", at: "2026-01-03T00:00:00Z", max: 2)
        XCTAssertEqual(Set(opened.keys), ["b", "c"])
    }
}

final class MentionRowsTests: XCTestCase {
    let lib: [LibRow] = [
        LibRow(id: "1", name: "Kapur productive failure", type: "pdf", tags: ["paper"]),
        LibRow(id: "2", name: "Notes on failure", type: "md", tags: ["note"]),
        LibRow(id: "3", name: "Attachment 1", type: "image"),
        LibRow(id: "4", name: "Zebra", type: "website", url: "https://failure.example"),
    ]
    let spaces = [Nav.Flat(id: "a", name: "Alpha", above: []), Nav.Flat(id: "b", name: "Beta", above: ["Alpha"]), Nav.Flat(id: "c", name: "Gamma", above: []), Nav.Flat(id: "d", name: "Delta", above: [])]

    func testEmptyVerbsThenThreeWorkspacesThenLibraryPicturesLast() {
        let rows = MentionRows.rows(query: "", library: lib, page: nil, pageRow: nil, workspaces: spaces, hereId: "a", bodies: nil, zotero: false, here: nil)
        XCTAssertEqual(rows.prefix(6).map(\.key), ["verb:bart", "verb:chat", "verb:brainstorm", "verb:discover", "verb:create", "verb:note"])
        XCTAssertEqual(rows[6...8].map(\.key), ["ws:b", "ws:c", "ws:d"], "never here; three before typing")
        XCTAssertEqual(rows[6].hint, "Alpha")
        XCTAssertEqual(rows.suffix(4).map(\.key), ["1", "2", "4", "3"])
    }
    func testTypedRankedNamesFirstAndVerbsByFirstLetter() {
        let rows = MentionRows.rows(query: "fail", library: lib, page: nil, pageRow: nil, workspaces: spaces, hereId: nil, bodies: nil, zotero: false, here: nil)
        XCTAssertEqual(rows.map(\.key), ["1", "2", "4"], "names that hold it, then where it is")
        XCTAssertEqual(MentionRows.rows(query: "b", library: [], page: nil, pageRow: nil, workspaces: spaces, hereId: nil, bodies: nil, zotero: false, here: nil).map(\.key), ["verb:bart", "verb:brainstorm", "ws:b"])
    }
    func testHereFirstThePageAndZotero() {
        let rows = MentionRows.rows(query: "", library: lib, page: .init(input: "https://example.org/a", title: "A page"), pageRow: nil, workspaces: [], hereId: nil, bodies: nil, zotero: true, here: ["2"])
        XCTAssertEqual(rows[6].kind, .fresh)
        XCTAssertEqual(rows[6].input, "https://example.org/a")
        XCTAssertEqual(rows[7].key, "zotero")
        XCTAssertEqual(rows[8].key, "2", "what this workspace holds first")
        let withRow = MentionRows.rows(query: "", library: lib, page: .init(input: "https://failure.example", title: "Zebra"), pageRow: lib[3], workspaces: [], hereId: nil, bodies: nil, zotero: false, here: nil)
        XCTAssertEqual(withRow[6].key, "4")
        XCTAssertEqual(withRow.filter { $0.key == "4" }.count, 1)
    }
    func testBodiesComeAfterNames() {
        let bodies = MentionRows.Bodies(items: ["3": "about Failure modes"], workspaces: ["c": "failure here"])
        let rows = MentionRows.rows(query: "failure", library: lib, page: nil, pageRow: nil, workspaces: spaces, hereId: nil, bodies: bodies, zotero: false, here: nil)
        XCTAssertEqual(rows.map(\.key), ["ws:c", "1", "2", "4", "3"], "names, then where it is, then only what it says")
    }
    func testMentionName() {
        XCTAssertEqual(MentionRows.mentionName("  [A]   page  "), "A page")
        XCTAssertEqual(MentionRows.mentionName(""), "Untitled page")
    }
    func testPickedChanges() {
        let out = MentionRows.pickedChanges(before: ["a", "b", "c"], after: ["b", "d"], picked: ["a", "c"], dropped: ["d"])
        XCTAssertEqual(out.unlink, ["a", "c"])
        XCTAssertEqual(out.relink, ["d"])
        XCTAssertEqual(MentionRows.pickedChanges(before: ["a"], after: [], picked: [], dropped: []).unlink, [], "linked from the sidebar: left alone")
    }
    func testLetGoNotes() {
        let tree = Fx.tree(nodes: [Fx.node("w1", "A", context: [], removed: ["n1"]), Fx.node("w2", "B", context: ["n2"], removed: [])],
                           notes: [["id": "n1", "name": "x", "path": "/x", "workspaceId": "w1", "created": "", "lastEdited": ""], ["id": "n3", "name": "y", "path": "/y", "workspaceId": .null, "created": "", "lastEdited": ""]])
        XCTAssertEqual(MentionRows.letGoNotes(tree.workspaces, notes: tree.notes), ["n1"])
    }
}

final class WalkthroughTests: XCTestCase {
    func testShowsOnlyInTheWelcomeWorkspaceUnlessHidden() {
        XCTAssertTrue(Walkthrough.shows(["workspaceId": "w", "ticked": [], "hidden": false], workspaceId: "w"))
        XCTAssertFalse(Walkthrough.shows(["workspaceId": "w", "hidden": true], workspaceId: "w"))
        XCTAssertFalse(Walkthrough.shows(["workspaceId": "w"], workspaceId: "v"))
        XCTAssertFalse(Walkthrough.shows(nil, workspaceId: "w"))
    }
    func testChanged() {
        XCTAssertEqual(Walkthrough.changed([1], hiddenNow: false, tick: [2, 1], untick: [], hidden: false)?.ticked, [1, 2])
        XCTAssertEqual(Walkthrough.changed([1, 2], hiddenNow: false, tick: [], untick: [1], hidden: false)?.ticked, [2])
        XCTAssertNil(Walkthrough.changed([1], hiddenNow: false, tick: [1], untick: [], hidden: false))
        XCTAssertNil(Walkthrough.changed([], hiddenNow: true, tick: [1], untick: [], hidden: false))
    }
    func testDiscoverPapers() {
        let text = [
            "@discover x",
            "bart> **[Productive failure](https://doi.org/10.1/pf#x)** · Kapur et al. · 2008",
            "bart> **Read:** [Method](https://doi.org/10.1/pf#find=a)",
            "bart> **Why:** It argues the point.",
            "bart> **[Productive failure](https://doi.org/10.1/pf)** · again",
            "plain line",
            "bart> **Why:** not this one",
        ].joined(separator: "\n")
        let papers = Walkthrough.discoverPapers(text)
        XCTAssertEqual(papers.count, 1)
        XCTAssertEqual(papers[0].title, "Productive failure")
        XCTAssertEqual(papers[0].byline, "Kapur · 2008 · Method")
        XCTAssertEqual(papers[0].why, "It argues the point.")
        XCTAssertEqual(papers[0].address, "https://doi.org/10.1/pf#find=a")
    }
}
