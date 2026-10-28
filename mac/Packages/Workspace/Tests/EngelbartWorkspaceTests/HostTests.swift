import XCTest
import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartStage
import EngelbartEditor
import EngelbartPDF
@testable import EngelbartWorkspace

/// Two sRGB hexes within `tolerance` per channel (colour-space rounding).
func near(_ a: String, _ b: String, tolerance: Int = 3) -> Bool {
    func channels(_ s: String) -> [Int] { let h = s.dropFirst(); return stride(from: 0, to: 6, by: 2).map { Int(String(h.dropFirst($0).prefix(2)), radix: 16) ?? -999 } }
    return zip(channels(a), channels(b)).allSatisfy { abs($0 - $1) <= tolerance }
}

// The hosts that connect the wave-1 views to the screen: the editor's (DocEditorHost), a Build card's, the Stage's
// (StageHost), a pdf's (PaperAdapter), the terminal's; and the + menu's model.

@MainActor
final class HostTests: XCTestCase {
    var api: FakeAPI!
    var hub: EventHub!
    override func setUp() async throws { api = FakeAPI(); hub = EventHub() }

    func model() -> WorkspaceModel {
        let m = WorkspaceModel(Fx.context(api, hub: hub))
        m.start()
        return m
    }

    func testEditorHostMapsKeysMentionsAndBuilds() async {
        let m = model()
        await settle()
        let host = WorkspaceEditorHost(model: m, pane: 0)
        let editor = DocEditorView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        editor.host = host
        editor.setDocument(key: "ws:\(Fx.w1)", text: "hello")
        XCTAssertEqual(host.doc(editor).ref, .workspace(Fx.w1))
        XCTAssertEqual(WorkspaceEditorHost.ref(forKey: "note:x"), .note("x"))
        XCTAssertEqual(WorkspaceEditorHost.ref(forKey: "project"), .project)
        XCTAssertNil(WorkspaceEditorHost.ref(forKey: "archive:a:b"))
        let rows = host.docEditorMentionable(editor)
        XCTAssertEqual(rows.prefix(5).map(\.row.id), ["bart", "chat", "brainstorm", "discover", "create"])
        XCTAssertEqual(rows.first { $0.row.id == Fx.n1 }?.row.summary, "A note in this project.")
        XCTAssertTrue(host.docEditorCanBuild(editor))
        XCTAssertTrue(host.docEditorHasRouter(editor))
        host.docEditor(editor, change: "note:\(Fx.n1)", text: "handed on")
        XCTAssertEqual(m.docs["note:\(Fx.n1)"], "handed on")
        XCTAssertEqual(host.docEditor(editor, textOf: "note:\(Fx.n1)"), "handed on")
        host.docEditor(editor, reportView: ViewPosition(top: 120, line: 4, offset: 3, hash: "h"), scope: Fx.w1, key: "ws:\(Fx.w1)", now: true)
        XCTAssertEqual(host.docEditor(editor, viewOf: Fx.w1, key: "ws:\(Fx.w1)"), ViewPosition(top: 120, line: 4, offset: 3, hash: "h"))
        let beside = WorkspaceEditorHost(model: m, pane: 1)
        XCTAssertNil(beside.docEditor(editor, viewOf: Fx.w1, key: "ws:\(Fx.w1)"), "a pane beside keeps no place")
        XCTAssertEqual(WorkspaceEditorHost.made("ask1/dir/a.svg", name: nil), MadeRef(askId: "ask1", rel: "dir/a.svg", name: "a.svg"))
        XCTAssertNil(WorkspaceEditorHost.made("nope", name: nil))
        let listing = WorkspaceEditorHost.listing(["entries": [["name": "a.pdf", "rel": "a.pdf", "dir": false, "type": "pdf"]], "total": 7, "missing": false])
        XCTAssertEqual(listing.entries.map(\.rel), ["a.pdf"])
        XCTAssertEqual(listing.total, 7)
    }

    func testBuildCardRemoveTakesItsLineAway() async {
        let m = model()
        await settle()
        m.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "spec\nbuild> b1\nend", typed: false)
        let card = BuildCardHost(model: m, id: "b1", editorKey: { "ws:\(Fx.w1)" })
        card.act("buildremove", nil)
        XCTAssertEqual(m.docs["ws:\(Fx.w1)"], "spec\nend")
        card.act("buildhistory", nil)
        XCTAssertTrue(card.open)
        card.reply = "  go on  "
        card.act("buildsend", nil)
        await settle()
        XCTAssertEqual(api.buildCalls.last, "reply:go on")
        XCTAssertEqual(card.reply, "")
        card.act("buildstop", nil)
        card.act("buildrunstopone", "web")
        await settle()
        XCTAssertEqual(Array(api.buildCalls.suffix(2)), ["stop", "runstopone:web"])
        XCTAssertNotNil(card.view)
    }

    func testStageHostTellsTheScreen() async {
        let m = model()
        let host = WorkspaceStageHost(model: m)
        XCTAssertEqual(host.projectId, Fx.project)
        XCTAssertEqual(host.projectDirectory, "/tmp/code")
        XCTAssertEqual(host.library().map(\.id), Fx.library.map(\.id))
        XCTAssertTrue(host.inRail(Fx.pdf))
        host.stageFrontChanged(Fx.pdf)
        XCTAssertEqual(m.stageFront, Fx.pdf)
        host.stageTabsChanged(["/p/.created/a1/x.html"])
        XCTAssertEqual(m.madeOpen, ["a1/x.html"])
        host.showStage()
        XCTAssertEqual(m.rightMode, "stage")
        XCTAssertNil(host.previewRow(for: "https://x.org"))
        api.lookups["https://x.org"] = LibraryLookup(row: Fx.library[2], type: "pdf", tags: ["paper"])
        let found = await host.lookupLibraryItem("https://x.org")
        XCTAssertEqual(found.row?.id, Fx.pdf)
        m.setOpenPage(OpenPage(input: "https://example.org/a", title: "A", tabId: "t1", webPage: true))
        await settle()
        XCTAssertEqual(m.pageState, "none")
        XCTAssertEqual(m.stageSave?.state, StageModel.SaveState.none)
        host.openExternal("https://x.org")
        XCTAssertEqual(api.openedExternal, ["https://x.org"])
    }

    func testSavePageKeepsACopyOfAPlainPageAndLinksIt() async throws {
        let m = model()
        m.setOpenPage(OpenPage(input: "https://example.org/a", title: "A", tabId: "t1", webPage: true))
        await settle()
        try await m.savePage(name: "A page", here: true)
        XCTAssertEqual(api.linked.last?.ids, ["ffffffff-0000-4000-8000-000000000005"], "a plain web page is kept as a copy")
    }

    func testPaperAdapterPendingAndContinue() async {
        let m = model()
        await settle()
        let req = PaperRequest(rowId: Fx.pdf, url: "", name: "Kapur 2008")
        let pending = PaperAdapter.pending([["askId": "h1", "markId": "m1", "page": 2, "question": "why", "lines": ["a"]], ["askId": "bad"]])
        XCTAssertEqual(pending.map(\.askId), ["h1"])
        XCTAssertEqual(pending.first?.page, 2)
        let host = WorkspaceStageHost(model: m)
        let viewer = host.makePaperView(req)
        XCTAssertEqual(viewer.currentPage(), 0)
        XCTAssertEqual(host.papers.count, 1)
        host.pushPending([["askId": "h2", "markId": "m", "page": 1, "rowId": .string(Fx.pdf)], ["askId": "h3", "markId": "m", "page": 1, "rowId": "other"]])
        (viewer as? PaperAdapter)?.paperContinue(PaperContinue(markId: "m", page: 1, quote: "the passage", question: "why", answer: "because", foot: ""))
        await settle()
        XCTAssertTrue(m.docs["ws:\(Fx.w1)"]?.contains("@[Kapur 2008]") ?? false, "the paper is mentioned in the thread")
        XCTAssertEqual(m.activeTab, "ws")
    }

    func testTerminalHost() async {
        let m = model()
        let host = WorkspaceTerminalHost(model: m)
        XCTAssertEqual(host.terminalProjectId, Fx.project)
        XCTAssertEqual(host.terminalProjectDirectory, "/tmp/code")
        XCTAssertEqual(host.terminalFullScreen, false)
        host.terminalToggleFullScreen()
        XCTAssertTrue(m.stageFull)
        host.keysToDocNow = { true }
        XCTAssertTrue(host.terminalKeysToDoc())
    }

    func testNotePickerModelMovesPicksAndEscapesInTwoSteps() async {
        var closed = 0, picked: [String] = [], made: [String] = []
        let picker = NotePickerModel(library: { Fx.library }, openIds: { [] }, inRail: { _ in false },
                                     onPick: { picked.append($0.id) }, onNew: { made.append($0) }, onClose: { closed += 1 }, onError: { _ in })
        XCTAssertEqual(picker.rows.first?.kind, .new)
        picker.move(-1)
        XCTAssertEqual(picker.index, picker.rows.count - 1, "↑ from the top wraps")
        picker.move(1)
        XCTAssertEqual(picker.index, 0)
        picker.query = "ide"
        XCTAssertEqual(picker.rows.map(\.key), [Fx.n1, "new"])
        picker.pick(picker.rows[0])
        await settle()
        XCTAssertEqual(picked, [Fx.n1])
        XCTAssertEqual(closed, 1)
        picker.busy = false
        picker.escape()
        XCTAssertEqual(picker.query, "", "Esc clears first")
        picker.escape()
        XCTAssertEqual(closed, 2)
        picker.pick(NotePick.Row(kind: .new, key: "new", name: "Plan", row: nil, tag: ""))
        await settle()
        XCTAssertEqual(made, ["Plan"])
    }
}
