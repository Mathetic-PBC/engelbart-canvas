import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/github.test.cjs: the GitHub connection against a fake GitHub, a fake keychain and a fake clock.

private let CLIENT = "Iv23liTestClient0001"
private let user = reply(200, ["login": "hudsonmp", "name": "Hudson", "avatar_url": "https://avatars.githubusercontent.com/u/1", "id": 7])

@MainActor
private final class Setup {
    let dir = tempDir("engelbart-github")
    let clock = FakeClock()
    var opened: [String] = []
    var closed = 0
    var changes: [GithubStatus] = []
    var installs: [String] = []
    var connected = 0
    let recorder = Recorder()
    var github: GithubConnection!
    var http: HTTPClient!
    var file: String { join(dir, "github.json") }

    init(_ script: @escaping @Sendable (Call) async throws -> HTTPResponse, clientId: String = CLIENT, crypt: SecretCrypt = ReversingCrypt(),
         browserAuth: GithubBrowserAuthorizing? = nil, localOrgs: ((String, [String]) async -> [MacOrg])? = nil, openInstall: Bool = false) {
        let (http, _) = fakeHTTP(recorder, script)
        self.http = http
        let clock = self.clock
        github = GithubConnection(
            http: http,
            settings: { GithubConnection.Settings(clientId: clientId, appSlug: "engelbart-mathetic") },
            file: { [dir] in join(dir, "github.json") },
            crypt: crypt,
            openVerification: { [weak self] url in self?.opened.append(url) },
            closeVerification: { [weak self] in self?.closed += 1 },
            browserAuth: { browserAuth },
            onConnected: { [weak self] in self?.connected += 1 },
            onChange: { [weak self] status in self?.changes.append(status) },
            localOrgs: localOrgs ?? { _, _ in [] },
            openInstall: openInstall ? { [weak self] url in self?.installs.append(url) } : nil,
            now: { clock.now },
            sleep: { ms in clock.advance(ms) })
    }

    var calls: [Call] { recorder.calls }
}

@MainActor
final class GithubConnectionTests: XCTestCase {
    func testDeviceFlowCodeWindowSlowDownTokenKeptEncryptedNoSecret() async throws {
        let polls = Box(0)
        let f = Setup({ call in
            if call.url.hasSuffix("/login/device/code") { return reply(200, ["device_code": "dev-1", "user_code": "WDJB-MJHT", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 5]) }
            if call.url.hasSuffix("/login/oauth/access_token") {
                polls.value += 1
                if polls.value == 1 { return reply(200, ["error": "authorization_pending"]) }
                if polls.value == 2 { return reply(200, ["error": "slow_down", "interval": 10]) }
                return reply(200, ["access_token": "ghu_first", "expires_in": 28800, "refresh_token": "ghr_first", "refresh_token_expires_in": 15897600, "token_type": "bearer"])
            }
            if call.url.hasSuffix("/user") { return user }
            return reply(404, [:])
        })
        let started = try await f.github.connect()
        XCTAssertEqual(started.pending?.userCode, "WDJB-MJHT")
        XCTAssertFalse(started.connected)
        XCTAssertEqual(f.opened, ["https://github.com/login/device"])
        await until { f.github.status().connected }
        let status = f.github.status()
        XCTAssertEqual([status.login, status.name, status.error], ["hudsonmp", "Hudson", ""])
        XCTAssertNil(status.pending)
        XCTAssertTrue(status.persisted)
        XCTAssertEqual(f.closed, 1, "the page closes once the token has come")
        XCTAssertEqual(f.changes.last?.connected, true)
        XCTAssertEqual(status.installUrl, "https://github.com/apps/engelbart-mathetic/installations/new")
        let polled = f.calls.filter { $0.url.hasSuffix("/access_token") }
        XCTAssertEqual(polled.count, 3)
        XCTAssertTrue(polled.allSatisfy { $0.form?["grant_type"] == "urn:ietf:params:oauth:grant-type:device_code" && $0.form?["client_id"] == CLIENT && $0.form?["client_secret"] == nil })
        XCTAssertEqual(f.calls.first { $0.url.hasSuffix("/user") }?.auth, "Bearer ghu_first")

        let kept = try String(contentsOfFile: f.file)
        XCTAssertFalse(kept.contains("ghu_first") || kept.contains("ghr_first"), "the tokens are never written in the clear")
        let mode = (try FileManager.default.attributesOfItem(atPath: f.file)[.posixPermissions] as! NSNumber).intValue
        XCTAssertEqual(mode & 0o777, 0o600)

        let later = FakeClock(1_000_000 + 60 * 1000)
        let (failing, _) = fakeHTTP { _ in reply(500, [:]) }
        let again = GithubConnection(http: failing, settings: { .init(clientId: CLIENT) }, file: { f.file }, crypt: ReversingCrypt(), now: { later.now })
        XCTAssertEqual(again.status().login, "hudsonmp", "a restart is still signed in")
        let first = await again.token()
        XCTAssertEqual(first, "ghu_first")
        later.advance(9 * 3600 * 1000)
        let none = await again.token()
        XCTAssertNil(none, "expired, and GitHub answers 500 to the refresh: nothing works now")
        XCTAssertTrue(again.status().connected, "but a bad moment at GitHub does not sign anyone out")
    }

    func testDeviceFlowFailures() async throws {
        let denied = Setup({ call in call.url.hasSuffix("/device/code") ? reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) : reply(200, ["error": "access_denied"]) })
        try await denied.github.connect()
        await until { denied.github.status().pending == nil }
        XCTAssertFalse(denied.github.status().connected)
        XCTAssertEqual(denied.github.status().error, "Cancelled on GitHub.")
        XCTAssertEqual(denied.closed, 1)

        let expiring = Setup({ call in call.url.hasSuffix("/device/code") ? reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 12, "interval": 5]) : reply(200, ["error": "authorization_pending"]) })
        try await expiring.github.connect()
        await until { expiring.github.status().pending == nil }
        XCTAssertEqual(expiring.github.status().error, "The code expired. Try again.")

        let disabled = Setup({ _ in reply(400, ["error": "device_flow_disabled"]) })
        await assertThrows({ try await disabled.github.connect() }, "Device flow is off")

        let unconfigured = Setup({ _ in reply(500, [:]) }, clientId: "")
        XCTAssertFalse(unconfigured.github.status().configured)
        await assertThrows({ try await unconfigured.github.connect() }, "client id in ~/\\.engelbart/config\\.json")
        XCTAssertEqual(unconfigured.calls.count, 0, "nothing is asked of GitHub without a client id")

        let polls = Box(0)
        let cancelled = Setup({ call in
            if call.url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
            polls.value += 1
            return reply(200, ["error": "authorization_pending"])
        })
        try await cancelled.github.connect()
        let again = try await cancelled.github.connect()
        XCTAssertEqual(cancelled.calls.filter { $0.url.hasSuffix("/device/code") }.count, 1, "asking again while a code waits shows the same code")
        XCTAssertEqual(cancelled.opened.count, 2, "and opens the page again")
        XCTAssertEqual(again.pending?.userCode, "AAAA-BBBB")
        cancelled.github.cancel()
        let after = polls.value
        await settle()
        XCTAssertLessThanOrEqual(polls.value, after + 1, "no more asking after cancel")
        XCTAssertNil(cancelled.github.status().pending)
    }

    func testTokensRefreshWithoutSecretRefusedRefreshSignsOut() async throws {
        let refreshes = Box(0)
        let f = Setup({ call in
            if call.url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
            if call.url.hasSuffix("/access_token") && call.form?["grant_type"] == "refresh_token" {
                refreshes.value += 1
                return refreshes.value == 1 ? reply(200, ["access_token": "ghu_second", "expires_in": 28800]) : reply(200, ["error": "bad_refresh_token"])
            }
            if call.url.hasSuffix("/access_token") { return reply(200, ["access_token": "ghu_first", "expires_in": 28800, "refresh_token": "ghr_first", "refresh_token_expires_in": 15897600]) }
            if call.url.hasSuffix("/user") { return user }
            return reply(404, [:])
        })
        try await f.github.connect()
        await until { f.github.status().connected }
        let t1 = await f.github.token()
        XCTAssertEqual(t1, "ghu_first")
        f.clock.advance(8 * 3600 * 1000 - 60 * 1000)
        async let a = f.github.token()
        async let b = f.github.token()
        let (ta, tb) = await (a, b)
        XCTAssertEqual([ta, tb], ["ghu_second", "ghu_second"])
        XCTAssertEqual(refreshes.value, 1, "two askers share one refresh")
        let refresh = f.calls.first { $0.form?["grant_type"] == "refresh_token" }
        XCTAssertEqual(refresh?.form, ["client_id": CLIENT, "grant_type": "refresh_token", "refresh_token": "ghr_first"])
        f.clock.advance(8 * 3600 * 1000)
        let t3 = await f.github.token()
        XCTAssertNil(t3, "the refresh token was kept and then refused")
        XCTAssertFalse(f.github.status().connected)
        XCTAssertEqual(f.github.status().error, "The GitHub sign-in expired. Sign in again.")
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.file))

        let revoked = Setup({ call in
            if call.url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
            if call.url.hasSuffix("/access_token") { return reply(200, ["access_token": "ghu_never_expires"]) }
            if call.url.hasSuffix("/user") { return user }
            return reply(401, ["message": "Bad credentials"])
        })
        try await revoked.github.connect()
        await until { revoked.github.status().connected }
        revoked.clock.advance(400 * 24 * 3600 * 1000)
        let never = await revoked.github.token()
        XCTAssertEqual(never, "ghu_never_expires", "an App that opted out of expiring tokens never refreshes")
        await assertThrows({ try await revoked.github.repos() }, "no longer accepts")
        XCTAssertFalse(revoked.github.status().connected)
    }

    func testRepositoriesEveryInstallationEveryPageOnceNewestFirst() async throws {
        @Sendable func repo(_ id: Int, _ full: String, _ pushed: String, _ priv: Bool = false) -> JSONValue {
            ["id": .number(Double(id)), "full_name": .string(full), "private": .bool(priv), "description": .string("about \(full)"), "pushed_at": .string(pushed)]
        }
        let many: [JSONValue] = (0..<100).map { i in repo(1000 + i, "Mathetic-PBC/r\(i)", "2026-01-01T00:00:\(String(format: "%02d", i % 60))Z") }
        let f = Setup({ call in
            let url = call.url
            if url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
            if url.hasSuffix("/access_token") { return reply(200, ["access_token": "ghu_first"]) }
            if url.hasSuffix("/user") { return user }
            if url.contains("/user/installations?") { return reply(200, ["total_count": 2, "installations": [["id": 11, "account": ["login": "Mathetic-PBC", "type": "Organization"], "repository_selection": "all"], ["id": 12, "account": ["login": "hudsonmp", "type": "User"], "repository_selection": "selected"]]]) }
            if url.contains("/installations/11/repositories") && url.contains("page=1") { return reply(200, ["repositories": .array(many)], headers: ["link": "<https://api.github.com/user/installations/11/repositories?page=2>; rel=\"next\""]) }
            if url.contains("/installations/11/repositories") && url.contains("page=2") { return reply(200, ["repositories": [repo(9, "Mathetic-PBC/engelbart-canvas", "2026-09-22T20:00:00Z", true)]]) }
            if url.contains("/installations/12/repositories") { return reply(200, ["repositories": [repo(9, "Mathetic-PBC/engelbart-canvas", "2026-09-22T20:00:00Z", true), repo(5, "hudsonmp/hudsonmp.github.io", "2026-09-20T00:00:00Z"), ["id": "x", "full_name": "bad"]]]) }
            return reply(404, [:])
        })
        await assertThrows({ try await f.github.repos() }, "Not signed in")
        try await f.github.connect()
        await until { f.github.status().connected }
        let list = try await f.github.repos()
        XCTAssertEqual(list.repos.count, 102, "a repository two installations share is listed once; nonsense is dropped")
        XCTAssertEqual(list.repos[0].fullName, "Mathetic-PBC/engelbart-canvas")
        XCTAssertTrue(list.repos[0].isPrivate)
        XCTAssertEqual(list.repos[0].url, "https://github.com/Mathetic-PBC/engelbart-canvas")
        XCTAssertEqual(list.repos[1].fullName, "hudsonmp/hudsonmp.github.io")
        XCTAssertFalse(list.repos[1].isPrivate)
        XCTAssertEqual(list.accounts, [GithubAccountInstall(login: "Mathetic-PBC", type: "Organization", all: true), GithubAccountInstall(login: "hudsonmp", type: "User", all: false)])
        XCTAssertTrue(f.calls.filter { $0.url.contains("/user/installations") }.allSatisfy { $0.auth == "Bearer ghu_first" })
    }

    func testMissingOrgsFromGithubAndTheMac() async throws {
        let base = "https://github.com/apps/engelbart-mathetic/installations/new"
        let asked = Box<[(String, [String])]>([])
        let script: (@escaping @Sendable () -> HTTPResponse) -> @Sendable (Call) async throws -> HTTPResponse = { orgs in
            { call in
                let url = call.url
                if url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
                if url.hasSuffix("/access_token") { return reply(200, ["access_token": "ghu_first"]) }
                if url.hasSuffix("/user") { return user }
                if url.contains("/user/installations?") { return reply(200, ["installations": [["id": 11, "account": ["login": "lab-a", "type": "Organization"], "repository_selection": "all"], ["id": 12, "account": ["login": "hudsonmp", "type": "User"], "repository_selection": "all"]]]) }
                if url.contains("/repositories") { return reply(200, ["repositories": []]) }
                if url.contains("/user/orgs?") { return orgs() }
                if url.hasSuffix("/users/karpathy") { return reply(200, ["id": 5, "login": "karpathy", "type": "User"]) }
                if url.hasSuffix("/users/lab-d") { return reply(200, ["id": 44, "login": "lab-d", "type": "Organization"]) }
                if url.hasSuffix("/users/lab-b") { return reply(500, [:]) }
                return reply(404, [:])
            }
        }
        let localOrgs: (String, [String]) async -> [MacOrg] = { login, dirs in
            asked.value.append((login, dirs))
            return [MacOrg(login: "Lab-A", repos: ["/r/a"]), MacOrg(login: "lab-b", repos: ["/r/b1", "/r/b2"]), MacOrg(login: "karpathy", repos: ["/r/k"]), MacOrg(login: "lab-d", repos: ["/r/d"]), MacOrg(login: "nobody-here", repos: ["/r/n"])]
        }
        let f = Setup(script({ reply(200, [["login": "LAB-B", "id": 22], ["login": "lab-c", "id": 33], ["login": "lab-a", "id": 11]]) }), localOrgs: localOrgs)
        try await f.github.connect()
        await until { f.github.status().connected }
        let list = try await f.github.repos(dirs: ["/picked/repo"])
        XCTAssertEqual(list.accounts.map(\.login), ["lab-a", "hudsonmp"])
        XCTAssertEqual(list.missingOrgs, [
            MissingOrg(login: "LAB-B", id: "22", repos: ["/r/b1", "/r/b2"], installUrl: "\(base)/permissions?target_id=22"),
            MissingOrg(login: "lab-c", id: "33", repos: [], installUrl: "\(base)/permissions?target_id=33"),
            MissingOrg(login: "lab-d", id: "44", repos: ["/r/d"], installUrl: "\(base)/permissions?target_id=44"),
        ])
        XCTAssertEqual(asked.value.last?.0, "hudsonmp")
        XCTAssertEqual(asked.value.last?.1, ["/picked/repo"])
        XCTAssertTrue(f.calls.filter { $0.url.contains("/user/orgs") }.allSatisfy { $0.auth == "Bearer ghu_first" })
        let lookups = f.calls.filter { $0.url.contains("/users/") }.count
        _ = try await f.github.repos()
        XCTAssertEqual(f.calls.filter { $0.url.contains("/users/") }.count, lookups, "an owner is looked up once (a login GitHub does not know too)")

        let failing = Setup(script({ reply(500, ["message": "down"]) }), localOrgs: localOrgs)
        try await failing.github.connect()
        await until { failing.github.status().connected }
        let got = try await failing.github.repos()
        XCTAssertEqual(got.missingOrgs.map(\.login), ["lab-b", "lab-d"], "/user/orgs failing leaves the remotes alone")
        XCTAssertEqual(got.missingOrgs[0].installUrl, base)
        XCTAssertTrue(failing.github.status().connected)
    }

    func testFreshSignInOpensInstallPageOnceRelaunchDoesNot() async throws {
        let installed = Box(false)
        let script: @Sendable (Call) async throws -> HTTPResponse = { call in
            let url = call.url
            if url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
            if url.hasSuffix("/access_token") { return reply(200, ["access_token": "ghu_first", "expires_in": 28800, "refresh_token": "ghr_first", "refresh_token_expires_in": 15897600]) }
            if url.hasSuffix("/user") { return user }
            if url.contains("/user/installations?") { return reply(200, ["installations": installed.value ? [["id": 11, "account": ["login": "hudsonmp", "type": "User"], "repository_selection": "all"]] : []]) }
            if url.contains("/repositories") { return reply(200, ["repositories": []]) }
            if url.contains("/user/orgs?") { return reply(200, []) }
            return reply(404, [:])
        }
        let f = Setup(script, openInstall: true)
        XCTAssertFalse(f.github.status().installHint)
        try await f.github.connect()
        await until { f.installs.count == 1 }
        XCTAssertEqual(f.installs, ["https://github.com/apps/engelbart-mathetic/installations/new"])
        XCTAssertTrue(f.github.status().installHint)
        XCTAssertEqual(f.changes.last?.installHint, true)
        installed.value = true
        _ = try await f.github.repos()
        XCTAssertFalse(f.github.status().installHint, "once installed and nothing missing, the hint goes")
        f.clock.advance(9 * 3600 * 1000)
        _ = await f.github.token()
        await settle()
        XCTAssertEqual(f.installs.count, 1, "a token refresh opens nothing")

        installed.value = false
        let relaunched = Box<[String]>([])
        let again = GithubConnection(http: f.http, settings: { .init(clientId: CLIENT, appSlug: "engelbart-mathetic") }, file: { f.file }, crypt: ReversingCrypt(),
                                     openInstall: { url in relaunched.value.append(url) }, now: { f.clock.now })
        XCTAssertTrue(again.status().connected)
        _ = try await again.repos()
        await settle()
        XCTAssertEqual(relaunched.value.count, 0)
        XCTAssertFalse(again.status().installHint, "a launch with a saved sign-in opens nothing")
    }

    func testWithoutKeychainSignInLastsUntilQuit() async throws {
        let f = Setup({ call in
            if call.url.hasSuffix("/device/code") { return reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "expires_in": 900, "interval": 5]) }
            if call.url.hasSuffix("/access_token") { return reply(200, ["access_token": "ghu_first"]) }
            return user
        }, crypt: NoKeychain())
        try await f.github.connect()
        await until { f.github.status().connected }
        XCTAssertFalse(f.github.status().persisted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.file))
        f.github.disconnect()
        XCTAssertFalse(f.github.status().connected)
        let token = await f.github.token()
        XCTAssertNil(token)
    }

    func testBrowserFlowSharesAttemptSavesMethodRefreshesThroughBroker() async throws {
        final class FakeBrowser: GithubBrowserAuthorizing, @unchecked Sendable {
            var started = 0, refreshed = 0, cancelled = 0
            var flow: BrowserFlow<JSONValue>?
            func start() async throws -> BrowserFlow<JSONValue> {
                started += 1
                let flow = BrowserFlow<JSONValue>(url: "https://engelbart.example/start", expiresAt: 9_999_999)
                flow.onFinish = { [weak self] in self?.cancelled += 0 }
                flow.cancelError = { [weak self] in self?.cancelled += 1; return GithubBrokerError(message: "GitHub sign-in cancelled.") }
                self.flow = flow
                return flow
            }
            func refresh(_ refreshToken: String) async throws -> JSONValue {
                refreshed += 1
                return ["access_token": "ghu_refreshed", "expires_in": 28800]
            }
        }
        let browser = FakeBrowser()
        let f = Setup({ _ in user }, browserAuth: browser)
        async let one = f.github.connect()
        async let two = f.github.connect()
        _ = try await (one, two)
        XCTAssertEqual(browser.started, 1)
        XCTAssertEqual(f.github.status().pending?.kind, "browser")
        XCTAssertNil(f.github.status().pending?.userCode)
        browser.flow?.finish(.success(["access_token": "ghu_browser", "refresh_token": "ghr_browser", "expires_in": 28800]))
        await until { f.github.status().connected }
        XCTAssertEqual(f.connected, 1)
        XCTAssertEqual(FileOps.readJSON(f.file)?["tokenFlow"]?.string, "browser")
        f.clock.advance(8 * 3600 * 1000)
        let refreshed = await f.github.token()
        XCTAssertEqual(refreshed, "ghu_refreshed")
        XCTAssertEqual(browser.refreshed, 1)
        f.github.disconnect()
        try await f.github.connect()
        f.github.cancel()
        browser.flow?.finish(.success(["access_token": "ghu_cancelled"]))
        await settle()
        XCTAssertFalse(f.github.status().connected)
        XCTAssertEqual(browser.cancelled, 1)
    }

    func testSignInFollowsItsFileOnePerDataRoot() async throws {
        let dir = tempDir("engelbart-github-roots")
        let roots = ["real": join(dir, "real"), "test": join(dir, "test")]
        FileOps.mkdir(roots["real"]!); FileOps.mkdir(roots["test"]!)
        let kept: JSONValue = ["v": 1, "login": "hudsonmp", "name": "", "avatarUrl": "", "id": "7", "access": .string(try ReversingCrypt().encrypt("ghu_real")),
                               "accessExpiresAt": .number(Date().timeIntervalSince1970 * 1000 + 3600e3), "refresh": .null, "refreshExpiresAt": .null, "tokenFlow": "browser"]
        try kept.text().write(toFile: join(roots["real"]!, "github.json"), atomically: true, encoding: .utf8)
        let mode = Box("real")
        let (http, _) = fakeHTTP { _ in reply(500, [:]) }
        let github = GithubConnection(http: http, settings: { .init(clientId: CLIENT) }, file: { join(roots[mode.value]!, "github.json") }, crypt: ReversingCrypt())
        XCTAssertEqual(github.status().login, "hudsonmp")
        mode.value = "test"
        XCTAssertFalse(github.status().connected, "test mode has its own, empty sign-in")
        github.disconnect()
        mode.value = "real"
        XCTAssertEqual(github.status().login, "hudsonmp", "signing out of test mode leaves the real sign-in")
        XCTAssertTrue(FileManager.default.fileExists(atPath: join(roots["real"]!, "github.json")))
    }

    func testChannelsOpenOnlyTheInstallPagesAndWaitingPage() async throws {
        let opened = Box<[String]>([])
        let f = Setup({ call in call.url.hasSuffix("/device/code") ? reply(200, ["device_code": "d", "user_code": "AAAA-BBBB", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 5]) : reply(200, ["error": "authorization_pending"]) })
        let channels = GithubChannels(github: f.github, openPage: { url in opened.value.append(url) })
        await assertThrows({ try await channels.open("device") }, "No sign-in is waiting")
        let base = "https://github.com/apps/engelbart-mathetic/installations/new"
        try await channels.open("install")
        try await channels.open("install", page: "\(base)/permissions?target_id=22")
        await assertThrows({ try await channels.open("install", page: "https://evil.example/") }, "Not the GitHub App's install page")
        _ = try await channels.connect()
        try await channels.open("device")
        XCTAssertEqual(opened.value, [base, "\(base)/permissions?target_id=22", "https://github.com/login/device"])
        let none = GithubChannels(github: nil, openPage: { _ in })
        XCTAssertEqual(none.status(), GithubStatus.unavailable)
        await assertThrows({ try await none.connect() }, "GitHub is not available")
        f.github.cancel()
    }
}

// test/github-browser-auth.test.cjs: PKCE, loopback and state, against the real loopback listener.
final class GithubBrowserAuthTests: XCTestCase {
    func testPKCELoopbackAndState() async throws {
        let exchanged = Box<JSONValue?>(nil)
        let broker = ClosureHTTPClient { request in
            exchanged.value = try JSONValue.parse(request.body ?? Data())
            return reply(200, ["access_token": "ghu_test"])
        }
        let auth = try GithubBrowserAuth(http: broker)
        let flow = try await auth.start()
        defer { flow.cancel() }
        let authorize = URLComponents(string: flow.url)!
        XCTAssertEqual("\(authorize.scheme!)://\(authorize.host!)", "https://engelbart.mathetic.com")
        let q = { (name: String) in authorize.queryItems!.first { $0.name == name }!.value! }
        let local = "http://127.0.0.1:\(q("port"))/oauth/github/callback"
        let plain = URLSessionHTTPClient()
        let wrong = try await plain.send(HTTPRequest(url: URL(string: "\(local)?state=wrong&code=test&ticket=ticket")!))
        XCTAssertEqual(wrong.status, 400)
        let right = "\(local)?state=\(q("state"))&code=test&ticket=ticket"
        let evil = try await plain.send(HTTPRequest(url: URL(string: right)!, headers: ["origin": "https://evil.example"]))
        XCTAssertEqual(evil.status, 403)
        let response = try await plain.send(HTTPRequest(url: URL(string: right)!))
        XCTAssertEqual(response.status, 200)
        let tokens = try await flow.result()
        XCTAssertEqual(tokens["access_token"]?.string, "ghu_test")
        XCTAssertEqual(PKCE.challenge(exchanged.value!["verifier"]!.string!), q("challenge"))
        XCTAssertEqual(exchanged.value!["code"]?.string, "test")
        XCTAssertFalse(response.text.contains("ghu_"))
        XCTAssertTrue(response.text.contains("GitHub connected"))
        XCTAssertEqual(response.header("cache-control"), "no-store")
    }

    func testCancellationAndTimeoutCloseTheListener() async throws {
        let auth = try GithubBrowserAuth(http: ClosureHTTPClient { _ in reply(500, [:]) })
        let flow = try await auth.start()
        flow.cancel()
        await assertThrows({ try await flow.result() }, "(?i)cancel")
        let port = URLComponents(string: flow.url)!.queryItems!.first { $0.name == "port" }!.value!
        await assertThrows({ try await URLSessionHTTPClient().send(HTTPRequest(url: URL(string: "http://127.0.0.1:\(port)/")!, timeout: 2)) }, ".")
        let expired = try await GithubBrowserAuth(http: ClosureHTTPClient { _ in reply(500, [:]) }, timeoutMs: 20).start()
        await assertThrows({ try await expired.result() }, "(?i)expired")
        let denied = try await auth.start()
        defer { denied.cancel() }
        let parts = URLComponents(string: denied.url)!.queryItems!
        let p = parts.first { $0.name == "port" }!.value!, s = parts.first { $0.name == "state" }!.value!
        let response = try await URLSessionHTTPClient().send(HTTPRequest(url: URL(string: "http://127.0.0.1:\(p)/oauth/github/callback?state=\(s)&error=access_denied")!))
        XCTAssertEqual(response.status, 200)
        await assertThrows({ try await denied.result() }, "(?i)cancel")
        XCTAssertThrowsError(try GithubBrowserAuth(broker: "http://broker.example"))
    }
}
