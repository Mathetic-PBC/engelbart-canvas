import Foundation
import CryptoKit
import EngelbartCore

// runlog.cjs — the Agent map's record of each @bart, @brainstorm, @discover and @create run, and the router's picks
// (2026-10-12; a window for developers only): what the agent was told (its system prompt and each block of context), what
// each model step was sent, the tools it called with their arguments and a piece of each result, what each step said,
// and what was written. Build turns and run steps are recorded the same way (the Build package keeps its own log).
//
// Kept in <userData>/agent-runs.jsonl, one JSON object a line, the last `maxRuns` runs: a run is written when it starts
// and again when it ends (a later line for the same id wins), and what happens between stays in memory. A system prompt
// is written once, by its hash, on a line of its own ({ prompt, text }); a run names it by `systemHash`. The file is
// written out again, without what was trimmed, when it holds twice as many lines as it keeps. The log never stands in a
// run's way: every call returns at once and never throws, and the file is written in the background.

public enum ToolCalls {
    public static let excerpt = 2000
    /// The tool calls one step keeps; the rest are counted in the step's `toolsDropped`.
    public static let maxTools = 1000

    /// A tool result's text, from Claude's content (a string, or blocks of text and images) or Codex's output.
    public static func resultText(_ content: JSONValue?) -> String {
        guard let content, !content.isNull else { return "" }
        if case .string(let s) = content { return s }
        if case .array(let a) = content {
            return a.map { b -> String in
                if case .string(let s) = b { return s }
                if b["type"]?.string == "text" { return b["text"]?.string ?? "" }
                if let t = b["type"]?.string, !t.isEmpty { return "[\(t)]" }
                return OJ(b).stringify()
            }.joined(separator: "\n")
        }
        return OJ(content).stringify()
    }

    static func excerptOf(_ content: JSONValue?) -> [(String, OJ)] {
        let text = resultText(content)
        return [("size", .number(Double(text.jsLength))), ("excerpt", .string(text.jsSlice(0, excerpt)))]
    }

    public struct Call {
        public var id: String
        public var name: String?
        /// nil = undefined (not said by this event); .null = said, none.
        public var input: OJ?
        public var result: OJ?
        public var done: Bool = false
    }

    /// The tool calls one raw stream event adds or completes; [] for any other event.
    public static func of(_ event: JSONValue) -> [Call] {
        guard event.object != nil else { return [] }
        let blocks = event["message"]?["content"]?.array ?? []
        if event["type"]?.string == "assistant" {
            return blocks.filter { $0["type"]?.string == "tool_use" }.map { b in
                Call(id: b["id"].flatMap(Activity.textOf) ?? "", name: b["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "tool", input: b["input"].map(OJ.init) ?? .null)
            }
        }
        if event["type"]?.string == "user" {
            return blocks.filter { $0["type"]?.string == "tool_result" }.map { b in
                var r = excerptOf(b["content"])
                if b["is_error"]?.bool == true { r.append(("error", true)) }
                return Call(id: b["tool_use_id"].flatMap(Activity.textOf) ?? "", name: nil, input: nil, result: .object(r), done: true)
            }
        }
        guard let type = event["type"]?.string, type == "item.started" || type == "item.completed", let item = event["item"], item.object != nil else { return [] }
        let done = type == "item.completed", id = item["id"].flatMap(Activity.textOf) ?? ""
        switch item["type"]?.string {
        case "command_execution":
            var call = Call(id: id, name: "command", input: ["command": item["command"].map(OJ.init) ?? .null])
            if done {
                var r = excerptOf(item["aggregated_output"])
                if let code = item["exit_code"], !code.isNull { r.append(("exitCode", OJ(code))) }
                if item["status"]?.string == "failed" { r.append(("error", true)) }
                call.result = .object(r); call.done = true
            }
            return [call]
        case "web_search":
            let action = item["action"]?.object != nil ? item["action"] : nil
            let query = item["query"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? action?["query"]?.string ?? ""
            var input: [(String, OJ)] = [("query", .string(query))]
            if let action { input.append(("action", OJ(action))) }
            var call = Call(id: id, name: "web_search", input: .object(input))
            if done { call.result = .object(excerptOf(item["result"].flatMap { $0.isNull ? nil : $0 } ?? .string(""))); call.done = true }
            return [call]
        case "mcp_tool_call":
            var args = item["arguments"].map(OJ.init)
            if case .string(let s)? = args, let parsed = OJ.parse(s) { args = parsed }
            let failed = (item["error"] != nil && !(item["error"]!.isNull)) || item["status"]?.string == "failed"
            let server = item["server"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "mcp"
            let tool = item["tool"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "tool"
            var call = Call(id: id, name: "\(server).\(tool)", input: args ?? .null)
            if done {
                let content: JSONValue? = failed ? (item["error"]?["message"].flatMap { $0.isNull ? nil : $0 } ?? item["error"]) : item["result"]
                var r = excerptOf(content)
                if failed { r.append(("error", true)) }
                call.result = .object(r); call.done = true
            }
            return [call]
        default: return []
        }
    }
}

/// The Agent map's log (runlog.cjs createRunLog).
public final class RunLog: @unchecked Sendable {
    final class Tool { var id: String; var name: String; var input: OJ; var at: Double; var result: OJ?; var ms: Double?
        init(id: String, name: String, input: OJ, at: Double) { self.id = id; self.name = name; self.input = input; self.at = at } }
    final class StepRec { var fields: [(String, OJ)]; var tools: [Tool] = []; var output: OJ = .null; var escalated = false; var ms: Double?; var toolsDropped = 0
        init(_ fields: [(String, OJ)]) { self.fields = fields }
        var at: Double { fields.first { $0.0 == "at" }?.1.double ?? 0 }
        var json: OJ {
            var o = fields
            o.append(("tools", .array(tools.map { t in
                var p: [(String, OJ)] = [("id", .string(t.id)), ("name", .string(t.name)), ("input", t.input), ("at", .number(t.at))]
                if let r = t.result { p.append(("result", r)) }
                if let ms = t.ms { p.append(("ms", .number(ms))) }
                return .object(p)
            })))
            o += [("output", output), ("escalated", .bool(escalated))]
            if let ms { o.append(("ms", .number(ms))) }
            if toolsDropped > 0 { o.append(("toolsDropped", .number(Double(toolsDropped)))) }
            return .object(o)
        }
    }
    final class Record { var fields: [(String, OJ)]; var steps: [StepRec]
        init(fields: [(String, OJ)], steps: [StepRec] = []) { self.fields = fields; self.steps = steps }
        subscript(key: String) -> OJ? {
            get { key == "steps" ? .array(steps.map { $0.json }) : fields.first { $0.0 == key }?.1 }
            set {
                guard key != "steps" else { return }
                if let i = fields.firstIndex(where: { $0.0 == key }) { if let v = newValue { fields[i].1 = v } else { fields.remove(at: i) } }
                else if let v = newValue { fields.append((key, v)) }
            }
        }
        var json: OJ { .object(fields.map { $0.0 == "steps" ? ("steps", .array(steps.map { $0.json })) : $0 }) }
    }

    static let big: Set<String> = ["system", "context", "steps", "written"]

    let file: URL?
    let onChange: (OJ) -> Void
    let maxRuns: Int
    let now: () -> Double
    private var runs: [Record] = [] // oldest first
    private var prompts: [String: String] = [:]
    private var written = Set<String>()
    private var lines = 0
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "engelbart.bart.runlog")

    public init(file: URL? = nil, onChange: @escaping (OJ) -> Void = { _ in }, maxRuns: Int = 300, now: @escaping () -> Double = { Time.ms() }) {
        self.file = file; self.onChange = onChange; self.maxRuns = maxRuns; self.now = now
        guard let file, let data = FileManager.default.contents(atPath: file.path) else { return }
        for line in String(decoding: data, as: UTF8.self).components(separatedBy: "\n") where !line.jsTrim.isEmpty {
            lines += 1
            guard let value = OJ.parse(line), value.isObject else { continue }
            if let hash = value["prompt"]?.string, let text = value["text"]?.string { prompts[hash] = text; written.insert(hash) }
            else if let run = value["run"], run.isObject, let id = run["id"]?.string {
                runs.removeAll { $0["id"]?.string == id }
                runs.append(Self.record(from: run))
            }
        }
        // A run the app quit in the middle of never finished.
        for r in runs where r["status"]?.string == "running" { r["status"] = "stopped" }
        while runs.count > maxRuns { runs.removeFirst() }
    }

    static func record(from run: OJ) -> Record {
        let steps = (run["steps"]?.array ?? []).map { s -> StepRec in
            let rec = StepRec((s.pairs ?? []).filter { !["tools", "output", "escalated", "ms", "toolsDropped"].contains($0.0) })
            rec.tools = (s["tools"]?.array ?? []).map { t in
                let tool = Tool(id: t["id"]?.string ?? "", name: t["name"]?.string ?? "", input: t["input"] ?? .null, at: t["at"]?.double ?? 0)
                tool.result = t["result"]; tool.ms = t["ms"]?.double
                return tool
            }
            rec.output = s["output"] ?? .null
            rec.escalated = s["escalated"]?.bool ?? false
            rec.ms = s["ms"]?.double
            rec.toolsDropped = Int(s["toolsDropped"]?.double ?? 0)
            return rec
        }
        return Record(fields: run.pairs ?? [], steps: steps)
    }

    static func hashOf(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    func summary(_ r: Record) -> OJ {
        var o = r.fields.filter { !RunLog.big.contains($0.0) }
        if let last = r.steps.last {
            for key in ["model", "effort"] {
                let v = last.fields.first { $0.0 == key }?.1 ?? .null
                if let i = o.firstIndex(where: { $0.0 == key }) { o[i].1 = v } else { o.append((key, v)) }
            }
        }
        func put(_ k: String, _ v: OJ) { if let i = o.firstIndex(where: { $0.0 == k }) { o[i].1 = v } else { o.append((k, v)) } }
        put("stepCount", .number(Double(r.steps.count)))
        put("toolCount", .number(Double(r.steps.reduce(0) { $0 + $1.tools.count })))
        let dropped = r.steps.reduce(0) { $0 + $1.toolsDropped }
        if dropped > 0 { put("toolsDropped", .number(Double(dropped))) }
        return .object(o)
    }

    private func changed(_ r: Record) { let s = summary(r); onChange(s) }

    private func later(_ work: @escaping () -> Void) { queue.async(execute: work) }

    private func rewrite() {
        guard let file else { return }
        let keep = runs
        var used: [String] = []
        for r in keep { if let h = r["systemHash"]?.string, !used.contains(h) { used.append(h) } }
        let promptLines = used.filter { prompts[$0] != nil }.map { (["prompt": .string($0), "text": .string(prompts[$0]!)] as OJ).stringify() }
        let text = (promptLines + keep.map { (["run": $0.json] as OJ).stringify() }).joined(separator: "\n")
        written = Set(used)
        lines = used.count + keep.count
        later { try? Files.writeAtomically(text.isEmpty ? "" : text + "\n", to: file, mode: 0o600) }
    }

    private func save(_ r: Record) {
        guard let file else { return }
        if lines + 2 > maxRuns * 2 { rewrite(); return }
        var text = ""
        if let h = r["systemHash"]?.string, !written.contains(h), let p = prompts[h] {
            text += (["prompt": .string(h), "text": .string(p)] as OJ).stringify() + "\n"
            written.insert(h); lines += 1
        }
        text += (["run": r.json] as OJ).stringify() + "\n"; lines += 1
        later {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let h = try? FileHandle(forWritingTo: file) { h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close() }
            else { try? Data(text.utf8).write(to: file); chmod(file.path, 0o600) }
        }
    }

    private func find(_ id: String) -> Record? { runs.first { $0["id"]?.string == id } }

    // MARK: the calls (each never throws and returns at once)

    /// A run whose context is built. `run.system` is kept once, by hash. `run` is the run record (Ask.runRecord).
    public func start(_ run: OJ) {
        lock.lock(); defer { lock.unlock() }
        guard run.isObject, let id = run["id"].flatMap({ $0.string ?? ($0.double.map(jsNumber)) }), !id.isEmpty else { return }
        let system = run["system"]?.string ?? ""
        let hash = RunLog.hashOf(system)
        prompts[hash] = system
        // { status: 'running', at: now(), steps: [], ...rest, id, systemHash }
        var fields: [(String, OJ)] = [("status", "running"), ("at", .number(now())), ("steps", .array([]))]
        for (k, v) in run.pairs! where k != "system" {
            if let i = fields.firstIndex(where: { $0.0 == k }) { fields[i].1 = v } else { fields.append((k, v)) }
        }
        if let i = fields.firstIndex(where: { $0.0 == "id" }) { fields[i].1 = .string(id) } else { fields.append(("id", .string(id))) }
        fields.removeAll { $0.0 == "systemHash" }
        fields.append(("systemHash", .string(hash)))
        let steps = (run["steps"]?.array ?? []).isEmpty ? [] : RunLog.record(from: run).steps
        let record = Record(fields: fields, steps: steps)
        runs.removeAll { $0["id"]?.string == id }
        runs.append(record)
        while runs.count > maxRuns { runs.removeFirst() }
        save(record)
        changed(record)
    }

    /// A model step begins: what it runs on and the whole message it is sent.
    public func step(_ id: String, model: String = "", name: String = "", effort: String = "", input: String = "") {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id) else { return }
        r.steps.append(StepRec([("model", .string(model)), ("name", .string(name)), ("effort", .string(effort)), ("input", .string(input)), ("at", .number(now()))]))
        changed(r)
    }

    /// A raw event from the CLI's stream: the tool calls it starts or completes go to the current step.
    public func event(_ id: String, _ raw: JSONValue) {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id), let step = r.steps.last else { return }
        let calls = ToolCalls.of(raw)
        if calls.isEmpty { return }
        for call in calls {
            if !call.id.isEmpty, let found = step.tools.first(where: { $0.id == call.id }) {
                if let input = call.input, found.input == .null { found.input = input }
                if let result = call.result { found.result = result; found.ms = now() - found.at }
            } else if call.name != nil && step.tools.count >= ToolCalls.maxTools {
                if !call.done { step.toolsDropped += 1 } // a completed one was counted when it started
            } else if let name = call.name {
                let t = Tool(id: call.id, name: name, input: call.input ?? .null, at: now())
                if let result = call.result { t.result = result; t.ms = 0 }
                step.tools.append(t)
            }
        }
        changed(r)
    }

    /// A step's end: what the model said, and whether it asked to move up.
    public func output(_ id: String, raw: String = "", escalated: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id), let step = r.steps.last else { return }
        step.output = .string(raw)
        step.escalated = escalated
        step.ms = now() - step.at
        changed(r)
    }

    /// Fields of a run learnt after it started.
    public func note(_ id: String, _ fields: [(String, OJ)]) {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id) else { return }
        for (k, v) in fields where !["id", "steps", "system", "systemHash", "status", "at"].contains(k) { r[k] = v }
        changed(r)
    }

    /// The run's end: 'done', 'failed' or 'stopped', the lines written, the error, how long it took, a Build's `ending`.
    public func finish(_ id: String, status: String = "done", written wrote: [String]? = nil, error: String? = nil, ms: Double? = nil, ending: OJ? = nil) {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id) else { return }
        r["status"] = .string(status)
        if let ending { r["ending"] = ending }
        r["written"] = wrote.map { .array($0.map { .string($0) }) } ?? .null
        r["error"] = error.map { .string($0) } ?? .null
        r["ms"] = .number(ms ?? (now() - (r["at"]?.double ?? now())))
        save(r)
        changed(r)
    }

    /// Fields set on a run after it ended (the router's `handedTo`, `corrected`; @create's `created`; citations).
    public func amend(_ id: String, _ patch: [(String, OJ)]) {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id) else { return }
        for (k, v) in patch where !["id", "steps", "systemHash", "system"].contains(k) { r[k] = v }
        save(r)
        changed(r)
    }

    /// The newest run for which `test(record)` holds, without its big fields; nil when none does.
    public func find(_ test: (OJ) -> Bool) -> OJ? {
        lock.lock(); defer { lock.unlock() }
        for r in runs.reversed() { let s = summary(r); if test(r.json) { return s } }
        return nil
    }

    /// Every run, newest first, without its big fields.
    public func list() -> [OJ] { lock.lock(); defer { lock.unlock() }; return runs.reversed().map(summary) }

    /// One run whole, its system prompt in place.
    public func get(_ id: String) -> OJ? {
        lock.lock(); defer { lock.unlock() }
        guard let r = find(id) else { return nil }
        return r.json.setting("system", .string(prompts[r["systemHash"]?.string ?? ""] ?? ""))
    }

    /// Waits for what was queued for the file (tests).
    public func flush() { queue.sync {} }
}
