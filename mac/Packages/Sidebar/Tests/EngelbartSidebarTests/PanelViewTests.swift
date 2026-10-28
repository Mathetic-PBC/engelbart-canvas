import AppKit
import SwiftUI
import XCTest
import EngelbartCore
import EngelbartStore
import EngelbartUI
@testable import EngelbartSidebar

// Each panel drawn offscreen in a hosting view at its CSS width: it lays out, its height is sensible, and what it
// says is there (the panels' own logic is PanelModelTests').

@MainActor
final class PanelViewTests: XCTestCase {
    func host<V: View>(_ view: V, width: CGFloat) -> NSHostingView<AnyView> {
        let h = NSHostingView(rootView: AnyView(view.frame(width: width)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = h
        h.frame = NSRect(x: 0, y: 0, width: width, height: max(10, h.fittingSize.height))
        h.layoutSubtreeIfNeeded()
        return h
    }

    func testAgentsPanel() {
        let empty = host(AgentsPanelView(entries: [], crumbOf: { _ in [] }, dismissable: true, onGo: { _, _ in }, onDismiss: { _ in }, onNext: {}, onSeenAll: {}), width: 360)
        XCTAssertGreaterThan(empty.fittingSize.height, 80, "head, the empty words, Next agent")
        let entries = [AgentEntry(id: "a", kind: "bart", title: "Bart", node: "sb", state: "unseen", at: JSTime.iso(JSTime.now() - 120_000)),
                       AgentEntry(id: "b", kind: "build", title: "Pills", node: "ic", state: "running", at: JSTime.iso(JSTime.now()))]
        let full = host(AgentsPanelView(entries: entries, crumbOf: { _ in ["User Interface", "Sidebar"] }, dismissable: true, onGo: { _, _ in }, onDismiss: { _ in }, onNext: {}, onSeenAll: {}), width: 360)
        XCTAssertGreaterThan(full.fittingSize.height, empty.fittingSize.height - 40)
    }

    func testLibraryAndPicker() {
        var lib: [LibraryRow] = []
        for i in 0..<12 {
            let even = i % 2 == 0
            let edited = String(format: "2026-10-%02dT00:00:00.000Z", i + 1)
            lib.append(row("r\(i)", "Row \(i)", even ? "pdf" : "md", even ? [] : ["note"], lastEdited: edited))
        }
        let model = LibraryPanelModel(library: lib, inRail: { _ in false }, lookup: LookupModel(ask: { _ in StoreValues.lookup() }, delay: 0))
        let view = host(LibraryPanelView(model: model, peek: nil, onOpenFull: {}), width: 360)
        XCTAssertGreaterThan(view.fittingSize.height, 200)
        let picker = AddPickerModel(intoName: "Sidebar", library: lib, has: { _ in false })
        let p = host(AddPickerView(model: picker, github: nil, inRail: { _ in false }, peek: nil, onMore: {}), width: 320)
        XCTAssertGreaterThan(p.fittingSize.height, 5 * 32)
    }

    func testTreesAndMenus() {
        let roots = SidebarViewTests.roots
        let tree = SidebarModel.indexTree(roots)
        let projects = host(ProjectsPanelView(model: ProjectsPanelModel(roots: roots, tree: tree, hereId: "sb"), counts: [:], hereId: "sb", onGo: { _ in }, onNew: {}, onMenu: { _, _ in }, onOpenVersion: { _ in }), width: 340)
        XCTAssertGreaterThan(projects.fittingSize.height, 6 * 30)
        let fly = host(ProjectFlyoutView(id: "ag", tree: tree, counts: [:], hereId: "sb", onGo: { _ in }), width: 270)
        XCTAssertGreaterThanOrEqual(fly.fittingSize.height, 3 * 30, "Agents, Bart build agents, Sandbox: open, no chevrons")
        let menu = host(ProjectMenuView(switchOpen: false, onSwitchHover: { _ in }, onSwitch: {}, onOtherHover: {}, onRename: {}, onProjectPage: {}, onShortcuts: {}), width: 230)
        let menuHeight: CGFloat = 150
        XCTAssertEqual(menu.fittingSize.height, menuHeight, accuracy: 4, "four rows of 32 (gap 1), the rule, padding 5")
        let ctx = host(ContextMenuView(items: [MenuItemSpec(label: "Open", icon: SidebarIcons.workspace), .separatorItem, MenuItemSpec(label: "Delete", icon: SidebarIcons.trash, danger: true)], onPick: { _ in }), width: 190)
        let ctxHeight: CGFloat = 81
        XCTAssertEqual(ctx.fittingSize.height, ctxHeight, accuracy: 4)
        let shortcuts = host(ShortcutsDialogView(roots: roots, railHidden: false, onNext: {}, onGo: { _ in }, onToggleRail: {}, onClose: {}), width: 480)
        XCTAssertGreaterThan(shortcuts.fittingSize.height, 6 * 38)
    }

    func testWalkthroughAndPeek() {
        let state = WalkState(workspaceId: "w", ticked: [1])
        let steps = GettingStartedModel.stepsHere(state, "w")
        let gs = host(GettingStartedView(state: state, steps: steps, library: [row("a", "A", "md", ["note"])], onTick: { _, _ in }, onHide: {}, onOpenLibrary: { _ in }, onWrite: {}, onOpenPaper: { _ in }), width: 640)
        XCTAssertGreaterThan(gs.fittingSize.height, 3 * 38)
        let peek = host(PeekCardView(row: row("w1", "Magic Ink", "website", url: "https://worrydream.com/MagicInk/", summary: "Information software design."),
                                     more: StoreValues.preview(id: "w1", heldBy: [StoreValues.holder(id: "p", name: "Engelbart", workspaces: [("sb", "Sidebar", "User Interface/Sidebar")])]),
                                     onOpenWorkspace: { _, _ in }), width: 360)
        XCTAssertGreaterThan(peek.fittingSize.height, 80)
        XCTAssertEqual(SidebarTour.placeCard(CGRect(x: 8, y: 80, width: 290, height: 40), height: 176, view: CGSize(width: 1200, height: 900)).side, "right")
        XCTAssertEqual(SidebarTour.placeCard(CGRect(x: 8, y: 80, width: 290, height: 40), height: 176, view: CGSize(width: 1200, height: 900)).origin, CGPoint(x: 314, y: 80))
        XCTAssertEqual(SidebarTour.placeCard(CGRect(x: 8, y: 10, width: 290, height: 40), height: 176, view: CGSize(width: 1200, height: 900)).origin.y, 52, "under the title line")
        XCTAssertEqual(SidebarTour.placeCard(nil, height: 176, view: CGSize(width: 1200, height: 900)).side, "none")
        XCTAssertEqual(SidebarTour.STEPS.map(\.title), ["Engelbart library", "Project-specific sources", "Create folders for your sources"])
    }

    func testAddToLibraryMenu() {
        let model = AddMenuModel(library: [row("p1", "ColBERT", "pdf")], inRail: { _ in false }, lookup: { _ in StoreValues.lookup() })
        let menu = host(AddMenuBodyView(model: model, github: nil).padding(10), width: 280)
        XCTAssertGreaterThan(menu.fittingSize.height, 33 + 33 + 32)
        model.q = "colb"
        XCTAssertEqual(model.results.map(\.key), ["p1"])
        XCTAssertEqual(model.results.first?.tag, "pdf")
        model.value = "https://example.org/a"
        XCTAssertTrue(model.addable)
    }
}
