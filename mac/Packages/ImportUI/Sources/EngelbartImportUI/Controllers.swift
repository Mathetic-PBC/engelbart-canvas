import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// What the app places (App.jsx): Import your context (its window or the modal over a workspace), the popups an Import
// your context run puts over the workspace (ImportPopupsView), the chip in the top-right controls and its popup
// (ConnectDock.jsx), Connect your library as a screen. Each is a SwiftUI view and an NSViewController around it, with a
// context struct the app fills (the ImportAPI, the callbacks).

// MARK: Import your context

public struct ImportFlowContext {
    public var api: ImportAPI
    /// .new: a new user's onboarding, the whole window; .modal: over a workspace, into `into`.
    public var mode: ImportFlowMode
    public var into: String?
    public var workspaceId: String?
    /// The project open there (its name and description), told to the agents.
    public var intoProject: (name: String, description: String)?
    /// "darwin" on the Mac (Allow Engelbart to organize your research is asked only there).
    public var platform: String = "darwin"
    public var defaults: UserDefaults = .standard
    /// A project was made (new user): main's startProject answer and the run's session ({ id }), or nil for one made
    /// from scratch. The app opens it (App.jsx onboarded).
    public var onDone: (JSONValue, JSONValue?) async -> Void = { _, _ in }
    /// The modal closed: the run's session when one started. A librarian session (not `direct`) opens its chat over the
    /// workspace (ConnectPopupView with its id); a direct run's status is not opened by itself.
    public var onClose: (JSONValue?) -> Void = { _ in }
    /// The librarian's chat in a new user's onboarding (default: ConnectLibraryHost as a page).
    public var librarian: ((String, (name: String, description: String), @escaping () -> Void, @escaping () -> Void) -> AnyView)?
    public init(api: ImportAPI, mode: ImportFlowMode, into: String? = nil, workspaceId: String? = nil, intoProject: (name: String, description: String)? = nil) {
        self.api = api; self.mode = mode; self.into = into; self.workspaceId = workspaceId; self.intoProject = intoProject
    }
}

/// Import your context with its model: `ImportFlowScreen(context:)` in SwiftUI, ImportFlowController in AppKit.
public struct ImportFlowScreen: View {
    @StateObject var model: ImportFlowModel
    let context: ImportFlowContext
    public init(context: ImportFlowContext) {
        self.context = context
        _model = StateObject(wrappedValue: ImportFlowModel(api: context.api, mode: context.mode, into: context.into, workspaceId: context.workspaceId,
                                                           intoProject: context.intoProject, platform: context.platform, defaults: context.defaults,
                                                           onDone: context.onDone, onClose: context.onClose))
    }
    public var body: some View {
        ImportFlowView(model: model, librarian: context.librarian)
            .task { await model.start() }
            .onDisappear { model.stop() }
    }
}

/// Import your context over a workspace (App.jsx 657-668): the veil rgba(23,23,23,.18), the panel 1000 × 800 at most,
/// radius 14, the mockup's shadow; the panel never scrolls (2026-10-17), its box does.
public struct ImportFlowModal: View {
    let context: ImportFlowContext
    public init(context: ImportFlowContext) { self.context = context }
    public var body: some View {
        GeometryReader { geometry in
            ZStack {
                IX.veil
                ImportFlowScreen(context: context)
                    .frame(width: min(1000, geometry.size.width - 48), height: min(800, geometry.size.height - 48))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .shadow(color: .black.opacity(0x26 / 255), radius: 30, y: 20)
            }
        }
        .driveID("import-modal")
    }
}

/// An NSViewController for any of this package's views (layer-backed, white where the view is).
open class ImportHostingController<Content: View>: NSViewController {
    public let hosting: NSHostingView<Content>
    public init(_ root: Content) { hosting = NSHostingView(rootView: root); super.init(nibName: nil, bundle: nil) }
    @available(*, unavailable) public required init?(coder: NSCoder) { fatalError() }
    open override func loadView() { view = hosting }
}

/// Import your context: a new user's window content (mode .new) or the modal over a workspace (mode .modal).
public final class ImportFlowController: ImportHostingController<AnyView> {
    public init(context: ImportFlowContext) {
        super.init(context.mode == .modal ? AnyView(ImportFlowModal(context: context)) : AnyView(ImportFlowScreen(context: context)))
    }
}

// MARK: the popups over the workspace

/// What the popups need from the app beyond the ImportAPI.
public struct ImportPopupsContext {
    /// The tool check's snapshot now (the provider popup reads it).
    public var tools: () -> JSONValue?
    /// "Open library" on the completion (App.jsx openLibrary): the session (it is dismissed here first).
    public var openLibrary: (JSONValue) -> Void = { _ in }
    /// The tools: Connect, Sign in again, a page in the browser (Tools' channels).
    public var toolsConnect: (String) async throws -> Void
    public var toolsSignIn: (String) async throws -> Void
    public var openExternal: (String) -> Void
    /// An error the app shows (App.jsx fail).
    public var fail: (String) -> Void = { _ in }
    /// The guided setup's offer wants to show (it sits between the status and the provider popup).
    public var guidedOffer: () -> Bool = { false }
    public init(tools: @escaping () -> JSONValue?, toolsConnect: @escaping (String) async throws -> Void, toolsSignIn: @escaping (String) async throws -> Void, openExternal: @escaping (String) -> Void) {
        self.tools = tools; self.toolsConnect = toolsConnect; self.toolsSignIn = toolsSignIn; self.openExternal = openExternal
    }
}

/// NeedPopup, ImportStatus, ProviderPopup and ConnectPopup over the workspace, one at a time (ImportOverlays decides).
public struct ImportPopupsView: View {
    @ObservedObject var overlays: ImportOverlays
    @ObservedObject var sessions: ConnectSessions
    let context: ImportPopupsContext
    @State private var provider: ProviderPopupState?
    public init(overlays: ImportOverlays, context: ImportPopupsContext) { self.overlays = overlays; self.sessions = overlays.sessions; self.context = context }

    public var body: some View {
        let shown = overlays.shown(guidedOffer: context.guidedOffer())
        ZStack {
            if shown.status, let session = overlays.statusSession {
                ImportStatusView(session: session, onClose: { overlays.statusId = nil }, onNeed: { overlays.needAgain(session, $0) },
                                 onStop: { Task { do { _ = try await overlays.api.connectStop(J.str(session["id"])) } catch { context.fail(tidyError(error)) } } },
                                 onDone: { overlays.statusId = nil; Task { try? await overlays.api.connectDismiss(J.str(session["id"])) }; context.openLibrary(session) })
            }
            if shown.need, let pending = overlays.pendingNeed {
                NeedPopupView(need: pending.need,
                              onOpen: { Task { do { try await overlays.needOpen(pending.session, pending.need) } catch { context.fail(tidyError(error)) } } },
                              onDone: { Task { do { try await overlays.needDone(pending.session, pending.need) } catch { context.fail(tidyError(error)) } } },
                              onSkip: { Task { do { try await overlays.needSkip(pending.session, pending.need) } catch { context.fail(tidyError(error)) } } },
                              onLater: { overlays.later(pending.session, pending.need) })
                    .id(J.str(pending.need["id"]))
            }
            if shown.provider, let blocked = overlays.blockedSession {
                ProviderPopupHost(session: blocked, overlays: overlays, context: context).id("\(J.str(blocked["id"])):\(J.str(blocked["blocked"]?["at"]))")
            }
            if let id = overlays.connectPopup {
                ConnectPopupView(api: overlays.api, request: ConnectPopupRequest(sessionId: id.isEmpty ? nil : id), onClose: { overlays.connectPopup = nil })
                    .id(id)
            }
        }
    }
}

struct ProviderPopupHost: View {
    @StateObject var state: ProviderPopupState
    let context: ImportPopupsContext
    let events: EventHub
    init(session: JSONValue, overlays: ImportOverlays, context: ImportPopupsContext) {
        self.context = context
        self.events = overlays.api.events
        let id = J.str(session["id"])
        _state = StateObject(wrappedValue: ProviderPopupState(session: session, tools: context.tools(), onConnect: context.toolsConnect, onSignIn: context.toolsSignIn,
                                                              onOpenPage: context.openExternal,
                                                              onContinue: { provider in _ = try await overlays.api.connectUnblock(id, provider: provider) },
                                                              onLater: { overlays.providerLater(id) }))
    }
    var body: some View {
        // The tool check's news: signed in (here, in Settings or in a terminal), the run goes on by itself.
        ProviderPopupView(model: state)
            .task {
                let events = self.events, state = self.state
                let token = events.on("engelbart:tools") { snapshot in Task { @MainActor in state.update(tools: snapshot) } }
                while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000_000) }
                events.off(token)
            }
    }
}

/// The popup controller for AppKit hosts: NeedPopup / ImportStatus / ProviderPopup / ConnectPopup over the workspace.
public final class ImportPopupsController: ImportHostingController<ImportPopupsView> {
    public init(overlays: ImportOverlays, context: ImportPopupsContext) { super.init(ImportPopupsView(overlays: overlays, context: context)) }
}

// MARK: the chip and its popup (ConnectDock.jsx)

/// The chip in the top-right controls: the newest session not shown in this window, what it is doing, a click to open
/// it (ImportOverlays.openSession); done, ink with ✓ and a × that dismisses it.
public struct ConnectChipView: View {
    @ObservedObject var sessions: ConnectSessions
    @ObservedObject var open: OpenSessions
    let onOpen: (String) -> Void
    public init(sessions: ConnectSessions, open: OpenSessions = .shared, onOpen: @escaping (String) -> Void) { self.sessions = sessions; self.open = open; self.onOpen = onOpen }
    public var body: some View {
        if let chip = ConnectDockModel.chip(sessions.list, isOpen: open.isOpen) {
            HStack(spacing: 0) {
                Button(action: { onOpen(chip.sessionId) }) {
                    Group {
                        if chip.wave { WaveText(chip.label, tone: chip.red ? .red : .grey, font: IX.font(12.5, 500)) }
                        else { Text(chip.label).font(IX.font(12.5, 500)).foregroundStyle(hex(chip.color)) }
                    }
                    .lineLimit(1).truncationMode(.tail).padding(.vertical, 2).padding(.horizontal, 4).frame(maxWidth: 160, maxHeight: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).hover(.dim).help(chip.tooltip).driveID("connect-dock-open=\(chip.sessionId)")
                if chip.tone == "done" {
                    Button(action: { let api = sessions.api; Task { try? await api.connectDismiss(chip.sessionId) } }) { Text("×").font(IX.font(14, 400)).foregroundStyle(IX.line2).frame(width: 18) }
                        .buttonStyle(.plain).hover(.ink).help("Dismiss").driveID("connect-dock-dismiss=\(chip.sessionId)")
                }
            }
            .frame(height: 28)
            .rise(0.2)
            .driveID("connect-dock=\(chip.tone)")
        }
    }
}

public final class ConnectChipController: ImportHostingController<ConnectChipView> {
    public init(sessions: ConnectSessions, open: OpenSessions = .shared, onOpen: @escaping (String) -> Void) { super.init(ConnectChipView(sessions: sessions, open: open, onOpen: onOpen)) }
}

/// The popup: a session again (`sessionId`, from the chip), or the one-time offer for the project open (`projectId`,
/// `workspaceId`: what comes in joins that workspace too).
public struct ConnectPopupRequest: Equatable {
    public var sessionId: String?
    public var projectId: String?
    public var workspaceId: String?
    public init(sessionId: String? = nil, projectId: String? = nil, workspaceId: String? = nil) { self.sessionId = sessionId; self.projectId = projectId; self.workspaceId = workspaceId }
}

/// ConnectDock.jsx ConnectPopup: Connect your library as a popup over the window; Escape closes it unless one of its own
/// modals takes Escape; the offer says "Shown once. Close it to dismiss." under it.
public struct ConnectPopupView: View {
    @StateObject var model: ConnectLibraryModel
    let request: ConnectPopupRequest
    let onClose: () -> Void
    public init(api: ImportAPI, request: ConnectPopupRequest, openSessions: OpenSessions? = nil, githubRepos: ((@escaping (JSONValue) -> Bool, @escaping (JSONValue) -> Void, String) -> AnyView)? = nil, onClose: @escaping () -> Void) {
        self.request = request; self.onClose = onClose
        var context = ConnectLibraryContext(mode: .popup, sessionId: request.sessionId, projectId: request.projectId, workspaceId: request.workspaceId)
        context.onSession = { _ in Task { try? await api.connectOfferSeen("started") } }
        context.onClose = onClose
        context.onSkip = onClose
        context.githubRepos = githubRepos
        _model = StateObject(wrappedValue: ConnectLibraryModel(api: api, context: context, openSessions: openSessions))
    }
    public var body: some View {
        ZStack {
            IX.veil
            VStack(spacing: 12) {
                ConnectLibraryView(model: model)
                if request.sessionId == nil { Text("Shown once. Close it to dismiss.").font(IX.font(12, 400)).foregroundStyle(IX.body).shadow(color: .white, radius: 6) }
            }
            .padding(24)
        }
        .background(KeyMonitor(keyCode: 53) {
            // The Keychain modal (and the folders' and the gate's) over it take Escape for themselves.
            if model.asking != nil || model.keychainOutcome != nil || model.folderShown != nil || model.gateView != nil { return false }
            onClose(); return true
        })
        .task { await model.start() }
        .onDisappear { model.stop() }
        .driveID("connect-popup=\(request.sessionId == nil ? "offer" : "session")")
    }
}

public final class ConnectPopupController: ImportHostingController<ConnectPopupView> {
    public init(api: ImportAPI, request: ConnectPopupRequest, onClose: @escaping () -> Void) { super.init(ConnectPopupView(api: api, request: request, onClose: onClose)) }
}

/// Connect your library as a screen (onboarding's page, or any host): ConnectLibraryHost.
public final class ConnectLibraryController: ImportHostingController<ConnectLibraryHost> {
    public init(api: ImportAPI, context: ConnectLibraryContext) { super.init(ConnectLibraryHost(api: api, context: context)) }
}

/// The agent popup over Welcome (Screens' slot): "Use Claude Code, Codex, or both?".
public final class AgentSetupController: ImportHostingController<AgentSetupPopup> {
    public let model: AgentSetupModel
    public init(model: AgentSetupModel) { self.model = model; super.init(AgentSetupPopup(model: model)) }
}
