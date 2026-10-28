import EngelbartCore
import EngelbartUI
import SwiftUI

/// Where wave-2 screens plug into every window's root, without this package depending on theirs. Set once at launch, before
/// the first window opens (AppHooks.configure, in the app's start-up, or a wave-2 `EngelbartWiring.install()`). Each slot
/// gets the window's RootModel (the App.jsx state: phase, tree, entry, library, config…) and its WindowContext.
/// Unset, a slot draws a placeholder that names it.
@MainActor
public final class ScreenSlots {
    public static let shared = ScreenSlots()
    public init() {}

    public typealias Screen = (RootModel, WindowContext) -> AnyView

    // MARK: the three screens (App.jsx phases)
    /// All projects (screens/Home.jsx).
    public var home: Screen?
    /// Onboarding / + Project / the guided setup (screens/Onboarding.jsx): read `model.onboardMode`, `model.run` (rebuild
    /// when it changes), `model.backTitle`; finish with `model.onboarded(…)`, go back with `model.leaveOnboarding()`.
    public var onboarding: Screen?
    /// A project's workspace (screens/Workspace.jsx): `model.tree`, `model.entry`, `model.shownLibrary`; report the
    /// workspace on screen with `model.onVisit(id)`; leave with `model.goHome()`. It sits blurred and inert behind the
    /// DirectoryGate while the project has no directory (`active` false in Electron: read `model.tree?.project.directory`).
    public var workspace: Screen?

    // MARK: on every screen
    /// The update banner (ui/UpdateBanner.jsx; Tools).
    public var updateBanner: Screen?
    /// The tool setup dialog (ui/ToolSetup.jsx; Tools), shown while `model.setup` is set and no popup comes first.
    public var toolSetup: ((RootModel, WindowContext, ToolSetupRequest) -> AnyView)?
    /// Wraps the whole window (ui/SandboxProgress.jsx; Sandbox).
    public var sandboxProgress: ((RootModel, WindowContext, AnyView) -> AnyView)?
    /// The sandbox notification bell in the top-right controls (ui/SandboxNotifications.jsx; Sandbox).
    public var notificationBell: Screen?
    /// The Connect chip after the gear (ui/ConnectDock.jsx ConnectChip; Connect).
    public var connectChip: Screen?
    /// Import your context over the workspace, inside the app's 1000 × 800 modal (import/ImportFlow.jsx; ImportUI).
    public var importFlow: ((RootModel, WindowContext, WindowPlace) -> AnyView)?
    /// The guided-setup offer (ui/GuidedSetup.jsx GuidedSetupOffer), shown when `PopupGate.offer`.
    public var guidedOffer: Screen?
    /// The Connect / import popups (NeedPopup, ImportStatus, ProviderPopup, ConnectPopup), each deciding whether it shows
    /// from the window's PopupGate (`model`'s state plus its own sessions).
    public var popups: [Screen] = []

    // MARK: Settings
    /// Connections' page (workspace/Connections.jsx; Integrations + Tools).
    public var settingsConnections: ((SettingsContext) -> AnyView)?
    /// The Models page's data (Bart's model settings).
    public var modelSettings: ModelSettingsSource?

    // MARK: data
    /// Makes a window's backend (the Store adapter). Default: EmptyBackend.
    public var backend: (() -> ShellBackend)?
    /// Window places in state.json (the Store's projects.readWindows / writeWindows).
    public var windowPlaces: WindowPlacesStore?
    /// Model/tools gate for the launch dialog (model/tools.js).
    public var toolsGate: ToolsGate?
    /// Engelbart's updater for the app menu (updates.cjs menuItem): nil = no item.
    public var updateMenuItem: (() -> UpdateMenuItem?)?
    /// View ▸ Agent Trace (onboarding/trace-window.cjs).
    public var openAgentTrace: (() -> Void)?
    /// Called when the last workspace window closes (the Agent map window goes with it).
    public var lastWindowClosed: (() -> Void)?
}

/// Where the windows' places are kept (state.json `windows`, Store-owned).
public protocol WindowPlacesStore: AnyObject {
    func readWindows() -> [SavedWindow]
    func writeWindows(_ windows: [SavedWindow])
}

/// The updater's app-menu item: its label, and its action when enabled.
public struct UpdateMenuItem {
    public var label: String
    public var action: (() -> Void)?
    public init(label: String, action: (() -> Void)?) { self.label = label; self.action = action }
}

/// What a slot shows until its package plugs in.
struct ScreenPlaceholder: View {
    let name: String
    let detail: String
    var slot = "screen"
    var body: some View {
        VStack(spacing: 0) {
            PlaceholderHeader(title: "Engelbart")
            Spacer()
            VStack(spacing: 10) {
                Text(name).textStyle(.microcapLarge).foregroundStyle(Color(Palette.fnt))
                Text(detail).textStyle(TextStyle(13, lineHeight: 1.5)).foregroundStyle(Color(Palette.fnt))
            }
            .accessibilityElement(children: .combine)
            .driveID("screen=\(slot)")
            .rise()
            Spacer()
        }
    }
}
