import Foundation
import EngelbartCore

/// One row of a sandbox run's timeline.
public struct RunStepRow: Equatable, Sendable {
    public var id: String
    public var title: String
    /// waiting | active | done | warned | failed | skipped
    public var state = "waiting"
    public var summary = ""
    public var error: String?
    public var startedAt: String?
    /// Milliseconds.
    public var elapsed: Double = 0
    public var since: String?
    public var events: [RunEvent] = []
    var flag: String?
    public var durationUnknown = false
}

/// The run as the timeline adapts it (canvas-build.js `adapted`).
public struct TimelineRun: Sendable {
    public var id: String?
    /// launching | running | killed | failed | usable | no_service | paused | queued …
    public var status: String?
    public var sandboxId: String?
    public var previewUrl: String?
    public var error: String?
    public var template: String?
    public var workdir: String?
    public var usage: JSONValue?
    public init(id: String? = nil, status: String? = nil, sandboxId: String? = nil, previewUrl: String? = nil, error: String? = nil) {
        self.id = id; self.status = status; self.sandboxId = sandboxId; self.previewUrl = previewUrl; self.error = error
    }
}

/// renderer/model/run-steps.js (ported from divadbaroon/engelbart-web @ afd4af9): a sandbox run's events grouped into the
/// pipeline's steps, each with its state, summary and duration.
public enum RunSteps {
    public static let order = ["sandbox", "trail", "plan", "services", "environment", "start", "health", "live"]
    static let titles = ["sandbox": "Sandbox", "trail": "Railpack", "plan": "Run Plan", "services": "Services", "environment": "Environment",
                         "start": "Install and start", "health": "Health and repair", "live": "Live"]
    static let healthRunStatus: Set<String> = ["needs_input", "setup_planning", "failed", "stopped", "error", "unhealthy"]

    static func isOver(_ run: TimelineRun?) -> Bool { ["failed", "killed", "paused", "no_service"].contains(run?.status ?? "") }
    static func railpackDiscovery(_ e: RunEvent) -> Bool {
        e.ds("phase") == "plan" && e.ds("source") == "railpack" && e.d("plan") == nil && e.d("start") == nil && ["running", "ok", "unavailable"].contains(e.ds("status") ?? "")
    }
    static func short(_ sha: String?) -> String { sha.map { String($0.prefix(7)) } ?? "" }
    public static func formatDay(_ iso: String?) -> String {
        guard let iso, let date = Time.parse(iso) else { return "" }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "MMM d"
        return f.string(from: date)
    }
    static func count(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : many ?? "\(one)s")" }
    public static func planner(_ source: String?) -> String {
        if source == "railpack" { return "Command list from Railpack" }
        if source == "run_order" { return "Command list from the run order" }
        return source.map { $0.isEmpty ? "" : "Command list from \($0)" } ?? ""
    }
    static func ms(_ iso: String?) -> Double { iso.flatMap(Time.parse).map { $0.timeIntervalSince1970 * 1000 } ?? .nan }
    static func cut(_ v: JSONValue?, _ n: Int) -> String { String(str(v).prefix(n)) }
    static func str(_ v: JSONValue?) -> String {
        guard let v else { return "" }
        if let s = v.string { return s }
        if v.isNull { return "" }
        if let d = v.double { return d.rounded() == d ? String(Int(d)) : String(d) }
        return v.text()
    }

    static func stepOf(_ e: RunEvent, _ seenReady: Bool) -> String? {
        let phase = e.ds("phase")
        if railpackDiscovery(e) { return "trail" }
        if seenReady && phase == "setup" { return "live" }
        switch phase {
        case "trail": return e.ds("status") == "saved" || (e.ds("status") == "shared" && e.d("saved")?.bool == true) ? "live" : "trail"
        case "recipe": return e.ds("status") == "captured" ? "live" : "trail"
        case "discover", "order", "plan", "brief": return "plan"
        case "supabase": return "services"
        case "environment": return "environment"
        case "approval", "setup": return "start"
        case "run": return healthRunStatus.contains(str(e.d("status"))) ? "health" : "start"
        case "patch", "visit", "resolve", "check": return "health"
        case "ready", "usable": return "live"
        case "conclusion": return e.ds("step") == "run" ? "health" : "plan"
        case "cost": return nil
        case "start": return e.ds("status") == "starting" || e.ds("status") == "leftover" ? "start" : "health"
        case "error":
            let step = e.ds("step") ?? ""
            if ["discover", "order", "plan"].contains(step) { return "plan" }
            if ["setup", "install"].contains(step) { return "start" }
            if step == "environment" { return "environment" }
            if step == "supabase" { return "services" }
            return seenReady ? "live" : "health"
        case "exited": return seenReady ? "live" : "health"
        default: break
        }
        if e.ds("stage") != nil && ["command", "stdout", "stderr"].contains(e.kind) { return seenReady ? "live" : "start" }
        let t = e.text
        if e.kind == "status" {
            if t.hasPrefix("picked up by runner") || t == "creating" || t == "cloning" || t == "cloned" || t.hasPrefix("exit ") || e.d("template") != nil || t.hasPrefix("docker ") || t.hasPrefix("sandbox killed") || t.hasPrefix("could not list") { return "sandbox" }
            if t == "launching" || e.d("recipe")?.bool == true || t.hasPrefix("could not hand over the saved recipe") { return "trail" }
            if t.hasPrefix("could not hand over the saved environment") || (t.hasPrefix("using ") && t.contains("saved environment value")) { return "environment" }
            if t.hasPrefix("service ") || t.hasPrefix("preview ") { return "live" }
        }
        if e.kind == "command" {
            if t.hasPrefix("git clone") || t.hasPrefix("ls -A") || t == "dockerd" { return "sandbox" }
            if t.hasPrefix("python3 ") { return "trail" }
            if t.contains("proxy.mjs") { return "live" }
        }
        return nil
    }

    public static func runSteps(_ run: TimelineRun?, _ events: [RunEvent], repoName: String?) -> [RunStepRow] {
        var steps: [String: RunStepRow] = [:]
        for id in order { steps[id] = RunStepRow(id: id, title: titles[id]!) }
        var current = "sandbox"
        var seenReady = false
        var openSince: String?
        var openSet = false
        var runtime: [RunEvent] = []
        for e in events {
            if ["app_status", "audit"].contains(e.ds("phase") ?? "") { runtime.append(e); continue }
            if railpackDiscovery(e) && current == "start" {
                steps["trail"]!.events.append(e)
                if steps["trail"]!.startedAt == nil { steps["trail"]!.startedAt = e.at }
                continue
            }
            if let to = stepOf(e, seenReady), to != current {
                if let since = openSince, let at = e.at { steps[current]!.elapsed += max(0, ms(at) - ms(since)) }
                else if openSet { steps[current]!.durationUnknown = true }
                current = to
                openSince = e.at; openSet = e.at != nil
            }
            if !openSet { openSince = e.at; openSet = e.at != nil }
            if e.ds("phase") == "ready" { seenReady = true }
            steps[current]!.events.append(e)
            if steps[current]!.startedAt == nil { steps[current]!.startedAt = e.at }
        }
        let over = isOver(run)
        let live = run?.status == "running" || run?.status == "usable"
        if let since = openSince {
            if over { steps[current]!.elapsed += max(0, ms(events.last?.at) - ms(since)) }
            else if !live { steps[current]!.since = since }
        }
        summarize(&steps, run, repoName)
        let reached = max(0, order.enumerated().map { steps[$0.element]!.events.isEmpty ? -1 : $0.offset }.max() ?? -1)
        for (i, id) in order.enumerated() {
            var s = steps[id]!
            if i < reached { s.state = s.events.isEmpty ? "skipped" : s.flag ?? "done" }
            else if i == reached { s.state = run?.status == "failed" ? "failed" : (over || live) ? s.flag ?? "done" : run != nil ? "active" : "waiting" }
            else { s.state = run?.status == "no_service" ? "skipped" : "waiting" }
            steps[id] = s
        }
        // Canvas can revisit install/plan during repairs: the latest event identifies the active or failed step.
        if let run, !live {
            for id in order where id != current && (steps[id]!.state == "active" || steps[id]!.state == "failed") { steps[id]!.state = steps[id]!.flag ?? "done" }
            steps[current]!.state = run.status == "failed" ? "failed" : run.status == "killed" ? "skipped" : !over ? "active" : steps[current]!.state
            if run.status == "failed", let error = run.error, !error.isEmpty { steps[current]!.error = BuildEvents.plainError(error) }
            if run.status == "killed" { steps[current]!.summary = "Stopped" }
        }
        if run?.status == "no_service" { for id in order where steps[id]!.state == "skipped" && steps[id]!.summary.isEmpty { steps[id]!.summary = "Nothing to serve" } }
        if steps["services"]!.state == "skipped" && steps["services"]!.summary.isEmpty { steps["services"]!.summary = "Not needed" }
        if steps["environment"]!.state == "skipped" && steps["environment"]!.summary.isEmpty { steps["environment"]!.summary = "Not scanned" }
        if run?.status != "no_service" {
            if steps["health"]!.state == "skipped" { steps["health"]!.state = "done"; if steps["health"]!.summary.isEmpty { steps["health"]!.summary = "Answered on the first check" } }
            if steps["plan"]!.state == "skipped" { steps["plan"]!.state = "done"; if steps["plan"]!.summary.isEmpty { steps["plan"]!.summary = "Taken from the saved command list" } }
        }
        if steps["trail"]!.state == "skipped" && steps["trail"]!.summary.isEmpty { steps["trail"]!.summary = "Not recorded" }
        if run?.status == "paused" { steps["sandbox"]!.summary = "\(steps["sandbox"]!.summary) · paused" }
        if run == nil && steps["sandbox"]!.summary.isEmpty { steps["sandbox"]!.summary = "Not prepared yet" }
        // A later stage does not turn an explicitly failed outcome into success.
        for id in order where steps[id]!.state == "done" {
            let outcome = steps[id]!.events.last { $0.kind == "error" || $0.ds("phase") == "error" || ["failed", "error", "ok", "done", "ready", "answering"].contains(str($0.d("status"))) }
            if let o = outcome, o.kind == "error" || o.ds("phase") == "error" || ["failed", "error"].contains(str(o.d("status"))) {
                steps[id]!.state = "warned"
                if steps[id]!.error == nil { steps[id]!.error = o.d("reason").map(str) ?? o.d("output").map(str) ?? o.text }
            }
        }
        if let discovery = steps["trail"]!.events.last(where: railpackDiscovery) {
            var step = steps["trail"]!
            if discovery.ds("status") != "running" && step.state != "failed" {
                step.state = discovery.ds("status") == "ok" ? "done" : "skipped"
                step.since = nil
                step.elapsed = discovery.d("elapsed_ms")?.double ?? step.elapsed
            } else if !over && !live { step.state = "active"; step.elapsed = 0; step.since = discovery.at }
            steps["trail"] = step
        }
        steps["live"]!.events.append(contentsOf: runtime)
        steps["live"]!.events.sort { (ms($0.at).isNaN ? 0 : ms($0.at)) < (ms($1.at).isNaN ? 0 : ms($1.at)) }
        return order.map { var s = steps[$0]!; s.flag = nil; return s }
    }

    static func summarize(_ steps: inout [String: RunStepRow], _ run: TimelineRun?, _ repoName: String?) {
        func last(_ id: String, _ pick: (RunEvent) -> Bool) -> RunEvent? { steps[id]!.events.last(where: pick) }
        // sandbox
        do {
            let creating = last("sandbox") { $0.d("template") != nil }
            let template = str(creating?.d("template")).isEmpty ? (run?.template ?? "") : str(creating?.d("template"))
            let docker = template.hasSuffix("-docker") ? " with Docker" : ""
            let made = creating != nil || run?.sandboxId != nil
            let box = !made ? "" : isOver(run) ? "Sandbox stopped\(docker)" : "Sandbox running\(docker)"
            let name = repoName ?? run?.workdir?.split(separator: "/").last.map(String.init) ?? ""
            let cloned = last("sandbox") { $0.text == "cloned" }
            let what = cloned != nil ? "cloned\(name.isEmpty ? "" : " \(name)")" : !steps["sandbox"]!.events.isEmpty ? "cloning\(name.isEmpty ? "" : " \(name)")…" : ""
            steps["sandbox"]!.summary = [box, what].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        // trail
        do {
            let discovery = last("trail", railpackDiscovery)
            let trail = last("trail") { $0.ds("phase") == "trail" }
            let replay = last("trail") { $0.ds("phase") == "recipe" }
            let d = trail?.data ?? [:]
            let files = d["files"]?.array?.count ?? d["files"]?.int ?? 0
            let from = [formatDay(d["capturedAt"]?.string), short(d["commit"]?.string).isEmpty ? "" : "at \(short(d["commit"]?.string))", files > 0 ? count(files, "patched file") : ""].filter { !$0.isEmpty }.joined(separator: ", ")
            let status = d["status"]?.string
            var text = status == "own" ? "Replaying this project's command list\(from.isEmpty ? "" : " from \(from)")"
                : status == "shared" ? "Replaying another project's command list\(from.isEmpty ? "" : " from \(from)")"
                : status == "none" ? "No command list yet; analyzing from scratch"
                : status == "fresh" ? "Working the commands out from scratch, as asked"
                : last("trail") { $0.d("recipe")?.bool == true } != nil ? "Replaying the saved command list" : ""
            let rd = replay?.data ?? [:]
            if ["failed", "ignored"].contains(rd["status"]?.string ?? "") {
                let reason = rd["reason"].map { " (\(cut($0, 80)))" } ?? ""
                text = "\(text.isEmpty ? "" : "\(text) · ")the command list did not work\(str(rd["reason"]).isEmpty ? "" : reason); analyzing from scratch"
                steps["trail"]!.flag = "warned"
            }
            if text.isEmpty && !steps["plan"]!.events.isEmpty { text = "No command list; analyzed from scratch" }
            if let discovery { text = ["running": "Discovering launch hints…", "ok": "Launch hints ready", "unavailable": "Launch hints unavailable"][discovery.ds("status") ?? ""] ?? text }
            steps["trail"]!.summary = text
        }
        // plan
        do {
            let plan = last("plan") { $0.ds("phase") == "plan" }
            let discovered = last("plan") { $0.ds("phase") == "discover" && $0.ds("status") == "done" }
            let comps = discovered?.d("components")?.array?.count ?? 0
            let pd = plan?.data ?? [:]
            let summary = pd["summary"]?.string ?? (plan.map { $0.text.replacingOccurrences(of: "^plan: ", with: "", options: .regularExpression) } ?? "")
            let failed = last("plan") { $0.ds("phase") == "error" }
            let concluded = last("plan") { $0.ds("phase") == "conclusion" }
            let cd = concluded?.data ?? [:]
            let conclusion = concluded == nil ? "" : cd["status"]?.string == "blocked" ? "Blocked: \(cut(cd["reason"], 200))" : "Nothing to serve: \(cut(cd["reason"], 200))"
            let brief = last("plan") { $0.ds("phase") == "brief" }
            let bd = brief?.data ?? [:]
            let briefLine = bd["status"]?.string == "starting" ? "Reading the repository…" : bd["status"]?.string == "failed" ? "No brief" : ""
            let gaveUp = last("plan") { $0.ds("phase") == "order" && $0.ds("status") == "gave_up" }
            let gaveUpLine = gaveUp.map { "The planner gave up: \(cut($0.d("reason"), 160))" } ?? ""
            let ordered = pd["plan"]
            let services = ordered?["services"]?.array ?? []
            let entry = services.first { $0["id"] == ordered?["entryService"] } ?? services.first
            let argv = entry?["argv"]?.array?.compactMap(\.string).joined(separator: " ") ?? ""
            let start = (pd["start"].map(str) ?? argv).trimmingCharacters(in: .whitespaces)
            let whereDir = [entry?["cwd"]?.string, bd["brief"]?["primaryApp"]?["path"]?.string].compactMap { $0 }.first { !$0.isEmpty && $0 != "." } ?? ""
            let runs = start.isEmpty ? "" : "Runs \(start)\(whereDir.isEmpty ? "" : " in \(whereDir)")"
            let firstPart = [conclusion, gaveUpLine, runs, summary, briefLine].first { !$0.isEmpty } ?? (failed != nil ? "" : !steps["plan"]!.events.isEmpty ? "Analyzing…" : "")
            steps["plan"]!.summary = [firstPart, planner(pd["source"]?.string), comps > 0 ? count(comps, "component") : ""].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        // services
        do {
            let ev = last("services") { $0.ds("phase") == "supabase" }
            let d = ev?.data ?? [:]
            let reason = d["reason"]?.string ?? ""
            switch d["status"]?.string {
            case "ready": steps["services"]!.summary = "Local Supabase ready"
            case "skipped": steps["services"]!.summary = reason.isEmpty ? "Not needed" : "Local Supabase skipped: \(reason)"; steps["services"]!.flag = "skipped"
            case "unavailable", "failed", "timeout", "needs_input", "stopped":
                steps["services"]!.summary = "Local Supabase could not start\(reason.isEmpty ? "" : ": \(reason)")"; steps["services"]!.flag = "warned"
            default: if ev != nil { steps["services"]!.summary = reason.isEmpty ? "Starting a local Supabase…" : "Local Supabase: \(reason)" }
            }
        }
        // environment
        do {
            if let ev = last("environment", { $0.ds("phase") == "environment" && $0.d("variables")?.array != nil }) {
                let vars = ev.d("variables")!.array!
                let found = vars.filter { $0["status"] == "found" }.count, local = vars.filter { $0["status"] == "local" }.count, saved = vars.filter { $0["status"] == "provided" }.count
                let missing = ev.d("skipped")?.array?.count ?? 0
                let parts = [found > 0 ? "\(found) in the repository" : "", local > 0 ? "\(local) from the local Supabase" : "", saved > 0 ? "\(saved) saved" : "", missing > 0 ? "\(missing) missing" : ""].filter { !$0.isEmpty }
                steps["environment"]!.summary = parts.isEmpty ? "Nothing read from the environment" : parts.joined(separator: " · ")
                if missing > 0 { steps["environment"]!.flag = "warned" }
            } else if !steps["environment"]!.events.isEmpty { steps["environment"]!.summary = "Scanning…" }
        }
        // start
        do {
            let stages = steps["start"]!.events.filter { $0.kind == "command" && $0.ds("stage") != nil }
            let firstStage = stages.first?.ds("stage")
            let starts = stages.enumerated().filter { $0.element.ds("stage") == firstStage }.map(\.offset)
            let commands = starts.isEmpty ? [] : stages[starts.last!...].map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            var unique: [String] = []
            for c in commands where !unique.contains(c) { unique.append(c) }
            let setup = last("start") { $0.ds("phase") == "setup" }
            let setupFailure = last("start") { ($0.ds("phase") == "setup" && $0.ds("status") == "failed") || $0.kind == "error" }
            let sd = setup?.data ?? [:]
            if setup != nil {
                let summaries = ["starting": "Installing and preparing…", "working": "Preparing repository…", "replaying": "Replaying saved setup…", "reusing": "Restarting application…", "fallback": "Switching setup provider…"]
                let s = sd["status"]?.string ?? ""
                steps["start"]!.summary = s == "failed" ? (run?.status == "running" ? "Initial setup failed" : "Setup failed")
                    : s == "done" ? (setupFailure != nil ? "Recovered after setup failure" : "Set up: \(String((sd["summary"].map(str) ?? "installed").prefix(160)))")
                    : summaries[s] ?? "Setup activity recorded"
            } else {
                steps["start"]!.summary = !unique.isEmpty ? "\(unique.joined(separator: " · "))\(starts.count > 1 ? " (\(starts.count) passes)" : "")" : !steps["start"]!.events.isEmpty ? "Starting…" : ""
            }
            if let f = setupFailure {
                steps["start"]!.flag = "warned"
                let reason = str(f.d("reason")), output = str(f.d("output"))
                steps["start"]!.error = !reason.isEmpty ? reason : !output.isEmpty ? output : f.text
            }
        }
        summarizeHealth(&steps)
        // live
        do {
            let ready = last("live") { $0.ds("phase") == "ready" }
            let services = ready?.d("services")?.array?.count ?? 0
            let captured = last("live") { $0.ds("phase") == "recipe" && $0.ds("status") == "captured" }
            let shared = last("live") { $0.ds("phase") == "trail" && $0.ds("status") == "shared" }
            let exited = last("live") { $0.ds("phase") == "exited" || $0.ds("phase") == "error" }
            let usable = last("live") { $0.ds("phase") == "usable" }
            let ub = usable?.d("blocker") ?? run?.usage?["blocker"]
            var first = ""
            if !isOver(run) {
                if run?.status == "usable" || usable != nil {
                    if let ub, !ub.isNull { first = "Set up; blocked by \(ub["kind"]?.string ?? "something"): \(cut(ub["what"], 120))" }
                    else { let sum = usable?.d("summary").map(str) ?? ""; first = "Set up and ready to use\(sum.isEmpty ? "" : ": \(String(sum.prefix(120)))")" }
                } else if run?.status == "running" && run?.previewUrl != nil { first = "Preview ready" }
                else if ready != nil { first = "Ready" }
            }
            var parts = [first, services > 1 ? count(services, "service") : "", shared != nil ? "command list saved and shared" : captured != nil ? "command list saved" : ""].filter { !$0.isEmpty }
            if let exited {
                let reason = str(exited.d("reason"))
                parts.append("stopped: \(String((reason.isEmpty ? exited.text : reason).prefix(120)))")
                steps["live"]!.flag = "warned"
            }
            if run?.status == "killed" { parts.append("stopped") }
            steps["live"]!.summary = parts.joined(separator: " · ")
        }
    }

    static func summarizeHealth(_ steps: inout [String: RunStepRow]) {
        func last(_ pick: (RunEvent) -> Bool) -> RunEvent? { steps["health"]!.events.last(where: pick) }
        let patch = last { $0.ds("phase") == "patch" && $0.ds("status") != "starting" }
        let starting = last { $0.ds("phase") == "patch" && $0.ds("status") == "starting" }
        let need = last { $0.ds("phase") == "run" && $0.ds("status") == "needs_input" }
        let unhealthy = last { $0.ds("phase") == "run" && $0.ds("status") == "unhealthy" }
        let concluded = last { $0.ds("phase") == "conclusion" }
        let check = last { $0.ds("phase") == "check" }
        let visited = last { $0.ds("phase") == "visit" }
        let err = last { $0.kind == "error" }
        let d = patch?.data ?? [:]
        let files = d["files"]?.array?.count ?? 0
        let attempt = (d["attempt"] ?? starting?.d("attempt")).map(str).flatMap { $0.isEmpty ? nil : $0 } ?? "1"
        let resolved = last { $0.ds("phase") == "resolve" && ["plan", "blocked", "failed"].contains($0.ds("status") ?? "") }
        let resolving = last { $0.ds("phase") == "resolve" && ["starting", "reading"].contains($0.ds("status") ?? "") }
        let rd = resolved?.data ?? [:]
        let blocker = rd["blocker"] ?? concluded?.d("blocker")
        let outcome = last { $0.ds("phase") == "start" || $0.ds("phase") == "check" }
        var summary = ""
        var warned = false
        func blockedLine(_ what: JSONValue?) -> String {
            "Blocked\(blocker?["kind"]?.string.map { " (\($0))" } ?? ""): \(String(str(what).prefix(200)))"
        }
        if outcome?.ds("phase") == "start" && outcome?.ds("status") == "failed" { summary = "The application did not start: \(cut(outcome?.d("reason"), 160))"; warned = true }
        else if outcome?.ds("phase") == "start" && outcome?.ds("status") == "answering" { summary = "Application responding" }
        else if outcome?.ds("phase") == "check" {
            let s = check?.ds("status") ?? ""
            let failed = ["failed", "error"].contains(s)
            let reason = str(check?.d("reason")).isEmpty ? str(check?.d("output")) : str(check?.d("reason"))
            summary = s == "ok" ? "The check passed" : failed ? "The check failed: \(String(reason.suffix(160)))" : "Verifying live preview…"
            warned = failed
        } else if let c = concluded, c.ds("status") == "blocked" { summary = blockedLine(blocker?["what"] ?? c.d("reason")); warned = true }
        else if let c = concluded { summary = "Nothing to serve: \(cut(c.d("reason"), 200))" }
        else if rd["status"]?.string == "plan" { summary = "The resolver corrected the plan: \(cut(rd["hint"], 160))"; warned = true }
        else if rd["status"]?.string == "blocked" { summary = blockedLine(blocker?["what"]); warned = true }
        else if rd["status"]?.string == "failed" { let r = str(rd["reason"]); summary = "The resolver could not decide\(r.isEmpty ? "" : ": \(String(r.prefix(120)))")"; warned = true }
        else if let r = resolving { summary = r.ds("status") == "reading" ? "The resolver is reading files…" : "The resolver is looking at why it stopped…" }
        else if d["status"]?.string == "applied" { summary = "Repair attempt \(attempt) edited \(count(files, "file"))"; warned = true }
        else if d["status"]?.string == "replayed" { summary = "Saved edits applied again (\(count(files, "file")))"; warned = true }
        else if d["status"]?.string == "none" { summary = "The repair agent found nothing to change" }
        else if d["status"]?.string == "failed" { let r = str(d["reason"]); summary = "Repair attempt \(attempt) failed\(r.isEmpty ? "" : ": \(String(r.prefix(120)))")"; warned = true }
        else if d["status"]?.string == "stale" { summary = "The saved edits no longer fit the repository" }
        else if starting != nil { summary = "Repair attempt \(attempt): the agent is looking for a fix…" }
        else if let n = need { summary = "Not answering: \(cut(n.d("reason"), 160))" }
        else if let u = unhealthy { summary = "Opened the page: \(cut(u.d("reason"), 160))" }
        else if let e = err { summary = String(e.text.prefix(160)) }
        else if let v = visited { let t = str(v.d("title")); summary = "Opened the page in a browser\(t.isEmpty ? "" : " (\(String(t.prefix(60))))")" }
        else if !steps["health"]!.events.isEmpty { summary = "Checking…" }
        steps["health"]!.summary = summary
        if warned { steps["health"]!.flag = "warned" }
    }

    static let tone = ["queued": "working", "creating": "working", "cloning": "working", "cloned": "working", "launching": "working", "running": "live",
                       "usable": "live", "paused": "ended", "no_service": "ended", "killed": "ended", "failed": "failed"]

    public static func runState(_ run: TimelineRun?, _ steps: [RunStepRow]) -> (headline: String, detail: String, tone: String) {
        guard let run else { return ("Not prepared", "", "none") }
        let at = steps.lastIndex { $0.state != "waiting" } ?? -1
        let current = at >= 0 ? steps[at] : nil
        let t = tone[run.status ?? ""] ?? ""
        let label = BuildEvents.statusLabel[run.status ?? ""] ?? (run.status ?? "")
        if t == "failed" || t == "ended" {
            return ("\(label)\(run.status == "failed" && current != nil ? " in \(current!.title)" : "")", BuildEvents.plainError(run.error), t)
        }
        if t == "live" {
            let blocker = run.usage?["blocker"]
            let detail = blocker.flatMap { $0.isNull ? nil : $0 }.map { b in
                "Blocked by \(b["kind"] == "secret" ? "a missing key" : b["kind"] == "service" ? "a missing service" : b["kind"]?.string ?? ""): \(b["what"]?.string ?? "")"
            } ?? (run.status == "running" ? run.previewUrl ?? "" : run.usage?["summary"]?.string ?? "")
            return (label, detail, t)
        }
        return (label, current.map { "Step \(at + 1) of \(steps.count) · \($0.title)" } ?? "", t)
    }

    /// Milliseconds, or nil when unknown.
    public static func stepDuration(_ step: RunStepRow, now: Double?) -> Double? {
        if step.startedAt == nil || step.durationUnknown { return nil }
        return step.elapsed + ((step.since != nil && now != nil) ? max(0, now! - ms(step.since)) : 0)
    }

    public static func runDuration(_ steps: [RunStepRow], now: Double?) -> Double? {
        guard steps.contains(where: { $0.startedAt != nil }) else { return nil }
        return steps.reduce(0) { $0 + (stepDuration($1, now: now) ?? 0) }
    }

    public static func formatDuration(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded())
        return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
    }
}
