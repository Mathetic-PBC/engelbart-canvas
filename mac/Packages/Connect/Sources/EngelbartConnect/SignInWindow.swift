import Foundation
import AppKit
import WebKit
import EngelbartCore

// Port of src/main/connect/signin-window.cjs (2026-10-11; pop-ups 2026-10-12; Google's refusal 2026-10-12; any site C9
// 2026-10-16): signing in to a web app in Engelbart's own browser, in a small window over the app, on the store the agents
// use (the Stage's), so a sign-in made here is the one the agents use. Any https page may load (a sign-in hops across
// hosts); anything else is blocked. An https pop-up opens as a child window on the same store and user agent ("Continue
// with Google" answers through window.opener); any other is refused. Every 2 s the app's sign-in cookie is looked for, with
// no time limit; there → the window closes itself: 'signed-in'. Closed by the person: 'closed'. One window at a time per
// sign-in group: a second open() focuses it and shares its answer. Google's "Couldn't sign you in" page clears Google's
// __Host-*, __Secure-*, OTZ and NID cookies and answers 'rejected'. openSite({ name, url, domains }) for any site: signed in
// when its sites' cookies changed while the window was open.

public enum SignInRules {
    public static let pollMs = 2000.0
    public static func httpsOnly(_ url: String) -> Bool { URL(string: url)?.scheme?.lowercased() == "https" }
    /// Google's "Couldn't sign you in" page: accounts.google.com/signin/rejected, /v3/signin/rejected and the like.
    public static func rejectedByGoogle(_ url: String) -> Bool {
        guard let u = URL(string: url) else { return false }
        return u.host == "accounts.google.com" && JS.test(u.path, #"/signin/rejected(?:/|$)"#)
    }
    static let googleHosts = ["google.com", "accounts.google.com", "mail.google.com"]
    static let googleStale = #"^(?:__Host-|__Secure-|OTZ$|NID$)"#

    /// The cookies a refused Google sign-in leaves behind, removed from `jar`.
    public static func clearGoogleRefusal(_ jar: CookieJar) async {
        for c in await jar.get(domain: "google.com") where googleHosts.contains(JS.replace(c.domain, "^\\.", "")) && JS.test(c.name, googleStale) {
            await jar.remove(url: "https://\(JS.replace(c.domain, "^\\.", ""))\(c.path)", name: c.name)
        }
    }

    /// Sites as registrable domains ('www.linear.app' → 'linear.app'), each once.
    public static func registrableOf(_ domains: [String]) -> [String] { WebSignIn.registrable(domains) }

    /// A registered app's sites (its start page's own, then its listed sites).
    public static func siteDomains(_ app: String, start: String) -> [String] { registrableOf([URL(string: start)?.host ?? ""] + (ConnectSources.apps[app]?.sites ?? [])) }

    /// Every cookie the jar holds for `sites` as one string (kept here, compared only).
    public static func printOf(_ jar: CookieJar, _ sites: [String]) async -> String {
        var lines: [String] = []
        for domain in sites { for c in await jar.get(domain: domain) { lines.append("\(c.domain)|\(c.path)|\(c.name)|\(c.value)") } }
        return lines.sorted().joined(separator: "\n")
    }
}

@MainActor
public final class SignInWindow: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    final class Current {
        let group: String
        let window: NSWindow
        var children: [NSWindow] = []
        var waiters: [CheckedContinuation<String, Never>] = []
        var result: String?
        var timer: Timer?
        var looking = false
        var refused = false
        var closed: (() async -> String)?
        init(group: String, window: NSWindow) { self.group = group; self.window = window }
    }

    let store: @MainActor () -> WKWebsiteDataStore
    let jar: CookieJar
    let parent: () -> NSWindow?
    let signedIn: (String) async -> Bool
    let headless: Bool
    let pollMs: Double
    var current: Current?

    public init(store: @escaping @MainActor () -> WKWebsiteDataStore = { ConnectBrowserStore.store }, jar: CookieJar, parent: @escaping () -> NSWindow? = { nil },
                signedIn: @escaping (String) async -> Bool, headless: Bool = ProcessInfo.processInfo.environment["ENGELBART_HEADLESS"] == "1", pollMs: Double = SignInRules.pollMs) {
        self.store = store; self.jar = jar; self.parent = parent; self.signedIn = signedIn; self.headless = headless; self.pollMs = pollMs
    }

    /// A registered app's sign-in page; one with no known sign-in cookie opens as any site does.
    public func open(_ app: String) async -> String {
        guard let start = WebSignIn.signInPages[app] ?? ConnectSources.apps[app]?.start else { return "closed" }
        if ConnectSources.signInCookies[app] == nil { return await openSite(name: app, url: start, domains: SignInRules.siteDomains(app, start: start)) }
        return await present(group: ConnectSources.signInGroup(app), start: start, title: "Sign in", signedInNow: { [signedIn] in await signedIn(app) }, closed: nil)
    }

    /// Sign in to any https site inside Engelbart (C9): 'signed-in' when its sites' cookies changed while it was open.
    public func openSite(name: String = "", url: String, domains: [String] = []) async -> String {
        guard SignInRules.httpsOnly(url) else { return "closed" }
        let sites = SignInRules.registrableOf(domains.isEmpty ? [URL(string: url)?.host ?? ""] : domains)
        if sites.isEmpty { return "closed" }
        let before = await SignInRules.printOf(jar, sites)
        return await present(group: "site \(sites.joined(separator: " "))", start: url, title: name.isEmpty ? "Sign in" : "Sign in to \(name)", signedInNow: nil) { [jar] in
            await SignInRules.printOf(jar, sites) != before ? "signed-in" : "closed"
        }
    }

    func present(group: String, start: String, title: String, signedInNow: (() async -> Bool)?, closed: (() async -> String)?) async -> String {
        if let c = current, c.group == group, c.result == nil {
            c.window.makeKeyAndOrderFront(nil)
            return await withCheckedContinuation { c.waiters.append($0) }
        }
        close()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store()
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 460, height: 720), configuration: config)
        if let ua = ConnectBrowserStore.userAgent { web.customUserAgent = ua }
        web.navigationDelegate = self
        web.uiDelegate = self
        let win = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        win.title = title
        win.backgroundColor = .white
        win.contentMinSize = CGSize(width: 360, height: 480)
        win.contentView = web
        win.isReleasedWhenClosed = false
        win.delegate = self
        if let p = parent() { p.addChildWindow(win, ordered: .above) }
        let entry = Current(group: group, window: win)
        entry.closed = closed
        current = entry
        if let url = URL(string: start) { web.load(URLRequest(url: url)) }
        if !headless { win.center(); win.makeKeyAndOrderFront(nil) }
        if let signedInNow {
            entry.timer = Timer.scheduledTimer(withTimeInterval: pollMs / 1000, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, entry.result == nil, !entry.looking else { return }
                    entry.looking = true
                    if await signedInNow() { self.finish(entry, "signed-in") }
                    entry.looking = false
                }
            }
        }
        return await withCheckedContinuation { entry.waiters.append($0) }
    }

    func finish(_ entry: Current, _ status: String) {
        guard entry.result == nil else { return }
        entry.result = status
        entry.timer?.invalidate()
        if current === entry { current = nil }
        let waiters = entry.waiters
        entry.waiters = []
        waiters.forEach { $0.resume(returning: status) }
        entry.children.forEach { $0.close() }
        entry.children = []
        if status != "closed" { entry.window.delegate = nil; entry.window.close() }
    }

    /// Closes the window, if one is open: its open() answers 'closed'.
    public func close() {
        guard let entry = current else { return }
        finish(entry, "closed")
        entry.window.delegate = nil
        entry.window.close()
    }

    public func isOpen() -> Bool { current != nil }

    public func windowWillClose(_ notification: Notification) {
        guard let entry = current, notification.object as? NSWindow === entry.window else { return }
        entry.children.forEach { $0.close() }
        if entry.refused || entry.result != nil { return }
        guard let closed = entry.closed else { finish(entry, "closed"); return }
        Task { @MainActor in finish(entry, await closed() == "signed-in" ? "signed-in" : "closed") }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url?.absoluteString ?? ""
        if !SignInRules.httpsOnly(url) && url != "about:blank" { decisionHandler(.cancel); return }
        landed(url)
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) { landed(webView.url?.absoluteString ?? "") }
    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { landed(webView.url?.absoluteString ?? "") }

    func landed(_ url: String) {
        guard let entry = current, entry.result == nil, !entry.refused, SignInRules.rejectedByGoogle(url) else { return }
        entry.refused = true
        Task { @MainActor in await SignInRules.clearGoogleRefusal(jar); finish(entry, "rejected") }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let entry = current, SignInRules.httpsOnly(action.request.url?.absoluteString ?? "") else { return nil }
        let child = WKWebView(frame: CGRect(x: 0, y: 0, width: 500, height: 640), configuration: configuration)
        child.customUserAgent = webView.customUserAgent
        child.navigationDelegate = self
        child.uiDelegate = self
        let win = NSWindow(contentRect: child.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        win.title = "Sign in"
        win.backgroundColor = .white
        win.isReleasedWhenClosed = false
        win.contentView = child
        entry.window.addChildWindow(win, ordered: .above)
        if !headless { win.center(); win.makeKeyAndOrderFront(nil) }
        entry.children.append(win)
        return child
    }

    public func webViewDidClose(_ webView: WKWebView) {
        guard let entry = current, let win = entry.children.first(where: { $0.contentView === webView }) else { return }
        entry.children.removeAll { $0 === win }
        win.close()
    }
}
