import EngelbartCore
import EngelbartUI
import Foundation
import SwiftUI

// A window's root (src/renderer/App.jsx). Screens: the app opens straight into the workspace you were last in, and the
// first run (no projects yet) is onboarding (2026-09-28); + Project runs its last two screens. The guided setup
// (2026-10-10) runs a new user's screens for someone who has projects: offered once over their workspace, and from
// Settings. "Engelbart" in the header (or Escape) shows all projects. A project whose project.json has no code directory
// yet is held behind a modal until one is chosen (2026-09-18). Several windows (2026-10-03): each opens where the window
// manager says (its place before a reload or a relaunch, the workspace it was opened from, or the projects screen) and
// tells it where it goes. What another window saves arrives as an announcement.

public enum Phase: String, Sendable { case boot, create, home, workspace }

/// The guided setup while it runs: started from all projects, or from a workspace (where its back button returns).
public enum Guided: Equatable, Sendable {
    case off
    case fromHome
    case fromProject(WindowPlace)
}

/// Onboarding's mode (model/onboarding.js): a new person's, the guided setup inside a project, or + Project.
public enum OnboardMode: String, Sendable { case new, guided, existing }

/// What the tool check needs from the Tools package (model/tools.js launchRows / installedSignedOut / busy), on its JSON
/// snapshot, so the root's launch logic can be ported here and tested.
public protocol ToolsGate {
    /// The tools the launch dialog asks about (empty: nothing needs the person).
    func launchRows(_ snapshot: JSONValue) -> [String]
    /// Agents installed since `before` that are signed out.
    func installedSignedOut(before: JSONValue?, after: JSONValue) -> [String]
    /// Whether any tool is installing or updating.
    func busy(_ snapshot: JSONValue) -> Bool
    /// All three tools in order (TOOL_ORDER).
    var order: [String] { get }
}

/// The tool setup dialog's request: launch (only the rows that need the person) or all (Set Up Tools…).
public struct ToolSetupRequest: Equatable, Sendable {
    public enum Mode: String, Sendable { case launch, all }
    public var mode: Mode
    public var ids: [String]
}

/// One popup at a time (2026-10-14, Hudson: "There were two popups, there should only be one … Simplify this."): a step
/// that needs the person first; the status waits behind it; the guided setup's offer, the provider popup and the tool
/// setup wait behind both, in that order. Any of them pauses the sidebar tour.
public struct PopupGate: Equatable, Sendable {
    public var need = false, status = false, offer = false, provider = false, setup = false, importModal = false, connect = false

    public static func compute(pendingNeed: Bool, statusSession: Bool, inWorkspace: Bool, importModal: Bool, connectPopup: Bool,
                               guidedOffer: Bool, blockedSession: Bool, setupRequested: Bool, toolsKnown: Bool) -> PopupGate {
        var g = PopupGate()
        g.need = pendingNeed
        g.status = statusSession && !importModal && inWorkspace && !g.need
        g.offer = guidedOffer && inWorkspace && !g.need && !g.status && !importModal && !connectPopup
        g.provider = blockedSession && !g.need && !g.status && !g.offer && !connectPopup
        g.setup = setupRequested && toolsKnown && !g.need && !g.status && !g.provider
        g.importModal = importModal
        g.connect = connectPopup
        return g
    }

    /// Whether any popup is up (the sidebar tour pauses).
    public var any: Bool { need || status || offer || setup || provider || importModal || connect }
}

@MainActor
public final class RootModel: ObservableObject {
    @Published public private(set) var config: ShellConfig?
    @Published public private(set) var busy = false
    @Published public var error = ""
    @Published public private(set) var projects: [ProjectSummary] = []
    @Published public private(set) var trashed: [ProjectSummary] = []
    @Published public private(set) var library: [JSONValue] = []
    @Published public private(set) var tree: ProjectTree?
    @Published public private(set) var entry: WorkspaceEntry?
    @Published public private(set) var phase: Phase = .boot
    /// A reset starts onboarding over from its first screen (the onboarding slot is rebuilt when this changes).
    @Published public private(set) var run = 0
    @Published public private(set) var guided: Guided = .off
    @Published public var guidedOfferShown = false
    /// Import your context over the workspace: the project and workspace its imports go to.
    @Published public var importModal: WindowPlace?
    /// The tool setup dialog while it is open.
    @Published public var setup: ToolSetupRequest?
    @Published public private(set) var tools: JSONValue?
    /// The settings window, while open: the page it opened on ("" the first).
    @Published public var settingsPage: String?

    public let backend: ShellBackend
    public var toolsGate: ToolsGate?
    /// The window: where it opens (its first start) and where it is now.
    public var windowTarget: () async -> WindowTarget? = { nil }
    public var reportPlace: (WindowPlace) -> Void = { _ in }
    public var onTitle: (String) -> Void = { _ in }
    /// Remembered UI state (localStorage's `engelbart.` keys), forgotten by a test reset.
    public var defaults: UserDefaults = .standard
    /// Asks before test data is deleted (index.cjs confirmReset); `fresh`: Start as a new user. The backend never asks.
    public var confirmReset: (_ fresh: Bool) async -> Bool = { _ in true }

    private var firstStart = true
    private var visited: WindowPlace?
    private var askedAtLaunch = false
    private var lastTools: JSONValue?
    /// What the launch check asks about, until the dialog can open: ids, or "after" (once installs end).
    public private(set) var launchAsk: LaunchAsk?
    public enum LaunchAsk: Equatable, Sendable { case ids([String]), after }
    private var tokens: [EventHub.Token] = []
    private var changedTimer: DispatchWorkItem?
    private var offerTimer: DispatchWorkItem?
    private var resumedImport = false
    /// Popups seen in this window (needs put away, completions shown), forgotten by a reset.
    public var laterNeeds = Set<String>(), completedShown = Set<String>(), laterProvider = Set<String>()
    /// How long a project-changed announcement waits (150 ms) and the guided offer (1200 ms); tests shorten them.
    public var projectChangedDelay: TimeInterval = 0.15
    public var offerDelay: TimeInterval = 1.2

    public init(backend: ShellBackend, hub: EventHub = .shared) {
        self.backend = backend
        self.hub = hub
        tokens.append(hub.on(ShellEvents.libraryChanged) { [weak self] _ in
            MainActor.assumeIsolated { self?.reloadLibrary() }
        })
        tokens.append(hub.on(ShellEvents.projectChanged) { [weak self] payload in
            MainActor.assumeIsolated { self?.projectChanged(payload["projectId"]?.string, trashed: payload["trashed"]?.bool == true) }
        })
        tokens.append(hub.on(ShellEvents.tools) { [weak self] payload in
            MainActor.assumeIsolated { self?.takeTools(payload) }
        })
    }
    private let hub: EventHub

    deinit { for t in tokens { hub.off(t) } }

    private func fail(_ e: Error) { error = e.localizedDescription }

    /// What a project in the trash holds is in the trash with it: no screen lists it until it is restored.
    public var shownLibrary: [JSONValue] {
        let gone = Set(trashed.map(\.id))
        return gone.isEmpty ? library : library.filter { !gone.contains($0["project_id"]?.string ?? "") }
    }

    public var returning: Bool { !projects.isEmpty || !trashed.isEmpty }

    /// The guided setup is a new user's onboarding; started inside a project, without Create.
    public var onboardMode: OnboardMode {
        if case .fromProject = guided { return .guided }
        return guided != .off || !returning ? .new : .existing
    }

    public var backTitle: String {
        if case .fromProject = guided { return "Back to your project" }
        return "All projects"
    }

    /// The window's title, which names it in the Window menu.
    public var title: String {
        if phase == .workspace, let name = tree?.project.name, !name.isEmpty { return "\(name) — Engelbart" }
        return "Engelbart"
    }

    // MARK: - starting

    /// The first load: the config, then start(). A config that cannot load shows its error on the projects screen.
    public func boot() async {
        do {
            config = try await backend.config()
            try await start()
        } catch {
            fail(error)
            if phase == .boot { setPhase(.home) }
        }
    }

    /// The trash is read first: reading it purges the projects in it a week, and their library rows with them.
    @discardableResult
    public func loadHome() async throws -> [ProjectSummary] {
        let gone = (try? await backend.trashedProjects()) ?? []
        async let list = backend.listProjects()
        async let rows = backend.library()
        let (l, r) = try await (list, rows)
        trashed = gone
        projects = l
        library = r
        return l
    }

    /// Startup (and after the data root changes): the last project you were in, or the create screen. A window's first
    /// start goes where it belongs, when the manager says (the projects screen, or a workspace).
    public func start() async throws {
        guided = .off
        let list = try await loadHome()
        let first = firstStart
        firstStart = false
        // Every project deleted: all projects, where Recently deleted can bring one back, not a new install's onboarding.
        if list.isEmpty { setPhase(trashed.isEmpty ? .create : .home); return }
        let target = first ? await windowTarget() : nil
        if target == .home { setPhase(.home); return }
        var last: WindowPlace?
        if case .place(let place) = target { last = place } else { last = await backend.lastOpen() }
        let known = last.flatMap { l in list.first { $0.id == l.projectId } }
        let id = known?.id ?? list[0].id
        try await openProject(id, prefer: last?.projectId == id ? OpenRequest(workspaceId: last?.workspaceId) : nil)
    }

    /// Opens a project straight into a workspace: the one asked for, else the opened note's own, else the first. Each of
    /// its workspaces reopens with the tabs, the document and the scroll position it was left with (views).
    public func openProject(_ id: String, prefer: OpenRequest? = nil) async throws {
        async let treeLoad = backend.loadProject(id)
        async let rowsLoad = backend.library()
        async let viewsLoad = backend.views(id)
        var next = try await treeLoad
        let rows = try await rowsLoad
        let views = (try? await viewsLoad) ?? .object([:])
        if next.workspaces.isEmpty {
            try await backend.createWorkspace(id, name: "Getting started")
            next = try await backend.loadProject(id)
        }
        tree = next
        library = rows
        // A note opened from the library lands in the workspace it was made in.
        let made = prefer?.tab != nil && prefer?.workspaceId == nil ? next.notes.first { $0.id == prefer?.tab?.id } : nil
        let workspaceId = prefer?.workspaceId ?? made?.workspaceId ?? next.workspaces[0].id
        entry = WorkspaceEntry(workspaceId: workspaceId, tab: prefer?.tab, stage: prefer?.stage, views: views)
        setPhase(.workspace)
        error = ""
    }

    private func setPhase(_ next: Phase) {
        phase = next
        if next == .home { reportPlace(WindowPlace()) }
        onTitle(title)
        scheduleOffer()
        settleLaunchAsk()
    }

    public func leaveProject() { tree = nil; entry = nil }

    public func goHome() async {
        leaveProject()
        setPhase(.home)
        do { try await loadHome() } catch { fail(error) }
    }

    /// The Workspace screen reports the workspace on screen: remembered as last open, and where this window is.
    public func onVisit(_ workspaceId: String) {
        guard let tree else { return }
        let place = WindowPlace(projectId: tree.project.id, workspaceId: workspaceId)
        visited = place
        reportPlace(place)
        Task { await backend.setLastOpen(place) }
    }

    /// The DirectoryGate's folder: the project's code directory, and its tree read again.
    public func chooseDirectory(_ directory: String) async {
        guard let tree else { return }
        error = ""
        do {
            try await backend.setProjectDirectory(tree.project.id, directory)
            await reload()
        } catch { fail(error) }
    }

    @discardableResult
    public func reload() async -> ProjectTree? {
        guard let tree else { return nil }
        do {
            async let next = backend.loadProject(tree.project.id)
            async let rows = backend.library()
            let (t, r) = try await (next, rows)
            self.tree = t
            library = r
            onTitle(title)
            return t
        } catch { fail(error); return nil }
    }

    private func reloadLibrary() {
        Task { if let rows = try? await backend.library() { library = rows } }
    }

    // MARK: - test mode

    public func toggleTest() async {
        guard let config, !busy else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            self.config = try await backend.setTestMode(!config.testMode)
            leaveProject()
            try await start()
        } catch { fail(error) }
    }

    /// `fresh`: Start as a new user… — no sample library, nothing remembered, onboarding from its first screen. Either
    /// reset forgets what this window remembers (2026-10-15: "resetting test data also resets states so i see popups
    /// again"): tours seen, popups put away, folds, and the steps and completions it already showed.
    public func resetTest(fresh: Bool) async {
        guard !busy else { return }
        busy = true; error = ""
        defer { busy = false }
        guard await confirmReset(fresh) else { return }
        do {
            let result = try await backend.resetTestData(fresh: fresh)
            guard result.reset else { return }
            Self.forgetRemembered(defaults)
            laterNeeds.removeAll(); completedShown.removeAll(); laterProvider.removeAll()
            config = result.config
            leaveProject()
            run += 1
            try await start()
        } catch { fail(error) }
    }

    /// Every remembered UI key (localStorage's and sessionStorage's `engelbart.` keys) forgotten.
    public static func forgetRemembered(_ defaults: UserDefaults) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("engelbart.") { defaults.removeObject(forKey: key) }
    }

    /// Another window switched the data root (test mode): this one starts over on it, as the window that switched it does.
    public func dataRootChanged(_ next: ShellConfig, fresh: Bool) async {
        config = next
        leaveProject()
        if fresh { run += 1 }
        do { try await start() } catch { fail(error) }
    }

    /// Another window saved something here: a project trashed while shown sends this one home; 150 ms later the projects
    /// screen reads its list again, or the workspace on that project its tree.
    public func projectChanged(_ projectId: String?, trashed gone: Bool) {
        if gone, phase == .workspace, tree?.project.id == projectId {
            leaveProject()
            setPhase(.home)
        }
        changedTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                if self.phase == .home { _ = try? await self.loadHome() }
                else if self.phase == .workspace, self.tree?.project.id == projectId { await self.reload() }
            }
        }
        changedTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + projectChangedDelay, execute: work)
    }

    // MARK: - projects

    /// Delete on a project card: into the trash for a week. The project open here is left first, so nothing of it writes
    /// while it moves.
    public func deleteProject(_ id: String) async {
        error = ""
        do {
            if tree?.project.id == id { leaveProject(); setPhase(.home) }
            try await backend.trashProject(id)
        } catch { fail(error) }
        do { try await loadHome() } catch { fail(error) }
    }

    public func restoreProject(_ id: String) async {
        error = ""
        do { try await backend.restoreProject(id) } catch { fail(error) }
        do { try await loadHome() } catch { fail(error) }
    }

    public func renameProject(_ id: String, _ name: String) async {
        do { try await backend.renameProject(id, name); try await loadHome() } catch { fail(error) }
    }

    /// + Project / the sidebar's New project: onboarding's last screens.
    public func newProject() { leaveProject(); guided = .off; setPhase(.create) }

    /// "Engelbart" in onboarding's top left: back to the workspace the guided setup was started in, else all projects.
    public func leaveOnboarding() async {
        let from = guided
        guided = .off
        if case .fromProject(let place) = from, let id = place.projectId {
            do { try await openProject(id, prefer: place.workspaceId.map { OpenRequest(workspaceId: $0) }) } catch { await goHome() }
        } else {
            await goHome()
        }
    }

    /// Onboarding made a project: land in it (its Welcome workspace's page, or the Welcome! note), with the Stage links its
    /// sign-in import named.
    public func onboarded(projectId: String, workspaceId: String?, note: TabRef?, gettingStarted: Bool, stageLinks: [String] = []) async {
        error = ""
        guided = .off
        _ = try? await loadHome()
        let stage: JSONValue? = stageLinks.isEmpty ? nil : ["links": .array(stageLinks.map { .string($0) })]
        do { try await openProject(projectId, prefer: OpenRequest(workspaceId: workspaceId, tab: gettingStarted ? nil : note, stage: stage)) } catch { fail(error) }
    }

    // MARK: - guided setup / Import your context

    /// The guided setup offered once to someone who has projects, over the workspace they are in, 1200 ms after it opens.
    private func scheduleOffer() {
        offerTimer?.cancel()
        guard phase == .workspace, let projectId = tree?.project.id else { return }
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, self.phase == .workspace, self.tree?.project.id == projectId else { return }
                if await self.backend.guidedOffer() {
                    self.guidedOfferShown = true
                    await self.backend.guidedOfferSeen("shown")
                }
            }
        }
        offerTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + offerDelay, execute: work)
        resumeImport(projectId)
    }

    /// Back from the relaunch Full Disk Access needs: Import your context had been opened over this project with its run
    /// pending, so it opens again on its step.
    private func resumeImport(_ projectId: String) {
        guard !resumedImport, importModal == nil else { return }
        resumedImport = true
        Task {
            if await backend.pendingImport() == projectId { importModal = WindowPlace(projectId: projectId, workspaceId: nil) }
        }
    }

    /// Start (the offer's, or Settings ▸ Import context's): in a workspace, Import your context opens over it, the imports
    /// going to its project. Anywhere else but onboarding itself, over the project Engelbart would open at launch (2026-10-16:
    /// "clicking import context should bypass the role and project selection screens"). No project at all: onboarding from
    /// its first screen; started again during it, it keeps where it was from.
    public func startGuided() async {
        let here = phase == .workspace ? tree?.project.id : nil
        guidedOfferShown = false
        if let here {
            let workspace = visited?.projectId == here ? visited?.workspaceId : entry?.workspaceId
            importModal = WindowPlace(projectId: here, workspaceId: workspace)
            return
        }
        if phase != .create {
            let list = (try? await loadHome()) ?? []
            if !list.isEmpty {
                let last = await backend.lastOpen()
                let known = last.flatMap { l in list.first { $0.id == l.projectId } }
                let id = known?.id ?? list[0].id
                let workspace = last?.projectId == id ? last?.workspaceId : nil
                do { try await openProject(id, prefer: workspace.map { OpenRequest(workspaceId: $0) }) } catch { fail(error); return }
                importModal = WindowPlace(projectId: id, workspaceId: workspace)
                return
            }
        }
        let from: Guided
        if phase == .create, case .fromProject = guided { from = guided } else { from = .fromHome }
        leaveProject()
        guided = from
        run += 1
        setPhase(.create)
    }

    public func dismissOffer() {
        guidedOfferShown = false
        Task { await backend.guidedOfferSeen("dismissed") }
    }

    public func acceptOffer() {
        Task { await backend.guidedOfferSeen("started"); await startGuided() }
    }

    // MARK: - tools

    /// A new install's onboarding asks on a screen of its own (2026-09-28), so the dialog waits until it is over.
    public var onboardingNew: Bool { phase == .boot || (phase == .create && (projects.isEmpty || guided != .off)) }

    /// The launch check's first answer opens the setup dialog once, and only when something needs the person; an agent
    /// installed while the app is open asks for its sign-in once the install is over, whatever was answered before.
    public func takeTools(_ snapshot: JSONValue) {
        guard snapshot["tools"] != nil else { return }
        tools = snapshot
        let before = lastTools
        lastTools = snapshot
        if let gate = toolsGate {
            if askedAtLaunch, !gate.installedSignedOut(before: before, after: snapshot).isEmpty, launchAsk == nil { launchAsk = .after }
            if !askedAtLaunch, snapshot["checked"]?.bool == true {
                askedAtLaunch = true
                let ids = gate.launchRows(snapshot)
                if !ids.isEmpty { launchAsk = .ids(ids) }
            }
        }
        settleLaunchAsk()
    }

    /// Engelbart ▸ Set Up Tools…: all three tools.
    public func openToolSetup() {
        setup = ToolSetupRequest(mode: .all, ids: toolsGate?.order ?? ["git", "claude", "codex"])
    }

    /// Onboarding's own tools screen answered: Install all leaves 'after' (once installs end, the dialog asks only what is
    /// left); Skip for now asks nothing more until the next launch.
    public func onboardingTools(install: Bool) {
        askedAtLaunch = true
        launchAsk = install ? .after : nil
        settleLaunchAsk()
    }

    /// Opens the dialog the launch check asked for, once onboarding's screens are over.
    public func settleLaunchAsk() {
        guard let ask = launchAsk, !onboardingNew, let tools, let gate = toolsGate else { return }
        switch ask {
        case .after:
            if gate.busy(tools) { return }
            let ids = gate.launchRows(tools)
            if !ids.isEmpty, setup == nil { setup = ToolSetupRequest(mode: .launch, ids: ids) }
        case .ids(let ids):
            if setup == nil { setup = ToolSetupRequest(mode: .launch, ids: ids) }
        }
        launchAsk = nil
    }

    /// A row clicked in the Agent Viewer for a project this window does not show: it opens at the ask's workspace.
    public func agentReveal(projectId: String?, workspaceId: String?) async {
        guard let projectId, projectId != tree?.project.id else { return }
        do { try await openProject(projectId, prefer: workspaceId.map { OpenRequest(workspaceId: $0) }) }
        catch { self.error = "This ask's project is not in this library (it may have been asked with test mode the other way)." }
    }
}
