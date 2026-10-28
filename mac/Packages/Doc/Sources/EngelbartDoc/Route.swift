import Foundation

// Bart, the router, in the editor (src/renderer/model/route.js, 2026-10-12). An `@bart` line picks its agent here first,
// by rule; only a line no rule settles is sent to the model (main's bart/route.cjs) with what this reads around it.

public enum Route {
    static let LEVEL = Rx(#"(^|\s)--(quick|standard|deep)(?=\s|$)"#, "i")
    /// A thread's question as the router is sent it, at most (main's bart/route.cjs reads 80 too).
    public static let QUESTION_CHARS = 80

    /// A thread's question as the router reads it: its first line, plain, cut at a word to at most `max` characters.
    public static func questionLine(_ text: String?, max: Int = QUESTION_CHARS) -> String {
        var s = Rx(#"\r?\n"#).split(text ?? "").map { $0.trimmed }.first { !$0.isEmpty } ?? ""
        s = Rx(#"@\[([^\]\n]+)\]\([^)\s]*\)"#).replace(s, with: "$1")
        s = Rx(#"@\[([^\]\n]+)\]"#).replace(s, with: "$1")
        s = Rx(#"(^|\s)@(?:bart|chat|brainstorm|orient|discover|create)\b"#, "i").replace(s, with: "$1")
        s = Rx(#"(^|\s)--\S+"#).replace(s, with: "$1")
        s = Rx(#"!?\[([^\]\n]*)\]\([^)\s]*\)"#).replace(s, with: "$1")
        s = Rx(#"^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)"#).replace(s, with: "", global: false)
        s = Rx(#"(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1"#).replace(s, with: "$2")
        s = Rx(#"[*`]"#).replace(s, with: "")
        s = Rx(#"\s+"#).replace(s, with: " ").trimmed
        if s.len <= max { return s }
        let cut = s.slice(0, max + 1), space = cut.lastIndexOf(" ")
        return Rx(#"[\s,;:–—-]+$"#).replace(space > 0 ? cut.slice(0, space) : s.slice(0, max), with: "")
    }

    public struct Rule: Equatable, Sendable { public var agent: String; public var rule: String; public init(agent: String, rule: String) { self.agent = agent; self.rule = rule } }

    /// The agent an `@bart` line goes to by rule, or nil when the model is asked: empty → brainstorm; --build → build;
    /// a level flag → discover; an answer to Discover settling its question → discover.
    public static func routeByRule(_ text: String?, asking: Bool = false) -> Rule? {
        let said = text ?? ""
        if said.trimmed.isEmpty { return Rule(agent: "brainstorm", rule: "empty") }
        if Question.readBuildFlag(said).build { return Rule(agent: "build", rule: "--build") }
        if LEVEL.test(said) { return Rule(agent: "discover", rule: "level") }
        if asking { return Rule(agent: "discover", rule: "answering Discover") }
        return nil
    }

    /// The text a Build is started from for a turn: its answer's last fenced block, else the question and the answer.
    public static func buildTextOf(_ lines: [String], _ turn: Turn) -> String {
        let t = Doc.turnText(lines, turn)
        let fences = Doc.answerFences(t.answer)
        return fences.last ?? [t.question, t.answer].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// The agent a follow-up goes to when Bart could not pick: its conversation's, but Chat for a Discover one.
    public static func fallbackAgent(_ current: String?) -> String { (current != nil && current != "discover") ? current! : "chat" }

    public struct Inputs: Equatable, Sendable {
        public struct ThreadInfo: Equatable, Sendable { public var agent: String; public var question: String; public var up: Int }
        public var section: String
        public var threads: [ThreadInfo]
        public var specAbove: Bool
        public var spec: String?
        public var specTitle: String
        public var current: String?
        public var asking: Bool
    }

    /// What the router reads around the `@bart` line at `at`.
    public static func routeInputs(_ lines: [String], _ at: Int) -> Inputs {
        let ps = Doc.parseLines(lines)
        var start = 0
        var k = at - 1
        while k >= 0 { if ps[k].type == .h { start = k; break }; k -= 1 }
        let above = Doc.threads(lines, ps).filter { $0.from < at }
        func said(_ t: DocThread) -> [Turn] { t.turns.filter { $0.q < at && $0.answered && $0.pending == nil && $0.build == nil } }
        let list = above.map { Inputs.ThreadInfo(agent: Doc.tokenOf(Doc.answeredBy($0)), question: questionLine(Doc.turnText(lines, $0.turns[0]).question), up: at - $0.from) }
        var spec: String? = nil
        if let near = above.reversed().first(where: { $0.from >= start && !said($0).isEmpty }), let turn = said(near).last {
            spec = Doc.answerFences(Doc.turnText(lines, turn).answer).last
        }
        func built(_ t: DocThread) -> Bool { t.turns.last?.build != nil }
        let into = above.first { ($0.to == at - 1 && !built($0)) || $0.turns.contains { $0.q == at } }
        let agent = into.map { Doc.answeredBy($0) }
        let current = agent == "bart" || agent == "brainstorm" || agent == "discover" ? Doc.tokenOf(agent) : nil
        let specTitle = spec.map { questionLine($0.jsSplit("\n").first { !$0.trimmed.isEmpty } ?? "") } ?? ""
        var asking = false
        if let into, agent == "discover", let last = said(into).last {
            asking = !Doc.isResearch(ps[last.q]) && !Rx(#"^## "#, "m").test(Doc.turnText(lines, last).answer)
        }
        let section = Array(lines[start...min(at, lines.count - 1)]).joined(separator: "\n")
        return Inputs(section: section, threads: list, specAbove: spec != nil, spec: spec, specTitle: specTitle, current: current, asking: asking)
    }
}
