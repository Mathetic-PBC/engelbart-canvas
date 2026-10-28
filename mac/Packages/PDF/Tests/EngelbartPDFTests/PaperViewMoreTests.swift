import AppKit
import EngelbartCore
import XCTest
@testable import EngelbartPDF

// The second pass (ledger rows that were "compiled, untested"): zoom by events, resize, restore, the title block, the
// bar, toast and selection card (with pixels against the CSS values), highlights' ink, cards and their sections,
// chips, the @ menu, running asks, answers and citations, find's tints, targets, keys, two papers side by side.

@MainActor
final class PaperViewMoreTests: PaperTestCase {

    /* ----------------------------------------------------------------------------------------- opening, status, title */

    func testStatusTexts() throws {
        open()
        paper.load(data: nil)
        XCTAssertEqual(paper.note, "No paper to open.")
        XCTAssertFalse(paper.statusLabel.isHidden)
        XCTAssertTrue(paper.bar.isHidden, "no bar while there is a status")
        XCTAssertEqual(paper.statusLabel.font?.pointSize, 12)
        paper.load(data: Data("not a pdf".utf8))
        XCTAssertEqual(paper.note, "Could not open the paper — The file is not a readable pdf")
        paper.load(data: makePDF(pages: 1, lines: lines))
        spin { self.paper.laidOut }
        XCTAssertEqual(paper.note, "")
        XCTAssertTrue(paper.statusLabel.isHidden)
        XCTAssertFalse(paper.bar.isHidden)
    }

    func testTitleBlockAndItsRule() throws {
        open(title: "TutorTrace: a paper")
        let label = paper.view.subviews.compactMap { $0.subviews.first as? NSTextField }.first
        XCTAssertEqual(label?.stringValue, "TutorTrace: a paper")
        XCTAssertEqual(label?.font?.pointSize, 15)
        XCTAssertEqual(label?.frame.minX, 20)
        XCTAssertEqual(label?.frame.minY, 14)
        XCTAssertGreaterThan(paper.paperArea.frame.minY, 14 + 12, "the pages start under the title and a 12 px gap")
        let rule = paper.paperArea.layer?.sublayers?.first { $0.name == "title-rule" }
        XCTAssertEqual(rule?.frame.height, 1)
        XCTAssertEqual(rule?.backgroundColor, NSColor(hex: "#eaeaea").cgColor)
        paper.paperTitle = nil
        paper.view.layoutSubtreeIfNeeded()
        XCTAssertEqual(paper.paperArea.frame.minY, 0)
        XCTAssertNil(paper.paperArea.layer?.sublayers?.first { $0.name == "title-rule" })
    }

    func testThePaneIsWhite() throws {
        open()
        XCTAssertEqual(paper.scrollView.backgroundColor, .white)
        XCTAssertEqual(paper.canvas.layer?.backgroundColor, NSColor.white.cgColor)
        XCTAssertEqual(paper.scrollView.borderType, .noBorder)
    }

    func testRestoresWhereItWasReadTo() throws {
        open(pages: 3, view: PaperViewState(zoom: 1.5, at: 0.5, left: 40))
        XCTAssertEqual(paper.currentZoom, 1.5, accuracy: 1e-9)
        XCTAssertEqual(paper.scrollTop, 0.5 * Double(paper.canvas.bounds.height), accuracy: 2)
        XCTAssertEqual(paper.scrollLeft, 40, accuracy: 1)
    }

    func testInitialSectionShownWithNoTarget() throws {
        open(pages: 3, initialSection: (find: "Cohen's kappa", to: "lorem ipsum"))
        spin { self.paper.section != nil }
        XCTAssertEqual(paper.section?.spot.page, 1)
        XCTAssertEqual(host.targets.first?.0, "Cohen's kappa")
        spin { !self.paper.sheets[0].tintLayer.tints.section.isEmpty }
        XCTAssertFalse(paper.sheets[0].tintLayer.tints.section.isEmpty, "tinted to just before the next section's words")
    }

    func testATargetNamingItsPageGoesThereAtOnce() throws {
        // Before the pages have their text a target naming its page scrolls there at once (the gate holds the passage);
        // once they have it the passage is found from page 1 and shown (PaperView componentDidUpdate → applyTarget).
        open(pages: 4)
        paper.gate.drawing()
        paper.setTarget("dog on page 3", to: nil, page: 3)
        XCTAssertEqual(paper.currentPage(), 3, "the page first, before any text is in")
        paper.setTarget(nil)
        spin { self.paper.texts.count == 4 }
        _ = paper.gate.drawn()
        paper.setTarget("The quick brown fox jumps over the lazy dog on page 3", to: nil, page: 3)
        spin { self.paper.section != nil }
        XCTAssertEqual(paper.section?.spot.page, 3)
        XCTAssertEqual(paper.currentPage(), 3)
    }

    func testLoadingAnotherPaperSavesTheFirstAndStartsAfresh() throws {
        open()
        textRead()
        selectLine(0)
        XCTAssertTrue(paper.canvasKeyDown(key("\r", 36)))
        paper.removeMark(1, paper.marks[1][0])
        XCTAssertFalse(paper.undos.isEmpty)
        selectLine(1)
        XCTAssertNotNil(paper.pendingSel)
        let other = PaperMarks(pages: [1: [highlight("o1")]])
        paper.load(data: makePDF(pages: 1, lines: lines), marks: other)
        XCTAssertFalse(host.saved.isEmpty, "the first paper's unsaved ink is saved first")
        XCTAssertNil(paper.pendingSel)
        XCTAssertTrue(paper.undos.isEmpty, "another paper: nothing to bring back")
        XCTAssertTrue(paper.toast.isHidden)
        XCTAssertEqual(paper.marks[1].map(\.id), ["o1"])
    }

    func testMarksArrivingLateAreAdoptedOnlyWhileNothingWasEdited() throws {
        open()
        paper.setMarks(PaperMarks(pages: [1: [highlight("late")]]))
        XCTAssertEqual(paper.marks[1].map(\.id), ["late"])
        textRead()
        selectLine(2)
        XCTAssertTrue(paper.canvasKeyDown(key("\r", 36)))
        paper.setMarks(PaperMarks(pages: [1: [highlight("other")]]))
        XCTAssertNotEqual(paper.marks[1].map(\.id), ["other"], "edited here: kept")
    }

    /* ----------------------------------------------------------------------------------------- zoom by events, resize */

    func testControlScrollZoomsAsOneTransformThenSettles() throws {
        open()
        let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 25, wheel2: 0, wheel3: 0)!
        cg.flags = .maskControl
        let e = NSEvent(cgEvent: cg)!
        let top0 = paper.scrollTop
        paper.scrollView.scrollWheel(with: e)
        paper.scrollView.scrollWheel(with: e)
        let live = paper.live ?? 0
        XCTAssertGreaterThan(live, 1.2, "zoomed in")
        XCTAssertEqual(Double(paper.scrollView.magnification), live, accuracy: 1e-6, "the paper scaled whole")
        XCTAssertEqual(paper.pageW, 612, "nothing laid out yet")
        XCTAssertEqual(paper.bar.preferredSize.height, 34)
        spin(0.4)
        XCTAssertNil(paper.live, "settled 180 ms after the last event")
        XCTAssertEqual(paper.scrollView.magnification, 1)
        XCTAssertEqual(paper.pageW, (612 * live).rounded(), accuracy: 1)
        XCTAssertEqual(paper.pct(), Int((live * 100).rounded()))
        XCTAssertGreaterThanOrEqual(paper.scrollTop, top0)
        // a plain scroll scrolls
        let plain = NSEvent(cgEvent: CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -40, wheel2: 0, wheel3: 0)!)!
        paper.scrollView.scrollWheel(with: plain)
        XCTAssertNil(paper.live)
    }

    func testAPinchOutAtTheTopKeepsPageOneAtThePaneTopAndHoldsCardsAtTheFloor() throws {
        open(marks: PaperMarks(pages: [1: [highlight("h", note: "a note")]]))
        spin(0.2)
        for _ in 0..<6 { paper.pinch(PaperZoom.pinchWheel(magnification: -0.3), pointerY: 300) }
        XCTAssertLessThan(paper.css, 0.4)
        XCTAssertEqual(Double(paper.clip.bounds.minY), 0, accuracy: 0.5, "no white band above page 1")
        let card = (try XCTUnwrap(paper.cardView("h"))), p = (try XCTUnwrap(paper.places["h"]))
        let onScreen = Double(card.frame.width) * paper.css / Double(card.size.width)
        XCTAssertEqual(onScreen, Canvas.NOTE_FLOOR, accuracy: 1e-6, "held at 10px handwriting, no smaller")
        XCTAssertLessThan(p.ns * paper.css, Canvas.NOTE_FLOOR)
        spin(0.4)
        XCTAssertEqual(paper.scrollTop, 0, accuracy: 0.5, "settled at the top")
        XCTAssertEqual(Double(card.frame.width) / Double(card.size.width), (try XCTUnwrap(paper.places["h"])).ns, accuracy: 1e-6, "back to its scale")
    }

    func testAPinchAboveTheFloorScalesCardsWithThePaper() throws {
        open(marks: PaperMarks(pages: [1: [highlight("h", note: "a note")]]))
        spin(0.2)
        paper.pinch(PaperZoom.pinchWheel(magnification: -0.1), pointerY: 300)
        let card = (try XCTUnwrap(paper.cardView("h")))
        XCTAssertEqual(Double(card.frame.width) / Double(card.size.width), (try XCTUnwrap(paper.places["h"])).ns, accuracy: 1e-6, "no counter-scale: 0.9 × 0.58 is above the floor")
    }

    func testAResizedPaneKeepsItsZoom() throws {
        open()
        paper.zoomTo(50)
        window.setContentSize(NSSize(width: 800, height: 700))
        paper.view.frame = NSRect(x: 0, y: 0, width: 800, height: 700)
        paper.view.layoutSubtreeIfNeeded()
        XCTAssertEqual(paper.pageW, 400, "50% of the new width at once")
        XCTAssertEqual(paper.pct(), 50)
        spin { self.paper.sheets[0].drawn }
        XCTAssertTrue(paper.sheets[0].drawn, "drawn for it once the resize settled")
    }

    func testAZoomRedrawsThePagesInViewAndKeepsTheOldDrawingStretchedMeanwhile() throws {
        open(pages: 3)
        spin { self.paper.sheets[0].image != nil }
        let before = paper.sheets[0].image
        paper.zoomTo(200)
        XCTAssertFalse(paper.sheets[0].drawn, "to be drawn again")
        XCTAssertTrue(paper.sheets[0].image === before, "the old drawing stretched until then")
        spin { self.paper.sheets[0].drawn }
        XCTAssertFalse(paper.sheets[0].image === before)
        XCTAssertGreaterThan(paper.sheets[0].image!.width, before!.width)
    }

    func testBarButtonsStepAndTheBarSitsAtTheFoot() throws {
        open()
        let f = paper.bar.frame, a = paper.paperArea.bounds
        XCTAssertEqual(f.minY, 16, "16 from the foot")
        XCTAssertEqual(f.height, 34)
        XCTAssertEqual(f.midX, a.midX, accuracy: 0.5)
        XCTAssertEqual(paper.bar.toolTip, "pinch, or ⌘ or ⌃ scroll, to zoom")
        XCTAssertEqual(paper.bar.layer?.cornerRadius, 8)
        XCTAssertEqual(paper.bar.layer?.borderColor, NSColor(hex: "#eaeaea").cgColor)
        paper.bar.onStep?(1)
        XCTAssertEqual(paper.pct(), 110)
        paper.bar.onStep?(-1); paper.bar.onStep?(-1)
        XCTAssertEqual(paper.pct(), 90)
        paper.bar.onPct?()
        XCTAssertEqual(paper.pct(), 100)
        let px = pixels(paper.bar)
        XCTAssertTrue(px.near(px.rgb(px.w / 2, px.h / 2 - 12), "#ffffff", 2) || px.has("#ffffff", 2), "white")
        XCTAssertTrue(px.has("#eaeaea", 8), "the 1px edge or the separator")
        XCTAssertGreaterThan(px.count { $0.r < 120 && $0.g < 120 && $0.b < 120 }, 5, "its numbers drawn dark")
    }

    /* ----------------------------------------------------------------------------------------- highlights' ink */

    func testHighlightsAreBlueZigzagsThatMultiplyWithThePage() throws {
        open(marks: PaperMarks(pages: [1: [highlight("h")]]))
        spin { self.paper.sheets[0].inkLayer.active && !self.paper.sheets[0].inkLayer.ink.zigzags.isEmpty }
        let ink = paper.sheets[0].inkLayer
        XCTAssertEqual(ink.compositingFilter as? String, "multiplyBlendMode")
        let px = pixels(ink)
        let x0 = Int(72.0 / 612 * paper.pageW), x1 = Int(272.0 / 612 * paper.pageW)
        let blue = { (c: (r: Int, g: Int, b: Int, a: Int)) -> Bool in c.a > 10 && c.b > c.r + 20 }
        XCTAssertGreaterThan(px.count(x0: x0, x1: x1, blue), 100, "the band's strokes")
        XCTAssertEqual(px.count(x0: x1 + 20, x1: px.w, blue), 0, "nothing past the band")
        // the mark in focus: a deeper fill over its band
        let before = px.count(x0: x0, x1: x1, blue)
        paper.focusMark("h")
        let focused = pixels(ink)
        XCTAssertGreaterThan(focused.count(x0: x0, x1: x1, blue), before, "rgba(0,112,243,.14) over it")
    }

    func testInkIsDrawnOnlyNearTheView() throws {
        var marks = PaperMarks()
        for p in 1...20 { marks[p] = [highlight("h\(p)")] }
        open(pages: 20, marks: marks)
        spin(0.5)
        XCTAssertTrue(paper.sheets[0].inkLayer.active)
        XCTAssertFalse(paper.sheets[19].inkLayer.active, "far from the view: paths, no bitmap")
        paper.toPage(20)
        spin { self.paper.sheets[19].inkLayer.active }
        XCTAssertTrue(paper.sheets[19].inkLayer.active)
        XCTAssertFalse(paper.sheets[0].inkLayer.active)
    }

    /* ----------------------------------------------------------------------------------------- selections */

    func testALiveSelectionIsDrawnAsItsBands() throws {
        open()
        textRead()
        drag(linePoint(page: 1, line: 0, x: 80), linePoint(page: 1, line: 0, x: 200), release: false)
        XCTAssertFalse(paper.sheets[0].inkLayer.ink.live.isEmpty, "bands while it is dragged")
        paper.canvas.mouseUp(with: mouse(.leftMouseUp, linePoint(page: 1, line: 0, x: 200)))
        XCTAssertTrue(paper.sheets[0].inkLayer.ink.live.isEmpty)
        XCTAssertFalse(paper.sheets[0].inkLayer.ink.pending.isEmpty)
    }

    func testAPendingSelectionFollowsAZoomAndGoesWhenScrolledAway() throws {
        open(pages: 4)
        textRead()
        selectLine(0)
        let w0 = try XCTUnwrap(paper.pendingSel).parts[0].rects[0].w
        // 110% about the view's middle keeps the line in the pane (at 200% it would leave it, and go, as in Electron)
        paper.zoomTo(110)
        let p = try XCTUnwrap(paper.pendingSel)
        XCTAssertEqual(p.parts[0].u, paper.pageW)
        XCTAssertEqual(p.parts[0].rects[0].w, w0 * paper.pageW / 612, accuracy: 1e-6, "carried over")
        paper.toPage(4)
        paper.scrolled()
        XCTAssertNil(paper.pendingSel, "scrolled out of the pane: put away, nothing kept")
        XCTAssertNil(paper.selCardView)
        XCTAssertTrue(paper.marks[1].isEmpty)
    }

    func testTheSelectionCardLooksLikeAnEmptyNote() throws {
        open()
        textRead()
        selectLine(1)
        let card = (try XCTUnwrap(paper.selCardView))
        let ns = Canvas.noteScale(paper.pageW)
        XCTAssertEqual(card.cardWidth, CGFloat(min(Canvas.NOTE_W, paper.paneFit())))
        XCTAssertEqual(Double(card.frame.width), Double(card.cardWidth) * ns, accuracy: 0.5)
        XCTAssertEqual(card.layer?.backgroundColor, NSColor.white.cgColor)
        XCTAssertEqual(SelectionCardView.placeholder, "Write a note or ask @bart")
        // under the selection's last line, left in line with it, 8 below
        let geom = paper.selectionGeom((try XCTUnwrap(paper.pendingSel)).parts.map { ($0.page, $0.rects, $0.u) })!
        let inCanvas = paper.canvas.convert(card.frame, from: paper.paperArea)
        XCTAssertEqual(inCanvas.minX, geom.line.minX, accuracy: 1)
        XCTAssertEqual(inCanvas.minY, geom.line.maxY + 8, accuracy: 1)
        let px = pixels(card)
        XCTAssertGreaterThan(px.count { abs($0.r - 0xb5) < 30 && abs($0.g - 0xb5) < 30 && abs($0.b - 0xb5) < 30 }, 10, "the placeholder's #b5b5b5")
    }

    /* ----------------------------------------------------------------------------------------- cards */

    func testOneCardANoteItsAnswersAndItsRunWithRoomBetweenAndNothingOfTheCardToSee() throws {
        let asks = [AskEntry(id: "a1", question: "why?", answer: "Because.", at: Time.iso()), AskEntry(id: "a2", question: "and then?", answer: "Then.", at: Time.iso())]
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "@bart and then?", asks: asks)]]))
        paper.pendingAsks = [PendingAsk(askId: "h1", markId: "m1", page: 1, question: "and then?", activity: "Reading tutortrace.pdf")]
        let card = (try XCTUnwrap(paper.cardView("m1")))
        XCTAssertNil(card.ground, "no fill")
        XCTAssertEqual(card.layer?.borderWidth ?? 0, 0, "no edge")
        XCTAssertEqual(card.askViews.map(\.id), ["a1", "a2"])
        XCTAssertEqual(card.runViews.map(\.id), ["h1"])
        let note = card.note!
        XCTAssertEqual(card.askViews[0].view.frame.minY, note.frame.maxY + 4 + 10, accuracy: 0.5, "10px of room under the note")
        XCTAssertEqual(card.askViews[1].view.frame.minY, card.askViews[0].view.frame.maxY + 10, accuracy: 0.5)
        XCTAssertEqual(card.runViews[0].view.frame.minY, card.askViews[1].view.frame.maxY + 10, accuracy: 0.5)
        XCTAssertNotNil(card.askViews[0].view.question, "an earlier question of the thread is shown")
        XCTAssertNil(card.askViews[1].view.question, "the note asks it now")
        XCTAssertTrue(card.runViews[0].view.question.isHidden)
        XCTAssertEqual(card.runViews[0].view.label.stringValue, "Bart · Reading tutortrace.pdf")
        XCTAssertTrue(card.typing, "holding answers it keeps its whole width")
        // laid out in note px, drawn at the page's note scale
        let ns = (try XCTUnwrap(paper.places["m1"])).ns
        XCTAssertEqual(Double(card.frame.width), Double(card.size.width) * ns, accuracy: 0.01)
        XCTAssertEqual(card.bounds.width, card.size.width, accuracy: 1e-6); XCTAssertEqual(card.bounds.height, card.size.height, accuracy: 1e-6)
    }

    func testTheNoteIsCaveatHandwriting() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "a margin note")]]))
        let f = (try XCTUnwrap(paper.noteField("m1")))
        let attrs = f.textStorage!.attributes(at: 0, effectiveRange: nil)
        let font = attrs[.font] as! NSFont
        XCTAssertEqual(font.pointSize, 24)
        XCTAssertTrue(font.fontName.hasPrefix("Caveat"), font.fontName)
        XCTAssertEqual(attrs[.kern] as? Double, 0.2)
        XCTAssertEqual((attrs[.foregroundColor] as? NSColor)?.usingColorSpace(.sRGB), NSColor(hex: "#1f2633").usingColorSpace(.sRGB))
        XCTAssertEqual((attrs[.paragraphStyle] as? NSParagraphStyle)?.minimumLineHeight, 28.8)
        XCTAssertEqual(f.textContainerInset.width, 6)
        XCTAssertTrue((try XCTUnwrap(paper.cardView("m1"))).typing, "with nowhere for a mention to go a note is its field, its whole width")
    }

    func testANoteNotTypedInIsAsWideAsItsTextAndOneTypedInKeepsItsWidth() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "hi")]]), before: { $0.opensMentions = true })
        let card = (try XCTUnwrap(paper.cardView("m1")))
        XCTAssertTrue(card.note!.shown)
        let narrow = card.size.width
        XCTAssertLessThan(narrow, CGFloat(Canvas.NOTE_MIN), "max-content")
        paper.editNote("m1", at: nil)
        XCTAssertGreaterThan((try XCTUnwrap(paper.cardView("m1"))).size.width, narrow, "typed in: its whole width")
    }

    func testTypingGrowsTheNoteDown() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "x")]]))
        paper.editNote("m1", at: nil)
        let f = (try XCTUnwrap(paper.noteField("m1"))), card = (try XCTUnwrap(paper.cardView("m1")))
        let h0 = card.size.height
        f.insertText(" a longer note that has to wrap over several lines in the margin of the page", replacementRange: f.selectedRange())
        XCTAssertGreaterThan(card.size.height, h0 + 20)
        paper.flushSave()
        XCTAssertTrue(host.saved.last!.1.contains("a longer note"))
    }

    func testCardsAreReplacedNotRedrawnOnAZoomAndLieAboveEverySheet() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "x")]]))
        let card = (try XCTUnwrap(paper.cardView("m1")))
        paper.zoomTo(50); paper.zoomTo(150)
        XCTAssertTrue(paper.cardView("m1") === card, "the very same card")
        XCTAssertTrue(paper.canvas.subviews.last === paper.canvas.cardsLayer, "cards above every page's drawing")
    }

    func testAFreeNoteWithoutAWidthIsMeasuredAgainstTheTextBesideIt() throws {
        let free = Mark(id: "f", rects: [], side: nil, y: 0.5, note: "free", text: "", pos: PPoint(x: 0.05, y: (100 - 4 + 11) / 612.0))
        open(marks: PaperMarks(pages: [1: [free]]))
        textRead()
        let w = paper.cardWidth(free, 1)
        XCTAssertEqual(w, Canvas.FREE_MIN, "the printed line starts 72 pt in: room for no more than the least")
        XCTAssertEqual(paper.cardWidth(highlight("h"), 1), Canvas.NOTE_W)
    }

    func testHoverPaintsTheMarkAndShowsTheMoveHandle() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "x")]]))
        let card = (try XCTUnwrap(paper.cardView("m1")))
        paper.cardHover(card, inside: true)
        XCTAssertFalse(paper.sheets[0].inkLayer.ink.focus.isEmpty)
        XCTAssertFalse(paper.handle.isHidden)
        XCTAssertEqual(paper.handle.frame, NSRect(x: card.frame.maxX - 15, y: card.frame.maxY, width: 15, height: 15))
        let px = pixels(paper.handle)
        XCTAssertTrue(px.has("#8f8f8f", 30), "the four arrows, grey")
        paper.cardHover(card, inside: false)
        XCTAssertTrue(paper.sheets[0].inkLayer.ink.focus.isEmpty)
        XCTAssertTrue(paper.handle.isHidden)
    }

    func testAClickOnAShownNotePutsTheCaretWhereItWasPressed() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "hello there")]]), before: { $0.opensMentions = true })
        let f = (try XCTUnwrap(paper.noteField("m1")))
        XCTAssertTrue(f.shown)
        let p = f.convert(NSPoint(x: f.bounds.maxX - 2, y: f.bounds.midY), to: nil)
        window.postEvent(mouse(.leftMouseUp, window: p), atStart: false)
        f.mouseDown(with: mouse(.leftMouseDown, window: p))
        XCTAssertEqual(paper.editing, "m1")
        XCTAssertTrue(window.firstResponder === paper.noteField("m1"))
        XCTAssertFalse((try XCTUnwrap(paper.noteField("m1"))).shown)
    }

    func testAPressMovedOnANoteDragsItsCard() throws {
        let free = Mark(id: "f", rects: [], side: nil, y: 0.5, note: "typed", text: "", pos: PPoint(x: 0.3, y: 0.5), w: 150)
        open(marks: PaperMarks(pages: [1: [free]]), before: { $0.opensMentions = true })
        let f = (try XCTUnwrap(paper.noteField("f")))
        let start = f.convert(NSPoint(x: 10, y: 10), to: nil)
        let left0 = (try XCTUnwrap(paper.places["f"])).left
        // window coordinates are y-up
        window.postEvent(mouse(.leftMouseDragged, window: NSPoint(x: start.x - 30, y: start.y - 20)), atStart: false)
        window.postEvent(mouse(.leftMouseDragged, window: NSPoint(x: start.x - 60, y: start.y - 40)), atStart: false)
        window.postEvent(mouse(.leftMouseUp, window: NSPoint(x: start.x - 60, y: start.y - 40)), atStart: false)
        f.mouseDown(with: mouse(.leftMouseDown, window: start))
        let m = paper.marks[1][0]
        XCTAssertEqual(m.pos!.x * paper.pageW, left0 - 60, accuracy: 1.5)
        XCTAssertEqual(paper.focusId, "f", "its mark in focus")
        XCTAssertEqual(m.w, 150)
    }

    func testRevealBringsACardIntoThePane() throws {
        let free = Mark(id: "f", rects: [], side: nil, y: 0.9, note: "far", text: "", pos: PPoint(x: 0.3, y: 1.2), w: 150)
        open(pages: 3, marks: PaperMarks(pages: [2: [free]]))
        paper.toPage(1)
        spin { self.paper.cardView("f") != nil }
        paper.revealCard("f")
        XCTAssertTrue(paper.clip.bounds.intersects((try XCTUnwrap(paper.cardView("f"))).frame))
    }

    /* ----------------------------------------------------------------------------------------- chips, label, menu */

    func testChipsShowNamesNowAndGoneOnesGrey() throws {
        let note = "see @[Old](lib:a1) and @[Gone](lib:b2) and @[x.pdf](lib:f9:dir/x.pdf)"
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: note)]]), before: { h in
            h.opensMentions = true
            h.names = ["a1": "New name", "b2": String?.none, "f9": "Folder"]
        })
        let f = (try XCTUnwrap(paper.noteField("m1")))
        XCTAssertTrue(f.shown)
        let s = f.textStorage!.string
        XCTAssertTrue(s.contains("@New name"), s)
        XCTAssertTrue(s.contains("@Gone"))
        let goneAt = (s as NSString).range(of: "@Gone").location
        XCTAssertNil(f.textStorage!.attribute(.link, at: goneAt, effectiveRange: nil), "nothing to click")
        XCTAssertEqual((f.textStorage!.attribute(.foregroundColor, at: goneAt, effectiveRange: nil) as? NSColor)?.usingColorSpace(.sRGB), NSColor(hex: "#8f8f8f").usingColorSpace(.sRGB))
        let newAt = (s as NSString).range(of: "@New name").location
        XCTAssertEqual((f.textStorage!.attribute(.foregroundColor, at: newAt, effectiveRange: nil) as? NSColor)?.usingColorSpace(.sRGB), NSColor(hex: "#0070f3").usingColorSpace(.sRGB))
        XCTAssertNotNil(f.textStorage!.attribute(.underlineStyle, at: newAt, effectiveRange: nil))
        let fileAt = (s as NSString).range(of: "@x.pdf").location
        XCTAssertEqual(f.textStorage!.attribute(.toolTip, at: fileAt, effectiveRange: nil) as? String, "Folder / dir/x.pdf")
        // a click on a chip opens it
        paper.openLink(PaperLink.target(f.textStorage!.attribute(.link, at: newAt, effectiveRange: nil)!)!)
        XCTAssertEqual(host.openedMentions, ["a1"])
        paper.openLink(PaperLink.target(f.textStorage!.attribute(.link, at: fileAt, effectiveRange: nil)!)!)
        XCTAssertEqual(host.openedFiles, ["f9/dir/x.pdf"])
        // the shown pieces map a click back to the note's text: a chip whole
        XCTAssertEqual(f.rawOffset(newAt + 2), (note as NSString).range(of: "@[Old](lib:a1)").location + ("@[Old](lib:a1)" as NSString).length)
        // renamed again: drawn again
        host.names["a1"] = "Renamed"
        paper.libraryChanged()
        XCTAssertTrue((try XCTUnwrap(paper.noteField("m1"))).textStorage!.string.contains("@Renamed"))
    }

    func testWithoutAMentionHandlerANoteIsAlwaysItsField() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "see @[Old](lib:a1)")]]))
        XCTAssertFalse((try XCTUnwrap(paper.noteField("m1"))).shown)
        XCTAssertEqual((try XCTUnwrap(paper.noteField("m1"))).string, "see @[Old](lib:a1)", "the token as typed")
    }

    func testALeadingAtBartIsTheBlueLabel() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "@bart why?")]]))
        let f = (try XCTUnwrap(paper.noteField("m1")))
        XCTAssertEqual(f.agentRange, NSRange(location: 0, length: 5))
        XCTAssertEqual(f.textStorage!.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, NSColor.clear, "the token's own text transparent")
        host.canAsk = false
        paper.renderMarks(1)
        XCTAssertNil((try XCTUnwrap(paper.noteField("m1"))).agentRange, "a note that cannot ask has no label")
    }

    func testAWrittenNoteShowsAsTextATurnAfterItIsLeft() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "x")]]), before: { $0.opensMentions = true })
        paper.editNote("m1", at: nil)
        XCTAssertFalse((try XCTUnwrap(paper.noteField("m1"))).shown)
        window.makeFirstResponder(paper.canvas)
        spin(0.05)
        XCTAssertTrue((try XCTUnwrap(paper.noteField("m1"))).shown)
    }

    func testTheAtMenuOffersLibraryItemsAndBartAtTheStartOfAHighlightsNote() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "")]]), before: { h in
            h.mentions = [.item(id: "r1", name: "TutorTrace", type: "pdf"), .item(id: "z1", name: "Zotero item", zotero: true), .bart, .item(id: "r2", name: "Notes", type: "note")]
        })
        paper.editNote("m1", at: nil)
        let f = (try XCTUnwrap(paper.noteField("m1")))
        f.insertText("@", replacementRange: f.selectedRange())
        XCTAssertNotNil(paper.mention)
        XCTAssertFalse(paper.menuView.isHidden)
        XCTAssertEqual(paper.menuView.rows.map(\.key), ["item:r1", "verb:bart", "item:r2"], "no Zotero row; Bart at the note's start")
        XCTAssertEqual(host.menuOpen, [true])
        // its look (MentionMenu.jsx): 400 wide, padding 4, rows 32, radius 8, 1px #eaeaea, no shadow
        XCTAssertEqual(paper.menuView.frame.width, 400)
        XCTAssertEqual(paper.menuView.frame.height, 3 * 32 + 8)
        XCTAssertEqual(paper.menuView.layer?.cornerRadius, 8)
        XCTAssertEqual(paper.menuView.layer?.borderColor, NSColor(hex: "#eaeaea").cgColor)
        XCTAssertEqual(paper.menuView.layer?.shadowOpacity ?? 0, 0)
        let px = pixels(paper.menuView)
        XCTAssertTrue(px.has("#f2f2f2", 3), "the keyboard's row")
        XCTAssertTrue(px.has("#4d4d4d", 40), "the glyphs")
        // ↓ moves, Enter picks: the token and a space, saved, the keyboard kept
        XCTAssertTrue(paper.noteKey(f.card!, f, key("", 125)))
        XCTAssertEqual(paper.mentionIdx, 1)
        XCTAssertTrue(paper.noteKey(f.card!, f, key("", 126)))
        XCTAssertTrue(paper.noteKey(f.card!, f, key("\r", 36)))
        XCTAssertEqual(f.string, "@[TutorTrace](lib:r1) ")
        XCTAssertNil(paper.mention)
        XCTAssertTrue(paper.menuView.isHidden)
        XCTAssertEqual(paper.marks[1][0].note, "@[TutorTrace](lib:r1) ")
        // later in the note Bart is not offered; Escape closes the menu alone
        f.insertText("@N", replacementRange: f.selectedRange())
        XCTAssertEqual(paper.menuView.rows.map(\.key), ["item:r2"])
        XCTAssertTrue(paper.noteKey(f.card!, f, key("\u{1b}", 53)))
        XCTAssertNil(paper.mention)
        XCTAssertTrue(window.firstResponder === f, "the note keeps the keyboard")
    }

    func testBartPickedWritesAtBart() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "")]]), before: { $0.mentions = [.bart] })
        paper.editNote("m1", at: nil)
        let f = (try XCTUnwrap(paper.noteField("m1")))
        f.insertText("@ba", replacementRange: f.selectedRange())
        paper.pickMention(.bart)
        XCTAssertEqual(f.string, "@Bart ")
    }

    func testALibraryFolderOpensInTheMenu() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "")]]), before: { h in
            h.mentions = [.item(id: "fold", name: "Papers", browsable: true)]
            h.folders = ["fold:": FolderListing(entries: [.init(name: "sub", rel: "sub", dir: true), .init(name: "a.pdf", rel: "a.pdf", type: "pdf")], total: 2),
                         "fold:sub": FolderListing(entries: [.init(name: "b.pdf", rel: "sub/b.pdf", type: "pdf")], total: 1)]
        })
        paper.editNote("m1", at: nil)
        let f = (try XCTUnwrap(paper.noteField("m1")))
        f.insertText("@Pap", replacementRange: f.selectedRange())
        paper.pickMention(paper.menuView.rows[0])
        XCTAssertEqual(f.string, "@", "what was typed to find it taken out")
        XCTAssertEqual(paper.menuView.rows.map(\.kind), [.back, .note], "opening…")
        spin { self.paper.menuView.rows.contains { $0.kind == .entry } }
        XCTAssertEqual(paper.menuView.rows.map(\.name), ["All", "Mention this folder", "sub", "a.pdf"])
        XCTAssertEqual(paper.mentionIdx, 2, "the first entry ready")
        paper.pickMention(paper.menuView.rows[2])
        spin { self.paper.menuView.rows.contains { $0.name == "b.pdf" } }
        XCTAssertEqual(host.listed, ["fold:", "fold:sub"])
        // Backspace right after the @ goes up a level
        XCTAssertTrue(paper.noteKey(f.card!, f, key("\u{7f}", 51)))
        spin { self.paper.menuView.rows.contains { $0.name == "a.pdf" } }
        paper.pickMention(paper.menuView.rows.first { $0.name == "a.pdf" }!)
        XCTAssertEqual(f.string, "@[a.pdf](lib:fold:a.pdf) ")
    }

    /* ----------------------------------------------------------------------------------------- running asks, answers */

    func testARunningAskIsFilledInPlaceAndFailsWithItsReason() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "@bart why?")]]))
        paper.pendingAsks = [PendingAsk(askId: "k1", markId: "m1", page: 1, question: "why?", activity: "Reading", log: ["Reading"])]
        let run = (try XCTUnwrap(paper.cardView("m1"))).runViews[0].view
        XCTAssertEqual(run.label.stringValue, "Bart · Reading")
        XCTAssertFalse(run.stop.isHidden)
        XCTAssertEqual(run.steps.title, "▸ 1 step")
        paper.pendingAsks = [PendingAsk(askId: "k1", markId: "m1", page: 1, question: "why?", activity: "Writing", lines: ["So far"], log: ["Reading", "Writing"])]
        XCTAssertTrue((try XCTUnwrap(paper.cardView("m1"))).runViews[0].view === run, "the same box: Stop is the same button")
        XCTAssertEqual(run.steps.title, "▸ 2 steps")
        XCTAssertFalse(run.bodyScroll.isHidden, "the answer as it comes")
        paper.runAction((try XCTUnwrap(paper.cardView("m1"))), askId: "k1", action: "log")
        XCTAssertEqual(run.steps.title, "▾ 2 steps")
        XCTAssertFalse(run.log.isHidden)
        paper.runAction((try XCTUnwrap(paper.cardView("m1"))), askId: "k1", action: "stop")
        XCTAssertEqual(host.stopped, ["k1"])
        paper.pendingAsks = [PendingAsk(askId: "k1", markId: "m1", page: 1, question: "why?", error: "")]
        XCTAssertTrue(run.stop.isHidden)
        XCTAssertFalse(run.failedLabel.isHidden)
        XCTAssertEqual(run.failedLabel.stringValue, "Bart · No answer")
        XCTAssertEqual(run.error.stringValue, "The run failed.")
        XCTAssertEqual(run.error.textColor, NSColor(hex: "#c4372d"))
        paper.runAction((try XCTUnwrap(paper.cardView("m1"))), askId: "k1", action: "dismiss")
        XCTAssertEqual(host.dismissed, ["k1"])
        paper.pendingAsks = []
        XCTAssertTrue((try XCTUnwrap(paper.cardView("m1"))).runViews.isEmpty)
    }

    func testAnAnswersButtonsCopyContinueDeleteCollapse() throws {
        let a = AskEntry(id: "a1", question: "why?", answer: "Because **so**. See [the site](https://x.org/p).", meta: ["foot": "Sonnet · high · 2 s"], at: Time.iso())
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "@bart why?", asks: [a])]]))
        let sec = (try XCTUnwrap(paper.cardView("m1"))).askViews[0].view
        XCTAssertEqual(sec.buttons.map(\.title), ["Continue in project", "Copy", "Delete", "Collapse"])
        XCTAssertEqual(sec.buttons[0].font.pointSize, 13)
        XCTAssertEqual(sec.buttons[0].color, NSColor(hex: "#8f8f8f"))
        paper.askAction((try XCTUnwrap(paper.cardView("m1"))), askId: "a1", action: "copy", button: sec.buttons[1])
        XCTAssertEqual(host.copied.last, a.answer)
        XCTAssertEqual(sec.buttons[1].title, "Copied")
        paper.askAction((try XCTUnwrap(paper.cardView("m1"))), askId: "a1", action: "continue", button: sec.buttons[0])
        XCTAssertEqual(host.continued.first?.foot, "Sonnet · high · 2 s")
        XCTAssertEqual(host.continued.first?.quote, "The quick brown")
        XCTAssertEqual(sec.buttons[0].title, "Added")
        spin(1.6)
        XCTAssertEqual(sec.buttons[1].title, "Copy", "back after 1.4 s")
        // the answer: bold drawn, the link a link that goes to the host
        let body = sec.body!
        let s = body.textStorage!.string
        XCTAssertEqual(s, "Because so. See the site.")
        let at = (s as NSString).range(of: "the site").location
        body.clicked(onLink: body.textStorage!.attribute(.link, at: at, effectiveRange: nil)!, at: at)
        XCTAssertEqual(host.links, ["https://x.org/p"])
        // collapse, then "Bart ›" expands
        paper.askAction((try XCTUnwrap(paper.cardView("m1"))), askId: "a1", action: "collapse", button: sec.buttons[3])
        let collapsed = (try XCTUnwrap(paper.cardView("m1"))).askViews[0].view
        XCTAssertEqual(collapsed.buttons.map(\.title), ["Bart ›"])
        XCTAssertEqual(collapsed.buttons[0].toolTip, "why?")
        XCTAssertEqual(paper.marks[1][0].asks?[0].collapsed, true)
        paper.askAction((try XCTUnwrap(paper.cardView("m1"))), askId: "a1", action: "expand", button: collapsed.buttons[0])
        XCTAssertEqual(paper.marks[1][0].asks?[0].collapsed, false)
    }

    func testCitationsAreNumberedFoldedAndCarryTheirCard() throws {
        let c1 = "[Me · notes](/Users/x/notes.md#find=kappa%20was%20good&cite=you)"
        let c2 = "[Paper](https://x.org/a.pdf#find=the%20result&cite=source)"
        let c3 = "[Other](https://y.org/b#find=against&cite=other&counter=1)"
        let answer = "It holds \(c1) \(c2) \(c3)\nAgain \(c1)"
        let a = AskEntry(id: "a1", question: "why?", answer: answer, at: Time.iso())
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "@bart why?", asks: [a])]]))
        let body = (try XCTUnwrap(paper.cardView("m1"))).askViews[0].view.body ?? AnswerText()
        func circles() -> Int { var n = 0; body.textStorage!.enumerateAttribute(.attachment, in: NSRange(location: 0, length: body.textStorage!.length)) { v, _, _ in if v != nil { n += 1 } }; return n }
        // folded: 1 and "…" in the first line, 1 again in the second, then Sources: rows with 1, 2, 3
        let folded = circles()
        XCTAssertEqual(folded, 2 + 1 + 3)
        XCTAssertTrue(body.textStorage!.string.contains("Sources"))
        var cards: [Any] = []
        body.textStorage!.enumerateAttribute(.citeCard, in: NSRange(location: 0, length: body.textStorage!.length)) { v, _, _ in if let v { cards.append(v) } }
        let first = cards.first as? CiteCardInfo
        XCTAssertEqual(first?.card.quote, "kappa was good")
        XCTAssertEqual(first?.card.where_, "notes.md")
        body.expand()
        XCTAssertEqual(circles(), 3 + 1 + 3, "every circle of the run once it is opened")
        // the hover card
        var at = 0
        body.textStorage!.enumerateAttribute(.citeCard, in: NSRange(location: 0, length: body.textStorage!.length)) { v, r, stop in if v != nil { at = r.location; stop.pointee = true } }
        body.showTip((first?.card)!, at: at)
        let tip = body.shownTip!
        XCTAssertEqual(tip.frame.width, 280)
        XCTAssertEqual(tip.layer?.cornerRadius, 10)
        XCTAssertEqual(tip.layer?.borderColor, NSColor(hex: "#e3e3e3").cgColor)
        XCTAssertEqual(tip.quoteText?.string, "“kappa was good”")
        XCTAssertTrue(tip.footText.string.contains("notes.md"))
        body.leaveCircle()
        spin(0.3)
        XCTAssertNil(body.shownTip, "gone CARD_GRACE after the pointer left")
    }

    func testAToastUndoBringsTheMarkBackAndTheToastGoesByItself() throws {
        open(marks: PaperMarks(pages: [1: [highlight("h1", note: "n")]]))
        paper.removeMark(1, paper.marks[1][0])
        XCTAssertFalse(paper.toast.isHidden)
        let f = paper.toast.frame
        XCTAssertEqual(f.minY, 60); XCTAssertEqual(f.height, 30)
        XCTAssertEqual(f.midX, paper.paperArea.bounds.midX, accuracy: 0.5)
        XCTAssertEqual(paper.toast.layer?.backgroundColor, NSColor(hex: "#171717").cgColor)
        XCTAssertEqual(paper.toast.layer?.cornerRadius, 8)
        paper.toast.onUndo?()
        XCTAssertEqual(paper.marks[1].map(\.id), ["h1"])
        XCTAssertTrue(paper.toast.isHidden)
        paper.removeMark(1, paper.marks[1][0])
        XCTAssertEqual(paper.toast.text, "Highlight removed")
        paper.removedTimer?.fire()
        XCTAssertTrue(paper.toast.isHidden, "after about 5 s")
        XCTAssertTrue(paper.undo(), "⌘Z still brings it back")
    }

    func testAFreeNoteRemovedSaysNoteRemoved() throws {
        let free = Mark(id: "f", rects: [], side: nil, y: 0.5, note: "typed", text: "", pos: PPoint(x: 0.3, y: 0.5), w: 150)
        open(marks: PaperMarks(pages: [1: [free]]))
        paper.removeMark(1, free)
        XCTAssertEqual(paper.toast.text, "Note removed")
    }

    /* ----------------------------------------------------------------------------------------- find, keys, two papers */

    func testFindTintsTheMatchesAndTheActiveOne() throws {
        open(pages: 2)
        spin { self.paper.texts.count == 2 }
        let r = paper.find("lorem")
        XCTAssertEqual(r.matches, 4)
        let t = paper.sheets[0].tintLayer.tints
        XCTAssertEqual(t.active.count, 1)
        XCTAssertGreaterThanOrEqual(t.matches.count, 1)
        let px = pixels(paper.sheets[0].tintLayer)
        XCTAssertGreaterThan(px.count { $0.r > 200 && $0.b < 140 }, 20, "the active match orange over white")
        paper.stopFind()
        XCTAssertTrue(paper.sheets[0].tintLayer.tints.active.isEmpty)
    }

    func testSpaceScrollsAndIsNeverThePapers() throws {
        open(pages: 3)
        window.makeFirstResponder(paper.canvas)
        let y0 = paper.scrollTop
        paper.canvas.keyDown(with: key(" ", 49))
        XCTAssertGreaterThan(paper.scrollTop, y0)
        XCTAssertTrue(paper.marks[1].isEmpty)
    }

    func testANotesKeysNeverReachThePaper() throws {
        open(marks: PaperMarks(pages: [1: [highlight("m1", note: "x")]]))
        paper.editNote("m1", at: nil)
        let f = (try XCTUnwrap(paper.noteField("m1")))
        XCTAssertFalse(paper.noteKey(f.card!, f, key("\u{7f}", 51)), "Backspace is the field's")
        XCTAssertEqual(paper.marks[1].count, 1)
        XCTAssertTrue(paper.noteKey(f.card!, f, key("\u{1b}", 53)), "Escape leaves the note")
        XCTAssertTrue(window.firstResponder === paper.canvas)
    }

    func testTwoPapersOnOnePdfKeepToThemselves() throws {
        open()
        let second = PaperViewController(), host2 = FakePaperHost()
        second.host = host2
        let holder = NSView(frame: window.contentView!.bounds)
        window.contentView = holder
        paper.view.frame = NSRect(x: 0, y: 0, width: 306, height: 700)
        second.view.frame = NSRect(x: 306, y: 0, width: 306, height: 700)
        holder.addSubview(paper.view); holder.addSubview(second.view)
        paper.view.layoutSubtreeIfNeeded(); second.view.layoutSubtreeIfNeeded()
        second.load(data: makePDF(pages: 2, lines: lines))
        spin { second.laidOut && self.paper.texts[1] != nil }
        selectLine(0)
        XCTAssertTrue(paper.canvasKeyDown(key("\r", 36)))
        XCTAssertEqual(paper.marks[1].count, 1)
        XCTAssertTrue(second.marks[1].isEmpty, "the other view's ink is its own")
        XCTAssertTrue(second.sheets[0].inkLayer.ink.zigzags.isEmpty)
        second.close()
    }
}
