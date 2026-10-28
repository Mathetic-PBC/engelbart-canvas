import XCTest
import AppKit
import EngelbartCore
import EngelbartUI
import EngelbartStore
@testable import EngelbartWorkspace

// The screen drawn offscreen: a window made with defer: false and never ordered front, synthesized key events, and
// assertions on frames, text, state and sampled pixels.

@MainActor
final class WorkspaceViewTests: XCTestCase {
    var api: FakeAPI!
    var hub: EventHub!
    var window: NSWindow!

    override func setUp() async throws { api = FakeAPI(); hub = EventHub() }
    override func tearDown() async throws { window?.close(); window = nil }

    func make(width: CGFloat = 1440, height: CGFloat = 900, entry: WorkspaceEntry = WorkspaceEntry(workspaceId: Fx.w1), tree: ProjectTree = Fx.tree(),
              configure: (inout WorkspaceContext) -> Void = { _ in }) async -> WorkspaceViewController {
        var ctx = Fx.context(api, tree: tree, entry: entry, hub: hub)
        configure(&ctx)
        let vc = WorkspaceViewController(ctx)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = vc
        vc.view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        await settle(0.15)
        vc.view.layoutSubtreeIfNeeded()
        vc.render()
        return vc
    }

    func key(_ chars: String, _ flags: NSEvent.ModifierFlags = [], code: UInt16 = 0, repeat r: Bool = false) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: r, keyCode: code)!
    }

    /// The colour of the view's own drawing at a point (y down), as an sRGB hex.
    func pixel(_ view: NSView, _ p: NSPoint) -> String {
        let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / view.bounds.width
        let c = rep.colorAt(x: Int(p.x * scale), y: Int(p.y * scale))!.usingColorSpace(.sRGB)!
        return String(format: "#%02x%02x%02x", Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
    }

    func testHeaderColumnsFollowTheLayout() async {
        let vc = await make()
        let l = vc.model.layout
        XCTAssertEqual(vc.header.frame.height, 44)
        XCTAssertEqual(vc.header.lead.frame.width, 300, "over the sidebar: its width")
        XCTAssertEqual(vc.header.modes.frame.width, l.paneWidth)
        XCTAssertEqual(vc.right.frame.width, l.paneWidth)
        XCTAssertEqual(vc.railBox.frame.width, 300)
        XCTAssertEqual(vc.page.frame.minX, 301)
        XCTAssertEqual(vc.column.frame.width, vc.page.frame.width - l.paneWidth - 1)
        // toggle and clock at the sidebar's right edge (no clock without a sidebar slot): 300 - 8 - 28
        XCTAssertEqual(vc.header.toggle.frame.minX, 264)
        XCTAssertEqual(vc.header.toggle.frame.midY, 27, "on the line through the lights")
        XCTAssertTrue(near(pixel(vc.header, NSPoint(x: 150, y: 6)), "#fafafa"))
    }

    func testTabsDrawnAsTheStagesWorkspaceFirstAndTheFrontOneWhite() async {
        let vc = await make()
        vc.model.openTab(Fx.n1, title: "Ideas")
        await settle()
        vc.view.layoutSubtreeIfNeeded()
        let strip = vc.header.tabs
        XCTAssertEqual(strip.tabs.map(\.id), ["ws", Fx.n1])
        let ws = strip.views["ws"]!, note = strip.views[Fx.n1]!
        XCTAssertEqual(ws.title, "Reading")
        XCTAssertEqual(ws.frame.height, 34)
        XCTAssertLessThan(ws.frame.maxX, note.frame.minX + 1)
        XCTAssertTrue(note.on); XCTAssertFalse(ws.on)
        XCTAssertNil(ws.closeButton, "Workspace has no ×")
        XCTAssertNotNil(note.closeButton)
        let inFront = strip.convert(NSPoint(x: note.frame.midX, y: note.frame.minY + 4), to: vc.header)
        XCTAssertTrue(near(pixel(vc.header, inFront), "#ffffff"))
        XCTAssertEqual(vc.header.plus.frame.minX, vc.header.tabs.frame.maxX + 6, "the + after the tabs")
    }

    func testTabsShrinkTogetherNotBelow44() {
        XCTAssertEqual(DocTabsView.shrink([100, 100], into: 300), [100, 100])
        XCTAssertEqual(DocTabsView.shrink([200, 100], into: 150), [100, 50])
        XCTAssertEqual(DocTabsView.shrink([200, 50], into: 150), [106, 44])
    }

    func testDraggingANoteTabReordersAndWorkspaceStaysFirst() async {
        let vc = await make()
        vc.model.openTab(Fx.n1, title: "Ideas")
        vc.model.openTab(Fx.n2, title: "Untitled Note 1")
        await settle()
        vc.view.layoutSubtreeIfNeeded()
        let strip = vc.header.tabs
        let n2 = strip.views[Fx.n2]!
        let startX = strip.convert(NSPoint(x: n2.frame.midX, y: 0), to: nil).x
        strip.pressed(Fx.n2, at: startX)
        strip.dragged(to: startX - 2)
        XCTAssertNil(strip.dragging, "under 4px it is a press")
        strip.dragged(to: startX - 300)
        await settle()
        XCTAssertEqual(vc.model.tabs.map(\.id), ["ws", Fx.n2, Fx.n1])
        strip.released()
        XCTAssertEqual(vc.model.activeTab, Fx.n2)
    }

    func testUntitledTitleIsAPlaceholderAndSlashesBecomeHyphens() async {
        let vc = await make(entry: WorkspaceEntry(workspaceId: Fx.w1, tab: DocTab(id: Fx.n2, title: "Untitled Note 1")))
        await settle(0.2)
        vc.render()
        let pane = vc.panes[0]
        XCTAssertTrue(pane.showsEditor)
        XCTAssertEqual(pane.titleField.stringValue, "")
        XCTAssertEqual(pane.titleField.placeholderAttributedString?.string, "Untitled Note 1")
        pane.titleField.stringValue = "a/b\\c"
        pane.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(pane.titleField.stringValue, "a-b-c")
    }

    func testFooterCopyBuildClearOnTheWorkspaceRestoreOnAnArchive() async {
        let vc = await make()
        await settle(0.2)
        vc.render()
        XCTAssertEqual(vc.panes[0].footerButtons.map(\.text), ["Copy", "Build", "Clear"])
        XCTAssertEqual(vc.copyButton.toolTip, "Copy current project")
        XCTAssertEqual(vc.panes[0].footer.frame.height, 45)
        vc.model.openTab("archive:old.md", title: "old")
        await settle(0.2)
        vc.render()
        XCTAssertEqual(vc.panes[0].footerButtons.map(\.text), ["Restore"])
        XCTAssertFalse(vc.panes[0].titleField.isEditable, "an archived version is only read")
        vc.model.openTab(Fx.n1, title: "Ideas")
        await settle(0.2)
        vc.render()
        XCTAssertEqual(vc.panes[0].footerButtons.map(\.text), ["Copy"])
        XCTAssertEqual(vc.copyButton.toolTip, "Copy current note")
    }

    func testThePaneBesideSplitsTheColumnAndHasItsX() async {
        let vc = await make()
        vc.model.openDocBeside(kind: "note", id: Fx.n1, name: "Ideas", link: "Ideas")
        await settle(0.2)
        vc.view.layoutSubtreeIfNeeded()
        XCTAssertEqual(vc.panes.count, 2)
        XCTAssertEqual(vc.panes[0].frame.width, vc.panes[1].frame.width)
        XCTAssertNotNil(vc.panes[1].closeButton)
        XCTAssertNil(vc.panes[0].closeButton)
        vc.panes[1].closeButton?.action?()
        await settle()
        XCTAssertEqual(vc.panes.count, 1)
    }

    func testFoldingTheSidebarAndTheFullScreens() async {
        let vc = await make()
        vc.model.toggleRail()
        await settle()
        vc.view.layoutSubtreeIfNeeded()
        XCTAssertTrue(vc.railBox.isHidden)
        XCTAssertEqual(vc.page.frame.minX, 0)
        XCTAssertEqual(vc.header.toggle.frame.minX, 84, "after the traffic lights")
        XCTAssertEqual(vc.header.toggle.accessibilityIdentifier(), "sidebar-toggle=hidden")
        vc.model.toggleDocFull()
        await settle()
        vc.view.layoutSubtreeIfNeeded()
        XCTAssertTrue(vc.right.isHidden)
        XCTAssertTrue(vc.header.modes.isHidden)
        XCTAssertEqual(vc.column.frame.width, vc.page.frame.width)
        vc.model.toggleStageFull()
        await settle()
        vc.view.layoutSubtreeIfNeeded()
        XCTAssertTrue(vc.column.isHidden)
        XCTAssertTrue(vc.header.strip.isHidden)
        XCTAssertEqual(vc.right.frame.width, vc.page.frame.width)
    }

    func testEdgesDoubleClickPutDefaultsBack() async {
        let vc = await make()
        vc.model.railWidth = 400
        vc.model.rightWidth = 500
        vc.railEdge.onReset()
        vc.rightEdge.onReset()
        XCTAssertEqual(vc.model.railWidth, 300)
        XCTAssertNil(vc.model.rightWidth)
        vc.railEdge.onDown()
        XCTAssertEqual(vc.model.rightWidth, vc.model.layout.right, "the right pane keeps its width while the sidebar's edge moves")
    }

    func testKeysCmdJCtrlDigitCmdBackslashAndCmdW() async {
        api.navState = NavState(recent: [["projectId": .string(Fx.project), "workspaceId": .string(Fx.w2), "at": "2026-10-16T00:00:00Z"]])
        let vc = await make()
        await settle()
        XCTAssertTrue(vc.handleKey(key("j", .command)))
        XCTAssertEqual(vc.model.topicId, Fx.w2)
        XCTAssertTrue(vc.handleKey(key("1", .control)))
        XCTAssertEqual(vc.model.topicId, Fx.w1)
        XCTAssertTrue(vc.handleKey(key("\\", .command)))
        XCTAssertTrue(vc.model.railHidden)
        vc.model.openTab(Fx.n1, title: "Ideas")
        XCTAssertTrue(vc.keysToDoc(), "the middle canvas has the keys by default")
        XCTAssertTrue(vc.handleKey(key("w", .command)))
        XCTAssertEqual(vc.model.tabs.map(\.id), ["ws"])
        XCTAssertTrue(vc.handleKey(key("w", .command)), "taken, but Workspace never closes")
        XCTAssertEqual(vc.model.tabs.map(\.id), ["ws"])
        vc.model.openTab(Fx.n1, title: "Ideas")
        XCTAssertTrue(vc.handleKey(key("1", .command)))
        XCTAssertEqual(vc.model.activeTab, "ws", "⌘1 the first tab")
        XCTAssertFalse(vc.handleKey(key("w", [.command, .shift])), "⇧⌘W is the window's")
    }

    func testCmdTOpensTheNotePickerAndEscapeClosesTheWorkspace() async {
        let vc = await make()
        XCTAssertTrue(vc.handleKey(key("t", .command)))
        XCTAssertTrue(vc.notePickerOpen)
        XCTAssertTrue(vc.model.notePlus)
        vc.closeNotePicker()
        XCTAssertFalse(vc.notePickerOpen)
        window.makeFirstResponder(nil)
        XCTAssertTrue(vc.handleKey(key("\u{1b}", code: 53)))
        XCTAssertEqual(api.closed, 1)
        vc.model.toggleDocFull()
        XCTAssertTrue(vc.handleKey(key("\u{1b}", code: 53)))
        XCTAssertFalse(vc.model.docFull, "Escape leaves the full screen")
        XCTAssertEqual(api.closed, 1, "never closes the workspace from there")
    }

    func testInactiveProjectTakesNoKeys() async {
        let vc = await make(tree: Fx.tree(directory: nil))
        XCTAssertFalse(vc.model.active)
        XCTAssertFalse(vc.handleKey(key("j", .command)))
    }

    func testConflictNoticeShowsOverTheDocument() async {
        api.docsOnDisk["ws:\(Fx.w1)"] = "mine"
        let vc = await make()
        await settle(0.2)
        vc.model.onDocChange(key: "ws:\(Fx.w1)", ref: .workspace(Fx.w1), text: "mine!", typed: false)
        hub.post("doc:changed", ["projectId": .string(Fx.project), "key": .string("ws:\(Fx.w1)"), "text": "theirs", "revision": 9])
        await settle()
        vc.render()
        let pane = vc.panes[0]
        XCTAssertFalse(pane.conflictBox.isHidden)
        XCTAssertEqual(pane.conflictBox.frame.minY, 10)
        XCTAssertEqual(pane.conflictBox.frame.maxX, pane.bounds.width - 16)
        pane.keepButton.action?()
        await settle()
        vc.render()
        XCTAssertTrue(pane.conflictBox.isHidden)
    }

    func testEmptyProjectOffersAProject() async {
        let vc = await make(tree: Fx.tree(nodes: []))
        await settle()
        vc.render()
        XCTAssertNotNil(vc.panes[0].emptyView)
        XCTAssertFalse(vc.header.plus.isHidden == false && vc.model.topic == nil, "no + without a workspace")
        XCTAssertTrue(vc.header.plus.isHidden)
    }

    func testModesSwitchTheRightPane() async {
        let vc = await make()
        XCTAssertEqual(vc.header.mode, "stage")
        vc.header.terminalMode.action?()
        await settle()
        XCTAssertEqual(vc.model.rightMode, "terminal")
        XCTAssertTrue(vc.stage?.view.isHidden ?? false)
        XCTAssertEqual(vc.header.terminalMode.color, Palette.gray900)
    }

    func testSidebarSlotIsGivenTheRailsProps() async {
        final class Rail: WorkspaceSidebar {
            let view = NSView()
            var states: [WorkspaceSidebarState] = []
            func update(_ state: WorkspaceSidebarState) { states.append(state) }
            func makeRecentPages() -> NSView? { NSView() }
            func makeWalkCard() -> NSView? { nil }
        }
        let rail = Rail()
        let vc = await make { $0.makeSidebar = { _ in rail } }
        await settle()
        vc.render()
        let s = rail.states.last!
        XCTAssertEqual(s.hereId, Fx.w1)
        XCTAssertEqual(s.width, 300)
        XCTAssertEqual(Set(s.rows.map(\.id)), [Fx.pdf, Fx.n1])
        XCTAssertEqual(rail.view.frame.width, 300)
        XCTAssertNotNil(vc.header.clock)
        vc.view.layoutSubtreeIfNeeded()
        XCTAssertEqual(vc.header.clock?.frame.maxX, 292, "the clock at the sidebar's right edge")
    }
}
