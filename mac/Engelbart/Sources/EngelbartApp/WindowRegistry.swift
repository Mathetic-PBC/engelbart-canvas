import CoreGraphics
import EngelbartCore
import Foundation

// Several windows, one app (src/main/windows.cjs, 2026-10-03, "multiple windows (like VS Code)"). Projects, the library,
// Bart, Builds, sandboxes, terminal processes and the GitHub sign-in are the app's, shared by every window; what a window
// looks at is its own: its Stage tabs, its post-it cards, whether its terminal pane is attached, how many of its Stages
// take links, and the project and workspace it shows. This is that bookkeeping, apart from AppKit so it can be tested;
// WindowManager drives it with real windows.
//
// Terminal sessions belong to the window they were opened from: their output goes there alone, and only that window
// acknowledges it. A closed window's sessions keep running; the next window whose terminal attaches takes them.
//
// `asking`: Electron knew which window's request a handler was serving through AsyncLocalStorage; here it is a task-local
// value: `WindowRegistry.$asking.withValue(ctx) { … }` around whatever a window asked for, read by dialogs and routing.

/// What the registry needs of a window.
public protocol WindowHandle: AnyObject {
    var isDestroyed: Bool { get }
    var isFocused: Bool { get }
    /// The window's normal (not zoomed, not full screen) bounds, y-down screen points.
    var normalBounds: CGRect { get }
}

/// One window's own things. Wave-2 packages keep their per-window parts (Stage tabs, post-it views, terminal attachment)
/// in `parts`, keyed by package.
public final class WindowContext: @unchecked Sendable {
    public let id: Int
    public let handle: WindowHandle
    public internal(set) var place: WindowPlace?
    public internal(set) var focusedAt: Int
    /// How many of this window's Stages take its new-window links (stage:links).
    public var stageListeners = 0
    /// The last window closed on macOS is only hidden until Quit (index.cjs:580-589).
    public var closedHidden = false
    /// An Agent Viewer reveal kept for a Workspace that mounts after it went by (agentMap:take-reveal).
    public var agentReveal: JSONValue?
    /// Whether this window's terminal pane has attached (RendererLifecycle.ready).
    public internal(set) var terminalAttached = false
    public var parts: [String: AnyObject] = [:]
    /// What the menu sends this window (find, tools-open, reload…), handled by its screens.
    public let actions = WindowActions()
    /// The window's root model (App.jsx state), set by the WindowManager.
    public internal(set) var root: AnyObject?

    init(id: Int, handle: WindowHandle, place: WindowPlace?, focusedAt: Int) {
        self.id = id; self.handle = handle; self.place = place; self.focusedAt = focusedAt
    }
}

public final class WindowRegistry {
    @TaskLocal public static var asking: WindowContext?

    private var contexts: [WindowContext] = []
    private var owners: [String: WindowContext] = [:] // terminal session id → its window
    private var clock = 0
    private var nextId = 1
    /// Whatever would be saved of the windows may have changed.
    public var onChange: () -> Void = {}
    /// A session's flow control starts over with the window it goes to (the Terminal package listens).
    public var onOwnerChange: (String) -> Void = { _ in }

    public init() {}

    private func open(_ ctx: WindowContext?) -> Bool {
        guard let ctx else { return false }
        return contexts.contains { $0 === ctx } && !ctx.handle.isDestroyed
    }

    @discardableResult
    public func add(_ handle: WindowHandle, place: WindowPlace? = nil) -> WindowContext {
        clock += 1
        let ctx = WindowContext(id: nextId, handle: handle, place: place.map { .clean(projectId: $0.projectId, workspaceId: $0.workspaceId) }, focusedAt: clock)
        nextId += 1
        contexts.append(ctx)
        onChange()
        return ctx
    }

    public func all() -> [WindowContext] { contexts }
    public var count: Int { contexts.count }
    public func context(of handle: WindowHandle) -> WindowContext? { contexts.first { $0.handle === handle } }

    /// The focused window, else the one focused last (a hidden one too: a dialog shows it first).
    public func focused() -> WindowContext? {
        var best: WindowContext?
        for ctx in contexts where !ctx.handle.isDestroyed {
            if ctx.handle.isFocused { return ctx }
            if best == nil || ctx.focusedAt > best!.focusedAt { best = ctx }
        }
        return best
    }

    public func touch(_ ctx: WindowContext) { clock += 1; ctx.focusedAt = clock }

    /// A window on a project, the one focused last first.
    public func showing(_ projectId: String) -> WindowContext? {
        contexts.filter { $0.place?.projectId == projectId }.max { $0.focusedAt < $1.focusedAt }
    }

    /// Closed: everything of its own goes; its terminal sessions keep running, held by no window until one attaches.
    public func remove(_ ctx: WindowContext) {
        guard contexts.contains(where: { $0 === ctx }) else { return }
        ctx.stageListeners = 0
        ctx.terminalAttached = false
        contexts.removeAll { $0 === ctx }
        for (id, owner) in owners where owner === ctx { owners[id] = nil }
        onChange()
    }

    /// Its page went (Reload) or crashed: the Stage's listeners and the terminal attachment go; the window stays.
    public func reset(_ ctx: WindowContext) {
        ctx.stageListeners = 0
        ctx.terminalAttached = false
    }

    public func navigated(_ ctx: WindowContext, _ place: WindowPlace) {
        ctx.place = .clean(projectId: place.projectId, workspaceId: place.workspaceId)
        onChange()
    }

    /// What a window opens on: nil before it said where it is, the projects screen, or its place.
    public func target(_ ctx: WindowContext) -> WindowTarget? {
        guard let place = ctx.place else { return nil }
        return place.projectId != nil ? .place(place) : .home
    }

    /// What is saved of the windows, the one focused last at the end. A window that has not said where it is yet is left out.
    public func places() -> [SavedWindow] {
        contexts.filter { $0.place != nil && !$0.handle.isDestroyed }
            .sorted { $0.focusedAt < $1.focusedAt }
            .map { SavedWindow(projectId: $0.place?.projectId, workspaceId: $0.place?.workspaceId, bounds: .rounded($0.handle.normalBounds)) }
    }

    // MARK: terminals

    /// The session's output goes to `ctx` from now on (nil: to no window). → the open window it went to before, if another.
    @discardableResult
    public func own(_ sessionId: String, _ ctx: WindowContext?) -> WindowContext? {
        let before = owners[sessionId]
        if let ctx, contexts.contains(where: { $0 === ctx }) { owners[sessionId] = ctx } else { owners[sessionId] = nil }
        onOwnerChange(sessionId)
        if let before, before !== ctx, open(before) { return before }
        return nil
    }

    public func ownerOf(_ sessionId: String) -> WindowContext? {
        let ctx = owners[sessionId]
        return open(ctx) ? ctx : nil
    }

    public func forget(_ sessionId: String) { owners[sessionId] = nil }

    /// Whether the session's window has its terminal pane attached.
    public func attached(_ sessionId: String) -> Bool { owners[sessionId]?.terminalAttached == true }

    /// A window's terminal pane attaches: sessions no open window holds come to it. → every session (the bootstrap list).
    @discardableResult
    public func bootstrap(_ ctx: WindowContext, sessions: [String]) -> [String] {
        for id in sessions where !open(owners[id]) { owners[id] = ctx }
        ctx.terminalAttached = true
        return sessions
    }

    /// Where a Build's run output or a sandbox terminal goes: the window that asked, else the one showing its project, else
    /// the focused one (index.cjs routeRun).
    public func routeTarget(projectId: String?) -> WindowContext? {
        if let asking = Self.asking, open(asking) { return asking }
        if let projectId, let shown = showing(projectId) { return shown }
        return focused()
    }

    /// A dialog's window: the one whose request opened it, else the focused one.
    public func dialogContext() -> WindowContext? {
        if let asking = Self.asking, open(asking) { return asking }
        return focused()
    }
}
