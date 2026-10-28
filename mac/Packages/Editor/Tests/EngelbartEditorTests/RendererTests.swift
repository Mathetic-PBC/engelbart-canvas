import XCTest
import AppKit
import EngelbartDoc
@testable import EngelbartEditor

// The drawing of the document (DocEditor lineHtml) and how a drawn line's characters stand for its source
// (segs/displayToRaw/rawToDisplay; test/math.test.cjs, doc-editor-click.test.cjs).

final class RendererTests: XCTestCase {
    func render(_ lines: [String], active: Int? = nil, reveal: (Int, Int) = (-1, -1), canReply: Bool = false) -> (EditorCore, Rendered) {
        let c = EditorCore(docKey: "k", text: lines.joined(separator: "\n"))
        c.activeLine = active
        var ctx = RenderContext()
        ctx.reveal = reveal
        ctx.canReply = canReply
        if canReply { c.hooks.ask = { _ in } }
        return (c, Renderer.render(c, ctx))
    }

    func shown(_ r: Rendered, _ i: Int) -> String { (r.text.string as NSString).substring(with: r.maps[i].range) }

    func testOneParagraphALine() {
        let lines = ["# Title", "- [ ] task **bold**", "  - bullet", "plain [link](https://x.y)", "```json", "{\"a\": 1}", "```", "> quote", ""]
        let (_, r) = render(lines)
        XCTAssertEqual(r.maps.count, lines.count)
        XCTAssertEqual(r.text.string.components(separatedBy: "\n").count, lines.count, "line i of the document is paragraph i")
        XCTAssertEqual(shown(r, 0), "Title", "a heading's # is never shown off the caret's line")
        XCTAssertEqual(shown(r, 1), "task bold", "a row's mark is drawn, never text")
        XCTAssertEqual(shown(r, 3), "plain link")
        XCTAssertEqual(shown(r, 4), "json", "an opening fence shows its language")
        XCTAssertEqual(shown(r, 5), "{\"a\": 1}", "code shows its source")
        XCTAssertEqual(shown(r, 7), "quote")
    }

    func testActiveLineShowsTokensTheCaretTouches() {
        let (_, far) = render(["see **bold** and [l](u) end"], active: 0, reveal: (0, 0))
        XCTAssertEqual(shown(far, 0), "see bold and l end", "nothing touched: drawn")
        let (_, near) = render(["see **bold** and [l](u) end"], active: 0, reveal: (5, 5))
        XCTAssertEqual(shown(near, 0), "see **bold** and l end", "the bold the caret is in opens")
        let (_, h) = render(["## Head"], active: 0, reveal: (4, 4))
        XCTAssertEqual(shown(h, 0), "## Head", "on the caret's line a heading keeps its #")
        let (_, m) = render(["a @[Plan] b"], active: 0, reveal: (9, 9))
        XCTAssertEqual(shown(m, 0), "a @Plan b", "a mention at its end stays drawn (MATH-56)")
        let (_, mi) = render(["a @[Plan] b"], active: 0, reveal: (5, 5))
        XCTAssertEqual(shown(mi, 0), "a @[Plan] b", "strictly inside, it opens")
    }

    func testOffsetsMapBothWays() {
        let (_, r) = render(["hello **world** x"])
        let m = r.maps[0]
        XCTAssertEqual(m.toRaw(0), 0)
        XCTAssertEqual(m.toRaw(8), 10, "hello wo|rld → hello **wo|rld**")
        XCTAssertEqual(m.toRaw(13), 17)
        XCTAssertEqual(m.toDisplay(10), 8)
        let (_, h) = render(["## Title"])
        XCTAssertEqual(h.maps[0].toRaw(2), 5, "a heading's base")
        let (_, mention) = render(["see @[hypocompass] now"])
        XCTAssertEqual(mention.maps[0].toRaw(16), 18, "the end of a mention is the end of its source")
        let line = "a $x^2$ b"
        let (_, math) = render([line])
        let shownMath = MathText.render("x^2", display: false)!
        XCTAssertEqual(math.maps[0].toRaw(3), 7, "within a drawn formula: after it")
        XCTAssertEqual(math.maps[0].toRaw(2), 2)
        XCTAssertEqual(math.maps[0].toDisplay(7), 2 + shownMath.len)
        let (_, img) = render(["![x](img:i)"])
        XCTAssertEqual(img.maps[0].toRaw(1), 11, "a picture: before or after it")
    }

    func testConversationRows() {
        let doc = ["bart# [chat 2026-10-12T21:41:00Z] Retry", "@chat why?", "bart> because", "bart> ", "bart> *Chat · Sonnet · high · 3 s*", "@chat and?", "bart~> run1", ""]
        let (_, r) = render(doc, canReply: true)
        XCTAssertTrue(r.text.attribute(.edHidden, at: r.maps[0].range.location, effectiveRange: nil) != nil || r.maps[0].range.length == 0, "an open conversation's title is not drawn")
        XCTAssertEqual(shown(r, 1), "@bart why?", "a sent question says @bart")
        XCTAssertEqual(shown(r, 2), "because")
        XCTAssertTrue(r.maps[3].widget, "the gap before the foot is not on the page")
        XCTAssertTrue(r.decos.contains { $0.line == 4 && $0.deco == .foot(q: 1, busy: true, plain: false) }, "the closing line is the foot")
        XCTAssertTrue(r.decos.contains { $0.line == 6 && $0.deco == .pending(id: "run1") })
        let folded = ["bart#+ [chat 2026-10-12T21:41:00Z] Retry", "@chat why?", "bart> because", ""]
        let (_, f) = render(folded, canReply: true)
        XCTAssertTrue(f.decos.contains { if case .titleRow(let t, _, _) = $0.deco { return t == "Retry" && $0.line == 0 }; return false })
        XCTAssertTrue(f.maps[1].widget && f.maps[2].widget, "a collapsed conversation's lines are hidden")
        let unasked = ["@chat what now"]
        let (_, u) = render(unasked)
        XCTAssertTrue(u.decos.contains { if case .chip(_, let ready) = $0.deco { return ready }; return false }, "an unasked question has its chip and a send ready")
        let answered = ["@chat q", "bart> a", "bart> *Chat · S · high · 1 s*", ""]
        let (_, a) = render(answered, canReply: true)
        XCTAssertTrue(a.decos.contains { if case .replyField(let from, let lead) = $0.deco { return from == 0 && lead == "@chat" }; return false }, "the reply field under the last turn")
    }

    func testRowsDrawTheirMarks() {
        let (_, r) = render(["- [x] done", "3. third"])
        let mark = r.text.attribute(.edMark, at: r.maps[0].range.location, effectiveRange: nil) as? MarkPaint
        if case .checkbox(let done)? = mark?.kind { XCTAssertTrue(done) } else { XCTFail("a checkbox") }
        XCTAssertNotNil(r.text.attribute(.strikethroughStyle, at: r.maps[0].range.location, effectiveRange: nil), "a done row is struck through")
        let num = r.text.attribute(.edMark, at: r.maps[1].range.location, effectiveRange: nil) as? MarkPaint
        if case .number(let n)? = num?.kind { XCTAssertEqual(n, "3.") } else { XCTFail("a number") }
    }

    func testMathBlockDrawnOutsideTheCaret() {
        let doc = ["Euler:", "```math", "e^{i\\pi} + 1 = 0", "```", "after"]
        let (_, r) = render(doc, active: 4)
        XCTAssertEqual(shown(r, 1), MathText.render("e^{i\\pi} + 1 = 0", display: true))
        XCTAssertNotNil(r.text.attribute(.edHidden, at: r.maps[2].range.location, effectiveRange: nil), "its body hidden")
        let (_, inside) = render(doc, active: 2)
        XCTAssertEqual(shown(inside, 2), "e^{i\\pi} + 1 = 0", "the caret in it: code, as typed")
    }

    func testEditorViewTypesThroughTheModel() {
        let v = DocEditorView(frame: NSRect(x: 0, y: 0, width: 700, height: 500))
        v.setDocument(key: "k", text: "hello")
        XCTAssertEqual(v.textView.string, "hello")
        v.setSelection(DocSelection(line: 0, offset: 5))
        v.typed(" world", replacing: nil)
        XCTAssertEqual(v.core.text, "hello world")
        _ = v.command("Enter")
        XCTAssertEqual(v.core.lines, ["hello world", ""])
        _ = v.command("z", cmd: true)
        XCTAssertEqual(v.core.text, "hello world")
        v.setText("changed outside")
        XCTAssertEqual(v.textView.string, "changed outside")
        XCTAssertEqual(EditorText.hashLine(""), "ztntfp", "FNV-1a offset basis, base 36")
    }
}
