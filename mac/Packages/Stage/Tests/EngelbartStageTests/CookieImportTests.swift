import XCTest
import SQLite3
import CryptoKit
import EngelbartCore
@testable import EngelbartStage

// test/import-cookies.test.cjs, test/cookies-onboarding-beta.test.cjs (C1, C2) and test/installed-apps.test.cjs, ported.
// Fixtures only: Chromium databases encrypted with a known password, a Firefox database, Safari files, a fake Keychain
// and a fake cookie store. No real profile or Keychain is read.

private let password = "peanuts"
private let key = CookieFormats.deriveKey(password)
private func unixToChrome(_ s: Double) -> Double { (s + CookieFormats.windowsToUnixSeconds) * 1e6 }
private func v10(_ value: String, version: Int) -> Data {
    CookieFormats.encryptV10(value, key: key, hashPrefix: version >= 24 ? Data(SHA256.hash(data: Data("host.example".utf8))) : nil)
}

private func exec(_ db: OpaquePointer?, _ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }
private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct CRow { var host: String; var name: String; var value = ""; var secure = false; var httpOnly = false; var samesite = -1; var persistent = true; var bad = false; var topFrame = ""; var expiresUtc: Double? = nil }
private func makeChromiumDb(_ file: String, _ version: Int, _ rows: [CRow]) {
    try? FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    var db: OpaquePointer?
    sqlite3_open(file, &db)
    exec(db, "CREATE TABLE meta (key TEXT NOT NULL, value TEXT); INSERT INTO meta VALUES ('version', '\(version)');")
    exec(db, "CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, is_persistent INTEGER)")
    for row in rows {
        var st: OpaquePointer?
        sqlite3_prepare_v2(db, "INSERT INTO cookies VALUES (?, ?, ?, '', ?, '/', ?, ?, ?, ?, ?, ?)", -1, &st, nil)
        let enc = row.bad ? Data("v10not-a-valid-block".utf8) : v10(row.value, version: version)
        sqlite3_bind_text(st, 1, row.host, -1, transient)
        sqlite3_bind_text(st, 2, row.topFrame, -1, transient)
        sqlite3_bind_text(st, 3, row.name, -1, transient)
        _ = enc.withUnsafeBytes { sqlite3_bind_blob(st, 4, $0.baseAddress, Int32(enc.count), transient) }
        sqlite3_bind_int64(st, 5, Int64(row.expiresUtc ?? unixToChrome(4_102_444_800)))
        sqlite3_bind_int(st, 6, row.secure ? 1 : 0); sqlite3_bind_int(st, 7, row.httpOnly ? 1 : 0); sqlite3_bind_int(st, 8, Int32(row.samesite))
        sqlite3_bind_int(st, 9, row.persistent ? 1 : 0); sqlite3_bind_int(st, 10, row.persistent ? 1 : 0)
        sqlite3_step(st); sqlite3_finalize(st)
    }
    sqlite3_close(db)
}

struct FRow { var host: String; var name: String; var value: String; var expiry: Int64 = 0; var secure = false; var httpOnly = false; var samesite = 0; var origin = "" }
private func makeFirefoxDb(_ file: String, _ rows: [FRow], schema: Int = 14) {
    try? FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    var db: OpaquePointer?
    sqlite3_open(file, &db)
    exec(db, "PRAGMA user_version = \(schema)")
    exec(db, "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, creationTime INTEGER, lastAccessed INTEGER)")
    for row in rows {
        let expiry = schema >= 14 ? row.expiry * 1000 : row.expiry
        exec(db, "INSERT INTO moz_cookies (originAttributes, host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, creationTime, lastAccessed) VALUES ('\(row.origin)', '\(row.host)', '\(row.name)', '\(row.value)', '/', \(expiry), \(row.secure ? 1 : 0), \(row.httpOnly ? 1 : 0), \(row.samesite), 16700000000000000, 16700000000000000)")
    }
    sqlite3_close(db)
}

final class FakeStore: StageCookieStore {
    var calls: [CookieSetDetails] = []
    var flushes = 0
    func set(_ details: CookieSetDetails) async throws { calls.append(details) }
    func names(for url: String) async -> Set<String>? {
        let asked = JSURL(url)?.hostname ?? ""
        return Set(calls.filter { d in
            let host = d.domain.map { $0.hasPrefix(".") ? String($0.dropFirst()) : $0 } ?? (JSURL(d.url)?.hostname ?? "")
            return asked == host || (d.domain != nil && asked.hasSuffix(".\(host)"))
        }.map(\.name))
    }
    func flush() async { flushes += 1 }
}

private func fakeProbe(_ script: [String: Any]) -> (String, Bool, TimeInterval) async -> SignInCheck.Response? {
    { url, _, timeout in
        switch script[url] {
        case let status as Int: return SignInCheck.Response(status: status)
        case let r as (Int, String): return SignInCheck.Response(status: r.0, location: r.1)
        case let s as String where s == "hang": try? await Task.sleep(nanoseconds: UInt64(timeout * 1e9)); return nil
        default: return nil
        }
    }
}

final class CookieImportTests: XCTestCase {
    var home: URL!
    var support: URL { home.appendingPathComponent("Library/Application Support") }
    var userData: URL { home.appendingPathComponent("userData") }

    override func setUp() {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("home-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: userData, withIntermediateDirectories: true)
        let brave = support.appendingPathComponent("BraveSoftware/Brave-Browser")
        try? FileManager.default.createDirectory(at: brave.appendingPathComponent("Default/Network"), withIntermediateDirectories: true)
        try? #"{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}"#.write(to: brave.appendingPathComponent("Local State"), atomically: true, encoding: .utf8)
        makeChromiumDb(brave.appendingPathComponent("Default/Network/Cookies").path, 24, [
            CRow(host: ".github.com", name: "user_session", value: "gh-secret", secure: true, httpOnly: true, samesite: 1),
            CRow(host: ".github.com", name: "__Host-user_session_same_site", value: "gh-host", secure: true, httpOnly: true, samesite: 1),
            CRow(host: ".google.com", name: "SID", value: "g-secret", secure: true, httpOnly: true, samesite: 0),
            CRow(host: ".github.com", name: "session_only", value: "ephemeral", secure: true, persistent: false),
            CRow(host: ".github.com", name: "broken", bad: true),
            CRow(host: ".unrelated.com", name: "x", value: "skip-me", secure: true),
            CRow(host: ".github.com", name: "user_session", value: "gh-partitioned", secure: true, httpOnly: true, samesite: 0, topFrame: "https://embedder.example"),
            CRow(host: ".github.com", name: "old_session", value: "gh-expired", secure: true, expiresUtc: unixToChrome(1_600_000_000)),
        ])
        makeFirefoxDb(support.appendingPathComponent("Firefox/Profiles/abcd.default-release/cookies.sqlite").path, [
            FRow(host: ".overleaf.com", name: "overleaf_session2", value: "ol-secret", expiry: 1_893_456_000, secure: true, httpOnly: true, samesite: 2),
            FRow(host: ".overleaf.com", name: "overleaf_session2", value: "ol-container", expiry: 1_893_456_000, secure: true, httpOnly: true, samesite: 2, origin: "^userContextId=1"),
            FRow(host: ".overleaf.com", name: "gclb", value: "ol-expired", expiry: 1_600_000_000, secure: true),
        ])
    }
    override func tearDown() { try? FileManager.default.removeItem(at: home) }

    func importer(store: FakeStore = FakeStore(), probe: [String: Any]? = nil, keychain: @escaping (String) async throws -> String = { _ in password },
                  installed: ((String) -> Bool)? = nil, settled: ((String) async -> Bool)? = nil, timeout: TimeInterval = 10) -> CookieImport {
        CookieImport(supportDir: support, userDataDir: userData, store: { store }, probe: probe.map(fakeProbe), keychain: keychain,
                     now: { Date(timeIntervalSince1970: 1_791_244_800) }, checkTimeout: timeout, installed: installed, settled: settled, homeDir: home.path, fullDiskAccess: { false })
    }

    func testDecryption() {
        XCTAssertEqual(CookieFormats.decryptChromiumValue(v10("plain", version: 20), plainValue: "", key: key, metaVersion: 20), "plain")
        XCTAssertEqual(CookieFormats.decryptChromiumValue(v10("hashed", version: 24), plainValue: "", key: key, metaVersion: 24), "hashed")
        XCTAssertNotEqual(CookieFormats.decryptChromiumValue(v10("hashed", version: 24), plainValue: "", key: key, metaVersion: 20), "hashed")
        XCTAssertEqual(CookieFormats.decryptChromiumValue(Data(), plainValue: "clear", key: key, metaVersion: 24), "clear")
        XCTAssertNil(CookieFormats.decryptChromiumValue(Data("v10short".utf8), plainValue: "", key: key, metaVersion: 24))
        XCTAssertNil(CookieFormats.decryptChromiumValue(v10("x", version: 24), plainValue: "", key: nil, metaVersion: 24))
        // the PBKDF2 key Chromium derives from "peanuts" (a published test vector: Chromium's own os_crypt tests)
        XCTAssertEqual(CookieFormats.deriveKey("peanuts").map { String(format: "%02x", $0) }.joined().count, 32)
    }

    func testTimesSameSiteDetailsDomains() {
        XCTAssertEqual(CookieFormats.chromeTimeToUnixSeconds(unixToChrome(1_893_456_000)), 1_893_456_000)
        XCTAssertEqual(CookieFormats.chromeTimeToUnixSeconds(0), 0); XCTAssertEqual(CookieFormats.chromeTimeToUnixSeconds(-1), 0)
        XCTAssertEqual(CookieFormats.sameSiteOf(CookieFormats.chromiumSameSite, -1), "unspecified")
        XCTAssertEqual(CookieFormats.sameSiteOf(CookieFormats.chromiumSameSite, 0), "no_restriction")
        XCTAssertEqual(CookieFormats.sameSiteOf(CookieFormats.chromiumSameSite, 1), "lax")
        XCTAssertEqual(CookieFormats.sameSiteOf(CookieFormats.chromiumSameSite, 2), "strict")
        XCTAssertEqual(CookieFormats.sameSiteOf(CookieFormats.firefoxSameSite, 0), "unspecified")
        XCTAssertEqual(CookieFormats.sameSiteOf(CookieFormats.firefoxSameSite, 2), "strict")
        let domain = CookieFormats.cookieSetDetails(ImportedCookie(host: ".github.com", name: "user_session", value: "v", path: "/", secure: true, httpOnly: true, sameSite: "lax", persistent: true, expires: 1_893_456_000))
        XCTAssertEqual(domain.url, "https://github.com/"); XCTAssertEqual(domain.domain, ".github.com"); XCTAssertEqual(domain.expirationDate, 1_893_456_000)
        XCTAssertNil(CookieFormats.cookieSetDetails(ImportedCookie(host: "github.com", name: "a", value: "v", path: "/", secure: true, httpOnly: false, sameSite: "", persistent: true, expires: 1)).domain)
        XCTAssertNil(CookieFormats.cookieSetDetails(ImportedCookie(host: ".github.com", name: "__Host-x", value: "v", path: "/", secure: true, httpOnly: false, sameSite: "", persistent: true, expires: 1)).domain)
        let session = CookieFormats.cookieSetDetails(ImportedCookie(host: "github.com", name: "s", value: "v", path: "/", secure: false, httpOnly: false, sameSite: "", persistent: false, expires: 0))
        XCTAssertNil(session.expirationDate); XCTAssertEqual(session.url, "http://github.com/")
        XCTAssertEqual(domain.httpCookie?.domain, ".github.com"); XCTAssertTrue(domain.httpCookie?.isHTTPOnly ?? false)
        XCTAssertTrue(session.httpCookie?.isSessionOnly ?? false)
        XCTAssertEqual(CookieFormats.registrableDomain(".www.github.com"), "github.com")
        XCTAssertEqual(CookieFormats.registrableDomain("accounts.google.com"), "google.com")
        XCTAssertEqual(CookieFormats.registrableDomain("sub.example.co.uk"), "example.co.uk")
        XCTAssertTrue(CookieFormats.boundToBrowser(host: ".google.co.uk", name: "SIDCC")); XCTAssertFalse(CookieFormats.boundToBrowser(host: ".google.com", name: "SID"))
    }

    func testDatabases() throws {
        let tmp = home.appendingPathComponent("tmp"); try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        for version in [20, 24] {
            let file = tmp.appendingPathComponent("Cookies-\(version)").path
            makeChromiumDb(file, version, [CRow(host: ".github.com", name: "user_session", value: "abc", secure: true, httpOnly: true, samesite: 1), CRow(host: "github.com", name: "logged_in", value: "yes", secure: true, samesite: 2), CRow(host: ".github.com", name: "broken", bad: true)])
            let read = try CookieFormats.withCopy(file, tmpBase: tmp, CookieFormats.readChromiumDb)
            let (cookies, skipped) = CookieFormats.normalizeChromium(version: read.version, rows: read.rows, key: key, now: 1_791_244_800)
            XCTAssertEqual(skipped, 1); XCTAssertEqual(cookies.map(\.value).sorted(), ["abc", "yes"]); XCTAssertEqual(cookies.first { $0.name == "user_session" }?.sameSite, "lax")
        }
        for schema in [12, 13, 14, 15] {
            let file = tmp.appendingPathComponent("cookies-\(schema).sqlite").path
            makeFirefoxDb(file, [FRow(host: ".overleaf.com", name: "overleaf_session2", value: "ff-value", expiry: 1_893_456_000, secure: true, httpOnly: true, samesite: 2)], schema: schema)
            let read = try CookieFormats.withCopy(file, tmpBase: tmp, CookieFormats.readFirefoxDb)
            XCTAssertEqual(read.schema, schema)
            let cookies = CookieFormats.normalizeFirefox(rows: read.rows, now: 1_791_244_800).cookies
            XCTAssertEqual(cookies[0].value, "ff-value"); XCTAssertEqual(cookies[0].expires, 1_893_456_000); XCTAssertEqual(cookies[0].sameSite, "strict")
        }
        // expired and partitioned rows left out uncounted
        let now = 1_790_000_000.0
        let chromium = tmp.appendingPathComponent("Cookies").path
        makeChromiumDb(chromium, 24, [CRow(host: ".github.com", name: "live", value: "yes", expiresUtc: unixToChrome(now + 3600)), CRow(host: ".github.com", name: "gone", value: "old", expiresUtc: unixToChrome(now - 3600)),
                                      CRow(host: ".github.com", name: "gone_bad", bad: true, expiresUtc: unixToChrome(now - 3600)), CRow(host: ".github.com", name: "session", value: "s", persistent: false, expiresUtc: 0),
                                      CRow(host: "github.com", name: "user_session", value: "third-party", topFrame: "https://embedder.example")])
        let read = try CookieFormats.withCopy(chromium, tmpBase: tmp, CookieFormats.readChromiumDb)
        let got = CookieFormats.normalizeChromium(version: read.version, rows: read.rows, key: key, now: Int(now))
        XCTAssertEqual(got.cookies.map(\.name).sorted(), ["live", "session"]); XCTAssertEqual(got.skipped, 0)
        let before = try FileManager.default.contentsOfDirectory(atPath: tmp.path).count
        XCTAssertThrowsError(try CookieFormats.withCopy(chromium, tmpBase: tmp) { _ -> Int in throw CookieImportError(message: "boom") })
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tmp.path).count, before)
    }

    func testVerdicts() {
        let github = SignInCheck.byDomain("github.com")!
        XCTAssertEqual(github.result(.init(status: 200)), true)
        XCTAssertEqual(github.result(.init(status: 302, location: "https://github.com/login")), false)
        XCTAssertEqual(github.result(.init(status: 302)), nil as Bool?)
        XCTAssertEqual(github.result(.init(status: 0)), nil as Bool?)
        XCTAssertEqual(github.result(.init(status: 401)), false)
        for status in [403, 404, 429, 500, 503] { XCTAssertEqual(github.result(.init(status: status)), nil as Bool?, "\(status)") }
        XCTAssertEqual(github.result(nil), nil as Bool?)
        XCTAssertEqual(github.result(.init(status: 200), held: ["logged_in"]), false, "no session cookie: signed out")
        let claude = SignInCheck.byDomain("claude.ai")!
        XCTAssertEqual(claude.result(.init(status: 403, body: #"{"type":"error","error":{"type":"permission_error","message":"Invalid authorization","details":{"error_code":"account_session_invalid"}}}"#)), false)
        XCTAssertEqual(claude.result(.init(status: 403, body: "<html>cloudflare</html>")), nil as Bool?)
        let zotero = SignInCheck.byDomain("zotero.org")!
        XCTAssertEqual(zotero.result(.init(status: 303, location: "/user/login")), false)
        XCTAssertEqual(SignInCheck.byDomain("overleaf.com")!.result(.init(status: 302, location: "https://www.overleaf.com/login")), false)
        XCTAssertEqual(SignInCheck.byDomain("evernote.com")!.result(.init(status: 302, location: "https://www.evernote.com/Login.action")), false)
        XCTAssertEqual(SignInCheck.defaultDomains, ["github.com", "google.com", "overleaf.com", "zotero.org"])
        XCTAssertEqual(SignInCheck.shownLocation("https://accounts.google.com/ServiceLogin?continue=x", from: "https://drive.google.com/"), "https://accounts.google.com/ServiceLogin")
    }

    func testSourcesAndProfiles() throws {
        let sources = importer().sources()
        XCTAssertEqual(sources.first { $0.id == "brave" }?.profiles.map(\.name), ["Personal"])
        XCTAssertEqual(sources.first { $0.id == "firefox" }?.profiles.first?.name, "abcd.default-release")
        XCTAssertNil(sources.first { $0.id == "safari" }, "Safari locked without an install check: not listed")
        let ff = support.appendingPathComponent("Firefox")
        makeFirefoxDb(ff.appendingPathComponent("Profiles/wxyz.work/cookies.sqlite").path, [])
        makeFirefoxDb(ff.appendingPathComponent("Profiles/nnnn.other/cookies.sqlite").path, [])
        try "[Install123]\nDefault=Profiles/abcd.default-release\n\n[Profile1]\nName=Work stuff\nIsRelative=1\nPath=Profiles/wxyz.work\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd.default-release\nDefault=1\n\n[General]\nVersion=2\n".write(to: ff.appendingPathComponent("profiles.ini"), atomically: true, encoding: .utf8)
        XCTAssertEqual(importer().sources().first { $0.id == "firefox" }?.profiles.sorted { $0.id < $1.id }.map(\.name), ["default-release", "nnnn.other", "Work stuff"])
        let brave = support.appendingPathComponent("BraveSoftware/Brave-Browser")
        makeChromiumDb(brave.appendingPathComponent("Profile 1/Network/Cookies").path, 24, [])
        try #"{"profile":{"info_cache":{"Default":{"name":"Personal","user_name":""},"Profile 1":{"name":"Work","user_name":"me@work.example"}}}}"#.write(to: brave.appendingPathComponent("Local State"), atomically: true, encoding: .utf8)
        let profiles = importer().sources().first { $0.id == "brave" }!.profiles
        XCTAssertEqual(profiles.map(\.id), ["Default", "Profile 1"]); XCTAssertEqual(profiles[1].email, "me@work.example"); XCTAssertNil(profiles[0].email)
        // a browser counts only with its app installed
        var asked: [String] = []
        let only = importer(installed: { asked.append($0); return $0 == "org.mozilla.firefox" })
        XCTAssertEqual(only.sources().map(\.id), ["firefox"])
        XCTAssertTrue(asked.contains("com.brave.Browser"))
        XCTAssertThrowsError(try only.cookieNames("brave", "Default", ["google.com"]))
    }

    func testDomainsListCountsOnly() throws {
        var keychainCalled = false
        let imp = importer(keychain: { _ in keychainCalled = true; return password })
        let result = try imp.domains("brave", "Default")
        XCTAssertFalse(keychainCalled)
        XCTAssertEqual(result.domains.first { $0.domain == "github.com" }?.count, 4)
        XCTAssertEqual(try imp.domains("firefox", "abcd.default-release").domains.first { $0.domain == "overleaf.com" }?.count, 1)
        XCTAssertEqual(result.defaults, ["github.com", "google.com", "overleaf.com", "zotero.org"])
        let names = try imp.cookieNames("brave", "Default", ["github.com"])
        XCTAssertEqual(Set(names.map(\.name)), ["user_session", "__Host-user_session_same_site", "session_only", "broken"])
    }

    func testImportWritesCountsAndChecks() async throws {
        let store = FakeStore()
        let imp = importer(store: store, probe: ["https://github.com/settings/profile": 200, "https://drive.google.com/drive/u/0/": (302, "https://accounts.google.com/ServiceLogin?service=wise")])
        let result = try await imp.run(browser: "brave", profile: "Default", domains: ["github.com", "google.com"])
        XCTAssertEqual([result.imported, result.skipped, result.sessionOnly], [4, 1, 1])
        XCTAssertEqual(store.flushes, 1)
        XCTAssertFalse(store.calls.map(\.name).contains("old_session"))
        XCTAssertEqual(store.calls.filter { $0.name == "user_session" }.map(\.value), ["gh-secret"])
        XCTAssertEqual(store.calls.first { $0.name == "user_session" }?.domain, ".github.com")
        XCTAssertNil(store.calls.first { $0.name == "__Host-user_session_same_site" }?.domain)
        XCTAssertEqual(result.checks.first { $0.site == "GitHub" }?.signedIn, true)
        XCTAssertEqual(result.checks.first { $0.site == "Google" }?.signedIn, false)
        let record = try String(contentsOf: userData.appendingPathComponent("browser-imports.json"), encoding: .utf8)
        for secret in ["gh-secret", "gh-host", "g-secret", "ephemeral", "skip-me", "gh-partitioned", "gh-expired"] {
            XCTAssertFalse(record.contains(secret)); XCTAssertFalse("\(result)".contains(secret))
        }
    }

    func testDenialAndEmptyAndFirefox() async throws {
        let store = FakeStore()
        do { _ = try await importer(store: store, keychain: { _ in throw CookieImportError(message: "Keychain access was denied", denied: true) }).run(browser: "brave", profile: "Default", domains: ["github.com"]); XCTFail() }
        catch let e as CookieImportError { XCTAssertTrue(e.denied); XCTAssertEqual(e.browser, "Brave"); XCTAssertTrue(e.message.contains("Nothing was imported")) }
        XCTAssertEqual(store.calls.count, 0); XCTAssertEqual(store.flushes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: userData.appendingPathComponent("browser-imports.json").path))
        do { _ = try await importer(store: store, keychain: { _ in throw CookieImportError(message: "The Keychain has no such key", notFound: true) }).run(browser: "brave", profile: "Default", domains: ["github.com"]); XCTFail() }
        catch let e as CookieImportError { XCTAssertTrue(e.notFound); XCTAssertEqual(e.message, "Engelbart couldn't find Brave's key in the Keychain, so its cookies can't be read. Nothing was imported.") }
        var asked = false
        let empty = try await importer(store: store, keychain: { _ in asked = true; return password }).run(browser: "brave", profile: "Default", domains: [])
        XCTAssertEqual([empty.imported, empty.skipped], [0, 0]); XCTAssertFalse(asked); XCTAssertEqual(store.flushes, 0)
        var keychainCalled = false
        let ff = try await importer(store: store, probe: ["https://www.overleaf.com/project": 200], keychain: { _ in keychainCalled = true; return password }).run(browser: "firefox", profile: "abcd.default-release", domains: ["overleaf.com"])
        XCTAssertFalse(keychainCalled); XCTAssertEqual(ff.imported, 1); XCTAssertEqual(store.calls[0].value, "ol-secret"); XCTAssertEqual(store.calls[0].expirationDate, 1_893_456_000)
        XCTAssertEqual(ff.checks.first?.signedIn, true)
        let record = Files.readJSON(userData.appendingPathComponent("browser-imports.json"))?.array
        XCTAssertEqual(record?.count, 1); XCTAssertEqual(record?[0]["domains"], ["overleaf.com"]); XCTAssertEqual(record?[0]["browser"], "firefox")
    }

    func testGoogleBoundCookies() async throws {
        let chrome = support.appendingPathComponent("Google/Chrome/Default/Network/Cookies").path
        let bound = ["SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-STRP", "AEC"]
        makeChromiumDb(chrome, 24, [CRow(host: ".google.com", name: "SID", value: "g-sid", secure: true), CRow(host: ".google.com", name: "__Secure-1PSID", value: "g-1psid", secure: true)]
                       + bound.map { CRow(host: $0 == "__Secure-STRP" ? "accounts.google.com" : ".google.com", name: $0, value: "bound-\($0)", secure: true) }
                       + [CRow(host: ".example.com", name: "SIDCC", value: "not-google", secure: true)])
        let store = FakeStore()
        let result = try await importer(store: store).run(browser: "chrome", profile: "Default", domains: ["google.com", "example.com"], quiet: true)
        XCTAssertEqual([result.imported, result.skipped], [3, bound.count])
        XCTAssertEqual(store.calls.first { $0.name == "SIDCC" }?.value, "not-google")
        XCTAssertFalse(FileManager.default.fileExists(atPath: userData.appendingPathComponent("browser-imports.json").path), "quiet: no record")
    }

    func testChecksTimeoutGithubGateAndUnlock() async throws {
        let got1 = await importer(probe: ["https://drive.google.com/drive/u/0/": 200]).check("google.com")
        XCTAssertEqual(got1, true)
        let got2 = await importer(probe: ["https://drive.google.com/drive/u/0/": (302, "https://accounts.google.com/v3/signin/identifier?x")]).check("google.com")
        XCTAssertEqual(got2, false)
        let got3 = await importer(probe: ["https://drive.google.com/drive/u/0/": "hang"], timeout: 0.05).check("google.com")
        XCTAssertEqual(got3, nil as Bool?)
        let got4 = await importer(probe: [:]).check("google.com")
        XCTAssertEqual(got4, nil as Bool?)
        let got5 = await importer(probe: [:]).check("chatgpt.com")
        XCTAssertEqual(got5, nil as Bool?)
        let got6 = await importer(probe: ["https://drive.google.com/drive/u/0/": 429]).check("google.com")
        XCTAssertEqual(got6, nil as Bool?)
        let gh = await importer(probe: ["https://github.com/settings/profile": 200]).checkDetail("github.com")
        XCTAssertEqual(gh?.signedIn, false); XCTAssertEqual(gh?.reason, "no-session-cookie")
        var asked: [String] = []
        let got7 = try await importer(keychain: { asked.append($0); return password }).unlock("brave")
        XCTAssertEqual(got7, true)
        let got8 = try await importer(keychain: { asked.append($0); return password }).unlock("firefox")
        XCTAssertEqual(got8, false)
        XCTAssertEqual(asked, ["Brave Safe Storage"])
        var keyAsked: [String] = []
        let notThere = importer(keychain: { keyAsked.append($0); return password }, installed: { _ in true }, settled: { $0 != "com.brave.Browser" })
        let got9 = await notThere.ready("brave")
        XCTAssertEqual(got9, false)
        do { _ = try await notThere.unlock("brave"); XCTFail() } catch let e as CookieImportError { XCTAssertTrue(e.notInstalled) }
        XCTAssertEqual(keyAsked, [])
        let got10 = await notThere.ready("firefox")
        XCTAssertEqual(got10, true)
    }

    func testKeychainRunner() async throws {
        let ok: KeychainRunner.Run = { file, args, _ in
            XCTAssertEqual(file, "/usr/bin/security"); XCTAssertEqual(args, ["find-generic-password", "-w", "-s", "Chrome Safe Storage"])
            return KeychainRunner.Output(status: 0, stdout: "s3cret\n")
        }
        let secret = try await KeychainRunner.read("Chrome Safe Storage", run: ok); XCTAssertEqual(secret, "s3cret")
        for (code, notFound, denied) in [(Int32(44), true, false), (128, false, true), (51, false, true), (1, false, false)] {
            let run: KeychainRunner.Run = { _, _, _ in KeychainRunner.Output(status: code) }
            do { _ = try await KeychainRunner.read("x", run: run); XCTFail() } catch let e as CookieImportError { XCTAssertEqual(e.notFound, notFound, "\(code)"); XCTAssertEqual(e.denied, denied, "\(code)") }
        }
        let late: KeychainRunner.Run = { _, _, _ in throw ProcessRunnerError.timedOut("security") }
        do { _ = try await KeychainRunner.read("x", run: late); XCTFail() } catch let e as CookieImportError { XCTAssertTrue(e.denied); XCTAssertTrue(e.timedOut) }
    }

    // C1: Safari's binarycookies
    func testSafariParser() throws {
        let expires = 1_893_456_000.0 - SafariCookies.macEpochUnix, created = 1_700_000_000.0 - SafariCookies.macEpochUnix
        let data = SafariCookies.makeBinaryCookies([[("." + "github.com", "user_session", "/", "s-gh", 0x5, expires, created), ("zotero.org", "z", "", "zv", 0, 0, created)], [("example.com", "e", "/x", "ev", 0x1, expires, created)]])
        let parsed = try SafariCookies.parseBinaryCookies(data)
        XCTAssertEqual(parsed.skipped, 0)
        XCTAssertEqual(parsed.cookies.map(\.name), ["user_session", "z", "e"])
        XCTAssertEqual(parsed.cookies[0], SafariCookies.Cookie(host: ".github.com", name: "user_session", value: "s-gh", path: "/", expires: 1_893_456_000, created: 1_700_000_000, secure: true, httpOnly: true))
        XCTAssertEqual(parsed.cookies[1].path, "/"); XCTAssertEqual(parsed.cookies[1].expires, 0); XCTAssertFalse(parsed.cookies[1].secure)
        XCTAssertThrowsError(try SafariCookies.parseBinaryCookies(Data("nope1234".utf8)))
        var broken = [UInt8](data)
        broken[8 + 8 + 8 + 4] = 0xff // the second page's... a record offset of the first page off the end
        let partly = try SafariCookies.parseBinaryCookies(Data(broken))
        XCTAssertEqual(partly.cookies.count + partly.skipped, 3)
        XCTAssertTrue(SafariCookies.kept(parsed.cookies[1], now: 2_000_000_000), "no expiry on disk: live")
        XCTAssertFalse(SafariCookies.kept(parsed.cookies[0], now: 2_000_000_000))
    }

    func testSafariLockedAndWithAccess() async throws {
        // without Full Disk Access: one locked profile, never touched, needs disk-access
        let locked = importer(installed: { $0 == "com.apple.Safari" })
        XCTAssertEqual(locked.sources().first { $0.id == "safari" }?.profiles.first?.locked, true)
        XCTAssertEqual(try locked.domains("safari", "Default").needs, "disk-access")
        let lockedRun = try await locked.run(browser: "safari", profile: "Default", domains: ["github.com"]); XCTAssertEqual(lockedRun.needs, "disk-access")
        XCTAssertFalse(locked.canRead("safari"))
        // with it: the container's file, then a Safari 17 profile by UUID
        let expires = 1_893_456_000.0 - SafariCookies.macEpochUnix
        let main = SafariCookies.containerFile(home.path)
        try FileManager.default.createDirectory(atPath: (main as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: main, contents: SafariCookies.makeBinaryCookies([[(".github.com", "user_session", "/", "s-gh", 0x5, expires, 1)]]))
        let uuid = "5F3C1A2B-1111-2222-3333-444455556666"
        let other = (SafariCookies.profilesDir(home.path) as NSString).appendingPathComponent("\(uuid)/Cookies/Cookies.binarycookies")
        try FileManager.default.createDirectory(atPath: (other as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: other, contents: SafariCookies.makeBinaryCookies([[(".zotero.org", "zsess", "/", "zz", 0x1, expires, 1)]]))
        let store = FakeStore()
        let open = CookieImport(supportDir: support, userDataDir: userData, store: { store }, keychain: { _ in XCTFail("no Keychain for Safari"); return "" }, homeDir: home.path, fullDiskAccess: { true })
        let profiles = open.sources().first { $0.id == "safari" }!.profiles
        XCTAssertEqual(profiles.map(\.name), ["Personal", "Profile 1"]); XCTAssertEqual(profiles[1].id, uuid)
        let result = try await open.run(browser: "safari", profile: "Default", domains: ["github.com"], quiet: true)
        XCTAssertEqual(result.imported, 1); XCTAssertEqual(store.calls[0].sameSite, "unspecified"); XCTAssertEqual(store.calls[0].expirationDate, 1_893_456_000)
        // the old ~/Library/Cookies file is the fallback
        try FileManager.default.removeItem(atPath: main)
        let old = SafariCookies.oldFile(home.path)
        try FileManager.default.createDirectory(atPath: (old as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: old, contents: SafariCookies.makeBinaryCookies([]))
        XCTAssertEqual(try SafariCookies.defaultCookieFile(home.path), old)
    }
}

final class InstalledAppsTests: XCTestCase {
    func fakeFS(_ files: [String: String], dirs: [String: [String]] = [:]) -> InstalledApps.FS {
        InstalledApps.FS(readdir: { if let d = dirs[$0] { return d }; throw CookieImportError(message: "none") }, readFile: { files[$0] }, exists: { p in files[p] != nil || files.keys.contains { $0.hasPrefix(p + "/") } })
    }
    let plist = { (id: String) in "<plist><dict><key>CFBundleIdentifier</key>\n<string>\(id)</string></dict></plist>" }

    func testLocalFirst() async {
        var asked: [String] = []
        let apps = InstalledApps(appDirs: ["/Applications"], spotlight: { asked.append($0); return false }, override: nil,
                                 fs: fakeFS(["/Applications/Google Chrome.app/Contents/Info.plist": plist("com.google.Chrome"), "/Applications/Thorium.app/Contents/Info.plist": plist("org.chromium.Chromium"), "/Applications/Brave Browser.app/Contents/Info.plist": plist("com.other")],
                                            dirs: ["/Applications": ["Google Chrome.app", "Thorium.app", "Brave Browser.app"]]))
        XCTAssertTrue(apps.has("com.google.Chrome"))
        XCTAssertTrue(apps.has("org.chromium.Chromium"), "any app whose plist names it")
        XCTAssertEqual(apps.where_("com.brave.Browser"), "", "a known name naming another app is not it")
        XCTAssertTrue(apps.has("com.brave.Browser"), "not answered yet: installed")
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(apps.has("com.brave.Browser"), "Spotlight's answer kept")
        XCTAssertEqual(asked, ["com.brave.Browser"])
        XCTAssertFalse(apps.has("bad id!"))
    }

    func testSettledAndOverride() async {
        let slow = InstalledApps(appDirs: [], spotlight: { _ in try? await Task.sleep(nanoseconds: 2_000_000_000); return false }, override: nil, fs: fakeFS([:]), settleSeconds: 0.05)
        let start = Date()
        let answer = await slow.settled("com.brave.Browser")
        XCTAssertTrue(answer, "no answer in time: installed")
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        let quick = InstalledApps(appDirs: [], spotlight: { _ in false }, override: nil, fs: fakeFS([:]))
        let quickAnswer = await quick.settled("com.brave.Browser")
        XCTAssertFalse(quickAnswer)
        var looked = false
        let over = InstalledApps(appDirs: ["/Applications"], spotlight: { _ in looked = true; return true }, override: ["org.mozilla.firefox"], fs: fakeFS([:]))
        XCTAssertTrue(over.has("org.mozilla.firefox")); XCTAssertFalse(over.has("com.google.Chrome"))
        let overSettled = await over.settled("com.google.Chrome")
        XCTAssertFalse(overSettled); XCTAssertFalse(looked)
    }

    func testPlistNames() {
        XCTAssertEqual(InstalledApps.plistNames(plist("com.google.Chrome"), "com.google.Chrome"), true)
        XCTAssertEqual(InstalledApps.plistNames(plist("com.other"), "com.google.Chrome"), false)
        XCTAssertNil(InstalledApps.plistNames("bplist00…", "com.google.Chrome"))
    }
}
