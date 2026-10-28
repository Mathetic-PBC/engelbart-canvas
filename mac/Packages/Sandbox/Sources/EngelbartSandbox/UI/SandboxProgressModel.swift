import Foundation
import SwiftUI
import EngelbartCore

/// What the progress model asks of the app (the preload's sandbox calls, and where an address opens).
public struct SandboxAPI {
    public var runs: () async throws -> [JSONValue]
    public var ensure: () async throws -> [JSONValue]
    public var terminal: (_ libraryId: String) async throws -> JSONValue
    public var touch: (_ libraryId: String) async throws -> Void
    public var environment: (_ libraryId: String) async throws -> EnvironmentDescription
    public var saveEnvironment: (_ libraryId: String, _ changes: [EnvironmentChange], _ revision: String?) async throws -> EnvironmentDescription
    public var restart: (_ libraryId: String) async throws -> Void
    /// An address to open: in the workspace's Stage (`inWorkspace`), else in the default browser.
    public var openURL: (_ url: String, _ inWorkspace: Bool) -> Void

    public init(runs: @escaping () async throws -> [JSONValue], ensure: @escaping () async throws -> [JSONValue],
                terminal: @escaping (String) async throws -> JSONValue, touch: @escaping (String) async throws -> Void,
                environment: @escaping (String) async throws -> EnvironmentDescription,
                saveEnvironment: @escaping (String, [EnvironmentChange], String?) async throws -> EnvironmentDescription,
                restart: @escaping (String) async throws -> Void, openURL: @escaping (String, Bool) -> Void) {
        self.runs = runs; self.ensure = ensure; self.terminal = terminal; self.touch = touch; self.environment = environment
        self.saveEnvironment = saveEnvironment; self.restart = restart; self.openURL = openURL
    }

    /// Over the service, as the preload's channels are over ipc.cjs.
    public init(service: SandboxService, openURL: @escaping (String, Bool) -> Void) {
        self.init(runs: { try await service.runs() }, ensure: { try await service.ensure() }, terminal: { try await service.terminal($0) },
                  touch: { try await service.touch($0) }, environment: { try await service.environment($0) },
                  saveEnvironment: { try await service.saveEnvironment($0, $1, revision: $2) }, restart: { _ = try await service.restart($0) },
                  openURL: openURL)
    }
}

/// SandboxProgress.jsx: one listener for the whole window, mounted before the library can submit work. The snapshot
/// restores state after a reload; events carry later changes. A preview or a repository opens in the workspace's Stage;
/// on the other screens, in the default browser.
@MainActor
public final class SandboxProgressModel: ObservableObject {
    @Published public private(set) var state: SandboxProgressState
    @Published public var library: [JSONValue] = [] { didSet { if oldValue != library { prepare() } } }
    @Published public private(set) var error = ""
    @Published public private(set) var busy: [String: Bool] = [:]
    /// The repository whose build details are open (the Build package's BuildDetails shows them).
    @Published public private(set) var buildRepoId: String?
    public var inWorkspace: Bool

    let api: SandboxAPI
    let storage: NotificationStorage?
    let hub: EventHub
    private let windowId = UUID().uuidString
    private var tokens: [EventHub.Token] = []
    private var live = 0
    private var signedIn = false
    private var claudeSignedIn = false

    public init(dataRoot: String, api: SandboxAPI, inWorkspace: Bool = false, storage: NotificationStorage? = UserDefaultsNotificationStorage(), hub: EventHub = .shared) {
        self.api = api; self.storage = storage; self.hub = hub; self.inWorkspace = inWorkspace
        state = SandboxProgressState(dataRoot: dataRoot, saved: SandboxNotifications.read(storage, dataRoot))
        tokens.append(hub.on(SandboxService.progressEvent) { [weak self] event in
            MainActor.assumeIsolated { guard let self, event["dataRoot"]?.string == self.state.dataRoot else { return }; self.dispatch(.progress(event)) }
        })
        // Every window keeps its own bell from the same events; what another window clears or reads, this one does too.
        tokens.append(hub.on(SandboxNotifications.savedEvent) { [weak self] payload in
            MainActor.assumeIsolated {
                guard let self, payload["root"]?.string == self.state.dataRoot, payload["window"]?.string != self.windowId else { return }
                self.dispatch(.sync(SandboxNotifications.read(self.storage, self.state.dataRoot)))
            }
        })
        load()
    }

    deinit { for t in tokens { hub.off(t) } }

    public var dataRoot: String { state.dataRoot }

    /// The data root changed (a mode change): the inbox is the new root's.
    public func setDataRoot(_ root: String) {
        guard root != state.dataRoot else { return }
        dispatch(.reset(dataRoot: root, saved: SandboxNotifications.read(storage, root)))
        buildRepoId = nil; error = ""
        load()
    }

    private func load() {
        live += 1
        let generation = live
        let root = state.dataRoot
        Task { [weak self] in
            guard let self else { return }
            do {
                let rows = try await api.runs()
                guard live == generation else { return }
                for row in rows {
                    var event = row.object ?? [:]
                    event["dataRoot"] = .string(root)
                    dispatch(.progress(.object(event)))
                }
            } catch { if live == generation { self.error = message(of: error) } }
        }
        prepare()
    }

    /// Saved repositories are prepared once per app session (main skips the ones it already did). Signing in to GitHub
    /// brings the E2B key, and signing Claude Code in is what does the setup, so preparation that waited runs then.
    public func prepare() {
        let generation = live
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await api.ensure() } catch { if live == generation { self.error = message(of: error) } }
        }
    }

    public func setGithubSignedIn(_ value: Bool) { if value != signedIn { signedIn = value; prepare() } }
    public func setClaudeSignedIn(_ value: Bool) { if value != claudeSignedIn { claudeSignedIn = value; prepare() } }

    func dispatch(_ action: SandboxNotifications.Action) {
        let next = SandboxNotifications.reduce(state, action)
        guard next != state else { return }
        let savedChanged = next.notifications != state.notifications || next.dismissed != state.dismissed
        state = next
        if savedChanged {
            SandboxNotifications.write(storage, state.dataRoot, SavedNotifications(notifications: state.notifications, dismissed: state.dismissed))
            if case .sync = action {} else { hub.post(SandboxNotifications.savedEvent, ["root": .string(state.dataRoot), "window": .string(windowId)]) }
        }
    }

    public var items: [String: SandboxItem] { state.items }
    public var notifications: [BuildNotificationRow] { state.notifications }
    /// The rows still to show (useBuildNotifications), and how many are new.
    public var rows: [BuildNotificationRow] { SandboxNotifications.available(state.notifications, state.items) }
    public var unread: Int { rows.filter { !$0.read }.count }

    public func markRead(_ ids: [String]) { dispatch(.read(ids)) }
    public func clear(_ ids: [String]) { dispatch(.clear(ids)) }

    private func readRun(_ runId: String?) { markRead(state.notifications.filter { $0.runId == runId }.map(\.id)) }

    /// Opens a ready run's live preview.
    public func open(_ run: SandboxRun) {
        guard run["status"]?.string == "ready", let url = run["preview_url"]?.string, !url.isEmpty else { return }
        readRun(run["id"]?.string)
        api.openURL(url, inWorkspace)
    }

    public func openRepository(_ row: JSONValue) { if let url = row["url"]?.string { api.openURL(url, inWorkspace) } }

    func act(_ run: SandboxRun, _ action: @escaping () async throws -> Void) async {
        let id = run["id"]?.string ?? ""
        busy[id] = true; error = ""
        do { try await action() } catch { self.error = message(of: error) }
        busy[id] = false
    }

    /// A repository used from a terminal: its shell, as a tab of the workspace's terminal pane (posted as
    /// `engelbart:open-sandbox-terminal` `{ session, show }`; the workspace adopts it). Only a workspace has a terminal pane.
    public func openTerminal(_ run: SandboxRun, show: Bool = true) {
        guard SandboxNotifications.canOpenTerminal(run) else { return }
        guard inWorkspace else { error = "Open a project to use the sandbox terminal."; return }
        readRun(run["id"]?.string)
        Task { await act(run) { [self] in
            let session = try await api.terminal(run["library_id"]?.string ?? "")
            hub.post(SandboxNotifications.openSandboxTerminal, ["session": session, "show": .bool(show)])
        } }
    }

    public func openBuild(_ row: JSONValue) { buildRepoId = row["id"]?.string }
    public func closeBuild() { buildRepoId = nil }

    /// A row of the library by id (for a notification's repository).
    public func repo(_ libraryId: String) -> JSONValue? { library.first { $0["id"]?.string == libraryId } }
}

/// usePreviewTouch / useSandboxTouch: while the window has the keyboard and a ready preview (or a sandbox terminal's tab)
/// is in front, its sandbox's sleep is put back to 10 minutes away now and every minute after. Another tab in front, the
/// tab closed or the window left stops it. A ping never wakes a sandbox.
@MainActor
public final class SandboxTouch {
    let touch: (String) async throws -> Void
    let interval: TimeInterval
    private var libraryId: String?
    private var focused = false
    private var timer: Timer?

    public init(interval: TimeInterval = 60, touch: @escaping (String) async throws -> Void) { self.touch = touch; self.interval = interval }

    /// The repository in front (nil when none), and whether the window has the keyboard.
    public func update(libraryId: String?, focused: Bool) {
        guard libraryId != self.libraryId || focused != self.focused else { return }
        self.libraryId = libraryId; self.focused = focused
        timer?.invalidate(); timer = nil
        guard let libraryId, focused else { return }
        let ping = { [touch] in Task { try? await touch(libraryId) } }
        _ = ping()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in _ = ping() }
    }

    /// The Stage's page at `url`, while showing: the repository whose ready preview it is.
    public func updatePreview(url: String?, showing: Bool, items: [String: SandboxItem], focused: Bool) {
        update(libraryId: showing ? url.flatMap { SandboxNotifications.previewLibraryId(items, $0) } : nil, focused: focused)
    }

    public func stop() { timer?.invalidate(); timer = nil; libraryId = nil }
}

/// EnvironmentPanel.jsx's state: saved names, draft changes, the new row, notices and errors.
@MainActor
public final class EnvironmentPanelModel: ObservableObject {
    @Published public private(set) var saved: EnvironmentDescription?
    /// Draft values by name; nil marks a saved value to remove.
    @Published public var changes: [String: String?] = [:]
    @Published public var name = ""
    @Published public var value = ""
    @Published public private(set) var busy = false
    @Published public private(set) var error = ""
    @Published public private(set) var notice = ""
    @Published public var run: SandboxRun? { didSet { if oldValue?["id"] != run?["id"] || oldValue?["status"] != run?["status"] { load() } } }
    public let libraryId: String
    let api: SandboxAPI

    public init(libraryId: String, run: SandboxRun?, api: SandboxAPI) {
        self.libraryId = libraryId; self.run = run; self.api = api
        load()
    }

    func load() {
        Task { [weak self] in
            guard let self else { return }
            do { self.saved = try await api.environment(libraryId) } catch { self.error = message(of: error) }
        }
    }

    public var report: JSONValue? { EnvironmentReport.of(run) ?? saved?.report }
    public var rows: [EnvironmentRow] { EnvironmentRows.make(report: report, saved: saved?.names ?? [], drafts: Array(changes.keys).sorted()) }
    public var pending: Bool { saved.map { $0.revision != run?["env_revision"]?.string } ?? false }
    public var canRestart: Bool { !(run?["sandbox_id"]?.string ?? "").isEmpty && ["ready", "failed"].contains(run?["status"]?.string ?? "") }
    public var isTerminal: Bool { run?["kind"]?.string == "terminal" }
    public var restartTitle: String { busy ? "Saving…" : isTerminal ? "Save & restart terminal" : "Save & restart app" }

    public func isRemoving(_ name: String) -> Bool { if case .some(.none) = changes[name] { return true }; return false }
    public func isEdited(_ name: String) -> Bool { changes[name] != nil }

    /// The row's action label: Undo (a removal), Remove (a saved value), Reset (a draft).
    public func action(_ row: EnvironmentRow) -> String { isRemoving(row.name) ? "Undo" : row.saved ? "Remove" : "Reset" }

    public func toggle(_ row: EnvironmentRow) {
        if isRemoving(row.name) || !row.saved { changes[row.name] = nil } else { changes[row.name] = .some(nil) }
    }

    public func setValue(_ text: String, for name: String) { changes[name] = .some(text) }

    public func note(_ row: EnvironmentRow) -> String {
        if isRemoving(row.name) { return "Will be removed" }
        if isEdited(row.name) { return "Unsaved change" }
        return EnvironmentRows.describe(row, pending: pending, removed: saved?.removed.contains(row.name) ?? false)
    }

    public func needsValue(_ row: EnvironmentRow) -> Bool { row.variable?.status == "missing" && !row.saved && !isEdited(row.name) }

    public func placeholder(_ row: EnvironmentRow) -> String {
        isRemoving(row.name) ? "Will be removed" : row.saved ? "Saved · leave unchanged" : row.variable?.status == "local" ? "Provided by sandbox" : "Value"
    }

    public func add() {
        let key = name.trimmed
        guard EnvironmentNames.isValid(key) else {
            error = "Use letters, digits and underscores; do not start with a digit. Runner configuration names are reserved."
            return
        }
        changes[key] = .some(value)
        name = ""; value = ""; error = ""; notice = ""
    }

    public func save(restart: Bool) async {
        busy = true; error = ""; notice = ""
        defer { busy = false }
        do {
            if !name.trimmed.isEmpty || !value.isEmpty { throw SandboxError("Click Add to include the new variable before saving.") }
            let list = changes.keys.sorted().map { EnvironmentChange(name: $0, value: changes[$0]!) }
            let result = try await api.saveEnvironment(libraryId, list, saved?.revision)
            saved = result; changes = [:]
            notice = "Saved."
            if restart {
                try await api.restart(libraryId)
                notice = isTerminal ? "Saved. The next terminal opened has the new values." : "Restarting app…"
            } else { notice = "Saved. Restart the app to apply." }
        } catch { self.error = message(of: error) }
    }

    public func reload() async {
        busy = true
        defer { busy = false }
        do {
            saved = try await api.environment(libraryId)
            error = ""; notice = "Reloaded saved names. Review your draft changes before saving."
        } catch { self.error = message(of: error) }
    }
}
