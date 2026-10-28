import Foundation

/// What the menu sends to a window (index.cjs buildMenu: "The menu's commands act on the focused window"). Wave-2 screens
/// register handlers on their window's `WindowActions`; the menu routes each item to the focused window's handler.
public enum WindowAction: String, CaseIterable, Sendable {
    /// Edit ▸ Find ▸ Find… / Find Next / Find Previous: the Stage's find (browser/views.cjs shortcut), or the document's
    /// (DocFind), whichever the screen says. A menu item, not a key a page takes first, so a page keeps its own find.
    case find, findNext = "find-next", findPrevious = "find-previous"
    /// Engelbart ▸ Set Up Tools… ('engelbart:tools-open').
    case toolsOpen = "tools-open"
    /// View ▸ Reload: the window starts over, as a page reload did.
    case reload
    /// View ▸ Toggle Developer Tools: the Stage's page inspector, where a screen offers one.
    case toggleDevTools = "toggle-dev-tools"
}

/// One window's handlers, newest first: a screen that registers later (a pane in front) is asked before an older one,
/// and a handler that returns false passes the action on.
public final class WindowActions {
    public typealias Handler = () -> Bool
    private var handlers: [WindowAction: [(UUID, Handler)]] = [:]

    public init() {}

    /// Registers a handler; returns the token to remove it with.
    @discardableResult
    public func on(_ action: WindowAction, _ handler: @escaping Handler) -> UUID {
        let id = UUID()
        handlers[action, default: []].insert((id, handler), at: 0)
        return id
    }

    public func off(_ token: UUID) {
        for key in handlers.keys { handlers[key]?.removeAll { $0.0 == token } }
    }

    /// Runs the newest handler that takes it. → whether one did.
    @discardableResult
    public func send(_ action: WindowAction) -> Bool {
        for (_, handler) in handlers[action] ?? [] where handler() { return true }
        return false
    }

    public func handles(_ action: WindowAction) -> Bool { !(handlers[action] ?? []).isEmpty }
}
