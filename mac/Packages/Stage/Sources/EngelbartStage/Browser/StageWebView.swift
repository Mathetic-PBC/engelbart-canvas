import AppKit
import WebKit

// A Stage tab's web view. What Electron took in `before-input-event` before the page saw it is taken here, in
// performKeyEquivalent and keyDown, before WebKit hands the key to the page: ⌘R, ⌘L, ⌘[, ⌘], ⌘J, ⌘T, ⌘W (⇧⌘W stays the
// window's), ⌘1–9; the boxes' keys (⌥ held, Backspace/Delete/Esc on a selected box, ⌘Z after one was removed); and a key
// typed while a selection's card shows. ⌘F is not here: it is the Edit menu's (Find…), which a page with its own find
// (Google Docs) gets to first, as in Electron, because WebKit offers the key to the page before the menu.
// The page taking the keyboard reports `browser:focused` (⌘T, ⌘W and ⌘F go to the side clicked last).

@MainActor
protocol StageWebViewKeys: AnyObject {
    /// A command key the Stage takes before the page (`r`, `l`, `[`, `]`, `j`, `t`, `w`, `1`…`9`). → whether it was taken.
    func pageShortcut(_ view: StageWebView, key: String, shift: Bool) -> Bool
    /// ⌥ alone pressed (down) or let go (up) in the page.
    func pageAlt(_ view: StageWebView, down: Bool, repeat: Bool)
    /// A key down in the page before it sees it (boxes, a selection's card). → whether it was taken.
    func pageKey(_ view: StageWebView, event: NSEvent) -> Bool
    func pageFocused(_ view: StageWebView)
    /// The right-click menu, rebuilt (views.cjs contextMenu).
    func pageMenu(_ view: StageWebView, menu: NSMenu)
}

final class StageWebView: WKWebView {
    weak var keys: StageWebViewKeys?
    /// The tab this view is (nil for a popup).
    var tabId: String?
    private var altDown = false

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.type == .keyDown, flags.contains(.command), !flags.contains(.option), !flags.contains(.control), window?.firstResponder === self || isDescendantFirstResponder,
           let key = event.charactersIgnoringModifiers?.lowercased(), let keys, keys.pageShortcut(self, key: key, shift: flags.contains(.shift)) {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    private var isDescendantFirstResponder: Bool {
        guard let responder = window?.firstResponder as? NSView else { return false }
        return responder.isDescendant(of: self)
    }

    override func keyDown(with event: NSEvent) {
        if let keys, keys.pageKey(self, event: event) { return }
        super.keyDown(with: event)
    }

    override func flagsChanged(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let alt = flags.contains(.option)
        let alone = alt && !flags.contains(.shift) && !flags.contains(.command) && !flags.contains(.control)
        if alt != altDown {
            altDown = alt
            keys?.pageAlt(self, down: alt && alone, repeat: false)
        }
        super.flagsChanged(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let took = super.becomeFirstResponder()
        if took { keys?.pageFocused(self) }
        return took
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        keys?.pageMenu(self, menu: menu)
        super.willOpenMenu(menu, with: event)
    }

    /// Developer tools (⋮ → Developer tools): the Web Inspector. WebKit offers no public call to show it, so it is asked
    /// for through the inspector object when the running WebKit has it; the right-click menu's Inspect Element is
    /// WebKit's own (isInspectable).
    func showInspector() {
        let inspector = NSSelectorFromString("_inspector")
        guard responds(to: inspector), let object = perform(inspector)?.takeUnretainedValue() as? NSObject else { return }
        let show = NSSelectorFromString("show")
        if object.responds(to: show) { object.perform(show) }
    }
}
