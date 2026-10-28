import AppKit
import SwiftUI
import XCTest
import EngelbartCore
import EngelbartConnect
import EngelbartUI
@testable import EngelbartImportUI

// The screens drawn offscreen: an NSWindow made with defer: false and never ordered front, the SwiftUI view in it, laid
// out and drawn into a bitmap. Asserted: which views are there (their drive markers, as the cloud drive scripts find
// them), where they are, what colour their pixels are, and that a synthesized click reaches the model.

@MainActor
final class Offscreen {
    let window: NSWindow
    let host: NSView
    init<V: View>(_ view: V, size: NSSize = NSSize(width: 1000, height: 760)) {
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        window.contentView = host
        self.host = host
        settle()
    }
    func settle(_ seconds: Double = 0.15) {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        } while Date() < end
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
    }
    /// The drive marker named `id` in this window (EngelbartUI's DriveRegistry answers only for visible windows, and this
    /// one is never ordered front, so the window's views are walked and each marker's `id` read).
    func marker(_ id: String) -> NSView? {
        var found: NSView?
        func walk(_ view: NSView) {
            if String(describing: type(of: view)) == "DriveMarkerView", !view.isHiddenOrHasHiddenAncestor,
               Mirror(reflecting: view).children.contains(where: { $0.label == "id" && ($0.value as? String) == id }) { found = view }
            view.subviews.forEach(walk)
        }
        if let content = window.contentView { walk(content) }
        return found
    }
    func ids() -> [String] { DriveRegistry.ids(in: [window]) }
    /// A marker's frame in the host, y from the top.
    func frame(_ id: String) -> NSRect? {
        guard let view = marker(id) else { return nil }
        var rect = view.convert(view.bounds, to: host)
        if !host.isFlipped { rect.origin.y = host.bounds.height - rect.maxY }
        return rect
    }
    func bitmap() -> NSBitmapImageRep {
        let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: rep)
        return rep
    }
    /// The colour at a point of the host (y from the top), as sRGB 0…255.
    func pixel(_ p: NSPoint, in rep: NSBitmapImageRep? = nil) -> (r: Int, g: Int, b: Int) {
        let rep = rep ?? bitmap()
        let scale = CGFloat(rep.pixelsWide) / host.bounds.width
        let c = rep.colorAt(x: Int(p.x * scale), y: Int(p.y * scale))?.usingColorSpace(.sRGB) ?? .clear
        return (Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
    }
    func center(_ id: String) -> NSPoint? { frame(id).map { NSPoint(x: $0.midX, y: $0.midY) } }
    /// A click at a marker's centre, sent to the window as AppKit would deliver it.
    func click(_ id: String) {
        guard let p = center(id) else { return XCTFail("no \(id)") }
        let inWindow = host.convert(NSPoint(x: p.x, y: host.isFlipped ? p.y : host.bounds.height - p.y), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            window.sendEvent(event)
        }
        settle(0.1)
    }
    func close() { window.close() }
}

func dark(_ c: (r: Int, g: Int, b: Int)) -> Bool { c.r < 60 && c.g < 60 && c.b < 60 }
func near(_ c: (r: Int, g: Int, b: Int), _ hex: Int, _ tolerance: Int = 12) -> Bool {
    abs(c.r - (hex >> 16 & 0xff)) <= tolerance && abs(c.g - (hex >> 8 & 0xff)) <= tolerance && abs(c.b - (hex & 0xff)) <= tolerance
}

@MainActor
final class ViewTests: XCTestCase {
    func flow(_ api: FakeImportAPI, mode: ImportFlowMode = .new, into: String? = nil) async -> ImportFlowModel {
        let m = ImportFlowModel(api: api, mode: mode, into: into, defaults: UserDefaults(suiteName: "view-\(UUID().uuidString)")!)
        await m.start()
        return m
    }

    func testIntroDrawsItsLogosAndButtons() async {
        let m = await flow(FakeImportAPI())
        let screen = Offscreen(ImportFlowView(model: m))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("import-screen=intro"))
        let start = screen.frame("import-start")!
        XCTAssertEqual(start.width, 270, accuracy: 1, "the primary button is 270 wide")
        XCTAssertEqual(start.height, 44, accuracy: 1)
        let rep = screen.bitmap()
        XCTAssertTrue(dark(screen.pixel(NSPoint(x: start.minX + 8, y: start.midY), in: rep)), "filled ink")
        XCTAssertNotNil(screen.marker("import-skip"))
        XCTAssertLessThan(screen.frame("import-skip")!.maxX, start.minX, "Skip on the left of the row")
        XCTAssertNil(screen.marker("import-close"), "no × in a new user's onboarding")
        // Import context asks for the provider (the button's action; SwiftUI takes no synthesized clicks in a window never
        // ordered front: the app's drive scripts click in the cloud run).
        await m.importContext()
        XCTAssertEqual(m.state.dialog, "provider-choice")
        screen.settle()
        XCTAssertNotNil(screen.marker("dialog=provider-choice"))
        XCTAssertNotNil(screen.marker("onboarding-provider=anthropic"))
        XCTAssertNotNil(screen.marker("onboarding-provider=openai"))
    }

    func testModalIntroHasItsClose() async {
        var closed = false
        let api = FakeImportAPI()
        let m = ImportFlowModel(api: api, mode: .modal, into: "p", defaults: UserDefaults(suiteName: "v-\(UUID().uuidString)")!, onClose: { _ in closed = true })
        await m.start()
        m.state.screen = "intro"; m.state.dialog = nil
        let screen = Offscreen(ImportFlowView(model: m))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("import-close"))
        await m.close()
        XCTAssertTrue(closed)
    }

    func testPickerRecommendedFirstAndItsAlwaysDrawnScrollbar() async {
        let m = await flow(FakeImportAPI())
        m.state.screen = "picker"
        m.state.picked = ["x"]
        m.pickSource("Obsidian")
        let screen = Offscreen(ImportFlowView(model: m), size: NSSize(width: 1000, height: 700))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("import-screen=picker"))
        let recommended = screen.frame("recommended=Obsidian")!
        let home = screen.frame("app=Obsidian")
        XCTAssertNotNil(screen.marker("group-section=recommended"))
        if let home { XCTAssertGreaterThan(home.minY, recommended.minY, "Recommended comes first") }
        XCTAssertGreaterThan(recommended.width, 300, "a row across the column")
        let rep = screen.bitmap()
        // The list's own box, with the scrollbar always drawn.
        let scroll = findScroll(screen.host)
        XCTAssertNotNil(scroll)
        XCTAssertTrue(scroll?.verticalScroller is PickerScroller)
        XCTAssertFalse(scroll?.autohidesScrollers ?? true)
        XCTAssertEqual(scroll?.scrollerStyle, .legacy)
        if let scroll, let bar = scroll.verticalScroller {
            XCTAssertFalse(bar.isHidden)
            XCTAssertEqual(bar.frame.width, 10, accuracy: 0.5)
            var r = bar.convert(bar.bounds, to: screen.host)
            if !screen.host.isFlipped { r.origin.y = screen.host.bounds.height - r.maxY }
            let track = screen.pixel(NSPoint(x: r.midX, y: r.maxY - 4), in: rep)
            XCTAssertTrue(near(track, 0xf2f2f2, 10) || near(track, 0xc2c2c2, 10), "the track or thumb is drawn: \(track)")
        }
        // The foot: Import to Engelbart, with the count.
        XCTAssertNotNil(screen.marker("import-run"))
        // Specify context opens under the row it was opened from.
        m.toggleSpecify("Obsidian", "recommended")
        screen.settle()
        XCTAssertNotNil(screen.marker("context-panel=Obsidian"))
        XCTAssertNotNil(screen.marker("choose-files=Obsidian"))
    }

    func findScroll(_ view: NSView) -> NSScrollView? {
        if let s = view as? NSScrollView, s.identifier?.rawValue == "picker-scroll" { return s }
        for sub in view.subviews { if let s = findScroll(sub) { return s } }
        return nil
    }

    func testEveryDialogDraws() async {
        let api = FakeImportAPI(browsers: ["chrome", "safari"])
        let m = await flow(api)
        m.state.screen = "picker"
        m.state.customProjects = [FlowProject(id: "a", title: "A"), FlowProject(id: "b", title: "B")]
        m.state.picked = ["a", "b"]
        let screen = Offscreen(ImportFlowView(model: m))
        defer { screen.close() }
        let widths = ["import-method": 560.0, "organize": 480, "safari": 540, "obsidian-picker": 540, "keychain": 486, "agents-consent": 486]
        for d in ["scratch-confirm", "project", "provider-choice", "import-method", "agents-consent", "keychain", "safari", "browser-profile", "notes-permission", "keychain-browser",
                  "organize", "browser-agents", "browser-agents-confirm", "starting", "first-project", "obsidian-picker", "work-add-project", "work-add-tool"] {
            m.state.dialog = d
            screen.settle(0.08)
            XCTAssertNotNil(screen.marker("dialog=\(d)"), d)
            if let width = widths[d] { XCTAssertEqual(screen.frame("dialog=\(d)")?.width ?? 0, width, accuracy: 1, d) }
        }
        m.state.dialog = "import-method"
        screen.settle()
        XCTAssertNotNil(screen.marker("import-method=agents"))
        XCTAssertNotNil(screen.marker("import-method=manual"))
        m.state.dialog = "organize"
        screen.settle()
        XCTAssertNotNil(screen.marker("organize-connect"))
        XCTAssertNotNil(screen.marker("organize-enabled=agents"))
    }

    func testTheWorkScreens() async {
        let api = FakeImportAPI()
        let m = await flow(api)
        let screen = Offscreen(ImportFlowView(model: m))
        defer { screen.close() }
        for (s, id) in [("roles", "work-role=Researcher"), ("work", "work-description"), ("projects", "add-project")] {
            m.state.screen = s
            screen.settle(0.08)
            XCTAssertNotNil(screen.marker("import-screen=\(s)"), s)
            XCTAssertNotNil(screen.marker(id), id)
        }
        m.state.screen = "projects"
        _ = try? await api.discoverProjects(provider: "anthropic", again: true)
        api.settleProjects()
        await until("projects") { m.projects.count == 4 }
        screen.settle()
        XCTAssertNotNil(screen.marker("work-project=engelbart"))
        m.error = "Something failed"
        screen.settle()
        XCTAssertNotNil(screen.marker("import-error"))
    }

    func testThePopupsDraw() {
        let need: JSONValue = ["id": "n", "app": "Notion", "kind": "connector", "busy": true]
        let needScreen = Offscreen(NeedPopupView(need: need, onOpen: {}, onDone: {}, onSkip: {}, onLater: {}))
        XCTAssertNotNil(needScreen.marker("need-popup=n"))
        XCTAssertNotNil(needScreen.marker("need-later=n"), "Skip is never disabled")
        XCTAssertEqual(needScreen.frame("need-popup=n")?.width ?? 0, 1000, accuracy: 1, "the scrim covers the window")
        needScreen.close()

        let running: JSONValue = ["id": "s", "jobs": [["id": "j", "kind": "import", "apps": ["Obsidian"], "status": "running", "notes": 2], ["id": "k", "kind": "import", "apps": ["Notion"], "status": "waiting"]],
                                  "needs": [["id": "n1", "app": "Notion", "kind": "connector"]], "leftOut": []]
        var stopped = false
        let status = Offscreen(ImportStatusView(session: running, onClose: {}, onNeed: { _ in }, onStop: { stopped = true }, onDone: {}))
        XCTAssertNotNil(status.marker("background-job=j"))
        XCTAssertNotNil(status.marker("need-open=n1"))
        XCTAssertNotNil(status.marker("import-stop-all"))
        status.close()
        let confirm = Offscreen(ImportStatusView(session: running, previewStop: true, onClose: {}, onNeed: { _ in }, onStop: { stopped = true }, onDone: {}))
        XCTAssertNotNil(confirm.marker("stop-confirm"))
        XCTAssertNotNil(confirm.marker("import-stop-confirm"))
        XCTAssertNotNil(confirm.marker("import-keep"))
        XCTAssertFalse(stopped)
        confirm.close()
        let ended = running.with("jobs", [["id": "j", "kind": "import", "apps": ["Obsidian"], "status": "done", "notes": 2]]).with("needs", [])
        let done = Offscreen(ImportStatusView(session: ended, onClose: {}, onNeed: { _ in }, onStop: {}, onDone: {}))
        XCTAssertNotNil(done.marker("imported=Obsidian"))
        XCTAssertNil(done.marker("import-stop-all"), "ended: no Stop all")
        done.close()

        let state = ProviderPopupState(session: ["id": "b", "blocked": ["provider": "openai"]], tools: ["tools": ["codex": ["status": "missing"], "claude": ["installed": true, "signedIn": true, "status": "ready"]]],
                                       onConnect: { _ in }, onSignIn: { _ in }, onOpenPage: { _ in }, onContinue: { _ in }, onLater: {})
        let provider = Offscreen(ProviderPopupView(model: state))
        XCTAssertNotNil(provider.marker("provider-popup=openai"))
        XCTAssertNotNil(provider.marker("provider-other=anthropic"), "Use Claude Code: it runs")
        XCTAssertNotNil(provider.marker("provider-connect=openai"))
        provider.close()
    }

    func testTheObsidianPicker() async {
        let api = FakeImportAPI()
        let model = ObsidianPickerModel(api: api, chosen: [])
        await model.load()
        let v = "/Users/you/Documents/Research vault"
        XCTAssertEqual(model.rows.map(\.node.name), ["Research vault", "Memex", "Meetings", "Engelbart Canvas", "Reading list"], "the vault open, its folders closed")
        model.press(model.rows[1].node, inSearch: false)
        XCTAssertEqual(model.rows.count, 7, "a folder opens on a click")
        model.togglePick(ObsidianNode(name: "As We May Think.md", path: "\(v)/Memex/As We May Think.md", dir: false))
        model.togglePick(model.rows[1].node)
        XCTAssertEqual(model.picked.map(\.path), ["\(v)/Memex"], "a folder chosen holds what was chosen inside it")
        XCTAssertTrue(model.covered("\(v)/Memex/Trails and associative indexing.md"))
        XCTAssertEqual(model.count, "1 chosen")
        model.query = "advisor"
        XCTAssertEqual(model.rows.map(\.node.name), ["2026-10-02 Advisor"])
        XCTAssertEqual(model.rows.first?.trail, ["Meetings"])
        let screen = Offscreen(ObsidianPickerView(model: model, onChoose: { _ in }, onCancel: {}), size: NSSize(width: 540, height: 520))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("obsidian-picker"))
        XCTAssertNotNil(screen.marker("obsidian-add"))
    }

    func testTheAgentPopup() {
        let api = FakeImportAPI(scenario: "none")
        let model = AgentSetupModel(api: api, tools: api.snapTools(), providers: ["providers": .array(api.providerEntries())], initial: "codex")
        let screen = Offscreen(AgentSetupPopup(model: model))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("agent-setup=codex"))
        XCTAssertNotNil(screen.marker("agent-choice=both"))
        XCTAssertNotNil(screen.marker("agent-skip"))
        XCTAssertNotNil(screen.marker("agent-primary="), "Connecting… while it installs")
    }

    func testConnectLibraryChooseChatAndWorking() async {
        let api = FakeImportAPI()
        let model = ConnectLibraryModel(api: api, context: ConnectLibraryContext(mode: .popup, projectId: "p"), openSessions: OpenSessions())
        await model.start()
        let screen = Offscreen(ConnectLibraryView(model: model))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("connect-library=choose"))
        XCTAssertNotNil(screen.marker("connect-source=notes"))
        XCTAssertNotNil(screen.marker("connect-app=Obsidian"), "Notes starts open: its first ticked source")
        XCTAssertNotNil(screen.marker("connect-permissions"))
        XCTAssertNotNil(screen.marker("connect-chip"))
        XCTAssertEqual(screen.frame("connect-library=choose").map { _ in true }, true)
        model.expand("code")
        screen.settle()
        XCTAssertNotNil(screen.marker("connect-app=GitHub"))
        XCTAssertNotNil(screen.marker("connect-app=Local repos"))
        model.gate = "ask"
        model.setRow("chats", "ChatGPT", true)
        model.gate = "ask"
        screen.settle()
        XCTAssertNotNil(screen.marker("connect-signin-gate=ask"))
        model.gateClose()
        await model.bringIn()
        await until("the chat") { model.view == "chat" }
        screen.settle()
        XCTAssertNotNil(screen.marker("connect-chat"))
        XCTAssertNotNil(screen.marker("connect-draft"))
        XCTAssertNotNil(screen.marker("connect-import"))
        XCTAssertNotNil(screen.marker("connect-needs"), "the sample run's ChatGPT step")
        await model.importNow()
        screen.settle()
        XCTAssertNotNil(screen.marker("connect-progress"))
        XCTAssertNotNil(screen.marker("connect-done"))
    }

    func testTheOnboardingPageAndCards() async {
        let api = FakeImportAPI()
        let model = ConnectLibraryModel(api: api, context: ConnectLibraryContext(mode: .onboarding), openSessions: OpenSessions())
        await model.start()
        let screen = Offscreen(ConnectLibraryView(model: model))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("connect-sources-box"))
        XCTAssertNotNil(screen.marker("connect-consent-at=after-code"))
        XCTAssertNotNil(screen.marker("connect-bring"))
        XCTAssertNotNil(screen.marker("onboarding-skip"))
        let ask: JSONValue = ["kind": "multi", "title": "Which folders?", "options": [["label": "Research", "why": "48 notes", "checked": true], ["label": "Daily"]]]
        let card = Offscreen(QuestionCard(ask: ask, live: true) { _ in }, size: NSSize(width: 560, height: 300))
        XCTAssertNotNil(card.marker("connect-option=Research"))
        XCTAssertNotNil(card.marker("connect-option-why"))
        XCTAssertNotNil(card.marker("connect-submit"))
        XCTAssertNotNil(card.marker("connect-skip"))
        // Nothing ticked to start (the recommendation is not marked out): no blue mark anywhere on the card.
        let rep = card.bitmap()
        var blue = 0
        for x in stride(from: 0, to: 560, by: 3) { for y in stride(from: 0, to: 300, by: 3) { if near(card.pixel(NSPoint(x: x, y: y), in: rep), 0x0070f3, 20) { blue += 1 } } }
        XCTAssertEqual(blue, 0, "no option ticked, and Submit is grey until one is")
        card.close()
        let answeredCard = Offscreen(QuestionCard(ask: ask, live: false) { _ in }, size: NSSize(width: 560, height: 300))
        XCTAssertNil(answeredCard.marker("connect-card-actions"), "no Skip or Submit on an answered card")
        XCTAssertNotNil(answeredCard.marker("connect-card=answered"))
        answeredCard.close()
        // The ticked circle: blue, a white ✓ (the picker's .cb).
        let check = Offscreen(IXCheck(on: true, size: 17), size: NSSize(width: 17, height: 17))
        XCTAssertTrue(near(check.pixel(NSPoint(x: 3, y: 8.5)), 0x0070f3, 30), "\(check.pixel(NSPoint(x: 3, y: 8.5)))")
        check.close()
        let off = Offscreen(IXCheck(on: false, size: 17), size: NSSize(width: 17, height: 17))
        XCTAssertTrue(near(off.pixel(NSPoint(x: 8.5, y: 8.5)), 0xffffff, 6))
        off.close()
        let grant = Offscreen(GrantCard(grant: ["rows": [["id": "Notion", "name": "Notion"]], "answered": nil], live: true) { _ in }, size: NSSize(width: 560, height: 260))
        XCTAssertNotNil(grant.marker("connect-grant=live"))
        XCTAssertNotNil(grant.marker("connect-grant-app=Notion"))
        grant.close()
    }

    func testTheChip() async {
        let api = FakeImportAPI()
        let sessions = ConnectSessions(api: api)
        sessions.take(["id": "a", "needs": [], "done": true, "jobs": [["status": "running", "kind": "import"], ["status": "done", "kind": "import"]], "memory": ["status": "waiting"]])
        let screen = Offscreen(ConnectChipView(sessions: sessions, open: OpenSessions()) { _ in }, size: NSSize(width: 300, height: 40))
        defer { screen.close() }
        XCTAssertNotNil(screen.marker("connect-dock=busy"))
        XCTAssertLessThanOrEqual(screen.frame("connect-dock-open=a")?.width ?? 999, 160)
        XCTAssertNil(screen.marker("connect-dock-dismiss=a"), "a × only once done")
        sessions.take(["id": "a", "needs": [], "done": true, "jobs": [["status": "done", "kind": "import", "notes": 1]], "memory": ["status": "saved"], "counts": ["notes": 1, "items": 0]])
        screen.settle()
        XCTAssertNotNil(screen.marker("connect-dock=done"))
        XCTAssertNotNil(screen.marker("connect-dock-dismiss=a"))
    }

    func testTheModalAndThePopupsOverTheWorkspace() async {
        let api = FakeImportAPI()
        let context = ImportFlowContext(api: api, mode: .modal, into: "p", intoProject: ("Memex", ""))
        let modal = Offscreen(ImportFlowModal(context: context), size: NSSize(width: 1200, height: 900))
        modal.settle(0.3)
        XCTAssertNotNil(modal.marker("import-modal"))
        let dialog = modal.frame("dialog=import-method")
        XCTAssertNotNil(dialog, "Import context from a project starts at how to import")
        modal.close()

        let sessions = ConnectSessions(api: api)
        let overlays = ImportOverlays(sessions: sessions, api: api)
        overlays.inWorkspace = true
        sessions.take(["id": "r", "direct": ["mode": "auto"], "jobs": [["id": "j", "kind": "import", "status": "running"]], "needs": [["id": "n1", "app": "Notion", "kind": "connector"]]])
        let popups = Offscreen(ImportPopupsView(overlays: overlays, context: ImportPopupsContext(tools: { nil }, toolsConnect: { _ in }, toolsSignIn: { _ in }, openExternal: { _ in })))
        defer { popups.close() }
        XCTAssertNotNil(popups.marker("need-popup=n1"))
        overlays.later(sessions.list[0], J.arr(sessions.list[0]["needs"])[0])
        overlays.statusId = "r"
        popups.settle()
        XCTAssertNil(popups.marker("need-popup=n1"))
        XCTAssertNotNil(popups.marker("import-status=r"))
    }
}
