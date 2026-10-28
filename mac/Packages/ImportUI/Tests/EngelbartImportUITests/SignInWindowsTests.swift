import XCTest
import EngelbartCore
import EngelbartConnect
@testable import EngelbartImportUI

// signInWindows (model/connect.js), as test/connect-turned-down.test.cjs and connect-auto-signin.test.cjs drive it: each
// open(row) waits until the test answers it.

@MainActor
final class Chain {
    var opened: [String] = []
    var waiting: [String: CheckedContinuation<String, Error>] = [:]
    var signIns: [String: SignIn]
    var state: Picks?
    var consent: () -> Bool
    let platform: String
    let viaRoute: Bool
    var chain: SignInWindows!
    init(signIns: [String: SignIn] = [:], state: Picks?, consent: @escaping () -> Bool = { true }, platform: String = "darwin", viaRoute: Bool = false) {
        self.signIns = signIns; self.state = state; self.consent = consent; self.platform = platform; self.viaRoute = viaRoute
        chain = SignInWindows(pick: { [unowned self] rows in ConnectModel.signInChain(rows, signIns: self.signIns, state: self.state, consent: self.consent()) },
                              open: { [unowned self] row in
                                  try await withCheckedThrowingContinuation { (c: CheckedContinuation<String, Error>) in
                                      let route = ConnectModel.signsInViaBrowser(row.app, self.signIns[row.app], platform: self.platform) ? "browser" : "window"
                                      self.opened.append(self.viaRoute ? "\(row.app) \(route)" : row.app)
                                      self.waiting[row.app] = c
                                  }
                              })
    }
    func settle() async { for _ in 0..<20 { await Task.yield() } }
    func answer(_ app: String, _ status: String) async {
        let shown = ["signed-in": "signed-in", "browser": "browser", "declined": "declined"][status]
        if let shown { for other in ConnectSources.sharesSignIn(app) { signIns[other] = SignIn(status: shown) } }
        waiting.removeValue(forKey: app)?.resume(returning: status)
        await settle()
    }
    func fail(_ app: String) async { waiting.removeValue(forKey: app)?.resume(throwing: ConnectError("failed", "gone")); await settle() }
    func start(_ rows: [SourceApp]) -> Task<Void, Never> { let c = chain!; return Task { @MainActor in await c.turnedDown(rows) } }
}

@MainActor
final class SignInWindowsTests: XCTestCase {
    func testNotNowOneAtATime() async {
        let rows = [sa("chats", "Claude"), sa("notes", "Google Docs"), sa("email", "Gmail")]
        let c = Chain(state: picksWith(rows.map { ($0.id, $0.app) }))
        let done = c.start(rows)
        await c.settle()
        XCTAssertEqual(c.opened, ["Claude"])
        await c.answer("Claude", "signed-in")
        XCTAssertEqual(c.opened, ["Claude", "Google Docs"])
        await c.answer("Google Docs", "signed-in")
        await done.value
        XCTAssertEqual(c.opened, ["Claude", "Google Docs"], "Gmail signed in with Google Drive")
    }

    func testDenyWaitsTheirTurn() async {
        let rows = [("chats", "Perplexity"), ("chats", "Grok"), ("notes", "Google Docs"), ("chats", "Gemini")]
        let c = Chain(state: picksWith(rows))
        let first = c.start([sa("chats", "Perplexity")])
        await c.settle()
        _ = c.start([sa("chats", "Grok")])
        _ = c.start([sa("chats", "Perplexity")])
        await c.settle()
        XCTAssertEqual(c.opened, ["Perplexity"])
        await c.answer("Perplexity", "signed-in")
        XCTAssertEqual(c.opened, ["Perplexity", "Grok"])
        _ = c.start([sa("notes", "Google Docs"), sa("chats", "Gemini")])
        await c.settle()
        await c.answer("Grok", "rejected")
        XCTAssertEqual(c.opened, ["Perplexity", "Grok", "Google Docs"])
        await c.answer("Google Docs", "signed-in")
        await first.value
        XCTAssertEqual(c.opened, ["Perplexity", "Grok", "Google Docs"])
    }

    func testClosedStopsTheChain() async {
        let rows = [sa("chats", "Claude"), sa("chats", "Grok"), sa("chats", "ChatGPT")]
        let c = Chain(state: picksWith(rows.map { ($0.id, $0.app) }))
        let done = c.start(rows)
        await c.settle()
        await c.answer("Claude", "closed")
        await done.value
        XCTAssertEqual(c.opened, ["Claude"])
        let again = c.start([sa("chats", "ChatGPT")])
        await c.settle()
        XCTAssertEqual(c.opened, ["Claude", "ChatGPT"], "only what was turned down now")
        await c.answer("ChatGPT", "signed-in")
        await again.value
    }

    func testConsentOff() async {
        var on = false
        let rows = [sa("chats", "Claude"), sa("chats", "Grok")]
        let c = Chain(state: picksWith(rows.map { ($0.id, $0.app) }), consent: { on })
        await c.chain.turnedDown(rows)
        XCTAssertEqual(c.opened, [])
        on = true
        let done = c.start(rows)
        await c.settle()
        on = false
        await c.answer("Claude", "signed-in")
        await done.value
        XCTAssertEqual(c.opened, ["Claude"])
    }

    func testAWindowThatFailsCountsAsClosed() async {
        let rows = [sa("chats", "Claude"), sa("chats", "Grok")]
        let c = Chain(state: nil)
        let done = c.start(rows)
        await c.settle()
        await c.fail("Claude")
        await done.value
        XCTAssertEqual(c.opened, ["Claude"])
    }

    func testGoogleTakesTheBrowserRouteAndDoesNotHoldTheChain() async {
        let rows = [("notes", "Google Docs"), ("chats", "ChatGPT")]
        let c = Chain(state: picksWith(rows), viaRoute: true)
        let done = c.start([sa("notes", "Google Docs")])
        await c.settle()
        _ = c.start([sa("chats", "ChatGPT")])
        await c.settle()
        XCTAssertEqual(c.opened, ["Google Docs browser"])
        await c.answer("Google Docs", "browser")
        XCTAssertEqual(c.opened, ["Google Docs browser", "ChatGPT window"])
        await c.answer("ChatGPT", "signed-in")
        await done.value
    }

    func testNotNowGivesTheGroupItsWindow() async {
        let rows = [("notes", "Google Docs"), ("email", "Gmail"), ("chats", "Claude")]
        let c = Chain(state: picksWith(rows), viaRoute: true)
        let done = c.start([sa("notes", "Google Docs"), sa("chats", "Claude")])
        await c.settle()
        _ = c.start([sa("email", "Gmail")])
        await c.answer("Google Docs", "declined")
        XCTAssertEqual(c.opened, ["Google Docs browser", "Google Docs window"])
        await c.answer("Google Docs", "signed-in")
        XCTAssertEqual(c.opened, ["Google Docs browser", "Google Docs window", "Claude window"])
        await c.answer("Claude", "signed-in")
        await done.value
    }

    func testSelectAllOffTheMac() async {
        let rows = [("chats", "ChatGPT"), ("chats", "Claude"), ("notes", "Google Docs"), ("email", "Gmail")]
        let c = Chain(state: picksWith(rows), platform: "linux", viaRoute: true)
        let done = c.start([sa("chats", "ChatGPT")])
        for (id, app) in rows.dropFirst() { _ = c.start([sa(id, app)]) }
        await c.settle()
        XCTAssertEqual(c.opened, ["ChatGPT window"])
        await c.answer("ChatGPT", "signed-in")
        XCTAssertEqual(c.opened, ["ChatGPT window", "Claude window"])
        await c.answer("Claude", "rejected")
        XCTAssertEqual(c.opened, ["ChatGPT window", "Claude window", "Google Docs window"])
        await c.answer("Google Docs", "signed-in")
        await done.value
        XCTAssertEqual(c.opened, ["ChatGPT window", "Claude window", "Google Docs window"])
    }

    func testReplacedAndDroppedDoNotStop() async {
        let rows = [("chats", "ChatGPT"), ("chats", "Claude"), ("chats", "Grok"), ("chats", "Perplexity")]
        let c = Chain(state: picksWith(rows))
        let done = c.start(rows.map { sa($0.0, $0.1) })
        await c.settle()
        await c.answer("ChatGPT", "replaced")
        await c.answer("Claude", "dropped")
        XCTAssertEqual(c.opened, ["ChatGPT", "Claude", "Grok"])
        await c.answer("Grok", "closed")
        await done.value
        XCTAssertEqual(c.opened, ["ChatGPT", "Claude", "Grok"])
    }

    func testClosedWindowUnticksItsGroupOnly() async {
        let rows = [sa("notes", "Google Docs"), sa("email", "Gmail"), sa("chats", "Grok"), sa("chats", "ChatGPT")]
        var state: Picks? = picksWith(rows.map { ($0.id, $0.app) })
        var signIns = Dictionary(uniqueKeysWithValues: rows.map { ($0.app, SignIn(status: "declined")) })
        var opened: [String] = []
        var close: (() -> Void)?
        let chain = SignInWindows(pick: { ConnectModel.signInChain($0, signIns: signIns, state: state) }, open: { row in
            try await withCheckedThrowingContinuation { c in
                opened.append(row.app)
                signIns[row.app] = SignIn(status: "signing", was: signIns[row.app])
                close = { let out = ConnectModel.signInWindowClosed(state, row.app, signIns); state = out.state; signIns = out.signIns; c.resume(returning: "closed") }
            }
        })
        let done = Task { @MainActor in await chain.turnedDown(rows) }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(opened, ["Google Docs"])
        close?()
        await done.value
        XCTAssertEqual(opened, ["Google Docs"])
        XCTAssertFalse(ConnectModel.ticked(state, "notes", "Google Docs"))
        XCTAssertFalse(ConnectModel.ticked(state, "email", "Gmail"))
        let found: JSONValue = .object(["apps": .object(Dictionary(uniqueKeysWithValues: rows.map { ($0.app, JSONValue.object(["found": true])) }))])
        for app in ["Grok", "ChatGPT"] {
            XCTAssertTrue(ConnectModel.ticked(state, "chats", app))
            XCTAssertEqual(ConnectModel.rowLabel(app, found: found, signIn: ConnectModel.shownSignIn(state, "chats", app, signIns)), label("", "", signIn: true))
        }
    }
}
