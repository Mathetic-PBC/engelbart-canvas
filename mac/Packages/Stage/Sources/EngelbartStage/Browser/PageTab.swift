import AppKit
import WebKit
import EngelbartCore

// One Stage tab's page (Electron's `entries` record and the handlers `attach` and `protect` set on its webContents).

@MainActor
final class PageTab: NSObject {
    let id: String
    let webView: StageWebView
    weak var owner: BrowserViews?

    var error: PageError?
    var requested = ""
    var pending = ""
    var seq = 0
    var found = ""
    /// A page has arrived in this tab at least once (the Stage's "Waking…" waits for the first).
    var drawn = false
    /// The address of a pdf being downloaded in place of the page: its cancelled load is no failure.
    var download = ""
    var retrying = false
    var opened = false
    /// Where the current navigation set out for, and the one asked again after an ended GitHub sign-in.
    var started = ""
    var retried = ""

    // what the page script answers (views.cjs entry fields)
    var quoteWait: (nonce: String, resolve: (BrowserRules.Quote?) -> Void)?
    var selectionWaits: [String: (BrowserRules.Selection?) -> Void] = [:]
    var sectionWaits: [String: (Bool) -> Void] = [:]
    var frameWaits: [String: () -> Void] = [:]
    var boxWait: (nonce: String, resolve: (BrowserRules.BoxReply?) -> Void)?
    var editing = false
    var boxes: BrowserRules.BoxReport?
    var boxCss = ""
    var boxHide: String?
    var boxView = BrowserRules.BoxView(id: nil)
    var removed: (url: String, removed: JSONValue)?
    var cursor = ""
    var offer: BrowserRules.SelectionCardOffer?
    var committed = ""
    var context: (link: String, selection: String, editable: Bool) = ("", "", false)
    private var observations: [NSKeyValueObservation] = []

    init(id: String, webView: StageWebView, owner: BrowserViews) {
        self.id = id; self.webView = webView; self.owner = owner
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.keys = owner
        let emit: (WKWebView, Any) -> Void = { [weak self] _, _ in MainActor.assumeIsolated { self?.emit() } }
        observations = [
            webView.observe(\.title, changeHandler: emit), webView.observe(\.url, changeHandler: emit),
            webView.observe(\.isLoading, changeHandler: emit), webView.observe(\.canGoBack, changeHandler: emit),
            webView.observe(\.canGoForward, changeHandler: emit),
            // the same document at another address (a page that changes its own address: did-navigate-in-page): its
            // boxes are that address's
            webView.observe(\.url) { [weak self] view, _ in MainActor.assumeIsolated {
                guard let self, let url = view.url?.absoluteString, url != self.committed, !view.isLoading, self.drawn else { return }
                self.committed = url
                self.owner?.sameDocument(self, url)
            } },
        ]
    }

    func dispose() {
        observations.removeAll()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.keys = nil
        for (_, wait) in sectionWaits { wait(false) }
        for (_, wait) in selectionWaits { wait(nil) }
        for (_, wait) in frameWaits { wait() }
        sectionWaits = [:]; selectionWaits = [:]; frameWaits = [:]
    }

    var hasKeyboard: Bool {
        guard let responder = webView.window?.firstResponder as? NSView else { return false }
        return responder === webView || responder.isDescendant(of: webView)
    }

    /// Reports where the tab is: until a page commits, the address it is headed for.
    func emit() {
        let url = error?.url ?? (pending.isEmpty ? (webView.url?.absoluteString ?? "") : pending)
        owner?.send(.state(PageState(id: id, url: url, title: webView.title ?? "", loading: webView.isLoading, canGoBack: webView.canGoBack,
                                     canGoForward: webView.canGoForward, error: error, drawn: drawn)))
    }

    /// A retry keeps the failure on screen until a page actually arrives.
    func load(_ href: String, keepError: Bool = false) {
        if !keepError { error = nil }
        download = ""
        retrying = false
        requested = href
        pending = href
        guard let url = URL(string: href) else { return }
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: owner?.fileRoot() ?? NSHomeDirectory()))
        } else {
            webView.load(URLRequest(url: url))
        }
        emit()
    }

    // ------------------------------------------------------------------------------------------- talking to the page

    /// main → page: `window.__engelbartPage.receive(channel, payload)` in the page script's world.
    func sendPage(_ channel: String, _ payload: JSONValue) {
        callPage("return window.__engelbartPage ? window.__engelbartPage.receive(channel, payload) : null", ["channel": channel, "payload": payload.any])
    }

    func callPage(_ body: String, _ arguments: [String: Any] = [:], _ done: ((Any?) -> Void)? = nil) {
        webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: StageSession.world) { result in
            if case .success(let value) = result { done?(value) } else { done?(nil) }
        }
    }

    /// Waits for an answer at most `timeout`: `start(done)` asks, `cleanup` forgets the question.
    func wait<T>(_ timeout: TimeInterval, fallback: T, start: (@escaping (T) -> Void) -> Void, cleanup: @escaping () -> Void) async -> T {
        await withCheckedContinuation { (done: CheckedContinuation<T, Never>) in
            let once = Once()
            let timer = DispatchWorkItem { if once.take() { cleanup(); done.resume(returning: fallback) } }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timer)
            start { value in if once.take() { timer.cancel(); cleanup(); done.resume(returning: value) } }
        }
    }

    /// The page's picture (all of it, or `rect` in view points) as PNG, its longer edge at most 1568, within 1.5 s; nil.
    func snapshot(_ rect: CGRect?) async -> Data? {
        let config = WKSnapshotConfiguration()
        if let rect { config.rect = CGRect(x: max(0, rect.minX.jsRounded), y: max(0, rect.minY.jsRounded), width: max(1, rect.width.jsRounded), height: max(1, rect.height.jsRounded)) }
        let image: NSImage? = await wait(BrowserRules.shotTimeout, fallback: nil) { done in
            self.webView.takeSnapshot(with: config) { image, _ in done(image) }
        } cleanup: {}
        guard let image else { return nil }
        return PageTab.png(image, maxEdge: BrowserRules.shotMaxEdge)
    }

    static func png(_ image: NSImage, maxEdge: CGFloat) -> Data? {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil), cg.width > 0, cg.height > 0 else { return nil }
        let scale = min(1, maxEdge / CGFloat(max(cg.width, cg.height)))
        let w = Int((CGFloat(cg.width) * scale).jsRounded), h = Int((CGFloat(cg.height) * scale).jsRounded)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let out = ctx.makeImage() else { return nil }
        let data = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:])
        return (data?.isEmpty ?? true) ? nil : data
    }
}

// ------------------------------------------------------------------------------------------- navigation (protect)

extension PageTab: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let owner, let url = action.request.url else { decisionHandler(.cancel); return }
        let href = url.absoluteString
        let main = action.targetFrame?.isMainFrame ?? true
        if main && GitHubPages.isSignIn(href) { NSWorkspace.shared.open(url); decisionHandler(.cancel); return }
        if !main {
            // a frame's own page: only another app's scheme is stopped (Chromium's guard was the main frame's)
            if !BrowserRules.externalScheme(href).isEmpty { owner.handOver(url); decisionHandler(.cancel); return }
            decisionHandler(.allow); return
        }
        if action.navigationType == .other && (href == "about:blank" || href.hasPrefix("about:")) { decisionHandler(.allow); return }
        if owner.allowed(href, from: webView.url?.absoluteString ?? (pending.isEmpty ? nil : pending)) || href == requested {
            // a page on disk linking to a pdf on disk: the viewer reads it, as when it is typed
            if url.isFileURL && BrowserRules.pdfAddress(href) { owner.openPdfFile(id, url); decisionHandler(.cancel); return }
            started = href
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        owner.handOver(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        guard response.isForMainFrame else { decisionHandler(.allow); return }
        let http = response.response as? HTTPURLResponse
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let fileName = response.response.suggestedFilename ?? ""
        let url = response.response.url?.absoluteString ?? ""
        let attachment = SRx(#"^\s*attachment\b"#, "i").test(disposition)
        // A tab never shows a pdf inline (2026-09-22): its answer becomes a download, which goes to the viewer.
        if BrowserRules.isPDFType(response.response.mimeType) || ((attachment || !response.canShowMIMEType) && BrowserRules.isPDF(mime: nil, fileName: fileName, url: url)) {
            download = url
            decisionHandler(.download)
            return
        }
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { owner?.receive(download, tab: self, response: navigationResponse.response) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { owner?.receive(download, tab: self, response: nil) }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        // A GitHub page sent to /login by a redirect (2026-10-05): the Stage still holds a sign-in GitHub has ended. The ended
        // session is dropped and the page asked for again, once, signed out; sent to /login again, it goes to the browser.
        let to = webView.url?.absoluteString ?? ""
        let from = started
        guard retried != from, GitHubPages.endedSession(from: from, to: to) else { return }
        retried = from
        retrying = true // the cancelled load is no failure: the page is asked for again
        webView.stopLoading()
        Task { @MainActor in
            await owner?.session.dropGithubSession()
            if owner?.entries[id] === self { load(from) }
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        error = nil; pending = ""; found = ""; drawn = true
        retried = ""
        committed = webView.url?.absoluteString ?? ""
        owner?.pageNavigated(self)
        emit()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { pending = ""; emit() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    /// A failed load reports its error; a cancelled one (Electron's ERR_ABORTED: a 204, a load replaced) is judged as
    /// did-stop-loading judged it: the tab's first load stopped with no page and nothing else on the way is a failure.
    func failed(_ failure: Error) {
        let ns = failure as NSError
        let cancelled = ns.code == NSURLErrorCancelled || (ns.domain == "WebKitErrorDomain" && (ns.code == 102 || ns.code == 204))
        if cancelled {
            if !requested.isEmpty && !drawn && self.error == nil && download.isEmpty && !retrying && !webView.isLoading {
                self.error = PageError(code: -3, description: "The page did not load", url: requested)
            }
            pending = ""
            emit()
            return
        }
        let url = (ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? requested
        self.error = PageError(code: PageTab.chromiumCode(ns), description: ns.localizedDescription, url: url)
        pending = ""
        emit()
    }

    /// The Chromium net error a Foundation error stands for, where the Stage reads the code (a refused local server, −102,
    /// is retried every 2 s); else the Foundation code.
    static func chromiumCode(_ e: NSError) -> Int {
        switch e.code {
        case NSURLErrorCannotConnectToHost: return -102
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return -105
        case NSURLErrorNotConnectedToInternet: return -106
        case NSURLErrorTimedOut: return -7
        case NSURLErrorNetworkConnectionLost: return -101
        case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot: return -202
        default: return e.code
        }
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        owner?.authenticate(challenge, tab: id, completionHandler)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

// --------------------------------------------------------------------------------------- new windows, close, media

extension PageTab: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        owner?.newWindow(from: self, fromPopup: false, configuration: configuration, action: action, features: windowFeatures)
    }

    /// window.close() from the page (the last step of many sign-ins) closes the tab.
    func webViewDidClose(_ webView: WKWebView) {
        guard let owner, owner.entries[id] === self else { return }
        owner.close(id)
        owner.send(.closed(id: id))
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        let address = "\(origin.protocol)://\(origin.host)\(origin.port > 0 ? ":\(origin.port)" : "")"
        owner?.session.decide(origin: address, permission: "media", window: webView.window) { decisionHandler($0 ? .grant : .deny) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert(); alert.messageText = frame.securityOrigin.host; alert.informativeText = message
        if let w = webView.window { alert.beginSheetModal(for: w) { _ in completionHandler() } } else { alert.runModal(); completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = frame.securityOrigin.host; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        if let w = webView.window { alert.beginSheetModal(for: w) { completionHandler($0 == .alertFirstButtonReturn) } } else { completionHandler(alert.runModal() == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = frame.securityOrigin.host; alert.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)); field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        if let w = webView.window { panel.beginSheetModal(for: w) { completionHandler($0 == .OK ? panel.urls : nil) } } else { completionHandler(panel.runModal() == .OK ? panel.urls : nil) }
    }
}

// ------------------------------------------------------------------------------------------------ the window level

extension BrowserViews {
    func authenticate(_ challenge: URLAuthenticationChallenge, tab: String?, _ completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        switch space.authenticationMethod {
        case NSURLAuthenticationMethodServerTrust:
            // This machine only: the one place a self-signed certificate is accepted; Chromium's (WebKit's) refusal stands.
            if BrowserRules.isLoopback(space.host), let trust = space.serverTrust { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.performDefaultHandling, nil) }
        case NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest, NSURLAuthenticationMethodNTLM, NSURLAuthenticationMethodNegotiate:
            if challenge.previousFailureCount > 2 { completionHandler(.performDefaultHandling, nil); return }
            askLogin(tab, challenge: challenge) { credential in
                if let credential { completionHandler(.useCredential, credential) } else { completionHandler(.performDefaultHandling, nil) }
            }
        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }

    /// A tab's download: a pdf goes to a temporary file and then to the viewer; any other is saved where the person says.
    func receive(_ download: WKDownload, tab: PageTab, response: URLResponse?) {
        let receiver = DownloadReceiver(owner: self, tab: tab, response: response)
        download.delegate = receiver
        receivers.append(receiver)
    }

    func downloadEnded(_ receiver: DownloadReceiver) { receivers.removeAll { $0 === receiver } }
}

/// One download from a tab (Electron's will-download item): a pdf to the viewer, anything else to a file the person picks.
@MainActor
final class DownloadReceiver: NSObject, WKDownloadDelegate {
    weak var owner: BrowserViews?
    let tab: PageTab
    var response: URLResponse?
    var file: URL?
    var pdf = false
    var url = ""
    var name = ""
    var under = ""
    var tooBig = false
    private var progress: NSKeyValueObservation?

    init(owner: BrowserViews, tab: PageTab, response: URLResponse?) { self.owner = owner; self.tab = tab; self.response = response }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        guard let owner else { completionHandler(nil); return }
        url = response.url?.absoluteString ?? download.originalRequest?.url?.absoluteString ?? ""
        if BrowserRules.isPDF(mime: response.mimeType, fileName: suggestedFilename, url: url) && owner.entries[tab.id] === tab {
            pdf = true
            try? FileManager.default.createDirectory(at: owner.pdfDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let target = owner.pdfDir.appendingPathComponent("\(owner.nextId("pdf")).pdf")
            file = target
            tab.download = url // its page's cancelled load is this download, not a failure
            name = BrowserRules.pdfName(suggestedFilename, url)
            under = tab.webView.url?.absoluteString ?? "about:blank"
            owner.send(.pdf(id: tab.id, url: url, name: name, under: under, loading: true, bytes: nil, error: nil))
            if response.expectedContentLength > Int64(BrowserRules.maxPDFBytes) { tooBig = true; completionHandler(nil); return }
            progress = download.progress.observe(\.completedUnitCount) { [weak self] p, _ in
                if p.completedUnitCount > Int64(BrowserRules.maxPDFBytes) { MainActor.assumeIsolated { self?.tooBig = true }; download.cancel() }
            }
            completionHandler(target)
            return
        }
        // Electron asked where to save any other download (its default); so does this
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        let finish: (NSApplication.ModalResponse) -> Void = { result in completionHandler(result == .OK ? panel.url : nil) }
        if let window = owner.window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
    }

    func downloadDidFinish(_ download: WKDownload) {
        defer { owner?.downloadEnded(self) }
        guard pdf, let owner, let file else { return }
        defer { try? FileManager.default.removeItem(at: file) }
        guard owner.entries[tab.id] === tab else { return }
        do {
            let bytes = try owner.readPdf(file.path)
            owner.send(.pdf(id: tab.id, url: url, name: name, under: under, loading: false, bytes: bytes, error: nil))
        } catch {
            owner.send(.pdf(id: tab.id, url: url, name: name, under: under, loading: false, bytes: nil, error: error.localizedDescription))
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        defer { owner?.downloadEnded(self) }
        guard pdf, let owner, owner.entries[tab.id] === tab else { return }
        if let file { try? FileManager.default.removeItem(at: file) }
        owner.send(.pdf(id: tab.id, url: url, name: name, under: under, loading: false, bytes: nil, error: tooBig ? "The pdf is larger than 200 MB" : "The pdf did not download"))
    }
}

/// A window a page opened with window.open features (decision 49): a real child window that keeps its opener, the page's
/// requested size (at least 320×320), white, not full-screenable, its title the host and the page's title.
@MainActor
final class PopupWindow: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    weak var owner: BrowserViews?
    let webView: WKWebView
    let window: NSWindow
    let from: String?
    private var observations: [NSKeyValueObservation] = []

    init(owner: BrowserViews, configuration: WKWebViewConfiguration, features: WKWindowFeatures, from: String?) {
        self.owner = owner
        self.from = from
        let width = max(320, CGFloat(features.width?.doubleValue ?? 500)), height = max(320, CGFloat(features.height?.doubleValue ?? 600))
        webView = StageWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.minSize = NSSize(width: 320, height: 320)
        window.backgroundColor = .white
        window.collectionBehavior.insert(.fullScreenNone)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        (webView as? StageWebView)?.keys = nil
        let retitle: (WKWebView, Any) -> Void = { [weak self] _, _ in MainActor.assumeIsolated { self?.title() } }
        observations = [webView.observe(\.title, changeHandler: retitle), webView.observe(\.url, changeHandler: retitle)]
        if let x = features.x?.doubleValue, let y = features.y?.doubleValue { window.setFrameTopLeftPoint(NSPoint(x: x, y: (NSScreen.main?.frame.maxY ?? 800) - y)) } else { window.center() }
    }

    func show(parent: NSWindow?) {
        parent?.addChildWindow(window, ordered: .above)
        window.makeKeyAndOrderFront(nil)
    }

    /// A popup has no address bar, so its title carries the host: the person can see who is asking.
    func title() { window.title = [webView.url?.host ?? "", webView.title ?? ""].filter { !$0.isEmpty }.joined(separator: " — ") }

    func close() { window.parent?.removeChildWindow(window); window.close() }
    func windowWillClose(_ notification: Notification) { observations.removeAll(); owner?.popupClosed(self) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let owner, let url = action.request.url else { decisionHandler(.cancel); return }
        let href = url.absoluteString
        if action.targetFrame?.isMainFrame ?? true {
            if GitHubPages.isSignIn(href) { NSWorkspace.shared.open(url); decisionHandler(.cancel); return }
            if href.hasPrefix("about:") || owner.allowed(href, from: webView.url?.absoluteString) { decisionHandler(.allow); return }
            decisionHandler(.cancel); owner.handOver(url); return
        }
        if !BrowserRules.externalScheme(href).isEmpty { owner.handOver(url); decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        owner?.authenticate(challenge, tab: nil, completionHandler) ?? completionHandler(.performDefaultHandling, nil)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        owner?.newWindow(from: from.flatMap { owner?.entries[$0] }, fromPopup: true, configuration: configuration, action: action, features: windowFeatures)
    }
    func webViewDidClose(_ webView: WKWebView) { close() }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        owner?.session.decide(origin: "\(origin.protocol)://\(origin.host)", permission: "media", window: window) { decisionHandler($0 ? .grant : .deny) }
    }
}

/// A page saved whole (MATH-17; Electron's savePage 'HTMLComplete'): WebKit's web archive unpacked into index.html and an
/// index_files folder beside it, each subresource's address in the page pointed at its copy.
enum SavedPage {
    static func write(archive: Data, into dir: URL) throws -> URL {
        guard let plist = try PropertyListSerialization.propertyList(from: archive, format: nil) as? [String: Any],
              let main = plist["WebMainResource"] as? [String: Any], let data = main["WebResourceData"] as? Data else { throw StageFiles.Failure("The page could not be saved") }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoding = (main["WebResourceTextEncodingName"] as? String).map { CFStringConvertEncodingToNSStringEncoding(CFStringConvertIANACharSetNameToEncoding($0 as CFString)) } ?? String.Encoding.utf8.rawValue
        var html = String(data: data, encoding: String.Encoding(rawValue: encoding)) ?? String(decoding: data, as: UTF8.self)
        let subresources = plist["WebSubresources"] as? [[String: Any]] ?? []
        if !subresources.isEmpty {
            let folder = dir.appendingPathComponent("index_files")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var used = Set<String>()
            for resource in subresources {
                guard let address = resource["WebResourceURL"] as? String, let bytes = resource["WebResourceData"] as? Data, let url = URL(string: address) else { continue }
                var name = url.lastPathComponent.isEmpty || url.lastPathComponent == "/" ? "resource" : url.lastPathComponent
                name = name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
                var unique = name, n = 1
                while used.contains(unique) { n += 1; unique = "\((name as NSString).deletingPathExtension)(\(n))\((name as NSString).pathExtension.isEmpty ? "" : "." + (name as NSString).pathExtension)" }
                used.insert(unique)
                try bytes.write(to: folder.appendingPathComponent(unique))
                html = html.replacingOccurrences(of: address, with: "index_files/\(unique)")
                if let path = url.path.isEmpty ? nil : url.path, path.count > 1 { html = html.replacingOccurrences(of: "\"\(path)\"", with: "\"index_files/\(unique)\"") }
            }
        }
        let file = dir.appendingPathComponent("index.html")
        try html.write(to: file, atomically: true, encoding: .utf8)
        return file
    }
}
