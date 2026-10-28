import Foundation
import EngelbartCore
import EngelbartDoc

// The page as a canvas, its pure parts (src/renderer/pdf/canvas.js; the decisions are in its header and in
// docs/superpowers/specs/2026-10-16-pdf-annotations-round.md): card widths and places, the spacing pass, and the answers a
// highlight keeps. Also the shared answer helpers (src/shared/mark-answers.cjs) and the selection card's place
// (src/shared/selection-card.cjs), copied here because this package depends on Core and UI only (ARCHITECTURE §2).

public enum Canvas {
    public static let BOX_GAP = 12.0     // desk px kept between two boxes by the spacing pass
    public static let NOTE_W = 240.0     // the widest a note gets (note px)
    public static let SIDE_GAP = 12.0    // a note beside its page: px from the text's edge
    public static let POS_DY = 11.0      // `pos` is where a box's first line sits: 11px under its top
    public static let NOTE_MIN = 96.0    // the narrowest a highlight's note in a margin gets
    public static let FREE_MIN = 80.0    // the narrowest a note typed anywhere is written
    public static let FREE_FIT = 160.0   // a note typed anywhere is narrowed to this before it is moved in
    public static let EDGE_PAD = 8.0     // px kept between a card and the pane's side
    public static let HIDE_ROOM = 40.0   // note px: a card whose margin shows less is hidden (round 4)
    public static let NOTE_REF = 1050.0  // a page this many px wide draws a note at its laid-out size
    public static let NOTE_FLOOR = 10.0 / 24.0 // the least a note is drawn at: 10px handwriting
    public static let PRESS_MOVE = 4.0   // px: a press that moves less is a click, not a drag
    public static let THREAD_IDLE_MS = 30.0 * 60_000 // main's bart/ask.cjs: how long a session can be resumed

    /// Side space that centres a page of width pageW in a pane of width W.
    public static func sideSpace(_ W: Double, _ pageW: Double) -> Double { max(0, ((W - pageW) / 2).rounded(.down)) }

    /// Screen px per note px for a page drawn pageW px wide.
    public static func noteScale(_ pageW: Double?) -> Double {
        let w = (pageW ?? 0) != 0 ? pageW! : NOTE_REF
        return max(NOTE_FLOOR, w / NOTE_REF)
    }

    /// A card's width where it is now (canvas.js fitWidth).
    public static func fitWidth(_ want: Double, _ room: Double, _ least: Double, _ span: Double) -> Double {
        let most = max(1, min(want, span)), low = min(least, most)
        return jsRound(max(low, min(most, room)))
    }

    /// A note typed anywhere: from `x` to the printed text after it or the edge of what showed (canvas.js freeNoteWidth).
    public static func freeNoteWidth(_ x: Double, _ textAt: Double, _ edge: Double, _ ns: Double = 1) -> Double {
        jsRound(max(FREE_MIN, min(NOTE_W, (min(textAt - 6, edge - 8) - x) / ns)))
    }

    /// The printed text's column on a page from its runs' edges (2nd and 98th percentiles) → (l, r) page units.
    public static func textColumn(_ lefts: [Double], _ rights: [Double]) -> (l: Double, r: Double)? {
        let ls = lefts.filter(\.isFinite).sorted(), rs = rights.filter(\.isFinite).sorted()
        if ls.count < 5 || rs.count < 5 { return nil }
        func at(_ xs: [Double], _ q: Double) -> Double { xs[min(xs.count - 1, Int((q * Double(xs.count)).rounded(.down)))] }
        let l = min(1, max(0, at(ls, 0.02))), r = min(1, max(0, at(rs, 0.98)))
        return r > l ? (l, r) : nil
    }

    /// A box kept in page units → its top-left in a sheet whose page starts at G and is P wide; and back.
    public static func placeOf(_ pos: PPoint, _ G: Double, _ P: Double) -> (left: Double, top: Double) { (G + pos.x * P, pos.y * P - POS_DY) }
    public static func posOf(_ left: Double, _ top: Double, _ G: Double, _ P: Double) -> PPoint { PPoint(x: (left - G) / P, y: (top + POS_DY) / P) }

    public struct SpaceBox: Equatable { public var left, width, height: Double
        public init(left: Double, width: Double, height: Double) { self.left = left; self.width = width; self.height = height }
    }
    public struct SpaceUnit { public var id: String; public var want: Double; public var boxes: [SpaceBox]
        public init(id: String, want: Double, boxes: [SpaceBox]) { self.id = id; self.want = want; self.boxes = boxes }
    }
    public struct FixedBox: Equatable { public var left, top, width, height: Double
        public init(left: Double, top: Double, width: Double, height: Double) { self.left = left; self.top = top; self.width = width; self.height = height }
    }

    /// The spacing pass (canvas.js spaceBoxes) → id → top.
    public static func spaceBoxes(_ units: [SpaceUnit], fixed: [FixedBox] = [], gap: Double = BOX_GAP) -> [String: Double] {
        var placed = fixed
        var out: [String: Double] = [:]
        let order = units.enumerated().sorted { $0.element.want != $1.element.want ? $0.element.want < $1.element.want : $0.offset < $1.offset }.map(\.element)
        for u in order {
            var offs: [Double] = [], o = 0.0
            for b in u.boxes { offs.append(o); o += b.height + gap }
            var top = u.want
            for _ in 0..<10000 {
                var push: Double?
                for (k, b) in u.boxes.enumerated() {
                    let y0 = top + offs[k], y1 = y0 + b.height
                    for r in placed {
                        if r.left >= b.left + b.width || b.left >= r.left + r.width { continue }
                        if y1 + gap <= r.top || r.top + r.height + gap <= y0 { continue }
                        let below = r.top + r.height + gap - offs[k]
                        if push == nil || below > push! { push = below }
                    }
                }
                guard let p = push, p > top else { break }
                top = p
            }
            out[u.id] = top
            for (k, b) in u.boxes.enumerated() { placed.append(FixedBox(left: b.left, top: top + offs[k], width: b.width, height: b.height)) }
        }
        return out
    }

    /* ------------------------------------------------------------------------------------------- answers on a highlight */

    /// The answers a mark shows: all but those deleted.
    public static func shownAsks(_ m: Mark?) -> [AskEntry] { (m?.asks ?? []).filter { $0.deleted != true } }

    static func parseAt(_ s: String?) -> Double {
        guard let s, let d = Time.parse(s) else { return 0 }
        return d.timeIntervalSince1970 * 1000
    }

    /// A mark's exchange at `now` (ms): its answers, a deleted one among them while its session can be resumed.
    public static func exchangeOf(_ m: Mark?, now: Double = Time.ms()) -> [AskEntry] {
        let asks = m?.asks ?? []
        if !asks.contains(where: { $0.deleted == true }) { return asks }
        let last = asks.map { parseAt($0.at) }.max() ?? 0
        return now - last < THREAD_IDLE_MS ? asks : asks.filter { $0.deleted != true }
    }

    /// A free note with nothing in it: it goes when it loses the keyboard, and is never saved.
    public static func emptyFree(_ m: Mark) -> Bool {
        m.rects.isEmpty && (m.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && shownAsks(m).isEmpty
    }

    /// A page's marks as they are saved at `now`.
    public static func keptMarks(_ list: [Mark], now: Double = Time.ms()) -> [Mark] {
        list.filter { !emptyFree($0) }.map { m in
            guard let asks = m.asks, asks.contains(where: { $0.deleted == true }) else { return m }
            let kept = exchangeOf(m, now: now)
            if kept.count == asks.count { return m }
            var out = m; out.asks = kept; return out
        }
    }

    /// The ink as saved at `now`: keptMarks a page, pages left empty left out.
    public static func kept(_ marks: PaperMarks, now: Double = Time.ms()) -> PaperMarks {
        var out = PaperMarks(other: marks.other)
        for (page, list) in marks.pages { let k = keptMarks(list, now: now); if !k.isEmpty { out.pages[page] = k } }
        return out
    }

    public struct Turn: Equatable, Sendable { public var question: String; public var answer: String
        public init(question: String, answer: String) { self.question = question; self.answer = answer }
    }

    /// The earlier turns of a mark's exchange at `now`, as a follow-up sends them.
    public static func turnsOf(_ m: Mark?, now: Double = Time.ms()) -> [Turn] {
        exchangeOf(m, now: now).compactMap { a in a.question.map { Turn(question: $0, answer: a.answer ?? "") } }
    }

    /// A note asks Bart when it starts with @bart → the question (what follows), or nil.
    public static func noteQuestion(_ note: String?) -> String? {
        guard let note else { return nil }
        let re = try! NSRegularExpression(pattern: "^\\s*@bart(?=\\s|$)([\\s\\S]*)$", options: [.caseInsensitive])
        guard let m = re.firstMatch(in: note, range: NSRange(location: 0, length: (note as NSString).length)) else { return nil }
        return (note as NSString).substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public struct PaperRef: Sendable { public var name: String; public var rowId: String?; public var url: String?
        public init(name: String = "", rowId: String? = nil, url: String? = nil) { self.name = name; self.rowId = rowId; self.url = url }
    }

    /// What Continue in workspace appends to the open workspace (canvas.js continueLines).
    public static func continueLines(quote: String, question: String, answer: String, foot: String = "", paper: PaperRef = PaperRef(), page: Int? = nil) -> [String] {
        var name = paper.name.replacingOccurrences(of: "[\\[\\]\\n]", with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { name = "the paper" }
        let where_: String
        if paper.rowId != nil { where_ = "@[\(name)]" } else if let url = paper.url, url.range(of: "^https?:", options: [.regularExpression, .caseInsensitive]) != nil { where_ = "[\(name)](\(url))" } else { where_ = name }
        let said = Marks.squash(quote)
        var lines: [String] = []
        if !said.isEmpty { lines.append("“\(said)” (\(where_)\(page.map { ", p. \($0)" } ?? ""))") }
        lines.append("@chat " + question.replacingOccurrences(of: "\\s*\\n\\s*", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines))
        for line in answer.components(separatedBy: "\n") { lines.append(trimEnd("bart> \(line)")) }
        if !foot.isEmpty { lines.append("bart>"); lines.append("bart> *\(foot)*") }
        return lines
    }

    static func trimEnd(_ s: String) -> String {
        var s = s
        while let c = s.last, c.isWhitespace { s.removeLast() }
        return s
    }

    /// Whether an answer's question is what its note asks now; its grey header shows only when not.
    public static func askedByNote(_ question: String?, _ note: String?) -> Bool {
        let q = Marks.squash(question ?? "")
        if q.isEmpty { return true }
        let asks = noteQuestion(note)
        return q == Marks.squash(asks ?? note ?? "")
    }

    /// The header of an answer still being written.
    public static func runningLabel(_ ask: PendingAsk?) -> String {
        guard let ask else { return "Bart · Thinking" }
        if let a = ask.activity, !a.isEmpty { return "Bart · \(a)" }
        if ask.movedUp, let name = ask.name, !name.isEmpty { return "Bart · Moving up to \([name, ask.effort ?? ""].filter { !$0.isEmpty }.joined(separator: " "))" }
        return "Bart · Thinking"
    }

    /// The answers being written as the workspace keeps them, with those main says are still running brought back.
    public static func runningBack(_ current: [String: PendingAsk], _ list: [PendingAsk], ended: Set<String> = []) -> [String: PendingAsk] {
        var out = current
        for a in list where !a.askId.isEmpty && !a.markId.isEmpty && current[a.askId] == nil && !ended.contains(a.askId) { out[a.askId] = a }
        return out
    }

    /* ------------------------------------------- shared/mark-answers.cjs and selection-card.cjs: EngelbartDoc's, typed here */

    /// An answer's lines as main sends them → (answer, foot) (EngelbartDoc.MarkAnswers.answerOf).
    public static func answerOf(_ lines: [String]) -> (answer: String, foot: String) { MarkAnswers.answerOf(lines) }

    /// A finished answer as a mark keeps it (MarkAnswers.askEntry): meta's values as `x || null` reads them.
    public static func askEntry(id: String, question: String, lines: [String], meta: JSONValue?, at: String, crop: String? = nil) -> AskEntry {
        let level = meta?.object?["level"]?.object ?? [:]
        func text(_ v: JSONValue?) -> String? { if case .string(let s)? = v, !s.isEmpty { return s }; return nil }
        func number(_ v: JSONValue?) -> Double? { if case .number(let n)? = v, n != 0, !n.isNaN { return n }; return nil }
        let entry = MarkAnswers.askEntry(id: id, question: question, lines: lines, provider: text(meta?.object?["provider"]), name: text(level["name"]),
                                         effort: text(level["effort"]), ms: number(meta?.object?["ms"]), at: at, crop: crop)
        return AnnotationJSON.ask(entry) ?? AskEntry(id: id)
    }

    /// The marks with `entry` added to mark `markId` on `page`, once; unchanged when the mark is gone or has it
    /// (MarkAnswers.withAsk over the ink as JSON).
    public static func withAsk(_ marks: PaperMarks, page: Int, markId: String, entry: AskEntry) -> PaperMarks {
        guard marks.pages[page]?.contains(where: { $0.id == markId }) == true else { return marks }
        let entryJSON = (try? JSONValue.parse(AnnotationJSON.askJSON(entry).text)) ?? .null
        let next = MarkAnswers.withAsk(AnnotationJSON.value(marks), page: String(page), markId: markId, entry: entryJSON)
        let out = AnnotationJSON.decode(next)
        return out[page].count == marks[page].count && out[page].map { $0.asks?.count ?? 0 } == marks[page].map { $0.asks?.count ?? 0 } ? marks : out
    }

    public static let CARD_GAP = SelectionCard.CARD_GAP

    /// The selection card's place (EngelbartDoc.SelectionCard.place).
    public static func selectionCardPlace(line: CGRect?, all: CGRect?, pane: CGRect?, size: CGSize?, gap: Double = CARD_GAP) -> CGRect? {
        SelectionCard.place(line: line, all: all, pane: pane, size: size, gap: gap)
    }
}

/// An answer being written for a highlight's note, as the workspace keeps it (Stage `pendingAsks`, main's progress).
public struct PendingAsk: Equatable, Sendable {
    public var askId: String
    public var markId: String
    public var page: Int
    public var question: String
    public var activity: String?
    public var movedUp: Bool
    public var name: String?
    public var effort: String?
    /// The answer so far, while Bart is "Writing".
    public var lines: [String]
    /// What Bart did, a step a line.
    public var log: [String]
    /// Set when the run failed: why.
    public var error: String?
    public init(askId: String, markId: String, page: Int, question: String = "", activity: String? = nil, movedUp: Bool = false,
                name: String? = nil, effort: String? = nil, lines: [String] = [], log: [String] = [], error: String? = nil) {
        self.askId = askId; self.markId = markId; self.page = page; self.question = question; self.activity = activity
        self.movedUp = movedUp; self.name = name; self.effort = effort; self.lines = lines; self.log = log; self.error = error
    }
}
