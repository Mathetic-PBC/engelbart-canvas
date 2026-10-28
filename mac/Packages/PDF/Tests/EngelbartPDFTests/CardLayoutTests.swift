import XCTest
@testable import EngelbartPDF

// Port of the placement half of test/paper-canvas-zoom.test.cjs: one page 612 × 792 pt in a pane 612 px wide, its text
// column from 10% to 90%; a card is 44 note px tall and 120 more an answer (the fake DOM's cardHeight), as wide as it is
// given.

final class CardLayoutTests: XCTestCase {
    let W = 612.0
    let C = Canvas.self

    struct M { var id: String; var y: Double; var pos: PPoint?; var side: String; var w: Double?; var answers: Int; var free: Bool }
    let base = [
        M(id: "m1", y: 0.2, pos: nil, side: "right", w: nil, answers: 1, free: false),
        M(id: "m2", y: 0.5, pos: PPoint(x: 0.7, y: 0.45), side: "left", w: nil, answers: 2, free: false),
        M(id: "m3", y: 0.9, pos: PPoint(x: 0.2, y: 0.9), side: "right", w: 150, answers: 0, free: true),
    ]

    func lay(_ ms: [M], zoom z: Double, x0: Double? = nil, col: (l: Double, r: Double)? = (0.1, 0.9)) -> (places: [String: CardLayout.Place], G: Double, pageW: Double, vL: Double, vR: Double, ns: Double) {
        let g = PaperDraw.columnGeometry(W, z)
        let x = x0 ?? max(0, (g.S - W) / 2)
        let specs = ms.map { m in
            CardLayout.Spec(id: m.id, markY: m.y, pos: m.pos, how: m.pos == nil ? m.side : "pos", fixed: m.pos != nil, want: m.w ?? C.NOTE_W, typing: m.answers > 0)
        }
        let answers = Dictionary(uniqueKeysWithValues: ms.map { ($0.id, $0.answers) })
        let out = CardLayout.arrange([CardLayout.Page(page: 1, G: g.G, pageW: g.pageW, pageH: 792 * g.pageW / 612, column: col, specs: specs)],
                                     view: .init(x0: x, W: W), measure: { id, w in (w, 44 + Double(answers[id]!) * 120) })
        return (out, g.G, g.pageW, x + 8, x + W - 8, C.noteScale(g.pageW))
    }

    func inPane(_ at: (places: [String: CardLayout.Place], G: Double, pageW: Double, vL: Double, vR: Double, ns: Double), _ what: String) {
        for (id, b) in at.places { XCTAssertTrue(b.left >= at.vL - 1e-6 && b.left + b.width <= at.vR + 1e-6, "\(what) \(id): \(b.left)…\(b.left + b.width) in \(at.vL)…\(at.vR)") }
    }

    func testCardsAtEveryZoom() {
        let at = lay(base, zoom: 1)
        XCTAssertEqual(at.ns, 612 / 1050, accuracy: 1e-9)
        let m1 = at.places["m1"]!, m2 = at.places["m2"]!, m3 = at.places["m3"]!
        XCTAssertEqual(m1.width, C.NOTE_MIN * at.ns, accuracy: 1e-9, "NOTE_MIN: margins of 61 px")
        XCTAssertEqual(m1.left + m1.width, at.vR, accuracy: 1e-9, "against the pane's right side")
        XCTAssertEqual(m1.height, 164 * at.ns, accuracy: 1e-9)
        XCTAssertEqual(m2.height, 284 * at.ns, accuracy: 1e-9)
        XCTAssertEqual(m3.width, 150 * at.ns, accuracy: 1e-9, "a typed note keeps its width")
        XCTAssertEqual(m3.left, 0.2 * 612, accuracy: 1e-9, "where it was typed")
        inPane(at, "100%")
        for f in [0.5, 2, 1] {
            let a = lay(base, zoom: f)
            XCTAssertEqual(a.pageW, 612 * f)
            inPane(a, "\(f * 100)%")
            XCTAssertEqual(a.places["m3"]!.top, 0.9 * a.pageW - C.POS_DY, accuracy: 1e-9)
            XCTAssertEqual(a.places["m2"]!.top, 0.45 * a.pageW - C.POS_DY, accuracy: 1e-9)
            XCTAssertGreaterThanOrEqual(a.places["m1"]!.top, 0.2 * a.pageW - 6 - 1e-9)
            XCTAssertEqual(a.places["m1"]!.height, 164 * a.ns, accuracy: 1e-9)
            if f == 0.5 {
                XCTAssertEqual(a.ns, 10 / 24)
                XCTAssertEqual(a.places["m3"]!.left, a.G + 0.2 * a.pageW, accuracy: 1e-9)
                XCTAssertEqual(a.places["m3"]!.width, 150 * a.ns, accuracy: 1e-9)
                XCTAssertGreaterThan(a.places["m1"]!.width, C.NOTE_MIN * a.ns)
                XCTAssertEqual(a.places["m1"]!.left, a.G + 0.9 * a.pageW + 12, accuracy: 1)
            }
            if f == 2 {
                XCTAssertEqual(a.places["m3"]!.left, a.vL, accuracy: 1e-9, "its place is left of the view: moved in")
                XCTAssertEqual(a.places["m1"]!.left + a.places["m1"]!.width, a.vR, accuracy: 1e-9)
            }
        }
    }

    func testSidewaysScrollKeepsCardsInPane() {
        for x in [0.0, 306, 612] { inPane(lay(base, zoom: 2, x0: x), "scrolled to \(x)") }
    }

    func testAgainstTheTextAndOverItWithLessThanNoteMin() {
        let ms = [M(id: "r", y: 0.2, pos: nil, side: "right", w: nil, answers: 0, free: false), M(id: "l", y: 0.4, pos: nil, side: "left", w: nil, answers: 0, free: false)]
        var at = lay(ms, zoom: 1)
        XCTAssertEqual(at.places["r"]!.width, C.NOTE_MIN * at.ns, accuracy: 1e-9)
        XCTAssertEqual(at.places["r"]!.left + at.places["r"]!.width, at.vR, accuracy: 1e-9)
        XCTAssertEqual(at.places["l"]!.width, C.NOTE_MIN * at.ns, accuracy: 1e-9)
        XCTAssertEqual(at.places["l"]!.left, at.vL, accuracy: 1e-9)
        at = lay(ms, zoom: 1, col: (0.25, 0.75))
        XCTAssertEqual(at.places["r"]!.left, 0.75 * 612 + 12, accuracy: 1e-9)
        XCTAssertEqual(at.places["r"]!.left + at.places["r"]!.width, at.vR, accuracy: 1)
        XCTAssertEqual(at.places["l"]!.left + at.places["l"]!.width, 0.25 * 612 - 12, accuracy: 1)
        XCTAssertEqual(at.places["l"]!.left, at.vL, accuracy: 1)
        at = lay(ms, zoom: 0.3, col: (0.25, 0.75))
        XCTAssertEqual(at.ns, C.NOTE_FLOOR)
        XCTAssertEqual(at.places["r"]!.width, C.NOTE_W * at.ns, accuracy: 1e-9)
        XCTAssertEqual(at.places["r"]!.left, at.G + 0.75 * at.pageW + 12, accuracy: 1e-9)
        inPane(at, "30%")
    }

    func testOtherMarginWhenOwnTooNarrow() {
        let at = lay([M(id: "l", y: 0.3, pos: nil, side: "left", w: nil, answers: 0, free: false)], zoom: 1, col: (0.1, 0.6))
        XCTAssertEqual(at.places["l"]!.left, 0.6 * 612 + 12, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(at.places["l"]!.width, C.NOTE_MIN * at.ns - 1e-9)
        XCTAssertLessThanOrEqual(at.places["l"]!.left + at.places["l"]!.width, at.vR + 1e-9)
    }

    func testLeftMarginNoteKeepsToIt() {
        let at = lay([M(id: "f", y: 0.3, pos: PPoint(x: 150 / 612, y: 0.3), side: "right", w: 300, answers: 0, free: true)], zoom: 1, col: (0.3, 0.9))
        let f = at.places["f"]!, L = 0.3 * 612
        XCTAssertLessThanOrEqual(f.left + f.width, L - 12 + 1e-6)
        XCTAssertGreaterThanOrEqual(f.left, at.vL - 1e-9)
        XCTAssertLessThan(f.left, 150)
    }

    func testNoteAgainstRightEdgeGoesIntoRightMargin() {
        let at = lay([M(id: "f", y: 0.3, pos: PPoint(x: 0.66, y: 0.3), side: "right", w: 240, answers: 0, free: true)], zoom: 1, col: (0.1, 0.7))
        let f = at.places["f"]!
        XCTAssertEqual(f.left, 0.7 * 612 + 12, accuracy: 1e-9)
        XCTAssertTrue(f.width >= C.FREE_MIN * at.ns - 1e-9 && f.left + f.width <= at.vR + 1e-9)
    }

    func testHiddenWhenMarginOutOfView() {
        var at = lay(base, zoom: 1)
        XCTAssertEqual(["m1", "m2", "m3"].map { at.places[$0]!.hidden }, [false, false, false])
        at = lay(base, zoom: 2)
        XCTAssertTrue(at.places["m1"]!.hidden, "its highlight's margin is off the pane")
        XCTAssertTrue(at.places["m3"]!.hidden, "typed at 20% across: off the pane")
        at = lay(base, zoom: 2, x0: 612)
        XCTAssertFalse(at.places["m1"]!.hidden, "its margin back in view")
        at = lay(base, zoom: 2, x0: 0)
        XCTAssertFalse(at.places["m3"]!.hidden, "its place back in view")
    }

    func testDraggedCardStaysWhereThePointerHasIt() {
        let g = PaperDraw.columnGeometry(W, 1)
        let specs = [CardLayout.Spec(id: "f", markY: 0.5, pos: PPoint(x: 0.3, y: 0.5), how: "pos", fixed: true, want: 150, typing: false)]
        let out = CardLayout.arrange([CardLayout.Page(page: 1, G: g.G, pageW: g.pageW, pageH: 792, column: (0.1, 0.9), specs: specs)], view: .init(x0: 0, W: W),
                                     dragged: .init(id: "f", left: 20, top: 33, w: 150), keepShown: ["f"], measure: { _, w in (w, 44) })
        XCTAssertEqual(out["f"]!.left, 20); XCTAssertEqual(out["f"]!.top, 33); XCTAssertFalse(out["f"]!.hidden)
    }

    func testStackedNotesNeverOverlap() {
        let ms = (0..<6).map { M(id: "n\($0)", y: 0.3 + Double($0) * 0.01, pos: nil, side: "right", w: nil, answers: 0, free: false) }
        let at = lay(ms, zoom: 0.5, col: (0.1, 0.9))
        let placed = at.places.values.sorted { $0.top < $1.top }
        for i in placed.indices.dropFirst() where placed[i].left < placed[i - 1].left + placed[i - 1].width && placed[i - 1].left < placed[i].left + placed[i].width {
            XCTAssertGreaterThanOrEqual(placed[i].top, placed[i - 1].top + placed[i - 1].height + 12 - 1e-9)
        }
    }
}
