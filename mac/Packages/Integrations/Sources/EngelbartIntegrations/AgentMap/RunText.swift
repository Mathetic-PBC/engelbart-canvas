import Foundation
import EngelbartCore

// src/renderer/agent-map/runText.js: what the Agent Viewer reads off the run log's records (Bart's runlog.cjs, JSON here)
// and its asks (AgentAsks), and the page it exports: one self-contained HTML file, its styles inline and the records'
// data in it, sections as <details> so it needs no script. No colours (2026-10-13): agents are named in words only.

public struct AgentInfo: Equatable, Sendable {
    public var agent: String
    public var routed: String?
    public var name: String
    public var token: String
    public var inside: String?
    public var unknown: Bool = false
}

/// A node of an ask's sections (askSections): what the Viewer and the export both draw.
public struct RunNode: Equatable, Sendable {
    public var label: String
    public var dim: String?
    public var arg: String?
    public var command = false
    public var tool = false
    public var text: String?
    public var plain = false
    public var error: String?
    public var open = false
    public var children: [RunNode]?
}

public struct RunSection: Equatable, Sendable {
    public var key: String
    public var title: String
    public var summary: String
    public var nodes: [RunNode]
}

public struct ContextBlock: Equatable, Sendable {
    public var key: String
    public var label: String
    public var text: String
}

public struct RunFilter: Equatable, Sendable {
    public var project = ""
    public var workspace = ""
    public var day = ""
    public init(project: String = "", workspace: String = "", day: String = "") { self.project = project; self.workspace = workspace; self.day = day }
    public static let all = RunFilter()
}

public enum RunText {
    public static let agents: [AgentInfo] = [
        AgentInfo(agent: "router", routed: nil, name: "Bart (classifier)", token: "@bart"),
        AgentInfo(agent: "bart", routed: "chat", name: "Chat", token: "@chat"),
        AgentInfo(agent: "brainstorm", routed: "brainstorm", name: "Brainstorm", token: "@brainstorm"),
        AgentInfo(agent: "discover", routed: "discover", name: "Discover", token: "@discover"),
        AgentInfo(agent: "create", routed: "create", name: "Create", token: "@create"),
        AgentInfo(agent: "build", routed: "build", name: "Build", token: "@bart / Build button / panel / sticky"),
        AgentInfo(agent: "run step", routed: nil, name: "Run step", token: "", inside: "build"),
    ]

    /// An agent's entry by its run log name or its routed name ('chat' is 'bart'); an unknown one under its own name.
    public static func agentInfo(_ name: String?) -> AgentInfo {
        let key = name ?? ""
        return agents.first { $0.agent == key || $0.routed == key } ?? AgentInfo(agent: key, routed: key, name: key.isEmpty ? "unknown" : key, token: "", unknown: true)
    }

    public static let buildAgents = ["build", "run step"]

    static func s(_ v: JSONValue?) -> String { v?.stringish ?? "" }
    static func nonEmpty(_ v: JSONValue?) -> String? { let x = s(v); return x.isEmpty ? nil : x }
    static func agent(_ r: JSONValue?) -> String { s(r?["agent"]) }

    /// A run's name in the export: its agent in plain words, then a Build turn's title; the run step "Build · run step <title>".
    public static func runLabel(_ run: JSONValue?) -> String {
        guard let run else { return "" }
        let turn = run["turn"].flatMap { $0.isNull ? nil : $0.stringish } ?? "?"
        if agent(run) == "build" { return "Build \(run["kind"]?.string == "quick" ? (nonEmpty(run["title"]) ?? "quick task") : s(run["title"])) · turn \(turn)" }
        if agent(run) == "run step" { return "Build · run step \(s(run["title"]))" }
        return agentLabel(run)
    }

    static func blockLabel(_ key: String) -> String {
        key == "prompt" ? "prompt" : key == "other" ? "text outside any block" : key == "reply" ? "sent this turn (<reply>, or everything again)" : "<\(key)>"
    }

    /// A run's context blocks, in the order the agent is sent them.
    public static func contextBlocks(_ record: JSONValue?) -> [ContextBlock] {
        let c = record?["context"] ?? .object([:])
        let text = { (v: JSONValue?) -> String in
            guard let v, !v.isNull else { return "" }
            if case .string(let x) = v { return x }
            if case .array(let a) = v { return a.map(\.stringish).joined(separator: "\n") }
            return v.stringish.isEmpty ? JSONText.stringify(v) : v.stringish
        }
        if let record, buildAgents.contains(agent(record)) {
            return (c.object ?? [:]).keys.sorted().map { ContextBlock(key: $0, label: blockLabel($0), text: text(c[$0])) }
        }
        return [("head", "<engelbart>"), ("contextJson", "<context_json>"), ("mentionedFiles", "<mentioned_files>"), ("documents", "documents"),
                ("now", "<stage> / <highlights> (now)"), ("conversation", "<conversation>"), ("extra", "extra (<path>, <mode>…)"), ("dirs", "folders granted"),
                ("input", "the router's input (line, section, threads, spec above)")].map { ContextBlock(key: $0.0, label: $0.1, text: text(c[$0.0])) }
    }

    public static func tokens(_ text: String?) -> Int { Int((Double(jsLength(text ?? "")) / 4).rounded()) }
    public static func sizeLabel(_ text: String?) -> String { "\(grouped(jsLength(text ?? ""))) chars · ~\(grouped(tokens(text))) tok" }
    public static func json(_ value: JSONValue?) -> String {
        guard let value, !value.isNull else { return "" }
        if case .string(let x) = value { return x }
        return JSONText.stringify(value, indent: 2)
    }
    public static func firstWords(_ text: String?, _ n: Int = 9) -> String {
        let words = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return words.isEmpty ? "(empty line)" : words.prefix(n).joined(separator: " ") + (words.count > n ? " …" : "")
    }
    public static func writtenText(_ record: JSONValue?) -> String {
        guard let written = record?["written"]?.array else { return "" }
        return written.map { $0.string ?? json($0) }.joined(separator: "\n")
    }

    static let timeFormatter: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "HH:mm:ss"; return f }()

    public static func timeLabel(_ at: Double?, now: Double = systemNow()) -> String {
        guard let at, at != 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let today = Calendar.current.isDate(date, inSameDayAs: Date(timeIntervalSince1970: now / 1000))
        let time = timeFormatter.string(from: date)
        return today ? time : "\(String(isoString(at).prefix(10))) \(time)"
    }

    public static func msLabel(_ ms: Double?) -> String {
        guard let ms else { return "" }
        if ms < 1000 { return "\(JSONText.number(ms)) ms" }
        if ms < 60000 { return String(format: "%.1f s", ms / 1000) }
        return "\(Int(ms / 60000)) m \(Int((ms.truncatingRemainder(dividingBy: 60000) / 1000).rounded())) s"
    }

    static let words: [String: String] = ["bart": "Chat", "chat": "Chat", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create", "build": "Build"]
    static func agentWord(_ a: String?) -> String { words[a ?? ""] ?? agentInfo(a).name }

    static func routedWord(_ router: JSONValue) -> String {
        if let h = router["handedTo"]?.string, h.hasPrefix("build:") { return "Build" }
        return nonEmpty(router["pick"]).map(agentWord) ?? "…"
    }

    public static func agentWords(_ run: JSONValue?) -> String {
        guard let run else { return "" }
        if agent(run) == "run step" { return "Build · run step" }
        if agent(run) == "build" { return "Build · turn \(run["turn"].flatMap { $0.isNull ? nil : $0.stringish } ?? "?")" }
        return agentWord(agent(run))
    }

    public static func agentLabel(_ run: JSONValue?) -> String {
        guard let run else { return "" }
        if agent(run) == "router" {
            if run["status"]?.string == "failed" { return "Bart couldn't route this" }
            let corrected = nonEmpty(run["corrected"]).map { ", corrected to \(agentWord($0))" } ?? ""
            let sure = run["by"]?.string != "rule" && run["sure"] != nil && !(run["sure"]!.isNull) ? " · \(s(run["sure"]))" : ""
            return "Bart → \(routedWord(run))\(corrected)\(sure)"
        }
        return "\(agentWords(run))\(run["routedBy"]?.string == "error" ? " · Bart failed to route" : "")"
    }

    /// The router's record for a run, from all of `runs`; nil for a later Build turn, a run step, a direct ask.
    public static func routerFor(_ run: JSONValue?, _ runs: [JSONValue]) -> JSONValue? {
        guard let run, agent(run) != "router", agent(run) != "run step" else { return nil }
        if agent(run) == "build" && run["turn"]?.double != 1 { return nil }
        if let from = nonEmpty(run["routedFrom"]) { return runs.first { agent($0) == "router" && s($0["id"]) == from } }
        if agent(run) == "build", let b = nonEmpty(run["buildId"]) { return runs.first { agent($0) == "router" && s($0["handedTo"]) == "build:\(b)" } }
        return nil
    }

    /// The line under "1. Classification".
    public static func classificationLine(_ router: JSONValue?, _ run: JSONValue? = nil) -> String {
        guard let router else { return "" }
        let went = run.map { agentWord(agent($0)) } ?? ""
        if router["status"]?.string == "failed" { return "Bart couldn't route this\(went.isEmpty ? "" : "; it went to \(went)")" }
        if let corrected = nonEmpty(router["corrected"]) ?? nonEmpty(run?["corrected"]) { return "Bart sent this to \(routedWord(router)); you changed it to \(agentWord(corrected))" }
        let sure = router["sure"].flatMap { $0.isNull ? nil : "\($0.stringish) sure" } ?? ""
        let why: String
        if router["by"]?.string == "rule" { why = "rule: \(nonEmpty(router["rule"]) ?? "?")" }
        else if let said = nonEmpty(router["said"]) { why = "the model said \(agentWord(said))\(sure.isEmpty ? "" : ", \(sure)")" }
        else { why = sure }
        return "Bart sent this to \(routedWord(router))\(why.isEmpty ? "" : " (\(why))")"
    }

    public static func turnLabel(_ run: JSONValue?) -> String {
        guard let run, agent(run) != "run step" else { return "" }
        if agent(run) == "router" { return (run["current"]?.truthy ?? false) ? "reply" : "first message" }
        if agent(run) == "build" { guard let t = run["turn"]?.double else { return "" }; return t > 1 ? "reply" : "first message" }
        guard let r = run["reply"]?.double, r.rounded() == r else { return "" }
        return r > 0 ? "reply \(Int(r) + 1)" : "first message"
    }

    public static func outcomeLabel(_ run: JSONValue?) -> String {
        guard let run else { return "" }
        if run["status"]?.string == "failed" { return "failed" }
        let climbed: Bool
        if let steps = run["steps"]?.array { climbed = steps.contains { $0["escalated"]?.truthy ?? false } }
        else { climbed = !buildAgents.contains(agent(run)) && (run["stepCount"]?.double ?? 0) > 1 }
        return run["ending"]?.string == "escalated" || climbed ? "escalated" : ""
    }

    public static func rowText(_ run: JSONValue?) -> String {
        let text = run.map { buildAgents.contains(agent($0)) ? (nonEmpty($0["title"]) ?? ($0["kind"]?.string == "quick" ? "quick task" : "")) : s($0["question"]) } ?? ""
        let line = re("\\s+").replace(text, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? "(empty line)" : line
    }

    public static func rowLine(_ run: JSONValue?, now: Double = systemNow()) -> String {
        guard let run else { return "" }
        return [agentLabel(run), timeLabel(run["at"]?.double, now: now), turnLabel(run), outcomeLabel(run)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The runs the list shows, newest first; a router's record left out when a listed run answered it, and a rule's pick.
    public static func listedRuns(_ runs: [JSONValue]) -> [JSONValue] {
        let others = runs.filter { agent($0) != "router" }
        let pointed = Set(others.compactMap { nonEmpty($0["routedFrom"]) })
        let builds = Set(others.filter { agent($0) == "build" }.compactMap { nonEmpty($0["buildId"]).map { "build:\($0)" } })
        let answered = { (r: JSONValue) in pointed.contains(s(r["id"])) || builds.contains(s(r["handedTo"])) }
        return runs.filter { agent($0) != "router" || $0["status"]?.string == "failed" || ($0["by"]?.string != "rule" && !answered($0)) }
            .enumerated().sorted { ($0.element["at"]?.double ?? 0) != ($1.element["at"]?.double ?? 0) ? ($0.element["at"]?.double ?? 0) > ($1.element["at"]?.double ?? 0) : $0.offset < $1.offset }
            .map(\.element)
    }

    public static func projectNames(_ runs: [JSONValue]) -> [String: String] {
        var names: [String: String] = [:]
        for run in runs { if let id = nonEmpty(run["projectId"]), let name = nonEmpty(run["projectName"]), names[id] == nil { names[id] = name } }
        return names
    }
    public static func projectOf(_ run: JSONValue?, _ names: [String: String] = [:]) -> String {
        nonEmpty(run?["projectName"]) ?? names[s(run?["projectId"])] ?? ""
    }
    public static func placeLabel(_ run: JSONValue, _ names: [String: String] = [:]) -> String {
        [projectOf(run, names), s(run["workspaceName"])].filter { !$0.isEmpty }.joined(separator: " / ")
    }

    /// The local day a run started on, "2026-10-13"; '' for none.
    public static func dayKey(_ at: Double?) -> String {
        guard let at, at != 0 else { return "" }
        let c = Calendar.current.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: at / 1000))
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    /// "Today", "Yesterday", else "Oct 11" (and the year when it is not this one).
    public static func dayLabel(_ key: String, now: Double = systemNow()) -> String {
        if key == dayKey(now) { return "Today" }
        let before = Calendar.current.date(byAdding: .day, value: -1, to: Date(timeIntervalSince1970: now / 1000))!
        if key == dayKey(before.timeIntervalSince1970 * 1000) { return "Yesterday" }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return key }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US")
        let thisYear = Calendar.current.component(.year, from: Date(timeIntervalSince1970: now / 1000))
        f.dateFormat = parts[0] == thisYear ? "MMM d" : "MMM d, yyyy"
        return f.string(from: date)
    }

    public static func filterRuns(_ runs: [JSONValue], _ filter: RunFilter = .all, names: [String: String]? = nil) -> [JSONValue] {
        let names = names ?? projectNames(runs)
        return runs.filter { run in
            (filter.project.isEmpty || projectOf(run, names) == filter.project)
                && (filter.workspace.isEmpty || s(run["workspaceName"]) == filter.workspace)
                && (filter.day.isEmpty || dayKey(run["at"]?.double) == filter.day)
        }
    }

    public static func filterOptions(_ runs: [JSONValue], _ filter: RunFilter = .all, names: [String: String]? = nil, now: Double = systemNow())
        -> (projects: [String], workspaces: [String], days: [(key: String, label: String)]) {
        let names = names ?? projectNames(runs)
        let sorted = { (values: [String]) in Array(Set(values.filter { !$0.isEmpty })).sorted { $0.localizedCompare($1) == .orderedAscending } }
        let days = Array(Set(runs.map { dayKey($0["at"]?.double) }.filter { !$0.isEmpty })).sorted().reversed().map { ($0, dayLabel($0, now: now)) }
        return (sorted(runs.map { projectOf($0, names) }), sorted(filterRuns(runs, RunFilter(project: filter.project), names: names).map { s($0["workspaceName"]) }), days)
    }

    public static func modelLabel(_ run: JSONValue) -> String {
        let label = [s(run["model"]), s(run["effort"])].filter { !$0.isEmpty }.joined(separator: " · ")
        return label.isEmpty ? (run["status"]?.string == "running" ? "starting" : "no model run") : label
    }

    /// The library rows a Create run kept, one a line ("Name · type · path"), then what it skipped; '(none)'.
    public static func createdLines(_ record: JSONValue?) -> String {
        let rows = record?["created"]?.array ?? [], skipped = record?["skipped"]?.array ?? []
        let kept = rows.isEmpty ? ["(none)"] : rows.map { [s($0["name"]), s($0["type"]), s($0["path"])].filter { !$0.isEmpty }.joined(separator: " · ") }
        return (kept + skipped.map { "skipped: \(s($0))" }).joined(separator: "\n")
    }

    /// A section's text, as `c` copies it: 'system', 'context', 'steps' or 'written'.
    public static func sectionText(_ record: JSONValue?, _ section: String) -> String {
        guard let record else { return "" }
        switch section {
        case "system": return s(record["system"])
        case "context": return contextBlocks(record).filter { !$0.text.isEmpty }.map { "===== \($0.label) (\(sizeLabel($0.text))) =====\n\($0.text)" }.joined(separator: "\n\n")
        case "steps":
            return (record["steps"]?.array ?? []).enumerated().map { n, step in
                var parts = ["===== step \(n + 1): \(nonEmpty(step["name"]) ?? s(step["model"])) (\(s(step["model"]))) at \(s(step["effort"]))\((step["escalated"]?.truthy ?? false) ? " · escalated" : "") =====",
                             "--- input ---", s(step["input"])]
                for tool in step["tools"]?.array ?? [] {
                    parts += ["--- tool: \(s(tool["name"])) ---", json(tool["input"])]
                    if let result = tool["result"], !result.isNull {
                        parts += ["--- result (\(s(result["size"])) chars\((result["error"]?.truthy ?? false) ? ", error" : "")) ---", s(result["excerpt"])]
                    } else { parts.append("--- no result yet ---") }
                }
                if let dropped = step["toolsDropped"], dropped.truthy { parts.append("--- \(s(dropped)) more tool calls, not kept ---") }
                parts += ["--- output ---", (step["output"]?.isNull ?? true) ? "(running)" : s(step["output"])]
                return parts.joined(separator: "\n")
            }.joined(separator: "\n\n")
        case "written": return writtenText(record)
        default: return ""
        }
    }

    static func escape(_ text: String?) -> String {
        (text ?? "").replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    static func pre(_ text: String?) -> String { "<pre>\(escape(text))</pre>" }
    static func details(_ summary: String, _ body: String, open: Bool = false) -> String { "<details\(open ? " open" : "")><summary>\(summary)</summary>\(body)</details>" }

    static func lastStep(_ record: JSONValue) -> JSONValue {
        guard let last = record["steps"]?.array?.last else { return record }
        return record.with("model", last["model"]).with("effort", last["effort"])
    }

    static func runHtml(_ record: JSONValue) -> String {
        var head = escape(runLabel(record))
        if let b = nonEmpty(record["buildId"]) { head += " · Build \(escape(b))" }
        if let e = nonEmpty(record["ending"]) { head += " · \(escape(e))" }
        head += " · \(escape(modelLabel(lastStep(record)))) · \(escape(s(record["status"]))) · \(escape(s(record["projectName"])))"
        if let w = nonEmpty(record["workspaceName"]) { head += " / \(escape(w))" }
        head += " · \(escape(isoString(record["at"]?.double ?? 0)))"
        if let ms = record["ms"]?.double { head += " · \(escape(msLabel(ms)))" }
        let steps = (record["steps"]?.array ?? []).enumerated().map { n, step -> String in
            let summary = "step \(n + 1): \(escape(nonEmpty(step["name"]) ?? s(step["model"]))) <span class=\"dim\">(\(escape(s(step["model"])))) · \(escape(s(step["effort"])))\(step["ms"]?.double.map { " · \(escape(msLabel($0)))" } ?? "")</span>\((step["escalated"]?.truthy ?? false) ? " <b>escalated</b>" : "")"
            let tools = step["tools"]?.array ?? []
            var body = details("input <span class=\"dim\">\(escape(sizeLabel(s(step["input"]))))</span>", pre(s(step["input"])))
            body += "<div class=\"sub\">tool calls (\(tools.count)\((step["toolsDropped"]?.truthy ?? false) ? ", and \(s(step["toolsDropped"])) more not kept" : ""))</div>"
            body += tools.map { tool -> String in
                let result = tool["result"].flatMap { $0.isNull ? JSONValue?.none : $0 }
                let dim = "\(tool["ms"]?.double.map { escape(msLabel($0)) } ?? "running")\(result.map { " · \(s($0["size"])) chars" } ?? "")\((result?["error"]?.truthy ?? false) ? " · error" : "")"
                return details("\(escape(s(tool["name"]))) <span class=\"dim\">\(dim)</span>",
                               "<div class=\"sub\">arguments</div>\(pre(json(tool["input"])))\(result.map { "<div class=\"sub\">result (first 2,000 characters)</div>\(pre(s($0["excerpt"])))" } ?? "")")
            }.joined()
            let output = (step["output"]?.isNull ?? true) ? "(running)" : s(step["output"])
            body += details("output <span class=\"dim\">\(escape(sizeLabel(s(step["output"]))))</span>", pre(output), open: true)
            return details(summary, body, open: true)
        }.joined()
        return "<section><h2>\(escape(firstWords(s(record["question"]), 16)))</h2><div class=\"dim\">\(head)</div>"
            + (nonEmpty(record["error"]).map { "<div class=\"error\">\(escape($0))</div>" } ?? "")
            + details("1 System prompt <span class=\"dim\">\(escape(sizeLabel(s(record["system"]))))</span>", pre(s(record["system"])))
            + details("2 Context", contextBlocks(record).map { details("\(escape($0.label)) <span class=\"dim\">\(escape(sizeLabel($0.text)))</span>", pre($0.text)) }.joined())
            + details("3 Steps (\((record["steps"]?.array ?? []).count))", steps, open: true)
            + details("4 Written", pre(writtenText(record)), open: true)
            + "</section>"
    }

    static let style = "body{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;margin:16px;max-width:1200px}h1{font-size:14px;margin:0 0 8px}h2{font-size:13px;margin:0 0 2px}section{border-top:1px solid #ccc;padding:10px 0}details{margin:3px 0 3px 12px}summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;border:1px solid #e3e3e3;padding:6px;margin:3px 0;max-height:none}.dim{color:#777}.sub{color:#555;margin:4px 0 0 12px}.error{color:#a00;border:1px solid #e6b8b8;padding:4px;margin:4px 0}"

    /// The exported page: `records` (whole runs), its title.
    public static func exportPage(_ records: [JSONValue], title: String = "Agent runs", now: Double = systemNow()) -> String {
        let data = JSONText.stringify(.array(records)).replacingOccurrences(of: "<", with: "\\u003c")
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>\(escape(title))</title><style>\(style)</style></head><body><h1>\(escape(title))</h1><div class=\"dim\">Exported from Engelbart's Agent Viewer, \(escape(isoString(now))). \(records.count) run\(records.count == 1 ? "" : "s").</div>\(records.map(runHtml).joined())<script type=\"application/json\" id=\"agent-runs\">\(data)</script></body></html>"
    }

    // MARK: asks (2026-10-12)

    public static func filterAsks(_ asks: [AgentAsk], _ filter: String) -> [AgentAsk] {
        if filter == "questions" { return asks.filter { $0.kind != "build" } }
        if filter == "builds" { return asks.filter { $0.kind == "build" } }
        return asks
    }

    public static func askText(_ text: String?) -> String {
        let line = re("\\s+").replace(re("!\\[[^\\]]*\\]\\([^)]*\\)").replace(text ?? "", with: " "), with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? "—" : line
    }

    public static func askTime(_ at: Double?, now: Double = systemNow()) -> String {
        guard let at, at != 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        if Calendar.current.isDate(date, inSameDayAs: Date(timeIntervalSince1970: now / 1000)) { return String(format: "%02d:%02d", c.hour!, c.minute!) }
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    public static func viaLabel(_ via: String, _ routedTo: String) -> String {
        switch via {
        case "--build": return "Typed directly (--build)"
        case "button": return "Typed directly (Build button)"
        case "panel": return "Typed directly (Build panel)"
        case "post-it": return "Typed directly (sticky)"
        default:
            let info = agentInfo(routedTo)
            return "Typed directly (\(info.unknown ? info.name : info.token))"
        }
    }

    public static func routerInputParts(_ input: String?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, tag) in [("workspace", "workspace"), ("section", "section"), ("threads", "threads"), ("specAbove", "spec_above"), ("line", "line")] {
            if let m = re("<\(tag)>\\n?([\\s\\S]*?)\\n?</\(tag)>").groups(input ?? ""), let v = m[1] { out[key] = v }
        }
        return out
    }

    /// The card a Brainstorm run wrote (its fenced JSON block) → (type, title, items, say), or nil.
    public static func cardOf(_ record: JSONValue?) -> (type: String, title: String, items: [String], say: String)? {
        var text = writtenText(record)
        if text.isEmpty { text = (record?["steps"]?.array ?? []).map { s($0["output"]) }.last ?? "" }
        let body = re("```[a-z]*\\n([\\s\\S]*?)\\n```").groups(text)?[1] ?? text
        guard let start = body.firstIndex(of: "{"), let end = body.lastIndex(of: "}"), start < end,
              let card = try? JSONValue.parse(String(body[start...end])), card.object != nil, let kind = nonEmpty(card["card"]) else { return nil }
        let group = card[kind]?.object != nil ? card[kind]! : .object([:])
        let items = (group["items"]?.array ?? []).map { [s($0["title"]), nonEmpty($0["type"]).map { "(\($0))" } ?? ""].filter { !$0.isEmpty }.joined(separator: " ") }
        let title = nonEmpty(group["title"]) ?? nonEmpty(card["title"]) ?? nonEmpty(group["items"]?.array?.first?["title"]) ?? ""
        return (kind, title, items, card["say"]?.string ?? "")
    }

    public static func cardText(_ card: (type: String, title: String, items: [String], say: String)?) -> String {
        guard let card else { return "" }
        return (["┌ card: \(card.type)\(card.title.isEmpty ? "" : " · \(card.title)")"] + (card.say.isEmpty ? [] : ["│ \(card.say)"]) + card.items.map { "│ - \($0)" } + ["└"]).joined(separator: "\n")
    }

    static func stepLabel(_ step: JSONValue, _ n: Int) -> String {
        let name = nonEmpty(step["name"]) ?? nonEmpty(step["model"]) ?? "?"
        let model = s(step["model"])
        return "step \(n + 1): \(name)\(!model.isEmpty && nonEmpty(step["name"]) != nil && model != s(step["name"]) ? " (\(model))" : "")\(nonEmpty(step["effort"]).map { " · \($0)" } ?? "")\(step["ms"]?.double.map { " · \(msLabel($0))" } ?? "")\((step["escalated"]?.truthy ?? false) ? " · escalated" : "")"
    }

    public static func tokShort(_ n: Int) -> String { n < 1000 ? String(n) : n < 10000 ? String(format: "%.1fk", Double(n) / 1000) : "\(Int((Double(n) / 1000).rounded()))k" }
    static func tok(_ text: String) -> String { "\(tokShort(tokens(text))) tok" }
    public static func oneLine(_ text: String?, _ n: Int = 80) -> String {
        let line = re("\\s+").replace(text ?? "", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return line.count > n ? "\(line.prefix(n - 1))…" : line
    }

    static func argString(_ v: JSONValue?) -> String {
        if let a = v?.array { return a.map(\.stringish).joined(separator: " ") }
        return v?.string ?? ""
    }
    static let commandKeys = ["command", "cmd"]
    static let argKeys = ["command", "cmd", "file_path", "path", "url", "pattern", "query", "notebook_path", "description", "prompt"]

    /// A tool call's argument summary for its row → (text, command).
    public static func toolArg(_ tool: JSONValue?) -> (text: String, command: Bool) {
        let input = tool?["input"]
        if let s = input?.string { return (oneLine(s), false) }
        let held = input?.object != nil ? input! : .object([:])
        let name = s(tool?["name"])
        let pick = { (keys: [String]) -> (key: String, value: String)? in
            for key in keys { let v = argString(held[key]); if !v.isEmpty { return (key, v) } }
            return nil
        }
        var found: (key: String, value: String)?
        if name == "Bash" { found = pick(commandKeys) }
        else if name == "Read" { found = pick(["file_path", "path"]) }
        else if name == "Grep" || name == "Glob" {
            let pattern = argString(held["pattern"]), at = argString(held["path"])
            found = !pattern.isEmpty ? ("pattern", at.isEmpty ? pattern : "\(pattern) in \(at)") : pick(["path"])
        } else if name == "WebFetch" { found = pick(["url"]) }
        if found == nil { found = pick(argKeys) }
        if found == nil { if let first = (held.object ?? [:]).keys.sorted().map({ argString(held[$0]) }).first(where: { !$0.isEmpty }) { found = ("", first) } }
        guard let found else { return ("", false) }
        return (oneLine(found.value), commandKeys.contains(found.key))
    }

    static func toolText(_ tool: JSONValue) -> String {
        let result = tool["result"].flatMap { $0.isNull ? JSONValue?.none : $0 }
        var lines = ["arguments", json(tool["input"]).isEmpty ? "(none)" : json(tool["input"]), ""]
        if let result {
            let size = result["size"]?.double ?? 0
            lines.append("result · \(grouped(Int(size))) chars\((result["error"]?.truthy ?? false) ? " · error" : "")\(Double(jsLength(s(result["excerpt"]))) < size ? " (first 2,000)" : "")")
            lines.append(s(result["excerpt"]))
        } else { lines.append("no result yet") }
        return lines.joined(separator: "\n")
    }

    static func toolNodes(_ step: JSONValue) -> [RunNode] {
        var nodes = (step["tools"]?.array ?? []).map { tool -> RunNode in
            let arg = toolArg(tool)
            let result = tool["result"].flatMap { $0.isNull ? JSONValue?.none : $0 }
            let dim = [tool["ms"]?.double.map(msLabel) ?? "running", result.map { "\(grouped(Int($0["size"]?.double ?? 0))) chars" } ?? "", (result?["error"]?.truthy ?? false) ? "error" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
            return RunNode(label: s(tool["name"]), dim: dim, arg: arg.text, command: arg.command, tool: true, text: toolText(tool))
        }
        if let dropped = step["toolsDropped"], dropped.truthy { nodes.append(RunNode(label: "\(s(dropped)) more tool calls, not kept", plain: true)) }
        return nodes
    }

    static func outputNode(_ step: JSONValue) -> RunNode {
        let done = !(step["output"]?.isNull ?? true)
        return RunNode(label: "raw output", dim: sizeLabel(s(step["output"])), text: done ? s(step["output"]) : "(running)", open: done)
    }

    static func promptNode(_ record: JSONValue) -> RunNode {
        RunNode(label: "System prompt\(nonEmpty(record["promptSource"]).map { " (\($0))" } ?? "")", dim: sizeLabel(s(record["system"])), text: s(record["system"]))
    }

    static func blockNodes(_ record: JSONValue) -> [RunNode] {
        contextBlocks(record).filter { !$0.text.isEmpty }.map { RunNode(label: $0.label, dim: sizeLabel($0.text), text: $0.text) }
    }

    /// An ask's records sorted out: the router's, the asks it handed over, a Build's turns and run steps.
    public static func pipelineOf(_ ask: JSONValue?) -> (router: JSONValue?, turns: [JSONValue], runSteps: [JSONValue], runs: [JSONValue], agent: AgentInfo) {
        let records = (ask?["records"]?.array ?? []).filter { !$0.isNull }
        let at = { (r: JSONValue) in r["at"]?.double ?? 0 }
        let byTurn = { (a: JSONValue, b: JSONValue) -> Bool in
            let ta = a["turn"]?.double ?? 0, tb = b["turn"]?.double ?? 0
            return ta != tb ? ta < tb : at(a) < at(b)
        }
        return (records.first { agent($0) == "router" }, records.filter { agent($0) == "build" }.sorted(by: byTurn),
                records.filter { agent($0) == "run step" }.sorted(by: byTurn),
                records.filter { !["router", "build", "run step"].contains(agent($0)) }.sorted { at($0) < at($1) }, agentInfo(ask.flatMap { nonEmpty($0["routedTo"]) }))
    }

    /// Where the line was typed, in names: "Engelbart / oct-12", "Engelbart / note Ideas in oct-12", "… / a highlight in X, page 3".
    public static func whereLabel(_ ask: JSONValue?, _ first: JSONValue = .object([:])) -> String {
        let place = ask?["place"] ?? .object([:]), names = ask?["names"] ?? .object([:])
        let ref = place["ref"].flatMap { $0.object != nil ? $0 : JSONValue?.none }
        let project = nonEmpty(names["project"]) ?? s(first["projectName"])
        let workspace = nonEmpty(names["workspace"]) ?? s(first["workspaceName"])
        var spot = ""
        if ref?["kind"]?.string == "note" { spot = "note\(nonEmpty(names["note"]).map { " \($0)" } ?? "")\(workspace.isEmpty ? "" : " in \(workspace)")" }
        else if ref?["kind"]?.string == "mark" { spot = "a highlight\(nonEmpty(names["paper"]).map { " in \($0)" } ?? "")\(ref!["page"].flatMap { $0.truthy ? ", page \($0.stringish)" : nil } ?? "")" }
        else { spot = workspace.isEmpty ? (ref != nil ? "workspace" : "") : workspace }
        return [project, spot].filter { !$0.isEmpty }.joined(separator: " / ")
    }

    static func modelShort(_ step: JSONValue?) -> String {
        guard let step else { return "" }
        return [nonEmpty(step["name"]) ?? s(step["model"]), s(step["effort"])].filter { !$0.isEmpty }.joined(separator: " ")
    }
    static func toolCount(_ record: JSONValue) -> Int {
        (record["steps"]?.array ?? []).reduce(0) { $0 + ($1["tools"]?.array?.count ?? 0) + Int($1["toolsDropped"]?.double ?? 0) }
    }
    static func plural(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }

    static func routerShort(_ router: JSONValue) -> (to: String, parts: [String], failed: Bool) {
        let step = router["steps"]?.array?.first
        let to = s(router["handedTo"]).hasPrefix("build:") ? "Build" : agentInfo(nonEmpty(router["corrected"]) ?? nonEmpty(router["pick"]) ?? "chat").name
        let rule = router["by"]?.string == "rule"
        let parts = [rule ? "rule: \(nonEmpty(router["rule"]) ?? "?")" : (router["sure"].flatMap { $0.isNull ? nil : "sure \($0.stringish)" } ?? ""),
                     rule ? "" : modelShort(step), router["ms"]?.double.map(msLabel) ?? ""].filter { !$0.isEmpty }
        return (to, parts, router["status"]?.string == "failed")
    }

    static func outputSummary(_ ask: JSONValue, turns: [JSONValue], runs: [JSONValue]) -> String {
        let status = s(ask["status"])
        if s(ask["routedTo"]) == "build" {
            guard let turn = turns.last else { return status == "running" ? "not started" : "nothing run" }
            let ts = nonEmpty(turn["status"]) ?? status
            return ["turn \(turn["turn"].flatMap { $0.isNull ? nil : $0.stringish } ?? "?")", plural(toolCount(turn), "tool"), ts,
                    turn["status"]?.string != "running" ? (turn["ms"]?.double.map(msLabel) ?? "") : ""].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        guard let last = runs.last else { return status == "running" ? "not started" : "nothing run" }
        let tools = runs.reduce(0) { $0 + toolCount($1) }
        return [runs.count > 1 ? plural(runs.count, "run") : "", plural(tools, "tool"), nonEmpty(last["status"]) ?? status,
                last["status"]?.string != "running" ? (last["ms"]?.double.map(msLabel) ?? "") : ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func inputSummary(_ record: JSONValue?) -> String {
        guard let record else { return "nothing sent yet" }
        let blocks = contextBlocks(record).filter { !$0.text.isEmpty }
        let total = blocks.reduce(0) { $0 + tokens($1.text) }
        let largest = blocks.max { tokens($0.text) < tokens($1.text) }
        let system = nonEmpty(record["system"]).map { "system \(tok($0))" } ?? ""
        let context = blocks.isEmpty ? "no context" : "context \(tokShort(total)) tok\(blocks.count > 1 && largest != nil ? " (most in \(largest!.label), \(tokShort(tokens(largest!.text))))" : "")"
        return [system, context].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The ask's pipeline on one line: "you → Bart: Build (0.85 · Haiku low · 3.4 s) → Build turn 1 · 14 tools · running".
    public static func pipelineLine(_ ask: JSONValue?) -> String {
        guard let ask else { return "" }
        let p = pipelineOf(ask)
        let out = outputSummary(ask, turns: p.turns, runs: p.runs)
        if let router = p.router {
            let short = routerShort(router)
            let how = short.parts.map { $0.hasPrefix("sure ") ? String($0.dropFirst(5)) : $0 }.joined(separator: " · ")
            return "you → Bart: \(short.to)\(how.isEmpty ? "" : " (\(how))") → \(p.agent.name)\(out.hasPrefix("turn ") ? " " : " · ")\(out)"
        }
        let unrouted = (p.runs + p.turns).contains { $0["routedBy"]?.string == "error" }
        return "you → \(p.agent.name) (\(unrouted ? "Bart failed to route" : "typed directly")) → \(out)"
    }

    /// The right side's four sections for an ask with its records whole.
    public static func askSections(_ ask: JSONValue?) -> [RunSection] {
        guard let ask else { return [] }
        let p = pipelineOf(ask)
        let first = p.router ?? p.runs.first ?? p.turns.first ?? p.runSteps.first ?? .object([:])
        let place = ask["place"] ?? .object([:])
        let whereText = whereLabel(ask, first)
        let lineNo = place["line"].flatMap { $0.isNull ? nil : "line \(Int($0.double ?? 0) + 1)" } ?? ""
        let typed = place["text"].flatMap { $0.isNull ? nil : $0.stringish } ?? s(first["question"])
        var input = [RunNode(label: "The line as typed", text: typed),
                     RunNode(label: "Where", dim: [whereText.isEmpty ? "—" : whereText, lineNo].filter { !$0.isEmpty }.joined(separator: " · "), plain: true),
                     RunNode(label: "id", dim: s(ask["id"]), plain: true)]
        if let router = p.router {
            let parts = routerInputParts(router["context"]?["input"]?.string)
            let threads = router["threads"]?.array ?? []
            let threadText = threads.isEmpty ? "(none)" : threads.map { "@\(s($0["agent"])), \(s($0["up"])) lines up: \(JSONText.stringify($0["question"] ?? .null))" }.joined(separator: "\n")
            var children = [parts["section"].map { RunNode(label: "section", dim: sizeLabel($0), text: $0) }
                            ?? RunNode(label: "section", dim: "\(grouped(Int(router["sectionSize"]?.double ?? 0))) chars (not kept: a rule picked, so no model was sent it)", plain: true),
                            RunNode(label: "threads", dim: "\(threads.count) · \(sizeLabel(threadText))", text: threadText),
                            RunNode(label: "spec above", dim: (router["specAbove"]?.truthy ?? false) ? "yes" : "no", plain: true)]
            if let all = nonEmpty(router["context"]?["input"]) { children.append(RunNode(label: "everything it was sent", dim: sizeLabel(all), text: all)) }
            input.append(RunNode(label: "What Bart (classifier) saw", children: children))
        }
        let shortWhere = whereText.isEmpty ? "" : (whereText.components(separatedBy: " / ").last ?? whereText)
        let inputSum = [oneLine(askText(typed), 60), [shortWhere, lineNo].filter { !$0.isEmpty }.joined(separator: " · ")].filter { !$0.isEmpty }.joined(separator: " · ")
        var classified: [RunNode], classifiedSum: String
        let routedTo = s(ask["routedTo"])
        if let router = p.router {
            let step = router["steps"]?.array?.first
            let short = routerShort(router)
            let picked = s(router["handedTo"]).hasPrefix("build:") ? "Build" : agentInfo(nonEmpty(router["pick"]) ?? "chat").name
            let dim = [router["sure"].flatMap { $0.isNull ? nil : "sure \($0.stringish)" } ?? "",
                       router["by"]?.string == "rule" ? "rule: \(nonEmpty(router["rule"]) ?? "?")" : (step.map { "model: \(nonEmpty($0["name"]) ?? s($0["model"])) · \(s($0["effort"]))" } ?? "model"),
                       router["ms"]?.double.map(msLabel) ?? "", (router["unread"]?.truthy ?? false) ? "reply not read: chat" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
            classified = [RunNode(label: "Picked \(picked)", dim: dim, plain: true)]
            if let c = nonEmpty(router["corrected"]) { classified.append(RunNode(label: "changed to \(agentInfo(c).name)", plain: true)) }
            if let h = nonEmpty(router["handedTo"]) { classified.append(RunNode(label: "handed to", dim: h, plain: true)) }
            if let e = nonEmpty(router["error"]) { classified.append(RunNode(label: "error", error: e)) }
            if let step, !(step["output"]?.isNull ?? true) { classified.append(outputNode(step)) }
            classifiedSum = ([short.to] + short.parts + (nonEmpty(router["error"]) != nil ? ["error"] : [])).joined(separator: " · ")
        } else {
            let unrouted = (p.runs + p.turns).first { $0["routedBy"]?.string == "error" }
            if let unrouted {
                classified = [RunNode(label: "Bart (classifier) failed: sent to \(agentInfo(routedTo).name) as the fallback, not Bart's pick", plain: true)]
                if let e = nonEmpty(unrouted["routeError"]) { classified.append(RunNode(label: "error", error: e)) }
                classifiedSum = "failed · sent to \(agentInfo(routedTo).name)"
            } else {
                classified = [RunNode(label: viaLabel(s(ask["via"]), routedTo), plain: true)]
                classifiedSum = ["--build", "button", "panel", "post-it"].contains(s(ask["via"])) ? viaLabel(s(ask["via"]), routedTo).replacingOccurrences(of: "Typed", with: "typed") : "typed directly"
            }
        }
        var agentIn: [RunNode] = [], agentOut: [RunNode] = []
        let failed = (p.runs + p.turns + p.runSteps).filter { nonEmpty($0["error"]) != nil && ($0["status"]?.string == "failed" || $0["status"]?.string == "stopped") }
        if routedTo == "build" {
            if let firstTurn = p.turns.first {
                agentIn.append(promptNode(firstTurn))
                agentIn.append(RunNode(label: "turn \(nonEmpty(firstTurn["turn"]) ?? "1"): context", dim: tok(blockNodes(firstTurn).map { $0.text ?? "" }.joined()), children: blockNodes(firstTurn)))
            }
            for turn in p.turns.dropFirst() { agentIn.append(RunNode(label: "turn \(s(turn["turn"])): what it was sent", children: blockNodes(turn))) }
            agentOut = p.turns.map { turn in
                RunNode(label: "turn \(turn["turn"].flatMap { $0.isNull ? nil : $0.stringish } ?? "?")",
                        dim: [modelLabel(lastStep(turn)), plural(toolCount(turn), "tool"), s(turn["status"]), nonEmpty(turn["ending"]).map { "ending: \($0)" } ?? ""].filter { !$0.isEmpty }.joined(separator: " · "),
                        children: (nonEmpty(turn["error"]).map { [RunNode(label: "error", error: $0)] } ?? []) + (turn["steps"]?.array ?? []).flatMap { toolNodes($0) + [outputNode($0)] })
            }
            for run in p.runSteps {
                let runnables = run["written"]?.array ?? []
                let text = runnables.isEmpty ? "(none yet)" : runnables.map { "\(s($0["name"])): \(s($0["status"]))\(($0["passed"]?.truthy ?? false) ? " · passed" : "")\(nonEmpty($0["error"]).map { "\n  last error: \($0)" } ?? "")" }.joined(separator: "\n")
                agentOut.append(RunNode(label: "Run step\(run["turn"].flatMap { $0.isNull ? nil : " (after turn \($0.stringish))" } ?? "")", dim: s(run["status"]),
                                        children: (nonEmpty(run["error"]).map { [RunNode(label: "error", error: $0)] } ?? []) + (run["steps"]?.array ?? []).flatMap(toolNodes) + [RunNode(label: "runnables", text: text)]))
            }
        } else {
            for (n, run) in p.runs.enumerated() {
                let again = p.runs.count > 1 ? " (run \(n + 1)\(n > 0 ? ", asked again" : ""))" : ""
                agentIn.append(promptNode(run))
                agentIn.append(RunNode(label: "context\(again)", dim: tok(blockNodes(run).map { $0.text ?? "" }.joined()), children: blockNodes(run)))
                agentIn += (run["steps"]?.array ?? []).enumerated().map { RunNode(label: stepLabel($1, $0), dim: sizeLabel(s($1["input"])), text: s($1["input"])) }
                let card = agent(run) == "brainstorm" ? cardOf(run) : nil
                var children = (run["steps"]?.array ?? []).enumerated().map { RunNode(label: stepLabel($1, $0), children: toolNodes($1) + [outputNode($1)]) }
                if let card { children.append(RunNode(label: "the card it wrote", text: cardText(card))) }
                if agent(run) == "create" { children.append(RunNode(label: "kept in the library", dim: "\((run["created"]?.array ?? []).count) rows", text: createdLines(run))) }
                children.append(RunNode(label: "what was written", dim: sizeLabel(writtenText(run)), text: writtenText(run)))
                agentOut.append(RunNode(label: "\(agentInfo(agent(run)).name)\(again)", dim: [plural(toolCount(run), "tool"), s(run["status"]), run["ms"]?.double.map(msLabel) ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), children: children))
            }
        }
        if !failed.isEmpty { agentOut.insert(contentsOf: failed.map { RunNode(label: $0["status"]?.string == "stopped" ? "Stopped" : "Failed", error: s($0["error"])) }, at: 0) }
        let status = s(ask["status"])
        if agentIn.isEmpty { agentIn.append(RunNode(label: status == "running" ? "Not started yet" : "Nothing was run", plain: true)) }
        if agentOut.isEmpty { agentOut.append(RunNode(label: status == "running" ? "Running…" : "Nothing was written", plain: true)) }
        let name = p.agent.name
        return [
            RunSection(key: "1", title: "1 Input", summary: inputSum, nodes: input),
            RunSection(key: "2", title: "2 \(agents[0].name)", summary: classifiedSum, nodes: classified),
            RunSection(key: "3", title: "3 \(name) input", summary: inputSummary(routedTo == "build" ? p.turns.first : p.runs.first), nodes: agentIn),
            RunSection(key: "4", title: "4 \(name) output", summary: [failed.isEmpty ? "" : (failed[0]["status"]?.string == "stopped" ? "stopped" : "failed"), outputSummary(ask, turns: p.turns, runs: p.runs)].filter { !$0.isEmpty }.joined(separator: " · "), nodes: agentOut),
        ]
    }

    /// An ask's sections as plain text (`c` copies the open section).
    public static func nodesText(_ nodes: [RunNode], depth: Int = 0) -> String {
        let pad = String(repeating: "  ", count: depth)
        return nodes.map { node in
            var parts = ["\(pad)\(node.error.map { "! \(node.label): \($0)" } ?? node.label)\(node.arg.flatMap { $0.isEmpty ? nil : " \($0)" } ?? "")\(node.dim.flatMap { $0.isEmpty ? nil : " (\($0))" } ?? "")"]
            if let text = node.text, !text.isEmpty { parts.append(text) }
            if let children = node.children { parts.append(nodesText(children, depth: depth + 1)) }
            return parts.joined(separator: "\n")
        }.joined(separator: "\n")
    }

    static func nodeHtml(_ node: RunNode) -> String {
        if let error = node.error { return "<div class=\"error\">\(escape(node.label)): \(escape(error))</div>" }
        let arg = node.arg.flatMap { $0.isEmpty ? nil : " \(node.command ? "<code>\(escape($0))</code>" : escape($0))" } ?? ""
        let head = "\(escape(node.label))\(arg)\(node.dim.flatMap { $0.isEmpty ? nil : " <span class=\"dim\">\(escape($0))</span>" } ?? "")"
        if node.plain { return "<div class=\"sub\">\(head)</div>" }
        return details(head, "\(node.text.map(pre) ?? "")\((node.children ?? []).map(nodeHtml).joined())", open: node.open)
    }

    /// The exported page of one ask: its four sections, every record of it whole in the page's data.
    public static func exportAsk(_ ask: JSONValue?, now: Double = systemNow()) -> String {
        let records = ask?["records"]?.array ?? []
        let title = "Agent Viewer · \(askText(ask?["text"]?.stringish))"
        let data = JSONText.stringify(ask ?? .null).replacingOccurrences(of: "<", with: "\\u003c")
        let sections = askSections(ask).map { details("\(escape($0.title))\($0.summary.isEmpty ? "" : " <span class=\"dim\">\(escape($0.summary))</span>")", $0.nodes.map(nodeHtml).joined(), open: true) }.joined()
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>\(escape(title))</title><style>\(style)</style></head><body><h1>\(escape(title))</h1><div class=\"dim\">Exported from Engelbart's Agent Viewer, \(escape(isoString(now))). \(escape(pipelineLine(ask))) · \(records.count) record\(records.count == 1 ? "" : "s").</div><section>\(sections)</section>\(records.map(runHtml).joined())<script type=\"application/json\" id=\"agent-ask\">\(data)</script></body></html>"
    }
}
