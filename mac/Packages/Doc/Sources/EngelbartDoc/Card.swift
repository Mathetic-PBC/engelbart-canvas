import Foundation
import EngelbartCore

// card.cjs's reading half (@brainstorm's and @discover's cards, 2026-09-30), moved into Doc so the editor can draw cards
// without depending on Bart: a card kept in an answer (a fenced ```json block), what it asks, how an answer to it is
// written and read back, recaps and results. Same names and shapes as Bart's Card.swift (main/bart/card.cjs), with
// JSONValue for its JSON; writing a card as ordered JSON (cardBody) stays Bart's.

public struct CardAnswer: Equatable, Sendable {
    public var skipped: Bool
    public var picks: [String]
    public var text: String
    public var note: String
    public var wrap: Bool = false
    public init(skipped: Bool, picks: [String], text: String, note: String, wrap: Bool = false) { self.skipped = skipped; self.picks = picks; self.text = text; self.note = note; self.wrap = wrap }
}

public struct CardQuestion: Equatable, Sendable {
    public var id: String?
    public var type: String
    public var title: String
    public var subtitle: String?
    /// Each { label, why? }.
    public var options: [JSONValue]
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
    public static let wrap = "(wrap up)"
    public static let lookForChars = 140
    public static let resultOffer = "Find papers on it with @discover, or ask about it with @chat."
    public static let oldResultOffer = "Find papers on it with @discover, or ask about it with @bart."
    public static let leftOpen = "You left what comes next open for now."

    static func squash(_ s: String) -> String { Rx(#"\s+"#).replace(s, with: " ").trimmed }
    public static func isResultOffer(_ line: String?) -> Bool { let s = (line ?? "").trimmed; return s == resultOffer || s == oldResultOffer }

    static func clip(_ value: JSONValue?, _ max: Int) -> String { guard case .string(let s)? = value else { return "" }; return squash(s).slice(0, max) }
    static func clipText(_ value: JSONValue?, _ max: Int) -> String {
        guard case .string(var s)? = value else { return "" }
        s = s.replacingOccurrences(of: "\r", with: "")
        s = Rx(#"[ \t]+"#).replace(s, with: " ")
        s = Rx(#" ?\n ?"#).replace(s, with: "\n")
        s = Rx(#"\n{3,}"#).replace(s, with: "\n\n")
        return s.trimmed.slice(0, max)
    }

    /// Each balanced top-level {...} in the text, in order; a brace inside a string does not count.
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
                else if c == 0x22 { quoted = true } else if c == 0x7B { depth += 1 } else if c == 0x7D { depth -= 1; if depth == 0 { to = n } }
                n += 1
            }
            if to < 0 { from = indexOf(0x7B, from + 1); continue }
            out.append(String(decoding: s[from...to], as: UTF16.self))
            from = indexOf(0x7B, to + 1)
        }
        return out
    }

    static func parse(_ s: String) -> JSONValue? { try? JSONValue.parse(s) }

    public static func parseJson(_ text: String?) -> JSONValue? {
        let raw = (text ?? "").trimmed
        let body = Rx(#"^```(?:json)?[ \t]*\n([\s\S]*?)\n```$"#, "i").match(raw)?[1] ?? raw
        if let v = parse(body) { return v }
        let from = body.indexOf("{"), to = body.lastIndexOf("}")
        if from >= 0, to > from, let v = parse(body.slice(from, to + 1)) { return v }
        for block in jsonBlocks(body).reversed() { if let v = parse(block), v.object != nil { return v } }
        return nil
    }

    static func cleanOptions(_ list: JSONValue?) -> [JSONValue] {
        var out: [JSONValue] = []
        for option in list?.array ?? [] {
            let given: JSONValue? = option.string != nil ? ["label": option] : option.object != nil ? option : nil
            let label = given.map { clip($0["label"], 200).replacingOccurrences(of: "\"", with: "'") } ?? ""
            if label.isEmpty || out.contains(where: { $0["label"]?.string?.lowercased() == label.lowercased() }) { continue }
            let why = clip(given?["why"], 300)
            out.append(why.isEmpty ? ["label": .string(label)] : ["label": .string(label), "why": .string(why)])
            if out.count == maxOptions { break }
        }
        return out
    }

    public static func cleanMap(_ map: JSONValue?) -> JSONValue? {
        guard let map, map.object != nil else { return nil }
        var out: [String: JSONValue] = [:]
        for group in mapGroups {
            var items: [JSONValue] = []
            for item in map[group]?.array ?? [] {
                let given: JSONValue? = item.string != nil ? ["text": item] : item.object != nil ? item : nil
                let text = given.map { clip($0["text"], 200) } ?? ""
                if text.isEmpty { continue }
                items.append(["text": .string(text), "from": .string(clip(given?["from"], 160))])
                if items.count == maxMapItems { break }
            }
            out[group] = .array(items)
        }
        return .object(out)
    }
    public static func mapHolds(_ map: JSONValue?) -> Bool { guard let map else { return false }; return mapGroups.contains { !(map[$0]?.array?.isEmpty ?? true) } }

    public static func readCard(_ text: String?) -> JSONValue? {
        guard let text else { return nil }
        if let card = cleanCard(parseJson(text)) { return card }
        for block in jsonBlocks(text).reversed() { if let found = cleanCard(parse(block)) { return found } }
        return nil
    }

    public static func cleanCard(_ value: JSONValue?) -> JSONValue? {
        guard let value, value.object != nil else { return nil }
        let say = clipText(value["say"], 1500)
        let kind: String = { switch value["card"] { case .string(let s)?: return s.lowercased(); case .bool(true)?: return "true"; default: return "" } }()
        if kind == "none" || value["ready"] == .bool(true) { return say.isEmpty ? nil : ["say": .string(say), "card": "none", "ready": true] }
        let map = cleanMap(value["map"])
        if kind == "focus" {
            let focus = value["focus"].flatMap { $0.object != nil ? $0 : nil } ?? .object([:])
            let options = cleanOptions(focus["options"])
            if options.count < 2 { return nil }
            let title = clip(focus["title"], 300)
            var o: [String: JSONValue] = ["say": .string(say), "card": "focus", "focus": ["title": .string(title.isEmpty ? "What should we focus on?" : title), "options": .array(options)], "ready": false]
            if let map { o["map"] = map }
            return .object(o)
        }
        if kind == "questions" {
            let questions = value["questions"].flatMap { $0.object != nil ? $0 : nil } ?? .object([:])
            guard let item = questions["items"]?.array?.first(where: { $0.object != nil }), let type = item["type"]?.string, types.contains(type) else { return nil }
            let title = clip(item["title"], 300)
            if title.isEmpty { return nil }
            let id = clip(item["id"], 40)
            var q: [String: JSONValue] = ["id": .string(id.isEmpty ? "q" : id), "type": .string(type), "title": .string(title)]
            let subtitle = clip(item["subtitle"], 300)
            if !subtitle.isEmpty { q["subtitle"] = .string(subtitle) }
            if type == "mcq" || type == "select_all" {
                let options = cleanOptions(item["options"])
                if options.count < 2 { return nil }
                q["options"] = .array(options)
            } else {
                let placeholder = clip(item["placeholder"], 120)
                if !placeholder.isEmpty { q["placeholder"] = .string(placeholder) }
            }
            var qs: [String: JSONValue] = ["items": .array([.object(q)])]
            let eyebrow = clip(questions["eyebrow"], 60)
            if !eyebrow.isEmpty { qs["eyebrow"] = .string(eyebrow) }
            var o: [String: JSONValue] = ["say": .string(say), "card": "questions", "questions": .object(qs), "ready": false]
            if let map { o["map"] = map }
            return .object(o)
        }
        return nil
    }

    /// An answer as the document holds it → the card it is, or nil. Only a card that asks something.
    public static func cardOfAnswer(_ answer: String?) -> JSONValue? {
        guard let m = Rx(#"^```json[ \t]*\n([\s\S]*)\n```$"#).match((answer ?? "").trimmed), let value = parse(m[1] ?? ""),
              let card = cleanCard(value), card["card"]?.string != "none" else { return nil }
        return card
    }

    public static func questionOf(_ card: JSONValue?) -> CardQuestion? {
        guard let card else { return nil }
        if card["card"]?.string == "focus" {
            return CardQuestion(id: nil, type: "focus", title: card["focus"]?["title"]?.string ?? "", subtitle: nil, options: card["focus"]?["options"]?.array ?? [], placeholder: nil, eyebrow: "focus")
        }
        guard let item = card["questions"]?["items"]?.array?.first else { return nil }
        return CardQuestion(id: item["id"]?.string, type: item["type"]?.string ?? "", title: item["title"]?.string ?? "", subtitle: item["subtitle"]?.string,
                            options: item["options"]?.array ?? [], placeholder: item["placeholder"]?.string, eyebrow: card["questions"]?["eyebrow"]?.string ?? "")
    }

    public static func cardAsText(_ card: JSONValue?) -> String {
        guard let card, card["card"]?.string != "none", let asked = questionOf(card) else { return "" }
        return ([card["say"]?.string ?? "", asked.title] + asked.labels.map { "- \($0)" }).filter { !$0.isEmpty }.joined(separator: "\n")
    }

    public static func isChoice(_ type: String?) -> Bool { type == "mcq" || type == "select_all" || type == "focus" }

    /// The answer as the words after "@brainstorm". Nothing given is Skip.
    public static func answerLine(_ card: JSONValue?, picks: [String] = [], text: String? = nil, note: String? = nil) -> String {
        let asked = questionOf(card)
        let labels = asked?.labels ?? []
        let chosen = picks.filter { labels.contains($0) }
        let n = squash(note ?? "")
        if let asked, isChoice(asked.type), chosen.isEmpty { return n.isEmpty ? skipped : n }
        let said = asked.map { isChoice($0.type) } == true ? "picked \(chosen.map { "\"\($0)\"" }.joined(separator: ", "))" : squash(text ?? "")
        if said.isEmpty { return skipped }
        return n.isEmpty ? said : "\(said); note: \(n)"
    }

    public static func readWrap(_ text: String?) -> (wrap: Bool, rest: String) {
        let said = (text ?? "").trimmed
        if said == wrap { return (true, "") }
        if let m = Rx(#"^([\s\S]*?)\s*;\s*\(wrap up\)$"#).match(said) { return (true, (m[1] ?? "").trimmed) }
        return (false, said)
    }
    public static func withWrap(_ said: String?) -> String { (said ?? "").isEmpty || said == skipped ? wrap : "\(said!); \(wrap)" }

    /// The words after "@brainstorm" read back against the card they answer.
    public static func readAnswer(_ text: String?, _ card: JSONValue?) -> CardAnswer {
        let (w, said) = readWrap(text)
        func out(_ a: CardAnswer) -> CardAnswer { var a = a; if w { a.wrap = true }; return a }
        if said.isEmpty || said == skipped { return out(CardAnswer(skipped: true, picks: [], text: "", note: "")) }
        if let m = Rx(#"^picked\s+((?:"[^"]*"\s*,\s*)*"[^"]*")\s*(?:;\s*note:\s*([\s\S]*))?$"#, "i").match(said) {
            return out(CardAnswer(skipped: false, picks: Rx(#""([^"]*)""#).matchAll(m[1] ?? "").map { $0[1] ?? "" }, text: "", note: (m[2] ?? "").trimmed))
        }
        if let asked = questionOf(card), isChoice(asked.type), let same = asked.labels.first(where: { $0.lowercased() == said.lowercased() }) {
            return out(CardAnswer(skipped: false, picks: [same], text: "", note: ""))
        }
        return out(CardAnswer(skipped: false, picks: [], text: said, note: ""))
    }

    public static let recapLabels = ["Where you are", "What pulls apart", "What's unclear", "Next, you said", "Where you'll look next", "What you know", "Where it thins out", "What draws you", "Your question", "What puzzles you", "What you took from it", "Look for"]
    static let recapLineRE = Rx("^\\s*(" + recapLabels.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|") + ")\\s*[:：]\\s*(.*)$", "i")

    /// One line of a recap → (label, text) when it starts with a recap label.
    public static func recapLine(_ line: String?) -> (label: String, text: String)? {
        guard let m = recapLineRE.match((line ?? "").replacingOccurrences(of: "’", with: "'")), let found = m[1],
              let label = recapLabels.first(where: { $0.lowercased() == found.lowercased() }) else { return nil }
        return (label, (m[2] ?? "").trimmed)
    }

    /// A reply read as a result → the sentence when its last line is the offer, else nil.
    public static func resultParts(_ text: String?) -> String? {
        let lines = (text ?? "").trimmed.components(separatedBy: "\n")
        guard lines.count >= 2, isResultOffer(lines.last) else { return nil }
        let sentence = squash(lines.dropLast().joined(separator: " "))
        return sentence.isEmpty ? nil : sentence
    }
    public static func resultText(_ sentence: String?) -> String { let s = squash(sentence ?? ""); return s.isEmpty ? leftOpen : "\(s)\n\(resultOffer)" }
}
