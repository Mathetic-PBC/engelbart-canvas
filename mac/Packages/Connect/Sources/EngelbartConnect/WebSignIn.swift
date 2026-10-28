import Foundation
import WebKit
import EngelbartCore

// Port of src/main/connect/web-signin.cjs (2026-10-08; one browser and profile chosen once, C4, 2026-10-16): a web app's
// sign-in made in the person's own browser is brought over into Engelbart's browser store, where the agents read the app:
// its cookies for the app's sites, through the Stage's cookie import (../browser/import-cookies.cjs, the `CookieImporter`
// protocol here). A copy is held only once it works: a site with a check page has that page asked over Engelbart's store
// after a copy; signed out → the copy undone completely (C3) and copied again; no answer → held (`unchecked`). The browser
// the person chose and its profile are the only ones any copy reads, and the only place a page opens. Engelbart's own
// sign-in window (SignInWindow) is the fallback; once it signed an app in, that sign-in is never copied over again.

/// A browser the importer can read (import-cookies.cjs sources()).
public struct BrowserSource: Sendable, Equatable {
    public struct Profile: Sendable, Equatable { public var id: String; public var name: String; public var email: String; public var locked: Bool
        public init(id: String, name: String = "", email: String = "", locked: Bool = false) { self.id = id; self.name = name; self.email = email; self.locked = locked } }
    public var id: String
    public var name: String
    public var family: String
    public var bundle: String?
    public var profiles: [Profile]
    public var count: Int = 0
    public init(id: String, name: String, family: String, bundle: String? = nil, profiles: [Profile]) { self.id = id; self.name = name; self.family = family; self.bundle = bundle; self.profiles = profiles }
}

public enum CookieImportError: Error, Sendable { case denied, needs(String) }

/// The Stage's cookie import (main/browser/import-cookies.cjs), consumed here.
public protocol CookieImporter: AnyObject, Sendable {
    func sources() -> [BrowserSource]
    func installedChromium() -> [BrowserSource]
    /// Names (and when each was last set) a profile holds for `domains`: no Keychain.
    func cookieNames(browser: String, profile: String, domains: [String]) throws -> [(domain: String, name: String, stamp: Double)]
    /// The site's check page over Engelbart's store → (signedIn true/false/nil, status, location, reason).
    func checkDetail(_ domain: String) async -> (signedIn: Bool?, status: Int?, location: String?, reason: String?)?
    func canRead(_ browserId: String) -> Bool
    /// Copies the cookies of `domains` into Engelbart's store → how many (nil when it doesn't count). Throws
    /// CookieImportError.denied (macOS refused the Keychain) or .needs('disk-access' | 'keychain').
    func importCookies(browser: String, profile: String, domains: [String], quiet: Bool) async throws -> Int?
    /// Asks macOS for a Chromium browser's key now (one prompt, kept for the run). Throws .denied.
    func unlock(_ browserId: String) async throws
    func ready(_ browserId: String) async -> Bool
}

/// Engelbart's own cookie store (Electron's session.cookies on the Stage's partition).
public struct StoredCookie: Sendable, Equatable {
    public var domain: String, path: String, name: String, value: String
    public var secure = false, httpOnly = false, hostOnly = false, session = true
    public var sameSite: String? = nil
    public var expirationDate: Double? = nil
    public init(domain: String, path: String = "/", name: String, value: String, secure: Bool = false, httpOnly: Bool = false, hostOnly: Bool = false, session: Bool = true, sameSite: String? = nil, expirationDate: Double? = nil) {
        self.domain = domain; self.path = path; self.name = name; self.value = value; self.secure = secure; self.httpOnly = httpOnly; self.hostOnly = hostOnly; self.session = session; self.sameSite = sameSite; self.expirationDate = expirationDate
    }
}

public protocol CookieJar: AnyObject, Sendable {
    /// Every cookie on `domain` or its subdomains.
    func get(domain: String) async -> [StoredCookie]
    func remove(url: String, name: String) async
    func set(_ cookie: StoredCookie) async
}

/// The WKWebsiteDataStore's cookies as a CookieJar.
public final class WKCookieJar: CookieJar, @unchecked Sendable {
    let store: @MainActor () -> WKWebsiteDataStore
    public init(store: @escaping @MainActor () -> WKWebsiteDataStore = { ConnectBrowserStore.store }) { self.store = store }
    @MainActor func all() async -> [HTTPCookie] { await store().httpCookieStore.allCookies() }
    static func matches(_ cookieDomain: String, _ domain: String) -> Bool {
        let c = cookieDomain.hasPrefix(".") ? String(cookieDomain.dropFirst()) : cookieDomain
        return c == domain || c.hasSuffix(".\(domain)")
    }
    public func get(domain: String) async -> [StoredCookie] {
        await all().filter { Self.matches($0.domain, domain) }.map { c in
            StoredCookie(domain: c.domain, path: c.path, name: c.name, value: c.value, secure: c.isSecure, httpOnly: c.isHTTPOnly, hostOnly: !c.domain.hasPrefix("."),
                         session: c.isSessionOnly, sameSite: c.sameSitePolicy?.rawValue, expirationDate: c.expiresDate.map { $0.timeIntervalSince1970 })
        }
    }
    public func remove(url: String, name: String) async {
        guard let host = URL(string: url)?.host else { return }
        let path = URL(string: url)?.path.isEmpty == false ? URL(string: url)!.path : "/"
        for c in await all() where c.name == name && (c.domain == host || c.domain == ".\(host)") && c.path == path { await MainActor.run { () -> Void in } ; await deleteCookie(c) }
    }
    @MainActor func deleteCookie(_ c: HTTPCookie) async { await store().httpCookieStore.deleteCookie(c) }
    public func set(_ cookie: StoredCookie) async {
        var props: [HTTPCookiePropertyKey: Any] = [.domain: cookie.domain, .path: cookie.path, .name: cookie.name, .value: cookie.value]
        if cookie.secure { props[.secure] = "TRUE" }
        if cookie.httpOnly { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        if let e = cookie.expirationDate, !cookie.session { props[.expires] = Date(timeIntervalSince1970: e) }
        if let s = cookie.sameSite { props[.sameSitePolicy] = s }
        guard let c = HTTPCookie(properties: props) else { return }
        await setCookie(c)
    }
    @MainActor func setCookie(_ c: HTTPCookie) async { await store().httpCookieStore.setCookie(c) }
}

public final class WebSignIn: @unchecked Sendable {
    public static let signInPages = Texts.signInPages
    static let browserNames: [(String, String?)] = [("chromium", "chromium"), ("canary", nil), ("chrome", "chrome"), ("brave", "brave"), ("edge", "edge"), ("vivaldi", "vivaldi"),
                                                    ("opera", "opera"), (#"^arc\b"#, "arc"), ("comet", "comet"), (#"^dia\b"#, "dia"), ("firefox", "firefox"), ("technology preview", nil), (#"^safari\b"#, "safari")]
    public static let anotherAccountPage = "https://accounts.google.com/AddSession"
    public static let pollMs = 4000.0, slowPollMs = 15_000.0, fastForMs = 2 * 60_000.0, timeoutMs = 5 * 60_000.0, heldWaitMs = 2 * 60_000.0, checkCacheMs = 3 * 60_000.0
    /// The sites with a check page (import-cookies.cjs SIGN_IN_CHECKS): their copies are checked, not taken on the cookie alone.
    public static let checkedSites = ["github.com": "GitHub", "google.com": "Google", "overleaf.com": "Overleaf", "zotero.org": "Zotero", "evernote.com": "Evernote", "claude.ai": "Claude"]

    /// The registrable domains of an app's sites, the cookie's own first.
    public static func domainsOf(_ app: String) -> [String] {
        var out: [String] = []
        if let own = ConnectSources.signInCookies[app]?.domain { out.append(own) }
        for site in ConnectSources.apps[app]?.sites ?? [] {
            let labels = site.lowercased().split(separator: ".").map(String.init)
            if labels.count >= 2 { let d = labels.suffix(2).joined(separator: "."); if !out.contains(d) { out.append(d) } }
        }
        return out
    }

    /// The importer's id for the default browser's name, or nil when it is one whose cookies Engelbart cannot read.
    public static func browserIdOf(_ name: String?) -> String? {
        let text = (name ?? "").trimmingCharacters(in: .whitespaces)
        return browserNames.first { JS.test(text, $0.0, options: .caseInsensitive) }?.1 ?? nil
    }

    static func pickKey(_ app: String) -> String { ConnectSources.signInCookies[app]?.domain ?? "" }

    /// A tool's sites as registrable domains ('www.linear.app' → 'linear.app'), each once.
    public static func registrable(_ domains: [String]) -> [String] {
        var out: [String] = []
        for d in domains {
            var s = JS.replace(d.lowercased().trimmingCharacters(in: .whitespaces), "^https?://", "")
            s = s.components(separatedBy: "/")[0]
            let r = s.split(separator: ".").filter { !$0.isEmpty }.suffix(2).joined(separator: ".")
            if r.contains(".") && !out.contains(r) { out.append(r) }
        }
        return out
    }

    /// `open` arguments that show `url` in one profile of a Chromium browser.
    public static func profileOpenArgs(bundle: String, profileId: String, url: String) -> [String] { ["-n", "-b", bundle, "--args", "--profile-directory=\(profileId)", url] }

    public struct Chosen: Sendable { public var browser: String?; public var profile: String?; public var keychain: String?
        public init(browser: String? = nil, profile: String? = nil, keychain: String? = nil) { self.browser = browser; self.profile = profile; self.keychain = keychain } }

    let importer: CookieImporter?
    let jar: CookieJar
    let defaultBrowser: () -> String
    let openExternal: (String) async throws -> Void
    let openIn: ((String, String) async throws -> Void)?
    let openInProfile: ((String, String, String) async throws -> Void)?
    let picks: SigninProfiles?
    let chosen: () -> Chosen
    let log: (String, JSONValue?) -> Void
    let poll: Double, slowPoll: Double, fastFor: Double, timeout: Double, heldWait: Double, checkCache: Double
    let now: () -> Double
    let sleep: (Double) async -> Void
    let lock = NSRecursiveLock()
    var asked = Set<String>()
    var refusedHere = Set<String>()
    var verdicts: [String: (at: Double, task: Task<Bool?, Never>)] = [:]
    var waitingIn: [String: BrowserSource] = [:]
    var here = Set<String>()
    var queues: [String: Task<Void, Never>] = [:]

    public init(importer: CookieImporter?, jar: CookieJar, defaultBrowser: @escaping () -> String = { "" }, openExternal: @escaping (String) async throws -> Void,
                openIn: ((String, String) async throws -> Void)? = nil, openInProfile: ((String, String, String) async throws -> Void)? = nil, picks: SigninProfiles? = nil,
                chosen: @escaping () -> Chosen = { Chosen() }, log: @escaping (String, JSONValue?) -> Void = { _, _ in },
                pollMs: Double = WebSignIn.pollMs, slowPollMs: Double = WebSignIn.slowPollMs, fastForMs: Double = WebSignIn.fastForMs, timeoutMs: Double = WebSignIn.timeoutMs,
                heldWaitMs: Double = WebSignIn.heldWaitMs, checkCacheMs: Double = WebSignIn.checkCacheMs, now: @escaping () -> Double = { Time.ms() },
                sleep: @escaping (Double) async -> Void = { await waitFor($0) }) {
        self.importer = importer; self.jar = jar; self.defaultBrowser = defaultBrowser; self.openExternal = openExternal; self.openIn = openIn; self.openInProfile = openInProfile
        self.picks = picks; self.chosen = chosen; self.log = log; poll = pollMs; slowPoll = slowPollMs; fastFor = fastForMs; timeout = timeoutMs; heldWait = heldWaitMs; checkCache = checkCacheMs
        self.now = now; self.sleep = sleep
    }

    var choice: Chosen { chosen() }
    func chosenId() -> String? { choice.browser ?? Self.browserIdOf(defaultBrowser()) }
    func canRead(_ id: String) -> Bool { importer?.canRead(id) ?? true }

    /// One import per browser at a time: two apps looked at together wait for the one answer macOS gives.
    func oneAtATime<T>(_ id: String, _ work: @escaping () async throws -> T) async throws -> T {
        lock.lock()
        let before = queues[id]
        let box = Box<Result<T, Error>?>(nil)
        let task = Task<Void, Never> { await before?.value; do { box.set(.success(try await work())) } catch { box.set(.failure(error)) } }
        queues[id] = task
        lock.unlock()
        await task.value
        return try box.get()!.get()
    }

    static func onTheWeb(_ app: String) -> Bool {
        guard let a = ConnectSources.apps[app] else { return false }
        return a.reach == .web || (a.reach == .connector && !a.sites.isEmpty)
    }
    /// A web app whose sign-in cookie is known: brought over.
    public func supports(_ app: String) -> Bool { importer != nil && ConnectSources.signInCookies[app] != nil && Self.onTheWeb(app) }
    /// Whether its sign-in can be told apart in Engelbart's own store (signed in through Engelbart's window, anywhere).
    public func canSignIn(_ app: String) -> Bool { ConnectSources.signInCookies[app] != nil && Self.onTheWeb(app) }
    public func isHere(_ app: String) -> Bool { lock.lock(); defer { lock.unlock() }; return here.contains(Self.pickKey(app)) }
    @discardableResult
    public func signedInHere(_ app: String) -> Bool { let k = Self.pickKey(app); if !k.isEmpty { lock.lock(); here.insert(k); verdicts[k] = nil; lock.unlock() }; return true }
    func copies(_ app: String) -> Bool { supports(app) && !isHere(app) }

    /// Whether Engelbart's store holds the app's sign-in cookie.
    public func signedIn(_ app: String) async -> Bool {
        guard let entry = ConnectSources.signInCookies[app] else { return false }
        return await jar.get(domain: entry.domain).contains { entry.matches($0.name) }
    }

    func works(_ app: String) async -> Bool? {
        let domain = Self.pickKey(app)
        if Self.checkedSites[domain] == nil { return true }
        return await checkSite(domain)
    }

    /// A checked site's answer → true | false | nil, the same for every app on it for a few minutes; every answer logged.
    func checkSite(_ domain: String) async -> Bool? {
        guard let site = Self.checkedSites[domain], let importer else { return nil }
        lock.lock()
        if let cached = verdicts[domain], now() - cached.at < checkCache { lock.unlock(); return await cached.task.value }
        let task = Task<Bool?, Never> { [log] in
            let detail = await importer.checkDetail(domain)
            let value = detail?.signedIn
            let said = detail.map { d in d.status != nil || d.location != nil ? " (\(d.status.map(String.init) ?? "no status")\(d.location.map { " → \($0)" } ?? ""))" : d.reason.map { " (\($0))" } ?? "" } ?? ""
            let info: JSONValue = ["kind": "signin-check", "site": .string(site), "domain": .string(domain), "verdict": .string(value == nil ? "unknown" : value! ? "signed-in" : "signed-out"),
                                   "status": detail?.status.map { .number(Double($0)) } ?? .null, "location": detail?.location.map { .string($0) } ?? .null]
            if value == nil { log("No answer checking the \(site) sign-in\(said.isEmpty ? " (offline or too slow)" : said): counted as signed in.", info) }
            else { log("Checked the \(site) sign-in\(said): \(value! ? "signed in" : "signed out").", info) }
            return value
        }
        verdicts[domain] = (now(), task)
        lock.unlock()
        return await task.value
    }

    func snapshot(_ domains: [String]) async -> [String: StoredCookie] {
        var out: [String: StoredCookie] = [:]
        for domain in domains { for c in await jar.get(domain: domain) { out["\(JS.replace(c.domain, "^\\.", ""))|\(c.path)|\(c.name)"] = c } }
        return out
    }

    /// A copy that failed its check undone completely (C3).
    func undo(_ before: [String: StoredCookie], _ domains: [String]) async {
        for (key, c) in await snapshot(domains) {
            let was = before[key]
            if let was, was.value == c.value { continue }
            let host = JS.replace(c.domain, "^\\.", "")
            await jar.remove(url: "http\(c.secure ? "s" : "")://\(host)\(c.path)", name: c.name)
            if var back = was { back.domain = was!.hostOnly ? host : was!.domain; await jar.set(back) }
        }
        lock.lock(); for d in domains { verdicts[d] = nil }; lock.unlock()
    }

    public func stillSignedIn(_ app: String) async -> Bool {
        if !(await signedIn(app)) { return false }
        lock.lock(); verdicts[Self.pickKey(app)] = nil; lock.unlock()
        return await works(app) != false
    }

    func drop(_ app: String) async {
        guard let entry = ConnectSources.signInCookies[app] else { return }
        lock.lock(); verdicts[entry.domain] = nil; lock.unlock()
        for c in await jar.get(domain: entry.domain) where entry.matches(c.name) {
            await jar.remove(url: "http\(c.secure ? "s" : "")://\(JS.replace(c.domain.isEmpty ? entry.domain : c.domain, "^\\.", ""))\(c.path)", name: c.name)
        }
    }

    func live(_ app: String) async -> (live: Bool, unchecked: Bool, dead: Bool) {
        if !(await signedIn(app)) { return (false, false, false) }
        let ok = await works(app)
        if ok == false { await drop(app); return (false, false, true) }
        return (true, ok == nil, false)
    }

    public func browserName() -> String { let n = JS.replace(defaultBrowser(), "^Google ", ""); return n.isEmpty ? "your browser" : n }

    func listed() -> [BrowserSource] { (importer?.sources() ?? []).filter { !$0.profiles.isEmpty } }

    func profileOf(_ source: BrowserSource, app: String? = nil) -> BrowserSource.Profile {
        let want = choice.profile
        let pick = app.flatMap { picked($0) }
        return (want.flatMap { w in source.profiles.first { $0.id == w } })
            ?? (pick.flatMap { p in p.browser == source.id ? source.profiles.first { $0.id == p.profile } : nil })
            ?? source.profiles.first { $0.id == "Default" } ?? source.profiles[0]
    }

    func readable(_ app: String? = nil) -> [BrowserSource] {
        guard let id = chosenId(), var source = listed().first(where: { $0.id == id }) else { return [] }
        source.count = source.profiles.count
        source.profiles = [profileOf(source, app: app)]
        return [source]
    }

    func openable(_ app: String? = nil) -> [BrowserSource] {
        let now = readable(app)
        if !now.isEmpty { return now }
        return (importer?.installedChromium() ?? []).filter { $0.id == chosenId() }.map { s in
            var x = s; x.count = s.profiles.count; x.profiles = s.profiles.isEmpty ? [] : [profileOf(s, app: app)]; return x
        }
    }

    func printOf(_ source: BrowserSource, _ profile: BrowserSource.Profile, _ domains: [String]) -> String {
        guard let names = try? importer?.cookieNames(browser: source.id, profile: profile.id, domains: domains) else { return "" }
        return names.map { "\($0.domain)/\($0.name)@\(JS.number($0.stamp))" }.sorted().joined(separator: "\n")
    }

    func holding(_ app: String, _ source: BrowserSource, _ profile: BrowserSource.Profile) -> (stamp: Double, print: String)? {
        guard let entry = ConnectSources.signInCookies[app], let names = try? importer?.cookieNames(browser: source.id, profile: profile.id, domains: Self.domainsOf(app)) else { return nil }
        guard let hit = names.first(where: { $0.domain == entry.domain && entry.matches($0.name) }) else { return nil }
        return (hit.stamp, names.map { "\($0.domain)/\($0.name)@\(JS.number($0.stamp))" }.sorted().joined(separator: "\n"))
    }

    func holders(_ app: String, _ source: BrowserSource) -> [BrowserSource.Profile] { source.profiles.filter { holding(app, source, $0) != nil } }

    public func picked(_ app: String) -> (browser: String, profile: String)? { picks?.get(Self.pickKey(app)) }

    @discardableResult
    public func choose(_ app: String, browser: String, profile: String) -> Bool {
        guard let picks, !Self.pickKey(app).isEmpty, !browser.isEmpty, !profile.isEmpty else { return false }
        picks.set(Self.pickKey(app), browser: browser, profile: profile)
        lock.lock(); verdicts[Self.pickKey(app)] = nil; lock.unlock()
        return true
    }

    public struct Holder: Sendable, Equatable { public var browserId, browser, profileId, name, email: String; public var keychain: Bool
        public var json: JSONValue { ["browserId": .string(browserId), "browser": .string(browser), "profileId": .string(profileId), "name": .string(name), "email": .string(email), "keychain": .bool(keychain)] } }

    /// The chosen profile, when it holds the app's sign-in (one at most, C4).
    public func holdersOf(_ app: String) -> [Holder] {
        guard copies(app) else { return [] }
        return readable(app).flatMap { source in holders(app, source).map { p in
            lock.lock(); let wasAsked = asked.contains(source.id); lock.unlock()
            return Holder(browserId: source.id, browser: source.name, profileId: p.id, name: p.name.isEmpty ? p.id : p.name, email: p.email, keychain: source.family == "chromium" && !wasAsked)
        } }
    }

    func openers(_ sources: [BrowserSource]) -> [BrowserSource] {
        let defaultId = Self.browserIdOf(defaultBrowser())
        return Array(sources.filter { $0.id == chosenId() && ($0.bundle != nil || $0.id == defaultId) }.prefix(1))
    }
    func opener(_ sources: [BrowserSource]) -> BrowserSource? { openers(sources).first }

    func installedNow(_ source: BrowserSource) async -> Bool { guard let importer else { return true }; return await importer.ready(source.id) }

    func openPage(_ source: BrowserSource, _ url: String) async throws {
        if let openInProfile, source.family == "chromium", let profile = source.profiles.first, source.count > 1 {
            do { try await openInProfile(source.id, profile.id, url); return } catch {
                log("Couldn't open a page in \(source.name)'s \(profile.name.isEmpty ? profile.id : profile.name) profile (\(error.localizedDescription)): opened where \(source.name) is.", nil)
            }
        }
        if source.id == Self.browserIdOf(defaultBrowser()) || openIn == nil { try await openExternal(url) } else { try await openIn!(source.id, url) }
    }

    func openFirst(_ sources: [BrowserSource], _ url: String) async -> BrowserSource? {
        for source in openers(sources) {
            if !(await installedNow(source)) { continue }
            do { try await openPage(source, url); return source } catch { log("Couldn't open a page in \(source.name) (\(error.localizedDescription)).", nil) }
        }
        return nil
    }

    /// The app's sign-in page (else its start page) opened in the browser the person chose → its name, or ''.
    public func openApp(_ app: String) async -> String {
        let url = Self.signInPages[app] ?? ConnectSources.apps[app]?.start ?? ""
        if url.isEmpty { return "" }
        let sources = openable(app)
        if sources.isEmpty { do { try await openExternal(url); return browserName() } catch { return "" } }
        return await openFirst(sources, url)?.name ?? ""
    }

    public struct Copy: Sendable, Equatable {
        public var copied = 0
        public var signedIn: Bool? = nil
        public var browser: String? = nil, profile: String? = nil
        public var declined = false, noBrowser = false
        public var needs: String? = nil
        public var refused: String? = nil, refusedId: String? = nil
    }

    public func copyBlind(_ app: String, denied: SetBox) async -> Bool { await copyDomains(Self.domainsOf(app), denied: denied) }
    public func copyDomains(_ domains: [String], denied: SetBox) async -> Bool { await copyFor(name: "", domains: domains, denied: denied).copied > 0 }

    /// A tool's sign-in (C7): every cookie of its domains copied from the chosen profile, checked where it can be.
    public func copyFor(name: String = "", domains: [String], denied: SetBox = SetBox()) async -> Copy {
        let wanted = Self.registrable(domains)
        guard let importer, !wanted.isEmpty else { return Copy() }
        if choice.keychain == "declined" { return Copy(declined: true) }
        guard let source = readable().first else { return Copy(noBrowser: true) }
        if !canRead(source.id) { return Copy(browser: source.name, needs: "disk-access") }
        lock.lock(); let refusedBefore = refusedHere.contains(source.id), askedBefore = asked.contains(source.id); lock.unlock()
        if denied.has(source.id) || refusedBefore { return Copy(refused: source.name, refusedId: source.id) }
        if source.family == "chromium" && !askedBefore && choice.keychain != "allowed" { return Copy(browser: source.name, needs: "keychain") }
        let profile = source.profiles[0]
        let profileName = source.count > 1 ? (profile.name.isEmpty ? profile.id : profile.name) : nil
        let before = await snapshot(wanted)
        let result: Int?
        do {
            result = try await oneAtATime(source.id) { [self] in
                if denied.has(source.id) { throw CookieImportError.denied }
                if source.family == "chromium" { lock.lock(); asked.insert(source.id); lock.unlock() }
                return try await importer.importCookies(browser: source.id, profile: profile.id, domains: wanted, quiet: true)
            }
        } catch CookieImportError.denied { denied.add(source.id); return Copy(refused: source.name, refusedId: source.id) }
        catch CookieImportError.needs(let what) { return Copy(browser: source.name, needs: what) }
        catch { log("Couldn't copy \(name.isEmpty ? wanted.joined(separator: ", ") : name) from \(source.name): \(error.localizedDescription)", nil); return Copy(browser: source.name, profile: profileName) }
        // An importer that doesn't count (a fake) counts as one copied.
        let copied = result ?? 1
        var signedIn: Bool?
        for domain in wanted where Self.checkedSites[domain] != nil {
            lock.lock(); verdicts[domain] = nil; lock.unlock()
            let answer = await checkSite(domain)
            if answer == false { signedIn = false } else if answer == true && signedIn != false { signedIn = true }
        }
        if signedIn == false { await undo(before, wanted); return Copy(copied: 0, signedIn: false, browser: source.name, profile: profileName) }
        if copied == 0 && signedIn == nil && before.isEmpty { signedIn = false }
        return Copy(copied: copied, signedIn: signedIn, browser: source.name, profile: profileName)
    }

    /// Google's sign-in group, signed in in the person's browser where a copy can't work in Engelbart.
    public func heldThere(_ app: String) -> Bool {
        guard supports(app), ConnectSources.signsInThroughBrowser(app) else { return false }
        return readable(app).contains { !holders(app, $0).isEmpty }
    }

    public func opensIn(_ app: String) -> String { copies(app) ? (opener(openable(app))?.name ?? "") : "" }

    struct Found { var browser: String?; var browserId: String?; var profile = ""; var unchecked = false; var refused: String?; var refusedId: String?; var dead = false; var copied = false
        var needs: String?; var from: String?; var declined = false }

    /// The app's sign-in from the chosen profile, brought in and checked (bringOver).
    func bringOver(_ app: String, _ sources: [BrowserSource], denied: SetBox, seen: SeenPrints, askedOnly: Bool = false) async throws -> Found {
        if isHere(app) { return Found() }
        if choice.keychain == "declined" { return Found(declined: true) }
        let domains = Self.domainsOf(app)
        var refused: BrowserSource?
        var failure: Error?
        var dead = false, copiedDead = false
        for source in sources {
            if !canRead(source.id) { return Found(needs: "disk-access", from: source.name) }
            guard let profile = source.profiles.first, let cookie = holding(app, source, profile) else { continue }
            lock.lock(); let refusedBefore = refusedHere.contains(source.id), askedBefore = asked.contains(source.id); lock.unlock()
            if denied.has(source.id) || refusedBefore { refused = refused ?? source; continue }
            if askedOnly && source.family == "chromium" && !askedBefore && choice.keychain != "allowed" { continue }
            let key = "\(source.id)/\(profile.id)"
            if seen.get(key) == cookie.print { dead = true; continue }
            let before = await snapshot(domains)
            do {
                _ = try await oneAtATime(source.id) { [self] in
                    if denied.has(source.id) { throw CookieImportError.denied }
                    if source.family == "chromium" { lock.lock(); asked.insert(source.id); lock.unlock() }
                    return try await importer!.importCookies(browser: source.id, profile: profile.id, domains: domains, quiet: true)
                }
            } catch CookieImportError.denied { refused = refused ?? source; denied.add(source.id); continue }
            catch CookieImportError.needs(let what) { return Found(needs: what, from: source.name) }
            catch { failure = failure ?? error; continue }
            lock.lock(); verdicts[Self.pickKey(app)] = nil; lock.unlock()
            let ok: Bool? = await signedIn(app) ? await works(app) : false
            if ok != false {
                return Found(browser: source.name, browserId: source.id, profile: (source.count > 0 ? source.count : source.profiles.count) > 1 ? (profile.name.isEmpty ? profile.id : profile.name) : "", unchecked: ok == nil)
            }
            await undo(before, domains)
            dead = true; copiedDead = true
            seen.set(key, cookie.print)
        }
        if let refused { return Found(refused: refused.name, refusedId: refused.id) }
        if dead { return Found(dead: true, copied: copiedDead) }
        if let failure { throw failure }
        return Found()
    }

    public struct SignInOutcome: Sendable, Equatable {
        public var status: String
        public var browser = ""
        public var browserId: String? = nil
        public var profile: String? = nil
        public var opened = false
        public var unchecked = false
        public var json: JSONValue {
            var o: [String: JSONValue] = ["status": .string(status), "browser": .string(browser), "opened": .bool(opened)]
            if let browserId { o["browserId"] = .string(browserId) }
            if let profile, !profile.isEmpty { o["profile"] = .string(profile) }
            if unchecked { o["unchecked"] = true }
            return .object(o)
        }
    }

    func from(_ f: Found, status: String, opened: Bool) -> SignInOutcome { SignInOutcome(status: status, browser: f.browser ?? "", profile: f.profile.isEmpty ? nil : f.profile, opened: opened, unchecked: f.unchecked) }

    /// Sign in to `app` (signed-in / timeout / cancelled / denied / no-browser / unsupported / needs-disk-access / declined /
    /// held-elsewhere). `timeoutMs` infinity waits until signed in or `signal` aborts.
    public func signIn(_ app: String, signal: AbortSignal? = nil, onOpened: @escaping (String) -> Void = { _ in }, timeoutMs: Double? = nil, denied: SetBox? = nil) async -> SignInOutcome {
        let held = supports(app) ? await live(app) : (await signedIn(app), false, false)
        if held.0 { return SignInOutcome(status: "signed-in", unchecked: held.1) }
        guard copies(app), importer != nil else { return SignInOutcome(status: "unsupported", browser: browserName()) }
        let sources = readable(app)
        let targets = sources.isEmpty ? openable(app) : sources
        if targets.isEmpty { return SignInOutcome(status: "no-browser") }
        let deniedSet = denied ?? SetBox()
        let seen = SeenPrints()
        let first = sources.isEmpty ? Found() : ((try? await bringOver(app, sources, denied: deniedSet, seen: seen)) ?? Found())
        if first.browser != nil { return from(first, status: "signed-in", opened: false) }
        if let r = first.refused { return SignInOutcome(status: "denied", browser: r, browserId: first.refusedId) }
        if first.needs != nil { return SignInOutcome(status: "needs-disk-access", browser: first.from ?? "") }
        if first.declined { return SignInOutcome(status: "declined") }
        if signal?.isAborted == true { return SignInOutcome(status: "cancelled") }
        if first.dead && heldThere(app) { return SignInOutcome(status: "held-elsewhere", browser: opener(sources)?.name ?? browserName()) }
        let url = Self.signInPages[app] ?? ConnectSources.apps[app]?.start ?? ""
        guard let target = await openFirst(targets, url) else { return SignInOutcome(status: "no-browser") }
        onOpened(target.name)
        let key = Self.pickKey(app)
        lock.lock(); waitingIn[key] = target; lock.unlock()
        defer { lock.lock(); if waitingIn[key]?.id == target.id { waitingIn[key] = nil }; lock.unlock() }
        let found = await waitLoop(signal: signal, limit: timeoutMs ?? timeout, stop: { self.isHere(app) }) { () async -> Found? in
            let now = sources.isEmpty ? self.readable(app) : sources
            guard !now.isEmpty, let f = try? await self.bringOver(app, now, denied: deniedSet, seen: seen) else { return nil }
            return f.browser != nil || f.refused != nil ? f : nil
        }
        switch found {
        case .cancelled: return SignInOutcome(status: "cancelled")
        case .here: return await signedIn(app) ? SignInOutcome(status: "signed-in", opened: true) : SignInOutcome(status: "cancelled")
        case .found(let f):
            if f.browser != nil { return from(f, status: "signed-in", opened: true) }
            if let r = f.refused { return SignInOutcome(status: "denied", browser: r, browserId: f.refusedId) }
        case .timeout: break
        }
        return SignInOutcome(status: "timeout", browser: target.name)
    }

    enum Wait<T> { case found(T), cancelled, here, timeout }

    /// A wait's looks: every poll for the first two minutes, then every 15 s, until found, aborted, stopped or `limit`.
    func waitLoop<T>(signal: AbortSignal?, limit: Double, stop: @escaping () -> Bool, _ look: @escaping () async -> T?) async -> Wait<T> {
        let until = limit.isFinite ? now() + limit : .infinity
        var waited = 0.0
        while now() < until {
            let w = waited < fastFor ? poll : slowPoll
            await sleep(w)
            waited += w
            if signal?.isAborted == true { return .cancelled }
            if stop() { return .here }
            if let f = await look() { return .found(f) }
        }
        return .timeout
    }

    public struct Quiet: Sendable, Equatable {
        public var signedIn: Bool
        public var browser = ""
        public var profile: String? = nil
        public var unchecked = false
        public var here = false
        public var refused = "", refusedId = ""
        public var noBrowser = false, declined = false, held = false
        public var needs: String? = nil
    }

    /// Whether the app's sign-in is in Engelbart's store and works, or can be brought over without opening anything.
    public func signInQuiet(_ app: String, denied: SetBox = SetBox(), askedOnly: Bool = false, fresh: Bool = false) async -> Quiet {
        if canSignIn(app) && (isHere(app) || !supports(app)) {
            let mark = isHere(app)
            if fresh { await drop(app); return Quiet(signedIn: false, here: mark) }
            let held = await live(app)
            return held.live ? Quiet(signedIn: true, unchecked: held.unchecked, here: mark) : Quiet(signedIn: false, here: mark)
        }
        guard supports(app), importer != nil else { return Quiet(signedIn: false) }
        if fresh { await drop(app) }
        let held = fresh ? (false, false, false) : await live(app)
        if held.0 { return Quiet(signedIn: true, unchecked: held.1) }
        let sources = readable(app)
        if sources.isEmpty { return Quiet(signedIn: false, noBrowser: true) }
        let found = (try? await bringOver(app, sources, denied: denied, seen: SeenPrints(), askedOnly: askedOnly)) ?? Found()
        if let b = found.browser { return Quiet(signedIn: true, browser: b, profile: found.profile.isEmpty ? nil : found.profile, unchecked: found.unchecked) }
        if let needs = found.needs { return Quiet(signedIn: false, browser: found.from ?? "", needs: needs) }
        if found.declined { return Quiet(signedIn: false, declined: true) }
        return Quiet(signedIn: false, refused: found.refused ?? "", refusedId: found.refusedId ?? "", held: found.refused == nil && !askedOnly && found.dead && heldThere(app))
    }

    public struct Recapture: Sendable, Equatable { public var signedIn: Bool; public var unchecked = false; public var browser: String? = nil; public var profile: String? = nil
        public var reason: String? = nil; public var refused: String? = nil; public var refusedId: String? = nil }

    /// The native-browser fallback (C8): copied at once when the cookies are there, else the page opens in the chosen
    /// browser and profile and the cookies are copied once any of them appears or changes; then checked.
    public func recapture(app: String? = nil, tool: (name: String, url: String, domains: [String])? = nil, signal: AbortSignal? = nil, timeoutMs: Double? = nil, denied: SetBox = SetBox()) async -> Recapture {
        let limit = timeoutMs ?? timeout
        guard importer != nil else { return Recapture(signedIn: false, reason: "unsupported") }
        if choice.keychain == "declined" { return Recapture(signedIn: false, reason: "declined") }
        if let app, supports(app) { return await recaptureApp(app, signal: signal, limit: limit, denied: denied) }
        let t = app.map { (name: $0, url: Self.signInPages[$0] ?? ConnectSources.apps[$0]?.start ?? "", domains: Self.domainsOf($0)) } ?? tool ?? (name: "", url: "", domains: [])
        let domains = Self.registrable(t.domains.isEmpty ? (t.url.isEmpty ? [] : [t.url]) : t.domains)
        if domains.isEmpty { return Recapture(signedIn: false, reason: "unsupported") }
        return await recaptureSites(name: t.name.isEmpty ? domains[0] : t.name, domains: domains, url: t.url.isEmpty ? "https://\(domains[0])/" : t.url, signal: signal, limit: limit, denied: denied)
    }

    func failedCopy(refused: String?, refusedId: String?, needs: String?, declined: Bool, noBrowser: Bool) -> Recapture? {
        if let refused { return Recapture(signedIn: false, refused: refused, refusedId: refusedId) }
        if needs == "disk-access" { return Recapture(signedIn: false, reason: "disk-access") }
        if needs == "keychain" { return Recapture(signedIn: false, reason: "keychain") }
        if declined { return Recapture(signedIn: false, reason: "declined") }
        if noBrowser { return Recapture(signedIn: false, reason: "no-browser") }
        return nil
    }

    func recaptureApp(_ app: String, signal: AbortSignal?, limit: Double, denied: SetBox) async -> Recapture {
        if isHere(app) { let held = await live(app); return held.live ? Recapture(signedIn: true, unchecked: held.unchecked) : Recapture(signedIn: false, reason: "signed-out") }
        let sources = readable(app)
        let targets = sources.isEmpty ? openable(app) : sources
        if targets.isEmpty { return Recapture(signedIn: false, reason: "no-browser") }
        let seen = SeenPrints()
        let done = { (f: Found) in Recapture(signedIn: true, unchecked: f.unchecked, browser: f.browser, profile: f.profile.isEmpty ? nil : f.profile) }
        let first = sources.isEmpty ? Found() : ((try? await bringOver(app, sources, denied: denied, seen: seen)) ?? Found())
        if first.browser != nil { return done(first) }
        if let failed = failedCopy(refused: first.refused, refusedId: first.refusedId, needs: first.needs, declined: first.declined, noBrowser: false) { return failed }
        if signal?.isAborted == true { return Recapture(signedIn: false, reason: "cancelled") }
        let url = Self.signInPages[app] ?? ConnectSources.apps[app]?.start ?? ""
        guard !url.isEmpty, await openFirst(targets, url) != nil else { return Recapture(signedIn: false, reason: "no-browser") }
        let held = first.dead
        let found = await waitLoop(signal: signal, limit: held ? min(limit, heldWait) : limit, stop: { self.isHere(app) }) { () async -> Found? in
            let now = sources.isEmpty ? self.readable(app) : sources
            guard !now.isEmpty else { return nil }
            let out = (try? await self.bringOver(app, now, denied: denied, seen: seen)) ?? Found()
            if out.dead && out.copied { var t = Found(); t.dead = true; t.copied = true; t.browser = nil; return t }
            return out.browser != nil || out.refused != nil ? out : nil
        }
        switch found {
        case .cancelled: return Recapture(signedIn: false, reason: "cancelled")
        case .here: return await signedIn(app) ? Recapture(signedIn: true) : Recapture(signedIn: false, reason: "signed-out")
        case .found(let f):
            if f.browser != nil { return done(f) }
            if f.refused != nil { return failedCopy(refused: f.refused, refusedId: f.refusedId, needs: nil, declined: false, noBrowser: false)! }
            return Recapture(signedIn: false, reason: "turned-away")
        case .timeout: return held ? Recapture(signedIn: false, reason: "turned-away") : Recapture(signedIn: false, reason: "timeout")
        }
    }

    func recaptureSites(name: String, domains: [String], url: String, signal: AbortSignal?, limit: Double, denied: SetBox) async -> Recapture {
        let good = { (c: Copy) in c.copied > 0 && c.signedIn != false }
        let done = { (c: Copy) in Recapture(signedIn: true, unchecked: c.signedIn == nil, browser: c.browser, profile: c.profile) }
        let first = await copyFor(name: name, domains: domains, denied: denied)
        if good(first) { return done(first) }
        if let failed = failedCopy(refused: first.refused, refusedId: first.refusedId, needs: first.needs, declined: first.declined, noBrowser: first.noBrowser) { return failed }
        if signal?.isAborted == true { return Recapture(signedIn: false, reason: "cancelled") }
        let targets = openable()
        if targets.isEmpty { return Recapture(signedIn: false, reason: "no-browser") }
        guard await openFirst(targets, url) != nil else { return Recapture(signedIn: false, reason: "no-browser") }
        let printNow = { () -> String in guard let s = self.readable().first else { return "" }; return self.printOf(s, s.profiles[0], domains) }
        let last = Box(printNow())
        let found = await waitLoop(signal: signal, limit: limit, stop: { false }) { () async -> Copy? in
            let print = printNow()
            if print.isEmpty || print == last.get() { return nil }
            last.set(print)
            let out = await self.copyFor(name: name, domains: domains, denied: denied)
            if good(out) || out.refused != nil { return out }
            return nil
        }
        switch found {
        case .cancelled: return Recapture(signedIn: false, reason: "cancelled")
        case .found(let c): return c.refused != nil ? Recapture(signedIn: false, refused: c.refused, refusedId: c.refusedId) : done(c)
        default: return Recapture(signedIn: false, reason: "timeout")
        }
    }

    /// "Use another account": Google's add-an-account page in the browser being waited on.
    public func anotherAccount(_ app: String) async -> (opened: Bool, browser: String) {
        guard copies(app), Self.pickKey(app) == "google.com" else { return (false, "") }
        lock.lock(); let target = waitingIn[Self.pickKey(app)]; lock.unlock()
        guard let target else { return (false, "") }
        do { try await openPage(target, Self.anotherAccountPage); return (true, target.name) } catch {
            log("Couldn't open Google's add-an-account page in \(target.name) (\(error.localizedDescription)).", nil)
            return (false, target.name)
        }
    }

    /// Ask macOS for the Keychain key of the browser `app`'s sign-in will be copied from, before anything opens.
    public func unlock(_ app: String, denied: SetBox? = nil) async -> (status: String, browser: String, browserId: String?) {
        guard copies(app), let importer, let target = keychainTarget(app) else { return ("allowed", "", nil) }
        if denied?.has(target.id) == true { return ("denied", target.name, target.id) }
        do {
            try await oneAtATime(target.id) { [self] in lock.lock(); asked.insert(target.id); lock.unlock(); try await importer.unlock(target.id) }
            return ("allowed", target.name, nil)
        } catch CookieImportError.denied {
            denied?.add(target.id)
            lock.lock(); asked.remove(target.id); lock.unlock()
            return ("denied", target.name, target.id)
        } catch { return ("allowed", target.name, nil) }
    }

    /// Allow on "Allow Engelbart to use your <browser> sign-ins?" (C5): macOS asked for the chosen browser's key at once.
    public func unlockBrowser(_ browserId: String? = nil) async -> JSONValue {
        guard let importer, let id = browserId ?? chosenId() else { return ["keychain": "allowed"] }
        let source = listed().first { $0.id == id }
        let name = source?.name ?? (id == "safari" ? "Safari" : id)
        let family = source?.family ?? (id == "safari" ? "safari" : id == "firefox" ? "firefox" : "chromium")
        if family == "safari" { return canRead(id) ? ["keychain": "allowed"] : ["keychain": "refused", "browser": .string(name), "needs": "disk-access"] }
        if family != "chromium" { return ["keychain": "allowed"] }
        do {
            try await oneAtATime(id) { [self] in lock.lock(); asked.insert(id); lock.unlock(); try await importer.unlock(id) }
            lock.lock(); refusedHere.remove(id); lock.unlock()
            return ["keychain": "allowed"]
        } catch CookieImportError.denied {
            lock.lock(); asked.remove(id); refusedHere.insert(id); lock.unlock()
            return ["keychain": "refused", "browser": .string(name)]
        } catch { return ["keychain": "allowed"] }
    }

    /// A browser's profiles for "Select your {browser} profile" ([] for one or none readable).
    public func profilesOf(_ browserId: String) -> [BrowserSource.Profile] {
        let profiles = (listed().first { $0.id == browserId }?.profiles ?? []).filter { !$0.locked }
        return profiles.count > 1 ? profiles.map { BrowserSource.Profile(id: $0.id, name: $0.name.isEmpty ? $0.id : $0.name, email: $0.email) } : []
    }

    /// The browser macOS will be asked about to bring the app's sign-in over, when it has not been yet → (id, name) | nil.
    public func keychainTarget(_ app: String, holdersOnly: Bool = false) -> (id: String, name: String)? {
        guard copies(app), importer != nil else { return nil }
        let sources = readable(app)
        let target = sources.first { !holders(app, $0).isEmpty } ?? (holdersOnly ? nil : opener(sources.isEmpty ? openable(app) : sources))
        lock.lock(); defer { lock.unlock() }
        guard let target, target.family == "chromium", !asked.contains(target.id) else { return nil }
        return (target.id, target.name)
    }

    public func keychainNote(_ app: String, holdersOnly: Bool = false) -> String {
        keychainTarget(app, holdersOnly: holdersOnly).map { "macOS will ask to use \($0.name)'s sign-ins. Choose Allow." } ?? ""
    }

    /// Every answer kept in memory dropped (test mode's reset).
    public func forget() { lock.lock(); verdicts = [:]; waitingIn = [:]; here = []; refusedHere = []; lock.unlock() }
    public func readableCount() -> Int { readable().count }
}

/// A shared set of browser ids (Electron's `denied` Set passed between calls).
public final class SetBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items = Set<String>()
    public init(_ items: Set<String> = []) { self.items = items }
    public func has(_ s: String) -> Bool { lock.lock(); defer { lock.unlock() }; return items.contains(s) }
    public func add(_ s: String) { lock.lock(); items.insert(s); lock.unlock() }
    public func remove(_ s: String) { lock.lock(); items.remove(s); lock.unlock() }
    public func clear() { lock.lock(); items.removeAll(); lock.unlock() }
}

final class SeenPrints: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [String: String] = [:]
    func get(_ k: String) -> String? { lock.lock(); defer { lock.unlock() }; return map[k] }
    func set(_ k: String, _ v: String) { lock.lock(); map[k] = v; lock.unlock() }
}
