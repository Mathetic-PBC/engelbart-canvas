import XCTest
import WebKit
import EngelbartCore
@testable import EngelbartConnect

/// signin-window.cjs (connect-signin-window.test.cjs) with a real window and web view: polled until signed in, closed by
/// the person → 'closed' or, for a site, 'signed-in' when its cookies changed; https only; Google's refusal page clears
/// the cookies it leaves; one window per sign-in group. Pages point at a closed loopback port: nothing leaves the Mac.
@MainActor
final class SignInWindowTests: XCTestCase {
    let nowhere = "https://127.0.0.1:9/"

    func window(jar: FakeJar, signedIn: @escaping (String) async -> Bool = { _ in false }) -> SignInWindow {
        let store = WKWebsiteDataStore.nonPersistent()
        return SignInWindow(store: { store }, jar: jar, signedIn: signedIn, headless: true, pollMs: 30)
    }

    func testPolledUntilSignedIn() async {
        let flag = Box(false)
        let w = window(jar: FakeJar(), signedIn: { _ in flag.get() })
        let pending = Task { await w.present(group: "chatgpt.com", start: nowhere, title: "Sign in", signedInNow: { flag.get() }, closed: nil) }
        let open = await eventually(5) { w.isOpen() }
        XCTAssertTrue(open)
        XCTAssertEqual(w.current?.window.title, "Sign in")
        XCTAssertEqual(w.current?.window.contentMinSize, CGSize(width: 360, height: 480))
        // A second ask for the same sign-in waits on the same window.
        let second = Task { await w.present(group: "chatgpt.com", start: nowhere, title: "Sign in", signedInNow: { flag.get() }, closed: nil) }
        try? await Task.sleep(nanoseconds: 100_000_000)
        flag.set(true)
        let a = await pending.value, b = await second.value
        XCTAssertEqual(a, "signed-in"); XCTAssertEqual(b, "signed-in")
        XCTAssertFalse(w.isOpen())
    }

    func testClosedByThePersonOrByEngelbart() async {
        let w = window(jar: FakeJar())
        let pending = Task { await w.present(group: "g", start: nowhere, title: "Sign in", signedInNow: { false }, closed: nil) }
        _ = await eventually(5) { w.isOpen() }
        w.current?.window.close() // the person's close button: windowWillClose
        let out = await pending.value
        XCTAssertEqual(out, "closed")
        let again = Task { await w.present(group: "g", start: nowhere, title: "Sign in", signedInNow: { false }, closed: nil) }
        _ = await eventually(5) { w.isOpen() }
        w.close()
        let closed = await again.value
        XCTAssertEqual(closed, "closed")
        // Another group: the window open closes ('closed') and the new one opens.
        let first = Task { await w.present(group: "a", start: nowhere, title: "A", signedInNow: nil, closed: nil) }
        _ = await eventually(5) { w.isOpen() }
        let next = Task { await w.present(group: "b", start: nowhere, title: "B", signedInNow: { true }, closed: nil) }
        let f = await first.value, n = await next.value
        XCTAssertEqual(f, "closed"); XCTAssertEqual(n, "signed-in")
    }

    func testOpenSiteSignedInWhenItsCookiesChanged() async {
        let jar = FakeJar([StoredCookie(domain: ".linear.app", name: "a", value: "1")])
        let w = window(jar: jar)
        let http = await w.openSite(name: "Linear", url: "http://linear.app/")
        XCTAssertEqual(http, "closed", "https only")
        let pending = Task { await w.openSite(name: "Linear", url: nowhere, domains: ["www.linear.app"]) }
        _ = await eventually(5) { w.isOpen() }
        XCTAssertEqual(w.current?.window.title, "Sign in to Linear")
        XCTAssertEqual(w.current?.group, "site linear.app")
        await jar.set(StoredCookie(domain: ".linear.app", name: "session", value: "s"))
        w.current?.window.close()
        let out = await pending.value
        XCTAssertEqual(out, "signed-in")
        let unchanged = Task { await w.openSite(name: "Linear", url: nowhere, domains: ["linear.app"]) }
        _ = await eventually(5) { w.isOpen() }
        w.current?.window.close()
        let u = await unchanged.value
        XCTAssertEqual(u, "closed")
    }

    func testGoogleRefusalAndRules() async {
        XCTAssertTrue(SignInRules.rejectedByGoogle("https://accounts.google.com/v3/signin/rejected?x=1"))
        XCTAssertFalse(SignInRules.rejectedByGoogle("https://accounts.google.com/signin"))
        XCTAssertTrue(SignInRules.httpsOnly("https://x")); XCTAssertFalse(SignInRules.httpsOnly("http://x"))
        XCTAssertEqual(SignInRules.siteDomains("Linear", start: "https://www.linear.app/"), ["linear.app"])
        let jar = FakeJar([StoredCookie(domain: ".google.com", name: "__Secure-1PSID", value: "x"), StoredCookie(domain: "accounts.google.com", name: "OTZ", value: "x"),
                           StoredCookie(domain: ".google.com", name: "SID", value: "keep"), StoredCookie(domain: ".youtube.com", name: "NID", value: "keep")])
        await SignInRules.clearGoogleRefusal(jar)
        XCTAssertEqual(jar.cookies.map(\.name).sorted(), ["NID", "SID"])
        // Landing on the refusal page ends the window as 'rejected'.
        let w = window(jar: jar)
        let pending = Task { await w.present(group: "google.com", start: nowhere, title: "Sign in", signedInNow: { false }, closed: nil) }
        _ = await eventually(5) { w.isOpen() }
        w.landed("https://accounts.google.com/signin/rejected")
        let out = await pending.value
        XCTAssertEqual(out, "rejected")
        let print = await SignInRules.printOf(FakeJar([StoredCookie(domain: ".b.com", name: "z", value: "1"), StoredCookie(domain: ".b.com", name: "a", value: "2")]), ["b.com"])
        XCTAssertEqual(print, ".b.com|/|a|2\n.b.com|/|z|1")
    }

    func testOpenAnAppWithNoKnownSignIn() async {
        // An app with no sign-in page and no start page: nothing opens.
        let w = window(jar: FakeJar())
        let none = await w.open("Folders on this Mac")
        XCTAssertEqual(none, "closed")
        XCTAssertFalse(w.isOpen())
    }
}
