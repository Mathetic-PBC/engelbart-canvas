import XCTest
import WebKit
import EngelbartCore
@testable import EngelbartConnect

/// browser.cjs against real WKWebViews in the off-screen agent windows, on pages a loopback server serves (127.0.0.1 is
/// one of the hosts a job may open over http): open, read with refs, click a link, type in a search box and submit, the
/// read-only refusals, scroll, wait, screenshot, evaluate, download with the store's cookies.
@MainActor
final class BrowserPageTests: XCTestCase {
    var server: TestServer!
    var windows: AgentBrowserWindows!
    var logged: [String] = []

    override func setUp() async throws {
        server = try TestServer()
        server.route("/index.html", .init("""
        <html><head><title>Library home</title></head><body>
        <h1>Reading list</h1><p>First paragraph about novice programmers.</p>
        <a href="/two.html">Second page</a>
        <form action="/search.html" method="get" role="search"><input type="search" name="q" placeholder="Search docs"></form>
        <button onclick="document.title='deleted'">Delete file</button>
        <input type="password" name="pw" placeholder="Password">
        <div contenteditable="true" aria-label="Message">x</div>
        <div style="height:3000px"></div><p id="end">The end.</p>
        <a href="https://elsewhere.example/x">Elsewhere</a>
        </body></html>
        """))
        server.route("/two.html", .init("<html><head><title>Second</title></head><body><p>Page two text.</p><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p>Arrived later</p>') }, 300)</script></body></html>"))
        server.route("/search.html", .init("<html><head><title>Results</title></head><body>Results</body></html>"))
        server.route("/paper.pdf", .init(data: Data("%PDF-1.4 fake".utf8), type: "application/pdf", headers: ["Content-Disposition": "attachment; filename=\"Paper One.pdf\""]))
        let store = WKWebsiteDataStore.nonPersistent()
        windows = AgentBrowserWindows(store: { store }, headless: true, log: { [weak self] _, line in self?.logged.append(line) })
    }

    override func tearDown() async throws { windows.closeAll(); server = nil }

    func page(_ id: String = "job-1") -> AgentPage { windows.tools(AgentJob(id: id, label: "Docs", sites: ["127.0.0.1"])) }

    func testOpenReadAndRefuse() async throws {
        let p = page()
        do { _ = try await p.open("https://docs.google.com/"); XCTFail("not one of its sites") } catch { XCTAssertTrue((error as? ConnectError)?.message.contains("is not one of the sites this import may open") == true, "\(error)") }
        do { _ = try await p.open("\(server.base)/logout"); XCTFail("sign-out") } catch { XCTAssertEqual((error as? ConnectError)?.kind, "read-only") }
        let opened = try await p.open("\(server.base)/index.html")
        XCTAssertEqual(opened["title"]?.string, "Library home")
        XCTAssertTrue(windows.has("job-1"))
        let read = try await p.read(offset: 0, maxChars: 5000)
        XCTAssertTrue(JS.string(read["text"]).contains("First paragraph about novice programmers."))
        let elements = read["elements"]?.array ?? []
        let link = elements.first { $0["name"]?.string == "Second page" }
        XCTAssertEqual(link?["role"]?.string, "link")
        XCTAssertEqual(link?["href"]?.string, "\(server.base)/two.html")
        XCTAssertEqual(elements.first { $0["name"]?.string == "Password" }?["password"], true)
        XCTAssertTrue(logged.contains("Opened 127.0.0.1"))
        func ref(_ name: String) -> String { JS.string(elements.first { $0["name"]?.string == name }?["ref"]) }
        // Read-only: a Delete button, a password field, a composer are refused, and nothing changes.
        do { _ = try await p.click(ref("Delete file")); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.kind, "read-only") }
        let title = try await p.evaluate("return document.title")
        XCTAssertEqual(title.string, "Library home")
        do { _ = try await p.type(ref("Password"), "secret", submit: false, replace: true); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "That is a password field: call needs_you so the person signs in themselves") }
        do { _ = try await p.type(ref("Message"), "hello", submit: false, replace: true); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.kind, "read-only") }
        do { _ = try await p.click("e999"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "No control e999 on the page now: browser_read again") }
        do { _ = try await p.press("F5"); XCTFail() } catch { XCTAssertTrue((error as? ConnectError)?.message.hasPrefix("key must be one of") == true) }
        // Scrolling, a later read from an offset.
        let scrolled = try await p.scroll(ref: "", direction: "down", amount: 1200)
        XCTAssertFalse(scrolled.isNull)
        let later = try await p.read(offset: 10, maxChars: 500)
        XCTAssertEqual(later["text"]?.string?.hasPrefix(String(JS.string(read["text"]).dropFirst(10).prefix(20))), true)
    }

    func testTypeSearchClickWaitScreenshot() async throws {
        let p = page("job-2")
        _ = try await p.open("\(server.base)/index.html")
        let read = try await p.read(offset: 0, maxChars: 5000)
        let elements = read["elements"]?.array ?? []
        let box = JS.string(elements.first { $0["name"]?.string == "Search docs" }?["ref"])
        let typed = try await p.type(box, "novice help", submit: false, replace: true)
        XCTAssertEqual(typed["typed"]?.int, 11)
        let value = try await p.evaluate("return document.querySelector('input[type=search]').value")
        XCTAssertEqual(value.string, "novice help")
        XCTAssertTrue(logged.contains("Typed into “Search docs”"))
        // A link click goes where it points (a synthesized mouse click in the off-screen window).
        let link = JS.string(elements.first { $0["name"]?.string == "Second page" }?["ref"])
        let clicked = try await p.click(link)
        let arrived = await eventually(5) { p.url().hasSuffix("/two.html") }
        XCTAssertTrue(arrived, "clicked: \(clicked.text()) at \(p.url())")
        let waited = try await p.wait(seconds: 5, untilText: "Arrived later", untilGone: "", stable: false)
        XCTAssertEqual(waited["done"], true)
        let shot = try await p.screenshot()
        XCTAssertEqual(shot.mimeType, "image/jpeg")
        XCTAssertGreaterThan(Data(base64Encoded: shot.data)?.count ?? 0, 100)
        // ensure: already on that host → no new load.
        let before = server.seen("/two.html")
        _ = try await p.ensure("\(server.base)/two.html")
        XCTAssertEqual(server.seen("/two.html"), before)
        // A link to another host is kept away when followed by the page itself.
        _ = try await p.open("\(server.base)/index.html")
        _ = try await p.evaluate("location.href = 'https://elsewhere.example/x'; return true")
        let kept = await eventually(5) { self.logged.contains { $0.hasPrefix("Kept away from elsewhere.example") } }
        XCTAssertTrue(kept, logged.joined(separator: "\n"))
    }

    func testDownloadWithTheStoresCookies() async throws {
        let p = page("job-3")
        let dir = TempDir()
        let got = try await p.download("\(server.base)/paper.pdf", dir: dir.path, name: "", maxBytes: nil, quiet: false)
        XCTAssertEqual((got.path as NSString).lastPathComponent, "Paper One.pdf")
        XCTAssertEqual(got.bytes, 13); XCTAssertEqual(got.type, "application/pdf")
        let again = try await p.download("\(server.base)/paper.pdf", dir: dir.path, name: "", maxBytes: nil, quiet: true)
        XCTAssertEqual((again.path as NSString).lastPathComponent, "Paper One-2.pdf", "never over a file there")
        do { _ = try await p.download("\(server.base)/paper.pdf", dir: dir.path, name: "", maxBytes: 5, quiet: true); XCTFail() } catch { XCTAssertTrue((error as? ConnectError)?.message.hasPrefix("The file is larger than") == true) }
        do { _ = try await p.download("\(server.base)/missing.pdf", dir: dir.path, name: "", maxBytes: nil, quiet: true); XCTFail() } catch { XCTAssertTrue((error as? ConnectError)?.message.hasSuffix("answered 404") == true) }
        do { _ = try await p.download("https://elsewhere.example/a.pdf", dir: dir.path, name: "", maxBytes: nil, quiet: true); XCTFail() } catch { XCTAssertTrue((error as? ConnectError)?.message.contains("is not one of the sites") == true) }
        // The store's cookies go with the request (Electron's session.fetch).
        let cookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "sid", .value: "abc"])!
        let fetched = try await CookieFetch.fetch("\(server.base)/paper.pdf", cookies: [cookie], userAgent: "EngelbartTest", timeout: 10)
        XCTAssertEqual((fetched.1 as? HTTPURLResponse)?.statusCode, 200)
        let last = server.requests.last { $0.path == "/paper.pdf" }
        XCTAssertEqual(last?.headers["cookie"], "sid=abc")
        XCTAssertEqual(last?.headers["user-agent"], "EngelbartTest")
        XCTAssertTrue(logged.contains("Downloaded Paper One.pdf"))
    }

    func testWindowsShowHideClose() async throws {
        let p = page("job-4")
        _ = try await p.open("\(server.base)/two.html")
        XCTAssertFalse(windows.show("job-4"), "headless: never shown")
        let shown = AgentBrowserWindows(store: { WKWebsiteDataStore.nonPersistent() }, headless: false)
        let q = shown.tools(AgentJob(id: "job-5", label: "Docs", sites: ["127.0.0.1"]))
        _ = try await q.open("\(server.base)/two.html")
        XCTAssertTrue(shown.show("job-5", title: "Sign in to Docs"))
        XCTAssertEqual(shown.windows["job-5"]?.window.title, "Sign in to Docs")
        XCTAssertEqual(shown.windows["job-5"]?.window.alphaValue, 1)
        shown.hide("job-5")
        XCTAssertEqual(shown.windows["job-5"]?.window.alphaValue, 0)
        XCTAssertEqual(shown.windows["job-5"]?.window.ignoresMouseEvents, true, "hidden again: see-through and out of the way (AppKit keeps its frame near a screen)")
        shown.close("job-5")
        XCTAssertFalse(shown.has("job-5"))
        windows.closeAll()
        XCTAssertFalse(windows.has("job-4"))
        XCTAssertEqual(AgentBrowser.view, CGSize(width: 1280, height: 900))
    }
}
