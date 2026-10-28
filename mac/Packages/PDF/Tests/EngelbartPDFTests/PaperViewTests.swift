import AppKit
import CoreText
import XCTest
@testable import EngelbartPDF

// The paper in a real (offscreen) window over a pdf made here: the column, drawing, selections → highlights, typing
// anywhere, removing and ⌘Z, @bart, find, saving, and a 144-page paper that must not stall the app (eea4073). Ports the
// behaviour half of test/paper-blank-arrows, paper-remove-mark, paper-note-ask, paper-draw and paper-canvas-zoom.

/// A pdf of `pages` US-letter pages, each with `lines` lines of 14 pt Helvetica at x 72, from 100 pt down, 20 apart.
func makePDF(pages: Int, lines: [String]) -> Data {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
    let font = CTFontCreateWithName("Helvetica" as CFString, 14, nil)
    for p in 0..<pages {
        ctx.beginPDFPage(nil)
        for (i, text) in lines.enumerated() {
            let s = NSAttributedString(string: text.replacingOccurrences(of: "#", with: String(p + 1)), attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
            let line = CTLineCreateWithAttributedString(s)
            ctx.textPosition = CGPoint(x: 72, y: 792 - 100 - Double(i) * 20)
            CTLineDraw(line, ctx)
        }
        ctx.endPDFPage()
    }
    ctx.closePDF()
    return data as Data
}

final class FakePaperHost: PaperHost {
    var saved: [(PaperMarks, String)] = []
    var asked: [PaperAsk] = []
    var stopped: [String] = []
    var copied: [String] = []
    var views: [PaperViewState] = []
    var canAsk = true
    var mentions: [MentionRow]? = nil
    var dismissed: [String] = []
    var continued: [PaperContinue] = []
    var links: [String] = []
    var openedMentions: [String] = []
    var openedFiles: [String] = []
    var opensMentions = false
    var names: [String: String?] = [:]
    var folders: [String: FolderListing] = [:]
    var listed: [String] = []
    var menuOpen: [Bool] = []
    var targets: [(String, Int)] = []
    var found: [(Int, Int)] = []
    var readMarks: PaperMarks? = nil
    func paperMarksChanged(_ marks: PaperMarks, json: String) { saved.append((marks, json)) }
    func paperReadAnnotations() -> PaperMarks? { readMarks }
    var paperCanAsk: Bool { canAsk }
    func paperAsk(_ ask: PaperAsk) { asked.append(ask) }
    func paperStopAsk(_ askId: String) { stopped.append(askId) }
    func paperDismissAsk(_ askId: String) { dismissed.append(askId) }
    var paperCanContinue: Bool { true }
    func paperContinue(_ c: PaperContinue) { continued.append(c) }
    var paperCanCopy: Bool { true }
    func paperCopy(_ text: String) { copied.append(text) }
    func paperOpenLink(_ href: String) { links.append(href) }
    var paperOpensMentions: Bool { opensMentions }
    func paperOpenMention(_ id: String) { openedMentions.append(id) }
    func paperOpenFile(folderId: String, rel: String, name: String) { openedFiles.append("\(folderId)/\(rel)") }
    func paperLibraryName(_ id: String) -> String?? { names[id] }
    func paperView(_ state: PaperViewState) { views.append(state) }
    func paperMentionItems(_ query: String) -> [MentionRow]? { mentions.map { $0.filter { query.isEmpty || $0.name.lowercased().contains(query) } } }
    func paperListFolder(_ folderId: String, rel: String, done: @escaping (FolderListing) -> Void) -> Bool {
        listed.append("\(folderId):\(rel)")
        if let l = folders["\(folderId):\(rel)"] { DispatchQueue.main.async { done(l) } }
        return true
    }
    func paperMentionMenu(open: Bool) { menuOpen.append(open) }
    func paperTarget(_ text: String, matches: Int, active: Int) { targets.append((text, matches)) }
    func paperFound(matches: Int, active: Int) { found.append((matches, active)) }
}

@MainActor
final class PaperViewTests: XCTestCase {
    let lines = ["The quick brown fox jumps over the lazy dog on page #", "Cohen's kappa was 0.79 overall across the deployments", "A third line about construc-", "tion of the thing we study", "lorem ipsum dolor sit amet", "lorem again"]
    var window: NSWindow!
    var paper: PaperViewController!
    var host: FakePaperHost!

    func open(pages: Int = 2, marks: PaperMarks? = nil, width: CGFloat = 612, height: CGFloat = 700) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false); window.isReleasedWhenClosed = false
        paper = PaperViewController()
        host = FakePaperHost()
        paper.host = host
        window.contentView = paper.view
        paper.scrollView.scrollerStyle = .overlay
        paper.view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        paper.view.layoutSubtreeIfNeeded()
        paper.load(data: makePDF(pages: pages, lines: lines), marks: marks)
        spin { self.paper.laidOut }
    }

    func spin(_ seconds: Double = 3, until done: @escaping () -> Bool) {
        let end = Date().addingTimeInterval(seconds)
        while !done() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }
    func spin(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    func windowPoint(_ canvasPoint: NSPoint) -> NSPoint { paper.canvas.convert(canvasPoint, to: nil) }
    func mouse(_ type: NSEvent.EventType, _ p: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: windowPoint(p), modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }
    func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }
    func click(_ p: NSPoint) { paper.canvas.mouseDown(with: mouse(.leftMouseDown, p)); paper.canvas.mouseUp(with: mouse(.leftMouseUp, p)) }
    func drag(_ a: NSPoint, _ b: NSPoint) {
        paper.canvas.mouseDown(with: mouse(.leftMouseDown, a))
        paper.canvas.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)))
        paper.canvas.mouseDragged(with: mouse(.leftMouseDragged, b))
        paper.canvas.mouseUp(with: mouse(.leftMouseUp, b))
    }
    /// A point of page n's text line i (0-based) at fraction f across the line's words (page points → canvas).
    func linePoint(page n: Int, line i: Int, x pts: Double) -> NSPoint {
        let k = paper.pageW / 612
        return NSPoint(x: paper.G + pts * k, y: paper.tops[n - 1] + (100 + Double(i) * 20 - 4) * k)
    }

    override func tearDown() { paper?.close(); window?.close(); window = nil; paper = nil; host = nil }

    func testColumnAtEveryZoom() {
        open()
        XCTAssertEqual(paper.sheets.count, 2)
        XCTAssertEqual(paper.pageW, 612); XCTAssertEqual(paper.G, 0); XCTAssertEqual(paper.sheetW, 612)
        XCTAssertEqual(paper.tops, [0, 792])
        paper.zoomTo(50)
        XCTAssertEqual(paper.pageW, 306); XCTAssertEqual(paper.G, 153); XCTAssertEqual(paper.canvas.frame.width, 612)
        XCTAssertEqual(paper.scrollLeft, 0)
        paper.zoomTo(200)
        XCTAssertEqual(paper.pageW, 1224); XCTAssertEqual(paper.canvas.frame.width, 1224)
        XCTAssertEqual(paper.scrollLeft, 306, accuracy: 1, "the view on the page's middle")
        paper.zoomStepBy(-1)
        XCTAssertEqual(paper.pct(), 150)
        paper.togglePct()
        XCTAssertEqual(paper.pct(), 100)
        XCTAssertFalse(paper.bar.isHidden)
    }

    func testPagesDrawnNearTheViewAndTextRead() {
        open(pages: 3)
        spin { self.paper.sheets[0].image != nil && self.paper.sheets[0].thumb != nil && self.paper.texts.count == 3 }
        XCTAssertNotNil(paper.sheets[0].image)
        XCTAssertNotNil(paper.sheets[0].thumb, "a small drawing kept under it")
        XCTAssertTrue(paper.texts[1]!.string.contains("quick brown fox"))
        XCTAssertNotNil(paper.cols[1], "its column known from its lines")
    }

    func testSelectionPendingThenEnterKeepsABareHighlight() {
        open()
        spin { self.paper.texts[1] != nil }
        drag(linePoint(page: 1, line: 1, x: 80), linePoint(page: 1, line: 1, x: 200))
        XCTAssertNotNil(paper.pendingSel, "pending: tinted, nothing kept")
        XCTAssertTrue(paper.marks[1].isEmpty)
        XCTAssertNotNil(paper.selCardView, "the empty card under it")
        XCTAssertFalse(paper.selCardView!.isHidden)
        XCTAssertFalse(paper.sheets[0].inkLayer.ink.pending.isEmpty)
        let text = paper.pendingSel!.text
        XCTAssertTrue(text.hasPrefix("Cohen's"), "snapped out to whole words: \(text)")
        XCTAssertTrue(paper.canvas.keyDownHandled(key("\r", 36), owner: paper))
        XCTAssertEqual(paper.marks[1].count, 1)
        XCTAssertNil(paper.marks[1][0].note)
        XCTAssertFalse(paper.marks[1][0].rects.isEmpty)
        XCTAssertNil(paper.pendingSel)
        XCTAssertNil(paper.selCardView)
        XCTAssertFalse(paper.sheets[0].inkLayer.ink.zigzags.isEmpty, "drawn as rough zigzags")
        paper.flushSave()
        XCTAssertEqual(host.saved.last?.0[1].count, 1)
        XCTAssertTrue(host.saved.last!.1.hasPrefix("{\"1\":[{\"id\":\"m"), host.saved.last!.1)
    }

    func testTypingOnAPendingSelectionKeepsItWithANote() {
        open()
        spin { self.paper.texts[1] != nil }
        drag(linePoint(page: 1, line: 0, x: 80), linePoint(page: 1, line: 0, x: 180))
        XCTAssertTrue(paper.canvas.keyDownHandled(key("w", 13), owner: paper))
        XCTAssertEqual(paper.marks[1].count, 1)
        XCTAssertEqual(paper.marks[1][0].note, "w")
        let id = paper.marks[1][0].id
        XCTAssertEqual(paper.editing, id)
        XCTAssertEqual(paper.selCard, id, "drawn where the empty card was")
        let field = paper.noteField(id)
        XCTAssertNotNil(field)
        XCTAssertTrue(window.firstResponder === field, "the note has the keyboard at once")
        field!.insertText("hy", replacementRange: field!.selectedRange())
        XCTAssertEqual(paper.marks[1][0].note, "why")
        window.makeFirstResponder(paper.canvas)
        spin(0.05)
        XCTAssertNil(paper.selCard, "left: beside its highlight")
        XCTAssertNil(paper.editing)
    }

    func testEscapeDropsAPendingSelection() {
        open()
        spin { self.paper.texts[1] != nil }
        drag(linePoint(page: 1, line: 0, x: 80), linePoint(page: 1, line: 0, x: 180))
        XCTAssertTrue(paper.canvas.keyDownHandled(key("\u{1b}", 53), owner: paper))
        XCTAssertNil(paper.pendingSel)
        XCTAssertTrue(paper.marks[1].isEmpty)
    }

    func testAClickWritesANoteAndAnEmptyOneGoes() {
        open()
        spin { self.paper.texts[1] != nil }
        let blank = NSPoint(x: 300, y: 500)
        click(blank)
        XCTAssertEqual(paper.marks[1].count, 1, "a note where the click was")
        let m = paper.marks[1][0]
        XCTAssertTrue(m.rects.isEmpty)
        XCTAssertEqual(m.pos!.x, 300 / 612, accuracy: 1e-9)
        XCTAssertNotNil(m.w)
        XCTAssertTrue(window.firstResponder === paper.noteField(m.id))
        // a click that puts something away (the note being typed in) writes nothing; the empty note goes
        click(NSPoint(x: 300, y: 600))
        spin(0.05)
        XCTAssertTrue(paper.marks[1].isEmpty, "the empty note is gone")
        paper.flushSave()
        XCTAssertTrue(host.saved.allSatisfy { $0.0[1].isEmpty }, "and never saved")
        click(NSPoint(x: 300, y: 600))
        XCTAssertEqual(paper.marks[1].count, 1, "the next click writes")
    }

    func testAClickOnPrintedWordsWritesNothing() {
        open()
        spin { self.paper.texts[1] != nil }
        click(linePoint(page: 1, line: 0, x: 120))
        XCTAssertTrue(paper.marks[1].isEmpty)
    }

    func testDeleteRemovesAndUndoBringsBack() {
        let hl = Mark(id: "h1", rects: [PRect(72 / 612, (100 - 14) / 612, 200 / 612, 16 / 612)], side: "left", y: 86 / 612, note: "mine", text: "The quick")
        open(marks: PaperMarks(pages: [1: [hl]]))
        spin { self.paper.texts[1] != nil }
        click(linePoint(page: 1, line: 0, x: 150))
        XCTAssertEqual(paper.focusId, "h1", "a click on a highlight puts it in focus")
        XCTAssertTrue(paper.canvas.keyDownHandled(key("\u{7f}", 51), owner: paper))
        XCTAssertTrue(paper.marks[1].isEmpty)
        XCTAssertFalse(paper.toast.isHidden)
        XCTAssertEqual(paper.toast.text, "Highlight removed")
        XCTAssertTrue(paper.canvasKeyEquivalent(key("z", 6, .command)))
        XCTAssertEqual(paper.marks[1].map(\.id), ["h1"])
        XCTAssertEqual(paper.marks[1][0].note, "mine", "with its note")
        XCTAssertTrue(paper.toast.isHidden)
        XCTAssertFalse(paper.canvasKeyEquivalent(key("z", 6, .command)), "nothing left to bring back: the key is the app's")
    }

    func testRemovingStopsRunningAsks() {
        let hl = Mark(id: "h1", rects: [PRect(0.1, 0.15, 0.3, 0.02)], side: "left", y: 0.15, note: "@bart why?", text: "x")
        open(marks: PaperMarks(pages: [1: [hl]]))
        paper.pendingAsks = [PendingAsk(askId: "k1", markId: "h1", page: 1, question: "why?"), PendingAsk(askId: "k2", markId: "h1", page: 1, question: "why?", error: "failed")]
        paper.removeMark(1, hl)
        XCTAssertEqual(host.stopped, ["k1"], "a failed one is not stopped")
    }

    func testCopyCopiesThePendingSelectionOrTheFocusedPassage() {
        open()
        spin { self.paper.texts[1] != nil }
        drag(linePoint(page: 1, line: 0, x: 80), linePoint(page: 1, line: 0, x: 180))
        let text = paper.pendingSel!.text
        XCTAssertTrue(paper.canvasKeyEquivalent(key("c", 8, .command)))
        XCTAssertEqual(host.copied, [text])
    }

    func testAtBartAsksWithThePassageAndThePage() {
        let hl = Mark(id: "h1", rects: [PRect(72 / 612, 86 / 612, 300 / 612, 16 / 612)], side: "left", y: 86 / 612, note: "@bart why?", text: "The quick brown fox")
        open(marks: PaperMarks(pages: [1: [hl]]))
        spin { self.paper.texts[1] != nil }
        paper.editNote("h1", at: nil)
        let field = paper.noteField("h1")!
        XCTAssertTrue(window.firstResponder === field)
        XCTAssertTrue(paper.noteKey(field.card!, field, key("\r", 36)))
        spin { !self.host.asked.isEmpty }
        let ask = host.asked.first
        XCTAssertEqual(ask?.question, "why?")
        XCTAssertEqual(ask?.quote, "The quick brown fox")
        XCTAssertEqual(ask?.page, 1)
        XCTAssertTrue(ask?.pageText.contains("Cohen's kappa") ?? false, "the page around the passage")
        XCTAssertEqual(ask?.turns, [])
        XCTAssertFalse(window.firstResponder === field, "the note shows as text")
        // Shift+Enter is a new line; a note without @bart does not ask
        paper.editNote("h1", at: nil)
        XCTAssertFalse(paper.noteKey(field.card!, field, key("\r", 36, .shift)))
        host.canAsk = false
        XCTAssertFalse(paper.noteKey(field.card!, field, key("\r", 36)))
    }

    func testAddAskJoinsItsMarkOnce() {
        let hl = Mark(id: "h1", rects: [PRect(0.1, 0.15, 0.3, 0.02)], side: "left", y: 0.15, note: "@bart why?", text: "x")
        open(marks: PaperMarks(pages: [1: [hl]]))
        let entry = AskEntry(id: "k1", question: "why?", answer: "Because.", at: "2026-10-06T10:00:00.000Z")
        XCTAssertTrue(paper.addAsk(page: 1, markId: "h1", entry: entry))
        XCTAssertTrue(paper.addAsk(page: 1, markId: "h1", entry: entry))
        XCTAssertEqual(paper.marks[1][0].asks?.count, 1)
        XCTAssertFalse(paper.addAsk(page: 1, markId: "gone", entry: entry))
        // Delete hides it and ⌘Z brings it back
        let card = paper.cardView("h1")!
        paper.askAction(card, askId: "k1", action: "delete", button: TextButton("Delete", action: "delete"))
        XCTAssertEqual(paper.marks[1][0].asks?.first?.deleted, true)
        XCTAssertTrue(Canvas.shownAsks(paper.marks[1][0]).isEmpty)
        XCTAssertTrue(paper.undo())
        XCTAssertNil(paper.marks[1][0].asks?.first?.deleted)
    }

    func testFindCountsAndTheHyphenNewlineRule() {
        open(pages: 3)
        spin { self.paper.texts.count == 3 }
        let r = paper.find("lorem")
        XCTAssertEqual(r.matches, 6)
        XCTAssertEqual(r.active, 1)
        XCTAssertEqual(paper.find("lorem", step: 1).active, 2)
        XCTAssertEqual(paper.find("lorem", step: -1).active, 1)
        XCTAssertEqual(paper.find("lorem", step: -1).active, 6, "wraps")
        XCTAssertEqual(paper.find("construction").matches, 3, "a word broken at a line's end")
        XCTAssertEqual(paper.find("").matches, 0)
    }

    func testSectionShownFromATarget() {
        open(pages: 3)
        paper.setTarget("Cohen's kappa", to: "lorem ipsum", page: nil)
        spin { self.paper.section != nil }
        XCTAssertEqual(paper.section?.spot.page, 1)
    }

    func testViewToldOnClose() {
        open(pages: 3)
        paper.zoomTo(150)
        paper.close()
        XCTAssertEqual(host.views.last?.zoom, 1.5)
        paper = nil
    }

    func testA144PageScanDoesNotStallTheApp() {
        let longLines = (0..<34).map { "Line \($0) of page # with words enough to read and to find again here" }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 800), styleMask: [.titled], backing: .buffered, defer: false); window.isReleasedWhenClosed = false
        paper = PaperViewController(); host = FakePaperHost(); paper.host = host
        window.contentView = paper.view
        paper.view.layoutSubtreeIfNeeded()
        var marks = PaperMarks()
        for p in 1...144 { marks[p] = [Mark(id: "h\(p)", rects: [PRect(0.1, 0.2, 0.5, 0.015)], side: "right", y: 0.2, note: "note \(p)", text: "a")] }
        let data = makePDF(pages: 144, lines: longLines)
        let t0 = Date()
        paper.load(data: data, marks: marks)
        let loadTime = Date().timeIntervalSince(t0)
        XCTAssertLessThan(loadTime, 0.5, "opening lays out 144 sheets without building any page's text")
        var worst = 0.0, last = Date()
        let timer = Timer(timeInterval: 0.005, repeats: true) { _ in let now = Date(); worst = max(worst, now.timeIntervalSince(last)); last = now }
        RunLoop.main.add(timer, forMode: .common)
        // Each run-loop turn's busy time (woken → about to sleep, Core Animation's commit included), and the paper's
        // phases inside the long ones, so a stall names its culprit in the log.
        PaperTrace.on = true; PaperTrace.entries = []
        var turnStart = PaperTrace.now()
        var long: [String] = []
        let woke = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, 0) { _, _ in turnStart = PaperTrace.now() }
        let sleeps = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { _, _ in
            let now = PaperTrace.now(), ms = (now - turnStart) * 1000
            if ms > 40 {
                let inside = PaperTrace.entries.filter { $0.start >= turnStart - 0.0005 && $0.start <= now }
                let tops = ["pumpStep", "readText", "drawn", "scrolled", "layoutPaper"]
                let mine = inside.filter { e in tops.contains { e.name.hasPrefix($0) } }.map(\.ms).reduce(0, +)
                long.append(String(format: "turn %.1f ms (top-level paper phases %.1f ms, rest = Core Animation / AppKit %.1f ms): ", ms, mine, ms - mine)
                            + inside.sorted { $0.ms > $1.ms }.prefix(8).map { String(format: "%@ %.1f", $0.name, $0.ms) }.joined(separator: ", "))
            }
            turnStart = now
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), woke, .commonModes)
        CFRunLoopAddObserver(CFRunLoopGetMain(), sleeps, .commonModes)
        let end = Date().addingTimeInterval(3)
        while Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        timer.invalidate()
        CFRunLoopRemoveObserver(CFRunLoopGetMain(), woke, .commonModes)
        CFRunLoopRemoveObserver(CFRunLoopGetMain(), sleeps, .commonModes)
        PaperTrace.on = false
        let slowest = PaperTrace.entries.sorted { $0.ms > $1.ms }.prefix(10).map { String(format: "%@ %.1f ms", $0.name, $0.ms) }
        print("STALL PROBE worst gap \(String(format: "%.1f", worst * 1000)) ms\nSTALL PROBE long turns:\n" + long.joined(separator: "\n") + "\nSTALL PROBE slowest phases: " + slowest.joined(separator: ", "))
        XCTAssertLessThan(worst, 0.15, "the longest the main thread was held while 144 pages were read and drawn: \(worst)\n" + long.joined(separator: "\n"))
        XCTAssertGreaterThan(paper.texts.count, 10, "text read in the background meanwhile")
        // a pinch-like zoom out and back settles quickly
        let z0 = Date()
        paper.zoomTo(15); paper.zoomTo(100)
        XCTAssertLessThan(Date().timeIntervalSince(z0), 0.3)
    }
}

extension PaperCanvas {
    /// A key as the paper hears it (keyDown on the canvas): whether the paper took it.
    @MainActor func keyDownHandled(_ e: NSEvent, owner: PaperViewController) -> Bool { owner.canvasKeyDown(e) }
}
