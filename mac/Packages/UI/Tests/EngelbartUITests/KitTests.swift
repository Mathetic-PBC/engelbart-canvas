import AppKit
import EngelbartCore
import SwiftUI
import XCTest
@testable import EngelbartUI

final class SVGPathTests: XCTestCase {
    func testCommandsAndBounds() {
        // A square with relative lines and a close.
        XCTAssertEqual(SVGPath.parse("M3.5 1.5h6l3 3v10h-9z").boundingBoxOfPath, CGRect(x: 3.5, y: 1.5, width: 9, height: 13))
        // Compact numbers: ".5.5" is two numbers, "-1-2" two.
        XCTAssertEqual(SVGPath.parse("M0 0l.5.5").currentPoint, CGPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(SVGPath.parse("M5 5l-1-2").currentPoint, CGPoint(x: 4, y: 3))
        // A circle drawn as two arcs (the globe) spans its diameter.
        let circle = SVGPath.parse("M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z").boundingBoxOfPath
        XCTAssertEqual(circle.minX, 1.75, accuracy: 0.05); XCTAssertEqual(circle.maxX, 14.25, accuracy: 0.05)
        XCTAssertEqual(circle.minY, 1.75, accuracy: 0.05); XCTAssertEqual(circle.maxY, 14.25, accuracy: 0.05)
        // Flags written together ("0 011") still parse.
        XCTAssertEqual(SVGPath.parse("M0 0a1 1 0 011 1").currentPoint, CGPoint(x: 1, y: 1))
        // S reflects the last control point; implicit lineto after M.
        XCTAssertEqual(SVGPath.parse("M0 0 10 0 10 10").currentPoint, CGPoint(x: 10, y: 10))
        XCTAssertEqual(SVGPath.parse("M8 1.75C6.2 3.45 5.3 5.55 5.3 8s.9 4.55 2.7 6.25").currentPoint, CGPoint(x: 8, y: 14.25))
        // Exponents.
        XCTAssertEqual(SVGPath.parse("M1e1 2E-1").currentPoint, CGPoint(x: 10, y: 0.2))
    }

    func testEveryIconDraws() {
        let icons: [Icon] = [KindIcons.gh, KindIcons.pdf, KindIcons.layers, KindIcons.folder, KindIcons.code, KindIcons.workspace, KindIcons.note,
                             KindIcons.file, KindIcons.doc, KindIcons.html, KindIcons.search, KindIcons.chat, KindIcons.globe, KindIcons.image,
                             KindIcons.task, KindIcons.expand, KindIcons.collapse,
                             SidebarIcons.inbox, SidebarIcons.inboxDot, SidebarIcons.agents, SidebarIcons.connections, SidebarIcons.library,
                             SidebarIcons.add, SidebarIcons.project, SidebarIcons.workspace, SidebarIcons.search, SidebarIcons.chevronDown,
                             SidebarIcons.chevronRight, SidebarIcons.link, SidebarIcons.note, SidebarIcons.file, SidebarIcons.folder,
                             SidebarIcons.star, SidebarIcons.starFilled, SidebarIcons.code, SidebarIcons.gear, SidebarIcons.panelClose,
                             SidebarIcons.panelOpen, SidebarIcons.plus, SidebarIcons.paperclip, SidebarIcons.check, SidebarIcons.close,
                             SidebarIcons.minusCircle, SidebarIcons.trash, SidebarIcons.archive, SidebarIcons.chat, SidebarIcons.pencil,
                             SidebarIcons.external, SidebarIcons.sticky(), SidebarIcons.sticky(hidden: true), SidebarIcons.dots,
                             SidebarIcons.compose, SidebarIcons.clock, SidebarIcons.image, SidebarIcons.globe, SidebarIcons.paper,
                             SidebarIcons.git, SidebarIcons.arrowOut, SettingsIcons.model, SettingsIcons.blocks, SettingsIcons.add,
                             SettingsIcons.flask, SettingsIcons.gear, SettingsIcons.search, SettingsIcons.selectChevron, PhosphorIcons.shapesBold]
        for icon in icons {
            for shape in icon.shapes + icon.after {
                let box = shape.cgPath.boundingBoxOfPath
                XCTAssertFalse(box.isNull || box.isEmpty && box.width == 0 && box.height == 0, "\(icon.name) has an empty shape")
                XCTAssertLessThanOrEqual(box.maxX, icon.grid + 0.5, icon.name); XCTAssertLessThanOrEqual(box.maxY, icon.grid + 0.5, icon.name)
            }
            let image = icon.image(size: 32)
            XCTAssertTrue(image.isTemplate)
            XCTAssertGreaterThan(inkCoverage(image), 0.01, "\(icon.name) draws something")
        }
        // The Inbox's dot is cut out of the tray, then drawn.
        XCTAssertGreaterThan(inkCoverage(SidebarIcons.inboxDot.image(size: 48)), inkCoverage(SidebarIcons.inbox.image(size: 48)) * 0.9)
    }

    func testKinds() {
        XCTAssertEqual(KindIcons.kind("git").label, "git repo")
        XCTAssertEqual(KindIcons.kind("workspace").label, "project")
        XCTAssertEqual(KindIcons.kind("weird").label, "file", "an unknown type is some file")
        XCTAssertEqual(KindIcons.kind("pdf", label: "pdf · paper").label, "pdf · paper")
        XCTAssertEqual(KindIcons.kind("chat", label: "anything").label, "chat", "fixed kinds keep their name")
        XCTAssertEqual(KindIcons.glyphSize("note"), 15); XCTAssertEqual(KindIcons.glyphSize("website"), 14)
        XCTAssertEqual(KindIcons.glyphSize("pdf"), 12); XCTAssertEqual(KindIcons.glyphSize("weird"), 15)
        XCTAssertEqual(SidebarIcons.source("pdf").name, "Paper"); XCTAssertEqual(SidebarIcons.source("html").name, "Code")
        XCTAssertEqual(SidebarIcons.source("x").name, "File")
    }

    func testPhosphorResourceShips() {
        let url = ResourceBundle.ui.url(forResource: "phosphor-LICENSE", withExtension: "txt", subdirectory: "Resources/Icons")
        XCTAssertNotNil(url, "Phosphor's MIT notice ships with its icon")
    }

    /// Share of pixels with any alpha.
    func inkCoverage(_ image: NSImage) -> Double {
        let w = Int(image.size.width * 2), h = Int(image.size.height * 2)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return 0 }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
        NSGraphicsContext.restoreGraphicsState()
        var inked = 0
        for y in 0..<h { for x in 0..<w where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 { inked += 1 } }
        return Double(inked) / Double(w * h)
    }
}

final class SettingsTests: XCTestCase {
    func pages() -> [SettingsPage] {
        SettingsPages.standard(models: { _ in AnyView(EmptyView()) }, connections: nil, startImport: {})
    }
    func ids(_ test: TestDataActions?) -> [String] {
        let context = SettingsContext(test: test, close: {})
        return pages().filter { $0.shown(context) }.map(\.id)
    }
    func test(_ on: Bool) -> TestDataActions { TestDataActions(testMode: on, onReveal: {}, onStartNew: {}, onReset: {}) }

    func testPagesInOrderTestDataOnlyInTestMode() {
        XCTAssertEqual(ids(nil), ["model", "connections", "guided-setup"])
        XCTAssertEqual(ids(test(false)), ["model", "connections", "guided-setup"])
        XCTAssertEqual(ids(test(true)), ["model", "connections", "guided-setup", "test-data"])
        let all = pages()
        XCTAssertEqual(all[0].title, "Models", "2026-10-13: change Model to Models")
        XCTAssertEqual([all[1].section, all[1].title], ["Settings", "Connections"])
        XCTAssertEqual([all[2].section, all[2].title], ["Settings", "Import context"])
        XCTAssertNil(all[2].body); XCTAssertNotNil(all[2].run)
        XCTAssertEqual(all[3].section, "Developer")
    }

    func testImportContextClosesAndStarts() {
        var closed = 0, started = 0
        let all = SettingsPages.standard(models: { _ in AnyView(EmptyView()) }, connections: nil, startImport: { started += 1 })
        all[2].run?(SettingsContext(test: nil, close: { closed += 1 }))
        XCTAssertEqual([closed, started], [1, 1])
        XCTAssertEqual(SettingsPages.initial(all, requested: "guided-setup"), "model", "an action never opens as a page")
        XCTAssertEqual(SettingsPages.initial(all, requested: "connections"), "connections")
        XCTAssertEqual(SettingsPages.initial(all, requested: nil), "model")
    }

    func testSearch() {
        func listed(_ query: String, _ t: TestDataActions? = nil) -> [String] {
            let context = SettingsContext(test: t, close: {})
            return pages().filter { $0.shown(context) }.filter { SettingsPages.matches($0, query) }.map(\.id)
        }
        XCTAssertEqual(listed(""), ["model", "connections", "guided-setup"])
        XCTAssertEqual(listed("   "), ["model", "connections", "guided-setup"])
        XCTAssertEqual(listed("onboarding"), ["guided-setup"])
        XCTAssertEqual(listed("conn"), ["connections"])
        XCTAssertEqual(listed("zot"), ["connections"])
        XCTAssertEqual(listed("deep"), ["model"])
        XCTAssertEqual(listed("--quick"), ["model"])
        XCTAssertEqual(listed("  GITHUB "), ["connections"])
        XCTAssertEqual(listed("codex"), ["model", "connections"])
        XCTAssertEqual(listed("claude code"), ["connections"])
        XCTAssertEqual(listed("xyz"), [])
        XCTAssertEqual(listed("reset"), [], "Test data is hidden outside test mode")
        XCTAssertEqual(listed("reset", test(true)), ["test-data"])
        XCTAssertEqual(listed("start over", test(true)), ["test-data"])
    }

    func testSectionsOnlyOverListedPages() {
        let all = pages()
        XCTAssertEqual(SettingsPages.sections(all, query: "").map(\.title), ["Settings", "Developer"])
        XCTAssertEqual(SettingsPages.sections(all, query: "zot").map(\.title), ["Settings"])
        XCTAssertEqual(SettingsPages.sections(all, query: "reset").map(\.title), ["Developer"])
        XCTAssertEqual(SettingsPages.sections(all, query: "xyz").count, 0)
    }

    func testEscape() {
        XCTAssertEqual(SettingsEscape.action(menuOpen: false, inSearch: true, searchText: "zot"), .clear)
        XCTAssertEqual(SettingsEscape.action(menuOpen: false, inSearch: true, searchText: ""), .close)
        XCTAssertEqual(SettingsEscape.action(menuOpen: true, inSearch: true, searchText: "zot"), .menu)
        XCTAssertEqual(SettingsEscape.action(menuOpen: false, inSearch: false, searchText: "x"), .close, "another field with text")
    }

    /// settings.test.cjs "Models: Quick, Standard and Deep of the provider @discover runs on", on a fixture shaped as
    /// settingsModels gives it.
    func fixture(usable: [String]?, provider: String = "anthropic", offered: [String] = ["anthropic", "openai"]) -> JSONValue {
        let step = { (m: String, e: String) -> JSONValue in ["model": .string(m), "effort": .string(e)] }
        var s: [String: JSONValue] = [
            "models": [
                "provider": .string(provider),
                "providers": [
                    "anthropic": ["name": "Claude Code", "models": ["haiku": ["name": "Haiku"], "sonnet": ["name": "Sonnet"], "opus": ["name": "Opus"]],
                                  "modelOrder": ["haiku", "sonnet", "opus"], "efforts": ["low", "medium", "high", "xhigh", "max"], "ladder": [step("sonnet", "medium")]],
                    "openai": ["name": "Codex", "models": ["luna": ["name": "Luna"], "sol": ["name": "Sol"], "astra": ["name": "Astra"]],
                               "efforts": ["low", "medium", "high", "xhigh"], "ladder": [step("sol", "medium")]],
                ],
                "build": ["provider": "anthropic", "providers": [:]],
                "discover": ["providers": [
                    "anthropic": ["quick": step("sonnet", "medium"), "standard": step("opus", "high"), "deep": step("opus", "max")],
                    "openai": ["quick": step("luna", "medium"), "standard": step("astra", "high"), "deep": step("astra", "xhigh")],
                ]],
            ],
            "offered": .array(offered.map { .string($0) }),
            "cli": usable?.contains("codex") == false ? ["openai": "Codex is not installed"] : [:],
        ]
        if let usable { s["usable"] = .array(usable.map { .string($0) }) }
        return .object(s)
    }

    func testModelsGroupsOrderAndSteps() {
        XCTAssertEqual(Intelligence.modelsGroups(fixture(usable: ["claude"])), ["anthropic", "openai"])
        XCTAssertEqual(Intelligence.modelsGroups(fixture(usable: ["codex"])), ["openai", "anthropic"], "the provider runs use, first")
        XCTAssertEqual(Intelligence.modelsGroups(fixture(usable: ["claude", "codex"], provider: "openai")), ["openai", "anthropic"], "the saved provider first")
        XCTAssertEqual(Intelligence.modelsGroups(fixture(usable: nil, offered: ["openai"])), ["openai"], "one provider offered: one group")
        XCTAssertEqual(Intelligence.defaultProvider(fixture(usable: nil), "bart"), "anthropic", "before the first check nothing moves")
        let models = fixture(usable: nil)["models"]!
        XCTAssertEqual(Intelligence.defaultStep(models, agent: "discover", provider: "anthropic", level: "quick")?.model, "sonnet")
        XCTAssertEqual(Intelligence.defaultStep(models, agent: "discover", provider: "anthropic", level: "deep")?.effort, "max")
        XCTAssertEqual(Intelligence.defaultStep(models, agent: "bart", provider: "openai")?.model, "sol")
        XCTAssertEqual(Intelligence.patchOf(agent: "discover", provider: "openai", model: "luna", effort: "medium", level: "quick"),
                       ["discover": ["openai": ["quick": ["model": "luna", "effort": "medium"]]]])
        XCTAssertEqual(Intelligence.patchOf(agent: "bart", provider: "anthropic", model: "opus", effort: "high"),
                       ["bart": ["anthropic": ["model": "opus", "effort": "high"]]])
        XCTAssertEqual(Intelligence.effortLabels["xhigh"], "Extra high")
    }
}

final class ControlLogicTests: XCTestCase {
    func testInlineFieldOutcomes() {
        XCTAssertEqual(InlineFieldOutcome.enter("  Reading  "), .commit("Reading"))
        XCTAssertEqual(InlineFieldOutcome.enter("   "), .cancel, "an empty name cancels")
        XCTAssertEqual(InlineFieldOutcome.escape, .cancel)
        XCTAssertEqual(InlineFieldOutcome.blur("x"), .commit("x"), "leaving the field commits")
    }

    @MainActor func testTabCardTiming() {
        var scheduled: [(TimeInterval, DispatchWorkItem)] = []
        let timer = TabCardTimer { delay, work in scheduled.append((delay, work)) }
        timer.enter(id: "t1", rect: CGRect(x: 100, y: 10, width: 120, height: 34), windowWidth: 1200)
        XCTAssertEqual(scheduled.last?.0, 0.65, "the first card after 650 ms")
        scheduled.last?.1.perform()
        XCTAssertEqual(timer.card, .init(id: "t1", left: 104, top: 50, width: 260))
        timer.leave()
        XCTAssertNil(timer.card, "gone at once")
        XCTAssertEqual(scheduled.last?.0, 0.4)
        timer.enter(id: "t2", rect: CGRect(x: 1100, y: 10, width: 120, height: 34), windowWidth: 1200)
        XCTAssertEqual(scheduled.last?.0, 0.06, "warm: the next after 60 ms")
        scheduled.last?.1.perform()
        XCTAssertEqual(timer.card?.left, 932, "kept 8 inside the window")
        timer.leave()
        scheduled[scheduled.count - 1].1.perform() // cooled
        timer.enter(id: "t3", rect: .zero, windowWidth: 1200)
        XCTAssertEqual(scheduled.last?.0, 0.65, "cold again after 400 ms away")
    }

    func testTabTitleClipping() {
        XCTAssertFalse(TabTitle.clipped(natural: 100, shown: 100))
        XCTAssertFalse(TabTitle.clipped(natural: 100.8, shown: 100), "within a point is whole")
        XCTAssertTrue(TabTitle.clipped(natural: 140, shown: 100))
    }

    func testWave() {
        XCTAssertEqual(WaveClock.span(position: 1).start, -1.6, accuracy: 1e-9)
        XCTAssertEqual(WaveClock.span(position: 0).end, 2.6, accuracy: 1e-9)
        // The band (50% of the image) crosses from left of the text to right of it: -0.3 → 1.3 widths.
        let bandAt = { (pos: Double) -> Double in let s = WaveClock.span(position: pos); return s.start + 0.5 * (s.end - s.start) }
        XCTAssertEqual(bandAt(1), -0.3, accuracy: 1e-9); XCTAssertEqual(bandAt(0), 1.3, accuracy: 1e-9)
        XCTAssertEqual(bandAt(0.5), 0.5, accuracy: 1e-9, "reduced motion: the band in the middle")
        // Two waves read the same clock.
        let now = Date()
        XCTAssertEqual(WaveClock.position(now), WaveClock.position(now))
    }

    func testKeyframes() {
        XCTAssertEqual(Keyframe.bezier(0, 0.42, 0, 0.58, 1), 0)
        XCTAssertEqual(Keyframe.bezier(1, 0.42, 0, 0.58, 1), 1)
        XCTAssertEqual(Keyframe.easeInOut(0.5), 0.5, accuracy: 1e-3)
        let stops: [(Double, Double)] = [(0, 0.15), (0.35, 1), (0.7, 0.15), (1, 0.15)]
        XCTAssertEqual(Keyframe.value(at: 0.35, stops: stops), 1, accuracy: 1e-9)
        XCTAssertEqual(Keyframe.value(at: 0.85, stops: stops), 0.15, accuracy: 1e-9)
        XCTAssertEqual(Keyframe.phase(Date(timeIntervalSinceReferenceDate: 2.75), period: 1.1, delay: 0.09), (2.66).truncatingRemainder(dividingBy: 1.1) / 1.1, accuracy: 1e-9)
    }

    func testTooltipSpot() {
        let view = CGSize(width: 1200, height: 800)
        XCTAssertEqual(TooltipTiming.spot(for: CGRect(x: 10, y: 100, width: 200, height: 28), view: view), CGPoint(x: 38, y: 133))
        XCTAssertEqual(TooltipTiming.spot(for: CGRect(x: 1100, y: 100, width: 50, height: 28), view: view).x, 952, "kept inside")
        XCTAssertEqual(TooltipTiming.spot(for: CGRect(x: 10, y: 760, width: 200, height: 28), view: view).y, 715, "no room under: above")
    }
}

/// use-placed.test.cjs: the panel keeps its scroll (and a list's) through re-measuring; it is placed by place().
@MainActor
final class FloatingPanelTests: XCTestCase {
    func window() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
        w.contentView = FlippedView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))
        return w
    }

    func tall(_ n: Int = 50) -> some View {
        VStack(spacing: 0) { ForEach(0..<n, id: \.self) { i in Text("Row \(i)").frame(height: 20) } }
    }

    func testPlacedAndCutAtCap() {
        let w = window()
        let panel = FloatingPanel()
        panel.show(in: w, anchor: CGRect(x: 100, y: 40, width: 0, height: 20), options: FloatingOptions(cap: 420, width: 400, rise: 0)) { tall() }
        XCTAssertEqual(panel.spot, PlaceSpot(left: 100, top: 66, maxHeight: 420), "the list is cut at the cap and scrolls")
        XCTAssertEqual(panel.cardSize, CGSize(width: 400, height: 420))
        panel.close()
    }

    func testScrollKeptThroughRemeasure() throws {
        let w = window()
        let panel = FloatingPanel()
        panel.show(in: w, anchor: CGRect(x: 100, y: 40, width: 0, height: 20), options: FloatingOptions(cap: 420, width: 400, rise: 0)) { tall() }
        let scroll = try XCTUnwrap(findScroll(panel.window.contentView))
        scroll.contentView.scroll(to: CGPoint(x: 0, y: 300))
        scroll.reflectScrolledClipView(scroll.contentView)
        panel.update { tall() } // a row hovered: rendered and measured again
        XCTAssertEqual(scroll.contentView.bounds.origin.y, 300, "a hover leaves the list where it was")
        panel.update { tall() }; panel.relayout()
        XCTAssertEqual(scroll.contentView.bounds.origin.y, 300, "and so does any other render")
        panel.close()
        XCTAssertFalse(panel.isOpen)
    }

    func testLayersAndClose() {
        let w = window()
        let a = FloatingPanel(), b = FloatingPanel()
        var closed = 0
        a.onClose = { closed += 1 }
        a.show(in: w, anchor: CGRect(x: 10, y: 10, width: 10, height: 10), options: FloatingOptions(width: 100, rise: 0)) { Text("A") }
        b.show(in: w, anchor: CGRect(x: 10, y: 10, width: 10, height: 10), options: FloatingOptions(width: 100, rise: 0)) { Text("B") }
        XCTAssertTrue(FloatingPanel.stack.last === b, "Escape belongs to the newest")
        b.close(); a.close()
        XCTAssertEqual(closed, 1)
        XCTAssertTrue(FloatingPanel.stack.isEmpty)
    }

    func findScroll(_ view: NSView?) -> NSScrollView? {
        guard let view else { return nil }
        if let s = view as? NSScrollView { return s }
        for sub in view.subviews { if let s = findScroll(sub) { return s } }
        return nil
    }
}
