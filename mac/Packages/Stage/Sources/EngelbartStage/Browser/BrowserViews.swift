import AppKit
import WebKit
import EngelbartCore

// The Stage's pages for one window (src/main/browser/views.cjs createBrowserViews, decisions 48, 49, 51, 78): one
// WKWebView per tab, laid over the Stage's page area, one showing at a time. A page is a top-level browsing context with
// web security on, in the shared StageSession. Signing in: a window a page opens keeps its opener (a popup is a real
// child window; any other new window is a tab around the web view WebKit made); HTTP authentication asks; camera and
// microphone ask once per site per run; a link into another app asks first. Pages on disk: a file: address opens when the
// file is inside the home folder, and only a page on disk may go to another. Pdfs never render in a tab: a pdf answer is
// downloaded and its bytes go to the Stage's viewer, the page under it staying where it was.
// The page script (Resources/page.js) is in every page, a tab's or a popup's; messages are answered only for a tab's main
// frame, in the shapes BrowserRules accepts.

/// What the window's Stage hears from its pages (Electron's `browser:*` channels).
public enum BrowserEvent {
    case state(PageState)
    /// A tab's pdf: loading first, then its bytes or why not.
    case pdf(id: String, url: String, name: String, under: String, loading: Bool, bytes: Data?, error: String?)
    case found(id: String, matches: Int, active: Int)
    case openTab(id: String, url: String, from: String?)
    case openLinkInNewTab(url: String, from: String)
    case closed(id: String)
    case login(LoginRequest)
    case focusAddress
    case focused(id: String?)
    case shortcut(name: String, tab: String?)
    case nextWorkspace
    case boxing(id: String, on: Bool)
    case boxRemoved(id: String, markId: String)
    case boxRestored(id: String, markId: String)
    /// @bart from a box's or a highlight's card: { tab, markId, url, title, question, note, turns, quote?, pageText? }.
    case boxAsk(JSONValue)
    case boxStop(askId: String)

    /// The Electron channel name, for EventHub.
    public var channel: String {
        switch self {
        case .state: return "browser:state"
        case .pdf: return "browser:pdf"
        case .found: return "browser:found"
        case .openTab, .openLinkInNewTab: return "browser:open-tab"
        case .closed: return "browser:closed"
        case .login: return "browser:login"
        case .focusAddress: return "browser:focus-address"
        case .focused: return "browser:focused"
        case .shortcut: return "browser:shortcut"
        case .nextWorkspace: return "engelbart:next-workspace"
        case .boxing: return "browser:boxing"
        case .boxRemoved: return "browser:box-removed"
        case .boxRestored: return "browser:box-restored"
        case .boxAsk: return "browser:box-ask"
        case .boxStop: return "browser:box-stop"
        }
    }
}

public struct LoginRequest: Equatable {
    public var requestId: String
    public var tab: String?
    public var host: String
    public var realm: String
    public var proxy: Bool
}

/// A page's web marks as the library keeps them (the host adapts store/library.cjs addWebMark & co).
public protocol StagePageMarks: AnyObject {
    func list(_ url: String) async throws -> [JSONValue]
    /// → whether it was kept; `crop` a box's picture (PNG).
    func add(_ url: String, _ mark: JSONValue, crop: Data?) async throws -> Bool
    /// → what `restore` needs to put it back, or nil when nothing was removed.
    func remove(_ url: String, _ markId: String) async throws -> JSONValue?
    func restore(_ url: String, _ removed: JSONValue) async throws -> Bool
    /// → the mark as written, or nil.
    func update(_ url: String, _ markId: String, _ patch: JSONValue, crop: Data?) async throws -> JSONValue?
}

@MainActor
public final class BrowserViews: NSObject {
    /// Where the views go: the Stage's page area (flipped), and the window (for questions and popups' parent).
    weak var container: NSView?
    var window: NSWindow? { container?.window }
    let session: StageSession
    /// Inside which a page on disk may be (the home folder).
    let fileRoot: () -> String
    let pageMarks: StagePageMarks?
    let newId: () -> String
    var onEvent: (BrowserEvent) -> Void = { _ in }
    let pdfDir: URL
    let userContent = WKUserContentController()

    var entries: [String: PageTab] = [:]
    var order: [String] = []
    var popups: [PopupWindow] = []
    var logins: [String: (URLCredential?) -> Void] = [:]
    var counter = 0
    var handing = false
    var receivers: [DownloadReceiver] = []

    // the drawing layer and the card (BrowserViews+Boxes.swift)
    var layer = Layer()
    var card = Card()

    public init(session: StageSession? = nil, fileRoot: @escaping () -> String = { NSHomeDirectory() }, pageMarks: StagePageMarks? = nil,
                pdfDir: URL = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-pdf"), newId: @escaping () -> String = IDs.new) {
        self.session = session ?? .shared; self.fileRoot = fileRoot; self.pageMarks = pageMarks; self.pdfDir = pdfDir; self.newId = newId
        super.init()
        let config = "window.__engelbartConfig = \(JSONValue.object(["markCSS": .string(BrowserRules.markCSS), "findCSS": .string(BrowserRules.findCSS)]).text());"
        userContent.addUserScript(WKUserScript(source: config, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: StageSession.world))
        userContent.addUserScript(WKUserScript(source: StageResources.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: StageSession.world))
        userContent.addScriptMessageHandler(self, contentWorld: StageSession.world, name: StageSession.handlerName)
    }

    func nextId(_ prefix: String) -> String { counter += 1; return "\(prefix)-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))-\(counter)" }
    func send(_ event: BrowserEvent) { onEvent(event) }

    /// A configuration for a new page: the shared session, the page script, nothing relaxed.
    func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = session.dataStore
        config.userContentController = userContent
        config.applicationNameForUserAgent = session.applicationName
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        return config
    }

    func pageUrl(_ value: String) throws -> URL {
        BrowserRules.isFileUrl(value) ? try BrowserRules.parseFileUrl(value, root: fileRoot()) : try BrowserRules.parseBrowserUrl(value)
    }

    func allowed(_ value: String, from current: String?) -> Bool { BrowserRules.allowed(value, from: current, root: fileRoot()) }

    func tabOf(_ webView: WKWebView?) -> PageTab? {
        guard let webView else { return nil }
        return entries.values.first { $0.webView === webView }
    }

    public func has(_ id: String) -> Bool { entries[id] != nil }

    // ------------------------------------------------------------------------------------------------------ tabs

    @discardableResult
    func create(_ id: String, configuration: WKWebViewConfiguration? = nil) -> PageTab {
        let view = StageWebView(frame: .zero, configuration: configuration ?? self.configuration())
        return attach(id, view)
    }

    @discardableResult
    func attach(_ id: String, _ view: StageWebView) -> PageTab {
        view.tabId = id
        view.isHidden = true
        view.isInspectable = true
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true
        view.underPageBackgroundColor = .white
        container?.addSubview(view, positioned: .below, relativeTo: nil)
        let tab = PageTab(id: id, webView: view, owner: self)
        entries[id] = tab
        order.append(id)
        return tab
    }

    /// Opens `value` (http(s), or a file: address inside the home folder) in tab `id`, made if new. A GitHub sign-in page
    /// goes to the default browser; a pdf on disk is read, never loaded.
    public func open(_ id: String, _ value: String) throws {
        let url = try pageUrl(value)
        if GitHubPages.isSignIn(url.absoluteString) { NSWorkspace.shared.open(url); return }
        if url.isFileURL && BrowserRules.pdfAddress(url.absoluteString) { openPdfFile(id, url); return }
        let tab = entries[id] ?? create(id)
        tab.load(url.absoluteString)
    }

    /// One page shows at a time: placing a tab's view hides every other.
    public func show(_ id: String, _ rect: CGRect) {
        guard let tab = entries[id] else { return }
        for (other, item) in entries where other != id {
            item.seq += 1
            item.webView.isHidden = true
            item.offer = nil // a tab left: its selection's card is not kept
        }
        tab.seq += 1
        if tab.webView.superview !== container { container?.addSubview(tab.webView, positioned: .below, relativeTo: nil) }
        tab.webView.frame = rect
        tab.webView.isHidden = false
        if let layerTab = layer.tab, layerTab != id { endBox(focusPage: false) } else if layer.tab == id { layer.view?.frame = rect }
        if let cardTab = card.tab, cardTab != id { hideCard() }
        if tab.boxView.id != nil || tab.offer != nil { placeCard(id) }
    }

    /// Hides whatever shows (a menu needs no picture under it: native views can cover a page in AppKit).
    public func hide() {
        endBox(focusPage: false)
        hideCard()
        for tab in entries.values {
            tab.offer = nil
            tab.webView.isHidden = true
        }
    }

    public func command(_ id: String, _ name: String) {
        guard let tab = entries[id] else { return }
        let view = tab.webView
        switch name {
        case "back": if view.canGoBack { view.goBack() }
        case "forward": if view.canGoForward { view.goForward() }
        case "reload": if let error = tab.error { tab.load(error.url.isEmpty ? tab.requested : error.url, keepError: true) } else { view.reload() }
        case "stop": view.stopLoading()
        case "devtools": view.showInspector()
        default: break
        }
    }

    /// Find in the page: a new query starts over, the same one steps; an empty one stops. Counts come back as `found`.
    public func find(_ id: String, _ text: String, backward: Bool = false) {
        guard let tab = entries[id], text.utf16.count <= BrowserRules.findMax else { return }
        if text.isEmpty { tab.callPage("window.__engelbartPage && window.__engelbartPage.stopFind && window.__engelbartPage.stopFind(true)"); tab.found = ""; return }
        let findNext = tab.found == text
        tab.found = text
        tab.callPage("return window.__engelbartPage && window.__engelbartPage.find ? window.__engelbartPage.find(text, { backward, findNext }) : null",
                     ["text": text, "backward": backward, "findNext": findNext]) { [weak self] value in
            guard let value = value as? [String: Any], let matches = value["matches"] as? Int, let active = value["active"] as? Int else { return }
            self?.send(.found(id: id, matches: matches, active: active))
        }
    }

    public func stopFind(_ id: String) {
        guard let tab = entries[id] else { return }
        tab.found = ""
        tab.callPage("window.__engelbartPage && window.__engelbartPage.stopFind && window.__engelbartPage.stopFind(false)")
    }

    /// A guide's section on the page (2026-10-15): whether the page found it, tinted it and scrolled to it, within 300 ms.
    public func section(_ id: String, _ text: String, timeout: TimeInterval = BrowserRules.selectionTimeout) async -> Bool {
        guard let tab = entries[id], text.utf16.count <= BrowserRules.findMax else { return false }
        let nonce = nextId("section")
        return await tab.wait(timeout, fallback: false) { done in
            tab.sectionWaits[nonce] = { done($0) }
            tab.sendPage(PageChannels.section, ["nonce": .string(nonce), "words": .string(text)])
        } cleanup: { tab.sectionWaits[nonce] = nil }
    }

    /// The Edit menu's Find items, with the tab whose page has the keyboard (nil: the app has it).
    public func shortcut(_ name: String) {
        var tab: String?
        for (id, entry) in entries where !entry.webView.isHidden && entry.hasKeyboard { tab = id }
        if tab != nil && name == "find" { window?.makeFirstResponder(nil) }
        send(.shortcut(name: name, tab: tab))
    }

    public func close(_ id: String) {
        guard let tab = detach(id) else { return }
        tab.webView.stopLoading()
        tab.webView.removeFromSuperview()
    }

    func detach(_ id: String) -> PageTab? {
        guard let tab = entries[id] else { return nil }
        if layer.tab == id { endBox(focusPage: false) }
        if card.tab == id { hideCard() }
        entries[id] = nil
        order.removeAll { $0 == id }
        tab.dispose()
        return tab
    }

    public func closeAll() {
        for id in order { close(id) }
        for popup in popups { popup.close() }
        popups.removeAll()
        for requestId in Array(logins.keys) { _ = answerLoginCredential(requestId, nil) }
        layer.view?.removeFromSuperview(); layer = Layer()
        hideCard(); card.view?.removeFromSuperview(); card = Card()
    }

    public func dispose() {
        closeAll()
        userContent.removeScriptMessageHandler(forName: StageSession.handlerName, contentWorld: StageSession.world)
    }

    // ------------------------------------------------------------------------------------------------------- pdfs

    /// A pdf on disk: read here, never loaded into the page.
    func openPdfFile(_ id: String, _ url: URL) {
        let under = entries[id]?.webView.url?.absoluteString ?? "about:blank"
        let name = BrowserRules.pdfName("", url.absoluteString)
        do {
            let bytes = try readPdf(url.path)
            send(.pdf(id: id, url: url.absoluteString, name: name, under: under, loading: false, bytes: bytes, error: nil))
        } catch {
            send(.pdf(id: id, url: url.absoluteString, name: name, under: under, loading: false, bytes: nil, error: error.localizedDescription))
        }
    }

    func readPdf(_ file: String) throws -> Data {
        var st = stat()
        if stat(file, &st) != 0 { throw StageFiles.Failure(errno == ENOENT ? "Nothing is at that path" : String(cString: strerror(errno))) }
        guard (st.st_mode & S_IFMT) == S_IFREG else { throw StageFiles.Failure("The pdf is not a file") }
        if Int(st.st_size) > BrowserRules.maxPDFBytes { throw StageFiles.Failure("The pdf is larger than 200 MB") }
        return try StageFiles.readBytes(file)
    }

    // ------------------------------------------------------------------------------- logins, external apps, popups

    func askLogin(_ tab: String?, challenge: URLAuthenticationChallenge, _ answer: @escaping (URLCredential?) -> Void) {
        let requestId = nextId("login")
        let timer = DispatchWorkItem { [weak self] in _ = self?.answerLoginCredential(requestId, nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + BrowserRules.loginTimeout, execute: timer)
        logins[requestId] = { credential in timer.cancel(); answer(credential) }
        let space = challenge.protectionSpace
        send(.login(LoginRequest(requestId: requestId, tab: tab, host: space.host, realm: space.realm ?? "", proxy: space.isProxy())))
    }

    /// The person's answer to an HTTP authentication: credentials (each ≤1024 characters) or nil (cancelled).
    @discardableResult
    public func answerLogin(_ requestId: String, _ credentials: (username: String, password: String)?) -> Bool {
        guard let answer = logins.removeValue(forKey: requestId) else { return false }
        if let c = credentials, c.username.utf16.count <= 1024, c.password.utf16.count <= 1024 {
            answer(URLCredential(user: c.username, password: c.password, persistence: .forSession))
        } else { answer(nil) }
        return true
    }

    func answerLoginCredential(_ requestId: String, _ credential: URLCredential?) -> Bool {
        guard let answer = logins.removeValue(forKey: requestId) else { return false }
        answer(credential)
        return true
    }

    /// A link into another app (slack://, vscode://): asked about first, one question at a time.
    func handOver(_ url: URL) {
        let scheme = BrowserRules.externalScheme(url.absoluteString)
        guard !scheme.isEmpty, !handing, url.absoluteString.utf16.count <= 8192 else { return }
        handing = true
        StageDialogs.ask(message: "Open this \(scheme)// link in its app?", detail: JSStr.slice(url.absoluteString, 0, 300), yes: "Open", window: window) { [weak self] yes in
            self?.handing = false
            if yes { NSWorkspace.shared.open(url) }
        }
    }

    /// A new window from a page: a popup (window.open with features) is a real child window keeping its opener; any other
    /// is a tab adopted around the web view WebKit made.
    func newWindow(from: PageTab?, fromPopup: Bool, configuration: WKWebViewConfiguration, action: WKNavigationAction, features: WKWindowFeatures) -> WKWebView? {
        let url = action.request.url?.absoluteString ?? ""
        if GitHubPages.isSignIn(url) { if let u = action.request.url { NSWorkspace.shared.open(u) }; return nil }
        if !url.isEmpty && url != "about:blank" && !allowed(url, from: action.sourceFrame.webView?.url?.absoluteString) { return nil }
        let popup = features.width != nil || features.height != nil || features.x != nil || features.y != nil
        if popup {
            let window = PopupWindow(owner: self, configuration: configuration, features: features, from: from?.id)
            popups.append(window)
            window.show(parent: self.window)
            return window.webView
        }
        let id = nextId("tab")
        let view = StageWebView(frame: .zero, configuration: configuration)
        let tab = attach(id, view)
        tab.opened = true
        send(.openTab(id: id, url: url, from: from?.id))
        return tab.webView
    }

    func popupClosed(_ popup: PopupWindow) { popups.removeAll { $0 === popup } }

    // ------------------------------------------------------------------------------------- what @bart sees (3a)

    /// The selection on tab `id`'s page as it is now: { quote, pageText }, or nil (none, gone, no answer in 300 ms).
    public func pageSelection(_ id: String, timeout: TimeInterval = BrowserRules.selectionTimeout) async -> BrowserRules.Selection? {
        guard let tab = entries[id] else { return nil }
        let nonce = nextId("selection")
        return await tab.wait(timeout, fallback: nil) { done in
            tab.selectionWaits[nonce] = { done($0) }
            tab.sendPage(PageChannels.selection, .string(nonce))
        } cleanup: { tab.selectionWaits[nonce] = nil }
    }

    /// What tab `id`'s page looks like now, as PNG bytes (its longer edge at most 1568), or nil.
    public func screenshot(_ id: String) async -> Data? {
        guard let tab = entries[id] else { return nil }
        return await tab.snapshot(nil)
    }

    /// The page a tab shows, written into `dir` as index.html and its index_files folder (MATH-17): the page as it is now,
    /// not one still loading or that failed. → (file, url, title)
    public func savePage(_ id: String, into dir: URL) async throws -> (file: URL, url: String, title: String) {
        guard let tab = entries[id] else { throw StageFiles.Failure("That tab is not open") }
        if tab.webView.isLoading { throw StageFiles.Failure("The page is still loading") }
        if tab.error != nil { throw StageFiles.Failure("The page did not load") }
        let archive: Data = try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { @MainActor in
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Data, Error>) in
                    tab.webView.createWebArchiveData { done.resume(with: $0) }
                }
            }
            group.addTask { try await Task.sleep(nanoseconds: UInt64(BrowserRules.saveTimeout * 1e9)); throw StageFiles.Failure("The page took too long to save") }
            let first = try await group.next()!
            group.cancelAll()
            return first
        }
        let file = try SavedPage.write(archive: archive, into: dir)
        return (file, tab.webView.url?.absoluteString ?? "", tab.webView.title ?? "")
    }

    /// The tabs showing an Overleaf editor (overleaf.com/project/<id>): (id, url, title, front).
    public func overleafTabs() -> [(id: String, url: String, title: String, front: Bool)] {
        order.compactMap { id in
            guard let tab = entries[id], tab.error == nil, let url = tab.webView.url?.absoluteString, SRx(#"^https:\/\/(?:www\.)?overleaf\.com\/project\/[0-9a-f]{24}"#, "i").test(url) else { return nil }
            return (id, url, tab.webView.title ?? "", !tab.webView.isHidden)
        }
    }

    /// A script run in tab `id`'s page's own world (the Integrations package's Overleaf editor read: CodeMirror's state is
    /// the page's, not the isolated world's), answered within `timeout` or nil.
    public func evaluateInPage(_ id: String, _ script: String, timeout: TimeInterval) async -> Any? {
        guard let tab = entries[id] else { return nil }
        return await tab.wait(timeout, fallback: nil) { done in
            tab.webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                if case .success(let value) = result { done(value) } else { done(nil) }
            }
        } cleanup: {}
    }
}

/// The page script's channels (page-preload.cjs CHANNELS).
enum PageChannels {
    static let marks = "engelbart-page:marks", quote = "engelbart-page:quote", add = "engelbart-page:add", selection = "engelbart-page:selection"
    static let box = "engelbart-page:box", boxes = "engelbart-page:boxes", boxSet = "engelbart-page:box-set", boxAdd = "engelbart-page:box-add"
    static let boxRemove = "engelbart-page:box-remove", boxSelect = "engelbart-page:box-select", boxHit = "engelbart-page:box-hit", editing = "engelbart-page:editing"
    static let boxResize = "engelbart-page:box-resize", boxView = "engelbart-page:box-view", frame = "engelbart-page:frame", cursor = "engelbart-page:cursor"
    static let section = "engelbart-page:section"
    static let selectionCard = "engelbart-page:selection-card", cardGone = "engelbart-page:card-gone", noted = "engelbart-page:noted", unmark = "engelbart-page:unmark"
    static let context = "engelbart-page:context"
}
