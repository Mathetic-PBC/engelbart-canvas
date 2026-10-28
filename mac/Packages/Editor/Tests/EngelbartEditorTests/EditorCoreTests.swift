import XCTest
import EngelbartCore
import EngelbartDoc
@testable import EngelbartEditor

// The document engine (DocEditor.jsx editorInput/editorKey/askInline/…), driven as test/doc-editor-*.test.cjs drive the
// component: a document, a caret, a key.

final class EditorCoreTests: XCTestCase {
    func core(_ lines: [String], ask: Bool = false) -> (EditorCore, Box) {
        let c = EditorCore(docKey: "k", text: lines.joined(separator: "\n"))
        let box = Box()
        c.hooks.changed = { box.changes.append($0) }
        if ask { c.hooks.ask = { box.asks.append($0) } }
        c.hooks.stopAsk = { box.stopped.append($0) }
        return (c, box)
    }
    final class Box { var changes: [String] = []; var asks: [AskRequest] = []; var stopped: [String] = [] }
    func sel(_ l: Int, _ o: Int) -> DocSelection { DocSelection(line: l, offset: o) }

    // MARK: typing rows (memory note traps)

    func testTypingACheckboxMakesARowAndTheFinishingSpaceIsSwallowed() {
        let (c, _) = core(["- [", "next"])
        c.insert("]", at: sel(0, 3))
        XCTAssertEqual(c.lines[0], "- [ ] ", "`- []` is stored as the row it makes")
        XCTAssertEqual(c.caret, CaretPlace(line: 0, offset: 0), "the caret moves back by the marker difference")
        c.insert(" ", at: sel(0, 0))
        XCTAssertEqual(c.lines[0], "- [ ] ", "the space that finishes a marker is swallowed")
        XCTAssertEqual(c.caret?.a, 0)
        c.insert("buy milk", at: sel(0, 0))
        XCTAssertEqual(c.lines[0], "- [ ] buy milk")
    }

    func testHalfACheckboxIsABullet() {
        let (c, _) = core(["- []"])
        XCTAssertEqual(Doc.parseLine("- []one").type, .list)
        c.typeLine(0, "one", caret: 3)
        XCTAssertEqual(c.lines[0], "- [ ] one")
    }

    func testMarkerTypedIntoAnEmptyBulletRetypesIt() {
        let (c, _) = core(["- "])
        c.typeLine(0, "[ ] ", caret: 4)
        XCTAssertEqual(c.lines[0], "- [ ] ", "`- [ ] ` typed in an empty bullet: bullet's text is `[ ] `, a marker? no — retypedRow needs `- ` lead")
        let (d, _) = core(["- "])
        d.typeLine(0, "- [ ] ", caret: 6)
        XCTAssertEqual(d.lines[0], "- [ ] ")
        XCTAssertEqual(d.caret?.a, 0)
    }

    func testStarBulletIsStoredAsDash() {
        let (c, _) = core([""])
        c.typeLine(0, "* x", caret: 3)
        XCTAssertEqual(c.lines[0], "- x")
        XCTAssertEqual(c.caret?.a, 1, "caret moves back by the marker the row now draws")
    }

    // MARK: Enter

    func testEnterContinuesRows() {
        let (c, _) = core(["- [x] done item"])
        c.key(KeyPress("Enter"), sel: sel(0, 6))
        XCTAssertEqual(c.lines, ["- [x] done i", "- [ ] tem"], "the new row is unchecked")
        XCTAssertEqual(c.caret, CaretPlace(line: 1, offset: 0))
        let (n, _) = core(["2) two"])
        n.key(KeyPress("Enter"), sel: sel(0, 3))
        XCTAssertEqual(n.lines, ["2) two", "3) "], "Enter writes the next number")
    }

    func testEnterOnAnEmptyNestedRowOutdentsBeforeLeaving() {
        let (c, _) = core(["- [ ] a", "  - [ ] "])
        c.key(KeyPress("Enter"), sel: sel(1, 0))
        XCTAssertEqual(c.lines[1], "- [ ] ", "outdented first")
        c.key(KeyPress("Enter"), sel: sel(1, 0))
        XCTAssertEqual(c.lines[1], "", "then a plain line")
    }

    func testEnterAfterAFenceClosesIt() {
        let (c, _) = core(["```json"])
        c.key(KeyPress("Enter"), sel: sel(0, 7))
        XCTAssertEqual(c.lines, ["```json", "", "```"])
        XCTAssertEqual(c.caret, CaretPlace(line: 1, offset: 0))
    }

    func testEnterInCodeKeepsIndent() {
        let (c, _) = core(["```", "  if (x) {", "```"])
        c.key(KeyPress("Enter"), sel: sel(1, 10))
        XCTAssertEqual(c.lines, ["```", "  if (x) {", "    ", "```"])
        XCTAssertEqual(c.caret, CaretPlace(line: 2, offset: 4))
    }

    // MARK: Tab, Backspace, Delete

    func testTabIndentsUnderTheRowAbove() {
        let (c, _) = core(["- a", "- b", "  - c"])
        c.key(KeyPress("Tab"), sel: sel(1, 0))
        XCTAssertEqual(c.lines, ["- a", "  - b", "    - c"], "its nested rows move with it")
        c.key(KeyPress("Tab"), sel: sel(1, 0))
        XCTAssertEqual(c.lines[1], "  - b", "never deeper than one under the row above")
        c.key(KeyPress("Tab", shift: true), sel: sel(1, 0))
        XCTAssertEqual(c.lines, ["- a", "- b", "  - c"])
        let (p, _) = core(["plain"])
        p.key(KeyPress("Tab"), sel: sel(0, 0))
        XCTAssertEqual(p.lines, ["plain"])
        let (code, _) = core(["```", "x", "```"])
        code.key(KeyPress("Tab"), sel: sel(1, 0))
        XCTAssertEqual(code.lines[1], "  x")
        code.key(KeyPress("Tab", shift: true), sel: sel(1, 2))
        XCTAssertEqual(code.lines[1], "x")
    }

    func testBackspaceAtRowStart() {
        let (c, _) = core(["  - [ ] nested", "- [ ] top", "plain", "after"])
        c.key(KeyPress("Backspace"), sel: sel(0, 0))
        XCTAssertEqual(c.lines[0], "- [ ] nested", "nested: outdent")
        c.key(KeyPress("Backspace"), sel: sel(1, 0))
        XCTAssertEqual(c.lines[1], "top", "top level: the mark goes")
        c.key(KeyPress("Backspace"), sel: sel(3, 0))
        XCTAssertEqual(c.lines, ["- [ ] nested", "top", "plainafter"])
        XCTAssertEqual(c.caret, CaretPlace(line: 2, offset: 5))
        let (q, _) = core(["> quoted"])
        q.key(KeyPress("Backspace"), sel: sel(0, 2))
        XCTAssertEqual(q.lines, ["quoted"])
        let (d, _) = core(["one", "two"])
        d.key(KeyPress("Delete"), sel: sel(0, 3))
        XCTAssertEqual(d.lines, ["onetwo"])
    }

    func testBackspaceTakesAWholeMention() {
        let (c, _) = core(["see @[Plan](ws:abc) now"])
        c.key(KeyPress("Backspace"), sel: sel(0, 19))
        XCTAssertEqual(c.lines, ["see  now"])
        c.undo()
        XCTAssertEqual(c.lines, ["see @[Plan](ws:abc) now"], "one undo brings it back")
        c.key(KeyPress("Delete"), sel: sel(0, 4))
        XCTAssertEqual(c.lines, ["see  now"])
    }

    func testFencesAreNotMerged() {
        let (c, _) = core(["text", "```", "x", "```"])
        c.key(KeyPress("Backspace"), sel: sel(1, 0))
        XCTAssertEqual(c.lines.count, 4)
        XCTAssertEqual(c.caret, CaretPlace(line: 0, offset: 4))
    }

    // MARK: locks

    static let THREAD = ["Notes", "@chat why?", "bart> because", "bart> ", "bart> *Chat · Sonnet · high · 3 s*", "", "after"]

    func testAnswersAreLocked() {
        let (c, _) = core(EditorCoreTests.THREAD)
        XCTAssertTrue(c.lockedAt(c.lines, 1), "an asked question")
        XCTAssertTrue(c.lockedAt(c.lines, 2), "an answer line")
        XCTAssertFalse(c.lockedAt(c.lines, 5))
        c.insert("x", at: sel(2, 3))
        XCTAssertEqual(c.lines, EditorCoreTests.THREAD, "typing into an answer does nothing")
        c.key(KeyPress("Backspace"), sel: sel(5, 0))
        XCTAssertEqual(c.lines.count, EditorCoreTests.THREAD.count - 1, "an empty line right after an answer goes away")
    }

    func testDocumentNeverEndsOrStartsOnACard() {
        let (c, b) = core(["@chat q", "bart> a"])
        XCTAssertTrue(c.normalize())
        XCTAssertEqual(c.lines, ["@chat q", "bart> a", ""], "ends on a card: an empty one goes under")
        XCTAssertTrue(c.normalize())
        XCTAssertEqual(c.lines, ["", "@chat q", "bart> a", ""], "starts on a locked line: an empty one goes above")
        XCTAssertFalse(c.normalize())
        XCTAssertEqual(b.changes.count, 2)
    }

    func testSelectAllDeleteTakesWholeConversationsButNotRunningOnes() {
        let (c, _) = core(["a", "@chat q", "bart> x", "", "@chat r", "bart~> run1", "b"])
        c.asks["run1"] = AskProgress()
        c.deleteSelection(DocSelection(anchor: DocPoint(line: 0, offset: 0), focus: DocPoint(line: 6, offset: 1)))
        XCTAssertEqual(c.lines, ["", "@chat r", "bart~> run1"], "the finished conversation goes; the one at work stays")
        XCTAssertTrue(c.normalize())
        XCTAssertEqual(c.lines.last, "", "the draw that follows puts a line of its own under it")
    }

    func testDeleteAcrossJoinsTheEnds() {
        let (c, _) = core(["start here", "@chat q", "bart> x", "end there"])
        c.deleteSelection(DocSelection(anchor: DocPoint(line: 0, offset: 6), focus: DocPoint(line: 3, offset: 4)))
        XCTAssertEqual(c.lines, ["start there"])
        XCTAssertEqual(c.caret, CaretPlace(line: 0, offset: 6))
    }

    func testBlockArmedThenTaken() {
        let (c, _) = core(["@chat q", "bart> x", "", "below"])
        c.key(KeyPress("Backspace"), sel: sel(2, 0))
        XCTAssertNotNil(c.armed, "the first Backspace marks it")
        XCTAssertEqual(c.lines, ["@chat q", "bart> x", "below"], "and the empty line under it goes first")
        c.key(KeyPress("Backspace"), sel: sel(2, 0))
        XCTAssertEqual(c.lines, ["below"])
        c.undo()
        XCTAssertEqual(c.lines, ["@chat q", "bart> x", "below"])
    }

    // MARK: formatting keys and undo

    func testFormattingKeys() {
        let (c, _) = core(["make bold"])
        c.key(KeyPress("b", cmd: true), sel: DocSelection(line: 0, 5, 9))
        XCTAssertEqual(c.lines, ["make **bold**"])
        XCTAssertEqual(c.caret, CaretPlace(line: 0, sel: (7, 11)))
        c.key(KeyPress("z", cmd: true), sel: sel(0, 0))
        XCTAssertEqual(c.lines, ["make bold"])
        c.key(KeyPress("z", shift: true, cmd: true), sel: sel(0, 0))
        XCTAssertEqual(c.lines, ["make **bold**"])
        let (l, _) = core(["go"])
        l.key(KeyPress("k", cmd: true), sel: sel(0, 2))
        XCTAssertEqual(l.lines, ["go[link](url)"])
        XCTAssertEqual(l.caret, CaretPlace(line: 0, sel: (9, 12)))
        let (i, _) = core(["x"])
        i.key(KeyPress("i", cmd: true), sel: DocSelection(line: 0, 0, 1))
        XCTAssertEqual(i.lines, ["*x*"])
    }

    func testUndoKeepsAtMost200() {
        let (c, _) = core([""])
        for n in 0..<210 { c.typeLine(0, String(n), caret: 1) }
        XCTAssertEqual(c.history.count, 200)
    }

    // MARK: paste

    func testPaste() {
        let (c, _) = core(["@bart "])
        c.paste("first\n\nsecond\nthird", at: sel(0, 6))
        XCTAssertEqual(c.lines, ["@bart first second third"], "a question is one line")
        let (l, _) = core(["- a"])
        l.paste("one\ntwo", at: sel(0, 1))
        XCTAssertEqual(l.lines, ["- aone", "two"])
        let (q, _) = core([">"])
        q.paste("\nx\n\ny\n", at: sel(0, 1))
        XCTAssertEqual(q.lines, ["> x", ">", "> y"], "every pasted line stays in the quote")
        let (w, _) = core([""])
        w.paste("Read the OpenAlex docs.", html: "<p>Read the <a href=\"https://docs.openalex.org/\">OpenAlex docs</a>.</p>", at: sel(0, 0))
        XCTAssertEqual(w.lines, ["Read the [OpenAlex docs](https://docs.openalex.org/)."])
        let (pdf, _) = core([""])
        pdf.paste("Large language models have shown remarkable abil-\nities in a wide range of tasks, including the de-\nsign of experiments and so on and so forth.", at: sel(0, 0))
        XCTAssertEqual(pdf.lines.count, 1, "a PDF's layout comes out")
        let (ans, _) = core(EditorCoreTests.THREAD)
        ans.paste("x", at: sel(2, 0))
        XCTAssertEqual(ans.lines, EditorCoreTests.THREAD, "over an answer: nothing")
    }

    func testCopyIsMarkdown() {
        let (c, _) = core(["See [a link](https://x.y) here"])
        let out = c.copy(DocSelection(line: 0, 4, 25))!
        XCTAssertEqual(out.markdown, "[a link](https://x.y)")
        XCTAssertEqual(out.html, "<a href=\"https://x.y\">a link</a>")
    }

    // MARK: pictures

    func testPlaceImage() {
        let (c, _) = core(["- [ ] fix", "", "text"])
        c.placeImage(id: "i1", label: "Attachment 1", at: DocPoint(line: 0, offset: 3))
        XCTAssertEqual(c.lines[0], "- [ ] fix ![Attachment 1](img:i1) ", "inline in a row, a space either side")
        c.placeImage(id: "i2", label: "Attachment 2", at: DocPoint(line: 1, offset: 0))
        XCTAssertEqual(Array(c.lines[1...2]), ["![Attachment 2](img:i2)", ""], "an empty line becomes the picture and an empty line")
        c.placeImage(id: "i3", label: "Attachment 3", at: DocPoint(line: 3, offset: 2))
        XCTAssertEqual(Array(c.lines[3...]), ["text", "![Attachment 3](img:i3)", ""])
        XCTAssertEqual(c.nextAttachmentLabel(), "Attachment 4")
    }

    func testPictureLineKeys() {
        let (c, _) = core(["a", "![x](img:i)", "", "b"])
        c.key(KeyPress("z"), sel: sel(1, 0))
        XCTAssertEqual(c.lines, ["a", "z", "![x](img:i)", "", "b"], "typed before it: a line above")
        c.key(KeyPress("Delete"), sel: sel(2, 11))
        XCTAssertEqual(c.lines, ["a", "z", "![x](img:i)", "b"], "Delete after it takes the empty line next to it")
        c.key(KeyPress("Backspace"), sel: sel(2, 11))
        XCTAssertEqual(c.lines, ["a", "z", "", "b"], "Backspace after it takes the picture, an empty line stays")
        XCTAssertEqual(EditorCore.moveLineTo(["a", "b", "c"], 0, 3), ["b", "c", "a"])
        XCTAssertEqual(EditorCore.imgDropGaps(["x", "@chat q", "bart> a", "y"]), [0, 1, 3, 4], "not inside a conversation (after its question)")
        c.resizeImage(2, width: 1)
        let (r, _) = core(["![Attachment 1|w=10](img:i)"])
        r.resizeImage(0, width: 320)
        XCTAssertEqual(r.lines[0], "![Attachment 1|w=320](img:i)")
    }

    // MARK: asking

    func testAskInlineStartsATitledConversation() {
        let (c, b) = core(["Notes", "@chat why retry?"], ask: true)
        c.askInline(1)
        XCTAssertEqual(b.asks.count, 1)
        let a = b.asks[0]
        XCTAssertEqual([a.text, a.agent, String(a.placeLine)], ["why retry?", "bart", "2"])
        XCTAssertTrue(a.name)
        let ls = c.lines
        XCTAssertTrue(ls[1].hasPrefix("bart# [chat "), ls[1])
        XCTAssertEqual(ls[2], "@chat why retry?")
        XCTAssertEqual(ls[3], "bart~> \(a.askId)")
        XCTAssertEqual(ls.last, "", "a line of the document's own under it")
        XCTAssertNil(c.activeLine)
        XCTAssertTrue(Rx(#"^[0-9a-z]+-[0-9a-z]{8}$"#).test(a.askId))
    }

    func testALineUnderACardStartsItsOwnConversation() {
        let (c, b) = core(["@chat why?", "bart> because", "bart> *Chat · Sonnet · high · 3 s*", "@chat and?"], ask: true)
        c.askInline(3)
        XCTAssertEqual(c.lines[3], "", "an empty line goes in above it")
        XCTAssertEqual(b.asks[0].turns, [], "not a follow-up")
    }

    func testRouterLinesGoThroughTheRouter() {
        let (c, b) = core(["@bart"], ask: true)
        var routed: [RouteRequest] = []
        c.hooks.route = { req, done in routed.append(req); done(RoutePick(agent: "discover", sure: 0.9, by: "model", id: "r1")) }
        c.askInline(0)
        XCTAssertEqual(routed.count, 1)
        XCTAssertEqual(routed[0].rule, Route.Rule(agent: "brainstorm", rule: "empty"))
        XCTAssertEqual(b.asks.first?.agent, "discover")
        XCTAssertTrue(c.lines[0].hasPrefix("bart# [discover "), "the pick is kept on the title line")
        XCTAssertEqual(c.lines[1], "@bart", "the line stays as typed")
    }

    func testRegenerateAndEdit() {
        let doc = ["@chat first?", "bart> one", "bart> *Chat · Sonnet · high · 3 s*", "@chat second?", "bart> two", "bart> *Chat · Opus · low · 2 s*", ""]
        let (c, b) = core(doc, ask: true)
        c.models = .defaults
        c.regenerate(3)
        XCTAssertEqual(c.lines[4], "bart~> \(b.asks[0].askId)")
        XCTAssertEqual(b.asks[0].turns.map { $0.question }, ["first?"])
        let (e, eb) = core(doc, ask: true)
        e.models = .defaults
        e.startEdit(0)
        XCTAssertEqual(e.activeLine, 0)
        XCTAssertFalse(e.lockedAt(e.lines, 0), "being edited, it can be typed in")
        e.typeLine(0, "@chat first, really?", caret: 20)
        e.key(KeyPress("Enter"), sel: sel(0, 20))
        XCTAssertEqual(eb.asks.count, 1)
        XCTAssertEqual(e.lines[0], "@chat first, really?")
        XCTAssertEqual(e.lines[1], "bart~> \(eb.asks[0].askId)")
        XCTAssertFalse(e.lines.contains("@chat second?"), "the turns after it go")
        e.undo()
        XCTAssertEqual(e.lines, doc, "one undo brings it all back")
        let (x, _) = core(doc, ask: true)
        x.startEdit(0)
        x.typeLine(0, "@chat changed", caret: 13)
        x.key(KeyPress("Escape"), sel: sel(0, 13))
        XCTAssertEqual(x.lines, doc, "Escape puts it back")
    }

    func testFollowUpFoldsOlderTurns() {
        let doc = ["@chat a?", "bart> one", "bart> *Chat · S · high · 1 s*", "@chat b?", "bart> two", "bart> *Chat · S · high · 1 s*", "@chat c?", "bart> three", "bart> *Chat · S · high · 1 s*", ""]
        let (c, b) = core(doc, ask: true)
        c.followText[0] = "d?"
        c.sendFollow(0)
        XCTAssertEqual(b.asks.first?.text, "d?")
        XCTAssertEqual(b.asks.first?.turns.count, 3)
        let ls = c.lines
        XCTAssertEqual(ls[1], "bart+> one", "older turns collapse")
        XCTAssertEqual(ls[4], "bart+> two")
        XCTAssertEqual(ls[7], "bart> three", "the newest stays open")
        XCTAssertEqual(Array(ls[9...10]), ["@chat d?", "bart~> \(b.asks[0].askId)"])
        XCTAssertNil(c.followText[0])
    }

    func testFoldingAndTitles() {
        let doc = ["bart# [chat 2026-10-12T21:41:00Z] Retry", "@chat why?", "bart> because", "bart> *Chat · S · high · 1 s*", "", "@chat untitled", "bart> yes", ""]
        let (c, _) = core(doc)
        c.collapseTurn(1)
        XCTAssertEqual(c.lines[0], "bart#+ [chat 2026-10-12T21:41:00Z] Retry", "the first exchange of a titled conversation collapses it whole")
        XCTAssertTrue(c.collapsedOf(c.lines).contains(2))
        c.toggleThread(0)
        XCTAssertEqual(c.lines[0], doc[0])
        c.toggleFold(5)
        XCTAssertEqual(c.lines[6], "bart+> yes")
        c.foldAll(false)
        XCTAssertEqual(c.lines[6], "bart> yes")
        c.foldAll(true)
        XCTAssertTrue(c.lines[0].hasPrefix("bart#+"))
        c.commitTitle(0, "New\nname")
        XCTAssertEqual(c.lines[0], "bart#+ [chat 2026-10-12T21:41:00Z] New name")
        let (a, _) = core(doc)
        a.autoCollapseOn = true
        a.autoCollapse()
        XCTAssertTrue(a.lines[0].hasPrefix("bart#+"), "left open, it collapses when the document is shown")
        a.toggleThread(0)
        a.autoCollapse()
        XCTAssertTrue(a.lines[0].hasPrefix("bart# "), "once per showing")
    }

    func testDeleteTurnAndCopy() {
        let doc = ["bart# T", "@chat --opus why?", "bart> because", "bart> *Chat · Opus · high · 1 s*", "x"]
        let (c, _) = core(doc)
        c.models = .defaults
        XCTAssertEqual(c.copyText(1), "why?\n\nbecause")
        c.deleteTurn(1)
        XCTAssertEqual(c.lines, ["x"], "the last turn takes its title with it")
    }

    func testRemoteChangeKeepsTheCaretLine() {
        let (c, _) = core(["@chat q", "bart~> a1", "", "typing here"])
        c.lastSelection = DocSelection(line: 3, 2, 4)
        c.activeLine = 3
        c.receive(text: ["@chat q", "bart> one", "bart> two", "bart> *x*", "", "typing here"].joined(separator: "\n"))
        XCTAssertEqual(c.caret, CaretPlace(line: 5, sel: (2, 4)))
        XCTAssertEqual(c.activeLine, 5)
    }

    func testMentionPickAndPickModel() {
        let (c, _) = core(["see @pla"])
        var picked: [MenuItem] = []
        c.hooks.mentionPicked = { picked.append($0) }
        c.pickMention(line: 0, start: 4, caretAt: 8, row: Mention.menuItem(LibRow(id: "n", name: "Plan", type: "md", tags: ["note"])))
        XCTAssertEqual(c.lines, ["see @[Plan]"], "a mention: no space after it")
        XCTAssertEqual(picked.count, 1)
        let (v, _) = core(["@br"])
        v.pickMention(line: 0, start: 0, caretAt: 3, row: MenuItem(kind: .verb, key: "verb:brainstorm", name: "Brainstorm", id: "brainstorm"))
        XCTAssertEqual(v.lines, ["@Brainstorm "], "a verb: a space after it")
        let (m, _) = core(["@chat why"])
        m.models = .defaults
        m.pickModel(line: 0, model: "opus", effort: "high")
        XCTAssertEqual(m.lines, ["@chat --opus --high why"])
        let (d, _) = core(["@discover agents"])
        d.models = .defaults
        d.pickLevel(line: 0, mode: "deep", provider: nil)
        XCTAssertEqual(d.lines, ["@discover agents --deep"])
        XCTAssertEqual(d.discoverLabel(0), "Deep")
    }

    func testNoteVerb() {
        let (c, _) = core(["see @Note My plan"])
        c.hooks.noteVerb = { name, done in XCTAssertEqual(name, "My plan"); done("My plan") }
        c.key(KeyPress("Enter"), sel: sel(0, 17))
        XCTAssertEqual(c.lines, ["see @[My plan] "])
    }

    func testRemoveAndToggle() {
        let (c, _) = core(["- [ ] a", "b"])
        c.toggleTodo(0)
        XCTAssertEqual(c.lines[0], "- [x] a")
        c.removeLine(1)
        XCTAssertEqual(c.lines, ["- [x] a"])
        c.removeLine(0)
        XCTAssertEqual(c.lines, [""])
    }
}
