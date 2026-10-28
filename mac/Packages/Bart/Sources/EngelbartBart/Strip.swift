import Foundation
import EngelbartDoc

// strip.cjs — what @brainstorm is not shown (2026-09-30, round 3): the answers other agents wrote in the document. An
// @bart or @discover question is the person's words and stays; the reply lines under it (answer, folded answer, pending)
// are the agent's understanding, not theirs, and each run of them becomes one "[agent reply omitted]". @brainstorm's own
// threads stay whole. An `@orient` line is @brainstorm's. The grammar is the editor's (doc.js BART_RE, REPLY_RE,
// PENDING_RE), restated here.
//
// A conversation's title (2026-10-12, `bart# …` or `bart#+ …`) is the editor's: no agent is shown it (stripTitles). It
// keeps, in brackets before the title, the agent Bart handed an `@bart` line to (`bart# [discover …] …`): the `@bart`
// lines of that thread are that agent's.
//
// 2026-10-14: @brainstorm is shown the other agents' replies (show), each run as <reply agent="Chat">…</reply> in its
// place, without its closing line; nearest the line being asked first, up to REPLY_BUDGET characters; one farther away is
// a <reply … left_out="…"/>. The router still gets one marker per run.
//
// A mention on a question line puts a blank line, the <file> and a blank line between the question and its replies: that
// stays with the line it is under; under a reply left out, it goes too.

public enum Strip {
    public static let bartRE = JSRegex("^@(bart|chat|brainstorm|orient|discover|create)(?:\\s(.*))?$", "i")
    public static let replyRE = JSRegex("^bart(\\+?)> ?(.*)$")
    public static let pendingRE = JSRegex("^bart~> ?([A-Za-z0-9_-]*)$")
    public static let titleRE = JSRegex("^bart#(\\+?) ?(.*)$")
    static let titleMetaRE = JSRegex("^\\[(chat|brainstorm|discover|create)( build)?(?: [^\\]]*)?\\](?: |$)")
    public static let omitted = "[agent reply omitted]"
    static let sameAs = ["orient": "brainstorm", "chat": "bart", "bart": "router"]
    static let fileRE = JSRegex("^<file\\s")
    static let closedRE = JSRegex("/>$")
    static let fileEnd = "</file>"
    public static let replyBudget = 40000
    static let agentLabels = ["bart": "Chat", "router": "Chat", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create"]
    static let footRE = JSRegex("^\\*(?:(Chat|Brainstorm|Discover|Create|Build)(?: · [^*]*)?|[^*]* · \\d+ s(?: · [^*]*)?)\\*$")
    static let footLabels = ["Chat": "Chat", "Build": "Chat", "Brainstorm": "Brainstorm", "Discover": "Discover", "Create": "Create"]
    public static let unsetTopic = "New conversation"
    static let buildLineRE = JSRegex("^build> [0-9a-f]{10}$")

    static func blockEnd(_ lines: [String], _ n: Int) -> Int {
        if closedRE.test(lines[n]) { return n }
        var depth = 0
        for k in n..<lines.count {
            if fileRE.test(lines[k]) && !closedRE.test(lines[k]) { depth += 1 }
            else if lines[k] == fileEnd { depth -= 1; if depth == 0 { return k } }
        }
        return lines.count - 1
    }

    final class Run { let who: String; let at: Int; var lines: [String] = []; var pending = false; init(who: String, at: Int) { self.who = who; self.at = at } }
    enum Part { case line(String), run(Run) }

    static func replyText(_ run: Run) -> (who: String, body: String) {
        var said = run.lines
        func trim() {
            while let l = said.last, l.jsTrim.isEmpty { said.removeLast() }
            while let f = said.first, f.jsTrim.isEmpty { said.removeFirst() }
        }
        trim()
        var who = agentLabels[run.who] ?? "Another agent"
        if let last = said.last, let foot = footRE.match(last.jsTrim) {
            if let name = foot[1] { who = footLabels[name] ?? who }
            said.removeLast()
            trim()
        }
        return (who, said.joined(separator: "\n"))
    }

    /// The text with the replies under every other agent's lines taken out, one marker per run; `agent`'s own stay. With
    /// `show`, each run is kept instead as a <reply agent="…"> block, nearest the pending line `askId` first, up to
    /// `budget` characters; the rest are left out with their size.
    public static func stripAgentReplies(_ text: String?, agent: String = "brainstorm", show: Bool = false, askId: String? = nil, budget: Int = replyBudget) -> String {
        let lines = (text ?? "").components(separatedBy: "\n")
        var out: [Part] = []
        var run: Run? = nil
        var outer: [String?] = []
        var owner: String? = nil
        var omitting = false
        var titled: String? = nil
        var routed: String? = nil
        func ends(_ n: Int) -> Bool { n >= 0 && n < lines.count && (lines[n] == fileEnd || (fileRE.test(lines[n]) && closedRE.test(lines[n]))) }
        var n = 0
        while n < lines.count {
            defer { n += 1 }
            let line = lines[n]
            if let title = titleRE.match(line) {
                let meta = titleMetaRE.match(title[2] ?? "")
                titled = meta.map { sameAs[$0[1]!] ?? $0[1]! } ?? ""
                continue
            }
            if owner != nil && line.isEmpty && (fileRE.test(n + 1 < lines.count ? lines[n + 1] : "") || ends(n - 1)) {
                if !omitting { out.append(.line(line)) }
                continue
            }
            if fileRE.test(line) {
                if omitting { n = blockEnd(lines, n); continue }
                out.append(.line(line))
                if !closedRE.test(line) { outer.append(owner); owner = nil }
                continue
            }
            if line == fileEnd && !outer.isEmpty { owner = outer.removeLast(); omitting = false; out.append(.line(line)); continue }
            if let asked = bartRE.match(line) {
                if let t = titled { routed = t.isEmpty ? nil : t } else if owner == nil { routed = nil }
                titled = nil
                let named = asked[1]!.lowercased(), who = sameAs[named] ?? named
                owner = who == "router" && routed != nil ? routed : who
                omitting = false
                out.append(.line(line))
                continue
            }
            if replyRE.test(line) || pendingRE.test(line) {
                if let o = owner, o != agent {
                    if show {
                        if !omitting { let r = Run(who: o, at: n); run = r; out.append(.run(r)) }
                        if let reply = replyRE.match(line) { run?.lines.append(reply[2] ?? "") } else { run?.pending = true }
                    } else if !omitting { out.append(.line(omitted)) }
                    omitting = true
                    continue
                }
                out.append(.line(line))
                continue
            }
            owner = nil
            titled = nil
            omitting = false
            out.append(.line(line))
        }
        if !show { return out.map { if case .line(let l) = $0 { return l }; return "" }.joined(separator: "\n") }
        let runs: [(Run, String, String)] = out.compactMap { if case .run(let r) = $0 { let t = replyText(r); return (r, t.who, t.body) }; return nil }
        let here = askId.map { id in lines.firstIndex { pendingRE.match($0)?[1] == id } ?? -1 } ?? -1
        let mark = here < 0 ? lines.count : here
        var spent = 0, full = true
        var fullOf: [ObjectIdentifier: Bool] = [:]
        // Array.prototype.sort is stable: equal distances keep document order.
        let byDistance = runs.enumerated().sorted { a, b in
            let da = abs(a.element.0.at - mark), db = abs(b.element.0.at - mark)
            return da != db ? da < db : a.offset < b.offset
        }
        for (_, r) in byDistance {
            full = full && spent + r.2.jsLength <= budget
            if full { spent += r.2.jsLength }
            fullOf[ObjectIdentifier(r.0)] = full
        }
        var shown: [ObjectIdentifier: String] = [:]
        for (r, who, body) in runs {
            shown[ObjectIdentifier(r)] = body.isEmpty ? "<reply agent=\"\(who)\"\(r.pending ? " status=\"still being written\"" : "")/>"
                : fullOf[ObjectIdentifier(r)] == true ? "<reply agent=\"\(who)\">\n\(body)\n</reply>"
                : "<reply agent=\"\(who)\" left_out=\"\(body.jsLength) characters, farther from this line\"/>"
        }
        return out.map { part -> String in
            switch part { case .line(let l): return l; case .run(let r): return shown[ObjectIdentifier(r)] ?? "" }
        }.joined(separator: "\n")
    }

    /// The topic of the conversation whose pending line is `bart~> <askId>` → its title's text, or nil.
    public static func topicOf(_ text: String?, askId: String?) -> String? {
        guard let askId, !askId.isEmpty else { return nil }
        let lines = (text ?? "").components(separatedBy: "\n")
        guard var n = lines.firstIndex(where: { pendingRE.match($0)?[1] == askId }) else { return nil }
        func at(_ i: Int) -> String? { i >= 0 && i < lines.count ? lines[i] : nil }
        func closedFile(_ line: String?) -> Bool { guard let line else { return false }; return fileRE.test(line) && closedRE.test(line) }
        n -= 1
        while n >= 0 {
            let line = lines[n]
            if let title = titleRE.match(line) {
                let t = title[2] ?? ""
                let meta = titleMetaRE.match(t)
                let said = (meta.map { t.jsSlice($0.length) } ?? t).jsTrim
                return meta?[1] == "brainstorm" && !said.isEmpty && said != unsetTopic ? said : nil
            }
            if bartRE.test(line) || replyRE.test(line) || pendingRE.test(line) || buildLineRE.test(line) || closedFile(line) { n -= 1; continue }
            if line == fileEnd {
                var depth = 0
                while n >= 0 {
                    if lines[n] == fileEnd { depth += 1 }
                    else if fileRE.test(lines[n]) && !closedRE.test(lines[n]) { depth -= 1; if depth == 0 { break } }
                    n -= 1
                }
                n -= 1
                continue
            }
            if line.isEmpty && (at(n - 1) == fileEnd || closedFile(at(n - 1)) || fileRE.test(at(n + 1) ?? "")) { n -= 1; continue }
            return nil
        }
        return nil
    }

    /// The text without its conversation titles.
    public static func stripTitles(_ text: String?) -> String {
        (text ?? "").components(separatedBy: "\n").filter { !titleRE.test($0) }.joined(separator: "\n")
    }
}
