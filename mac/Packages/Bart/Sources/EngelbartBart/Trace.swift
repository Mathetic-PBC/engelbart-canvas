import Foundation
import EngelbartCore

// trace.cjs — what an @discover run is doing, told as its trace (2026-10-15, David's mockup): the steps grouped by the
// part of the trace they belong to (Starting papers, Papers they cite, Newer papers that cite them, then the reading and
// the web), each line saying what came back, by title. Activity labels a step by what it was asked; this reads the paper
// tools' own answers (Papers, JSON we write), and of those only titles, ids and counts. A web page is named by its host.
// Gives back the whole story each time it changes: { groups: [{ key, title, lines: [{ text, now }] }], latest, now, last }.

public enum TraceText {
    static func clip(_ value: String?, _ max: Int) -> String {
        let text = (value ?? "").squashedSpaces
        return text.jsLength > max ? "\(text.jsSlice(0, max - 1))…" : text
    }

    /// A title as a line names it: the part before a colon, or up to a question mark, when that part says enough.
    public static func named(_ title: String?) -> String {
        let text = (title ?? "").squashedSpaces
        let head = JSRegex(":\\s|(?<=\\?)\\s").split(text)[0]
        return "“\(clip(head.jsLength >= 4 ? head : text, 60))”"
    }

    static func host(_ url: String?) -> String {
        guard let u = URL(string: url ?? ""), u.scheme != nil else { return "a page" }
        let h = u.host ?? ""
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }
    static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : many ?? "\(one)s")" }
    static func ordinal(_ n: Int) -> String {
        let suffix = (11...13).contains(n % 100) ? "th" : [1: "st", 2: "nd", 3: "rd"][n % 10] ?? "th"
        return "\(n)\(suffix)"
    }

    public static let groups = ["start": "Starting papers", "cites": "Papers they cite", "cited": "Newer papers that cite them", "read": "Reading the papers", "web": "Essays and posts", "files": "Your notes and files"]
    static let arxivRE = JSRegex("arxiv\\.org/(?:abs|pdf|html)/(\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[A-Z]{2})?/\\d{7})", "i")
    static let arxivBareRE = JSRegex("^(?:arxiv:\\s*)?(\\d{4}\\.\\d{4,5})(?:v\\d+)?$", "i")
    static let doiRE = JSRegex("(10\\.\\d{4,9}/[^\\s?#]+)", "i")
    static let workRE = JSRegex("^(?:https?://openalex\\.org/)?(W\\d+)$", "i")
    static let maxLines = 30

    static func titleKey(_ title: String?) -> String {
        JSRegex("[^a-z0-9]+", "g").replace(JSRegex("\\.pdf$").replace((title ?? "").lowercased(), with: ""), with: " ").jsTrim
    }
    static func arxivOf(_ text: String?) -> String? { (arxivRE.match(text ?? "") ?? arxivBareRE.match(text ?? ""))?[1]?.lowercased() }
    static func doiOf(_ text: String?) -> String? { doiRE.match(text ?? "")?[1]?.lowercased() }

    /// The library's entries → whether a paper record is one of them (by arXiv id, DOI or title).
    public static func libraryMatcher(_ entries: [CatalogEntryView]) -> (JSONValue?) -> Bool {
        var arxiv = Set<String>(), dois = Set<String>(), titles = Set<String>()
        for entry in entries {
            for w in [entry.url, entry.path] { if let a = arxivOf(w) { arxiv.insert(a) }; if let d = doiOf(w) { dois.insert(d) } }
            let key = titleKey(entry.name)
            if key.jsLength >= 8 { titles.insert(key) }
        }
        return { record in
            guard let record, record.object != nil else { return false }
            if let a = record["arxiv"]?.string, !a.isEmpty, let k = arxivOf(a), arxiv.contains(k) { return true }
            if let d = record["doi"]?.string, !d.isEmpty {
                if dois.contains(d.lowercased()) { return true }
                if JSRegex("^10\\.48550/arxiv\\.", "i").test(d), arxiv.contains(JSRegex("^10\\.48550/arxiv\\.", "i").replace(d, with: "").lowercased()) { return true }
            }
            return titles.contains(titleKey(record["title"]?.string))
        }
    }

    /// A tool result's text: Claude's content (a string, or text blocks), Codex's `{ content: [...] }`.
    static func textOf(_ content: JSONValue?) -> String {
        guard let content else { return "" }
        switch content {
        case .string(let s): return s
        case .array(let a): return a.map { b in b.string ?? (b["type"]?.string == "text" ? b["text"]?.string ?? "" : "") }.joined(separator: "\n")
        case .object: return content["content"]?.array != nil ? textOf(content["content"]) : ""
        default: return ""
        }
    }

    enum Call { case start(id: String, tool: String, input: JSONValue); case result(id: String, result: String, error: Bool) }

    /// One raw event → the calls it starts and the results it brings.
    static func callsOf(_ event: JSONValue) -> [Call] {
        guard event.object != nil else { return [] }
        let blocks = event["message"]?["content"]?.array ?? []
        func claudeTool(_ name: String?) -> String? {
            if let m = JSRegex("^mcp__papers__([A-Za-z0-9_]+)$").match(name ?? "") { return m[1] }
            return ["WebFetch": "web_fetch", "WebSearch": "web_search", "Read": "read"][name ?? ""]
        }
        if event["type"]?.string == "assistant" {
            return blocks.compactMap { b in
                guard b["type"]?.string == "tool_use", let tool = claudeTool(b["name"]?.string) else { return nil }
                return .start(id: b["id"]?.string ?? "", tool: tool, input: b["input"]?.object != nil ? b["input"]! : .object([:]))
            }
        }
        if event["type"]?.string == "user" {
            return blocks.compactMap { b in
                guard b["type"]?.string == "tool_result" else { return nil }
                return .result(id: b["tool_use_id"]?.string ?? "", result: textOf(b["content"]), error: b["is_error"]?.bool == true)
            }
        }
        guard let type = event["type"]?.string, type == "item.started" || type == "item.completed", let item = event["item"], item.object != nil else { return [] }
        let done = type == "item.completed", id = item["id"]?.string ?? ""
        if item["type"]?.string == "mcp_tool_call" && item["server"]?.string == "papers" {
            if done { return [.result(id: id, result: textOf(item["result"]), error: (item["error"] != nil && item["error"] != .null) || item["status"]?.string == "failed")] }
            var input = item["arguments"] ?? .object([:])
            if case .string(let s) = input { input = (try? JSONValue.parse(s)) ?? .object([:]) }
            return [.start(id: id, tool: item["tool"]?.string ?? "", input: input.object != nil ? input : .object([:]))]
        }
        if item["type"]?.string == "web_search" && done {
            let action = item["action"]?.object != nil ? item["action"]! : .object([:])
            if action["type"]?.string == "open_page", let url = action["url"]?.string, !url.isEmpty {
                return [.start(id: id, tool: "web_fetch", input: ["url": .string(url)]), .result(id: id, result: "", error: false)]
            }
            if let query = item["query"]?.string ?? action["query"]?.string, !query.isEmpty {
                return [.start(id: id, tool: "web_search", input: ["query": .string(query)]), .result(id: id, result: "", error: false)]
            }
        }
        return []
    }
}

/// trace.cjs createTrace: one per @discover search run.
public final class Trace: @unchecked Sendable {
    final class Line { var text: String; var now: Bool; var check: [String]?; var waiting = 0
        init(_ text: String, now: Bool = true, check: [String]? = nil, waiting: Int = 0) { self.text = text; self.now = now; self.check = check; self.waiting = waiting } }
    final class Group { let key: String; let title: String; var lines: [Line] = []; init(key: String) { self.key = key; title = TraceText.groups[key] ?? key } }
    struct CallInfo { var tool: String; var words = false; var query: String? = nil; var check = false; var label = "" }

    private let inLibrary: (JSONValue?) -> Bool
    private var records: [String: JSONValue] = [:]
    private var groups: [Group] = []
    private var open: [String: (line: Line, call: CallInfo)] = [:]
    private var traced: String? = nil
    private var found: (ids: [String], total: Int)? = nil
    private var lastLine: Line? = nil
    private var latest: String? = nil
    private let lock = NSLock()

    public init(entries: [CatalogEntryView] = []) { inLibrary = TraceText.libraryMatcher(entries) }

    private func know(_ record: JSONValue?) {
        guard let record, record.object != nil, let title = record["title"]?.string, !title.isEmpty else { return }
        var keys: [String?] = [record["id"].flatMap(Activity.textOf)]
        if let a = record["arxiv"]?.string, !a.isEmpty { keys.append(TraceText.arxivOf(a)) }
        if let d = record["doi"]?.string, !d.isEmpty {
            keys.append(d.lowercased())
            if JSRegex("^10\\.48550/arxiv\\.", "i").test(d) { keys.append(JSRegex("^10\\.48550/arxiv\\.", "i").replace(d, with: "").lowercased()) }
        }
        for key in keys.compactMap({ $0 }) where !key.isEmpty { records[key] = record }
    }

    private func recordFor(_ ref: String?) -> JSONValue? {
        let text = (ref ?? "").jsTrim
        if let w = TraceText.workRE.match(text), let r = records[w[1]!.uppercased()] { return r }
        if let a = TraceText.arxivOf(text), let r = records[a] { return r }
        if let d = TraceText.doiOf(text), let r = records[d] { return r }
        return nil
    }

    private func nameOf(_ ref: String?) -> String {
        if let r = recordFor(ref) { return TraceText.named(r["title"]?.string) }
        return "“\(TraceText.clip(ref, 32))”"
    }

    private func group(_ key: String) -> Group {
        if let g = groups.first(where: { $0.key == key }) { return g }
        let g = Group(key: key); groups.append(g); return g
    }

    @discardableResult private func add(_ key: String, _ line: Line) -> Line {
        latest = key
        let g = group(key)
        g.lines.append(line)
        if g.lines.count > TraceText.maxLines { g.lines.removeFirst() }
        return line
    }

    private func checkText(_ titles: [String], _ done: Bool) -> String {
        let shown = titles.count > 3 ? Array(titles.prefix(2)) + ["\(titles.count - 2) more"] : titles
        let list = shown.count > 1 ? "\(shown.dropLast().joined(separator: ", ")) and \(shown.last!)" : shown.first ?? ""
        return "\(done ? "Checked" : "Checking") whether \(list) \(done || titles.count > 1 ? "fit" : "fits")"
    }

    private func s(_ v: JSONValue?) -> String? { v.flatMap(Activity.textOf) }

    private func start(tool: String, input: JSONValue) -> (line: Line, call: CallInfo)? {
        switch tool {
        case "search":
            let words = input["by"]?.string == "words"
            let line = add(traced ?? "start", Line(words ? "Searching papers for “\(TraceText.clip(s(input["query"]), 40))”" : "Searching for papers close to your problem"))
            return (line, CallInfo(tool: tool, words: words, query: s(input["query"])))
        case "resolve":
            let q = s(input["query"])
            let label = recordFor(q) != nil ? nameOf(q) : "“\(TraceText.clip(q, 40))”"
            if let traced {
                let g = group(traced)
                if let last = g.lines.last, last.check != nil, last === lastLine {
                    latest = traced
                    last.check!.append(label); last.waiting += 1; last.now = true; last.text = checkText(last.check!, false)
                    return (last, CallInfo(tool: tool, check: true, label: label))
                }
                let line = add(traced, Line(checkText([label], false), check: [label], waiting: 1))
                return (line, CallInfo(tool: tool, check: true, label: label))
            }
            return (add("start", Line("Looking up \(label)")), CallInfo(tool: tool))
        case "references":
            traced = "cites"
            return (add("cites", Line("Listing the papers \(nameOf(s(input["id"]))) cites")), CallInfo(tool: tool))
        case "citations":
            traced = "cited"
            return (add("cited", Line("Finding newer papers that cite \(nameOf(s(input["id"])))")), CallInfo(tool: tool))
        case "related":
            return (add(traced ?? "start", Line("Finding papers near \(nameOf(s(input["id"])))")), CallInfo(tool: tool))
        case "author_works":
            return (add(traced ?? "start", Line("Listing the works of \(TraceText.clip(s(input["author"]), 40))")), CallInfo(tool: tool))
        case "web_fetch":
            let url = s(input["url"])
            let record = recordFor(url)
            let paper = record != nil || TraceText.arxivOf(url) != nil || TraceText.doiOf(url) != nil || JSRegex("\\.pdf(?:$|[?#])", "i").test(url ?? "")
            return (add(paper ? "read" : "web", Line(record != nil ? "Reading \(TraceText.named(record?["title"]?.string))" : "Reading \(TraceText.host(url))")), CallInfo(tool: tool))
        case "web_search":
            return (add("web", Line("Searching the web for “\(TraceText.clip(s(input["query"]), 40))”")), CallInfo(tool: tool))
        case "read":
            // A pdf read from disk is a paper (a web fetch keeps one as a file): the reading, not the person's files.
            let file = s(input["file_path"]) ?? ""
            let pdf = JSRegex("\\.pdf$", "i").test(file)
            let base = file.components(separatedBy: "/").last ?? ""
            return (add(pdf ? "read" : "files", Line(pdf && JSRegex("webfetch-", "i").test(file) ? "Reading a pdf it downloaded" : "Reading \(TraceText.clip(base.isEmpty ? "a file" : base, 40))")), CallInfo(tool: tool))
        default: return nil
        }
    }

    private func finish(_ line: Line, _ call: CallInfo, result: String, error: Bool) {
        let parsed: JSONValue? = error ? nil : (try? JSONValue.parse(result)).flatMap { $0.object != nil ? $0 : nil }
        let paper = parsed?["paper"].flatMap { $0.object != nil ? $0 : nil }
        if let out = parsed { know(paper); know(out["of"]); for r in out["results"]?.array ?? [] { know(r) } }
        func past(_ t: String) -> String {
            for (a, b) in [("Searching", "Searched"), ("Looking up", "Looked up"), ("Listing", "Listed"), ("Finding", "Looked for"), ("Reading", "Read")] where t.hasPrefix(a) { return b + t.dropFirst(a.count) }
            return t
        }
        if call.check {
            line.waiting -= 1
            if let title = paper?["title"]?.string, !title.isEmpty, let n = line.check?.firstIndex(of: call.label) { line.check![n] = TraceText.named(title) }
            if line.waiting <= 0 { line.now = false; line.text = checkText(line.check ?? [], true) } else { line.text = checkText(line.check ?? [], false) }
            return
        }
        line.now = false
        func failed(_ t: String) -> String {
            for (a, b) in [("Searching", "Couldn’t search"), ("Looking up", "Couldn’t look up"), ("Listing", "Couldn’t list"), ("Finding", "Couldn’t find"), ("Reading", "Couldn’t read")] where t.hasPrefix(a) { return b + t.dropFirst(a.count) }
            return t
        }
        guard let out = parsed else { line.text = error ? failed(line.text) : past(line.text); return }
        if call.tool == "search" {
            let results = out["results"]?.array ?? []
            found = (results.map { s($0["id"]) ?? "" }, results.count)
            line.text = call.words ? "Searched papers for “\(TraceText.clip(call.query, 40))”: \(TraceText.plural(results.count, "result"))"
                : !results.isEmpty ? "Searched for papers close to your problem" : "Searched for papers close to your problem: none came back"
            return
        }
        if call.tool == "resolve" {
            if out["found"] == .bool(false) { if line.text.hasPrefix("Looking up") { line.text = "Found nothing for" + line.text.dropFirst("Looking up".count) }; return }
            guard let paper, let title = paper["title"]?.string, !title.isEmpty else { line.text = past(line.text); return }
            let rank = found.map { f in f.ids.firstIndex(of: s(paper["id"]) ?? "\u{0}") ?? -1 } ?? -1
            line.text = inLibrary(paper) ? "Found \(TraceText.named(title)) in your library"
                : rank >= 0 ? "Picked \(TraceText.named(title)), the \(rank > 0 ? "\(TraceText.ordinal(rank + 1)) closest" : "closest") of \(found!.total)"
                : "Looked up \(TraceText.named(title))"
            return
        }
        let of = out["of"]?["title"]?.string.flatMap { $0.isEmpty ? nil : TraceText.named($0) }
        let total = out["total"]?.double.map { Int($0) } ?? 0
        let count = total != 0 ? total : (out["results"]?.array?.count ?? 0)
        if call.tool == "references", let of { line.text = count > 0 ? "Listed the \(TraceText.plural(count, "paper")) \(of) cites" : "\(of) cites no paper OpenAlex knows"; return }
        if call.tool == "citations", let of { line.text = count > 0 ? "Found \(count == 1 ? "1 newer paper that cites" : "\(count) newer papers that cite") \(of)" : "No paper cites \(of) yet"; return }
        if call.tool == "related", let of { line.text = "Found \(TraceText.plural(out["results"]?.array?.count ?? 0, "paper")) near \(of)"; return }
        if call.tool == "author_works" {
            let name = TraceText.clip(out["author"]?["name"]?.string, 40)
            line.text = out["found"] == .bool(false) ? "Found no author called \(TraceText.clip(s(out["author"]), 40))" : "Listed the works of \(name.isEmpty ? "the author" : name)"
            return
        }
        line.text = past(line.text)
    }

    /// The whole story as the progress event carries it.
    public func story() -> JSONValue {
        lock.lock(); defer { lock.unlock() }
        return storyLocked()
    }

    private func storyLocked() -> JSONValue {
        let lines = groups.flatMap { $0.lines }
        let now = lines.reversed().first { $0.now }
        return [
            "groups": .array(groups.map { g in ["key": .string(g.key), "title": .string(g.title), "lines": .array(g.lines.map { ["text": .string($0.text), "now": .bool($0.now)] })] }),
            "latest": latest.map { .string($0) } ?? .null,
            "now": now.map { .string($0.text) } ?? .null,
            "last": lastLine.map { .string($0.text) } ?? .null,
        ]
    }

    /// One raw event → the story when it changed, else nil.
    public func take(_ event: JSONValue) -> JSONValue? {
        lock.lock(); defer { lock.unlock() }
        var changed = false
        for one in TraceText.callsOf(event) {
            switch one {
            case .start(let id, let tool, let input):
                if let begun = start(tool: tool, input: input) { open[id] = begun; lastLine = begun.line; changed = true }
            case .result(let id, let result, let error):
                if let held = open[id] { finish(held.line, held.call, result: result, error: error); open[id] = nil; changed = true }
            }
        }
        return changed ? storyLocked() : nil
    }
}
