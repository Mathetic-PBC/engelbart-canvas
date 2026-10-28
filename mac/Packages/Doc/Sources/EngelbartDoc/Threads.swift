import Foundation

// The @bart exchanges of a document (src/renderer/model/doc.js threads and the title/answer helpers around it).

public struct Turn: Equatable, Sendable {
    /// The question's line.
    public var q: Int
    /// The lines under the question: `from...to` (to == q when there are none).
    public var from: Int
    public var to: Int
    public var answered = false
    /// The id of a run still working.
    public var pending: String? = nil
    /// The closing line that says which model answered (-1 without one).
    public var foot = -1
    public var folded = false
    /// The agent that answered: 'bart', 'brainstorm', 'discover', 'create', or nil for an `@bart` turn none names.
    public var agent: String? = nil
    /// The id of the Build card standing directly under the question as its answer.
    public var build: String? = nil
}

public struct DocThread: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public var turns: [Turn] = []
    /// answeredBy: 'bart', 'brainstorm', 'discover', 'create' or 'router'.
    public var agent: String = "bart"
    /// Its first line's agent.
    public var asked: String
    /// Bart's first pick, kept on the title line.
    public var routedTo: String?
    public var at: String?
    public var build: Bool
    public var title: String?
    public var titleLine: Int
    public var folded: Bool
}

extension Doc {
    /// Which agent a question line asks: 'bart' (`@chat`), 'router' (`@bart`), 'brainstorm', 'discover' or 'create'.
    public static func agentOf(_ p: ParsedLine?) -> String {
        guard let p else { return "bart" }
        if p.agent == "orient" { return "brainstorm" }
        if let a = p.agent, ["brainstorm", "discover", "create", "router"].contains(a) { return a }
        return "bart"
    }
    /// The word a line asking `agent` starts with (2026-10-12).
    public static func tokenOf(_ agent: String?) -> String {
        guard let agent, agent != "bart" else { return "chat" }
        return agent == "router" ? "bart" : agent
    }

    static let RESEARCH = Rx(#"(^|\s)--research(?=\s|$)"#, "i")
    static let REFINE = Rx(#"(^|\s)--refine(?=\s|$)"#, "i")
    /// An @discover research box's line (2026-10-13).
    public static func isResearch(_ p: ParsedLine?) -> Bool { guard let p else { return false }; return p.type == .bart && agentOf(p) == "discover" && RESEARCH.test(p.text) }
    public static func researchLine(_ text: String?) -> String { let t = (text ?? "").trimmed; return "@discover \(RESEARCH_FLAG)\(t.isEmpty ? "" : " \(t)")" }
    public static func researchText(_ text: String?) -> String { Rx(#"\s+"#).replace(RESEARCH.replace(text ?? "", with: "$1"), with: " ").trimmed }
    /// A Refine turn's line (2026-10-15, David).
    public static func isRefine(_ p: ParsedLine?) -> Bool { guard let p else { return false }; return p.type == .bart && agentOf(p) == "discover" && REFINE.test(p.text) }
    public static func refineLine(_ text: String?) -> String { "@discover \(REFINE_FLAG) \((text ?? "").trimmed)" }

    static let FOOT_AGENTS = ["Chat": "bart", "Build": "bart", "Brainstorm": "brainstorm", "Discover": "discover", "Create": "create"]
    static let FOOT_LEAD = Rx(#"^\*(Chat|Brainstorm|Discover|Create|Build)(?: · [^*]*)?\*$"#)
    /// The agent a closing line says answered, or nil.
    public static func footAgent(_ text: String?) -> String? { FOOT_LEAD.match(text ?? "").flatMap { FOOT_AGENTS[$0[1]!] } }

    /// The agent that answers a thread (2026-10-13).
    public static func answeredBy(_ thread: DocThread?) -> String {
        guard let thread else { return "bart" }
        for turn in thread.turns.reversed() where turn.answered && turn.pending == nil && turn.agent != nil { return turn.agent! }
        return thread.routedTo ?? thread.asked
    }

    static func followsIn(_ p: ParsedLine, _ first: ParsedLine, _ thread: DocThread) -> Bool {
        agentOf(p) == "router" || isResearch(p) || isRefine(p) || (agentOf(p) == thread.agent && (p.agent != "orient" || first.agent == "orient"))
    }

    /// The @bart exchanges of a document, by line index (doc.js threads).
    public static func threads(_ lines: [String], _ psIn: [ParsedLine]? = nil) -> [DocThread] {
        let ps = psIn ?? parseLines(lines)
        var out: [DocThread] = []
        var i = 0
        while i < lines.count {
            if ps[i].type != .bart { i += 1; continue }
            let head: ParsedLine? = i > 0 && ps[i - 1].type == .title ? ps[i - 1] : nil
            var thread = DocThread(from: i, to: i, asked: agentOf(ps[i]), routedTo: head?.agent, at: head?.at, build: head?.build ?? false, title: head?.text, titleLine: head == nil ? -1 : i - 1, folded: head?.folded ?? false)
            thread.agent = answeredBy(thread)
            while true {
                var turn = Turn(q: i, from: i + 1, to: i)
                while i + 1 < lines.count {
                    let p = ps[i + 1]
                    if p.type != .pending && p.type != .reply { break }
                    i += 1; turn.to = i
                    if p.type == .pending { turn.pending = p.id } else { turn.folded = p.folded }
                }
                // A Build card right under the question is its answer (2026-10-13).
                if turn.to == turn.q && i + 1 < ps.count && ps[i + 1].type == .build { i += 1; turn.to = i; turn.build = ps[i].id }
                turn.answered = turn.to > turn.q
                if turn.answered && turn.pending == nil { let last = ps[turn.to]; if last.type == .reply && DocRx.ATTRIBUTION.test(last.text) { turn.foot = turn.to } }
                let asks = agentOf(ps[turn.q])
                turn.agent = (turn.foot >= 0 ? footAgent(ps[turn.foot].text) : nil) ?? (asks != "router" ? asks : turn.q == thread.from ? thread.routedTo : nil)
                thread.turns.append(turn); thread.to = turn.to
                thread.agent = answeredBy(thread)
                if !turn.answered || turn.build != nil || i + 1 >= lines.count || ps[i + 1].type != .bart || !followsIn(ps[i + 1], ps[thread.from], thread) { break }
                let after = i + 2 < ps.count ? ps[i + 2].type : nil
                if !isResearch(ps[i + 1]) && !(after == .pending || after == .reply || after == .build) { break }
                i += 1
            }
            out.append(thread)
            i += 1
        }
        return out
    }

    /// One turn as text: the question as typed after `@bart`, and the answer without its prefixes or its closing line.
    public static func turnText(_ lines: [String], _ turn: Turn) -> (question: String, answer: String) {
        var body: [String] = []
        if turn.from <= turn.to { for i in turn.from...turn.to { let p = parseLine(lines[i]); if p.type == .reply && i != turn.foot { body.append(p.text) } } }
        return (parseLine(lines[turn.q]).text.trimmed, body.joined(separator: "\n").trimmed)
    }

    /// A document written before the router (2026-10-12): an answered `@bart` line becomes `@chat`. → (text, count).
    public static func migrateChatLines(_ text: String?) -> (text: String, count: Int) {
        let source = text ?? ""
        var lines = source.jsSplit("\n")
        let ps = parseLines(lines)
        var routed = Set<Int>()
        for thread in threads(lines, ps) { for turn in thread.turns where thread.routedTo != nil || (turn.foot >= 0 && footAgent(ps[turn.foot].text) != nil) { routed.insert(turn.q) } }
        var count = 0
        var i = 0
        while i + 1 < lines.count {
            defer { i += 1 }
            if ps[i].type != .bart || ps[i].agent != "router" || routed.contains(i) { continue }
            let under = ps[i + 1]
            if under.type != .reply && under.type != .pending { continue }
            lines[i] = Rx(#"^@(b)art"#, "i").replace(lines[i], global: false) { m in m[1] == "B" ? "@Chat" : "@chat" }
            count += 1
        }
        return (count > 0 ? lines.joined(separator: "\n") : source, count)
    }

    /// The fenced code blocks of an answer's text, in order, each as the code it holds.
    public static func answerFences(_ answer: String?) -> [String] {
        let lines = (answer ?? "").jsSplit("\n")
        return codeBlocks(lines).map { lines[($0.open + 1)..<$0.close].joined(separator: "\n") }
    }

    static let WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static let MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// When a conversation was asked, as its collapsed row says it, in local time: "9:41 PM" today, "Yesterday", the
    /// weekday within the week, else the date ("Oct 3", and the year when it is not this one). '' with no time.
    public static func whenShown(_ at: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let at, let d = parseISO(at) else { return "" }
        let day = { (x: Date) in calendar.startOfDay(for: x) }
        let days = Int((day(now).timeIntervalSince(day(d)) / 86400).rounded())
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: d)
        if days <= 0 { let h = c.hour!; return "\(h % 12 == 0 ? 12 : h % 12):\(String(format: "%02d", c.minute!)) \(h < 12 ? "AM" : "PM")" }
        if days == 1 { return "Yesterday" }
        if days < 7 { return WEEKDAYS[c.weekday! - 1] }
        let year = calendar.component(.year, from: now)
        return "\(MONTHS[c.month! - 1]) \(c.day!)\(c.year! != year ? ", \(c.year!)" : "")"
    }

    static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// Now, as a title line keeps it: to the second, in UTC.
    public static func askedNow(_ now: Date = Date()) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: now)
    }

    /// Where ask `askId`'s question stands now → (question, index), or nil when its pending line is gone.
    public static func askedAt(_ text: String, _ askId: String) -> (question: String, index: Int)? {
        let all = text.jsSplit("\n")
        guard let at = all.firstIndex(of: "bart~> \(askId)"), at > 0 else { return nil }
        return (all[at - 1], at - 1)
    }

    /// `text` with the empty title line of ask `askId`'s thread filled with `title`; nil when there is none to fill.
    public static func placeTitle(_ text: String, _ askId: String, _ title: String?, near: (question: String, index: Int)? = nil) -> String? {
        var all = text.jsSplit("\n")
        func empty(_ j: Int) -> Bool {
            guard j >= 0, j < all.count, let m = DocRx.TITLE.match(all[j]) else { return false }
            return titleMeta(m[2]).text.trimmed.isEmpty
        }
        var at = -1
        if let pending = all.firstIndex(of: "bart~> \(askId)") {
            if pending >= 2 && DocRx.BART.test(all[pending - 1]) && empty(pending - 2) { at = pending - 2 }
        } else if let near {
            var best = -1
            for (j, line) in all.enumerated() where line == near.question && empty(j - 1) && (best < 0 || abs(j - near.index) < abs(best - near.index)) { best = j }
            if best >= 0 { at = best - 1 }
        }
        let said = (title ?? "").trimmed
        if at < 0 || said.isEmpty { return nil }
        let m = DocRx.TITLE.match(all[at])!
        all[at] = titleLine(said, folded: m[1] == "+", meta: titleMeta(m[2]))
        return all.joined(separator: "\n")
    }

    /// `text` with the title of the conversation that holds `near`'s question changed to `title` (2026-10-14); `unset`:
    /// only a title not written yet is changed.
    public static func retitle(_ text: String, near: (question: String, index: Int)?, _ title: String?, unset: Bool = false) -> String? {
        let said = (title ?? "").trimmed
        guard !said.isEmpty, let near else { return nil }
        var all = text.jsSplit("\n")
        var best = -1
        for (j, line) in all.enumerated() where line == near.question && (best < 0 || abs(j - near.index) < abs(best - near.index)) { best = j }
        guard best >= 0, let thread = threads(all).first(where: { $0.turns.contains { $0.q == best } }), thread.titleLine >= 0 else { return nil }
        let m = DocRx.TITLE.match(all[thread.titleLine])!
        let meta = titleMeta(m[2])
        let now = meta.text.trimmed
        if now == said || (unset && !now.isEmpty && now != UNSET_TOPIC) { return nil }
        all[thread.titleLine] = titleLine(said, folded: m[1] == "+", meta: meta)
        return all.joined(separator: "\n")
    }

    /// A Brainstorm conversation's topic, as its chip shows it: its title, unless it has none yet.
    public static func topicOfThread(_ thread: DocThread?) -> String {
        guard let t = thread, t.routedTo == "brainstorm", let title = t.title, !title.trimmed.isEmpty, title.trimmed != UNSET_TOPIC else { return "" }
        return title.trimmed
    }
}
