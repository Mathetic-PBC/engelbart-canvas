import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// Engelbart's own cookie store as the tests see it (cookies matched on their domain's ending, as Electron's fixture).
final class FakeJar: CookieJar, @unchecked Sendable {
    let lock = NSLock()
    var cookies: [StoredCookie]
    var removed: [(url: String, name: String)] = []
    init(_ cookies: [StoredCookie] = []) { self.cookies = cookies }
    func get(domain: String) async -> [StoredCookie] { lock.lock(); defer { lock.unlock() }; return cookies.filter { $0.domain.hasSuffix(domain) } }
    func remove(url: String, name: String) async {
        lock.lock(); defer { lock.unlock() }
        removed.append((url, name))
        let host = URL(string: url)?.host ?? ""
        cookies.removeAll { $0.name == name && JS.replace($0.domain, "^\\.", "") == host }
    }
    func set(_ cookie: StoredCookie) async { lock.lock(); cookies.removeAll { $0.domain == cookie.domain && $0.name == cookie.name && $0.path == cookie.path }; cookies.append(cookie); lock.unlock() }
}

/// The Stage's cookie import, faked (connect-web-signin.test.cjs fixture / machine / google): browsers with profiles that
/// hold the app's sign-in cookie or not; an import copies it into the jar; Google's check page answers in turn.
final class FakeImporter: CookieImporter, @unchecked Sendable {
    struct Profile { var id: String; var name: String; var email = ""; var signedIn: Bool; var stamp: Double = 1 }
    struct Browser { var id: String; var profiles: [Profile]; var deny = false; var installed = true }
    static let names: [String: (String, String, String)] = ["chrome": ("Chrome", "chromium", "com.google.Chrome"), "brave": ("Brave", "chromium", "com.brave.Browser"),
                                                            "firefox": ("Firefox", "firefox", "org.mozilla.firefox")]
    let lock = NSLock()
    var browsers: [Browser]
    let cookie: (domain: String, name: String)
    let jar: FakeJar
    var answers: [Bool?]
    var checks = 0
    var imports: [(browser: String, profile: String, domains: [String], quiet: Bool)] = []
    var keychain: [String] = []
    var looks: [String: Int] = [:]
    var unlocked: [String] = []
    /// The person signs in once a page has opened (in place of Electron's look counts).
    var signedInAfterOpen = false
    var opened = false

    init(_ browsers: [Browser], cookie: (String, String), jar: FakeJar, checks: [Bool?] = []) { self.browsers = browsers; self.cookie = cookie; self.jar = jar; answers = checks }

    func source(_ b: Browser) -> BrowserSource {
        let n = Self.names[b.id]!
        return BrowserSource(id: b.id, name: n.0, family: n.1, bundle: n.2, profiles: b.profiles.map { BrowserSource.Profile(id: $0.id, name: $0.name, email: $0.email) })
    }
    func sources() -> [BrowserSource] { browsers.map(source) }
    func installedChromium() -> [BrowserSource] { browsers.filter { Self.names[$0.id]!.1 == "chromium" }.map(source) }
    func cookieNames(browser: String, profile: String, domains: [String]) throws -> [(domain: String, name: String, stamp: Double)] {
        lock.lock(); defer { lock.unlock() }
        looks[browser, default: 0] += 1
        let p = browsers.first { $0.id == browser }?.profiles.first { $0.id == profile }
        let held = (p?.signedIn ?? false) || (signedInAfterOpen && opened)
        return held ? [(cookie.domain, cookie.name, p?.stamp ?? 1), (cookie.domain, "NID", 1)] : [(cookie.domain, "NID", 1)]
    }
    func checkDetail(_ domain: String) async -> (signedIn: Bool?, status: Int?, location: String?, reason: String?)? {
        lock.lock(); checks += 1; let a: Bool? = answers.isEmpty ? true : answers.removeFirst(); lock.unlock()
        return (a, a == nil ? nil : 200, nil, a == nil ? "timed out" : nil)
    }
    func canRead(_ browserId: String) -> Bool { browserId != "safari" }
    func importCookies(browser: String, profile: String, domains: [String], quiet: Bool) async throws -> Int? {
        lock.lock()
        if Self.names[browser]?.1 == "chromium" { keychain.append(browser) }
        let deny = browsers.first { $0.id == browser }?.deny == true
        if !deny { imports.append((browser, profile, domains, quiet)) }
        lock.unlock()
        if deny { throw CookieImportError.denied }
        await jar.set(StoredCookie(domain: ".\(cookie.domain)", name: cookie.name, value: "v\(imports.count)", secure: true))
        return 1
    }
    func unlock(_ browserId: String) async throws { lock.lock(); unlocked.append(browserId); lock.unlock(); if browsers.first(where: { $0.id == browserId })?.deny == true { throw CookieImportError.denied } }
    func ready(_ browserId: String) async -> Bool { browsers.first { $0.id == browserId }?.installed ?? false }
}

final class WebSignInTests: XCTestCase {
    struct Machine { let web: WebSignIn; let importer: FakeImporter; let jar: FakeJar; let opened: Box<[String]>; let openedIn: Box<[[String]]>; let log: Box<[String]>; let picks: SigninProfiles }

    func machine(_ defaultName: String = "Google Chrome", _ browsers: [FakeImporter.Browser], app: String = "ChatGPT", checks: [Bool?] = [], held: Bool = false,
                 chosen: WebSignIn.Chosen = WebSignIn.Chosen(), timeoutMs: Double = 200) -> Machine {
        let entry = ConnectSources.signInCookies[app]!
        let name = app == "ChatGPT" ? "__Secure-next-auth.session-token" : "SID"
        XCTAssertTrue(entry.matches(name))
        let jar = FakeJar(held ? [StoredCookie(domain: ".\(entry.domain)", name: name, value: "old", secure: true)] : [])
        let importer = FakeImporter(browsers, cookie: (entry.domain, name), jar: jar, checks: checks)
        let opened = Box<[String]>([]), openedIn = Box<[[String]]>([]), log = Box<[String]>([])
        let picksDir = URL(fileURLWithPath: TempDir.make("picks"))
        let picks = SigninProfiles(dataRoot: { picksDir })
        let web = WebSignIn(importer: importer, jar: jar, defaultBrowser: { defaultName },
                            openExternal: { url in opened.set(opened.get() + [url]); importer.opened = true },
                            openIn: { id, url in openedIn.set(openedIn.get() + [[id, url]]); importer.opened = true },
                            openInProfile: { id, profile, url in openedIn.set(openedIn.get() + [[id, profile, url]]); importer.opened = true },
                            picks: picks, chosen: { chosen }, log: { line, _ in log.set(log.get() + [line]) },
                            pollMs: 1, slowPollMs: 1, timeoutMs: timeoutMs, sleep: { _ in await Task.yield() })
        return Machine(web: web, importer: importer, jar: jar, opened: opened, openedIn: openedIn, log: log, picks: picks)
    }
    let twoProfiles = [FakeImporter.Profile(id: "Profile 1", name: "Work", signedIn: false), FakeImporter.Profile(id: "Default", name: "Me", signedIn: true)]
    func me(_ signedIn: Bool = true, stamp: Double = 1) -> FakeImporter.Profile { .init(id: "Default", name: "Me", signedIn: signedIn, stamp: stamp) }

    func testSignedInAlreadyComesOverNothingOpens() async {
        let m = machine("Google Chrome", [.init(id: "chrome", profiles: twoProfiles)])
        let before = await m.web.signedIn("ChatGPT")
        XCTAssertFalse(before)
        let out = await m.web.signIn("ChatGPT")
        XCTAssertEqual(out, WebSignIn.SignInOutcome(status: "signed-in", browser: "Chrome", profile: "Me", opened: false), "Chrome has two profiles: the one it came from is named")
        XCTAssertEqual(m.opened.get(), [])
        XCTAssertEqual(m.importer.imports.map { "\($0.browser) \($0.profile) \($0.domains) \($0.quiet)" }, [#"chrome Default ["chatgpt.com", "openai.com"] true"#])
        let after = await m.web.signedIn("ChatGPT")
        XCTAssertTrue(after)
    }

    func testNotSignedInOpensTheDefaultAndWaits() async {
        let m = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)])])
        m.importer.signedInAfterOpen = true
        let told = Box("")
        let out = await m.web.signIn("ChatGPT", onOpened: { told.set($0) })
        XCTAssertEqual(out.status, "signed-in"); XCTAssertEqual(out.browser, "Chrome"); XCTAssertTrue(out.opened)
        XCTAssertEqual(m.opened.get(), ["https://chatgpt.com/auth/login"], "the default browser, through openExternal")
        XCTAssertEqual(told.get(), "Chrome")
        XCTAssertEqual(m.importer.imports.count, 1, "nothing written until the sign-in cookie is there")
        // Two profiles: the page opens in the profile a copy reads (open -n -b … --profile-directory).
        let two = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false), .init(id: "Profile 1", name: "Work", signedIn: false)])])
        two.importer.signedInAfterOpen = true
        let twoOut = await two.web.signIn("ChatGPT")
        XCTAssertEqual(twoOut.profile, "Me")
        XCTAssertEqual(two.openedIn.get(), [["chrome", "Default", "https://chatgpt.com/auth/login"]])
        XCTAssertEqual(two.opened.get(), [])
    }

    func testTimeoutCancelAndKeychainRefusal() async {
        let never = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)])])
        let timedOut = await never.web.signIn("ChatGPT")
        XCTAssertEqual(timedOut.status, "timeout")
        let signal = AbortSignal()
        let cancelled = await machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)])]).web.signIn("ChatGPT", signal: signal, onOpened: { _ in signal.abort() })
        XCTAssertEqual(cancelled, WebSignIn.SignInOutcome(status: "cancelled"))
        let refused = machine("Google Chrome", [.init(id: "chrome", profiles: [me()], deny: true)])
        let denied = await refused.web.signIn("ChatGPT")
        XCTAssertEqual(denied, WebSignIn.SignInOutcome(status: "denied", browser: "Chrome", browserId: "chrome"))
        XCTAssertEqual(refused.opened.get(), [], "no page opened once macOS said no")
    }

    func testOneBrowserOnlyC4() async {
        // Safari the default, its sign-ins not readable: Chrome signed in is not read instead, nothing opens.
        let safari = machine("Safari", [.init(id: "chrome", profiles: [me()])])
        let out = await safari.web.signIn("ChatGPT")
        XCTAssertEqual(out, WebSignIn.SignInOutcome(status: "no-browser"))
        XCTAssertTrue(safari.importer.imports.isEmpty && safari.importer.keychain.isEmpty && safari.opened.get().isEmpty && safari.openedIn.get().isEmpty)
        let quiet = await machine("Safari", [.init(id: "firefox", profiles: [me(false)]), .init(id: "chrome", profiles: [me(false)])]).web.signInQuiet("ChatGPT")
        XCTAssertEqual(quiet, WebSignIn.Quiet(signedIn: false, noBrowser: true))
        // Brave chosen and signed in comes over; Chrome holding it too is never looked at.
        let brave = machine("Brave Browser", [.init(id: "chrome", profiles: [me()]), .init(id: "brave", profiles: [me()])])
        let b = await brave.web.signIn("ChatGPT")
        XCTAssertEqual(b, WebSignIn.SignInOutcome(status: "signed-in", browser: "Brave", opened: false))
        XCTAssertNil(brave.importer.looks["chrome"])
        // Its own default opened through openExternal.
        let own = machine("Brave Browser", [.init(id: "chrome", profiles: [me(false)]), .init(id: "brave", profiles: [me(false)])])
        own.importer.signedInAfterOpen = true
        let o = await own.web.signIn("ChatGPT")
        XCTAssertEqual(o.browser, "Brave")
        XCTAssertEqual(own.opened.get(), ["https://chatgpt.com/auth/login"]); XCTAssertEqual(own.openedIn.get(), [])
        // Nothing readable at all.
        let none = machine("Google Chrome", [])
        let n1 = await none.web.signIn("ChatGPT"), n2 = await none.web.signInQuiet("ChatGPT")
        XCTAssertEqual(n1, WebSignIn.SignInOutcome(status: "no-browser"))
        XCTAssertEqual(n2, WebSignIn.Quiet(signedIn: false, noBrowser: true))
        // Chrome refused by macOS: Firefox signed in is not read instead.
        let refused = machine("Google Chrome", [.init(id: "chrome", profiles: [me()], deny: true), .init(id: "firefox", profiles: [me()])])
        let r = await refused.web.signIn("ChatGPT")
        XCTAssertEqual(r, WebSignIn.SignInOutcome(status: "denied", browser: "Chrome", browserId: "chrome"))
        XCTAssertEqual(refused.importer.keychain, ["chrome"], "macOS asked once")
    }

    func testSignInQuietNeverOpens() async {
        let m = machine("Google Chrome", [.init(id: "chrome", profiles: [me()], deny: true)])
        let denied = SetBox()
        let a = await m.web.signInQuiet("ChatGPT", denied: denied), b = await m.web.signInQuiet("ChatGPT", denied: denied)
        XCTAssertEqual(a, WebSignIn.Quiet(signedIn: false, refused: "Chrome", refusedId: "chrome"))
        XCTAssertEqual(b, a, "refused before: still named, macOS not asked")
        XCTAssertEqual(m.importer.keychain, ["chrome"])
        XCTAssertTrue(m.opened.get().isEmpty && m.openedIn.get().isEmpty)
        let fine = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])])
        let f1 = await fine.web.signInQuiet("ChatGPT"), f2 = await fine.web.signInQuiet("ChatGPT")
        XCTAssertEqual(f1, WebSignIn.Quiet(signedIn: true, browser: "Chrome"))
        XCTAssertEqual(f2, WebSignIn.Quiet(signedIn: true), "held already")
        // signIn when held already: nothing imported, nothing looked at.
        let names = fine.importer.looks["chrome"]
        let again = await fine.web.signIn("ChatGPT")
        XCTAssertEqual(again, WebSignIn.SignInOutcome(status: "signed-in", opened: false))
        XCTAssertEqual(fine.importer.imports.count, 1); XCTAssertEqual(fine.importer.looks["chrome"], names)
    }

    func testKeychainTargetAndNote() async {
        XCTAssertNil(machine("Firefox", [.init(id: "firefox", profiles: [me()]), .init(id: "chrome", profiles: [me(false)])]).web.keychainTarget("ChatGPT"), "Firefox chosen: no Keychain")
        let chrome = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])])
        XCTAssertEqual(chrome.web.keychainTarget("ChatGPT")?.id, "chrome")
        _ = await chrome.web.signInQuiet("ChatGPT")
        XCTAssertNil(chrome.web.keychainTarget("ChatGPT"), "asked once this run")
        let none = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)])])
        XCTAssertEqual(none.web.keychainTarget("ChatGPT")?.name, "Chrome", "held by none: where its sign-in page opens")
        XCTAssertNil(none.web.keychainTarget("ChatGPT", holdersOnly: true))
        XCTAssertEqual(none.web.keychainNote("ChatGPT", holdersOnly: true), "")
        XCTAssertEqual(none.web.keychainNote("ChatGPT"), "macOS will ask to use Chrome's sign-ins. Choose Allow.")
        none.importer.signedInAfterOpen = true
        _ = await none.web.signIn("ChatGPT")
        XCTAssertEqual(none.web.keychainNote("ChatGPT"), "")
    }

    func testWhichAppsAndBrowsers() {
        let web = machine("Google Chrome", []).web
        XCTAssertTrue(web.supports("ChatGPT")); XCTAssertTrue(web.supports("Claude")); XCTAssertTrue(web.supports("Notion"))
        XCTAssertFalse(web.supports("Granola")); XCTAssertFalse(web.supports("Evernote"))
        XCTAssertEqual(["Google Chrome", "Brave Browser", "Arc", "Firefox", "Microsoft Edge", "Safari", "Google Chrome Canary"].map(WebSignIn.browserIdOf), ["chrome", "brave", "arc", "firefox", "edge", "safari", nil])
        XCTAssertEqual(WebSignIn.domainsOf("Gemini"), ["google.com"])
        XCTAssertEqual(WebSignIn.registrable(["https://www.linear.app/x", "linear.app", "localhost"]), ["linear.app"])
        XCTAssertEqual(WebSignIn.profileOpenArgs(bundle: "com.google.Chrome", profileId: "Profile 1", url: "https://x"), ["-n", "-b", "com.google.Chrome", "--args", "--profile-directory=Profile 1", "https://x"])
    }

    // 2026-10-12: a copy checked before it counts.
    func testGoogleCopiesChecked() async {
        let dead = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])], app: "Gmail", checks: [false, true], held: true)
        let q = await dead.web.signInQuiet("Gmail")
        XCTAssertEqual(q, WebSignIn.Quiet(signedIn: true, browser: "Chrome"))
        XCTAssertEqual(dead.importer.checks, 2, "the held copy, then the new one")
        XCTAssertEqual(dead.importer.imports.count, 1)
        XCTAssertEqual(dead.jar.removed.count, 1, "the dead one taken out first")
        // Dead in Engelbart though Chrome holds it: said, and no sign-in page opened.
        let bound = machine("Google Chrome", [.init(id: "chrome", profiles: [me(stamp: 5)])], app: "Gmail", checks: [false, false, false, true], held: true)
        let b = await bound.web.signInQuiet("Gmail")
        XCTAssertEqual(b, WebSignIn.Quiet(signedIn: false, held: true))
        XCTAssertEqual(bound.jar.cookies.count, 0, "the dead copy is gone")
        XCTAssertTrue(bound.web.heldThere("Gmail"))
        let out = await bound.web.signIn("Gmail", onOpened: { _ in XCTFail("nothing opens") }, timeoutMs: .infinity)
        XCTAssertEqual(out, WebSignIn.SignInOutcome(status: "held-elsewhere", browser: "Chrome"))
        XCTAssertEqual(bound.opened.get(), [])
        // The check not answering: held, said, logged.
        let offline = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])], app: "Gmail", checks: [nil])
        let o = await offline.web.signInQuiet("Gmail")
        XCTAssertEqual(o, WebSignIn.Quiet(signedIn: true, browser: "Chrome", unchecked: true))
        XCTAssertTrue(offline.log.get().joined(separator: "\n").contains("No answer checking the Google sign-in"))
        // One check for every Google app within a few minutes.
        let one = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])], app: "Gmail")
        for app in ["Gmail", "Google Docs", "Gemini"] { let s = await one.web.signInQuiet(app); XCTAssertTrue(s.signedIn, app) }
        XCTAssertEqual(one.importer.checks, 1); XCTAssertEqual(one.importer.imports.count, 1)
    }

    func testProfilesC4() async {
        let work = FakeImporter.Profile(id: "Profile 1", name: "Work", email: "me@work.example", signedIn: true)
        let two = machine("Google Chrome", [.init(id: "chrome", profiles: [me(), work])], app: "Gmail")
        XCTAssertEqual(two.web.holdersOf("Gmail"), [WebSignIn.Holder(browserId: "chrome", browser: "Chrome", profileId: "Default", name: "Me", email: "", keychain: true)])
        XCTAssertNil(two.web.picked("Gmail"))
        XCTAssertTrue(two.web.choose("Gmail", browser: "chrome", profile: "Profile 1"))
        XCTAssertEqual(two.picks.get("google.com")?.profile, "Profile 1")
        XCTAssertEqual(two.web.picked("Google Docs")?.profile, "Profile 1", "one pick for every Google app")
        let docs = await two.web.signInQuiet("Google Docs")
        XCTAssertEqual(docs, WebSignIn.Quiet(signedIn: true, browser: "Chrome", profile: "Work"))
        XCTAssertEqual(two.importer.imports.map(\.profile), ["Profile 1"])
        // The profile onboarding chose is the only one read.
        let chosen = machine("Google Chrome", [.init(id: "chrome", profiles: [me(), .init(id: "Profile 1", name: "Work", signedIn: true)])], app: "Gmail", checks: [false, false, true], held: true,
                             chosen: WebSignIn.Chosen(browser: "chrome", profile: "Profile 1", keychain: "allowed"))
        _ = chosen.web.choose("Gmail", browser: "chrome", profile: "Default")
        let c = await chosen.web.signInQuiet("Gmail")
        XCTAssertEqual(c, WebSignIn.Quiet(signedIn: false, held: true))
        XCTAssertEqual(chosen.importer.imports.map(\.profile), ["Profile 1"])
        // A browser with one profile: no profile named.
        let lone = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])], app: "Gmail")
        let l = await lone.web.signInQuiet("Gmail")
        XCTAssertEqual(l, WebSignIn.Quiet(signedIn: true, browser: "Chrome"))
        XCTAssertEqual(lone.web.profilesOf("chrome"), [])
        XCTAssertEqual(two.web.profilesOf("chrome").map(\.name), ["Me", "Work"])
    }

    func testGoogleWaitsUntilCancelledAndUnlock() async {
        let m = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)])], app: "Gmail")
        let signal = AbortSignal()
        let told = Box("")
        let pending = Task { await m.web.signIn("Gmail", signal: signal, onOpened: { told.set($0) }, timeoutMs: .infinity) }
        try? await Task.sleep(nanoseconds: 300_000_000) // longer than the 200 ms timeout
        signal.abort()
        let out = await pending.value
        XCTAssertEqual(out, WebSignIn.SignInOutcome(status: "cancelled"))
        XCTAssertEqual(told.get(), "Chrome")
        XCTAssertEqual(m.opened.get(), ["https://accounts.google.com/"])
        // unlock asks macOS for the browser's key and copies nothing; refused → said.
        let u = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)])])
        let ok = await u.web.unlock("ChatGPT")
        XCTAssertEqual(ok.status, "allowed"); XCTAssertEqual(u.importer.unlocked, ["chrome"]); XCTAssertTrue(u.importer.imports.isEmpty)
        let no = machine("Google Chrome", [.init(id: "chrome", profiles: [me(false)], deny: true)])
        let refused = await no.web.unlock("ChatGPT")
        XCTAssertEqual(refused.status, "denied")
        let ff = machine("Firefox", [.init(id: "firefox", profiles: [me(false)])])
        let f = await ff.web.unlock("ChatGPT")
        XCTAssertTrue(ff.importer.unlocked.isEmpty, "Firefox: no Keychain, nothing asked (\(f.status))")
    }

    func testForgetAndSignedInHere() async {
        let m = machine("Google Chrome", [.init(id: "chrome", profiles: [me()])])
        XCTAssertFalse(m.web.isHere("ChatGPT"))
        m.web.signedInHere("ChatGPT")
        XCTAssertTrue(m.web.isHere("ChatGPT"))
        XCTAssertEqual(m.web.holdersOf("ChatGPT"), [], "signed in here: never copied over again")
        m.web.forget()
        XCTAssertFalse(m.web.isHere("ChatGPT"))
        XCTAssertEqual(m.web.readableCount(), 1)
    }
}
