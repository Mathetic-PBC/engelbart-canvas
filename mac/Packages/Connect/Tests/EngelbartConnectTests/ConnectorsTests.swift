import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// connect.test.cjs "a connector's sign-in": discovery, registration, the code back on the loopback port, tokens kept and
/// refreshed. The authorization server is a fake fetch; the person's browser is a GET to the real loopback callback.
final class ConnectorsTests: XCTestCase {
    final class Seen: @unchecked Sendable { var registered: JSONValue?; var exchanged = 0; var refreshed = 0; var clock = Time.ms(); var changes: [Bool] = [] }

    func testSignInRegisterExchangeRefresh() async throws {
        let dir = TempDir()
        let base = "https://granola.test"
        let seen = Seen()
        let fetch: Connectors.Fetch = { req in
            let url = req.url!
            let body = req.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
            func json(_ v: JSONValue, _ status: Int = 200) -> (Data, HTTPURLResponse) { (Data(v.text().utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"])!) }
            switch url.path {
            case "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource":
                return json(["resource": .string("\(base)/mcp"), "authorization_servers": [.string(base)]])
            case "/.well-known/oauth-authorization-server":
                return json(["issuer": .string(base), "authorization_endpoint": .string("\(base)/authorize"), "token_endpoint": .string("\(base)/token"), "registration_endpoint": .string("\(base)/register")])
            case "/register":
                let r = try JSONValue.parse(Data(body.utf8)); seen.registered = r
                var o = r.object ?? [:]; o["client_id"] = "client-1"
                return json(.object(o), 201)
            case "/token":
                var form: [String: String] = [:]
                for pair in body.split(separator: "&") { let kv = pair.split(separator: "=", maxSplits: 1).map(String.init); if kv.count == 2 { form[kv[0]] = kv[1].removingPercentEncoding } }
                if form["grant_type"] == "authorization_code" {
                    seen.exchanged += 1
                    XCTAssertEqual(form["code"], "the-code"); XCTAssertNotNil(form["code_verifier"])
                    return json(["access_token": "access-1", "token_type": "Bearer", "expires_in": 600, "refresh_token": "refresh-1"])
                }
                seen.refreshed += 1
                return json(["access_token": "access-2", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "refresh-2"])
            default:
                return json(["error": "not_found"], 404)
            }
        }
        let openExternal: (String) async throws -> Void = { href in
            let asked = URLComponents(string: href)!
            XCTAssertEqual(asked.path, "/authorize")
            let q = Dictionary(uniqueKeysWithValues: (asked.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(q["code_challenge_method"], "S256")
            XCTAssertEqual(q["scope"], nil, "Granola names no scope")
            var back = URLComponents(string: q["redirect_uri"]!)!
            back.queryItems = [URLQueryItem(name: "code", value: "the-code"), URLQueryItem(name: "state", value: q["state"])]
            let url = back.url!
            Task { try? await Task.sleep(nanoseconds: 10_000_000); _ = try? await URLSession.shared.data(from: url) }
        }
        let file = dir.url.appendingPathComponent("connectors.json")
        let connectors = Connectors(file: { file }, crypt: PlainCrypt(), openExternal: openExternal, fetch: fetch, now: { seen.clock },
                                    urls: ["Granola": "\(base)/mcp"], onChange: { seen.changes.append($0.connected) }, probe: { _, _ in (404, []) })
        XCTAssertEqual(try connectors.status("Granola").connected, false)
        let none = await connectors.accessToken("Granola")
        XCTAssertNil(none)
        let status = try await connectors.signIn("Granola")
        XCTAssertTrue(status.connected)
        XCTAssertEqual(seen.registered?["client_name"]?.string, "Engelbart")
        XCTAssertTrue(JS.test(JS.string(seen.registered?["redirect_uris"]?[0]), #"^http://localhost:\d+/callback$"#))
        XCTAssertEqual(seen.exchanged, 1)
        XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("access-1"), "the tokens are kept sealed")
        let first = await connectors.accessToken("Granola")
        XCTAssertEqual(first, "access-1")
        seen.clock += 500_000 // within two minutes of its end: refreshed first
        let second = await connectors.accessToken("Granola")
        XCTAssertEqual(second, "access-2")
        XCTAssertEqual(seen.refreshed, 1)
        let servers = await connectors.serversFor(["Granola", "Notion", "ChatGPT"])
        XCTAssertEqual(servers.map { [$0.app, $0.name, $0.url, $0.token ?? ""] }, [["Granola", "granola", "\(base)/mcp", "access-2"]])
        XCTAssertFalse(try connectors.signOut("Granola").connected)
        XCTAssertTrue(seen.changes.contains(true) && seen.changes.last == false)
        XCTAssertThrowsError(try connectors.status("ChatGPT")) { XCTAssertTrue(($0 as? ConnectError)?.message.contains("has no connector") == true) }
    }

    func testCheckMarksRefusedAndNoTools() async throws {
        let dir = TempDir()
        let file = dir.url.appendingPathComponent("connectors.json")
        final class Answer: @unchecked Sendable { var value: (status: Int, tools: [String]) = (403, []) }
        let answer = Answer()
        let c = Connectors(file: { file }, crypt: PlainCrypt(), openExternal: { _ in }, fetch: { _ in throw ConnectError("failed", "offline") }, now: { 1000 },
                           probe: { _, _ in answer.value })
        c.save("Evernote", ["tokens": ["access_token": "a"], "obtainedAt": 0])
        var s = try await c.check("Evernote", force: true)
        XCTAssertEqual(s.state, "unavailable")
        answer.value = (200, ["unrelated"])
        s = try await c.check("Evernote", force: true)
        XCTAssertEqual(s.reason, "no-tools")
        answer.value = (200, ["search_notes"])
        s = try await c.check("Evernote", force: true)
        XCTAssertEqual(s.state, "connected")
        answer.value = (500, [])
        s = try await c.check("Evernote", force: true)
        XCTAssertEqual(s.unchecked, true)
    }
}
