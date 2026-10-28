import Foundation
import Combine
import EngelbartCore

// Connect your library in the background (src/renderer/ui/ConnectDock.jsx, connect-open.js; 2026-10-07: "Once the
// questions are done they should be able to minimize/close and it goes in the background"). A session put away keeps
// running in main; the chip in the top-right controls says how it goes and opens it again. And the App.jsx coordination
// of the popups an Import your context run puts over the workspace (ImportOverlays): one at a time.

/// Which sessions a window shows right now (ConnectLibraryModel marks its own), so the chip shows only the ones running
/// out of sight. One per window in Electron; `shared` when the app keeps one for all.
@MainActor
public final class OpenSessions: ObservableObject {
    public static let shared = OpenSessions()
    @Published public private(set) var counts: [String: Int] = [:]
    public init() {}
    public func mark(_ id: String, _ on: Bool) {
        guard !id.isEmpty else { return }
        let n = (counts[id] ?? 0) + (on ? 1 : -1)
        if n > 0 { counts[id] = n } else { counts[id] = nil }
    }
    public func isOpen(_ id: String) -> Bool { counts[id] != nil }
}

/// The sessions main holds for this data root (useConnectSessions), kept current from its announcements.
@MainActor
public final class ConnectSessions: ObservableObject {
    @Published public private(set) var list: [JSONValue] = []
    let api: ImportAPI
    private var token: EventHub.Token?
    public init(api: ImportAPI) { self.api = api }

    /// Read the list (on start and when the data root changes) and follow engelbart:connect.
    public func start() async {
        if token == nil { token = api.events.on("engelbart:connect") { [weak self] snapshot in Task { @MainActor in self?.take(snapshot) } } }
        if let all = try? await api.connectList() { list = all }
    }
    public func stop() { if let token { api.events.off(token) }; token = nil; list = [] }

    /// A snapshot replaces its entry; a new one goes first; a dismissed one leaves.
    public func take(_ snapshot: JSONValue) {
        let id = J.str(snapshot["id"])
        guard !id.isEmpty else { return }
        let at = list.firstIndex { J.str($0["id"]) == id }
        if J.truthy(snapshot["dismissed"]) { if let at { list.remove(at: at) }; return }
        if let at { list[at] = snapshot } else { list.insert(snapshot, at: 0) }
    }
    public func session(_ id: String?) -> JSONValue? { id.flatMap { id in list.first { J.str($0["id"]) == id } } }
}

public struct ChipView: Equatable, Sendable {
    public var sessionId: String
    /// 'busy' | 'warn' | 'done'
    public var tone: String
    public var short: String
    public var text: String
    /// The words move (the left-to-right wave), red when a step needs the person.
    public var wave: Bool
    public var red: Bool
    /// "#8f8f8f" busy, "#c0392b" warn, "#171717" done.
    public var color: String
    public var tooltip: String { "\(text): open it" }
    /// What the chip reads: done adds " ✓" (and a × beside it).
    public var label: String { tone == "done" ? "\(short) ✓" : short }
}

public enum ConnectDockModel {
    /// An Import your context run whose imports have all ended (round 3, 2026-10-13): no chip; its completion is a popup.
    public static func importsEnded(_ entry: JSONValue) -> Bool {
        guard J.truthy(entry["direct"]) else { return false }
        let work = J.arr(entry["jobs"]).filter { ["import", "recall", "survey"].contains(J.str($0["kind"])) }
        return !work.isEmpty && work.allSatisfy { ["done", "failed", "stopped"].contains(J.str($0["status"])) } && J.arr(entry["needs"]).isEmpty
    }

    // 2026-10-14 (Hudson: "Remove the pill and blinking blue dot but keep the 'Importing i/n' text … it should 'wave
    // gradient'"): plain text, no border, fill or dot; working, the wave; needing the person, the red wave; done, ink.
    static let tones: [String: (color: String, wave: Bool, red: Bool)] = ["busy": ("#8f8f8f", true, false), "warn": ("#c0392b", true, true), "done": ("#171717", false, false)]

    /// The chip: the newest session not shown in this window, never one stopped (2026-10-16), one needing the person first.
    public static func chip(_ sessions: [JSONValue], isOpen: (String) -> Bool) -> ChipView? {
        let shown = sessions.filter { !isOpen(J.str($0["id"])) && !importsEnded($0) && !J.truthy($0["stopped"]) }
        guard let top = shown.first(where: { !J.arr($0["needs"]).isEmpty }) ?? shown.first, let line = ConnectModel.dockLine(top) else { return nil }
        // An import that needs the person: still "Importing i/n" (its count), red.
        var view = line
        if line.tone == "warn", let importing = ConnectModel.dockLine(top.with("needs", [])), importing.short.hasPrefix("Importing") {
            view = DockLine(tone: "warn", short: importing.short, text: "\(importing.text) · \(line.text)")
        }
        let tone = tones[view.tone] ?? tones["busy"]!
        return ChipView(sessionId: J.str(top["id"]), tone: view.tone, short: view.short, text: view.text, wave: tone.wave, red: tone.red, color: tone.color)
    }
}

/// What an Import your context run puts over the workspace (App.jsx 245-304, 562-566), one popup at a time: a step for
/// the person first, then the run's status, then (the app's) guided offer, then Connect Claude Code / Codex for a run
/// blocked on its provider. The app keeps one per window, feeds it `phase`, `importModal`, `connectPopup`, and asks it.
@MainActor
public final class ImportOverlays: ObservableObject {
    public let sessions: ConnectSessions
    let api: ImportAPI
    /// The window is on a project's workspace (the popups show only there).
    @Published public var inWorkspace = false { didSet { completions() } }
    /// Import your context is open over the workspace.
    @Published public var importModal = false { didSet { completions() } }
    /// The chat popup (ConnectPopup) open: its session id ("" for the one-time offer), nil when closed.
    @Published public var connectPopup: String? { didSet { completions() } }
    /// The status modal open for a session id.
    @Published public var statusId: String?
    /// A step asked for again from the status's "Needs you".
    @Published public var needShown: (sessionId: String, needId: String)?
    public private(set) var laterNeeds = Set<String>()
    public private(set) var completedShown = Set<String>()
    public private(set) var laterProvider = Set<String>()
    private var bag: AnyCancellable?

    public init(sessions: ConnectSessions, api: ImportAPI) {
        self.sessions = sessions; self.api = api
        bag = sessions.$list.sink { [weak self] _ in Task { @MainActor in self?.completions() } }
    }

    /// The step popup to show: none while the import modal is up or off the workspace; a manual run's steps only once its
    /// chat is put away (2026-10-15); the one asked for again, else the first not put away.
    public var pendingNeed: (session: JSONValue, need: JSONValue)? {
        if importModal || !inWorkspace { return nil }
        for session in sessions.list {
            let id = J.str(session["id"])
            if !J.truthy(session["direct"]) && (J.truthy(session["stopped"]) || connectPopup == id) { continue }
            for need in J.arr(session["needs"]) {
                let needId = J.str(need["id"])
                let asked = needShown?.sessionId == id && needShown?.needId == needId
                if asked || !laterNeeds.contains(needId) { return (session, need) }
            }
        }
        return nil
    }

    /// Later puts a step away for good (2026-10-14: "clicking later should dismiss the needs you, too"): skipped.
    public func later(_ session: JSONValue, _ need: JSONValue) {
        laterNeeds.insert(J.str(need["id"]))
        needShown = nil
        objectWillChange.send()
        let id = J.str(session["id"]), needId = J.str(need["id"])
        Task { _ = try? await api.connectNeed(id, needId, "skip") }
    }
    /// The status modal's "Needs you": that step's popup again, over the modal.
    public func needAgain(_ session: JSONValue, _ need: JSONValue) {
        laterNeeds.remove(J.str(need["id"]))
        needShown = (J.str(session["id"]), J.str(need["id"]))
    }
    /// Every step's primary action runs in main (connect-need open), Zotero's and GitHub's own sign-ins too.
    public func needOpen(_ session: JSONValue, _ need: JSONValue) async throws { _ = try await api.connectNeed(J.str(session["id"]), J.str(need["id"]), "open") }
    public func needDone(_ session: JSONValue, _ need: JSONValue) async throws { _ = try await api.connectNeed(J.str(session["id"]), J.str(need["id"]), "done") }
    public func needSkip(_ session: JSONValue, _ need: JSONValue) async throws { needShown = nil; _ = try await api.connectNeed(J.str(session["id"]), J.str(need["id"]), "skip") }

    /// Everything ended: the run's completion opens by itself, once (round 3: "instead of having the pill in the header
    /// once it is done a popup should just come"). A manual run too, once finished and its chat not shown.
    public func completions() {
        guard inWorkspace, !importModal else { return }
        for session in sessions.list {
            let id = J.str(session["id"])
            if (!J.truthy(session["direct"]) && (!J.truthy(session["finished"]) || connectPopup == id)) || completedShown.contains(id) { continue }
            if !ImportStatusModel.isEnded(session) || J.truthy(session["dismissed"]) { continue }
            completedShown.insert(id)
            statusId = id
        }
    }

    /// The chip clicked: a direct run, or a manual one finished, opens its status; else its chat.
    public func openSession(_ id: String) {
        let session = sessions.session(id)
        if let session, J.truthy(session["direct"]) || (J.truthy(session["manual"]) && J.truthy(session["finished"])) { statusId = id } else { connectPopup = id }
    }

    public var statusSession: JSONValue? { sessions.session(statusId) }
    /// A run waiting for its Claude Code or Codex (connect/session.cjs `blocked`), not put away until the next launch.
    public var blockedSession: JSONValue? {
        guard inWorkspace, !importModal else { return nil }
        return sessions.list.first { J.truthy($0["direct"]) && J.truthy($0["blocked"]) && !J.truthy($0["stopped"]) && !J.truthy($0["dismissed"]) && !laterProvider.contains(J.str($0["id"])) }
    }
    public func providerLater(_ id: String) { laterProvider.insert(id); objectWillChange.send() }

    /// One popup at a time (2026-10-14): which of this package's popups shows now. `guidedOffer` is the app's offer
    /// wanting to show (it sits between the status and the provider popup).
    public func shown(guidedOffer: Bool = false) -> (need: Bool, status: Bool, provider: Bool) {
        let need = pendingNeed != nil
        let status = statusSession != nil && !importModal && inWorkspace && !need
        let offer = guidedOffer && inWorkspace && !need && !status && !importModal && connectPopup == nil
        let provider = blockedSession != nil && !need && !status && !offer && connectPopup == nil
        return (need, status, provider)
    }

    /// Test mode's reset forgets the steps put away, the completions shown and the provider popups put away (2026-10-15).
    public func reset(defaults: UserDefaults = .standard) {
        laterNeeds.removeAll(); completedShown.removeAll(); laterProvider.removeAll()
        needShown = nil; statusId = nil
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("engelbart.") { defaults.removeObject(forKey: key) }
    }
}
