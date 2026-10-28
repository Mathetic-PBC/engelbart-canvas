import Foundation
import EngelbartCore

// src/shared/environment.cjs: the scan metadata engelbart-web's Environment tab uses. Values stay in the encrypted store;
// a report holds names and statuses only. And src/main/sandbox/environment.cjs's redaction.

public enum EnvironmentNames {
    private static let reserved = ["HC_", "HUMAN_COMPACT_", "ENGELBART_CANVAS_", "ELECTRON_"]

    /// `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, not a runner configuration name, not a prototype key.
    public static func isValid(_ name: String?) -> Bool {
        guard let name, !name.isEmpty, name.count <= 128 else { return false }
        let scalars = Array(name.unicodeScalars)
        func letter(_ s: Unicode.Scalar) -> Bool { (s >= "A" && s <= "Z") || (s >= "a" && s <= "z") || s == "_" }
        func digit(_ s: Unicode.Scalar) -> Bool { s >= "0" && s <= "9" }
        guard letter(scalars[0]), scalars.dropFirst().allSatisfy({ letter($0) || digit($0) }) else { return false }
        if reserved.contains(where: { name.hasPrefix($0) }) { return false }
        return !["__proto__", "constructor", "prototype"].contains(name)
    }

    static func names(_ list: JSONValue?) -> [String] {
        var seen: [String] = []
        for item in list?.array ?? [] {
            if let s = item.string, isValid(s), !seen.contains(s) { seen.append(s) }
        }
        return Array(seen.prefix(500))
    }
}

/// One variable of a scan, as the report keeps it.
public struct EnvironmentVariable: Equatable, Sendable {
    public var name: String
    public var status: String
    public var requirement: String
    public var group: String
    public var source: String?
    public var isPublic: Bool

    public var json: JSONValue {
        ["name": .string(name), "status": .string(status), "requirement": .string(requirement), "group": .string(group),
         "source": source.map { .string($0) } ?? .null, "public": .bool(isPublic)]
    }

    public init(json: JSONValue) {
        name = json["name"]?.string ?? ""
        status = json["status"]?.string ?? "uncertain"
        requirement = json["requirement"]?.string ?? "unknown"
        group = json["group"]?.string ?? "unresolved"
        source = json["source"]?.string
        isPublic = json["public"]?.bool ?? false
    }
}

public enum EnvironmentReport {
    static let statuses: Set<String> = ["missing", "found", "provided", "local", "optional", "uncertain", "not_applicable"]
    static let requirements: Set<String> = ["required", "optional", "unknown"]
    static let groups: Set<String> = ["required", "optional", "other", "unresolved"]

    /// `environmentReport(event, runId, at)`: the report of an `environment` scan event, or nil.
    public static func make(_ event: JSONValue?, runId: String, at: String) -> JSONValue? {
        guard let event, event["phase"]?.string == "environment", let variables = event["variables"]?.array else { return nil }
        var order: [String] = []
        var byName: [String: JSONValue] = [:]
        for variable in variables.prefix(500) {
            guard let name = variable["name"]?.string, EnvironmentNames.isValid(name) else { continue }
            if byName[name]?["status"]?.string == "missing" { continue }
            let status = variable["status"]?.string.flatMap { statuses.contains($0) ? $0 : nil } ?? "uncertain"
            let requirement = variable["requirement"]?.string.flatMap { requirements.contains($0) ? $0 : nil } ?? "unknown"
            let group = variable["group"]?.string.flatMap { groups.contains($0) ? $0 : nil } ?? "unresolved"
            let source: JSONValue = variable["source"]?.string.map { .string($0.head(256)) } ?? .null
            if byName[name] == nil { order.append(name) }
            byName[name] = ["name": .string(name), "status": .string(status), "requirement": .string(requirement),
                            "group": .string(group), "source": source, "public": .bool(variable["public"]?.truthy ?? false)]
        }
        return [
            "variables": .array(order.compactMap { byName[$0] }),
            "missing": .array(EnvironmentNames.names(event["skipped"]).map { .string($0) }),
            "local": .array(EnvironmentNames.names(event["local"]).map { .string($0) }),
            "scannedAt": .string(at), "runId": .string(runId),
        ]
    }

    /// `environmentReportOf(run)`: its stored report, else (runs from before reports were stored) the last scan in its log.
    public static func of(_ run: JSONValue?) -> JSONValue? {
        guard let run, !run.isNull else { return nil }
        if let report = run["env_report"], !report.isNull { return report }
        for entry in (run["build_log"]?.array ?? []).reversed() {
            if let report = make(entry["data"], runId: run["id"]?.string ?? "", at: entry["time"]?.string ?? "") { return report }
        }
        return nil
    }
}

/// A row of the Environment panel: a report variable, a saved name, or a draft.
public struct EnvironmentRow: Equatable, Sendable {
    public var name: String
    public var variable: EnvironmentVariable?
    public var saved: Bool
}

public enum EnvironmentRows {
    /// `environmentRows(report, savedNames, draftNames)`: missing secrets first.
    public static func make(report: JSONValue?, saved savedNames: [String] = [], drafts draftNames: [String] = []) -> [EnvironmentRow] {
        let saved = Set(savedNames)
        var order: [String] = []
        var rows: [String: EnvironmentRow] = [:]
        for v in report?["variables"]?.array ?? [] {
            let variable = EnvironmentVariable(json: v)
            if rows[variable.name] == nil { order.append(variable.name) }
            rows[variable.name] = EnvironmentRow(name: variable.name, variable: variable, saved: saved.contains(variable.name))
        }
        for name in savedNames + draftNames where rows[name] == nil {
            order.append(name)
            rows[name] = EnvironmentRow(name: name, variable: nil, saved: saved.contains(name))
        }
        func rank(_ row: EnvironmentRow) -> Int {
            if row.variable?.status == "missing" && !row.saved { return 0 }
            if row.variable?.group == "unresolved" && !row.saved { return 1 }
            if row.saved { return 2 }
            if row.variable?.status == "found" { return 3 }
            if row.variable?.group == "other" { return 5 }
            return 4
        }
        let list = order.compactMap { rows[$0] }
        // A stable sort, as Array.prototype.sort is: equal ranks keep the order above, then by name.
        return list.enumerated().sorted { a, b in
            let ra = rank(a.element), rb = rank(b.element)
            if ra != rb { return ra < rb }
            let c = a.element.name.localizedCompare(b.element.name)
            if c != .orderedSame { return c == .orderedAscending }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// `describeEnvironment(row, { pending, removed })`.
    public static func describe(_ row: EnvironmentRow, pending: Bool = false, removed: Bool = false) -> String {
        if removed { return "Saved override removed" }
        if row.saved { return pending ? "Saved · used on the next launch" : "Saved" }
        guard let variable = row.variable else { return "New variable" }
        switch variable.status {
        case "missing": return "Required · no value"
        case "provided": return "Provided to the last launch"
        case "local": return "Provided by the sandbox"
        case "found": return variable.source.map { "Found in \($0)" } ?? "Found in the repository"
        case "optional": return "Optional"
        case "not_applicable": return "Not used by this launch"
        default: return variable.requirement == "required" ? "Required · unresolved" : "Needs a value check"
        }
    }
}

/// Redaction (src/main/sandbox/environment.cjs): saved values and keys never reach a log, an event or a reply.
public enum Redact {
    static let mark = "[redacted]"

    /// `redact(value, secrets)`: every secret in every string, longest first, nested too.
    public static func value(_ value: JSONValue, _ secrets: [String]) -> JSONValue {
        let list = ordered(secrets)
        if list.isEmpty { return value }
        return apply(value, list)
    }

    public static func string(_ text: String, _ secrets: [String]) -> String {
        var out = text
        for secret in ordered(secrets) { out = out.replacingOccurrences(of: secret, with: mark) }
        return out
    }

    private static func ordered(_ secrets: [String]) -> [String] {
        var unique: [String] = []
        for s in secrets where !s.isEmpty && !unique.contains(s) { unique.append(s) }
        // Array.prototype.sort is stable: equal lengths keep their order.
        return unique.enumerated().sorted { $0.element.count != $1.element.count ? $0.element.count > $1.element.count : $0.offset < $1.offset }.map(\.element)
    }

    private static func apply(_ value: JSONValue, _ secrets: [String]) -> JSONValue {
        switch value {
        case .string(let s):
            var out = s
            for secret in secrets { out = out.replacingOccurrences(of: secret, with: mark) }
            return .string(out)
        case .array(let a): return .array(a.map { apply($0, secrets) })
        case .object(let o): return .object(o.mapValues { apply($0, secrets) })
        default: return value
        }
    }

    /// `redactOutput(text, secrets)`: output callbacks can split a value between chunks, so a chunk ending in a secret's
    /// start, or starting with its end, loses that fragment too.
    public static func output(_ text: String, _ secrets: [String]) -> String {
        var text = string(text, secrets)
        for secret in secrets where !secret.isEmpty {
            let chars = Array(secret)
            var n = min(chars.count - 1, text.count)
            while n > 0 {
                if text.hasSuffix(String(chars[0..<n])) { text = String(text.dropLast(n)) + mark; break }
                n -= 1
            }
            n = min(chars.count - 1, text.count)
            while n > 0 {
                if text.hasPrefix(String(chars[(chars.count - n)...])) { text = mark + String(text.dropFirst(n)); break }
                n -= 1
            }
        }
        return text
    }

    /// `redactEvent(event, secrets)`: only output fields (`message`, `error`, `data`) carry logs; ids, URLs and protocol
    /// fields are never rewritten when a short value happens to match part of them.
    public static func event(_ event: JSONValue, _ secrets: [String]) -> JSONValue {
        guard var o = event.object else { return event }
        for key in ["message", "error", "data"] { if let v = o[key] { o[key] = value(v, secrets) } }
        return .object(o)
    }
}

// src/shared/sandbox-sleep.cjs: a ready E2B preview sleeps instead of ending, and stays asleep until a request wakes it.
// One nobody has opened for EXPIRE_MS is ended by the manager's sweep, which marks the end in its log so that clicking the
// repository builds it again (Notifications.repositoryClick), and so that a new session's preparation leaves it alone.
public enum SandboxSleep {
    public static let expireMs: Double = 7 * 24 * 60 * 60_000
    public static let expired = "expired"

    public static func expiredRun(_ run: JSONValue?) -> Bool {
        guard let run, run["status"]?.string == "stopped", let log = run["build_log"]?.array else { return false }
        return log.contains { $0["data"]?["lifecycle"]?.string == expired }
    }
}

// The run log's milestones: a copy of src/shared/build-history.cjs's `milestoneKey`/`isAgentActivity` (the Build package
// owns the rest of that file; the dependency rule keeps this package from importing it).
public enum BuildHistory {
    public static let agentLogLimit = 200
    static let phases: Set<String> = ["trail", "recipe", "discover", "order", "plan", "supabase", "environment", "approval", "run", "patch", "visit", "brief", "resolve", "setup", "agent", "check", "start", "conclusion", "error", "exited", "ready", "usable"]
    static let statuses: Set<String> = ["starting", "running", "working", "checking", "reading", "done", "ok", "ready", "answering", "succeeded", "failed", "error", "blocked", "unavailable", "skipped", "stopped", "timeout", "needs_input", "unhealthy", "setup_planning", "replaying", "reusing", "fallback", "none", "own", "shared", "saved", "fresh", "captured", "ignored", "applied", "replayed", "stale", "plan", "gave_up", "leftover", "summary_unavailable"]
    static let stages: Set<String> = ["install", "setup", "build", "start", "run", "discover", "order", "plan", "environment", "supabase"]
    static let messages: Set<String> = ["Starting repository setup", "Creating sandbox", "Sandbox created", "Cloning repository", "Repository cloned", "Preview ready", "Sandbox stopped", "Analyzing and setting up repository", "Starting repository services", "Verifying live preview"]

    public static func isAgentActivity(_ entry: JSONValue) -> Bool {
        entry["data"]?["phase"]?.string == "agent" || entry["data"]?["actor"]?.string == "setup-agent"
    }

    public static func milestoneKey(_ entry: JSONValue) -> String? {
        var data: JSONValue = entry["data"].flatMap { $0.isNull ? nil : $0 } ?? .object([:])
        let kind = entry["kind"]?.string
        let message = entry["message"]?.string ?? ""
        if entry["data"] == nil || entry["data"]?.isNull == true {
            let parts = message.components(separatedBy: " · ")
            let phase = parts[0]
            if phases.contains(phase) { data = ["phase": .string(phase), "status": parts.count > 1 ? .string(parts.last!) : .null] }
            else if phase == "stage" { data = ["phase": "stage", "stage": .string(parts.count > 1 && !parts[1].isEmpty ? parts[1] : "install")] }
        }
        let phase = data["phase"]?.string
        if phase == "app_status", data["app"]?["running"]?.bool != nil, data["app"]?["listeners"]?.array != nil { return "services:observed" }
        if ["stdout", "stderr", "metrics"].contains(kind ?? "") || ["log", "app_status", "audit", "cost"].contains(phase ?? "") { return nil }
        if let lifecycle = data["lifecycle"]?.string, lifecycle == "restart" || lifecycle == "cloned" { return "lifecycle:\(lifecycle)" }
        let rawStage = data["stage"]?.string ?? data["step"]?.string ?? ""
        let stage = stages.contains(rawStage) ? rawStage : ""
        if kind == "command" || phase == "stage" { return "command:\(stage)" }
        if kind == "error" && phase == nil { return "error:\(stage)" }
        if let phase, phases.contains(phase) {
            let raw = data["install_status"]?.string ?? data["status"]?.string ?? ""
            let status = statuses.contains(raw) ? raw : "other"
            return "\(phase):\(data["source"]?.string == "railpack" ? "railpack" : ""):\(stage):\(status)"
        }
        if messages.contains(message) { return "message:\(message)" }
        if phase == nil && message.hasPrefix("Installing dependencies") { return "message:install" }
        return nil
    }
}
