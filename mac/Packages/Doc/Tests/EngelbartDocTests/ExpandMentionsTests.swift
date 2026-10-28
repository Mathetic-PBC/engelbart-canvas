import XCTest
@testable import EngelbartDoc

// test/expand-mentions.test.cjs (the parts without the Store), ported. The Store-backed expandDoc tests belong to the Store.

final class ExpandMentionsTests: XCTestCase {
    final class Reads { var names: [String] = [] }

    struct NoteRow { var row: LibRow; var text: String? }
    func note(_ name: String, _ text: String?) -> NoteRow { NoteRow(row: LibRow(id: "id-\(name)", name: name, type: "md", tags: ["note"], path: "/p/\(name).md"), text: text) }

    func source(_ rows: [NoteRow], images: [String: String] = [:], reads: Reads = Reads(), get: Bool = false, file: ((String, String) -> FolderFile?)? = nil) -> MentionSource {
        MentionSource(find: { name in rows.first { $0.row.name.lowercased() == name.lowercased() }?.row },
                      get: get ? { id in rows.first { $0.row.id == id }?.row } : nil,
                      read: { row in reads.names.append(row.name); return rows.first { $0.row.id == row.id }?.text },
                      image: { images[$0] }, file: file)
    }
    func expand(_ text: String, _ s: MentionSource, seen: Set<String> = []) async -> (text: String, files: Int, missing: Int, seen: Set<String>) {
        var seen = seen
        let r = await ExpandMentions.expandMentions(text, s, seen: &seen)
        return (r.lines.joined(separator: "\n"), r.files, r.missing, seen)
    }

    func testNoteUnderItsLineOnce() async {
        let reads = Reads()
        let r = await expand("Intro\nSee @[Plan] first.\nThen go.\n\nAgain @[plan].", source([note("Plan", "step one\nstep two\n")], reads: reads))
        XCTAssertEqual(r.text, ["Intro", "See @[Plan] first.", "", "<file name=\"Plan\" type=\"md\" tags=\"note\" path=\"/p/Plan.md\">", "step one", "step two", "</file>", "", "Then go.", "", "Again @[plan]."].joined(separator: "\n"))
        XCTAssertEqual([r.files, r.missing], [1, 0])
        XCTAssertEqual(reads.names, ["Plan"])
    }

    func testTwoMentionsOneLine() async {
        let r = await expand("- [ ] read @[B] and @[A]\n\nnext", source([note("A", "a"), note("B", "b")]))
        XCTAssertEqual(r.text, ["- [ ] read @[B] and @[A]", "", "<file name=\"B\" type=\"md\" tags=\"note\" path=\"/p/B.md\">", "b", "</file>", "", "<file name=\"A\" type=\"md\" tags=\"note\" path=\"/p/A.md\">", "a", "</file>", "", "next"].joined(separator: "\n"))
        XCTAssertEqual(r.files, 2)
    }

    func testCircle() async {
        let reads = Reads()
        let s = source([note("A", "A says @[B]"), note("B", "B says @[C] and @[A]"), note("C", "C says @[Root]"), note("Root", "never read")], reads: reads)
        let r = await expand("@[A]\n@[C]", s, seen: ["id-Root"])
        XCTAssertEqual(r.text, ["@[A]", "", "<file name=\"A\" type=\"md\" tags=\"note\" path=\"/p/A.md\">", "A says @[B]", "", "<file name=\"B\" type=\"md\" tags=\"note\" path=\"/p/B.md\">", "B says @[C] and @[A]", "",
                                "<file name=\"C\" type=\"md\" tags=\"note\" path=\"/p/C.md\">", "C says @[Root]", "</file>", "</file>", "</file>", "", "@[C]"].joined(separator: "\n"))
        XCTAssertEqual(r.files, 3)
        XCTAssertEqual(reads.names, ["A", "B", "C"])
    }

    func testCodeAndBartAndMissing() async {
        let r = await expand("type `@[Plan]` to mention\n@bart what about @[Gone] and @[gone]?\n@[bart]", source([note("Plan", "p")]))
        XCTAssertEqual(r.text, ["type `@[Plan]` to mention", "@bart what about @[Gone] and @[gone]?", "", "<file name=\"Gone\" missing=\"true\" />", "", "@[bart]"].joined(separator: "\n"))
        XCTAssertEqual([r.files, r.missing], [0, 1])
    }

    func testBrainstormAndDiscover() async {
        let doc = ["@brainstorm about @[Plan]", "bart> ```json", "bart> {\"card\": \"focus\"}", "bart> ```", "@brainstorm picked \"Plan\""].joined(separator: "\n")
        let r = await expand(doc, source([note("Plan", "p")]))
        XCTAssertEqual(r.text, ["@brainstorm about @[Plan]", "", "<file name=\"Plan\" type=\"md\" tags=\"note\" path=\"/p/Plan.md\">", "p", "</file>", "", "bart> ```json", "bart> {\"card\": \"focus\"}", "bart> ```", "@brainstorm picked \"Plan\""].joined(separator: "\n"))
        let d = await expand("@discover about @[Plan]", source([note("Plan", "p")]))
        XCTAssertEqual(d.text, ["@discover about @[Plan]", "", "<file name=\"Plan\" type=\"md\" tags=\"note\" path=\"/p/Plan.md\">", "p", "</file>"].joined(separator: "\n"))
    }

    func testUnreadableNote() async {
        let r = await expand("@[Lost]", source([NoteRow(row: LibRow(id: "x", name: "Lost", type: "md", tags: ["note"], path: "/p/Lost.md"), text: nil)]))
        XCTAssertEqual(r.text, "@[Lost]\n\n<file name=\"Lost\" type=\"md\" tags=\"note\" path=\"/p/Lost.md\" missing=\"true\" />")
        XCTAssertEqual([r.missing, r.files], [1, 0])
    }

    func testNonNotes() async {
        let reads = Reads()
        let rows = [NoteRow(row: LibRow(id: "p", name: "Attention", type: "pdf", tags: ["paper"], path: "/lib/attention.pdf", summary: "We propose the Transformer.\nIt attends."), text: nil),
                    NoteRow(row: LibRow(id: "w", name: "Docs \"v2\" <beta>", type: "website", url: "https://example.com/?a=1&b=2"), text: nil),
                    NoteRow(row: LibRow(id: "r", name: "Repo", type: "folder", tags: ["git"], folderPath: "/code/y", url: "https://github.com/x/y"), text: nil)]
        let r = await expand("@[Attention] @[Docs \"v2\" <beta>] @[Repo]", source(rows, reads: reads))
        XCTAssertEqual(r.text, ["@[Attention] @[Docs \"v2\" <beta>] @[Repo]", "", "<file name=\"Attention\" type=\"pdf\" tags=\"paper\" path=\"/lib/attention.pdf\" contains=\"summary\">", "We propose the Transformer.", "It attends.", "</file>", "",
                                "<file name=\"Docs &quot;v2&quot; &lt;beta>\" type=\"website\" url=\"https://example.com/?a=1&amp;b=2\" />", "", "<file name=\"Repo\" type=\"folder\" tags=\"git\" folder=\"/code/y\" url=\"https://github.com/x/y\" />"].joined(separator: "\n"))
        XCTAssertEqual(r.files, 3)
        XCTAssertEqual(reads.names, [])
    }

    func testImages() async {
        let s = source([note("Plan", "never read")], images: ["a1b2-c3": "/home/p/assets/a1b2-c3.png"])
        let r = await expand("![Attachment 1](img:a1b2-c3)\n- [ ] fix ![Attachment 1](img:a1b2-c3) and ![Attachment 2](img:nope)", s)
        XCTAssertEqual(r.text, "![Attachment 1](/home/p/assets/a1b2-c3.png)\n- [ ] fix ![Attachment 1](/home/p/assets/a1b2-c3.png) and ![Attachment 2](img:nope)")
        XCTAssertEqual(ExpandMentions.imagePaths("--opus what is ![Attachment 2](img:a1b2-c3) showing?", s), "--opus what is ![Attachment 2](/home/p/assets/a1b2-c3.png) showing?")
        XCTAssertEqual(ExpandMentions.imagePaths("![Attachment 3](img:nope) gone, `![Attachment 2](img:a1b2-c3)` in code, @[Plan] mentioned", s), "![Attachment 3](img:nope) gone, `![Attachment 2](img:a1b2-c3)` in code, @[Plan] mentioned")
        XCTAssertEqual(ExpandMentions.imagePaths("[Attachment 2] typed", s), "[Attachment 2] typed")
    }

    func testSameInline() { XCTAssertTrue(ExpandMentions.INLINE === Inline.INLINE, "one definition, shared") }

    func testLibAndFolderFiles() async {
        let rows = [NoteRow(row: LibRow(id: "r-1", name: "Renamed Paper", type: "pdf", tags: ["paper"], path: "/p/paper.pdf"), text: nil),
                    NoteRow(row: LibRow(id: "f-1", name: "Papers", type: "folder", folderPath: "/home/papers"), text: nil)]
        let files = ["f-1\nsub dir/Smith (2024) #2.pdf": FolderFile(exists: true, dir: false, type: "pdf", folder: "Papers", path: "/home/papers/sub dir/Smith (2024) #2.pdf")]
        let s = source(rows, get: true, file: { folderId, rel in files["\(folderId)\n\(rel)"] ?? FolderFile(exists: false, folder: "Papers", path: "/home/papers/\(rel)") })
        let r = await expand("See @[Old Name](lib:r-1) and @[Smith (2024) #2.pdf](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf), again @[x](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf).\nGone @[Old.pdf](lib:f-1:Old.pdf)", s)
        XCTAssertEqual(r.text, ["See @[Old Name](lib:r-1) and @[Smith (2024) #2.pdf](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf), again @[x](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf).", "",
                                "<file name=\"Renamed Paper\" type=\"pdf\" tags=\"paper\" path=\"/p/paper.pdf\" />", "", "<file name=\"Smith (2024) #2.pdf\" type=\"pdf\" folder=\"Papers\" path=\"/home/papers/sub dir/Smith (2024) #2.pdf\" />", "",
                                "Gone @[Old.pdf](lib:f-1:Old.pdf)", "", "<file name=\"Old.pdf\" folder=\"Papers\" path=\"/home/papers/Old.pdf\" missing=\"true\" />"].joined(separator: "\n"))
        XCTAssertTrue(r.seen.contains("r-1") && r.seen.contains("f-1"))
        XCTAssertTrue(r.seen.contains("file:f-1:sub dir/Smith (2024) #2.pdf") && r.seen.contains("file:f-1:Old.pdf"))
        XCTAssertEqual([r.files, r.missing], [2, 1])
    }

    func testWorkspaceAndBuildLines() async {
        var s = source([note("Plan", "p")])
        s.workspace = { id in id == "w1" ? (name: "Other place", path: "/proj/other/workspace.md", text: "there @[Plan]") : nil }
        let r = await expand("see @[Old](ws:w1) and @[x](ws:w1) and @[Gone](ws:w2)", s)
        XCTAssertEqual(r.text, ["see @[Old](ws:w1) and @[x](ws:w1) and @[Gone](ws:w2)", "", "<file name=\"Other place\" type=\"workspace\" path=\"/proj/other/workspace.md\">", "there @[Plan]", "",
                                "<file name=\"Plan\" type=\"md\" tags=\"note\" path=\"/p/Plan.md\">", "p", "</file>", "</file>", "", "<file name=\"Gone\" type=\"workspace\" missing=\"true\" />"].joined(separator: "\n"))
        XCTAssertEqual(ExpandMentions.buildLines("a\nbuild> 0123456789\nbuild> abcdefabcd", task: { $0 == "0123456789" ? (title: "Add tests", status: "done") : nil }), "a\nBuild \"Add tests\" (done)\nbuild> abcdefabcd")
    }

    func testImageMentionedOnceWherePasted() async {
        // image-mentions.test.cjs: a picture the text pastes is given once, where it is pasted; a mention of it adds nothing.
        let pic = LibRow(id: "img-1", name: "Diagram.png", type: "image", path: "/assets/img-1.png")
        let s = MentionSource.project("p", rows: [pic], read: { _ in nil })
        var seen = Set<String>()
        let r = await ExpandMentions.expandMentions("![Attachment 1](img:img-1)\nsee @[Diagram.png](lib:img-1)", s, seen: &seen)
        XCTAssertEqual(r.lines, ["![Attachment 1](/assets/img-1.png)", "see @[Diagram.png](lib:img-1)"])
        let only = await ExpandMentions.expandMentions("see @[Diagram.png](lib:img-1)", s)
        XCTAssertEqual(only.lines, ["see @[Diagram.png](lib:img-1)", "", "<file name=\"Diagram.png\" type=\"image\" path=\"/assets/img-1.png\" />"])
    }
}
