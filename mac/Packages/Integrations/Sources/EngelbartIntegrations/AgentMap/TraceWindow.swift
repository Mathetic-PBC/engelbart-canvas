import AppKit
import WebKit
import EngelbartCore
import EngelbartUI

// src/main/onboarding/trace-window.cjs + trace.html + trace-preload.cjs (2026-10-13): the Agent trace window, View ▸
// Agent Trace (⌥⌘T). The page is trace.html as Electron ships it (Resources/trace.html, unchanged), in a WKWebView, with
// `window.traceApi` bridged to this process: list() the entries kept, save(html) "Save as HTML", reveal() "Show files",
// onEntry(fn) each new or changed entry. The trace itself (onboarding/trace.cjs: <dataRoot>/.connect/trace/*.jsonl) is
// the Connect package's; it gives `list()` and posts each entry on EventHub as `trace:entry`.

/// The trace the window shows (Connect's onboarding trace).
public protocol AgentTraceSource: AnyObject {
    /// The last entries kept, oldest first.
    func list() -> [JSONValue]
    /// The folder its files are in (<dataRoot>/.connect/trace).
    func traceDir() -> String
}

@MainActor
public final class TraceWindow: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply {
    let source: AgentTraceSource
    let hub: EventHub
    private var window: NSWindow?
    private var web: WKWebView?
    private var token: EventHub.Token?

    public init(source: AgentTraceSource, hub: EventHub = .shared) {
        self.source = source
        self.hub = hub
        super.init()
        token = hub.on("trace:entry") { [weak self] entry in MainActor.assumeIsolated { self?.send(entry) } }
    }

    public var isOpen: Bool { window != nil }

    static var page: URL? {
        ResourceBundle.named("Integrations_EngelbartIntegrations", fallback: Bundle.module).url(forResource: "trace", withExtension: "html")
    }

    /// The page's bridge (trace-preload.cjs), before its own script runs.
    static let bridge = """
    window.traceApi = {
      list: () => window.webkit.messageHandlers.trace.postMessage({ op: 'list' }),
      save: (html) => window.webkit.messageHandlers.trace.postMessage({ op: 'save', html }),
      reveal: () => window.webkit.messageHandlers.trace.postMessage({ op: 'reveal' }),
      onEntry: (listener) => { window.__traceEntry = listener; return () => { if (window.__traceEntry === listener) window.__traceEntry = null; }; },
    };
    """

    @discardableResult
    public func open() -> Bool {
        if let window { window.makeKeyAndOrderFront(nil); return true }
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "trace")
        let web = WKWebView(frame: .zero, configuration: config)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Agent trace"
        w.minSize = NSSize(width: 560, height: 400)
        w.backgroundColor = .white
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = web
        if let page = Self.page { web.loadFileURL(page, allowingReadAccessTo: URL(fileURLWithPath: "/")) }
        w.center()
        w.makeKeyAndOrderFront(nil)
        self.web = web
        window = w
        return true
    }

    /// A new or changed entry, to the window when it is open.
    func send(_ entry: JSONValue) {
        guard let web else { return }
        web.evaluateJavaScript("window.__traceEntry && window.__traceEntry(\(JSONText.stringify(entry).replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")))", completionHandler: nil)
    }

    /// The page as it shows, written where the person picks (it must be a whole page, at most 60 MB). → the path, or ''.
    public static func save(_ html: String, in window: NSWindow?, choose: (NSSavePanel, NSWindow?) async -> URL? = TraceWindow.runPanel) async throws -> String {
        guard html.hasPrefix("<!doctype html>"), html.utf8.count <= 60_000_000 else { throw BenchmarkError(message: "html is invalid") }
        let stamp = re("[:T]").replace(String(Time.iso().prefix(16)), with: "-")
        let panel = NSSavePanel()
        panel.title = "Save agent trace"
        panel.nameFieldStringValue = "Engelbart agent trace \(stamp).html"
        panel.allowedContentTypes = [.html]
        guard let url = await choose(panel, window) else { return "" }
        try FileOps.write(html, to: url.path, mode: 0o600)
        return url.path
    }

    public static func runPanel(_ panel: NSSavePanel, _ window: NSWindow?) async -> URL? {
        if let window { return await panel.beginSheetModal(for: window) == .OK ? panel.url : nil }
        return panel.runModal() == .OK ? panel.url : nil
    }

    /// trace:reveal: the trace's folder (made if need be) opened in the Finder. → whether there is one.
    public func revealFolder() -> Bool {
        let dir = source.traceDir()
        guard !dir.isEmpty else { return false }
        FileOps.mkdir(dir)
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
        return true
    }

    // The trace window's own calls: from that page only (WKScriptMessage carries its frame).
    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.webView === web, message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "Not the trace window"); return
        }
        switch op {
        case "list": replyHandler(JSONValue.array(source.list()).any, nil)
        case "reveal": replyHandler(revealFolder(), nil)
        case "save":
            let html = body["html"] as? String ?? ""
            Task { @MainActor in
                do { replyHandler(try await Self.save(html, in: self.window), nil) } catch { replyHandler(nil, error.localizedDescription) }
            }
        default: replyHandler(nil, "Unknown call")
        }
    }

    public func windowWillClose(_ notification: Notification) {
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "trace", contentWorld: .page)
        web = nil
        window = nil
    }
}
