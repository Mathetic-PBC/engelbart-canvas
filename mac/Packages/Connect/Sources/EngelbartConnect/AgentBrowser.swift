import Foundation
import AppKit
import WebKit
import EngelbartCore

// Port of src/main/connect/browser.cjs (Connect your library, 2026-10-07, second build): the agents' browser. An import
// agent works in a real browser window of Engelbart's that is never shown, one per agent, on the Stage's own website data
// store (the sign-ins the person made in Engelbart's browser, or brought over from their own), so it opens ChatGPT, Google
// Drive or Overleaf, reads, clicks, types and downloads as a person would, while the person goes on with their own work.
// Limits, kept here rather than left to the model: only the hosts of the job's apps (and the sign-in pages they send it
// through), https only; a password field's value is never read; read-only (clickRefusal, typeRefusal, pressRefusal); a
// script of its own never runs in a page (evaluate is for Engelbart's fixed readers). `headless`: show() does nothing.
//
// Electron → WebKit: a BrowserWindow with show:false becomes a WKWebView in a window kept off-screen and transparent (so
// WebKit keeps drawing it), on the persistent WKWebsiteDataStore the Stage uses; executeJavaScript becomes
// callAsyncJavaScript in the page world; sendInputEvent becomes NSEvents sent to the web view; session.fetch becomes a
// URLSession carrying the store's cookies.

public enum AgentBrowser {
    public static let view = CGSize(width: 1280, height: 900)
    static let loadTimeoutMs = 45_000.0
    static let evalTimeoutMs = 60_000.0
    static let maxWaitS = 120.0
    static let maxText = 60_000
    static let maxResult = 120_000
    public static let maxDownloadBytes = 300 * 1024 * 1024
    static let shotEdge = 1280.0
    public static let keys = Texts.browserKeys

    static func hostOf(_ url: String) -> String { URL(string: url)?.host?.lowercased() ?? "" }
    static func isLoopback(_ host: String) -> Bool { host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1" }
    static func quote(_ text: String?, _ max: Int = 48) -> String { let v = JS.replace(text ?? "", #"\s+"#, " ").trimmingCharacters(in: .whitespaces); return v.count > max ? String(v.prefix(max - 1)) + "…" : v }

    /// Whether `url` may be opened by an agent whose job allows `hosts` (exact hosts or their subdomains).
    public static func hostAllowed(_ url: String, _ hosts: [String]) -> Bool {
        if url == "about:blank" { return true }
        guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), let rawHost = parsed.host else { return false }
        let host = rawHost.lowercased()
        if scheme == "http" { if !isLoopback(host) { return false } } else if scheme != "https" { return false }
        return hosts.contains { let h = $0.lowercased(); return host == h || host.hasSuffix(".\(h)") }
    }

    /// The hosts a job's window may open: its apps' sites, and the sign-in pages they send people through.
    public static func hostsFor(_ sites: [String]) -> [String] {
        var out: [String] = []
        for s in (sites + ConnectSources.signInSites).map({ $0.lowercased() }) where !s.isEmpty && !out.contains(s) { out.append(s) }
        return out
    }

    static let changesRE = #"\b(?:delete|remove|trash|bin|discard|archive|unarchive|send|reply|forward|share|unshare|publish|unpublish|post|comment|submit|save|rename|move|edit|create|new|add|upload|import|duplicate|copy|clone|make a copy|restore|empty|clear|reset|change|update|apply|confirm|approve|accept|decline|reject|invite|leave|join|subscribe|unsubscribe|follow|unfollow|block|report|mute|pin|unpin|star|unstar|favou?rite|bookmark|like|vote|rate|install|uninstall|enable|disable|turn on|turn off|connect|disconnect|revoke|grant|allow|deny|transfer|pay|buy|purchase|checkout|upgrade|downgrade|cancel|regenerate|retry|branch|fork|lock|unlock|mark|label|snooze|draft|compose|write|schedule|record|start|stop|download|export|print|sync|request|verify|log ?out|sign ?out|log ?off|sign ?off)\b"#
    static let signOutRE = #"(?:log|sign)[-_ ]?(?:out|off)\b|logout|signout|logoff"#
    static let choosesRoles: Set<String> = ["switch", "checkbox", "radio", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton"]
    static let actionRoles: Set<String> = ["button", "menuitem"]
    static let textTypes: Set<String> = ["", "text", "search"]

    /// What a control is (INFO_SCRIPT's answer).
    public struct Info: Sendable, Equatable {
        public var tag = "", role = "", type = "", name = "", href = ""
        public var editable = false, search = false, form = false, formSearch = false, submit = false
        public var x: Double?, y: Double?
        public init() {}
        public init(_ v: JSONValue) {
            tag = JS.string(v["tag"]); role = JS.string(v["role"]); type = JS.string(v["type"]); name = JS.string(v["name"]); href = JS.string(v["href"])
            editable = v["editable"] == .bool(true); search = v["search"] == .bool(true); form = v["form"] == .bool(true); formSearch = v["formSearch"] == .bool(true); submit = v["submit"] == .bool(true)
            x = v["x"]?.double; y = v["y"]?.double
        }
    }

    /// Whether `url` is a page that signs the person out (its path or query says so).
    public static func signsOut(_ url: String) -> Bool {
        guard let parsed = URLComponents(string: url) else { return false }
        let tail = (parsed.percentEncodedPath + (parsed.percentEncodedQuery.map { "?\($0)" } ?? "")).removingPercentEncoding ?? ""
        return JS.test(tail, signOutRE, options: .caseInsensitive)
    }

    static func isAction(_ i: Info) -> Bool { i.tag == "button" || actionRoles.contains(i.role) || (i.tag == "input" && JS.test(i.type, "^(submit|button|reset|image)$")) || (i.tag == "a" && i.href.isEmpty) }
    static func isField(_ i: Info) -> Bool {
        i.editable || i.tag == "textarea" || (i.tag == "input" && !JS.test(i.type, "^(submit|button|reset|image|checkbox|radio|file|hidden|range|color)$")) || ["textbox", "searchbox", "combobox"].contains(i.role)
    }

    /// Why a click on the control is refused (it could change something), or nil when it only reads.
    public static func clickRefusal(_ info: Info?) -> String? {
        guard let i = info else { return nil }
        let quoted = i.name.isEmpty ? "That control" : "“\(quote(i.name, 40))”"
        if JS.test(i.name, signOutRE, options: .caseInsensitive) || (!i.href.isEmpty && signsOut(i.href)) { return "\(quoted) signs out" }
        if i.tag == "select" || choosesRoles.contains(i.role) || (i.tag == "input" && JS.test(i.type, "^(checkbox|radio|file|range|color)$")) { return "\(quoted) changes a setting, a selection or a file" }
        if !isAction(i) { return nil }
        if i.name.isEmpty { return "A control with no name could change something" }
        if JS.test(i.name, changesRE, options: .caseInsensitive) { return "\(quoted) could change something in the account" }
        if i.submit && !i.formSearch { return "\(quoted) sends a form" }
        return nil
    }

    /// Why typing into the control is refused (only a search box takes text), or nil.
    public static func typeRefusal(_ info: Info?) -> String? {
        guard let i = info else { return nil }
        if i.type == "password" { return "That is a password field: call needs_you so the person signs in themselves" }
        if i.editable { return "That is an editor (a message, a document): agents only type into search boxes" }
        if !isField(i) { return "That control does not take text" }
        if i.tag == "input" && !textTypes.contains(i.type) { return "Agents only type into search boxes" }
        if !i.search { return "\(i.name.isEmpty ? "That field" : "“\(quote(i.name, 40))”") is not a search box: agents only type into search boxes" }
        return nil
    }

    /// Why pressing `key` where the focus is (nil for the page) is refused, or nil.
    public static func pressRefusal(_ key: String, _ info: Info?) -> String? {
        let inSearch = info.map { isField($0) && typeRefusal($0) == nil } ?? false
        if key == "Delete" || key == "Backspace" { return inSearch ? nil : "\(key) could delete something: it is only pressed in a search box" }
        if key != "Enter" && key != "Space" { return nil }
        guard let i = info else { return nil }
        if isField(i) { return inSearch || (key == "Space" && !i.editable && i.tag != "textarea" && i.role != "textbox") ? nil : "\(key) there would send or write something: it is only pressed in a search box" }
        return clickRefusal(i)
    }

    static func sameText(_ a: String, _ b: String) -> Bool { JS.replace(a, #"\s+"#, " ").trimmingCharacters(in: .whitespaces) == JS.replace(b, #"\s+"#, " ").trimmingCharacters(in: .whitespaces) }

    /// A file name from a response's content-disposition, else the address's last part, made safe.
    public static func fileNameOf(disposition: String, url: String, fallback: String = "download") -> String {
        var name = ""
        if let star = JS.match(disposition, #"filename\*=(?:UTF-8'')?([^;]+)"#, options: .caseInsensitive)?[1] ?? nil {
            name = JS.replace(star.trimmingCharacters(in: .whitespaces), #"^"|"$"#, "").removingPercentEncoding ?? ""
        } else if let plain = JS.match(disposition, #"filename="?([^";]+)"?"#, options: .caseInsensitive)?[1] ?? nil {
            name = plain.trimmingCharacters(in: .whitespaces)
        } else if let path = URL(string: url)?.path {
            name = path.split(separator: "/").last.map(String.init)?.removingPercentEncoding ?? ""
        }
        name = String(JS.replace(JS.replace(name, #"[/\\:\x{0}]"#, "-"), #"^\.+"#, "").trimmingCharacters(in: .whitespaces).prefix(120))
        return name.isEmpty ? fallback : name
    }

    /// A path in `dir` for `name` that is not taken: name, name-2, …
    public static func freePath(_ dir: String, _ name: String) throws -> String {
        let ext = (name as NSString).pathExtension.isEmpty ? "" : "." + (name as NSString).pathExtension
        var base = String(name.dropLast(ext.count))
        if base.isEmpty { base = "download" }
        for n in 1..<1000 {
            let file = (dir as NSString).appendingPathComponent(n == 1 ? "\(base)\(ext)" : "\(base)-\(n)\(ext)")
            if !FileManager.default.fileExists(atPath: file) { return file }
        }
        throw ConnectError("failed", "No free name for the download")
    }

    static func readScript(offset: Int, max: Int) -> String {
        Texts.browserReadScript.replacingOccurrences(of: "333333", with: String(offset + max)).replacingOccurrences(of: "111111", with: String(offset))
    }
    static func infoScript(_ ref: String?, spot: Bool = false) -> String {
        guard let ref else { return Texts.browserInfoFocused }
        return (spot ? Texts.browserInfoSpot : Texts.browserInfoRef).replacingOccurrences(of: "\"__REF__\"", with: JSONValue.string(ref).text())
    }
    static func typeScript(_ ref: String, _ text: String, replace: Bool) -> String {
        (replace ? Texts.browserTypeReplace : Texts.browserTypeAppend).replacingOccurrences(of: "\"__REF__\"", with: JSONValue.string(ref).text())
            .replacingOccurrences(of: "\"__TEXT__\"", with: JSONValue.string(text).text())
    }
    static func scrollScript(_ ref: String, _ dy: Double) -> String {
        (ref.isEmpty ? Texts.browserScrollPage : Texts.browserScrollRef).replacingOccurrences(of: "\"__REF__\"", with: JSONValue.string(ref).text()).replacingOccurrences(of: "4242", with: JS.number(dy))
    }
}

/// The identifier of the Stage's persistent website data store, the one every sign-in lives in (Electron: the shared
/// persist:engelbart partition). Defaults to the identifier Stage/API.md documents (`StageSession.identifier`); a run from
/// a checkout uses Stage's `devIdentifier`, so the app sets `ConnectBrowserStore.identifier = StageSession.shared`'s before
/// anything opens. Connect does not depend on Stage, hence the copy.
public enum ConnectBrowserStore {
    nonisolated(unsafe) public static var identifier = UUID(uuidString: "8E1A6C1E-5747-4E5B-9A0B-5354A6E4B001")!
    @MainActor public static var store: WKWebsiteDataStore { WKWebsiteDataStore(forIdentifier: identifier) }
    /// The user agent sites see (the Stage's own, without anything that says it is an embedded view), set by the app.
    nonisolated(unsafe) public static var userAgent: String? = nil
}

/// The window behind each job's page (createAgentBrowser). Main-actor work; the pages hop to it.
@MainActor
public final class AgentBrowserWindows: NSObject {
    final class Entry: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
        let jobId: String
        let label: String
        let hosts: [String]
        let window: NSWindow
        let webView: WKWebView
        var showing = false
        var typed = false
        var sent = false
        var closing = false
        weak var owner: AgentBrowserWindows?
        var loadWaiters: [CheckedContinuation<Void, Never>] = []
        var popups: [NSWindow] = []

        init(jobId: String, label: String, hosts: [String], store: WKWebsiteDataStore, owner: AgentBrowserWindows) {
            self.jobId = jobId; self.label = label; self.hosts = hosts; self.owner = owner
            let config = WKWebViewConfiguration()
            config.websiteDataStore = store
            webView = WKWebView(frame: CGRect(origin: .zero, size: AgentBrowser.view), configuration: config)
            if let ua = ConnectBrowserStore.userAgent { webView.customUserAgent = ua }
            window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20000, y: -20000), size: AgentBrowser.view), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            super.init()
            window.title = "Engelbart · \(label.isEmpty ? "agent" : label)"
            window.isReleasedWhenClosed = false
            window.contentView = webView
            window.delegate = self
            webView.navigationDelegate = self
            webView.uiDelegate = self
            // Off-screen and see-through, never key: WebKit keeps drawing it, nothing reaches the screen or the focus.
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            window.orderFrontRegardless()
        }

        // Where the page may take itself: the job's hosts while an agent drives it, anywhere on https while the person does.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let url = action.request.url?.absoluteString ?? ""
            let ok = showing ? JS.test(url, "^(https:|about:blank)", options: .caseInsensitive) : AgentBrowser.hostAllowed(url, hosts) && !AgentBrowser.signsOut(url)
            if !ok {
                owner?.log(jobId, AgentBrowser.signsOut(url) ? "Didn't open \(AgentBrowser.hostOf(url))'s sign-out page" : "Kept away from \(AgentBrowser.hostOf(url).isEmpty ? "a page" : AgentBrowser.hostOf(url)) (not one of \(label.isEmpty ? "this app" : label)'s sites)")
            }
            decisionHandler(ok ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { settle() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { settle() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { settle() }
        func settle() { let w = loadWaiters; loadWaiters = []; w.forEach { $0.resume() } }

        // A new window: while the person signs in, a real popup; while an agent drives, the page in this window when it is
        // one of the job's sites, else nothing.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            let url = action.request.url?.absoluteString ?? ""
            if showing && JS.test(url, "^https:", options: .caseInsensitive) {
                let child = WKWebView(frame: CGRect(x: 0, y: 0, width: 500, height: 640), configuration: configuration)
                child.customUserAgent = webView.customUserAgent
                let win = NSWindow(contentRect: child.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
                win.isReleasedWhenClosed = false
                win.contentView = child
                win.center()
                win.makeKeyAndOrderFront(nil)
                popups.append(win)
                return child
            }
            if !showing && AgentBrowser.hostAllowed(url, hosts) { webView.load(action.request) }
            else { owner?.log(jobId, "Kept a new window for \(AgentBrowser.hostOf(url).isEmpty ? "a page" : AgentBrowser.hostOf(url)) from opening") }
            return nil
        }

        // Closed by the person while shown: hidden again and handed back, never destroyed under the agent.
        func windowShouldClose(_ sender: NSWindow) -> Bool {
            if closing { return true }
            if showing { showing = false; hide(); owner?.onClosed(jobId) }
            return false
        }

        func hide() {
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            window.setFrameOrigin(CGPoint(x: -20000, y: -20000))
            popups.forEach { $0.close() }
            popups = []
        }
    }

    var windows: [String: Entry] = [:]
    let storeProvider: @MainActor () -> WKWebsiteDataStore
    public var log: (String, String) -> Void
    public var onClosed: (String) -> Void
    let headless: Bool

    public init(store: @escaping @MainActor () -> WKWebsiteDataStore = { ConnectBrowserStore.store }, headless: Bool = ProcessInfo.processInfo.environment["ENGELBART_HEADLESS"] == "1",
                log: @escaping (String, String) -> Void = { _, _ in }, onClosed: @escaping (String) -> Void = { _ in }) {
        self.storeProvider = store; self.log = log; self.onClosed = onClosed; self.headless = headless
    }

    func entry(_ job: AgentJob) -> Entry {
        if let e = windows[job.id] { return e }
        let e = Entry(jobId: job.id, label: job.label, hosts: AgentBrowser.hostsFor(job.sites), store: storeProvider(), owner: self)
        windows[job.id] = e
        return e
    }

    /// The tools of one job's window (browser.cjs tools(job)).
    public nonisolated func tools(_ job: AgentJob) -> AgentPage { WKAgentPage(job: job, windows: self) }

    public func show(_ jobId: String, title: String = "") -> Bool {
        guard let e = windows[jobId], !headless else { return false }
        e.showing = true
        if !title.isEmpty { e.window.title = title }
        e.window.alphaValue = 1
        e.window.ignoresMouseEvents = false
        e.window.center()
        e.window.makeKeyAndOrderFront(nil)
        NSApp?.activate(ignoringOtherApps: true)
        return true
    }

    public func hide(_ jobId: String) { guard let e = windows[jobId] else { return }; e.showing = false; e.hide() }

    public func close(_ jobId: String) {
        guard let e = windows.removeValue(forKey: jobId) else { return }
        e.closing = true
        e.popups.forEach { $0.close() }
        e.window.close()
    }

    public func closeAll() { for id in Array(windows.keys) { close(id) } }
    public func has(_ jobId: String) -> Bool { windows[jobId] != nil }
}

/// One job as its window knows it: id, label, sites, and the one message it may send (a recall's question).
public struct AgentJob: Sendable { public var id: String; public var label: String; public var sites: [String]; public var sendOnly: String?
    public init(id: String, label: String, sites: [String], sendOnly: String? = nil) { self.id = id; self.label = label; self.sites = sites; self.sendOnly = sendOnly } }

final class WKAgentPage: AgentPage, @unchecked Sendable {
    let job: AgentJob
    let windows: AgentBrowserWindows
    private let urlLock = NSLock()
    private var lastURL = ""
    init(job: AgentJob, windows: AgentBrowserWindows) { self.job = job; self.windows = windows }

    func refuse(_ why: String) -> ConnectError {
        let id = job.id
        Task { @MainActor in windows.log(id, "Didn't: \(why)") }
        return ConnectError("read-only", "Refused: \(why). Engelbart's agents only open, read, scroll and search; nothing in the person's accounts is changed.")
    }

    @MainActor func entry() -> AgentBrowserWindows.Entry { windows.entry(job) }

    /// `body` run as an async function in the page (its `return` is the answer), bounded by 60 s.
    func run(_ body: String, timeout: Double = AgentBrowser.evalTimeoutMs) async throws -> JSONValue {
        try await withThrowingTaskGroup(of: JSONValue.self) { group in
            group.addTask { @MainActor in
                let web = self.entry().webView
                do {
                    let value = try await web.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
                    return JSONValue(any: value)
                } catch { throw ConnectError("failed", "The page: \(error.localizedDescription)") }
            }
            group.addTask { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000)); throw ConnectError("failed", "The page took longer than \(Int((timeout / 1000).rounded())) seconds") }
            let first = try await group.next()!
            group.cancelAll()
            return first
        }
    }

    func url() -> String {
        let id = job.id
        if Thread.isMainThread { return MainActor.assumeIsolated { windows.windows[id]?.webView.url?.absoluteString ?? "" } }
        let box = Box("")
        DispatchQueue.main.sync { box.set(MainActor.assumeIsolated { windows.windows[id]?.webView.url?.absoluteString ?? "" }) }
        return box.get()
    }

    func here() async -> (url: String, title: String) { await MainActor.run { let w = entry().webView; return (w.url?.absoluteString ?? "", w.title ?? "") } }

    func open(_ url: String) async throws -> JSONValue {
        let hosts = AgentBrowser.hostsFor(job.sites)
        guard AgentBrowser.hostAllowed(url, hosts) else {
            throw ConnectError("failed", "\(AgentBrowser.hostOf(url).isEmpty ? url : AgentBrowser.hostOf(url)) is not one of the sites this import may open (\(job.sites.isEmpty ? "none" : job.sites.joined(separator: ", ")))")
        }
        if AgentBrowser.signsOut(url) { throw refuse("that page signs out") }
        let id = job.id
        await MainActor.run { windows.log(id, "Opened \(AgentBrowser.hostOf(url))") }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor in
                let e = self.entry()
                guard let target = URL(string: url) else { return }
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in e.loadWaiters.append(c); e.webView.load(URLRequest(url: target)) }
            }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(AgentBrowser.loadTimeoutMs * 1_000_000)) }
            await group.next()
            group.cancelAll()
        }
        await MainActor.run { let e = entry(); let w = e.loadWaiters; e.loadWaiters = []; w.forEach { $0.resume() } }
        try? await Task.sleep(nanoseconds: 600_000_000) // pages that draw themselves after load
        let at = await here()
        return ["url": .string(at.url), "title": .string(at.title)]
    }

    func ensure(_ url: String) async throws -> JSONValue {
        let at = await here()
        if !at.url.isEmpty && AgentBrowser.hostOf(at.url) == AgentBrowser.hostOf(url) { return ["url": .string(at.url), "title": .string(at.title)] }
        return try await open(url)
    }

    func read(offset: Int, maxChars: Int) async throws -> JSONValue {
        let max = min(Swift.max(500, maxChars), AgentBrowser.maxText)
        let out = try await run("return " + AgentBrowser.readScript(offset: Swift.max(0, offset), max: max))
        let title = JS.string(out["title"])
        let id = job.id
        await MainActor.run { windows.log(id, "Read \(AgentBrowser.hostOf(JS.string(out["url"])).isEmpty ? "the page" : AgentBrowser.hostOf(JS.string(out["url"])))\(title.isEmpty ? "" : " (\(AgentBrowser.quote(title, 40)))")") }
        return out
    }

    func click(_ ref: String) async throws -> JSONValue {
        let spot = try await run("return " + AgentBrowser.infoScript(ref, spot: true))
        if spot.isNull { throw ConnectError("failed", "No control \(ref) on the page now: browser_read again") }
        let info = AgentBrowser.Info(spot)
        let sending = await MainActor.run { () -> Bool in let e = entry(); return job.sendOnly != nil && e.typed && !e.sent && JS.test(info.name, #"^send\b"#, options: .caseInsensitive) }
        if !sending, let why = AgentBrowser.clickRefusal(info) { throw refuse(why) }
        await MainActor.run {
            let e = entry()
            if sending { e.sent = true }
            sendMouse(e, x: info.x ?? 0, y: info.y ?? 0)
            windows.log(job.id, "Clicked \(info.name.isEmpty ? "a control" : "“\(AgentBrowser.quote(info.name, 40))”")")
        }
        try? await Task.sleep(nanoseconds: 700_000_000)
        let at = await here()
        return ["url": .string(at.url), "title": .string(at.title)]
    }

    @MainActor func sendMouse(_ e: AgentBrowserWindows.Entry, x: Double, y: Double) {
        // Page coordinates (top-left origin) → the window's (bottom-left).
        let point = CGPoint(x: x, y: e.webView.bounds.height - y)
        let windowPoint = e.webView.convert(point, to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let event = NSEvent.mouseEvent(with: type, location: windowPoint, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: e.window.windowNumber,
                                              context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
                if type == .leftMouseDown { e.webView.mouseDown(with: event) } else { e.webView.mouseUp(with: event) }
            }
        }
    }

    func type(_ ref: String, _ text: String, submit: Bool, replace: Bool) async throws -> JSONValue {
        let field = try await run("return " + AgentBrowser.infoScript(ref))
        if field.isNull { throw ConnectError("failed", "No control \(ref) on the page now: browser_read again") }
        let info = AgentBrowser.Info(field)
        let asking = await MainActor.run { () -> Bool in
            let e = entry()
            guard let only = job.sendOnly else { return false }
            return !e.sent && info.type != "password" && (info.editable || info.tag == "textarea" || info.role == "textbox") && AgentBrowser.sameText(text, only)
        }
        let why = asking ? nil : AgentBrowser.typeRefusal(info)
        if let why, info.type == "password" { throw ConnectError("failed", why) }
        if let why { throw refuse(job.sendOnly != nil && !asking && (info.editable || info.tag == "textarea") ? "only Engelbart's own question goes into the message box, word for word" : why) }
        if asking { await MainActor.run { entry().typed = true } }
        let out = try await run("return " + AgentBrowser.typeScript(ref, text, replace: replace))
        if out["error"]?.string == "password" { throw ConnectError("failed", "That is a password field: call needs_you so the person signs in themselves") }
        if let error = out["error"]?.string { throw ConnectError("failed", error == "gone" ? "No control \(ref) on the page now: browser_read again" : "That control does not take text") }
        let name = JS.string(out["name"])
        let id = job.id
        await MainActor.run { windows.log(id, "Typed into \(name.isEmpty ? "a field" : "“\(AgentBrowser.quote(name, 40))”")") }
        if submit { _ = try await press("Enter", quiet: true) }
        return ["typed": .number(Double(text.utf16.count)), "submitted": .bool(submit)]
    }

    func press(_ key: String) async throws -> JSONValue { try await press(key, quiet: false) }

    func press(_ key: String, quiet: Bool) async throws -> JSONValue {
        guard AgentBrowser.keys.contains(key) else { throw ConnectError("failed", "key must be one of \(AgentBrowser.keys.joined(separator: ", "))") }
        let focusValue = (try? await run("return " + AgentBrowser.infoScript(nil))) ?? .null
        let focus = focusValue.isNull ? nil : AgentBrowser.Info(focusValue)
        let sending = await MainActor.run { () -> Bool in let e = entry(); return key == "Enter" && job.sendOnly != nil && e.typed && !e.sent && focus.map(AgentBrowser.isField) == true }
        if !sending, let why = AgentBrowser.pressRefusal(key, focus) { throw refuse(why) }
        await MainActor.run {
            let e = entry()
            if sending { e.sent = true }
            let codes: [String: (UInt16, String)] = ["Enter": (36, "\r"), "Tab": (48, "\t"), "Escape": (53, "\u{1b}"), "Backspace": (51, "\u{8}"), "Delete": (117, "\u{7f}"),
                                                    "ArrowDown": (125, "\u{F701}"), "ArrowUp": (126, "\u{F700}"), "ArrowLeft": (123, "\u{F702}"), "ArrowRight": (124, "\u{F703}"),
                                                    "PageDown": (121, "\u{F72D}"), "PageUp": (116, "\u{F72C}"), "Home": (115, "\u{F729}"), "End": (119, "\u{F72B}"), "Space": (49, " ")]
            let (code, chars) = codes[key] ?? (36, "\r")
            e.window.makeFirstResponder(e.webView)
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: e.window.windowNumber,
                                                context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
                    if type == .keyDown { e.webView.keyDown(with: event) } else { e.webView.keyUp(with: event) }
                }
            }
            if !quiet { windows.log(job.id, "Pressed \(key)") }
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        return ["url": .string(await here().url)]
    }

    func scroll(ref: String, direction: String, amount: Double) async throws -> JSONValue {
        let step = ((amount.isFinite && amount != 0 ? amount : 800).rounded()) * (direction == "up" ? -1 : 1)
        let out = try await run("return " + AgentBrowser.scrollScript(ref, step))
        try? await Task.sleep(nanoseconds: 500_000_000)
        return out
    }

    func wait(seconds: Double, untilText: String, untilGone: String, stable: Bool) async throws -> JSONValue {
        let limit = min(max(1, seconds.isFinite && seconds != 0 ? seconds : 5), AgentBrowser.maxWaitS) * 1000
        let started = Time.ms()
        var last: String?
        var still = 0
        let after = { Double(Int(((Time.ms() - started) / 1000).rounded())) }
        while Time.ms() - started < limit {
            let text = JS.string((try? await run("return (document.body ? document.body.innerText : \"\")")) ?? "")
            if !untilText.isEmpty && text.contains(untilText) { return ["done": true, "after": .number(after())] }
            if !untilGone.isEmpty && !text.contains(untilGone) { return ["done": true, "after": .number(after())] }
            if stable { still = text == last ? still + 1 : 0; last = text; if still >= 6 { return ["done": true, "after": .number(after())] } }
            if untilText.isEmpty && untilGone.isEmpty && !stable { try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000)); return ["done": true] }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return ["done": false, "after": .number((limit / 1000).rounded())]
    }

    func screenshot() async throws -> (data: String, mimeType: String) {
        let image: NSImage = try await snap()
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
            throw ConnectError("failed", "The page could not be pictured")
        }
        let id = job.id
        let host = AgentBrowser.hostOf(url())
        await MainActor.run { windows.log(id, "Looked at \(host.isEmpty ? "the page" : host)") }
        return (jpeg.base64EncodedString(), "image/jpeg")
    }

    @MainActor func snap() async throws -> NSImage {
        let config = WKSnapshotConfiguration()
        if entry().webView.bounds.width > AgentBrowser.shotEdge { config.snapshotWidth = NSNumber(value: AgentBrowser.shotEdge) }
        return try await entry().webView.takeSnapshot(configuration: config)
    }
    @MainActor func storeCookies() async -> [HTTPCookie] { await windows.storeProvider().httpCookieStore.allCookies() }

    func evaluate(_ script: String) async throws -> JSONValue {
        let at = url()
        guard AgentBrowser.hostAllowed(at, AgentBrowser.hostsFor(job.sites)) else { throw ConnectError("failed", "Open one of this app's pages first") }
        let value = try await run("\n\(script)\n")
        let id = job.id
        await MainActor.run { windows.log(id, "Ran a script on \(AgentBrowser.hostOf(at))") }
        let text = value.text()
        return text.utf16.count > AgentBrowser.maxResult ? ["truncated": true, "json": .string(String(text.prefix(AgentBrowser.maxResult)))] : value
    }

    func download(_ url: String, dir: String, name: String, maxBytes: Int?, quiet: Bool) async throws -> (path: String, bytes: Int, type: String, url: String) {
        guard AgentBrowser.hostAllowed(url, AgentBrowser.hostsFor(job.sites)) else { throw ConnectError("failed", "\(AgentBrowser.hostOf(url).isEmpty ? url : AgentBrowser.hostOf(url)) is not one of the sites this import may open") }
        if AgentBrowser.signsOut(url) { throw refuse("that address signs out") }
        let cap = maxBytes ?? AgentBrowser.maxDownloadBytes
        let cookies = await storeCookies()
        let ua = await MainActor.run { entry().webView.customUserAgent }
        let (data, response) = try await CookieFetch.fetch(url, cookies: cookies, userAgent: ua, timeout: 180)
        let http = response as? HTTPURLResponse
        guard let status = http?.statusCode, (200..<300).contains(status) else { throw ConnectError("failed", "\(AgentBrowser.hostOf(url)) answered \(http?.statusCode ?? 0)") }
        if let length = Int(http?.value(forHTTPHeaderField: "content-length") ?? ""), length > cap { throw ConnectError("failed", "The file is larger than \(Int((Double(cap) / 1_048_576).rounded())) MB") }
        if data.count > cap { throw ConnectError("failed", "The file is larger than \(Int((Double(cap) / 1_048_576).rounded())) MB") }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let given = JS.replace(name, #"[/\\:\x{0}]"#, "-").trimmingCharacters(in: .whitespaces)
        let file = try AgentBrowser.freePath(dir, given.isEmpty ? AgentBrowser.fileNameOf(disposition: http?.value(forHTTPHeaderField: "content-disposition") ?? "", url: url) : given)
        FileManager.default.createFile(atPath: file, contents: data, attributes: [.posixPermissions: 0o600])
        if !quiet { let id = job.id; await MainActor.run { windows.log(id, "Downloaded \((file as NSString).lastPathComponent)") } }
        return (file, data.count, (http?.value(forHTTPHeaderField: "content-type") ?? "").components(separatedBy: ";")[0], response.url?.absoluteString ?? url)
    }
}

/// A request carrying the browser store's cookies for its host (Electron's session.fetch).
public enum CookieFetch {
    public static func fetch(_ url: String, cookies: [HTTPCookie], userAgent: String?, timeout: TimeInterval, method: String = "GET", followRedirects: Bool = true) async throws -> (Data, URLResponse) {
        guard let target = URL(string: url) else { throw ConnectError("failed", "Not an address: \(url)") }
        let config = URLSessionConfiguration.ephemeral
        let storage = HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: "engelbart.connect.\(UUID().uuidString)")
        storage.cookieAcceptPolicy = .always
        cookies.forEach { storage.setCookie($0) }
        config.httpCookieStorage = storage
        config.timeoutIntervalForRequest = timeout
        if let userAgent { config.httpAdditionalHeaders = ["User-Agent": userAgent] }
        let delegate = followRedirects ? nil : NoRedirect()
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: target, timeoutInterval: timeout)
        request.httpMethod = method
        return try await session.data(for: request)
    }
    final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }
    }
}
