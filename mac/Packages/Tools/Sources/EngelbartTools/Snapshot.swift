import EngelbartCore
import Foundation

/// What is happening to a tool right now (Manager.swift `busy`): check | install | update | sign-in | sign-out, with
/// Apple's installer's phase (Git) or the sign-in page's address.
public struct Busy: Equatable, Sendable {
    public var action: String
    public var phase: String?
    public var url: String?
    public init(action: String, phase: String? = nil, url: String? = nil) { self.action = action; self.phase = phase; self.url = url }

    public var json: JSONValue {
        var out: Fields = ["action": .string(action)]
        if action == "install" { out["phase"] = phase.map(JSONValue.string) ?? .null }
        if action == "sign-in" { out["url"] = url.map(JSONValue.string) ?? .null }
        return .object(out)
    }
}

/// One tool as the setup dialog draws it: its record, plus `id`, `name`, `minimum`, `busy` and `autoUpdate`.
public struct ToolSnapshot: Equatable, Sendable {
    public var record: ToolRecord
    public var busy: Busy?
    public var autoUpdate: Bool

    public init(record: ToolRecord, busy: Busy? = nil, autoUpdate: Bool = false) { self.record = record; self.busy = busy; self.autoUpdate = autoUpdate }

    public var id: String { record.name }
    public var name: String { Requirements[record.name].name }
    public var minimum: String { Requirements[record.name].minimum }
    public var installed: Bool { get { record.installed } set { record.installed = newValue } }
    public var status: String { get { record.status } set { record.status = newValue } }
    public var version: String? { get { record.version } set { record.version = newValue } }
    public var skip: Bool { get { record.skip } set { record.skip = newValue } }
    public var signedIn: Bool? { get { record.signedIn } set { record.signedIn = newValue } }
    public var account: String? { get { record.account } set { record.account = newValue } }
    public var source: String? { get { record.source } set { record.source = newValue } }
    public var error: String? { get { record.error } set { record.error = newValue } }
    public var note: String? { get { record.note } set { record.note = newValue } }
    public var untested: Bool { get { record.untested } set { record.untested = newValue } }
    public var path: String? { get { record.path } set { record.path = newValue } }
    public var checkedAt: String? { record.checkedAt }

    public var json: JSONValue {
        var out = record.fields
        out["id"] = .string(id)
        out["name"] = .string(name)
        out["minimum"] = .string(minimum)
        out["busy"] = busy?.json ?? .null
        out["autoUpdate"] = .bool(autoUpdate)
        return .object(out)
    }
}

/// What the manager sends on every change (`engelbart:tools`) and answers `tools`.
public struct ToolsSnapshot: Equatable, Sendable {
    public var checked: Bool
    public var platform: String
    public var updates: String
    public var tools: [String: ToolSnapshot]

    public init(checked: Bool, platform: String = "darwin", updates: String = "auto", tools: [String: ToolSnapshot]) {
        self.checked = checked; self.platform = platform; self.updates = updates; self.tools = tools
    }

    public subscript(id: String) -> ToolSnapshot? { tools[id] }

    public var json: JSONValue {
        var tools: Fields = [:]
        for (id, tool) in self.tools { tools[id] = tool.json }
        return ["checked": .bool(checked), "platform": .string(platform), "updates": .string(updates), "tools": .object(tools)]
    }
}
