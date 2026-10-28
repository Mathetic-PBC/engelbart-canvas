import Foundation
import EngelbartDoc

// How one drawn line's characters stand for its source (DocEditor.jsx segs/displayToRaw/rawToDisplay). A line is drawn
// as pieces: a piece open shows its source as typed; a piece closed shows what its token draws (a mention's name, a
// link's title, a formula). The caret moves through the drawing; edits land in the source.

public struct Seg: Equatable {
    /// Characters in the text view (UTF-16).
    public var dLen: Int
    /// The source token.
    public var src: String
    /// Shown as typed.
    public var open: Bool
    /// One piece the caret stands before or after (math, an attachment, a citation, the hammer, a picture).
    public var unit: Bool
    /// Source characters before the shown text (`**` 2, `[` 1, `@[` 1 …).
    public var pre: Int
    public var rLen: Int { src.len }
    public init(dLen: Int, src: String, open: Bool, unit: Bool = false, pre: Int = 0) { self.dLen = dLen; self.src = src; self.open = open; self.unit = unit; self.pre = pre }
    public static func text(_ s: String) -> Seg { Seg(dLen: s.len, src: s, open: true) }
}

/// One source line as drawn: where its text is in the text view, how its pieces map, and where its source text starts.
public struct LineMap: Equatable {
    public var line: Int
    /// The line's characters in the text view (its newline excluded).
    public var range: NSRange
    public var segs: [Seg]
    /// lineText() offset where the pieces start (a rendered heading's `# `, a quote's `> `, an answer's own mark).
    public var base: Int
    /// The line takes no caret of its own (a widget row: pending, a title row, a Build, a foot).
    public var widget: Bool
    /// Where a caret in a drawn fence goes: the end of the fence.
    public var fenceEnd: Int?
    public init(line: Int, range: NSRange, segs: [Seg], base: Int = 0, widget: Bool = false, fenceEnd: Int? = nil) {
        self.line = line; self.range = range; self.segs = segs; self.base = base; self.widget = widget; self.fenceEnd = fenceEnd
    }

    /// A display offset in the line → its lineText() offset.
    public func toRaw(_ disp: Int) -> Int {
        if let f = fenceEnd { return f }
        var accD = 0, accR = 0
        for s in segs {
            if disp <= accD + s.dLen {
                let d = disp - accD
                if s.open { return base + accR + d }
                if s.unit { return base + accR + (d == 0 ? 0 : s.rLen) }
                // The end of a drawn mention is the end of its source (MATH-56).
                if d == 0 { return base + accR }
                if d == s.dLen && s.src.hasPrefix("@[") { return base + accR + s.rLen }
                return base + accR + min(s.rLen, s.pre + d)
            }
            accD += s.dLen; accR += s.rLen
        }
        return base + accR
    }

    /// A lineText() offset → its display offset in the line.
    public func toDisplay(_ rawIn: Int) -> Int {
        if fenceEnd != nil { return range.length }
        let raw = rawIn - base
        if raw <= 0 { return 0 }
        var accD = 0, accR = 0
        for s in segs {
            if raw <= accR + s.rLen {
                let d = raw - accR
                if s.open { return accD + d }
                if s.unit { return accD + (d <= 0 ? 0 : s.dLen) }
                return accD + max(0, min(s.dLen, d - s.pre))
            }
            accD += s.dLen; accR += s.rLen
        }
        return accD
    }
}
