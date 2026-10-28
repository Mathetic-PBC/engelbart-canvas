import XCTest
import EngelbartCore
@testable import EngelbartStore

/// test/library.test.cjs, test/library-home.test.cjs, test/library-drop.test.cjs, test/library-about.test.cjs
final class LibraryTests: XCTestCase {
    var ctx: StoreContext!
    var layout: Home.Layout!
    var home: String!

    override func setUpWithError() throws { (ctx, layout, home) = try makeContext("engelbart-library-") }
    override func tearDown() { SQLiteRegistry.closeAll() }

    func fixtures() -> String {
        let dir = tempDir("engelbart-fixtures-")
        write(Paths.join(dir, "hypocompass.pdf"), "%PDF-1.4 test")
        write(Paths.join(dir, "problems.csv"), "a,b\n")
        return dir
    }
    func ink(_ note: String) -> JSONValue { ["1": [["id": .string(note), "rects": [], "side": .null, "y": 0, "note": .string(note), "text": "", "pos": ["x": 0, "y": 0]]]] }

    func testSeedReadFileAnnotations() async throws {
        XCTAssertEqual(try Library.seedIfEmpty(ctx, fixturesDir: fixtures()), 4)
        XCTAssertEqual(try Library.seedIfEmpty(ctx, fixturesDir: fixtures()), 0)
        let rows = try Library.listLibrary(ctx)
        XCTAssertEqual(rows.map { "\($0.type) \($0.tags)" }.sorted(), ["csv []", "pdf []", "website [\"git\"]", "website [\"paper\"]"])
        let paper = rows.first { $0.type == "pdf" }!
        XCTAssertEqual(paper.path, Paths.join(layout.testRoot, "seed", "hypocompass.pdf"))
        let file = try Library.readLibraryFile(ctx, paper.id)
        XCTAssertEqual(file.name, paper.name); XCTAssertEqual(String(decoding: file.bytes, as: UTF8.self), "%PDF-1.4 test")
        XCTAssertThrowsMatchingSync({ try Library.readLibraryFile(ctx, rows.first { $0.type == "csv" }!.id) }, "Only downloaded pdf")
        XCTAssertThrowsMatchingSync({ try Library.readLibraryFile(ctx, rows.first { $0.hasTag("paper") && $0.type == "website" }!.id) }, "no local file")
        XCTAssertThrowsMatchingSync({ try Library.readLibraryFile(ctx, "../etc") }, "invalid")
        let gone = try ctx.libraryDb.insert(NewLibraryRow(name: "Gone", type: "pdf", path: Paths.join(home, "gone.pdf")))
        XCTAssertThrowsMatchingSync({ try Library.readLibraryFile(ctx, gone.id) }, "^Nothing is at that path$")
        // the bundled fixtures (package resources) are the ones the app seeds from
        XCTAssertTrue(exists(Paths.join(Library.bundledFixtures!, "hypocompass.pdf")))

        let id = uuid()
        XCTAssertNil(try Library.readAnnotations(ctx, id))
        XCTAssertTrue(try Library.writeAnnotations(ctx, id, ink("hi")))
        XCTAssertEqual(try Library.readAnnotations(ctx, id), ink("hi"))
        XCTAssertThrowsError(try Library.writeAnnotations(ctx, "bad", [:]))

        // ink on a pdf in the Browser pane: the row's when the library holds it, else by address until a row is added
        try Library.writePageAnnotations(ctx, Paths.fileURL(paper.path!), ink("disk"))
        XCTAssertEqual(try Library.readAnnotations(ctx, paper.id), ink("disk"))
        let arxiv = rows.first { $0.url == "https://arxiv.org/abs/2310.05292" }!
        try Library.writePageAnnotations(ctx, "https://arxiv.org/pdf/2310.05292v2", ink("arxiv"))
        XCTAssertEqual(try Library.readAnnotations(ctx, arxiv.id), ink("arxiv"))
        XCTAssertNil(try Library.readPageAnnotations(ctx, "https://example.com/a.pdf"))
        try Library.writePageAnnotations(ctx, "https://example.com/a.pdf#page=2", ink("web"))
        XCTAssertEqual(try Library.readPageAnnotations(ctx, "https://example.com/a.pdf"), ink("web"))
        let added = try await Library.addItem(ctx, "https://example.com/a.pdf", hooks: .init())
        XCTAssertEqual(try Library.readAnnotations(ctx, added.id), ink("web"))
        try Library.writePageAnnotations(ctx, "https://example.com/a.pdf", ink("after"))
        XCTAssertEqual(try Library.readAnnotations(ctx, added.id), ink("after"))
        XCTAssertFalse(try Library.writePageAnnotations(ctx, "http://localhost:3000/x", ink("preview")), "a preview keeps no ink")
        XCTAssertEqual(Library.inkFileOf(ctx, added), Paths.join(ctx.dataRoot, "annotations", "\(added.id).json"))
    }

    func testPdfCopyFromTheWeb() async throws {
        let bytes = Data("%PDF-1.7 copy".utf8)
        try Library.writePageAnnotations(ctx, "https://papers.example.org/files/Retrieval%20Study.pdf", ink("before"))
        let row = try await Library.addPdfCopy(ctx, "https://papers.example.org/files/Retrieval%20Study.pdf", bytes: bytes, inspectPdf: { _ in ["paper"] })
        XCTAssertEqual([row.type, row.name, row.url], ["pdf", "Retrieval Study", "https://papers.example.org/files/Retrieval%20Study.pdf"])
        XCTAssertEqual(row.path, Paths.join(layout.testRoot, "assets", "pdfs", "\(row.id).pdf"))
        XCTAssertEqual(row.tags, ["paper"]); XCTAssertEqual(read(row.path!), "%PDF-1.7 copy")
        XCTAssertEqual(try Library.readAnnotations(ctx, row.id), ink("before"))
        XCTAssertEqual(try Library.lookupItem(ctx, "http://www.papers.example.org/files/Retrieval%20Study.pdf").row?.id, row.id)
        let error = await thrown { try await Library.addPdfCopy(ctx, "https://papers.example.org/files/Retrieval%20Study.pdf", bytes: bytes) }
        XCTAssertEqual((error as? StoreError)?.code, "EXISTS")
        await XCTAssertThrowsMatching({ try await Library.addPdfCopy(ctx, "https://x.example.org/b.pdf", bytes: Data("<html>".utf8)) }, "not a pdf")
        await XCTAssertThrowsMatching({ try await Library.addPdfCopy(ctx, "/Users/h/a.pdf", bytes: bytes) }, "from the web")
        let arxiv = try await Library.addPdfCopy(ctx, "https://arxiv.org/pdf/1706.03762v7", bytes: bytes, name: "Attention")
        XCTAssertEqual([arxiv.name, arxiv.url], ["Attention", "https://arxiv.org/abs/1706.03762"]); XCTAssertEqual(arxiv.tags, ["paper"])
    }

    static let pageHTML = #"<html><head><title>A Post</title><meta name="description" content="What the post is about."></head><body><img src="index_files/a.png"></body></html>"#
    func fakeSave(_ url: String, title: String = "A Post", html: String = pageHTML, calls: Box<[String]> = Box([])) -> (String) async throws -> Library.SavedPage? {
        { dir in
            calls.value.append(dir)
            write(Paths.join(dir, "index.html"), html)
            write(Paths.join(dir, "index_files", "a.png"), "png")
            return Library.SavedPage(url: url, title: title)
        }
    }
    func pageFolders() -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: Paths.join(layout.testRoot, "assets", "pages"))) ?? []).sorted() }

    func testPageCopy() async throws {
        let url = "https://blog.example.org/posts/kept?id=2"
        let calls = Box<[String]>([])
        let row = try await Library.addPageCopy(ctx, url, save: fakeSave(url, calls: calls), name: "  My   post ")
        let dir = Paths.join(try Paths.real(Paths.join(layout.testRoot, "assets", "pages")), row.id)
        XCTAssertEqual(calls.value, [dir])
        XCTAssertEqual([row.type, row.name, row.url], ["html", "My post", url]); XCTAssertEqual(row.tags, []); XCTAssertNil(row.projectId)
        XCTAssertEqual(row.categorized, Library.categoryRules); XCTAssertEqual(row.path, Paths.join(dir, "index.html"))
        XCTAssertEqual(row.summary, "What the post is about.")
        XCTAssertEqual(try Library.lookupItem(ctx, "http://www.blog.example.org/posts/kept/?id=2#top").row?.id, row.id)
        XCTAssertEqual(try Library.lookupItem(ctx, row.path!).row?.id, row.id)
        let before = pageFolders()
        let again = Box<[String]>([])
        let error = await thrown { try await Library.addPageCopy(ctx, url, save: fakeSave(url, calls: again)) }
        XCTAssertEqual((error as? StoreError)?.code, "EXISTS"); XCTAssertEqual((error as? StoreError)?.row?.id, row.id)
        XCTAssertEqual(again.value.count, 0); XCTAssertEqual(pageFolders(), before)
        try await Library.recategorize(ctx)
        XCTAssertEqual(try ctx.libraryDb.get(row.id)?.type, "html")

        let awaited109 = try await Library.addPageCopy(ctx, "https://news.example.org/a", save: fakeSave("https://news.example.org/a", title: "  The   Headline ")).name
        XCTAssertEqual(awaited109, "The Headline")
        let awaited110 = try await Library.addPageCopy(ctx, "https://news.example.org/b", save: fakeSave("https://news.example.org/b", title: String(repeating: "x", count: 300)), name: "   ").name
        XCTAssertEqual(awaited110, String(repeating: "x", count: 200))
        let untitled = try await Library.addPageCopy(ctx, "https://news.example.org/c/", save: fakeSave("https://news.example.org/c/", title: "", html: "<p>no head</p>"))
        XCTAssertEqual(untitled.name, "news.example.org/c"); XCTAssertNil(untitled.summary)

        let count = try ctx.libraryDb.list().count, folders = pageFolders()
        await XCTAssertThrowsMatching({ try await Library.addPageCopy(ctx, "https://fail.example.org/a", save: { dir in write(Paths.join(dir, "index.html"), "half"); throw StoreError("The page is still loading") }) }, "still loading")
        await XCTAssertThrowsMatching({ try await Library.addPageCopy(ctx, "https://fail.example.org/b", save: self.fakeSave("https://fail.example.org/elsewhere")) }, "changed before it was saved")
        await XCTAssertThrowsMatching({ try await Library.addPageCopy(ctx, "https://fail.example.org/c", save: { _ in Library.SavedPage(url: "https://fail.example.org/c", title: "") }) }, "not saved")
        XCTAssertEqual(pageFolders(), folders); XCTAssertEqual(try ctx.libraryDb.list().count, count)

        try Library.writePageAnnotations(ctx, "https://essays.example.org/inked#part-2", ink("before"))
        let inked = try await Library.addPageCopy(ctx, "https://essays.example.org/inked", save: fakeSave("https://essays.example.org/inked"))
        XCTAssertTrue(exists(Paths.join(layout.testRoot, "annotations", "\(inked.id).json")))
        XCTAssertEqual(try Library.readAnnotations(ctx, inked.id), ink("before"))

        for input in ["https://github.com/karpathy/micrograd", "https://gitlab.com/group/tool.git", "https://arxiv.org/abs/2310.05292", "https://doi.org/10.1145/3544548.3580919"] {
            let none = Box<[String]>([])
            await XCTAssertThrowsMatching({ try await Library.addPageCopy(ctx, input, save: self.fakeSave(input, calls: none)) }, "plain web page")
            XCTAssertEqual(none.value.count, 0)
        }
        await XCTAssertThrowsMatching({ try await Library.addPageCopy(ctx, Paths.join(home, "page.html"), save: self.fakeSave("")) }, "from the web")
    }

    func testResolverAndAdding() async throws {
        func resolve(_ input: String) throws -> Library.Found { try Library.resolveAddition(input, homeDir: home) }
        XCTAssertEqual(try resolve(" arxiv:2310.05292v3 "), .init(type: "website", tags: ["paper"], name: "arXiv 2310.05292", url: "https://arxiv.org/abs/2310.05292"))
        XCTAssertEqual(try resolve("https://arxiv.org/pdf/2310.05292.pdf"), .init(type: "website", tags: ["paper"], name: "arXiv 2310.05292", url: "https://arxiv.org/abs/2310.05292"))
        XCTAssertEqual(try resolve("https://doi.org/10.1145/3544548.3580919"), .init(type: "website", tags: ["paper"], name: "doi 10.1145/3544548.3580919", url: "https://doi.org/10.1145/3544548.3580919"))
        XCTAssertEqual(try resolve("https://github.com/mqo00/hypocompass/tree/main/backend"), .init(type: "website", tags: ["git"], name: "mqo00/hypocompass", url: "https://github.com/mqo00/hypocompass"))
        XCTAssertEqual(try resolve("\"https://www.inkandswitch.com/embark/\""), .init(type: "website", tags: [], name: "inkandswitch.com/embark", url: "https://www.inkandswitch.com/embark/"))
        XCTAssertThrowsMatchingSync({ try resolve("notes/today.md") }, "starts with")
        XCTAssertThrowsMatchingSync({ try resolve("/etc/hosts") }, "home directory")
        XCTAssertThrowsMatchingSync({ try resolve("~/missing.pdf") }, "Nothing is at that path")
        XCTAssertEqual(try resolve("github.com").url, "https://github.com/")
        XCTAssertEqual(try resolve("github.com/anthropics/claude-code").tags, ["git"])
        XCTAssertEqual(try resolve("arxiv.org/abs/2401.00001").tags, ["paper"])
        XCTAssertThrowsMatchingSync({ try resolve("notes.md") }, "Paste a link, or a path")

        let files = Paths.join(home, "files")
        try FileManager.default.createDirectory(atPath: Paths.join(files, "clone", ".git"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: Paths.join(files, "tables"), withIntermediateDirectories: true)
        for name in ["Attention.pdf", "rows.csv", "events.NDJSON", "report.html", "old.htm", "plain.md", "plain.txt"] { write(Paths.join(files, name)) }
        XCTAssertEqual(try resolve("~/files/Attention.pdf"), .init(type: "pdf", tags: [], name: "Attention", path: Paths.join(files, "Attention.pdf")))
        XCTAssertEqual(try ["rows.csv", "events.NDJSON", "report.html", "old.htm", "plain.md"].map { try resolve(Paths.join(files, $0)).type }, ["csv", "jsonl", "html", "html", "md"])
        XCTAssertEqual(try resolve(Paths.join(files, "clone")), .init(type: "folder", tags: ["git"], name: "clone", folderPath: Paths.join(files, "clone")))
        XCTAssertEqual(try resolve(Paths.join(files, "tables")), .init(type: "folder", tags: [], name: "tables", folderPath: Paths.join(files, "tables")))
        XCTAssertTrue(try resolve(Paths.join(files, "report.html")).url!.hasPrefix("file://"))
        XCTAssertThrowsMatchingSync({ try resolve(Paths.join(files, "plain.txt")) }, #"does not know what a \.txt is"#)

        let describe: PageMeta.Describe = { _ in .init(title: "  Embark:\n Dynamic documents ", description: "Travel planning as a document.") }
        let identify: PageMeta.IdentifyRepo = { owner, name in .init(id: "1000596606", fullName: "\(owner)/\(name)", url: "https://github.com/\(owner)/\(name)", description: "A repository.") }
        let page = try await Library.addItem(ctx, "https://www.inkandswitch.com/embark/", hooks: .init(describe: describe))
        XCTAssertEqual([page.name, page.summary], ["Embark: Dynamic documents", "Travel planning as a document."]); XCTAssertNil(page.projectId)
        let rowsBefore = try ctx.libraryDb.list().count
        let dup = await thrown { try await Library.addItem(ctx, "https://www.inkandswitch.com/embark/", hooks: .init(describe: { _ in throw StoreError("asked twice") })) } as? StoreError
        XCTAssertEqual(dup?.code, "EXISTS"); XCTAssertEqual(dup?.message, "Already in the library as “Embark: Dynamic documents”"); XCTAssertEqual(dup?.row?.id, page.id)
        XCTAssertEqual(try ctx.libraryDb.list().count, rowsBefore)
        for spelling in ["http://inkandswitch.com/embark", "https://www.inkandswitch.com/embark#top", "https://INKANDSWITCH.com/embark//"] {
            await XCTAssertThrowsMatching({ try await Library.addItem(ctx, spelling) }, "Already in the library as “Embark: Dynamic documents”")
        }
        let awaited170 = try await Library.addItem(ctx, "https://www.inkandswitch.com/embark/?part=2").id
        XCTAssertNotEqual(awaited170, page.id)
        let named = try await Library.addItem(ctx, "https://example.org/named", hooks: .init(describe: describe), name: "  My   name for it ")
        XCTAssertEqual([named.name, named.summary], ["My name for it", "Travel planning as a document."])
        let repo = try await Library.addItem(ctx, "git@github.com:mqo00/hypocompass.git", hooks: .init(describe: describe, identifyRepo: identify))
        XCTAssertEqual([repo.name, repo.summary, repo.githubId], ["mqo00/hypocompass", "A repository.", "1000596606"])
        XCTAssertEqual([repo.source, repo.category], ["github", "repo"])
        let offline = try await Library.addItem(ctx, "https://example.org/offline", hooks: .init(describe: { _ in throw StoreError("no network") }))
        XCTAssertEqual(offline.name, "example.org/offline"); XCTAssertNil(offline.summary); XCTAssertEqual(offline.source, "web")
        let pdf = try await Library.addItem(ctx, Paths.join(files, "Attention.pdf"))
        XCTAssertEqual(pdf.path, Paths.join(files, "Attention.pdf")); XCTAssertEqual(pdf.source, "mac")
        await XCTAssertThrowsMatching({ try await Library.addItem(ctx, "~/files/Attention.pdf") }, "Already in the library as “Attention”")
        XCTAssertEqual(pdf.type, "pdf"); XCTAssertEqual(pdf.tags, []); XCTAssertNil(pdf.categorized)

        // adding categorizes at once
        let pdfs = Paths.join(home, "pdfs")
        for name in ["paper.pdf", "invoice.pdf", "locked.pdf"] { write(Paths.join(pdfs, name)) }
        let looked = Box<[String]>([])
        let inspect: Library.InspectPdf = { file in looked.value.append(Paths.basename(file)); if file.contains("locked") { throw StoreError("unreadable") }; return file.contains("paper") ? ["paper"] : [] }
        let p = try await Library.addItem(ctx, Paths.join(pdfs, "paper.pdf"), hooks: .init(inspectPdf: inspect))
        XCTAssertEqual(p.tags, ["paper"]); XCTAssertEqual(p.categorized, Library.categoryRules)
        let inv = try await Library.addItem(ctx, Paths.join(pdfs, "invoice.pdf"), hooks: .init(inspectPdf: inspect))
        XCTAssertEqual(inv.tags, []); XCTAssertEqual(inv.categorized, Library.categoryRules)
        let locked = try await Library.addItem(ctx, Paths.join(pdfs, "locked.pdf"), hooks: .init(inspectPdf: inspect))
        XCTAssertNil(locked.categorized)
        XCTAssertEqual(looked.value, ["paper.pdf", "invoice.pdf", "locked.pdf"])
        for input in ["arxiv:2310.05292", "https://doi.org/10.1145/3544548.3580919", "git@github.com:o/r.git", "https://example.org/page"] {
            let found = try resolve(input)
            XCTAssertEqual(Library.addressTags(found.url), found.tags, input)
        }
    }

    func testRecategorizeAnInstalledLibrary() async throws {
        let base = Paths.join(home, "installed")
        try FileManager.default.createDirectory(atPath: Paths.join(base, "became-a-repo", ".git"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: Paths.join(base, "plain-folder"), withIntermediateDirectories: true)
        for name in ["attention.pdf", "receipt.pdf", "corrupt.pdf", "stuck.pdf"] { write(Paths.join(base, name)) }
        let was: [(String, NewLibraryRow)] = [
            ("pdfPaper", .init(name: "attention", type: "pdf", path: Paths.join(base, "attention.pdf"))),
            ("pdfOther", .init(name: "receipt", type: "pdf", path: Paths.join(base, "receipt.pdf"))),
            ("pdfCorrupt", .init(name: "corrupt", type: "pdf", path: Paths.join(base, "corrupt.pdf"))),
            ("pdfStuck", .init(name: "stuck", type: "pdf", path: Paths.join(base, "stuck.pdf"))),
            ("pdfAway", .init(name: "on another disk", type: "pdf", path: Paths.join(base, "away.pdf"))),
            ("arxivAsWebsite", .init(name: "arXiv 2310.05292", type: "website", url: "https://arxiv.org/abs/2310.05292")),
            ("githubAsWebsite", .init(name: "a repo saved as a link", type: "website", url: "https://github.com/o/saved-as-link")),
            ("gitlab", .init(name: "group/tool", type: "website", tags: ["git"], url: "https://gitlab.example.org/group/tool")),
            ("folderNowRepo", .init(name: "became-a-repo", type: "folder", folderPath: Paths.join(base, "became-a-repo"))),
            ("folderPlain", .init(name: "plain-folder", type: "folder", folderPath: Paths.join(base, "plain-folder"))),
            ("cloneAway", .init(name: "o/unmounted", type: "folder", tags: ["git"], folderPath: Paths.join(base, "unmounted"))),
            ("page", .init(name: "A page", type: "website", url: "https://example.org/a-page")),
            ("csv", .init(name: "rows.csv", type: "csv", path: Paths.join(base, "rows.csv"))),
        ]
        var ids: [String: String] = [:]
        for (key, row) in was {
            ids[key] = try ctx.libraryDb.insert(row).id
            try ctx.libraryDb.setSummary(ids[key]!, "What \(row.name) is about.", at: Time.parse("2026-09-10T00:00:00.000Z")!)
        }
        let note = try Documents.createNote(ctx, try Projects.create(ctx, "Installed").id, name: "An installed note", text: "body")
        func untouched() throws -> [String: String] { Dictionary(uniqueKeysWithValues: try ctx.libraryDb.list().map { ($0.id, "\($0.name)|\($0.summary ?? "")|\($0.summaryEdited ?? "")|\($0.lastEdited)|\($0.charCount ?? -1)|\($0.path ?? "")|\($0.url ?? "")|\($0.folderPath ?? "")") }) }
        let before = try untouched()
        let looked = Box<[String]>([])
        let inspect: Library.InspectPdf = { file in
            looked.value.append(Paths.basename(file))
            if file.contains("stuck") { try await Task.sleep(nanoseconds: 10_000_000_000) }
            if file.contains("corrupt") { throw StoreError("not a pdf") }
            return file.contains("attention") ? ["paper"] : []
        }
        let report = try await Library.recategorize(ctx, inspectPdf: inspect, inspectTimeout: 0.05)
        let R = Library.categoryRules
        func now(_ key: String) throws -> String { let row = try ctx.libraryDb.get(ids[key]!)!; return "\(row.type) \(row.tags) \(row.categorized.map(String.init) ?? "nil")" }
        let expect: [String: String] = [
            "pdfPaper": "pdf [\"paper\"] \(R)", "pdfOther": "pdf [] \(R)", "pdfCorrupt": "pdf [] \(R)", "pdfStuck": "pdf [] \(R)", "pdfAway": "pdf [] nil",
            "arxivAsWebsite": "website [\"paper\"] \(R)", "githubAsWebsite": "website [\"git\"] \(R)", "gitlab": "website [\"git\"] \(R)",
            "folderNowRepo": "folder [\"git\"] \(R)", "folderPlain": "folder [] \(R)", "cloneAway": "folder [\"git\"] \(R)", "page": "website [] \(R)", "csv": "csv [] \(R)",
        ]
        for (key, value) in expect { XCTAssertEqual(try now(key), value, key) }
        XCTAssertEqual(try ctx.libraryDb.get(note.id)?.categorized, R)
        XCTAssertEqual(try untouched(), before, "names, summaries, last_edited and locations are as they were")
        XCTAssertEqual(looked.value.sorted(), ["attention.pdf", "corrupt.pdf", "receipt.pdf", "stuck.pdf"])
        XCTAssertEqual(report.changed.map(\.name).sorted(), ["a repo saved as a link", "arXiv 2310.05292", "attention", "became-a-repo"]); XCTAssertEqual(report.due, 1)
        looked.value = []
        let again = try await Library.recategorize(ctx, inspectPdf: inspect, inspectTimeout: 0.05)
        XCTAssertEqual(looked.value, []); XCTAssertEqual(again.changed.count, 0); XCTAssertEqual(again.due, 1)
        write(Paths.join(base, "away.pdf"))
        try await Library.recategorize(ctx, inspectPdf: { _ in ["paper"] })
        XCTAssertEqual(try now("pdfAway"), "pdf [\"paper\"] \(R)")
        let unread = try ctx.libraryDb.insert(.init(name: "unread", type: "pdf", path: Paths.join(base, "receipt.pdf")))
        let late = try ctx.libraryDb.insert(.init(name: "late link", type: "website", url: "https://arxiv.org/abs/1706.03762"))
        try await Library.recategorize(ctx)
        XCTAssertNil(try ctx.libraryDb.get(unread.id)?.categorized); XCTAssertEqual(try ctx.libraryDb.get(late.id)?.tags, ["paper"])
    }

    func testWhoHoldsWhatAndBodies() async throws {
        let a = try Projects.create(ctx, "Alpha"), b = try Projects.create(ctx, "Beta")
        let outer = try Workspaces.create(ctx, a.id, name: "Outer")
        let inner = try Workspaces.create(ctx, a.id, name: "Inner", parentId: outer.id)
        let other = try Workspaces.create(ctx, b.id, name: "Elsewhere")
        let note = try Documents.createNote(ctx, a.id, name: "Made in Alpha")
        let paper = try ctx.libraryDb.insert(.init(name: "Shared paper", type: "website", tags: ["paper"], url: "https://arxiv.org/abs/1706.03762"))
        let loose = try ctx.libraryDb.insert(.init(name: "Held by nobody", type: "website", url: "https://example.org/loose"))
        try Workspaces.setContext(ctx, a.id, inner.id, [paper.id])
        try Workspaces.setContext(ctx, b.id, other.id, [paper.id, note.id])
        XCTAssertEqual(try Library.projectsForLibraryItem(ctx, paper.id).map { "\($0.name) \($0.origin) \($0.workspaces.map(\.path))" }.sorted(), ["Alpha false [\"Outer/Inner\"]", "Beta false [\"Elsewhere\"]"])
        XCTAssertEqual(try Library.projectsForLibraryItem(ctx, note.id).map { "\($0.name) \($0.origin) \($0.workspaces.count)" }.sorted(), ["Alpha true 0", "Beta false 1"])
        XCTAssertEqual(try Library.projectsForLibraryItem(ctx, loose.id).count, 0)
        XCTAssertThrowsMatchingSync({ try Library.projectsForLibraryItem(ctx, uuid()) }, "Unknown library item")
        let inAlpha = try Library.libraryForProject(ctx, a.id)
        XCTAssertEqual(inAlpha.map { "\($0.row.name) \($0.origin) \($0.workspaces)" }.sorted(), ["Made in Alpha true []", "Shared paper false [\"Outer/Inner\"]"])
        XCTAssertEqual(JSONValue.encode(inAlpha[0])["origin"]?.bool != nil, true, "origin and workspaces travel with the row")
        for project in [a, b] {
            let held = Set(try Library.libraryForProject(ctx, project.id).map(\.row.id))
            for row in [note.id, paper.id, loose.id] { XCTAssertEqual(held.contains(row), try Library.projectsForLibraryItem(ctx, row).contains { $0.id == project.id }) }
        }

        try Documents.writeDoc(ctx, a.id, .workspace(workspaceId: outer.id), "A phrase only the outer holds.")
        let huge = try Documents.createNote(ctx, a.id, name: "Huge", text: String(repeating: "é", count: 300_000) + String(repeating: "x", count: 300_000))
        let swept = try ctx.libraryDb.insert(.init(name: "Swept paper", type: "pdf", path: Paths.join(home, "swept.pdf"), projectId: a.id))
        try ctx.libraryDb.setText(swept.id, "Text the sweep read from a PDF.", mtime: 1)
        let scan = try ctx.libraryDb.insert(.init(name: "A scan", type: "pdf", path: Paths.join(home, "scan.pdf"), projectId: a.id))
        try ctx.libraryDb.setText(scan.id, "", mtime: 1)
        let bodies = try Library.bodiesForProject(ctx, a.id)
        XCTAssertEqual(bodies.items[swept.id], "Text the sweep read from a PDF.")
        XCTAssertEqual(bodies.items[huge.id], String(repeating: "é", count: 300_000) + String(repeating: "x", count: 200_000), "cut at characters, not bytes")
        XCTAssertNil(bodies.items[scan.id])
        XCTAssertEqual(bodies.workspaces, [outer.id: "A phrase only the outer holds."])
        XCTAssertNil(JSONValue.encode(try ctx.libraryDb.get(swept.id)!)["text"], "never on the rows")
        XCTAssertEqual(try Library.bodiesForLibrary(ctx).workspaces, [:])
        for row in [swept, scan] { try ctx.libraryDb.remove(row.id) }
    }

    /// A clone with a remote (test/library-home.test.cjs fakeClone).
    func fakeClone(_ dir: String, _ remote: String?, name: String = "origin", worktreeOf: String? = nil) -> String {
        try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let worktreeOf { write(Paths.join(dir, ".git"), "gitdir: \(Paths.join(worktreeOf, ".git", "worktrees", "wt"))\n"); return dir }
        write(Paths.join(dir, ".git", "worktrees", "wt", "commondir"), "../..\n")
        write(Paths.join(dir, ".git", "config"), "[core]\n\tbare = false\n\(remote.map { "[remote \"\(name)\"]\n\turl = \($0)\n\tfetch = +refs/heads/*:refs/remotes/\(name)/*\n" } ?? "")[branch \"main\"]\n\tremote = \(name)\n")
        return dir
    }

    func testClonesAndRemotes() {
        for spelling in ["https://github.com/Mathetic-PBC/engelbart-canvas.git", "git@github.com:Mathetic-PBC/engelbart-canvas.git", "ssh://git@github.com/Mathetic-PBC/engelbart-canvas", "git://github.com/Mathetic-PBC/engelbart-canvas.git/", "https://hudson:ghp_secret@github.com/Mathetic-PBC/engelbart-canvas.git"] {
            XCTAssertEqual(Library.canonicalRemote(spelling), "https://github.com/Mathetic-PBC/engelbart-canvas", spelling)
        }
        XCTAssertEqual(Library.canonicalRemote("git@gitlab.example.org:group/sub/tool.git"), "https://gitlab.example.org/group/sub/tool")
        XCTAssertNil(Library.canonicalRemote("/srv/git/local.git")); XCTAssertNil(Library.canonicalRemote("file:///srv/git/local.git")); XCTAssertNil(Library.canonicalRemote(""))
        let base = Paths.join(home, "remotes")
        XCTAssertEqual(Library.readCloneRemote(fakeClone(Paths.join(base, "plain"), "git@github.com:o/plain.git")), "https://github.com/o/plain")
        XCTAssertEqual(Library.readCloneRemote(fakeClone(Paths.join(base, "upstream-only"), "https://github.com/o/fork.git", name: "upstream")), "https://github.com/o/fork")
        XCTAssertNil(Library.readCloneRemote(fakeClone(Paths.join(base, "no-remote"), nil)))
        XCTAssertEqual(Library.readCloneRemote(fakeClone(Paths.join(base, "worktree"), nil, worktreeOf: Paths.join(base, "plain"))), "https://github.com/o/plain")
        XCTAssertNil(Library.readCloneRemote(Paths.join(base, "missing")))
    }

    func testARepositoryIsItsGitHubId() async throws {
        let base = Paths.join(home, "repos")
        let known: [(Int, [String], String)] = [(101, ["Acme/Widgets"], "From GitHub."), (102, ["acme/gears"], ""), (103, ["acme/cogs", "acme/old-cogs"], "")]
        let identify: PageMeta.IdentifyRepo = { owner, name in
            guard let hit = known.first(where: { $0.1.contains { $0.lowercased() == "\(owner)/\(name)".lowercased() } }) else { throw StoreError("The address answered 404") }
            return .init(id: String(hit.0), fullName: hit.1[0], url: "https://github.com/\(hit.1[0])", description: hit.2)
        }
        let hooks = Library.AddHooks(identifyRepo: identify)
        let byUrl = try await Library.addItem(ctx, "https://github.com/acme/widgets", hooks: hooks)
        XCTAssertEqual([byUrl.githubId, byUrl.name, byUrl.url, byUrl.summary], ["101", "Acme/Widgets", "https://github.com/Acme/Widgets", "From GitHub."]); XCTAssertNil(byUrl.folderPath)
        let clone = fakeClone(Paths.join(base, "widgets-checkout"), "git@github.com:acme/widgets.git")
        let e = await thrown { try await Library.addItem(ctx, clone, hooks: hooks) } as? StoreError
        XCTAssertEqual(e?.code, "EXISTS"); XCTAssertEqual(e?.row?.id, byUrl.id)
        let linked = try ctx.libraryDb.get(byUrl.id)!
        XCTAssertEqual(linked.folderPath, clone); XCTAssertEqual(byUrl.type, "website"); XCTAssertEqual(linked.type, "folder")
        let second = fakeClone(Paths.join(base, "gears"), "https://github.com/acme/gears.git")
        let byFolder = try await Library.addItem(ctx, second, hooks: hooks)
        XCTAssertEqual([byFolder.githubId, byFolder.name, byFolder.url, byFolder.folderPath], ["102", "acme/gears", "https://github.com/acme/gears", second])
        let e2 = await thrown { try await Library.addItem(ctx, "git@github.com:acme/gears.git", hooks: hooks) } as? StoreError
        XCTAssertEqual(e2?.row?.id, byFolder.id)
        let old = try await Library.addItem(ctx, "https://github.com/acme/old-cogs", hooks: .init(identifyRepo: { _, _ in .init(id: "103", fullName: "acme/old-cogs", url: "https://github.com/acme/old-cogs", description: "") }))
        let cogs = fakeClone(Paths.join(base, "cogs"), "https://github.com/acme/cogs.git")
        await XCTAssertThrowsMatching({ try await Library.addItem(ctx, cogs, hooks: hooks) }, "Already in the library as “acme/cogs”")
        let renamed = try ctx.libraryDb.get(old.id)!
        XCTAssertEqual([renamed.githubId, renamed.url, renamed.name, renamed.folderPath], ["103", "https://github.com/acme/cogs", "acme/cogs", cogs])
        let before = try await Library.addItem(ctx, "https://github.com/acme/reused", hooks: .init(identifyRepo: { _, _ in .init(id: "104", fullName: "acme/reused", url: "https://github.com/acme/reused", description: "") }))
        let after = try await Library.addItem(ctx, "https://github.com/acme/reused", hooks: .init(identifyRepo: { _, _ in .init(id: "999", fullName: "acme/reused", url: "https://github.com/acme/reused", description: "") }))
        XCTAssertNotEqual(after.id, before.id); XCTAssertEqual(after.githubId, "999")

        // GitHub cannot be asked: the address stands in for the id
        let silent: PageMeta.IdentifyRepo = { _, _ in throw StoreError("The address answered 404") }
        let secret = try await Library.addItem(ctx, "https://github.com/Mathetic-PBC/secret", hooks: .init(identifyRepo: silent))
        XCTAssertNil(secret.githubId)
        let secretClone = fakeClone(Paths.join(home, "private", "secret"), "git@github.com:mathetic-pbc/secret.git")
        _ = await thrown { try await Library.addItem(ctx, secretClone, hooks: .init(identifyRepo: silent)) }
        XCTAssertEqual(try ctx.libraryDb.get(secret.id)?.folderPath, secretClone)
        let legacyDir = fakeClone(Paths.join(home, "private", "legacy"), "https://github.com/acme/legacy.git")
        let legacy = try ctx.libraryDb.insert(.init(name: "legacy", type: "folder", tags: ["git"], folderPath: legacyDir))
        await XCTAssertThrowsMatching({ try await Library.addItem(ctx, "https://github.com/acme/legacy", hooks: .init(identifyRepo: { _, _ in .init(id: "105", fullName: "acme/legacy", url: "https://github.com/acme/legacy", description: "") })) }, "Already in the library as “legacy”")
        let found = try ctx.libraryDb.get(legacy.id)!
        XCTAssertEqual([found.url, found.githubId, found.name], ["https://github.com/acme/legacy", "105", "legacy"])
        let moved = Paths.join(home, "private", "secret-moved")
        try FileManager.default.moveItem(atPath: secretClone, toPath: moved)
        _ = await thrown { try await Library.addItem(ctx, moved, hooks: .init(identifyRepo: silent)) }
        XCTAssertEqual(try ctx.libraryDb.get(secret.id)?.folderPath, moved)
        let lab = try await Library.addItem(ctx, "git@gitlab.example.org:group/lathe.git", hooks: .init(identifyRepo: { _, _ in throw StoreError("asked GitHub") }))
        XCTAssertEqual([lab.type, lab.url], ["website", "https://gitlab.example.org/group/lathe"]); XCTAssertEqual(lab.tags, ["git"]); XCTAssertNil(lab.githubId)
    }

    func testProjectCloneFoundOnAddAndPeek() async throws {
        let code = fakeClone(Paths.join(home, "code", "canvas"), "https://github.com/Mathetic-PBC/engelbart-canvas.git")
        write(Paths.join(code, "package.json"), "{}")
        try FileManager.default.createDirectory(atPath: Paths.join(code, "src"), withIntermediateDirectories: true)
        let row = try await Library.addItem(ctx, "https://github.com/mathetic-pbc/engelbart-canvas")
        XCTAssertNil(row.folderPath)
        try Projects.createProject(ctx, .init(name: "Canvas", directory: code))
        let seen = try await Library.previewItem(ctx, row.id, listRemoteFiles: { _, _ in throw StoreError("the network was asked") })
        XCTAssertEqual(seen.files, ["src/", "package.json"]); XCTAssertEqual(seen.folder, "~/code/canvas"); XCTAssertEqual(seen.owner, "mathetic-pbc")
        XCTAssertEqual(try ctx.libraryDb.get(row.id)?.folderPath, code)
        let other = fakeClone(Paths.join(home, "code", "tool"), "git@github.com:acme/tool.git")
        try Projects.createProject(ctx, .init(name: "Tool", directory: other))
        let added = try await Library.addItem(ctx, "https://github.com/acme/tool", hooks: .init(identifyRepo: { _, _ in .init(id: "106", fullName: "acme/tool", url: "https://github.com/acme/tool", description: "One request: id and description.") }))
        XCTAssertEqual([added.folderPath, added.summary, added.githubId, added.type], [other, "One request: id and description.", "106", "folder"])
        try FileManager.default.removeItem(atPath: other)
        let gone = try await Library.previewItem(ctx, added.id, listRemoteFiles: { _, _ in ["README.md"] })
        XCTAssertEqual(gone.files, ["README.md"]); XCTAssertNil(gone.folder); XCTAssertEqual(gone.folderMissing, "~/code/tool")

        let project = try Projects.create(ctx, "Peeks")
        let ws = try Workspaces.create(ctx, project.id, name: "Reading")
        let note = try Documents.createNote(ctx, project.id, name: "Peeked", text: "# Title\n- [ ] a task")
        try Workspaces.setContext(ctx, project.id, ws.id, [note.id])
        let peek = try await Library.previewItem(ctx, note.id)
        XCTAssertEqual(peek.text, "# Title\n- [ ] a task")
        XCTAssertEqual(peek.heldBy.map { "\($0.name) \($0.origin) \($0.workspaces.map(\.name))" }, ["Peeks true [\"Reading\"]"])
        write(Paths.join(home, "peek", "data.csv"), (0..<30).map { "row,\($0)" }.joined(separator: "\n"))
        let data = try await Library.addItem(ctx, Paths.join(home, "peek", "data.csv"))
        let awaited398 = try await Library.previewItem(ctx, data.id).lines?.count
        XCTAssertEqual(awaited398, 12)
        let remote = try await Library.addItem(ctx, "https://github.com/o/r")
        let asked = Box(0)
        let lister = PageMeta.remoteFileLister(fetch: { url, _, _ in
            asked.value += 1; XCTAssertEqual(url, "https://api.github.com/repos/o/r/contents")
            return HTTPResponse(url: url, data: Data(#"[{"name":"z.py","type":"file"},{"name":"docs","type":"dir"}]"#.utf8))
        })
        for _ in 0..<2 {
            let p = try await Library.previewItem(ctx, remote.id, listRemoteFiles: lister)
            XCTAssertEqual(p.owner, "o"); XCTAssertEqual(p.files, ["docs/", "z.py"])
        }
        XCTAssertEqual(asked.value, 1)
    }

    func testPageMeta() async throws {
        XCTAssertEqual(PageMeta.readHtmlMeta("<html><head><title>Ink &amp; Switch\n</title><meta content=\"Tools for &#39;thought&#39;\" name=\"description\"></head>"), .init(title: "Ink & Switch", description: "Tools for 'thought'"))
        XCTAssertEqual(PageMeta.readHtmlMeta("<meta property=\"og:title\" content=\"Only OG\"><meta property=\"og:description\" content='Second best'>"), .init(title: "Only OG", description: "Second best"))
        let describe = PageMeta.describer(fetch: { url, _, _ in HTTPResponse(url: url, headers: ["Content-Type": url.hasSuffix(".pdf") ? "application/pdf" : "text/html; charset=utf-8"], data: Data("<title>T</title>".utf8)) })
        let t = try await describe(.init(type: "website", tags: [], name: "", url: "https://example.org/"))
        XCTAssertEqual(t, .init(title: "T", description: ""))
        let none = try await describe(.init(type: "website", tags: [], name: "", url: "https://example.org/a.pdf"))
        XCTAssertNil(none)
        await XCTAssertThrowsMatching({ try await describe(.init(type: "website", tags: [], name: "", url: "ftp://example.org/")) }, "http")
        let identify = PageMeta.repoIdentifier(fetch: { url, _, _ in
            XCTAssertEqual(url, "https://api.github.com/repos/mqo00/hypocompass")
            return HTTPResponse(url: url, data: Data(#"{"id":1000596606,"full_name":"mqo00/hypocompass","description":null}"#.utf8))
        })
        let who = try await identify("mqo00", "hypocompass")
        XCTAssertEqual(who, .init(id: "1000596606", fullName: "mqo00/hypocompass", url: "https://github.com/mqo00/hypocompass", description: ""))
        await XCTAssertThrowsMatching({ try await PageMeta.repoIdentifier(fetch: { url, _, _ in HTTPResponse(status: 404, url: url, data: Data()) })("a", "b") }, "404")
        await XCTAssertThrowsMatching({ try await PageMeta.repoIdentifier(fetch: { url, _, _ in HTTPResponse(url: url, data: Data(#"{"id":"nope"}"#.utf8)) })("a", "b") }, "id")
        // a refused token is dropped and the question asked again signed out
        let headersSeen = Box<[Bool]>([])
        let signed = PageMeta.repoIdentifier(fetch: { url, headers, _ in
            headersSeen.value.append(headers["authorization"] != nil)
            return headers["authorization"] != nil ? HTTPResponse(status: 401, url: url, data: Data()) : HTTPResponse(url: url, data: Data(#"{"id":5,"full_name":"a/b"}"#.utf8))
        }, auth: { ["authorization": "Bearer x"] })
        let awaited435 = try await signed("a", "b").id
        XCTAssertEqual(awaited435, "5"); XCTAssertEqual(headersSeen.value, [true, false])
    }

    func testLookupPicturesAndTheTrash() async throws {
        let files = Paths.join(home, "lookups")
        write(Paths.join(files, "figure.PNG")); write(Paths.join(files, "shot.heic"))
        let before = try ctx.libraryDb.list().count
        let fresh = try Library.lookupItem(ctx, "https://example.org/never-added")
        XCTAssertNil(fresh.row); XCTAssertEqual(fresh.found?.type, "website"); XCTAssertNil(fresh.error)
        let page = try await Library.addItem(ctx, "https://example.org/looked-up")
        XCTAssertEqual(try Library.lookupItem(ctx, "https://example.org/looked-up").row?.id, page.id)
        let repo = try await Library.addItem(ctx, "https://github.com/looked/up")
        XCTAssertEqual(try Library.lookupItem(ctx, "git@github.com:Looked/Up.git").row?.id, repo.id)
        XCTAssertNotNil(try Library.lookupItem(ctx, Paths.join(files, "missing.pdf")).error?.range(of: "Nothing is at that path"))
        let picture = try Library.lookupItem(ctx, Paths.join(files, "figure.PNG"))
        XCTAssertNil(picture.row); XCTAssertEqual(picture.found?.type, "image")
        let heic = try await Library.addItem(ctx, Paths.join(files, "shot.heic"))
        XCTAssertEqual(heic.type, "image"); XCTAssertEqual(heic.path, Paths.join(files, "shot.heic"))
        XCTAssertEqual(try ctx.libraryDb.list().count, before + 3)

        let project = try Projects.create(ctx, "Sidebar")
        let workspace = try Workspaces.create(ctx, project.id, name: "Reading")
        let other = try Workspaces.create(ctx, project.id, name: "Elsewhere")
        let a = try await Library.addItem(ctx, "https://example.org/a-link"), b = try await Library.addItem(ctx, "https://example.org/b-link")
        let note = try Documents.createNote(ctx, project.id, name: "Made here", workspaceId: workspace.id)
        var seen = try Workspaces.link(ctx, project.id, workspace.id, [a.id, b.id, a.id])
        XCTAssertEqual(seen.context, [a.id, b.id]); XCTAssertEqual(seen.removed, [])
        try Workspaces.link(ctx, project.id, other.id, [a.id])
        seen = try Workspaces.unlink(ctx, project.id, workspace.id, [a.id])
        XCTAssertEqual(seen.context, [b.id]); XCTAssertEqual(seen.removed, [a.id])
        seen = try Workspaces.unlink(ctx, project.id, workspace.id, [note.id])
        XCTAssertEqual(seen.removed, [a.id, note.id])
        XCTAssertEqual(try Projects.loadProject(ctx, project.id).workspaces.first { $0.id == workspace.id }?.removed, [a.id, note.id])
        XCTAssertEqual(try Workspaces.find(ctx, project.id, other.id).workspace.context, [a.id])
        seen = try Workspaces.link(ctx, project.id, workspace.id, [note.id])
        XCTAssertEqual(seen.context, [b.id, note.id]); XCTAssertEqual(seen.removed, [a.id])
    }


    func testWebMarksBoxesAndAnswers() throws {
        let url = "https://essays.example.org/marked"
        let highlight: JSONValue = ["id": "m1", "quote": ["exact": "a phrase", "prefix": "", "suffix": ""], "note": "", "at": "2026-10-06T00:00:00.000Z"]
        XCTAssertTrue(try Library.addWebMark(ctx, url: url, mark: highlight))
        XCTAssertFalse(try Library.addWebMark(ctx, url: url, mark: highlight), "once")
        XCTAssertFalse(try Library.addWebMark(ctx, url: "http://localhost:3000/", mark: highlight), "a preview keeps no ink")
        let png = Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
        let box: JSONValue = ["id": "b1", "box": ["x": 1, "y": 2, "w": 3, "h": 4], "crop": "crops/b1.png", "text": "under", "note": ""]
        XCTAssertTrue(try Library.addWebMark(ctx, url: url, mark: box, crop: png))
        XCTAssertEqual(FileManager.default.contents(atPath: Library.cropFile(ctx, "crops/b1.png")!), png)
        XCTAssertNil(Library.cropFile(ctx, "../x.png"))
        XCTAssertEqual(Library.readWebMark(ctx, url: url, markId: "m1")?["quote"]?["exact"], "a phrase")
        XCTAssertEqual(try Library.readPageAnnotations(ctx, "http://www." + url.dropFirst(8))?["web"]?.array?.count, 2, "one page however it is spelled")

        let entry: JSONValue = ["id": "ask-1", "question": "why?", "lines": ["bart> because"]]
        XCTAssertTrue(try Library.addMarkAnswer(ctx, url: url, page: nil, markId: "m1", entry: entry))
        XCTAssertFalse(try Library.addMarkAnswer(ctx, url: url, page: nil, markId: "m1", entry: entry), "once")
        XCTAssertFalse(try Library.addMarkAnswer(ctx, url: url, page: nil, markId: "gone", entry: entry), "only while the mark is there")
        XCTAssertEqual(Library.readWebMark(ctx, url: url, markId: "m1")?["asks"]?.array?.count, 1)

        let resized = try Library.updateWebMark(ctx, url: url, markId: "b1", patch: ["note": "a note", "id": "hijack"], crop: Data([9, 9]))!
        XCTAssertEqual(resized["note"], "a note"); XCTAssertEqual(resized["id"], "b1", "its id is not the caller's to set")
        XCTAssertEqual(resized["crop"], "crops/b1-1.png", "a resized box has a new picture; the old one stays")
        XCTAssertTrue(exists(Library.cropFile(ctx, "crops/b1.png")!)); XCTAssertTrue(exists(Library.cropFile(ctx, "crops/b1-1.png")!))
        XCTAssertNil(try Library.updateWebMark(ctx, url: url, markId: "b1", patch: ["box": "flat"]), "a box stays a box")
        XCTAssertNil(try Library.updateWebMark(ctx, url: url, markId: "nope", patch: ["note": "x"]))

        let removed = try Library.removeWebMark(ctx, url: url, markId: "b1")!
        XCTAssertEqual(removed.index, 1); XCTAssertEqual(Set(removed.crops.map(\.crop)), ["crops/b1.png", "crops/b1-1.png"])
        XCTAssertFalse(exists(Library.cropFile(ctx, "crops/b1.png")!))
        XCTAssertNil(Library.readWebMark(ctx, url: url, markId: "b1"))
        XCTAssertTrue(try Library.restoreWebMark(ctx, url: url, removed))
        XCTAssertFalse(try Library.restoreWebMark(ctx, url: url, removed), "already back")
        XCTAssertEqual(try Library.readPageAnnotations(ctx, url)?["web"]?.array?.map { $0["id"]!.string! }, ["m1", "b1"])
        XCTAssertTrue(exists(Library.cropFile(ctx, "crops/b1-1.png")!))

        // the file @bart reads: where it would be written, '' for a preview
        XCTAssertTrue(try Library.annotationsFileOf(ctx, url: url).hasPrefix(Paths.join(ctx.dataRoot, "annotations", "pages")))
        XCTAssertEqual(try Library.annotationsFileOf(ctx, url: "http://127.0.0.1:8000/"), "")
        // pdf page marks (MATH-27): an answer onto page 2
        let row = try ctx.libraryDb.insert(.init(name: "p", type: "website", url: "https://example.org/p.pdf"))
        try Library.writeAnnotations(ctx, row.id, ["2": [["id": "k", "rects": []]]])
        XCTAssertTrue(try Library.addMarkAnswer(ctx, rowId: row.id, page: 2, markId: "k", entry: entry))
        XCTAssertEqual(try Library.readAnnotations(ctx, row.id)?["2"]?[0]?["asks"]?.array?.count, 1)
        XCTAssertEqual(try Library.annotationsFileOf(ctx, rowId: row.id), Paths.join(ctx.dataRoot, "annotations", "\(row.id).json"))
    }

    // MARK: library-drop.test.cjs

    let PNG = latin1("\u{89}PNG\r\n\u{1a}\n\u{00}\u{00}\u{00}\rIHDR picture")
    let JPEG = latin1("\u{ff}\u{d8}\u{ff}\u{e0} photo")
    let PDF = Data("%PDF-1.7 dropped".utf8)
    func images() -> [String] { (try? FileManager.default.contentsOfDirectory(atPath: Paths.join(layout.testRoot, "assets", "images"))) ?? [] }

    func testAddFileCopy() async throws {
        let row = try await Library.addFileCopy(ctx, bytes: PNG, mime: "image/png", name: "Figure 3.png")
        XCTAssertEqual([row.type, row.name], ["image", "Figure 3.png"]); XCTAssertNil(row.projectId); XCTAssertNil(row.url)
        XCTAssertEqual(row.path, Paths.join(layout.testRoot, "assets", "images", "\(row.id).png"))
        XCTAssertEqual([row.source, row.category], ["mac", "image"])
        let cat = try await Library.addFileCopy(ctx, bytes: JPEG, mime: "image/jpeg", url: "https://cdn.example.org/pets/Sleepy%20cat.jpg")
        XCTAssertEqual([cat.name, cat.url], ["Sleepy cat.jpg", "https://cdn.example.org/pets/Sleepy%20cat.jpg"]); XCTAssertTrue(cat.path!.hasSuffix(".jpg"))
        let awaited487 = try await Library.addFileCopy(ctx, bytes: PNG, mime: "image/png", url: "https://cdn.example.org/").name
        XCTAssertEqual(awaited487, "Image")
        let awaited488 = try await Library.addFileCopy(ctx, bytes: PNG, mime: "image/png").name
        XCTAssertEqual(awaited488, "Image")
        let awaited489 = try await Library.addFileCopy(ctx, bytes: latin1("RIFF\u{10}\u{00}\u{00}\u{00}WEBPVP8 "), mime: "image/png", name: "w").path!.hasSuffix(".webp")
        XCTAssertTrue(awaited489)
        let raw = try await Library.addFileCopy(ctx, bytes: PNG, mime: "image/png", url: "https://github.com/o/r/raw/main/docs/shot.png")
        XCTAssertEqual([raw.type, raw.name], ["image", "shot.png"]); XCTAssertEqual(raw.tags, [])
        let pdf = try await Library.addFileCopy(ctx, bytes: PDF, mime: "application/pdf", name: "Retrieval Study.pdf", inspectPdf: { _ in ["paper"] })
        XCTAssertEqual([pdf.type, pdf.name], ["pdf", "Retrieval Study"]); XCTAssertEqual(pdf.tags, ["paper"])
        let arxiv = try await Library.addFileCopy(ctx, bytes: PDF, mime: "application/pdf", url: "https://arxiv.org/pdf/1706.03762v7")
        XCTAssertEqual(arxiv.url, "https://arxiv.org/abs/1706.03762"); XCTAssertEqual(arxiv.tags, ["paper"])
        let count = images().count
        await XCTAssertThrowsMatching({ try await Library.addFileCopy(ctx, bytes: Data("<html>".utf8), mime: "text/html") }, "Only png, jpeg, gif and webp images and pdfs")
        await XCTAssertThrowsMatching({ try await Library.addFileCopy(ctx, bytes: Data("<html>".utf8), mime: "image/png") }, "not a png, jpeg, gif or webp image")
        await XCTAssertThrowsMatching({ try await Library.addFileCopy(ctx, bytes: self.PNG, mime: "application/pdf") }, "not a pdf")
        await XCTAssertThrowsMatching({ try await Library.addFileCopy(ctx, bytes: Data(), mime: "image/png") }, "empty")
        var big = Data(count: Library.maxImageBytes + 1); big.replaceSubrange(0..<PNG.count, with: PNG)
        await XCTAssertThrowsMatching({ try await Library.addFileCopy(ctx, bytes: big, mime: "image/png") }, "larger than 20 MB")
        await XCTAssertThrowsMatching({ try await Library.addFileCopy(ctx, bytes: self.PNG, mime: "image/png", url: "file:///etc/hosts") }, "from the web")
        let first = try await Library.addFileCopy(ctx, bytes: PNG, mime: "image/png", url: "https://images.example.org/a/b.png")
        let e = await thrown { try await Library.addFileCopy(ctx, bytes: self.PNG, mime: "image/png", url: "http://www.images.example.org/a/b.png#top") } as? StoreError
        XCTAssertEqual(e?.code, "EXISTS"); XCTAssertEqual(e?.row?.id, first.id)
        XCTAssertEqual(images().count, count + 1)
    }

    func stub(_ pages: [String: (status: Int, type: String?, length: Int?, body: Data)]) -> (HTTPFetch, Box<[(String, String?)]>) {
        let asked = Box<[(String, String?)]>([])
        let fetch: HTTPFetch = { url, headers, _ in
            asked.value.append((url, headers["accept"]))
            guard let page = pages[url] else { throw StoreError("fetch failed") }
            var h: [String: String] = [:]
            if let type = page.type { h["content-type"] = type }
            if let length = page.length { h["content-length"] = String(length) }
            return HTTPResponse(status: page.status, url: url, headers: h, data: page.body)
        }
        return (fetch, asked)
    }

    func testAddFromUrl() async throws {
        let (fetch, asked) = stub([
            "https://cdn.example.org/cats/tabby.png": (200, "image/png; charset=binary", nil, PNG),
            "https://blog.example.org/post": (200, "text/html; charset=utf-8", nil, Data("<title>A post</title>".utf8)),
            "https://papers.example.org/download?id=7": (200, "application/octet-stream", nil, PDF),
            "https://papers.example.org/typed.pdf": (200, "application/pdf", nil, PDF),
            "https://files.example.org/blob": (200, nil, nil, JPEG),
            "https://files.example.org/data.bin": (200, "application/octet-stream", nil, Data("just bytes".utf8)),
            "https://gone.example.org/missing.png": (404, "text/html", nil, Data("Not found".utf8)),
            "https://cdn.example.org/huge.png": (200, "image/png", Library.maxImageBytes + 1, PNG),
            "https://cdn.example.org/liar.png": (200, "image/png", nil, Data(count: Library.maxImageBytes + 10)),
        ])
        let describe: PageMeta.Describe = { _ in .init(title: "A post", description: "About things.") }
        let image = try await Library.addFromUrl(ctx, " https://cdn.example.org/cats/tabby.png ", fetch: fetch, hooks: .init(describe: describe))
        XCTAssertEqual([image.type, image.name, image.url], ["image", "tabby.png", "https://cdn.example.org/cats/tabby.png"])
        let page = try await Library.addFromUrl(ctx, "https://blog.example.org/post", fetch: fetch, hooks: .init(describe: describe))
        XCTAssertEqual([page.type, page.name, page.url, page.summary], ["website", "A post", "https://blog.example.org/post", "About things."])
        XCTAssertTrue(asked.value.allSatisfy { $0.1?.contains("image/png") == true })
        let e = await thrown { try await Library.addFromUrl(ctx, "https://cdn.example.org/cats/tabby.png", fetch: fetch) } as? StoreError
        XCTAssertEqual(e?.code, "EXISTS")
        let told = try await Library.addFromUrl(ctx, "https://papers.example.org/download?id=7", fetch: fetch, hooks: .init(inspectPdf: { _ in ["paper"] }))
        XCTAssertEqual([told.type, told.name], ["pdf", "download"]); XCTAssertEqual(told.tags, ["paper"])
        let awaited545 = try await Library.addFromUrl(ctx, "https://papers.example.org/typed.pdf", fetch: fetch).name
        XCTAssertEqual(awaited545, "typed")
        let awaited546 = try await Library.addFromUrl(ctx, "https://files.example.org/blob", fetch: fetch).type
        XCTAssertEqual(awaited546, "image")
        let awaited547 = try await Library.addFromUrl(ctx, "https://files.example.org/data.bin", fetch: fetch).type
        XCTAssertEqual(awaited547, "website")
        let awaited548 = try await Library.addFromUrl(ctx, "https://gone.example.org/missing.png", fetch: fetch).type
        XCTAssertEqual(awaited548, "website")
        let awaited549 = try await Library.addFromUrl(ctx, "https://offline.example.org/a.png", fetch: fetch).type
        XCTAssertEqual(awaited549, "website")
        let before = asked.value.count
        for input in ["file:///etc/hosts", "ftp://example.org/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA"] {
            await XCTAssertThrowsMatching({ try await Library.addFromUrl(ctx, input, fetch: fetch) }, #"Only http\(s\) links"#)
        }
        await XCTAssertThrowsMatching({ try await Library.addFromUrl(ctx, "not a link", fetch: fetch) }, "not a valid address")
        XCTAssertEqual(asked.value.count, before)
        await XCTAssertThrowsMatching({ try await Library.addFromUrl(ctx, "https://cdn.example.org/huge.png", fetch: fetch) }, "larger than 20 MB")
        await XCTAssertThrowsMatching({ try await Library.addFromUrl(ctx, "https://cdn.example.org/liar.png", fetch: fetch) }, "larger than 20 MB")
    }

    func testOutsideHomeCopyAndMarkdownCopy() async throws {
        let outside = tempDir("engelbart-outside-")
        let shot = Paths.join(outside, "Screenshot 2026-10-13.png")
        writeData(shot, PNG)
        let row = try await Library.addItem(ctx, shot)
        XCTAssertEqual([row.type, row.name], ["image", "Screenshot 2026-10-13.png"]); XCTAssertTrue(row.path!.hasPrefix(ctx.dataRoot))
        try FileManager.default.removeItem(atPath: shot)
        XCTAssertTrue(exists(row.path!))
        write(Paths.join(outside, "notes.md"), "# hi")
        // the temp folder is outside this test's home: refused for anything but a picture or a pdf
        await XCTAssertThrowsMatching({ try await Library.addItem(ctx, Paths.join(outside, "notes.md")) }, "home directory")

        let picture = Paths.join(outside, "p.png"); writeData(picture, PNG)
        let md = try Library.addMarkdownCopy(ctx, name: " A: chat/one ", text: "body", pictures: [(picture, "p.png")], about: AboutFields(source: "Claude", category: "chat"))
        XCTAssertEqual(md.name, "A: chat/one"); XCTAssertEqual(md.titled, Library.titleRules)
        XCTAssertEqual(Paths.basename(md.path!), "A- chat-one.md"); XCTAssertTrue(exists(Paths.join(Paths.dirname(md.path!), "p.png")))
        XCTAssertEqual(md.source, "Claude")
    }

    // MARK: library-about.test.cjs

    func testHeadLinesAndDescribeRows() async throws {
        let assets = Paths.join(ctx.dataRoot, "assets")
        func keep(_ name: String, _ text: String) throws -> LibraryRow {
            let id = uuid()
            let file = Paths.join(assets, "md", id, "\(name).md")
            write(file, text)
            return try ctx.libraryDb.insert(.init(id: id, name: name, type: "md", path: file))
        }
        let chat = try keep("Old chat", "*Claude · 2025-10-06 · Transfer study*\n\n**You:** Q one\n\n**Claude:** A one\n\n**You:** Q two\n\n**Claude:** A two\n")
        let bare = try keep("Old ChatGPT", "*ChatGPT · 2025-09-01*\n\n**You:** Hi\n\n**ChatGPT:** Hello\n")
        let mail = try keep("Old thread", "*Gmail · Mon, Mar 2, 2026 at 9:10 AM–Tue, Mar 3, 2026 at 4:45 PM · Dr. Lee, Sam*\n\n**Dr. Lee**, Mon\n\nHi\n")
        let drive = try keep("Old doc", "*Google Drive · https://drive.google.com/open?id=abcdefghijk*\n\nBody\n")
        let overleaf = try keep("Old tex", "*Overleaf · https://www.overleaf.com/project/0123456789abcdef01234567*\n\nx\n")
        let other = try keep("Old notion", "*Notion · 2025-01-01*\n\nNot an app whose head line is read\n")
        let savedId = uuid()
        writeData(Paths.join(assets, "pdfs", "\(savedId).pdf"), makePdf([["Saved"]]))
        let saved = try ctx.libraryDb.insert(.init(id: savedId, name: "Saved paper", type: "pdf", path: Paths.join(assets, "pdfs", "\(savedId).pdf"), url: "https://example.org/saved.pdf", categorized: 1))
        let repo = try ctx.libraryDb.insert(.init(name: "org/tool", type: "website", tags: ["git"], url: "https://github.com/org/tool"))
        write(Paths.join(home, "Data", "runs.csv"), "a,b\n")
        let onMac = try ctx.libraryDb.insert(.init(name: "Given name", type: "csv", path: Paths.join(home, "Data", "runs.csv")))
        let edited = try ctx.libraryDb.get(chat.id)!.lastEdited
        try await Library.describeRows(ctx)
        func about(_ row: LibraryRow) throws -> [String?] { let r = try ctx.libraryDb.get(row.id)!; return [r.source, r.category, r.itemDate, r.originUrl, r.place, r.messages.map(String.init), r.minutes.map(String.init)] }
        XCTAssertEqual(try about(chat), ["Claude", "chat", "2025-10-06", nil, "Transfer study", "4", nil])
        XCTAssertEqual(try about(bare), ["ChatGPT", "chat", "2025-09-01", nil, nil, "2", nil])
        XCTAssertEqual(try about(mail), ["Gmail", "email", "2026-03-03", nil, nil, nil, nil])
        XCTAssertEqual(try about(drive), ["Google Docs", "note", nil, "https://drive.google.com/open?id=abcdefghijk", nil, nil, nil])
        XCTAssertEqual(try about(overleaf), ["Overleaf", "paper", nil, "https://www.overleaf.com/project/0123456789abcdef01234567", nil, nil, nil])
        XCTAssertEqual(try about(other), [nil, nil, nil, nil, nil, nil, nil])
        XCTAssertEqual(try about(saved)[0], "web")
        XCTAssertEqual(try about(repo)[0...1], ["github", "repo"])
        XCTAssertEqual(try about(onMac)[0], "mac")
        let after = try ctx.libraryDb.get(chat.id)!
        XCTAssertEqual([after.name, after.lastEdited], ["Old chat", edited]); XCTAssertEqual(after.titled, Library.titleRules)
        try ctx.libraryDb.fillAbout(chat.id, AboutFields(source: "ChatGPT", place: "Elsewhere"))
        XCTAssertEqual(try about(chat)[0], "Claude")
        XCTAssertFalse(try ctx.libraryDb.untitled(Library.titleRules).contains { $0.id == chat.id })
        XCTAssertEqual(Library.dayOf("Mon, Oct 6, 2025 at 3:14 PM"), "2025-10-06")
    }

    func testRetitlePass() async throws {
        func pdf(_ rel: String, _ lines: [String], _ info: [String: String]? = nil) -> String { let f = Paths.join(home, rel); writeData(f, makePdf([lines], info: info)); return f }
        let withTitle = pdf("Papers/smith2020.pdf", ["Some first line"], ["Title": "Learning to Learn"])
        let firstLine = pdf("Papers/scan_0042.pdf", ["A Study of Transfer", "Ana Author"])
        let wordTitle = pdf("Papers/draft3.pdf", ["Real Heading Here"], ["Title": "Microsoft Word - draft3.docx"])
        let given = pdf("Papers/given.pdf", ["Ignored"], ["Title": "Ignored too"])
        let template = pdf("Papers/neurips.pdf", ["IDETrace"], ["Title": "Formatting Instructions For NeurIPS 2026"])
        XCTAssertEqual(try PdfKind.pdfTitle(withTitle), "Learning to Learn")
        XCTAssertEqual(try PdfKind.pdfTitle(firstLine), "")
        XCTAssertEqual(try PdfKind.pdfTitle(wordTitle), "")
        XCTAssertEqual(try PdfKind.pdfTitle(template), "")
        let a = try await Library.addItem(ctx, withTitle), b = try await Library.addItem(ctx, firstLine), c = try await Library.addItem(ctx, wordTitle)
        let d = try await Library.addItem(ctx, given, name: "The name I gave")
        write(Paths.join(home, "Docs", "meeting-notes.md"), "---\ntags: x\n---\n\n```\n# not this\n```\n# Kickoff with Ana\n\nText\n")
        write(Paths.join(home, "Docs", "scratch.md"), "no heading here\n")
        write(Paths.join(home, "Docs", "other.md"), "# Its heading\n")
        write(Paths.join(home, "Docs", "gone.md"), "# Gone\n")
        let md = try await Library.addItem(ctx, Paths.join(home, "Docs", "meeting-notes.md"))
        let mdNone = try await Library.addItem(ctx, Paths.join(home, "Docs", "scratch.md"))
        let mdGiven = try await Library.addItem(ctx, Paths.join(home, "Docs", "other.md"), name: "Kept as I named it")
        let gone = try await Library.addItem(ctx, Paths.join(home, "Docs", "gone.md"))
        try FileManager.default.removeItem(atPath: gone.path!)
        let project = try Projects.create(ctx, "Retitle")
        let noteId = try Documents.createNote(ctx, project.id, name: "note-stem", text: "# A heading in a note\n").id
        let unread = try await Library.describeRows(ctx)
        XCTAssertGreaterThanOrEqual(unread.due, 3)
        XCTAssertEqual(try ctx.libraryDb.get(a.id)?.name, "smith2020")
        let report = try await Library.describeRows(ctx, pdfTitle: PdfKind.title)
        func name(_ id: String) throws -> String { try ctx.libraryDb.get(id)!.name }
        XCTAssertEqual(try name(a.id), "Learning to Learn"); XCTAssertEqual(try name(b.id), "scan_0042"); XCTAssertEqual(try name(c.id), "draft3")
        XCTAssertEqual(try name(d.id), "The name I gave"); XCTAssertEqual(try name(md.id), "Kickoff with Ana"); XCTAssertEqual(try name(mdNone.id), "scratch.md")
        XCTAssertEqual(try name(mdGiven.id), "Kept as I named it"); XCTAssertEqual(try name(noteId), "note-stem")
        XCTAssertTrue(report.renamed.contains { $0.id == a.id && $0.from == "smith2020" && $0.to == "Learning to Learn" })
        XCTAssertNil(try ctx.libraryDb.get(gone.id)?.titled)
        try ctx.libraryDb.rename(a.id, "smith2020")
        try await Library.describeRows(ctx, pdfTitle: PdfKind.title)
        XCTAssertEqual(try name(a.id), "smith2020")
    }

    func testRemoveFromProjectRules() async throws {
        let project = try Projects.create(ctx, "Removal")
        let imported = try Documents.createNote(ctx, project.id, name: "Onboarded chat", text: "*Claude · 2026-09-30 · Thesis*\n\n**You:** Q\n\n**Claude:** A\n")
        let mine = try Documents.createNote(ctx, project.id, name: "Written here", text: "*Claude · 2026-09-30*\n\nLooks like a chat, but I wrote it.\n")
        try ctx.libraryDb.query("update library set source = null, category = null, titled = null, created = '2026-10-01T12:00:00.000Z' where id = ?", [.text(imported.id)])
        try ctx.libraryDb.query("update library set source = null, category = null, titled = null where id = ?", [.text(mine.id)])
        try await Library.describeRows(ctx)
        XCTAssertEqual(try ctx.libraryDb.get(imported.id)?.source, "Claude"); XCTAssertEqual(try ctx.libraryDb.get(imported.id)?.place, "Thesis")
        XCTAssertEqual(try ctx.libraryDb.get(mine.id)?.source, "engelbart")
        XCTAssertEqual(try Projects.removeFromProject(ctx, project.id, [imported.id]), 1)
        XCTAssertThrowsMatchingSync({ try Projects.removeFromProject(ctx, project.id, [mine.id]) }, #"Made in this project, so it goes to the trash instead of being removed \(only what was brought in from elsewhere can be removed\): Written here"#)
        let unknown = try ctx.libraryDb.insert(.init(name: "Unknown origin", type: "website", url: "https://example.org/unknown", projectId: project.id))
        XCTAssertThrowsMatchingSync({ try Projects.removeFromProject(ctx, project.id, [unknown.id]) }, "Made in this project.*Unknown origin")
    }

    // MARK: project-library.test.cjs (store parts)

    func testProjectsOwnList() throws {
        let held = ProjectHolds.holder(projectId: "p", library: ["listed", "both"], removed: ["both", "made-removed"], workspaces: [.init(id: "w", context: ["ctx", "ctx-thrown"], removed: ["ctx-thrown"])])
        func row(_ id: String, _ project: String? = nil) -> LibraryRow { LibraryRow(id: id, name: id, type: "md", projectId: project) }
        XCTAssertTrue(held(row("made", "p"))); XCTAssertTrue(held(row("listed"))); XCTAssertTrue(held(row("ctx")))
        XCTAssertFalse(held(row("ctx-thrown"))); XCTAssertFalse(held(row("both"))); XCTAssertFalse(held(row("made-removed", "p"))); XCTAssertFalse(held(row("other", "q")))
        XCTAssertEqual(ProjectHolds.letGo([.init(id: "w", context: [], removed: [])], ["postit": nil]), [])

        let project = try Projects.create(ctx, "Library 1")
        let a = try Workspaces.create(ctx, project.id, name: "A"), b = try Workspaces.create(ctx, project.id, name: "B")
        let paper = try ctx.libraryDb.insert(.init(name: "Listed", type: "website", url: "https://example.org/\(uuid())"))
        XCTAssertEqual(try Library.libraryForProject(ctx, project.id).count, 0)
        XCTAssertEqual(try Projects.addToProject(ctx, project.id, [paper.id]).added, 1)
        XCTAssertEqual(json(Paths.join(project.dir, "project.json"))?["library"], [.string(paper.id)])
        XCTAssertEqual(try Library.libraryForProject(ctx, project.id).map(\.row.id), [paper.id])
        XCTAssertTrue(try Projects.listProjects(ctx).first { $0.id == project.id }!.libraryIds!.contains(paper.id))
        XCTAssertEqual(try Projects.removeFromProject(ctx, project.id, [paper.id]), 1)
        XCTAssertEqual(try Projects.find(ctx, project.id).removed, [paper.id])
        XCTAssertEqual(try Library.libraryForProject(ctx, project.id).count, 0)
        try Projects.addToProject(ctx, project.id, [paper.id])
        XCTAssertEqual(try Projects.find(ctx, project.id).library, [paper.id]); XCTAssertEqual(try Projects.find(ctx, project.id).removed, [])

        let note = try Documents.createNote(ctx, project.id, name: "Draft", workspaceId: a.id, text: "x")
        let postIt = try Documents.createNote(ctx, project.id, name: "From a post-it", text: "y")
        try Workspaces.link(ctx, project.id, b.id, [note.id])
        try Workspaces.unlink(ctx, project.id, b.id, [note.id])
        XCTAssertTrue(try Library.libraryForProject(ctx, project.id).contains { $0.row.id == note.id })
        try Workspaces.unlink(ctx, project.id, a.id, [note.id])
        XCTAssertFalse(try Library.libraryForProject(ctx, project.id).contains { $0.row.id == note.id })
        XCTAssertTrue(try Library.libraryForProject(ctx, project.id).contains { $0.row.id == postIt.id })

        let ids = (0..<201).map { _ in uuid() }
        XCTAssertThrowsMatchingSync({ try Projects.addToProject(ctx, project.id, ids) }, "At most 200 .* 201 were sent")
        XCTAssertThrowsMatchingSync({ try Projects.removeFromProject(ctx, project.id, ids) }, "At most 200 .* 201 were sent")
        XCTAssertThrowsMatchingSync({ try Projects.addToProject(ctx, project.id, [uuid()]) }, "Not in the library")

        let rows = [try ctx.libraryDb.insert(.init(name: "One", type: "website", url: "https://example.org/\(uuid())")), try ctx.libraryDb.insert(.init(name: "Two", type: "website", url: "https://example.org/\(uuid())"))]
        let dir = try Workspaces.find(ctx, project.id, a.id).workspace.dir
        try JSONFiles.write(Paths.join(dir, "meta.json"), json(Paths.join(dir, "meta.json"))!.merging(["context": .array((0..<(Projects.maxTreeEntries - 1)).map { _ in .string(uuid()) })]))
        let out = try Projects.addToProject(ctx, project.id, rows.map(\.id), workspaceId: a.id)
        XCTAssertEqual(out.added, 2); XCTAssertEqual(out.inWorkspace, 1)

        let mention = try ctx.libraryDb.insert(.init(name: "Transfer study", type: "website", url: "https://example.org/\(uuid())"))
        let c = try Workspaces.create(ctx, project.id, name: "C"), d = try Workspaces.create(ctx, project.id, name: "D")
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: c.id), "See @[Transfer study](lib:\(mention.id)).")
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: d.id), "And @[transfer study] too.")
        XCTAssertEqual(try Projects.projectItemMentions(ctx, project.id, mention.id).map(\.name).sorted(), ["C", "D"])
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: d.id), "Nothing now.")
        XCTAssertEqual(try Projects.projectItemMentions(ctx, project.id, mention.id).map(\.name), ["C"])
        XCTAssertEqual(try Projects.keepInProject(ctx, project.id, [mention.id, mention.id, "junk"]), [mention.id])
    }
}
