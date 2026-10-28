import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartUI
import SwiftUI
import XCTest
@testable import EngelbartScreens

// The screens drawn offscreen (an NSWindow made with defer: false and never ordered front): what is there (the parts named
// after the Electron data-* attributes, Probe.swift), where it is, sampled pixels, and presses.

@MainActor
final class HomeViewTests: XCTestCase {
    var data = FakeData()
    var events: [String] = []

    func model() -> HomeModel {
        let context = HomeContext(
            data: data,
            onCreateScreen: { self.events.append("create") },
            onOpenWorkspace: { p, w, _ in self.events.append("open \(p) \(w ?? "-")") },
            onOpenNote: { self.events.append("note \($0.id)") }, onOpenOnStage: { self.events.append("stage \($0.id)") },
            onRename: { self.events.append("rename \($0) \($1)") },
            onDelete: { self.events.append("delete \($0)") }, onRestore: { self.events.append("restore \($0)") },
            onLibraryChanged: {})
        let m = HomeModel(context: context)
        m.delays = (0.02, 0.01, 0.05)
        let now = Date()
        m.update(projects: [
            project("p1", "Thesis", workspaces: 5, lastEdited: "2026-10-01T00:00:00.000Z",
                    recent: [recent("w1", "Plan", text: "# Plan\n- [ ] read **Bush**"), recent("w2", "Notes"), recent("w3", "Draft"), recent("w4", "Old")],
                    libraryIds: ["a", "b"]),
            project("p3", "Side project"),
        ], trashed: [trashed("p2", "Old <Draft>", deleted: now.addingTimeInterval(-2 * 86400), expires: now.addingTimeInterval(5 * 86400))],
           library: [row("a", "As We May Think", type: "pdf", tags: ["paper"]), row("b", "memex.org", type: "website", url: "https://memex.org")], error: "")
        return m
    }

    func testTheScreenIsThereWhereTheDesignPutsIt() async throws {
        let m = model()
        let screen = Offscreen(HomeScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        XCTAssertTrue(screen.has("screen=home"))
        let rail = try XCTUnwrap(screen.frame("library-rail"))
        XCTAssertEqual(rail.width, 340, accuracy: 1)
        XCTAssertEqual(rail.minY, 54, accuracy: 1, "under the 54px header")
        let card = try XCTUnwrap(screen.frame("project-card=p1"))
        XCTAssertEqual(card.minX, 340 + 20, accuracy: 1.5, "the column's padding")
        XCTAssertGreaterThanOrEqual(card.width, 336)
        let second = try XCTUnwrap(screen.frame("project-card=p3"))
        XCTAssertEqual(second.minY, card.minY, accuracy: 1, "cards wrap side by side")
        XCTAssertEqual(second.height, card.height, accuracy: 1, "a line's cards stretch to one height")
        XCTAssertEqual(second.minX, card.maxX + 14, accuracy: 1.5, "gap 14")
        XCTAssertGreaterThanOrEqual(second.width, 336, "at least 336 wide")
        let plus = try XCTUnwrap(screen.frame("new-project"))
        XCTAssertEqual(plus.width, 320, accuracy: 1)
        XCTAssertTrue(screen.has("recently-deleted")); XCTAssertTrue(screen.has("trashed-project=p2")); XCTAssertTrue(screen.has("restore-project=p2"))
        XCTAssertTrue(screen.has("library-row=a")); XCTAssertTrue(screen.has("library-row=b"))
        let rowA = try XCTUnwrap(screen.frame("library-row=a"))
        XCTAssertEqual(rowA.height, 31.5, accuracy: 0.6); XCTAssertEqual(rowA.width, 340, accuracy: 1.5)
        // 1440 − 340: a 1100 column holds three tiles.
        XCTAssertEqual(m.tiles, 3)
        XCTAssertEqual(screen.ids(prefix: "workspace-tile="), ["workspace-tile=w1", "workspace-tile=w2", "workspace-tile=w3"])
        let tile = try XCTUnwrap(screen.frame("workspace-tile=w1"))
        XCTAssertEqual(tile.width, 168, accuracy: 1); XCTAssertEqual(tile.height, 200, accuracy: 1)
        XCTAssertTrue(screen.has("held-icons"))
        // Pixels: the header's hairline, the rail's grey, the white page, the rail's border.
        let rep = screen.bitmap()
        XCTAssertTrue(near(screen.color(rep, 700, 53.5), "#eaeaea"), "header hairline: \(screen.color(rep, 700, 53.5))")
        XCTAssertTrue(near(screen.color(rep, 170, 850), "#fafafa"), "rail: \(screen.color(rep, 170, 850))")
        XCTAssertTrue(near(screen.color(rep, 1400, 880), "#ffffff"), "page: \(screen.color(rep, 1400, 880))")
        XCTAssertTrue(near(screen.color(rep, 339.5, 500), "#eaeaea"), "the rail's right border: \(screen.color(rep, 339.5, 500))")
        XCTAssertTrue(near(screen.color(rep, card.minX + 0.5, card.midY), "#eaeaea", 12), "the card's border: \(screen.color(rep, card.minX + 0.5, card.midY))")
    }

    func testANarrowWindowShowsTwoTilesAndPressesReachTheApp() async throws {
        let m = model()
        let screen = Offscreen(HomeScreen(model: m), size: CGSize(width: 1000, height: 700))
        await settle(0.3)
        XCTAssertEqual(m.tiles, 2)
        XCTAssertEqual(screen.ids(prefix: "workspace-tile=").count, 2)
        XCTAssertTrue(screen.press("new-project")); XCTAssertEqual(events.last, "create")
        XCTAssertTrue(screen.press("project-card=p3")); XCTAssertEqual(events.last, "open p3 -")
        XCTAssertTrue(screen.press("workspace-tile=w2")); XCTAssertEqual(events.last, "open p1 w2")
        XCTAssertTrue(screen.press("restore-project=p2"))
        await until { self.events.last == "restore p2" }
        XCTAssertEqual(events.last, "restore p2")
        XCTAssertTrue(screen.press("project-name=p1"))
        await settle(0.2)
        XCTAssertTrue(screen.has("rename-project"), "a click on the name puts the field there")
        XCTAssertFalse(screen.has("project-name=p1"))
        XCTAssertFalse(events.contains("open p1 -"), "the name's click never opens the card")
        // The search narrows the rail.
        m.query = "memex"
        await settle(0.2)
        XCTAssertFalse(screen.has("library-row=a")); XCTAssertTrue(screen.has("library-row=b"))
    }

    func testDeleteAsksFirst() async throws {
        let m = model()
        let screen = Offscreen(HomeScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.2)
        XCTAssertFalse(screen.has("delete-project-dialog"), "nothing asks before the can is pressed")
        XCTAssertTrue(screen.press("delete-project=p1"))
        await settle(0.3)
        XCTAssertFalse(events.contains("open p1 -"), "the can never opens the card")
        let dialog = try XCTUnwrap(screen.frame("delete-project-dialog"))
        XCTAssertEqual(dialog.width, 400, accuracy: 1)
        XCTAssertEqual(dialog.midX, 720, accuracy: 1, "centred")
        let confirm = try XCTUnwrap(screen.frame("delete-project-confirm"))
        let cancel = try XCTUnwrap(screen.frame("delete-project-cancel"))
        XCTAssertLessThan(cancel.maxX, confirm.minX, "Cancel, then Delete, on the right")
        XCTAssertEqual(confirm.maxX, dialog.maxX - 20, accuracy: 1.5)
        XCTAssertGreaterThanOrEqual(confirm.height, 34)
        let rep = screen.bitmap()
        let red = screen.color(rep, confirm.minX + 6, confirm.midY)
        XCTAssertTrue(red.redComponent > 0.8 && red.greenComponent < 0.3 && red.blueComponent < 0.3, "Delete is red (#e70022): \(red)")
        XCTAssertTrue(near(screen.color(rep, 20, 880), "#bfbfbf", 12), "the veil: \(screen.color(rep, 20, 880))")
        XCTAssertTrue(screen.press("delete-project-confirm"))
        await until { self.events.contains("delete p1") }
        XCTAssertTrue(events.contains("delete p1"))
        await settle(0.2)
        XCTAssertFalse(screen.has("delete-project-dialog"))
    }

    func testPeekHangsBesideTheRow() async throws {
        let m = model()
        data.previews["a"] = preview("a", heldBy: [holder("p1", "Thesis", workspaces: [("w1", "Plan")])])
        let screen = Offscreen(HomeScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        let rowFrame = try XCTUnwrap(screen.frame("library-row=a"))
        m.openPeek(HomePeek(key: "a", kind: .item(m.rows.first { $0.id == "a" }!), rect: rowFrame))
        await until { m.peek != nil }
        await settle(0.3)
        let peek = try XCTUnwrap(screen.frame("peek=item"))
        XCTAssertEqual(peek.minX, rowFrame.maxX, accuracy: 1.5, "the wrapper reaches back to the row")
        XCTAssertEqual(peek.width, 380 + 8, accuracy: 1.5)
        XCTAssertEqual(peek.minY, max(54, rowFrame.minY - 12), accuracy: 1.5)
        XCTAssertEqual(data.calls.filter { $0 == "preview a" }.count, 1)
        // A tile's peek: 420 wide, on the right of the tile when it fits.
        let tile = try XCTUnwrap(screen.frame("workspace-tile=w1"))
        m.openPeek(HomePeek(key: "w1", kind: .workspace(decode(RecentWorkspace.self, recent("w1", "Plan", path: "Agents/Plan", text: "x")), project: m.projects[0]), rect: tile))
        await until { m.peek?.key == "w1" }
        await settle(0.3)
        let wpeek = try XCTUnwrap(screen.frame("peek=workspace"))
        XCTAssertEqual(wpeek.width, 420 + 8, accuracy: 1.5)
        XCTAssertEqual(wpeek.minX, tile.maxX, accuracy: 1.5)
    }

    func testItemPeekSaysWhereItIsAndWhoHoldsIt() async throws {
        let m = model()
        let clone = row("c", "a/b", type: "website", tags: ["git"], url: "https://github.com/a/b", summary: "A repo")
        m.update(projects: m.projects, trashed: m.trashed, library: m.library + [clone], error: "Could not read the trash")
        data.previews["c"] = preview("c", files: ["README.md"], owner: "a", folderMissing: "/Users/h/b", heldBy: [holder("p1", "Thesis", workspaces: [("w1", "Plan")])])
        let screen = Offscreen(HomeScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        XCTAssertTrue(screen.has("home-error"), "the screen's error under the heading")
        let rowFrame = try XCTUnwrap(screen.frame("library-row=c"))
        m.openPeek(HomePeek(key: "c", kind: .item(clone), rect: rowFrame))
        await until { m.preview(for: clone) != nil }
        await settle(0.3)
        XCTAssertTrue(screen.has("peek-missing"), "a clone that is gone, struck through")
        XCTAssertFalse(screen.has("peek-local"))
        XCTAssertTrue(screen.has("holder=p1"))
        XCTAssertTrue(screen.press("holder=p1/w1"))
        XCTAssertEqual(events.last, "open p1 w1")
        XCTAssertNil(m.peek, "the peek closes first")
    }

    func testPeekAndTileContentsDraw() {
        let md = row("m", "Reading.md", type: "md", path: "/Users/h/Reading.md")
        let repo = row("r", "a/b", type: "website", tags: ["git"], url: "https://github.com/a/b", summary: "A repo")
        draw(ItemPeek(row: md, more: preview("m", text: "# Title\n- one"), onOpenWorkspace: { _, _ in }))
        draw(ItemPeek(row: repo, more: preview("r", files: ["README.md", "src"], owner: "a", folderMissing: "/Users/h/b"), onOpenWorkspace: { _, _ in }))
        draw(DocPreview(text: "\n# Head\n```\nlet x = 1\n```\n- [x] done\n1. first\n> quote\n@bart why?\nplain **bold** *it* `code` [link](https://x.org)", maxLines: 24))
    }

    private func draw<V: View>(_ view: V) {
        let screen = Offscreen(view.frame(width: 380), size: CGSize(width: 380, height: 500))
        let rep = screen.bitmap()
        XCTAssertGreaterThan(rep.pixelsWide, 0)
    }
}

final class DocPreviewTests: XCTestCase {
    func testLinesAsTheWorkspaceDrawsThem() {
        let lines = DocPreviewModel.lines("\n# Head\n```\nlet x = 1\n```\n\n- [x] done\n  - [ ] nested\n1. first\n> quote\n@bart why?\nplain **bold**")
        guard lines.count == 9 else { return XCTFail("\(lines)") }
        if case .heading(let runs) = lines[0] { XCTAssertEqual(runs.map(\.shown).joined(), "Head") } else { XCTFail("heading") }
        XCTAssertEqual(lines[1], .code("let x = 1"), "a fenced block's body; its fences hidden")
        XCTAssertEqual(lines[2], .gap)
        if case .item(let mark, let depth, let done, _) = lines[3] { XCTAssertEqual(mark, "✓"); XCTAssertEqual(depth, 0); XCTAssertTrue(done) } else { XCTFail("done task") }
        if case .item(let mark, let depth, let done, _) = lines[4] { XCTAssertEqual(mark, "–"); XCTAssertEqual(depth, 1); XCTAssertFalse(done) } else { XCTFail("task") }
        if case .item(let mark, _, _, _) = lines[5] { XCTAssertEqual(mark, "1.") } else { XCTFail("numbered") }
        if case .answer = lines[6] {} else { XCTFail("quote") }
        if case .plain(let runs) = lines[7] { XCTAssertEqual(runs.map(\.shown).joined(), "@bart why?") } else { XCTFail("@bart line") }
        if case .plain(let runs) = lines[8] { XCTAssertTrue(runs.contains { if case .strong = $0 { return true }; return false }) } else { XCTFail("bold") }
        XCTAssertEqual(DocPreviewModel.lines("a\nb\nc", maxLines: 2).count, 2)
        XCTAssertEqual(DocPreviewModel.lines("a\nb\n\nc\n\n", tail: 2).count, 5, "from the second-last line that holds something to the end")
    }
}

@MainActor
final class GuidedOfferViewTests: XCTestCase {
    func testOfferStartsOrIsDismissed() async throws {
        var events: [String] = []
        let screen = Offscreen(GuidedSetupOffer(onStart: { events.append("start") }, onDismiss: { events.append("dismiss") }).background(Color.white), size: CGSize(width: 1000, height: 700))
        await settle(0.3)
        let panel = try XCTUnwrap(screen.frame("guided-offer"))
        XCTAssertEqual(panel.width, 400, accuracy: 1)
        XCTAssertEqual(panel.midX, 500, accuracy: 1, "centred")
        let start = try XCTUnwrap(screen.frame("guided-offer-start"))
        let notNow = try XCTUnwrap(screen.frame("guided-offer-dismiss"))
        XCTAssertLessThan(notNow.maxX, start.minX, "Not now, then Start, on the right")
        XCTAssertEqual(start.maxX, panel.maxX - 24, accuracy: 1.5)
        XCTAssertTrue(screen.press("guided-offer-start"))
        XCTAssertTrue(screen.press("guided-offer-dismiss"))
        XCTAssertTrue(screen.press("guided-offer-veil"))
        XCTAssertEqual(events, ["start", "dismiss", "dismiss"])
        let rep = screen.bitmap()
        XCTAssertTrue(near(screen.color(rep, 20, 20), "#d4d4d4", 14), "the veil: \(screen.color(rep, 20, 20))")
        XCTAssertTrue(near(screen.color(rep, panel.minX + 30, panel.maxY - 6), "#ffffff"), "the panel is white")
        XCTAssertEqual(GuidedSetup.startEvent, "engelbart:guided-setup")
        XCTAssertEqual(GuidedSetup.onboardMode(guidedFromProject: true, guided: true, returning: true), .guided)
        XCTAssertEqual(GuidedSetup.onboardMode(guidedFromProject: false, guided: true, returning: true), .new)
        XCTAssertEqual(GuidedSetup.onboardMode(guidedFromProject: false, guided: false, returning: false), .new)
        XCTAssertEqual(GuidedSetup.onboardMode(guidedFromProject: false, guided: false, returning: true), .existing)
        XCTAssertEqual(GuidedSetup.backTitle(guidedFromProject: true), "Back to your project")
        XCTAssertEqual(GuidedSetup.backTitle(guidedFromProject: false), "All projects")
        let hub = EventHub()
        var heard = 0
        _ = hub.on(GuidedSetup.startEvent) { _ in heard += 1 }
        GuidedSetup.start(hub)
        XCTAssertEqual(heard, 1)
    }

    func testLanding() {
        XCTAssertEqual(Onboarded(projectId: "p", workspaceId: "w", noteId: "n", noteName: "Welcome!").landingTab?.title, "Welcome!")
        XCTAssertNil(Onboarded(projectId: "p", workspaceId: "w", noteId: "n", noteName: "Welcome!", welcomePage: true).landingTab, "a new user's Welcome page")
        XCTAssertNil(Onboarded(projectId: "p", workspaceId: "w", noteId: "n", gettingStarted: true).landingTab, "the walkthrough's workspace")
        XCTAssertNil(Onboarded(projectId: "p", workspaceId: "w").landingTab, "no note")
    }
}

@MainActor
final class OnboardingViewTests: XCTestCase {
    var data = FakeData()
    var done: [Onboarded] = []

    func model(_ mode: OnboardingMode) -> OnboardingModel {
        OnboardingModel(context: OnboardingContext(mode: mode, data: data, onDone: { made, _ in self.done.append(made) }, onBack: {}))
    }

    func testWelcomeGrowsWithTheWindowAndContinues() async throws {
        XCTAssertEqual(welcomeWidth(window: CGSize(width: 1440, height: 900)), 640)
        XCTAssertEqual(welcomeWidth(window: CGSize(width: 1000, height: 700)), 547)
        XCTAssertEqual(welcomeWidth(window: CGSize(width: 900, height: 560)), 326)
        XCTAssertEqual(welcomeWidth(window: CGSize(width: 900, height: 500)), 300, "never under 300")
        let m = model(.new)
        let screen = Offscreen(OnboardingScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.4)
        XCTAssertTrue(screen.has("onboarding=new"))
        let picture = try XCTUnwrap(screen.frame("welcome-picture"))
        XCTAssertEqual(picture.width, 640, accuracy: 1)
        XCTAssertEqual(picture.height, 405, accuracy: 1)
        XCTAssertEqual(picture.midX, 720, accuracy: 1, "centred")
        let go = try XCTUnwrap(screen.frame("onboarding-continue"))
        XCTAssertEqual(go.maxX, picture.maxX, accuracy: 1.5, "Continue on the right (S1)")
        XCTAssertEqual(go.minY, picture.maxY + 30, accuracy: 1.5, "gap 30")
        XCTAssertTrue(screen.has("onboarding-step-of"), "the pager in Welcome's foot")
        XCTAssertTrue(screen.has("onboarding-back"), "Engelbart in the top left when there is somewhere to go back to")
        let back = try XCTUnwrap(screen.frame("onboarding-back"))
        XCTAssertEqual(back.minX, 84, accuracy: 1, "clear of the traffic lights")
        let rep = screen.bitmap()
        XCTAssertTrue(near(screen.color(rep, go.minX + 4, go.midY), "#171717", 10), "Continue is ink: \(screen.color(rep, go.minX + 4, go.midY))")
        XCTAssertTrue(screen.press("onboarding-continue"))
        await settle(0.3)
        XCTAssertEqual(m.place.step, "create")
        XCTAssertTrue(screen.has("onboarding-name"))
        XCTAssertTrue(screen.has("onboarding-use-folder"))
        // The create screen sits in at most 800 × 600, centred.
        let field = try XCTUnwrap(screen.frame("onboarding-name"))
        XCTAssertLessThanOrEqual(field.width, 520 + 1)
        XCTAssertEqual(field.midX, 720, accuracy: 2)
    }

    func testTheImportAndContextScreensDraw() async throws {
        data.rows = [row("a", "As We May Think", tags: ["paper"]), row("w", "memex.org", type: "website", url: "https://memex.org")]
        let m = model(.existing)
        let screen = Offscreen(OnboardingScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        XCTAssertTrue(screen.has("onboarding-step-of"))
        m.name = "Memex"
        await m.createNext(); await m.createNext()
        await settle(0.3)
        XCTAssertEqual(m.place.step, "context")
        XCTAssertTrue(screen.has("option=a")); XCTAssertTrue(screen.has("option=w"))
        XCTAssertTrue(screen.has("onboarding-selected"))
        XCTAssertTrue(screen.press("option=a"))
        await settle(0.1)
        XCTAssertEqual(m.sel["a"], true)
        m.addToLibraryDetour()
        await settle(0.3)
        XCTAssertTrue(screen.has("part=github"))
        XCTAssertFalse(screen.has("onboarding-step-of"), "no pager on a detour")
        XCTAssertTrue(screen.has("onboarding-mark=open"))
        m.advance()
        await settle(0.3)
        XCTAssertTrue(screen.has("part=url"), "\(screen.ids(prefix: ""))")
        XCTAssertTrue(screen.has("onboarding-link"), "\(screen.ids(prefix: ""))")
        XCTAssertTrue(screen.has("onboarding-skip"), "Skip while the part is empty")
        m.entry = "memex.org"
        XCTAssertTrue(screen.press("onboarding-link-add"))
        await until { m.addedHere("url").count == 1 }
        await settle(0.2)
        XCTAssertTrue(screen.has("onboarding-mark=done"), "the circle becomes a check once the part holds something")
        XCTAssertFalse(screen.has("onboarding-skip"))
        m.advance()
        await settle(0.3)
        XCTAssertTrue(screen.has("onboarding-pick-papers"))
        m.advance()
        await settle(0.3)
        XCTAssertEqual(m.place.step, "context")
        XCTAssertTrue(screen.press("onboarding-open"))
        await until { !self.done.isEmpty }
        XCTAssertEqual(Set(data.started.first?.context ?? []), Set(["a"] + m.added.map(\.id)), "ticked, and what was just added")
    }

    func testInstructionsScreen() async throws {
        let m = model(.new)
        m.place = OnboardingPlace(step: "instructions")
        let screen = Offscreen(OnboardingScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        XCTAssertTrue(screen.has("option=import")); XCTAssertTrue(screen.has("option=own"))
        XCTAssertFalse(screen.has("onboarding-instructions"), "the text box only once a way is chosen")
        XCTAssertTrue(screen.press("option=import"))
        await settle(0.2)
        XCTAssertTrue(screen.has("onboarding-copy-prompt"))
        XCTAssertTrue(screen.has("onboarding-instructions"))
        XCTAssertTrue(screen.has("onboarding-skip"))
        let a = try XCTUnwrap(screen.frame("option=import")), b = try XCTUnwrap(screen.frame("option=own"))
        XCTAssertEqual(a.width, b.width, accuracy: 1, "two options side by side, the same width")
        XCTAssertEqual(a.minY, b.minY, accuracy: 1)
    }

    func testGuidedConnectPageAndTheAgentPopupComeFromTheirSlots() async throws {
        var asked: [String] = []
        let context = OnboardingContext(mode: .guided, into: "p1", data: data, onDone: { _, _ in },
                                        connectLibrary: { request in asked.append("connect \(request.project?.name ?? "-") \(request.pager.map { "\($0.index + 1)/\($0.count)" } ?? "-")"); return AnyView(Color.red.probe("connect-slot")) },
                                        agentSetup: { _ in asked.append("agent"); return AnyView(Color.blue.probe("agent-slot")) })
        let m = OnboardingModel(context: context)
        let screen = Offscreen(OnboardingScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        m.place = OnboardingPlace(step: "connect")
        await settle(0.3)
        XCTAssertTrue(screen.has("connect-slot"))
        XCTAssertTrue(asked.contains("connect Thesis 2/2"), "\(asked)")
    }

    func testANewUsersAgentPopupThenImportYourContext() async throws {
        var agent: AgentSetupRequest?
        var flow: ImportFlowRequest?
        var landed: [(Onboarded, OnboardedExtras)] = []
        let context = OnboardingContext(
            mode: .new, data: data, agents: OnboardingAgents(providers: { _ in AgentProviders(providers: []) }, rememberProvider: { _ in }, toolsInstall: { _ in }, toolsUpdate: { _ in }),
            onDone: { made, extras in landed.append((made, extras)) },
            importFlow: { request in flow = request; return AnyView(Color.white.probe("import-slot")) },
            connectLibrary: { _ in AnyView(Color.white.probe("librarian-slot")) },
            agentSetup: { request in agent = request; return AnyView(Color.white.probe("agent-slot")) })
        let m = OnboardingModel(context: context)
        let screen = Offscreen(OnboardingScreen(model: m), size: CGSize(width: 1440, height: 900))
        await settle(0.3)
        XCTAssertFalse(screen.has("onboarding-step-of"), "Welcome is the only screen of a new user's flow that draws a pager: none")
        m.setTools(snap(["claude": s("missing"), "codex": s("missing")]))
        XCTAssertTrue(screen.press("onboarding-continue"))
        await until { m.gate == .ask }
        await settle(0.2)
        XCTAssertTrue(screen.has("agent-slot"), "the agent popup over Welcome")
        agent?.onDone("codex")
        await settle(0.3)
        XCTAssertEqual(m.place.step, "create")
        XCTAssertTrue(screen.has("import-slot"), "Import your context's page in place of Create")
        XCTAssertFalse(screen.has("onboarding-back"), "a new person's first run has nowhere to go back to")
        let librarian = Offscreen(try XCTUnwrap(flow).renderLibrarian(LibrarianRequest(sessionId: "s1", project: nil, onDone: {}, onBack: nil)), size: CGSize(width: 400, height: 300))
        await settle(0.2)
        XCTAssertTrue(librarian.has("librarian-slot"), "Import manually: the librarian's chat")
        flow?.onDone(Onboarded(projectId: "p", workspaceId: "w", gettingStarted: true), OnboardedExtras(session: "s1"))
        await until { !landed.isEmpty }
        XCTAssertEqual(landed.first?.0.projectId, "p"); XCTAssertEqual(landed.first?.1.session, "s1")
    }
}
