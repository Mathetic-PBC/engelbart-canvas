import AppKit

/// The main menu, as index.cjs buildMenu makes it on macOS. The menu's commands act on the focused window (its
/// WindowActions); the standard Edit and Window items go down the responder chain as Electron's roles do.
@MainActor
public final class MainMenu: NSObject {
    weak var manager: WindowManager?
    weak var quit: QuitController?
    let slots: ScreenSlots
    let paths: AppPaths
    /// The data root shown by Reveal Engelbart Folder (the Store's layout.root once it is wired; else the data root).
    public var revealRoot: () -> String

    public init(manager: WindowManager, quit: QuitController, slots: ScreenSlots, paths: AppPaths) {
        self.manager = manager
        self.quit = quit
        self.slots = slots
        self.paths = paths
        revealRoot = { paths.dataRoot.path }
        super.init()
    }

    /// One item: title, key equivalent (with its modifiers), action and target.
    private func item(_ title: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, _ action: Selector?, target: AnyObject? = nil) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
        it.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        it.target = target
        return it
    }

    /// Builds the menu bar (again whenever the updater's state changes).
    public func rebuild() {
        let bar = NSMenu()
        bar.addItem(submenu(appMenu(), title: "Engelbart"))
        bar.addItem(submenu(fileMenu(), title: "File"))
        bar.addItem(submenu(editMenu(), title: "Edit"))
        bar.addItem(submenu(viewMenu(), title: "View"))
        let window = windowMenu()
        bar.addItem(submenu(window, title: "Window"))
        NSApp.mainMenu = bar
        NSApp.windowsMenu = window
    }

    private func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        menu.title = title
        it.submenu = menu
        return it
    }

    func appMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(item("About Engelbart", "", [], #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        if let update = slots.updateMenuItem?() {
            let it = item(update.label, "", [], update.action != nil ? #selector(updateItem) : nil, target: self)
            it.isEnabled = update.action != nil
            updateAction = update.action
            m.addItem(it)
        }
        m.addItem(.separator())
        m.addItem(item("Set Up Tools…", "", [], #selector(setUpTools), target: self))
        m.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApplication.shared.servicesMenu = servicesMenu
        m.addItem(services)
        m.addItem(.separator())
        m.addItem(item("Hide Engelbart", "h", .command, #selector(NSApplication.hide(_:))))
        m.addItem(item("Hide Others", "h", [.command, .option], #selector(NSApplication.hideOtherApplications(_:))))
        m.addItem(item("Show All", "", [], #selector(NSApplication.unhideAllApplications(_:))))
        m.addItem(.separator())
        m.addItem(item("Quit Engelbart", "q", .command, #selector(quitApp), target: self))
        return m
    }

    func fileMenu() -> NSMenu {
        let m = NSMenu()
        // On the workspace the focused window shows, else on the projects screen.
        m.addItem(item("New Window", "N", .command, #selector(newWindow), target: self))
        m.addItem(.separator())
        m.addItem(item("Reveal Engelbart Folder", "", [], #selector(revealFolder), target: self))
        m.addItem(.separator())
        // ⇧⌘W: ⌘W stays the tabs' (the Stage's, the documents', the terminal's).
        m.addItem(item("Close Window", "W", .command, #selector(NSWindow.performClose(_:))))
        return m
    }

    func editMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(item("Undo", "z", .command, Selector(("undo:"))))
        m.addItem(item("Redo", "Z", .command, Selector(("redo:"))))
        m.addItem(.separator())
        m.addItem(item("Cut", "x", .command, #selector(NSText.cut(_:))))
        m.addItem(item("Copy", "c", .command, #selector(NSText.copy(_:))))
        m.addItem(item("Paste", "v", .command, #selector(NSText.paste(_:))))
        m.addItem(item("Select All", "a", .command, #selector(NSText.selectAll(_:))))
        m.addItem(.separator())
        // The Browser pane's find (browser/views.cjs). A menu item, not a key the pane takes first, so a page with its own
        // find (Google Docs) keeps it.
        let find = NSMenu(title: "Find")
        find.addItem(item("Find…", "f", .command, #selector(findAction), target: self))
        find.addItem(item("Find Next", "g", .command, #selector(findNext), target: self))
        find.addItem(item("Find Previous", "G", .command, #selector(findPrevious), target: self))
        let findItem = NSMenuItem(title: "Find", action: nil, keyEquivalent: "")
        findItem.submenu = find
        m.addItem(findItem)
        return m
    }

    func viewMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(item("Reload", "r", .command, #selector(reload), target: self))
        m.addItem(item("Toggle Developer Tools", "i", [.command, .option], #selector(toggleDevTools), target: self))
        m.addItem(.separator())
        // Every prompt, input, output and context of onboarding's agents, and the dispatching around them (2026-10-13).
        m.addItem(item("Agent Trace", "t", [.command, .option], #selector(agentTrace), target: self))
        m.addItem(.separator())
        m.addItem(item("Toggle Full Screen", "f", [.command, .control], #selector(NSWindow.toggleFullScreen(_:))))
        return m
    }

    func windowMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(item("Minimize", "m", .command, #selector(NSWindow.performMiniaturize(_:))))
        m.addItem(item("Zoom", "", [], #selector(NSWindow.performZoom(_:))))
        m.addItem(.separator())
        m.addItem(item("Bring All to Front", "", [], #selector(NSApplication.arrangeInFront(_:))))
        return m
    }

    /// The Dock icon's menu: a new window on the projects screen.
    public func dockMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(item("New Window", "", [], #selector(newHomeWindow), target: self))
        return m
    }

    // MARK: actions

    private var updateAction: (() -> Void)?
    @objc func updateItem() { updateAction?() }

    private func send(_ action: WindowAction) {
        guard let ctx = manager?.focusedContext else { return }
        WindowRegistry.$asking.withValue(ctx) { _ = ctx.actions.send(action) }
    }

    @objc func setUpTools() { send(.toolsOpen) }
    @objc func quitApp() { NSApp.terminate(nil) }
    @objc func newWindow() { manager?.newWindow(from: manager?.focusedContext) }
    @objc func newHomeWindow() { manager?.newWindow(from: nil) }
    @objc func revealFolder() { Dialogs.reveal(revealRoot()) }
    @objc func findAction() { send(.find) }
    @objc func findNext() { send(.findNext) }
    @objc func findPrevious() { send(.findPrevious) }
    @objc func reload() { send(.reload) }
    @objc func toggleDevTools() { send(.toggleDevTools) }
    @objc func agentTrace() { slots.openAgentTrace?() }
}
