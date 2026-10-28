import EngelbartCore
import Foundation

// The tools part of src/main/ipc.cjs and src/preload.cjs, and the wiring in src/main/index.cjs (2026-09-23). Electron's
// renderer reached the manager through IPC channels; the Swift screens call these methods, which keep the channels'
// names, their argument checks and when they answer: installs, updates, sign-ins and Connect answer the snapshot at once
// and report through `engelbart:tools` as they go; sign-out answers once the CLI has logged out and been checked again.

public enum ToolsChannelError: Error, LocalizedError, Equatable {
    case unknownTool
    public var errorDescription: String? { "Unknown tool" }
}

/// Event names (the Electron channel names), posted on EventHub.
public enum ToolsEvents {
    /// Every change of the tool check, payload `ToolsSnapshot.json`, to every window.
    public static let tools = "engelbart:tools"
    /// Engelbart ▸ Set Up Tools… (the focused window opens the dialog with all three).
    public static let toolsOpen = "engelbart:tools-open"
    /// Every change of the updater, payload `UpdateSnapshot.json`.
    public static let update = "engelbart:update"
}

@MainActor
public final class ToolsChannels {
    public let manager: ToolsManager
    let hub: EventHub

    public init(manager: ToolsManager, hub: EventHub = .shared) {
        self.manager = manager
        self.hub = hub
    }

    public static func toolName(_ value: String) throws -> String {
        guard TOOL_NAMES.contains(value) else { throw ToolsChannelError.unknownTool }
        return value
    }

    /// At most three, each a tool's name.
    public static func toolNames(_ value: [String]) throws -> [String] { try value.prefix(3).map(toolName) }

    /// `tools`
    public func tools() -> ToolsSnapshot { manager.snapshot() }
    /// `tools-check`
    public func check() async -> ToolsSnapshot { await manager.check() }
    /// `tools-install`: answers at once.
    @discardableResult public func install(_ names: [String]) throws -> ToolsSnapshot {
        let names = try Self.toolNames(names)
        Task { await manager.install(names) }
        return manager.snapshot()
    }
    /// `tools-update`
    @discardableResult public func update(_ name: String) throws -> ToolsSnapshot {
        let name = try Self.toolName(name)
        Task { await manager.update(name) }
        return manager.snapshot()
    }
    /// `tools-sign-in`
    @discardableResult public func signIn(_ name: String) throws -> ToolsSnapshot {
        let name = try Self.toolName(name)
        Task { await manager.signIn(name) }
        return manager.snapshot()
    }
    /// `tools-connect` (2026-10-14): installed, updated, checked and signed in, whichever it still needs, from one press.
    @discardableResult public func connect(_ name: String) throws -> ToolsSnapshot {
        let name = try Self.toolName(name)
        Task { await manager.connect(name) }
        return manager.snapshot()
    }
    /// `tools-cancel-sign-in`
    @discardableResult public func cancelSignIn(_ name: String) throws -> Bool { manager.cancelSignIn(try Self.toolName(name)) }
    /// `tools-sign-out`: once the CLI has logged out and been checked again.
    public func signOut(_ name: String) async throws -> ActionResult { await manager.signOut(try Self.toolName(name)) }
    /// `tools-skip`
    @discardableResult public func skip(_ names: [String]) throws -> ToolsSnapshot { manager.skip(try Self.toolNames(names)) }
    /// `tools-ask-again`
    @discardableResult public func askAgain(_ name: String) throws -> ToolsSnapshot { manager.askAgain(try Self.toolName(name)) }
    /// `tools-set-updates`: 'ask', anything else is 'auto'.
    @discardableResult public func setUpdates(_ value: String) -> ToolsSnapshot { manager.setUpdates(value == "ask" ? "ask" : "auto") }

    /// Engelbart ▸ Set Up Tools…: `engelbart:tools-open`.
    public func openSetup() { hub.post(ToolsEvents.toolsOpen, [:]) }
}

/// The tool check as the app starts it (src/main/index.cjs): checked at every launch in the background and recorded in
/// config.json → tools; installed, updated and signed in to from the setup dialog. The Git that comes with Engelbart stands
/// in when the Mac has none of its own, and on a Mac with neither agent Claude Code is installed at launch without asking.
/// ENGELBART_TOOLS_FAKE (JSON) pretends a machine, ENGELBART_TOOLS=off skips the launch check and ENGELBART_GIT=bundled uses
/// Engelbart's Git even where there is another, for scripted runs only. A pretend machine keeps its records in memory:
/// config.json keeps what the real machine has (and the choices made on it), so a scripted run never leaves a fake path or
/// a "skip" behind.
@MainActor
public final class ToolsSetup {
    public let manager: ToolsManager
    public let channels: ToolsChannels
    /// The pretend machine, when ENGELBART_TOOLS_FAKE set one.
    public let fake: FakeTools?
    public let runner: ToolRunner

    /// `storage`: config.json → tools through the Store. `resourcesPath`: the app bundle's Resources (Engelbart's own Git).
    public init(storage: ToolsStorage, environment: [String: String] = ProcessInfo.processInfo.environment,
                resourcesPath: String? = Bundle.main.resourcePath, appRoot: String? = nil, hub: EventHub = .shared) {
        let fake = environment["ENGELBART_TOOLS_FAKE"].flatMap { $0.isEmpty ? nil : FakeTools($0) }
        let runner = ToolRunner()
        var options = DetectOptions()
        options.bundledGit = BundledGit.find(resourcesPath: resourcesPath, appRoot: appRoot, override: environment["ENGELBART_BUNDLED_GIT"])
        options.preferBundledGit = environment["ENGELBART_GIT"] == "bundled"
        let detect: ToolsManager.Detect = fake.map { f in { await f.detect($0) } } ?? { only in
            var now = options
            now.environment = ProcessInfo.processInfo.environment // read at each check, as the agents read it
            return await detectTools(runner: runner, only: only, options: now)
        }
        manager = ToolsManager(storage: fake == nil ? storage : .memory(), detect: detect, actions: fake ?? ToolInstaller(runner: runner),
                               signIn: fake?.signInStarter ?? makeSignInStarter(shell: runner.shellPath),
                               signOut: fake?.signOutRunner ?? makeSignOutRunner(runner: runner),
                               installAtLaunch: ["claude"],
                               onChange: { snapshot in hub.post(ToolsEvents.tools, snapshot.json) })
        channels = ToolsChannels(manager: manager, hub: hub)
        self.fake = fake
        self.runner = runner
        if environment["ENGELBART_TOOLS"] != "off" { Task { await manager.start() } }
    }

    /// Test mode's reset (2026-10-15): a pretend machine back to its first state, then checked again, so setup shows again.
    public func afterTestReset() async {
        guard let fake else { return }
        fake.reset()
        await manager.check()
    }

    /// Before quitting: Claude Code or Codex sign-ins still waiting in the browser end first (their terminals are outside
    /// the session manager).
    public func beforeQuit() async { await manager.stopSignIns() }
}
