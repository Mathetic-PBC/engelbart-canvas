import XCTest
import WebKit
import EngelbartCore
@testable import EngelbartConnect

/// web-chats.cjs's scripts, verbatim, run for real in an agent window's WebKit page against a loopback server that answers
/// ChatGPT's and Claude's own endpoints (/api/auth/session, /backend-api/…, /api/organizations/…) with fixtures.
@MainActor
final class WebChatScriptsTests: XCTestCase {
    /// The agent's page, kept on the loopback site: `ensure` (chatgpt.com / claude.ai) stays where it is.
    final class Here: AgentPage, @unchecked Sendable {
        let inner: AgentPage
        init(_ inner: AgentPage) { self.inner = inner }
        func open(_ url: String) async throws -> JSONValue { ["url": .string(inner.url())] }
        func ensure(_ url: String) async throws -> JSONValue { ["url": .string(inner.url())] }
        func read(offset: Int, maxChars: Int) async throws -> JSONValue { try await inner.read(offset: offset, maxChars: maxChars) }
        func click(_ ref: String) async throws -> JSONValue { try await inner.click(ref) }
        func type(_ ref: String, _ text: String, submit: Bool, replace: Bool) async throws -> JSONValue { try await inner.type(ref, text, submit: submit, replace: replace) }
        func press(_ key: String) async throws -> JSONValue { try await inner.press(key) }
        func scroll(ref: String, direction: String, amount: Double) async throws -> JSONValue { try await inner.scroll(ref: ref, direction: direction, amount: amount) }
        func wait(seconds: Double, untilText: String, untilGone: String, stable: Bool) async throws -> JSONValue { try await inner.wait(seconds: seconds, untilText: untilText, untilGone: untilGone, stable: stable) }
        func screenshot() async throws -> (data: String, mimeType: String) { try await inner.screenshot() }
        func evaluate(_ script: String) async throws -> JSONValue { try await inner.evaluate(script) }
        func download(_ url: String, dir: String, name: String, maxBytes: Int?, quiet: Bool) async throws -> (path: String, bytes: Int, type: String, url: String) { try await inner.download(url, dir: dir, name: name, maxBytes: maxBytes, quiet: quiet) }
        func url() -> String { inner.url() }
    }

    func page(_ server: TestServer, _ windows: AgentBrowserWindows, _ id: String) async throws -> AgentPage {
        let inner = windows.tools(AgentJob(id: id, label: "Chats", sites: ["127.0.0.1"]))
        _ = try await inner.open("\(server.base)/")
        return Here(inner)
    }

    func testChatGPTAndClaudeThroughTheirOwnEndpoints() async throws {
        let server = try TestServer()
        let json = { (v: JSONValue) in TestServer.Reply(v.text(), type: "application/json") }
        server.route("/", .init("<html><head><title>Home</title></head><body>home</body></html>"))
        server.route("/api/auth/session", json(["accessToken": "tok", "user": ["email": "me@example.org"]]))
        server.route("/backend-api/conversations", json(["items": [["id": "g-111111", "title": "Regression help", "update_time": "2026-10-02T00:00:00Z"], ["id": "g-222222", "title": "Old recipe", "update_time": 1500000000]], "total": 2]))
        server.route("/backend-api/gizmos/snorlax/sidebar", json(["items": [["gizmo": ["gizmo": ["id": "g-p-abc", "display": ["name": "Thesis"]]]]], "cursor": .null]))
        server.route("/backend-api/gizmos/g-p-abc/conversations", json(["items": [["id": "g-333333", "title": "Chapter two", "update_time": "2026-10-03T00:00:00Z"]], "cursor": .null]))
        server.route("/backend-api/conversation/g-111111", json(["title": "Regression help", "update_time": 1759000100, "current_node": "b", "mapping": [
            "root": ["parent": .null, "message": .null],
            "a": ["parent": "root", "message": ["author": ["role": "user"], "content": ["content_type": "text", "parts": ["Which model?"]]]],
            "b": ["parent": "a", "message": ["author": ["role": "assistant"], "content": ["content_type": "text", "parts": ["A mixed model."]]]]]]))
        server.route("/api/organizations", json([["uuid": "org1", "name": "Me", "capabilities": ["chat"]]]))
        server.route("/api/organizations/org1/projects", json([["uuid": "p1", "name": "Thesis"]]))
        server.route("/api/organizations/org1/chat_conversations", json([["uuid": "c-111111", "name": "Study design", "updated_at": "2026-10-01T00:00:00Z", "project_uuid": "p1"], ["uuid": "c-222222", "name": "Pasta", "updated_at": "2026-10-01T00:00:00Z"]]))
        server.route("/api/organizations/org1/chat_conversations/c-111111", json(["name": "Study design", "chat_messages": [["sender": "human", "text": "How many?"], ["sender": "assistant", "content": [["type": "text", "text": "Twenty."]]]]]))
        let windows = AgentBrowserWindows(store: { WKWebsiteDataStore.nonPersistent() }, headless: true)
        defer { windows.closeAll() }
        let p = try await page(server, windows, "chats-1")
        let listed = try await WebChats.list(p, "ChatGPT", days: 365 * 3, sleep: { _ in })
        XCTAssertEqual(listed["account"]?.string, "me@example.org")
        XCTAssertEqual(listed["chats"]?.array?.map { JS.string($0["title"]) }, ["Chapter two", "Regression help"], "older than the days asked left out; a project's chats listed with its name")
        XCTAssertEqual(listed["chats"]?[0]?["project"]?.string, "Thesis")
        let chat = try await WebChats.read(p, "ChatGPT", "g-111111", sleep: { _ in })
        XCTAssertEqual(chat.turns, [Readers.Turn(role: "user", text: "Which model?"), Readers.Turn(role: "assistant", text: "A mixed model.")])
        let claude = try await WebChats.list(p, "Claude", project: "thes", sleep: { _ in })
        XCTAssertEqual(claude["chats"]?.array?.map { JS.string($0["id"]) }, ["c-111111"])
        XCTAssertEqual(claude["account"]?.string, "Me")
        let hoisted1 = try await WebChats.read(p, "Claude", "c-111111", sleep: { _ in }).turns.map(\.text)
        XCTAssertEqual(hoisted1, ["How many?", "Twenty."])
        XCTAssertTrue(server.requests.contains { $0.path == "/backend-api/conversations" && $0.headers["authorization"] == "Bearer tok" }, "the page's own session token")
    }

    func testSignedOutAndUnsure() async throws {
        let server = try TestServer()
        server.route("/", .init("<html><body>home</body></html>"))
        server.route("/api/auth/session", .init("{}", status: 401, type: "application/json"))
        server.route("/api/organizations", .init(#"{"type":"error","error":{"type":"permission_error","message":"Invalid authorization","details":{"error_code":"account_session_invalid"}}}"#, status: 403, type: "application/json"))
        let windows = AgentBrowserWindows(store: { WKWebsiteDataStore.nonPersistent() }, headless: true)
        defer { windows.closeAll() }
        let p = try await page(server, windows, "chats-2")
        do { _ = try await WebChats.list(p, "ChatGPT", sleep: { _ in }); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.kind, "signed-out") }
        do { _ = try await WebChats.list(p, "Claude", sleep: { _ in }); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.kind, "signed-out", "Claude's 403 that says so is a sign-out") }
        // A 403 that says nothing (Cloudflare's page), twice: unsure, never "signed out".
        let other = try TestServer()
        other.route("/", .init("<html><body>home</body></html>"))
        other.route("/api/organizations", .init("<html>checking your browser</html>", status: 403))
        let q = try await page(other, windows, "chats-3")
        do { _ = try await WebChats.list(q, "Claude", sleep: { _ in }); XCTFail() } catch {
            XCTAssertEqual((error as? ConnectError)?.kind, "unsure")
            XCTAssertTrue((error as? ConnectError)?.message.contains("(it answered 403)") == true, "\(error)")
        }
        XCTAssertEqual(other.seen("/api/organizations"), 2, "asked once more after a pause")
    }

    // gmail.cjs ACCOUNT_SCRIPT and SEARCH_SCRIPT, verbatim, on a page shaped like Gmail's: off mail.google.com they say
    // signed out at once; with that one host check standing in, they read the address, the key and the drawn rows.
    func testGmailScriptsInAPage() async throws {
        let server = try TestServer()
        server.route("/mail/u/0/", .init("""
        <html><head><title>Inbox (3) - me@example.org - Gmail</title><script>window.GLOBALS = [0,1,2,3,4,5,6,7,8,'abc123def'];</script></head><body>
        <div role="main"><table><tr><td><span email="ana@x.org" name="Ana">Ana</span></td><td><span data-thread-id="#thread-f:1811">Study plan</span></td><td class="xW"><span title="Fri, Oct 10, 2025 at 3:04 PM">Oct 10</span></td></tr>
        <tr><td><span email="bo@x.org">Bo</span></td><td><span data-thread-id="#thread-f:1812">Budget</span></td><td class="xW"><span title="Sat, Oct 11, 2025 at 9:00 AM">Oct 11</span></td></tr></table></div>
        </body></html>
        """))
        let windows = AgentBrowserWindows(store: { WKWebsiteDataStore.nonPersistent() }, headless: true)
        defer { windows.closeAll() }
        let p = windows.tools(AgentJob(id: "gmail-1", label: "Gmail", sites: ["127.0.0.1"]))
        _ = try await p.open("\(server.base)/mail/u/0/")
        let off = try await p.evaluate(Texts.gmailAccountScript)
        XCTAssertEqual(off, ["signedIn": false], "not mail.google.com: signed out at once")
        let host = "/mail\\.google\\.com$/.test(location.hostname)"
        XCTAssertTrue(Texts.gmailAccountScript.contains(host) && Texts.gmailSearchScript.contains(host), "the host check, verbatim")
        let account = try await p.evaluate(Texts.gmailAccountScript.replacingOccurrences(of: host, with: "true"))
        XCTAssertEqual(account["address"]?.string, "me@example.org"); XCTAssertEqual(account["ik"]?.string, "abc123def"); XCTAssertEqual(account["signedIn"], true)
        let search = try await p.evaluate(Gmail.searchScript(limit: 50).replacingOccurrences(of: host, with: "true"))
        XCTAssertEqual(search["threads"]?.array?.map { JS.string($0["id"]) }, ["thread-f:1811", "thread-f:1812"])
        XCTAssertEqual(search["threads"]?[0]?["subject"]?.string, "Study plan")
        XCTAssertEqual(search["threads"]?[0]?["people"]?.string, "Ana")
        XCTAssertEqual(search["threads"]?[1]?["date"]?.string, "Sat, Oct 11, 2025 at 9:00 AM")
        XCTAssertEqual(search["ik"]?.string, "abc123def")
    }
}
