import AppKit
import EngelbartCore
import EngelbartUI
import SwiftUI

/// The windows (index.cjs openWindow / newWindow / showWindow / saveWindows; windows.cjs). Each window has its own root
/// (RootModel + RootView), its context in the registry, and its place saved in state.json through the Store.
@MainActor
public final class WindowManager: NSObject, NSWindowDelegate {
    public let registry = WindowRegistry()
    public let slots: ScreenSlots
    public let paths: AppPaths
    public let headless: Bool
    public var quit: QuitController?
    private var windows: [Int: EngelbartWindow] = [:]
    private var chromes: [Int: WindowChrome] = [:]
    private var saveTimer: DispatchWorkItem?
    private let hub: EventHub
    /// How long a change waits before the windows are saved (800 ms).
    public var saveDelay: TimeInterval = 0.8

    public init(slots: ScreenSlots, paths: AppPaths, headless: Bool = ProcessInfo.processInfo.environment["ENGELBART_HEADLESS"] == "1", hub: EventHub = .shared) {
        self.slots = slots
        self.paths = paths
        self.headless = headless
        self.hub = hub
        super.init()
        registry.onChange = { [weak self] in self?.saveWindows() }
    }

    public func window(of ctx: WindowContext) -> EngelbartWindow? { windows[ctx.id] }
    public func model(of ctx: WindowContext) -> RootModel? { ctx.root as? RootModel }
    public var focusedContext: WindowContext? { registry.focused() }

    /// The work areas of every display, y-down.
    private var workAreas: [CGRect] {
        let main = NSScreen.screens.first?.frame.height ?? 0
        return NSScreen.screens.map { WindowGeometry.yDown($0.visibleFrame, mainHeight: main) }
    }

    /// A window. `place`: where it opens (nil: where the app was last); `bounds`: a saved window's; `from`: the window it is
    /// opened from.
    @discardableResult
    public func open(place: WindowPlace? = nil, bounds: CGRect? = nil, from: WindowContext? = nil) -> WindowContext {
        // The last window closed on macOS is only hidden, for the Dock icon to bring back; once another opens, it goes.
        for ctx in registry.all() where ctx.closedHidden { windows[ctx.id]?.close() }
        let fromBounds = from.flatMap { windows[$0.id] }.map { WindowGeometry.yDown($0.frame, mainHeight: NSScreen.screens.first?.frame.height ?? 0) }
        let placed = WindowGeometry.placement(bounds: bounds, from: fromBounds, workAreas: workAreas)
        let window = EngelbartWindow(frame: NSRect(origin: .zero, size: placed.size))
        if let origin = placed.origin {
            let main = NSScreen.screens.first?.frame.height ?? 0
            window.setFrame(WindowGeometry.yUp(CGRect(origin: origin, size: placed.size), mainHeight: main), display: false)
        } else {
            window.center()
        }
        window.delegate = self
        let ctx = registry.add(window, place: place)
        windows[ctx.id] = window

        let env = ShellDemo.current
        let backend: ShellBackend = slots.backend?()
            ?? DemoBackend(environment: env, paths: paths, testModeAvailable: Developer.current) as ShellBackend?
            ?? EmptyBackend(paths: paths, testModeAvailable: Developer.current)
        let model = RootModel(backend: backend, hub: hub)
        if let page = env["ENGELBART_SHELL_SETTINGS"] { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { model.settingsPage = page } }
        model.toolsGate = slots.toolsGate
        model.windowTarget = { [weak self, weak ctx] in
            guard let self, let ctx else { return nil }
            return self.registry.target(ctx)
        }
        model.reportPlace = { [weak self, weak ctx] place in
            guard let self, let ctx else { return }
            self.registry.navigated(ctx, place)
        }
        model.onTitle = { [weak window] title in window?.title = title }
        model.confirmReset = { [weak window, weak ctx] fresh in
            let root = (ctx?.root as? RootModel)?.config.map { AppPaths.shown(URL(fileURLWithPath: $0.testRoot)) } ?? AppPaths.shown(self.paths.testRoot)
            return await Dialogs.confirmReset(fresh: fresh, testRootShown: root, window: window)
        }
        ctx.root = model
        let chrome = WindowChrome()
        chromes[ctx.id] = chrome
        let content = makeContent(model: model, chrome: chrome, ctx: ctx, window: window)
        window.contentView = content
        window.onFullScreenChange = { [weak content, weak chrome] on in
            chrome?.fullScreen = on
            content?.stripsHidden = on
        }
        ctx.actions.on(.reload) { [weak self, weak ctx] in
            guard let self, let ctx else { return false }
            self.reload(ctx)
            return true
        }
        ctx.actions.on(.toolsOpen) { model.openToolSetup(); return true }
        if !headless {
            window.makeKeyAndOrderFront(nil)
        }
        Task { await model.boot() }
        return ctx
    }

    private func makeContent(model: RootModel, chrome: WindowChrome, ctx: WindowContext, window: NSWindow) -> WindowContentView {
        let root = RootView(model: model, chrome: chrome, context: ctx, slots: slots,
                            pickFolder: { [weak window, paths] in await Dialogs.pickDirectory(current: nil, home: paths.home, window: window) },
                            reveal: { Dialogs.reveal($0) })
        let host = NSHostingView(rootView: root)
        host.sizingOptions = []
        // Full-size content: the header is drawn under the (hidden) title bar, so no safe area at the top.
        host.safeAreaRegions = []
        return WindowContentView(root: host)
    }

    /// View ▸ Reload: the window's page started over (its own views go; the app's things stay).
    public func reload(_ ctx: WindowContext) {
        guard let window = windows[ctx.id], let chrome = chromes[ctx.id], let old = model(of: ctx) else { return }
        registry.reset(ctx)
        hub.post("window:reset", ["window": .number(Double(ctx.id))])
        let model = RootModel(backend: old.backend, hub: hub)
        model.toolsGate = old.toolsGate
        model.windowTarget = old.windowTarget
        model.reportPlace = old.reportPlace
        model.onTitle = old.onTitle
        model.confirmReset = old.confirmReset
        ctx.root = model
        let content = makeContent(model: model, chrome: chrome, ctx: ctx, window: window)
        content.stripsHidden = window.isFullScreen
        window.contentView = content
        Task { await model.boot() }
    }

    /// A new window on the workspace `from` shows, else on the projects screen.
    @discardableResult
    public func newWindow(from: WindowContext?) -> WindowContext {
        let place = from?.place?.projectId != nil ? from!.place! : WindowPlace()
        return open(place: place, from: from)
    }

    /// The focused window, shown (the Dock icon, a second launch); a window when there is none.
    public func showWindow() {
        guard let ctx = registry.focused(), let window = windows[ctx.id], !window.isDestroyed else { open(); return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        ctx.closedHidden = false
        window.makeKeyAndOrderFront(nil)
    }

    /// A sign-in that finished or a download that arrived: the focused window restored, shown and focused, the app in front.
    public func bringForward() {
        showWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// A dialog's window: the one that asked, else the focused one.
    public func dialogWindow() -> NSWindow? {
        registry.dialogContext().flatMap { windows[$0.id] }.flatMap { $0.isDestroyed ? nil : $0 }
    }

    /// The Agent Viewer's reveal (index.cjs:1364-1373): the window on the ask's project (else focused, else a new one)
    /// comes to the front and is told; the reveal is kept for a workspace that mounts after the event went by.
    @discardableResult
    public func reveal(_ target: JSONValue) -> Bool {
        let projectId = target["place"]?["projectId"]?.string
        let ctx = projectId.flatMap { registry.showing($0) } ?? registry.focused() ?? open()
        guard let window = windows[ctx.id], !window.isDestroyed else { return false }
        ctx.agentReveal = target
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        if let model = model(of: ctx) {
            let ref = target["place"]?["ref"]
            Task { await model.agentReveal(projectId: projectId, workspaceId: ref?["kind"]?.string == "workspace" ? ref?["workspaceId"]?.string : nil) }
        }
        hub.post(ShellEvents.agentReveal, target)
        return true
    }

    /// The reveal a window was told of, taken once by the Workspace of its project.
    public func takeReveal(_ ctx: WindowContext, projectId: String) -> JSONValue? {
        guard let held = ctx.agentReveal, held["place"]?["projectId"]?.string == projectId else { return nil }
        ctx.agentReveal = nil
        return held
    }

    // MARK: saving (index.cjs saveWindows)

    /// The windows' places, sizes and positions go into state.json a moment after any change, and once more when
    /// quitting, before any window closes.
    public func saveWindows(now: Bool = false) {
        saveTimer?.cancel(); saveTimer = nil
        if !now, quit?.pending == true || quit?.ready == true { return }
        guard registry.count > 0, let store = slots.windowPlaces else { return }
        if now { store.writeWindows(registry.places()); return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.saveTimer = nil
            self.slots.windowPlaces?.writeWindows(self.registry.places())
        }
        saveTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + saveDelay, execute: work)
    }

    /// Every window open when the app last quit comes back, where it was; without that list, one window where the app was last.
    public func restore() {
        let saved = slots.windowPlaces?.readWindows() ?? []
        if ["home", "kit"].contains(ShellDemo.mode ?? "") { open(place: WindowPlace()); return }
        if saved.isEmpty { open(); return }
        for entry in saved { open(place: entry.place, bounds: entry.bounds?.cgRect) }
    }

    // MARK: NSWindowDelegate

    private func context(_ notification: Notification) -> WindowContext? {
        guard let window = notification.object as? EngelbartWindow else { return nil }
        return registry.context(of: window)
    }

    public func windowDidResize(_ notification: Notification) { saveWindows() }
    public func windowDidMove(_ notification: Notification) { saveWindows() }

    public func windowDidBecomeKey(_ notification: Notification) {
        guard let ctx = context(notification) else { return }
        registry.touch(ctx)
        hub.post("window:focus", ["window": .number(Double(ctx.id)), "focused": true])
    }

    public func windowDidResignKey(_ notification: Notification) {
        guard let ctx = context(notification) else { return }
        // A post-it gesture in progress is cancelled (post-its listen); the Stage's preview ping hears the window lost the keys.
        hub.post("window:focus", ["window": .number(Double(ctx.id)), "focused": false])
    }

    /// On macOS the last window hides rather than closes (its things stay) until Quit; any other window closes.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let window = sender as? EngelbartWindow, let ctx = registry.context(of: window) else { return true }
        if quit?.ready != true, registry.count == 1 {
            ctx.closedHidden = true
            window.orderOut(nil)
            return false
        }
        return true
    }

    public func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? EngelbartWindow, let ctx = registry.context(of: window) else { return }
        registry.remove(ctx)
        hub.post("window:closed", ["window": .number(Double(ctx.id))])
        windows[ctx.id] = nil
        chromes[ctx.id] = nil
        // The Agent map is no workspace window: it goes with the last of them.
        if registry.count == 0 { slots.lastWindowClosed?() }
    }

    /// A hidden window shown again is no longer "closed".
    public func unhide(_ ctx: WindowContext) { ctx.closedHidden = false }
}
