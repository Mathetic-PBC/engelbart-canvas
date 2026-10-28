import Foundation
import EngelbartCore

/// What a Build turn is doing, while it does it (bart/activity.cjs, which the Bart package owns; the labels a Build's
/// agents produce are made the same way here). Both CLIs print one JSON event per line; each event becomes at most one
/// update: a short label ("Reading src/main/ipc.cjs"), or the answer's text so far. Labels are made from known fields
/// only: a tool's output, a file's content and the model's reasoning never leave this file.
public struct ActivityUpdate: Equatable, Sendable {
    public var activity: String?
    public var log = false
    public var textStart = false
    public var delta: String?
    public var text: String?
    public init(activity: String? = nil, log: Bool = false, textStart: Bool = false, delta: String? = nil, text: String? = nil) {
        self.activity = activity; self.log = log; self.textStart = textStart; self.delta = delta; self.text = text
    }
}

public enum Activity {
    static func clip(_ value: String?, _ max: Int) -> String {
        let text = (value ?? "").replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return text.count > max ? String(text.prefix(max - 1)) + "…" : text
    }

    static func quoted(_ value: String?) -> String { let t = clip(value, 40); return t.isEmpty ? "" : " for “\(t)”" }

    static func stripFor(_ s: String) -> String { s.hasPrefix(" for") ? String(s.dropFirst(4)) : s }

    /// A path as the person knows it: relative to a directory the agent was granted, otherwise the file's name.
    public static func pathLabeller(_ dirs: [String]) -> (String?) -> String {
        { file in
            let full = file ?? ""
            if full.isEmpty { return "a file" }
            func tail(_ t: String) -> String { t.count > 48 ? "…" + String(t.suffix(47)) : t }
            if !NodePath.isAbsolute(full) { return tail(full.hasPrefix("./") ? String(full.dropFirst(2)) : full) }
            for dir in dirs {
                let inside = NodePath.relative(dir, full)
                if !inside.isEmpty && !inside.hasPrefix("..") && !NodePath.isAbsolute(inside) { return tail(inside) }
            }
            return NodePath.basename(full)
        }
    }

    static func host(_ url: String?) -> String {
        guard let u = url, let h = URL(string: u)?.host else { return "a page" }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    static func paperTool(_ tool: String, _ given: [String: JSONValue]) -> String {
        let q = { (k: String) in given[k]?.string }
        switch tool {
        case "resolve": return "Looking up\(stripFor(quoted(q("query"))))"
        case "references": return "Reading what\(stripFor(quoted(q("id")))) cites"
        case "citations": return "Reading what cites\(stripFor(quoted(q("id"))))"
        case "author_works": return "Listing the works of\(stripFor(quoted(q("author"))))"
        case "related": return "Finding papers near\(stripFor(quoted(q("id"))))"
        case "search": return q("by") == "words" ? "Searching papers\(quoted(q("query")))" : "Finding papers close to\(stripFor(quoted(q("query"))))"
        default: return "Looking papers up"
        }
    }

    // A Build's tools for putting things in the library (2026-10-07).
    static func engelbartTool(_ tool: String, _ given: [String: JSONValue], _ short: (String?) -> String) -> String {
        switch tool {
        case "save_file": return "Saving\(stripFor(quoted(given["name"]?.string))) to Engelbart"
        case "duplicate_file":
            let item = given["item"]?.string
            return "Duplicating \(item.map { $0.hasPrefix("/") } == true ? short(item) : "an item") in Engelbart"
        case "move_file_into_engelbart": return "Moving \(short(given["path"]?.string)) into Engelbart"
        default: return "Saving to Engelbart"
        }
    }

    static func claudeTool(_ name: String, _ input: JSONValue?, _ short: (String?) -> String) -> String {
        let given = input?.object ?? [:]
        if let r = name.range(of: #"^mcp__papers__(\w+)$"#, options: .regularExpression) { _ = r; return paperTool(String(name.dropFirst("mcp__papers__".count)), given) }
        if name.range(of: #"^mcp__engelbart__(\w+)$"#, options: .regularExpression) != nil { return engelbartTool(String(name.dropFirst("mcp__engelbart__".count)), given, short) }
        switch name {
        case "Agent", "Task": return "Handing\(stripFor(quoted(given["description"]?.string))) to a subagent"
        case "Read": return "Reading \(short(given["file_path"]?.string))"
        case "Grep": return "Searching code\(quoted(given["pattern"]?.string))"
        case "Glob": let g = clip(given["pattern"]?.string, 40); return "Listing \(g.isEmpty ? "files" : g)"
        case "WebSearch": return "Searching the web\(quoted(given["query"]?.string))"
        case "WebFetch": return "Reading \(host(given["url"]?.string))"
        case "Edit", "MultiEdit", "NotebookEdit": return "Editing \(short(given["file_path"]?.string ?? given["notebook_path"]?.string))"
        case "Write": return "Writing \(short(given["file_path"]?.string))"
        case "Bash": return commandLabel(given["command"]?.string, short)
        default: return "Using \(clip(name, 24))"
        }
    }

    /// One Claude Code stream-json event → an update, or nil.
    public static func claudeUpdate(_ event: JSONValue, _ short: (String?) -> String) -> ActivityUpdate? {
        guard event.object != nil else { return nil }
        if event["type"]?.string == "assistant", let content = event["message"]?["content"]?.array {
            if let tool = content.first(where: { $0["type"]?.string == "tool_use" }) {
                return ActivityUpdate(activity: claudeTool(tool["name"]?.string ?? "", tool["input"], short), log: true)
            }
            return nil
        }
        guard event["type"]?.string == "stream_event", let inner = event["event"] else { return nil }
        if inner["type"]?.string == "content_block_start", let block = inner["content_block"] {
            if block["type"]?.string == "thinking" { return ActivityUpdate(activity: "Thinking") }
            if block["type"]?.string == "text" { return ActivityUpdate(textStart: true) }
        }
        if inner["type"]?.string == "content_block_delta", inner["delta"]?["type"]?.string == "text_delta" {
            return ActivityUpdate(delta: inner["delta"]?["text"]?.string ?? "")
        }
        return nil
    }

    static let readers: Set<String> = ["cat", "sed", "head", "tail", "nl", "bat", "less", "wc"]
    static let searchers: Set<String> = ["rg", "grep", "ag", "ack"]
    static let listers: Set<String> = ["ls", "find", "fd", "tree"]

    /// Codex reads through the shell. Only the first command's name and one argument are shown.
    public static func commandLabel(_ command: String?, _ short: (String?) -> String) -> String {
        var text = (command ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let re = try? NSRegularExpression(pattern: #"^\S*(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$"#),
           let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let r = Range(m.range(at: 2), in: text) {
            text = String(text[r])
        }
        let firstCommand = text.components(separatedBy: CharacterSet(charactersIn: "|;")).first ?? ""
        let head = firstCommand.components(separatedBy: "&&").first ?? ""
        let words = head.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map {
            String($0).replacingOccurrences(of: #"^['"]|['"]$"#, with: "", options: .regularExpression)
        }.filter { !$0.isEmpty }
        let name = NodePath.basename(words.first ?? "")
        let plain = words.dropFirst().filter { !$0.hasPrefix("-") }
        if readers.contains(name) { return "Reading \(short(plain.last))" }
        if searchers.contains(name) { return "Searching code\(quoted(plain.first))" }
        if listers.contains(name) { return "Listing files" }
        return name.isEmpty ? "Running a command" : "Running \(clip(name, 24))"
    }

    /// One `codex exec --json` event → an update, or nil. Codex sends a message whole, not in pieces.
    public static func codexUpdate(_ event: JSONValue, _ short: (String?) -> String) -> ActivityUpdate? {
        guard let type = event["type"]?.string, type == "item.started" || type == "item.completed", let item = event["item"], item.object != nil else { return nil }
        let started = type == "item.started"
        switch item["type"]?.string {
        case "command_execution": return started ? ActivityUpdate(activity: commandLabel(item["command"]?.string, short), log: true) : nil
        case "web_search":
            if let query = item["query"]?.string ?? item["action"]?["query"]?.string, !query.isEmpty { return ActivityUpdate(activity: "Searching the web\(quoted(query))", log: true) }
            return started ? ActivityUpdate(activity: "Searching the web") : nil
        case "reasoning": return ActivityUpdate(activity: "Thinking")
        case "mcp_tool_call":
            if !started { return nil }
            var args = item["arguments"]?.object ?? [:]
            if let s = item["arguments"]?.string { args = (try? JSONValue.parse(s))?.object ?? [:] }
            let server = item["server"]?.string, tool = item["tool"]?.string ?? ""
            return ActivityUpdate(activity: server == "papers" ? paperTool(tool, args) : server == "engelbart" ? engelbartTool(tool, args, short) : "Using \(clip(tool, 24))", log: true)
        case "file_change" where !started:
            let first = item["changes"]?.array?.first
            return ActivityUpdate(activity: "Editing \(first != nil ? short(first?["path"]?.string) : "files")", log: true)
        case "agent_message" where !started:
            return ActivityUpdate(text: item["text"]?.string ?? "")
        default: return nil
        }
    }

    /// Bytes → whole lines → events. A line that is not JSON is passed over.
    static func eventReader(_ onEvent: @escaping (JSONValue) -> Void) -> (Data) -> Void {
        let rest = LockedData()
        let lock = NSLock()
        var held = Data()
        _ = rest
        return { chunk in
            lock.lock()
            held.append(chunk)
            var lines: [Data] = []
            while let nl = held.firstIndex(of: 0x0A) {
                lines.append(held[held.startIndex..<nl])
                held.removeSubrange(held.startIndex...nl)
            }
            lock.unlock()
            for line in lines {
                let text = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                guard text.hasPrefix("{"), let event = try? JSONValue.parse(text) else { continue }
                onEvent(event)
            }
        }
    }
}

/// Updates → progress messages, the text at most once per interval: `{ activity, log? }` when what it is doing changes,
/// `{ lines }` as the answer grows (createFeed). An "ESCALATE:" text is the agent talking to the harness: never previewed.
final class ActivityFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var text = "", sent = "", activity = ""
    private var timer: DispatchWorkItem?
    private let interval: TimeInterval
    private let onProgress: (JSONValue) -> Void

    init(interval: TimeInterval = 0.1, onProgress: @escaping (JSONValue) -> Void) { self.interval = interval; self.onProgress = onProgress }

    private func say(_ label: String, _ log: Bool) {
        guard !label.isEmpty, label != activity else { return }
        activity = label
        onProgress(log ? ["activity": .string(label), "log": true] : ["activity": .string(label)])
    }

    static func toHarness(_ text: String) -> Bool {
        let head = String(text.drop(while: { $0.isWhitespace }).prefix(9))
        return !head.isEmpty && "ESCALATE:".hasPrefix(head)
    }

    private func flush() {
        lock.lock()
        timer = nil
        if text == sent || ActivityFeed.toHarness(text) { lock.unlock(); return }
        sent = text
        let current = text
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { say("Writing", false) }
        lock.unlock()
        // bart/reply.cjs bodyLines flattens the answer as the document will hold it; the card shows only the activity,
        // so the lines are the text's own lines here.
        onProgress(["lines": .array(trimmed.isEmpty ? [] : current.components(separatedBy: "\n").map(JSONValue.string))])
    }

    func take(_ update: ActivityUpdate?) {
        guard let update else { return }
        lock.lock()
        if let a = update.activity { say(a, update.log) }
        if update.textStart { text = "" }
        if let d = update.delta { text += d }
        if let t = update.text { text = t }
        if text != sent && timer == nil {
            let work = DispatchWorkItem { [weak self] in self?.flush() }
            timer = work
            DispatchQueue.global().asyncAfter(deadline: .now() + interval, execute: work)
        }
        lock.unlock()
    }

    /// A new turn: nothing of the last one is kept.
    func reset() { lock.lock(); timer?.cancel(); timer = nil; text = ""; sent = ""; activity = ""; lock.unlock() }
    func end() { lock.lock(); timer?.cancel(); timer = nil; lock.unlock() }
}
