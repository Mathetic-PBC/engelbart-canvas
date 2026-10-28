import Foundation
import WebKit

// created-preview.cjs — a picture of a page @create made (2026-10-14; Create.readCreated): the editor draws an html file's
// row thumbnail and its expanded view from it. The page is opened in a hidden web view of its own (a non-persistent data
// store; it may not navigate or open windows), 900 wide (2026-10-15: from 1200, so a page's column fills more of the
// picture, and with no scrollbar), given a moment to draw itself, and captured as tall as it is, to 4000. The picture is
// kept beside the file (`out`) and taken again only when the file is newer, or the picture was taken at another width.
// One page at a time. Electron's offscreen BrowserWindow → an offscreen WKWebView and takeSnapshot.

public enum CreatedPreview {
    public static let width = 900
    public static let maxHeight = 4000
    static let loadSeconds: Double = 8
    static let settleSeconds: Double = 0.4

    /// A png's width, from its header (IHDR, bytes 16–19); 0 when it is no png.
    public static func pngWidth(_ data: Data) -> Int {
        guard data.count >= 24 else { return 0 }
        let b = [UInt8](data.prefix(24))
        guard b[12] == 0x49, b[13] == 0x48, b[14] == 0x44, b[15] == 0x52 else { return 0 }
        return Int(b[16]) << 24 | Int(b[17]) << 16 | Int(b[18]) << 8 | Int(b[19])
    }

    static let queue = SnapshotQueue()

    /// snapshot(file, out) → the png's bytes. Pages are taken one at a time.
    public static func snapshot(_ file: String, _ out: String) async throws -> Data {
        try await queue.run { try await shoot(file, out) }
    }

    struct Failed: Error, LocalizedError { var errorDescription: String? { "The page drew nothing" } }

    static func mtime(_ p: String) -> Date? { (try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date }

    @MainActor
    static func shoot(_ file: String, _ out: String) async throws -> Data {
        if let shot = mtime(out), let page = mtime(file), shot >= page, let held = FileManager.default.contents(atPath: out), pngWidth(held) == width { return held }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 800), configuration: config)
        let guard_ = NavigationGuard()
        view.navigationDelegate = guard_
        let url = URL(fileURLWithPath: file)
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        await guard_.loaded(within: loadSeconds)
        try? await Task.sleep(nanoseconds: UInt64(settleSeconds * 1e9))
        _ = try? await view.evaluateJavaScript("(()=>{const s=document.createElement('style');s.textContent='::-webkit-scrollbar{display:none}';document.head&&document.head.appendChild(s);})()")
        let tall = (try? await view.evaluateJavaScript("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) as? Double ?? 800
        let height = max(200, min(maxHeight, Int(tall.rounded(.up))))
        view.frame = CGRect(x: 0, y: 0, width: width, height: height)
        try? await Task.sleep(nanoseconds: 200_000_000)
        let conf = WKSnapshotConfiguration()
        conf.rect = CGRect(x: 0, y: 0, width: width, height: height)
        conf.snapshotWidth = NSNumber(value: width)
        let image = try await view.takeSnapshot(configuration: conf)
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]), !png.isEmpty else { throw Failed() }
        try FileManager.default.createDirectory(atPath: (out as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try png.write(to: URL(fileURLWithPath: out))
        chmod(out, 0o600)
        return png
    }

    /// Lets the page load once, refuses every navigation after it and every new window.
    final class NavigationGuard: NSObject, WKNavigationDelegate {
        private var done = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var first = true
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if first { first = false; return .allow }
            return .cancel
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
        private func finish() { done = true; let w = waiters; waiters = []; w.forEach { $0.resume() } }
        @MainActor func loaded(within seconds: Double) async {
            if done { return }
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                waiters.append(c)
                DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.finish() }
            }
        }
    }
}

/// One snapshot at a time, in the order asked.
actor SnapshotQueue {
    private var tail: Task<Void, Never>?
    func run<T: Sendable>(_ body: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task { () async throws -> T in await previous?.value; return try await body() }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }
}
