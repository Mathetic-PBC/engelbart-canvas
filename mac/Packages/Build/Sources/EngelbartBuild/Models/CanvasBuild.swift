import Foundation
import EngelbartCore

/// renderer/model/canvas-build.js and local-build.js: Canvas's persisted sandbox runs (sandbox_runs rows: id, status,
/// error, created_at, kind, sandbox_id, preview_url, build_log, build_milestones) adapted to the web timeline's events.
public enum CanvasBuild {
    static let phases: Set<String> = ["trail", "recipe", "discover", "order", "plan", "supabase", "environment", "approval", "run", "patch", "visit", "brief", "resolve", "cost", "setup", "check", "start", "conclusion", "error", "exited"]

    /// The live log plus the milestones kept apart from it, deduplicated, in order, from the last restart on. Older
    /// builds only have message strings; they stay readable.
    public static func buildEvents(_ run: JSONValue?) -> [RunEvent] {
        let saved = (run?["build_milestones"]?.object ?? [:]).values.flatMap { slot -> [JSONValue] in
            [slot["first"], slot["last"]].compactMap { $0 } + (slot["entries"]?.array ?? [])
        }.filter { !$0.isNull }
        func keyOf(_ e: JSONValue) -> String { e["id"].map { $0.text() } ?? JSONValue.array([e["time"] ?? .null, e["kind"] ?? .null, e["message"] ?? .null, e["data"] ?? .null]).text() }
        var log = run?["build_log"]?.array ?? []
        var seen = Set(log.map(keyOf))
        for e in saved { let k = keyOf(e); if !seen.contains(k) { log.append(e); seen.insert(k) } }
        log = log.enumerated().sorted { a, b in
            if let x = a.element["seq"]?.double, let y = b.element["seq"]?.double { return x == y ? a.offset < b.offset : x < y }
            let x = RunSteps.ms(a.element["time"]?.string), y = RunSteps.ms(b.element["time"]?.string)
            return x == y || x.isNaN || y.isNaN ? a.offset < b.offset : x < y
        }.map(\.element)
        let restart = log.lastIndex { $0["data"]?["lifecycle"]?.string == "restart" } ?? 0
        var localAgent = false
        let runError = run?["error"]?.string
        return log[max(0, restart)...].enumerated().map { index, entry in
            var text = entry["message"]?.string ?? ""
            var kind = entry["kind"]?.string ?? "status"
            var data = entry["data"]?.object ?? [:]
            if entry["data"] == nil || entry["data"]!.isNull {
                let parts = text.components(separatedBy: " · ")
                let phase = parts[0]
                if phases.contains(phase) { data = ["phase": .string(phase), "status": parts.count > 1 ? .string(parts.last!) : .null] }
                else if phase == "stage" { kind = "command"; data = ["stage": .string(parts.count > 1 ? parts[1] : "install")] }
                else if text == "Analyzing and setting up repository" { data = ["phase": "discover"] }
                else if text == "Starting repository services" { data = ["phase": "supabase", "status": "starting"] }
                else if text.hasPrefix("Installing dependencies") { data = ["phase": "setup", "status": "starting"] }
                else if text == "Verifying live preview" { data = ["phase": "check", "status": "checking"] }
                else if text == "Preview ready" { data = ["phase": "ready"] }
                else if text == runError { kind = "error" }
            }
            // Older local-Claude runs used setup for both narration and installation: reclassify inside that window only.
            if data["provider"]?.string == "api" { localAgent = false }
            if data["phase"]?.string == "agent" || (data["provider"]?.string == "claude-local" && data["phase"]?.string == "setup") { localAgent = true }
            if localAgent && data["phase"]?.string == "setup" && data["stage"] == nil && data["install_status"] == nil && data["status"]?.string != "reusing" {
                data["phase"] = "agent"; data["legacy"] = true
            }
            if text == "Cloning repository" { text = "cloning" }
            if text == "Creating sandbox" { text = "creating" }
            if data["lifecycle"]?.string == "cloned" { text = "cloned" }
            if (kind == "stdout" || kind == "stderr") && data["phase"]?.string != "log" && !(text.hasSuffix("\n") || text.hasSuffix("\r")) { text += "\n" }
            return RunEvent(id: .number(Double(index)), seq: index, runId: run?["id"]?.string, at: entry["time"]?.string, text: text, kind: kind, data: data)
        }
    }

    /// End-to-end wall time to the first verified preview (ms), not the sum of stages; nil while starting or unknown.
    public static func timeToLive(_ run: JSONValue?) -> Double? {
        guard let run, run["status"]?.string != "starting" else { return nil }
        let events = buildEvents(run)
        let restart = events.first { $0.ds("lifecycle") == "restart" }
        let start = restart?.at ?? run["created_at"]?.string ?? events.first { $0.text == "Starting repository setup" }?.at
        let ready = events.first { $0.ds("phase") == "ready" }?.at
        guard let start, let ready else { return nil }
        let duration = RunSteps.ms(ready) - RunSteps.ms(start)
        return duration.isFinite && duration >= 0 ? duration : nil
    }

    public static func steps(_ run: JSONValue?, repoName: String?) -> [RunStepRow] {
        var events = buildEvents(run)
        if run?["status"]?.string == "ready" && !events.contains(where: { $0.ds("phase") == "ready" }) {
            events.append(RunEvent(id: "ready", at: nil, text: "Preview ready", kind: "status", data: ["phase": "ready"]))
        }
        let adapted = run.map { r -> TimelineRun in
            var t = TimelineRun(id: r["id"]?.string, status: ["starting": "launching", "ready": "running", "stopped": "killed", "failed": "failed"][r["status"]?.string ?? ""],
                                sandboxId: r["sandbox_id"]?.string, previewUrl: r["preview_url"]?.string, error: r["error"]?.string)
            t.usage = r["usage"]
            return t
        }
        var steps = RunSteps.runSteps(adapted, events.filter { !LocalBuild.isAgentEvent($0) && !LocalBuild.isEnvironmentApplication($0) }, repoName: repoName)
        for i in steps.indices {
            if steps[i].id != "live" && steps[i].events.isEmpty && ["done", "skipped"].contains(steps[i].state) { steps[i].state = "skipped"; steps[i].summary = "Not recorded" }
            if steps[i].id == "health" && steps[i].summary == "Verifying live preview…" && events.contains(where: { $0.ds("phase") == "ready" }) { steps[i].summary = "The check passed" }
            if steps[i].id == "start" && steps[i].state == "done" && run?["status"]?.string == "ready" && events.contains(where: { $0.ds("phase") == "check" && $0.ds("status") == "ok" }) { steps[i].summary = "Repository prepared" }
        }
        if events.contains(where: { $0.ds("lifecycle") == "restart" }) {
            for i in steps.indices {
                if ["sandbox", "trail", "plan", "services"].contains(steps[i].id) {
                    steps[i].state = "skipped"; steps[i].since = nil
                    steps[i].summary = steps[i].id == "sandbox" ? "Same sandbox and working files" : "Reused from the previous build"
                }
                if steps[i].id == "start" { steps[i].title = "Restart application"; if steps[i].summary == "Repository prepared" { steps[i].summary = "Application restarted" } }
            }
        }
        // Used from a terminal (2026-10-03): installed, then ready in a shell; no app to start or preview to check.
        if run?["kind"]?.string == "terminal" {
            for i in steps.indices {
                if steps[i].id == "start" { steps[i].title = "Install" }
                if steps[i].id == "health" && steps[i].events.isEmpty { steps[i].summary = "No web preview to check" }
                if steps[i].id == "live" && steps[i].state == "done" { steps[i].summary = "Terminal ready" }
            }
        }
        return LocalBuild.steps(steps, events, run)
    }
}

/// local-build.js: Local-Claude observations extend the legacy pipeline without inventing a sequential stage for work that
/// runs in parallel with dependency installation.
public enum LocalBuild {
    public static func isAgentEvent(_ e: RunEvent) -> Bool { e.ds("phase") == "agent" || e.ds("actor") == "setup-agent" }
    public static func isEnvironmentApplication(_ e: RunEvent) -> Bool { e.ds("phase") == "environment" && e.ds("source") == "claude-local" && e.ds("status") == "applied" }
    static let terminal: Set<String> = ["done", "failed", "stopped", "summary_unavailable"]

    static func details(_ e: RunEvent, _ text: String) -> RunEvent { var x = e; x.text = text; x.kind = "status"; return x }

    static func agentStep(_ events: [RunEvent], _ run: JSONValue?) -> RunStepRow {
        let started = events.first { $0.ds("phase") == "agent" && $0.ds("status") == "starting" }
        let ended = events.last { $0.ds("phase") == "agent" && terminal.contains($0.ds("status") ?? "") }
        let legacy = events.allSatisfy { $0.d("legacy")?.bool == true }
        let status = run?["status"]?.string
        var state: String, summary: String
        if let ended {
            switch ended.ds("status") {
            case "done": (state, summary) = ("done", "Setup agent finished")
            case "failed": (state, summary) = (status == "failed" ? "failed" : "warned", "Setup agent failed")
            case "stopped": (state, summary) = ("skipped", "Setup agent stopped")
            default: (state, summary) = ("warned", "Preview verified · final summary unavailable")
            }
        } else if ["failed", "stopped"].contains(status ?? "") { (state, summary) = ("skipped", "Completion not recorded") }
        else if legacy && status == "ready" { (state, summary) = ("skipped", "Agent activity recorded · completion not recorded") }
        else { (state, summary) = ("active", status == "ready" ? "Finishing setup summary…" : "Claude preparing the repository…") }
        let elapsed = ended?.d("elapsed_ms")?.double ?? ((started?.at != nil && ended?.at != nil) ? max(0, RunSteps.ms(ended!.at) - RunSteps.ms(started!.at)) : 0)
        var step = RunStepRow(id: "agent", title: "Setup agent", state: state, summary: summary, error: ended?.ds("status") == "failed" ? ended!.text : nil,
                              startedAt: started?.at, elapsed: elapsed, since: state == "active" ? started?.at : nil, events: events)
        step.durationUnknown = started == nil || (state != "active" && ended == nil)
        return step
    }

    static func observedServices(_ step: inout RunStepRow, _ event: RunEvent, _ run: JSONValue?) {
        let app = event.d("app")!
        let listeners = app["listeners"]?.array ?? []
        var ports: [String] = []
        for l in listeners where l["ownership"]?.string == "owned" { let p = l["port"]?.text() ?? ""; if !ports.contains(p) { ports.append(p) } }
        let status = run?["status"]?.string
        let ended = ["failed", "stopped"].contains(status ?? "")
        let running = app["running"]?.bool == true
        let health = app["health"]
        let healthy = health?["current"]?.bool != false && health?["ok"]?.bool == true
        var summary = !ports.isEmpty ? RunSteps.count(ports.count, "listening port") : running ? "Processes running · no owned listener observed" : "No application processes running"
        if healthy && running { summary += " · Preview responding" }
        if ended { summary = "Last observed: " + summary }
        else if ["stopped", "exited"].contains(app["status"]?.string ?? "") { summary = "Application processes stopped" }
        else if running && health?["ok"]?.bool == false && status == "ready" { summary += " · Preview not responding" }
        var lines = [event.text]
        lines += (app["processes"]?.array ?? []).map { "Process \(RunSteps.str($0["pid"])): \(RunSteps.str($0["name"]))" }
        lines += listeners.map { l in
            let addr = RunSteps.str(l["address"])
            return "TCP \(addr.contains(":") ? "[\(addr)]" : addr):\(RunSteps.str(l["port"])) · \(["owned": "owned by app", "unowned": "not owned by app"][l["ownership"]?.string ?? ""] ?? "ownership unknown")"
        }
        if let h = health, !h.isNull {
            let code = RunSteps.str(h["http_status"]), err = RunSteps.str(h["error"])
            lines.append("Preview HTTP check: \(h["current"]?.bool == false ? "previous result" : h["ok"]?.bool == true ? "passed" : "not passing")\(code.isEmpty ? "" : " (\(code))")\(err.isEmpty ? "" : " · \(err)")")
        } else { lines.append("Preview HTTP check: not recorded") }
        lines.append("Listening ports are observations, not a complete service inventory. Other endpoints and credential-dependent features are not verified by this check.")
        step.summary = summary
        step.state = ended ? "skipped" : running && healthy ? "done" : status == "starting" ? "active" : running || ["stopped", "exited"].contains(app["status"]?.string ?? "") ? "warned" : "skipped"
        step.events = [details(event, lines.joined(separator: "\n"))]
        step.startedAt = nil; step.since = nil; step.elapsed = 0; step.durationUnknown = true; step.error = nil
    }

    public static func steps(_ input: [RunStepRow], _ events: [RunEvent], _ run: JSONValue?) -> [RunStepRow] {
        var steps = input
        let agentEvents = events.filter(isAgentEvent)
        let applied = events.last(where: isEnvironmentApplication)
        let snapshot = events.last { $0.ds("phase") == "app_status" && $0.d("app")?["running"]?.bool != nil && $0.d("app")?["listeners"]?.array != nil }
        let provider = events.last { ["api", "claude-local"].contains($0.ds("provider") ?? "") }?.ds("provider")
        let local = provider != "api" && (!agentEvents.isEmpty || applied != nil || snapshot != nil)
        if !agentEvents.isEmpty {
            let agent = agentStep(agentEvents, run)
            if let index = steps.firstIndex(where: { $0.id == "plan" }) {
                // Keep a real API Run Plan on fallback; replace only the empty placeholder.
                if steps[index].events.isEmpty { steps[index] = agent } else { steps.insert(agent, at: index) }
            }
            for i in steps.indices {
                if steps[i].id == "sandbox" && steps[i].state == "active" && steps[i].events.contains(where: { $0.ds("lifecycle") == "cloned" }) {
                    steps[i].state = "done"; steps[i].since = nil
                    if steps[i].startedAt != nil && agent.startedAt != nil { steps[i].elapsed = max(0, RunSteps.ms(agent.startedAt) - RunSteps.ms(steps[i].startedAt)) }
                }
                if ["sandbox", "trail", "plan"].contains(steps[i].id) && steps[i].state == "active" && steps[i].events.isEmpty { steps[i].state = "waiting" }
                if steps[i].id == "start" && steps[i].state == "failed" && agent.state == "failed"
                    && !steps[i].events.contains(where: { ["failed", "error", "blocked"].contains(($0.ds("install_status") ?? $0.ds("status")) ?? "") || $0.ds("phase") == "error" }) {
                    steps[i].state = "skipped"; steps[i].summary = "Interrupted by setup agent failure"; steps[i].error = nil; steps[i].durationUnknown = true
                }
            }
        }
        if let si = steps.firstIndex(where: { $0.id == "services" }), local, !steps[si].events.contains(where: { $0.ds("phase") == "supabase" }) {
            if let snapshot {
                observedServices(&steps[si], snapshot, run)
                if let li = steps.firstIndex(where: { $0.id == "live" }) { steps[li].events = steps[li].events.filter { $0.ds("phase") != "app_status" || $0.d("app") == nil } }
            } else { steps[si].state = "skipped"; steps[si].summary = "Not observed yet"; steps[si].since = nil }
        }
        if let ei = steps.firstIndex(where: { $0.id == "environment" }) {
            let scanned = steps[ei].events.contains { $0.ds("phase") == "environment" && $0.d("variables")?.array != nil }
            if let applied {
                let names = applied.d("provided_names")?.array?.compactMap(\.string) ?? []
                let removed = applied.d("removed_names")?.array?.compactMap(\.string) ?? []
                let output = [applied.text, names.isEmpty ? "No saved variables supplied." : "Applied names: \(names.joined(separator: ", "))"]
                    + (removed.isEmpty ? [] : ["Removed overrides: \(removed.joined(separator: ", "))"])
                    + ["Applying saved values does not check which variables the repository requires or whether credentials work."]
                if !scanned && local {
                    steps[ei].state = "skipped"
                    steps[ei].summary = "\(names.isEmpty ? "No saved variables" : "\(names.count) saved applied") · Requirements not scanned"
                    steps[ei].startedAt = nil; steps[ei].since = nil; steps[ei].elapsed = 0; steps[ei].durationUnknown = true; steps[ei].error = nil
                }
                steps[ei].events.append(details(applied, output.joined(separator: "\n")))
            } else if local && !scanned { steps[ei].state = "skipped"; steps[ei].summary = "Requirements not scanned"; steps[ei].since = nil }
        }
        return steps
    }
}

/// shared/build-history.cjs: durable evidence for the Build overview, separate from the rolling log tail — first/latest
/// lifecycle evidence and process observations, plus a bounded agent activity tail.
public enum BuildHistory {
    static let phases: Set<String> = ["trail", "recipe", "discover", "order", "plan", "supabase", "environment", "approval", "run", "patch", "visit", "brief", "resolve", "setup", "agent", "check", "start", "conclusion", "error", "exited", "ready", "usable"]
    static let statuses: Set<String> = ["starting", "running", "working", "checking", "reading", "done", "ok", "ready", "answering", "succeeded", "failed", "error", "blocked", "unavailable", "skipped", "stopped", "timeout", "needs_input", "unhealthy", "setup_planning", "replaying", "reusing", "fallback", "none", "own", "shared", "saved", "fresh", "captured", "ignored", "applied", "replayed", "stale", "plan", "gave_up", "leftover", "summary_unavailable"]
    static let stages: Set<String> = ["install", "setup", "build", "start", "run", "discover", "order", "plan", "environment", "supabase"]
    static let messages: Set<String> = ["Starting repository setup", "Creating sandbox", "Sandbox created", "Cloning repository", "Repository cloned", "Preview ready", "Sandbox stopped", "Analyzing and setting up repository", "Starting repository services", "Verifying live preview"]
    public static let agentLogLimit = 200

    public static func isAgentActivity(_ entry: JSONValue) -> Bool { entry["data"]?["phase"]?.string == "agent" || entry["data"]?["actor"]?.string == "setup-agent" }

    public static func milestoneKey(_ entry: JSONValue) -> String? {
        var data = entry["data"]?.object ?? [:]
        let message = entry["message"]?.string ?? ""
        if entry["data"] == nil || entry["data"]!.isNull {
            let parts = message.components(separatedBy: " · ")
            if phases.contains(parts[0]) { data = ["phase": .string(parts[0]), "status": parts.count > 1 ? .string(parts.last!) : .null] }
            else if parts[0] == "stage" { data = ["phase": "stage", "stage": .string(parts.count > 1 && !parts[1].isEmpty ? parts[1] : "install")] }
        }
        let kind = entry["kind"]?.string ?? ""
        let phase = data["phase"]?.string
        // Only actual observations qualify; generic monitoring messages prove nothing.
        if phase == "app_status", data["app"]?["running"]?.bool != nil, data["app"]?["listeners"]?.array != nil { return "services:observed" }
        if ["stdout", "stderr", "metrics"].contains(kind) || ["log", "app_status", "audit", "cost"].contains(phase ?? "") { return nil }
        if let l = data["lifecycle"]?.string, l == "restart" || l == "cloned" { return "lifecycle:\(l)" }
        let given = data["stage"]?.string ?? data["step"]?.string ?? ""
        let stage = stages.contains(given) ? given : ""
        if kind == "command" || phase == "stage" { return "command:\(stage)" }
        if kind == "error" && phase == nil { return "error:\(stage)" }
        if let phase, phases.contains(phase) {
            let s = data["install_status"]?.string ?? data["status"]?.string ?? ""
            return "\(phase):\(data["source"]?.string == "railpack" ? "railpack" : ""):\(stage):\(statuses.contains(s) ? s : "other")"
        }
        if messages.contains(message) { return "message:\(message)" }
        if phase == nil && message.hasPrefix("Installing dependencies") { return "message:install" }
        return nil
    }

    public static func collectMilestones(_ entries: [JSONValue]) -> [String: JSONValue] {
        var milestones: [String: JSONValue] = [:]
        for entry in entries {
            if entry["data"]?["lifecycle"]?.string == "restart" { milestones = [:] }
            if let key = milestoneKey(entry) { milestones[key] = ["first": milestones[key]?["first"] ?? entry, "last": entry] }
            if isAgentActivity(entry) {
                let list = (milestones["agent:activity"]?["entries"]?.array ?? []) + [entry]
                milestones["agent:activity"] = ["entries": .array(Array(list.suffix(agentLogLimit)))]
            }
        }
        return milestones
    }
}
