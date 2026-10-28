import Foundation
import Network
import CryptoKit
import Security
import EngelbartCore

// Port of src/main/connect/connectors.cjs (2026-10-07, second build; Linear and Evernote 2026-10-16; K3 recovery): the apps
// reached through their own MCP servers (connect-sources reach 'connector'). Engelbart signs in as an MCP client does (OAuth
// 2.1 with PKCE, the client registered dynamically): discovery from the server's metadata, registration, the sign-in page
// opened in the person's browser, the code back on a loopback port, the tokens, and refreshing them later. Tokens are kept
// per data root, sealed with a key the macOS Keychain holds (Electron's safeStorage), in <dataRoot>/connectors.json.
// The MCP SDK's auth() is reimplemented here with URLSession (the SDK is Node's); what it does is the same steps.
//   - a token near its end is refreshed (one at a time per app); a refusal or no refresh token marks it `reconnect`
//   - check(app) asks the server itself (initialize, then tools/list) at most every five minutes: a 401 refreshes once
//     and asks again, still refused is `reconnect` ('revoked'); a 403, or no reading tools, is `unavailable`
//   - what can't be told (offline, a 5xx, a timeout) changes nothing
// status(app).state: 'connected' | 'signed-out' | 'reconnect' | 'unavailable', with `action` ("Connect Linear") when a
// sign-in is what it needs.

/// safeStorage's role: seal and open a secret (the app's Keychain-held key).
public protocol ConnectorCrypt: Sendable {
    func available() -> Bool
    func encrypt(_ text: String) throws -> String
    func decrypt(_ text: String) throws -> String
}

/// A 256-bit key kept in the login Keychain (generic password, service "Engelbart connectors"), AES-GCM over it.
public struct KeychainCrypt: ConnectorCrypt, @unchecked Sendable {
    public var service: String
    public var account: String
    /// The keychain to use; nil = the login keychain (the app). Tests pass a temporary one.
    public var keychain: SecKeychain?
    public init(service: String = "Engelbart connectors", account: String = "key", keychain: SecKeychain? = nil) { self.service = service; self.account = account; self.keychain = keychain }

    func stored() -> SymmetricKey? {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
        if let keychain { query[kSecMatchSearchList as String] = [keychain] }
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data, data.count == 32 else { return nil }
        return SymmetricKey(data: data)
    }

    func key() throws -> SymmetricKey {
        if let key = stored() { return key }
        let fresh = SymmetricKey(size: .bits256)
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecValueData as String: fresh.withUnsafeBytes { Data($0) }]
        if let keychain { query[kSecUseKeychain as String] = keychain }
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess { return fresh }
        // Kept by someone else meanwhile: theirs is the key (it used to return the unsaved one).
        if status == errSecDuplicateItem, let key = stored() { return key }
        throw ConnectError("failed", "The Keychain refused to keep the connectors' key")
    }
    public func available() -> Bool { (try? key()) != nil }
    public func encrypt(_ text: String) throws -> String {
        let box = try AES.GCM.seal(Data(text.utf8), using: try key())
        guard let combined = box.combined else { throw ConnectError("failed", "sealing failed") }
        return combined.base64EncodedString()
    }
    public func decrypt(_ text: String) throws -> String {
        guard let data = Data(base64Encoded: text) else { throw ConnectError("failed", "unreadable") }
        return String(decoding: try AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: try key()), as: UTF8.self)
    }
}

/// An in-memory crypt (tests): `available` false keeps tokens for the run only, as Electron does without a keychain.
public struct PlainCrypt: ConnectorCrypt {
    public var isAvailable: Bool
    public init(available: Bool = true) { isAvailable = available }
    public func available() -> Bool { isAvailable }
    public func encrypt(_ text: String) throws -> String { "plain:" + Data(text.utf8).base64EncodedString() }
    public func decrypt(_ text: String) throws -> String { guard text.hasPrefix("plain:"), let d = Data(base64Encoded: String(text.dropFirst(6))) else { throw ConnectError("failed", "unreadable") }; return String(decoding: d, as: UTF8.self) }
}

public struct ConnectorStatus: Sendable, Equatable {
    public var app: String
    public var connected: Bool
    public var state: String
    public var reason: String?
    public var action: String?
    public var fallback: String?
    public var refreshable: Bool
    public var expiresAt: Double?
    public var pending: Bool
    public var unchecked: Bool = false
    public var json: JSONValue {
        var o: [String: JSONValue] = ["app": .string(app), "connected": .bool(connected), "state": .string(state), "reason": reason.map { .string($0) } ?? .null,
                                      "fallback": fallback.map { .string($0) } ?? .null, "refreshable": .bool(refreshable), "expiresAt": expiresAt.map { .number($0) } ?? .null, "pending": .bool(pending)]
        if let action { o["action"] = .string(action) }
        if unchecked { o["unchecked"] = true }
        return .object(o)
    }
}

public final class Connectors: @unchecked Sendable {
    public struct Connector: Sendable { public var url: String; public var server: String; public var scope: String?; public var fallback: String?; public var reads: [String]? }
    /// Every reach 'connector' app → its server.
    public static let all: [String: Connector] = {
        var out: [String: Connector] = [:]
        for name in ConnectSources.appOrder { guard let app = ConnectSources.apps[name], app.reach == .connector, let mcp = app.mcp else { continue }
            out[name] = Connector(url: mcp, server: JS.replace(name.lowercased(), "[^a-z0-9]+", "-"), scope: app.scope, fallback: app.fallback, reads: app.reads.map { $0.list + $0.read }) }
        return out
    }()
    public static let order = ConnectSources.appOrder.filter { all[$0] != nil }
    static let signInTimeoutMs = 10 * 60_000.0
    static let refreshEarlyMs = 2 * 60_000.0
    static let checkKeepMs = 5 * 60_000.0
    static let checkTimeoutMs = 15_000.0

    public typealias Fetch = (URLRequest) async throws -> (Data, HTTPURLResponse)
    public typealias Probe = (_ url: String, _ token: String) async -> (status: Int, tools: [String])

    let file: () -> URL
    let crypt: ConnectorCrypt?
    let openExternal: (String) async throws -> Void
    let fetch: Fetch
    let now: () -> Double
    let urls: [String: String]
    let onChange: (ConnectorStatus) -> Void
    let own: OwnConnectors?
    let probe: Probe
    let lock = NSRecursiveLock()
    var pending: [String: (task: Task<ConnectorStatus, Error>, cancel: () -> Void)] = [:]
    var memory: [String: JSONValue] = [:]
    var refreshing: [String: Task<RefreshOutcome, Never>] = [:]
    var checks: [String: (at: Double, task: Task<ConnectorStatus, Error>)] = [:]
    var held: [String: [String: JSONValue]] = [:] // the verifier between the redirect and the code

    public init(file: @escaping () -> URL, crypt: ConnectorCrypt?, openExternal: @escaping (String) async throws -> Void, fetch: Fetch? = nil, now: @escaping () -> Double = { Time.ms() },
                urls: [String: String] = [:], onChange: @escaping (ConnectorStatus) -> Void = { _ in }, own: OwnConnectors? = nil, probe: Probe? = nil) {
        self.file = file; self.crypt = crypt; self.openExternal = openExternal; self.now = now; self.urls = urls; self.onChange = onChange; self.own = own
        let f: Fetch = fetch ?? { req in
            let (d, r) = try await URLSession.shared.data(for: req)
            guard let http = r as? HTTPURLResponse else { throw ConnectError("failed", "No answer") }
            return (d, http)
        }
        self.fetch = f
        self.probe = probe ?? { url, token in await Connectors.probeServer(url: url, token: token, fetch: f) }
    }

    func urlOf(_ app: String) -> String { urls[app] ?? Self.all[app]!.url }

    // MARK: storage

    func readAll() -> [String: JSONValue] { Files.readJSON(file())?.object ?? [:] }
    func load(_ app: String) -> [String: JSONValue]? {
        lock.lock(); defer { lock.unlock() }
        if let m = memory[app] { return m.object }
        guard let sealed = readAll()[app]?.string, let crypt, let text = try? crypt.decrypt(sealed), let v = try? JSONValue.parse(text) else { return nil }
        return v.object
    }
    func save(_ app: String, _ value: [String: JSONValue]?) {
        lock.lock(); defer { lock.unlock() }
        guard let crypt, crypt.available() else { if let value { memory[app] = .object(value) } else { memory[app] = nil }; return }
        var all = readAll()
        if let value, let sealed = try? crypt.encrypt(JSONValue.object(value).text()) { all[app] = .string(sealed) } else { all[app] = nil }
        try? FileManager.default.createDirectory(at: file().deletingLastPathComponent(), withIntermediateDirectories: true)
        // JSON.stringify(all, null, 1): one-space indent.
        let body = all.isEmpty ? "{}" : "{\n" + all.sorted { $0.key < $1.key }.map { " \(JSONValue.string($0.key).text()): \($0.value.text())" }.joined(separator: ",\n") + "\n}"
        try? Files.writeAtomically(body + "\n", to: file(), mode: 0o600)
    }

    // MARK: status

    public func status(_ app: String) throws -> ConnectorStatus {
        guard let connector = Self.all[app] else { throw ConnectError("failed", "\(app) has no connector") }
        let held = load(app) ?? [:]
        let tokens = held["tokens"]
        let has = JS.truthy(tokens?["access_token"])
        let lifetime = tokens?["expires_in"]?.double ?? 0
        let expiresAt: Double? = has && lifetime > 0 ? (held["obtainedAt"]?.double ?? 0) + lifetime * 1000 : nil
        let ended = expiresAt.map { $0 <= now() } == true && !JS.truthy(tokens?["refresh_token"])
        let state = has && !ended ? (JS.truthy(held["unavailable"]) ? "unavailable" : "connected") : (JS.truthy(held["lapsed"]) || ended ? "reconnect" : "signed-out")
        let reason: String? = state == "unavailable" ? (held["unavailable"]?["reason"]?.string ?? "refused") : state == "reconnect" ? (ended ? "expired" : (held["lapsed"]?["reason"]?.string ?? "revoked")) : nil
        lock.lock(); let isPending = pending[app] != nil; lock.unlock()
        return ConnectorStatus(app: app, connected: state == "connected", state: state, reason: reason,
                               action: state == "reconnect" || state == "signed-out" ? "Connect \(ConnectSources.shownName(app))" : nil,
                               fallback: connector.fallback, refreshable: JS.truthy(tokens?["refresh_token"]), expiresAt: expiresAt, pending: isPending)
    }

    public func list() -> [ConnectorStatus] { Self.order.compactMap { try? status($0) } }

    func mark(_ app: String, _ change: [String: JSONValue?]) {
        let before = (try? status(app))?.state
        var next = load(app) ?? [:]
        for (k, v) in change { next[k] = v }
        save(app, next)
        if let after = try? status(app), after.state != before { onChange(after) }
    }

    func lapse(_ app: String, _ reason: String) {
        lock.lock(); checks[app] = nil; lock.unlock()
        mark(app, ["tokens": nil, "obtainedAt": nil, "unavailable": nil, "lapsed": ["at": .number(now()), "reason": .string(reason)]])
    }

    // MARK: OAuth (the MCP SDK's auth(), refreshAuthorization, discovery)

    enum RefreshOutcome { case ok(String), lapsed(String), unknown }

    struct Discovery { var authorizationServerUrl: String; var resourceMetadata: JSONValue?; var authorizationServerMetadata: JSONValue? }

    func getJSON(_ url: String) async -> JSONValue? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: 15)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("2025-06-18", forHTTPHeaderField: "MCP-Protocol-Version")
        guard let (data, http) = try? await fetch(req), (200..<300).contains(http.statusCode) else { return nil }
        return try? JSONValue.parse(data)
    }

    /// RFC 9728 protected-resource metadata (path-aware, then root), then the authorization server's RFC 8414 metadata
    /// (path-aware, root, then OpenID's).
    func discover(_ serverUrl: String) async throws -> Discovery {
        guard let u = URL(string: serverUrl), let host = u.host, let scheme = u.scheme else { throw ConnectError("failed", "Not a server address") }
        let origin = "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")"
        let path = u.path == "/" ? "" : u.path
        var resource = await getJSON("\(origin)/.well-known/oauth-protected-resource\(path)")
        if resource == nil && !path.isEmpty { resource = await getJSON("\(origin)/.well-known/oauth-protected-resource") }
        let asUrl = resource?["authorization_servers"]?[0]?.string ?? origin
        guard let a = URL(string: asUrl), let aHost = a.host, let aScheme = a.scheme else { throw ConnectError("failed", "No authorization server") }
        let aOrigin = "\(aScheme)://\(aHost)\(a.port.map { ":\($0)" } ?? "")"
        let aPath = a.path == "/" ? "" : a.path
        var meta = await getJSON("\(aOrigin)/.well-known/oauth-authorization-server\(aPath)")
        if meta == nil && !aPath.isEmpty { meta = await getJSON("\(aOrigin)/.well-known/oauth-authorization-server") }
        if meta == nil { meta = await getJSON("\(aOrigin)/.well-known/openid-configuration\(aPath)") }
        return Discovery(authorizationServerUrl: asUrl, resourceMetadata: resource, authorizationServerMetadata: meta)
    }

    func endpoint(_ d: Discovery, _ key: String, _ fallback: String) -> String {
        d.authorizationServerMetadata?[key]?.string ?? (URL(string: fallback, relativeTo: URL(string: d.authorizationServerUrl))?.absoluteString ?? fallback)
    }

    /// The resource indicator: the protected resource's own `resource` when it names one, else the server's address.
    func resourceOf(_ app: String, _ d: Discovery) -> String { d.resourceMetadata?["resource"]?.string ?? urlOf(app) }

    struct OAuthFailure: Error { var code: String; var description: String; var status: Int }

    func postForm(_ url: String, _ fields: [(String, String)]) async throws -> JSONValue {
        guard let u = URL(string: url) else { throw ConnectError("failed", "No token endpoint") }
        var req = URLRequest(url: u, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        req.httpBody = Data(fields.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&").utf8)
        let (data, http) = try await fetch(req)
        let body = try? JSONValue.parse(data)
        if !(200..<300).contains(http.statusCode) || body?["error"] != nil {
            throw OAuthFailure(code: body?["error"]?.string ?? (http.statusCode >= 500 ? "server_error" : "invalid_request"), description: JS.string(body?["error_description"]), status: http.statusCode)
        }
        guard let body, body["access_token"]?.string != nil else { throw OAuthFailure(code: "server_error", description: "no token", status: http.statusCode) }
        return body
    }

    /// Whether a refresh's error is the server saying no (the grant or client refused), not a failure to ask it.
    static func refusedBy(_ error: Error) -> Bool {
        guard let e = error as? OAuthFailure else { return false }
        return !["server_error", "temporarily_unavailable", "too_many_requests"].contains(e.code)
    }

    func refresh(_ app: String) -> Task<RefreshOutcome, Never> {
        lock.lock(); defer { lock.unlock() }
        if let t = refreshing[app] { return t }
        let task = Task<RefreshOutcome, Never> { [self] in
            defer { lock.lock(); refreshing[app] = nil; lock.unlock() }
            guard let held = load(app), let refreshToken = held["tokens"]?["refresh_token"]?.string, let clientId = held["client"]?["client_id"]?.string else { return .lapsed("expired") }
            do {
                var d: Discovery
                if let s = held["discovery"]?["authorizationServerUrl"]?.string { d = Discovery(authorizationServerUrl: s, resourceMetadata: held["discovery"]?["resourceMetadata"], authorizationServerMetadata: held["discovery"]?["authorizationServerMetadata"]) }
                else { d = try await discover(urlOf(app)) }
                let token = try await postForm(endpoint(d, "token_endpoint", "/token"), [("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", clientId), ("resource", resourceOf(app, d))])
                var tokens = token.object ?? [:]
                if tokens["refresh_token"] == nil { tokens["refresh_token"] = .string(refreshToken) }
                var next = load(app) ?? held
                next["discovery"] = ["authorizationServerUrl": .string(d.authorizationServerUrl), "resourceMetadata": d.resourceMetadata ?? .null, "authorizationServerMetadata": d.authorizationServerMetadata ?? .null]
                next["tokens"] = .object(tokens)
                next["obtainedAt"] = .number(now())
                save(app, next)
                return .ok(JS.string(tokens["access_token"]))
            } catch {
                return Self.refusedBy(error) ? .lapsed("revoked") : .unknown
            }
        }
        refreshing[app] = task
        return task
    }

    /// The access token, refreshed when it is about to end; a refusal lapses the connector. nil when there is none to use.
    func tokenOf(_ app: String) async -> String? {
        guard let held = load(app), let access = held["tokens"]?["access_token"]?.string else { return nil }
        let lifetime = (held["tokens"]?["expires_in"]?.double ?? 0) > 0 ? held["tokens"]!["expires_in"]!.double! * 1000 : nil
        let endsAt = lifetime.map { (held["obtainedAt"]?.double ?? 0) + $0 }
        guard let endsAt, endsAt - now() <= Self.refreshEarlyMs else { return access }
        switch await refresh(app).value {
        case .ok(let token): return token
        case .lapsed(let reason): lapse(app, reason); return nil
        case .unknown: return endsAt > now() ? access : nil
        }
    }

    /// The connector's server asked whether its sign-in works (at most every five minutes; `force` now).
    public func check(_ app: String, force: Bool = false) async throws -> ConnectorStatus {
        guard Self.all[app] != nil else { throw ConnectError("failed", "\(app) has no connector") }
        lock.lock()
        if !force, let hit = checks[app], now() - hit.at < Self.checkKeepMs { lock.unlock(); return try await hit.task.value }
        let task = Task<ConnectorStatus, Error> { [self] in
            let before = try status(app)
            if before.state == "signed-out" || before.state == "reconnect" { return before }
            guard let token = await tokenOf(app) else { return try status(app) }
            var seen = await probe(urlOf(app), token)
            if seen.status == 401 {
                switch await refresh(app).value {
                case .lapsed: lapse(app, "revoked"); return try status(app)
                case .unknown: var s = try status(app); s.unchecked = true; return s
                case .ok(let fresh):
                    seen = await probe(urlOf(app), fresh)
                    if seen.status == 401 { lapse(app, "revoked"); return try status(app) }
                }
            }
            let reads = Self.all[app]!.reads
            if seen.status == 403 { mark(app, ["unavailable": ["at": .number(now()), "reason": "refused"]]) }
            else if seen.status == 200, let reads, !seen.tools.contains(where: { reads.contains($0) }) { mark(app, ["unavailable": ["at": .number(now()), "reason": "no-tools"]]) }
            else if seen.status == 200 { mark(app, ["unavailable": nil]) }
            else { var s = try status(app); s.unchecked = true; return s }
            return try status(app)
        }
        checks[app] = (now(), task)
        lock.unlock()
        do { return try await task.value } catch { lock.lock(); checks[app] = nil; lock.unlock(); throw error }
    }

    /// The sign-in: the app's page opened in the person's browser, their consent, the code back on the loopback port, the
    /// tokens kept. Resolves with the status once done; throws when cancelled, refused or after ten minutes.
    public func signIn(_ app: String) async throws -> ConnectorStatus {
        guard Self.all[app] != nil else { throw ConnectError("failed", "\(app) has no connector") }
        lock.lock()
        if let p = pending[app] { lock.unlock(); return try await p.task.value }
        let cancelBox = Box<(() -> Void)?>(nil)
        let task = Task<ConnectorStatus, Error> { [self] in
            defer { lock.lock(); pending[app] = nil; lock.unlock(); if let s = try? status(app) { onChange(s) } }
            var stateBytes = [UInt8](repeating: 0, count: 24)
            _ = SecRandomCopyBytes(kSecRandomDefault, 24, &stateBytes)
            let state = Data(stateBytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let returned = CodeWait()
            cancelBox.set { returned.fail(ConnectError("failed", "\(app) sign-in was cancelled")) }
            let held = load(app) ?? [:]
            let preferred = held["redirectUrl"]?.string.flatMap { URL(string: $0)?.port } ?? 0
            let loop = try await Loopback.listen(preferred: UInt16(preferred)) { request in
                guard request.method == "GET", request.path == "/callback" else { return (404, "Not found") }
                guard constantTimeEqual(request.query["state"] ?? "", state) else { return (400, "This sign-in is not the one Engelbart started") }
                if let error = request.query["error"], !error.isEmpty { returned.fail(ConnectError("failed", "\(app) sign-in was cancelled")); return (200, "\(app) sign-in cancelled") }
                guard let code = request.query["code"], !code.isEmpty, code.count <= 4096 else { return (400, "Sign-in callback without a code") }
                returned.succeed(code)
                return (200, "\(app) is connected")
            }
            defer { loop.close() }
            let timer = Task { try? await Task.sleep(nanoseconds: UInt64(Self.signInTimeoutMs * 1_000_000)); returned.fail(ConnectError("failed", "\(app) sign-in expired. Try again.")) }
            defer { timer.cancel() }
            if let s = try? status(app) { onChange(s) }
            let redirectUrl = "http://localhost:\(loop.port)/callback"
            let d = try await discover(urlOf(app))
            // A registration for another return address (the port moved) is no use: registered again.
            var client = held["redirectUrl"]?.string == redirectUrl ? held["client"] : nil
            if client == nil {
                guard let reg = d.authorizationServerMetadata?["registration_endpoint"]?.string, let regUrl = URL(string: reg) else { throw ConnectError("failed", "\(app) does not let Engelbart register") }
                var req = URLRequest(url: regUrl, timeoutInterval: 30)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                let meta: JSONValue = ["client_name": "Engelbart", "client_uri": "https://engelbart.mathetic.com", "redirect_uris": [.string(redirectUrl)],
                                       "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none"]
                req.httpBody = Data(meta.text().utf8)
                let (data, http) = try await fetch(req)
                guard (200..<300).contains(http.statusCode), let info = try? JSONValue.parse(data), info["client_id"]?.string != nil else { throw ConnectError("failed", "\(app) refused Engelbart's registration") }
                client = info
                var next = load(app) ?? [:]
                next["client"] = info; next["redirectUrl"] = .string(redirectUrl)
                save(app, next)
            }
            let clientId = JS.string(client?["client_id"])
            // PKCE S256.
            var verifierBytes = [UInt8](repeating: 0, count: 32)
            _ = SecRandomCopyBytes(kSecRandomDefault, 32, &verifierBytes)
            let b64url = { (d: Data) in d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
            let verifier = b64url(Data(verifierBytes))
            let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
            var comps = URLComponents(string: endpoint(d, "authorization_endpoint", "/authorize"))
            var items = [URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "code_challenge", value: challenge),
                         URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "redirect_uri", value: redirectUrl), URLQueryItem(name: "state", value: state)]
            // Only the app's `scope` ('read'): the SDK otherwise asks for every scope the server lists.
            if let scope = Self.all[app]!.scope { items.append(URLQueryItem(name: "scope", value: scope)) }
            else if let scopes = d.resourceMetadata?["scopes_supported"]?.array?.compactMap(\.string), !scopes.isEmpty { items.append(URLQueryItem(name: "scope", value: scopes.joined(separator: " "))) }
            items.append(URLQueryItem(name: "resource", value: resourceOf(app, d)))
            let existingItems = comps?.queryItems ?? []
            comps?.queryItems = existingItems + items
            guard let authUrl = comps?.url?.absoluteString else { throw ConnectError("failed", "No sign-in page") }
            do { try await openExternal(authUrl) } catch { returned.fail(error) }
            let code = try await returned.value()
            let tokens = try await postForm(endpoint(d, "token_endpoint", "/token"), [("grant_type", "authorization_code"), ("code", code), ("code_verifier", verifier),
                                                                                      ("redirect_uri", redirectUrl), ("client_id", clientId), ("resource", resourceOf(app, d))])
            // New tokens: whatever ended or was refused before is past, and the server is asked again.
            var next = load(app) ?? [:]
            next["tokens"] = tokens; next["obtainedAt"] = .number(now()); next["lapsed"] = nil; next["unavailable"] = nil
            next["discovery"] = ["authorizationServerUrl": .string(d.authorizationServerUrl), "resourceMetadata": d.resourceMetadata ?? .null, "authorizationServerMetadata": d.authorizationServerMetadata ?? .null]
            save(app, next)
            lock.lock(); checks[app] = nil; lock.unlock()
            // Signed in: the server is asked at once whether it takes the account (Evernote's beta).
            return try await check(app, force: true)
        }
        pending[app] = (task, { cancelBox.get()?() })
        lock.unlock()
        return try await task.value
    }

    /// An access token for a run; nil when the person must sign in again or the server refuses the account.
    public func accessToken(_ app: String) async -> String? {
        guard Self.all[app] != nil else { return nil }
        if let held = load(app), JS.truthy(held["unavailable"]) { return nil }
        return await tokenOf(app)
    }

    /// The connectors among `apps` the person is signed in to, for a run (each server asked first).
    public func serversFor(_ apps: [String]) async -> [ConnectorServer] {
        var out: [ConnectorServer] = []
        var seen = Set<String>()
        for app in apps where Self.all[app] != nil && seen.insert(app).inserted {
            if let s = try? await check(app), !s.connected { continue }
            if let token = await accessToken(app) { out.append(ConnectorServer(app: app, name: Self.all[app]!.server, url: urlOf(app), token: token)) }
        }
        return out
    }

    /// Engelbart's sign-in where it has one, else the person's own in their Claude Code or Codex.
    public func serversForRun(_ apps: [String], provider: String) async -> [ConnectorServer] {
        let mine = await serversFor(apps)
        let rest = apps.filter { a in Self.all[a] != nil && !mine.contains { $0.app == a } }
        let theirs = rest.isEmpty || own == nil ? [] : await own!.serversFor(rest, provider: provider).map { ConnectorServer(app: $0.app, name: $0.name, url: $0.url, type: $0.type, own: true) }
        return mine + theirs
    }

    public func reaches(_ app: String, provider: String) async -> Bool {
        guard Self.all[app] != nil else { return false }
        if (try? status(app))?.connected == true {
            if let s = try? await check(app) { if s.connected { return true } } else { return true }
        }
        return await own?.reaches(app, provider: provider) ?? false
    }

    public func cancel(_ app: String) { lock.lock(); let p = pending[app]; lock.unlock(); p?.cancel() }

    @discardableResult
    public func signOut(_ app: String) throws -> ConnectorStatus {
        guard Self.all[app] != nil else { throw ConnectError("failed", "\(app) has no connector") }
        lock.lock(); memory[app] = nil; checks[app] = nil; lock.unlock()
        save(app, nil)
        let s = try status(app)
        onChange(s)
        return s
    }

    // MARK: the server's own answer

    /// One look at an MCP server with a token: initialize, then tools/list → (200, tool names), or the HTTP status it
    /// refused with, 0 when it couldn't be asked.
    public static func probeServer(url: String, token: String, fetch: Fetch) async -> (status: Int, tools: [String]) {
        guard let target = URL(string: url) else { return (0, []) }
        func post(_ body: JSONValue, session: String?) async -> (Int, JSONValue?, String?) {
            var req = URLRequest(url: target, timeoutInterval: checkTimeoutMs / 1000)
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
            if let session { req.setValue(session, forHTTPHeaderField: "Mcp-Session-Id") }
            req.httpBody = Data(body.text().utf8)
            guard let (data, http) = try? await fetch(req) else { return (0, nil, nil) }
            let text = String(decoding: data, as: UTF8.self)
            var value = try? JSONValue.parse(data)
            if value == nil { // text/event-stream: the data lines
                for line in text.components(separatedBy: "\n") where line.hasPrefix("data:") {
                    if let v = try? JSONValue.parse(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)), v["id"] != nil { value = v }
                }
            }
            return (http.statusCode, value, http.value(forHTTPHeaderField: "Mcp-Session-Id"))
        }
        let (status, initialized, session) = await post(["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["protocolVersion": "2025-06-18", "capabilities": .object([:]), "clientInfo": ["name": "Engelbart", "version": "1.0.0"]]], session: nil)
        guard (200..<300).contains(status) else { return (status, []) }
        guard initialized?["result"] != nil else { return (0, []) }
        _ = await post(["jsonrpc": "2.0", "method": "notifications/initialized"], session: session)
        let (listStatus, listed, _) = await post(["jsonrpc": "2.0", "id": 2, "method": "tools/list"], session: session)
        guard (200..<300).contains(listStatus) else { return (listStatus, []) }
        guard let tools = listed?["result"]?["tools"]?.array else { return (0, []) }
        return (200, tools.compactMap { $0["name"]?.string })
    }
}

/// A one-shot wait for the sign-in's code (resolved by the callback, failed by cancel or the timer).
final class CodeWait: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<String, Error>?
    private var waiter: CheckedContinuation<String, Error>?
    func succeed(_ code: String) { settle(.success(code)) }
    func fail(_ error: Error) { settle(.failure(error)) }
    private func settle(_ r: Result<String, Error>) {
        lock.lock(); if result != nil { lock.unlock(); return }; result = r; let w = waiter; waiter = nil; lock.unlock()
        w?.resume(with: r)
    }
    func value() async throws -> String {
        try await withCheckedThrowingContinuation { c in
            lock.lock(); if let result { lock.unlock(); c.resume(with: result); return }; waiter = c; lock.unlock()
        }
    }
}

/// The loopback server for a sign-in's return: 127.0.0.1 and, on the same port, ::1 (localhost may be either).
final class Loopback: @unchecked Sendable {
    let port: UInt16
    let listeners: [NWListener]
    init(port: UInt16, listeners: [NWListener]) { self.port = port; self.listeners = listeners }
    func close() { listeners.forEach { $0.cancel() } }

    static func page(_ status: Int, _ text: String) -> Data {
        let html = "<!doctype html><meta charset=\"utf-8\"><title>Engelbart</title><h1>\(text)</h1><p>You can close this tab and go back to Engelbart.</p>"
        let reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Bad Request"
        let head = "HTTP/1.1 \(status) \(reason)\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\ncontent-security-policy: default-src 'none'\r\ncontent-length: \(html.utf8.count)\r\nconnection: close\r\n\r\n"
        return Data((head + html).utf8)
    }

    static func listen(preferred: UInt16, _ handle: @escaping (HTTPRequest) -> (Int, String)) async throws -> Loopback {
        func make(_ host: String, _ port: UInt16) async throws -> NWListener {
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? .any)
            let listener = try NWListener(using: params)
            let ready = ToolBridge.AsyncReady()
            listener.stateUpdateHandler = { state in
                if case .ready = state { ready.resume(.success(listener.port?.rawValue ?? 0)) }
                if case .failed(let e) = state { ready.resume(.failure(e)) }
            }
            listener.newConnectionHandler = { conn in
                conn.start(queue: .global())
                var buffer = Data()
                func receive() {
                    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, error in
                        if let data { buffer.append(data) }
                        if let request = HTTPRequest.parse(buffer) {
                            let (status, text) = handle(request)
                            conn.send(content: page(status, text), completion: .contentProcessed { _ in conn.cancel() })
                            return
                        }
                        if done || error != nil || buffer.count > 65536 { conn.cancel(); return }
                        receive()
                    }
                }
                receive()
            }
            listener.start(queue: .global())
            _ = try await ready.value()
            return listener
        }
        var first: NWListener
        do { first = try await make("127.0.0.1", preferred) } catch { first = try await make("127.0.0.1", 0) }
        let port = first.port?.rawValue ?? 0
        var all = [first]
        if let second = try? await make("::1", port) { all.append(second) }
        return Loopback(port: port, listeners: all)
    }
}
