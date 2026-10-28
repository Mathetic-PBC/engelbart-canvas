import Foundation
import EngelbartCore
import EngelbartDoc

// card.cjs, its writing half. Reading a card (readCard, cleanCard, cardOfAnswer, questionOf, cardAsText, answerLine,
// readWrap, readAnswer, recapLine, resultText, resultParts) is the Doc package's `Card`, one definition shared with the
// editor. What stays here is what only main does: write a card into the document as `JSON.stringify(card, null, 2)`
// writes it, keys in the order cleanCard builds them (Doc's JSONValue keeps no order), and the welcome walkthrough's
// constants, lead-ins and counts.

public enum CardBody {
    /// What an @brainstorm line with nothing after it asks (BS-01).
    public static let opening = "Start from this workspace."
    /// The last card of an exchange (MATH-40).
    public static let nextID = "next"
    public static let nextTitleText = "So what do you want to dig into next?"
    public static let nextPlaceholder = "One thing, as specific as you can make it"
    public static let againID = "again"
    public static let againTitle = "What's one part of that you'd start with?"
    static let leadChars = 200

    static func ordered(_ v: JSONValue?, _ keys: [String]) -> [(String, OJ)] { keys.compactMap { k in v?[k].map { (k, OJ($0)) } } }

    /// A cleaned card (Doc's Card.cleanCard) as cleanCard built it: { say, card, map?, focus | questions, ready }, the map's
    /// groups settled, open, untouched ({ text, from }), a focus { title, options [{ label, why? }] }, questions
    /// { eyebrow?, items [{ id, type, title, subtitle?, options | placeholder? }] }.
    public static func ordered(_ card: JSONValue) -> OJ {
        func option(_ o: JSONValue) -> OJ { .object(ordered(o, ["label", "why"])) }
        var out: [(String, OJ)] = ordered(card, ["say", "card"])
        if let map = card["map"] {
            out.append(("map", .object(Card.mapGroups.map { g in (g, .array((map[g]?.array ?? []).map { .object(ordered($0, ["text", "from"])) })) })))
        }
        if let focus = card["focus"] {
            out.append(("focus", ["title": OJ(focus["title"] ?? ""), "options": .array((focus["options"]?.array ?? []).map(option))]))
        }
        if let q = card["questions"] {
            var qo: [(String, OJ)] = ordered(q, ["eyebrow"])
            qo.append(("items", .array((q["items"]?.array ?? []).map { item in
                var io = ordered(item, ["id", "type", "title", "subtitle"])
                if let opts = item["options"]?.array { io.append(("options", .array(opts.map(option)))) }
                io += ordered(item, ["placeholder"])
                return .object(io)
            })))
            out.append(("questions", .object(qo)))
        }
        out += ordered(card, ["ready"])
        return .object(out)
    }

    /// The reply as the document keeps it → (body, card): a card as its JSON in a fence, the recap as its words, anything
    /// else as it came.
    public static func cardBody(_ text: String?) -> (body: String, card: JSONValue?) {
        guard let card = Card.readCard(text) else { return (text ?? "", nil) }
        if card["card"]?.string == "none" { return (card["say"]?.string ?? "", card) }
        return (["```json", ordered(card).stringify(indent: 2), "```"].joined(separator: "\n"), card)
    }

    /// card.cjs parseJson, keeping the model's own key order (Doc's returns JSONValue): bare, fenced, words around it,
    /// else the last block that is an object. For rewriting a reply as it came (ask.cjs topicsOnly).
    public static func parseOrdered(_ text: String?) -> OJ? {
        let raw = (text ?? "").jsTrim
        let body = JSRegex("^```(?:json)?[ \\t]*\\n([\\s\\S]*?)\\n```$", "i").match(raw)?[1] ?? raw
        if let v = OJ.parse(body) { return v }
        let from = body.jsIndexOf("{")
        let to = (body as NSString).range(of: "}", options: .backwards).location
        if from >= 0, to != NSNotFound, to > from, let v = OJ.parse(body.jsSlice(from, to + 1)) { return v }
        for block in Card.jsonBlocks(body).reversed() { if let v = OJ.parse(block), v.isObject { return v } }
        return nil
    }

    /// The lead-in of a next card's title (MATH-40 follow-up). '' when there is none, it asks something itself, or it is too long.
    public static func nextLead(_ title: String?) -> String {
        let said = (title ?? "").squashedSpaces.jsSlice(0, 300)
        let at = said.lowercased().jsIndexOf("so what do you want")
        var lead = (at >= 0 ? said.jsSlice(0, at) : said).jsTrim
        if at < 0 && lead.hasSuffix("?") {
            lead = JSRegex("^([\\s\\S]*[.!…][\"”’]?)\\s+[^.!?…]*\\?$").match(lead)?[1] ?? ""
        }
        if lead.isEmpty || lead.contains("?") || lead.jsLength > leadChars { return "" }
        return JSRegex("[.!…][\"”’]?$").test(lead) ? lead : "\(lead)."
    }

    public static func nextTitle(_ lead: String?) -> String { (lead ?? "").isEmpty ? nextTitleText : "\(lead!) \(nextTitleText)" }

    /// Whether two answers are the same words (case, punctuation and spacing aside); two empty ones are not.
    public static func sameWords(_ a: String?, _ b: String?) -> Bool {
        func words(_ t: String?) -> String { JSRegex("[\\p{L}\\p{N}']+", "g").matchAll((t ?? "").lowercased()).map { $0.whole }.joined(separator: " ") }
        let one = words(a)
        return !one.isEmpty && one == words(b)
    }

    static let lookForRE = JSRegex("^\\s*look for:\\s*(?:@discover\\b\\s*)?(.*)$", "i")

    /// A recap → its lines other than the "Look for:" ones, and the searches those name (at most two of 140 characters).
    public static func recapParts(_ text: String?) -> (lines: [String], lookFor: [String]) {
        var lines: [String] = [], lookFor: [String] = []
        for line in (text ?? "").components(separatedBy: "\n") {
            guard let m = lookForRE.match(line) else { lines.append(line); continue }
            let query = (m[1] ?? "").squashedSpaces.jsSlice(0, Card.lookForChars).jsTrim
            if !query.isEmpty && lookFor.count < 2 && !lookFor.contains(query) { lookFor.append(query) }
        }
        return (lines, lookFor)
    }

    static func bare(_ question: String?) -> String { JSRegex("^(?:--\\S+\\s*)+|(?:\\s*--\\S+)+$", "g").replace(question ?? "", with: "").jsTrim }

    /// How many meaningful answers the person has given since the exchange last ended, `question` included.
    public static func answersSoFar(_ turns: [(question: String, answer: String)], _ question: String) -> Int {
        let said = turns.map { $0.question } + [question]
        var count = 0
        var n = turns.count - 1
        while n >= 0 {
            if Card.cardOfAnswer(turns[n].answer) == nil { break }
            let answer = Card.readWrap(bare(said[n + 1])).rest
            if !answer.isEmpty && answer != Card.skipped { count += 1 }
            n -= 1
        }
        return count
    }
}
