import XCTest
@testable import EngelbartStage
import EngelbartDoc

// test/stage-model.test.cjs, test/browser.test.cjs (addresses), test/kind.test.cjs, ported.

private func row(_ id: String, _ name: String, _ type: String, _ tags: [String] = [], url: String? = nil, path: String? = nil, folder: String? = nil) -> StageRow {
    StageRow(id: id, name: name, type: type, tags: tags, path: path, folderPath: folder, url: url)
}
private let library = [
    row("n1", "Saving and importing", "md", ["note"], path: "/Users/h/.engelbart/p/Saving.md"),
    row("m1", "README.md", "md", path: "/Users/h/code/README.md"),
    row("p1", "ColBERT", "pdf", ["paper"], path: "/Users/h/ColBERT.pdf"),
    row("w1", "Contextual Retrieval", "website", url: "https://www.anthropic.com/engineering/contextual-retrieval"),
    row("c1", "problems.csv", "csv", path: "/Users/h/problems.csv"),
    row("f1", "fixtures", "folder", folder: "/Users/h/fixtures"),
    row("g1", "o/r", "folder", ["git"], url: "https://github.com/o/r", folder: "/Users/h/r"),
]
private func tab(_ id: String = IDsForTests.next(), url: String = "about:blank", item: String? = nil, claimed: Bool = false, pdfURL: String? = nil, filePath: String? = nil) -> StageTab {
    var t = StageTab(id: id)
    t.url = url; t.item = item; t.claimed = claimed
    if let pdfURL { t.pdf = StagePDF(url: pdfURL, input: "", name: "") }
    if let filePath { t.file = StageFile(kind: .md, path: filePath, name: "") }
    return t
}
enum IDsForTests { static var n = 0; static func next() -> String { n += 1; return "t\(n)" } }

final class AddressTests: XCTestCase {
    func testLocalServersGetHttpTheWebGetsHttps() {
        let k = StageAddress.kindOf
        XCTAssertEqual(k("3000").url, "http://localhost:3000")
        XCTAssertEqual(k(":5173/docs").url, "http://localhost:5173/docs")
        XCTAssertEqual(k("localhost:8080/x").url, "http://localhost:8080/x")
        XCTAssertEqual(k("0.0.0.0:3000").url, "http://localhost:3000")
        XCTAssertEqual(k("127.0.0.1:4000").kind, .local)
        XCTAssertEqual(k("192.168.1.4").kind, .local)
        XCTAssertEqual(k("172.20.0.1").kind, .local)
        XCTAssertEqual(k("devbox:8080").url, "http://devbox:8080")
        XCTAssertEqual(k("myapp.local").url, "http://myapp.local")
        XCTAssertEqual(k("https://localhost:3000").url, "https://localhost:3000")
        XCTAssertEqual(k("example.com").url, "https://example.com")
        XCTAssertEqual(k("http://example.com").url, "http://example.com")
        XCTAssertEqual(k("").kind, .blank)
        XCTAssertEqual(k("about:blank").kind, .blank)
        XCTAssertEqual(k("sandbox://manifund").name, "manifund")
        XCTAssertEqual(k("file:///Users/h/a.html").kind, .disk)
        XCTAssertEqual(k("~/x.md").kind, .file)
        XCTAssertEqual(k("report.html").kind, .file)
    }

    func testWordsAreAGoogleSearch() {
        XCTAssertEqual(StageAddress.kindOf("what is rag").url, "https://www.google.com/search?q=what%20is%20rag")
        XCTAssertEqual(StageAddress.kindOf("colbert").url, "https://www.google.com/search?q=colbert")
    }

    func testSchemeHiddenOnlyWhenTypingTheRestLeadsBack() {
        XCTAssertEqual(StageAddress.stripScheme("https://example.com/"), "example.com")
        XCTAssertEqual(StageAddress.stripScheme("https://example.com/a"), "example.com/a")
        XCTAssertEqual(StageAddress.stripScheme("http://example.com/a"), "http://example.com/a")
        XCTAssertEqual(StageAddress.stripScheme("http://localhost:3000/"), "localhost:3000")
        XCTAssertEqual(StageAddress.stripScheme("file:///Users/h/a%20b.html"), "/Users/h/a b.html")
        XCTAssertEqual(StageAddress.stripScheme("about:blank"), "")
    }

    func testAddressKeyAndPreview() {
        XCTAssertEqual(AddressKey.addressKey("https://www.Example.org/a/#x"), AddressKey.addressKey("http://example.org/a"))
        XCTAssertNotEqual(AddressKey.addressKey("https://example.org/a?id=1"), AddressKey.addressKey("https://example.org/a?id=2"))
        XCTAssertEqual(AddressKey.addressKey("https://example.org/a?utm_source=x&id=2&fbclid=y"), "example.org/a?id=2")
        XCTAssertEqual(AddressKey.addressKey("file:///Users/h/a.md#x"), "file:///Users/h/a.md")
        XCTAssertEqual(AddressKey.addressKey("not a url"), "not a url")
        XCTAssertTrue(AddressKey.isPreviewAddress("http://localhost:3000"))
        XCTAssertTrue(AddressKey.isPreviewAddress("https://5173-abc.e2b.app/"))
        XCTAssertTrue(AddressKey.isPreviewAddress("http://[::1]:8000"))
        XCTAssertFalse(AddressKey.isPreviewAddress("https://example.org"))
        XCTAssertFalse(AddressKey.isPreviewAddress("file:///Users/h/a.html"))
    }

    func testGithubSignInPages() {
        XCTAssertTrue(GitHubPages.isSignIn("https://github.com/login"))
        XCTAssertTrue(GitHubPages.isSignIn("https://github.com/login/oauth/authorize?x"))
        XCTAssertTrue(GitHubPages.isSignIn("https://github.com/apps/engelbart/installations/new"))
        XCTAssertFalse(GitHubPages.isSignIn("https://github.com/o/r"))
        XCTAssertFalse(GitHubPages.isSignIn("https://user:pw@github.com/login"))
        XCTAssertTrue(GitHubPages.endedSession(from: "https://github.com/o/r", to: "https://github.com/login?return_to=x"))
        XCTAssertFalse(GitHubPages.endedSession(from: "https://github.com/login", to: "https://github.com/login"))
        XCTAssertFalse(GitHubPages.endedSession(from: "https://github.com/o/r", to: "https://github.com/session"))
    }

    func testWebName() {
        XCTAssertEqual(WebName.webName("Example", "https://example.org"), "Example")
        XCTAssertEqual(WebName.webName("https://www.example.org/a/", "https://www.example.org/a/"), "example.org/a")
        XCTAssertEqual(WebName.webName("", "https://example.org/path?x=1#y"), "example.org/path")
        XCTAssertEqual(WebName.webLabel(""), "Untitled page")
        XCTAssertEqual(WebName.webLabel("https://example.org/" + String(repeating: "a", count: 80)).count, 60)
    }
}

final class KindTests: XCTestCase {
    func testTypeAndTags() {
        XCTAssertEqual(Kind.kindKey(row("a", "a", "md", ["note"])), "note")
        XCTAssertEqual(Kind.kindKey(row("a", "a", "md")), "md")
        XCTAssertEqual(Kind.kindKey(row("a", "a", "website", ["git"])), "git")
        XCTAssertEqual(Kind.kindKey(row("a", "a", "jsonl")), "data")
        XCTAssertEqual(Kind.kindLabel(row("a", "a", "website", ["paper"])), "link · paper")
        XCTAssertEqual(Kind.kindRank(row("a", "a", "image")), Kind.KIND_ORDER.count)
    }
    func testChips() {
        XCTAssertTrue(Kind.libraryFilter(row("g", "g", "website", ["git"]), "repos"))
        XCTAssertFalse(Kind.libraryFilter(row("g", "g", "website", ["git"]), "web"))
        XCTAssertFalse(Kind.libraryFilter(row("i", "i", "image"), "all"))
        var made = row("c", "c", "image"); made.source = "create"
        XCTAssertTrue(Kind.libraryFilter(made, "assets"))
        XCTAssertTrue(Kind.libraryFilter(row("d", "d", "docx"), "files"))
        XCTAssertEqual(Kind.libraryCounts(library)["notes"], 1)
    }
}

final class StageModelTests: XCTestCase {
    func testTabKey() {
        XCTAssertEqual(StageModel.tabKey(tab()), "")
        XCTAssertEqual(StageModel.tabKey(tab(url: "https://x.org", item: "p1")), "i:p1")
        XCTAssertEqual(StageModel.tabKey(tab(pdfURL: "https://x.org/a.pdf")), "l:x.org/a.pdf")
        XCTAssertEqual(StageModel.tabKey(tab(filePath: "/Users/h/a.md")), "l:file:///Users/h/a.md")
    }

    func testPlaceTab() {
        let tabs = [tab(url: "https://a.org"), tab(), tab(item: "p1")]
        XCTAssertEqual(StageModel.placeTab(tabs, 0, "i:p1"), .focus(2))
        XCTAssertEqual(StageModel.placeTab(tabs, 1, "l:b.org"), .replace(1))
        XCTAssertEqual(StageModel.placeTab(tabs, 0, "l:b.org"), .append)
        XCTAssertEqual(StageModel.placeTab(tabs, 1, "i:p9", also: StageModel.tabKey(tabs[0])), .focus(0))
        XCTAssertEqual(StageModel.placeTab(tabs, 0, "i:p1", newTab: true), .append)
        let full = (0..<15).map { tab(url: "https://s\($0).org") }
        XCTAssertEqual(StageModel.placeTab(full, 4, "l:new.org"), .replace(4))
        XCTAssertEqual(StageModel.placeTab([tab(pdfURL: "")], 0, "l:b.org"), .append)
        XCTAssertEqual(StageModel.placeTab([tab(claimed: true)], 0, "l:b.org"), .append)
        let key = StageModel.linkPlan("https://github.com/mqo00/rope", library).key
        let rope = tab(url: "https://github.com/mqo00/rope")
        XCTAssertEqual(StageModel.placeTab([rope], 0, key), .focus(0))
        XCTAssertEqual(StageModel.placeTab([rope], 0, key, newTab: true), .append)
        XCTAssertEqual(StageModel.placeTab([rope, tab()], 1, key, newTab: true), .replace(1))
        var fullRope = (0..<15).map { tab(url: "https://s\($0).org") }
        fullRope[2] = rope
        XCTAssertEqual(StageModel.placeTab(fullRope, 4, key, newTab: true), .replace(4))
        XCTAssertEqual(StageModel.placeTab(fullRope, 4, key), .focus(2))
    }

    func testAfterCloseWidthsLooksPlaces() {
        XCTAssertEqual(StageModel.afterClose(count: 3, activeIndex: 1, closedIndex: 1), 1)
        XCTAssertEqual(StageModel.afterClose(count: 3, activeIndex: 2, closedIndex: 2), 1)
        XCTAssertEqual(StageModel.afterClose(count: 3, activeIndex: 2, closedIndex: 0), 1)
        XCTAssertEqual(StageModel.afterClose(count: 3, activeIndex: 0, closedIndex: 2), 0)
        XCTAssertEqual(StageModel.afterClose(count: 1, activeIndex: 0, closedIndex: 0), -1)
        XCTAssertEqual(StageModel.tabWidth(room: 1000, count: 3), 220)
        XCTAssertEqual(StageModel.tabWidth(room: 1000, count: 8), 125)
        XCTAssertEqual(StageModel.tabWidth(room: 601, count: 15), 40)
        XCTAssertEqual(StageModel.tabWidth(room: 300, count: 15), 36)
        XCTAssertEqual(StageModel.tabWidth(room: 500, count: 0), 220)
        XCTAssertEqual(StageModel.tabLook(width: 90, active: false), .full)
        XCTAssertEqual(StageModel.tabLook(width: 89, active: false), .icon)
        XCTAssertEqual(StageModel.tabLook(width: 89, active: true), .iconX)
        XCTAssertEqual(StageModel.tabLook(width: 56, active: true), .iconX)
        XCTAssertEqual(StageModel.tabLook(width: 55, active: true), .x)
        XCTAssertEqual(StageModel.tabPlace("https://www.anthropic.com/engineering/x"), "anthropic.com")
        XCTAssertEqual(StageModel.tabPlace("file:///Users/h/a%20b.md"), "/Users/h/a b.md")
        XCTAssertEqual(StageModel.tabPlace("~/x.pdf"), "~/x.pdf")
        XCTAssertEqual(StageModel.tabPlace("about:blank"), "")
    }

    func testLooksLikePlace() {
        for yes in ["https://a.org", "example.com", "example.com/a/b", "localhost:3000", ":5173", "3000", "~/x.pdf", "/Users/h/a.csv", "report.html", "docs/a.md", "file:///Users/h/a.md", "2310.05292"] {
            XCTAssertTrue(StageModel.looksLikePlace(yes), yes)
        }
        for no in ["", "colbert", "contextual retrieval", "what is rag"] { XCTAssertFalse(StageModel.looksLikePlace(no), no) }
    }

    func testStageRows() {
        let inRail: (String) -> Bool = { ["n1", "p1"].contains($0) }
        let empty = StageModel.stageRows(query: "", library: library, inRail: inRail)
        XCTAssertEqual(empty.map(\.key), ["p1", "m1", "w1", "c1", "f1", "g1", "disk"])
        if case .item(_, let here) = empty[0] { XCTAssertTrue(here) } else { XCTFail() }
        XCTAssertEqual(StageModel.stageRows(query: "saving", library: library, inRail: inRail).map(\.key), ["search:saving", "disk"])
        XCTAssertEqual(StageModel.stageRows(query: "colb", library: library, inRail: inRail).map(\.key), ["p1", "search:colb", "disk"])
        XCTAssertEqual(StageModel.stageRows(query: "https://x.org/a.pdf", library: library, inRail: { _ in false }).map(\.key), ["place:https://x.org/a.pdf", "disk"])
        let known = StageModel.stageRows(query: "https://www.anthropic.com/engineering/contextual-retrieval", library: library, inRail: { _ in false }, found: .some(library[3]))
        XCTAssertEqual(known.first?.key, "w1")
        let note = StageModel.stageRows(query: "/Users/h/.engelbart/p/Saving.md", library: library, inRail: { _ in false }, found: .some(library[0]))
        XCTAssertEqual(note.first?.key, "place:/Users/h/.engelbart/p/Saving.md")
    }

    func testOnStage() {
        for id in ["m1", "p1", "w1", "c1", "f1", "g1"] { XCTAssertTrue(StageModel.onStage(library.first { $0.id == id }), id) }
        XCTAssertFalse(StageModel.onStage(library[0]))
        XCTAssertFalse(StageModel.onStage(row("x1", "nowhere", "folder")))
        XCTAssertFalse(StageModel.onStage(row("ws", "Reading", "workspace")))
    }

    func testParseTable() {
        XCTAssertEqual(StageModel.parseTable("a,b\n1,\"x, y\"\n2,\"say \"\"hi\"\"\"\n"), [["a", "b"], ["1", "x, y"], ["2", "say \"hi\""]])
        XCTAssertEqual(StageModel.parseTable("a\tb\r\n1\t2", delimiter: "\t"), [["a", "b"], ["1", "2"]])
        XCTAssertEqual(StageModel.parseTable("a\n\"line\nbreak\""), [["a"], ["line\nbreak"]])
        XCTAssertEqual(StageModel.parseTable("1\n2\n3\n4", limit: 2).count, 2)
    }

    func testMarkdown() {
        let blocks = MarkdownFile.blocks("# Title\n\nOne\ntwo\n\n- a\n  - [x] b\n1. c\n> q1\n> q2\n```js\nx # not a heading\n```\n---\n")
        XCTAssertEqual(blocks, [
            .h(level: 1, text: "Title"), .p("One two"),
            .li(ordered: false, marker: "-", depth: 0, checked: nil, text: "a"),
            .li(ordered: false, marker: "-", depth: 1, checked: true, text: "b"),
            .li(ordered: true, marker: "1.", depth: 0, checked: nil, text: "c"),
            .quote("q1 q2"), .code(lang: "js", text: "x # not a heading"), .hr,
        ])
        XCTAssertEqual(MarkdownFile.blocks(">tight\n> spaced"), [.quote("tight spaced")])
        let runs = MarkdownFile.runs("a **b** *c* `d` [e](https://e.org) https://f.org/x. <b>g</b>")
        XCTAssertEqual(runs.map(\.text), ["a ", "b", " ", "c", " ", "d", " ", "e", " ", "https://f.org/x", ". <b>g</b>"])
        XCTAssertTrue(runs[1].bold); XCTAssertTrue(runs[3].italic); XCTAssertTrue(runs[5].code)
        XCTAssertEqual(runs[7].href, "https://e.org"); XCTAssertEqual(runs[9].href, "https://f.org/x")
    }

    func testSplitTarget() {
        func t(_ s: String?) -> [String] { let x = PassageLink.splitTarget(s); return [x.address, x.find, x.to] }
        XCTAssertEqual(t("https://arxiv.org/pdf/2312.10893#find=We%20argue%20that%20GenAI"), ["https://arxiv.org/pdf/2312.10893", "We argue that GenAI", ""])
        XCTAssertEqual(t("https://x.org/a.pdf#page=3"), ["https://x.org/a.pdf#page=3", "", ""])
        XCTAssertEqual(t("/Users/h/Downloads/My%20Paper.pdf#find=the%20%20first%0Asentence%20"), ["/Users/h/Downloads/My Paper.pdf", "the first sentence", ""])
        XCTAssertEqual(t("https://x.org/a#find=100%"), ["https://x.org/a", "100%", ""])
        XCTAssertEqual(t("https://x.org/a#find="), ["https://x.org/a", "", ""])
        XCTAssertEqual(t(nil), ["", "", ""])
        XCTAssertEqual(t("https://arxiv.org/pdf/2312.10893#find=We%20argue%20that&to=In%20this%20section%20we"), ["https://arxiv.org/pdf/2312.10893", "We argue that", "In this section we"])
        XCTAssertEqual(t("/Users/h/My%20Paper.pdf#find=search%20%26%20rank&to=Q%26A%20systems"), ["/Users/h/My Paper.pdf", "search & rank", "Q&A systems"])
        XCTAssertEqual(t("https://x.org/a.pdf#page=3&to=x"), ["https://x.org/a.pdf#page=3&to=x", "", ""])
        let cite = PassageLink.splitTarget("/a.pdf#find=x&page=3&note=hi%20there&cite=you&counter=1")
        XCTAssertEqual([cite.cite, cite.note], ["you", "hi there"]); XCTAssertEqual(cite.page, 3); XCTAssertEqual(cite.counter, true)
        XCTAssertEqual(PassageLink.splitTarget("/a.pdf#cite=source").cite, "source")
    }

    private let paper = "https://arxiv.org/pdf/2312.10893"
    private let other = "https://dl.acm.org/doi/pdf/10.1145/3544548.3581225"
    private var guide: [String] { [
        "## Prior work on reading support",
        "**[CiteSee](\(paper))** · Chang et al. · 2023",
        "**Read:** [3.2 Design Goals](\(paper)#find=We%20set%20three%20goals&to=The%20system%20has) and [5 Evaluation](\(paper)#find=We%20ran%20a%20study)",
        "**Why:** it decides what to show first.",
        "**[Scim](\(other))** · Fok et al. · 2023",
        "**Read:** [4 Faceted highlights](\(other)#find=Scim%20colours&to=Our%20study)",
        "Then back to [3.2 Design Goals, again](\(paper)#find=We%20set%20three%20goals&to=The%20system%20has), and `[not a link](\(paper)#find=in%20code)`.",
    ] }

    func testGuideSectionsAndPassages() {
        XCTAssertEqual(StageModel.guideSections(guide, paper), [GuideSection(label: "3.2 Design Goals", find: "We set three goals", to: "The system has"), GuideSection(label: "5 Evaluation", find: "We ran a study", to: "")])
        XCTAssertEqual(StageModel.guideSections(guide, other), [GuideSection(label: "4 Faceted highlights", find: "Scim colours", to: "Our study")])
        XCTAssertEqual(StageModel.guideSections(guide, ""), [])
        XCTAssertEqual(StageModel.guideSections(["**Read:** [Intro](/Users/h/My%20Paper.pdf#find=In%20this%20paper)"], "/Users/h/My Paper.pdf"), [GuideSection(label: "Intro", find: "In this paper", to: "")])
        let sections = StageModel.guideSections(guide, paper)
        let t = StageModel.withPassage(tab(), "We ran a study", "", sections)
        XCTAssertEqual(t.pendingFind, "We ran a study"); XCTAssertNil(t.pendingTo); XCTAssertEqual(t.activeSection, 1)
        XCTAssertEqual(StageModel.sectionAt(sections, "We set three goals", ""), -1)
        var drawn = t; drawn.pdf = StagePDF(url: "", input: "", name: "", seq: 1)
        let landed = StageModel.landTab(drawn, "We ran a study")
        XCTAssertNil(landed.pendingFind); XCTAssertEqual(landed.activeSection, 1)
        XCTAssertFalse(StageModel.landingFinds(landed))
        XCTAssertEqual(StageModel.landTab(drawn, "Another"), drawn)
        let plain = StageModel.withPassage(landed, "late interaction", "", nil)
        XCTAssertEqual(plain.sections, []); XCTAssertEqual(plain.activeSection, -1)
        XCTAssertEqual(StageModel.withPassage(landed, "", "", sections), landed)
    }

    func testLinkPlan() {
        let p = StageModel.linkPlan("/Users/h/ColBERT.pdf#find=late%20interaction", library)
        XCTAssertEqual(p.row?.id, "p1"); XCTAssertEqual(p.key, "i:p1"); XCTAssertEqual(p.find, "late interaction")
        XCTAssertEqual(StageModel.linkPlan("file:///Users/h/ColBERT.pdf#find=x", library).row?.id, "p1")
        XCTAssertEqual(StageModel.linkPlan("https://anthropic.com/engineering/contextual-retrieval#find=x", library).row?.id, "w1")
        XCTAssertNil(StageModel.linkPlan("/Users/h/.engelbart/p/Saving.md#find=x", library).row)
        XCTAssertNil(StageModel.linkPlan("/Users/h/ColBERT.pdf", library).row)
        XCTAssertEqual(StageModel.linkPlan("/Users/h/ColBERT.pdf#cite=source", library).row?.id, "p1")
        XCTAssertEqual(StageModel.linkPlan("https://arxiv.org/pdf/2312.10893#find=We%20argue", library).key, "l:arxiv.org/pdf/2312.10893")
        XCTAssertEqual(StageModel.linkPlan("/Users/h/elsewhere.pdf", library).key, "")
        XCTAssertEqual(StageModel.linkPlan("/Users/h/My Paper.pdf#find=x", library).key, StageModel.tabKey(tab(pdfURL: "file:///Users/h/My%20Paper.pdf")))
        var opened = tab(item: "p1")
        opened.url = "about:blank"
        XCTAssertEqual(StageModel.placeTab([opened], 0, StageModel.linkPlan("/Users/h/ColBERT.pdf#find=x", library).key), .focus(0))
    }

    func testPreviewWait() {
        let since = 1_000_000.0
        XCTAssertEqual(StageModel.previewWait(preview: true, drawn: false, since: since, now: since), .waking)
        XCTAssertEqual(StageModel.previewWait(preview: true, drawn: false, since: since, now: since + StageModel.wakeMs - 1), .waking)
        XCTAssertEqual(StageModel.previewWait(preview: true, drawn: false, since: since, now: since + StageModel.wakeMs), .failed)
        XCTAssertNil(StageModel.previewWait(preview: true, drawn: true, since: since, now: since + StageModel.wakeMs))
        XCTAssertNil(StageModel.previewWait(preview: false, drawn: false, since: since, now: since + 5000))
        XCTAssertEqual(StageModel.previewWait(preview: true, drawn: false, since: 0, now: since), .waking)
        XCTAssertEqual(StageModel.previewName("manifund/manifund"), "manifund")
        XCTAssertEqual(StageModel.previewName(nil), "")
    }

    func testStageSnapshot() {
        var t1 = tab("t1", item: "p1"); t1.row = library[2]; t1.pdf = StagePDF(url: "file:///Users/h/ColBERT.pdf", input: "/Users/h/ColBERT.pdf", name: "ColBERT", bytes: Data([1]), rowId: "p1"); t1.pendingFind = "x"
        var t2 = tab("t2", url: "https://example.org/second"); t2.web = PageState(id: "t2", url: "https://example.org/second", title: "Second page", canGoBack: true)
        var t3 = tab("t3", url: "https://arxiv.org/abs/2312.10893"); t3.pdf = StagePDF(url: "https://arxiv.org/pdf/2312.10893", input: "https://arxiv.org/pdf/2312.10893", name: "Some paper", under: "https://arxiv.org/abs/2312.10893")
        var t4 = tab("t4"); t4.file = StageFile(kind: .md, path: "/Users/h/notes.md", name: "notes.md", text: "# hi")
        var t5 = tab("t5"); t5.pdf = StagePDF(url: "file:///Users/h/a.pdf", input: "/Users/h/a.pdf", name: "a")
        var t6 = tab("t6", url: "file:///Users/h/site/index.html"); t6.web = PageState(id: "t6", url: "", title: "Site")
        let t7 = tab("t7", url: "http://localhost:5173/")
        let snap = StageModel.stageSnapshot([t1, t2, t3, t4, t5, t6, t7], activeId: "t2")
        XCTAssertEqual(snap, StageSnapshot(active: 1, tabs: [
            KeptTab(item: "p1", title: "ColBERT"), KeptTab(address: "https://example.org/second", title: "Second page"),
            KeptTab(address: "https://arxiv.org/pdf/2312.10893", title: "Some paper"), KeptTab(address: "/Users/h/notes.md", title: "notes.md"),
            KeptTab(address: "/Users/h/a.pdf", title: "a"), KeptTab(address: "file:///Users/h/site/index.html", title: "Site"),
            KeptTab(address: "http://localhost:5173/", title: ""),
        ]))
        XCTAssertEqual(StageModel.stageSnapshot([t1, t2], activeId: nil).active, 0)

        var pop = tab("pop", url: "https://accounts.example.org/login"); pop.opened = true; pop.from = "w1"
        var w1 = tab("w1", url: "https://example.org"); w1.web = PageState(id: "w1", url: "", title: "Example")
        var l1 = tab("l1"); l1.file = StageFile(kind: .loading, path: "/Users/h/big.csv", name: "big.csv")
        var e1 = tab("e1"); e1.file = StageFile(kind: .error, path: "/Users/h/gone.md", name: "gone.md", message: "ENOENT")
        let s1 = tab("s1", url: "sandbox://manifund"), w2 = tab("w2", url: "https://two.org")
        let list = [tab("b1"), pop, w1, l1, e1, s1, w2]
        XCTAssertEqual(StageModel.stageSnapshot(list, activeId: "w2"), StageSnapshot(active: 1, tabs: [KeptTab(address: "https://example.org", title: "Example"), KeptTab(address: "https://two.org", title: "")]))
        XCTAssertEqual(StageModel.stageSnapshot(list, activeId: "pop").active, 0)
        var r1 = tab("r1"); r1.restore = KeptTab(item: "p1", title: "ColBERT")
        var r2 = tab("r2"); r2.restore = KeptTab(address: "/Users/h/a.pdf", title: "a"); r2.restoreOpening = true
        XCTAssertEqual(StageModel.stageSnapshot([r1, r2], activeId: "r2"), StageSnapshot(active: 1, tabs: [KeptTab(item: "p1", title: "ColBERT"), KeptTab(address: "/Users/h/a.pdf", title: "a")]))
    }

    func testRestoreTabs() {
        var n = 0
        let make: (KeptTab) -> StageTab = { entry in n += 1; var t = tab("r\(n)"); t.restore = entry; return t }
        let saved = StageSnapshot(active: 2, tabs: [KeptTab(item: "p1", title: "ColBERT"), KeptTab(item: "gone", title: "Deleted"), KeptTab(address: "https://example.org/second", title: "Second page"), KeptTab(address: "/Users/h/notes.md", title: "notes.md")])
        let lone = [tab("b1")]
        var plan = StageModel.restoreTabs(lone, saved, library, make: make)
        XCTAssertEqual(plan.tabs.map { $0.restore }, [KeptTab(item: "p1", title: "ColBERT"), KeptTab(address: "https://example.org/second", title: "Second page"), KeptTab(address: "/Users/h/notes.md", title: "notes.md")])
        XCTAssertEqual(plan.front, plan.tabs[1].id)
        XCTAssertEqual(plan.tabs.map(StageModel.tabKey), ["i:p1", "l:example.org/second", "l:file:///Users/h/notes.md"])
        plan = StageModel.restoreTabs(lone, StageSnapshot(active: 1, tabs: saved.tabs), library, make: make)
        XCTAssertEqual(plan.tabs.first { $0.id == plan.front }?.restore?.address, "https://example.org/second")
        plan = StageModel.restoreTabs(lone, StageSnapshot(active: 9, tabs: saved.tabs), library, make: make)
        XCTAssertEqual(plan.tabs.first { $0.id == plan.front }?.restore?.address, "/Users/h/notes.md")
        plan = StageModel.restoreTabs(lone, StageSnapshot(), library, make: make)
        XCTAssertEqual(plan.tabs, lone); XCTAssertNil(plan.front)
        var opened = tab("o1", item: "p1", claimed: true); opened.row = library[2]
        plan = StageModel.restoreTabs([opened], saved, library, make: make)
        XCTAssertNil(plan.front); XCTAssertEqual(plan.tabs.map(StageModel.tabKey), ["i:p1", "l:example.org/second", "l:file:///Users/h/notes.md"]); XCTAssertEqual(plan.tabs[0], opened)
        let link = tab("o2", url: "https://new.org/", claimed: true)
        plan = StageModel.restoreTabs([link], saved, library, make: make)
        XCTAssertEqual(plan.tabs.map(StageModel.tabKey), ["i:p1", "l:example.org/second", "l:file:///Users/h/notes.md", "l:new.org"])
        plan = StageModel.restoreTabs([tab("o3", url: "http://www.example.org/second/", claimed: true)], saved, library, make: make)
        XCTAssertEqual(plan.tabs.count, 3)
        let many = StageSnapshot(active: 0, tabs: (0..<15).map { KeptTab(address: "https://s\($0).org", title: "s\($0)") })
        plan = StageModel.restoreTabs([link], many, library, make: make)
        XCTAssertEqual(plan.tabs.count, 15); XCTAssertEqual(plan.tabs[14], link); XCTAssertEqual(plan.tabs[13].restore?.title, "s13")
        var g1 = tab("g1"); g1.restore = KeptTab(item: "p1", title: "ColBERT")
        var g2 = tab("g2"); g2.restore = KeptTab(address: "https://example.org/a", title: "A")
        XCTAssertEqual(StageModel.placeTab([g1, g2], 0, "i:p1"), .focus(0))
        XCTAssertEqual(StageModel.placeTab([g1, g2], 0, "l:example.org/a"), .focus(1))
        XCTAssertEqual(StageModel.placeTab([g1, g2], 0, "l:other.org"), .append)
    }

    func testPassageText() {
        let hits = PassageText.matchPassage("He said “construc-\ntion” — fine", "\"construction\" - fine")
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(PassageText.normalizePassage("bart> The  ﬁrst\nline", prefixes: true), "the first line")
        XCTAssertEqual(PassageText.matchPassage("a b c", "x").count, 0)
        XCTAssertEqual(PassageText.matchPassage("cell1cell2", "cell1 cell2").count, 1)
    }
}
