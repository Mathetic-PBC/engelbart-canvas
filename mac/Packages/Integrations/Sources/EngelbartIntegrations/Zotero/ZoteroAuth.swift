import Foundation
import EngelbartCore

// src/main/zotero/browser-auth.cjs and connection.cjs (MATH-65): Zotero's OAuth 1.0a, which only the broker can sign,
// run as GitHub's browser sign-in is: a loopback port, a state and a PKCE challenge go to /api/zotero/start; the browser
// comes back to the loopback with a sealed ticket that only this process's verifier redeems for the Web API key. The key
// is kept in <dataRoot>/zotero.json sealed with the Keychain's key, beside github.json. Zotero keys do not expire, so
// there is no refresh; disconnecting deletes the file and revokes the key. The key never leaves this module except as a
// header to api.zotero.org: the status names the account, never the key. zotero-browser.json (an older web session) is
// never read or touched. Nothing here logs.

public struct ZoteroError: Error, LocalizedError, Equatable {
    public let message: String
    public let code: String
    public init(_ message: String, code: String = "zotero") { self.message = message; self.code = code }
    public var errorDescription: String? { message }
}

public struct ZoteroCredentials: Sendable, Equatable {
    public var key: String
    public var userID: String
}

public protocol ZoteroBrowserAuthorizing: Sendable {
    func start() async throws -> BrowserFlow<ZoteroCredentials>
}

public final class ZoteroBrowserAuth: ZoteroBrowserAuthorizing, @unchecked Sendable {
    public static let broker = "https://engelbart.mathetic.com"

    /// What the broker's callback and token errors mean to the person.
    public static let failures: [String: String] = [
        "access_denied": "Cancelled on Zotero.",
        "authorization_failed": "Zotero did not authorize the sign-in. Try again.",
        "upstream_unavailable": "Zotero could not be reached. Try again.",
        "invalid_ticket": "The Zotero sign-in expired. Try again.",
        "invalid_verifier": "The Zotero sign-in could not be verified. Try again.",
    ]

    static func failure(_ code: String?) -> ZoteroError {
        if let code, let words = failures[code] { return ZoteroError(words, code: code) }
        return ZoteroError("Zotero sign-in did not complete. Try again.", code: "failed")
    }

    let target: URL
    let http: HTTPClient
    let timeoutMs: Double
    let now: NowMs

    public init(broker: String = ZoteroBrowserAuth.broker, http: HTTPClient = URLSessionHTTPClient.shared, timeoutMs: Double = 600_000, now: @escaping NowMs = systemNow) throws {
        guard let url = URL(string: broker), let scheme = url.scheme, scheme == "https" || (scheme == "http" && url.host == "127.0.0.1") else {
            throw ZoteroError("Zotero sign-in requires HTTPS")
        }
        self.target = url; self.http = http; self.timeoutMs = timeoutMs; self.now = now
    }

    func exchange(ticket: String, verifier: String) async throws -> ZoteroCredentials {
        let url = URL(string: "/api/zotero/token", relativeTo: target)!.absoluteURL
        let body: JSONValue = ["ticket": .string(ticket), "verifier": .string(verifier)]
        let response = try await http.send(HTTPRequest(url: url, method: "POST", headers: ["content-type": "application/json"], body: Data(body.text().utf8), redirect: .error, timeout: 20))
        let data = response.json
        if !response.ok && response.status >= 500 { throw ZoteroError("Zotero sign-in service is unavailable. Try again.") }
        if !response.ok { throw Self.failure(data?["error"]?.string) }
        guard let key = data?["key"]?.string, re("^[A-Za-z0-9]{1,128}$").test(key) else { throw Self.failure("authorization_failed") }
        let userID = data?["userID"]?.stringish ?? ""
        guard re("^[0-9]{1,20}$").test(userID) else { throw Self.failure("authorization_failed") }
        return ZoteroCredentials(key: key, userID: userID)
    }

    public func start() async throws -> BrowserFlow<ZoteroCredentials> {
        let state = PKCE.random(32), verifier = PKCE.random(48)
        let challenge = PKCE.challenge(verifier)
        let consuming = Box(false)
        let flowBox = Box<BrowserFlow<ZoteroCredentials>?>(nil)
        let portBox = Box<UInt16>(0)
        let server = try await LoopbackServer.start { [self] req in
            if req.headers["origin"] != nil || req.headers["host"] != "127.0.0.1:\(portBox.value)" { return signInPage(403, "Request refused") }
            guard req.method == "GET", req.path == "/oauth/zotero/callback", PKCE.same(req.query("state"), state) else { return signInPage(400, "Invalid sign-in callback") }
            guard let flow = flowBox.value else { return signInPage(400, "Invalid sign-in callback") }
            if flow.finished || consuming.value { return signInPage(409, "Sign-in already handled") }
            if req.hasQuery("error") {
                let code = req.query("error")
                flow.finish(.failure(Self.failure(code)))
                return signInPage(200, code == "access_denied" ? "Sign-in cancelled" : "Sign-in did not complete. Try again in Engelbart.")
            }
            guard let ticket = req.query("ticket"), !ticket.isEmpty, ticket.count <= 4096 else { return signInPage(400, "Invalid sign-in callback") }
            consuming.value = true
            do {
                let credentials = try await self.exchange(ticket: ticket, verifier: verifier)
                if flow.finished { return signInPage(410, "Sign-in expired or cancelled") }
                flow.finish(.success(credentials))
                return signInPage(200, "Zotero connected")
            } catch {
                flow.finish(.failure(error))
                return signInPage(502, "Sign-in did not complete. Try again in Engelbart.")
            }
        }
        portBox.value = server.port
        var start = URLComponents(url: URL(string: "/api/zotero/start", relativeTo: target)!.absoluteURL, resolvingAgainstBaseURL: false)!
        start.percentEncodedQuery = queryString([("port", String(server.port)), ("state", state), ("challenge", challenge)])
        let flow = BrowserFlow<ZoteroCredentials>(url: start.url!.absoluteString, expiresAt: now() + timeoutMs)
        flow.cancelError = { ZoteroError("Zotero sign-in cancelled.", code: "cancelled") }
        let timer = DispatchWorkItem { [weak flow] in flow?.finish(.failure(ZoteroError("The Zotero sign-in expired. Try again.", code: "expired"))) }
        flow.onFinish = { timer.cancel(); server.close() }
        flowBox.value = flow
        DispatchQueue.global().asyncAfter(deadline: .now() + timeoutMs / 1000, execute: timer)
        return flow
    }
}

public struct ZoteroPending: Equatable, Sendable {
    public var kind: String
    public var expiresAt: Double
}

/// The sign-in's status (connection.cjs status()), with the mirror's (`sync`) as the IPC answers it.
public struct ZoteroStatus: Equatable, Sendable {
    public var configured: Bool
    public var connected: Bool
    public var username: String
    public var userID: String
    public var persisted: Bool
    public var pending: ZoteroPending?
    public var error: String
    public var sync: ZoteroSyncStatus?

    public init(configured: Bool = false, connected: Bool = false, username: String = "", userID: String = "", persisted: Bool = true,
                pending: ZoteroPending? = nil, error: String = "", sync: ZoteroSyncStatus? = nil) {
        self.configured = configured; self.connected = connected; self.username = username; self.userID = userID
        self.persisted = persisted; self.pending = pending; self.error = error; self.sync = sync
    }

    public static let unavailable = ZoteroStatus()

    public var json: JSONValue {
        ["configured": .bool(configured), "connected": .bool(connected), "username": .string(username), "userID": .string(userID),
         "persisted": .bool(persisted), "pending": pending.map { ["kind": .string($0.kind), "expiresAt": .number($0.expiresAt)] } ?? .null,
         "error": .string(error), "sync": sync?.json ?? .null]
    }
}

@MainActor
public final class ZoteroConnection {
    nonisolated public static let api = "https://api.zotero.org"
    static let timeout: TimeInterval = 15

    let http: HTTPClient
    let file: () -> String?
    let crypt: SecretCrypt
    let browserAuth: () -> ZoteroBrowserAuthorizing?
    let openAuthorize: (String) async throws -> Void
    let onConnected: () -> Void
    let onChange: (ZoteroStatus) -> Void
    let apiBase: String

    private final class Account { let userID: String; let username: String; let key: String
        init(userID: String, username: String, key: String) { self.userID = userID; self.username = username; self.key = key } }
    private final class Pending { let url: String; let expiresAt: Double; let cancel: () -> Void
        init(url: String, expiresAt: Double, cancel: @escaping () -> Void) { self.url = url; self.expiresAt = expiresAt; self.cancel = cancel } }

    private var saved: Account?
    private var loaded = false
    private var savedFor: String?
    private var pending: Pending?
    private var problem = ""
    private var persisted = true
    private var starting: Task<ZoteroStatus, Error>?
    private var generation = 0
    let now: NowMs

    public init(http: HTTPClient = URLSessionHTTPClient.shared, file: @escaping () -> String?, crypt: SecretCrypt = NoKeychain(),
                browserAuth: @escaping () -> ZoteroBrowserAuthorizing? = { nil }, openAuthorize: @escaping (String) async throws -> Void = { _ in },
                onConnected: @escaping () -> Void = {}, onChange: @escaping (ZoteroStatus) -> Void = { _ in },
                api: String = ZoteroConnection.api, now: @escaping NowMs = systemNow) {
        self.http = http; self.file = file; self.crypt = crypt; self.browserAuth = browserAuth; self.openAuthorize = openAuthorize
        self.onConnected = onConnected; self.onChange = onChange; self.apiBase = api; self.now = now
    }

    private func changed() { onChange(status()) }

    private func call(_ method: String, key: String) async throws -> (status: Int, ok: Bool, data: JSONValue?) {
        let response = try await http.send(HTTPRequest(url: URL(string: "\(apiBase)/keys/current")!, method: method,
                                                       headers: ["zotero-api-key": key, "zotero-api-version": "3", "accept": "application/json"],
                                                       redirect: .error, timeout: Self.timeout))
        return (response.status, response.ok, method == "GET" ? response.json : nil)
    }

    // MARK: storage

    private func load() -> Account? {
        let at = file()
        if loaded && savedFor == at { return saved }
        loaded = true
        savedFor = at
        saved = nil
        guard let at, let raw = FileOps.readJSON(at), raw["v"]?.double == 1, let key = raw["key"]?.string, crypt.available() else { return nil }
        if let plain = try? crypt.decrypt(key) {
            saved = Account(userID: raw["userID"]?.stringish ?? "", username: raw["username"]?.stringish ?? "", key: plain)
        }
        return saved
    }

    private func keep(_ next: Account) {
        saved = next
        loaded = true
        let at = file()
        savedFor = at
        persisted = at != nil && crypt.available()
        guard persisted, let at else { return }
        do {
            let out: JSONValue = ["v": 1, "userID": .string(next.userID), "username": .string(next.username), "key": .string(try crypt.encrypt(next.key))]
            FileOps.mkdir((at as NSString).deletingLastPathComponent)
            try FileOps.write(JSONText.stringify(out, indent: 2) + "\n", to: at, mode: 0o600)
        } catch { persisted = false }
    }

    private func forget(_ reason: String = "") {
        saved = nil
        loaded = true
        let at = file()
        savedFor = at
        if let at { FileOps.remove(at) }
        problem = reason
    }

    // MARK: status

    public func status() -> ZoteroStatus {
        let account = load()
        return ZoteroStatus(configured: browserAuth() != nil, connected: account != nil, username: account?.username ?? "", userID: account?.userID ?? "",
                            persisted: account != nil ? persisted : true, pending: pending.map { ZoteroPending(kind: "browser", expiresAt: $0.expiresAt) }, error: problem)
    }

    // MARK: sign-in

    /// Starts signing in, or opens the browser again for one waiting. Signed in already, nothing opens (2026-10-14).
    @discardableResult
    public func connect() async throws -> ZoteroStatus {
        if load() != nil { return status() }
        if starting == nil {
            starting = Task { @MainActor in
                defer { self.starting = nil }
                return try await self.begin()
            }
        }
        return try await starting!.value
    }

    private func begin() async throws -> ZoteroStatus {
        guard let browser = browserAuth() else { throw ZoteroError("Zotero sign-in is not available.", code: "unconfigured") }
        if let pending, now() < pending.expiresAt { try await openAuthorize(pending.url); return status() }
        pending?.cancel()
        generation += 1
        let attempt = generation
        problem = ""
        let auth = try await browser.start()
        if attempt != generation { auth.cancel(); return status() }
        let flow = Pending(url: auth.url, expiresAt: auth.expiresAt, cancel: { auth.cancel() })
        pending = flow
        changed()
        Task { @MainActor in
            do {
                let credentials = try await auth.result()
                guard self.pending === flow else { return }
                try await self.accept(credentials, active: { [weak self] in self?.pending === flow })
                guard self.pending === flow else { return }
                self.pending = nil; self.problem = ""; self.changed(); self.onConnected()
            } catch {
                guard self.pending === flow else { return }
                self.pending = nil; self.problem = error.localizedDescription; self.changed()
            }
        }
        do { try await openAuthorize(flow.url) } catch {
            cancel()
            problem = "Could not open your browser. Try signing in again."
            changed()
            throw error
        }
        return status()
    }

    /// A key from the broker: Zotero is asked whose it is, then it is kept. One Zotero will not vouch for is revoked.
    private func accept(_ credentials: ZoteroCredentials, active: () -> Bool) async throws {
        let who: (status: Int, ok: Bool, data: JSONValue?)
        do { who = try await call("GET", key: credentials.key) } catch {
            await revoke(credentials.key)
            throw ZoteroError("Could not reach Zotero to check the sign-in. Try again.", code: "network")
        }
        guard who.ok, (who.data?["userID"]?.stringish ?? "") == credentials.userID else {
            await revoke(credentials.key)
            throw ZoteroError("Zotero did not accept the sign-in. Try again.", code: "key")
        }
        if !active() { await revoke(credentials.key); return }
        keep(Account(userID: credentials.userID, username: who.data?["username"]?.string ?? "", key: credentials.key))
    }

    /// Revokes a key on Zotero's side; whether it worked changes nothing here.
    private func revoke(_ key: String) async { _ = try? await call("DELETE", key: key) }

    @discardableResult
    public func cancel() -> ZoteroStatus {
        generation += 1
        guard let flow = pending else { return status() }
        pending = nil
        flow.cancel()
        changed()
        return status()
    }

    /// Forgets the key (the file goes first) and revokes it with Zotero; a revoke that fails still disconnects.
    @discardableResult
    public func disconnect() async -> ZoteroStatus {
        cancel()
        let account = load()
        forget("")
        changed()
        if let account { await revoke(account.key) }
        return status()
    }

    /// The API key, for this process's own requests to api.zotero.org, or nil when signed out.
    public func key() -> String? { load()?.key }
}
