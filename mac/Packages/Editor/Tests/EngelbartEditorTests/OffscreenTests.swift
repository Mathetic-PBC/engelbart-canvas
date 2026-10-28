import XCTest
import AppKit
import EngelbartCore
import EngelbartDoc
@testable import EngelbartEditor

// The editor in a window that is never shown (defer: false, never ordered front), driven by synthesized NSEvents through
// keyDown / interpretKeyEvents / mouseDown and the overlays' own buttons; asserted on the model's text, the selection,
// layout rects, attributes, the overlays placed and what reached the host.

final class FakeHost: DocEditorHost {
    var asks: [AskRequest] = []
    var links: [(String, Bool)] = []
    var copies: [String] = []
    var made: [String] = []
    var madeSaves: [String] = []
    var madeNeeded: [[String]] = []
    var madeFiles: [String: MadeFile] = [:]
    var papers: [String: String] = [:]
    var saved: [String] = []
    var unsaved: [String] = []
    var stops: [String] = []
    var reports: [ViewPosition] = []
    var rows: [EditorRow] = []
    var listings: [String: FolderListing] = [:]
    var listed: [String] = []
    var menuOpen: [Bool] = []
    var canAsk = true
    var models: QuestionModels? = nil
    func docEditorCanAsk(_ editor: DocEditorView) -> Bool { canAsk }
    func docEditorModels(_ editor: DocEditorView) -> QuestionModels? { models }
    func docEditor(_ editor: DocEditorView, ask: AskRequest) { asks.append(ask) }
    func docEditor(_ editor: DocEditorView, stop askId: String) { stops.append(askId) }
    func docEditor(_ editor: DocEditorView, openLink href: String, newTab: Bool, sections: [String]?) { links.append((href, newTab)) }
    func docEditor(_ editor: DocEditorView, copy text: String) { copies.append(text) }
    func docEditor(_ editor: DocEditorView, openMade key: String) { made.append(key) }
    func docEditor(_ editor: DocEditorView, madeFile key: String) -> MadeFile? { madeFiles[key] }
    func docEditor(_ editor: DocEditorView, saveMade key: String, name: String) { madeSaves.append(key) }
    func docEditor(_ editor: DocEditorView, madeNeeded keys: [String]) { madeNeeded.append(keys) }
    func docEditor(_ editor: DocEditorView, paperState address: String) -> String? { papers[address] }
    func docEditor(_ editor: DocEditorView, savePaper title: String, address: String, done: @escaping (Error?) -> Void) { saved.append(title); papers[address] = "here"; done(nil) }
    func docEditorCanUnsavePaper(_ editor: DocEditorView) -> Bool { true }
    func docEditor(_ editor: DocEditorView, unsavePaper title: String, address: String, done: @escaping (Error?) -> Void) { unsaved.append(title); papers[address] = "lib"; done(nil) }
    func docEditor(_ editor: DocEditorView, reportView position: ViewPosition, scope: String, key: String, now: Bool) { reports.append(position) }
    func docEditorMentionable(_ editor: DocEditorView) -> [EditorRow] { rows }
    func docEditor(_ editor: DocEditorView, listFolder id: String, rel: String, done: @escaping (FolderListing) -> Void) {
        listed.append("\(id):\(rel)"); done(listings["\(id):\(rel)"] ?? FolderListing(entries: []))
    }
    func docEditor(_ editor: DocEditorView, mentionMenuOpen open: Bool) { menuOpen.append(open) }
    // pictures, drops, opening, peeks, Builds
    var images: [String: NSImage] = [:]
    var pasted: [(mime: String, label: String)] = []
    var pasteId: (Int) -> String? = { "p\($0)" }
    var dropped: [[Drop.Item]] = []
    var zoteroDrops: [(String, String)] = []
    var opened: [String] = []
    var peeks: [String: WorkspacePeekInfo] = [:]
    var peekTexts: [String: String] = [:]
    var peekReads: [String] = []
    var buildViews: [String: NSView] = [:]
    var buildAsks: [String] = []
    var patched: [String] = []
    func docEditor(_ editor: DocEditorView, image id: String) -> NSImage? { images[id] }
    func docEditor(_ editor: DocEditorView, pasteImage data: Data, mime: String, label: String, done: @escaping (String?) -> Void) { pasted.append((mime, label)); done(pasteId(pasted.count)) }
    func docEditor(_ editor: DocEditorView, dropItems: [Drop.Item]) { dropped.append(dropItems) }
    func docEditor(_ editor: DocEditorView, dropOnZotero key: String, name: String, file: String) { zoteroDrops.append((key, file)) }
    func docEditor(_ editor: DocEditorView, openZotero key: String, name: String, newTab: Bool) { opened.append("zotero:\(key)") }
    func docEditor(_ editor: DocEditorView, openFile folderId: String, rel: String, name: String, newTab: Bool) { opened.append("file:\(folderId):\(rel)") }
    func docEditor(_ editor: DocEditorView, openBeside kind: String, id: String, name: String) { opened.append("beside:\(kind):\(id)") }
    func docEditor(_ editor: DocEditorView, openWorkspace id: String) { opened.append("workspace:\(id)") }
    func docEditor(_ editor: DocEditorView, open row: LibRow) { opened.append("row:\(row.id)") }
    func docEditor(_ editor: DocEditorView, workspacePeek id: String) -> WorkspacePeekInfo? { peeks[id] }
    func docEditor(_ editor: DocEditorView, workspacePeekText id: String, done: @escaping (String?) -> Void) { peekReads.append(id); done(peekTexts[id]) }
    func docEditor(_ editor: DocEditorView, buildView id: String) -> NSView? { buildAsks.append(id); return buildViews[id] }
    func docEditor(_ editor: DocEditorView, patchBuild id: String, view: NSView) { patched.append(id) }
}

class EditorWindowCase: XCTestCase {
    var window: NSWindow!
    var editor: DocEditorView!
    var host: FakeHost!

    func open(_ lines: [String], host h: FakeHost = FakeHost(), compact: Bool = false, size: NSSize = NSSize(width: 800, height: 600)) {
        host = h
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        editor = DocEditorView(frame: NSRect(origin: .zero, size: size))
        editor.compact = compact
        window.contentView = editor
        editor.host = host
        editor.setDocument(key: "doc", text: lines.joined(separator: "\n"))
        editor.layoutSubtreeIfNeeded()
        editor.redraw(keepSelection: true)
    }
    override func tearDown() { window?.contentView = nil; window?.close(); window = nil; editor = nil; host = nil }

    // MARK: events

    func key(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = [], ignoring: String? = nil) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                         context: nil, characters: chars, charactersIgnoringModifiers: ignoring ?? chars, isARepeat: false, keyCode: code)!
    }
    /// A key the way AppKit delivers it: keyDown, and what the editor does not take through interpretKeyEvents.
    func press(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = [], ignoring: String? = nil) {
        window.makeFirstResponder(editor.textView)
        editor.textView.keyDown(with: key(chars, code: code, flags: flags, ignoring: ignoring))
    }
    func type(_ text: String) { for ch in text { press(String(ch), code: 0) } }
    func mouse(_ type: NSEvent.EventType, at p: NSPoint, flags: NSEvent.ModifierFlags = [], clicks: Int = 1) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: editor.textView.convert(p, to: nil), modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    }
    /// A press the editor takes itself (a box, a link, a gap, below the last line): mouseDown returns at once.
    func click(_ p: NSPoint, flags: NSEvent.ModifierFlags = []) { window.makeFirstResponder(editor.textView); editor.textView.mouseDown(with: mouse(.leftMouseDown, at: p, flags: flags)) }
    /// The point in the text view at display offset `off` of line `i`.
    func point(line i: Int, offset off: Int) -> NSPoint {
        let m = editor.rendered.maps[i]
        let lm = editor.layoutManager
        let g = lm.glyphRange(forCharacterRange: NSRange(location: m.range.location + off, length: 1), actualCharacterRange: nil)
        let r = lm.boundingRect(forGlyphRange: g, in: editor.textView.textContainer!)
        return NSPoint(x: r.midX + editor.textView.textContainerOrigin.x, y: r.midY + editor.textView.textContainerOrigin.y)
    }
    /// Lets what the editor put on the main queue run (a host's answer, focus leaving).
    func spin(_ s: TimeInterval = 0.05) {
        let e = expectation(description: "spin")
        DispatchQueue.main.asyncAfter(deadline: .now() + s) { e.fulfill() }
        wait(for: [e], timeout: s + 5)
    }
    func overlays<T: NSView>(_ type: T.Type) -> [T] { editor.overlays.compactMap { $0 as? T } }
    func caret(_ line: Int, _ offset: Int) { editor.placeCaret(line: line, a: offset, b: offset); window.makeFirstResponder(editor.textView) }

}

final class OffscreenTests: EditorWindowCase {
    // MARK: typing and keys

    func testTypingThroughKeyEventsGoesToTheModel() {
        open(["hello"])
        caret(0, 5)
        type(" you")
        XCTAssertEqual(editor.core.lines, ["hello you"], "keyDown → interpretKeyEvents → insertText → the model")
        press("\r", code: 36)
        XCTAssertEqual(editor.core.lines, ["hello you", ""], "Return → insertNewline → Enter")
        type("- a")
        press("\r", code: 36)
        XCTAssertEqual(editor.core.lines.last, "- ", "a list row continues")
        press("\u{7F}", code: 51)
        XCTAssertEqual(editor.core.lines.last, "", "Backspace on an empty row's mark")
        XCTAssertEqual(editor.caretNow()?.line, editor.core.lines.count - 1)
    }

    func testCommandEnterDoesNothingAndUndoRestoresTheCaret() {
        open(["one two"])
        caret(0, 3)
        press("\r", code: 36, flags: .command)
        XCTAssertEqual(editor.core.lines, ["one two"], "⌘Enter does nothing")
        type("X")
        XCTAssertEqual(editor.core.lines, ["oneX two"])
        caret(0, 0)
        press("z", code: 6, flags: .command)
        XCTAssertEqual(editor.core.lines, ["one two"])
        XCTAssertEqual(editor.caretNow()?.a, 3, "undo puts the caret where the step was taken")
        press("z", code: 6, flags: [.command, .shift], ignoring: "Z")
        XCTAssertEqual(editor.core.lines, ["oneX two"], "⇧⌘Z redoes")
    }

    func testWordAndLineDelete() {
        open(["alpha beta gamma"])
        caret(0, 16)
        editor.textView.doCommand(by: #selector(NSResponder.deleteWordBackward(_:)))
        XCTAssertEqual(editor.core.lines, ["alpha beta "], "⌥⌫ a word as one range")
        editor.textView.doCommand(by: #selector(NSResponder.deleteToBeginningOfLine(_:)))
        XCTAssertEqual(editor.core.lines, [""], "⌘⌫ to the line's start")
    }

    func testBulkDeleteEmptyingARowLeavesAPlainLine() {
        open(["- [ ] task one", "after"])
        editor.setSelection(DocSelection(anchor: DocPoint(line: 0, offset: 0), focus: DocPoint(line: 0, offset: 8)))
        window.makeFirstResponder(editor.textView)
        press("\u{7F}", code: 51)
        XCTAssertEqual(editor.core.lines[0], "", "a row emptied by a bulk delete is a plain empty line")
    }

    func testEscapeLeavesTheLine() {
        open(["text"])
        caret(0, 2)
        XCTAssertTrue(editor.isActive)
        press("\u{1B}", code: 53)
        XCTAssertNil(editor.core.activeLine)
        XCTAssertFalse(editor.isActive)
        XCTAssertFalse(window.firstResponder === editor.textView, "Escape leaves the line (blur)")
    }

    func testIMECompositionCommitsThroughTheModel() {
        open(["a"])
        caret(0, 1)
        editor.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(editor.composing)
        XCTAssertEqual(editor.core.lines, ["a"], "marked text is the IME's until it commits")
        editor.textView.insertText("日", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertFalse(editor.composing)
        XCTAssertEqual(editor.core.lines, ["a日"])
        XCTAssertEqual(editor.textView.string, "a日")
    }

    func testFocusLeavingCancelsEditAndLeavesTheLine() {
        open(["x"])
        editor.appActive = { true }
        caret(0, 1)
        XCTAssertTrue(window.firstResponder === editor.textView, "the text view has the keyboard")
        XCTAssertEqual(editor.core.activeLine, 0)
        window.makeFirstResponder(nil)
        spin(0.2)
        if editor.core.activeLine != nil { editor.focusLeft(); spin(0.2) }
        XCTAssertNil(editor.core.activeLine, "focus out: the line is left")
    }

    // MARK: the @ menu

    func testMentionMenuKeysAndNoneInCode() {
        let h = FakeHost()
        h.rows = [EditorRow(row: LibRow(id: "n1", name: "Plan", type: "md", tags: ["note"])), EditorRow(row: LibRow(id: "n2", name: "Paper", type: "pdf"))]
        open(["", "```", "", "```"], host: h)
        caret(0, 0)
        type("@P")
        XCTAssertNotNil(editor.mentionMenu, "@ + letters opens the menu")
        XCTAssertEqual(h.menuOpen.first, true)
        let first = editor.mention!.index
        press("", code: 125)
        XCTAssertNotEqual(editor.mention!.index, first, "↓ moves")
        press("", code: 126)
        XCTAssertEqual(editor.mention!.index, first, "↑ back")
        press("\u{1B}", code: 53)
        XCTAssertNil(editor.mentionMenu, "Escape closes the menu alone")
        XCTAssertEqual(editor.core.activeLine, 0, "and keeps the line")
        type("l")
        XCTAssertNotNil(editor.mentionMenu)
        press("\t", code: 48)
        XCTAssertNil(editor.mentionMenu)
        XCTAssertTrue(editor.core.lines[0].contains("Plan"), "Tab picks: the mention is written")
        caret(2, 0)
        type("@P")
        XCTAssertNil(editor.mentionMenu, "no @ menu inside code")
    }

    func testFolderBrowsingInTheMentionMenu() {
        let h = FakeHost()
        let folder = LibRow(id: "f1", name: "Papers", type: "folder", folderPath: "/home/p")
        h.rows = [EditorRow(row: folder)]
        h.listings["f1:"] = FolderListing(entries: [FolderListing.Entry(name: "sub", rel: "sub", dir: true), FolderListing.Entry(name: "a.pdf", rel: "a.pdf", dir: false)])
        h.listings["f1:sub"] = FolderListing(entries: [FolderListing.Entry(name: "deep.pdf", rel: "sub/deep.pdf", dir: false)])
        open([""], host: h)
        caret(0, 0)
        type("@Pap")
        guard let row = editor.mention?.items.first(where: { $0.row?.id == "f1" }) else { return XCTFail("the folder is a row") }
        editor.pickMention(row)
        XCTAssertEqual(h.listed, ["f1:"], "a folder row opens the folder: its listing asked of the host")
        XCTAssertNotNil(editor.browse)
        XCTAssertTrue(editor.mention!.items.contains { $0.name.contains("sub") })
        if let sub = editor.mention!.items.first(where: { $0.dir && $0.name.contains("sub") }) {
            editor.pickMention(sub)
            XCTAssertEqual(h.listed.last, "f1:sub")
        } else { XCTFail("sub folder row") }
        XCTAssertTrue(editor.upFromFolder(editor.mention!.caret), "Backspace at the path goes up a level")
        XCTAssertEqual(editor.browse?.rel ?? "", "")
    }

    // MARK: clicks

    func testTodoBoxLinkAndBelowTheLastLine() {
        open(["- [ ] task", "see [site](https://ex.org) now", "last"])
        let box = editor.textView.textStorage!.attribute(.edMark, at: editor.rendered.maps[0].range.location, effectiveRange: nil) as! MarkPaint
        let row = point(line: 0, offset: 0)
        click(NSPoint(x: editor.textView.textContainerOrigin.x + box.x + box.width / 2, y: row.y))
        XCTAssertEqual(editor.core.lines[0], "- [x] task", "a press on the box toggles it")
        click(point(line: 1, offset: 5))
        XCTAssertEqual(h0(host.links), "https://ex.org", "a link opens through the host")
        click(point(line: 1, offset: 5), flags: .command)
        XCTAssertEqual(host.links.last?.1, true, "⌘: a new tab")
        let below = NSPoint(x: 200, y: editor.layoutManager.usedRect(for: editor.textView.textContainer!).maxY + editor.textView.textContainerOrigin.y + 40)
        click(below)
        XCTAssertEqual(editor.caretNow()?.line, 2, "below the last line: the caret at the end")
        XCTAssertEqual(editor.caretNow()?.a, 4)
    }
    func h0(_ l: [(String, Bool)]) -> String? { l.first?.0 }

    func testMadeMentionOpensInTheStage() {
        open(["see @[flow.svg](made:a1/flow.svg) here"])
        click(point(line: 0, offset: 5))
        XCTAssertEqual(host.made, ["a1/flow.svg"])
    }

    func testGapUnderACardMakesALine() {
        open(["- [ ] a", "- [ ] b", "## Head"])
        guard let r = editor.paragraphRect(1) else { return XCTFail() }
        let style = editor.textView.textStorage!.attribute(.paragraphStyle, at: editor.rendered.maps[1].range.location, effectiveRange: nil) as! NSParagraphStyle
        let y = r.maxY - 2
        let g = editor.gapAt(NSPoint(x: r.midX, y: y))
        XCTAssertNotNil(g, "the space under a checklist (\(style.paragraphSpacing)) is a gap")
        click(NSPoint(x: r.midX, y: y))
        XCTAssertEqual(editor.core.lines.count, 4, "a line made there")
        XCTAssertEqual(editor.core.lines[2], "")
        XCTAssertEqual(editor.caretNow()?.line, 2)
        _ = editor.command("z", cmd: true)
        XCTAssertEqual(editor.core.lines, ["- [ ] a", "- [ ] b", "## Head"], "one undo step")
    }

    // MARK: public entry points

    func testFocusPlaceCaretShutMenusShowLine() {
        open((0..<80).map { "line \($0)" })
        editor.focusStart()
        XCTAssertEqual(editor.caretNow()?.line, 0)
        editor.focusEnd()
        XCTAssertEqual(editor.caretNow()?.line, 79)
        XCTAssertTrue(editor.placeCaret(line: 10, a: 2, b: 4))
        XCTAssertEqual(editor.caretNow()?.a, 2); XCTAssertEqual(editor.caretNow()?.b, 4)
        XCTAssertFalse(editor.shutMenus(), "nothing open")
        XCTAssertTrue(editor.showLine(40))
        let r = editor.paragraphRect(40)!
        let pane = editor.scroll.contentView.bounds
        XCTAssertTrue(pane.minY <= r.minY && r.maxY <= pane.maxY, "line 40 brought into the pane")
        var flash: Any? = nil
        editor.layoutManager.temporaryAttributes(atCharacterIndex: editor.rendered.maps[40].range.location, effectiveRange: nil).forEach { if $0.key == .backgroundColor { flash = $0.value } }
        XCTAssertNotNil(flash, "flashed")
        XCTAssertTrue(editor.showPassage(60, find: "line 60"))
    }

    func testEmptyHintAndBesideMarks() {
        open(["see @[Plan] here", ""])
        editor.emptyHint = "Write here"
        editor.redraw(keepSelection: true)
        XCTAssertTrue(editor.overlays.contains { ($0 as? NSTextField)?.stringValue == "Write here" }, "the hint is drawn on the empty last line")
        XCTAssertFalse(editor.textView.string.contains("Write here"), "never in the text")
        editor.besideLink = "Plan"
        let at = editor.rendered.maps[0].range.location + 5
        let bg = editor.textView.textStorage!.attribute(.backgroundColor, at: at, effectiveRange: nil) as? NSColor
        let pill = editor.textView.textStorage!.attribute(.edPill, at: at, effectiveRange: nil)
        XCTAssertTrue(bg != nil || pill != nil, "a mention open beside is marked")
    }

    func testAsksPatchKeepTheCaretAndPendingRowHasStop() {
        open(["intro", "@chat hi", "bart~> run1", "", "typing here"])
        caret(4, 6)
        editor.setAsks(["run1": AskProgress(activity: "Thinking", name: "Sonnet", effort: "high", lines: ["so far"])])
        XCTAssertEqual(editor.caretNow()?.line, 4); XCTAssertEqual(editor.caretNow()?.a, 6, "progress leaves the caret where it was")
        guard let row = overlays(PendingView.self).first else { return XCTFail("the pending row") }
        row.stop.performClick(nil)
        XCTAssertEqual(host.stops, ["run1"], "Stop goes to the host")
    }

    func testCopyCodeAndCopiedLabel() {
        open(["```js", "let a = 1", "```"])
        guard let b = overlays(IconButton.self).first(where: { $0.toolTip == "Copy" }) else { return XCTFail("the code block's Copy") }
        b.performClick(nil)
        XCTAssertEqual(host.copies, ["let a = 1"])
        XCTAssertEqual(b.toolTip, "Copied", "says Copied for a moment")
    }

    func testAnsweredQuestionHasItsCornerAndFoot() {
        open(["intro", "@chat why?", "bart> because", "bart> *Chat · Sonnet · high · 3 s*", ""])
        XCTAssertTrue(editor.rendered.decos.contains { if case .corner = $0.deco { return true }; return false }, "Collapse in the corner")
        XCTAssertFalse(overlays(FootView.self).isEmpty)
        XCTAssertFalse(overlays(ReplyFieldView.self).isEmpty, "the reply field under the last turn")
        let s = editor.textView.textStorage!
        let card = s.attribute(.edCard, at: editor.rendered.maps[1].range.location, effectiveRange: nil) as? CardPaint
        XCTAssertTrue(card?.top ?? false, "the asked question opens its card")
    }

    // MARK: sizing

    func testCompactFitsItsLinesAndPageHasHalfAWindowBelow() {
        open(["one", "two"], compact: true, size: NSSize(width: 260, height: 300))
        XCTAssertEqual(editor.textView.bottomExtra, 2, "a post-it: no room under its last line")
        XCTAssertLessThan(editor.contentHeight, 120, "fits its lines")
        open(["one", "two"], size: NSSize(width: 800, height: 600))
        XCTAssertGreaterThanOrEqual(editor.textView.bottomExtra, 600 / 2 - 40, "a page: half a window below the last line")
        XCTAssertGreaterThan(editor.textView.frame.height, editor.layoutManager.usedRect(for: editor.textView.textContainer!).height + 200)
    }

    // MARK: pictures

    func testPictureHandlesResizeAndOpen() {
        let h = FakeHost()
        open(["![Attachment 1](img:i1)", "text"], host: h)
        // No image from the host: the picture's line still draws its placeholder attachment (or none); handles follow it.
        let handles = overlays(PictureHandles.self)
        if let p = handles.first {
            XCTAssertEqual(p.corners().count, 4, "four corners")
            XCTAssertEqual(p.line, 0)
        }
        editor.core.resizeImage(0, width: 240)
        XCTAssertTrue(editor.core.lines[0].contains("|w=240"), "the width written in the alt")
    }

    // MARK: cards, bookmarks, made rows

    func testCardOverlayPickSubmitAndSkip() {
        open(["intro"] + CardsTests.cardTurn() + [""])
        guard let card = overlays(CardView.self).first else { return XCTFail("the card is drawn") }
        XCTAssertGreaterThan(card.frame.height, 100)
        let rows = card.subviews.compactMap { $0 as? CardOptionView }
        XCTAssertEqual(rows.count, 3)
        XCTAssertTrue(rows.allSatisfy { $0.boxed })
        rows[1].performClick(nil)
        XCTAssertEqual(editor.core.cardPicks[1], ["Beta"])
        guard let again = overlays(CardView.self).first, let submit = again.submit else { return XCTFail("Submit") }
        XCTAssertEqual(again.subviews.compactMap { $0 as? CardOptionView }[1].on, true, "drawn ticked")
        submit.performClick(nil)
        XCTAssertEqual(host.asks.last?.text, "picked \"Beta\"")
        open(["intro"] + CardsTests.cardTurn() + [""])
        guard let foot = overlays(FootView.self).first else { return XCTFail("the foot") }
        let words = foot.extras.map { $0.title }
        XCTAssertEqual(words, ["Skip", "Wrap up"])
        foot.extras[0].performClick(nil)
        XCTAssertEqual(host.asks.last?.text, Card.skipped)
    }

    func testRepickAsksFirstThenRestarts() {
        open(["intro"] + CardsTests.cardTurn() + ["@brainstorm picked \"Alpha\"", "bart> ok", "bart> *Brainstorm · 1 s*", ""])
        guard let card = overlays(CardView.self).first else { return XCTFail() }
        let rows = card.subviews.compactMap { $0 as? CardOptionView }
        XCTAssertFalse(rows[0].isEnabled, "the pick made is still")
        rows[2].performClick(nil)
        XCTAssertEqual(editor.cards.repick?.n, 2, "asked before anything goes")
        XCTAssertTrue(host.asks.isEmpty)
        press("\u{1B}", code: 53)
        XCTAssertNil(editor.cards.repick, "Escape: not")
        overlays(CardView.self).first!.subviews.compactMap { $0 as? CardOptionView }[2].performClick(nil)
        guard let go = overlays(CardView.self).first!.subviews.compactMap({ $0 as? BoxButton }).first(where: { $0.words == "Restart from here" }) else { return XCTFail("Restart from here") }
        go.performClick(nil)
        XCTAssertEqual(editor.core.lines[6], "@brainstorm picked \"Gamma\"")
        XCTAssertEqual(host.asks.count, 1)
    }

    func testSendToDiscoverOpensAndSends() {
        open(["intro", "@brainstorm go", "bart> What you know: a lot", "bart> Your question: why", "bart> *Brainstorm · 2 s*", ""])
        guard let row = overlays(SendDiscoverView.self).first, let b = row.button else { return XCTFail("Send to Discover's button") }
        b.performClick(nil)
        guard let field = overlays(SendDiscoverView.self).first, let f = field.field else { return XCTFail("opened") }
        f.string = "prior work"
        field.textDidChange(Notification(name: NSText.didChangeNotification))
        field.send?.performClick(nil)
        XCTAssertEqual(host.asks.last?.agent, "discover")
        XCTAssertTrue(editor.core.lines.contains("@discover prior work"))
    }

    func testResultOfferClick() {
        open(["intro", "@brainstorm go", "bart> A sharp question.", "bart> \(Card.resultOffer)", "bart> *Brainstorm · 2 s*", ""])
        let shown = (editor.textView.string as NSString).substring(with: editor.rendered.maps[3].range) as NSString
        let at = shown.range(of: "@chat").location
        guard at != NSNotFound else { return XCTFail("the offer line: \(shown)") }
        click(point(line: 3, offset: at + 1))
        XCTAssertEqual(host.asks.last?.agent, "bart")
        XCTAssertEqual(host.asks.last?.text, "A sharp question.")
    }

    func testGuideBookmarksAndSaveAll() {
        let h = FakeHost()
        h.papers = ["https://a.org/1": "none", "https://a.org/2": "here", "https://a.org/3": "lib"]
        open(["intro", "@discover papers", "bart> **[One](https://a.org/1)**", "bart> **[Two](https://a.org/2)**", "bart> **[Three](https://a.org/3)**", "bart> *Discover · 9 s*", ""], host: h)
        let marks = overlays(PaperMarkButton.self)
        XCTAssertEqual(marks.map { $0.mark }, ["none", "here", "lib"])
        marks[1].performClick(nil)
        spin()
        XCTAssertEqual(h.unsaved, ["Two"], "a filled bookmark takes it off this project")
        guard let foot = overlays(FootView.self).first, let all = foot.extras.first(where: { $0.title.hasPrefix("Save all") }) else { return XCTFail("Save all") }
        XCTAssertEqual(all.title, "Save all (3)")
        all.performClick(nil)
        spin(0.3)
        XCTAssertEqual(h.saved, ["One", "Two", "Three"])
        XCTAssertNil(overlays(FootView.self).first?.extras.first { $0.title.hasPrefix("Save all") }, "none left to save")
    }

    func testMadeRowSaveExpandAndNeeded() {
        let h = FakeHost()
        let made = "@[flow.svg](made:a1/flow.svg)"
        open(["intro", "@create a diagram", "bart> Here.", "bart> \(made)", "bart> *Create · 9 s*", ""], host: h)
        XCTAssertEqual(h.madeNeeded.first, ["a1/flow.svg"], "a made file not read yet is asked for")
        h.madeFiles["a1/flow.svg"] = MadeFile(name: "flow.svg", type: "svg", text: "<svg/>")
        editor.redraw(keepSelection: true)
        guard let row = overlays(MadeRowView.self).first, let save = row.save else { return XCTFail("its row, with Save") }
        save.performClick(nil)
        XCTAssertEqual(h.madeSaves, ["a1/flow.svg"])
        row.nameButton.performClick(nil)
        XCTAssertEqual(h.made, ["a1/flow.svg"], "the name opens it in the Stage")
        let shut = row.frame.height
        row.chevron.performClick(nil)
        guard let opened = overlays(MadeRowView.self).first else { return XCTFail() }
        XCTAssertTrue(opened.open)
        XCTAssertGreaterThan(opened.frame.height, shut, "its frame inline")
        opened.stage?.performClick(nil)
        XCTAssertEqual(h.made.count, 2, "Open in Stage")
        h.madeFiles["a1/flow.svg"]?.saved = "flow.svg"
        editor.redraw(keepSelection: true)
        XCTAssertNil(overlays(MadeRowView.self).first?.save, "Saved: no button")
    }

    func testCreatingRowStops() {
        open(["intro", "@create a page", "bart~> c1", ""])
        editor.setAsks(["c1": AskProgress(agent: "create", activity: "Reading notes.md", making: "A page of the notes.", at: Date().addingTimeInterval(-65))])
        guard let row = overlays(CreatingView.self).first else { return XCTFail("the Create row") }
        XCTAssertEqual(row.clock?.stringValue, "1:05")
        XCTAssertEqual(row.doing.stringValue, "Reading your notes")
        row.button.performClick(nil)
        XCTAssertEqual(host.stops, ["c1"])
    }

    // MARK: long answers, sources, chips

    func testShowMoreCutsOlderLongAnswers() {
        let long = (1...24).map { "bart> line \($0) of a long answer that goes on" }
        open(["intro", "@chat first?", "bart> short", "bart> *Chat · 1 s*", "@chat second?"] + long + ["bart> *Chat · 1 s*", "@chat third?", "bart> short too", "bart> *Chat · 1 s*", ""])
        let q = 4
        XCTAssertNotNil(editor.clipFrom[q], "an older answer past six lines is cut")
        let from = editor.clipFrom[q]!
        XCTAssertNotNil(editor.textView.textStorage!.attribute(.edHidden, at: editor.rendered.maps[from].range.location, effectiveRange: nil))
        XCTAssertNil(editor.clipFrom[1], "not the first answer")
        XCTAssertNil(editor.clipFrom[q + long.count + 2], "not the latest")
        guard let more = overlays(MoreView.self).first else { return XCTFail("Show more") }
        XCTAssertFalse(more.open)
        more.button.performClick(nil)
        XCTAssertNil(editor.clipFrom[q], "Show more: whole")
        XCTAssertEqual(overlays(MoreView.self).first?.open, true, "Show less")
    }

    func testSourcesListUnderACitingAnswer() {
        open(["intro", "@chat why?", "bart> One [a](/n/A.md#find=x%20y&cite=you) and [b](/n/B.md#find=z&cite=other).", "bart> *Chat · 1 s*", ""])
        XCTAssertTrue(editor.rendered.decos.contains { $0.deco == .sources(q: 1) })
        guard let v = overlays(SourcesView.self).first else { return XCTFail("the sources list") }
        XCTAssertEqual(v.sources.count, 2)
        XCTAssertEqual(v.sources.map { $0.n }, [1, 2])
        v.onOpen(v.sources[0].href)
        XCTAssertEqual(host.links.last?.0, "/n/A.md#find=x%20y&cite=you")
    }

    func testZoteroChipFindingAndWaiting() {
        open(["see @[Smith 2024](zotero:ABC123) here"])
        editor.zoteroFinding = ["ABC123"]
        XCTAssertTrue(editor.textView.string.contains("Smith 2024 · Finding a free copy…"))
        editor.zoteroFinding = []
        editor.zoteroWaiting = ["ABC123"]
        XCTAssertFalse(editor.textView.string.contains("Finding"))
        XCTAssertFalse(overlays(ChipNoteView.self).isEmpty, "the waiting label under the chip")
        XCTAssertEqual(overlays(ChipNoteView.self).first?.text, "Download the PDF in your browser to open it in the Stage")
    }

    // MARK: asking

    func testAskedRowHeldAndReplyTakesTheKeyboard() {
        open(["intro", "@chat why?", ""])
        caret(1, 10)
        editor.core.askInline(1)
        editor.redraw()
        XCTAssertEqual(host.asks.count, 1)
        guard let id = host.asks.first?.askId else { return }
        XCTAssertNotNil(editor.replyWait, "waits for its answer")
        let lines = editor.core.lines.map { $0 == "bart~> \(id)" ? "bart> because\nbart> *Chat · 1 s*" : $0 }
        editor.setText(lines.joined(separator: "\n"))
        XCTAssertNil(editor.replyWait)
        XCTAssertTrue(window.firstResponder is ReplyTextView, "the reply field takes the keyboard when the answer lands")
    }

    func testStreamBoxHeldWhenScrolledUp() {
        open(["intro", "@chat hi", "bart~> run1", ""])
        editor.setAsks(["run1": AskProgress(activity: "Writing", lines: (1...40).map { "line \($0)" })])
        guard let v = overlays(PendingView.self).first else { return XCTFail() }
        XCTAssertTrue(v.follow, "follows the newest line")
        v.onScrolled(12, 200)
        XCTAssertEqual(editor.streamHeld["run1"], 12, "scrolled up past 40px: held")
        editor.setAsks(["run1": AskProgress(activity: "Writing", lines: (1...41).map { "line \($0)" })])
        let again = overlays(PendingView.self).first!
        XCTAssertFalse(again.follow)
        XCTAssertEqual(again.heldTop, 12)
        again.onScrolled(300, 10)
        XCTAssertNil(editor.streamHeld["run1"], "back near the bottom: follows again")
    }

    func testProviderListOpensAndRegenerateAsks() {
        let h = FakeHost(); h.models = QuestionModels.defaults
        open(["intro", "@chat why?", "bart> because", "bart> *Chat · Sonnet · high · 3 s*", ""], host: h)
        guard let foot = overlays(FootView.self).first else { return XCTFail() }
        foot.regen.performClick(nil)
        guard let pv = editor.picker else { return XCTFail("the selector under Regenerate") }
        if h.models!.providers.count > 1 {
            pv.mouseDown(with: NSEvent.mouseEvent(with: .leftMouseDown, location: pv.convert(NSPoint(x: 20, y: 20), to: nil), modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
            XCTAssertTrue(pv.listing, "the provider field opens a list (BartPicker), not a cycle")
            let second = h.models!.providers[1].key
            pv.mouseDown(with: NSEvent.mouseEvent(with: .leftMouseDown, location: pv.convert(NSPoint(x: 20, y: 44 + 4 + 32 + 16), to: nil), modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
            XCTAssertEqual(pv.provider, second)
            XCTAssertFalse(pv.listing)
        }
        pv.onSend?()
        XCTAssertEqual(h.asks.count, 1, "its blue button asks again")
        XCTAssertNil(editor.picker)
        foot.regen.performClick(nil)
        if let pv2 = overlays(FootView.self).first { pv2.regen.performClick(nil) }
        XCTAssertNotNil(editor.picker)
        press("\u{1B}", code: 53)
        XCTAssertNil(editor.picker, "Escape shuts the selector only")
    }

    func testScrollPositionReportedAndRestored() {
        open((0..<200).map { "line \($0)" })
        editor.viewScope = "w1"
        editor.scrollTo(y: 900)
        editor.reportView(now: true)
        guard let pos = host.reports.last else { return XCTFail("reported") }
        XCTAssertGreaterThan(pos.line ?? 0, 10)
        XCTAssertEqual(pos.hash, EditorText.hashLine("line \(pos.line!)"))
        editor.scrollTo(y: 0)
        editor.applyView(pos)
        XCTAssertEqual(editor.captureView().line, pos.line, "back to the same first line")
    }
}
