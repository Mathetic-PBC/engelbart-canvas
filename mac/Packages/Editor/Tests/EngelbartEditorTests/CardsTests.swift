import XCTest
import AppKit
import EngelbartCore
import EngelbartDoc
@testable import EngelbartEditor

// @brainstorm/@discover cards, recaps, a result's offer, Send to Discover, an @discover guide's bookmarks and @create's
// words (DocEditor.jsx cardsOf/pickCard/sendCard/repickCard/answerShown/isRecap/endsInRecap/discoverLook/askResult,
// model/guide.js guideTitle, makingLabel/creatingLine/createDoing/madeNoun/madeToOpen; test/brainstorm-card.test.cjs,
// discover-guide.test.cjs, create-rows.test.cjs), and SwiftMath's typesetting.

final class CardsTests: XCTestCase {
    static func json(type: String = "mcq", options: [String] = ["Alpha", "Beta", "Gamma"], id: String = "q1", map: Bool = false) -> String {
        let opts = options.map { "{\"label\":\"\($0)\",\"why\":\"because \($0.lowercased())\"}" }.joined(separator: ",")
        let m = map ? ",\"map\":{\"settled\":[{\"text\":\"what is known\",\"from\":\"you\"}],\"open\":[],\"untouched\":[]}" : ""
        return "{\"say\":\"Here is a thought.\",\"card\":\"questions\",\"questions\":{\"items\":[{\"id\":\"\(id)\",\"type\":\"\(type)\",\"title\":\"Which way?\",\"subtitle\":\"Pick one\",\"options\":[\(opts)]}]}\(m)}"
    }
    static func cardTurn(_ agent: String = "brainstorm", type: String = "mcq", foot: String = "Brainstorm", map: Bool = false) -> [String] {
        ["@\(agent) help me think", "bart> ```json", "bart> \(json(type: type, map: map))", "bart> ```", "bart> *\(foot) · 3 s*"]
    }

    final class Asked { var requests: [AskRequest] = [] }
    func core(_ lines: [String], ask: Bool = true) -> (EditorCore, Asked) {
        let c = EditorCore(docKey: "k", text: lines.joined(separator: "\n"))
        let asked = Asked()
        if ask { c.hooks.ask = { asked.requests.append($0) } }
        return (c, asked)
    }

    // MARK: SwiftMath

    func testSwiftMathParsesAndSizes() {
        XCTAssertTrue(MathTypeset.parses("\\frac{1}{2}"))
        XCTAssertTrue(MathTypeset.parses("x^2 + \\sqrt{y}"))
        XCTAssertFalse(MathTypeset.parses("\\frac{1}{"), "an unclosed group is not read")
        let inline = MathTypeset.draw("x", display: false, size: 16)
        let frac = MathTypeset.draw("\\frac{a+b}{c}", display: true, size: 16)
        XCTAssertNotNil(inline); XCTAssertNotNil(frac)
        XCTAssertGreaterThan(inline!.size.width, 0)
        XCTAssertGreaterThan(frac!.size.height, inline!.size.height, "a stacked fraction stands taller than a letter")
        XCTAssertGreaterThan(frac!.descent, 0, "it hangs below the baseline")
        XCTAssertNil(MathTypeset.draw("\\frac{", display: false, size: 16))
        XCTAssertNil(MathTypeset.draw("  ", display: false, size: 16))
        let big = MathTypeset.draw("x", display: false, size: 32)!
        XCTAssertGreaterThan(big.size.height, inline!.size.height, "drawn at the line's size")
        let a = MathTypeset.attachment("\\sum_{i=1}^n i", display: true, size: 16)
        let att = a?.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment
        XCTAssertNotNil(att?.image)
        XCTAssertLessThan(att!.bounds.minY, 0, "sits on the baseline by its descent")
        XCTAssertEqual(a?.length, 1)
    }

    func testMathErrorFallsBackToMathText() {
        // A formula SwiftMath cannot read but MathText can still show is text, not an attachment.
        let c = EditorCore(docKey: "k", text: "see $\\unknowncommand{x}$ here")
        let r = Renderer.render(c, RenderContext())
        let shown = (r.text.string as NSString).substring(with: r.maps[0].range)
        XCTAssertTrue(shown.hasPrefix("see "))
        XCTAssertTrue(shown.hasSuffix(" here"))
    }

    // MARK: cards

    func testCardsOfAndLayout() {
        let (c, _) = core(CardsTests.cardTurn() + [""])
        let cards = c.cardsOf()
        let e = cards.byQ[0]
        XCTAssertNotNil(e)
        XCTAssertEqual(e?.agent, "brainstorm")
        XCTAssertTrue(e?.live ?? false, "the last turn, unfolded, in an editor that asks")
        XCTAssertEqual(e?.last, 3, "the card's lines end before its foot")
        XCTAssertEqual(cards.lines, [1, 2, 3])
        XCTAssertTrue(c.boxedCard(e!), "@brainstorm's single choice is boxed (David's mock)")
        let at = c.layout(canReply: true)
        XCTAssertTrue(at[1]?.card ?? false)
        XCTAssertTrue(at[2]?.underCard ?? false)
        XCTAssertTrue(at[3]?.underCard ?? false)
        XCTAssertFalse(at[4]?.fieldAfter ?? true, "a boxed live card has its field inside it: none under the conversation")
        XCTAssertFalse(at[0]?.editable ?? true, "a turn answered by a card is not edited in place")
        let (plain, _) = core(CardsTests.cardTurn(type: "select_all") + [""])
        let sa = plain.cardsOf().byQ[0]!
        XCTAssertFalse(plain.boxedCard(sa), "a select-all is a list")
        XCTAssertTrue(plain.layout(canReply: true)[4]?.fieldAfter ?? false, "answered in the reply field under it")
        let (none, _) = core(CardsTests.cardTurn() + [""], ask: false)
        XCTAssertFalse(none.cardsOf().byQ[0]!.live, "an editor that cannot ask has no live card")
        let (chat, _) = core(["@chat hi", "bart> ```json", "bart> \(CardsTests.json())", "bart> ```", "bart> *Chat · 2 s*", ""])
        XCTAssertNil(chat.cardsOf().byQ[0], "Chat's answers are never cards")
    }

    func testPickAndSendBoxedCard() {
        let (c, asked) = core(CardsTests.cardTurn() + [""])
        c.pickCard(0, 1)
        XCTAssertEqual(c.cardPicks[0], ["Beta"], "a boxed card's row is ticked, not sent")
        c.pickCard(0, 0)
        XCTAssertEqual(c.cardPicks[0], ["Alpha", "Beta"], "kept in the card's order")
        c.pickCard(0, 1)
        XCTAssertEqual(c.cardPicks[0], ["Alpha"], "pressed again: unticked")
        c.followText[0] = "and soon"
        c.sendCard(0)
        XCTAssertEqual(asked.requests.count, 1)
        let req = asked.requests[0]
        XCTAssertEqual(req.agent, "brainstorm")
        XCTAssertEqual(req.text, "picked \"Alpha\"; note: and soon")
        XCTAssertEqual(c.lines[5], "@brainstorm picked \"Alpha\"; note: and soon")
        XCTAssertTrue(c.lines[6].hasPrefix("bart~> "))
        XCTAssertNil(c.cardPicks[0]); XCTAssertNil(c.followText[0])
        XCTAssertEqual(req.turns.count, 1, "the turns before it go along")
    }

    func testSingleChoiceListSendsOnPress() {
        let (c, asked) = core(CardsTests.cardTurn("discover", type: "mcq", foot: "Discover").map { $0 } + [""])
        // @discover's single choice is boxed too; an @brainstorm focus-free mcq list is not boxed only for select_all.
        XCTAssertTrue(c.boxedCard(c.cardsOf().byQ[0]!))
        c.pickCard(0, 2)
        XCTAssertTrue(asked.requests.isEmpty)
        c.sendCard(0)
        XCTAssertEqual(asked.requests.first?.agent, "discover")
        XCTAssertEqual(asked.requests.first?.text, "picked \"Gamma\"")
        XCTAssertEqual(c.lines[0], "@discover help me think", "@discover's turns do not fold")
    }

    func testSubmitWithNothingWaitsSkipAndWrap() {
        let (c, asked) = core(CardsTests.cardTurn() + [""])
        c.sendCard(0)
        XCTAssertTrue(asked.requests.isEmpty, "nothing picked or typed: Submit waits")
        c.sendCard(0, how: "skip")
        XCTAssertEqual(asked.requests.last?.text, Card.skipped)
        let (w, wasked) = core(CardsTests.cardTurn() + [""])
        w.pickCard(0, 0)
        w.sendCard(0, how: "wrap")
        XCTAssertEqual(wasked.requests.last?.text, "picked \"Alpha\"; (wrap up)")
        let (d, dasked) = core(CardsTests.cardTurn("discover", foot: "Discover") + [""])
        d.sendCard(0, how: "wrap")
        XCTAssertTrue(dasked.requests.isEmpty, "Wrap up is @brainstorm's alone")
    }

    func testSendFollowAnswersALiveCard() {
        let (c, asked) = core(CardsTests.cardTurn(type: "select_all") + [""])
        c.pickCard(0, 0); c.pickCard(0, 2)
        XCTAssertTrue(asked.requests.isEmpty, "a select-all ticks")
        c.sendFollow(0)
        XCTAssertEqual(asked.requests.first?.text, "picked \"Alpha\", \"Gamma\"", "Enter in the reply field sends the ticks")
    }

    func testAnsweredCardShownAndRepick() {
        let doc = CardsTests.cardTurn() + ["@brainstorm picked \"Beta\"; note: why", "bart> Fine.", "bart> *Brainstorm · 1 s*", ""]
        let (c, asked) = core(doc)
        let e = c.cardsOf().byQ[0]!
        XCTAssertFalse(e.live)
        XCTAssertEqual(e.answer?.picks, ["Beta"])
        XCTAssertEqual(c.answerShown(e.answer!).text, "Beta · why")
        XCTAssertEqual(c.layout(canReply: true)[5]?.answersQ, 0)
        XCTAssertTrue(c.repickable(e))
        XCTAssertNil(c.repickCard(0, 1), "the row already picked is no repick")
        let id = c.repickCard(0, 2)
        XCTAssertNotNil(id)
        XCTAssertEqual(c.lines[5], "@brainstorm picked \"Gamma\"", "the answering line says the new pick")
        XCTAssertEqual(asked.requests.last?.text.contains("Gamma"), true)
        XCTAssertFalse(c.lines.contains("bart> Fine."), "what came after it goes")
        _ = c.undo()
        XCTAssertEqual(c.lines, doc, "one undo brings it all back")
        let skipped = CardAnswer(skipped: true, picks: [], text: "", note: "")
        XCTAssertEqual(c.answerShown(skipped).grey, "Skipped")
        XCTAssertEqual(c.answerShown(CardAnswer(skipped: false, picks: ["A"], text: "", note: "", wrap: true)).grey, " · Wrapped up")
        XCTAssertEqual(c.answerShown(CardAnswer(skipped: true, picks: [], text: "", note: "", wrap: true)).grey, "Wrapped up")
    }

    func testRecapEndsAndSendToDiscover() {
        let doc = ["@brainstorm go", "bart> What you know: a lot", "bart> Your question: why", "bart> *Brainstorm · 2 s*", ""]
        let (c, asked) = core(doc)
        let t = c.threads()[0]
        XCTAssertTrue(c.isRecap(c.lines, t.turns[0]))
        XCTAssertTrue(c.endsInRecap(c.lines, t))
        XCTAssertTrue(c.layout(canReply: true)[3]?.recapAfter ?? false, "Send to Discover's row under it")
        c.discoverLook(0, query: "prior work on why")
        XCTAssertEqual(Array(c.lines[4...6]), ["", "@discover prior work on why", c.lines[6]])
        XCTAssertTrue(c.lines[6].hasPrefix("bart~> "))
        XCTAssertEqual(asked.requests.last?.agent, "discover")
        XCTAssertEqual(asked.requests.last?.placeLine, 5)
        let (prose, _) = core(["@brainstorm go", "bart> Just prose here.", "bart> *Brainstorm · 2 s*", ""])
        XCTAssertFalse(prose.isRecap(prose.lines, prose.threads()[0].turns[0]))
    }

    func testResultOfferAsks() {
        let doc = ["@brainstorm go", "bart> A sharp question.", "bart> \(Card.resultOffer)", "bart> *Brainstorm · 2 s*", ""]
        let (c, asked) = core(doc)
        c.askResult(2, agent: "bart")
        XCTAssertEqual(asked.requests.last?.agent, "bart")
        XCTAssertEqual(asked.requests.last?.text, "A sharp question.")
        XCTAssertTrue(c.lines.contains("@chat A sharp question."))
        c.askResult(2, agent: "create")
        XCTAssertEqual(asked.requests.count, 1, "only @discover and @chat")
        let (d, dasked) = core(doc)
        XCTAssertTrue(d.discoverLastResult())
        XCTAssertEqual(dasked.requests.last?.agent, "discover")
    }

    func testRendererDrawsCardsRecapsOfferAndAnswers() {
        let doc = CardsTests.cardTurn(map: true) + ["@brainstorm picked \"Beta\"", "bart> What you know: a lot", "bart> Your question: not said", "bart> *Brainstorm · 1 s*", "", "@brainstorm more", "bart> It holds.", "bart> \(Card.resultOffer)", "bart> *Brainstorm · 1 s*", ""]
        let (c, _) = core(doc)
        var ctx = RenderContext(); ctx.canReply = true
        let r = Renderer.render(c, ctx)
        XCTAssertTrue(r.decos.contains { $0.line == 1 && $0.deco == .card(q: 0) && $0.whole })
        for i in 2...3 { XCTAssertNotNil(r.text.attribute(.edHidden, at: r.maps[i].range.location, effectiveRange: nil), "its JSON is not on the page") }
        let shown = { (i: Int) in (r.text.string as NSString).substring(with: r.maps[i].range) }
        XCTAssertEqual(shown(5), "Beta", "the answering line as said")
        XCTAssertEqual(shown(6), "What you know\u{2028}a lot", "a recap section: the label on its own line")
        XCTAssertEqual(shown(7), "Your question\u{2028}not said")
        XCTAssertEqual(shown(12), "Find papers on it with @discover, or ask about it with @chat.")
        let at = (shown(12) as NSString).range(of: "@discover").location + r.maps[12].range.location
        XCTAssertEqual((r.text.attribute(.edAction, at: at, effectiveRange: nil) as? ActionBox)?.action, .resultAsk(line: 12, agent: "discover"))
        XCTAssertTrue(r.decos.contains { $0.deco == .sendDiscover(from: 5) } == false, "the recap is not the conversation's end here")
    }

    // MARK: an @discover guide

    func testGuideTitleAndUnsavedPapers() {
        XCTAssertEqual(EditorCore.guideTitle("**[A  paper](https://x.org/p#sec)** — 2024")?.address, "https://x.org/p")
        XCTAssertEqual(EditorCore.guideTitle("**[A  paper](https://x.org/p)**")?.title, "A paper")
        XCTAssertNil(EditorCore.guideTitle("**[A](https://x.org/p)**", next: "**Read:** abstract only"), "read from its abstract alone: no bookmark")
        XCTAssertNil(EditorCore.guideTitle("**[A](mailto:x)**"))
        XCTAssertEqual(EditorCore.guideTitle("**[Local](/Users/me/My%20Paper.pdf)**")?.address, "/Users/me/My Paper.pdf")
        XCTAssertEqual(EditorCore.guideTitle("**[L](file:///a.pdf)**")?.address, "file:///a.pdf")
        let doc = ["@discover papers", "bart> **[One](https://a.org/1)**", "bart> **Read:** full text", "bart> **[Two](https://a.org/2)**", "bart> **[One](https://a.org/1)**", "bart> **[Three](https://a.org/3)**", "bart> *Discover · 9 s*", ""]
        let (c, _) = core(doc)
        let state = ["https://a.org/1": "none", "https://a.org/2": "here", "https://a.org/3": "lib"]
        let left = c.unsavedPapers(0, state: { state[$0] })
        XCTAssertEqual(left.map { $0.title }, ["One", "Three"], "not here yet, once each, in order")
        var ctx = RenderContext(); ctx.paperState = { state[$0] }
        let r = Renderer.render(c, ctx)
        XCTAssertEqual(r.decos.filter { if case .paperMark = $0.deco { return true }; return false }.map { $0.line }, [1, 3, 4, 5])
    }

    // MARK: @create

    func testCreateWords() {
        XCTAssertEqual(CreateWords.madeNoun("flow.svg"), "Diagram")
        XCTAssertEqual(CreateWords.madeNoun("x.HTML"), "Page")
        XCTAssertEqual(CreateWords.madeNoun("notes.md", text: "```python\nprint(1)\n```"), "Script")
        XCTAssertEqual(CreateWords.madeNoun("notes.md", text: "# Title\nwords"), "Document")
        XCTAssertEqual(CreateWords.madeNoun("x.bin"), "File")
        XCTAssertEqual(CreateWords.makingLabel("A flowchart of the plan", nil, nil), "Creating a flowchart")
        XCTAssertEqual(CreateWords.makingLabel(nil, "make me an html page", nil), "Creating an HTML page")
        XCTAssertEqual(CreateWords.makingLabel(nil, "draw slides about it", nil), "Creating slides")
        XCTAssertEqual(CreateWords.makingLabel(nil, "make a markdown report", nil), "Creating a Markdown report")
        XCTAssertEqual(CreateWords.makingLabel(nil, "something", "out/thing.csv"), "Creating a dataset")
        XCTAssertEqual(CreateWords.makingLabel(nil, "hmm", nil), "Create")
        XCTAssertEqual(CreateWords.creatingLine("A diagram of this conversation."), "Creating a diagram of this conversation…")
        XCTAssertEqual(CreateWords.creatingLine("HTML page of results"), "Creating HTML page of results…", "an acronym keeps its capitals")
        XCTAssertEqual(CreateWords.creatingLine("Creating the thing"), "Creating the thing…")
        XCTAssertEqual(CreateWords.creatingLine("  "), "")
        XCTAssertEqual(CreateWords.createDoing("Writing out/flow.svg · 3 KB", kind: "diagram", wrote: true), "Drawing the diagram")
        XCTAssertEqual(CreateWords.createDoing("Editing page.html", kind: nil, wrote: true), "Revising the page")
        XCTAssertEqual(CreateWords.createDoing("Reading notes.md", kind: nil, wrote: false), "Reading your notes")
        XCTAssertEqual(CreateWords.createDoing("Reading paper.pdf", kind: nil, wrote: false), "Reading a paper")
        XCTAssertEqual(CreateWords.createDoing("Reading arxiv.org", kind: nil, wrote: false), "Reading a page on arxiv.org")
        XCTAssertEqual(CreateWords.createDoing("Reading src/app.swift", kind: nil, wrote: false), "Reading the code")
        XCTAssertEqual(CreateWords.createDoing("Thinking", kind: "diagram", wrote: false), "Planning the diagram")
        XCTAssertEqual(CreateWords.createDoing("", kind: nil, wrote: false), "Thinking it through")
        XCTAssertEqual(CreateWords.createDoing("Writing", kind: nil, wrote: true), "Finishing up")
        XCTAssertEqual(CreateWords.createDoing("Using a tool", kind: nil, wrote: false), "Working")
    }

    func testCreateRowsRendered() {
        let made = "@[flow.svg](made:a1/flow.svg)"
        guard let mm = Inline.madeMentionOf(made) else { return XCTFail("made mention") }
        let doc = ["@create a diagram", "bart> Here it is.", "bart> \(made)", "bart> *Create · 9 s*", "@create another", "bart~> run9", ""]
        let (c, _) = core(doc)
        c.asks = ["run9": AskProgress(agent: "create", activity: "Writing out/x.svg", log: ["Writing out/x.svg"], making: "A diagram of it.", at: Date())]
        var ctx = RenderContext(); ctx.canReply = true
        let r = Renderer.render(c, ctx)
        XCTAssertTrue(r.decos.contains { $0.line == 2 && $0.deco == .made(key: mm.key, name: mm.name) && $0.whole })
        XCTAssertTrue(r.decos.contains { $0.line == 5 && $0.deco == .creating(id: "run9", q: 4) })
        let w = CreatingView.words(ask: c.asks["run9"], request: "another")
        XCTAssertEqual(w.sentence, "Creating a diagram of it…")
        XCTAssertEqual(w.doing, "Drawing the diagram")
        XCTAssertTrue(w.running)
        let gone = CreatingView.words(ask: nil, request: "a chart")
        XCTAssertEqual(gone.doing, "No answer came back: the run was interrupted.")
        XCTAssertEqual(gone.label, "Creating a chart")
        var opened = Set<String>()
        XCTAssertEqual(CreateWords.madeToOpen(lines: ["bart> \(made)"], stopped: false, failed: false, askId: "a1", askedIn: "k", here: "k", opened: &opened)?.key, mm.key)
        XCTAssertNil(CreateWords.madeToOpen(lines: ["bart> \(made)"], stopped: false, failed: false, askId: "a1", askedIn: "k", here: "k", opened: &opened), "once per run")
        var none = Set<String>()
        XCTAssertNil(CreateWords.madeToOpen(lines: ["bart> \(made)"], stopped: false, failed: false, askId: "a2", askedIn: "k", here: "other", opened: &none), "not when the person left")
    }
}
