import AppKit
import WebKit
import EngelbartCore

// The Stage's browsing session (decision 48; src/main/browser/views.cjs PARTITION): one persistent website data store for
// every tab and popup in every window, apart from anything else in the app, so sign-ins last across launches. Electron's
// `persist:browser` partition is `WKWebsiteDataStore(forIdentifier: StageSession.identifier)`; a run from a checkout
// (`swift run`, an unbundled build: Electron's `npm start`) keeps its own (`devIdentifier`, Electron's persist:browser-dev),
// so a developer's test sign-ins never mix with the packaged app's. The Connect package's sign-in windows must use
// `StageSession.shared.dataStore` too: the agents read the same cookies.
//
// Cookies: WebKit writes its store itself, so Electron's flushStore timer and the flush on quit are not needed.

@MainActor
public final class StageSession {
    /// The Stage's data store for a packaged app (fixed: changing it signs everyone out).
    public static let identifier = UUID(uuidString: "8E1A6C1E-5747-4E5B-9A0B-5354A6E4B001")!
    /// A checkout's (an unbundled run's) data store.
    public static let devIdentifier = UUID(uuidString: "8E1A6C1E-5747-4E5B-9A0B-5354A6E4B0DE")!
    /// The content world the page script runs in (Electron's isolated world).
    public static let world = WKContentWorld.world(name: "engelbart-page")
    public static let handlerName = "engelbartPage"

    public static let shared = StageSession()

    /// Whether this copy is the packaged app (an .app bundle) rather than a run from a checkout.
    public static var packaged: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    public let dataStore: WKWebsiteDataStore
    /// "Engelbart/<version>": the app's own token, kept as Electron kept it (cleanUserAgent removed only Electron's).
    public var applicationName: String

    private init(identifier: UUID? = nil) {
        dataStore = WKWebsiteDataStore(forIdentifier: identifier ?? (StageSession.packaged ? StageSession.identifier : StageSession.devIdentifier))
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        applicationName = "Engelbart/\(version)"
    }

    // ------------------------------------------------------------------------------------- permissions (decision 49)

    /// The person's answers for this run, by "<origin> <permission>" (Electron's `decided`): asked once per site per run,
    /// in every window alike.
    private var decided: [String: Bool] = [:]
    private var asking: [String: [(Bool) -> Void]] = [:]

    static let askedPermissions = ["media": "the camera or microphone", "geolocation": "your location", "notifications": "notifications", "clipboard-read": "the clipboard"]

    /// Asks "Allow <origin> to use <what>?" once per origin and permission per run; a question already on screen is shared.
    public func decide(origin: String, permission: String, window: NSWindow?, _ answer: @escaping (Bool) -> Void) {
        guard let what = StageSession.askedPermissions[permission], !origin.isEmpty else { answer(false); return }
        let key = "\(origin) \(permission)"
        if let known = decided[key] { answer(known); return }
        if asking[key] != nil { asking[key]?.append(answer); return }
        asking[key] = [answer]
        StageDialogs.ask(message: "Allow \(origin) to use \(what)?", detail: "", yes: "Allow", window: window) { [weak self] yes in
            guard let self else { return }
            self.decided[key] = yes
            for one in self.asking.removeValue(forKey: key) ?? [] { one(yes) }
        }
    }

    // ------------------------------------------------------------------------------------------------ the cookies

    public lazy var cookieStore: WebKitCookieStore = WebKitCookieStore(dataStore.httpCookieStore)

    /// GitHub's sign-in cookies gone (endedGithubSession): the next GitHub page is asked for signed out.
    public func dropGithubSession() async {
        let store = dataStore.httpCookieStore
        let all = await store.allCookies()
        for cookie in all where GitHubPages.sessionCookies.contains(cookie.name) && cookie.domain.hasSuffix("github.com") {
            await store.deleteCookie(cookie)
        }
    }

    /// A sign-in check page asked over the Stage's cookies, redirects not followed (import-cookies.cjs probe): its status and
    /// where it redirected, the body's first 4096 bytes only for a check that reads it; nil on failure or timeout.
    public nonisolated func probe(_ url: String, readBody: Bool, timeout: TimeInterval) async -> SignInCheck.Response? {
        guard let target = URL(string: url) else { return nil }
        let cookies = await MainActor.run { self.dataStore.httpCookieStore }.allCookiesForProbe(target)
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpShouldHandleCookies = false
        for (k, v) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(v, forHTTPHeaderField: k) }
        let delegate = NoRedirects()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = timeout
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            let status = http.statusCode
            let location = http.value(forHTTPHeaderField: "Location") ?? ""
            if status >= 300 && status < 400 { return SignInCheck.Response(status: status, location: location) }
            let body = readBody && !(200..<300).contains(status) ? String(decoding: data.prefix(4096), as: UTF8.self) : nil
            return SignInCheck.Response(status: status, body: body)
        } catch {
            return nil
        }
    }

    /// The cookie importer over this session (MATH-18): the person's Keychain and folders, the Stage's store.
    public func cookieImport(userDataDir: URL, installedApps: InstalledApps? = nil) -> CookieImport {
        let apps = installedApps
        return CookieImport(supportDir: URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support"),
                            userDataDir: userDataDir, store: { [cookieStore] in cookieStore },
                            probe: { url, body, timeout in await StageSession.shared.probe(url, readBody: body, timeout: timeout) },
                            keychain: { try await KeychainRunner.read($0) },
                            installed: apps.map { a in { a.has($0) } }, settled: apps.map { a in { await a.settled($0) } })
    }
}

/// Stops URLSession following redirects, so a check sees the 3xx and where it went.
final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

extension WKHTTPCookieStore {
    /// The cookies this store would send to `url` (domain, path and secure matched as a browser does).
    nonisolated func allCookiesForProbe(_ url: URL) async -> [HTTPCookie] {
        let all = await withCheckedContinuation { (done: CheckedContinuation<[HTTPCookie], Never>) in
            DispatchQueue.main.async { self.getAllCookies { done.resume(returning: $0) } }
        }
        let host = url.host?.lowercased() ?? ""
        let path = url.path.isEmpty ? "/" : url.path
        return all.filter { c in
            let domain = c.domain.lowercased()
            let hostMatch = domain.hasPrefix(".") ? (host == String(domain.dropFirst()) || host.hasSuffix(domain)) : host == domain
            return hostMatch && path.hasPrefix(c.path) && (!c.isSecure || url.scheme == "https") && (c.expiresDate.map { $0 > Date() } ?? true)
        }
    }
}

/// The Stage's cookie store as the importer writes to it.
public final class WebKitCookieStore: StageCookieStore, @unchecked Sendable {
    let store: WKHTTPCookieStore
    init(_ store: WKHTTPCookieStore) { self.store = store }

    public func set(_ details: CookieSetDetails) async throws {
        guard let cookie = details.httpCookie else { throw CookieImportError(message: "The cookie was refused") }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { self.store.setCookie(cookie) { done.resume() } }
        }
    }
    public func names(for url: String) async -> Set<String>? {
        guard let target = URL(string: url) else { return nil }
        return Set(await store.allCookiesForProbe(target).map(\.name))
    }
    public func flush() async {}
}

/// The native questions the Stage asks (Electron's dialog.showMessageBox): a sheet on the window when there is one.
@MainActor
enum StageDialogs {
    static func ask(message: String, detail: String, yes: String, window: NSWindow?, _ answer: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .informational
        alert.addButton(withTitle: yes)
        alert.addButton(withTitle: "Don\u{2019}t Allow")
        // the default is Don't Allow (defaultId 1, cancelId 1)
        alert.buttons[0].keyEquivalent = ""
        alert.buttons[1].keyEquivalent = "\r"
        if let window {
            alert.beginSheetModal(for: window) { answer($0 == .alertFirstButtonReturn) }
        } else {
            answer(alert.runModal() == .alertFirstButtonReturn)
        }
    }
}
