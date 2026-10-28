import Foundation
import EngelbartCore

// A pdf's ink as the Electron app keeps it (src/main/store/library.cjs readAnnotations/writeAnnotations, written by
// src/renderer/pdf/PaperView.jsx): { "<page>": [Mark], … }, geometry in page units (fractions of the page's drawn width)
// so it survives any zoom. Every field Electron writes is modelled; anything else a mark or an answer carries is kept as
// it came (`extra`) so a file written by either app reads the same in the other.

/// A box in any one unit (layout px or page units). marks.js `{ x, y, w, h }`.
public struct PRect: Equatable, Hashable, Sendable {
    public var x: Double, y: Double, w: Double, h: Double
    public init(_ x: Double, _ y: Double, _ w: Double, _ h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
    public init(x: Double, y: Double, w: Double, h: Double) { self.init(x, y, w, h) }
    var bottom: Double { y + h }
    var right: Double { x + w }
    func scaled(_ k: Double) -> PRect { PRect(x * k, y * k, w * k, h * k) }
}

public struct PPoint: Equatable, Hashable, Sendable {
    public var x: Double, y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// An answer Bart gave from a highlight's note (shared/mark-answers.cjs askEntry), as the mark keeps it.
public struct AskEntry: Equatable, Sendable {
    public var id: String
    public var question: String?
    public var answer: String?
    public var meta: JSONValue?
    public var at: String?
    /// `pos` is kept as it came (null since the one-card change of 2026-10-06; an older answer may hold a place, no longer read).
    public var pos: JSONValue?
    public var collapsed: Bool?
    public var crop: String?
    /// Deleted: no longer drawn, still a turn of its exchange while the session lasts (canvas.js exchangeOf).
    public var deleted: Bool?
    public var extra: [String: JSONValue] = [:]

    public init(id: String, question: String? = nil, answer: String? = nil, meta: JSONValue? = nil, at: String? = nil,
                pos: JSONValue? = .null, collapsed: Bool? = false, crop: String? = nil, deleted: Bool? = nil) {
        self.id = id; self.question = question; self.answer = answer; self.meta = meta; self.at = at; self.pos = pos
        self.collapsed = collapsed; self.crop = crop; self.deleted = deleted
    }
}

/// A mark: a highlight (with `rects`) and its note, or a note typed anywhere (no rects, a `pos`).
public struct Mark: Equatable, Sendable {
    public var id: String
    public var rects: [PRect]
    public var side: String?
    public var y: Double
    public var note: String?
    public var text: String
    public var pos: PPoint?
    /// A part of a selection across pages (MATH-14): the parts share it.
    public var group: String?
    /// The width (note px) a typed or moved note keeps.
    public var w: Double?
    public var asks: [AskEntry]?
    public var extra: [String: JSONValue] = [:]

    public init(id: String, rects: [PRect] = [], side: String? = nil, y: Double = 0, note: String? = nil, text: String = "",
                pos: PPoint? = nil, group: String? = nil, w: Double? = nil, asks: [AskEntry]? = nil) {
        self.id = id; self.rects = rects; self.side = side; self.y = y; self.note = note; self.text = text; self.pos = pos
        self.group = group; self.w = w; self.asks = asks
    }

    /// A highlight is a mark with rects (its note may have been moved: `pos`).
    public var isHighlight: Bool { !rects.isEmpty }
    /// Held as one with a note: never merged into another (marks.js hasNote).
    var hasNote: Bool { note != nil || !(asks ?? []).isEmpty }
}

/// A pdf's ink: its pages' marks, and any other key the file holds (a web page's "web" list) kept as it came.
public struct PaperMarks: Equatable, Sendable {
    public var pages: [Int: [Mark]] = [:]
    public var other: [String: JSONValue] = [:]
    public init(pages: [Int: [Mark]] = [:], other: [String: JSONValue] = [:]) { self.pages = pages; self.other = other }

    public subscript(page: Int) -> [Mark] {
        get { pages[page] ?? [] }
        set { pages[page] = newValue }
    }

    /// The mark `id` and its page (PaperView findMark).
    public func find(_ id: String) -> (page: Int, index: Int, mark: Mark)? {
        for page in pages.keys.sorted() {
            if let i = pages[page]!.firstIndex(where: { $0.id == id }) { return (page, i, pages[page]![i]) }
        }
        return nil
    }

    /// Changes the mark `id` in place; → whether it was there.
    @discardableResult
    public mutating func update(_ id: String, _ change: (inout Mark) -> Void) -> Bool {
        guard let at = find(id) else { return false }
        change(&pages[at.page]![at.index])
        return true
    }
}

/* ------------------------------------------------------------------------------------------------ marks.js */

enum MarkGeometry {
    static let LINE = 0.5   // same line: vertical overlap of at least half the smaller height
    static let GAP = 0.6    // within a line, a gap under 0.6 × the line's height is joined
    static let SLACK = 0.2  // "inside" allows this share of a line's height at either end
    static let SIDE = 0.45  // a selection centred left of 45% of the page has its note on the left
    static let BAND_GAP = 1.6
    static let TALL = 1.8
}

public enum Marks {
    static func vOverlap(_ a: PRect, _ b: PRect) -> Double { min(a.bottom, b.bottom) - max(a.y, b.y) }

    /// Two rects on the same line: their vertical overlap is at least half the smaller height.
    public static func sameLine(_ a: PRect, _ b: PRect) -> Bool { vOverlap(a, b) >= MarkGeometry.LINE * min(a.h, b.h) }

    /// Same line and some horizontal overlap.
    public static func boxesOverlap(_ a: PRect, _ b: PRect) -> Bool { sameLine(a, b) && min(a.right, b.right) > max(a.x, b.x) }

    static func usable(_ r: PRect) -> Bool { [r.x, r.y, r.w, r.h].allSatisfy { $0.isFinite } && r.w > 0 && r.h > 0 }

    static func union(_ list: [PRect]) -> PRect {
        let x = list.map(\.x).min()!, y = list.map(\.y).min()!
        return PRect(x, y, list.map(\.right).max()! - x, list.map(\.bottom).max()! - y)
    }

    /// Rects merged into one box per stretch of a line (marks.js mergeLineRects).
    public static func mergeLineRects(_ rects: [PRect]) -> [PRect] {
        var lines: [(band: PRect, members: [PRect])] = []
        let sorted = rects.filter(usable).enumerated().sorted { a, b in
            let ka = a.element.y + a.element.h / 2, kb = b.element.y + b.element.h / 2
            return ka != kb ? ka < kb : a.offset < b.offset // Array.sort in JS is stable
        }.map(\.element)
        for r in sorted {
            if let i = lines.firstIndex(where: { sameLine($0.band, r) }) {
                lines[i].members.append(r); lines[i].band = union([lines[i].band, r])
            } else { lines.append((r, [r])) }
        }
        lines = lines.enumerated().sorted { a, b in a.element.band.y != b.element.band.y ? a.element.band.y < b.element.band.y : a.offset < b.offset }.map(\.element)
        var out: [PRect] = []
        for (band, members) in lines {
            var box: PRect?
            for r in members.enumerated().sorted(by: { $0.element.x != $1.element.x ? $0.element.x < $1.element.x : $0.offset < $1.offset }).map(\.element) {
                if let b = box, r.x - b.right < MarkGeometry.GAP * band.h { box = union([b, r]) } else {
                    if let b = box { out.append(b) }
                    box = r
                }
            }
            if let b = box { out.append(b) }
        }
        return out
    }

    /// A mark's rects as continuous bands (2026-10-16: "Highlights should be continuous … stretch across spaces").
    public static func bandRects(_ rects: [PRect]) -> [PRect] {
        var out: [PRect] = []
        for b in mergeLineRects(rects) {
            if let prev = out.last, sameLine(prev, b), b.x >= prev.x, b.x - prev.right < MarkGeometry.BAND_GAP * min(prev.h, b.h) {
                out[out.count - 1] = union([prev, b])
            } else { out.append(b) }
        }
        return out
    }

    /// Each of `inner` lies inside one of `outer`, give or take SLACK of the line's height.
    public static func boxesInside(_ inner: [PRect], _ outer: [PRect]) -> Bool {
        !inner.isEmpty && inner.allSatisfy { a in
            outer.contains { b in
                let slack = MarkGeometry.SLACK * min(a.h, b.h)
                return sameLine(a, b) && a.x >= b.x - slack && a.right <= b.right + slack
            }
        }
    }

    /// 'left' or 'right': the side a note goes on, from the boxes' mean centre over a page `width` wide.
    public static func sideOf(_ boxes: [PRect], width: Double = 1) -> String {
        if boxes.isEmpty { return "right" }
        let cx = boxes.reduce(0.0) { $0 + $1.x + $1.w / 2 } / Double(boxes.count)
        return cx / width < MarkGeometry.SIDE ? "left" : "right"
    }

    /// A rough.js seed (never 0) fixed by a box's place on its page, in page units.
    public static func boxSeed(page: Int, _ box: PRect) -> Int {
        let h = Double(page) * 7919 + jsRound(box.y * 1000) * 131 + jsRound(box.x * 1000)
        return 1 + Int(abs(h).truncatingRemainder(dividingBy: 2147483646))
    }

    static func squash(_ s: String) -> String {
        s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Two texts in reading order as one: where the end of `a` is the start of `b`, it is written once.
    static func joinText(_ a: String, _ b: String) -> String {
        if a.isEmpty { return b }
        if b.isEmpty || a.contains(b) { return a }
        if b.contains(a) { return b }
        let au = Array(a.utf16), bu = Array(b.utf16)
        var k = min(au.count, bu.count) - 1
        while k >= 3 {
            if Array(au.suffix(k)) == Array(bu.prefix(k)) { return a + String(utf16CodeUnits: Array(bu[k...]), count: bu.count - k) }
            k -= 1
        }
        return "\(a) \(b)"
    }

    static func joins(_ a: Mark, _ b: Mark) -> Bool { a.group == nil || b.group == nil || a.group == b.group }

    /// Where a new selection highlight goes among a page's marks (marks.js placeHighlight) → the page's marks after, and
    /// the mark that holds the selection now.
    public static func placeHighlight(_ marks: [Mark], _ mark: Mark) -> (list: [Mark], mark: Mark) {
        let boxes = mergeLineRects(mark.rects)
        if boxes.isEmpty { return (marks + [mark], mark) }
        let hits = marks.filter { m in m.isHighlight && mergeLineRects(m.rects).contains { b in boxes.contains { a in boxesOverlap(a, b) } } }
        if let host = hits.first(where: { boxesInside(boxes, mergeLineRects($0.rects)) && joins($0, mark) }) {
            let note = mark.note != nil && host.note == nil ? mark.note : host.note
            let group = host.group ?? mark.group
            if note == host.note && group == host.group { return (marks, host) }
            var next = host
            next.note = note
            if let group { next.group = group }
            return (marks.map { $0.id == host.id ? next : $0 }, next)
        }
        var groups: [String] = []
        for g in (hits + [mark]).compactMap(\.group) where !groups.contains(g) { groups.append(g) }
        if hits.isEmpty || mark.hasNote || hits.contains(where: { $0.hasNote }) || groups.count > 1 { return (marks + [mark], mark) }
        let merged = mergeLineRects(hits.flatMap(\.rects) + mark.rects)
        let covers = hits.allSatisfy { boxesInside(mergeLineRects($0.rects), boxes) }
        let reading = (hits + [mark]).enumerated().map { (i: $0.offset, m: $0.element, b: mergeLineRects($0.element.rects)[0]) }
            .sorted { p, q in
                let d = sameLine(p.b, q.b) ? p.b.x - q.b.x : p.b.y - q.b.y
                return d != 0 ? d < 0 : p.i < q.i
            }.map(\.m)
        let earliest = hits[0]
        var next = earliest
        next.rects = merged
        next.side = sideOf(merged)
        next.y = ([mark.y] + hits.map(\.y)).min()!
        next.text = covers ? mark.text : squash(reading.reduce("") { joinText($0, squash($1.text)) })
        if let g = groups.first { next.group = g }
        let hitIds = Set(hits.map(\.id))
        var out: [Mark] = []
        for m in marks {
            if m.id == earliest.id { out.append(next) } else if !hitIds.contains(m.id) { out.append(m) }
        }
        return (out, next)
    }

    /* ------------------------------------------------------------------ a selection across pages (MATH-14) */

    /// Rects with stray slivers dropped (2026-10-08, "a thin vertical line also highlights").
    public static func dropSlivers(_ rects: [PRect]) -> [PRect] {
        let list = rects.filter(usable)
        if list.count < 2 { return list }
        let hs = list.map(\.h).sorted(), median = hs[(hs.count - 1) / 2]
        return list.filter { !($0.h > MarkGeometry.TALL * median && $0.w < $0.h) }
    }

    /// A selection's part on one page: rects in layout px of that page, the side its note goes on, its top, its text, and
    /// `u` the page's drawn width when it was measured.
    public struct Part: Equatable, Sendable {
        public var page: Int
        public var rects: [PRect]
        public var side: String
        public var y: Double
        public var text: String
        public var u: Double
        public init(page: Int, rects: [PRect], side: String, y: Double, text: String, u: Double) {
            self.page = page; self.rects = rects; self.side = side; self.y = y; self.text = text; self.u = u
        }
    }

    public struct Piece { public var page: Int; public var rects: [PRect]; public var width: Double; public var text: String; public var u: Double
        public init(page: Int, rects: [PRect], width: Double, text: String, u: Double) { self.page = page; self.rects = rects; self.width = width; self.text = text; self.u = u }
    }

    /// A selection's pieces, one a page → its parts in page order (marks.js selectionParts).
    public static func selectionParts(_ pieces: [Piece]) -> [Part] {
        var out: [Part] = []
        for p in pieces {
            let boxes = bandRects(dropSlivers(p.rects))
            if !boxes.isEmpty { out.append(Part(page: p.page, rects: boxes, side: sideOf(boxes, width: p.width), y: boxes.map(\.y).min()!, text: p.text, u: p.u)) }
        }
        return out.enumerated().sorted { $0.element.page != $1.element.page ? $0.element.page < $1.element.page : $0.offset < $1.offset }.map(\.element)
    }

    /// A part drawn at another size: its geometry (px of a page `from` wide) scaled to a page `to` wide.
    public static func scalePart(_ part: Part, from: Double?, to: Double) -> Part {
        let f = (from ?? 0) != 0 ? from! : to
        let k = to / f
        var out = part
        out.rects = part.rects.map { $0.scaled(k) }
        out.y = part.y * k
        out.u = to
        return out
    }

    /// The marks a selection's parts make, one a part, in page units (marks.js partMarks).
    public static func partMarks(_ parts: [Part], note: String?, newId: (String) -> String, widthOf: (Int) -> Double) -> [(page: Int, mark: Mark)] {
        let list = parts.filter { !$0.rects.isEmpty }
        let group = list.count > 1 ? newId("g") : nil
        return list.enumerated().map { i, p in
            let w = widthOf(p.page), u = w != 0 && w.isFinite ? w : 1
            var mark = Mark(id: newId("m"), rects: p.rects.map { $0.scaled(1 / u) }, side: p.side, y: p.y / u, note: i == 0 ? note : nil, text: p.text, pos: nil)
            mark.group = group
            return (p.page, mark)
        }
    }

    /// The passage a mark is part of: its own text, or for a part of a selection across pages every part of its group.
    public static func passageOf(_ marks: PaperMarks, _ mark: Mark?) -> String {
        guard let mark else { return "" }
        guard let group = mark.group else { return mark.text }
        var parts: [(page: Int, y: Double, i: Int, text: String)] = []
        for (page, list) in marks.pages {
            for (i, m) in list.enumerated() where m.group == group { parts.append((page, m.y.isFinite ? m.y : 0, i, m.text)) }
        }
        if parts.isEmpty { return mark.text }
        return parts.sorted { a, b in a.page != b.page ? a.page < b.page : a.y != b.y ? a.y < b.y : a.i < b.i }
            .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    /// How far a note may be pushed down its own margin before the other one is tried (2026-10-06).
    public static let NOTE_SLACK = 200.0

    public struct NoteItem { public var id: String; public var ideal: Double; public var h: Double; public var side: String
        public init(id: String, ideal: Double, h: Double, side: String) { self.id = id; self.ideal = ideal; self.h = h; self.side = side }
    }

    /// Where the margin notes of one page go so none covers another (marks.js stackNotes) → id → (top, side).
    public static func stackNotes(_ items: [NoteItem], pageH: Double = .infinity, gap: Double = 8, slack: Double = NOTE_SLACK) -> [String: (top: Double, side: String)] {
        var out: [String: (top: Double, side: String)] = [:]
        var placed: [String: [(id: String, top: Double, h: Double)]] = ["left": [], "right": []]
        var bottom: [String: Double] = ["left": -.infinity, "right": -.infinity]
        let order = items.enumerated().sorted { $0.element.ideal != $1.element.ideal ? $0.element.ideal < $1.element.ideal : $0.offset < $1.offset }.map(\.element)
        for it in order {
            let own = it.side == "left" ? "left" : "right", other = own == "left" ? "right" : "left"
            func at(_ side: String) -> Double { max(it.ideal, bottom[side]! + gap) }
            let side = at(own) - it.ideal > slack && at(other) < at(own) ? other : own
            let top = at(side)
            bottom[side] = top + it.h
            placed[side]!.append((it.id, top, it.h))
            out[it.id] = (top, side)
        }
        for side in ["left", "right"] {
            var limit = pageH
            for n in placed[side]!.reversed() {
                if n.top + n.h <= limit { break }
                let top = max(0, limit - n.h)
                limit = top - gap
                out[n.id] = (top, side)
            }
        }
        return out
    }

    /* ------------------------------------------------------------- whole words, and the page around a passage */

    static func isWordUnit(_ c: UInt16) -> Bool {
        if c == 0x5F || c == 0x27 || c == 0x2019 || c == 0x2D { return true } // _ ' ’ -
        guard let scalar = Unicode.Scalar(c) else { return true } // a surrogate half: part of a letter outside the BMP
        let p = scalar.properties.generalCategory
        switch p {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .nonspacingMark, .spacingMark, .enclosingMark, .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }
    static func isDigit(_ c: UInt16?) -> Bool { guard let c else { return false }; return c >= 0x30 && c <= 0x39 }

    /// A stretch widened to whole words at both ends (marks.js wordBounds), offsets in UTF-16 units as JS strings are.
    public static func wordBounds(_ text: String, from: Int, to: Int) -> (from: Int, to: Int) {
        let s = Array(text.utf16)
        func word(_ i: Int) -> Bool {
            guard i >= 0, i < s.count else { return false }
            if isWordUnit(s[i]) { return true }
            return (s[i] == 0x2E || s[i] == 0x2C) && isDigit(i > 0 ? s[i - 1] : nil) && isDigit(i + 1 < s.count ? s[i + 1] : nil)
        }
        var a = from, b = to
        while a > 0 && word(a - 1) && word(a) { a -= 1 }
        while b < s.count && word(b - 1) && word(b) { b += 1 }
        return (a, b)
    }

    public static let PAGE_TEXT = 4000

    static func escapeRegex(_ s: String) -> String { NSRegularExpression.escapedPattern(for: s) }

    /// Words as find matches them: any run of space or none between them, a word broken at a line's end.
    static func wordsPattern(_ words: [String]) -> String {
        words.map { w in w.map { escapeRegex(String($0)) }.joined(separator: "(?:-\\n)?") }.joined(separator: "\\s*")
    }

    /// Where `passage` is in `page` → [from, to] (UTF-16), by its first and last eight words; nil when not found.
    public static func findPassage(_ page: String, _ passage: String) -> (Int, Int)? {
        let words = squash(passage).split(separator: " ").map(String.init).filter { !$0.isEmpty }
        if words.isEmpty { return nil }
        let ns = page as NSString
        guard let headRe = try? NSRegularExpression(pattern: wordsPattern(Array(words.prefix(8))), options: [.caseInsensitive]),
              let head = headRe.firstMatch(in: page, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let tailRe = try? NSRegularExpression(pattern: wordsPattern(Array(words.suffix(8))), options: [.caseInsensitive])
        let end = tailRe?.firstMatch(in: page, range: NSRange(location: head.range.location, length: ns.length - head.range.location))
        return (head.range.location, end.map { $0.range.location + $0.range.length } ?? head.range.location + head.range.length)
    }

    static func tidy(_ t: String) -> String {
        let lines = t.components(separatedBy: "\n").map { $0.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: " \t\r\u{0B}\u{0C}\u{A0}").union(.whitespaces)) }
        return lines.joined(separator: "\n").replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The text of a page around a highlighted passage, as a question from it carries it (marks.js pageWindow).
    public static func pageWindow(_ text: String, _ passage: String, max: Int = PAGE_TEXT, at: Double? = nil) -> String {
        let ns = text as NSString, n = ns.length
        if n <= max { return tidy(text) }
        let found = findPassage(text, passage)
        let mid = found.map { Double($0.0 + $0.1) / 2 } ?? Swift.max(0, Swift.min(1, (at?.isFinite ?? false) ? at! : 0.5)) * Double(n)
        var b = Swift.min(n, Swift.max(0, Int(jsRound(mid - Double(max) / 2))) + max)
        var a = Swift.max(0, b - max)
        let space = try! NSRegularExpression(pattern: "\\s")
        if a > 0 {
            let len = Swift.min(40, n - a)
            if let m = space.firstMatch(in: text, range: NSRange(location: a, length: len)) { a = m.range.location + 1 }
        }
        if b < n {
            let from = Swift.max(a, b - 40)
            let last = try! NSRegularExpression(pattern: "\\s\\S*$")
            let slice = ns.substring(with: NSRange(location: from, length: b - from))
            if let m = last.firstMatch(in: slice, range: NSRange(location: 0, length: (slice as NSString).length)) { b = from + m.range.location }
        }
        return "\(a > 0 ? "… " : "")\(tidy(ns.substring(with: NSRange(location: a, length: b - a))))\(b < n ? " …" : "")"
    }
}

/// JS Math.round: halves go up (toward +∞), unlike Swift's `.rounded()`.
@inline(__always) func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }
