import Foundation
import EngelbartCore

// The renderer's window.localStorage, for the conveniences this machine remembers (storage may refuse; nothing breaks
// without it). Same keys as Electron:
//   engelbart.sidebar.open       what is folded open: `section:<key>`, `folder:<project id>`, `folder:<folder id>` → bool
//   engelbart.sidebar.slots      top-level project id → the level-2 projects its section shows
//   engelbart.sidebarTour.seen   "1" once the tour ended
//   engelbart.agentMarks         Agents rows clicked / put away (Workspace.jsx; model keptAgents)
//   engelbart.openedAt           library id → when it was last opened (byOpened)
//   engelbart.recentPages        top-level project id → visits (the clock)
// The app passes a `UserDefaultsStorage` (its own suite); tests pass `MemoryStorage`.

public protocol KeyValueStorage: AnyObject {
    func string(_ key: String) -> String?
    func set(_ key: String, _ value: String?)
}

public final class MemoryStorage: KeyValueStorage {
    public private(set) var values: [String: String] = [:]
    public init(_ values: [String: String] = [:]) { self.values = values }
    public func string(_ key: String) -> String? { values[key] }
    public func set(_ key: String, _ value: String?) { values[key] = value }
}

public final class UserDefaultsStorage: KeyValueStorage {
    let defaults: UserDefaults
    public init(suite: String? = nil) { defaults = suite.flatMap { UserDefaults(suiteName: $0) } ?? .standard }
    public func string(_ key: String) -> String? { defaults.string(forKey: key) }
    public func set(_ key: String, _ value: String?) { if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) } }
}

public enum StorageKeys {
    public static let open = "engelbart.sidebar.open"
    public static let slots = "engelbart.sidebar.slots"
    public static let tourSeen = "engelbart.sidebarTour.seen"
    public static let agentMarks = "engelbart.agentMarks"
    public static let openedAt = "engelbart.openedAt"
    public static let recentPages = "engelbart.recentPages"
}

public extension KeyValueStorage {
    /// A JSON value kept under `key` (nil when missing or not JSON).
    func json(_ key: String) -> JSONValue? { string(key).flatMap { try? JSONValue.parse($0) } }
    func setJSON(_ key: String, _ value: JSONValue) { set(key, value.text()) }

    /// `engelbart.sidebar.open`.
    func opened() -> [String: Bool] { (json(StorageKeys.open)?.object ?? [:]).compactMapValues { $0.bool } }
    func setOpened(_ value: [String: Bool]) { setJSON(StorageKeys.open, .object(value.mapValues { .bool($0) })) }

    /// `engelbart.sidebar.slots`.
    func slots() -> [String: [String]] { (json(StorageKeys.slots)?.object ?? [:]).compactMapValues { $0.array?.compactMap(\.string) } }
    func setSlots(_ value: [String: [String]]) { setJSON(StorageKeys.slots, .object(value.mapValues { .array($0.map { .string($0) }) })) }

    func tourSeen() -> Bool { string(StorageKeys.tourSeen) == "1" }
    func markTourSeen() { set(StorageKeys.tourSeen, "1") }

    /// `engelbart.agentMarks` (an object; anything else reads as {}).
    func agentMarks() -> [String: AgentMark] {
        (json(StorageKeys.agentMarks)?.object ?? [:]).compactMapValues { value in
            guard value.object != nil else { return nil }
            return AgentMark(clicked: value["clicked"]?.string, dismissed: value["dismissed"]?.string)
        }
    }
    func setAgentMarks(_ marks: [String: AgentMark]) {
        setJSON(StorageKeys.agentMarks, .object(marks.mapValues { mark in
            var o: [String: JSONValue] = [:]
            if let c = mark.clicked { o["clicked"] = .string(c) }
            if let d = mark.dismissed { o["dismissed"] = .string(d) }
            return .object(o)
        }))
    }

    /// `engelbart.openedAt`.
    func openedAt() -> [String: String] { (json(StorageKeys.openedAt)?.object ?? [:]).compactMapValues(\.string) }
    func setOpenedAt(_ value: [String: String]) { setJSON(StorageKeys.openedAt, .object(value.mapValues { .string($0) })) }

    /// `engelbart.recentPages`: one top-level project's visits.
    func visits(_ projectId: String) -> [Visit] {
        (json(StorageKeys.recentPages)?[projectId]?.array ?? []).compactMap { v in
            guard let kind = v["kind"]?.string, let id = v["id"]?.string else { return nil }
            return Visit(kind: kind, id: id, at: v["at"]?.string ?? "")
        }
    }
    func setVisits(_ projectId: String, _ visits: [Visit]) {
        var all = json(StorageKeys.recentPages)?.object ?? [:]
        all[projectId] = .array(visits.map { .object(["kind": .string($0.kind), "id": .string($0.id), "at": .string($0.at)]) })
        setJSON(StorageKeys.recentPages, .object(all))
    }
}
