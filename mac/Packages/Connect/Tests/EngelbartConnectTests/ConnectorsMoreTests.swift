import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// connectors.cjs beyond the first sign-in: the page the person's browser lands on, a callback that is not Engelbart's,
/// the registration kept for the same return address, a refresh refused (lapsed, "reconnect"), a refusal on the consent
/// page, and Cancel.
final class ConnectorsMoreTests: XCTestCase {
    final class Server: @unchecked Sendable { var registered = 0; var refreshRefused = false; var pages: [String] = []; var deny = false }

    func connectors(_ s: Server, file: URL, clock: Box<Double>, openExternal: ((String) async throws -> Void)? = nil) -> Connectors {
        let base = "https://granola.test"
        let fetch: Connectors.Fetch = { req in
            let url = req.url!
            let body = req.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
            func json(_ v: JSONValue, _ status: Int = 200) -> (Data, HTTPURLResponse) { (Data(v.text().utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!) }
            switch url.path {
            case "/.well-known/oauth-protected-resource/mcp": return json(["resource": .string("\(base)/mcp"), "authorization_servers": [.string(base)]])
            case "/.well-known/oauth-authorization-server": return json(["authorization_endpoint": .string("\(base)/authorize"), "token_endpoint": .string("\(base)/token"), "registration_endpoint": .string("\(base)/register")])
            case "/register": s.registered += 1; return json(["client_id": .string("client-\(s.registered)")], 201)
            case "/token":
                if body.contains("grant_type=refresh_token") { return s.refreshRefused ? json(["error": "invalid_grant"], 400) : json(["access_token": "fresh", "expires_in": 3600, "refresh_token": "r2"]) }
                return json(["access_token": "a1", "expires_in": 600, "refresh_token": "r1"])
            default: return json(["error": "not_found"], 404)
            }
        }
        let open: (String) async throws -> Void = openExternal ?? { href in
            let q = Dictionary(uniqueKeysWithValues: (URLComponents(string: href)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            var back = URLComponents(string: q["redirect_uri"]!)!
            back.queryItems = s.deny ? [URLQueryItem(name: "error", value: "access_denied"), URLQueryItem(name: "state", value: q["state"])] : [URLQueryItem(name: "code", value: "c"), URLQueryItem(name: "state", value: q["state"])]
            let wrong = URLComponents(string: q["redirect_uri"]! + "?code=x&state=not-ours")!.url!
            let target = back.url!
            Task {
                if let (data, _) = try? await URLSession.shared.data(from: wrong) { s.pages.append(String(decoding: data, as: UTF8.self)) }
                if let (data, _) = try? await URLSession.shared.data(from: target) { s.pages.append(String(decoding: data, as: UTF8.self)) }
            }
        }
        return Connectors(file: { file }, crypt: PlainCrypt(), openExternal: open, fetch: fetch, now: { clock.get() }, urls: ["Granola": "\(base)/mcp"], probe: { _, _ in (404, []) })
    }

    func testCallbackPageRegistrationKeptAndRefreshRefused() async throws {
        let dir = TempDir()
        let file = dir.url.appendingPathComponent("connectors.json")
        let s = Server()
        let clock = Box(Time.ms())
        let c = connectors(s, file: file, clock: clock)
        let first = try await c.signIn("Granola")
        XCTAssertTrue(first.connected)
        let pages = await eventually(5) { s.pages.count == 2 }
        XCTAssertTrue(pages)
        XCTAssertTrue(s.pages.contains("<!doctype html><meta charset=\"utf-8\"><title>Engelbart</title><h1>Granola is connected</h1><p>You can close this tab and go back to Engelbart.</p>"), "\(s.pages)")
        XCTAssertTrue(s.pages.contains { $0.contains("This sign-in is not the one Engelbart started") }, "a callback with another state is turned away")
        // The refresh refused: the sign-in lapses ("reconnect", revoked), its registration kept.
        s.refreshRefused = true
        clock.set(clock.get() + 590_000)
        let token = await c.accessToken("Granola")
        XCTAssertNil(token)
        let lapsed = try c.status("Granola")
        XCTAssertEqual(lapsed.state, "reconnect"); XCTAssertEqual(lapsed.reason, "revoked"); XCTAssertEqual(lapsed.action, "Connect Granola")
        XCTAssertNotNil(c.load("Granola")?["client"], "the registration is kept")
        // Signed in again on the same return address: no second registration.
        s.pages = []
        let again = try await c.signIn("Granola")
        XCTAssertTrue(again.connected)
        XCTAssertEqual(s.registered, 1, "registered once for the same redirect")
    }

    func testRefusedOnTheConsentPageAndCancel() async throws {
        let dir = TempDir()
        let s = Server(); s.deny = true
        let c = connectors(s, file: dir.url.appendingPathComponent("connectors.json"), clock: Box(Time.ms()))
        do { _ = try await c.signIn("Granola"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "Granola sign-in was cancelled") }
        XCTAssertFalse(try c.status("Granola").connected)
        // Cancel while the browser page is open.
        let waiting = connectors(Server(), file: dir.url.appendingPathComponent("c2.json"), clock: Box(Time.ms()), openExternal: { _ in })
        let pending = Task { try await waiting.signIn("Granola") }
        let isPending = await eventually(5) { (try? waiting.status("Granola").pending) == true }
        XCTAssertTrue(isPending)
        waiting.cancel("Granola")
        do { _ = try await pending.value; XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "Granola sign-in was cancelled") }
        XCTAssertFalse(try waiting.status("Granola").pending)
        let missing = await waiting.accessToken("ChatGPT")
        XCTAssertNil(missing)
        let none = await waiting.serversFor(["Granola"])
        XCTAssertEqual(none, [])
    }
}
