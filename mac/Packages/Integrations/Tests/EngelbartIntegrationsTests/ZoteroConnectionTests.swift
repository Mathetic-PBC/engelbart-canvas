import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/zotero.test.cjs: the Zotero connection and its browser sign-in against a fake broker and a fake api.zotero.org,
// both on loopback; "the browser" is this test following the redirects.

private let KEY = "P9NiFoyLeZu2bZNvvuQPDWsd"
private let USER_ID = "475425"

final class ServerRecord: @unchecked Sendable {
    private let lock = NSLock()
    private var _starts: [[String: String]] = []
    private var _tokens: [JSONValue] = []
    private var _calls: [[String: String]] = []
    var tickets: [String: (key: String, userID: String, challenge: String)] = [:]
    func start(_ q: [String: String]) { lock.lock(); _starts.append(q); lock.unlock() }
    func token(_ b: JSONValue) { lock.lock(); _tokens.append(b); lock.unlock() }
    func call(_ c: [String: String]) { lock.lock(); _calls.append(c); lock.unlock() }
    var starts: [[String: String]] { lock.lock(); defer { lock.unlock() }; return _starts }
    var tokens: [JSONValue] { lock.lock(); defer { lock.unlock() }; return _tokens }
    var calls: [[String: String]] { lock.lock(); defer { lock.unlock() }; return _calls }
}

private func queryDict(_ req: LoopbackRequest) -> [String: String] {
    var out: [String: String] = [:]
    for item in URLComponents(url: req.url, resolvingAgainstBaseURL: false)?.queryItems ?? [] { out[item.name] = item.value ?? "" }
    return out
}

/// The broker: start sends the browser to Zotero; Zotero's callback comes back as a ticket (or an error) on loopback.
private func fakeBroker(callbackError: String? = nil, tokenStatus: (Int, String)? = nil) async throws -> (LoopbackServer, ServerRecord) {
    let seen = ServerRecord()
    let server = try await LoopbackServer.start { req in
        if req.method == "GET" && req.path == "/api/zotero/start" {
            seen.start(queryDict(req))
            return LoopbackResponse(status: 302, headers: ["location": "https://www.zotero.org/oauth/authorize?oauth_token=request-1"])
        }
        if req.method == "GET" && req.path == "/api/zotero/callback" {
            let start = seen.starts.last!
            var local = URLComponents(string: "http://127.0.0.1:\(start["port"]!)/oauth/zotero/callback")!
            if callbackError != nil || req.query("oauth_verifier") == nil {
                local.queryItems = [URLQueryItem(name: "state", value: start["state"]), URLQueryItem(name: "error", value: callbackError ?? "access_denied")]
            } else {
                let ticket = PKCE.random(24)
                seen.tickets[ticket] = (KEY, USER_ID, start["challenge"]!)
                local.queryItems = [URLQueryItem(name: "state", value: start["state"]), URLQueryItem(name: "ticket", value: ticket)]
            }
            return LoopbackResponse(status: 302, headers: ["location": local.url!.absoluteString])
        }
        if req.method == "POST" && req.path == "/api/zotero/token" {
            let body = (try? JSONValue.parse(req.body)) ?? .null
            seen.token(body)
            if let tokenStatus { return .json(tokenStatus.0, "{\"error\":\"\(tokenStatus.1)\"}") }
            let ticket = body["ticket"]?.string ?? ""
            guard let data = seen.tickets.removeValue(forKey: ticket) else { return .json(400, "{\"error\":\"invalid_ticket\"}") }
            if PKCE.challenge(body["verifier"]?.string ?? "") != data.challenge { return .json(400, "{\"error\":\"invalid_verifier\"}") }
            return .json(200, "{\"key\":\"\(data.key)\",\"userID\":\"\(data.userID)\"}")
        }
        return .json(404, "{\"error\":\"not_found\"}")
    }
    return (server, seen)
}

/// api.zotero.org's /keys/current: who a key belongs to (GET) and revoking it (DELETE).
private func fakeApi(check: String = "ok", revoke: Int = 204) async throws -> (LoopbackServer, ServerRecord) {
    let seen = ServerRecord()
    let server = try await LoopbackServer.start { req in
        let key = req.headers["zotero-api-key"] ?? ""
        seen.call(["method": req.method, "path": req.target, "key": key, "version": req.headers["zotero-api-version"] ?? ""])
        if req.target != "/keys/current" { return .json(404, "{}") }
        if req.method == "DELETE" { return LoopbackResponse(status: revoke) }
        if check == "forbidden" || key != KEY { return .text(403, "Invalid key") }
        return .json(200, "{\"key\":\"\(key)\",\"userID\":\(check == "mismatch" ? "1" : USER_ID),\"username\":\"researcher\",\"displayName\":\"A Researcher\"}")
    }
    return (server, seen)
}

@MainActor
private final class Setup {
    let broker: LoopbackServer, brokerSeen: ServerRecord
    let api: LoopbackServer, apiSeen: ServerRecord
    let dir = tempDir("engelbart-zotero")
    var opened: [String] = []
    var changes: [ZoteroStatus] = []
    var connected = 0
    var zotero: ZoteroConnection!
    var file: String { join(dir, "zotero.json") }
    var brokerBase: String { "http://127.0.0.1:\(broker.port)" }

    init(broker: (LoopbackServer, ServerRecord), api: (LoopbackServer, ServerRecord), timeoutMs: Double? = nil, openAuthorize: ((String) async throws -> Void)? = nil, crypt: SecretCrypt = ReversingCrypt()) throws {
        (self.broker, brokerSeen) = broker
        (self.api, apiSeen) = api
        let auth = try ZoteroBrowserAuth(broker: "http://127.0.0.1:\(broker.0.port)", http: URLSessionHTTPClient(), timeoutMs: timeoutMs ?? 600_000)
        zotero = ZoteroConnection(http: URLSessionHTTPClient(), file: { [dir] in join(dir, "zotero.json") }, crypt: crypt, browserAuth: { auth },
                                  openAuthorize: openAuthorize ?? { [weak self] url in self?.opened.append(url) },
                                  onConnected: { [weak self] in self?.connected += 1 }, onChange: { [weak self] in self?.changes.append($0) },
                                  api: "http://127.0.0.1:\(api.0.port)")
    }

    func close() { zotero.cancel(); broker.closeAll(); api.closeAll() }
}

private func port(_ url: String) -> String { URLComponents(string: url)!.queryItems!.first { $0.name == "port" }!.value! }
private func state(_ url: String) -> String { URLComponents(string: url)!.queryItems!.first { $0.name == "state" }!.value! }

/// The person's browser: the broker's start, Zotero's authorize page, the broker's callback, loopback.
private func browse(_ brokerBase: String, _ startUrl: String, approve: Bool = true) async throws -> (status: Int, html: String) {
    let http = URLSessionHTTPClient()
    let start = try await http.send(HTTPRequest(url: URL(string: startUrl)!, redirect: .manual))
    XCTAssertEqual(start.status, 302)
    XCTAssertTrue(start.header("location")!.hasPrefix("https://www.zotero.org/oauth/authorize"))
    let back = try await http.send(HTTPRequest(url: URL(string: "\(brokerBase)/api/zotero/callback?oauth_token=request-1\(approve ? "&oauth_verifier=approved" : "")")!, redirect: .manual))
    XCTAssertEqual(back.status, 302)
    let local = back.header("location")!
    XCTAssertTrue(re("^http://127\\.0\\.0\\.1:\\d+/oauth/zotero/callback\\?state=").test(local))
    let page = try await http.send(HTTPRequest(url: URL(string: local)!))
    return (page.status, page.text)
}

@MainActor
final class ZoteroConnectionTests: XCTestCase {
    func testSignInBrokerPKCEKeyCheckedKeptEncrypted() async throws {
        let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi())
        defer { f.close() }
        XCTAssertEqual(f.zotero.status(), ZoteroStatus(configured: true))
        let waiting = try await f.zotero.connect()
        XCTAssertFalse(waiting.connected)
        XCTAssertEqual(waiting.pending?.kind, "browser")
        XCTAssertGreaterThan(waiting.pending!.expiresAt, systemNow() + 9 * 60_000)
        XCTAssertEqual(f.opened.count, 1)
        let start = URLComponents(string: f.opened[0])!
        XCTAssertEqual("http://\(start.host!):\(start.port!)\(start.path)", "\(f.brokerBase)/api/zotero/start")
        XCTAssertTrue(re("^[A-Za-z0-9_-]{43}$").test(state(f.opened[0])))
        XCTAssertGreaterThanOrEqual(Int(port(f.opened[0]))!, 1024)
        let page = try await browse(f.brokerBase, f.opened[0])
        XCTAssertEqual(page.status, 200)
        XCTAssertTrue(page.html.contains("Zotero connected"))
        XCTAssertFalse(page.html.contains(KEY))
        await until { f.zotero.status().connected }
        XCTAssertEqual(f.brokerSeen.tokens.count, 1)
        let challenge = start.queryItems!.first { $0.name == "challenge" }!.value!
        XCTAssertEqual(PKCE.challenge(f.brokerSeen.tokens[0]["verifier"]!.string!), challenge)
        XCTAssertEqual(f.apiSeen.calls, [["method": "GET", "path": "/keys/current", "key": KEY, "version": "3"]])
        XCTAssertEqual(f.zotero.status(), ZoteroStatus(configured: true, connected: true, username: "researcher", userID: USER_ID))
        XCTAssertEqual(f.connected, 1)
        XCTAssertEqual(f.zotero.key(), KEY)
        let saved = readJSONFile(f.file)
        XCTAssertEqual(saved.object!.keys.sorted(), ["key", "userID", "username", "v"])
        XCTAssertEqual(saved["userID"], .string(USER_ID))
        XCTAssertFalse(FileOps.read(f.file)!.contains(KEY))
        let mode = (try FileManager.default.attributesOfItem(atPath: f.file)[.posixPermissions] as! NSNumber).intValue
        XCTAssertEqual(mode & 0o777, 0o600)
        for change in f.changes { XCTAssertFalse(change.json.text().contains(KEY)) }
        let again = ZoteroConnection(file: { f.file }, crypt: ReversingCrypt())
        XCTAssertTrue(again.status().connected)
        XCTAssertEqual(again.key(), KEY)
        XCTAssertEqual(f.apiSeen.calls.count, 1)
        await assertThrows({ try await URLSessionHTTPClient().send(HTTPRequest(url: URL(string: "http://127.0.0.1:\(port(f.opened[0]))/")!, timeout: 2)) }, ".")
    }

    func testWrongStateRefusedOriginRefusedThenSignsIn() async throws {
        let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi())
        defer { f.close() }
        try await f.zotero.connect()
        let local = "http://127.0.0.1:\(port(f.opened[0]))/oauth/zotero/callback"
        let http = URLSessionHTTPClient()
        var r = try await http.send(HTTPRequest(url: URL(string: "\(local)?state=\(String(repeating: "x", count: 43))&ticket=forged")!))
        XCTAssertEqual(r.status, 400)
        r = try await http.send(HTTPRequest(url: URL(string: "\(local)?state=\(state(f.opened[0]))&ticket=forged")!, headers: ["origin": "https://evil.example"]))
        XCTAssertEqual(r.status, 403)
        r = try await http.send(HTTPRequest(url: URL(string: "\(local)?state=\(state(f.opened[0]))")!))
        XCTAssertEqual(r.status, 400, "no ticket, no exchange")
        XCTAssertEqual(f.brokerSeen.tokens.count, 0)
        XCTAssertEqual(f.zotero.status().pending?.kind, "browser")
        _ = try await browse(f.brokerBase, f.opened[0])
        await until { f.zotero.status().connected }
    }

    func testBrokerCallbackErrorsEndTheSignIn() async throws {
        for (code, words) in [("access_denied", "Cancelled on Zotero"), ("authorization_failed", "did not authorize"), ("upstream_unavailable", "could not be reached")] {
            let f = try Setup(broker: try await fakeBroker(callbackError: code), api: try await fakeApi())
            try await f.zotero.connect()
            let page = try await browse(f.brokerBase, f.opened[0], approve: code != "access_denied")
            XCTAssertEqual(page.status, 200)
            await until { f.zotero.status().pending == nil }
            XCTAssertFalse(f.zotero.status().connected)
            XCTAssertTrue(f.zotero.status().error.contains(words), f.zotero.status().error)
            XCTAssertEqual(f.brokerSeen.tokens.count, 0)
            XCTAssertEqual(f.apiSeen.calls.count, 0)
            XCTAssertFalse(FileOps.exists(f.file))
            f.close()
        }
    }

    func testRedeemingTheTicketFailures() async throws {
        for (status, code, words) in [(400, "invalid_ticket", "expired"), (400, "invalid_verifier", "could not be verified"), (503, "not_configured", "service is unavailable")] {
            let f = try Setup(broker: try await fakeBroker(tokenStatus: (status, code)), api: try await fakeApi())
            try await f.zotero.connect()
            let page = try await browse(f.brokerBase, f.opened[0])
            XCTAssertEqual(page.status, 502)
            await until { f.zotero.status().pending == nil }
            XCTAssertTrue(f.zotero.status().error.contains(words), f.zotero.status().error)
            XCTAssertFalse(f.zotero.status().connected)
            XCTAssertEqual(f.apiSeen.calls.count, 0)
            f.close()
        }
    }

    func testKeyZoteroWillNotVouchForIsRevoked() async throws {
        for check in ["forbidden", "mismatch"] {
            let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi(check: check))
            try await f.zotero.connect()
            _ = try await browse(f.brokerBase, f.opened[0])
            await until { f.zotero.status().pending == nil }
            XCTAssertFalse(f.zotero.status().connected)
            XCTAssertTrue(f.zotero.status().error.contains("did not accept"))
            XCTAssertFalse(FileOps.exists(f.file))
            XCTAssertEqual(f.apiSeen.calls.map { $0["method"]! }, ["GET", "DELETE"])
            f.close()
        }
    }

    func testTimeoutCancelReconnectAndBrowserFailure() async throws {
        let timed = try Setup(broker: try await fakeBroker(), api: try await fakeApi(), timeoutMs: 40)
        try await timed.zotero.connect()
        await until { timed.zotero.status().pending == nil }
        XCTAssertTrue(timed.zotero.status().error.contains("expired"))
        timed.close()

        let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi())
        defer { f.close() }
        try await f.zotero.connect()
        let cancelled = f.zotero.cancel()
        XCTAssertNil(cancelled.pending)
        XCTAssertEqual(cancelled.error, "")
        XCTAssertNil(f.changes.last?.pending)
        await assertThrows({ try await URLSessionHTTPClient().send(HTTPRequest(url: URL(string: "http://127.0.0.1:\(port(f.opened[0]))/oauth/zotero/callback?state=\(state(f.opened[0]))&ticket=late")!, timeout: 2)) }, ".")
        XCTAssertEqual(f.brokerSeen.tokens.count, 0)

        try await f.zotero.connect()
        try await f.zotero.connect()
        XCTAssertEqual(f.opened.count, 3)
        XCTAssertEqual(f.opened[1], f.opened[2], "the same page again, not a second sign-in")
        _ = try await browse(f.brokerBase, f.opened[2])
        await until { f.zotero.status().connected }
        let again = try await f.zotero.connect()
        XCTAssertTrue(again.connected)
        XCTAssertNil(again.pending)
        XCTAssertEqual(f.opened.count, 3, "signed in: nothing opens (2026-10-14)")

        let failing = try Setup(broker: try await fakeBroker(), api: try await fakeApi(), openAuthorize: { _ in throw ZoteroError("no browser") })
        await assertThrows({ try await failing.zotero.connect() }, "no browser")
        XCTAssertNil(failing.zotero.status().pending)
        XCTAssertTrue(failing.zotero.status().error.contains("Could not open your browser"))
        failing.close()
    }

    func testDisconnectDeletesFileAndRevokes() async throws {
        for revoke in [204, 500] {
            let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi(revoke: revoke))
            try await f.zotero.connect()
            _ = try await browse(f.brokerBase, f.opened[0])
            await until { f.zotero.status().connected }
            let status = await f.zotero.disconnect()
            XCTAssertFalse(status.connected)
            XCTAssertEqual(status.username, "")
            XCTAssertEqual(status.error, "")
            XCTAssertFalse(FileOps.exists(f.file))
            XCTAssertNil(f.zotero.key())
            XCTAssertEqual(f.changes.last?.connected, false)
            XCTAssertEqual(Array(f.apiSeen.calls.dropFirst()), [["method": "DELETE", "path": "/keys/current", "key": KEY, "version": "3"]])
            f.close()
        }
    }

    func testOldBrowserFileLeftAloneOtherKeychainSignedOutNoKeychainMemoryOnly() async throws {
        let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi())
        defer { f.close() }
        let old = join(f.dir, "zotero-browser.json")
        try "{\"cookie\":\"old\"}".write(toFile: old, atomically: true, encoding: .utf8)
        let notOurs: JSONValue = ["v": 1, "userID": .string(USER_ID), "username": "researcher", "key": "not ours"]
        try notOurs.text().write(toFile: f.file, atomically: true, encoding: .utf8)
        XCTAssertFalse(ZoteroConnection(file: { f.file }, crypt: ThrowingCrypt()).status().connected)
        await f.zotero.disconnect()
        XCTAssertEqual(FileOps.read(old), "{\"cookie\":\"old\"}")

        let memory = try Setup(broker: try await fakeBroker(), api: try await fakeApi(), crypt: NoKeychain())
        defer { memory.close() }
        try await memory.zotero.connect()
        _ = try await browse(memory.brokerBase, memory.opened[0])
        await until { memory.zotero.status().connected }
        XCTAssertFalse(memory.zotero.status().persisted)
        XCTAssertFalse(FileOps.exists(memory.file))
    }

    func testChannelsAnswerTheStatusNeverTheKey() async throws {
        let f = try Setup(broker: try await fakeBroker(), api: try await fakeApi())
        defer { f.close() }
        let channels = ZoteroChannels(zotero: f.zotero, library: nil)
        var answers: [ZoteroStatus] = []
        answers.append(channels.status())
        answers.append(try await channels.connect())
        answers.append(try channels.cancel())
        answers.append(try await channels.connect())
        _ = try await browse(f.brokerBase, f.opened.last!)
        await until { f.zotero.status().connected }
        answers.append(channels.status())
        XCTAssertEqual(answers.last?.username, "researcher")
        answers.append(try await channels.disconnect())
        XCTAssertEqual(answers.last?.connected, false)
        for a in answers { XCTAssertFalse(a.json.text().contains(KEY)) }
        let bare = ZoteroChannels(zotero: nil, library: nil)
        XCTAssertEqual(bare.status().json, ["configured": false, "connected": false, "username": "", "userID": "", "persisted": true, "pending": nil, "error": "", "sync": nil])
        await assertThrows({ try await bare.connect() }, "not available")
    }

    func testDefaultSignInWaitsTenMinutesAndRequiresHttps() async throws {
        let flow = try await ZoteroBrowserAuth().start()
        XCTAssertLessThan(abs(flow.expiresAt - systemNow() - 600_000), 2000)
        let url = URLComponents(string: flow.url)!
        XCTAssertEqual("\(url.scheme!)://\(url.host!)", "https://engelbart.mathetic.com")
        XCTAssertEqual(url.path, "/api/zotero/start")
        flow.cancel()
        await assertThrows({ try await flow.result() }, "cancelled")
        XCTAssertThrowsError(try ZoteroBrowserAuth(broker: "http://broker.example"))
    }
}
