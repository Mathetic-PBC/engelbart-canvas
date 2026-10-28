import Foundation
import EngelbartCore

// src/main/github/connection.cjs: GitHub App access for the repository picker. The shared registration (client id
// Iv23liAZNYl96zlluMDs) signs in through the broker in the default browser (./GithubBrowserAuth.swift); a custom
// registration (config.json github.clientId, or ENGELBART_GITHUB_CLIENT_ID) uses the device flow, which needs no client
// secret for the token nor for refreshing it (spec decision 84). Tokens stay in this process, sealed with the Keychain's
// key in <dataRoot>/github.json (one sign-in per data root: test mode's root starts signed out). `tokenFlow` records
// whether a refresh goes to the broker or to GitHub directly.

public struct GithubError: Error, LocalizedError, Equatable {
    public let message: String
    public let code: String
    public init(_ message: String, code: String = "github") { self.message = message; self.code = code }
    public var errorDescription: String? { message }
}

public struct GithubPending: Equatable, Sendable {
    public var kind: String          // 'browser' | 'device'
    public var userCode: String?
    public var verificationUri: String
    public var expiresAt: Double
}

public struct GithubStatus: Equatable, Sendable {
    public var configured: Bool
    public var connected: Bool
    public var login: String
    public var name: String
    public var avatarUrl: String
    public var persisted: Bool
    public var pending: GithubPending?
    public var error: String
    public var installUrl: String
    public var installHint: Bool

    public init(configured: Bool = false, connected: Bool = false, login: String = "", name: String = "", avatarUrl: String = "",
                persisted: Bool = true, pending: GithubPending? = nil, error: String = "", installUrl: String = "", installHint: Bool = false) {
        self.configured = configured; self.connected = connected; self.login = login; self.name = name; self.avatarUrl = avatarUrl
        self.persisted = persisted; self.pending = pending; self.error = error; self.installUrl = installUrl; self.installHint = installHint
    }

    /// What github-status answers with no GitHub at all (ipc.cjs).
    public static let unavailable = GithubStatus()

    /// The status as the `engelbart:github` payload (preload's shape).
    public var json: JSONValue {
        var pendingValue: JSONValue = .null
        if let pending {
            var p: [String: JSONValue] = ["kind": .string(pending.kind), "verificationUri": .string(pending.verificationUri), "expiresAt": .number(pending.expiresAt)]
            if let code = pending.userCode { p["userCode"] = .string(code) }
            pendingValue = .object(p)
        }
        return ["configured": .bool(configured), "connected": .bool(connected), "login": .string(login), "name": .string(name),
                "avatarUrl": .string(avatarUrl), "persisted": .bool(persisted), "pending": pendingValue, "error": .string(error),
                "installUrl": .string(installUrl), "installHint": .bool(installHint)]
    }
}

/// A repository the App can read (shapeRepo).
public struct GithubRepo: Equatable, Sendable, Identifiable {
    public var id: String?
    public var fullName: String
    public var url: String
    public var owner: String
    public var isPrivate: Bool
    public var description: String
    public var pushedAt: String
    /// Typed or pasted into the search, not listed by the App (model/github.js typedRepo).
    public var typed: Bool = false

    public init(id: String?, fullName: String, url: String, owner: String, isPrivate: Bool, description: String = "", pushedAt: String = "", typed: Bool = false) {
        self.id = id; self.fullName = fullName; self.url = url; self.owner = owner; self.isPrivate = isPrivate
        self.description = description; self.pushedAt = pushedAt; self.typed = typed
    }

    /// `shapeRepo`: nil unless full_name is owner/name and the id a safe integer; description cut to 300.
    public static func shape(_ repo: JSONValue) -> GithubRepo? {
        guard let full = repo["full_name"]?.string, re("^[\\w.-]+/[\\w.-]+$").test(full),
              let id = repo["id"]?.double, id.rounded() == id, abs(id) <= 9_007_199_254_740_991 else { return nil }
        return GithubRepo(id: JSONText.number(id), fullName: full, url: "https://github.com/\(full)", owner: String(full.split(separator: "/")[0]),
                          isPrivate: repo["private"]?.truthy ?? false, description: jsSlice(repo["description"]?.string ?? "", 300),
                          pushedAt: repo["pushed_at"]?.string ?? "")
    }

    public var json: JSONValue {
        ["id": id.map { .string($0) } ?? .null, "fullName": .string(fullName), "url": .string(url), "owner": .string(owner),
         "private": .bool(isPrivate), "description": .string(description), "pushedAt": .string(pushedAt)]
    }
}

public struct GithubAccountInstall: Equatable, Sendable {
    public var login: String
    public var type: String
    public var all: Bool
}

public struct GithubRepoList: Equatable, Sendable {
    public var repos: [GithubRepo]
    public var accounts: [GithubAccountInstall]
    public var missingOrgs: [MissingOrg]
}

/// What a sign-in keeps (Electron's `saved`). A class: a refresh started for one sign-in checks it is still the one kept.
final class GithubAccount {
    var login: String
    var name: String
    var avatarUrl: String
    var id: String?
    var access: String
    var accessExpiresAt: Double?
    var refresh: String?
    var refreshExpiresAt: Double?
    var tokenFlow: String

    init(login: String, name: String, avatarUrl: String, id: String?, access: String, accessExpiresAt: Double?, refresh: String?, refreshExpiresAt: Double?, tokenFlow: String) {
        self.login = login; self.name = name; self.avatarUrl = avatarUrl; self.id = id; self.access = access
        self.accessExpiresAt = accessExpiresAt; self.refresh = refresh; self.refreshExpiresAt = refreshExpiresAt; self.tokenFlow = tokenFlow
    }
}

@MainActor
public final class GithubConnection {
    nonisolated public static let web = "https://github.com"
    nonisolated public static let api = "https://api.github.com"
    static let timeout: TimeInterval = 15
    static let refreshEarlyMs: Double = 5 * 60 * 1000
    static let perPage = 100
    static let maxPages = 10
    static let deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"

    /// What GitHub's device-flow errors mean to the person.
    nonisolated public static let failures: [String: String] = [
        "access_denied": "Cancelled on GitHub.",
        "expired_token": "The code expired. Try again.",
        "token_expired": "The code expired. Try again.",
        "device_flow_disabled": "Device flow is off in the GitHub App’s settings.",
        "incorrect_client_credentials": "GitHub does not know this client id.",
        "incorrect_device_code": "GitHub did not accept the code. Try again.",
        "unsupported_grant_type": "GitHub refused the sign-in.",
    ]

    public struct Settings: Equatable, Sendable {
        public var clientId: String
        public var appSlug: String
        public init(clientId: String = "", appSlug: String = "") { self.clientId = clientId; self.appSlug = appSlug }
    }

    // Wiring (index.cjs createGithub's options).
    let http: HTTPClient
    let settings: () -> Settings
    let file: () -> String?
    let crypt: SecretCrypt
    let openVerification: (String) async throws -> Void
    let closeVerification: () -> Void
    let browserAuth: () -> GithubBrowserAuthorizing?
    let onConnected: () -> Void
    let onChange: (GithubStatus) -> Void
    /// MATH-111: the organizations this Mac's repositories belong to (({ login, dirs }) → orgs.macOrgs).
    let localOrgs: (String, [String]) async -> [MacOrg]
    /// The App's install page opened in the default browser right after a fresh sign-in (nil: never).
    let openInstall: ((String) async throws -> Void)?
    let now: NowMs
    let sleep: SleepMs
    public let webBase: String
    public let apiBase: String

    private var saved: GithubAccount?
    private var loaded = false
    private var savedFor: String?
    private var pending: PendingFlow?
    private var problem = ""
    private var persisted = true
    private var refreshing: Task<String?, Never>?
    private var starting: Task<GithubStatus, Error>?
    private var generation = 0
    private var installHint = false
    private var owners: [String: Owner] = [:]

    enum Owner { case gone, known(id: String, type: String) }

    final class PendingFlow {
        let kind: String
        let userCode: String?
        let verificationUri: String
        let deviceCode: String
        let interval: Double
        let expiresAt: Double
        let cancel: (() -> Void)?
        init(kind: String, userCode: String?, verificationUri: String, deviceCode: String = "", interval: Double = 5, expiresAt: Double, cancel: (() -> Void)? = nil) {
            self.kind = kind; self.userCode = userCode; self.verificationUri = verificationUri; self.deviceCode = deviceCode
            self.interval = interval; self.expiresAt = expiresAt; self.cancel = cancel
        }
    }

    public init(http: HTTPClient = URLSessionHTTPClient.shared,
                settings: @escaping () -> Settings = { Settings() },
                file: @escaping () -> String?,
                crypt: SecretCrypt = NoKeychain(),
                openVerification: @escaping (String) async throws -> Void = { _ in },
                closeVerification: @escaping () -> Void = {},
                browserAuth: @escaping () -> GithubBrowserAuthorizing? = { nil },
                onConnected: @escaping () -> Void = {},
                onChange: @escaping (GithubStatus) -> Void = { _ in },
                localOrgs: @escaping (String, [String]) async -> [MacOrg] = { _, _ in [] },
                openInstall: ((String) async throws -> Void)? = nil,
                now: @escaping NowMs = systemNow,
                sleep: @escaping SleepMs = systemSleep,
                web: String = GithubConnection.web,
                api: String = GithubConnection.api) {
        self.http = http; self.settings = settings; self.file = file; self.crypt = crypt
        self.openVerification = openVerification; self.closeVerification = closeVerification; self.browserAuth = browserAuth
        self.onConnected = onConnected; self.onChange = onChange; self.localOrgs = localOrgs; self.openInstall = openInstall
        self.now = now; self.sleep = sleep; self.webBase = web; self.apiBase = api
    }

    private var clientId: String { settings().clientId }
    private var appSlug: String { settings().appSlug }

    private func changed() { onChange(status()) }

    // MARK: requests

    struct Answer { var status: Int; var ok: Bool; var data: JSONValue?; var link: String }

    private func call(_ url: String, method: String = "GET", form: [(String, String)]? = nil, token: String? = nil) async throws -> Answer {
        guard let target = URL(string: url) else { throw GithubError("GitHub answered 0.", code: "api") }
        var headers = ["accept": form != nil ? "application/json" : "application/vnd.github+json", "x-github-api-version": "2022-11-28"]
        if let token { headers["authorization"] = "Bearer \(token)" }
        var body: Data?
        if let form { headers["content-type"] = "application/x-www-form-urlencoded"; body = HTTPRequest.formBody(form) }
        let response = try await http.send(HTTPRequest(url: target, method: method, headers: headers, body: body, redirect: .follow, timeout: Self.timeout))
        return Answer(status: response.status, ok: response.ok, data: response.json, link: response.header("link") ?? "")
    }

    // MARK: storage

    private func load() -> GithubAccount? {
        let at = file()
        if loaded && savedFor == at { return saved }
        loaded = true
        savedFor = at
        saved = nil
        guard let at, let raw = FileOps.readJSON(at) else { return nil }
        guard raw["v"]?.double == 1, let access = raw["access"]?.string, crypt.available() else { return nil }
        do {
            let positive: (JSONValue?) -> Double? = { value in
                guard let n = value?.numberish, n > 0 else { return nil }
                return n
            }
            saved = GithubAccount(
                login: raw["login"]?.stringish ?? "", name: raw["name"]?.stringish ?? "", avatarUrl: raw["avatarUrl"]?.stringish ?? "",
                id: (raw["id"]?.isNull ?? true) ? nil : raw["id"]?.stringish,
                access: try crypt.decrypt(access), accessExpiresAt: positive(raw["accessExpiresAt"]),
                refresh: try raw["refresh"]?.string.map { try crypt.decrypt($0) }, refreshExpiresAt: positive(raw["refreshExpiresAt"]),
                tokenFlow: raw["tokenFlow"]?.string == "browser" ? "browser" : "device")
        } catch {
            saved = nil // encrypted by another keychain: signed out
        }
        return saved
    }

    private func keep(_ next: GithubAccount) {
        saved = next
        loaded = true
        let at = file()
        savedFor = at
        persisted = at != nil && crypt.available()
        guard persisted, let at else { return }
        do {
            let out: JSONValue = [
                "v": 1, "login": .string(next.login), "name": .string(next.name), "avatarUrl": .string(next.avatarUrl),
                "id": next.id.map { .string($0) } ?? .null,
                "access": .string(try crypt.encrypt(next.access)), "accessExpiresAt": next.accessExpiresAt.map { .number($0) } ?? .null,
                "refresh": try next.refresh.map { .string(try crypt.encrypt($0)) } ?? .null,
                "refreshExpiresAt": next.refreshExpiresAt.map { .number($0) } ?? .null,
                "tokenFlow": .string(next.tokenFlow),
            ]
            FileOps.mkdir((at as NSString).deletingLastPathComponent)
            try FileOps.write(JSONText.stringify(out, indent: 2) + "\n", to: at, mode: 0o600)
        } catch {
            persisted = false
        }
    }

    private func forget(_ reason: String = "") {
        saved = nil
        loaded = true
        installHint = false
        refreshing = nil
        let at = file()
        savedFor = at
        if let at { FileOps.remove(at) }
        problem = reason
    }

    /// The tokens GitHub answered, expiry times in milliseconds since the epoch.
    private func tokensFrom(_ answer: JSONValue, at: Double) -> (access: String, accessExpiresAt: Double?, refresh: String?, refreshExpiresAt: Double?) {
        let accessIn = answer["expires_in"]?.numberish.flatMap { $0 > 0 ? $0 : nil }
        let refreshIn = answer["refresh_token_expires_in"]?.numberish.flatMap { $0 > 0 ? $0 : nil }
        let refresh = answer["refresh_token"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        return (answer["access_token"]?.stringish ?? "", accessIn.map { at + $0 * 1000 }, refresh, refreshIn.map { at + $0 * 1000 })
    }

    // MARK: status

    public func status() -> GithubStatus {
        let account = load()
        return GithubStatus(
            configured: !clientId.isEmpty,
            connected: account != nil,
            login: account?.login ?? "",
            name: account?.name ?? "",
            avatarUrl: account?.avatarUrl ?? "",
            persisted: account != nil ? persisted : true,
            pending: pending.map { GithubPending(kind: $0.kind, userCode: $0.userCode, verificationUri: $0.verificationUri, expiresAt: $0.expiresAt) },
            error: problem,
            installUrl: appSlug.isEmpty ? "" : "\(webBase)/apps/\(appSlug)/installations/new",
            installHint: account != nil && installHint)
    }

    // MARK: sign-in

    /// Starts signing in (or shows the page again for a sign-in already waiting). Answers the status.
    @discardableResult
    public func connect() async throws -> GithubStatus {
        if starting == nil {
            starting = Task { @MainActor in
                defer { self.starting = nil }
                return try await self.begin()
            }
        }
        return try await starting!.value
    }

    private func begin() async throws -> GithubStatus {
        if clientId.isEmpty {
            throw GithubError("GitHub is not set up: put the GitHub App’s client id in ~/.engelbart/config.json (github.clientId).", code: "unconfigured")
        }
        if let pending, now() < pending.expiresAt { try await openVerification(pending.verificationUri); return status() }
        pending?.cancel?()
        generation += 1
        let attempt = generation
        problem = ""
        if let browser = browserAuth() {
            let auth = try await browser.start()
            if attempt != generation { auth.cancel(); return status() }
            let flow = PendingFlow(kind: "browser", userCode: nil, verificationUri: auth.url, expiresAt: auth.expiresAt, cancel: { auth.cancel() })
            pending = flow
            changed()
            Task { @MainActor in
                do {
                    let data = try await auth.result()
                    guard self.pending === flow else { return }
                    try await self.accept(data, active: { [weak self] in self?.pending === flow }, tokenFlow: "browser")
                    guard self.pending === flow else { return }
                    self.pending = nil; self.problem = ""; self.changed(); self.onConnected()
                    Task { @MainActor in await self.askToInstall() }
                } catch {
                    guard self.pending === flow else { return }
                    self.pending = nil; self.problem = error.localizedDescription; self.changed()
                }
            }
            do { try await openVerification(flow.verificationUri) } catch {
                cancel()
                problem = "Could not open your browser. Try signing in again."
                changed()
                throw error
            }
            return status()
        }
        let answer = try await call("\(webBase)/login/device/code", method: "POST", form: [("client_id", clientId)])
        let data = answer.data ?? .object([:])
        if attempt != generation { return status() }
        guard answer.ok, let device = data["device_code"], device.truthy, let user = data["user_code"], user.truthy else {
            let code = data["error"]?.string ?? ""
            problem = Self.failures[code] ?? data["error_description"]?.string ?? "GitHub answered \(answer.status)."
            changed()
            throw GithubError(problem, code: code.isEmpty ? "device-code" : code)
        }
        let uri = data["verification_uri"]?.string.flatMap { $0.hasPrefix("https://") ? $0 : nil } ?? "\(webBase)/login/device"
        let interval = data["interval"]?.numberish.flatMap { $0 > 0 ? $0 : nil } ?? 5
        let expiresIn = data["expires_in"]?.numberish.flatMap { $0 > 0 ? $0 : nil } ?? 900
        let flow = PendingFlow(kind: "device", userCode: user.stringish, verificationUri: uri, deviceCode: device.stringish,
                               interval: interval, expiresAt: now() + expiresIn * 1000)
        pending = flow
        changed()
        try await openVerification(flow.verificationUri)
        Task { @MainActor in await self.wait(flow) }
        return status()
    }

    private func wait(_ flow: PendingFlow) async {
        var interval = flow.interval
        while pending === flow && now() < flow.expiresAt {
            do { try await sleep(interval * 1000) } catch { return }
            if pending !== flow { return }
            let answer: Answer
            do {
                answer = try await call("\(webBase)/login/oauth/access_token", method: "POST",
                                        form: [("client_id", clientId), ("device_code", flow.deviceCode), ("grant_type", Self.deviceGrant)])
            } catch {
                continue // the network blinked: keep waiting until the code expires
            }
            let data = answer.data ?? .object([:])
            if pending !== flow { return }
            if let token = data["access_token"], token.truthy {
                do {
                    try await accept(data, active: { [weak self] in self?.pending === flow })
                    if pending !== flow { return }
                    problem = ""
                } catch {
                    problem = error.localizedDescription
                }
                if pending === flow { pending = nil }
                closeVerification()
                changed()
                if saved != nil { onConnected(); Task { @MainActor in await self.askToInstall() } }
                return
            }
            let code = data["error"]?.string ?? ""
            if code == "authorization_pending" { continue }
            if code == "slow_down" { interval = data["interval"]?.numberish.flatMap { $0 > 0 ? $0 : nil } ?? interval + 5; continue }
            if pending !== flow { return }
            pending = nil
            problem = Self.failures[code] ?? data["error_description"]?.string ?? "GitHub answered \(answer.status)."
            closeVerification()
            changed()
            return
        }
        if pending === flow { pending = nil; problem = Self.failures["expired_token"]!; closeVerification(); changed() }
    }

    /// A token arrived: who it belongs to, then keep it.
    private func accept(_ data: JSONValue, active: () -> Bool = { true }, tokenFlow: String = "device") async throws {
        let tokens = tokensFrom(data, at: now())
        let who = try await call("\(apiBase)/user", token: tokens.access)
        guard who.ok, let login = who.data?["login"]?.string else {
            throw GithubError("GitHub gave a token but would not say whose it is.", code: "user")
        }
        if !active() { return }
        let idValue = who.data?["id"]
        keep(GithubAccount(login: login, name: who.data?["name"]?.string ?? "", avatarUrl: who.data?["avatar_url"]?.string ?? "",
                           id: (idValue == nil || idValue!.isNull) ? nil : idValue!.stringish,
                           access: tokens.access, accessExpiresAt: tokens.accessExpiresAt, refresh: tokens.refresh,
                           refreshExpiresAt: tokens.refreshExpiresAt, tokenFlow: tokenFlow))
    }

    @discardableResult
    public func cancel() -> GithubStatus {
        generation += 1
        guard let flow = pending else { return status() }
        flow.cancel?()
        pending = nil
        closeVerification()
        changed()
        return status()
    }

    @discardableResult
    public func disconnect() -> GithubStatus {
        cancel()
        forget("")
        changed()
        return status()
    }

    // MARK: tokens

    /// A token that works now (refreshed when it is about to expire), or nil when signed out.
    public func token() async -> String? {
        guard let account = load() else { return nil }
        if account.accessExpiresAt == nil || now() < account.accessExpiresAt! - Self.refreshEarlyMs { return account.access }
        if account.refresh == nil || (account.refreshExpiresAt != nil && now() >= account.refreshExpiresAt!) {
            forget("The GitHub sign-in expired. Sign in again.")
            changed()
            return nil
        }
        if refreshing == nil {
            refreshing = Task { @MainActor in
                defer { self.refreshing = nil }
                return await self.refresh(account)
            }
        }
        return await refreshing!.value
    }

    private func refresh(_ account: GithubAccount) async -> String? {
        var data: JSONValue
        do {
            if account.tokenFlow == "browser" {
                guard let browser = browserAuth() else { return nil }
                data = try await browser.refresh(account.refresh ?? "")
            } else {
                data = try await call("\(webBase)/login/oauth/access_token", method: "POST",
                                      form: [("client_id", clientId), ("grant_type", "refresh_token"), ("refresh_token", account.refresh ?? "")]).data ?? .object([:])
            }
        } catch {
            return nil // offline: nothing works now; the refresh token is still good for later
        }
        if saved !== account { return nil }
        let token = data["access_token"]
        let error = data["error"]
        if !(token?.truthy ?? false) && !(error?.truthy ?? false) { return nil } // GitHub had a bad moment: keep the sign-in
        if !(token?.truthy ?? false) {
            forget(error?.string == "bad_refresh_token" ? "The GitHub sign-in expired. Sign in again."
                   : (data["error_description"]?.string ?? "GitHub would not renew the sign-in. Sign in again."))
            changed()
            return nil
        }
        let renewed = tokensFrom(data, at: now())
        keep(GithubAccount(login: account.login, name: account.name, avatarUrl: account.avatarUrl, id: account.id,
                           access: renewed.access, accessExpiresAt: renewed.accessExpiresAt,
                           refresh: renewed.refresh ?? account.refresh,
                           refreshExpiresAt: renewed.refresh != nil ? renewed.refreshExpiresAt : account.refreshExpiresAt,
                           tokenFlow: account.tokenFlow))
        return saved?.access
    }

    /// Headers that sign a request to GitHub's API in, or none.
    public func authHeaders() async -> [String: String] {
        guard let value = await token() else { return [:] }
        return ["authorization": "Bearer \(value)"]
    }

    /// A signed-in GET; a token GitHub no longer accepts signs the person out.
    private func signedGet(_ url: String) async throws -> Answer {
        guard let value = await token() else { throw GithubError("Not signed in to GitHub.", code: "signed-out") }
        let answer = try await call(url, token: value)
        if answer.status == 401 {
            forget("GitHub no longer accepts the sign-in. Sign in again.")
            changed()
            throw GithubError(problem, code: "signed-out")
        }
        if !answer.ok { throw GithubError(answer.data?["message"]?.string ?? "GitHub answered \(answer.status).", code: "api") }
        return answer
    }

    /// Every page of a list: `key` names it in the answer, or nil when the answer is the list.
    private func pages(_ url: String, key: String?) async throws -> [JSONValue] {
        var out: [JSONValue] = []
        for page in 1...Self.maxPages {
            let answer = try await signedGet("\(url)\(url.contains("?") ? "&" : "?")per_page=\(Self.perPage)&page=\(page)")
            let list = key.flatMap { answer.data?[$0] } ?? (key == nil ? answer.data : nil)
            let items = list?.array ?? []
            out.append(contentsOf: items)
            if items.count < Self.perPage || !answer.link.contains("rel=\"next\"") { break }
        }
        return out
    }

    /// GitHub's id and type for an account, kept (a 404 kept as gone; another failure asked again next time).
    private func ownerOf(_ login: String) async -> Owner? {
        let key = login.lowercased()
        if let held = owners[key] { return held }
        let answer: Answer
        do { answer = try await call("\(apiBase)/users/\(encodeURIComponent(login))", token: await token()) } catch { return nil }
        if answer.status == 404 { owners[key] = .gone; return .gone }
        guard answer.ok, let id = answer.data?["id"], !id.isNull else { return nil }
        let owner = Owner.known(id: id.stringish, type: answer.data?["type"]?.stringish ?? "")
        owners[key] = owner
        return owner
    }

    /// The organizations the person works in that the App is not installed on (MATH-111).
    private func missingFor(_ accounts: [GithubAccountInstall], dirs: [String]) async -> [MissingOrg] {
        let login = load()?.login ?? ""
        var fromGithub: [(login: String, id: String?)] = []
        if let orgs = try? await pages("\(apiBase)/user/orgs", key: nil) {
            fromGithub = orgs.compactMap { org in
                guard let l = org["login"]?.string else { return nil }
                let id = org["id"]
                return (l, (id == nil || id!.isNull) ? nil : id!.stringish)
            }
        }
        let fromMac = await localOrgs(login, dirs)
        let base = status().installUrl
        let found = Array(GithubOrgs.missingOrgs(accounts: accounts.map(\.login), fromGithub: fromGithub, fromMac: fromMac, login: login, base: base).prefix(20))
        var out: [MissingOrg] = []
        for org in found {
            var who: Owner?
            if org.id == nil { who = await ownerOf(org.login) }
            if let who {
                if case .gone = who { continue }
                if case .known(_, let type) = who, type == "User" { continue }
            }
            var id = org.id
            if id == nil, case .known(let known, _)? = who { id = known }
            out.append(MissingOrg(login: org.login, id: id, repos: org.repos, installUrl: GithubOrgs.installUrlFor(base, id)))
        }
        return out
    }

    /// The repositories the App can read, most recently pushed first; the accounts it is installed on; the organizations
    /// it is missing. `dirs`: more repository folders on this Mac whose remotes count.
    public func repos(dirs: [String] = []) async throws -> GithubRepoList {
        let installations = try await pages("\(apiBase)/user/installations", key: "installations")
        var seen = Set<String>()
        var list: [GithubRepo] = []
        for installation in installations {
            guard let id = installation["id"]?.double, id.rounded() == id else { continue }
            for repo in try await pages("\(apiBase)/user/installations/\(JSONText.number(id))/repositories", key: "repositories") {
                if let shaped = GithubRepo.shape(repo), let rid = shaped.id, seen.insert(rid).inserted { list.append(shaped) }
            }
        }
        list.sort { $0.pushedAt != $1.pushedAt ? $0.pushedAt > $1.pushedAt : $0.fullName.localizedCompare($1.fullName) == .orderedAscending }
        let accounts: [GithubAccountInstall] = installations.compactMap { installation in
            guard let login = installation["account"]?["login"]?.string else { return nil }
            return GithubAccountInstall(login: login, type: installation["account"]?["type"]?.stringish ?? "", all: installation["repository_selection"]?.string == "all")
        }
        let missing = await missingFor(accounts, dirs: dirs)
        if installHint && !accounts.isEmpty && missing.isEmpty { installHint = false; changed() }
        return GithubRepoList(repos: list, accounts: accounts, missingOrgs: missing)
    }

    /// Right after a fresh sign-in: with the App installed nowhere or an organization missing, GitHub's install page opens
    /// in the default browser, once, and the lists say what to do there until nothing is missing.
    private func askToInstall() async {
        guard let openInstall, !status().installUrl.isEmpty else { return }
        guard let found = try? await repos() else { return }
        if !found.accounts.isEmpty && found.missingOrgs.isEmpty { return }
        installHint = true
        changed()
        try? await openInstall(status().installUrl)
    }
}
