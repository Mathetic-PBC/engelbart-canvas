import Foundation

// A link the app's own window asks to open in a new tab or window (a ⌘-click nothing else handled, target=_blank,
// window.open) opens in a new Stage tab while a workspace shows the Stage (2026-10-02), as every website does; with no
// Stage (the all-projects screen), and for GitHub's sign-in pages, it goes to the default browser. Anything but http(s)
// stays closed (src/main/stage-links.cjs, src/main/window-open.cjs).

public final class StageLinks {
    private var count = 0
    private let send: (String, [String: Any]) -> Bool
    private let openExternal: (String) -> Void

    /// `send(channel, payload)` → whether it was delivered ('stage:open-link' { url, newTab: true }); `openExternal(url)`.
    public init(send: @escaping (String, [String: Any]) -> Bool, openExternal: @escaping (String) -> Void) {
        self.send = send
        self.openExternal = openExternal
    }

    /// A Stage starts (true) or stops (false) taking the window's new-window links; each listener counts once.
    public func listen(_ on: Bool) { count = on ? count + 1 : max(0, count - 1) }
    public func reset() { count = 0 }
    public var listening: Bool { count > 0 }

    /// The window's open handler: never a window of its own.
    public func windowOpen(_ url: String) {
        guard let parsed = StageLinks.parseExternalUrl(url) else { return } // untrusted schemes remain closed
        if listening && !GitHubPages.isSignIn(parsed) && send("stage:open-link", ["url": parsed, "newTab": true]) { return }
        openExternal(parsed)
    }

    /// http(s), at most 4096 characters → the address as the URL parser spells it, else nil (ipc-validation parseExternalUrl).
    public static func parseExternalUrl(_ value: String) -> String? {
        guard !value.isEmpty, value.utf16.count <= 4096, let url = JSURL(value), url.protocol == "http:" || url.protocol == "https:" else { return nil }
        return url.href
    }

    public enum Route: Equatable { case stage(String), external(String) }

    /// Where a link the app's page would open in a new window goes (window-open.cjs windowOpenRoute); nil: nowhere.
    public static func windowOpenRoute(_ value: String, stage: Bool) -> Route? {
        guard let url = parseExternalUrl(value) else { return nil }
        if stage && !GitHubPages.isSignIn(url) { return .stage(url) }
        return .external(url)
    }
}
