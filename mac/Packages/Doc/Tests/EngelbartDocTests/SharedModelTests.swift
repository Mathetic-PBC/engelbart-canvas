import XCTest
import CoreGraphics
@testable import EngelbartDoc

// test/cite.test.cjs (fold, link), cite-circles, cite-open, paste-model, doc-find, kind, key-side, selection-card,
// folder-mentions, website-mentions, math and doc-model's inlineHtml checks, ported where they are pure.

final class SharedModelTests: XCTestCase {
    // MARK: passage-text, passage-link

    func testNormalizePassage() {
        XCTAssertEqual(PassageText.normalizePassage("  The   Quick\n\tBrown  "), "the quick brown")
        XCTAssertEqual(PassageText.normalizePassage("“Smart” ‘tools’ ′"), "\"smart\" 'tools' '")
        XCTAssertEqual(PassageText.normalizePassage("a – b — c − d"), "a - b - c - d")
        XCTAssertEqual(PassageText.normalizePassage("ﬁnd the ﬂow, eﬀort"), "find the flow, effort")
        XCTAssertEqual(PassageText.normalizePassage("con\u{00AD}struc\u{00AD}tion"), "construction")
        XCTAssertEqual(PassageText.normalizePassage("the construc-\n  tion of it"), "the construction of it")
        XCTAssertEqual(PassageText.normalizePassage("a well-known thing"), "a well-known thing")
        XCTAssertEqual(PassageText.normalizePassage("Section 3-\n4"), "section 3- 4")
        let text = "A ﬁne “day”"
        let f = PassageText.fold(text)
        XCTAssertEqual(f.string, "a fine \"day\"")
        XCTAssertEqual(text.charAt(f.map[f.string.indexOf("fine")]), "ﬁ")
        XCTAssertEqual(f.map[f.map.count - 1], text.len - 1)
    }

    func testMatchPassage() {
        let doc = "@bart why skip short notes?\nbart> It **skips** them because\nbart> they carry [no signal](https://x.y) at all"
        let hit = PassageText.matchPassage(doc, "It skips them because they carry no signal at all", prefixes: true, markdown: true).first!
        XCTAssertTrue(doc.slice(hit.start, hit.end).hasPrefix("It **skips**") && doc.slice(hit.start, hit.end).hasSuffix("at all"))
        XCTAssertTrue(PassageText.matchPassage(doc, "It skips them because they carry").isEmpty)
        XCTAssertEqual(PassageText.matchPassage("a well-\nknown result", "well-known result").count, 1)
        XCTAssertEqual(PassageText.matchPassage("cellonecelltwo", "cell one cell two").count, 1)
        XCTAssertTrue(PassageText.matchPassage("anything", "   ").isEmpty)
    }

    func testSplitTarget() {
        func t(_ h: String) -> LinkTarget { PassageLink.splitTarget(h) }
        XCTAssertEqual(t("/a/b.md#find=one%20two"), LinkTarget(address: "/a/b.md", find: "one two", to: ""))
        XCTAssertEqual(t("/a/b.md#find=one&to=two"), LinkTarget(address: "/a/b.md", find: "one", to: "two"))
        XCTAssertEqual(t("/a/b.md#find=a&b"), LinkTarget(address: "/a/b.md", find: "a&b", to: ""))
        XCTAssertEqual(t("/a/b.md#find=a&to=b&c"), LinkTarget(address: "/a/b.md", find: "a&to=b&c", to: ""))
        XCTAssertEqual(t("/a/b.md#to=x&find=y"), LinkTarget(address: "/a/b.md#to=x&find=y", find: "", to: ""))
        let cite = LinkTarget(address: "/a/My Note.md", find: "search & rank", to: "", cite: "you", counter: false)
        XCTAssertEqual(t("/a/My%20Note.md#find=search%20%26%20rank&cite=you"), cite)
        XCTAssertEqual(t("/a/My%20Note.md#cite=you&find=search%20%26%20rank"), cite)
        XCTAssertEqual(t("/a/b.md#find=x%20y&to=z&cite=other&counter=1"), LinkTarget(address: "/a/b.md", find: "x y", to: "z", cite: "other", counter: true))
        XCTAssertEqual(t("/a/b.md#find=x%20y&counter=1&cite=source&to=z"), LinkTarget(address: "/a/b.md", find: "x y", to: "z", cite: "source", counter: true))
        XCTAssertEqual(t("/a/b.md#counter=1&find=x&cite=source"), LinkTarget(address: "/a/b.md", find: "x", to: "", cite: "source", counter: true))
        XCTAssertEqual(t("/a/b.md#find=x&cite=nobody").cite, "")
        XCTAssertEqual(PassageLink.citeHref(address: "/a/My Note (1).md", find: "a & (b)", cite: "you", counter: true), "/a/My%20Note%20%281%29.md#find=a%20%26%20%28b%29&cite=you&counter=1")
        XCTAssertEqual(t(PassageLink.citeHref(address: "/a/My Note (1).md", find: "a & (b)", cite: "you")), LinkTarget(address: "/a/My Note (1).md", find: "a & (b)", to: "", cite: "you", counter: false))
        XCTAssertEqual(PassageLink.citeHref(address: "https://en.wikipedia.org/wiki/Hint_(education)", find: "x", cite: "source"), "https://en.wikipedia.org/wiki/Hint_%28education%29#find=x&cite=source")
    }

    // MARK: citations

    let NOTE = "[You · Oct 12](/Users/me/Notes/My%20note.md#find=reading%20is%20slow%20when%20the%20figures%20come%20late&cite=you)"
    let NOTE_AGAIN = "[You · Oct 14](/Users/me/Notes/My%20note.md#find=figures%20first%20then%20text&cite=you)"
    let PAPER = "[Smith 2024](https://www.example.org/paper.pdf#find=readers%20skim%20figures%20before%20text&cite=source)"
    let PAPER_SAME = "[Smith 2024](https://example.org/paper.pdf/#find=a%20second%20passage%20of%20it&cite=source)"
    let AGAINST = "[Lee · Sep 2](/Users/me/Meetings/Standup.md#find=nobody%20looks%20at%20the%20figures&cite=other&counter=1)"
    let PLAIN = "[a document link](https://example.org/doc#find=the%20first%20words)"

    func testCitationOf() {
        let c = Cite.citationOf(NOTE)!
        XCTAssertEqual([c.label, c.address, c.key, c.find, c.cite], ["You · Oct 12", "/Users/me/Notes/My note.md", "/Users/me/Notes/My note.md", "reading is slow when the figures come late", "you"])
        XCTAssertFalse(c.counter)
        XCTAssertTrue(Cite.citationOf(AGAINST)!.counter)
        XCTAssertNil(Cite.citationOf(PLAIN))
        XCTAssertNil(Cite.citationOf("[x](/a.md#find=b&cite=maybe)"))
        XCTAssertEqual(Cite.citationOf("[x](/a.md#cite=you)")?.find, "")
        XCTAssertNil(Cite.citationOf("plain words"))
    }

    func testCitationNumbersAndRuns() {
        let lines = ["Reading slows \(NOTE) and readers skim \(PAPER).", "- Against it \(AGAINST), though \(PAPER_SAME) and \(NOTE_AGAIN), as said \(NOTE)."]
        let n = Cite.citationNumbers(lines)
        func of(_ l: String) -> Int? { n[Cite.citationPassage(Cite.citationOf(l)!)] }
        XCTAssertEqual([NOTE, PAPER, AGAINST, PAPER_SAME, NOTE_AGAIN].map(of), [1, 2, 3, 4, 5])
        XCTAssertEqual(n.count, 5)
        XCTAssertEqual(of(PAPER.replacingOccurrences(of: "www.", with: "")), 2)
        XCTAssertEqual(Cite.citationNumbers([lines.joined(separator: "\n")]), n)
        XCTAssertEqual(Cite.citationNumbers(["only \(PLAIN)"]).count, 0)
        XCTAssertTrue(Cite.citationRuns(Inline.tokens("a \(NOTE) b")).allSatisfy { $0 == nil })
        XCTAssertTrue(Cite.citationRuns(Inline.tokens("a \(NOTE) \(PAPER) b")).allSatisfy { $0 == nil })
        let three = Inline.tokens("claim \(NOTE) \(PAPER)\(AGAINST).")
        let runs = Cite.citationRuns(three)
        let first = three.firstIndex(of: NOTE)!, last = three.firstIndex(of: AGAINST)!
        XCTAssertEqual(runs[first], CiteRunRole(run: first, role: .first, last: last, more: 2))
        XCTAssertEqual(runs[first + 1]?.role, .rest)
        XCTAssertNil(runs[0]); XCTAssertNil(runs[last + 1])
        XCTAssertTrue(Cite.citationRuns(Inline.tokens("\(NOTE) and \(PAPER) and \(AGAINST)")).allSatisfy { $0 == nil })
    }

    func testCitationUnitAndHtml() {
        let t = Inline.tokShown(NOTE)
        XCTAssertEqual([t.shown, String(t.pre), "\(t.unit)"], ["", "1", "true"])
        let text = "Slow \(NOTE)."
        XCTAssertEqual(Inline.rawOffset(P(.p, text), 5, line: text), 5)
        XCTAssertEqual(Inline.rawOffset(P(.p, text), 6, line: text), text.len)
        let html = InlineHtml.html("Slow \(NOTE) but \(AGAINST) and \(PLAIN).")
        let circles = Rx(#"<a href="([^"]*)" data-link="1" data-cite="(\w+)" data-n="(\d+)"[^>]*><\/a>"#).matchAll(html)
        XCTAssertEqual(circles.map { "\($0[2]!) \($0[3]!)" }, ["you 1", "other 2"])
        XCTAssertTrue(circles[0].str.contains("data-you=\"1\"")); XCTAssertTrue(circles[1].str.contains("data-counter=\"1\""))
        XCTAssertTrue(circles[0].str.contains("data-source=\"My note.md\""))
        var o = InlineOpts(); o.cites = Cite.citationNumbers(["\(NOTE) \(PAPER)", AGAINST])
        XCTAssertTrue(InlineHtml.html("Later \(AGAINST)", o).contains("data-n=\"3\""))
        let folded = InlineHtml.html("Claim \(NOTE) \(PAPER) \(AGAINST).")
        XCTAssertTrue(Rx(#"^Claim <span data-cite-run="1"><a [^>]*data-n="1"[^>]*><\/a><span data-cite-more="1" data-n="…"[^>]*><\/span><span data-cite-rest="1"> <a [^>]*data-n="2"[^>]*><\/a> <a [^>]*data-n="3"[^>]*><\/a><\/span><\/span>\.$"#).test(folded), folded)
        XCTAssertTrue(InlineHtml.html("[You · Oct 1](/p/Agents/workspace.md#find=a%20b%20c&cite=you)").contains("data-source=\"Agents\""))
        func shown(_ s: String) -> String { Rx(#"<a [^>]*data-cite[^>]*><\/a>"#).replace(InlineHtml.html(s), with: "①") }
        XCTAssertEqual(shown("They are your beliefs, not just \"the process\": \(NOTE)."), "They are your beliefs, not just &quot;the process&quot; ①.")
        XCTAssertEqual(shown("The first step toward preservation — \(NOTE)."), "The first step toward preservation ①.")
        XCTAssertEqual(shown("**It says**: \(NOTE)."), "<strong style=\"font-weight:600\">It says</strong> ①.")
        XCTAssertEqual(shown("Times like 10:30 matter \(NOTE)."), "Times like 10:30 matter ①.")
    }

    func testStreamingAndSources() {
        XCTAssertEqual(Cite.streamingText("We chose OpenAlex \(NOTE). Then more."), "We chose OpenAlex. Then more.")
        XCTAssertEqual(Cite.streamingText("Chosen [You · Oct 12](/a/b.md#find=papers (use openalex) and&cite=you)."), "Chosen.")
        XCTAssertEqual(Cite.streamingText("We chose OpenAlex [You · Oct 1"), "We chose OpenAlex")
        XCTAssertEqual(Cite.streamingText("We chose OpenAlex [You · Oct 12](/Users/me/x.md#find=I%20mean"), "We chose OpenAlex")
        XCTAssertEqual(Cite.streamingText("Read \(PLAIN) and - [ ] this [aside] here."), "Read \(PLAIN) and - [ ] this [aside] here.")
        let names = ["/Users/me/Meetings/Standup.md": "Standup"]
        let sources = Cite.citationSources("A \(NOTE) b \(PAPER) c \(NOTE_AGAIN) d \(AGAINST) e \(NOTE).", citeSource: { names[$0] })
        XCTAssertEqual(sources.map { "\($0.name) \($0.passages.map { String($0.n) }.joined(separator: ","))" }, ["My note.md 1,3", "example.org 2", "Standup 4"])
        let card = Cite.citationCard(label: "You · Oct 14", cite: "you", find: "figures first then text", note: "", source: "My note.md", counter: false)
        XCTAssertEqual(card, Cite.Card(quote: "figures first then text", lead: "", where_: "My note.md", when: "Oct 14", counter: false))
        let note = Cite.citationCard(label: "You · Sep 14", cite: "you", find: "Learners who waited", note: "the wait is what matters", source: "TutorTrace", counter: false)
        XCTAssertEqual([note.quote, note.lead, note.where_, note.when], ["the wait is what matters", "Your note", "TutorTrace", "Sep 14"])
        XCTAssertEqual(Cite.citationCard(label: "Chat · Oct 10", cite: "other", find: "x", note: "", source: "flow", counter: false).lead, "Chat")
        XCTAssertEqual(Cite.citationCard(label: "TutorTrace p. 6", cite: "source", find: "x", note: "", source: "TutorTrace.pdf", counter: false).where_, "TutorTrace p. 6")
    }

    func testCiteOpen() {
        let PROJECT = "/Users/me/.engelbart/Project"
        let index: [String: CiteOpen.WorkspaceNode] = [
            "w1": .init(id: "w1", name: "Onboarding", folder: "Onboarding", parentId: nil),
            "w2": .init(id: "w2", name: "Oct 12", folder: "oct-12", parentId: "w1"),
            "w3": .init(id: "w3", name: "Notes (old)", folder: "Notes (old)", parentId: nil),
        ]
        let notes = [LibRow(id: "n1", name: "Hints", type: "md", tags: ["note"], path: "\(PROJECT)/Hints.md")]
        func href(_ a: String, _ c: String = "you") -> String { PassageLink.citeHref(address: a, find: "ask about the project first", cite: c) }
        XCTAssertEqual(CiteOpen.citedDoc(href("\(PROJECT)/Onboarding/oct-12/workspace.md"), projectDir: PROJECT, index: index, notes: notes), .init(kind: "workspace", id: "w2", name: "Oct 12", find: "ask about the project first", cite: "you"))
        XCTAssertEqual(CiteOpen.citedDoc(href("\(PROJECT)/Onboarding/workspace.md"), projectDir: PROJECT, index: index, notes: notes)?.id, "w1")
        XCTAssertEqual(CiteOpen.citedDoc(href("\(PROJECT)/Notes (old)/workspace.md"), projectDir: PROJECT, index: index, notes: notes)?.id, "w3")
        XCTAssertEqual(CiteOpen.citedDoc(href("\(PROJECT)/Hints.md", "other"), projectDir: PROJECT, index: index, notes: notes), .init(kind: "note", id: "n1", name: "Hints", find: "ask about the project first", cite: "other"))
        XCTAssertNil(CiteOpen.citedDoc(PassageLink.citeHref(address: "/Users/me/Papers/TutorTrace.pdf", find: "x", cite: "source"), projectDir: PROJECT, index: index, notes: notes))
        XCTAssertNil(CiteOpen.citedDoc("\(PROJECT)/Hints.md#find=ask%20about", projectDir: PROJECT, index: index, notes: notes))
        let lines = ["@bart what should the first build be?", "bart+> Build: **Ask about the project** before Connect your library.", "@bart --build Ask about the project before Connect your library.", "And the previews should sleep, not be", "deleted when nobody uses them."]
        XCTAssertEqual(CiteOpen.passageLine(lines, "Ask about the project before Connect your library", cite: "you"), 2)
        XCTAssertEqual(CiteOpen.passageLine(lines, "Ask about the project before Connect your library", cite: "other"), 1)
        XCTAssertEqual(CiteOpen.passageLine(lines, "what should the first build be", cite: "you"), 0)
        XCTAssertEqual(CiteOpen.passageLine(lines, "previews should sleep, not be deleted", cite: "you"), 3)
        XCTAssertEqual(CiteOpen.passageLine(lines, "words that are nowhere here", cite: "you"), -1)
    }

    // MARK: paste, find

    func testPdfText() {
        let copied = ["Large language models have shown remarkable abil-", "ities in a wide range of tasks, including the de-", "sign of experiments and the analysis of their re-", "sults. We study how ﬁne-tuning affects this.", "12", "In this paper we propose a method for the evalu-", "ation of such systems."].joined(separator: "\n")
        XCTAssertEqual(PdfPaste.pdfText(copied), "Large language models have shown remarkable abilities in a wide range of tasks, including the design of experiments and the analysis of their results. We study how fine-tuning affects this. In this paper we propose a method for the evaluation of such systems.")
        XCTAssertEqual(PdfPaste.pdfText("a self-\nSupervised approach that works across a great many different settings and across tasks"), "a self-Supervised approach that works across a great many different settings and across tasks")
        XCTAssertEqual(PdfPaste.pdfText("Introduction to the method that we developed over the course\nof three years of careful experimentation in the lab.\nShort final line.\nThe next paragraph begins here and continues on to\nthe following line without any break in the sentence."),
                       "Introduction to the method that we developed over the course of three years of careful experimentation in the lab. Short final line.\nThe next paragraph begins here and continues on to the following line without any break in the sentence.")
        XCTAssertEqual(PdfPaste.pdfText("The first paragraph of the paper starts here and runs\non to a second line of the column.\n\nThe second paragraph also runs over two lines of\nthe same column on this page."),
                       "The first paragraph of the paper starts here and runs on to a second line of the column.\n\nThe second paragraph also runs over two lines of the same column on this page.")
        XCTAssertEqual(PdfPaste.pdfText("The results are summarised in three main points that we\ndiscuss in turn below, each with its own section:\n1. the first point is about the data that we collected\n2. the second point is about the model we trained on it"),
                       "The results are summarised in three main points that we discuss in turn below, each with its own section:\n1. the first point is about the data that we collected\n2. the second point is about the model we trained on it")
        for kept in ["apples\nbananas\npears", "function f() {\n    return 1;\n    }", "Line one ends here.\nLine two ends here.\nLine three ends here as well.", "```\nsome code that goes on and on and on and on\nand more code here too that is long\n```", "one line alone"] {
            XCTAssertEqual(PdfPaste.pdfText(kept), kept)
        }
        XCTAssertEqual(PdfPaste.pdfText("eﬃcient and\u{00AD}soft"), "efficient andsoft")
    }

    func testSegmentMatches() {
        typealias S = DocFind.Segment
        let segs = [S(text: "The plan, the Plan and THE PLAN.", block: 0)]
        let found = DocFind.segmentMatches(segs, "plan")
        XCTAssertEqual(found.count, 3)
        XCTAssertEqual(found[0], .init(start: .init(seg: 0, offset: 4), end: .init(seg: 0, offset: 8)))
        let s2 = [S(text: "read the ", block: 1), S(text: "related", block: 1), S(text: " work", block: 1), S(text: "work", block: 2), S(text: "shop", block: 3)]
        XCTAssertEqual(DocFind.segmentMatches(s2, "the related work"), [.init(start: .init(seg: 0, offset: 5), end: .init(seg: 2, offset: 5))])
        XCTAssertEqual(DocFind.segmentMatches(s2, "workshop"), [])
        XCTAssertEqual(DocFind.segmentMatches(s2, "work").count, 2)
        let s3 = [S(text: "ab", block: 0), S(text: "", block: 0), S(text: "cd", block: 0)]
        XCTAssertEqual(DocFind.segmentMatches(s3, "bc"), [.init(start: .init(seg: 0, offset: 1), end: .init(seg: 2, offset: 1))])
        XCTAssertEqual(DocFind.segmentMatches([S(text: "aaaa", block: 0)], "aa").count, 2)
        XCTAssertEqual(DocFind.segmentMatches([S(text: "a b", block: 0)], "   "), [])
        let s4 = [S(text: "İstanbul ", block: 0), S(text: "Plan", block: 0)]
        XCTAssertEqual(DocFind.segmentMatches(s4, "plan"), [.init(start: .init(seg: 1, offset: 0), end: .init(seg: 1, offset: 4))])
        XCTAssertEqual(DocFind.nextFind(fresh: true, count: 0, at: -1).at, -1)
        XCTAssertEqual(DocFind.nextFind(fresh: false, step: 1, count: 3, at: 2).at, 0)
        XCTAssertEqual(DocFind.nextFind(fresh: false, step: -1, count: 3, at: 0).at, 2)
        XCTAssertEqual(DocFind.nextFind(fresh: true, step: -1, count: 3, at: 1).at, 2)
        XCTAssertFalse(DocFind.nextFind(fresh: false, step: 0, count: 3, at: 5).scroll)
    }

    // MARK: kind, names, key-side, selection card

    func testKind() {
        func r(_ type: String, _ tags: [String] = [], source: String? = nil) -> LibRow { LibRow(id: type + tags.joined(), name: "", type: type, tags: tags, source: source) }
        XCTAssertEqual([r("md", ["note"]), r("md"), r("pdf", ["paper"]), r("website", ["git"]), r("folder", ["git"]), r("csv"), r("parquet"), r("image")].map { Kind.kindKey($0) }, ["note", "md", "pdf", "git", "git", "data", "data", "image"])
        XCTAssertEqual(Kind.kindKey(nil), "note")
        XCTAssertEqual([Kind.kindLabel(r("md", ["note"])), Kind.kindLabel(r("website", ["paper"])), Kind.kindLabel(r("csv"))], ["md · note", "link · paper", "csv"])
        XCTAssertFalse(Kind.isNote(r("note")))
        let rows = [r("md", ["note"]), r("md"), r("pdf", ["paper"]), r("folder", ["git"]), r("website", ["git"]), r("website"), r("html"), r("docx"), r("folder"), r("csv"), r("image"), r("image", source: "create"), r("html", source: "create")]
        XCTAssertEqual(Kind.libraryCounts(rows), ["all": 12, "notes": 1, "papers": 1, "repos": 2, "web": 2, "files": 4, "assets": 2])
        XCTAssertEqual(Names.wsLabel("Workspace"), "Workspace")
        XCTAssertEqual(Names.wsLabel("Onboarding flow"), "Onboardi…")
        XCTAssertEqual(Names.wsLabel(""), "Workspace")
        XCTAssertEqual(Names.nextUntitled("Note", ["Untitled Note 1", "Untitled Note 3"]), "Untitled Note 2")
        XCTAssertTrue(Names.isUntitled("Untitled Workspace 4")); XCTAssertFalse(Names.isUntitled("Untitled thing"))
    }

    func testKeySide() {
        XCTAssertTrue(KeySide.docHasKeys("doc")); XCTAssertFalse(KeySide.docHasKeys("stage"))
        XCTAssertFalse(KeySide.docHasKeys("doc", docShown: false)); XCTAssertTrue(KeySide.docHasKeys("stage", docFull: true))
        let tabs = ["ws", "n1", "n2"]
        XCTAssertEqual(KeySide.docClose(tabs: tabs, active: "n1"), .tab("n1"))
        XCTAssertEqual(KeySide.docClose(tabs: tabs, active: "n1", pane: 1, beside: 1), .pane(1))
        XCTAssertEqual(KeySide.docClose(tabs: tabs, active: "n1", pane: 1, beside: 0), .tab("n1"))
        XCTAssertNil(KeySide.docClose(tabs: tabs, active: "ws"))
        XCTAssertNil(KeySide.docClose(tabs: ["project"], active: "project"))
        XCTAssertEqual(KeySide.docClose(tabs: ["project", "n1"], active: "project"), .tab("project"))
        XCTAssertNil(KeySide.docClose(tabs: tabs, active: "gone"))
        final class El { let side: String?; let pane: Int?; init(_ s: String?, _ p: Int? = nil) { side = s; pane = p } }
        let t = SideTracker<El>(sideOf: { $0?.side.flatMap { SideTracker<El>.Side(rawValue: $0) } }, paneOf: { $0?.pane })
        XCTAssertEqual(t.side, .doc)
        let stage = El("stage"), editor = El("doc", 1), sidebar = El(nil)
        t.pressed(stage); XCTAssertEqual(t.side, .stage)
        t.pressed(sidebar); XCTAssertEqual(t.side, .stage, "the sidebar leaves it")
        t.pressed(editor); XCTAssertEqual(t.side, .doc); XCTAssertEqual(t.pane, 1)
        t.left(editor); t.page(); XCTAssertEqual(t.side, .stage)
        t.focused(editor); XCTAssertEqual(t.side, .stage, "the app getting the keyboard back is no click")
    }

    func testSelectionCard() {
        let pane = CGRect(x: 0, y: 0, width: 800, height: 600), size = CGSize(width: 240, height: 60)
        XCTAssertEqual(SelectionCard.place(line: CGRect(x: 120, y: 300, width: 200, height: 16), all: CGRect(x: 40, y: 260, width: 400, height: 56), pane: pane, size: size), CGRect(x: 120, y: 324, width: 240, height: 60))
        XCTAssertEqual(SelectionCard.place(line: CGRect(x: 120, y: 560, width: 200, height: 16), all: CGRect(x: 40, y: 520, width: 400, height: 56), pane: pane, size: size), CGRect(x: 120, y: 452, width: 240, height: 60))
        XCTAssertEqual(SelectionCard.place(line: CGRect(x: 700, y: 100, width: 60, height: 16), all: nil, pane: pane, size: size), CGRect(x: 560, y: 124, width: 240, height: 60))
        XCTAssertEqual(SelectionCard.place(line: CGRect(x: 10, y: 580, width: 60, height: 16), all: CGRect(x: 10, y: 20, width: 600, height: 576), pane: pane, size: size), CGRect(x: 10, y: 540, width: 240, height: 60))
        XCTAssertEqual(SelectionCard.place(line: CGRect(x: 50, y: 10, width: 20, height: 10), all: nil, pane: CGRect(x: 30, y: 0, width: 100, height: 600), size: size), CGRect(x: 30, y: 28, width: 100, height: 60))
        XCTAssertNil(SelectionCard.place(line: CGRect(x: 10, y: 700, width: 60, height: 16), all: nil, pane: pane, size: size))
        XCTAssertNil(SelectionCard.place(line: nil, all: nil, pane: pane, size: size))
    }

    // MARK: mentions of folders, pages, files

    func testFolderMentions() {
        let rel = "sub dir/Smith (2024) #2.pdf"
        XCTAssertEqual(Inline.encodeRel(rel), "sub%20dir/Smith%20%282024%29%20%232.pdf")
        XCTAssertEqual(Inline.decodeRel(Inline.encodeRel(rel)), rel)
        let tok = Inline.fileMention("Smith (2024) #2.pdf", "f-1", rel)
        XCTAssertEqual(Inline.tokens("see \(tok) now"), ["see ", tok, " now"])
        XCTAssertEqual(Inline.fileMentionOf(tok), .init(name: "Smith (2024) #2.pdf", folderId: "f-1", rel: rel))
        XCTAssertEqual(Inline.fileMention(nil, "f", "a/b [x].md"), "@[b x.md](lib:f:a/b%20%5Bx%5D.md)")
        XCTAssertEqual(Inline.folderPath("Papers", "sub/inner"), "@Papers/sub/inner/")
        XCTAssertEqual(Inline.folderMentionAt("see @Papers/smi th", 18, start: 4, path: "@Papers/"), .query("smi th", start: 4))
        XCTAssertEqual(Inline.folderMentionAt("see @Papers/sub/", 16, start: 4, path: "@Papers/"), .into("sub", start: 4))
        XCTAssertNil(Inline.folderMentionAt("see @Pap", 8, start: 4, path: "@Papers/"))
        XCTAssertEqual(Inline.fileKindOf("a.PDF"), "pdf"); XCTAssertEqual(Inline.fileKindOf("x.jsonl"), "data"); XCTAssertEqual(Inline.fileKindOf("noext"), "file")
        var o = InlineOpts()
        o.libName = { $0 == "f-1" ? .name("Papers") : .unknown }
        o.fileState = { _, r in r == "gone.pdf" ? .missing : .exists(dir: false) }
        let html = InlineHtml.html(tok, o)
        XCTAssertTrue(html.contains("title=\"Papers / \(rel)\""), html)
        XCTAssertTrue(InlineHtml.html(Inline.fileMention("gone.pdf", "f-1", "gone.pdf"), o).contains("data-missing=\"1\""))
    }

    func testWebNames() {
        XCTAssertEqual(WebName.webLabel("https://www.example.com/a/b/?q=1#x"), "example.com/a/b")
        XCTAssertEqual(WebName.webLabel("https://github.com/mqo00/rope"), "github.com/mqo00/rope")
        XCTAssertEqual(WebName.webName("https://github.com/mqo00/rope", "https://github.com/mqo00/rope"), "github.com/mqo00/rope")
        XCTAssertEqual(WebName.webName("ROPE [repo]", "https://github.com/mqo00/rope"), "ROPE repo")
        XCTAssertTrue(WebName.sameAddress("http://www.x.org/a/", "https://x.org/a#top"))
        let row = LibRow(id: "w-1", name: "https://github.com/mqo00/rope", type: "website", url: "https://github.com/mqo00/rope")
        XCTAssertEqual(Mention.rowMention(row), "@[github.com/mqo00/rope](lib:w-1)")
        XCTAssertEqual(Mention.rowMention(LibRow(id: "i-1", name: "Attachment 1", type: "image", path: "/a.png")), "@[Attachment 1](lib:i-1)")
        XCTAssertEqual(Mention.rowMention(LibRow(id: "n", name: "Plan", type: "md", tags: ["note"])), "@[Plan]")
        XCTAssertEqual(Mention.mentionToken(MenuItem(kind: .workspace, key: "w", name: "Other", id: "w9")), "@[Other](ws:w9)")
        XCTAssertEqual(Mention.mentionToken(MenuItem(kind: .fresh, key: "f", name: "https://x.org/p", input: "https://x.org/p")), "@[x.org/p]")
        var o = InlineOpts(); o.webKind = { _, id in id == "w-1" ? "git" : nil }
        XCTAssertTrue(InlineHtml.html("@[rope](lib:w-1)", o).contains("<svg viewBox=\"0 0 16 16\" width=\"0.8em\" height=\"0.8em\" fill=\"currentColor\""))
        o.named = { _ in false }
        XCTAssertTrue(InlineHtml.html("@[https://x.org/page]", o).contains("data-url=\"https://x.org/page\""))
        XCTAssertEqual(Inline.tokShown("@[https://www.x.org/page/]").shown, "@x.org/page")
        XCTAssertEqual(Mention.mentionedIds("@[Plan] and @[A](lib:a-1) and @[F](lib:f-2:x.pdf) and @[W](ws:w)", [LibRow(id: "p-1", name: "plan", type: "md")]), ["a-1", "f-2", "p-1"], "a file in a folder is a mention of its folder")
    }

    func testInlineHtmlParity() {
        XCTAssertEqual(InlineHtml.html("a **b** c"), "a <strong style=\"font-weight:600\">b</strong> c")
        XCTAssertEqual(InlineHtml.html("*i*"), "<em>i</em>")
        XCTAssertEqual(InlineHtml.html("`c`"), "<code style=\"padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)\">c</code>")
        XCTAssertEqual(InlineHtml.html("@bart go"), "<span style=\"color:#0070f3;font-weight:500\">@bart</span> go")
        XCTAssertTrue(Rx(#"^<span data-mention="hypocompass" style="[^"]*">@hypocompass<\/span>$"#).test(InlineHtml.html("@[hypocompass]")))
        XCTAssertTrue(Rx(#"^<a href="https:\/\/a\.b" data-link="1"[^>]*>t<\/a>$"#).test(InlineHtml.html("[t](https://a.b)")))
        XCTAssertEqual(InlineHtml.html("<b>&\""), "&lt;b&gt;&amp;&quot;")
        let STYLE = "color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9"
        XCTAssertEqual(InlineHtml.html("see @[A <b>](lib:x-1)"), "see <span data-mention=\"A &lt;b&gt;\" data-lib=\"x-1\" style=\"\(STYLE)\">@A &lt;b&gt;</span>")
        var o = InlineOpts(); o.libName = { $0 == "x-1" ? .name("Renamed") : .gone }
        XCTAssertEqual(InlineHtml.html("@[A](lib:x-1)", o), "<span data-mention=\"Renamed\" data-lib=\"x-1\" style=\"\(STYLE)\">@Renamed</span>")
        o.libName = { _ in .gone }
        XCTAssertTrue(Rx(#"^<span [^>]*color:#8f8f8f[^>]*>@A<\/span>$"#).test(InlineHtml.html("@[A](lib:x-1)", o)))
        XCTAssertTrue(InlineHtml.html("@[bart:x]").contains("This chat is gone"))
        XCTAssertTrue(InlineHtml.html("@[Plan](ws:w-1)").contains("\">@<svg "), "the @, the icon right after it, then the name")
        XCTAssertFalse(InlineHtml.html("@[Plan]").contains("<svg"))
        o = InlineOpts(); o.trashed = { n, _ in n == "Old" }
        XCTAssertTrue(InlineHtml.html("@[Old]", o).contains("title=\"In trash\""))
        o = InlineOpts(); o.named = { _ in false }
        XCTAssertTrue(InlineHtml.html("@[Nothing]", o).contains("Not in the library"))
        XCTAssertTrue(InlineHtml.html("![Attachment 1](img:abc)").contains("data-attachment=\"abc\""))
        XCTAssertEqual(InlineHtml.html("**[A paper](https://arxiv.org/abs/1)** · Ada"), "<strong style=\"font-weight:600\"><a href=\"https://arxiv.org/abs/1\" data-link=\"1\" style=\"color:#0070f3;text-decoration:underline;text-underline-offset:3px;padding:5px 2px;margin:-5px -2px;border-radius:3px;cursor:pointer\">A paper</a></strong> · Ada")
        XCTAssertTrue(Inline.holdsLink("**[A](https://a.b)**")); XCTAssertTrue(Inline.holdsLink("https://x.y")); XCTAssertFalse(Inline.holdsLink("plain"))
        var b = InlineOpts(); b.buildTurn = 3
        XCTAssertTrue(InlineHtml.html("Press [[build]] Build", b).contains("data-act=\"footbuild\" data-turn=\"3\""))
        XCTAssertEqual(Inline.tokShown("[[build]]").unit, true)
    }

    // MARK: math

    func testMath() {
        XCTAssertEqual(Inline.tokens("so $x^2$ grows"), ["so ", "$x^2$", " grows"])
        XCTAssertEqual(Inline.tokens("$5 and $10"), ["$5 and $10"])
        XCTAssertEqual(Inline.tokens("costs \\$5"), ["costs ", "\\$", "5"])
        XCTAssertEqual(Inline.tokens("$ x$ and $y $"), ["$ x$ and $y $"])
        XCTAssertEqual(Inline.tokens("$a$5"), ["$a$5"])
        XCTAssertEqual(Inline.tokens("`$x$` stays code"), ["`$x$`", " stays code"])
        XCTAssertEqual(MathText.render("x^2", display: false), "x²")
        XCTAssertEqual(MathText.render("\\alpha + \\beta_i", display: false), "α + βᵢ")
        XCTAssertEqual(MathText.render("\\frac{1}{2}", display: false), "1⁄2")
        XCTAssertEqual(MathText.render("\\sqrt{x}", display: false), "√x")
        XCTAssertEqual(MathText.render("\\bar x", display: false), "x\u{0304}")
        XCTAssertEqual(MathText.render("\\mathbb{R}^n", display: false), "ℝⁿ")
        XCTAssertNil(MathText.render("\\frac{", display: false))
        XCTAssertNil(MathText.render("\\unknowncommand x", display: false))
        XCTAssertEqual(MathText.render("\\kappa = 0.79", display: false), "κ = 0.79")
        let t = Inline.tokShown("$\\frac{$")
        XCTAssertEqual([t.shown, String(t.pre), "\(t.unit)"], ["$\\frac{$", "0", "false"])
        let shown = MathText.render("x^2", display: false)!
        let line = "a $x^2$ b", p = P(.p, line)
        XCTAssertEqual(Inline.rawOffset(p, 2, line: line), 2)
        XCTAssertEqual(Inline.rawOffset(p, 2 + shown.len, line: line), 7)
        XCTAssertEqual(Inline.rawOffset(p, 3, line: line), 7)
        XCTAssertEqual(Inline.rawOffset(p, 2 + shown.len + 2, line: line), 9)
        XCTAssertEqual(Inline.rawOffset(P(.p, "costs \\$5"), 7, line: "costs \\$5"), 8)
        let lines = ["a $x^2$ b", "next line"]
        XCTAssertEqual(Doc.selectionMarkdown(lines, DocPoint(line: 0, offset: 0), DocPoint(line: 0, offset: 9)), "a $x^2$ b")
        XCTAssertEqual(Doc.selectionMarkdown(lines, DocPoint(line: 0, offset: 1), DocPoint(line: 0, offset: 8)), " $x^2$ ")
        XCTAssertEqual(Doc.selectionMarkdown(lines, DocPoint(line: 0, offset: 4), DocPoint(line: 1, offset: 4)), "$x^2$ b\nnext")
        XCTAssertEqual(Doc.selectionMarkdown(lines, DocPoint(line: 0, offset: 3), DocPoint(line: 0, offset: 5)), "x^")
        XCTAssertEqual(Doc.selectionHtml("so $x^2$ and \\$5"), "so $x^2$ and $5")
        XCTAssertTrue(InlineHtml.textMathHtml("If $p < 0.05$, is <b> real?").hasPrefix("If <span data-math=\"1\""))
        XCTAssertTrue(InlineHtml.textMathHtml("If $p < 0.05$, is <b> real?").hasSuffix(", is &lt;b&gt; real?"))
        XCTAssertEqual(InlineHtml.textMathHtml("**not bold** and \\$3"), "**not bold** and $3")
        XCTAssertTrue(InlineHtml.html("bad $\\frac{$ here").contains("<code data-math-error=\"1\""))
    }

    // MARK: misc

    func testDropAndAsk() {
        XCTAssertEqual(Drop.readDrop(files: [], uriList: "# comment\nhttps://x.org/a.png\n", html: nil), [.url("https://x.org/a.png")])
        XCTAssertEqual(Drop.readDrop(files: [], uriList: "https://www.google.com/imgres?imgurl=https://p.org/i.jpg&x=1", html: nil), [.url("https://p.org/i.jpg")])
        XCTAssertEqual(Drop.readDrop(files: [], uriList: "", html: "<p><img alt=\"x\" src='https://p.org/a&amp;b.png'></p>"), [.url("https://p.org/a&b.png")])
        XCTAssertEqual(Drop.readDrop(files: [.path("/a.png")], uriList: "https://x.org", html: nil), [.path("/a.png")])
        XCTAssertEqual(Drop.readDrop(files: [], uriList: "", html: ""), [])
        XCTAssertTrue(Drop.isPastable(.path("/x/Shot.PNG"))); XCTAssertFalse(Drop.isPastable(.path("/x/a.pdf")))
        XCTAssertTrue(Drop.isPastable(.bytes(Data(), mime: "image/webp", name: nil))); XCTAssertFalse(Drop.isPastable(.bytes(Data(), mime: "image/tiff", name: nil)))
        XCTAssertEqual(AskLine.findAskLine(["a", "@chat why", "b", "@bart why"], text: "@bart why", line: 1, routedTo: "chat"), 1)
        XCTAssertEqual(AskLine.findAskLine(["a"], text: "  ", line: 0), -1)
        XCTAssertEqual(AskLine.findBuildLine(["x", "build> 0123456789 "], "0123456789"), 1)
        let a = MarkAnswers.answerOf(["bart> one", "bart+> two", "bart> ", "bart> *Sol · high · 12 s*"])
        XCTAssertEqual([a.answer, a.foot], ["one\ntwo", "Sol · high · 12 s"])
        let blocks = MarkdownFile.blocks("# Title\n\npara one\ncontinues\n- [x] done\n  1. sub\n> q1\n> q2\n```js\ncode\n```\n---")
        XCTAssertEqual(blocks, [.h(level: 1, text: "Title"), .p("para one continues"), .li(ordered: false, marker: "-", depth: 0, checked: true, text: "done"), .li(ordered: true, marker: "1.", depth: 1, checked: nil, text: "sub"), .quote("q1 q2"), .code(lang: "js", text: "code"), .hr])
        XCTAssertEqual(MarkdownFile.runs("a **b** `c` [d](e) https://f.g."), [.init(text: "a "), .init(text: "b", bold: true), .init(text: " "), .init(text: "c", code: true), .init(text: " "), .init(text: "d", href: "e"), .init(text: " "), .init(text: "https://f.g", href: "https://f.g"), .init(text: ".")])
    }

    func testDocSync() {
        var taken: [String] = [], conflicts = 0, edits = false
        let sync = DocSync(hasEdits: { _ in edits }, take: { _, t in taken.append(t) }, conflict: { _, _ in conflicts += 1 })
        XCTAssertEqual(sync.announced("k", (text: "a", revision: 1)), .take)
        XCTAssertEqual(sync.announced("k", (text: "old", revision: 1)), .ignore)
        sync.saving("k")
        XCTAssertEqual(sync.announced("k", (text: "b", revision: 3)), .wait)
        XCTAssertEqual(sync.saved("k", 2), .take)
        XCTAssertEqual(taken, ["a", "b"])
        edits = true
        XCTAssertEqual(sync.announced("k", (text: "c", revision: 4)), .conflict)
        XCTAssertEqual(conflicts, 1)
    }
}
