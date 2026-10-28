import XCTest
import EngelbartCore
@testable import EngelbartStage

// test/stage-sections.test.cjs (the Stage's tabs, landing, kept tabs) against the native controller with a fake host.

@MainActor
final class FakeHost: StageHost {
    var projectId = "p1"
    var projectDirectory: String?
    var rows: [StageRow] = []
    var files: [String: StageFile] = [:]
    var kept: StageSnapshot?
    var setStages: [StageSnapshot] = []
    var opened: [String] = []
    var pages: [StagePage?] = []
    var asks: [StageAsk] = []
    var pdfRequests: [StagePDFRequest] = []
    func library() -> [StageRow] { rows }
    func inRail(_ id: String) -> Bool { false }
    func lookupLibraryItem(_ input: String) async -> StageLookup { StageLookup() }
    func readStageFile(_ input: String) async throws -> StageFile {
        if let f = files[input] { return f }
        throw StageFiles.Failure("Nothing is at that path")
    }
    func readLibraryFile(_ rowId: String) async throws -> Data { Data("%PDF".utf8) }
    func readAnnotations(rowId: String) async -> JSONValue? { [:] }
    func readPageAnnotations(url: String) async -> JSONValue? { [:] }
    func writeAnnotations(rowId: String, _ marks: JSONValue) async throws {}
    func writePageAnnotations(url: String, _ marks: JSONValue) async throws {}
    func stage() async -> StageSnapshot? { kept }
    func setStage(_ snapshot: StageSnapshot) { setStages.append(snapshot) }
    func pickPaths() async throws -> [String] { [] }
    func openExternal(_ url: String) { opened.append(url) }
    func makePDFView(_ request: StagePDFRequest) -> StagePDFViewing { pdfRequests.append(request); return FakePDF() }
    func ask(_ ask: StageAsk) async -> JSONValue? { asks.append(ask); return nil }
    func stopAsk(_ askId: String) {}
    func dismissAsk(_ askId: String) {}
    func openMention(_ row: StageRow) {}
    func openCited(_ href: String) -> Bool { false }
    func stagePageChanged(_ page: StagePage?) { pages.append(page) }
    func stageFrontChanged(_ rowId: String?) {}
    func stageTabsChanged(_ places: [String]) {}
    func showStage() {}
    func keysToDoc() -> Bool { false }
    func previewRow(for url: String) -> StageRow? { nil }
    func openBuildDetails(_ row: StageRow, from view: NSView) {}
    func previewTouch(_ url: String, visible: Bool) {}
}

@MainActor
final class FakePDF: StagePDFViewing {
    let view = NSView()
    var finds: [(String, Int)] = []
    func find(_ text: String, step: Int, fromStart: Bool) -> (matches: Int, active: Int)? { finds.append((text, step)); return (3, 1) }
    func stopFind() {}
    func showSection(find: String, to: String) {}
    func clearSection() {}
    func currentPage() -> Int { 4 }
    func addAsk(page: Int, markId: String, entry: JSONValue) {}
}

@MainActor
final class StageControllerTests: XCTestCase {
    func make(_ host: FakeHost) -> StageController {
        let stage = StageController(host: host)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentViewController = stage
        stage.view.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        return stage
    }
    func settle() async { try? await Task.sleep(nanoseconds: 200_000_000) }

    func testFilesOpenInTabsAndComeForward() async {
        let host = FakeHost()
        host.files["/Users/h/notes.md"] = StageFile(kind: .md, path: "/Users/h/notes.md", name: "notes.md", text: "# Notes\n\nThe target passage.")
        let stage = make(host)
        await settle()
        stage.openPaths(["/Users/h/notes.md"])
        await settle()
        XCTAssertEqual(stage.tabs.count, 1, "the blank tab in front takes it")
        XCTAssertEqual(stage.tab.file?.kind, .md)
        XCTAssertEqual(stage.titleOf(stage.tab), "notes.md")
        stage.newTab()
        XCTAssertEqual(stage.tabs.count, 2)
        stage.openFile("/Users/h/notes.md")
        XCTAssertEqual(stage.tabs.count, 2, "open already: its tab comes forward")
        XCTAssertEqual(stage.tab.file?.path, "/Users/h/notes.md")
        // kept 150 ms after it changed
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(host.setStages.last?.tabs.first, KeptTab(address: "/Users/h/notes.md", title: "notes.md"))
        stage.closeTab()
        XCTAssertEqual(stage.tabs.count, 1)
        stage.closeTab()
        XCTAssertEqual(stage.tabs.count, 1, "closing the last leaves a blank tab")
        XCTAssertTrue(stage.isBlank)
    }

    func testAtMostFifteenAndNewTab() async {
        let host = FakeHost()
        let stage = make(host)
        await settle()
        for _ in 0..<20 { stage.newTab() }
        XCTAssertEqual(stage.tabs.count, StageModel.maxTabs)
    }

    func testAPassageLandsInADrawnFile() async {
        let host = FakeHost()
        host.files["/Users/h/a.md"] = StageFile(kind: .md, path: "/Users/h/a.md", name: "a.md", text: "Intro.\n\nThe target passage lives here.")
        let stage = make(host)
        await settle()
        stage.openInput("/Users/h/a.md#find=target%20passage")
        await settle()
        XCTAssertNil(stage.tab.pendingFind, "found once the file is drawn")
        XCTAssertFalse(stage.finding, "no find card for a drawn file")
    }

    func testAMissingPathSaysSo() async {
        let host = FakeHost()
        let stage = make(host)
        await settle()
        stage.openPaths(["/Users/h/gone.md"])
        await settle()
        XCTAssertEqual(stage.tab.file?.kind, .error)
        XCTAssertEqual(stage.tab.file?.message, "Nothing is at that path")
    }

    func testKeptTabsComeBackUnopened() async {
        let host = FakeHost()
        host.rows = [StageRow(id: "p1", name: "ColBERT", type: "pdf", path: "/Users/h/ColBERT.pdf")]
        host.kept = StageSnapshot(active: 1, tabs: [KeptTab(item: "p1", title: "ColBERT"), KeptTab(item: "gone", title: "x"), KeptTab(address: "/Users/h/b.md", title: "b.md")])
        host.files["/Users/h/b.md"] = StageFile(kind: .md, path: "/Users/h/b.md", name: "b.md", text: "b")
        let stage = make(host)
        await settle()
        XCTAssertEqual(stage.tabs.count, 2)
        XCTAssertEqual(stage.titleOf(stage.tabs[0]), "ColBERT")
        XCTAssertEqual(stage.tab.file?.path, "/Users/h/b.md", "the one in front opens")
        XCTAssertNotNil(stage.tabs[0].restore, "the others wait until they come forward")
        stage.select(stage.tabs[0].id)
        await settle()
        XCTAssertEqual(stage.tab.pdf?.rowId, "p1")
        XCTAssertEqual(host.pdfRequests.last?.rowId, "p1")
    }

    func testGithubSignInGoesToTheBrowserAndFrontIsAPdf() async {
        let host = FakeHost()
        let stage = make(host)
        await settle()
        stage.openInput("https://github.com/login")
        XCTAssertEqual(host.opened, ["https://github.com/login"])
        host.rows = [StageRow(id: "p1", name: "ColBERT", type: "pdf", path: "/Users/h/ColBERT.pdf")]
        stage.openRow(host.rows[0])
        await settle()
        XCTAssertEqual(stage.front(), ["rowId": "p1", "url": .null, "page": 4, "kind": "pdf"])
    }

    func testKeys() async {
        let host = FakeHost()
        let stage = make(host)
        await settle()
        let t = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: 0, context: nil, characters: "t", charactersIgnoringModifiers: "t", isARepeat: false, keyCode: 17)!
        XCTAssertTrue(stage.handleKey(t))
        XCTAssertEqual(stage.tabs.count, 2)
        XCTAssertFalse(stage.handleKey(t, inTerminal: true), "the terminal's own tabs")
        let w = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: 0, context: nil, characters: "w", charactersIgnoringModifiers: "w", isARepeat: false, keyCode: 13)!
        XCTAssertTrue(stage.handleKey(w))
        XCTAssertEqual(stage.tabs.count, 1)
        let f = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: 0, context: nil, characters: "f", charactersIgnoringModifiers: "f", isARepeat: false, keyCode: 3)!
        XCTAssertTrue(stage.handleKey(f))
        XCTAssertTrue(stage.finding)
        stage.closeFind()
        XCTAssertFalse(stage.finding)
    }

    func testWithAsk() {
        let marks: JSONValue = ["3": [["id": "m1", "asks": []]]]
        let entry: JSONValue = ["id": "a1", "answer": "yes"]
        let once = StageController.withAsk(marks, page: 3, markId: "m1", entry: entry)
        XCTAssertEqual(once["3"]?[0]?["asks"]?.array?.count, 1)
        XCTAssertEqual(StageController.withAsk(once, page: 3, markId: "m1", entry: entry), once, "an answer already there is not added again")
        XCTAssertEqual(StageController.withAsk(marks, page: 2, markId: "m1", entry: entry), marks)
    }
}
