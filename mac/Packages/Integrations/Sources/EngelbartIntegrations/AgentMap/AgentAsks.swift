import Foundation
import EngelbartCore

// src/main/agent-map/asks.cjs (2026-10-12) and the reveal/place parts of agent-map/ipc.cjs: the run log's records
// (Bart's runlog.cjs, given here as JSON) grouped one entry per thing the person asked. An `@bart` line is the router's
// record and the run it handed the line to (`routedFrom`), or every turn of the Build it started (`handedTo:
// build:<id>`) with their run steps; a line asked of an agent directly, a follow-up, a Build from a line, the Build panel
// or a post-it is an entry of its own. No record is ever left out: one of an agent the Viewer does not know is an entry
// under its own name.

/// The run log the Viewer reads (Bart's runlog.cjs: list() the runs without their big fields, newest first; get(id) one
/// whole). The app adapts Bart's run log to it.
public protocol AgentRunLog: AnyObject {
    func list() -> [JSONValue]
    func get(_ id: String) -> JSONValue?
}

public struct AgentAsk: Equatable, Sendable {
    public var id: String
    public var at: Double
    public var text: String
    public var place: JSONValue?
    public var routedTo: String
    public var status: String
    public var via: String
    public var kind: String
    public var buildId: String?
    public var records: [String]

    public var json: JSONValue {
        ["id": .string(id), "at": .number(at), "text": .string(text), "place": place ?? .null, "routedTo": .string(routedTo), "status": .string(status),
         "via": .string(via), "kind": .string(kind), "buildId": buildId.map { .string($0) } ?? .null, "records": .array(records.map { .string($0) })]
    }
}

public enum AgentAsks {
    /// The token each internal agent is known by: 'bart' is @chat since the router took @bart.
    public static let tokenOf: [String: String] = ["router": "bart", "bart": "chat", "brainstorm": "brainstorm", "discover": "discover", "create": "create", "build": "build", "run step": "run step"]
    public static func routedName(_ agent: String?) -> String {
        let a = agent ?? ""
        return a == "bart" ? "chat" : a == "run step" ? "build" : (a.isEmpty ? "unknown" : a)
    }
    static let buildish: Set<String> = ["build", "run step"]

    static func atOf(_ record: JSONValue?) -> Double { record?["at"]?.double.flatMap { $0.isFinite ? $0 : nil } ?? 0 }
    static func agent(_ r: JSONValue) -> String { r["agent"]?.stringish ?? "" }

    /// One entry's status: running while any of its records runs, else that of its last.
    static func statusOf(_ records: [JSONValue]) -> String {
        if records.contains(where: { $0["status"]?.string == "running" }) { return "running" }
        guard let last = records.sorted(by: { atOf($0) < atOf($1) }).last else { return "done" }
        let s = last["status"]?.string ?? ""
        return s.isEmpty ? "done" : s
    }

    /// How a line reached its agent when the router did not pick.
    static func viaOf(_ first: JSONValue, _ records: [JSONValue]) -> String {
        if agent(first) == "router" { return "router" }
        if !buildish.contains(agent(first)) { return "direct" }
        let build = records.first { agent($0) == "build" } ?? first
        if build["kind"]?.string == "quick" { return "post-it" }
        let place = records.compactMap { $0["place"] }.first { $0.truthy }
        guard let place, let line = place["line"], !line.isNull else { return "panel" }
        return re("(^|\\s)--build\\b").test(place["text"]?.stringish ?? "") ? "--build" : "button"
    }

    /// The entries, newest first.
    public static func group(_ list: [JSONValue]) -> [AgentAsk] {
        let records = list.filter { $0["id"]?.string != nil }
        var claimed = Set<String>()
        var buildOrder: [String] = []
        var builds: [String: [JSONValue]] = [:]
        for record in records where buildish.contains(agent(record)) {
            guard let buildId = record["buildId"]?.string, !buildId.isEmpty else { continue }
            if builds[buildId] == nil { buildOrder.append(buildId) }
            builds[buildId, default: []].append(record)
        }
        var routedTo: [String: [JSONValue]] = [:]
        for record in records where agent(record) != "router" {
            if let from = record["routedFrom"]?.string, !from.isEmpty { routedTo[from, default: []].append(record) }
        }
        var entries: [AgentAsk] = []
        func entry(_ group: [JSONValue], _ routed: String) {
            let sorted = group.sorted { atOf($0) < atOf($1) }
            for r in sorted { claimed.insert(r["id"]!.string!) }
            let first = sorted[0]
            let firstPlace = agent(first) == "router" ? first["place"].flatMap { $0.truthy ? $0 : JSONValue?.none } : nil
            let place = firstPlace ?? sorted.compactMap { $0["place"] }.first { $0.truthy }
            let build = sorted.first { agent($0) == "build" }
            let placeText = place?["text"]?.string
            let s = { (v: JSONValue?) -> String? in v?.string.flatMap { $0.isEmpty ? nil : $0 } }
            let text: String
            if let placeText, !placeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { text = placeText }
            else if agent(first) == "router" { text = first["question"]?.stringish ?? "" }
            else if buildish.contains(agent(first)) && (place == nil || place!["line"] == nil || place!["line"]!.isNull) {
                text = s(build?["title"]) ?? s(first["title"]) ?? s(first["question"]) ?? ""
            } else { text = s(first["question"]) ?? s(build?["title"]) ?? "" }
            let firstId = first["id"]!.string!
            let id = agent(first) == "router" ? firstId : (buildish.contains(agent(first)) && s(first["buildId"]) != nil ? "build:\(first["buildId"]!.string!)" : firstId)
            let buildId = sorted.compactMap { s($0["buildId"]) }.first
            entries.append(AgentAsk(id: id, at: atOf(first), text: text, place: place, routedTo: routed, status: statusOf(sorted), via: viaOf(first, sorted),
                                    kind: routed == "build" ? "build" : "question", buildId: buildId, records: sorted.map { $0["id"]!.string! }))
        }
        // The router's records first: each claims what it handed over.
        for router in records where agent(router) == "router" {
            if let handed = router["handedTo"]?.string, handed.hasPrefix("build:") {
                entry([router] + (builds[String(handed.dropFirst(6))] ?? []), "build")
                continue
            }
            let asks = (routedTo[router["id"]!.string!] ?? []).filter { !claimed.contains($0["id"]!.string!) }
            // Asked again (Regenerate, another agent picked) the line is the same ask: every run it handed over is in it.
            let last = asks.sorted { atOf($0) < atOf($1) }.last
            let pick = [router["corrected"]?.string, router["pick"]?.string].compactMap { $0 }.first { !$0.isEmpty } ?? "chat"
            entry([router] + asks, last.map { routedName(agent($0)) } ?? routedName(pick))
        }
        for buildId in buildOrder {
            let group = builds[buildId]!
            if group.contains(where: { claimed.contains($0["id"]!.string!) }) { continue }
            entry(group, "build")
        }
        for record in records where !claimed.contains(record["id"]!.string!) { entry([record], routedName(agent(record))) }
        return entries.sorted { $0.at > $1.at }
    }

    /// One entry with its records whole, each with `promptSource` ('built-in' or 'custom') when it can be told; nil once
    /// gone. `builtInPrompt(record)`: the built-in system prompt the record's agent would have had (Bart's and Build's
    /// prompts; the app provides it), nil when there is none to tell.
    public static func askOf(_ runLog: AgentRunLog?, _ id: String, builtInPrompt: (JSONValue) -> String? = { _ in nil }) -> JSONValue? {
        guard let runLog, let found = group(runLog.list()).first(where: { $0.id == id }) else { return nil }
        let records: [JSONValue] = found.records.compactMap { runLog.get($0) }.map { record in
            guard let source = promptSource(record, builtInPrompt: builtInPrompt) else { return record }
            return record.with("promptSource", .string(source))
        }
        return found.json.with("records", .array(records))
    }

    /// 'built-in', 'custom', or nil when there is none to tell (a run step's prompt is its own).
    public static func promptSource(_ record: JSONValue, builtInPrompt: (JSONValue) -> String?) -> String? {
        guard let system = record["system"], system.truthy, agent(record) != "run step" else { return nil }
        guard let builtIn = builtInPrompt(record) else { return nil }
        // A Brainstorm run of the Welcome walkthrough (2026-10-14) ran under that exchange's own built-in prompt.
        let welcome = agent(record) == "brainstorm" ? builtInPrompt(["agent": "welcome"]) : nil
        let mine = system.stringish.trimmingCharacters(in: .whitespacesAndNewlines)
        let same = { (text: String?) in text != nil && mine == text!.trimmingCharacters(in: .whitespacesAndNewlines) }
        return same(builtIn) || same(welcome) ? "built-in" : "custom"
    }

    static func shortStr(_ value: JSONValue?, _ max: Int) -> String? {
        guard let s = value?.string, s.count <= max else { return nil }
        return s
    }

    /// What a click asks to be shown: { place: { projectId, ref, line, text, quote }, routedTo, buildId }, or nil.
    public static func revealTarget(_ value: JSONValue?) -> JSONValue? {
        guard let value, value.object != nil else { return nil }
        let place: JSONValue? = value["place"]?.object != nil ? value["place"]! : nil
        guard let place, let projectId = shortStr(place["projectId"], 64) else { return nil }
        let held: JSONValue? = place["ref"]?.object != nil ? place["ref"]! : nil
        var ref: JSONValue = .null
        if let held {
            let kind = held["kind"]?.string
            if kind == "workspace", let w = shortStr(held["workspaceId"], 64) { ref = ["kind": "workspace", "workspaceId": .string(w)] }
            else if kind == "note", let id = shortStr(held["id"], 64) { ref = ["kind": "note", "id": .string(id)] }
            else if kind == "mark", let id = shortStr(held["id"], 64), shortStr(held["rowId"], 64) != nil || shortStr(held["url"], 8192) != nil {
                var o: [String: JSONValue] = ["kind": "mark", "id": .string(id)]
                if let row = held["rowId"], row.truthy { o["rowId"] = row } else { o["url"] = held["url"] }
                if let page = held["page"]?.double, page.rounded() == page { o["page"] = .number(page) }
                if held["source"]?.string == "web" { o["source"] = "web" }
                ref = .object(o)
            }
        }
        let line = place["line"]?.double.flatMap { $0.rounded() == $0 && $0 >= 0 ? JSONValue.number($0) : nil } ?? .null
        return ["place": ["projectId": .string(projectId), "ref": ref, "line": line, "text": shortStr(place["text"], 8000).map { .string($0) } ?? .null,
                          "quote": shortStr(place["quote"], 2000).map { .string($0) } ?? .null],
                "routedTo": shortStr(value["routedTo"], 40).map { .string($0) } ?? .null, "buildId": shortStr(value["buildId"], 64).map { .string($0) } ?? .null]
    }
}

/// The names of where an ask's line was typed (2026-10-13), for the Viewer to show in place of ids. The Store finds
/// them; the app provides this.
public protocol AgentPlaceNamer: AnyObject {
    /// → { project, workspace, note, paper }, each '' when it cannot be found.
    func placeNames(_ place: JSONValue) async -> (project: String, workspace: String, note: String, paper: String)
}
