import Foundation
import EngelbartCore

/// shared/build-history.cjs: the durable evidence of a sandbox run's build kept beside its rolling log. The library
/// database backfills `sandbox_runs.build_milestones` with it for runs from before the column (db.cjs openLibraryDb).
enum BuildHistory {
    static let phases: Set<String> = ["trail", "recipe", "discover", "order", "plan", "supabase", "environment", "approval", "run", "patch", "visit", "brief", "resolve", "setup", "agent", "check", "start", "conclusion", "error", "exited", "ready", "usable"]
    static let statuses: Set<String> = ["starting", "running", "working", "checking", "reading", "done", "ok", "ready", "answering", "succeeded", "failed", "error", "blocked", "unavailable", "skipped", "stopped", "timeout", "needs_input", "unhealthy", "setup_planning", "replaying", "reusing", "fallback", "none", "own", "shared", "saved", "fresh", "captured", "ignored", "applied", "replayed", "stale", "plan", "gave_up", "leftover", "summary_unavailable"]
    static let stages: Set<String> = ["install", "setup", "build", "start", "run", "discover", "order", "plan", "environment", "supabase"]
    static let messages: Set<String> = ["Starting repository setup", "Creating sandbox", "Sandbox created", "Cloning repository", "Repository cloned", "Preview ready", "Sandbox stopped", "Analyzing and setting up repository", "Starting repository services", "Verifying live preview"]
    static let agentLogLimit = 200

    static func isAgentActivity(_ entry: JSONValue) -> Bool {
        entry["data"]?["phase"]?.string == "agent" || entry["data"]?["actor"]?.string == "setup-agent"
    }

    static func milestoneKey(_ entry: JSONValue) -> String? {
        var data: [String: JSONValue] = entry["data"]?.object ?? [:]
        let message = entry["message"]?.string ?? ""
        if entry["data"] == nil || entry["data"]?.isNull == true {
            let parts = message.components(separatedBy: " · ")
            let phase = parts.first ?? ""
            if phases.contains(phase) { data = ["phase": .string(phase), "status": parts.count > 1 ? .string(parts.last!) : .null] }
            else if phase == "stage" { data = ["phase": "stage", "stage": .string(parts.count > 1 && !parts[1].isEmpty ? parts[1] : "install")] }
        }
        let phase = data["phase"]?.string
        let kind = entry["kind"]?.string
        if phase == "app_status", data["app"]?["running"]?.bool != nil, data["app"]?["listeners"]?.array != nil { return "services:observed" }
        if ["stdout", "stderr", "metrics"].contains(kind ?? "") || ["log", "app_status", "audit", "cost"].contains(phase ?? "") { return nil }
        if let lifecycle = data["lifecycle"]?.string, lifecycle == "restart" || lifecycle == "cloned" { return "lifecycle:\(lifecycle)" }
        let stageValue = data["stage"]?.string ?? data["step"]?.string ?? ""
        let stage = stages.contains(stageValue) ? stageValue : ""
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

    static func collect(_ entries: [JSONValue]) -> JSONValue {
        var milestones: [String: JSONValue] = [:]
        for entry in entries {
            if entry["data"]?["lifecycle"]?.string == "restart" { milestones = [:] }
            if let key = milestoneKey(entry) {
                milestones[key] = ["first": milestones[key]?["first"] ?? entry, "last": entry]
            }
            if isAgentActivity(entry) {
                let held = milestones["agent:activity"]?["entries"]?.array ?? []
                milestones["agent:activity"] = ["entries": .array(Array((held + [entry]).suffix(agentLogLimit)))]
            }
        }
        return .object(milestones)
    }
}
