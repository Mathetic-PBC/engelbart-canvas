import XCTest
@testable import EngelbartDoc

// test/doc-model.test.cjs, ported.

func P(_ type: LineType, _ text: String, depth: Int = 0, done: Bool = false, num: Int? = nil, delim: String? = nil, level: Int = 0) -> ParsedLine {
    var p = ParsedLine(type: type, text: text)
    p.depth = depth; p.done = done; p.num = num; p.delim = delim; p.level = level
    return p
}

final class DocModelTests: XCTestCase {
    func testPlaceAnswer() {
        let doc = "Plan.\n@bart --build add a hello comment\nbart~> ab12\nAfter."
        XCTAssertEqual(Doc.placeAnswer(doc, "ab12", [Doc.buildLine("0123456789")]), "Plan.\n@bart --build add a hello comment\nbuild> 0123456789\nAfter.")
        XCTAssertEqual(Doc.placeAnswer("@bart --build\nbart~> ab12", "ab12", ["bart> **No Build.** Write what to build after --build."]), "@bart --build\nbart> **No Build.** Write what to build after --build.")
        XCTAssertEqual(Doc.placeAnswer(doc, "ab12", []), "Plan.\n@bart --build add a hello comment\nAfter.")
        XCTAssertNil(Doc.placeAnswer("Plan.", "ab12", ["x"]))
    }

    func testTaskAndBullet() {
        XCTAssertEqual(Doc.parseLine("  - [x] a"), P(.todo, "a", depth: 1, done: true))
        XCTAssertEqual(Doc.parseLine("- [ ] open"), P(.todo, "open"))
        XCTAssertEqual(Doc.parseLine("- []"), P(.todo, ""))
        XCTAssertEqual(Doc.parseLine("- [] buy milk"), P(.todo, "buy milk"))
        XCTAssertEqual(Doc.parseLine("- []one"), P(.list, "[]one"), "the checkbox needs its space")
        XCTAssertEqual(Doc.parseLine("- [x]done"), P(.list, "[x]done"))
        XCTAssertEqual(Doc.parseLine("- plain dash"), P(.list, "plain dash"))
        XCTAssertEqual(Doc.parseLine("                    - [ ] deep").depth, 8)
        XCTAssertEqual(Doc.parseLine("  - two"), P(.list, "two", depth: 1))
        XCTAssertEqual(Doc.parseLine("* star"), P(.list, "star"))
        XCTAssertEqual(Doc.parseLine("- "), P(.list, ""))
        XCTAssertEqual(Doc.parseLine("-no space"), P(.p, "-no space"))
        XCTAssertEqual(Doc.listLine(2, "x"), "    - x")
        XCTAssertEqual(Doc.parseLine(Doc.listLine(3, "round trip")), P(.list, "round trip", depth: 3))
    }

    func testNumbered() {
        XCTAssertEqual(Doc.parseLine("1. one"), P(.list, "one", num: 1, delim: "."))
        XCTAssertEqual(Doc.parseLine("  12) twelve"), P(.list, "twelve", depth: 1, num: 12, delim: ")"))
        XCTAssertEqual(Doc.parseLine("3. "), P(.list, "", num: 3, delim: "."))
        XCTAssertEqual(Doc.parseLine("1.no space"), P(.p, "1.no space"))
        XCTAssertEqual(Doc.parseLine("1.5 litres"), P(.p, "1.5 litres"))
        XCTAssertEqual(Doc.listLine(1, "x", 4, ")"), "  4) x")
        XCTAssertEqual(Doc.listMark(Doc.parseLine("7) x")), "7)")
        XCTAssertEqual(Doc.listMark(Doc.parseLine("- x")), "\u{2022}")
        var p = Doc.parseLine("2) b")
        XCTAssertEqual(Doc.sameLine(p, "changed"), "2) changed")
        p.num = 3
        XCTAssertEqual(Doc.sameLine(p, ""), "3) ")
        XCTAssertEqual(Doc.canonicalLine("1) x"), "1) x")
        XCTAssertEqual(Doc.retypedRow(Doc.parseLine("- "), "1. first")?.line, "1. first")
        XCTAssertEqual(Doc.retypedRow(Doc.parseLine("- "), "1. first")?.ate, 3)
        XCTAssertEqual(Doc.selectionHtml("1. a\n2) b"), "1. a<br>2) b")
        XCTAssertEqual(Inline.replyRawOffset(P(.reply, "10. abc"), 4), 5)
    }

    func testTaskGoneAndCanonical() {
        XCTAssertEqual(Doc.parseLine("@Task write the paper"), P(.p, "@Task write the paper"))
        XCTAssertEqual(Doc.canonicalLine("@Task x"), "@Task x")
        XCTAssertEqual(Doc.canonicalLine("- [] x"), "- [ ] x")
        XCTAssertEqual(Doc.canonicalLine("- [x] done"), "- [x] done")
        XCTAssertEqual(Doc.canonicalLine("* star"), "- star")
        XCTAssertEqual(Doc.canonicalLine("hello"), "hello")
    }

    func testRetypedRow() {
        let bullet = Doc.parseLine("- ")
        func r(_ p: ParsedLine, _ t: String) -> [String]? { Doc.retypedRow(p, t).map { [$0.line, String($0.ate)] } }
        XCTAssertEqual(r(bullet, "- [ ] real work"), ["- [ ] real work", "6"])
        XCTAssertNil(r(bullet, "@Task real work"))
        XCTAssertEqual(r(bullet, "- nested?"), ["- nested?", "2"])
        XCTAssertEqual(r(bullet, "- []"), ["- [ ] ", "4"])
        XCTAssertEqual(r(bullet, "- []one"), ["- []one", "2"])
        let task = Doc.parseLine("- [ ] ")
        XCTAssertEqual(r(task, "- []one"), ["- []one", "2"])
        XCTAssertNil(r(task, "plain"))
        let nested = Doc.parseLine("  - [ ] ")
        XCTAssertEqual(r(nested, "- [x] done"), ["  - [x] done", "6"])
        XCTAssertEqual(r(nested, "- a bullet"), ["  - a bullet", "2"])
    }

    func testParseLineKinds() {
        XCTAssertEqual(Doc.parseLine("## Title"), P(.h, "Title", level: 2))
        XCTAssertEqual(Doc.parseLine("#### not a heading"), P(.p, "#### not a heading"))
        XCTAssertEqual(Doc.parseLine("@chat hi there"), P(.bart, "hi there"))
        var router = P(.bart, "hi there"); router.agent = "router"
        XCTAssertEqual(Doc.parseLine("@bart hi there"), router)
        XCTAssertEqual(Doc.parseLine("@bart").agent, "router")
        XCTAssertEqual(Doc.parseLine("> quoted"), P(.quote, "quoted"))
        XCTAssertEqual(Doc.parseLine(">tight"), P(.quote, "tight"))
        let img = Doc.parseLine("![alt](https://x.y/z.png)")
        XCTAssertEqual([img.type.rawValue, img.text, img.src], ["img", "alt", "https://x.y/z.png"])
        XCTAssertEqual(Doc.parseLine(""), P(.p, ""))
        XCTAssertEqual(Doc.todoLine(2, false, "x"), "    - [ ] x")
        XCTAssertEqual(Doc.todoLine(0, true, "done"), "- [x] done")
    }

    func testInlineSplit() {
        XCTAssertEqual(Inline.tokens("a **b** @[n] [l](u)"), ["a ", "**b**", " ", "@[n]", " ", "[l](u)"])
        XCTAssertEqual(Inline.tokens("@bart hi"), ["@bart", " hi"])
        XCTAssertEqual(Inline.tokens("@bartty"), ["@bartty"])
        XCTAssertEqual(Inline.tokens("*i* `c`"), ["*i*", " ", "`c`"])
        XCTAssertEqual(Inline.tokens("see https://example.com/a_b?q=1#x, then"), ["see ", "https://example.com/a_b?q=1#x", ", then"])
        XCTAssertEqual(Inline.tokens("read https://example.com/paper.pdf."), ["read ", "https://example.com/paper.pdf", "."])
        XCTAssertEqual(Inline.tokens("(https://example.com)"), ["(", "https://example.com", ")"])
        XCTAssertEqual(Inline.tokens("see @[A](lib:x-1) now"), ["see ", "@[A](lib:x-1)", " now"])
        XCTAssertEqual(Inline.tokens("@[A](lib:x-1)@[B](ws:y-2) @[C] [l](u)"), ["@[A](lib:x-1)", "@[B](ws:y-2)", " ", "@[C]", " ", "[l](u)"])
        XCTAssertEqual(Inline.tokens("@[A](lib:not an id)"), ["@[A]", "(lib:not an id)"])
        XCTAssertEqual(Inline.tokens("@Discover `@bart` x"), ["@Discover", " ", "`@bart`", " x"])
        XCTAssertEqual(Inline.tokens("@Orient hi"), ["@Orient", " hi"])
        XCTAssertEqual(Inline.tokens("@Brainstorm here"), ["@Brainstorm", " here"])
    }

    func testTokShown() {
        func t(_ s: String) -> [String] { let r = Inline.tokShown(s); return [r.shown, String(r.pre), r.unit ? "u" : ""] }
        XCTAssertEqual(t("**bold**"), ["bold", "2", ""])
        XCTAssertEqual(t("*it*"), ["it", "1", ""])
        XCTAssertEqual(t("`c`"), ["c", "1", ""])
        XCTAssertEqual(t("@[hypocompass]"), ["@hypocompass", "1", ""])
        XCTAssertEqual(t("@[bart:x]"), ["@bart", "1", ""])
        XCTAssertEqual(t("[text](https://a.b)"), ["text", "1", ""])
        XCTAssertEqual(t("plain"), ["plain", "0", ""])
        XCTAssertEqual(t("@bart"), ["@bart", "0", ""])
        XCTAssertEqual(t("https://example.com"), ["https://example.com", "0", ""])
        XCTAssertEqual(t("**[A paper](https://x.org)**"), ["A paper", "2", ""])
        XCTAssertEqual(t("@[A paper](lib:x-1)"), ["@A paper", "1", ""])
        XCTAssertEqual(t("![Attachment 1](img:0a1b2c3d-0000-4000-8000-000000000000)"), ["[Attachment 1]", "1", "u"])
    }

    func testTokensOf() {
        XCTAssertEqual(Inline.tokensOf(Doc.parseLine("## A **b**"), "## A **b**"), ["## ", "A ", "**b**"])
        XCTAssertEqual(Inline.tokensOf(Doc.parseLine("> q *i*"), "> q *i*"), ["> ", "q ", "*i*"])
        XCTAssertEqual(Inline.tokensOf(Doc.parseLine(">q"), ">q"), [">", "q"])
        XCTAssertEqual(Inline.tokensOf(Doc.parseLine("- [ ] t @[x]"), "- [ ] t @[x]"), ["t ", "@[x]"])
        XCTAssertEqual(Inline.tokensOf(Doc.parseLine("- t @[x]"), "- t @[x]"), ["t ", "@[x]"])
        XCTAssertEqual(Inline.tokensOf(Doc.parseLine("@bart hi"), "@bart hi"), ["@bart", " hi"])
    }

    func testRawOffset() {
        let p = Doc.parseLine("hello **world** x")
        XCTAssertEqual(Inline.rawOffset(p, 0), 0)
        XCTAssertEqual(Inline.rawOffset(p, 6), 6)
        XCTAssertEqual(Inline.rawOffset(p, 8), 10)
        XCTAssertEqual(Inline.rawOffset(p, 11), 13)
        XCTAssertEqual(Inline.rawOffset(p, 13), 17)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("## Title"), 2), 5)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("## Title"), 0), 3)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("see @[hypocompass] now"), 6), 7)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("see @[hypocompass] now"), 16), 18)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("see @[hypocompass] now"), 4), 4)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine(">q"), 1, line: ">q"), 2)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("> q"), 1, line: "> q"), 3)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("@bart hello"), 8, line: "@bart hello"), 8)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("- [ ] a **b**"), 2, line: "- [ ] a **b**"), 2)
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("- a **b**"), 2, line: "- a **b**"), 2)
        let token = "![Attachment 1](img:0a1b2c3d-0000-4000-8000-000000000000)"
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("fix \(token) now"), "fix [Atta".len), "fix \(token)".len)
        let todo = Doc.parseLine("- [ ] fix \(token) now")
        XCTAssertEqual(Inline.rawOffset(todo, "fix [Attachment 1] now".len), "fix \(token) now".len)
        let todo2 = Doc.parseLine("- [ ] open https://example.com today")
        XCTAssertEqual(Inline.rawOffset(todo2, "open https://example.com today".len), todo2.text.len)
        let ws = Inline.wsMention("Pulling [in] workspaces", "0a1b2c3d-0000-4000-8000-000000000000")
        XCTAssertEqual(ws, "@[Pulling in workspaces](ws:0a1b2c3d-0000-4000-8000-000000000000)")
        let wp = Doc.parseLine("- \(ws) next")
        XCTAssertEqual(Inline.rawOffset(wp, "@Pulling in workspaces next".len), "\(ws) next".len)
        XCTAssertEqual(Inline.rawOffset(wp, 2), 3)
        let lt = "@[A paper](lib:x-1)"
        XCTAssertEqual(Inline.rawOffset(Doc.parseLine("\(lt) next"), "@A paper next".len), "\(lt) next".len)
    }

    func testAnswerLine() {
        let open = Doc.parseLine("bart> It **is** so"), folded = Doc.parseLine("bart+> It **is** so")
        XCTAssertEqual([open.folded, folded.folded], [false, true])
        XCTAssertTrue(Doc.isDrawn(.reply) && !Doc.isMarked(.reply))
        XCTAssertEqual(Doc.lineText(open, "bart> It **is** so"), "It **is** so")
        XCTAssertEqual(Doc.sameLine(open, "It was"), "bart> It was")
        XCTAssertEqual(Doc.sameLine(folded, "It was"), "bart+> It was")
        XCTAssertEqual(Doc.sameLine(open, "word "), "bart> word ")
        XCTAssertEqual(Doc.parseLine(Doc.replyLine("", false)), P(.reply, ""))
        XCTAssertEqual(Inline.tokensOf(open, "bart> It **is** so"), ["It ", "**is**", " so"])
        XCTAssertEqual(Inline.rawOffset(open, 5, line: "bart> It **is** so"), 7)
        XCTAssertEqual(Inline.replyRawOffset(Doc.parseLine("bart> ## Seen"), 2), 5)
        XCTAssertEqual(Inline.replyRawOffset(Doc.parseLine("bart> - **230** characters"), 1), 2)
        XCTAssertEqual(Inline.replyRawOffset(Doc.parseLine("bart> - **230** characters"), 4), 7)
        XCTAssertEqual(Inline.replyRawOffset(Doc.parseLine("bart>   - nested"), 3), 6)
        XCTAssertEqual(Inline.replyRawOffset(Doc.parseLine("bart> plain **bold**"), 8), 10)
    }

    func testThreads() {
        let doc = ["intro", "@bart --opus why?", "bart> Because.", "bart>", "bart> *Opus · high · 12 s*", "@bart and then?", "bart+> Then this.",
                   "bart+> *Opus · high · 4 s*", "@bart a third", "bart~> k9-x", "", "@bart typed, not sent", "@bart another, right under it", "bart> **No answer.** Codex was not found"]
        let found = Doc.threads(doc)
        XCTAssertEqual(found.map { [$0.from, $0.to, $0.turns.count] }, [[1, 9, 3], [11, 11, 1], [12, 13, 1]])
        XCTAssertEqual(found[0].turns.map { "\($0.q) \($0.from) \($0.to) \($0.answered) \($0.pending ?? "nil") \($0.foot) \($0.folded)" },
                       ["1 2 4 true nil 4 false", "5 6 7 true nil 7 true", "8 9 9 true k9-x -1 false"])
        let t0 = Doc.turnText(doc, found[0].turns[0])
        XCTAssertEqual([t0.question, t0.answer], ["--opus why?", "Because."])
        let t1 = Doc.turnText(doc, found[0].turns[1])
        XCTAssertEqual([t1.question, t1.answer], ["and then?", "Then this."])
        XCTAssertEqual(found[2].turns[0].foot, -1)
        XCTAssertEqual(Doc.turnText(doc, found[2].turns[0]).answer, "**No answer.** Codex was not found")
        XCTAssertEqual(Doc.threads(["bart> orphaned", "text"]).count, 0)
    }

    func testCodeBlocks() {
        let doc = ["intro", "```json", "{", "  # not a heading", "- not a bullet", "@bart not a question", "```", "# a heading", "~~~", "tilde body", "```", "~~~~", "```python", "x = 1"]
        XCTAssertEqual(Doc.codeBlocks(doc).map { "\($0.open) \($0.close) \($0.lang) \($0.fence)" }, ["1 6 json ```", "8 11  ~~~"])
        let ps = Doc.parseLines(doc)
        XCTAssertEqual(ps.map { $0.type.rawValue }, ["p", "fence", "code", "code", "code", "code", "fence", "h", "fence", "code", "code", "fence", "p", "p"])
        XCTAssertTrue(ps[1].open); XCTAssertFalse(ps[6].open)
        XCTAssertEqual(ps[3].text, "  # not a heading")
        XCTAssertEqual(ps[7], Doc.parseLine("# a heading"))
        XCTAssertEqual(Doc.fenceShown(ps[1]), "json"); XCTAssertEqual(Doc.fenceShown(ps[6]), "")
        XCTAssertEqual(Doc.threads(doc).count, 0)
        XCTAssertEqual(Doc.codeBlocks(["```js title", "a", "````"]).map { "\($0.lang) \($0.close)" }, ["js 2"])
        XCTAssertEqual(Doc.codeBlocks(["````", "```", "x"]).count, 0)
        XCTAssertEqual(Doc.codeBlocks(["use ```json``` inline", "x", "```"]).count, 0)
        XCTAssertEqual(Doc.codeBlocks(["    ```", "x", "```"]).count, 0)
    }

    func testHighlight() {
        func plain(_ html: String) -> String {
            Rx(#"<[^>]+>"#).replace(html, with: "").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&amp;", with: "&")
        }
        for line in ["  \"name\": \"Engelbart\", \"n\": -1.5e3, \"ok\": true, \"none\": null,", "{\"a\":[1,2,{\"b\":\"<x> & \\\"y\\\"\"}]}", "  // a jsonc comment", "\"unterminated"] {
            XCTAssertEqual(plain(Doc.highlight(line, "json")), line)
        }
        XCTAssertTrue(Doc.highlight("  \"name\": \"Engelbart\",", "JSON").contains("<span style=\"color:#171717\">&quot;name&quot;</span><span style=\"color:#8f8f8f\">:</span> <span style=\"color:#0761d1\">&quot;Engelbart&quot;</span>"))
        XCTAssertTrue(Doc.highlight("\"n\": 12", "json").contains("<span style=\"color:#4d4d4d\">12</span>"))
        XCTAssertEqual(Doc.highlight("const a = \"<b>\";", "js"), "const a = &quot;&lt;b&gt;&quot;;")
        XCTAssertEqual(Doc.highlight("x", ""), "x")
    }

    func testAnswerCodeBlocks() {
        let doc = ["@bart how?", "bart> Like this:", "bart> ```json", "bart> {", "bart>   \"a\": 1", "bart>", "bart> }", "bart> ```", "bart>", "bart> *Sol · medium · 3 s*", "@bart and ```?", "bart> ```", "bart> *Sol · medium · 2 s*"]
        let ps = Doc.parseLines(doc)
        XCTAssertEqual(ps.map { $0.code?.rawValue ?? $0.type.rawValue }, ["bart", "reply", "open", "body", "body", "body", "body", "close", "reply", "reply", "bart", "reply", "reply"])
        XCTAssertEqual([ps[2].block!.open, ps[2].block!.close], [2, 7])
        XCTAssertEqual(ps[2].lang, "json")
        XCTAssertEqual(ps[4].text, "  \"a\": 1")
        XCTAssertEqual(Doc.fenceShown(ps[2]), "json")
        XCTAssertTrue(Doc.isFence(ps[2]) && Doc.isFence(ps[7]) && Doc.isCode(ps[4]) && !Doc.isCode(ps[1]) && !Doc.isFence(ps[11]))
        let thread = Doc.threads(doc)[0]
        XCTAssertEqual(thread.turns.map { [$0.q, $0.from, $0.to, $0.foot] }, [[0, 1, 9, 9], [10, 11, 12, 12]])
        XCTAssertEqual(Doc.turnText(doc, thread.turns[0]).answer, "Like this:\n```json\n{\n  \"a\": 1\n\n}\n```")
    }

    func testLibMentionTokens() {
        XCTAssertEqual(Inline.LIB_MENTION.match("@[A](lib:x-1)").map { [$0[1]!, $0[2]!] }, ["A", "x-1"])
        XCTAssertEqual(Inline.libMention("Pulling [in]\nworkspaces", "x-1"), "@[Pulling inworkspaces](lib:x-1)")
        XCTAssertEqual(Inline.libMention("  [ ] ", "x-1"), "@[Untitled](lib:x-1)")
        XCTAssertEqual(Inline.libMention(nil, "x-1"), "@[Untitled](lib:x-1)")
    }

    func testNotes() {
        let note = "ab @[A](lib:x) cd"
        XCTAssertEqual(Inline.noteParts(note), ["ab ", "@[A](lib:x)", " cd"])
        XCTAssertEqual(Inline.noteParts("@[A](lib:x)@[B](lib:y)"), ["@[A](lib:x)", "@[B](lib:y)"])
        XCTAssertEqual(Inline.noteOffset(note, 0, 1), 1)
        XCTAssertEqual(Inline.noteOffset(note, 1, 0), "ab @[A](lib:x)".len)
        XCTAssertEqual(Inline.noteOffset(note, 2, 2), "ab @[A](lib:x) c".len)
        XCTAssertEqual(Inline.noteOffset(note, 2, Int.max), note.len)
        XCTAssertEqual(Inline.noteOffset(note, 9, 0), note.len)
        XCTAssertEqual(Inline.noteParts("  @bart hi @[A](lib:x)", agents: true), ["  ", "@bart", " hi ", "@[A](lib:x)"])
    }

    func testMentionAt() {
        func m(_ t: String?, _ c: Int, _ holds: ((String) -> Bool)? = nil) -> String? { Inline.mentionAt(t, c, holds: holds).map { "\($0.query)|\($0.start)" } }
        XCTAssertEqual(m("@", 1), "|0")
        XCTAssertEqual(m("compare with @pla", 17), "pla|13")
        XCTAssertEqual(m("compare with @pla and more", 17), "pla|13")
        XCTAssertEqual(m("mail@host", 9), "host|4")
        XCTAssertEqual(m("@@pl", 4), "pl|1")
        XCTAssertEqual(m("@" + "x".repeated(30), 31), "x".repeated(30) + "|0")
        for (text, caret) in [("", 0), ("plain", 5), ("@pla ", 5), ("@[Plan] ", 8), ("@[Pla", 5), ("@pla", 0), ("@" + "x".repeated(31), 32)] {
            XCTAssertNil(m(text, caret), text)
        }
        XCTAssertNil(m(nil, 0))
        let names = ["Meeting with David", "Meeting with Amir", "Plan"]
        let holds = { (q: String) in names.contains { $0.lowercased().contains(q.lowercased()) } }
        XCTAssertEqual(m("see @Meeting with D", 19, holds), "Meeting with D|4")
        XCTAssertEqual(m("@Meeting ", 9, holds), "Meeting |0")
        XCTAssertEqual(m("@pla", 4, holds), "pla|0")
        XCTAssertNil(m("@Plan is to write", 17, holds))
        XCTAssertNil(m("@ Meeting", 9, holds))
        XCTAssertNil(m("@[Meeting with David] and", 25, holds))
        XCTAssertNil(m("@Meeting with D", 15))
    }

    func testFollowUpMentionThread() {
        let ws = Inline.wsMention("Other place", "0a1b2c3d-0000-4000-8000-000000000000")
        let sent = "@chat --opus --high and @[Plan] with \(ws)?"
        XCTAssertEqual(Doc.parseLine(sent), P(.bart, "--opus --high and @[Plan] with \(ws)?"))
        let toks = Inline.tokens(sent)
        XCTAssertTrue(toks.contains("@[Plan]") && toks.contains(ws))
        let doc = ["@chat why?", "bart> Because.", "bart> *Sonnet · high · 3 s*", sent, "bart~> a2", ""]
        XCTAssertEqual(Doc.threads(doc).map { $0.turns.map { $0.q } }, [[0, 3]])
    }

    func testBuildLine() {
        XCTAssertEqual(Doc.buildLine("0123456789"), "build> 0123456789")
        let p = Doc.parseLine("build> 0123456789")
        XCTAssertEqual([p.type.rawValue, p.id, p.text], ["build", "0123456789", ""])
        XCTAssertEqual(Doc.parseLine("build> not-an-id").type, .p)
        XCTAssertEqual(Doc.parseLine("build>0123456789").type, .p)
        XCTAssertEqual(Doc.threads(["@bart why?", "bart> because", "build> 0123456789", "@bart and?"]).map { [$0.from, $0.to] }, [[0, 1], [3, 3]])
        XCTAssertEqual(Doc.parseLines(["```", "build> 0123456789", "```"])[1].type, .code)
    }

    func testAgents() {
        XCTAssertEqual(Doc.parseLine("@brainstorm").agent, "brainstorm")
        XCTAssertEqual(Doc.parseLine("@Brainstorm what about retries?").text, "what about retries?")
        XCTAssertEqual([Doc.agentOf(Doc.parseLine("@chat q")), Doc.agentOf(Doc.parseLine("@bart q")), Doc.agentOf(Doc.parseLine("@brainstorm")), Doc.agentOf(Doc.parseLine("plain"))], ["bart", "router", "brainstorm", "bart"])
        XCTAssertEqual(Doc.parseLine("@brainstorming").type, .p)
        XCTAssertEqual(Doc.parseLine("@orient x").agent, "orient")
        XCTAssertEqual(Doc.agentOf(Doc.parseLine("@Orient")), "brainstorm")
        XCTAssertEqual(Doc.parseLine("@orientation x").type, .p)
        XCTAssertTrue(Inline.AGENT_TOKEN.test("@orient") && Inline.AGENT_TOKEN.test("@Orient"))
        XCTAssertEqual(Doc.agentOf(Doc.parseLine("@discovery x")), "bart")
        let doc = ["@brainstorm", "bart> ```json", "bart> {", "bart>   \"card\": \"focus\"", "bart> }", "bart> ```", "bart>", "bart> *Sonnet · high · 3 s*", "@brainstorm picked \"Retries\"", "bart~> k2", ""]
        let thread = Doc.threads(doc)[0]
        XCTAssertEqual(thread.turns.map { "\($0.q) \($0.from) \($0.to) \($0.foot) \($0.pending ?? "nil")" }, ["0 1 7 7 nil", "8 9 9 -1 k2"])
        XCTAssertEqual(Doc.turnText(doc, thread.turns[0]).answer, "```json\n{\n  \"card\": \"focus\"\n}\n```")
        XCTAssertEqual(Doc.threads(["@bart why?", "bart> because", "@brainstorm", "bart~> k3"]).map { [$0.from, $0.to, $0.turns.count] }, [[0, 1, 1], [2, 3, 1]])
        let card = ["bart> ```json", "bart> {\"say\": \"\", \"card\": \"questions\", \"questions\": {\"items\": [{\"id\": \"know\", \"type\": \"open\", \"title\": \"K?\"}]}, \"ready\": false}", "bart> ```", "bart>", "bart> *3 s*"]
        let mixed = ["@brainstorm"] + card + ["@orient metacognition"] + card + ["@brainstorm people overrate what they learn", "bart~> a1"]
        XCTAssertEqual(Doc.threads(mixed).map { [$0.from, $0.turns.count] }, [[0, 1], [6, 2]])
        let own = ["@orient metacognition"] + card + ["@orient people overrate it"] + card + ["@brainstorm (wrap up)", "bart~> a3"]
        XCTAssertEqual(Doc.threads(own).map { $0.turns.count }, [3])
        XCTAssertEqual(Doc.threads(["@bart why?", "bart> because", "@orient x", "bart~> a4"]).map { $0.from }, [0, 2])
        XCTAssertEqual(Doc.threads(["@discover agents", "bart> ## Start here", "bart> *Opus · high · 90 s*", "@discover only after 2022", "bart~> k4"]).map { $0.turns.count }, [2])
    }

    func testDifferentAgents() {
        let card = ["bart> ```json", "bart> {", "bart>   \"card\": \"focus\"", "bart> }", "bart> ```", "bart>", "bart> *Sonnet · high · 3 s*"]
        let mixed = Doc.threads(["@brainstorm"] + card + ["@discover retry loops", "bart~> d1", ""])
        XCTAssertEqual(mixed.map { [$0.from, $0.to, $0.turns.count] }, [[0, 7, 1], [8, 9, 1]])
        for agent in ["bart", "brainstorm", "discover"] {
            let doc = ["@\(agent) first", "bart> one", "bart> *Opus · high · 4 s*", "@\(agent) again", "bart> two", "bart> *Opus · high · 3 s*", "@\(agent) once more", "bart~> \(agent)3"]
            XCTAssertEqual(Doc.threads(doc).map { $0.turns.map { $0.q } }, [[0, 3, 6]], agent)
        }
        XCTAssertEqual(Doc.threads(["@bart a", "bart> b", "@bart c", "bart> d", "@discover e", "bart~> f", "@bart g"]).map { $0.turns.map { $0.q } }, [[0, 2], [4], [6]])
        let chat = ["@chat why?", "bart> because", "bart> *Chat · Sonnet · high · 3 s*"]
        for line in ["@chat x", "@bart x", "@discover x", "@brainstorm x"] {
            XCTAssertEqual(Doc.threads(chat + [line]).map { [$0.from, $0.to, $0.turns.count] }, [[0, 2, 1], [3, 3, 1]], line)
        }
        XCTAssertEqual(Doc.threads(chat + ["@chat x", "bart~> p1"]).map { $0.turns.count }, [2])
        XCTAssertEqual(Doc.threads(chat + ["@bart x", "bart~> p1"]).map { $0.turns.count }, [2])
        XCTAssertEqual(Doc.threads(chat + ["", "@chat x", "bart~> p1"]).map { $0.turns.count }, [1, 1])
        XCTAssertEqual(Doc.threads(chat + ["@discover --research tutors", "bart~> r1"]).map { $0.turns.count }, [2])
    }

    static let COPY_DOC = ["# Reading list", "See [the ROPE paper](https://github.com/mqo00/rope) and https://example.com/docs for setup.", "- first **bold** item",
                           "- second item with [a link](https://openalex.org)", "- [ ] a task for @[Welcome!]", "@bart what is ROPE?", "bart> ## Short answer",
                           "bart> - It is [ROPE](https://github.com/mqo00/rope), a tutor.", "bart> ", "bart> *Sol · medium · 1 s*", "A paragraph with an important word."]

    func testSelectionInOneLine() {
        let D = Self.COPY_DOC
        func at(_ l: Int, _ o: Int) -> DocPoint { DocPoint(line: l, offset: o) }
        func shownEnd(_ line: String) -> Int {
            let p = Doc.parseLine(line), text = Doc.lineText(p, line)
            return Inline.rawOffset(p, Inline.tokens(text).reduce(0) { $0 + Inline.tokShown($1).shown.len }, line: p.type == .list ? nil : line)
        }
        XCTAssertEqual(Doc.selectionMarkdown(D, at(1, 0), at(1, shownEnd(D[1]))), D[1])
        XCTAssertEqual(shownEnd(D[3]), 24)
        XCTAssertEqual(Doc.selectionMarkdown(D, at(3, 0), at(3, 24)), "second item with [a link](https://openalex.org)")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(10, 20), at(10, 29)), "important")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(1, 9), at(1, 13)), "ROPE")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(1, 21), at(1, 50)), "https://github.com/mqo00/rope")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(1, 13), at(1, 9)), "ROPE")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(10, 4), at(10, 4)), "")
        XCTAssertEqual(Doc.selectionMarkdown(["ask @[Plan](ws:abc123) and @[Note] now"], at(0, 0), at(0, 8)), "ask @[Plan](ws:abc123)")
        XCTAssertEqual(Doc.selectionMarkdown(["ask @[Plan](ws:abc123) and @[Note] now"], at(0, 10), at(0, 38)), " and @[Note] now")
        XCTAssertEqual(Doc.selectionMarkdown(["```js", "const a = [x](y);", "```"], at(1, 6), at(1, 14)), "a = [x](")
    }

    func testSelectionAcrossLines() {
        let D = Self.COPY_DOC
        func at(_ l: Int, _ o: Int) -> DocPoint { DocPoint(line: l, offset: o) }
        XCTAssertEqual(Doc.selectionMarkdown(D, at(0, 2), at(10, 35)), ["# Reading list", D[1], "- first **bold** item", "- second item with [a link](https://openalex.org)", "- [ ] a task for @[Welcome!]",
            "@bart what is ROPE?", "## Short answer", "- It is [ROPE](https://github.com/mqo00/rope), a tutor.", "", "A paragraph with an important word."].joined(separator: "\n"))
        XCTAssertEqual(Doc.selectionMarkdown(D, at(1, 9), at(3, 6)), "[ROPE paper](https://github.com/mqo00/rope) and https://example.com/docs for setup.\n- first **bold** item\n- second")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(2, 10), at(3, 6)), "**ld** item\n- second")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(2, 0), at(3, 24)), "- first **bold** item\n- second item with [a link](https://openalex.org)")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(3, 24), at(4, 6)), "\n- [ ] a task")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(2, 0), at(3, 0)), "- first **bold** item\n")
        XCTAssertEqual(Doc.selectionMarkdown(D, at(6, 0), at(9, 0)), "## Short answer\n- It is [ROPE](https://github.com/mqo00/rope), a tutor.\n")
        let doc = ["@bart q", "bart+> one [x](https://x.y)", "bart+> *Opus · 2 s*", "build> 0123456789", "@bart again", "bart~> k1", "end"]
        XCTAssertEqual(Doc.selectionMarkdown(doc, at(0, 0), at(6, 3)), "@bart q\none [x](https://x.y)\n@bart again\nend")
        XCTAssertEqual(Doc.selectionMarkdown(doc, at(6, 3), at(0, 0)), "@bart q\none [x](https://x.y)\n@bart again\nend")
        XCTAssertEqual(Doc.selectionMarkdown(["```js", "const a = [x](y);", "```", "after"], at(0, 0), at(3, 5)), "```js\nconst a = [x](y);\n```\nafter")
        XCTAssertEqual(Doc.selectionMarkdown(["see @[Plan](ws:abc123) now", "and @[Note]"], at(0, 4), at(1, 11)), "@[Plan](ws:abc123) now\nand @[Note]")
    }

    func testSelectionHtml() {
        XCTAssertEqual(Doc.selectionHtml("See [a](https://a.b) and https://c.d/e, **bold [L](https://l.m)** *it* `c<d>` @[Plan] @[Space](ws:w1) ![Attachment 1](img:abc)"),
            "See <a href=\"https://a.b\">a</a> and <a href=\"https://c.d/e\">https://c.d/e</a>, <strong>bold <a href=\"https://l.m\">L</a></strong> <em>it</em> <code>c&lt;d&gt;</code> Plan Space ")
        XCTAssertEqual(Doc.selectionHtml("# Head\n- one\n  - [x] two\n- [ ] three\n\n```\n  code <b>\n```\n![pic](https://x.y/p.png)\n![Attachment 2](img:def)\n> quoted"),
            "<strong>Head</strong><br>• one<br>&nbsp;&nbsp;&nbsp;&nbsp;☑ two<br>☐ three<br><br><code>&nbsp;&nbsp;code &lt;b&gt;</code><br><a href=\"https://x.y/p.png\">pic</a><br>&gt; quoted")
        XCTAssertEqual(Doc.selectionHtml("[click](javascript:alert) [x](ws:abc) [m](mailto:a@b.c)"), "click x <a href=\"mailto:a@b.c\">m</a>")
        XCTAssertEqual(Doc.selectionHtml("[q](https://a.b/?q=\"x\"&y=1)"), "<a href=\"https://a.b/?q=&quot;x&quot;&amp;y=1\">q</a>")
    }

    func testWithLinks() {
        XCTAssertEqual(Doc.withLinks("Read the OpenAlex docs and the ROPE repo.", [("OpenAlex docs", "https://docs.openalex.org/"), ("ROPE repo", "https://github.com/mqo00/rope")]),
            "Read the [OpenAlex docs](https://docs.openalex.org/) and the [ROPE repo](https://github.com/mqo00/rope).")
        XCTAssertEqual(Doc.withLinks("here and here", [("here", "https://a.b"), ("here", "https://c.d")]), "[here](https://a.b) and [here](https://c.d)")
        XCTAssertEqual(Doc.withLinks("a cat sat", [("at", "https://a.b")]), "a cat sat")
        XCTAssertEqual(Doc.withLinks("see Python (programming language).", [("Python (programming language)", "https://en.wikipedia.org/wiki/Python_(programming_language)")]),
            "see [Python (programming language)](https://en.wikipedia.org/wiki/Python_%28programming_language%29).")
        XCTAssertEqual(Doc.withLinks("OpenAlex\ndocs", [("OpenAlex\n  docs", "https://x.y")]), "OpenAlex\ndocs")
        XCTAssertEqual(Doc.withLinks("the OpenAlex docs", [("OpenAlex\n  docs", "https://x.y")]), "the [OpenAlex docs](https://x.y)")
        let plain = "https://x.y/ and [1] and mail and wiki and gone"
        XCTAssertEqual(Doc.withLinks(plain, [("https://x.y/", "https://x.y"), ("[1]", "https://x.y/#1"), ("mail", "mailto:a@b.c"), ("wiki", "/wiki/X"), ("", "https://img.y"), ("missing", "https://m.y")]), plain)
    }

    func testFlattenPaste() {
        XCTAssertEqual(Doc.flattenPaste("one\ntwo\nthree"), "one two three")
        XCTAssertEqual(Doc.flattenPaste("one\n\ntwo\n\n\n\nthree"), "one two three")
        XCTAssertEqual(Doc.flattenPaste("one\r\ntwo\r\n\r\nthree"), "one two three")
        XCTAssertEqual(Doc.flattenPaste("one\rtwo"), "one two")
        XCTAssertEqual(Doc.flattenPaste("  \n one\ntwo  \n\n"), "one two")
        XCTAssertEqual(Doc.flattenPaste("def f():\n\treturn 1\n\t\tdone"), "def f(): return 1 done")
        XCTAssertEqual(Doc.flattenPaste("\tone\ttwo\t\n"), "one\ttwo")
        XCTAssertEqual(Doc.flattenPaste("a  b\nc"), "a  b c")
        XCTAssertEqual(Doc.flattenPaste("\n\n \t\n"), "")
    }

    func testTitles() {
        let t = Doc.parseLine("bart# Retry logic in the client")
        XCTAssertEqual([t.type.rawValue, t.text, "\(t.folded)"], ["title", "Retry logic in the client", "false"])
        XCTAssertTrue(Doc.parseLine("bart#+ Retry logic").folded)
        XCTAssertEqual(Doc.parseLine("bart#").text, "")
        XCTAssertEqual(Doc.titleLine("A title", folded: false), "bart# A title")
        XCTAssertEqual(Doc.titleLine("A title", folded: true), "bart#+ A title")
        XCTAssertEqual(Doc.parseLine("# bart").type, .h)
        let lines = ["Notes", "bart# Retry logic", "@chat why retry?", "bart> because", "@chat and timeouts?", "bart> those too", "", "@discover old thread", "bart> a guide", "", "bart#+ Folded one", "@brainstorm", "bart> {}"]
        let ts = Doc.threads(lines)
        XCTAssertEqual([ts[0].from, ts[0].titleLine], [2, 1]); XCTAssertEqual(ts[0].title, "Retry logic"); XCTAssertEqual(ts[0].agent, "bart"); XCTAssertEqual(ts[0].turns.count, 2)
        XCTAssertEqual(ts[1].titleLine, -1); XCTAssertNil(ts[1].title); XCTAssertEqual(ts[1].agent, "discover")
        XCTAssertEqual(ts[2].titleLine, 10); XCTAssertTrue(ts[2].folded); XCTAssertEqual(ts[2].agent, "brainstorm")
        let ps = Doc.parseLines(["bart# Left behind", "just a line", "bart# Also alone"])
        XCTAssertEqual(ps[0], P(.p, "bart# Left behind"))
        XCTAssertEqual(Doc.threads(["@bart a", "bart> one", "bart# New one", "@bart b", "bart> two"]).map { $0.title ?? "-" }, ["-", "New one"])

        let meta = Doc.parseLine("bart# [discover 2026-10-12T21:41:00Z] Papers on tutors")
        XCTAssertEqual([meta.text, meta.agent ?? "", meta.at ?? ""], ["Papers on tutors", "discover", "2026-10-12T21:41:00Z"])
        let b = Doc.parseLine("bart#+ [chat build 2026-10-12T21:41:00Z] Retry check")
        XCTAssertEqual([b.agent ?? "", "\(b.build)", "\(b.folded)"], ["bart", "true", "true"])
        XCTAssertEqual(Doc.parseLine("bart# [not a meta] A title").text, "[not a meta] A title")
        XCTAssertEqual(Doc.titleLine("Papers", folded: true, meta: TitleMeta(text: "", agent: "discover", at: "2026-10-12T21:41:00Z")), "bart#+ [discover 2026-10-12T21:41:00Z] Papers")
        XCTAssertEqual(Doc.titleLine("", folded: false, meta: TitleMeta(text: "", agent: "bart", at: "2026-10-12T21:41:00Z", build: true)), "bart# [chat build 2026-10-12T21:41:00Z] ")
        let routed = ["bart# [discover 2026-10-12T21:41:00Z] Papers", "@bart papers on tutors?", "bart> a guide", "bart> *Discover · Opus · high · 9 s*", "@bart and more?", "bart~> run2"]
        let th = Doc.threads(routed)[0]
        XCTAssertEqual([th.asked, th.routedTo ?? "", th.agent, Doc.answeredBy(th), th.at ?? "", "\(th.turns.count)"], ["router", "discover", "discover", "discover", "2026-10-12T21:41:00Z", "2"])
        XCTAssertEqual(Doc.threads(Array(routed.prefix(4)) + ["@bart and more?"])[0].turns.count, 1)
        XCTAssertEqual(Doc.answeredBy(Doc.threads(["@bart pending", "bart~> x"])[0]), "router")
        XCTAssertEqual(Doc.placeTitle(["bart# [discover 2026-10-12T21:41:00Z] ", "@bart papers?", "bart~> a1"].joined(separator: "\n"), "a1", "Papers")?.jsSplit("\n")[0], "bart# [discover 2026-10-12T21:41:00Z] Papers")
        XCTAssertEqual(Doc.migrateChatLines(routed.joined(separator: "\n")).count, 0)
        XCTAssertEqual(Doc.migrateChatLines("@bart old question\nbart> answer").count, 1)
        XCTAssertEqual(Doc.migrateChatLines("@Bart old question\nbart> answer").text, "@Chat old question\nbart> answer")
    }

    func testWhenShown() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = .current
        func d(_ y: Int, _ mo: Int, _ day: Int, _ h: Int, _ mi: Int) -> Date { cal.date(from: DateComponents(year: y, month: mo, day: day, hour: h, minute: mi))! }
        func iso(_ x: Date) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: x) }
        let now = d(2026, 10, 12, 23, 0)
        XCTAssertEqual(Doc.whenShown(iso(d(2026, 10, 12, 21, 41)), now: now, calendar: cal), "9:41 PM")
        XCTAssertEqual(Doc.whenShown(iso(d(2026, 10, 12, 0, 5)), now: now, calendar: cal), "12:05 AM")
        XCTAssertEqual(Doc.whenShown(iso(d(2026, 10, 11, 9, 0)), now: now, calendar: cal), "Yesterday")
        XCTAssertEqual(Doc.whenShown(iso(d(2026, 10, 8, 9, 0)), now: now, calendar: cal), "Thursday")
        XCTAssertEqual(Doc.whenShown(iso(d(2026, 9, 3, 9, 0)), now: now, calendar: cal), "Sep 3")
        XCTAssertEqual(Doc.whenShown(iso(d(2025, 9, 3, 9, 0)), now: now, calendar: cal), "Sep 3, 2025")
        XCTAssertEqual(Doc.whenShown(nil, now: now), "")
        XCTAssertEqual(Doc.whenShown("not a time", now: now), "")
    }

    func testPlaceTitle() {
        let doc = ["Notes", "bart# ", "@bart why retry?", "bart~> ask1", "", "bart# ", "@bart other?", "bart~> ask2", ""].joined(separator: "\n")
        XCTAssertEqual(Doc.placeTitle(doc, "ask1", "Retry logic"), ["Notes", "bart# Retry logic", "@bart why retry?", "bart~> ask1", "", "bart# ", "@bart other?", "bart~> ask2", ""].joined(separator: "\n"))
        XCTAssertEqual(Doc.placeTitle(doc, "ask2", "Other"), ["Notes", "bart# ", "@bart why retry?", "bart~> ask1", "", "bart# Other", "@bart other?", "bart~> ask2", ""].joined(separator: "\n"))
        let near = Doc.askedAt(doc, "ask1")!
        XCTAssertEqual([near.question, String(near.index)], ["@bart why retry?", "2"])
        let answered = Doc.placeAnswer(doc, "ask1", ["bart> because", "", "bart> *Sonnet High · 3s*"])!
        let typed = "A line typed above\n\(answered)"
        XCTAssertEqual(Doc.placeTitle(typed, "ask1", "Retry logic", near: near)?.jsSplit("\n").prefix(4).joined(separator: "\n"), ["A line typed above", "Notes", "bart# Retry logic", "@bart why retry?"].joined(separator: "\n"))
        XCTAssertNil(Doc.placeTitle(doc.replacingOccurrences(of: "bart# \n@bart why", with: "bart# Mine\n@bart why"), "ask1", "Retry logic"))
        XCTAssertNil(Doc.placeTitle(doc.replacingOccurrences(of: "bart# \n@bart why", with: "@bart why"), "ask1", "Retry logic"))
        XCTAssertNil(Doc.placeTitle(doc, "ask1", "  "))
        XCTAssertNil(Doc.placeTitle(answered, "ask1", "Retry logic"))
        XCTAssertNil(Doc.placeTitle(doc, "nope", "Retry logic"))
    }

    func testBuildCardThreads() {
        let t = Doc.threads(["bart# [chat build 2026-10-13T09:00:00Z] X", "@bart --build x", "build> abc0123456"])
        XCTAssertEqual(t.count, 1)
        XCTAssertEqual([t[0].from, t[0].to, t[0].titleLine, t[0].turns.count], [1, 2, 0, 1]); XCTAssertTrue(t[0].build)
        XCTAssertEqual(t[0].turns[0].build, "abc0123456"); XCTAssertEqual(t[0].turns[0].foot, -1)
        let c = Doc.threads(["@chat why?", "bart> because", "bart> *Chat · Sonnet · high · 3 s*", "build> abc0123456"])[0]
        XCTAssertEqual([c.to, c.turns.count, c.turns[0].to], [2, 1, 2]); XCTAssertNil(c.turns[0].build)
        let p = Doc.threads(["@bart --build x", "bart~> a1"])
        XCTAssertEqual(p[0].turns[0].pending, "a1"); XCTAssertNil(p[0].turns[0].build)
        XCTAssertEqual(Doc.threads(["@bart --build x", "build> abc0123456", "@chat next?", "bart> ok"]).map { [$0.from, $0.to, $0.titleLine, $0.turns.count] }, [[0, 1, -1, 1], [2, 3, -1, 1]])
    }

    func testRetitleAndTopic() {
        let doc = ["bart# [brainstorm 2026-10-14T09:00:00Z] New conversation", "@bart what to study", "bart> card", ""]
        let near = (question: "@bart what to study", index: 1)
        XCTAssertEqual(Doc.retitle(doc.joined(separator: "\n"), near: near, "Tutoring")?.jsSplit("\n")[0], "bart# [brainstorm 2026-10-14T09:00:00Z] Tutoring")
        XCTAssertNotNil(Doc.retitle(doc.joined(separator: "\n"), near: near, "Tutoring", unset: true), "New conversation counts as unset")
        let named = doc.joined(separator: "\n").replacingOccurrences(of: "New conversation", with: "Mine")
        XCTAssertNil(Doc.retitle(named, near: near, "Tutoring", unset: true))
        XCTAssertNil(Doc.retitle(named, near: near, "Mine"))
        XCTAssertEqual(Doc.topicOfThread(Doc.threads(Doc.lines(named))[0]), "Mine")
        XCTAssertEqual(Doc.topicOfThread(Doc.threads(doc)[0]), "")
    }
}
