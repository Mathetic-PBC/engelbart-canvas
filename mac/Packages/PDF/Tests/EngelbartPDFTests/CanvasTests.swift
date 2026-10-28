import XCTest
import EngelbartCore
@testable import EngelbartPDF

// Port of test/paper-canvas.test.cjs (canvas.js, paper-draw.js columnGeometry/settleView), the pure half of
// test/paper-draw.test.cjs (nearOrder) and PaperView's zoom math, plus the ink file's JSON and rough.js.

final class CanvasTests: XCTestCase {
    func testFitWidth() {
        let C = Canvas.self
        XCTAssertEqual(C.fitWidth(C.NOTE_W, 500, C.NOTE_MIN, 600), C.NOTE_W)
        XCTAssertEqual(C.fitWidth(C.NOTE_W, 150, C.NOTE_MIN, 600), 150)
        XCTAssertEqual(C.fitWidth(C.NOTE_W, 40, C.NOTE_MIN, 600), C.NOTE_MIN)
        XCTAssertEqual(C.fitWidth(C.NOTE_W, -300, C.NOTE_MIN, 600), C.NOTE_MIN)
        XCTAssertEqual(C.fitWidth(C.NOTE_W, 500, C.NOTE_MIN, 80), 80)
        XCTAssertEqual(C.fitWidth(70, 500, C.NOTE_MIN, 600), 70)
    }

    func testFreeNoteWidth() {
        XCTAssertEqual(Canvas.FREE_MIN, 80)
        XCTAssertEqual(Canvas.freeNoteWidth(100, 300, .infinity), 300 - 6 - 100)
        XCTAssertEqual(Canvas.freeNoteWidth(100, .infinity, 260), 260 - 8 - 100)
        XCTAssertEqual(Canvas.freeNoteWidth(100, .infinity, .infinity), Canvas.NOTE_W)
        XCTAssertEqual(Canvas.freeNoteWidth(500, 520, .infinity), Canvas.FREE_MIN)
    }

    func testColumnGeometry() {
        XCTAssertTrue(PaperDraw.columnGeometry(800, 1) == (800, 800, 0))
        XCTAssertTrue(PaperDraw.columnGeometry(800, 0.5) == (400, 800, 200))
        XCTAssertTrue(PaperDraw.columnGeometry(800, 2) == (1600, 1600, 0))
        XCTAssertTrue(PaperDraw.columnGeometry(801, 0.15) == (120, 801, 340.5))
    }

    func testSettleView() {
        typealias Lay = PaperDraw.Layout
        let from = Lay(tops: [0, 1000, 2000], pageW: 800, S: 800), half = Lay(tops: [0, 500, 1000], pageW: 400, S: 800), twice = Lay(tops: [0, 2000, 4000], pageW: 1600, S: 1600)
        XCTAssertTrue(PaperDraw.settleView(W: 800, ox: 400, oy: 1200, top: 900, left: 0, from: from, to: half) == (300, 0))
        XCTAssertTrue(PaperDraw.settleView(W: 800, ox: 400, oy: 1200, top: 900, left: 0, from: from, to: twice) == (2100, 400))
        XCTAssertTrue(PaperDraw.settleView(W: 800, ox: 1200, oy: 0, top: 0, left: 800, from: twice, to: Lay(tops: [0, 1500], pageW: 1200, S: 1200)) == (0, 400))
        XCTAssertEqual(PaperDraw.settleView(W: 800, ox: 400, oy: 0, top: 0, left: 0, from: twice, to: from).left, 0)
        XCTAssertEqual(PaperDraw.settleView(W: 800, ox: 400, oy: 10, top: 0, left: 0, from: from, to: half).top, 0)
    }

    func testAskedByNote() {
        XCTAssertTrue(Canvas.askedByNote("why is κ good?", "@bart why is κ good?"))
        XCTAssertTrue(Canvas.askedByNote("why  is κ\ngood?", "@Bart   why is κ good? "))
        XCTAssertFalse(Canvas.askedByNote("why?", "@bart and then?"))
        XCTAssertTrue(Canvas.askedByNote("a plain note", "a plain note"))
        XCTAssertFalse(Canvas.askedByNote("why?", nil))
        XCTAssertTrue(Canvas.askedByNote("", "anything"))
    }

    func testPlaceOfPosOf() {
        let pos = Canvas.posOf(1300, 200, 400, 800)
        XCTAssertEqual(pos, PPoint(x: 1.125, y: (200 + Canvas.POS_DY) / 800))
        XCTAssertTrue(Canvas.placeOf(pos, 400, 800) == (1300, 200))
        let half = Canvas.placeOf(pos, 400, 400)
        XCTAssertEqual(half.left, 400 + 1.125 * 400)
        XCTAssertEqual(half.top, ((200 + Canvas.POS_DY) / 800) * 400 - Canvas.POS_DY)
    }

    private func box(_ l: Double, _ w: Double, _ h: Double) -> Canvas.SpaceBox { .init(left: l, width: w, height: h) }
    private func unit(_ id: String, _ want: Double, _ boxes: Canvas.SpaceBox...) -> Canvas.SpaceUnit { .init(id: id, want: want, boxes: boxes) }

    func testSpaceBoxes() {
        XCTAssertEqual(Canvas.BOX_GAP, 12)
        let tops = Canvas.spaceBoxes([unit("c", 130, box(1000, 240, 40)), unit("a", 100, box(1000, 240, 40)), unit("b", 110, box(1000, 240, 30)), unit("d", 400, box(1000, 240, 40))])
        XCTAssertEqual(tops, ["a": 100, "b": 152, "c": 194, "d": 400])
        let together = Canvas.spaceBoxes([unit("note+answers", 100, box(1000, 240, 40), box(1000, 320, 200)), unit("next", 120, box(1000, 240, 40)), unit("left side", 105, box(40, 240, 40))])
        XCTAssertEqual(together, ["note+answers": 100, "next": 364, "left side": 105])
        let moved = [Canvas.FixedBox(left: 1100, top: 90, width: 320, height: 100)]
        XCTAssertEqual(Canvas.spaceBoxes([unit("a", 80, box(1000, 240, 40)), unit("b", 300, box(1000, 240, 40))], fixed: moved), ["a": 202, "b": 300])
        XCTAssertEqual(Canvas.spaceBoxes([unit("a", 80, box(1000, 60, 40))], fixed: moved)["a"], 80)
        XCTAssertEqual(Canvas.spaceBoxes([unit("a", 202, box(1100, 10, 10))], fixed: moved)["a"], 202)
        XCTAssertEqual(Canvas.spaceBoxes([unit("a", 201, box(1100, 10, 10))], fixed: moved)["a"], 202)
        let deep = Canvas.spaceBoxes([unit("pair", 0, box(1000, 60, 50), box(1000, 320, 50))], fixed: [.init(left: 1200, top: 70, width: 50, height: 50)])
        XCTAssertEqual(deep["pair"], 70 + 50 + 12 - 62)
    }

    func testSpaceBoxesNeverOverlap() {
        var seed = 7.0
        func rand() -> Double { seed = (seed * 16807).truncatingRemainder(dividingBy: 2147483647); return seed / 2147483647 }
        let units = (0..<40).map { i -> Canvas.SpaceUnit in
            let want = (rand() * 900).rounded()
            let n = 1 + Int(rand() * 3)
            return Canvas.SpaceUnit(id: "u\(i)", want: want, boxes: (0..<n).map { _ in box(rand() < 0.5 ? 40 : 1000, 240 + (rand() * 80).rounded(), 20 + (rand() * 120).rounded()) })
        }
        let fixed = (0..<5).map { _ in Canvas.FixedBox(left: rand() < 0.5 ? 60 : 1050, top: (rand() * 900).rounded(), width: 200, height: 80) }
        let tops = Canvas.spaceBoxes(units, fixed: fixed)
        var placed = fixed
        for u in units {
            var t = tops[u.id]!
            XCTAssertGreaterThanOrEqual(t, u.want)
            for b in u.boxes { placed.append(.init(left: b.left, top: t, width: b.width, height: b.height)); t += b.height + Canvas.BOX_GAP }
        }
        for i in placed.indices { for j in placed.indices where j > i {
            let a = placed[i], b = placed[j]
            let sharesX = a.left < b.left + b.width && b.left < a.left + a.width
            let apart = a.top + a.height + Canvas.BOX_GAP <= b.top + 1e-9 || b.top + b.height + Canvas.BOX_GAP <= a.top + 1e-9
            if sharesX && !(i < fixed.count && j < fixed.count) { XCTAssertTrue(apart, "boxes \(i) and \(j)") }
        } }
    }

    func testNoteQuestion() {
        XCTAssertEqual(Canvas.noteQuestion("@bart why κ?"), "why κ?")
        XCTAssertEqual(Canvas.noteQuestion("  @Bart --opus why\nand how?"), "--opus why\nand how?")
        XCTAssertEqual(Canvas.noteQuestion("@bart"), "")
        XCTAssertNil(Canvas.noteQuestion("see @bart why"))
        XCTAssertNil(Canvas.noteQuestion("@barty"))
        XCTAssertNil(Canvas.noteQuestion(nil))
    }

    func testWithAskAndTurns() {
        let marks = PaperMarks(pages: [2: [Mark(id: "m1", note: "@bart q", asks: []), Mark(id: "m2")]])
        let entry = AskEntry(id: "a1", question: "q", answer: "A.")
        let next = Canvas.withAsk(marks, page: 2, markId: "m1", entry: entry)
        XCTAssertEqual(next[2][0].asks, [entry])
        XCTAssertEqual(marks[2][0].asks, [])
        XCTAssertEqual(Canvas.withAsk(next, page: 2, markId: "m1", entry: entry)[2][0].asks?.count, 1)
        XCTAssertEqual(Canvas.withAsk(marks, page: 2, markId: "gone", entry: entry), marks)
        XCTAssertEqual(Canvas.withAsk(marks, page: 7, markId: "m1", entry: entry), marks)
        XCTAssertEqual(Canvas.turnsOf(next[2][0]), [Canvas.Turn(question: "q", answer: "A.")])
        XCTAssertEqual(Canvas.turnsOf(Mark(id: "x")), [])
    }

    func testRunningBack() {
        let held = ["h1": PendingAsk(askId: "h1", markId: "m1", page: 2, question: "why?", activity: "Writing", lines: ["So far"])]
        let list = [PendingAsk(askId: "h1", markId: "m1", page: 2, question: "why?", activity: "Reading"),
                    PendingAsk(askId: "h2", markId: "m3", page: 5, question: "and?", activity: "Reading", name: "Sonnet", effort: "high", log: ["Reading"]),
                    PendingAsk(askId: "h3", markId: "m4", page: 1, question: "so?"),
                    PendingAsk(askId: "h4", markId: "", page: 0)]
        let next = Canvas.runningBack(held, list, ended: ["h3"])
        XCTAssertEqual(Set(next.keys), ["h1", "h2"])
        XCTAssertEqual(next["h1"], held["h1"])
        XCTAssertEqual(next["h2"], list[1])
        XCTAssertEqual(Canvas.runningBack(held, [list[0]]), held)
    }

    func testDeletedAnswerExchange() {
        let t0 = Time.parse("2026-10-06T10:00:00.000Z")!.timeIntervalSince1970 * 1000
        func at(_ min: Double) -> String { Time.iso(Date(timeIntervalSince1970: (t0 + min * 60_000) / 1000)) }
        let m = Mark(id: "m1", note: "@bart q", asks: [AskEntry(id: "a1", question: "why?", answer: "Because.", at: at(0), deleted: true), AskEntry(id: "a2", question: "and?", answer: "Then.", at: at(5))])
        XCTAssertEqual(Canvas.shownAsks(m).map(\.id), ["a2"])
        XCTAssertEqual(Canvas.turnsOf(m, now: t0 + 20 * 60_000), [.init(question: "why?", answer: "Because."), .init(question: "and?", answer: "Then.")])
        XCTAssertEqual(Canvas.turnsOf(m, now: t0 + 36 * 60_000), [.init(question: "and?", answer: "Then.")])
        XCTAssertEqual(Canvas.exchangeOf(Mark(id: "x", asks: [AskEntry(id: "a", deleted: true)]), now: t0).map(\.id), [])
        let kept = Canvas.keptMarks([m, Mark(id: "m2", note: "n")], now: t0 + 40 * 60_000)
        XCTAssertEqual(kept[0].asks?.map(\.id), ["a2"])
        XCTAssertEqual(kept[1].id, "m2")
        XCTAssertEqual(Canvas.keptMarks([m], now: t0 + 10 * 60_000)[0], m)
    }

    func testKeptMarksDropsEmptyFreeNotes() {
        // paper-blank-arrows: keptMarks drops a free note with nothing in it, never a highlight or a note with words
        let list = [Mark(id: "f1", note: "  "), Mark(id: "f2", note: "words"), Mark(id: "h", rects: [PRect(0.1, 0.1, 0.2, 0.01)], note: nil)]
        XCTAssertEqual(Canvas.keptMarks(list).map(\.id), ["f2", "h"])
    }

    func testContinueLines() {
        XCTAssertEqual(Canvas.continueLines(quote: "κ was\n0.79 overall", question: "is that good?", answer: "Yes.\n\nSee p. 6.", foot: "Sonnet · high · 4 s", paper: .init(name: "TutorTrace", rowId: "r1"), page: 6), [
            "“κ was 0.79 overall” (@[TutorTrace], p. 6)", "@chat is that good?", "bart> Yes.", "bart>", "bart> See p. 6.", "bart>", "bart> *Sonnet · high · 4 s*",
        ])
        let web = Canvas.continueLines(quote: "q", question: "why\nnow", answer: "A", paper: .init(name: "Scim", url: "https://arxiv.org/pdf/1"), page: 2)
        XCTAssertEqual(web[0], "“q” ([Scim](https://arxiv.org/pdf/1), p. 2)")
        XCTAssertEqual(web[1], "@chat why now")
    }

    func testRunningLabel() {
        XCTAssertEqual(Canvas.runningLabel(PendingAsk(askId: "a", markId: "m", page: 1, activity: "Reading tutortrace.pdf")), "Bart · Reading tutortrace.pdf")
        XCTAssertEqual(Canvas.runningLabel(PendingAsk(askId: "a", markId: "m", page: 1, activity: "", movedUp: true, name: "Opus", effort: "high")), "Bart · Moving up to Opus high")
        XCTAssertEqual(Canvas.runningLabel(PendingAsk(askId: "a", markId: "m", page: 1, name: "Sonnet", effort: "high")), "Bart · Thinking")
        XCTAssertEqual(Canvas.runningLabel(nil), "Bart · Thinking")
    }

    func testTextColumn() {
        let lefts = Array(repeating: 0.12, count: 60) + [0.02], rights = Array(repeating: 0.88, count: 60) + [0.99]
        XCTAssertTrue(Canvas.textColumn(lefts, rights)! == (0.12, 0.88))
        let two = Array(repeating: 0.1, count: 30) + Array(repeating: 0.52, count: 30), ends = Array(repeating: 0.48, count: 30) + Array(repeating: 0.9, count: 30)
        XCTAssertTrue(Canvas.textColumn(two, ends)! == (0.1, 0.9))
        XCTAssertNil(Canvas.textColumn([0.1, 0.2], [0.8, 0.9]))
        XCTAssertNil(Canvas.textColumn([], []))
    }

    func testAnswerOfAndAskEntry() {
        let (answer, foot) = Canvas.answerOf(["bart> Yes.", "bart>", "bart> See p. 6.", "bart>", "bart> *Sonnet · high · 4 s*"])
        XCTAssertEqual(answer, "Yes.\n\nSee p. 6.")
        XCTAssertEqual(foot, "Sonnet · high · 4 s")
        let e = Canvas.askEntry(id: "k1", question: " why? ", lines: ["bart> Because."], meta: ["provider": "claude", "level": ["name": "Sonnet", "effort": "high"], "ms": 0], at: "2026-10-06T10:00:00.000Z", crop: "../x.png")
        XCTAssertEqual(e.question, "why?")
        XCTAssertEqual(e.answer, "Because.")
        XCTAssertEqual(e.meta?.object?["ms"], .null, "a falsy ms is null, as `|| null` has it")
        XCTAssertEqual(e.meta?.object?["name"], "Sonnet")
        XCTAssertNil(e.crop, "only a crops/… picture is kept")
        XCTAssertEqual(e.collapsed, false)
    }

    func testSelectionCardPlace() {
        let pane = CGRect(x: 0, y: 0, width: 600, height: 400)
        let line = CGRect(x: 100, y: 100, width: 200, height: 14)
        XCTAssertEqual(Canvas.selectionCardPlace(line: line, all: line, pane: pane, size: CGSize(width: 240, height: 40)), CGRect(x: 100, y: 122, width: 240, height: 40))
        // no room under: above the first line
        let low = CGRect(x: 100, y: 370, width: 200, height: 14)
        XCTAssertEqual(Canvas.selectionCardPlace(line: low, all: CGRect(x: 100, y: 340, width: 200, height: 44), pane: pane, size: CGSize(width: 240, height: 40))!.minY, 340 - 8 - 40)
        // kept inside the pane on the right
        XCTAssertEqual(Canvas.selectionCardPlace(line: CGRect(x: 500, y: 100, width: 50, height: 14), all: nil, pane: pane, size: CGSize(width: 240, height: 40))!.minX, 360)
        // out of the pane: none
        XCTAssertNil(Canvas.selectionCardPlace(line: CGRect(x: 100, y: 500, width: 50, height: 14), all: nil, pane: pane, size: CGSize(width: 240, height: 40)))
    }

    /* ------------------------------------------------------------------------------------------------ zoom and drawing */

    func testZoomSteps() {
        XCTAssertEqual(PaperZoom.zoomStep(100, 1), 110)
        XCTAssertEqual(PaperZoom.zoomStep(100, -1), 90)
        XCTAssertEqual(PaperZoom.zoomStep(68, -1), 67)
        XCTAssertEqual(PaperZoom.zoomStep(68, 1), 69)
        XCTAssertNil(PaperZoom.zoomStep(200, 1))
        XCTAssertNil(PaperZoom.zoomStep(15, -1))
        XCTAssertEqual(PaperZoom.zoomStep(14.6, -1), nil, "15 rounded is the floor")
    }

    func testWheelZoom() {
        XCTAssertEqual(PaperZoom.wheelZoom(1, .init(deltaY: -25)), exp(0.25), accuracy: 1e-12)
        XCTAssertEqual(PaperZoom.wheelZoom(1, .init(deltaY: -500)), exp(0.5), accuracy: 1e-12, "one event is limited to about ×1.65")
        XCTAssertEqual(PaperZoom.wheelZoom(1, .init(deltaY: 3, lines: true)), exp(-0.48), accuracy: 1e-12)
        XCTAssertEqual(PaperZoom.wheelZoom(1.9, .init(deltaY: -50)), 2)
        XCTAssertEqual(PaperZoom.wheelZoom(0.2, .init(deltaY: 50)), 0.15)
        // a pinch of +10% is a ×1.1 zoom
        XCTAssertEqual(PaperZoom.wheelZoom(1, PaperZoom.pinchWheel(magnification: 0.1)), 1.1, accuracy: 1e-9)
    }

    func testPageAtAndCanvasScale() {
        XCTAssertEqual(PaperZoom.pageAt([], 10), 0)
        XCTAssertEqual(PaperZoom.pageAt([0, 100, 200], 0), 1)
        XCTAssertEqual(PaperZoom.pageAt([0, 100, 200], 150), 2)
        XCTAssertEqual(PaperZoom.pageAt([0, 100, 200], 9999), 3)
        XCTAssertEqual(PaperZoom.canvasScale(100, 100), 2)
        XCTAssertEqual(PaperZoom.canvasScale(2000, 2000), 1)
    }

    func testNearOrder() {
        XCTAssertEqual(PaperDraw.nearOrder(3, 5, 4, 10), [4, 5, 3, 6, 2, 7, 1])
        XCTAssertEqual(PaperDraw.nearOrder(1, 1, 1, 3), [1, 2, 3])
        XCTAssertEqual(PaperDraw.nearOrder(0, 0, 0, 0), [])
        XCTAssertEqual(PaperDraw.allOrder(2, 2, 2, 4), [2, 3, 1, 4])
        XCTAssertTrue(PaperDraw.tooFar(12, 3, 5))
        XCTAssertFalse(PaperDraw.tooFar(10, 3, 5))
    }

    /* ------------------------------------------------------------------------------------------------ find */

    func testFindPatternHyphenNewline() {
        let pages = [(page: 1, text: "a construc-\ntion of the thing"), (page: 2, text: "Construction here")]
        let spots = PaperFind.matchSpots("construction", pages: pages)
        XCTAssertEqual(spots, [FindSpot(page: 1, from: 2, to: 16), FindSpot(page: 2, from: 0, to: 12)])
        XCTAssertEqual(PaperFind.matchSpots("of the", pages: pages), [FindSpot(page: 1, from: 17, to: 23)])
        XCTAssertEqual(PaperFind.matchSpots("ofthe", pages: [(1, "of the")]), [], "a space in the text is not skipped")
        XCTAssertEqual(PaperFind.matchSpots("of the", pages: [(1, "ofthe")]).count, 1, "a space in the query matches none")
        // typography: curly quotes, an em dash, a ligature
        XCTAssertEqual(PaperFind.matchSpots("the \"first\" try - again", pages: [(3, "so the “ﬁrst” try — again")]).count, 1)
    }

    func testNextFind() {
        XCTAssertTrue(PaperFind.nextFind(fresh: true, count: 0, at: 3) == (-1, false))
        XCTAssertTrue(PaperFind.nextFind(fresh: true, count: 5, at: -1, firstInView: { 2 }) == (2, true))
        XCTAssertTrue(PaperFind.nextFind(fresh: true, step: -1, count: 5, at: -1) == (4, true))
        XCTAssertTrue(PaperFind.nextFind(fresh: false, step: 1, count: 5, at: 4) == (0, true))
        XCTAssertTrue(PaperFind.nextFind(fresh: false, step: -1, count: 5, at: 0) == (4, true))
        XCTAssertTrue(PaperFind.nextFind(fresh: false, step: 0, count: 3, at: 7) == (2, false))
        XCTAssertTrue(PaperFind.nextFind(fresh: false, count: 3, at: 2, fromStart: true) == (0, true))
    }

    func testSectionSpansAndGate() {
        let start = FindSpot(page: 2, from: 10, to: 20)
        XCTAssertEqual(PaperFind.sectionSpans(start, [FindSpot(page: 2, from: 50, to: 60)]), [FindSpot(page: 2, from: 10, to: 50)])
        XCTAssertEqual(PaperFind.sectionSpans(start, [FindSpot(page: 1, from: 0, to: 1), FindSpot(page: 4, from: 7, to: 9)]), [FindSpot(page: 2, from: 10, to: nil), FindSpot(page: 3, from: 0, to: nil), FindSpot(page: 4, from: 0, to: 7)])
        XCTAssertNil(PaperFind.sectionSpans(start, [FindSpot(page: 9, from: 0, to: 1)]), "more than six pages on")
        XCTAssertNil(PaperFind.sectionSpans(start, []))
        let gate = TargetGate()
        XCTAssertNil(gate.set("words"), "not drawn yet")
        XCTAssertEqual(gate.peek(), "words")
        XCTAssertEqual(gate.drawn(), "words")
        XCTAssertNil(gate.drawn(), "once")
        XCTAssertNil(gate.set(""))
        XCTAssertEqual(gate.set("words"), "words", "cleared and given again")
        XCTAssertEqual(PaperFind.targetKey("a", "b"), "a\nb")
        XCTAssertEqual(PaperFind.targetKey("a", nil), "a")
        XCTAssertEqual(PaperFind.targetKey(nil, "b"), "")
    }

    /* ------------------------------------------------------------------------------------------------ the ink file */

    func testJSNumbers() {
        XCTAssertEqual(JSNumber.string(1), "1")
        XCTAssertEqual(JSNumber.string(0.1), "0.1")
        XCTAssertEqual(JSNumber.string(-2.5), "-2.5")
        XCTAssertEqual(JSNumber.string(1e-7), "1e-7")
        XCTAssertEqual(JSNumber.string(0.000001), "0.000001")
        XCTAssertEqual(JSNumber.string(1e21), "1e+21")
        XCTAssertEqual(JSNumber.string(1e20), "100000000000000000000")
        XCTAssertEqual(JSNumber.string(123.456), "123.456")
        XCTAssertEqual(JSNumber.string(0.5 + 0.018), "0.518")
        XCTAssertEqual(JSNumber.string(106.0 / 500), "0.212")
        XCTAssertEqual(JSNumber.string(1.0 / 3), "0.3333333333333333")
        XCTAssertEqual(JSNumber.string(-0.0), "0")
        XCTAssertEqual(JSNumber.string(.nan), "null")
    }

    func testInkRoundTripAsElectronWritesIt() throws {
        // As PaperView writes it (keys in its order) and library.cjs stores it (JSON.stringify).
        let text = #"{"1":[{"id":"m1759700000000abcd","rects":[{"x":0.1,"y":0.2,"w":0.5,"h":0.015}],"side":"right","y":0.2,"note":"@bart why?","text":"a \"quoted\" line\n","pos":null,"group":"g1","asks":[{"id":"k1","question":"why?","answer":"Because.","meta":{"provider":"claude","name":"Sonnet","effort":"high","ms":1200,"foot":"Sonnet · high · 1 s"},"at":"2026-10-06T10:00:00.000Z","pos":null,"collapsed":false}]},{"id":"m2","rects":[],"side":null,"y":0.9,"note":"free","text":"","pos":{"x":0.2,"y":0.9},"w":150}],"12":[],"web":[{"id":"w1","quote":{"exact":"x"}}]}"#
        let marks = AnnotationJSON.decode(Data(text.utf8))
        XCTAssertEqual(marks[1].count, 2)
        XCTAssertEqual(marks[1][0].asks?.first?.answer, "Because.")
        XCTAssertEqual(marks[1][1].pos, PPoint(x: 0.2, y: 0.9))
        XCTAssertEqual(marks[1][1].w, 150)
        XCTAssertNotNil(marks.other["web"], "a web page's list is kept untouched")
        let out = try AnnotationJSON.encode(marks)
        // Everything but the answer's meta (an object whose original key order is not kept) reads back byte for byte.
        let expected = text.replacingOccurrences(of: #""meta":{"provider":"claude","name":"Sonnet","effort":"high","ms":1200,"foot":"Sonnet · high · 1 s"}"#, with: #""meta":{"effort":"high","foot":"Sonnet · high · 1 s","ms":1200,"name":"Sonnet","provider":"claude"}"#)
        XCTAssertEqual(out, expected)
        XCTAssertEqual(AnnotationJSON.decode(Data(out.utf8)), marks)
    }

    func testInkUnknownFieldsKept() throws {
        let text = #"{"3":[{"id":"a","rects":[],"side":null,"y":0,"note":"n","text":"","pos":null,"vis":{"l":1}}]}"#
        let out = try AnnotationJSON.encode(AnnotationJSON.decode(Data(text.utf8)))
        XCTAssertEqual(out, text)
    }

    func testInkTooLarge() {
        let big = Mark(id: "x", note: String(repeating: "a", count: AnnotationJSON.maxChars))
        XCTAssertThrowsError(try AnnotationJSON.encode(PaperMarks(pages: [1: [big]]))) { XCTAssertEqual($0.localizedDescription, "annotations are too large") }
    }

    func testJSStringEscapes() {
        var s = ""
        JSString.quote("a\"b\\c\n\t\u{01}é\u{2028}😀", into: &s)
        XCTAssertEqual(s, "\"a\\\"b\\\\c\\n\\t\\u0001é\u{2028}😀\"")
    }

    /* ------------------------------------------------------------------------------------------------ rough.js */

    func testRoughMatchesRoughJS() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "rough-highlights", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertEqual(cases.count, 4)
        for c in cases {
            let x = c["x"] as! Double, y = c["y"] as! Double, w = c["w"] as! Double, h = c["h"] as! Double, seed = c["seed"] as! Int
            let ops = Rough.zigzagRectangle(x, y + h * 0.12, w, h * 0.76, .highlight(seed: seed))
            XCTAssertEqual(Rough.svgPath(ops), c["path"] as! String, "seed \(seed)")
        }
    }

    func testRoughRandom() {
        // Math.imul(48271, seed) & 0x7fffffff over 2^31, as math.js Random
        let r = Rough.Random(1)
        XCTAssertEqual(r.next(), 48271.0 / 2147483648.0)
        XCTAssertEqual(r.next(), Double((48271 * 48271) & 0x7fffffff) / 2147483648.0)
    }
}
