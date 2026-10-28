import XCTest
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartEditor
@testable import EngelbartWorkspace

// Workspace.jsx's logic with a fake api: opening, tabs and views, documents (read once, saved 400 ms after the last edit,
// another window's save, Keep mine / Take theirs), @bart (answers placed, --build, the router's fallback, a Build from a
// line), Builds, Clear / Copy, agents and ⌘J, revealAsk, notes, links and mentions.

@MainActor
final class WorkspaceModelTests: XCTestCase {
    var api: FakeAPI!
    var hub: EventHub!
    override func setUp() async throws { api = FakeAPI(); hub = EventHub() }

    func make(_ entry: WorkspaceEntry = WorkspaceEntry(workspaceId: Fx.w1), tree: ProjectTree = Fx.tree()) -> WorkspaceModel {
        let m = WorkspaceModel(Fx.context(api, tree: tree, entry: entry, hub: hub))
        m.start()
        return m
    }

    func testOpensOnTheEntryWorkspaceElseTheFirstAndReportsIt() async {
        let m = make(WorkspaceEntry(workspaceId: Fx.w2))
        XCTAssertEqual(m.topicId, Fx.w2)
        XCTAssertEqual(api.visits, [Fx.w2])
        let gone = make(WorkspaceEntry(workspaceId: "zz"))
        XCTAssertEqual(gone.topicId, Fx.w1, "an id that is gone falls back to the first")
        let empty = make(tree: Fx.tree(nodes: []))
        XCTAssertNil(empty.topicId)
        XCTAssertEqual(empty.paneDocs[0], .none)
    }

    func testViewsRestoreTabsAndTheOpenedNoteComesInFront() async {
        let views: [String: JSONValue] = [Fx.w1: ["active": .string(Fx.n1), "tabs": [["id": .string(Fx.n1), "title": "Old"], ["id": "gone", "title": "x"]], "positions": [:]]]
        let m = make(WorkspaceEntry(workspaceId: Fx.w1, views: views))
        XCTAssertEqual(m.tabs.map(\.id), ["ws", Fx.n1])
        XCTAssertEqual(m.tabs[1].title, "Ideas", "the note's current name")
        XCTAssertEqual(m.activeTab, Fx.n1)
        let opened = make(WorkspaceEntry(workspaceId: Fx.w1, tab: DocTab(id: Fx.n2, title: "Untitled Note 1"), views: views))
        XCTAssertEqual(opened.activeTab, Fx.n2)
    }

    func testTabsOpenCloseMoveAndTheViewIsSavedLater() async {
        let m = make()
        m.openTab(Fx.n1, title: "Ideas")
        m.openTab(Fx.n2, title: "Untitled Note 1", behind: true)
        XCTAssertEqual(m.activeTab, Fx.n1)
        m.openTab(Fx.n1, title: "Ideas")
        XCTAssertEqual(m.tabs.count, 3, "an open note is not opened twice")
        m.moveTab(Fx.n2, over: Fx.n1)
        XCTAssertEqual(m.tabs.map(\.id), ["ws", Fx.n2, Fx.n1])
        m.closeTab(Fx.n1)
        XCTAssertEqual(m.activeTab, Fx.n2, "the one in front closing puts the last in front")
        m.closeTab("ws")
        XCTAssertEqual(m.tabs.first?.id, "ws")
        XCTAssertTrue(api.views.isEmpty, "saved a moment later")
        await settle(0.6)
        let last = api.views.last
        XCTAssertEqual(last?.wid, Fx.w1)
        XCTAssertEqual(last?.view["active"]?.string, Fx.n2)
        XCTAssertEqual(last?.view["tabs"]?.array?.compactMap { $0["id"]?.string }, [Fx.n2])
    }

    func testGoingToAnotherWorkspaceRestoresWhatItHadAndItsOwnNameShowsItsDocument() async {
        let m = make()
        m.openTab(Fx.n1, title: "Ideas")
        m.selectTopic(Fx.w2)
        XCTAssertEqual(m.tabs.map(\.id), ["ws"])
        m.selectTopic(Fx.w1)
        XCTAssertEqual(m.tabs.map(\.id), ["ws", Fx.n1])
        XCTAssertEqual(m.activeTab, Fx.n1)
        m.selectTopic(Fx.w1)
        XCTAssertEqual(m.activeTab, "ws", "its own name again opens its document")
        XCTAssertEqual(api.visits, [Fx.w1, Fx.w2, Fx.w1])
    }

    func testDocumentsAreReadOnceMigratedAndSaved400msAfterTheLastEdit() async {
        api.docsOnDisk["ws:\(Fx.w1)"] = "@bart old question\nbart> answer"
        let m = make()
        await settle()
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "@chat old question\nbart> answer", "an answered @bart line becomes @chat (2026-10-12)")
        await settle(0.5)
        XCTAssertEqual(api.writes.last?.text, "@chat old question\nbart> answer", "saved as an ordinary edit")
        let before = api.writes.count
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "one")
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "one two")
        await settle(0.2)
        XCTAssertEqual(api.writes.count, before, "not yet")
        await settle(0.4)
        XCTAssertEqual(api.writes.count, before + 1)
        XCTAssertEqual(api.writes.last?.text, "one two")
        XCTAssertEqual(api.edits, [Fx.w1], "typing records the workspace written in, once within 30 s")
    }

    func testAnArchiveIsReadOnlyAndNeverSaved() async {
        let m = make()
        m.openTab("archive:2026-10-01.md", title: "1 Oct")
        await settle()
        XCTAssertEqual(m.docs["archive:\(Fx.w1):2026-10-01.md"], "archived 2026-10-01.md")
        m.onDocChange(key: "archive:\(Fx.w1):2026-10-01.md", ref: .archive(workspaceId: Fx.w1, file: "2026-10-01.md"), text: "changed")
        await settle(0.5)
        XCTAssertFalse(api.writes.contains { $0.text == "changed" })
    }

    func testAnotherWindowsSaveIsTakenElseTheNoticeKeepMineTakeTheirs() async {
        api.docsOnDisk["ws:\(Fx.w1)"] = "mine"
        let m = make()
        await settle()
        hub.post("doc:changed", ["projectId": .string(Fx.project), "key": .string("ws:\(Fx.w1)"), "text": "theirs", "revision": 5])
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "theirs", "no edits waiting: taken")
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "mine again", typed: false)
        hub.post("doc:changed", ["projectId": .string(Fx.project), "key": .string("ws:\(Fx.w1)"), "text": "theirs again", "revision": 6])
        XCTAssertNotNil(m.conflicts["ws:\(Fx.w1)"], "edits waiting: the notice")
        await settle(0.6)
        XCTAssertFalse(api.writes.contains { $0.text == "mine again" }, "their save waits for an answer")
        m.keepMine("ws:\(Fx.w1)")
        await settle()
        XCTAssertEqual(api.writes.last?.text, "mine again")
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "draft", typed: false)
        hub.post("doc:changed", ["projectId": .string(Fx.project), "key": .string("ws:\(Fx.w1)"), "text": "final", "revision": 100])
        m.takeTheirs("ws:\(Fx.w1)")
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "final")
        await settle(0.6)
        XCTAssertFalse(api.writes.contains { $0.text == "draft" }, "their version drops the edits")
    }

    func testAskPlacesTheAnswerInWhateverTheDocumentSaysNow() async {
        api.docsOnDisk["ws:\(Fx.w1)"] = ""
        let m = make()
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "@chat why\nbart~> a1\nmore", typed: false)
        api.askAnswer = { _ in ["lines": ["bart> Because."], "meta": [:]] }
        await m.askBart(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), AskRequest(askId: "a1", text: "why", turns: [], agent: "bart", placeLine: 0, placeText: "@chat why"))
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "@chat why\nbart> Because.\nmore")
        XCTAssertEqual(api.asked.first?["workspaceId"]?.string, Fx.w1)
        XCTAssertEqual(api.asked.first?["ref"]?["kind"]?.string, "workspace")
        XCTAssertEqual(api.asked.first?["place"]?["text"]?.string, "@chat why")
        XCTAssertTrue(api.writes.contains { $0.text.contains("bart~> a1") }, "saved before the agent reads it")
        XCTAssertNil(m.asks["a1"], "the run's row goes when it ends")
    }

    func testStoppedFailedAndProgress() async {
        let m = make()
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "@chat a\nbart~> s1", typed: false)
        api.askAnswer = { [hub] _ in
            hub!.post("engelbart:bart-progress", ["askId": "s1", "step": 1, "name": "Sonnet", "effort": "low"])
            hub!.post("engelbart:bart-progress", ["askId": "s1", "activity": "Reading", "log": true])
            return ["stopped": true]
        }
        let ask = Task { await m.askBart(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), AskRequest(askId: "s1", text: "a", turns: [], agent: "bart", placeLine: 0, placeText: "@chat a")) }
        await settle(0.02)
        await ask.value
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "@chat a", "Stop removes the line")
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "@chat b\nbart~> f1", typed: false)
        api.askAnswer = { _ in throw WorkspaceError("Claude is signed out") }
        await m.askBart(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), AskRequest(askId: "f1", text: "b", turns: [], agent: "bart", placeLine: 0, placeText: "@chat b"))
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "@chat b\nbart> **No answer.** Claude is signed out")
    }

    func testProgressUpdatesTheRunsRow() async {
        let m = make()
        m.askStarted("p1", docKey: "ws:\(Fx.w1)", agent: "bart")
        hub.post("engelbart:bart-progress", ["askId": "p1", "step": 1, "name": "Sonnet", "effort": "low"])
        hub.post("engelbart:bart-progress", ["askId": "p1", "activity": "Reading the paper", "log": true])
        XCTAssertEqual(m.asks["p1"]?.progress.name, "Sonnet")
        XCTAssertEqual(m.asks["p1"]?.progress.activity, "Reading the paper")
        XCTAssertEqual(m.asks["p1"]?.progress.log, ["Reading the paper"])
    }

    func testBuildFlagStartsABuildInThePendingLinesPlace() async {
        let m = make()
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "@bart --build a login page\nbart~> k1", typed: false)
        await m.askBart(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), AskRequest(askId: "k1", text: "--build a login page", turns: [], agent: "bart", placeLine: 0, placeText: "@bart --build a login page"))
        XCTAssertEqual(api.buildsStarted.first?["text"]?.string, "a login page")
        XCTAssertEqual(api.buildsStarted.first?["fromLine"]?.bool, true)
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "@bart --build a login page\nbuild> b1")
        XCTAssertNotNil(m.builds["b1"])
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "@bart --build\nbart~> k2", typed: false)
        await m.askBart(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), AskRequest(askId: "k2", text: "--build", turns: [], agent: "bart", placeLine: 0, placeText: "@bart --build"))
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "@bart --build\nbart> **No Build.** Write what to build after --build.")
    }

    func testTheRoutersFallbackSaysWhy() async {
        let m = make()
        api.routeFails = true
        let pick = await m.routeLine(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), RouteAsk(askId: "r1", text: "hi", inputs: Route.routeInputs(["@bart hi"], 0), rule: nil, placeLine: 0, placeText: "@bart hi"))
        XCTAssertEqual(pick.by, "error")
        XCTAssertEqual(pick.error, "router down")
        XCTAssertEqual(pick.agent, "chat")
        XCTAssertEqual(m.asks["r1"]?.progress.agent, "router", "the pending row says Thinking until it is handed over")
        api.routeFails = false
        api.routeAnswer = ["agent": "discover", "sure": 0.9, "by": "model", "id": "route-1"]
        let ok = await m.routeLine(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), RouteAsk(askId: "r2", text: "papers", inputs: Route.routeInputs(["@bart papers"], 0), rule: nil, placeLine: 0, placeText: "@bart papers"))
        XCTAssertEqual(ok.agent, "discover")
        XCTAssertEqual(ok.id, "route-1")
        m.routeGone("r2")
        XCTAssertNil(m.asks["r2"])
    }

    func testFooterBuildGoesAfterTheThreadFoundByItsWords() async {
        let m = make()
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "top\n@chat q\nbart> a\n\n", typed: false)
        var b = BuildAsk(text: "make it", after: 9, afterLine: "bart> a", placeLine: 2, placeText: "bart> a")
        await m.buildFromEditor(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), b)
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "top\n@chat q\nbart> a\nbuild> b1\n\n")
        b.afterLine = "nowhere"
        await m.buildFromEditor(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), b)
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "top\n@chat q\nbart> a\nbuild> b1\nbuild> b2", "not found: at the end")
    }

    func testBuildEventsProgressAndCardActions() async {
        let m = make()
        hub.post("engelbart:build", ["id": "b9", "projectId": .string(Fx.project), "status": "running", "title": "T"])
        hub.post("engelbart:build", ["id": "x", "projectId": "other", "status": "running"])
        XCTAssertNotNil(m.builds["b9"]); XCTAssertNil(m.builds["x"])
        hub.post("engelbart:build-progress", ["projectId": .string(Fx.project), "id": "b9", "activity": "Editing", "log": true])
        XCTAssertEqual(m.buildProgress["b9"]?["activity"]?.string, "Editing")
        XCTAssertEqual(m.buildProgress["b9"]?["log"]?.array?.count, 1)
        hub.post("engelbart:build", ["id": "b9", "projectId": .string(Fx.project), "status": "review", "title": "T"])
        XCTAssertNil(m.buildProgress["b9"], "a turn that ended leaves nothing to show")
        let accepted = await m.onBuildAction("b9", "accept")
        XCTAssertTrue(accepted, "Accept's refusal is the card's to say")
        await m.onBuildAction("b9", "reject")
        XCTAssertEqual(m.rejecting?.id, "b9")
        await m.onBuildAction("b9", "review")
        XCTAssertEqual(m.review?.id, "b9")
        XCTAssertEqual(m.review?.review, api.reviewAnswer)
        hub.post("engelbart:build", ["id": "b9", "projectId": .string(Fx.project), "status": "review", "runStep": ["runnables": [["name": "web", "type": "ui", "status": "running"]]]])
        m.closeReview()
        await m.onBuildAction("b9", "review")
        XCTAssertNil(m.review, "what runs opens in the Stage instead")
        XCTAssertTrue(api.buildCalls.contains("runshow:web"))
    }

    func testStartBuildAppendsItsLineAndClears() async {
        api.docsOnDisk["ws:\(Fx.w1)"] = "the spec\n\n"
        let m = make()
        await settle()
        try? await m.startBuild(["provider": "claude", "attach": []], clear: false)
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "the spec\n\nbuild> b1\n")
        try? await m.startBuild(["provider": "claude"], clear: true)
        XCTAssertEqual(api.cleared, [Fx.w1])
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "")
    }

    func testClearIsRefusedDuringAConflictAndCopySaysWhatItDid() async {
        let m = make()
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "x", typed: false)
        hub.post("doc:changed", ["projectId": .string(Fx.project), "key": .string("ws:\(Fx.w1)"), "text": "y", "revision": 50])
        await m.clearDoc()
        XCTAssertEqual(api.errors.last, "This document was changed in another window: keep yours or take theirs first.")
        XCTAssertTrue(api.cleared.isEmpty)
        await m.copyDoc()
        XCTAssertNotNil(m.copied)
        XCTAssertEqual(WorkspaceText.copiedLabel(files: m.copied!.files, missing: m.copied!.missing), "Copied · 2 files · 1 missing")
        await settle(1.9)
        XCTAssertNil(m.copied, "for 1.8 s")
    }

    func testRestoreShowsTheWorkspaceTab() async {
        let m = make()
        m.openTab("archive:old.md", title: "old")
        await m.restoreVersion("old.md")
        XCTAssertEqual(m.activeTab, "ws")
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "restored old.md")
    }

    func testThePaneBesideOpensReplacesClosesWithTheTab() async {
        let m = make()
        XCTAssertEqual(m.openDocBeside(kind: "note", id: Fx.n1, name: "Ideas", link: "Ideas"), 1)
        XCTAssertEqual(m.paneDocs.map(\.key), ["ws:\(Fx.w1)", "note:\(Fx.n1)"])
        XCTAssertEqual(m.openDocBeside(kind: "workspace", id: Fx.w1, name: "", link: Fx.w1), 0, "the document in front is not opened again")
        XCTAssertNil(m.openDocBeside(kind: "workspace", id: "gone", name: "", link: ""))
        m.openDocBeside(kind: "workspace", id: Fx.w2, name: "", link: Fx.w2)
        XCTAssertEqual(m.beside.map(\.id), [Fx.w2])
        XCTAssertEqual(m.beside.first?.title, "Writing")
        m.openTab(Fx.n2, title: "Untitled Note 1")
        XCTAssertTrue(m.beside.isEmpty, "switching tab closes it")
        m.openDocBeside(kind: "note", id: Fx.n1, name: "Ideas", link: "Ideas")
        m.closeBeside(1)
        XCTAssertTrue(m.beside.isEmpty)
    }

    func testCitationOpensBesideAndLightsThePassage() async {
        let m = make()
        let editor = FakeEditor("note:\(Fx.n1)", ["# Ideas", "the quoted words are here"])
        m.editors = { [editor] }
        api.docsOnDisk["note:\(Fx.n1)"] = "# Ideas\nthe quoted words are here"
        XCTAssertTrue(m.openIfCited("/tmp/root/Thesis/notes/Ideas.md#cite=you&find=quoted%20words"))
        XCTAssertEqual(m.beside.first?.id, Fx.n1)
        await settle(0.4)
        XCTAssertEqual(editor.passages.first?.0, 1)
    }

    func testNextAgentFailedFirstThenTheNextPlace() async {
        api.navState = NavState(recent: [["projectId": .string(Fx.project), "workspaceId": .string(Fx.w2), "at": "2026-10-16T00:00:00Z"]],
                                agents: [["id": "a1", "kind": "bart", "projectId": .string(Fx.project), "workspaceId": .string(Fx.w2), "status": "waiting",
                                          "started": .string(WorkspaceTime.iso()), "finished": .string(WorkspaceTime.iso()), "doc": ["kind": "workspace", "workspaceId": .string(Fx.w2)]]])
        let m = make()
        await settle()
        XCTAssertEqual(m.entries.map(\.id), ["agent:a1"])
        m.goNextAgent()
        XCTAssertEqual(m.topicId, Fx.w2, "the agent waiting")
        await settle()
        XCTAssertTrue(api.seen.contains(Fx.w2), "being there is looking at what it left")
        XCTAssertTrue(m.entries.first?.viewed ?? false, "clicked: viewed")
        api.navState = NavState(recent: [["projectId": .string(Fx.project), "workspaceId": .string(Fx.w1), "at": "2026-10-16T00:00:00Z"]])
        hub.post("engelbart:nav")
        await settle()
        m.goNextAgent()
        XCTAssertEqual(m.topicId, Fx.w1, "nothing waiting: the workspace written in before")
    }

    func testRevealAskShowsTheLineOrSaysItIsGone() async {
        let m = make()
        let editor = FakeEditor("ws:\(Fx.w2)", ["a", "@chat the line", "bart> x"])
        m.editors = { [editor] }
        api.docsOnDisk["ws:\(Fx.w2)"] = "a\n@chat the line\nbart> x"
        m.revealAsk(["place": ["projectId": .string(Fx.project), "ref": ["kind": "workspace", "workspaceId": .string(Fx.w2)], "text": "@chat the line", "line": 1]])
        XCTAssertEqual(m.topicId, Fx.w2)
        await settle(0.4)
        XCTAssertEqual(editor.shown.first?.0, 1)
        XCTAssertEqual(editor.shown.first?.1, true)
        m.revealAsk(["place": ["projectId": .string(Fx.project), "ref": ["kind": "note", "id": "gone"]]])
        XCTAssertEqual(api.errors.last, "This note is no longer here")
        m.revealAsk(["place": ["projectId": .string(Fx.project), "ref": ["kind": "workspace", "workspaceId": "gone"]]])
        XCTAssertEqual(api.errors.last, "This workspace is no longer here")
        m.revealAsk(["place": ["projectId": .string(Fx.project), "ref": ["kind": "mark", "id": "m", "rowId": "gone"]]])
        XCTAssertEqual(api.errors.last, "This highlight's paper is no longer here")
        m.revealAsk(["place": ["projectId": .string(Fx.project), "ref": ["kind": "workspace", "workspaceId": .string(Fx.w2)], "text": "not there"]])
        await settle(0.4)
        XCTAssertEqual(api.errors.last, "This line is no longer here")
    }

    func testCtrlShortcutsAndRailFlags() async {
        let m = make()
        XCTAssertTrue(m.goShortcut(2))
        XCTAssertEqual(m.topicId, Fx.w2)
        XCTAssertFalse(m.goShortcut(5))
        XCTAssertFalse(m.railHidden)
        m.toggleRail()
        XCTAssertTrue(m.railHidden)
        XCTAssertEqual(m.ctx.storage.string(forKey: "engelbart.sidebar.hidden"), "1", "remembered across launches")
        let again = WorkspaceModel(m.ctx)
        XCTAssertTrue(again.railHidden)
    }

    func testFullScreensTurnEachOtherOff() async {
        let m = make()
        m.toggleDocFull()
        XCTAssertTrue(m.docFull)
        m.toggleStageFull()
        XCTAssertTrue(m.stageFull); XCTAssertFalse(m.docFull)
        m.toggleDocFull()
        XCTAssertFalse(m.stageFull); XCTAssertTrue(m.docFull)
        m.showRight("terminal")
        XCTAssertFalse(m.docFull, "what opens on the right brings the pane back")
        XCTAssertEqual(m.rightMode, "terminal")
    }

    func testNotesMadeLinkedAndOpenedLinksFlash() async {
        let m = make()
        _ = try? await m.makeNote("", open: true)
        XCTAssertEqual(api.notesMade, ["Untitled Note 2"], "the next free Untitled Note n")
        XCTAssertEqual(api.linked.last?.ids, ["eeeeeeee-0000-4000-8000-000000000001"])
        XCTAssertTrue(m.wantTitleFocus)
        XCTAssertEqual(m.activeTab, "eeeeeeee-0000-4000-8000-000000000001")
        XCTAssertEqual(m.flashId, "eeeeeeee-0000-4000-8000-000000000001")
        m.wantTitleFocus = false
        _ = try? await m.makeNote("From the menu", open: false)
        XCTAssertEqual(m.activeTab, "eeeeeeee-0000-4000-8000-000000000001", "@Note opens it behind")
        XCTAssertFalse(m.wantTitleFocus)
    }

    func testAddOrFindAnswersWithTheLibrarysRow() async throws {
        let m = make()
        api.addAnswer = { _ in throw WorkspaceError("Already in the library as “Kapur 2008”") }
        api.lookups["https://x.org/p.pdf"] = LibraryLookup(row: Fx.library[2])
        let row = try await m.addInput("https://x.org/p.pdf", folderId: nil)
        XCTAssertEqual(row.id, Fx.pdf)
        XCTAssertEqual(api.linked.last?.ids, [Fx.pdf])
        api.addAnswer = { _ in throw WorkspaceError("Nothing is at that path") }
        do { _ = try await m.addInput("/nope", folderId: nil); XCTFail("refused") } catch { XCTAssertEqual(WorkspaceModel.message(of: error), "Nothing is at that path") }
    }

    func testUnmentionUnlinksAPickedItemAndRelinksOnUndo() async {
        let tree = Fx.tree(nodes: [Fx.node(Fx.w1, "Reading", context: [Fx.pdf], picked: [Fx.pdf])])
        let m = make(tree: tree)
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "see @[Kapur 2008]", typed: false)
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "see ", typed: false)
        await settle()
        XCTAssertEqual(api.unlinked.last?.id, Fx.pdf)
        XCTAssertEqual(api.unlinked.last?.unmentioned, true)
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "see @[Kapur 2008]", typed: false)
        await settle()
        XCTAssertEqual(api.linked.last?.ids, [Fx.pdf])
        XCTAssertEqual(api.linked.last?.picked, true)
    }

    func testRailRowsActiveRowAndFindable() async {
        let m = make()
        XCTAssertEqual(Set(m.rows.map(\.id)), [Fx.pdf, Fx.n1])
        XCTAssertTrue(m.inRail(Fx.pdf))
        XCTAssertEqual(m.activeRowId, "ws")
        m.stageFront = Fx.pdf
        XCTAssertEqual(m.activeRowId, Fx.pdf)
        m.openTab(Fx.n1, title: "Ideas")
        XCTAssertEqual(m.activeRowId, Fx.n1)
    }

    func testHighlightAskKeepsABoxAndSaysWhyItFailed() async {
        let m = make()
        api.askAnswer = { _ in ["failed": true, "lines": ["bart> **No answer.** Out of tokens."]] }
        let entry = await m.askHighlight(markId: "m1", page: 3, quote: "q", note: "n", question: "@bart why", turns: [], rowId: Fx.pdf, url: nil, paper: "Kapur", pageText: "", source: nil)
        XCTAssertNil(entry)
        let box = m.paperAsks.values.first
        XCTAssertEqual(box?["error"]?.string, "Out of tokens.")
        XCTAssertEqual(api.asked.last?["ref"]?["kind"]?.string, "mark")
        XCTAssertEqual(api.asked.last?["ref"]?["page"]?.int, 3)
        api.askAnswer = { _ in ["lines": ["bart> Yes."], "meta": ["provider": "claude", "level": ["name": "Sonnet", "effort": "low"]]] }
        let ok = await m.askHighlight(markId: "m2", page: 1, quote: "q", note: "", question: "why", turns: [], rowId: nil, url: "https://x.org/a.pdf", paper: nil, pageText: "", source: "web")
        XCTAssertEqual(ok?["answer"]?.string, "Yes.")
        XCTAssertEqual(api.asked.last?["ref"]?["source"]?.string, "web")
        XCTAssertEqual(m.paperAsks.count, 1, "a success leaves no box")
    }

    func testWalkthroughTicksAndHides() async {
        api.walkState = ["workspaceId": .string(Fx.w1), "ticked": [], "hidden": false, "steps": 3]
        let m = make()
        await settle()
        XCTAssertTrue(m.walkShown)
        m.walkOpenLibrary(chip: "papers")
        XCTAssertEqual(m.walk?["ticked"]?.array?.compactMap(\.int), [1])
        XCTAssertEqual(m.libraryRequest?.n, 1)
        m.walkHide()
        XCTAssertFalse(m.walkShown)
    }

    func testTourRequestTakenOncePerN() async {
        let m = make()
        m.takeTourRequest(TourRequest(n: 7, workspaceId: Fx.w2, tab: nil))
        XCTAssertEqual(m.topicId, Fx.w2)
        XCTAssertEqual(m.tourStep, 0)
        m.tourNext(); m.tourNext(); m.tourNext()
        XCTAssertNil(m.tourStep)
        XCTAssertTrue(m.tourSeen)
        m.selectTopic(Fx.w1)
        m.takeTourRequest(TourRequest(n: 7, workspaceId: Fx.w2, tab: nil))
        XCTAssertEqual(m.topicId, Fx.w1, "the same request is not taken twice")
    }

    func testDeleteTheWorkspaceInFrontOpensTheOneAbove() async {
        let m = make(WorkspaceEntry(workspaceId: Fx.w2))
        m.deleteWorkspace(Fx.w2)
        await settle()
        XCTAssertEqual(api.trashed, [Fx.w2])
        XCTAssertEqual(m.topicId, Fx.w1)
    }

    func testZoteroChipOpensItsPdfElseTheBrowserElseSays() async {
        let m = make()
        api.zoteroAnswer = ["url": "https://doi.org/10.1/x"]
        await m.openZotero(key: "K", name: "Paper")
        XCTAssertEqual(api.openedExternal, ["https://doi.org/10.1/x"])
        api.zoteroAnswer = ["error": "No pdf"]
        await m.openZotero(key: "K", name: "Paper")
        XCTAssertEqual(api.errors.last, "No pdf")
    }

    func testAFolderFileThatIsGoneSaysSoAndGreys() async {
        let m = make()
        await m.openFolderFile(folderId: "F", rel: "a/b.pdf", name: "b.pdf")
        XCTAssertEqual(api.errors.last, "\"b.pdf\" is no longer in Papers (a/b.pdf)")
        XCTAssertTrue(m.missingFiles.contains("F:a/b.pdf"))
    }

    func testMadeFilesReadSavedAndTheStagesSave() async {
        let m = make()
        let made = MadeRef(askId: "ask1", rel: "page.html", name: "page.html")
        m.needMade([made])
        await settle()
        XCTAssertEqual(m.madeFiles[made.key]?.path, "/tmp/.created/ask1/page.html")
        await m.saveMade(made)
        XCTAssertEqual(m.madeFiles[made.key]?.saved?.name, "page.html")
        XCTAssertEqual(m.madeFile(made.key)?.saved, "page.html")
    }

    func testMentionPickedLinksAndAddsTheOpenPage() async {
        let m = make()
        m.mentionPicked(MenuItem(kind: .item, key: Fx.pdf, name: "Kapur 2008", row: Fx.library[2].libRow))
        await settle()
        XCTAssertEqual(api.linked.last?.ids, [Fx.pdf])
        XCTAssertEqual(api.linked.last?.picked, true)
        m.mentionPicked(MenuItem(kind: .fresh, key: "page:https://x.org", name: "X", input: "https://x.org"))
        await settle()
        XCTAssertEqual(api.linked.last?.picked, true)
    }
}
