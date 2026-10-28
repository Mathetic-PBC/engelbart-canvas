import Foundation

// Find in a pdf and a link's section (PaperView.jsx find/showSection; src/renderer/model/find.js; the typography fold of
// src/shared/passage-text.cjs). Offsets are UTF-16, as in the JS strings they were made for.

public struct FindSpot: Equatable, Sendable {
    public var page: Int
    public var from: Int
    /// nil: to the end of the page.
    public var to: Int?
    public init(page: Int, from: Int, to: Int?) { self.page = page; self.from = from; self.to = to }
}

public enum PaperFind {
    /// Space in the query matches any run of space or none (lines and words are separate runs), and a word may be broken
    /// by a hyphen at the end of a line ("construc-\ntion"): the hyphen-newline rule (2026-09-22, 49/56 → pdftotext's count).
    public static func findPattern(_ query: String) -> NSRegularExpression? {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
        if words.isEmpty { return nil }
        let src = words.map { w in w.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "(?:-\\n)?") }.joined(separator: "\\s*")
        return try? NSRegularExpression(pattern: src, options: [.caseInsensitive])
    }

    /// Where a query matches, page by page in order. A passage of three or more words found nowhere is matched again
    /// typography-folded (curly quotes, dashes, ligatures, soft hyphens: passage-text.cjs matchPassage).
    public static func matchSpots(_ query: String, pages: [(page: Int, text: String)]) -> [FindSpot] {
        var spots: [FindSpot] = []
        if let re = findPattern(query) {
            for (page, text) in pages {
                for m in re.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)) where m.range.length > 0 {
                    spots.append(FindSpot(page: page, from: m.range.location, to: m.range.location + m.range.length))
                }
            }
        }
        if !spots.isEmpty || query.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .whitespacesAndNewlines).filter({ !$0.isEmpty }).count < 3 { return spots }
        for (page, text) in pages { for hit in PassageText.matchPassage(text, query) { spots.append(FindSpot(page: page, from: hit.start, to: hit.end)) } }
        return spots
    }

    /// Which match is in front after a search, and whether to scroll to it (find.js nextFind).
    public static func nextFind(fresh: Bool, step: Int = 0, count: Int, at: Int, fromStart: Bool = false, firstInView: () -> Int = { 0 }) -> (at: Int, scroll: Bool) {
        if count == 0 { return (-1, false) }
        let next: Int
        if fromStart { next = 0 }
        else if fresh || at < 0 { next = step < 0 ? count - 1 : firstInView() }
        else if step != 0 { next = ((at + step) % count + count) % count }
        else { next = min(at, count - 1) }
        return (next, fresh || step != 0 || fromStart)
    }

    public static let SECTION_PAGES = 6

    /// The stretch a section covers, page by page; nil when `to` matches nowhere after the start or too far on.
    public static func sectionSpans(_ start: FindSpot?, _ ends: [FindSpot]) -> [FindSpot]? {
        guard let start else { return nil }
        let startTo = start.to ?? Int.max
        guard let end = ends.first(where: { $0.page > start.page || ($0.page == start.page && $0.from >= startTo) }),
              end.page - start.page <= SECTION_PAGES else { return nil }
        if end.page == start.page { return [FindSpot(page: start.page, from: start.from, to: end.from)] }
        var spans = [FindSpot(page: start.page, from: start.from, to: nil)]
        if start.page + 1 < end.page { for page in (start.page + 1)..<end.page { spans.append(FindSpot(page: page, from: 0, to: nil)) } }
        spans.append(FindSpot(page: end.page, from: 0, to: end.from))
        return spans
    }

    /// A link's target as the gate holds it: the passage, and the start of the section after it when there is one.
    public static func targetKey(_ find: String?, _ to: String?) -> String {
        guard let find, !find.isEmpty else { return "" }
        if let to, !to.isEmpty { return "\(find)\n\(to)" }
        return find
    }
}

/// A link's passage waiting for the pages (find.js createTargetGate): found once, after drawing, until cleared and given again.
public final class TargetGate {
    private var target = "", done = "", ready = false
    public init() {}
    private func take() -> String? {
        if !ready || target.isEmpty || target == done { return nil }
        done = target
        return target
    }
    @discardableResult public func set(_ next: String?) -> String? { target = next ?? ""; if target.isEmpty { done = "" }; return take() }
    public func drawing() { ready = false }
    public func drawn() -> String? { ready = true; return take() }
    public func peek() -> String? { !target.isEmpty && target != done ? target : nil }
    public func claim() { if !target.isEmpty { done = target } }
}

/// How a quoted passage is found in a text whatever its typography (src/shared/passage-text.cjs foldPassage/matchPassage,
/// without the workspace-line options, which a pdf never needs).
public enum PassageText {
    static let ONE: [UInt16: UInt16] = [
        0x2018: 0x27, 0x2019: 0x27, 0x201A: 0x27, 0x201B: 0x27, 0x2032: 0x27,
        0x201C: 0x22, 0x201D: 0x22, 0x201E: 0x22, 0x201F: 0x22, 0x2033: 0x22,
        0x2010: 0x2D, 0x2011: 0x2D, 0x2012: 0x2D, 0x2013: 0x2D, 0x2014: 0x2D, 0x2015: 0x2D, 0x2212: 0x2D,
    ]
    static let LIGATURES: [UInt16: String] = [0xFB00: "ff", 0xFB01: "fi", 0xFB02: "fl", 0xFB03: "ffi", 0xFB04: "ffl", 0xFB05: "st", 0xFB06: "st"]

    static func isSpace(_ c: UInt16) -> Bool {
        guard let s = Unicode.Scalar(c) else { return false }
        return s.properties.isWhitespace || c == 0xFEFF
    }
    static func isHyphen(_ c: UInt16) -> Bool { c == 0x2D || (0x2010...0x2015).contains(c) || c == 0x2212 }
    static func isLetter(_ c: UInt16?) -> Bool {
        guard let c, let s = Unicode.Scalar(c) else { return false }
        switch s.properties.generalCategory { case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true; default: return false }
    }
    static func lower(_ c: UInt16) -> [UInt16] {
        guard let s = Unicode.Scalar(c) else { return [c] }
        return Array(String(s).lowercased().utf16)
    }

    /// `text` folded → (folded UTF-16, map: offset each folded unit came from).
    public static func fold(_ input: String) -> (text: [UInt16], map: [Int]) {
        let src = Array(input.utf16)
        var out: [UInt16] = [], map: [Int] = []
        func push(_ cs: [UInt16], _ at: Int) { for c in cs { out.append(c); map.append(at) } }
        func space(_ at: Int) { if let last = out.last, last != 0x20 { push([0x20], at) } }
        var i = 0
        while i < src.count {
            let c = src[i]
            if c == 0x0A { space(i); i += 1; continue }
            if isSpace(c) { space(i); i += 1; continue }
            if c == 0xAD { i += 1; continue } // soft hyphen
            if isHyphen(c), i > 0, isLetter(src[i - 1]) {
                // "construc-\ntion": a hyphen at a line's end between letters joins the word (a lowercase letter after)
                var j = i + 1
                while j < src.count, src[j] == 0x20 || src[j] == 0x09 { j += 1 }
                if j < src.count, src[j] == 0x0D { j += 1 }
                if j < src.count, src[j] == 0x0A {
                    j += 1
                    while j < src.count, isSpace(src[j]) { j += 1 }
                    if j < src.count, isLetter(src[j]), lower(src[j]) == [src[j]], j - i < 40 { i = j; continue }
                }
            }
            if let one = ONE[c] { push([one], i); i += 1; continue }
            if let lig = LIGATURES[c] { push(Array(lig.utf16), i); i += 1; continue }
            push(lower(c), i)
            i += 1
        }
        while out.last == 0x20 { out.removeLast(); map.removeLast() }
        return (out, map)
    }

    static func without(_ folded: (text: [UInt16], map: [Int]), _ drop: Set<UInt16>) -> (text: [UInt16], map: [Int]) {
        var t: [UInt16] = [], m: [Int] = []
        for (i, c) in folded.text.enumerated() where !drop.contains(c) { t.append(c); m.append(folded.map[i]) }
        return (t, m)
    }

    static func indices(of needle: [UInt16], in hay: [UInt16]) -> [Int] {
        guard !needle.isEmpty, needle.count <= hay.count else { return [] }
        var out: [Int] = []
        var i = 0
        while i <= hay.count - needle.count {
            if hay[i] == needle[0] && Array(hay[i..<(i + needle.count)]) == needle { out.append(i) }
            i += 1
        }
        return out
    }

    /// Every place `words` are in `text` → (start, end) offsets into `text`.
    public static func matchPassage(_ text: String, _ words: String) -> [(start: Int, end: Int)] {
        let hay = fold(text), want = fold(words).text
        if want.isEmpty { return [] }
        let tries: [((text: [UInt16], map: [Int]), [UInt16])] = [
            (hay, want),
            (without(hay, [0x2D]), want.filter { $0 != 0x2D }),
            (without(hay, [0x2D, 0x20]), want.filter { $0 != 0x2D && $0 != 0x20 }),
        ]
        for (h, w) in tries where !w.isEmpty {
            let hits = indices(of: w, in: h.text).map { (start: h.map[$0], end: h.map[$0 + w.count - 1] + 1) }
            if !hits.isEmpty { return hits }
        }
        return []
    }
}
