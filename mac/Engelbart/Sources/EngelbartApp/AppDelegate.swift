import AppKit
import EngelbartCore
import EngelbartUI

/// The app's lifecycle (index.cjs:599-1407): one instance, every quit through requestQuit, the Dock's reopen and menu,
/// windows restored at launch, the menu built (and rebuilt when the updater changes).
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    public let paths: AppPaths
    public let slots: ScreenSlots
    public let quit = QuitController()
    public private(set) var manager: WindowManager!
    public private(set) var menu: MainMenu!
    let instance: SingleInstance
    /// ENGELBART_SNAPSHOT / ENGELBART_DRIVE runs (SelfTest.swift).
    public private(set) var selfTest: SelfTest?

    public init(paths: AppPaths, slots: ScreenSlots, instance: SingleInstance) {
        self.paths = paths
        self.slots = slots
        self.instance = instance
        super.init()
    }

    public func applicationWillFinishLaunching(_ notification: Notification) {
        Fonts.register()
        EngelbartWiring.install(slots, delegate: self)
        manager = WindowManager(slots: slots, paths: paths)
        manager.quit = quit
        quit.saveWindowsNow = { [weak self] in self?.manager.saveWindows(now: true) }
        quit.dialogWindow = { [weak self] in self?.manager.dialogWindow() }
        quit.finish = { relaunch in
            if relaunch { QuitController.relaunch() }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        menu = MainMenu(manager: manager, quit: quit, slots: slots, paths: paths)
        menu.rebuild()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // A run that is not a bundle (swift run) shows Engelbart's icon in the Dock, as the bundle does.
        if Bundle.main.bundleURL.pathExtension != "app", let icon = Images.named("app-icon") { NSApp.applicationIconImage = icon }
        instance.onSecondLaunch { [weak self] in self?.manager.showWindow() }
        manager.restore()
        if manager.headless == false { NSApp.activate(ignoringOtherApps: true) }
        selfTest = SelfTest(manager: manager, quit: quit)
        selfTest?.start()
    }

    /// Every quit comes through requestQuit; the app ends only once it has said so.
    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quit.ready { return .terminateNow }
        Task { @MainActor in
            let going = await quit.request()
            if !going && !quit.ready { NSApp.reply(toApplicationShouldTerminate: false) }
        }
        return .terminateLater
    }

    /// The last window closed: the app stays (macOS).
    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// The Dock icon: the focused window shown, or a new one.
    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        manager.showWindow()
        return false
    }

    public func applicationDockMenu(_ sender: NSApplication) -> NSMenu? { menu.dockMenu() }

    public func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

/// The process's entry point: `--mcp <name>` serves an MCP server and exits; anything else starts AppKit.
public enum EngelbartMain {
    public static func run(arguments: [String] = Array(CommandLine.arguments.dropFirst())) -> Never {
        if let request = MCPRegistry.request(in: arguments) {
            MCPServers.registerAll()
            exit(MCPRegistry.serve(request.name, args: request.args))
        }
        let paths = AppPaths()
        if AppPaths.isElectronRoot(paths.dataRoot, home: paths.home) {
            FileHandle.standardError.write(Data("[engelbart] refusing to use the Electron app's data root \(paths.dataRoot.path)\n".utf8))
            exit(1)
        }
        let instance = SingleInstance(userData: paths.userData)
        if !instance.acquire() {
            instance.announceSecondLaunch()
            exit(0)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = MainActor.assumeIsolated { AppDelegate(paths: paths, slots: ScreenSlots.shared, instance: instance) }
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        exit(0)
    }
}
