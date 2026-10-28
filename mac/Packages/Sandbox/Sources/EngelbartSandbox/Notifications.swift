import Foundation
import EngelbartCore

// src/renderer/model/sandbox-notifications.js: the build notifications (the bell, then the sidebar's Inbox): one per
// repository, Building… → Build finished / Build failed, kept per data root.

public struct BuildNotificationRow: Equatable, Sendable {
    public var id: String
    public var runId: String
    public var libraryId: String
    /// starting | ready | failed; nil for alerts saved before phases (all previews).
    public var status: String?
    public var at: String
    public var read: Bool

    public var json: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "runId": .string(runId), "libraryId": .string(libraryId), "at": .string(at), "read": .bool(read)]
        if let status { o["status"] = .string(status) }
        return .object(o)
    }
}

/// A repository's newest run as the bell holds it: the run, its last message, and its sandbox as main last saw it.
public struct SandboxItem: Equatable, Sendable {
    public var run: SandboxRun
    public var message: String
    /// `asleep` | `running` | nil (not looked at yet).
    public var sandbox: String?
}

public struct SandboxProgressState: Equatable, Sendable {
    public var dataRoot: String
    public var items: [String: SandboxItem] = [:]
    public var notifications: [BuildNotificationRow] = []
    public var dismissed: [String: String] = [:]

    public init(dataRoot: String, saved: SavedNotifications? = nil) {
        self.dataRoot = dataRoot
        notifications = saved?.notifications ?? []
        dismissed = saved?.dismissed ?? [:]
    }
}

public struct SavedNotifications: Equatable, Sendable {
    public var notifications: [BuildNotificationRow]
    public var dismissed: [String: String]
    public init(notifications: [BuildNotificationRow] = [], dismissed: [String: String] = [:]) { self.notifications = notifications; self.dismissed = dismissed }
}

/// localStorage, for the saved notifications (UserDefaults in the app).
public protocol NotificationStorage: AnyObject {
    func getItem(_ key: String) -> String?
    func setItem(_ key: String, _ value: String) throws
}

public final class UserDefaultsNotificationStorage: NotificationStorage, @unchecked Sendable {
    let defaults: UserDefaults
    public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func getItem(_ key: String) -> String? { defaults.string(forKey: key) }
    public func setItem(_ key: String, _ value: String) throws { defaults.set(value, forKey: key) }
}

public enum SandboxNotifications {
    public static let limit = 40
    /// Posted (EventHub) when a window saved its notifications: the others take its reads and dismissals (the shared
    /// localStorage's `storage` event).
    public static let savedEvent = "sandbox-notifications:saved"
    /// A shell in a repository's sandbox to show in the workspace's terminal pane: `{ session, show }`.
    public static let openSandboxTerminal = "engelbart:open-sandbox-terminal"

    public static func storageKey(_ root: String) -> String { "engelbart:preview-notifications:\(root)" }

    static func status(_ row: BuildNotificationRow) -> String { row.status ?? "ready" }
    static func dismissalKey(_ row: BuildNotificationRow) -> String { status(row) == "ready" ? row.libraryId : "\(row.libraryId):\(status(row))" }
    static func ms(_ text: String?) -> Double? { text.flatMap(Time.parse).map { Time.ms($0) } }

    /// Saved alerts can outlive a run or load before its snapshot: only the current run, in its current phase.
    public static func available(_ notifications: [BuildNotificationRow], _ items: [String: SandboxItem]) -> [BuildNotificationRow] {
        notifications.filter { row in
            guard let run = items[row.libraryId]?.run, run["id"]?.string == row.runId, let s = run["status"]?.string else { return false }
            return ["starting", "ready", "failed"].contains(s) && s == status(row)
        }
    }

    public static func read(_ storage: NotificationStorage?, _ root: String) -> SavedNotifications {
        guard let text = storage?.getItem(storageKey(root)), let saved = try? JSONValue.parse(text) else { return SavedNotifications() }
        // Older versions stored just the visible notifications.
        let rows = saved.array ?? saved["notifications"]?.array ?? []
        let notifications: [BuildNotificationRow] = rows.compactMap { row in
            guard let o = row.object else { return nil }
            for key in ["id", "runId", "libraryId", "at"] { guard let s = o[key]?.string, s.utf16.count < 256 else { return nil } }
            guard ms(o["at"]?.string) != nil, let read = o["read"]?.bool else { return nil }
            if let s = o["status"], !(s.string.map { ["starting", "ready", "failed"].contains($0) } ?? false) { return nil }
            return BuildNotificationRow(id: o["id"]!.string!, runId: o["runId"]!.string!, libraryId: o["libraryId"]!.string!, status: o["status"]?.string, at: o["at"]!.string!, read: read)
        }
        var dismissed: [String: String] = [:]
        for (libraryId, at) in saved["dismissed"]?.object ?? [:] {
            if libraryId.utf16.count < 256, let s = at.string, s.utf16.count < 256, ms(s) != nil { dismissed[libraryId] = s }
        }
        return SavedNotifications(notifications: Array(notifications.prefix(limit)), dismissed: dismissed)
    }

    public static func write(_ storage: NotificationStorage?, _ root: String, _ state: SavedNotifications) {
        let value: JSONValue = ["notifications": .array(state.notifications.prefix(limit).map(\.json)), "dismissed": .object(state.dismissed.mapValues { .string($0) })]
        try? storage?.setItem(storageKey(root), value.text()) // notifications still work without storage
    }

    /// How a person uses a ready run's repository: `interface`, `terminal` or `both`. Runs from before 2026-10-03 have none,
    /// and were all previews.
    public static func runKind(_ run: SandboxRun?) -> String {
        let k = run?["kind"]?.string ?? ""
        return sandboxKinds.contains(k) ? k : "interface"
    }
    public static func canOpenPreview(_ run: SandboxRun?) -> Bool {
        run?["status"]?.string == "ready" && runKind(run) != "terminal" && !(run?["preview_url"]?.string ?? "").isEmpty
    }
    public static func canOpenTerminal(_ run: SandboxRun?) -> Bool {
        run?["status"]?.string == "ready" && runKind(run) != "interface" && (run?["terminal"].map { $0.truthy } ?? false)
    }

    /// Why a build failed, in a few words for the bell (≤ 60 characters); the whole error stays in its build details.
    public static func failureReason(_ run: SandboxRun?) -> String {
        guard run?["status"]?.string == "failed" else { return "" }
        let error = run?["error"]?.string ?? ""
        if error.matches("^Setup stopped|Setup was interrupted", options: .caseInsensitive) { return "Setup stopped" }
        if error.matches("Claude Code is not installed|Update Claude Code", options: .caseInsensitive) { return "Claude Code not installed" }
        if error.matches("not signed in to a Claude subscription", options: .caseInsensitive) { return "Claude Code not signed in" }
        if error.matches("^Desktop apps are not supported yet", options: .caseInsensitive) { return "Desktop apps not supported yet" }
        if error.matches("web preview|preview is not reachable|public preview", options: .caseInsensitive) { return "No web preview found" }
        return "Setup failed"
    }

    /// A saved repository clicked in the sidebar (2026-09-29): its live preview when there is one (asleep too: opening it
    /// wakes it), its terminal when it is used from one, both for both; else its build details. One ended only because
    /// nobody opened it for 7 days is built again (`start`). Without a run it opens as it always has (nil).
    public static func repositoryClick(_ item: SandboxItem?) -> String? {
        guard let run = item?.run else { return nil }
        if SandboxSleep.expiredRun(run) { return "start" }
        let preview = canOpenPreview(run), terminal = canOpenTerminal(run)
        return preview && terminal ? "both" : preview ? "preview" : terminal ? "terminal" : "details"
    }

    static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
        return url.port.flatMap { $0 == defaultPort ? nil : $0 }.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    /// The repository whose ready preview an address is on (same origin: each sandbox has its own host), or nil.
    public static func previewLibraryId(_ items: [String: SandboxItem], _ url: String) -> String? {
        guard let u = URL(string: url), let target = origin(u) else { return nil }
        for (_, item) in items.sorted(by: { $0.key < $1.key }) {
            guard item.run["status"]?.string == "ready", let p = item.run["preview_url"]?.string, let pu = URL(string: p) else { continue }
            if origin(pu) == target { return item.run["library_id"]?.string }
        }
        return nil
    }

    /// A ready run's sandbox for the bell: `Asleep` (opening it wakes it, which can take a few seconds) or `Running`.
    public static func sandboxStatus(_ run: SandboxRun?, _ sandbox: String?) -> String {
        guard run?["status"]?.string == "ready" else { return "" }
        return sandbox == "asleep" ? "Asleep" : sandbox == "running" ? "Running" : ""
    }

    public enum Action {
        case reset(dataRoot: String, saved: SavedNotifications?)
        case clear([String])
        case sync(SavedNotifications)
        case read([String])
        /// A progress event from main (`{ dataRoot, run, message, sandbox?, notification?, reveal? }`).
        case progress(JSONValue)
    }

    /// Progress can arrive before the snapshot: an older snapshot never restores a stopped preview, replaces a newer build,
    /// or makes another alert.
    public static func reduce(_ state: SandboxProgressState, _ action: Action) -> SandboxProgressState {
        switch action {
        case .reset(let root, let saved): return SandboxProgressState(dataRoot: root, saved: saved)
        case .clear(let ids):
            let set = Set(ids)
            let cleared = state.notifications.filter { set.contains($0.id) }
            if cleared.isEmpty { return state }
            // Dismissal is per phase, so clearing Building cannot hide completion. Ready keeps the repository key.
            var next = state
            for row in cleared {
                let key = dismissalKey(row)
                if !((ms(next.dismissed[key]) ?? -.infinity) >= (ms(row.at) ?? .infinity)) { next.dismissed[key] = row.at }
            }
            next.notifications = state.notifications.filter { !set.contains($0.id) }
            return next
        case .sync(let saved):
            // Another window saved: what it cleared is cleared here and what it read is read here. Nothing is added.
            var next = state
            var changed = false
            for (key, at) in saved.dismissed where !((ms(next.dismissed[key]) ?? -.infinity) >= (ms(at) ?? .infinity)) {
                next.dismissed[key] = at; changed = true
            }
            let read = Set(saved.notifications.filter(\.read).map(\.id))
            var rows: [BuildNotificationRow] = []
            for row in state.notifications {
                if (ms(next.dismissed[dismissalKey(row)]) ?? -.infinity) >= (ms(row.at) ?? .infinity) { changed = true; continue }
                if !row.read && read.contains(row.id) { var r = row; r.read = true; rows.append(r); changed = true } else { rows.append(row) }
            }
            next.notifications = rows
            return changed ? next : state
        case .read(let ids):
            let set = Set(ids)
            if !state.notifications.contains(where: { !$0.read && set.contains($0.id) }) { return state }
            var next = state
            next.notifications = state.notifications.map { set.contains($0.id) ? BuildNotificationRow(id: $0.id, runId: $0.runId, libraryId: $0.libraryId, status: $0.status, at: $0.at, read: true) : $0 }
            return next
        case .progress(let event):
            guard event["dataRoot"]?.string == state.dataRoot, let run = event["run"], let runId = run["id"]?.string, !runId.isEmpty,
                  let libraryId = run["library_id"]?.string, !libraryId.isEmpty else { return state }
            let message = event["message"]?.string ?? ""
            let previous = state.items[libraryId]
            if let previous, (previous.run["created_at"]?.string ?? "") > (run["created_at"]?.string ?? "")
                || (previous.run["id"]?.string == runId && (previous.run["updated_at"]?.string ?? "") > (run["updated_at"]?.string ?? "")) { return state }
            var next = state
            let status = run["status"]?.string ?? ""
            if ["starting", "ready", "failed"].contains(status) {
                let existing = state.notifications.first { $0.runId == runId }
                let samePhase = existing.map { Self.status($0) == status } ?? false
                let changedPhase = previous?.run["id"]?.string == runId && previous?.run["status"]?.string != status
                let log = run["build_log"]?.array ?? []
                let boundary: String? = status == "ready" ? log.last(where: { $0["message"]?.string == "Preview ready" || $0["data"]?["phase"]?.string == "ready" })?["time"]?.string
                    : status == "starting" ? log.last(where: { $0["data"]?["lifecycle"]?.string == "restart" })?["time"]?.string
                    : run["finished_at"]?.string
                // Preserve read/dismissed state as progress arrives and old log lines age out.
                let at = boundary ?? (samePhase ? existing!.at : nil) ?? ((changedPhase || status == "failed") ? run["updated_at"]?.string : run["created_at"]?.string) ?? ""
                let row = BuildNotificationRow(id: "\(runId):\(status):\(at)", runId: runId, libraryId: libraryId, status: status, at: at, read: false)
                let reveal = event["reveal"]?.truthy ?? false
                let dismissedAt = ms(state.dismissed[dismissalKey(row)])
                if (reveal || !((dismissedAt ?? -.infinity) >= (ms(at) ?? .infinity))) && (!samePhase || (ms(at) ?? -.infinity) > (ms(existing!.at) ?? .infinity)) {
                    next.notifications = Array(([row] + state.notifications.filter { $0.libraryId != libraryId }).prefix(limit))
                }
            }
            // `sandbox`: main's last sight of its sandbox, asleep or running (2026-10-04); nil while main has not looked.
            let sandbox: String?
            if let s = event["sandbox"] { sandbox = s.string } else { sandbox = previous?.run["id"]?.string == runId ? previous?.sandbox : nil }
            next.items[libraryId] = SandboxItem(run: run, message: message, sandbox: sandbox)
            return next
        }
    }
}
