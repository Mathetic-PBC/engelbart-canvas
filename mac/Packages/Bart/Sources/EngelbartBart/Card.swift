import Foundation

// card.cjs — @brainstorm's cards (2026-09-30): what the agent replies with, how a card is kept in the document, and how
// the person's answer is written back. Pure, so the editor can use it too: a card it draws is one main would have
// written, and an answer it writes is one main reads.
//
// The agent replies with one JSON object: { say, card: 'questions' | 'focus' | 'none', map?, questions | focus, ready }.
// A card is kept as the lines of a fenced ```json block (Reply puts `bart> ` in front of each); the recap (card 'none')
// as its text. A reply that is not a card is kept as it came. One that holds more than one object, a correction between
// them, is the last of them that is a card (2026-10-04, readCard). The person's answer is the next line of the document:
//   @brainstorm picked "label"                 one choice (mcq, focus)
//   @brainstorm picked "a", "b"                several (select_all)
//   @brainstorm the words they typed           free and open, or a sentence typed by hand
//   @brainstorm picked "a"; note: …            with something added
//   @brainstorm (skipped)                      Skip
//   @brainstorm (wrap up)                      Wrap up (round 6), with nothing given
//   @brainstorm picked "a"; (wrap up)          Wrap up, with the answer given
// MATH-40 (2026-10-06): an exchange ends on the person's answer to the "next" card; that sentence is the result, written
// as the reply by code (resultText), followed by RESULT_OFFER. 2026-10-14: an ordinary @brainstorm is a conversation in
// prose and asks no cards. What is here still serves @discover's card, the Welcome walkthrough's three, and the cards and
// results older documents keep; a conversation that goes on from one is sent its cards as text (cardAsText).
//
// A card is kept as ordered JSON (OJ) so that `cardBody` writes the same key order as `JSON.stringify(card, null, 2)`.

public struct CardAnswer: Equatable, Sendable {
    public var skipped: Bool
    public var picks: [String]
    public var text: String
    public var note: String
    public var wrap: Bool = false
}

public struct CardQuestion: Equatable, Sendable {
    public var id: String?
    public var type: String
    public var title: String
    public var subtitle: String?
    public var options: [OJ]
    public var placeholder: String?
    public var eyebrow: String
    public var labels: [String] { options.compactMap { $0["label"]?.string } }
}

public enum Card {
    public static let types = ["mcq", "select_all", "free", "open"]
    static let maxOptions = 6
    public static let mapGroups = ["settled", "open", "untouched"]
    static let maxMapItems = 4
    public static let skipped = "(skipped)"
    /// What Wrap up adds to an answer (round 6).
    public static let wrap = "(wrap up)"
    public static let lookForChars = 140
    /// What an @brainstorm line with nothing after it asks (BS-01).
    public static let opening = "Start from this workspace."
    public static let nextID = "next"
    public static let nextTitleText = "So what do you want to dig into next?"
    public static let resultOffer = "Find papers on it with @discover, or ask about it with @chat."
    /// The same line as results written before the router (2026-10-12) say it: still read as the offer.
    public static let oldResultOffer = "Find papers on it with @discover, or ask about it with @bart."
    public static let nextPlaceholder = "One thing, as specific as you can make it"
    public static let againID = "again"
    public static let againTitle = "What's one part of that you'd start with?"
    static let leadChars = 200
    public static let leftOpen = "You left what comes next open for now."

    public static func isResultOffer(_ line: String?) -> Bool { let s = (line ?? "").jsTrim; return s == resultOffer || s == oldResultOffer }

    /// One line of text: spaces run together, cut to `max`.
    static func clip(_ value: OJ?, _ max: Int) -> String {
        guard case .string(let s)? = value else { return "" }
        return s.squashedSpaces.jsSlice(0, max)
    }

    /// Text that may keep its lines (the recap is three).
    static func clipText(_ value: OJ?, _ max: Int) -> String {
        guard case .string(var s)? = value else { return "" }
        s = s.replacingOccurrences(of: "\r", with: "")
        s = JSRegex("[ \\t]+", "g").replace(s, with: " ")
        s = JSRegex(" ?\\n ?", "g").replace(s, with: "\n")
        s = JSRegex("\\n{3,}", "g").replace(s, with: "\n\n")
        return s.jsTrim.jsSlice(0, max)
    }

    /// Each balanced top-level {...} in the text, in order (2026-10-04). A brace inside a double-quoted string does not
    /// count, nor does an escaped quote end the string; a "{" that never closes is passed over.
    public static func jsonBlocks(_ text: String?) -> [String] {
        let s = Array((text ?? "").utf16)
        var out: [String] = []
        func indexOf(_ c: UInt16, _ from: Int) -> Int { var i = max(0, from); while i < s.count { if s[i] == c { return i }; i += 1 }; return -1 }
        var from = indexOf(0x7B, 0)
        while from >= 0 {
            var depth = 0, quoted = false, to = -1, n = from
            while n < s.count && to < 0 {
                let c = s[n]
                if quoted { if c == 0x5C { n += 1 } else if c == 0x22 { quoted = false } }
                else if c == 0x22 { quoted = true }
                else if c == 0x7B { depth += 1 }
                else if c == 0x7D { depth -= 1; if depth == 0 { to = n } }
                n += 1
            }
            if to < 0 { from = indexOf(0x7B, from + 1); continue }
            out.append(String(decoding: s[from...to], as: UTF16.self))
            from = indexOf(0x7B, to + 1)
        }
        return out
    }

    /// The model's text as JSON: bare, in a code fence, or with words around it; else, when it holds more than one
    /// object, the last of them that parses. nil when there is none.
    public static func parseJson(_ text: String?) -> OJ? {
        let raw = (text ?? "").jsTrim
        let body = JSRegex("^```(?:json)?[ \\t]*\\n([\\s\\S]*?)\\n```$", "i").match(raw)?[1] ?? raw
        if let v = OJ.parse(body) { return v }
        let from = body.jsIndexOf("{")
        let to = (body as NSString).range(of: "}", options: .backwards).location
        if from >= 0, to != NSNotFound, to > from, let v = OJ.parse(body.jsSlice(from, to + 1)) { return v }
        for block in jsonBlocks(body).reversed() { if let v = OJ.parse(block), v.isObject { return v } }
        return nil
    }

    // An answer names its options by label inside double quotes, so a label never holds one.
    static func cleanOptions(_ list: OJ?) -> [OJ] {
        var out: [OJ] = []
        for option in list?.array ?? [] {
            let given: OJ? = option.string != nil ? ["label": option] : option.isObject ? option : nil
            let label = given.map { clip($0["label"], 200).replacingOccurrences(of: "\"", with: "'") } ?? ""
            if label.isEmpty || out.contains(where: { $0["label"]?.string?.lowercased() == label.lowercased() }) { continue }
            let why = clip(given?["why"], 300)
            out.append(why.isEmpty ? ["label": .string(label)] : ["label": .string(label), "why": .string(why)])
            if out.count == maxOptions { break }
        }
        return out
    }

    /// The map as it may be kept → { settled, open, untouched }, each at most four { text, from }. nil when not an object.
    public static func cleanMap(_ map: OJ?) -> OJ? {
        guard let map, map.isObject else { return nil }
        var out: [(String, OJ)] = []
        for group in mapGroups {
            var items: [OJ] = []
            for item in map[group]?.array ?? [] {
                let given: OJ? = item.string != nil ? ["text": item] : item.isObject ? item : nil
                let text = given.map { clip($0["text"], 200) } ?? ""
                if text.isEmpty { continue }
                items.append(["text": .string(text), "from": .string(clip(given?["from"], 160))])
                if items.count == maxMapItems { break }
            }
            out.append((group, .array(items)))
        }
        return .object(out)
    }

    /// Whether a map says anything.
    public static func mapHolds(_ map: OJ?) -> Bool { guard let map else { return false }; return mapGroups.contains { !(map[$0]?.array?.isEmpty ?? true) } }

    /// A reply (the model's text) as a card fit to draw, or nil. `ready` ends the exchange whatever card it names.
    public static func readCard(_ text: String?) -> OJ? {
        guard let text else { return nil }
        if let card = cleanCard(parseJson(text)) { return card }
        for block in jsonBlocks(text).reversed() { if let found = cleanCard(OJ.parse(block)) { return found } }
        return nil
    }

    /// One parsed value as a card fit to draw, or nil.
    public static func cleanCard(_ value: OJ?) -> OJ? {
        guard let value, value.isObject else { return nil }
        let say = clipText(value["say"], 1500)
        let kind: String = {
            switch value["card"] { case .string(let s)?: return s.lowercased(); case .number(let n)? where n != 0: return jsNumber(n); case .bool(true)?: return "true"; default: return "" }
        }()
        if kind == "none" || value["ready"] == .bool(true) { return say.isEmpty ? nil : ["say": .string(say), "card": "none", "ready": true] }
        let map = cleanMap(value["map"])
        if kind == "focus" {
            let focus = value["focus"].flatMap { $0.isObject ? $0 : nil } ?? .object([])
            let options = cleanOptions(focus["options"])
            if options.count < 2 { return nil }
            var o: [(String, OJ)] = [("say", .string(say)), ("card", "focus")]
            if let map { o.append(("map", map)) }
            let title = clip(focus["title"], 300)
            o.append(("focus", ["title": .string(title.isEmpty ? "What should we focus on?" : title), "options": .array(options)]))
            o.append(("ready", false))
            return .object(o)
        }
        if kind == "questions" {
            let questions = value["questions"].flatMap { $0.isObject ? $0 : nil } ?? .object([])
            guard let item = questions["items"]?.array?.first(where: { $0.isObject }) else { return nil } // one question per card
            guard let type = item["type"]?.string, types.contains(type) else { return nil }
            let title = clip(item["title"], 300)
            if title.isEmpty { return nil }
            let id = clip(item["id"], 40)
            var out: [(String, OJ)] = [("id", .string(id.isEmpty ? "q" : id)), ("type", .string(type)), ("title", .string(title))]
            let subtitle = clip(item["subtitle"], 300)
            if !subtitle.isEmpty { out.append(("subtitle", .string(subtitle))) }
            if type == "mcq" || type == "select_all" {
                let options = cleanOptions(item["options"])
                if options.count < 2 { return nil }
                out.append(("options", .array(options)))
            } else {
                let placeholder = clip(item["placeholder"], 120)
                if !placeholder.isEmpty { out.append(("placeholder", .string(placeholder))) }
            }
            let eyebrow = clip(questions["eyebrow"], 60)
            var q: [(String, OJ)] = []
            if !eyebrow.isEmpty { q.append(("eyebrow", .string(eyebrow))) }
            q.append(("items", .array([.object(out)])))
            var o: [(String, OJ)] = [("say", .string(say)), ("card", "questions")]
            if let map { o.append(("map", map)) }
            o.append(("questions", .object(q)))
            o.append(("ready", false))
            return .object(o)
        }
        return nil
    }

    /// The reply as the document keeps it → (body, card): a card as its JSON in a fence, the recap as its words, anything
    /// else as it came.
    public static func cardBody(_ text: String?) -> (body: String, card: OJ?) {
        guard let card = readCard(text) else { return (text ?? "", nil) }
        if card["card"]?.string == "none" { return (card["say"]?.string ?? "", card) }
        return (["```json", card.stringify(indent: 2), "```"].joined(separator: "\n"), card)
    }

    /// An answer as the document holds it → the card it is, or nil. Only a card that asks something.
    public static func cardOfAnswer(_ answer: String?) -> OJ? {
        guard let m = JSRegex("^```json[ \\t]*\\n([\\s\\S]*)\\n```$").match((answer ?? "").jsTrim), let value = OJ.parse(m[1] ?? "") else { return nil }
        guard let card = cleanCard(value), card["card"]?.string != "none" else { return nil }
        return card
    }

    /// What the card asks, whatever its kind. A focus card is one choice.
    public static func questionOf(_ card: OJ?) -> CardQuestion? {
        guard let card else { return nil }
        if card["card"]?.string == "focus" {
            return CardQuestion(id: nil, type: "focus", title: card["focus"]?["title"]?.string ?? "", subtitle: nil,
                                options: card["focus"]?["options"]?.array ?? [], placeholder: nil, eyebrow: "focus")
        }
        guard let item = card["questions"]?["items"]?.array?.first else { return nil }
        return CardQuestion(id: item["id"]?.string, type: item["type"]?.string ?? "", title: item["title"]?.string ?? "",
                            subtitle: item["subtitle"]?.string, options: item["options"]?.array ?? [], placeholder: item["placeholder"]?.string,
                            eyebrow: card["questions"]?["eyebrow"]?.string ?? "")
    }

    /// A card as an agent reading an older conversation is shown it (2026-10-14).
    public static func cardAsText(_ card: OJ?) -> String {
        guard let card, card["card"]?.string != "none", let asked = questionOf(card) else { return "" }
        return ([card["say"]?.string ?? "", asked.title] + asked.labels.map { "- \($0)" }).filter { !$0.isEmpty }.joined(separator: "\n")
    }

    public static func isChoice(_ type: String?) -> Bool { type == "mcq" || type == "select_all" || type == "focus" }

    /// The answer as the words after "@brainstorm" (BS-06). Nothing given is Skip.
    public static func answerLine(_ card: OJ?, picks: [String] = [], text: String? = nil, note: String? = nil) -> String {
        let asked = questionOf(card)
        func one(_ v: String?) -> String { (v ?? "").squashedSpaces }
        let labels = asked?.labels ?? []
        let chosen = picks.filter { labels.contains($0) }
        let n = one(note)
        if let asked, isChoice(asked.type), chosen.isEmpty { return n.isEmpty ? skipped : n }
        let said = asked.map { isChoice($0.type) } == true ? "picked \(chosen.map { "\"\($0)\"" }.joined(separator: ", "))" : one(text)
        if said.isEmpty { return skipped }
        return n.isEmpty ? said : "\(said); note: \(n)"
    }

    /// Whether an answer wraps up (round 6) → (wrap, rest).
    public static func readWrap(_ text: String?) -> (wrap: Bool, rest: String) {
        let said = (text ?? "").jsTrim
        if said == wrap { return (true, "") }
        if let m = JSRegex("^([\\s\\S]*?)\\s*;\\s*\\(wrap up\\)$").match(said) { return (true, (m[1] ?? "").jsTrim) }
        return (false, said)
    }

    /// An answer line as Wrap up writes it.
    public static func withWrap(_ said: String?) -> String { (said ?? "").isEmpty || said == skipped ? wrap : "\(said!); \(wrap)" }

    /// The words after "@brainstorm" read back against the card they answer.
    public static func readAnswer(_ text: String?, _ card: OJ?) -> CardAnswer {
        let (w, said) = readWrap(text)
        func out(_ a: CardAnswer) -> CardAnswer { var a = a; if w { a.wrap = true }; return a }
        if said.isEmpty || said == skipped { return out(CardAnswer(skipped: true, picks: [], text: "", note: "")) }
        if let m = JSRegex("^picked\\s+((?:\"[^\"]*\"\\s*,\\s*)*\"[^\"]*\")\\s*(?:;\\s*note:\\s*([\\s\\S]*))?$", "i").match(said) {
            let picks = JSRegex("\"([^\"]*)\"", "g").matchAll(m[1] ?? "").map { $0[1] ?? "" }
            return out(CardAnswer(skipped: false, picks: picks, text: "", note: (m[2] ?? "").jsTrim))
        }
        // Typed by hand: a sentence stands as what was said; one that is an option's label word for word is that pick.
        if let asked = questionOf(card), isChoice(asked.type), let same = asked.labels.first(where: { $0.lowercased() == said.lowercased() }) {
            return out(CardAnswer(skipped: false, picks: [same], text: "", note: ""))
        }
        return out(CardAnswer(skipped: false, picks: [], text: said, note: ""))
    }

    static func bare(_ question: String?) -> String { JSRegex("^(?:--\\S+\\s*)+|(?:\\s*--\\S+)+$", "g").replace(question ?? "", with: "").jsTrim }

    /// How many meaningful answers the person has given since the exchange last ended, `question` included.
    public static func answersSoFar(_ turns: [(question: String, answer: String)], _ question: String) -> Int {
        let said = turns.map { $0.question } + [question]
        var count = 0
        var n = turns.count - 1
        while n >= 0 {
            if cardOfAnswer(turns[n].answer) == nil { break }
            let answer = readWrap(bare(said[n + 1])).rest
            if !answer.isEmpty && answer != skipped { count += 1 }
            n -= 1
        }
        return count
    }

    static let lookForRE = JSRegex("^\\s*look for:\\s*(?:@discover\\b\\s*)?(.*)$", "i")

    /// A recap → its lines other than the "Look for:" ones, and the searches those name (at most two of 140 characters).
    public static func recapParts(_ text: String?) -> (lines: [String], lookFor: [String]) {
        var lines: [String] = [], lookFor: [String] = []
        for line in (text ?? "").components(separatedBy: "\n") {
            guard let m = lookForRE.match(line) else { lines.append(line); continue }
            let query = (m[1] ?? "").squashedSpaces.jsSlice(0, lookForChars).jsTrim
            if !query.isEmpty && lookFor.count < 2 && !lookFor.contains(query) { lookFor.append(query) }
        }
        return (lines, lookFor)
    }

    public static let recapLabels = ["Where you are", "What pulls apart", "What's unclear", "Next, you said", "Where you'll look next", "What you know", "Where it thins out", "What draws you", "Your question", "What puzzles you", "What you took from it", "Look for"]
    static let recapLineRE = JSRegex("^\\s*(" + recapLabels.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|") + ")\\s*[:：]\\s*(.*)$", "i")

    /// One line of a recap → (label, text) when it starts with a recap label, else nil.
    public static func recapLine(_ line: String?) -> (label: String, text: String)? {
        guard let m = recapLineRE.match((line ?? "").replacingOccurrences(of: "’", with: "'")), let found = m[1] else { return nil }
        guard let label = recapLabels.first(where: { $0.lowercased() == found.lowercased() }) else { return nil }
        return (label, (m[2] ?? "").jsTrim)
    }

    /// The lead-in of a next card's title (MATH-40 follow-up). '' when there is none, it asks something itself, or it is too long.
    public static func nextLead(_ title: String?) -> String {
        let said = clip(title.map(OJ.string), 300)
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

    /// The result of an exchange from the sentence they wrote on the next card: it, then the offer; with none, LEFT_OPEN.
    public static func resultText(_ sentence: String?) -> String {
        let said = (sentence ?? "").squashedSpaces
        return said.isEmpty ? leftOpen : "\(said)\n\(resultOffer)"
    }

    /// A reply read as a result → the sentence when its last line is the offer, else nil.
    public static func resultParts(_ text: String?) -> String? {
        let lines = (text ?? "").jsTrim.components(separatedBy: "\n")
        guard lines.count >= 2, isResultOffer(lines.last) else { return nil }
        let sentence = lines.dropLast().joined(separator: " ").squashedSpaces
        return sentence.isEmpty ? nil : sentence
    }
}
