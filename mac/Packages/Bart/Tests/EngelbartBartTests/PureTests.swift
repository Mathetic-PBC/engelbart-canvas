import XCTest
import EngelbartCore
@testable import EngelbartBart

// Ported from test/bart.test.cjs (reply lines, activity, highlights, cards, strip, trace), test/cite.test.cjs and
// test/source-text.test.cjs (passages), test/personality.test.cjs and the prompt tests.

func j(_ text: String) -> JSONValue { OJ.parse(text)!.jsonValue } // a key given twice: the last wins, as in JS

final class PureTests: XCTestCase {
    // MARK: reply.cjs, clip.cjs

    func testReplyLines() {
        let meta = ReplyMeta(provider: "openai", level: .init(name: "Sol", effort: "high"), trail: [.init(name: "Sol", effort: "medium")], ms: 41_400)
        XCTAssertEqual(Reply.attribution(meta), "*Sol · high · 41 s · moved up from Sol medium*")
        XCTAssertEqual(Reply.attribution(meta, model: false), "*41 s*")
        XCTAssertEqual(Reply.attribution(meta, model: false, agent: "brainstorm"), "*Brainstorm · 41 s*")
        var routed = meta; routed.routed = Routed(build: true)
        XCTAssertEqual(Reply.attribution(routed, agent: "bart"), "*Build · Sol · high · 41 s · moved up from Sol medium*")
        XCTAssertEqual(Reply.replyLines("One.", meta, model: false), ["bart> One.", "bart>", "bart> *41 s*"])
        XCTAssertEqual(Reply.replyLines("One.\n\n\n\n## Two  \n> quoted\n- item\r\n", meta), ["bart> One.", "bart>", "bart> ## Two", "bart> quoted", "bart> - item", "bart>", "bart> *Sol · high · 41 s · moved up from Sol medium*"])
        XCTAssertEqual(Reply.replyLines("Use:\n```json\n{\n  \"a\": 1,\n\n\n\n> not a quote\n}\n```\nDone.", nil), ["bart> Use:", "bart> ```json", "bart> {", "bart>   \"a\": 1,", "bart>", "bart>", "bart>", "bart> > not a quote", "bart> }", "bart> ```", "bart> Done."])
        XCTAssertEqual(Reply.replyLines("Cut off:\n~~~~sh\nls -la\n\n", nil), ["bart> Cut off:", "bart> ~~~~sh", "bart> ls -la", "bart> ~~~~"])
        XCTAssertEqual(Reply.replyLines("", nil), ["bart> No answer came back."])
        XCTAssertEqual(Reply.failureLines("Codex was\nnot found"), ["bart> **No answer.** Codex was not found"])
        XCTAssertEqual(Reply.failureLines(nil), ["bart> **No answer.** The run failed."])
        XCTAssertEqual(Reply.pendingRE.match("bart~> k3-x9")?[1], "k3-x9")
        XCTAssertEqual(Reply.answerText("  One.\n\n> two "), "One.\n\ntwo")
    }

    func testClipMiddle() {
        XCTAssertEqual(Clip.clipMiddle("short", 10), "short")
        let long = String(repeating: "q", count: 5000)
        let cut = Clip.clipMiddle(long, 600)
        XCTAssertLessThanOrEqual(cut.jsLength, 600)
        XCTAssertTrue(cut.contains("\n[… 4,4"))
        XCTAssertTrue(cut.hasPrefix("qqq") && cut.hasSuffix("qqq"))
        // No surrogate half on either side.
        let emoji = String(repeating: "😀", count: 400)
        let e = Clip.clipMiddle(emoji, 101)
        XCTAssertLessThanOrEqual(e.jsLength, 101)
        XCTAssertFalse(e.unicodeScalars.contains { $0.value == 0xFFFD })
        XCTAssertEqual(Clip.clipMiddle(long, 5), "qqqqq")
    }

    // MARK: activity.cjs

    func testActivity() {
        let short = Activity.pathLabeller(["/code/app", "/home/me/.engelbart"])
        XCTAssertEqual(short("/code/app/src/main/ipc.cjs"), "src/main/ipc.cjs")
        XCTAssertEqual(short("/etc/secret/passwd"), "passwd")
        XCTAssertEqual(short("./src/a.js"), "src/a.js")
        XCTAssertEqual(short(nil), "a file")
        XCTAssertEqual(short("/code/app/" + String(repeating: "d/", count: 40) + "f.js").jsLength, 48)
        func tool(_ name: String, _ input: String) -> JSONValue { j(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"\#(name)","input":\#(input)}]}}"#) }
        XCTAssertEqual(Activity.claudeUpdate(tool("Read", #"{"file_path":"/code/app/src/a.js"}"#), short), .activity("Reading src/a.js", log: true))
        XCTAssertEqual(Activity.claudeUpdate(tool("Grep", #"{"pattern":"onProgress"}"#), short), .activity("Searching code for “onProgress”", log: true))
        XCTAssertEqual(Activity.claudeUpdate(tool("WebSearch", #"{"query":"engelbart 1968"}"#), short), .activity("Searching the web for “engelbart 1968”", log: true))
        XCTAssertEqual(Activity.claudeUpdate(tool("WebFetch", #"{"url":"https://www.dougengelbart.org/x?y=1"}"#), short), .activity("Reading dougengelbart.org", log: true))
        XCTAssertEqual(Activity.claudeUpdate(tool("mcp__papers__search", #"{"query":"tutors"}"#), short), .activity("Finding papers close to “tutors”", log: true))
        XCTAssertEqual(Activity.claudeUpdate(tool("mcp__papers__references", #"{"id":"W1"}"#), short), .activity("Reading what “W1” cites", log: true))
        XCTAssertEqual(Activity.claudeUpdate(tool("Glob", #"{}"#), short), .activity("Listing files", log: true))
        func stream(_ e: String) -> JSONValue { j(#"{"type":"stream_event","event":\#(e)}"#) }
        XCTAssertEqual(Activity.claudeUpdate(stream(#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#), short), .activity("Thinking", log: false))
        XCTAssertEqual(Activity.claudeUpdate(stream(#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#), short), .textStart)
        XCTAssertEqual(Activity.claudeUpdate(stream(#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The secret"}}"#), short), .delta("The secret"))
        XCTAssertNil(Activity.claudeUpdate(stream(#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private"}}"#), short))
        XCTAssertNil(Activity.claudeUpdate(j(#"{"type":"user","message":{"content":[{"type":"tool_result","content":"file body"}]}}"#), short))
        XCTAssertNil(Activity.claudeUpdate(j(#"{"type":"result","result":"x"}"#), short))
        XCTAssertEqual(Activity.codexUpdate(j(#"{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc 'cat note.txt'","status":"in_progress"}}"#), short), .activity("Reading note.txt", log: true))
        XCTAssertNil(Activity.codexUpdate(j(#"{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc 'cat note.txt'","aggregated_output":"the secret word"}}"#), short))
        XCTAssertEqual(Activity.codexUpdate(j(#"{"type":"item.started","item":{"type":"web_search","query":"","action":{"type":"other"}}}"#), short), .activity("Searching the web", log: false))
        XCTAssertEqual(Activity.codexUpdate(j(#"{"type":"item.completed","item":{"type":"web_search","query":"Douglas Engelbart birth year","action":{"type":"search"}}}"#), short), .activity("Searching the web for “Douglas Engelbart birth year”", log: true))
        XCTAssertEqual(Activity.codexUpdate(j(#"{"type":"item.completed","item":{"type":"agent_message","text":"It is **1925**."}}"#), short), .text("It is **1925**."))
        XCTAssertNil(Activity.codexUpdate(j(#"{"type":"item.completed","item":{"type":"error","message":"Skill descriptions were shortened"}}"#), short))
        XCTAssertEqual(Activity.codexUpdate(j(#"{"type":"item.started","item":{"type":"mcp_tool_call","server":"papers","tool":"citations","arguments":"{\"id\":\"W9\"}"}}"#), short), .activity("Reading what cites “W9”", log: true))
        XCTAssertEqual(Activity.commandLabel("/bin/zsh -lc \"rg -n 'execFile' /code/app/src | head\"", short), "Searching code for “execFile”")
        XCTAssertEqual(Activity.commandLabel("/bin/zsh -lc \"sed -n '1,80p' /code/app/src/main/bart/ask.cjs\"", short), "Reading src/main/bart/ask.cjs")
        XCTAssertEqual(Activity.commandLabel("python3 -c \"import os; os.system('x')\"", short), "Running python3")
        XCTAssertNil(Activity.event(fromLine: "Restored session"))
        XCTAssertNil(Activity.event(fromLine: "{broken"))
        XCTAssertEqual(Activity.event(fromLine: "{\"n\":3}")?["n"]?.int, 3)
    }

    func testClaudeReaderNamesAWriteAsItComes() {
        let read = Activity.claudeReader(Activity.pathLabeller(["/d"]))
        func s(_ e: String) -> JSONValue { j(#"{"type":"stream_event","event":\#(e)}"#) }
        XCTAssertNil(read(s(#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","name":"Write"}}"#)))
        XCTAssertNil(read(s(#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"file_pa"}}"#)))
        XCTAssertEqual(read(s(#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"th\":\"/d/diagram.svg\",\"content\":\""}}"#)), .activity("Writing diagram.svg", log: false))
        XCTAssertNil(read(s(#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\#(String(repeating: "x", count: 500))"}}"#)))
        XCTAssertEqual(read(s(#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\#(String(repeating: "x", count: 600))"}}"#)), .activity("Writing diagram.svg · 1 KB", log: false))
        XCTAssertNil(read(s(#"{"type":"content_block_stop","index":2}"#)))
    }

    func testFeed() {
        var got: [BartProgress] = []
        let lock = NSLock()
        let done = expectation(description: "flushed")
        let feed = Feed(intervalMs: 0) { p in lock.lock(); got.append(p); lock.unlock(); if case .lines = p { done.fulfill() } }
        feed.take(.activity("Reading a", log: true))
        feed.take(.activity("Reading a", log: true))
        feed.take(.textStart)
        feed.take(.delta("Hello\n> world"))
        wait(for: [done], timeout: 2)
        lock.lock(); defer { lock.unlock() }
        XCTAssertEqual(got.first, .activity("Reading a", log: true))
        XCTAssertEqual(got.filter { if case .activity("Reading a", _) = $0 { return true }; return false }.count, 1, "said once while it does not change")
        XCTAssertTrue(got.contains(.activity("Writing", log: false)))
        XCTAssertTrue(got.contains(.lines(["Hello", "world"])))
        // ESCALATE is the agent talking to the harness: never previewed.
        var escalated: [BartProgress] = []
        let quiet = Feed(intervalMs: 0) { escalated.append($0) }
        quiet.take(.text("ESCALATE: hard"))
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertTrue(escalated.isEmpty)
        XCTAssertTrue(Activity.toHarness("ESCAL") && Activity.toHarness("  ESCALATE: x") && !Activity.toHarness("Escalate") && !Activity.toHarness(""))
    }

    // MARK: highlights.cjs

    static let box = #"[{"x":0,"y":0,"w":1,"h":1}]"#
    func hl(_ id: String, _ text: String, _ extra: String = "") -> String { #"{"id":"\#(id)","rects":\#(PureTests.box),"y":0.2,"text":"\#(text)","note":null,"pos":null\#(extra.isEmpty ? "" : "," + extra)}"# }
    func asked(_ q: String, _ a: String) -> String { #"{"id":"a-\#(q)","question":"\#(q)","answer":"\#(a)","meta":{},"at":"now"}"# }

    func testMarksOf() {
        let ink = j("""
        {"4":[\(hl("m4b", "second part", #""group":"g1","y":0.05,"asks":[\#(asked("what?", "that."))]"#)),\(hl("m4", "later on four", #""y":0.6"#))],
         "3":[\(hl("m3", "first part", #""group":"g1","y":0.9,"note":"a note on it""#)),{"id":"free","rects":[],"y":0.1,"note":"a free note","text":""},\(hl("bare", "   "))],
         "x":[\(hl("junk", "not a page"))], "0":[\(hl("zero", "no page 0"))], "5":"not a list"}
        """)
        XCTAssertEqual(Highlights.marksOf(ink), [
            Highlight(page: 3, quote: "", note: "a free note", asks: []),
            Highlight(page: 3, quote: "first part\nsecond part", note: "a note on it", asks: [HighlightAsk(question: "what?", answer: "that.", crop: nil)]),
            Highlight(page: 4, quote: "later on four", note: "", asks: []),
        ])
        XCTAssertEqual(Highlights.marksOf(nil), [])
        XCTAssertEqual(Highlights.marksOf(j("[]")), [])
    }

    func testStageBlock() {
        let paper = InkedItem(name: "Paper \"A\"", where_: "/p/a.pdf", annotations: "/d/annotations/x.json")
        XCTAssertEqual(Highlights.stageBlock(paper, page: 7, ink: j("{}")), "<stage paper=\"Paper  A \" path=\"/p/a.pdf\" page=\"7\" highlights=\"0\"/>")
        let small = Highlights.stageBlock(paper, page: 2, ink: j(#"{"2":[\#(hl("a", "alpha", #""note":"mine","asks":[\#(asked("why?", "because"))]"#))]}"#))
        XCTAssertEqual(small, "<stage paper=\"Paper  A \" path=\"/p/a.pdf\" page=\"2\" annotations=\"/d/annotations/x.json\">\n<highlight page=\"2\">\n<quote>\nalpha\n</quote>\n<note>\nmine\n</note>\n<ask>\n<question>\nwhy?\n</question>\n<answer>\nbecause\n</answer>\n</ask>\n</highlight>\n</stage>")
        var parts: [String] = []
        for p in 1...20 {
            var list = [hl("b\(p)", "p\(p) ".padding(toLength: 560, withPad: "x", startingAt: 0))]
            if p == 20 { list.append(hl("n20", "noted far away", #""note":"keep me","y":0.5"#)) }
            parts.append("\"\(p)\":[\(list.joined(separator: ","))]")
        }
        let out = Highlights.stageBlock(paper, page: 10, ink: j("{\(parts.joined(separator: ","))}"))
        XCTAssertLessThanOrEqual(out.jsLength, Highlights.stageBudget)
        let pages = JSRegex("<highlight page=\"(\\d+)\">", "g").matchAll(out).map { Int($0[1]!)! }
        XCTAssertEqual(pages, pages.sorted())
        XCTAssertTrue(out.contains("keep me") && out.contains("p10 ") && out.contains("p9 ") && out.contains("p11 "))
        XCTAssertFalse(out.contains("p1 x") || out.contains("p19 "))
        XCTAssertTrue(out.hasSuffix("<more n=\"\(21 - pages.count)\"/>\n</stage>"))
    }

    func testMentionedBlock() {
        XCTAssertEqual(Highlights.mentionedBlock([]), "")
        let fits = Highlights.mentionedBlock([InkedItem(name: "S", where_: "/s.pdf", annotations: "/ink/s.json", ink: j(#"{"2":[\#(hl("s", "short"))]}"#))])
        XCTAssertEqual(fits, "<highlights from=\"mentioned\">\n<paper name=\"S\" path=\"/s.pdf\" annotations=\"/ink/s.json\">\n<highlight page=\"2\">\n<quote>\nshort\n</quote>\n</highlight>\n</paper>\n</highlights>")
        func many(_ tag: String, _ n: Int, extra: String = "") -> JSONValue {
            var parts: [String] = []
            for p in 1...n { parts.append("\"\(p)\":[\(hl("\(tag)\(p)", "\(tag)\(p) ".padding(toLength: 560, withPad: "x", startingAt: 0)))\(p == n ? extra : "")]") }
            return j("{\(parts.joined(separator: ","))}")
        }
        let a = InkedItem(name: "A", where_: "/a.pdf", annotations: "/ink/a.json", ink: many("A", 30))
        let b = InkedItem(name: "B", where_: "/b.pdf", annotations: "/ink/b.json", ink: many("B", 30, extra: "," + hl("Bn", "noted at the end", #""asks":[\#(asked("q?", "an answer"))]"#)))
        let out = Highlights.mentionedBlock([a, InkedItem(name: "Empty", where_: "/e.pdf", ink: j("{}")), b])
        XCTAssertLessThanOrEqual(out.jsLength, Highlights.mentionedBudget)
        XCTAssertFalse(out.contains("Empty"))
        XCTAssertTrue(out.contains("an answer"))
        func count(_ tag: String) -> Int { JSRegex("<quote>\\n\(tag)\\d+ ", "g").matchAll(out).count }
        XCTAssertGreaterThanOrEqual(count("A"), 9); XCTAssertLessThanOrEqual(abs(count("A") - count("B")), 1)
    }

    func testWebStageAndBoxes() {
        let page = InkedItem(source: "web", name: "A page", address: "https://x.org/a", path: "", annotations: "")
        XCTAssertEqual(Highlights.webStageBlock(page, ink: nil), "<stage source=\"web\" title=\"A page\" address=\"https://x.org/a\" highlights=\"0\"/>")
        var live = page; live.selection = j(#"{"quote":{"exact":"picked words"},"pageText":"around"}"#); live.screenshot = "/d/bart-shots/k.png"
        XCTAssertEqual(Highlights.webStageBlock(live, ink: nil), "<stage source=\"web\" title=\"A page\" address=\"https://x.org/a\" highlights=\"0\">\n<selection>\n<quote>\npicked words\n</quote>\n<page_text>\naround\n</page_text>\n</selection>\n<screenshot path=\"/d/bart-shots/k.png\"/>\n</stage>")
        let ink = j(#"{"web":[{"id":"w1","quote":{"exact":"a passage","prefix":"p"},"note":"mine"},{"id":"b1","box":{"x":1},"crop":"crops/b1.png","text":"under it","asks":[{"question":"q","answer":"a","crop":"crops/b1-1.png"}]}]}"#)
        let marks = Highlights.webMarksOf(ink, inkRoot: "/d/annotations")
        XCTAssertEqual(marks.count, 2)
        XCTAssertEqual(marks[1].crop, "/d/annotations/crops/b1.png")
        XCTAssertEqual(marks[1].asks[0].crop, "/d/annotations/crops/b1-1.png")
        XCTAssertEqual(Highlights.highlightXml(marks[1]), "<box crop=\"/d/annotations/crops/b1.png\">\n<text>\nunder it\n</text>\n<ask crop=\"/d/annotations/crops/b1-1.png\">\n<question>\nq\n</question>\n<answer>\na\n</answer>\n</ask>\n</box>\n")
    }

    // MARK: card.cjs

    static let FOCUS = #"{"say":"","card":"focus","focus":{"title":"Which?","options":[{"label":"Retries","why":"In notes.md."},{"label":"The \"slow\" path"},{"label":"retries"}]},"ready":false}"#

    func testCards() {
        let focus = Card.readCard(PureTests.FOCUS)!
        XCTAssertEqual(focus["focus"]!["options"], [["label": "Retries", "why": "In notes.md."], ["label": "The 'slow' path"]])
        XCTAssertEqual(Card.readCard("```json\n\(PureTests.FOCUS)\n```"), focus)
        XCTAssertEqual(Card.readCard("Here you go: \(PureTests.FOCUS) Thanks."), focus)
        let two = #"{"say":"","card":"questions","questions":{"items":[{"id":"a","type":"free","title":"First?","placeholder":"x","options":[{"label":"no"}]},{"id":"b","type":"open","title":"Second?"}]}}"#
        XCTAssertEqual(Card.readCard(two)!["questions"], ["items": [["id": "a", "type": "free", "title": "First?", "placeholder": "x"]]])
        XCTAssertEqual(Card.readCard(#"{"say": "Interest: retries\nAim: measure", "card": "none", "ready": true}"#), ["say": "Interest: retries\nAim: measure", "card": "none", "ready": true])
        for broken in ["not json", "{\"say\": \"cut", #"{"card":"focus","focus":{"options":[{"label":"one"}]}}"#, #"{"card":"questions","questions":{"items":[{"type":"essay","title":"x"}]}}"#, #"{"card":"none","ready":true}"#, "[1, 2]"] {
            XCTAssertNil(Card.readCard(broken), broken)
        }
        let kept = Card.cardBody(PureTests.FOCUS)
        XCTAssertEqual(kept.body, "```json\n\(focus.stringify(indent: 2))\n```")
        XCTAssertTrue(kept.body.hasPrefix("```json\n{\n  \"say\": \"\",\n  \"card\": \"focus\",\n  \"focus\": {"))
        XCTAssertEqual(Card.cardOfAnswer(Reply.answerText(kept.body)), focus)
        XCTAssertEqual(Card.cardBody("Sorry, I got confused.").body, "Sorry, I got confused.")
        XCTAssertNil(Card.cardOfAnswer("```json\n{\"say\": \"a\", \"card\": \"none\", \"ready\": true}\n```"))
        // More than one object: the last that is a card.
        let corrected = "{\"say\":\"\",\"card\":\"focus\",\"focus\":{\"options\":[{\"label\":\"only\"}]}}\nWait — corrected reply:\n\(PureTests.FOCUS)"
        XCTAssertEqual(Card.readCard(corrected), focus)
        XCTAssertEqual(Card.jsonBlocks("a {\"x\": \"}\"} b {nested {x}} {open"), ["{\"x\": \"}\"}", "{nested {x}}"])
        XCTAssertEqual(Card.cardAsText(focus), "Which?\n- Retries\n- The 'slow' path")
    }

    func testAnswers() {
        let focus = Card.readCard(PureTests.FOCUS)!
        XCTAssertEqual(Card.answerLine(focus, picks: ["Retries"]), "picked \"Retries\"")
        XCTAssertEqual(Card.answerLine(focus, picks: ["Retries"], note: " more  words "), "picked \"Retries\"; note: more words")
        XCTAssertEqual(Card.answerLine(focus, note: "my own words"), "my own words")
        XCTAssertEqual(Card.answerLine(focus), "(skipped)")
        XCTAssertEqual(Card.readAnswer("picked \"Retries\", \"The 'slow' path\"; note: hm", focus), CardAnswer(skipped: false, picks: ["Retries", "The 'slow' path"], text: "", note: "hm"))
        XCTAssertEqual(Card.readAnswer("retries", focus).picks, ["Retries"])
        XCTAssertEqual(Card.readAnswer("something else", focus).text, "something else")
        XCTAssertTrue(Card.readAnswer("(skipped)", focus).skipped)
        let w = Card.readAnswer("picked \"Retries\"; (wrap up)", focus)
        XCTAssertTrue(w.wrap); XCTAssertEqual(w.picks, ["Retries"])
        XCTAssertTrue(Card.readAnswer("(wrap up)", focus).skipped && Card.readAnswer("(wrap up)", focus).wrap)
        XCTAssertEqual(Card.withWrap(""), "(wrap up)"); XCTAssertEqual(Card.withWrap("picked \"a\""), "picked \"a\"; (wrap up)")
        let body = Card.cardBody(PureTests.FOCUS).body
        XCTAssertEqual(Card.answersSoFar([("", body), ("picked \"Retries\"", body)], "(skipped)"), 1)
        XCTAssertEqual(Card.answersSoFar([("", body)], "--deep picked \"Retries\""), 1)
    }

    func testRecapAndResults() {
        let base = "Where you are: a\nWhat's unclear: b"
        XCTAssertTrue(Card.recapParts(base) == (base.components(separatedBy: "\n"), []))
        let r = Card.recapParts("\(base)\nLook for: @discover how people choose\nLook for: one\nLook for: two")
        XCTAssertEqual(r.lookFor, ["how people choose", "one"])
        XCTAssertTrue(Card.recapLine("What’s unclear: why")! == ("What's unclear", "why"))
        XCTAssertNil(Card.recapLine("Nothing: here"))
        XCTAssertEqual(Card.nextLead("You keep coming back to retries. So what do you want to dig into next?"), "You keep coming back to retries.")
        XCTAssertEqual(Card.nextLead("Retries again"), "Retries again.")
        XCTAssertEqual(Card.nextLead("Why this?"), "")
        XCTAssertEqual(Card.nextTitle("Lead."), "Lead. So what do you want to dig into next?")
        XCTAssertTrue(Card.sameWords("Retries, again!", "retries again"))
        XCTAssertFalse(Card.sameWords("", ""))
        XCTAssertEqual(Card.resultText("  measure  the loop "), "measure the loop\nFind papers on it with @discover, or ask about it with @chat.")
        XCTAssertEqual(Card.resultText(""), Card.leftOpen)
        XCTAssertEqual(Card.resultParts("measure it\nFind papers on it with @discover, or ask about it with @bart."), "measure it")
        XCTAssertNil(Card.resultParts("just text"))
    }

    // MARK: strip.cjs

    func testStrip() {
        let doc = ["My own line.", "@bart why do runs loop?", "bart> Because of the lock.", "bart> See *TutorTrace*.", "bart> *Sonnet · high · 3 s*",
                   "@bart and then?", "bart+> folded answer", "Back to me.", "@discover what should I read?", "bart> ## Start here",
                   "bart> **Illusion of Learning** · 2024", "@brainstorm", "bart> ```json", "bart> {\"card\": \"focus\"}", "bart> ```",
                   "@brainstorm picked \"Retries\"", "bart~> ask-now", "@bart pending one", "bart~> other-ask", "Plain again.", "bart> orphan reply under nothing"].joined(separator: "\n")
        XCTAssertEqual(Strip.stripAgentReplies(doc), ["My own line.", "@bart why do runs loop?", Strip.omitted, "@bart and then?", Strip.omitted, "Back to me.",
                                                      "@discover what should I read?", Strip.omitted, "@brainstorm", "bart> ```json", "bart> {\"card\": \"focus\"}", "bart> ```",
                                                      "@brainstorm picked \"Retries\"", "bart~> ask-now", "@bart pending one", Strip.omitted, "Plain again.", "bart> orphan reply under nothing"].joined(separator: "\n"))
        XCTAssertEqual(Strip.stripAgentReplies("no agents here\n\n- [ ] a task"), "no agents here\n\n- [ ] a task")
        XCTAssertEqual(Strip.stripAgentReplies(""), "")
        // A thread Bart handed to brainstorm is brainstorm's.
        let handed = ["bart# [brainstorm 2026-10-12T21:41:00Z] A plan", "@bart help me plan", "bart> a card", "", "bart# Old title", "@bart --build x", "bart> **No Build.**"].joined(separator: "\n")
        XCTAssertEqual(Strip.stripAgentReplies(handed), ["@bart help me plan", "bart> a card", "", "@bart --build x", Strip.omitted].joined(separator: "\n"))
        XCTAssertEqual(Strip.stripTitles("bart# A\n@chat q\nbart> a"), "@chat q\nbart> a")
    }

    func testStripShow() {
        let doc = ["@chat why?", "bart> Because.", "bart> *Chat · Sonnet · high · 3 s*", "@discover read?", "bart~> other", "@brainstorm", "bart~> NOW"].joined(separator: "\n")
        let shown = Strip.stripAgentReplies(doc, agent: "brainstorm", show: true, askId: "NOW")
        XCTAssertEqual(shown, ["@chat why?", "<reply agent=\"Chat\">\nBecause.\n</reply>", "@discover read?", "<reply agent=\"Discover\" status=\"still being written\"/>", "@brainstorm", "bart~> NOW"].joined(separator: "\n"))
        func said(_ n: Int) -> String { String(repeating: "w", count: n) }
        let far = ["@chat a", "bart> \(said(30))", "@chat b", "bart> \(said(30))", "@chat c", "bart> \(said(30))", "@brainstorm", "bart~> NOW"].joined(separator: "\n")
        let budgeted = Strip.stripAgentReplies(far, agent: "brainstorm", show: true, askId: "NOW", budget: 70)
        XCTAssertEqual(budgeted.components(separatedBy: "\n").filter { $0 == said(30) }.count, 2)
        XCTAssertEqual(budgeted.components(separatedBy: "\n").filter { $0.contains("left_out=\"30 characters, farther from this line\"") }.count, 1)
    }

    func testTopicOf() {
        let doc = ["bart# [brainstorm 2026] Retries", "@brainstorm why?", "bart> prose", "@brainstorm more", "bart~> NOW"].joined(separator: "\n")
        XCTAssertEqual(Strip.topicOf(doc, askId: "NOW"), "Retries")
        XCTAssertNil(Strip.topicOf(doc.replacingOccurrences(of: "Retries", with: "New conversation"), askId: "NOW"))
        XCTAssertNil(Strip.topicOf(doc.replacingOccurrences(of: "[brainstorm", with: "[discover"), askId: "NOW"))
        XCTAssertNil(Strip.topicOf("Some text\n@brainstorm x\nbart~> NOW", askId: "NOW"))
        XCTAssertNil(Strip.topicOf(doc, askId: "other"))
    }

    // MARK: prompts

    func testPromptsAreVerbatim() {
        let all: [String: String] = ["corePersonality": Prompts.corePersonality, "bart": Prompts.bart, "brainstorm": Prompts.brainstorm, "welcome": Prompts.welcome,
                                     "discover": Prompts.discover, "create": Prompts.create, "route": Prompts.route, "summary": Prompts.summary]
        for (name, text) in all { XCTAssertEqual(text.jsLength, Prompts.jsLengths[name], name) }
        for p in [Prompts.bart, Prompts.brainstorm, Prompts.welcome, Prompts.discover, Prompts.create] { XCTAssertTrue(p.hasPrefix(Prompts.corePersonality), "opens with the shared personality") }
        XCTAssertFalse(Prompts.route.contains("# How you work with the person"))
        XCTAssertEqual(Prompts.bart.components(separatedBy: "Never operationalize farther than the person asked").count, 2)
        XCTAssertTrue(Prompts.bart.contains("ESCALATE:"))
    }

    // MARK: passage-link / passage-text

    func testPassageLinks() {
        let t = PassageLink.splitTarget("/Users/me/My%20Paper.pdf#find=We%20argue&to=Next&cite=you&counter=1")
        XCTAssertEqual(t.address, "/Users/me/My Paper.pdf"); XCTAssertEqual(t.find, "We argue"); XCTAssertEqual(t.to, "Next")
        XCTAssertEqual(t.cite, "you"); XCTAssertTrue(t.counter)
        XCTAssertEqual(PassageLink.splitTarget("https://arxiv.org/pdf/2312.10893#find=We%20argue%20that"), LinkTarget(address: "https://arxiv.org/pdf/2312.10893", find: "We argue that", to: ""))
        XCTAssertEqual(PassageLink.splitTarget("/a.pdf#page=3"), LinkTarget(address: "/a.pdf#page=3", find: "", to: ""))
        let whole = PassageLink.splitTarget("/a.pdf#page=4&cite=source")
        XCTAssertEqual(whole.cite, "source"); XCTAssertEqual(whole.page, 4); XCTAssertEqual(whole.find, "")
        let note = PassageLink.splitTarget("/a.pdf#find=the%20passage&page=2&note=my%20words&cite=you")
        XCTAssertEqual(note.note, "my words"); XCTAssertEqual(note.page, 2); XCTAssertEqual(note.find, "the passage")
        XCTAssertEqual(PassageLink.citeHref(address: "/My Notes/a (1).md", find: "words (here)", cite: "you"), "/My%20Notes/a%20%281%29.md#find=words%20%28here%29&cite=you")
        XCTAssertEqual(PassageLink.citeHref(address: "https://x.org/a b", find: "", page: 3, note: "n", cite: "source", counter: true), "https://x.org/a%20b#page=3&note=n&cite=source&counter=1")
    }

    func testPassageMatching() {
        let text = "@bart why?\nbart> The “construc-\ntion” of — things\n## A heading\n- an **item** [link](http://x.org)"
        XCTAssertEqual(PassageText.normalizePassage(text, prefixes: true, markdown: true), "why? the \"construction\" of - things a heading an item link")
        let hits = PassageText.matchPassage(text, "construction\" of", prefixes: true, markdown: true)
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(text.jsSlice(hits[0].start, hits[0].end), "construc-\ntion” of")
        XCTAssertEqual(PassageText.matchPassage("well-\nknown", "wellknown").count, 1)
        XCTAssertEqual(PassageText.matchPassage("a|b|c", "a b c").count, 0)
        XCTAssertEqual(PassageText.matchPassage("cellonecelltwo", "cellone celltwo").count, 1)
        XCTAssertEqual(PassageText.matchPassage("ﬁnd it", "find").count, 1)
        XCTAssertEqual(PassageText.matchPassage("x", "").count, 0)
    }
}
