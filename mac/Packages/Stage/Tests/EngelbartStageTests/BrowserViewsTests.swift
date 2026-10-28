import XCTest
import WebKit
import EngelbartCore
@testable import EngelbartStage

// test/browser.test.cjs, web-page-marks, web-live-stage and stage-sections, against real WKWebViews on local file: pages
// (no network): pages load in tabs, report their state, find with counts, show a guide's section, hand over their
// selection, are saved whole; a pdf on disk goes to the viewer; a page from disk may reach another, only inside the root.

final class FakeMarks: StagePageMarks {
    var marks: [String: [JSONValue]] = [:]
    var added: [(String, JSONValue, Data?)] = []
    var listed: [String] = []
    func list(_ url: String) async throws -> [JSONValue] { listed.append(url); return marks[url] ?? [] }
    func add(_ url: String, _ mark: JSONValue, crop: Data?) async throws -> Bool { added.append((url, mark, crop)); marks[url, default: []].append(mark); return true }
    func remove(_ url: String, _ markId: String) async throws -> JSONValue? {
        guard let m = marks[url]?.first(where: { $0["id"]?.string == markId }) else { return nil }
        marks[url]?.removeAll { $0["id"]?.string == markId }
        return ["mark": m]
    }
    func restore(_ url: String, _ removed: JSONValue) async throws -> Bool { if let m = removed["mark"] { marks[url, default: []].append(m) }; return true }
    func update(_ url: String, _ markId: String, _ patch: JSONValue, crop: Data?) async throws -> JSONValue? { marks[url]?.first { $0["id"]?.string == markId } }
}

@MainActor
final class BrowserViewsTests: XCTestCase {
    var dir: URL!
    var window: NSWindow!
    var views: BrowserViews!
    var events: [BrowserEvent] = []
    var marks = FakeMarks()

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("stage-pages-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let container = FlippedView(frame: NSRect(x: 0, y: 0, width: 900, height: 700))
        window.contentView = container
        let root = dir.path
        views = BrowserViews(fileRoot: { root }, pageMarks: marks)
        views.container = container
        views.onEvent = { [weak self] in self?.events.append($0) }
    }

    override func tearDown() async throws {
        views.dispose()
        window.close()
        try? FileManager.default.removeItem(at: dir)
    }

    func page(_ name: String, _ html: String) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try html.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func until(_ what: String, timeout: TimeInterval = 10, _ check: @escaping () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !check() && Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(check(), what)
    }

    func lastState(_ id: String) -> PageState? {
        for e in events.reversed() { if case .state(let s) = e, s.id == id { return s } }
        return nil
    }

    func testAPageOnDiskLoadsReportsAndFinds() async throws {
        let url = try page("index.html", "<html><head><title>Hello page</title></head><body><h1>Intro</h1><p>Hello world, hello again.</p><h2>Results</h2><p>The target passage lives here.</p><h2>Next</h2><p>After.</p></body></html>")
        try views.open("t1", url.absoluteString)
        views.show("t1", NSRect(x: 0, y: 0, width: 800, height: 600))
        await until("the page arrives") { [self] in self.lastState("t1")?.drawn == true && self.lastState("t1")?.loading == false }
        XCTAssertEqual(lastState("t1")?.title, "Hello page")
        XCTAssertEqual(lastState("t1")?.url, url.absoluteString)
        XCTAssertNil(lastState("t1")?.error)
        try? await Task.sleep(nanoseconds: 300_000_000) // the page script's DOMContentLoaded
        views.find("t1", "hello")
        await until("find counts") { [self] in self.events.contains { if case .found(_, let n, _) = $0 { return n == 2 }; return false } }
        views.find("t1", "hello")
        await until("the same query steps") { [self] in self.events.contains { if case .found(_, 2, let a) = $0 { return a == 2 }; return false } }
        views.stopFind("t1")
        let shown = await views.section("t1", "the TARGET passage")
        XCTAssertTrue(shown, "a guide's section is found as find would")
        let missing = await views.section("t1", "not on this page")
        XCTAssertFalse(missing)
    }

    func testOnlyAPageOnDiskReachesAnother() throws {
        XCTAssertThrowsError(try views.open("t2", "file:///etc/hosts"))
        XCTAssertThrowsError(try views.open("t2", "ftp://example.org"))
        let inside = dir.appendingPathComponent("a.html").absoluteString
        XCTAssertTrue(views.allowed(inside, from: dir.appendingPathComponent("b.html").absoluteString))
        XCTAssertFalse(views.allowed(inside, from: "https://example.org"))
    }

    func testAPdfOnDiskGoesToTheViewer() async throws {
        let pdf = dir.appendingPathComponent("Paper.pdf")
        try Data("%PDF-1.4 tiny".utf8).write(to: pdf)
        try views.open("t3", pdf.absoluteString)
        guard case .pdf(let id, _, let name, _, let loading, let bytes, let error)? = events.last else { return XCTFail("no pdf event") }
        XCTAssertEqual([id, name], ["t3", "Paper"]); XCTAssertFalse(loading); XCTAssertEqual(bytes, Data("%PDF-1.4 tiny".utf8)); XCTAssertNil(error)
        XCTAssertNil(views.entries["t3"], "never loaded into a page")
        try views.open("t3", dir.appendingPathComponent("gone.pdf").absoluteString)
        guard case .pdf(_, _, _, _, _, _, let err)? = events.last else { return XCTFail() }
        XCTAssertEqual(err, "Nothing is at that path")
    }

    func testSelectionScreenshotAndSave() async throws {
        let url = try page("sel.html", "<html><head><title>Sel</title></head><body><p id=p>Once upon a time the future was bright.</p></body></html>")
        try views.open("t4", url.absoluteString)
        views.show("t4", NSRect(x: 0, y: 0, width: 800, height: 600))
        await until("loaded") { [self] in self.lastState("t4")?.drawn == true && self.lastState("t4")?.loading == false }
        try? await Task.sleep(nanoseconds: 300_000_000)
        let none = await views.pageSelection("t4")
        XCTAssertNil(none, "nothing selected")
        _ = try await views.entries["t4"]!.webView.callAsyncJavaScript("const r = document.createRange(); const t = document.getElementById('p').firstChild; r.setStart(t, 18); r.setEnd(t, 26); getSelection().removeAllRanges(); getSelection().addRange(r);", contentWorld: .page)
        let selection = await views.pageSelection("t4", timeout: 2)
        XCTAssertEqual(selection?.quote.exact, "the future", "taken to whole words")
        XCTAssertEqual(selection?.quote.prefix, "Once upon a time ")
        let shot = await views.screenshot("t4")
        XCTAssertNotNil(shot)
        XCTAssertEqual(shot?.prefix(4), Data([0x89, 0x50, 0x4e, 0x47]))
        let out = dir.appendingPathComponent("saved")
        let saved = try await views.savePage("t4", into: out)
        XCTAssertEqual(saved.title, "Sel")
        XCTAssertTrue((try String(contentsOf: saved.file, encoding: .utf8)).contains("the future was bright"))
        do { _ = try await views.savePage("nope", into: out); XCTFail() } catch { XCTAssertEqual(error.localizedDescription, "That tab is not open") }
    }

    func testHighlightsArePaintedFromTheInk() async throws {
        let url = try page("ink.html", "<html><body><p>Alice said the cat sat on the mat.</p></body></html>")
        marks.marks[url.absoluteString] = [["id": "m1", "quote": ["exact": "the cat sat", "prefix": "Alice said ", "suffix": " on the mat."], "note": "a note"]]
        try views.open("t5", url.absoluteString)
        views.show("t5", NSRect(x: 0, y: 0, width: 800, height: 600))
        await until("loaded") { [self] in self.lastState("t5")?.drawn == true && self.lastState("t5")?.loading == false }
        var painted = false
        for _ in 0..<40 {
            let size = try? await views.entries["t5"]!.webView.callAsyncJavaScript("return CSS.highlights.has('engelbart-web-mark') ? CSS.highlights.get('engelbart-web-mark').size : 0", contentWorld: StageSession.world) as? Int
            if size == 1 { painted = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(painted, "the page's highlight is tinted by its quote")
        let styled = try await views.entries["t5"]!.webView.callAsyncJavaScript("return document.adoptedStyleSheets.length", contentWorld: StageSession.world) as? Int
        XCTAssertGreaterThanOrEqual(styled ?? 0, 1, "the tints' rule, with no node added")
        let nodes = try await views.entries["t5"]!.webView.callAsyncJavaScript("return document.querySelectorAll('style,link').length", contentWorld: .page) as? Int
        XCTAssertEqual(nodes, 0, "the page's DOM is never changed")
    }

    func testAPageThatChangesItsOwnAddressGetsThatAddresssBoxes() async throws {
        let url = try page("spa.html", "<html><body><p>one page</p></body></html>")
        try views.open("t7", url.absoluteString)
        views.show("t7", NSRect(x: 0, y: 0, width: 800, height: 600))
        await until("loaded") { [self] in self.lastState("t7")?.drawn == true && self.lastState("t7")?.loading == false }
        _ = try await views.entries["t7"]!.webView.callAsyncJavaScript("history.pushState({}, '', 'spa.html?view=2')", contentWorld: .page)
        await until("the new address's marks asked") { [self] in self.marks.listed.contains { $0.hasSuffix("spa.html?view=2") } }
    }

    func testCloseAndWindowClose() async throws {
        let url = try page("c.html", "<html><body>c</body></html>")
        try views.open("t6", url.absoluteString)
        XCTAssertTrue(views.has("t6"))
        views.close("t6")
        XCTAssertFalse(views.has("t6"))
    }

    func testSavedPageUnpacksAnArchive() throws {
        let archive: [String: Any] = [
            "WebMainResource": ["WebResourceData": Data("<img src=\"https://x.org/a/pic.png\">".utf8), "WebResourceURL": "https://x.org/", "WebResourceMIMEType": "text/html", "WebResourceTextEncodingName": "UTF-8"],
            "WebSubresources": [["WebResourceData": Data([1, 2, 3]), "WebResourceURL": "https://x.org/a/pic.png", "WebResourceMIMEType": "image/png"]],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: archive, format: .binary, options: 0)
        let file = try SavedPage.write(archive: data, into: dir.appendingPathComponent("p"))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "<img src=\"index_files/pic.png\">")
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("p/index_files/pic.png")), Data([1, 2, 3]))
    }
}
