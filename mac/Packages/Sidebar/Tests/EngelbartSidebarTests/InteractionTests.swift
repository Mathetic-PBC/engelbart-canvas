import AppKit
import XCTest
import EngelbartCore
import EngelbartStore
import EngelbartUI
@testable import EngelbartSidebar

// What the sidebar does on presses, right clicks and rests (Rail.jsx's handlers), in the offscreen harness.

@MainActor
final class SidebarInteractionTests: XCTestCase {
    func input(_ edit: (inout SidebarInput) -> Void = { _ in }) -> SidebarInput { SidebarViewTests().input(edit) }

    func testRightClickMenus() {
        let h = Harness(input())
        h.click(h.view("sb-project-row=mc")!, right: true)
        XCTAssertEqual(h.c.menuItems?.filter { !$0.separator }.map(\.label), ["Open", "Create project within Middle Canvas", "Rename", "Delete"])
        XCTAssertEqual(h.c.menuItems?.last?.danger, true)
        h.click(h.view("sb-project-row=ic")!, right: true)
        let within = h.c.menuItems?.first { $0.label.hasPrefix("Create project within") }
        XCTAssertEqual(within?.disabled, true, "Iconography is the fourth level")
        XCTAssertEqual(within?.title, "Projects go four levels deep")
        h.click(h.view("sb-source=n0")!, right: true)
        XCTAssertEqual(h.c.menuItems?.filter { !$0.separator }.map(\.label), ["Open", "Rename", "Add to References", "Remove from this project"])
        h.click(h.view("sb-folder=f1")!, right: true)
        XCTAssertEqual(h.c.menuItems?.filter { !$0.separator }.map(\.label), ["Rename", "Delete folder"])
        // Rename from the menu: the source's name typed in place
        h.click(h.view("sb-source=n0")!, right: true)
        h.c.menuItems?.first { $0.label == "Rename" }?.action()
        XCTAssertEqual(h.c.renaming, "n0")
        guard let field = h.row("sb-source=n0")?.renameField as? RenameField else { return XCTFail("no field") }
        field.stringValue = "First note"
        field.finish(true)
        XCTAssertEqual(h.calls.last, "renameRow:n0:First note")
    }

    func testHeadMenuAndRename() {
        let h = Harness(input())
        h.click(h.c.root.head.project)
        XCTAssertEqual(h.c.openPanel, "project")
        XCTAssertTrue(h.c.root.head.project.on, "#ececec while its menu is open")
        h.c.close()
        h.c.startRename("project")
        guard let box = h.c.root.head.renameBox as? RenameBox, let field = box.field as? RenameField else { return XCTFail("no rename box") }
        XCTAssertTrue(h.c.root.head.project.isHidden)
        field.stringValue = "Engelbart 2"
        field.finish(true)
        XCTAssertEqual(h.calls.last, "renameProject:Engelbart 2")
        XCTAssertNil(h.c.root.head.renameBox)
        // Escape keeps the old name
        h.c.startRename("project")
        (h.c.root.head.renameBox as? RenameBox)?.field.flatMap { $0 as? RenameField }?.finish(false)
        XCTAssertEqual(h.calls.filter { $0.hasPrefix("renameProject") }.count, 1)
    }

    func testHoverCardAndTip() {
        let h = Harness(input())
        let ag = h.row("sb-project-row=ag")!
        ag.onHover?(ag, true, nil)
        h.spin(0.1)
        XCTAssertEqual(h.c.flyout?.id, "ag", "resting on a folded project shows what is in it")
        XCTAssertEqual(h.c.tip?.kind, "shortcut")
        XCTAssertEqual(h.c.tip?.n, 3, "Agents is the third level-2 project: Ctrl+3")
        ag.onHover?(ag, false, nil)
        h.spin(0.1)
        // (the card holds while the pointer is on it: the runner's pointer may happen to rest where it shows)
        if !h.c.flyCard.window.frame.contains(NSEvent.mouseLocation) { XCTAssertNil(h.c.flyout, "gone a beat after the pointer leaves: \(h.c.flyCard.window.frame) \(NSEvent.mouseLocation)") }
        XCTAssertNil(h.c.tip)
        // an open project shows no card
        let ui = h.row("sb-project-row=ui")!
        ui.onHover?(ui, true, nil)
        h.spin(0.1)
        XCTAssertNil(h.c.flyout)
        ui.onHover?(ui, false, nil)
    }

    func testPeekFromASource() {
        var asked: [String] = []
        let h = Harness(input()) { _, services in services.preview = { id in asked.append(id); return StoreValues.preview(id: id, text: "hello") } }
        let n0 = h.row("sb-source=n0")!
        n0.onHover?(n0, true, nil)
        h.spin(0.1)
        XCTAssertEqual(h.c.peek.peek?.row.id, "n0")
        XCTAssertEqual(asked, ["n0"], "the preview is asked once")
        XCTAssertEqual(h.c.peek.peek?.edge, 300, "beside the sidebar's right edge")
        n0.onHover?(n0, false, nil)
        h.spin(0.1)
        XCTAssertNil(h.c.peek.peek)
    }

    func testSearchCreateAndTrash() async throws {
        var made: [String] = []
        let h = Harness(input { $0.trashFull = true }) { _, services in
            services.createFolder = { name in made.append(name); return [StoreValues.folder(id: "f1", name: "References"), StoreValues.folder(id: "f2", name: name)] }
        }
        h.click(h.view("sb-fixed-row=search")!)
        XCTAssertTrue(h.c.searching)
        XCTAssertNotNil(h.c.searchModel)
        h.c.searchModel?.onClose()
        XCTAssertFalse(h.c.searching)
        h.click(h.view("sb-create-folder")!)
        XCTAssertEqual(h.c.nameModel?.title, "Create folder")
        h.c.nameModel?.name = "Reading"
        h.c.nameModel?.create()
        for _ in 0..<50 where made.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(made, ["Reading"])
        XCTAssertEqual(h.c.folders.map(\.name), ["References", "Reading"])
        h.click(h.c.root.foot.trash)
        XCTAssertTrue(h.calls.contains("trash"))
        h.click(h.view("sb-next-agent")!)
        XCTAssertEqual(h.calls.last, "next")
        // + within a project: "Create project within User Interface"
        h.row("sb-project-row=ui")!.setHovered(true)
        h.click(h.view("sb-new-child=ui")!)
        XCTAssertEqual(h.c.nameModel?.title, "Create project within User Interface")
    }

    func testTourOpensLibrary() {
        let h = Harness(input())
        h.c.update(input { $0.tourStep = 0 })
        h.spin(0.05)
        XCTAssertEqual(h.c.openPanel, "library", "the tour's first card holds Library's popup open")
        XCTAssertEqual(h.c.tourHoles(step: 0).count, 2, "the row and the popup")
        h.c.update(input { $0.tourStep = 1 })
        XCTAssertNil(h.c.openPanel, "only the one the tour opened is shut")
    }

    func testFlashAndActiveSource() {
        let h = Harness(input { $0.activeRowId = "n1"; $0.flashId = "sb" })
        XCTAssertTrue(h.row("sb-source=n1")!.look.active)
        XCTAssertTrue(h.row("sb-project-row=sb")!.look.flash)
        XCTAssertTrue(h.row("sb-project-row=ui")!.look.holds == false, "an open ancestor is not bold")
        let deep = Harness(input { $0.hereId = "sx" })
        XCTAssertEqual(deep.ids("sb-project-row="), ["ui", "ag", "bb", "sx", "lb"].filter { deep.view("sb-project-row=\($0)") != nil })
        XCTAssertTrue(deep.row("sb-project-row=sx")!.look.active)
    }

    func testDropTargetsSources() {
        let h = Harness(input())
        XCTAssertGreaterThan(h.c.root.list.sourcesTop, h.frame("sb-head=projects")!.maxY - 36, "drops are taken from Sources down")
        h.c.root.list.dropping = true
        let r = h.c.root.list.convert(CGRect(x: 0, y: h.c.root.list.sourcesTop, width: 10, height: 10), to: h.c.view)
        let edge = h.pixel(CGPoint(x: r.minX + 1.5, y: r.minY + 20))
        XCTAssertLessThan(edge.r, 0xf0, "the 2px #c9c9c9 ring while files are over Sources: \(edge)")
    }
}
