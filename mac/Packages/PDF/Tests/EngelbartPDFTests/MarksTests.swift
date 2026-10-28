import XCTest
@testable import EngelbartPDF

// Port of test/paper-marks.test.cjs (src/renderer/pdf/marks.js).

private func r(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> PRect { PRect(x, y, w, h) }
private func round(_ boxes: [PRect], _ d: Double = 2) -> [PRect] {
    let k = pow(10, d)
    return boxes.map { PRect(($0.x * k).rounded() / k, ($0.y * k).rounded() / k, ($0.w * k).rounded() / k, ($0.h * k).rounded() / k) }
}
private func L(_ n: Double) -> Double { 0.5 + n * 0.018 }
private func mark(_ id: String, _ rects: [PRect], note: String? = nil, text: String? = nil, group: String? = nil, side: String = "left") -> Mark {
    var m = Mark(id: id, rects: rects, side: side, y: rects.map(\.y).min()!, note: note, text: text ?? id, pos: nil)
    m.group = group
    return m
}

final class MarksTests: XCTestCase {
    func testMergeLineRectsNothing() {
        XCTAssertEqual(Marks.mergeLineRects([]), [])
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 0, 10), r(0, 0, 10, 0), r(.nan, 0, 5, 5)]), [])
    }

    func testMergeLineRectsDuplicates() {
        XCTAssertEqual(Marks.mergeLineRects([r(10, 20, 100, 14), r(10, 20, 100, 14)]), [r(10, 20, 100, 14)])
        XCTAssertEqual(Marks.mergeLineRects([r(10, 20, 100, 14), r(10.5, 19.5, 100, 14.5)]), [r(10, 19.5, 100.5, 14.5)])
        XCTAssertEqual(round(Marks.mergeLineRects([r(86.58, 549.09, 388.35, 14.44), r(86.58, 547.59, 388.35, 16.5)])), [r(86.58, 547.59, 388.35, 16.5)])
    }

    func testMergeLineRectsJoins() {
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 50, 14), r(50, 0, 50, 14)]), [r(0, 0, 100, 14)])
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 60, 14), r(40, 1, 60, 13)]), [r(0, 0, 100, 14)])
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 50, 14), r(54, 0, 46, 14)]), [r(0, 0, 100, 14)])
        XCTAssertEqual(Marks.mergeLineRects([r(87, 496, 389, 14.6), r(511, 496, 389, 14.6)]), [r(87, 496, 389, 14.6), r(511, 496, 389, 14.6)])
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 50, 10), r(56.1, 0, 50, 10)]).count, 2)
    }

    func testBandRects() {
        let words = [r(135, 80, 120, 22), r(275, 80, 165, 22), r(457, 80, 270, 22)]
        XCTAssertEqual(Marks.mergeLineRects(words).count, 3)
        XCTAssertEqual(Marks.bandRects(words), [r(135, 80, 592, 22)])
        XCTAssertEqual(Marks.bandRects(words + [r(135, 104, 80, 22), r(230, 104, 60, 22)]), [r(135, 80, 592, 22), r(135, 104, 155, 22)])
        let across = [r(50, 300, 250, 12), r(340, 300, 250, 12)]
        XCTAssertEqual(Marks.bandRects(across), across)
        XCTAssertEqual(Marks.bandRects([]), [])
    }

    func testMergeLineRectsLines() {
        let lines = [r(87, 531, 388, 16.5), r(87, 547.6, 388, 16.5), r(87, 565.3, 118, 16.5)]
        XCTAssertEqual(Marks.mergeLineRects(lines), lines)
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 100, 16), r(0, 12, 100, 16)]), [r(0, 0, 100, 16), r(0, 12, 100, 16)])
        XCTAssertEqual(Marks.mergeLineRects([r(0, 0, 100, 16), r(0, 7, 100, 16)]), [r(0, 0, 100, 23)])
        let shuffled = [r(511, 40, 50, 10), r(0, 40, 50, 10), r(300, 0, 50, 10), r(0, 20, 50, 10), r(0, 0, 50, 10)]
        XCTAssertEqual(Marks.mergeLineRects(shuffled), [r(0, 0, 50, 10), r(300, 0, 50, 10), r(0, 20, 50, 10), r(0, 40, 50, 10), r(511, 40, 50, 10)])
        XCTAssertEqual(Marks.mergeLineRects([r(0, 10, 100, 14), r(100, 8, 6, 8)]), [r(0, 8, 106, 16)])
    }

    func testMergeLineRectsAnyUnit() {
        let px = [r(86.58, 549.09, 388.35, 14.44), r(86.58, 547.59, 388.35, 16.5), r(122.76, 530.01, 353.08, 16.5), r(511, 530, 300, 16.5)]
        let W = 985.0
        let inPage = Marks.mergeLineRects(px.map { $0.scaled(1 / W) })
        XCTAssertEqual(round(inPage.map { $0.scaled(W) }), round(Marks.mergeLineRects(px)))
        XCTAssertEqual(inPage.count, 3)
    }

    func testSameLineAndOverlap() {
        XCTAssertTrue(Marks.sameLine(r(0, 0, 10, 10), r(0, 5, 10, 10)))
        XCTAssertFalse(Marks.sameLine(r(0, 0, 10, 10), r(0, 5.1, 10, 10)))
        XCTAssertTrue(Marks.boxesOverlap(r(0, 0, 50, 10), r(49, 1, 50, 10)))
        XCTAssertFalse(Marks.boxesOverlap(r(0, 0, 50, 10), r(50, 0, 50, 10)))
        XCTAssertFalse(Marks.boxesOverlap(r(0, 0, 50, 10), r(10, 8, 20, 10)))
    }

    func testSideOfAndBoxSeed() {
        XCTAssertEqual(Marks.sideOf([r(0.1, 0, 0.3, 0.01)]), "left")
        XCTAssertEqual(Marks.sideOf([r(0.5, 0, 0.4, 0.01)]), "right")
        XCTAssertEqual(Marks.sideOf([r(87, 0, 388, 14), r(87, 20, 100, 14)], width: 985), "left")
        XCTAssertEqual(Marks.sideOf([]), "right")
        let b = r(0.1234, 0.5678, 0.3, 0.015)
        XCTAssertEqual(Marks.boxSeed(page: 2, b), Marks.boxSeed(page: 2, b))
        XCTAssertGreaterThanOrEqual(Marks.boxSeed(page: 2, b), 1)
        XCTAssertNotEqual(Marks.boxSeed(page: 2, b), Marks.boxSeed(page: 3, b))
        XCTAssertNotEqual(Marks.boxSeed(page: 2, b), Marks.boxSeed(page: 2, r(0.1234, 0.59, 0.3, 0.015)))
        XCTAssertGreaterThanOrEqual(Marks.boxSeed(page: 0, r(0, 0, 1, 1)), 1)
        // The value marks.js gives (node: boxSeed(2, {x:.1234,y:.5678}) = 1 + (2·7919 + 568·131 + 123))
        XCTAssertEqual(Marks.boxSeed(page: 2, b), 1 + 2 * 7919 + 568 * 131 + 123)
    }

    func testPlaceSameTextTwice() {
        let a = mark("a", [r(0.12, L(0), 0.36, 0.015), r(0.09, L(1), 0.2, 0.015)])
        let again = mark("b", [r(0.1205, L(0) - 0.0005, 0.3593, 0.0155), r(0.0898, L(1), 0.2004, 0.015)])
        let out = Marks.placeHighlight([a], again)
        XCTAssertEqual(out.list, [a])
        XCTAssertEqual(out.mark, a)
    }

    func testPlaceNoteInside() {
        let plain = mark("a", [r(0.1, L(0), 0.4, 0.015)])
        let inside = mark("b", [r(0.2, L(0), 0.1, 0.015)], note: "w")
        let out = Marks.placeHighlight([plain], inside)
        XCTAssertEqual(out.list.count, 1)
        XCTAssertEqual(out.mark.id, "a")
        XCTAssertEqual(out.mark.note, "w")
        XCTAssertEqual(out.mark.rects, plain.rects)
        let noted = mark("a", [r(0.1, L(0), 0.4, 0.015)], note: "mine")
        let opened = Marks.placeHighlight([noted], inside)
        XCTAssertEqual(opened.list.count, 1)
        XCTAssertEqual(opened.mark, noted)
        var enteredSel = inside; enteredSel.note = nil
        XCTAssertEqual(Marks.placeHighlight([noted], enteredSel).mark, noted)
    }

    func testPlaceOverlapMerges() {
        let free = Mark(id: "f", rects: [], side: nil, y: 0.2, note: "free", text: "", pos: PPoint(x: 0.9, y: 0.2))
        let other = mark("o", [r(0.6, L(9), 0.3, 0.015)])
        let a = mark("a", [r(0.1, L(0), 0.2, 0.015)], text: "the quick brown")
        let b = mark("b", [r(0.25, L(0), 0.2, 0.015), r(0.09, L(1), 0.1, 0.015)], text: "brown fox jumps over\nthe")
        let out = Marks.placeHighlight([free, a, other], b)
        XCTAssertEqual(out.list.map(\.id), ["f", "a", "o"])
        XCTAssertEqual(out.list[0], free)
        let m = out.mark
        XCTAssertEqual(m.id, "a")
        XCTAssertEqual(m.rects, Marks.mergeLineRects(a.rects + b.rects))
        XCTAssertEqual(round(m.rects, 4), [r(0.1, L(0), 0.35, 0.015), r(0.09, L(1), 0.1, 0.015)])
        XCTAssertEqual(m.y, L(0))
        XCTAssertEqual(m.side, "left")
        XCTAssertNil(m.note)
        XCTAssertNil(m.pos)
        XCTAssertEqual(m.text, "the quick brown fox jumps over the")
    }

    func testPlaceCoverKeepsText() {
        let a = mark("a", [r(0.5, L(0), 0.1, 0.015)], text: "fox")
        let b = mark("b", [r(0.62, L(0), 0.1, 0.015)], text: "jumps")
        let cover = mark("c", [r(0.45, L(0), 0.4, 0.015)], text: "brown fox jumps over")
        let out = Marks.placeHighlight([a, b], cover)
        XCTAssertEqual(out.list.count, 1)
        XCTAssertEqual(out.mark.id, "a")
        XCTAssertEqual(out.mark.text, "brown fox jumps over")
        XCTAssertEqual(out.mark.side, "right")
        let later = mark("l", [r(0.1, L(2), 0.3, 0.015)], text: "later words")
        let earlier = mark("e", [r(0.3, L(1), 0.4, 0.015), r(0.1, L(2), 0.1, 0.015)], text: "earlier")
        let joined = Marks.placeHighlight([later], earlier)
        XCTAssertEqual(joined.mark.id, "l")
        XCTAssertEqual(joined.mark.text, "earlier later words")
        XCTAssertEqual(joined.mark.y, L(1))
    }

    func testPlaceNoteKeepsApart() {
        let noted = mark("a", [r(0.1, L(0), 0.3, 0.015)], note: "keep me")
        let b = mark("b", [r(0.3, L(0), 0.2, 0.015)])
        let out = Marks.placeHighlight([noted], b)
        XCTAssertEqual(out.list.map(\.id), ["a", "b"])
        XCTAssertEqual(out.list[0].note, "keep me")
        XCTAssertEqual(out.mark, b)
        let plain = mark("p", [r(0.1, L(0), 0.3, 0.015)])
        let started = mark("s", [r(0.3, L(0), 0.2, 0.015)], note: "n")
        let apart = Marks.placeHighlight([plain], started)
        XCTAssertEqual(apart.list.map(\.id), ["p", "s"])
        XCTAssertEqual(apart.mark.note, "n")
    }

    func testPlaceNoOverlap() {
        let a = mark("a", [r(0.1, L(0), 0.3, 0.015)])
        XCTAssertEqual(Marks.placeHighlight([a], mark("b", [r(0.1, L(1), 0.3, 0.015)])).list.map(\.id), ["a", "b"])
        XCTAssertEqual(Marks.placeHighlight([a], mark("c", [r(0.405, L(0), 0.2, 0.015)])).list.map(\.id), ["a", "c"])
        XCTAssertEqual(Marks.placeHighlight([], mark("d", [r(0.1, L(0), 0.3, 0.015)])).list.map(\.id), ["d"])
    }

    func testDropSlivers() {
        XCTAssertEqual(Marks.dropSlivers([]), [])
        XCTAssertEqual(Marks.dropSlivers([r(30, 100, 8, 400)]), [r(30, 100, 8, 400)])
        XCTAssertEqual(Marks.dropSlivers([r(87, 120, 380, 14), r(30, 60, 12, 420), r(87, 136, 300, 14)]), [r(87, 120, 380, 14), r(87, 136, 300, 14)])
        let keep = [r(87, 120, 4, 14), r(87, 140, 200, 14), r(87, 160, 300, 30)]
        XCTAssertEqual(Marks.dropSlivers(keep), keep)
    }

    func testSelectionParts() {
        let one = Marks.selectionParts([Marks.Piece(page: 1, rects: [r(87, 120, 380, 14), r(30, 60, 12, 420), r(87, 136, 300, 14)], width: 600, text: "two lines", u: 600)])
        XCTAssertEqual(one[0].rects, [r(87, 120, 380, 14), r(87, 136, 300, 14)])
        let parts = Marks.selectionParts([
            Marks.Piece(page: 4, rects: [r(95, 106, 330, 16.5), r(95, 107.5, 330, 14.4), r(95, 126, 120, 16.5)], width: 985, text: "This hypothesis-driven\nbugs", u: 985),
            Marks.Piece(page: 3, rects: [r(700, 1240, 125, 18)], width: 985, text: "us hypotheses [84].", u: 985),
            Marks.Piece(page: 5, rects: [r(0, 0, 0, 10), r(5, 5, 0.5, 0)], width: 985, text: "", u: 985),
        ])
        XCTAssertEqual(parts.map(\.page), [3, 4])
        XCTAssertEqual(parts[0], Marks.Part(page: 3, rects: [r(700, 1240, 125, 18)], side: "right", y: 1240, text: "us hypotheses [84].", u: 985))
        XCTAssertEqual(parts[1].rects, [r(95, 106, 330, 16.5), r(95, 126, 120, 16.5)])
        XCTAssertEqual(parts[1].side, "left")
        XCTAssertEqual(parts[1].y, 106)
        XCTAssertEqual(Marks.selectionParts([]), [])
    }

    func testScalePart() {
        let part = Marks.Part(page: 3, rects: [r(100, 200, 50, 10)], side: "left", y: 200, text: "t", u: 1000)
        XCTAssertEqual(Marks.scalePart(part, from: 1000, to: 1500), Marks.Part(page: 3, rects: [r(150, 300, 75, 15)], side: "left", y: 300, text: "t", u: 1500))
        var same = part; same.u = 800
        XCTAssertEqual(Marks.scalePart(part, from: nil, to: 800), same)
    }

    private func counter() -> (String) -> String { var n = 0; return { n += 1; return "\($0)\(n)" } }

    func testPartMarksOne() {
        let out = Marks.partMarks([Marks.Part(page: 2, rects: [r(100, 200, 300, 15)], side: "left", y: 200, text: "one page", u: 1000)], note: "n", newId: counter(), widthOf: { _ in 1000 })
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].page, 2)
        XCTAssertEqual(out[0].mark, Mark(id: "m1", rects: [r(0.1, 0.2, 0.3, 0.015)], side: "left", y: 0.2, note: "n", text: "one page", pos: nil))
        XCTAssertNil(out[0].mark.group)
    }

    func testPartMarksAcrossPages() {
        let parts = [
            Marks.Part(page: 3, rects: [r(700, 1240, 125, 18)], side: "right", y: 1240, text: "us hypotheses [84].", u: 1000),
            Marks.Part(page: 4, rects: [r(95, 106, 330, 16)], side: "left", y: 106, text: "This hypothesis", u: 1000),
            Marks.Part(page: 5, rects: [], side: "left", y: 0, text: "", u: 1000),
        ]
        let widths = [3: 1000.0, 4: 500.0]
        let out = Marks.partMarks(parts, note: "k", newId: counter(), widthOf: { widths[$0] ?? 0 })
        XCTAssertEqual(out.map(\.page), [3, 4])
        let a = out[0].mark, b = out[1].mark
        XCTAssertEqual(a.group, "g1"); XCTAssertEqual(b.group, "g1")
        XCTAssertEqual([a.id, b.id], ["m2", "m3"])
        XCTAssertEqual([a.note, b.note], ["k", nil])
        XCTAssertEqual(round(a.rects, 4), [r(0.7, 1.24, 0.125, 0.018)])
        XCTAssertEqual(round(b.rects, 4), [r(0.19, 0.212, 0.66, 0.032)])
        XCTAssertEqual(b.y, 106 / 500)
        XCTAssertEqual(Marks.partMarks(parts, note: nil, newId: counter(), widthOf: { _ in 1000 }).map(\.mark.note), [nil, nil])
        XCTAssertTrue(Marks.partMarks([], note: "k", newId: counter(), widthOf: { _ in 1000 }).isEmpty)
    }

    func testPlaceGroupKept() {
        let a = mark("a", [r(0.1, L(0), 0.2, 0.015)], text: "the quick brown")
        let part = mark("p", [r(0.25, L(0), 0.2, 0.015)], text: "brown fox", group: "g1")
        let out = Marks.placeHighlight([a], part)
        XCTAssertEqual(out.list.count, 1)
        XCTAssertEqual(out.mark.id, "a")
        XCTAssertEqual(out.mark.group, "g1")
        XCTAssertEqual(out.mark.text, "the quick brown fox")
        let plain = mark("e", [r(0.1, L(1), 0.1, 0.015)])
        let grouped = mark("q", [r(0.3, L(1), 0.1, 0.015)], group: "g2")
        let over = mark("o", [r(0.15, L(1), 0.2, 0.015)])
        let merged = Marks.placeHighlight([plain, grouped], over)
        XCTAssertEqual(merged.list.map(\.id), ["e"])
        XCTAssertEqual(merged.mark.group, "g2")
        let none = Marks.placeHighlight([mark("x", [r(0.1, L(2), 0.2, 0.015)])], mark("y", [r(0.2, L(2), 0.2, 0.015)]))
        XCTAssertEqual(none.list.count, 1)
        XCTAssertNil(none.mark.group)
    }

    func testPlacePartInsideGivesGroup() {
        let host = mark("h", [r(0.1, L(0), 0.4, 0.015)])
        let part = mark("p", [r(0.2, L(0), 0.1, 0.015)], group: "g1")
        let out = Marks.placeHighlight([host], part)
        XCTAssertEqual(out.list.count, 1)
        XCTAssertEqual(out.mark.id, "h")
        XCTAssertEqual(out.mark.group, "g1")
        XCTAssertNil(out.mark.note)
        var notedPart = part; notedPart.note = "w"
        let noted = Marks.placeHighlight([host], notedPart)
        XCTAssertEqual(noted.mark.id, "h")
        XCTAssertEqual(noted.mark.group, "g1"); XCTAssertEqual(noted.mark.note, "w")
        var same = host; same.group = "g1"
        XCTAssertEqual(Marks.placeHighlight([same], part).mark, same)
        XCTAssertEqual(Marks.placeHighlight([same], mark("s", [r(0.2, L(0), 0.1, 0.015)])).mark, same)
    }

    func testPlaceTwoGroupsApart() {
        let host = mark("h", [r(0.1, L(0), 0.4, 0.015)], group: "g1")
        let inside = mark("p", [r(0.2, L(0), 0.1, 0.015)], group: "g2")
        let kept = Marks.placeHighlight([host], inside)
        XCTAssertEqual(kept.list.map { [$0.id, $0.group ?? ""] }, [["h", "g1"], ["p", "g2"]])
        XCTAssertEqual(kept.mark, inside)
        let left = mark("l", [r(0.1, L(1), 0.2, 0.015)], group: "g1")
        let overlapping = mark("o", [r(0.25, L(1), 0.2, 0.015)], group: "g2")
        XCTAssertEqual(Marks.placeHighlight([left], overlapping).list.map(\.id), ["l", "o"])
        let right = mark("r", [r(0.5, L(1), 0.2, 0.015)], group: "g3")
        let across = mark("x", [r(0.25, L(1), 0.3, 0.015)])
        XCTAssertEqual(Marks.placeHighlight([left, right], across).list.map(\.id), ["l", "r", "x"])
    }

    func testPassageOf() {
        let plain = Mark(id: "p", y: 0.2, text: "Cohen's κ was 0.79")
        var a = Mark(id: "a", y: 0.9, note: "@bart why?", text: "the model was\ntrained on "); a.group = "g1"
        var b = Mark(id: "b", y: 0.05, text: "a dataset of 480 students"); b.group = "g1"
        var c = Mark(id: "c", y: 0.04, text: " and four deployments."); c.group = "g1"
        var other = Mark(id: "o", y: 0.5, text: "elsewhere"); other.group = "g2"
        let marks = PaperMarks(pages: [4: [c, other], 3: [b], 2: [plain, a]])
        XCTAssertEqual(Marks.passageOf(marks, plain), "Cohen's κ was 0.79")
        let whole = "the model was\ntrained on\na dataset of 480 students\nand four deployments."
        XCTAssertEqual(Marks.passageOf(marks, a), whole)
        XCTAssertEqual(Marks.passageOf(marks, c), whole)
        XCTAssertEqual(Marks.passageOf(marks, other), "elsewhere")
        var alone = Mark(id: "x", text: "alone"); alone.group = "g9"
        XCTAssertEqual(Marks.passageOf(PaperMarks(), alone), "alone")
        XCTAssertEqual(Marks.passageOf(marks, nil), "")
    }

    func testStackNotes() {
        typealias I = Marks.NoteItem
        var at = Marks.stackNotes([I(id: "a", ideal: 100, h: 48, side: "right"), I(id: "b", ideal: 110, h: 24, side: "right")], gap: 8)
        XCTAssertEqual(at["a"]!.top, 100); XCTAssertEqual(at["a"]!.side, "right")
        XCTAssertEqual(at["b"]!.top, 156); XCTAssertEqual(at["b"]!.side, "right")
        at = Marks.stackNotes([I(id: "a", ideal: 100, h: Marks.NOTE_SLACK + 40, side: "right"), I(id: "b", ideal: 110, h: 24, side: "right")], gap: 8)
        XCTAssertEqual(at["b"]!.top, 110); XCTAssertEqual(at["b"]!.side, "left")
        at = Marks.stackNotes([I(id: "a", ideal: 100, h: Marks.NOTE_SLACK + 2, side: "right"), I(id: "b", ideal: 110, h: 24, side: "right")], gap: 8)
        XCTAssertEqual(at["b"]!.side, "right")
        at = Marks.stackNotes((0..<10).map { I(id: "n\($0)", ideal: 100, h: 60, side: "right") }, gap: 8)
        var bySide: [String: [Double]] = ["left": [], "right": []]
        for (_, p) in at { bySide[p.side]!.append(p.top) }
        XCTAssertFalse(bySide["left"]!.isEmpty)
        for (_, tops) in bySide { let s = tops.sorted(); for i in s.indices.dropFirst() { XCTAssertGreaterThanOrEqual(s[i] - s[i - 1], 68) } }
        at = Marks.stackNotes([I(id: "a", ideal: 980, h: 40, side: "left")], pageH: 1000)
        XCTAssertEqual(at["a"]!.top, 960)
    }

    func testWordBounds() {
        let t = "the example text here"
        XCTAssertTrue(Marks.wordBounds(t, from: 6, to: 14) == (4, 16))
        XCTAssertTrue(Marks.wordBounds(t, from: 4, to: 11) == (4, 11))
        XCTAssertTrue(Marks.wordBounds(t, from: 3, to: 12) == (3, 12))
        XCTAssertTrue(Marks.wordBounds("κ = 0.79, n=480", from: 1, to: 6) == (1, 8))
        XCTAssertTrue(Marks.wordBounds("N = 13,633 events", from: 6, to: 6) == (4, 10))
        XCTAssertTrue(Marks.wordBounds("behavior-aware AI", from: 10, to: 12) == (0, 14))
        XCTAssertTrue(Marks.wordBounds("construc-\ntion of", from: 11, to: 13) == (10, 14))
        XCTAssertTrue(Marks.wordBounds("it's fine", from: 3, to: 3) == (0, 4))
        XCTAssertTrue(Marks.wordBounds("", from: 0, to: 0) == (0, 0))
    }

    func testPageWindow() {
        XCTAssertEqual(Marks.pageWindow("Results.\n\n\n\nκ   was 0.79.  ", "κ was"), "Results.\n\nκ was 0.79.")
        func filler(_ w: String, _ n: Int) -> String { (0..<n).map { "\(w)\($0)" }.joined(separator: " ") }
        let page = "\(filler("before", 900)) Cohen's κ was 0.79 overall across the four deployments \(filler("after", 900))"
        let out = Marks.pageWindow(page, "Cohen's κ was 0.79\noverall across")
        let n = (out as NSString).length
        XCTAssertTrue(n <= 4004 && n > 3900, "\(n)")
        XCTAssertTrue(out.hasPrefix("… ") && out.hasSuffix(" …"))
        let at = (out as NSString).range(of: "Cohen's κ").location, mid = at + 30
        XCTAssertLessThan(abs(Double(mid) - Double(n) / 2), 60)
        XCTAssertNotNil(out.range(of: "^… before\\d+ ", options: .regularExpression))
        XCTAssertTrue(Marks.findPassage("a b construc-\ntion of the thing", "construc- tion of")! == (4, 21))
        XCTAssertTrue(Marks.findPassage("x Cohen'sκ y", "Cohen's κ")! == (2, 10))
        XCTAssertNil(Marks.findPassage("nothing here", "elsewhere"))
        let late = Marks.pageWindow(page, "not on this page", at: 1)
        XCTAssertTrue(late.hasSuffix("after899") && late.hasPrefix("… "))
        let early = Marks.pageWindow(page, "not on this page", at: 0)
        XCTAssertTrue(early.hasPrefix("before0 ") && early.hasSuffix(" …"))
    }
}
