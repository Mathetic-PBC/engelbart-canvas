import Foundation
import EngelbartCore

// activity.cjs — what an @bart run is doing, while it does it (2026-09-20). Both CLIs print one JSON event per line as
// they work (claude: --output-format stream-json; codex: --json). Each event becomes at most one update: a short label
// ("Reading src/main/ipc.cjs"), or the answer's text so far. The labels are made here from known fields only: a tool's
// output, a file's content and the model's reasoning never leave this module. The shapes were read off real runs of
// Claude Code 2.1.278 and codex-cli 0.155.0; an event that is not recognised is no update, never an error.
//
// The text so far is a preview, held by the editor outside the document. Only the finished answer is written into the
// document (Reply), so autosave and undo never see half of one.

/// One update made from one CLI event.
public enum ActivityUpdate: Equatable, Sendable {
    case activity(String, log: Bool)
    case textStart
    case delta(String)
    /// Codex sends a message whole.
    case text(String)
}

public enum Activity {
    static func clip(_ value: String?, _ max: Int) -> String {
        let text = (value ?? "").squashedSpaces
        return text.jsLength > max ? "\(text.jsSlice(0, max - 1))…" : text
    }

    static func quoted(_ value: String?) -> String {
        let text = clip(value, 40)
        return text.isEmpty ? "" : " for “\(text)”"
    }

    /// `quoted(x).replace(/^ for/, '')`.
    static func bare(_ value: String?) -> String {
        let q = quoted(value)
        return q.hasPrefix(" for") ? String(q.dropFirst(4)) : q
    }

    /// A path as the person knows it: relative to a directory the agent was granted, otherwise the file's name.
    public static func pathLabeller(_ dirs: [String] = []) -> (String?) -> String {
        return { file in
            let full = file ?? ""
            if full.isEmpty { return "a file" }
            func tail(_ text: String) -> String { text.jsLength > 48 ? "…\(text.jsSlice(-47))" : text }
            if !full.hasPrefix("/") { return tail(full.hasPrefix("./") ? String(full.dropFirst(2)) : full) }
            let fullStd = (full as NSString).standardizingPath
            for dir in dirs {
                let d = (dir as NSString).standardizingPath
                let prefix = d.hasSuffix("/") ? d : d + "/"
                if fullStd.hasPrefix(prefix) && fullStd.count > prefix.count {
                    return tail(String(fullStd.dropFirst(prefix.count)))
                }
            }
            return (full as NSString).lastPathComponent
        }
    }

    static func host(_ url: String?) -> String {
        guard let u = URL(string: url ?? ""), u.scheme != nil else { return "a page" }
        let h = u.host ?? ""
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    /// @discover's paper tools (Papers), by the tool's own name: what it was asked, never what came back.
    public static func paperTool(_ tool: String?, _ input: JSONValue?) -> String {
        let given = input?.object ?? [:]
        func s(_ k: String) -> String? { given[k].flatMap(textOf) }
        switch tool {
        case "resolve": return "Looking up\(bare(s("query")))"
        case "references": return "Reading what\(bare(s("id"))) cites"
        case "citations": return "Reading what cites\(bare(s("id")))"
        case "author_works": return "Listing the works of\(bare(s("author")))"
        case "related": return "Finding papers near\(bare(s("id")))"
        // A search by meaning (the default, 2026-10-15) reads as what it does; one by words as before.
        case "search": return s("by") == "words" ? "Searching papers\(quoted(s("query")))" : "Finding papers close to\(bare(s("query")))"
        default: return "Looking papers up"
        }
    }

    /// A Build's tools for putting things in the library (2026-10-07; build/engelbart-tools.cjs).
    static func engelbartTool(_ tool: String?, _ input: JSONValue?, _ short: (String?) -> String) -> String {
        let given = input?.object ?? [:]
        switch tool {
        case "save_file": return "Saving\(bare(given["name"].flatMap(textOf))) to Engelbart"
        case "duplicate_file":
            let item = given["item"]?.string
            return "Duplicating \(item.map { $0.hasPrefix("/") } == true ? short(item) : "an item") in Engelbart"
        case "move_file_into_engelbart": return "Moving \(short(given["path"]?.string)) into Engelbart"
        default: return "Saving to Engelbart"
        }
    }

    /// A JSON value as JS's String() would show it in a label (strings as they are, numbers as numbers).
    static func textOf(_ v: JSONValue) -> String? {
        switch v {
        case .string(let s): return s
        case .number(let n): return jsNumber(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    static func claudeTool(_ name: String?, _ input: JSONValue?, _ short: (String?) -> String) -> String {
        let given = input?.object ?? [:]
        let n = name ?? ""
        if let m = JSRegex("^mcp__papers__([A-Za-z0-9_]+)$").match(n) { return paperTool(m[1], input) }
        if let m = JSRegex("^mcp__engelbart__([A-Za-z0-9_]+)$").match(n) { return engelbartTool(m[1], input, short) }
        func s(_ k: String) -> String? { given[k].flatMap(textOf) }
        switch n {
        case "Agent", "Task": return "Handing\(bare(s("description"))) to a subagent"
        case "Read": return "Reading \(short(s("file_path")))"
        case "Grep": return "Searching code\(quoted(s("pattern")))"
        case "Glob": let c = clip(s("pattern"), 40); return "Listing \(c.isEmpty ? "files" : c)"
        case "WebSearch": return "Searching the web\(quoted(s("query")))"
        case "WebFetch": return "Reading \(host(s("url")))"
        // A Build's tools (2026-09-25); @bart never has these.
        case "Edit", "MultiEdit", "NotebookEdit": return "Editing \(short(s("file_path") ?? s("notebook_path")))"
        case "Write": return "Writing \(short(s("file_path")))"
        case "Bash": return commandLabel(s("command"), short)
        default: return "Using \(clip(n, 24))"
        }
    }

    /// One Claude Code stream-json event → an update, or nil.
    public static func claudeUpdate(_ event: JSONValue, _ short: (String?) -> String) -> ActivityUpdate? {
        guard case .object = event else { return nil }
        if event["type"]?.string == "assistant", let content = event["message"]?["content"]?.array {
            // whole input; the stream_event form has none yet
            guard let tool = content.first(where: { $0["type"]?.string == "tool_use" }) else { return nil }
            return .activity(claudeTool(tool["name"]?.string, tool["input"], short), log: true)
        }
        guard event["type"]?.string == "stream_event", let inner = event["event"], case .object = inner else { return nil }
        if inner["type"]?.string == "content_block_start", let block = inner["content_block"] {
            if block["type"]?.string == "thinking" { return .activity("Thinking", log: false) }
            if block["type"]?.string == "text" { return .textStart }
        }
        if inner["type"]?.string == "content_block_delta", let delta = inner["delta"], delta["type"]?.string == "text_delta" {
            return .delta(delta["text"]?.string ?? "")
        }
        return nil
    }

    /// claudeUpdate, with a Write told as it is written (2026-10-15, David): Claude Code streams a tool's input as it is
    /// made, and a large file takes a minute or more to come. Here the file is named as soon as its path has come
    /// ("Writing diagram.svg"), then its size so far each whole KB ("Writing diagram.svg · 9 KB"); the whole call is still
    /// logged once, as claudeUpdate logs it. Only the path and a length are kept. One reader per turn.
    public static func claudeReader(_ short: @escaping (String?) -> String) -> (JSONValue) -> ActivityUpdate? {
        final class Held { var json = ""; var file: String?; var length = 0; var kb = 0 }
        var writes: [Int: Held] = [:]
        let lock = NSLock()
        return { event in
            lock.lock(); defer { lock.unlock() }
            let inner: JSONValue? = event["type"]?.string == "stream_event" ? event["event"] : nil
            let index = inner?["index"]?.int ?? -1
            if let inner, inner["type"]?.string == "content_block_start", let block = inner["content_block"], block["type"]?.string == "tool_use" {
                if block["name"]?.string == "Write" { writes[index] = Held() }
                return nil
            }
            if let inner, inner["type"]?.string == "content_block_delta", let delta = inner["delta"], delta["type"]?.string == "input_json_delta" {
                guard let held = writes[index] else { return nil }
                let part = delta["partial_json"]?.string ?? ""
                if held.file == nil {
                    held.json += part
                    guard let named = JSRegex("\"file_path\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").match(held.json) else { return nil }
                    let raw = named[1] ?? ""
                    if case .string(let s)? = OJ.parse("\"\(raw)\"") { held.file = s } else { held.file = raw }
                    held.length = held.json.jsLength - named.index - named.length
                    held.json = ""
                    return .activity("Writing \(short(held.file))", log: false)
                }
                held.length += part.jsLength
                let kb = held.length / 1024
                if kb <= held.kb { return nil }
                held.kb = kb
                return .activity("Writing \(short(held.file)) · \(kb) KB", log: false)
            }
            if let inner, inner["type"]?.string == "content_block_stop" { writes[index] = nil }
            return claudeUpdate(event, short)
        }
    }

    static let readers: Set<String> = ["cat", "sed", "head", "tail", "nl", "bat", "less", "wc"]
    static let searchers: Set<String> = ["rg", "grep", "ag", "ack"]
    static let listers: Set<String> = ["ls", "find", "fd", "tree"]

    /// Codex reads through the shell. Only the first command's name and one argument are shown.
    public static func commandLabel(_ command: String?, _ short: (String?) -> String) -> String {
        var text = (command ?? "").jsTrim
        if let wrapped = JSRegex("^\\S*(?:zsh|bash|sh)\\s+-l?c\\s+(['\"])([\\s\\S]*)\\1$").match(text) { text = wrapped[2] ?? text }
        let first = JSRegex("\\s*(?:\\||&&|;)\\s*").split(text)[0]
        let words = JSRegex("\\s+").split(first).map { JSRegex("^['\"]|['\"]$", "g").replace($0, with: "") }.filter { !$0.isEmpty }
        let name = ((words.first ?? "") as NSString).lastPathComponent
        let plain = words.dropFirst().filter { !$0.hasPrefix("-") }
        if readers.contains(name) { return "Reading \(short(plain.last))" }
        if searchers.contains(name) { return "Searching code\(quoted(plain.first))" }
        if listers.contains(name) { return "Listing files" }
        return name.isEmpty ? "Running a command" : "Running \(clip(name, 24))"
    }

    /// One `codex exec --json` event → an update, or nil. Codex sends a message whole, not in pieces.
    public static func codexUpdate(_ event: JSONValue, _ short: (String?) -> String) -> ActivityUpdate? {
        guard let type = event["type"]?.string, type == "item.started" || type == "item.completed",
              let item = event["item"], case .object = item else { return nil }
        let started = type == "item.started"
        switch item["type"]?.string {
        case "command_execution":
            return started ? .activity(commandLabel(item["command"]?.string, short), log: true) : nil
        case "web_search":
            if let query = item["query"]?.string ?? item["action"]?["query"]?.string, !query.isEmpty {
                return .activity("Searching the web\(quoted(query))", log: true)
            }
            return started ? .activity("Searching the web", log: false) : nil
        case "reasoning": return .activity("Thinking", log: false)
        // @discover's paper tools (2026-09-30): `arguments` arrives as an object or as its JSON.
        case "mcp_tool_call":
            if !started { return nil }
            var args = item["arguments"]
            if case .string(let s)? = args { args = (try? JSONValue.parse(s)) ?? .object([:]) }
            let server = item["server"]?.string
            let tool = item["tool"]?.string
            let label = server == "papers" ? paperTool(tool, args) : server == "engelbart" ? engelbartTool(tool, args, short) : "Using \(clip(tool, 24))"
            return .activity(label, log: true)
        // A Build's patch (2026-09-25): the first file it touches names it.
        case "file_change":
            if started { return nil }
            let first = item["changes"]?.array?.first
            return .activity("Editing \(first.map { short($0["path"]?.string) } ?? "files")", log: true)
        case "agent_message":
            return started ? nil : .text(item["text"]?.string ?? "")
        default: return nil
        }
    }

    /// Bytes → whole lines → events. A line that is not JSON (a shell banner, a warning) is passed over.
    public static func event(fromLine line: String) -> JSONValue? {
        let text = line.jsTrim
        guard text.hasPrefix("{"), let v = try? JSONValue.parse(text) else { return nil }
        return v
    }

    /// "ESCALATE: <why>" is the agent talking to the harness (Ask), not an answer: it is never previewed.
    static func toHarness(_ text: String) -> Bool {
        let head = text.jsTrimStart.jsSlice(0, 9)
        return !head.isEmpty && "ESCALATE:".hasPrefix(head)
    }
}

/// Updates → progress messages, the text at most once per interval: an activity when what it is doing changes, the
/// lines as the answer grows (whole, flattened as the final answer will be). activity.cjs createFeed.
public final class Feed: @unchecked Sendable {
    private let onProgress: (BartProgress) -> Void
    private let interval: TimeInterval
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "engelbart.bart.feed")
    private var text = "", sent = "", activity = ""
    private var timer: DispatchWorkItem?

    public init(intervalMs: Double = 100, onProgress: @escaping (BartProgress) -> Void) {
        self.onProgress = onProgress
        self.interval = intervalMs / 1000
    }

    private func say(_ label: String, _ log: Bool) {
        // called with the lock held
        if !label.isEmpty && label != activity {
            activity = label
            let p = BartProgress.activity(label, log: log)
            lock.unlock(); onProgress(p); lock.lock()
        }
    }

    private func flush() {
        lock.lock()
        timer = nil
        if text == sent || Activity.toHarness(text) { lock.unlock(); return }
        sent = text
        if !text.jsTrim.isEmpty { say("Writing", false) }
        let lines = text.jsTrim.isEmpty ? [] : Reply.bodyLines(text)
        lock.unlock()
        onProgress(.lines(lines))
    }

    public func take(_ update: ActivityUpdate?) {
        guard let update else { return }
        lock.lock()
        switch update {
        case .activity(let label, let log): say(label, log)
        case .textStart: text = ""
        case .delta(let d): text += d
        case .text(let t): text = t
        }
        if text != sent && timer == nil {
            let work = DispatchWorkItem { [weak self] in self?.flush() }
            timer = work
            if interval <= 0 { queue.async(execute: work) } else { queue.asyncAfter(deadline: .now() + interval, execute: work) }
        }
        lock.unlock()
    }

    /// A new turn (the first, or one step up): nothing of the last one is kept.
    public func reset() {
        lock.lock(); timer?.cancel(); timer = nil; text = ""; sent = ""; activity = ""; lock.unlock()
    }

    public func end() { lock.lock(); timer?.cancel(); timer = nil; lock.unlock() }
}
