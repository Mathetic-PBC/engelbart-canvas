import AppKit
import XCTest
import EngelbartCore
import EngelbartStore
import EngelbartUI
@testable import EngelbartSidebar

// The sidebar as it draws (test/sidebar-ui.test.cjs, ported to the AppKit sidebar): an offscreen window (defer: false,
// never ordered front), the controller's view in it, synthesized mouse events, and geometry, text, state and sampled
// pixels checked against the CSS.

@MainActor
final class Harness {
    let window: NSWindow
    let storage: MemoryStorage
    let hub = EventHub()
    var calls: [String] = []
    var folders: [AppState.Folder]
    private(set) var c: SidebarViewController!

    init(_ input: SidebarInput, folders: [AppState.Folder] = [], storage: MemoryStorage = MemoryStorage(), configure: (inout SidebarActions, inout SidebarServices) -> Void = { _, _ in }) {
        self.storage = storage
        self.folders = folders
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        var timing = SidebarTiming()
        timing.open = 0.02; timing.switchTo = 0.01; timing.close = 0.02; timing.pickerLeave = 0.02; timing.lookup = 0.01; timing.flash = 0.2
        rebuild(input, timing: timing, configure: configure)
    }

    func rebuild(_ input: SidebarInput, timing: SidebarTiming, configure: (inout SidebarActions, inout SidebarServices) -> Void) {
        var actions = SidebarActions()
        actions.selectWorkspace = { [unowned self] id in calls.append("select:\(id)") }
        actions.renameWorkspace = { [unowned self] id, name in calls.append("rename:\(id):\(name)") }
        actions.openRow = { [unowned self] row in calls.append("open:\(row.id)") }
        actions.removeRow = { [unowned self] row in calls.append("remove:\(row.id)") }
        actions.toggleStickies = { [unowned self] in calls.append("stickies") }
        actions.nextAgent = { [unowned self] in calls.append("next") }
        actions.openSettings = { [unowned self] in calls.append("settings") }
        actions.flash = { [unowned self] id in calls.append("flash:\(id)") }
        actions.panelOpened = { [unowned self] kind in calls.append("panel:\(kind)") }
        actions.newNote = { [unowned self] in calls.append("newNote"); return "note1" }
        actions.renameProject = { [unowned self] name in calls.append("renameProject:\(name)") }
        actions.openTrash = { [unowned self] _, _ in calls.append("trash") }
        actions.renameRow = { [unowned self] row, name in calls.append("renameRow:\(row.id):\(name)") }
        var services = SidebarServices()
        services.folders = { [unowned self] in self.folders }
        services.addToFolder = { [unowned self] id, ids in
            calls.append("addToFolder:\(id):\(ids.joined(separator: ","))")
            folders = folders.map { f in var f = f; if f.id == id { for i in ids where !f.items.contains(i) { f.items.append(i) } }; return f }
            return folders
        }
        configure(&actions, &services)
        let c = SidebarViewController(context: SidebarContext(services: services, actions: actions, storage: storage, hub: hub, timing: timing), input: input)
        self.c = c
        let content = FlippedContent(frame: NSRect(x: 0, y: 0, width: 1200, height: 900))
        window.contentView = content
        c.view.frame = NSRect(x: 0, y: 0, width: input.width, height: 900)
        content.addSubview(c.view)
        c.view.layoutSubtreeIfNeeded()
    }

    func view(_ id: String) -> NSView? { c.rows[id] }
    func row(_ id: String) -> SBRowView? { c.rows[id] as? SBRowView }
    /// A view's frame in the sidebar (y down).
    func frame(_ id: String) -> CGRect? { view(id).map { c.view.convert($0.bounds, from: $0) } }
    /// Ids of this prefix, top to bottom.
    func ids(_ prefix: String) -> [String] {
        c.rows.filter { $0.key.hasPrefix(prefix) }.sorted { (frame($0.key)?.minY ?? 0) < (frame($1.key)?.minY ?? 0) }.map { String($0.key.dropFirst(prefix.count)) }
    }

    func click(_ view: NSView, at local: CGPoint? = nil, count: Int = 1, right: Bool = false) {
        let p = local ?? CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        let inWindow = view.convert(p, to: nil)
        // A window never ordered front takes no mouse events through sendEvent; AppKit's own dispatch is done here: the
        // view the content view hit-tests at that point gets the down and the up (a plain view hands them up the chain).
        for n in 1...count {
            let content = window.contentView!
            guard let hit = content.hitTest(content.superview?.convert(inWindow, from: nil) ?? inWindow) else { XCTFail("nothing at \(inWindow)"); return }
            let down = NSEvent.mouseEvent(with: right ? .rightMouseDown : .leftMouseDown, location: inWindow, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: n, pressure: 1)!
            if right { hit.rightMouseDown(with: down); return }
            hit.mouseDown(with: down)
            let up = NSEvent.mouseEvent(with: .leftMouseUp, location: inWindow, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: n, pressure: 0)!
            hit.mouseUp(with: up)
        }
    }

    /// The colour drawn at `point` of the sidebar (y down), as sRGB 0–255.
    func pixel(_ point: CGPoint) -> (r: Int, g: Int, b: Int) {
        let v = c.view
        let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)!
        v.cacheDisplay(in: v.bounds, to: rep)
        let sx = CGFloat(rep.pixelsWide) / v.bounds.width, sy = CGFloat(rep.pixelsHigh) / v.bounds.height
        // The raw values drawn (the window draws in sRGB; the rep may be tagged otherwise, and converting would shift them).
        var px = [Int](repeating: 0, count: max(4, rep.samplesPerPixel))
        rep.getPixel(&px, atX: Int(point.x * sx), y: Int(point.y * sy))
        let scale = rep.bitsPerSample == 16 ? 257 : 1
        return (px[0] / scale, px[1] / scale, px[2] / scale)
    }

    func spin(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
}

final class FlippedContent: NSView { override var isFlipped: Bool { true } }

func near(_ a: (r: Int, g: Int, b: Int), _ hex: String, _ tol: Int = 3, file: StaticString = #filePath, line: UInt = #line) {
    let c = NSColor(hex: hex).usingColorSpace(.sRGB)!
    let want = (Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
    XCTAssertTrue(abs(a.r - want.0) <= tol && abs(a.g - want.1) <= tol && abs(a.b - want.2) <= tol, "pixel \(a) is not \(hex)", file: file, line: line)
}

@MainActor
final class SidebarViewTests: XCTestCase {
    static let roots = [
        ws("gs", "Getting started", at(600)),
        ws("ui", "User Interface", at(500), [ws("sb", "Sidebar", at(5), [ws("ic", "Iconography", at(400))]), ws("mc", "Middle Canvas", at(50))]),
        ws("ag", "Agents", at(450), [ws("bb", "Bart build agents", at(30), [ws("sx", "Sandbox", at(31))])]),
        ws("lb", "Library", at(100)),
    ]
    static let notes = (0..<7).map { row("n\($0)", "Note \($0)", "md", ["note"]) }
    static let rows = notes + [row("w1", "Magic Ink", "website", url: "https://worrydream.com/MagicInk/"), row("w2", "Linear refresh", "website"),
                               row("g1", "engelbart-canvas", "folder", ["git"]), row("p1", "Working spheres", "pdf")]

    func input(_ edit: (inout SidebarInput) -> Void = { _ in }) -> SidebarInput {
        var i = SidebarInput(project: SidebarProject(id: "p", name: "Engelbart"))
        i.width = 300
        i.roots = Self.roots
        i.hereId = "sb"
        i.entries = [AgentEntry(id: "agent:a1", kind: "bart", title: "Bart", node: "bb", state: "unseen", at: JSTime.iso(JSTime.now() - 180_000)),
                     AgentEntry(id: "build:b1", kind: "build", title: "Pills", node: "ic", state: "running", at: JSTime.iso(JSTime.now() - 60_000))]
        i.rows = Self.rows
        i.library = Self.rows
        i.inRail = Set(Self.rows.map(\.id))
        i.folders = [StoreValues.folder(id: "f1", name: "References", items: ["w1", "gone"])]
        edit(&i)
        return i
    }

    func testHead() {
        let h = Harness(input())
        let head = h.c.root.head
        XCTAssertEqual(head.project.name, "Engelbart")
        XCTAssertEqual(head.project.frame.height, 30)
        XCTAssertLessThan(head.settings.frame.minX, head.newNote.frame.minX, "Settings, then New note")
        XCTAssertEqual(head.settings.frame.size, CGSize(width: 28, height: 28))
        XCTAssertEqual(h.c.root.head.frame.height, 36)
        // the name's button is as wide as its words and chevron
        XCTAssertEqual(head.project.frame.width, head.project.fittingWidth, accuracy: 0.5)
        h.click(head.settings)
        XCTAssertEqual(h.calls, ["settings"])
    }

    func testFixedRows() {
        let h = Harness(input())
        XCTAssertEqual(h.ids("sb-trigger=").filter { ["agents", "library"].contains($0) }, ["agents", "library"])
        let agents = h.frame("sb-trigger=agents")!, library = h.frame("sb-trigger=library")!, search = h.frame("sb-fixed-row=search")!
        XCTAssertEqual(agents.height, 30); XCTAssertEqual(library.minY - agents.maxY, 1, "gap 1"); XCTAssertEqual(search.minY - library.maxY, 1)
        XCTAssertEqual(agents.minY, 36 + 4, "under the head, padding-top 4")
        XCTAssertEqual((h.view("sb-count=library") as? SBLabel)?.text, "11", "the library's size")
        XCTAssertEqual(h.row("sb-fixed-row=search")?.look.label, "Search")
    }

    func testAgentsPill() {
        let h = Harness(input())
        let pill = h.c.rows["sb-trigger=agents"].flatMap { ($0 as? SBRowView)?.accessories.first as? SBCountView }!
        XCTAssertTrue(pill.pill); XCTAssertTrue(pill.running); XCTAssertEqual(pill.label, "2"); XCTAssertFalse(pill.isHidden)
        XCTAssertEqual(pill.frame.size, CGSize(width: 22, height: 22))
        h.c.update(input { $0.entries = [AgentEntry(id: "a", node: "sb", state: "needs"), AgentEntry(id: "b", state: "unseen")] })
        let ready = (h.row("sb-trigger=agents")!.accessories.first as! SBCountView)
        XCTAssertFalse(ready.running); XCTAssertEqual(ready.label, "2")
        h.c.update(input { $0.entries = (0..<12).map { AgentEntry(id: "e\($0)", node: "sb", state: "unseen") } })
        XCTAssertEqual((h.row("sb-trigger=agents")!.accessories.first as! SBCountView).label, "9+")
        h.c.update(input { $0.entries = [AgentEntry(id: "old", node: "sb", state: "done")] })
        XCTAssertTrue((h.row("sb-trigger=agents")!.accessories.first as! SBCountView).isHidden, "nothing to count: no pill")
    }

    func testProjects() {
        let h = Harness(input())
        XCTAssertEqual(h.ids("sb-project-row="), ["ui", "sb", "ic", "mc", "ag", "lb"])
        XCTAssertTrue(h.row("sb-project-row=sb")!.look.active)
        XCTAssertNotNil(h.view("sb-more=projects"), "More, for Getting started")
        XCTAssertEqual(["ui", "sb", "ic", "mc", "ag", "lb"].map { h.row("sb-project-row=\($0)")!.level }, [2, 3, 4, 3, 2, 2])
        // indentation: level 3 rows 24 in, level 4 rows 46 in; indented rows draw no icon
        XCTAssertEqual(h.frame("sb-project-row=sb")!.minX - h.frame("sb-project-row=ui")!.minX, 24)
        XCTAssertEqual(h.frame("sb-project-row=ic")!.minX - h.frame("sb-project-row=ui")!.minX, 46)
        XCTAssertEqual(h.row("sb-project-row=sb")!.labelX, 10, "indented: no icon, padding 10")
        XCTAssertEqual(h.row("sb-project-row=ui")!.labelX, 8 + 18 + 10, "icon box 18, margin 10")
        // Projects' head: 12 below Search
        XCTAssertEqual(h.frame("sb-head=projects")!.minY - h.frame("sb-fixed-row=search")!.maxY, 12)
    }

    func testCounts() {
        let h = Harness(input())
        func count(_ id: String) -> SBCountView? { h.view("sb-project-row=\(id)").flatMap { ($0 as! SBRowView).accessories[1].subviews.first as? SBCountView } }
        XCTAssertEqual(["ui", "sb", "ic", "ag"].map { count($0)?.label }, ["1", "1", "1", "1"])
        XCTAssertNil(count("lb"))
        XCTAssertTrue(count("ui")!.running, "grey and breathing while it runs")
        XCTAssertFalse(count("ag")!.running, "dark once ready")
        XCTAssertEqual(count("ui")!.toolTip, "0 to look at, 1 running")
    }

    func testPlusAndShortcuts() {
        let h = Harness(input())
        XCTAssertNotNil(h.view("sb-new-workspace"))
        XCTAssertEqual(h.view("sb-new-workspace")!.accessibilityLabel(), "Create project within Engelbart")
        XCTAssertEqual(h.ids("sb-new-child=").sorted(), ["ag", "lb", "mc", "sb", "ui"], "Iconography is the fourth level: no +")
        XCTAssertEqual(h.view("sb-project-row=ui")!.accessibilityLabel(), "User Interface, Ctrl+2")
        XCTAssertEqual(h.view("sb-project-row=sb")!.accessibilityLabel(), "Sidebar")
        XCTAssertTrue((h.view("sb-new-child=ui") as! SBView).isHidden, "the + shows on the row's hover")
        h.row("sb-project-row=ui")!.setHovered(true)
        XCTAssertFalse((h.view("sb-new-child=ui") as! SBView).isHidden)
    }

    func testChevronsAndGuide() {
        let h = Harness(input())
        let ui = h.view("sb-chevron=ui") as! SBIconButton, ag = h.view("sb-chevron=ag") as! SBIconButton
        XCTAssertFalse(ui.rotated, "User Interface: open, down"); XCTAssertFalse(ui.revealOnHover, "in its branch: always shown")
        XCTAssertTrue(ag.rotated, "Agents: folded, up"); XCTAssertTrue(ag.revealOnHover, "a level-2 project you are not in: on hover")
        XCTAssertEqual(h.c.root.list.guides.count, 1)
        let guide = h.c.root.list.guides[0]
        let sb = h.c.root.list.convert(h.view("sb-project-row=sb")!.bounds, from: h.view("sb-project-row=sb"))
        XCTAssertEqual(guide.minX, sb.minX + 10.5, "beside Sidebar's children (level 4): 10.5 in")
        XCTAssertEqual(guide.minY, sb.maxY + 2)
        XCTAssertEqual(guide.height, 30 - 4)
        // a chevron opens Agents and folds User Interface (one branch at a time); it shows on the row's hover
        XCTAssertTrue(ag.isHidden)
        h.row("sb-project-row=ag")!.setHovered(true)
        XCTAssertFalse(ag.isHidden)
        h.click(ag)
        XCTAssertTrue(h.c.expanded.contains("ag")); XCTAssertFalse(h.c.expanded.contains("ui"))
        XCTAssertEqual(h.ids("sb-project-row="), ["ui", "ag", "bb", "lb"])
    }

    func testClickAndRename() {
        let h = Harness(input())
        h.click(h.view("sb-project-row=mc")!)
        XCTAssertEqual(h.calls.last, "select:mc")
        h.click(h.view("sb-project-row=mc")!, count: 2)
        XCTAssertEqual(h.c.renaming, "mc")
        guard let field = h.row("sb-project-row=mc")?.renameField as? RenameField else { return XCTFail("no rename field") }
        XCTAssertEqual(field.stringValue, "Middle Canvas")
        field.stringValue = "Middle/Canvas"
        field.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
        XCTAssertEqual(field.stringValue, "Middle-Canvas", "/ and \\ become -")
        field.finish(true)
        XCTAssertEqual(h.calls.last, "rename:mc:Middle-Canvas")
        XCTAssertNil(h.c.renaming)
    }

    func testSectionsFoldAndRemember() {
        let h = Harness(input())
        h.click(h.view("sb-head=projects")!, at: CGPoint(x: 12, y: 15))
        XCTAssertEqual(h.storage.opened()["section:projects"], false)
        XCTAssertEqual(h.ids("sb-project-row="), [])
        XCTAssertTrue(h.row("sb-head=projects")!.look.sectionOpen == false)
        // a press past the name and chevron does nothing
        h.click(h.view("sb-head=projects")!, at: CGPoint(x: 200, y: 15))
        XCTAssertEqual(h.storage.opened()["section:projects"], false)
        // remembered for the next sidebar
        let again = Harness(input(), storage: h.storage)
        XCTAssertEqual(again.ids("sb-project-row="), [])
    }

    func testSources() {
        let h = Harness(input())
        XCTAssertEqual(h.ids("sb-folder=").filter { ["project", "f1"].contains($0) }, ["project", "f1"])
        XCTAssertEqual(h.row("sb-folder=project")!.expanded, true)
        XCTAssertEqual(h.row("sb-folder=f1")!.expanded, false)
        XCTAssertEqual(h.ids("sb-source="), ["n0", "n1", "n2", "n3"], "eleven sources: four, then More")
        XCTAssertNotNil(h.view("sb-more=project"))
        XCTAssertNotNil(h.view("sb-create-folder"))
        XCTAssertEqual(h.row("sb-folder=project")!.look.label, "Sidebar", "named after the project here")
        XCTAssertEqual(h.frame("sb-source=n0")!.minX - h.frame("sb-folder=project")!.minX, 24, "folder rows indented 24")
        XCTAssertNil(h.row("sb-source=n0")!.look.icon, "no icon beside a file in a folder")
        // a press on the folder unfolds it, remembered
        h.click(h.view("sb-folder=f1")!)
        XCTAssertEqual(h.storage.opened()["folder:f1"], true)
        XCTAssertEqual(h.ids("sb-source=").filter { $0 == "w1" }, ["w1"], "References holds Magic Ink; the gone id is left out")
        // its source's minus takes it out of the folder
        XCTAssertEqual(h.view("sb-remove=w1")?.accessibilityLabel(), "Remove from References")
    }

    func testSourceIconsAndOpen() {
        let h = Harness(input { $0.rows = Array(Self.rows.suffix(4)) })
        XCTAssertEqual(h.ids("sb-source="), ["w1", "w2", "g1", "p1"])
        h.click(h.view("sb-source=w1")!)
        XCTAssertEqual(h.calls.last, "open:w1")
        XCTAssertEqual(h.view("sb-remove=w1")?.accessibilityLabel(), "Remove from this project")
        h.row("sb-source=w1")!.setHovered(true)
        h.click(h.view("sb-remove=w1")!)
        XCTAssertEqual(h.calls.last, "remove:w1")
    }

    func testFoot() {
        let h = Harness(input())
        XCTAssertEqual(h.c.root.foot.toggle.look.label, "Hide stickies")
        XCTAssertTrue(h.c.root.foot.trash.isHidden)
        h.click(h.c.root.foot.toggle)
        XCTAssertEqual(h.calls.last, "stickies")
        h.c.update(input { $0.stickiesHidden = true; $0.trashFull = true })
        XCTAssertEqual(h.c.root.foot.toggle.look.label, "Show stickies")
        XCTAssertEqual(h.c.root.foot.toggle.look.icon?.shapes.first?.dash, [2.6, 2.4], "dotted while hidden")
        XCTAssertFalse(h.c.root.foot.trash.isHidden)
        // the foot sits 10 above the bottom
        XCTAssertEqual(h.c.root.foot.frame.maxY, 900 - 10)
        // a sticky dragged: the drop target
        h.c.update(input { $0.stickyDrag = StickyDrag(active: true, over: true) })
        XCTAssertTrue(h.c.root.foot.toggle.isHidden)
        let foot = h.c.root.foot.frame
        near(h.pixel(CGPoint(x: foot.minX + 3, y: foot.midY)), "#e6e6e6")
    }

    func testEmptyAndHidden() {
        let h = Harness(input { $0.roots = []; $0.hereId = nil; $0.rows = []; $0.entries = [] })
        XCTAssertTrue(h.c.root.list.subviews.contains { ($0.subviews.first as? SBLabel)?.text == "No projects yet" })
        XCTAssertNotNil(h.view("sb-new-workspace"))
        XCTAssertNil(h.view("sb-more=projects"))
        XCTAssertNil(h.view("sb-add-sources"), "no project here: no + on Sources")
        h.c.update(input { $0.hidden = true })
        XCTAssertTrue(h.c.view.isHidden)
        XCTAssertEqual(h.c.view.frame.width, 300)
    }

    func testPixels() {
        let h = Harness(input())
        near(h.pixel(CGPoint(x: 2, y: 300)), "#fafafa")
        let sb = h.frame("sb-project-row=sb")!
        near(h.pixel(CGPoint(x: sb.minX + 3, y: sb.midY)), "#e6e6e6")
        let mc = h.frame("sb-project-row=mc")!
        near(h.pixel(CGPoint(x: mc.minX + 3, y: mc.midY)), "#fafafa")
        h.row("sb-project-row=mc")!.setHovered(true)
        near(h.pixel(CGPoint(x: mc.minX + 3, y: mc.midY)), "#efefef")
        // the guide line
        let g = h.c.root.list.guides[0]
        let inRoot = h.c.view.convert(g, from: h.c.root.list)
        let line = h.pixel(CGPoint(x: inRoot.minX + 0.5, y: inRoot.midY))
        XCTAssertLessThan(line.r, 0xf4, "the guide line (#dcdcdc, antialiased at 1x) is drawn: \(line)")
    }

    func testFlash() {
        let h = Harness(input { $0.flashId = "n0" })
        let n0 = h.frame("sb-source=n0")!
        let p = h.pixel(CGPoint(x: n0.minX + 3, y: n0.midY))
        XCTAssertTrue(p.b > p.r, "flashing blue at first: \(p)")
        h.spin(0.35)
        near(h.pixel(CGPoint(x: n0.minX + 3, y: n0.midY)), "#fafafa")
    }

    func testPanelsToggle() {
        let h = Harness(input())
        h.click(h.view("sb-trigger=library")!)
        XCTAssertEqual(h.c.openPanel, "library")
        XCTAssertTrue(h.row("sb-trigger=library")!.look.active)
        XCTAssertEqual(h.calls.last, "panel:library")
        XCTAssertNotNil(h.c.libraryModel)
        h.click(h.view("sb-trigger=library")!)
        XCTAssertNil(h.c.openPanel, "a second press closes it")
        h.click(h.view("sb-trigger=agents")!)
        XCTAssertEqual(h.c.openPanel, "agents")
        h.click(h.view("sb-more=projects")!)
        XCTAssertEqual(h.c.openPanel, "projects", "one panel at a time")
        XCTAssertEqual(h.c.projectsModel?.folded, ["ag"], "every level-2 with something under it folded but yours")
        h.c.close()
        h.c.openLibrary(chip: "papers")
        XCTAssertEqual(h.c.openPanel, "library")
        XCTAssertEqual(h.c.libraryModel?.picked, "papers")
        h.c.close()
    }

    func testPanelAnchor() {
        let h = Harness(input())
        h.click(h.view("sb-trigger=agents")!)
        let anchor = h.c.panel!.anchor
        let row = FloatingPanel.anchorRect(of: h.view("sb-trigger=agents")!)
        XCTAssertEqual(anchor.minY, row.minY); XCTAssertEqual(anchor.maxX, 300, "the sidebar's right edge")
        h.c.close()
    }

    func testAddPickerOpensFromPlus() {
        let h = Harness(input())
        h.click(h.view("sb-add-sources")!)
        XCTAssertEqual(h.c.openPanel, "add")
        XCTAssertEqual(h.c.addModel?.intoName, "Sidebar")
        h.click(h.view("sb-add-sources")!)
        XCTAssertNil(h.c.openPanel)
    }

    func testFoldersFollowTheStore() {
        let h = Harness(input { $0.folders = nil }, folders: [StoreValues.folder(id: "f9", name: "Reading")])
        h.spin(0.1)
        XCTAssertEqual(h.c.folders.map(\.name), ["Reading"])
        XCTAssertNotNil(h.view("sb-folder=f9"))
        h.hub.post("engelbart:folders", ["folders": [["id": "f8", "name": "Later", "items": [], "created": .null]]])
        XCTAssertEqual(h.c.folders.map(\.name), ["Later"])
        XCTAssertNotNil(h.view("sb-folder=f8"))
    }

    func testAddIntoFolder() async throws {
        let h = Harness(input(), folders: [StoreValues.folder(id: "f1", name: "References")]) { actions, services in
            services.addLibraryItem = { _ in throw StoreError("Already in the library as “Magic Ink”", code: "EXISTS", row: row("w1", "Magic Ink", "website")) }
        }
        let made = try await h.c.addInput("https://worrydream.com/MagicInk/", folderId: "f1")
        XCTAssertEqual(made.id, "w1")
        XCTAssertEqual(h.calls.suffix(2), ["addToFolder:f1:w1", "flash:w1"])
    }

    func testNewNoteInto() {
        let h = Harness(input())
        h.click(h.c.root.head.newNote)
        h.spin(0.05)
        XCTAssertEqual(h.calls.last, "newNote")
        let empty = Harness(input { $0.rows = [] })
        XCTAssertNotNil(empty.view("sb-plus-note"), "an empty project folder offers + Note")
        XCTAssertEqual(empty.row("sb-plus-note")?.look.label, "+ Note")
    }

    func testTourUnfoldsSources() {
        let storage = MemoryStorage()
        storage.setOpened(["section:sources": false])
        let h = Harness(input(), storage: storage)
        XCTAssertNil(h.view("sb-folder=project"))
        h.c.update(input { $0.tourStep = 1 })
        XCTAssertNotNil(h.view("sb-folder=project"))
        let holes = h.c.tourHoles(step: 1)
        XCTAssertEqual(holes.count, 1)
        let head = FloatingPanel.anchorRect(of: h.view("sb-head=sources")!)
        XCTAssertEqual(holes[0].minY, head.minY - 5, accuracy: 1, "padded 5")
        XCTAssertEqual(h.c.tourHoles(step: 2).count, 1, "the person's folders and Create new")
    }

    func testDragCarriesTheRow() {
        let item = SidebarDrag.pasteboardItem([row("w1", "Magic Ink", "website", url: "https://worrydream.com/MagicInk/")])
        // through a pasteboard, as a drag carries it to the document (DocEditorView reads the same type)
        let pb = NSPasteboard(name: NSPasteboard.Name("sidebar-test-\(UUID().uuidString)"))
        pb.clearContents()
        XCTAssertTrue(pb.writeObjects([item]))
        XCTAssertTrue(SidebarDrag.carriesRows(pb))
        let list = SidebarDrag.rows(pb)
        guard !list.isEmpty else { return XCTFail("no rows on the pasteboard") }
        XCTAssertEqual(list.first?["id"] as? String, "w1")
        XCTAssertEqual(list.first?["name"] as? String, "Magic Ink")
        XCTAssertTrue(pb.string(forType: .string)?.hasPrefix("@[") ?? false)
        pb.releaseGlobally()
    }
}

@MainActor
final class PanelModelTests: XCTestCase {
    func testLibraryModel() {
        let lib = [row("n1", "Note on retrieval", "md", ["note"], lastEdited: "2026-10-10T00:00:00.000Z"), row("p1", "ColBERT", "pdf", ["paper"], lastEdited: "2026-10-09T00:00:00.000Z")]
        let m = LibraryPanelModel(library: lib, inRail: { $0 == "p1" }, lookup: LookupModel(ask: { _ in StoreValues.lookup() }, delay: 0))
        XCTAssertEqual(m.chips.map(\.id), ["all", "notes", "papers"])
        XCTAssertEqual(m.heading, "Recent")
        XCTAssertEqual(m.rows.map(\.key), ["n1", "p1"])
        m.pickChip("papers")
        XCTAssertEqual(m.chip, "papers"); XCTAssertEqual(m.heading, "Recent papers")
        m.pickChip("papers")
        XCTAssertEqual(m.chip, "all", "a press on the chip that is on goes back to All")
        m.query = "zzz"
        XCTAssertEqual(m.empty, "Nothing in the library by that name.")
        m.picked = "notes"
        XCTAssertEqual(m.empty, "No notes match")
        m.query = ""
        XCTAssertEqual(m.rows.map(\.key), ["n1"])
        // ↓ moves, Enter opens and closes
        var opened: [String] = [], closed = 0
        m.onOpen = { opened.append($0.id) }; m.onClose = { closed += 1 }
        m.picked = "all"
        m.query = "colb"
        XCTAssertTrue(m.key(.enter))
        XCTAssertEqual(opened, ["p1"]); XCTAssertEqual(closed, 1)
        // a picker leaves out what is there
        let picker = LibraryPanelModel(library: lib, inRail: { _ in false }, picking: .init(has: { $0 == "n1" }, onPick: { _ in }), lookup: LookupModel(ask: { _ in StoreValues.lookup() }, delay: 0))
        XCTAssertEqual(picker.rows.map(\.key), ["p1"])
    }

    func testAddPickerModel() async {
        let lib = (0..<8).map { row("r\($0)", "Row \($0)", "pdf", lastEdited: String(format: "2026-10-%02dT00:00:00.000Z", $0 + 1)) } + [row("i1", "Picture", "image", lastEdited: "2026-10-30T00:00:00.000Z")]
        let m = AddPickerModel(intoName: "Sidebar", library: lib, has: { $0 == "r7" })
        XCTAssertEqual(m.shown.map(\.key), ["r6", "r5", "r4", "r3", "r2"], "the five newest not there yet, no pictures")
        XCTAssertEqual(m.results.count, 7)
        m.q = "row 1"
        XCTAssertEqual(m.shown.map(\.key), ["r1"])
        XCTAssertFalse(m.stays)
        m.value = "github.com notes.md"
        XCTAssertTrue(m.stays, "a typed link keeps it")
        XCTAssertEqual(m.addLabel, "Add source")
        var added: [String] = []
        m.onAddInput = { text in added.append(text); return row("x-\(text)", text, "website") }
        m.commit()
        for _ in 0..<50 where m.busy || added.isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(added, ["github.com"])
        XCTAssertEqual(m.value, "notes.md", "what could not be stays, saying why")
        XCTAssertEqual(m.run.error, "\"notes.md\" is not a link or a path")
        XCTAssertEqual(m.added.map(\.name), ["github.com"])
        // hiding by itself
        XCTAssertTrue(AddPickerModel.inside(CGPoint(x: 111, y: 50), boxes: [CGRect(x: 0, y: 0, width: 100, height: 100)]))
        XCTAssertFalse(AddPickerModel.inside(CGPoint(x: 113, y: 50), boxes: [CGRect(x: 0, y: 0, width: 100, height: 100)]))
    }

    func testSearchDialogModel() {
        let flat = NavModel.flatWorkspaces(SidebarViewTests.roots)
        let rows = [row("n1", "Sidebar notes", "md", ["note"])]
        let lib = rows + [row("w1", "Sidebar patterns", "website")]
        let m = SearchDialogModel(workspaces: flat, rows: rows, library: lib, inRail: { $0 == "n1" }, lookup: LookupModel(ask: { _ in StoreValues.lookup() }, delay: 0))
        XCTAssertEqual(m.sections.count, 0)
        m.q = "sidebar"
        XCTAssertEqual(m.sections.map(\.title), ["Projects", "In this project", "Library"])
        XCTAssertEqual(m.flat.map(\.key), ["ws:sb", "here:n1", "lib:w1"])
        var went: [String] = []
        m.onGoWorkspace = { went.append($0) }
        XCTAssertTrue(m.key(.enter))
        XCTAssertEqual(went, ["sb"])
    }

    func testProjectTreeLines() {
        let tree = SidebarModel.indexTree([ws("a", "Alpha", nil, [ws("b", "Beta")], archives: [ArchiveEntry(file: "1.md", clearedAt: "2026-10-01T00:00:00Z", title: "Old alpha")]), ws("c", "Gamma")])
        var o = TreeOptions(tree: tree, counts: [:], hereId: nil, showVersions: true)
        XCTAssertEqual(ProjectTreeModel.lines(["a", "c"], o).map { $0.version?.title ?? $0.id }, ["a", "b", "Old alpha", "c"])
        o.folded = ["a"]
        XCTAssertEqual(ProjectTreeModel.lines(["a", "c"], o).map(\.id), ["a", "c"])
        o.q = "old"
        XCTAssertEqual(ProjectTreeModel.lines(["a", "c"], o).map { $0.version?.title ?? $0.id }, ["a", "Old alpha"], "a search opens what it finds")
        let deep = SidebarModel.indexTree([ws("x", "X", nil, [ws("y", "Y", nil, [ws("z", "Z")])])])
        XCTAssertEqual(ProjectTreeModel.deepest(deep["x"]!), 3)
        XCTAssertNil(ProjectTreeModel.deepest(SidebarModel.indexTree([ws("q", "Q", nil, [ws("r", "R")])])["q"]!), "only children: no guide")
        let m = ProjectsPanelModel(roots: [ws("a", "Alpha", nil, [ws("b", "Beta")]), ws("c", "Gamma")], tree: tree, hereId: "b")
        XCTAssertEqual(m.folded, [], "yours stays open")
        m.q = "zzz"; XCTAssertTrue(m.nothing)
    }

    func testPeekPlace() {
        let (origin, right) = PeekController.place(rect: CGRect(x: 10, y: 200, width: 280, height: 30), edge: 300, view: CGSize(width: 1200, height: 900))
        XCTAssertTrue(right); XCTAssertEqual(origin, CGPoint(x: 300, y: 188))
        let (o2, r2) = PeekController.place(rect: CGRect(x: 900, y: 880, width: 280, height: 30), edge: 1180, view: CGSize(width: 1200, height: 900))
        XCTAssertFalse(r2); XCTAssertEqual(o2, CGPoint(x: 900 - 360 - 16, y: 900 - 380))
    }

    func testAgentsPanelModel() {
        let entries = [AgentEntry(id: "1", state: "done"), AgentEntry(id: "2", state: "running"), AgentEntry(id: "3", state: "unseen"), AgentEntry(id: "4", state: "failed")]
        XCTAssertEqual(AgentsPanelModel.groups(entries).map(\.title), ["Running", "Failed", "Finished"])
        XCTAssertEqual(AgentsPanelModel.groups(entries).last?.list.map(\.id), ["1", "3"])
        XCTAssertTrue(AgentsPanelModel.unseen(entries))
        XCTAssertTrue(AgentsPanelModel.waiting(entries[2])); XCTAssertFalse(AgentsPanelModel.waiting(entries[0])); XCTAssertFalse(AgentsPanelModel.waiting(entries[1]))
        XCTAssertEqual(AgentsPanelModel.crumb(AgentEntry(id: "q", kind: "quick", state: "done"), crumbOf: { _ in [] }), ["A sticky"])
        XCTAssertEqual(AgentsPanelModel.crumb(AgentEntry(id: "r", kind: "repo", state: "failed", run: ["status": "failed", "error": "Claude Code is not installed"]), crumbOf: { _ in [] }), ["Build failed · Claude Code not installed"])
        XCTAssertEqual(AgentsPanelModel.crumb(AgentEntry(id: "r", kind: "repo", state: "unseen", run: ["status": "ready"], sandbox: "asleep"), crumbOf: { _ in [] }), ["Build finished · Asleep"])
        XCTAssertEqual(AgentsPanelModel.crumb(AgentEntry(id: "r", kind: "repo", state: "running", run: ["status": "starting"]), crumbOf: { _ in [] }), ["Building…"])
        XCTAssertEqual(AgentsPanelModel.crumb(AgentEntry(id: "x", node: "sb", state: "done"), crumbOf: { _ in ["User Interface", "Sidebar"] }), ["User Interface", "Sidebar"])
    }

    func testNameDialogModel() async {
        var made: [String] = []
        let m = NameDialogModel(title: "Create folder", placeholder: "Folder name", action: "Create folder") { made.append($0) }
        var closed = false
        m.onClose = { closed = true }
        m.create()
        XCTAssertFalse(m.busy, "Create waits for a name")
        m.name = "  Reading  "
        m.create()
        for _ in 0..<50 where !closed { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(made, ["Reading"]); XCTAssertTrue(closed)
        XCTAssertEqual(NameDialogModel.clean("a/b\\c"), "a-b-c")
        let failing = NameDialogModel(title: "", placeholder: "", action: "") { _ in throw StoreError("Projects go four levels deep") }
        failing.name = "x"
        failing.create()
        for _ in 0..<50 where failing.problem.isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(failing.problem, "Projects go four levels deep")
    }
}
