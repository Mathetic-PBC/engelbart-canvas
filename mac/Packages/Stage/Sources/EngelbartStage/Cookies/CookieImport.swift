import Foundation
import EngelbartCore

// Import sign-ins from the person's own browsers into the Stage (MATH-18, 2026-10-06; src/main/browser/import-cookies.cjs).
// The Stage keeps every tab in one shared cookie store (StageSession); this reads the cookies a Chromium-family browser,
// Firefox or Safari has on disk and writes the ones the person ticks into that store. Nothing is kept anywhere else: the
// results carry domains and counts only, never values, and the only record is <app support>/browser-imports.json
// (domains and counts — CK-12, CK-13). Everything that reaches the machine is injected, so the tests use fixtures alone.

public struct CookieImportError: Error, LocalizedError, Equatable {
    public var message: String
    public var denied = false
    public var notFound = false
    public var notInstalled = false
    public var needsDiskAccess = false
    public var timedOut = false
    public var browser: String?
    public init(message: String, denied: Bool = false, notFound: Bool = false, notInstalled: Bool = false, needsDiskAccess: Bool = false, timedOut: Bool = false, browser: String? = nil) {
        self.message = message; self.denied = denied; self.notFound = notFound; self.notInstalled = notInstalled
        self.needsDiskAccess = needsDiskAccess; self.timedOut = timedOut; self.browser = browser
    }
    public var errorDescription: String? { message }
}

/// The Stage's cookie store, as the importer writes to it (StageSession's WKHTTPCookieStore; a fake in the tests).
public protocol StageCookieStore: AnyObject {
    func set(_ details: CookieSetDetails) async throws
    /// The names of the cookies the store would send to `url`, or nil when it cannot say.
    func names(for url: String) async -> Set<String>?
    func flush() async
}

public enum CookieBrowsers {
    public enum Family: String, Sendable { case chromium, firefox, safari }
    public struct Browser: Equatable, Sendable {
        public let id: String, name: String, family: Family
        public let dir: String?, keychain: String?, bundle: String?
    }
    // Arc, Comet and Dia are newer Chromium forks: their folders and Keychain names follow their published layout and were
    // NOT verified against an installed copy. Comet's and Dia's bundle ids are not confirmed: a page is never opened there.
    public static let chromium: [Browser] = [
        Browser(id: "chrome", name: "Chrome", family: .chromium, dir: "Google/Chrome", keychain: "Chrome Safe Storage", bundle: "com.google.Chrome"),
        Browser(id: "brave", name: "Brave", family: .chromium, dir: "BraveSoftware/Brave-Browser", keychain: "Brave Safe Storage", bundle: "com.brave.Browser"),
        Browser(id: "edge", name: "Edge", family: .chromium, dir: "Microsoft Edge", keychain: "Microsoft Edge Safe Storage", bundle: "com.microsoft.edgemac"),
        Browser(id: "vivaldi", name: "Vivaldi", family: .chromium, dir: "Vivaldi", keychain: "Vivaldi Safe Storage", bundle: "com.vivaldi.Vivaldi"),
        Browser(id: "opera", name: "Opera", family: .chromium, dir: "com.operasoftware.Opera", keychain: "Opera Safe Storage", bundle: "com.operasoftware.Opera"),
        Browser(id: "chromium", name: "Chromium", family: .chromium, dir: "Chromium", keychain: "Chromium Safe Storage", bundle: "org.chromium.Chromium"),
        Browser(id: "arc", name: "Arc", family: .chromium, dir: "Arc/User Data", keychain: "Arc Safe Storage", bundle: "company.thebrowser.Browser"),
        Browser(id: "comet", name: "Comet", family: .chromium, dir: "Comet", keychain: "Comet Safe Storage", bundle: nil),
        Browser(id: "dia", name: "Dia", family: .chromium, dir: "Dia/User Data", keychain: "Dia Safe Storage", bundle: nil),
    ]
    public static let firefox = Browser(id: "firefox", name: "Firefox", family: .firefox, dir: "Firefox", keychain: nil, bundle: "org.mozilla.firefox")
    public static let safari = Browser(id: "safari", name: "Safari", family: .safari, dir: nil, keychain: nil, bundle: "com.apple.Safari")
    public static let all = chromium + [firefox, safari]
    public static func byId(_ id: String) -> Browser? { all.first { $0.id == id } }
    /// The macOS bundle id of a browser the importer knows, or nil.
    public static func bundleOf(_ id: String) -> String? { byId(id)?.bundle }
}

/// One site's signed-in check (CK-14) and its verdict rule: a 2xx is signed in; a redirect to that site's own login page, or
/// a 401, is signed out; anything else (403, 429, 5xx, a redirect elsewhere, a timeout, a network error) is not confirmed.
public struct SignInCheck: Sendable {
    public let site: String, domain: String, url: String
    public let sessionCookies: [String]?
    public let signedOut: (@Sendable (String, String) -> Bool)?
    public let signedOutAnswer: (@Sendable (Int, String?) -> Bool)?

    static let googleLoginPath = SRx(#"^\/(?:ServiceLogin|signin|v\d+\/signin|AccountChooser)(?:[/?]|$)"#, "i")

    /// A Google page redirected to Google's own sign-in page.
    public static func endedGoogleSession(_ from: String, _ to: String) -> Bool {
        guard let login = JSURL(to) else { return false }
        return login.protocol == "https:" && login.hostname == "accounts.google.com" && googleLoginPath.test(login.pathname)
    }
    /// Claude's API turning the session away: 403 with an error that names the session invalid (Cloudflare's 403 is not it).
    public static func endedClaudeSession(_ status: Int, _ body: String?) -> Bool {
        guard status == 403, let body, let json = try? JSONValue.parse(body) else { return false }
        let error = json["error"]
        return error?["details"]?["error_code"]?.string == "account_session_invalid" || SRx("invalid authorization", "i").test(error?["message"]?.string ?? "")
    }
    /// A login page on `hosts` whose path matches `pattern` (a relative `to` read from `from`).
    static func loginAt(_ hosts: [String], _ pattern: SRx) -> @Sendable (String, String) -> Bool {
        { from, to in
            let absolute = to.hasPrefix("/") ? ((JSURL(from)?.origin ?? "") + to) : to
            guard let login = JSURL(absolute) else { return false }
            return login.protocol == "https:" && hosts.contains(login.hostname) && pattern.test(login.pathname)
        }
    }

    public static let all: [SignInCheck] = [
        SignInCheck(site: "GitHub", domain: "github.com", url: "https://github.com/settings/profile", sessionCookies: GitHubPages.sessionCookies, signedOut: { GitHubPages.endedSession(from: $0, to: $1) }, signedOutAnswer: nil),
        SignInCheck(site: "Google", domain: "google.com", url: "https://drive.google.com/drive/u/0/", sessionCookies: nil, signedOut: endedGoogleSession, signedOutAnswer: nil),
        SignInCheck(site: "Overleaf", domain: "overleaf.com", url: "https://www.overleaf.com/project", sessionCookies: nil, signedOut: loginAt(["www.overleaf.com", "overleaf.com"], SRx(#"^\/login\/?$"#)), signedOutAnswer: nil),
        SignInCheck(site: "Zotero", domain: "zotero.org", url: "https://www.zotero.org/settings/", sessionCookies: nil, signedOut: loginAt(["www.zotero.org", "zotero.org"], SRx(#"^\/user\/login\/?$"#)), signedOutAnswer: nil),
        SignInCheck(site: "Evernote", domain: "evernote.com", url: "https://www.evernote.com/client/web", sessionCookies: nil, signedOut: loginAt(["www.evernote.com", "evernote.com"], SRx(#"^\/Login\.action$"#, "i")), signedOutAnswer: nil),
        SignInCheck(site: "Claude", domain: "claude.ai", url: "https://claude.ai/api/organizations", sessionCookies: nil, signedOut: nil, signedOutAnswer: endedClaudeSession),
    ]
    public static func byDomain(_ domain: String) -> SignInCheck? { all.first { $0.domain == domain } }
    /// The Stage's picker pre-ticks the sites a person is likely to import (Evernote's and Claude's checks are Connect's).
    public static let defaultDomains = all.filter { $0.domain != "evernote.com" && $0.domain != "claude.ai" }.map(\.domain)
    public static let timeout: TimeInterval = 10

    /// What a check page answered: its status, where a redirect went, and (for a check that reads it) a little of the body.
    public struct Response: Equatable, Sendable {
        public var status: Int
        public var location: String = ""
        public var body: String?
        public init(status: Int, location: String = "", body: String? = nil) { self.status = status; self.location = location; self.body = body }
    }

    static func wasRedirect(_ r: Response) -> Bool { r.status == 0 || (r.status >= 300 && r.status < 400) }
    func lacksSession(_ held: Set<String>?) -> Bool { if let names = sessionCookies, let held { return !names.contains { held.contains($0) } }; return false }

    /// The verdict: true signed in, false signed out, nil not confirmed either way.
    public func result(_ response: Response?, held: Set<String>? = nil) -> Bool? {
        if lacksSession(held) { return false }
        guard let response else { return nil }
        if SignInCheck.wasRedirect(response) { return !response.location.isEmpty && (signedOut?(url, response.location) ?? false) ? false : nil }
        if response.status == 401 { return false }
        if let answer = signedOutAnswer, answer(response.status, response.body) { return false }
        return response.status >= 200 && response.status < 300 ? true : nil
    }

    /// A redirect target as the trace keeps it: its origin and path, the query left off.
    public static func shownLocation(_ location: String, from: String) -> String {
        if location.isEmpty { return "" }
        let absolute = location.hasPrefix("/") ? ((JSURL(from)?.origin ?? "") + location) : location
        guard let to = JSURL(absolute) else { return "" }
        return "\(to.origin)\(to.pathname)"
    }
}

/// The browsers' cookies, read and written into the Stage.
public final class CookieImport: @unchecked Sendable {
    public struct Profile: Equatable, Sendable { public var id: String; public var name: String; public var email: String?; public var locked = false; var cookieFile = "" }
    public struct Source: Equatable, Sendable { public var id: String; public var name: String; public var family: String; public var bundle: String?; public var profiles: [Profile] }
    public struct Domains: Equatable, Sendable { public var browser: String; public var profile: String; public var defaults: [String]; public var domains: [(domain: String, count: Int)]; public var needs: String?
        public static func == (a: Domains, b: Domains) -> Bool { a.browser == b.browser && a.profile == b.profile && a.defaults == b.defaults && a.needs == b.needs && a.domains.map(\.domain) == b.domains.map(\.domain) && a.domains.map(\.count) == b.domains.map(\.count) } }
    public struct Check: Equatable, Sendable { public var site, domain, url: String; public var signedIn: Bool?; public var status: Int; public var location: String; public var reason: String? }
    public struct Result: Equatable, Sendable { public var browser: String; public var profile: String; public var imported = 0, skipped = 0, sessionOnly = 0; public var checks: [Check] = []; public var needs: String? }

    let supportDir: URL
    let userDataDir: URL
    let tmpBase: URL
    let store: () -> StageCookieStore
    let probe: ((String, Bool, TimeInterval) async -> SignInCheck.Response?)?
    let keychain: (String) async throws -> String
    let now: () -> Date
    let checkTimeout: TimeInterval
    let installed: ((String) -> Bool)?
    let settled: ((String) async -> Bool)?
    let homeDir: String
    let fullDiskAccess: () -> Bool

    /// `probe(url, readBody, timeout)` asks a check page over the Stage's cookies without following redirects (nil: none);
    /// `keychain(service)` the Keychain password (KeychainRunner.read); `installed`/`settled` InstalledApps's answers;
    /// `fullDiskAccess` whether Safari's files may be read (never touched without it).
    public init(supportDir: URL, userDataDir: URL, tmpBase: URL = FileManager.default.temporaryDirectory, store: @escaping () -> StageCookieStore,
                probe: ((String, Bool, TimeInterval) async -> SignInCheck.Response?)? = nil, keychain: @escaping (String) async throws -> String,
                now: @escaping () -> Date = Date.init, checkTimeout: TimeInterval = SignInCheck.timeout, installed: ((String) -> Bool)? = nil,
                settled: ((String) async -> Bool)? = nil, homeDir: String? = nil, fullDiskAccess: (() -> Bool)? = nil) {
        self.supportDir = supportDir; self.userDataDir = userDataDir; self.tmpBase = tmpBase; self.store = store; self.probe = probe
        self.keychain = keychain; self.now = now; self.checkTimeout = checkTimeout; self.installed = installed; self.settled = settled
        let home = homeDir ?? supportDir.deletingLastPathComponent().deletingLastPathComponent().path
        self.homeDir = home
        self.fullDiskAccess = fullDiskAccess ?? { CookieImport.canReadHere(home) }
    }

    /// Whether this process may read what macOS guards (onboarding/disk-access.cjs canReadHere): Safari's container listed.
    public static func canReadHere(_ home: String) -> Bool {
        let probe = (home as NSString).appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library")
        guard FileManager.default.fileExists(atPath: probe) else { return false }
        return (try? FileManager.default.contentsOfDirectory(atPath: probe)) != nil
    }

    var importsFile: URL { userDataDir.appendingPathComponent("browser-imports.json") }
    var unixNow: Int { Int(now().timeIntervalSince1970.rounded(.down)) }
    static let lockedSafari = [Profile(id: "Default", name: "Safari", email: nil, locked: true)]

    func safariHere() -> [Profile] {
        guard fullDiskAccess() else { return CookieImport.lockedSafari }
        do { return try SafariCookies.profiles(homeDir).map { Profile(id: $0.id, name: $0.name, email: nil, cookieFile: $0.cookieFile) } }
        catch is SafariCookies.NeedsDiskAccess { return CookieImport.lockedSafari }
        catch { return [] }
    }

    func profilesOf(_ browser: CookieBrowsers.Browser) -> [Profile] {
        browser.family == .safari ? safariHere() : profilesFor(browser)
    }

    static func existsDir(_ p: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue }
    static func existsFile(_ p: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: p, isDirectory: &d) && !d.boolValue }

    /// The Cookies file for a Chromium profile: newer Chromium keeps it under Network/, older beside the profile.
    static func chromiumCookieFile(_ profileDir: String) -> String {
        let network = (profileDir as NSString).appendingPathComponent("Network/Cookies")
        if existsFile(network) { return network }
        let direct = (profileDir as NSString).appendingPathComponent("Cookies")
        return existsFile(direct) ? direct : ""
    }

    /// A Chromium browser's profiles from its Local State (profile.info_cache), only those with cookies.
    static func chromiumProfiles(_ root: String) -> [Profile] {
        let info = (Files.readJSON(URL(fileURLWithPath: (root as NSString).appendingPathComponent("Local State")))?["profile"]?["info_cache"]?.object) ?? [:]
        var dirs = Array(info.keys)
        if existsDir((root as NSString).appendingPathComponent("Default")) && !dirs.contains("Default") { dirs.append("Default") }
        var out: [Profile] = []
        for dir in dirs.sorted(by: { a, b in a == "Default" ? true : b == "Default" ? false : a < b }) {
            let file = chromiumCookieFile((root as NSString).appendingPathComponent(dir))
            if file.isEmpty { continue }
            let email = JSStr.trim(info[dir]?["user_name"]?.string ?? "")
            out.append(Profile(id: dir, name: info[dir]?["name"]?.string ?? dir, email: email.isEmpty ? nil : email, cookieFile: file))
        }
        return out
    }

    /// Each Firefox profile folder's own name, from profiles.ini.
    static func firefoxNames(_ root: String) -> [String: String] {
        guard let text = try? String(contentsOfFile: (root as NSString).appendingPathComponent("profiles.ini"), encoding: .utf8) else { return [:] }
        var names: [String: String] = [:]
        for section in SRx(#"^\s*\["#, "m").replace(text, with: "\u{1}").components(separatedBy: "\u{1}") where SRx("^Profile", "i").test(section) {
            let name = SRx("^Name=(.*)$", "m").match(section)?[1]
            let where_ = SRx("^Path=(.*)$", "m").match(section)?[1]
            if let name, let where_, !name.isEmpty, !where_.isEmpty {
                names[(JSStr.trim(where_).replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent] = JSStr.trim(name)
            }
        }
        return names
    }

    static func firefoxProfiles(_ root: String) -> [Profile] {
        let base = (root as NSString).appendingPathComponent("Profiles")
        guard existsDir(base) else { return [] }
        let names = firefoxNames(root)
        return ((try? FileManager.default.contentsOfDirectory(atPath: base)) ?? []).sorted().compactMap { dir in
            let file = (base as NSString).appendingPathComponent("\(dir)/cookies.sqlite")
            return existsFile(file) ? Profile(id: dir, name: names[dir] ?? dir, email: nil, cookieFile: file) : nil
        }
    }

    func profilesFor(_ browser: CookieBrowsers.Browser) -> [Profile] {
        guard let dir = browser.dir else { return [] }
        let root = supportDir.appendingPathComponent(dir).path
        guard CookieImport.existsDir(root) else { return [] }
        return browser.family == .firefox ? CookieImport.firefoxProfiles(root) : CookieImport.chromiumProfiles(root)
    }

    /// Whether the browser's app is installed (`installed`), or no check was given.
    func has(_ browser: CookieBrowsers.Browser) -> Bool {
        guard let installed else { return true }
        guard let bundle = browser.bundle else { return false }
        return installed(bundle)
    }

    /// The installed browsers and their profiles, domains and values untouched (CK-03).
    public func sources() -> [Source] {
        var out: [Source] = []
        for browser in CookieBrowsers.all where has(browser) {
            let profiles = profilesOf(browser)
            if browser.family == .safari && installed == nil && profiles.contains(where: \.locked) { continue }
            if !profiles.isEmpty { out.append(Source(id: browser.id, name: browser.name, family: browser.family.rawValue, bundle: browser.bundle, profiles: profiles)) }
        }
        return out
    }

    /// The installed Chromium browsers, with their profiles or none yet (2026-10-15).
    public func installedChromium() -> [Source] {
        CookieBrowsers.chromium.filter { $0.bundle != nil && has($0) }.map { Source(id: $0.id, name: $0.name, family: "chromium", bundle: $0.bundle, profiles: profilesFor($0)) }
    }

    /// Whether the browser is installed, once macOS has answered (`settled`), else as `has` says.
    public func ready(_ browserId: String) async -> Bool {
        guard let browser = CookieBrowsers.byId(browserId), has(browser) else { return false }
        guard let settled, let bundle = browser.bundle else { return true }
        return await settled(bundle)
    }

    /// Whether a browser's cookies can be read now (false for Safari without Full Disk Access).
    public func canRead(_ browserId: String) -> Bool {
        guard let browser = CookieBrowsers.byId(browserId) else { return false }
        if browser.family != .safari { return true }
        return !safariHere().contains(where: \.locked)
    }

    func keyOf(_ browser: CookieBrowsers.Browser) async throws -> Data {
        if !(await ready(browser.id)) { throw CookieImportError(message: "\(browser.name) is not installed.", notInstalled: true, browser: browser.name) }
        do { return CookieFormats.deriveKey(try await keychain(browser.keychain ?? "")) } catch {
            let failure = KeychainRunner.failure(error)
            let message = failure == "not-found" ? "Engelbart couldn't find \(browser.name)'s key in the Keychain, so its cookies can't be read. Nothing was imported."
                : failure == "denied" ? "Engelbart needs Keychain access to read \(browser.name)'s cookies, and the request was denied. Nothing was imported."
                : "Engelbart could not read \(browser.name)'s Keychain key. Nothing was imported."
            throw CookieImportError(message: message, denied: failure == "denied", notFound: failure == "not-found", browser: browser.name)
        }
    }

    /// Ask macOS for a Chromium browser's Keychain key now, copying nothing → whether it has one (Firefox: false).
    public func unlock(_ browserId: String) async throws -> Bool {
        guard let browser = CookieBrowsers.byId(browserId) else { throw CookieImportError(message: "That browser is not one Engelbart can import from.") }
        if browser.family != .chromium { return false }
        _ = try await keyOf(browser)
        return true
    }

    func resolve(_ browserId: String, _ profileId: String) throws -> (CookieBrowsers.Browser, Profile) {
        guard let browser = CookieBrowsers.byId(browserId) else { throw CookieImportError(message: "That browser is not one Engelbart can import from.") }
        if !has(browser) { throw CookieImportError(message: "\(browser.name) is not installed.") }
        guard let profile = profilesOf(browser).first(where: { $0.id == profileId }) else { throw CookieImportError(message: "That browser profile is no longer there.") }
        return (browser, profile)
    }

    static let needsDiskAccess = CookieImportError(message: "Engelbart needs Full Disk Access to read Safari's sign-ins.", needsDiskAccess: true, browser: "Safari")

    func readSafari(_ profile: Profile) throws -> SafariCookies.Parsed {
        if profile.locked || profile.cookieFile.isEmpty || !fullDiskAccess() { throw CookieImport.needsDiskAccess }
        do { return try SafariCookies.readFile(profile.cookieFile) } catch is SafariCookies.NeedsDiskAccess { throw CookieImport.needsDiskAccess }
    }

    func readProfile(_ browser: CookieBrowsers.Browser, _ profile: Profile, key: Data?, want: Set<String>) throws -> (cookies: [ImportedCookie], skipped: Int) {
        switch browser.family {
        case .safari: return CookieFormats.normalizeSafari(try readSafari(profile), want: want, now: unixNow)
        case .firefox: return CookieFormats.normalizeFirefox(rows: try CookieFormats.withCopy(profile.cookieFile, tmpBase: tmpBase, CookieFormats.readFirefoxDb).rows, want: want, now: unixNow)
        case .chromium:
            let read = try CookieFormats.withCopy(profile.cookieFile, tmpBase: tmpBase, CookieFormats.readChromiumDb)
            return CookieFormats.normalizeChromium(version: read.version, rows: read.rows, key: key, want: want, now: unixNow)
        }
    }

    /// A profile's live rows for listing (host, name, stamp), with no value decrypted.
    func listed(_ browser: CookieBrowsers.Browser, _ profile: Profile) throws -> [(host: String, name: String, stamp: Double)] {
        let at = unixNow
        switch browser.family {
        case .safari: return try readSafari(profile).cookies.filter { SafariCookies.kept($0, now: at) }.map { ($0.host, $0.name, Double($0.created)) }
        case .firefox: return try CookieFormats.withCopy(profile.cookieFile, tmpBase: tmpBase, CookieFormats.readFirefoxDb).rows.filter { CookieFormats.firefoxKept($0, now: at) }.map { ($0.host, $0.name, $0.stamp) }
        case .chromium: return try CookieFormats.withCopy(profile.cookieFile, tmpBase: tmpBase, CookieFormats.readChromiumDb).rows.filter { CookieFormats.chromiumKept($0, now: at) }.map { ($0.host, $0.name, $0.stamp) }
        }
    }

    /// The domains a profile has cookies for, with counts (CK-07). No Keychain: listing never decrypts.
    public func domains(_ browserId: String, _ profileId: String) throws -> Domains {
        let (browser, profile) = try resolve(browserId, profileId)
        let rows: [(host: String, name: String, stamp: Double)]
        do { rows = try listed(browser, profile) } catch let e as CookieImportError where e.needsDiskAccess {
            return Domains(browser: browser.id, profile: profile.id, defaults: SignInCheck.defaultDomains, domains: [], needs: "disk-access")
        }
        var counts: [String: Int] = [:]
        for row in rows { let d = CookieFormats.registrableDomain(row.host); if !d.isEmpty { counts[d, default: 0] += 1 } }
        let list = counts.map { (domain: $0.key, count: $0.value) }.sorted { $0.count != $1.count ? $0.count > $1.count : $0.domain < $1.domain }
        return Domains(browser: browser.id, profile: profile.id, defaults: SignInCheck.defaultDomains, domains: list)
    }

    /// The names of the live cookies a profile holds for `wanted` registrable domains → [(domain, name, stamp)].
    public func cookieNames(_ browserId: String, _ profileId: String, _ wanted: [String]) throws -> [(domain: String, name: String, stamp: Double)] {
        let (browser, profile) = try resolve(browserId, profileId)
        let want = Set(wanted.map { $0.lowercased() })
        return try listed(browser, profile).compactMap { row in
            let d = CookieFormats.registrableDomain(row.host)
            return want.contains(d) ? (d, row.name, row.stamp) : nil
        }
    }

    /// The signed-in check for each imported domain that has one, all at once.
    func runChecks(_ domains: [String]) async -> [Check] {
        let checks = domains.compactMap(SignInCheck.byDomain)
        let target = store()
        return await withTaskGroup(of: (Int, Check).self) { group in
            for (i, check) in checks.enumerated() {
                group.addTask { [probe, checkTimeout] in
                    let held = check.sessionCookies != nil ? await target.names(for: check.url) : nil
                    let skipped = check.lacksSession(held)
                    let response = skipped || probe == nil ? nil : await probe!(check.url, check.signedOutAnswer != nil, checkTimeout)
                    let signedIn = check.result(response, held: held)
                    if skipped { return (i, Check(site: check.site, domain: check.domain, url: check.url, signedIn: signedIn, status: 0, location: "", reason: "no-session-cookie")) }
                    if let response { return (i, Check(site: check.site, domain: check.domain, url: check.url, signedIn: signedIn, status: response.status, location: SignInCheck.shownLocation(response.location, from: check.url), reason: nil)) }
                    return (i, Check(site: check.site, domain: check.domain, url: check.url, signedIn: signedIn, status: 0, location: "", reason: probe == nil ? "no-request" : "no-answer"))
                }
            }
            var out: [(Int, Check)] = []
            for await one in group { out.append(one) }
            return out.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    /// Whether the Stage's sign-in for `domain` works, by its check page alone → true, false, or nil (no page, no answer).
    public func check(_ domain: String) async -> Bool? { await checkDetail(domain)?.signedIn ?? nil }

    public func checkDetail(_ domain: String) async -> Check? {
        guard let known = SignInCheck.byDomain(domain.lowercased()) else { return nil }
        return await runChecks([known.domain]).first
    }

    /// Import the ticked domains' cookies into the Stage (CK-08–CK-13): counts only, never a value. A Keychain denial or miss
    /// throws before anything is written. No domains: nothing asked, read, written or recorded. Safari without Full Disk
    /// Access: nothing written or recorded, `needs: 'disk-access'`. `quiet`: no checks over the network and no record.
    public func run(browser browserId: String, profile profileId: String, domains wanted: [String], quiet: Bool = false) async throws -> Result {
        let (browser, profile) = try resolve(browserId, profileId)
        let want = Set(wanted.map { $0.lowercased() })
        if want.isEmpty { return Result(browser: browser.id, profile: profile.name) }
        let key = browser.family == .chromium ? try await keyOf(browser) : nil
        let read: (cookies: [ImportedCookie], skipped: Int)
        do { read = try readProfile(browser, profile, key: key, want: want) } catch let e as CookieImportError where e.needsDiskAccess {
            return Result(browser: browser.id, profile: profile.name, needs: "disk-access")
        }
        let cookies = read.cookies.filter { !CookieFormats.boundToBrowser(host: $0.host, name: $0.name) }
        let skipped = read.skipped + (read.cookies.count - cookies.count)
        let target = store()
        var imported = 0, sessionOnly = 0
        for cookie in cookies {
            do {
                try await target.set(CookieFormats.cookieSetDetails(cookie))
                imported += 1
                if !(cookie.persistent && cookie.expires > 0) { sessionOnly += 1 }
            } catch {
                // A value the store will not take is skipped, not fatal; the error is dropped unread, so no value leaks.
            }
        }
        await target.flush()
        let importedDomains = wanted.map { $0.lowercased() }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        if quiet { return Result(browser: browser.id, profile: profile.name, imported: imported, skipped: skipped, sessionOnly: sessionOnly) }
        let checks = await runChecks(importedDomains)
        recordImport(["browser": .string(browser.id), "browserName": .string(browser.name), "profile": .string(profile.name),
                      "domains": .array(importedDomains.map(JSONValue.string)), "time": .string(Time.iso(now())),
                      "imported": .number(Double(imported)), "skipped": .number(Double(skipped)), "sessionOnly": .number(Double(sessionOnly))])
        return Result(browser: browser.id, profile: profile.name, imported: imported, skipped: skipped, sessionOnly: sessionOnly, checks: checks)
    }

    /// Append one import to browser-imports.json: browser, profile, domains, time and counts. Never values.
    func recordImport(_ entry: JSONValue) {
        var list = Files.readJSON(importsFile)?.array ?? []
        list.append(entry)
        try? FileManager.default.createDirectory(at: userDataDir, withIntermediateDirectories: true)
        try? Files.writeJSON(.array(list), to: importsFile)
    }
}

/// The default Keychain runner (CK-05): `security find-generic-password -w -s "<name>"`. Exit 44 is errSecItemNotFound;
/// 128 errSecUserCanceled and 51 errSecAuthFailed are the person saying no; no answer in time counts as a no.
public enum KeychainRunner {
    public static let notFoundExit: Int32 = 44
    public static let deniedExits: Set<Int32> = [128, 51]

    /// What `security` answered: its exit status and output (Core's ProcessResult has no public initializer for fakes).
    public struct Output: Sendable {
        public var status: Int32; public var stdout: String; public var stderr: String
        public init(status: Int32, stdout: String = "", stderr: String = "") { self.status = status; self.stdout = stdout; self.stderr = stderr }
    }
    public typealias Run = (_ file: String, _ args: [String], _ timeout: TimeInterval) async throws -> Output

    public static let defaultRun: Run = { file, args, timeout in
        let r = try await ProcessRunner.run(file, args, timeout: timeout)
        return Output(status: r.exit.signal == nil ? r.exit.status : -1, stdout: r.stdout, stderr: r.stderr)
    }

    public static func read(_ service: String, timeout: TimeInterval = 60, run: Run = defaultRun) async throws -> String {
        let result: Output
        do { result = try await run("/usr/bin/security", ["find-generic-password", "-w", "-s", service], timeout) } catch ProcessRunnerError.timedOut {
            throw CookieImportError(message: "Keychain access was denied", denied: true, timedOut: true)
        }
        if result.status == 0 {
            var out = result.stdout
            if out.hasSuffix("\n") { out.removeLast() }
            return out
        }
        let code = result.status
        let notFound = code == notFoundExit
        let denied = !notFound && (deniedExits.contains(code) || SRx("denied|user (?:name|interaction)|cancel", "i").test(result.stderr))
        throw CookieImportError(message: notFound ? "The Keychain has no such key" : denied ? "Keychain access was denied" : "The Keychain key could not be read", denied: denied, notFound: notFound)
    }

    /// Which way a Keychain read failed: 'not-found', 'denied' or 'other'.
    public static func failure(_ error: Error) -> String {
        if let e = error as? CookieImportError {
            if e.notFound { return "not-found" }
            if e.denied { return "denied" }
        }
        let message = error.localizedDescription
        if SRx("could not be found|no such key", "i").test(message) { return "not-found" }
        if SRx("denied|-128|cancel", "i").test(message) { return "denied" }
        return "other"
    }
}
