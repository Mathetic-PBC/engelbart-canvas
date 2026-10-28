import Foundation

// clip.cjs — text too long for where it goes, cut in the middle (MATH-27 second pass, 2026-10-06): a passage
// highlighted across many pages, or an earlier answer past what a turn may hold, is asked about with its start and its
// end and a line saying how much was left out between them, rather than refused.

public enum Clip {
    /// The line that stands where `n` characters were cut.
    public static func cutLine(_ n: Int) -> String { "\n[… \(localeNumber(n)) characters cut …]\n" }

    /// `text` as it is when it fits in `max` characters (UTF-16 units, as JS counts), else its start and end around
    /// cutLine, `max` long at most. Never cuts a surrogate pair in half.
    public static func clipMiddle(_ text: String?, _ max: Int) -> String {
        let s = text ?? ""
        let n = s.jsLength
        if n <= max { return s }
        let room = max - cutLine(n).jsLength // the line for the most that could be cut is the longest it gets
        if room <= 0 { return s.jsSlice(0, max) }
        var head = Int((Double(room) / 2).rounded(.up))
        var tail = room - head
        if let c = s.jsCharCode(head - 1), (0xD800...0xDBFF).contains(c) { head -= 1 }
        if tail > 0, let c = s.jsCharCode(n - tail), (0xDC00...0xDFFF).contains(c) { tail -= 1 }
        return s.jsSlice(0, head) + cutLine(n - head - tail) + (tail > 0 ? s.jsSlice(n - tail) : "")
    }
}

// reply.cjs — how an answer sits in a document's text (2026-09-19). Every line says what it is, as todo lines do, so
// the editor stays line by line and a copied document reads as a conversation:
//   @bart --opus why does the sweep skip short notes?     the question
//   bart~> 6f1c…                                          pending: the run with that id is working
//   bart> It skips them because …                         the answer, kept as it arrives (2026-09-21: no Save;
//                                                         the card's Delete takes the question and the answer out)
//   bart+> It skips them because …                        the same line while the answer is folded (Collapse)
//   @bart and the long ones?                              a question right under an answer continues that exchange
// `bart?> ` was the unsaved draft of the 09-19 build; the editor reads it as an answer.

public struct ReplyMeta: Equatable, Sendable {
    public struct Level: Equatable, Sendable {
        public var name: String, effort: String, model: String
        public init(name: String, effort: String, model: String = "") { self.name = name; self.effort = effort; self.model = model }
    }
    public struct Moved: Equatable, Sendable {
        public var name: String, effort: String, why: String
        public init(name: String, effort: String, why: String = "") { self.name = name; self.effort = effort; self.why = why }
    }
    public var provider: String
    public var level: Level
    public var trail: [Moved]
    public var ms: Double
    public var pinned: Bool
    public var routed: Routed?
    /// @create's files kept (createdRow): { name, type, path }.
    public var created: [CreatedRow]?

    public init(provider: String, level: Level, trail: [Moved] = [], ms: Double, pinned: Bool = false, routed: Routed? = nil, created: [CreatedRow]? = nil) {
        self.provider = provider; self.level = level; self.trail = trail; self.ms = ms; self.pinned = pinned; self.routed = routed; self.created = created
    }
}

/// What a routed run's meta and its record say of the routing (ask.cjs routedOf): { id, build, corrected, failed }.
public struct Routed: Equatable, Sendable {
    public var id: String?
    public var build: Bool
    public var corrected: String?
    /// Routing failed and this is the fallback (`by: 'error'`): why, when known ("" = true with no reason).
    public var failed: String?
    public init(id: String? = nil, build: Bool = false, corrected: String? = nil, failed: String? = nil) {
        self.id = id; self.build = build; self.corrected = corrected; self.failed = failed
    }
}

public struct CreatedRow: Equatable, Sendable {
    public var name: String, type: String, path: String
    public init(name: String, type: String, path: String) { self.name = name; self.type = type; self.path = path }
}

public enum Reply {
    public static let pendingRE = JSRegex("^bart~> ?([A-Za-z0-9_-]*)$")
    public static let replyPrefix = "bart> "
    public static let maxReplyChars = 12000
    /// What a closing line said after the model when Bart handed the line over, before 2026-10-12 (the editor still reads it).
    public static let viaBart = "via Bart"
    /// The names the foot gives the agents (2026-10-12), as the editor shows them.
    public static let agentNames: [String: String] = ["bart": "Chat", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create"]

    static func seconds(_ ms: Double) -> String { "\(max(1, Int(jsRound(ms / 1000)))) s" }

    /// "Discover · Sol · high · 41 s · moved up from Sol medium": which agent and model said this, kept with the answer.
    /// "Brainstorm · 8 s" without `model` (@brainstorm, 2026-10-02: its model is fixed and not shown). The agent comes
    /// first (2026-10-12), "Build" when Bart, the router, read the line as a request to build; with no `agent`, none.
    public static func attribution(_ meta: ReplyMeta, model: Bool = true, agent: String? = nil) -> String {
        let name: String? = meta.routed?.build == true ? "Build" : agent.flatMap { agentNames[$0] }
        var parts: [String] = name.map { [$0] } ?? []
        parts += model ? [meta.level.name, meta.level.effort, seconds(meta.ms)] : [seconds(meta.ms)]
        if model && !meta.trail.isEmpty {
            parts.append("moved up from " + meta.trail.map { "\($0.name) \($0.effort)" }.joined(separator: ", then "))
        }
        return "*\(parts.joined(separator: " · "))*"
    }

    static let fenceRE = JSRegex("^ {0,3}(`{3,}|~{3,})")
    static let closeRE = JSRegex("^ {0,3}(`{3,}|~{3,})\\s*$")

    /// The model's text as the lines of an answer. A fenced code block is kept as written (2026-09-22: the editor draws
    /// it), and one the text leaves open — cut off, or still arriving — is closed, so it reads as code rather than as a
    /// stray fence. Outside code, the block quotes it was told not to use are flattened and a run of blank lines is one.
    public static func bodyLines(_ text: String?) -> [String] {
        let raw = (text ?? "").replacingOccurrences(of: "\r", with: "").jsSlice(0, maxReplyChars)
        let lines = raw.components(separatedBy: "\n").map { JSRegex("\\s+$").replace($0, with: "") }
        var out: [String] = []
        var fence: String? = nil
        for line in lines {
            if let f = fence {
                out.append(line)
                if let close = closeRE.match(line), let mark = close[1], mark.first == f.first, mark.count >= f.count { fence = nil }
                continue
            }
            if let open = fenceRE.match(line), let mark = open[1] { fence = mark; out.append(line); continue }
            let flat = JSRegex("^> ?").replace(line, with: "")
            if !flat.isEmpty || out.last != "" { out.append(flat) }
        }
        if let f = fence {
            while out.last == "" { out.removeLast() }
            out.append(f)
        }
        while out.first == "" { out.removeFirst() }
        while out.last == "" { out.removeLast() }
        if !out.isEmpty && !fenceRE.test(out[0]) { out[0] = out[0].jsTrimStart }
        return out.isEmpty ? ["No answer came back."] : out
    }

    /// The answer as lines for the document. `model`/`agent` go to its foot (attribution).
    public static func replyLines(_ text: String?, _ meta: ReplyMeta?, model: Bool = true, agent: String? = nil) -> [String] {
        var lines = bodyLines(text)
        if let meta { lines += ["", attribution(meta, model: model, agent: agent)] }
        return lines.map { "\(replyPrefix)\($0)".jsTrimEnd }
    }

    /// The answer as the document will hold it and as a later follow-up will send it back: the body alone.
    public static func answerText(_ text: String?) -> String { bodyLines(text).joined(separator: "\n").jsTrim }

    /// A run that failed still answers, so the card has a foot to regenerate or delete it from.
    public static func failureLines(_ message: String?) -> [String] {
        let m = (message?.isEmpty == false ? message! : "The run failed.")
        return ["\(replyPrefix)**No answer.** \(JSRegex("\\s+", "g").replace(m, with: " ").jsSlice(0, 300))"]
    }
}
