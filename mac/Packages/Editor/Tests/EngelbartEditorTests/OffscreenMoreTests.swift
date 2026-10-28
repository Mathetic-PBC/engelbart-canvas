import XCTest
import AppKit
import EngelbartCore
import EngelbartDoc
@testable import EngelbartEditor

// The third pass's offscreen tests: the editor in a window never ordered front, driven by synthesized events (presses
// queued with window.postEvent before the mouseDown whose tracking loop reads them), a fake NSDraggingInfo for drops, and
// private pasteboards. Each test names the ledger rows it covers.

/// A drop as AppKit hands it to the text view.
final class FakeDrag: NSObject, NSDraggingInfo {
    let pb: NSPasteboard
    let at: NSPoint
    init(_ pb: NSPasteboard, at: NSPoint) { self.pb = pb; self.at = at }
    var draggingDestinationWindow: NSWindow? { nil }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { at }
    var draggedImageLocation: NSPoint { at }
    var draggedImage: NSImage? { nil }
    var draggingPasteboard: NSPasteboard { pb }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}

final class OffscreenMoreTests: EditorWindowCase {
    func picture(_ w: CGFloat, _ h: CGFloat, _ color: NSColor = .systemTeal) -> NSImage {
        NSImage(size: NSSize(width: w, height: h), flipped: false) { r in color.setFill(); r.fill(); return true }
    }
    func board() -> NSPasteboard { let pb = NSPasteboard(name: NSPasteboard.Name("engelbart-test-\(UUID().uuidString)")); pb.clearContents(); return pb }
    func png(_ w: Int = 4, _ h: Int = 4) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.representation(using: .png, properties: [:])!
    }
    /// A point of the text view in window coordinates.
    func win(_ p: NSPoint) -> NSPoint { editor.textView.convert(p, to: nil) }
    func post(_ type: NSEvent.EventType, _ windowPoint: NSPoint) {
        window.postEvent(NSEvent.mouseEvent(with: type, location: windowPoint, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
    }
    func down(_ windowPoint: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(with: .leftMouseDown, location: windowPoint, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }
    func keyEvent(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }
    func shown(_ i: Int) -> String { (editor.textView.string as NSString).substring(with: editor.rendered.maps[i].range) }

    // MARK: rows 6, 8, 14, 21, 78

    func testFlagsAreTokensOfTheirOwnAtWeight500() {
        let h = FakeHost(); h.models = QuestionModels.defaults
        open(["intro", "@chat why --opus --high", ""], host: h)
        let s = editor.textView.textStorage!, m = editor.rendered.maps[1]
        let text = shown(1) as NSString
        let flag = text.range(of: "--opus"), word = text.range(of: "why")
        XCTAssertNotEqual(flag.location, NSNotFound, "an unasked line shows its flags")
        let ff = s.attribute(.font, at: m.range.location + flag.location, effectiveRange: nil) as! NSFont
        let wf = s.attribute(.font, at: m.range.location + word.location, effectiveRange: nil) as! NSFont
        XCTAssertNotEqual(ff, wf, "a recognised flag is drawn bolder (500) than the words")
        XCTAssertEqual(NSFontManager.shared.weight(of: ff) > NSFontManager.shared.weight(of: wf), true)
        open(["intro", "@brainstorm why --opus", ""], host: h)
        let bs = shown(1) as NSString, f2 = bs.range(of: "--opus")
        let b2 = editor.textView.textStorage!.attribute(.font, at: editor.rendered.maps[1].range.location + f2.location, effectiveRange: nil) as! NSFont
        let w2 = editor.textView.textStorage!.attribute(.font, at: editor.rendered.maps[1].range.location, effectiveRange: nil) as! NSFont
        XCTAssertEqual(NSFontManager.shared.weight(of: b2), NSFontManager.shared.weight(of: w2), "@brainstorm reads no flags")
    }

    func testTypingAtTheEdgeOfAClosedMentionIsTheLinesOwnText() {
        open(["a @[Plan] b"])
        editor.placeCaret(line: 0, a: 9, b: 9)
        type("x")
        XCTAssertEqual(editor.core.lines[0], "a @[Plan]x b", "right after the mention: beside it, not inside")
        editor.placeCaret(line: 0, a: 2, b: 2)
        type("y")
        XCTAssertEqual(editor.core.lines[0], "a y@[Plan]x b", "right before it: beside it")
    }

    func testParagraphHeightAndAnswerCodeBox() {
        open(["one plain line", "two"])
        let r = editor.paragraphRect(0)!
        XCTAssertEqual(r.height, 35, accuracy: 1.5, "padding 4px 0 around a 27px line: 35")
        open(["intro", "@chat code?", "bart> Here:", "bart> ```swift", "bart> let a = 1", "bart> ```", "bart> *Chat · 1 s*", ""])
        editor.textView.display()
        let boxes = editor.layoutManager.codeBoxes
        XCTAssertEqual(boxes.count, 3, "the fence, the body and the closing fence each draw their part of the white box")
        let col = editor.textView.textContainer!.size.width
        for b in boxes { XCTAssertEqual(b.minX - editor.textView.textContainerOrigin.x, 32, accuracy: 0.5); XCTAssertEqual(editor.textView.textContainerOrigin.x + col - b.maxX, 16, accuracy: 0.5) }
        XCTAssertEqual(boxes[0].maxY, boxes[1].minY, accuracy: 1, "one box down the block")
        XCTAssertTrue(editor.rendered.decos.contains { $0.line == 3 && $0.deco == .copyCode }, "language + Copy on its head")
        XCTAssertEqual(shown(3), "swift")
        let mono = editor.textView.textStorage!.attribute(.font, at: editor.rendered.maps[4].range.location, effectiveRange: nil) as! NSFont
        XCTAssertTrue(mono.isFixedPitch)
    }

    func testAPressWithin4pxOfAnAnswersLinkOpensIt() {
        open(["intro", "@chat where?", "bart> Read the [docs page](https://ex.org/docs) first.", "bart> *Chat · 1 s*", ""])
        let s = shown(2) as NSString
        let at = s.range(of: "docs page").location
        let lm = editor.layoutManager, m = editor.rendered.maps[2]
        let g = lm.glyphRange(forCharacterRange: NSRange(location: m.range.location + at, length: 9), actualCharacterRange: nil)
        let r = lm.boundingRect(forGlyphRange: g, in: editor.textView.textContainer!)
        let o = editor.textView.textContainerOrigin
        click(NSPoint(x: r.maxX + 3 + o.x, y: r.midY + o.y))
        XCTAssertEqual(host.links.last?.0, "https://ex.org/docs", "3px past its end: a press on it")
        let before = host.links.count
        post(.leftMouseUp, win(NSPoint(x: r.maxX + 12 + o.x, y: r.midY + o.y)))
        click(NSPoint(x: r.maxX + 12 + o.x, y: r.midY + o.y))
        XCTAssertEqual(host.links.count, before, "12px away: not")
    }

    // MARK: rows 17, 72, 103: a picture's corners and its drag

    func testCornerResizeWritesTheWidth() {
        let h = FakeHost(); h.images["a"] = picture(240, 120)
        open(["intro", "![Attachment 1](img:a)", "after"], host: h)
        guard let handles = overlays(PictureHandles.self).first else { return XCTFail("the picture's handles") }
        let w0 = handles.frame.width
        let corner = handles.convert(NSPoint(x: handles.bounds.width - 4, y: handles.bounds.height - 4), to: nil)
        post(.leftMouseDragged, NSPoint(x: corner.x - 30, y: corner.y))
        post(.leftMouseDragged, NSPoint(x: corner.x - 80, y: corner.y))
        post(.leftMouseUp, NSPoint(x: corner.x - 80, y: corner.y))
        handles.mouseDown(with: down(corner))
        let w = EditorText.imgParts(Doc.parseLine(editor.core.lines[1]).text).width
        XCTAssertEqual(CGFloat(w), (w0 - 80).rounded(), accuracy: 1.5, "the se corner dragged 80pt left: that much narrower, written as |w=")
        XCTAssertTrue(editor.core.lines[1].contains("|w="))
        // The nw corner widens to the left as the pointer goes left.
        guard let again = overlays(PictureHandles.self).first else { return XCTFail() }
        let nw = again.convert(NSPoint(x: 4, y: 4), to: nil)
        post(.leftMouseDragged, NSPoint(x: nw.x - 20, y: nw.y))
        post(.leftMouseUp, NSPoint(x: nw.x - 20, y: nw.y))
        again.mouseDown(with: down(nw))
        XCTAssertEqual(CGFloat(EditorText.imgParts(Doc.parseLine(editor.core.lines[1]).text).width), (again.frame.width + 20).rounded(), accuracy: 1.5)
    }

    func testPictureDragMovesItsLineAndEscapeCancels() {
        let h = FakeHost(); h.images["a"] = picture(160, 80)
        open(["intro", "![Attachment 1](img:a)", "one", "two", "three", "end"], host: h)
        guard let handles = overlays(PictureHandles.self).first else { return XCTFail("the picture's handles") }
        let start = handles.convert(NSPoint(x: handles.bounds.midX, y: handles.bounds.midY), to: nil)
        let target = win(NSPoint(x: editor.paragraphRect(4)!.midX, y: editor.paragraphRect(4)!.maxY - 2))
        post(.leftMouseDragged, NSPoint(x: start.x + 2, y: start.y - 2))
        post(.leftMouseDragged, NSPoint(x: target.x, y: target.y))
        post(.leftMouseUp, target)
        handles.mouseDown(with: down(start))
        XCTAssertNotEqual(editor.core.lines[1], "![Attachment 1](img:a)", "the picture's line left its place")
        XCTAssertEqual(editor.core.lines.filter { $0 == "![Attachment 1](img:a)" }.count, 1, "moved, not copied")
        XCTAssertGreaterThan(editor.core.lines.firstIndex(of: "![Attachment 1](img:a)")!, 2, "let go lower down: lower down")
        XCTAssertTrue(window.contentView!.subviews.allSatisfy { !($0 is ImageViewer.ViewerView) }, "a drag opens no viewer")
        let was = editor.core.lines
        guard let h2 = overlays(PictureHandles.self).first else { return XCTFail() }
        let s2 = h2.convert(NSPoint(x: h2.bounds.midX, y: h2.bounds.midY), to: nil)
        post(.leftMouseDragged, NSPoint(x: s2.x, y: s2.y + 60))
        window.postEvent(keyEvent("\u{1B}", 53), atStart: false)
        post(.leftMouseUp, NSPoint(x: s2.x, y: s2.y + 60))
        h2.mouseDown(with: down(s2))
        XCTAssertEqual(editor.core.lines, was, "Escape: left where it was")
    }

    // MARK: rows 73, 96: the viewer

    func testViewerStepsThroughTheNotesPictures() {
        let h = FakeHost(); h.images = ["a": picture(300, 200), "b": picture(2000, 1500, .systemPink)]
        open(["intro", "![First](img:a)", "text ![Second|w=80](img:b) more", "end"], host: h)
        guard let handles = overlays(PictureHandles.self).first else { return XCTFail() }
        let at = handles.convert(NSPoint(x: handles.bounds.midX, y: handles.bounds.midY), to: nil)
        post(.leftMouseUp, at)
        handles.mouseDown(with: down(at))
        guard let v = window.contentView!.subviews.compactMap({ $0 as? ImageViewer.ViewerView }).last else { return XCTFail("a press that does not move opens the viewer") }
        XCTAssertEqual(v.pics.count, 2, "every picture of the note")
        XCTAssertEqual(v.at, 0)
        XCTAssertTrue(window.firstResponder === v)
        v.keyDown(with: keyEvent("", 124))
        XCTAssertEqual(v.at, 1, "→ the next")
        XCTAssertEqual(v.pic.alt, "Second")
        v.keyDown(with: keyEvent("", 124))
        XCTAssertEqual(v.at, 1, "none past the last")
        XCTAssertTrue(v.canZoom, "a picture larger than the window fits, and can zoom")
        v.toggleZoom()
        XCTAssertTrue(v.zoomed)
        XCTAssertEqual(v.pictureRect.width, 2000, "100%: one image pixel a point")
        v.keyDown(with: keyEvent("", 123))
        XCTAssertEqual(v.at, 0, "← back"); XCTAssertFalse(v.zoomed, "a step fits again")
        var copied: NSImage?
        v.copy = { copied = $0; return true }
        v.keyDown(with: keyEvent("c", 8, .command))
        XCTAssertTrue(copied === h.images["a"], "⌘C copies the one shown")
        XCTAssertTrue(v.copied, "the hint says Copied")
        v.close.performClick(nil)
        XCTAssertNil(v.superview)
        XCTAssertTrue(window.firstResponder === editor.textView, "closed: the keyboard is back in the note")
        let again = editor.openPicture("b")
        XCTAssertEqual(again?.at, 1, "an inline picture opens on itself")
        again?.keyDown(with: keyEvent("\u{1B}", 53))
        XCTAssertNil(again?.superview, "Escape closes it")
    }

    // MARK: rows 77, 94: a workspace's peek

    func testWorkspacePeekReadsOnceAndSaysWhereItStands() {
        let h = FakeHost()
        let iso = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-5 * 60 - 5))
        h.peeks["w1"] = WorkspacePeekInfo(name: "Other place", above: ["Root", "Mid"], bart: "waiting", editedAt: iso)
        h.peekTexts["w1"] = (1...12).map { "line \($0)" }.joined(separator: "\n") + "\n- [x] done row\n## Last head"
        open(["see @[Other](ws:w1) here", "and @[Gone](ws:w2) too"], host: h)
        editor.hover(at: point(line: 0, offset: 5))
        spin()
        guard let peek = editor.wsPeek else { return XCTFail("the peek") }
        XCTAssertEqual(peek.eyebrow, "PROJECT · ROOT / MID")
        XCTAssertEqual(peek.bartLine, "Bart answered — waiting for you")
        XCTAssertEqual(peek.footLine, "Edited 5 min ago · Click to go there")
        XCTAssertEqual(peek.frame.width, 360)
        let tail = peek.preview!.string.components(separatedBy: "\n")
        XCTAssertEqual(tail.count, 8, "the document's last 8 lines that show something")
        XCTAssertEqual(tail.last, "Last head")
        XCTAssertEqual(tail[tail.count - 2], "✓ done row")
        editor.hover(at: point(line: 0, offset: 6))
        XCTAssertEqual(h.peekReads, ["w1"], "read once a hover")
        editor.hover(at: point(line: 0, offset: 21))
        XCTAssertNil(editor.wsPeek, "off the mention: gone")
        editor.hover(at: point(line: 1, offset: 5))
        XCTAssertEqual(editor.wsPeek?.info, nil)
        XCTAssertEqual(h.peekReads, ["w1"], "a workspace that is gone is not read")
        XCTAssertEqual(agoText(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3 * 3600))), "3 h")
        XCTAssertEqual(agoText("nonsense"), "")
        click(point(line: 0, offset: 5))
        XCTAssertNil(editor.wsPeek, "a click goes there; the peek closes")
        XCTAssertEqual(h.opened.last, "beside:workspace:w1")
    }

    // MARK: row 84: a research box

    static let research = ["intro", "@discover what is x", "bart> I will look for x.", "bart> *Discover · 2 s*"]

    func testResearchHeadAndStatusInEveryState() {
        let h = FakeHost(); h.models = QuestionModels.defaults
        open(OffscreenMoreTests.research + ["@discover --research what is x", ""], host: h)
        guard let ready = editor.core.researchInfo(4) else { return XCTFail() }
        XCTAssertEqual(ready.state, "ready")
        XCTAssertEqual(ready.level, "Standard")
        XCTAssertTrue(ready.levelPicks)
        XCTAssertTrue(ready.status.hasPrefix("Not started · "), ready.status)
        XCTAssertEqual(ready.action, "Start research")
        XCTAssertEqual(ready.mark, "dot")
        guard let v = overlays(ResearchView.self).first else { return XCTFail("the box") }
        XCTAssertEqual((v.action as? BoxButton)?.words, "Start research", "Start research is the blue button")
        v.mouseDown(with: down(v.convert(NSPoint(x: v.levelRect.midX, y: v.levelRect.midY), to: nil)))
        XCTAssertNotNil(editor.picker, "the level opens the levels menu")
        XCTAssertTrue(editor.picker?.levels ?? false)
        press("\u{1B}", code: 53)
        let done = OffscreenMoreTests.research + ["@discover --research what is x --steer also y --deep", "bart> **[A](https://a.org/1)**", "bart> *Discover · Sol · medium · 125 s*", ""]
        open(done, host: h)
        guard let fin = editor.core.researchInfo(4) else { return XCTFail() }
        XCTAssertEqual(fin.state, "finished")
        XCTAssertEqual(fin.status, "Finished in 2 min · Sol medium", "how long it took, the model that answered")
        XCTAssertEqual(fin.steers, ["also y"], "what a reply added, its level flag out")
        XCTAssertEqual(fin.action, "Run again")
        XCTAssertEqual(fin.mark, "check")
        XCTAssertEqual(fin.fold, "Collapse")
        guard let fv = overlays(ResearchView.self).first else { return XCTFail() }
        XCTAssertTrue(fv.action is TextButton, "Run again is quiet")
        XCTAssertEqual(fv.frame.height, ResearchView.height(fin, width: fv.frame.width, first: false, closes: fv.closes), accuracy: 0.5)
        fv.fold?.performClick(nil)
        XCTAssertTrue(editor.core.findTurn(editor.core.lines, 4)?.turn.folded ?? false, "its Collapse folds it")
        XCTAssertEqual(editor.core.researchInfo(4)?.fold, "Expand")
        XCTAssertEqual(editor.core.researchInfo(4)?.status, "", "done and folded: no status row")
        open(OffscreenMoreTests.research + ["@discover --research what is x", "bart> **No answer.** the rate limit", "bart> *Discover · 3 s*", ""], host: h)
        XCTAssertEqual(editor.core.researchInfo(4)?.status, "Interrupted: the rate limit")
        XCTAssertEqual(editor.core.researchInfo(4)?.action, "Restart")
        XCTAssertEqual(editor.core.researchInfo(4)?.mark, "")
        open(OffscreenMoreTests.research + ["@discover --research what is x", "bart> found", "bart> *Discover · 9 s*", "@discover --research narrower x", ""], host: h)
        XCTAssertEqual(editor.core.researchInfo(7)?.asked, "narrower x", "a box that refines an earlier one says what it was asked")
    }

    func testDeepResearchWaitsFiveSecondsAndCancels() {
        let h = FakeHost()
        open(["intro", "@discover --research --deep x", "bart~> w1", ""], host: h)
        let req = AskRequest(askId: "w1", text: "x", turns: [], agent: "discover", placeLine: 1, placeText: "@discover --research --deep x")
        editor.core.waitResearch(req)
        XCTAssertEqual(editor.core.waits["w1"]?.left, 5)
        editor.redraw(keepSelection: true)
        XCTAssertEqual(overlays(PendingView.self).first?.doing, "Searching in 5 s")
        XCTAssertEqual(overlays(PendingView.self).first?.stop.title, "Cancel")
        spin(1.3)
        XCTAssertEqual(editor.core.waits["w1"]?.left, 4, "counting down")
        XCTAssertTrue(h.asks.isEmpty, "nothing asked yet")
        XCTAssertTrue(editor.core.cancelWait("w1"))
        XCTAssertNil(editor.core.waits["w1"])
        spin(1.2)
        XCTAssertTrue(h.asks.isEmpty, "cancelled: never asked")
    }

    func testPendingRowWordsAndStepsToggle() {
        XCTAssertEqual(PendingView.doingText(progress: AskProgress(name: "Sonnet", effort: "high"), waitLeft: nil), "Thinking · Sonnet high")
        XCTAssertEqual(PendingView.doingText(progress: AskProgress(movedUp: true), waitLeft: nil), "Thinking harder")
        XCTAssertEqual(PendingView.doingText(progress: AskProgress(agent: "create", activity: "Writing x.svg · 3 KB"), waitLeft: nil), "Writing x.svg")
        XCTAssertEqual(PendingView.doingText(progress: nil, waitLeft: nil), "No answer came back: the run was interrupted.")
        open(["intro", "@chat hi", "bart~> r1", ""])
        editor.setAsks(["r1": AskProgress(activity: "Reading", log: ["Read a", "Read b"])])
        guard let row = overlays(PendingView.self).first, let steps = row.steps else { return XCTFail("the steps toggle") }
        XCTAssertEqual(steps.title, "2 steps ⌄")
        steps.performClick(nil)
        guard let open = overlays(PendingView.self).first else { return XCTFail() }
        XCTAssertEqual(open.steps?.title, "2 steps ⌃")
        XCTAssertEqual(open.logText?.stringValue, "Read a\nRead b")
        editor.setAsks([:])
        guard let gone = overlays(PendingView.self).first else { return XCTFail() }
        XCTAssertEqual(gone.stop.title, "Hide", "no run: Hide")
        gone.stop.performClick(nil)
        XCTAssertFalse(editor.core.lines.contains("bart~> r1"), "Hide takes the line out")
    }

    // MARK: row 91: pictures and PDF text pasted into a reply field

    func testPictureAndPdfTextPastedIntoTheReplyField() {
        let h = FakeHost()
        open(["intro", "![Attachment 1](img:old)", "@chat look", "bart> ok", "bart> *Chat · 1 s*", ""], host: h)
        guard let field = overlays(ReplyFieldView.self).first else { return XCTFail("the reply field") }
        let from = field.from
        window.makeFirstResponder(field.field)
        let pb = board(); pb.setData(png(), forType: .png)
        XCTAssertTrue(editor.fieldPaste(pb, field: field.field, from: from))
        XCTAssertEqual(h.pasted.first?.label, "Attachment 2", "numbered on from the document's pictures")
        XCTAssertEqual(editor.core.followImages[from]?.first?.id, "p1")
        let now = overlays(ReplyFieldView.self).first!.field.string
        XCTAssertEqual(now, "[Attachment 2] ")
        XCTAssertEqual(editor.core.followText[from], "[Attachment 2] ")
        let typed = overlays(ReplyFieldView.self).first!
        typed.field.insertText("see this", replacementRange: typed.field.selectedRange())
        editor.core.sendFollow(from)
        XCTAssertEqual(h.asks.last?.text.contains("![Attachment 2](img:p1)"), true, "sent: the picture's token in the line")
        let pdf = board(); pdf.setString("This is a sen-\ntence that wraps\nacross lines.", forType: .string)
        open(["intro", "@chat look", "bart> ok", "bart> *Chat · 1 s*", ""], host: h)
        guard let f2 = overlays(ReplyFieldView.self).first else { return XCTFail() }
        XCTAssertTrue(editor.fieldPaste(pdf, field: f2.field, from: f2.from))
        XCTAssertEqual(f2.field.string, PdfPaste.pdfText("This is a sen-\ntence that wraps\nacross lines."))
        XCTAssertFalse(f2.field.string.contains("\n"))
        let plain = board(); plain.setString("short words", forType: .string)
        XCTAssertFalse(editor.fieldPaste(plain, field: f2.field, from: f2.from), "other text is the field's own paste")
    }

    // MARK: row 97: card words are text

    func testCardWordsAreSelectableAndCopyable() {
        open(["intro"] + CardsTests.cardTurn(map: true) + [""])
        guard let card = overlays(CardView.self).first else { return XCTFail() }
        XCTAssertFalse(card.blocks.isEmpty)
        for b in card.blocks { XCTAssertTrue(b.isSelectable); XCTAssertFalse(b.isEditable) }
        guard let question = card.blocks.first(where: { $0.string == "Which way?" }) else { return XCTFail("the question as text") }
        window.makeFirstResponder(question)
        question.setSelectedRange(NSRange(location: 0, length: 5))
        NSPasteboard.general.clearContents()
        question.copy(nil)
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "Which")
        XCTAssertTrue(card.blocks.contains { $0.string == "Here is a thought." })
        XCTAssertTrue(card.blocks.contains { $0.string.hasPrefix("What you've settled") })
    }

    // MARK: rows 39, 102: a Build's card patched in place

    final class GrowingView: NSView { var tall: CGFloat = 80; override var fittingSize: NSSize { NSSize(width: 300, height: tall) } }

    func testBuildCardKeptAliveAndPatchedInPlace() {
        let h = FakeHost(); let card = GrowingView(); h.buildViews["0123456789"] = card
        open(["intro", "build> 0123456789", "", "typing here"], host: h)
        XCTAssertTrue(card.superview === editor.textView, "the host's card on the page")
        XCTAssertEqual(h.buildAsks, ["0123456789"])
        editor.redraw(keepSelection: true)
        XCTAssertEqual(h.buildAsks, ["0123456789"], "a redraw keeps the same view: asked once")
        XCTAssertTrue(card.superview === editor.textView)
        caret(3, 6)
        let frame = card.frame
        editor.setBuilds(["0123456789": BuildState(status: "running")])
        XCTAssertEqual(h.patched, ["0123456789"], "progress patches the card")
        XCTAssertEqual(card.frame, frame, "nothing moved")
        XCTAssertEqual(editor.caretNow()?.line, 3); XCTAssertEqual(editor.caretNow()?.a, 6, "the caret untouched")
        card.tall = 200
        editor.buildProgressed("0123456789")
        XCTAssertEqual(card.frame.height, 200 + 20 - 12, accuracy: 1, "grown: the editor drew again around it")
        editor.setDocument(key: "other", text: "plain")
        XCTAssertNil(card.superview, "another document: the card goes")
    }

    // MARK: rows 27, 32, 86, 105

    func testPassageLitUntilTheNextKey() {
        open((0..<30).map { $0 == 20 ? "alpha beta gamma delta" : "line \($0)" })
        XCTAssertTrue(editor.showPassage(20, find: "beta gamma"))
        let at = editor.rendered.maps[20].range.location + 6
        XCTAssertNotNil(editor.layoutManager.temporaryAttribute(.backgroundColor, atCharacterIndex: at, effectiveRange: nil), "the quoted words lit")
        XCTAssertNil(editor.layoutManager.temporaryAttribute(.backgroundColor, atCharacterIndex: editor.rendered.maps[20].range.location, effectiveRange: nil))
        caret(20, 0)
        press("", code: 124)
        XCTAssertNil(editor.layoutManager.temporaryAttribute(.backgroundColor, atCharacterIndex: at, effectiveRange: nil), "cleared by the next key")
    }

    func testAnswerFadesUnderAQuestionBeingEdited() {
        open(["intro", "@chat why?", "bart> because", "bart> *Chat · 1 s*", ""])
        editor.core.startEdit(1); editor.redraw()
        let c = editor.textView.textStorage!.attribute(.foregroundColor, at: editor.rendered.maps[2].range.location, effectiveRange: nil) as! NSColor
        XCTAssertEqual(c.alphaComponent, 0.45, accuracy: 0.01)
        editor.core.cancelEdit(); editor.redraw()
        let back = editor.textView.textStorage!.attribute(.foregroundColor, at: editor.rendered.maps[2].range.location, effectiveRange: nil) as! NSColor
        XCTAssertEqual(back.alphaComponent, 1, accuracy: 0.01)
    }

    func testAskedRowStaysWhereItWasOnScreen() {
        open((0..<60).map { $0 == 40 ? "@chat question" : "line \($0)" })
        XCTAssertTrue(editor.showLine(40, flash: false))
        caret(40, 5)
        let top0 = editor.paragraphRect(40)!.minY - editor.scroll.contentView.bounds.minY
        editor.core.askInline(40); editor.redraw()
        guard let hold = editor.askHold, let id = host.asks.last?.askId else { return XCTFail("held") }
        XCTAssertEqual(hold.top, top0, accuracy: 1)
        let q = editor.core.lines.firstIndex(of: "bart~> \(id)")! - 1
        // Ten lines arrive above it (another window's edit): the asked row stays where it was on screen.
        editor.setText((["new"] + Array(repeating: "added above", count: 9) + editor.core.lines).joined(separator: "\n"))
        let top1 = editor.paragraphRect(q + 10)!.minY - editor.scroll.contentView.bounds.minY
        XCTAssertEqual(top1, top0, accuracy: 2, "kept in place for 3 s")
    }

    // MARK: rows 36, 67, 68, 70, 76

    func testDropsAndTheZoteroChipMark() throws {
        let h = FakeHost(); h.rows = [EditorRow(row: LibRow(id: "n1", name: "Plan", type: "md", tags: ["note"]))]
        open(["see @[Paper](zotero:ABC12) here", "end"], host: h)
        let chip = point(line: 0, offset: 5)
        editor.markDropChip(at: chip, carriesRows: false)
        XCTAssertNotNil(editor.dropChip, "a file over a Zotero chip marks it")
        XCTAssertEqual(editor.layoutManager.temporaryAttribute(.backgroundColor, atCharacterIndex: editor.dropChip!.location, effectiveRange: nil) as? NSColor, NSColor(hex: "#e8f0fe"))
        editor.markDropChip(at: chip, carriesRows: true)
        XCTAssertNil(editor.dropChip, "sidebar rows never mark it")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-drop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let pdf = dir.appendingPathComponent("paper.pdf"); try Data("%PDF-1.4".utf8).write(to: pdf)
        let pb = board(); pb.writeObjects([pdf as NSURL])
        XCTAssertTrue(editor.drop(FakeDrag(pb, at: .zero), at: chip))
        XCTAssertEqual(h.zoteroDrops.first?.0, "ABC12", "a pdf let go on the chip becomes its file")
        let rows = board()
        rows.setData(try JSONSerialization.data(withJSONObject: [["id": "n1", "name": "Plan", "type": "md"]]), forType: NSPasteboard.PasteboardType(Mention.LIB_DRAG_TYPE))
        let end = point(line: 1, offset: 3)
        XCTAssertTrue(editor.drop(FakeDrag(rows, at: .zero), at: end))
        XCTAssertTrue(editor.core.lines[1].contains("@[Plan]"), "a sidebar row writes its mention where let go")
        let link = board(); link.setString("https://ex.org/page", forType: .string)
        XCTAssertTrue(editor.drop(FakeDrag(link, at: .zero), at: end))
        XCTAssertEqual(h.dropped.count, 1, "anything else goes to the host as library items")
        let pic = board(); pic.setData(png(), forType: .png)
        XCTAssertTrue(editor.drop(FakeDrag(pic, at: .zero), at: end))
        XCTAssertTrue(editor.core.lines.contains { $0.contains("](img:p1)") }, "a picture dropped is a pasted picture")
    }

    func testPastePictureAndCopyWritesThePasteboards() {
        let h = FakeHost()
        open(["one two", ""], host: h)
        caret(1, 0)
        let pb = board(); pb.setData(png(), forType: .png)
        editor.paste(from: pb)
        XCTAssertEqual(h.pasted.first?.label, "Attachment 1")
        XCTAssertTrue(editor.core.lines.contains("![Attachment 1](img:p1)"), "saved by the host, placed as a picture line")
        open(["**bold** words", "@chat q", "bart> a", "bart> *Chat · 1 s*", ""], host: h)
        editor.setSelection(DocSelection(anchor: DocPoint(line: 0, offset: 0), focus: DocPoint(line: 0, offset: 14)))
        XCTAssertTrue(editor.copySelection(cut: false))
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "**bold** words", "markdown as plain text")
        XCTAssertTrue(NSPasteboard.general.string(forType: .html)?.contains("<strong>bold</strong>") ?? false, "and HTML")
        editor.setSelection(DocSelection(anchor: DocPoint(line: 0, offset: 0), focus: DocPoint(line: 4, offset: 0)))
        XCTAssertTrue(editor.copySelection(cut: false))
        XCTAssertNotNil(NSPasteboard.general.string(forType: DocEditorView.ownLines), "whole conversations: the document's own lines too")
    }

    func testMentionClicksOpenEachKind() {
        let h = FakeHost(); h.rows = [EditorRow(row: LibRow(id: "n1", name: "Plan", type: "md", tags: ["note"])), EditorRow(row: LibRow(id: "p1", name: "Paper", type: "pdf"))]
        open(["@[Z](zotero:ABC12) x", "@[a.pdf](lib:f1:a.pdf) x", "see https://ex.org/x now", "@[W](ws:w1) x", "@[Plan](lib:n1) x", "@[Paper](lib:p1) x"], host: h)
        click(point(line: 0, offset: 1)); XCTAssertEqual(h.opened.last, "zotero:ABC12")
        click(point(line: 1, offset: 1)); XCTAssertEqual(h.opened.last, "file:f1:a.pdf")
        click(point(line: 2, offset: 6)); XCTAssertEqual(h.links.last?.0, "https://ex.org/x", "an address opens as a link")
        click(point(line: 3, offset: 1)); XCTAssertEqual(h.opened.last, "beside:workspace:w1")
        click(point(line: 3, offset: 1), flags: .command); XCTAssertEqual(h.opened.last, "workspace:w1", "⌘: go to it")
        click(point(line: 4, offset: 1)); XCTAssertEqual(h.opened.last, "beside:note:n1", "a note opens beside")
        click(point(line: 4, offset: 1), flags: .command); XCTAssertEqual(h.opened.last, "row:n1", "⌘: as a tab")
        click(point(line: 5, offset: 1)); XCTAssertEqual(h.opened.last, "row:p1", "others: the host opens the item")
    }

    // MARK: row 95: find, row 99: the made peek

    func testFindCountsStepsAndEscapePlacesTheCaret() {
        open(["alpha one", "beta alpha", "gamma", "alpha"])
        editor.openFind()
        guard let f = editor.findBar else { return XCTFail("the find card") }
        XCTAssertLessThanOrEqual(f.frame.width, 360)
        f.field.stringValue = "alpha"
        f.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(f.ranges.count, 3)
        XCTAssertEqual(f.count.stringValue, "1 of 3")
        editor.findStep(1)
        XCTAssertEqual(f.count.stringValue, "2 of 3")
        editor.findStep(-1); editor.findStep(-1)
        XCTAssertEqual(f.count.stringValue, "3 of 3", "steps wrap")
        f.field.stringValue = "zzz"
        f.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(f.count.stringValue, "0 matches")
        f.field.stringValue = "gamma"
        f.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        f.close()
        XCTAssertNil(editor.findBar)
        XCTAssertEqual(editor.caretNow()?.line, 2, "the caret on the match in front")
    }

    func testMadePeekAfterRestingOnTheName() {
        let h = FakeHost()
        h.madeFiles["a1/flow.svg"] = MadeFile(name: "flow.svg", type: "svg", text: "<svg/>")
        open(["intro", "@create a diagram", "bart> Here.", "bart> @[flow.svg](made:a1/flow.svg)", "bart> *Create · 9 s*", ""], host: h)
        guard let row = overlays(MadeRowView.self).first else { return XCTFail() }
        let p = NSPoint(x: row.frame.minX + row.peekRect.midX, y: row.frame.minY + row.peekRect.midY)
        editor.hoverMade(p)
        XCTAssertNil(editor.cards.peek, "not at once")
        spin(0.5)
        XCTAssertNotNil(editor.cards.peek, "after 350 ms")
        XCTAssertEqual(editor.cards.peek?.frame.width, 280)
        editor.hoverMade(NSPoint(x: 1, y: 1))
        XCTAssertNil(editor.cards.peek, "leaving hides it")
    }
}
