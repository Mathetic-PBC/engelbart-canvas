import XCTest
import EngelbartCore
@testable import EngelbartStore

/// test/onboarding.test.cjs, getting-started.test.cjs, folder-files.test.cjs, web-pdfs.test.cjs, pdf-kind.test.cjs,
/// store-modes.test.cjs (store parts), the shared address key and GitHub links.
final class MiscTests: XCTestCase {
    var ctx: StoreContext!
    var layout: Home.Layout!
    var home: String!

    override func setUpWithError() throws { (ctx, layout, home) = try makeContext("engelbart-misc-") }
    override func tearDown() { SQLiteRegistry.closeAll() }

    // MARK: onboarding

    func testInstructionsAndFolders() throws {
        XCTAssertEqual(Onboarding.readInstructions(ctx.dataRoot), "")
        XCTAssertEqual(Onboarding.instructionsBlock(ctx.dataRoot), "")
        try Onboarding.writeInstructions(ctx.dataRoot, "  I study help-seeking.\n\n")
        XCTAssertEqual(Onboarding.readInstructions(ctx.dataRoot), "I study help-seeking.")
        XCTAssertNotNil(Onboarding.instructionsBlock(ctx.dataRoot).range(of: #"^<custom_instructions [^>]*>\nI study help-seeking\.\n</custom_instructions>$"#, options: .regularExpression))
        try Onboarding.writeInstructions(ctx.dataRoot, "   ")
        XCTAssertFalse(exists(Paths.join(ctx.dataRoot, "instructions.md")))

        let first = try Onboarding.freeFolder(ctx, "Teachable Agents!")
        XCTAssertEqual(first, .init(path: Paths.join(home, "teachable-agents"), shown: "~/teachable-agents"))
        try FileManager.default.createDirectory(atPath: first.path, withIntermediateDirectories: true)
        XCTAssertEqual(try Onboarding.freeFolder(ctx, "Teachable Agents!").shown, "~/teachable-agents-2")
        XCTAssertThrowsMatchingSync({ try Onboarding.existingFolder(ctx, "relative/path") }, "starts with")
        XCTAssertThrowsMatchingSync({ try Onboarding.existingFolder(ctx, "~/not-there") }, "Nothing is at")
        XCTAssertEqual(try Onboarding.existingFolder(ctx, "~/teachable-agents"), first.path)
    }

    func testStartProjectAndDiscard() async throws {
        write(Paths.join(home, "paper.pdf"), "%PDF-1.4\n%%EOF\n")
        let paper = try await Library.addItem(ctx, Paths.join(home, "paper.pdf"))
        let note = try Documents.createNote(ctx, try Projects.create(ctx, "Other").id, name: "Elsewhere", text: "x")
        let made = try Onboarding.startProject(ctx, .init(name: "Spec study", description: "How learners find what a system should do.", context: [paper.id, note.id, "not-an-id", paper.id]))
        XCTAssertEqual(made.project.directory, Paths.join(home, "spec-study"))
        XCTAssertTrue(Paths.isDirectory(made.project.directory!))
        XCTAssertEqual(made.project.description, "How learners find what a system should do.")
        let tree = try Projects.loadProject(ctx, made.project.id)
        XCTAssertEqual(tree.workspaces.map(\.name), ["Getting started"])
        XCTAssertEqual(tree.workspaces[0].context, [made.noteId!, paper.id])
        XCTAssertEqual(try Documents.readDoc(ctx, made.project.id, .workspace(workspaceId: made.workspaceId)), "How learners find what a system should do.\n")
        let again = try Onboarding.startProject(ctx, .init(name: "Second", folder: "existing", directory: "~/spec-study"))
        XCTAssertEqual(again.project.directory, made.project.directory); XCTAssertEqual(again.project.description, "")
        XCTAssertThrowsMatchingSync({ try Onboarding.startProject(ctx, .init(name: "Third", folder: "existing", directory: "~/missing")) }, "Nothing is at")
        let welcome = try Onboarding.startProject(ctx, .init(name: "Walk one", workspaceName: "Welcome"))
        XCTAssertEqual(try Projects.loadProject(ctx, welcome.project.id).workspaces[0].name, "Welcome")

        try FileManager.default.createDirectory(atPath: Paths.join(home, "loose"), withIntermediateDirectories: true)
        let loose = try await Library.addItem(ctx, Paths.join(home, "loose"))
        let released = Box(false)
        let discarded = try await Onboarding.discardItem(ctx, loose.id, release: { released.value = true })
        XCTAssertTrue(discarded); XCTAssertTrue(released.value)
        XCTAssertNil(try ctx.libraryDb.get(loose.id))
        let kept = try await Onboarding.discardItem(ctx, paper.id)
        XCTAssertFalse(kept, "in the Getting started workspace's context")
        XCTAssertNotNil(try ctx.libraryDb.get(paper.id))
    }

    func testGettingStartedAndGuidedOffer() throws {
        let made = try Projects.createProjectWithWelcome(ctx, .init(name: "Walk state"), workspaceName: "Welcome")
        XCTAssertNil(GettingStarted.read(ctx, made.project.id), "+ Project: no walkthrough")
        let started = try GettingStarted.start(ctx, made.project.id, workspaceId: made.workspaceId)
        XCTAssertEqual(started, .init(workspaceId: made.workspaceId, ticked: [], hidden: false, steps: 3))
        XCTAssertTrue(exists(Paths.join(made.project.dir, ".context", "getting-started.json")))
        XCTAssertEqual(try Projects.loadProject(ctx, made.project.id).workspaces.count, 1)
        XCTAssertEqual(try GettingStarted.set(ctx, made.project.id, tick: [3, 1, 9, 3]).ticked, [1, 3])
        try GettingStarted.set(ctx, made.project.id, untick: [3])
        XCTAssertEqual(GettingStarted.read(ctx, made.project.id)?.ticked, [1])
        XCTAssertTrue(try GettingStarted.set(ctx, made.project.id, hidden: true).hidden)
        XCTAssertTrue(try GettingStarted.set(ctx, made.project.id, tick: [2]).hidden, "hidden stays hidden")
        let bare = try Projects.create(ctx, "No walk")
        XCTAssertThrowsMatchingSync({ try GettingStarted.set(ctx, bare.id, tick: [1]) }, "no walkthrough")

        let root = tempDir("engelbart-guided-offer-")
        XCTAssertTrue(GettingStarted.guidedOfferDue(root))
        XCTAssertEqual(try GettingStarted.markGuidedOffer(root, "shown", now: Time.parse("2026-10-10T12:00:00.000Z")!), ["seen": true, "how": "shown", "at": "2026-10-10T12:00:00.000Z"])
        XCTAssertFalse(GettingStarted.guidedOfferDue(root))
        XCTAssertEqual(try GettingStarted.markGuidedOffer(root, "started")["how"], "started")
        XCTAssertEqual(try GettingStarted.markGuidedOffer(root, "anything")["how"], "dismissed")
        write(Paths.join(root, GettingStarted.offerFile), "not json")
        XCTAssertTrue(GettingStarted.guidedOfferDue(root))
    }

    func testGuidedSetupInsideAProject() throws {
        let made = try Projects.createProjectWithWelcome(ctx, .init(name: "Already here"))
        let before = try Projects.listProjects(ctx).count
        let paper = try ctx.libraryDb.insert(.init(name: "A paper", type: "pdf", tags: ["paper"], path: "/tmp/guided-paper.pdf"))
        let site = try ctx.libraryDb.insert(.init(name: "A site", type: "website", url: "https://example.org/guided"))
        let first = try Onboarding.addWelcomeWorkspace(ctx, made.project.id, context: [paper.id, made.noteId!, "not-an-id", site.id, paper.id])
        XCTAssertEqual(first.project.id, made.project.id)
        XCTAssertEqual(try Projects.listProjects(ctx).count, before)
        var tree = try Projects.loadProject(ctx, made.project.id)
        XCTAssertEqual(tree.workspaces.map(\.name), ["Getting started", "Welcome"])
        XCTAssertEqual(tree.workspaces.first { $0.id == first.workspaceId }?.context, [paper.id, site.id])
        XCTAssertEqual(tree.workspaces.first { $0.id == made.workspaceId }?.context, [made.noteId!])
        let second = try Onboarding.addWelcomeWorkspace(ctx, made.project.id)
        tree = try Projects.loadProject(ctx, made.project.id)
        XCTAssertEqual(tree.workspaces.count, 3); XCTAssertNotEqual(second.workspaceId, first.workspaceId)
        XCTAssertTrue(tree.workspaces.first { $0.id == second.workspaceId }!.name.hasPrefix("Welcome"))
        XCTAssertThrowsMatchingSync({ try Onboarding.addWelcomeWorkspace(ctx, "00000000-0000-4000-8000-000000000000") }, "Unknown project")
    }

    // MARK: folder files (MATH-22)

    func folderRow(_ dir: String, tags: [String] = []) throws -> String {
        try ctx.libraryDb.insert(.init(name: Paths.basename(dir), type: "folder", tags: tags, folderPath: dir)).id
    }

    func testFolderListing() throws {
        let dir = Paths.join(home, "papers-x")
        for f in ["b paper.pdf", "A notes.md", "data.CSV", "script.sh", "no-extension", ".hidden.pdf", ".DS_Store", ".git/config", "node_modules/x/index.md", ".secret/a.pdf", "Zeta/deep.pdf", "alpha/x.md"] { write(Paths.join(dir, f)) }
        let id = try folderRow(dir)
        let level = try FolderFiles.listFolder(ctx, id, "")
        XCTAssertFalse(level.missing)
        XCTAssertEqual(level.entries.map { "\($0.name)|\($0.dir)|\($0.type)|\($0.rel)" }, ["alpha|true|folder|alpha", "Zeta|true|folder|Zeta", "A notes.md|false|md|A notes.md", "b paper.pdf|false|pdf|b paper.pdf", "data.CSV|false|csv|data.CSV"])
        XCTAssertEqual(level.total, 5)
        XCTAssertEqual(try FolderFiles.listFolder(ctx, id, "Zeta").entries.map(\.rel), ["Zeta/deep.pdf"])
    }

    func testFolderSymlinksStayInside() throws {
        let outside = Paths.join(home, "outside-x"); write(Paths.join(outside, "private.pdf"))
        let dir = Paths.join(home, "linked-x"); write(Paths.join(dir, "real", "in.pdf"))
        let fm = FileManager.default
        try fm.createSymbolicLink(atPath: Paths.join(dir, "alias"), withDestinationPath: Paths.join(dir, "real"))
        try fm.createSymbolicLink(atPath: Paths.join(dir, "shortcut.pdf"), withDestinationPath: Paths.join(dir, "real", "in.pdf"))
        try fm.createSymbolicLink(atPath: Paths.join(dir, "escape"), withDestinationPath: outside)
        try fm.createSymbolicLink(atPath: Paths.join(dir, "escape.pdf"), withDestinationPath: Paths.join(outside, "private.pdf"))
        try fm.createSymbolicLink(atPath: Paths.join(dir, "broken.pdf"), withDestinationPath: Paths.join(dir, "nowhere.pdf"))
        let id = try folderRow(dir)
        XCTAssertEqual(try FolderFiles.listFolder(ctx, id, "").entries.map { "\($0.name) \($0.dir)" }, ["alias true", "real true", "shortcut.pdf false"])
        XCTAssertThrowsMatchingSync({ try FolderFiles.listFolder(ctx, id, "escape") }, "leaves its folder")
        XCTAssertThrowsMatchingSync({ try FolderFiles.listFolder(ctx, id, "../outside") }, "inside its folder")
        XCTAssertThrowsMatchingSync({ try FolderFiles.listFolder(ctx, id, "/etc") }, "relative")
        XCTAssertThrowsMatchingSync({ try FolderFiles.folderFile(ctx, id, "escape.pdf") }, "leaves its folder")
        XCTAssertThrowsMatchingSync({ try FolderFiles.folderFile(ctx, id, "real/../../x.pdf") }, "inside its folder")
        let shortcut = try FolderFiles.folderFile(ctx, id, "shortcut.pdf")
        XCTAssertTrue(shortcut.exists); XCTAssertEqual(shortcut.path, Paths.join(dir, "real", "in.pdf"))
        XCTAssertEqual(FolderFiles.folderFiles(ctx, [(id, "escape.pdf"), (id, "alias/in.pdf"), ("nope", "x")]), [
            .init(folderId: id, rel: "escape.pdf", exists: false, dir: false), .init(folderId: id, rel: "alias/in.pdf", exists: true, dir: false), .init(folderId: "nope", rel: "x", exists: false, dir: false),
        ])
    }

    func testFolderGoneAndLarge() throws {
        let dir = Paths.join(home, "moving-x"); write(Paths.join(dir, "Smith (2024) #1 é.pdf"))
        let id = try folderRow(dir)
        let found = try FolderFiles.folderFile(ctx, id, "Smith (2024) #1 é.pdf")
        XCTAssertTrue(found.exists); XCTAssertFalse(found.dir); XCTAssertEqual(found.type, "pdf"); XCTAssertEqual(found.folder, "moving-x")
        try FileManager.default.moveItem(atPath: Paths.join(dir, "Smith (2024) #1 é.pdf"), toPath: Paths.join(dir, "renamed.pdf"))
        XCTAssertFalse(try FolderFiles.folderFile(ctx, id, "Smith (2024) #1 é.pdf").exists)
        XCTAssertEqual(try FolderFiles.listFolder(ctx, id, "no such level"), .init(id: id, name: "moving-x", rel: "no such level", missing: true, entries: [], total: 0))
        try FileManager.default.removeItem(atPath: dir)
        XCTAssertTrue(try FolderFiles.listFolder(ctx, id, "").missing)
        XCTAssertFalse(try FolderFiles.folderFile(ctx, id, "renamed.pdf").exists)
        XCTAssertTrue(try FolderFiles.listFolder(ctx, try folderRow(tempDir("not-home-")), "").missing)
        let notFolder = try ctx.libraryDb.insert(.init(name: "A paper", type: "pdf", path: Paths.join(home, "a.pdf"))).id
        XCTAssertThrowsMatchingSync({ try FolderFiles.listFolder(ctx, notFolder, "") }, "not a folder")
        XCTAssertThrowsMatchingSync({ try FolderFiles.listFolder(ctx, "bad id!", "") }, "invalid")
        let repo = Paths.join(home, "repo-x")
        write(Paths.join(repo, ".git", "HEAD")); write(Paths.join(repo, "docs", "guide.md"))
        for i in 0..<(FolderFiles.maxEntries + 5) { write(Paths.join(repo, "many", String(format: "f%04d.md", i))) }
        let rid = try folderRow(repo, tags: ["git"])
        XCTAssertEqual(try FolderFiles.listFolder(ctx, rid, "").entries.map(\.name), ["docs", "many"])
        let many = try FolderFiles.listFolder(ctx, rid, "many")
        XCTAssertEqual(many.entries.count, FolderFiles.maxEntries); XCTAssertEqual(many.total, FolderFiles.maxEntries + 5)
        XCTAssertTrue(try FolderFiles.fileInRow(LibraryRow(id: rid, name: "repo", type: "folder", folderPath: repo), "docs/guide.md", homeDir: home).exists)
    }

    // MARK: web pdfs

    let PDF = Data("%PDF-1.7 saved".utf8)
    func page(_ name: String, _ url: String, _ tags: [String] = []) -> NewLibraryRow { .init(name: name, type: "website", tags: tags, url: url, categorized: Library.categoryRules) }

    func testCandidatesAndReadPdfResponse() async throws {
        XCTAssertEqual(WebPdfs.candidate(LibraryRow(id: "a", name: "", type: "website", url: "https://arxiv.org/abs/2310.05292", tags: ["paper"])), .init(id: "a", url: "https://arxiv.org/abs/2310.05292", from: "https://arxiv.org/pdf/2310.05292", sure: true))
        XCTAssertEqual(WebPdfs.candidate(LibraryRow(id: "b", name: "", type: "website", url: "https://x.org/a/B.PDF"))?.sure, true)
        XCTAssertEqual(WebPdfs.candidate(LibraryRow(id: "c", name: "", type: "website", url: "https://openreview.net/pdf?id=1"))?.sure, false)
        XCTAssertNil(WebPdfs.candidate(LibraryRow(id: "d", name: "", type: "website", url: "https://github.com/o/r", tags: ["git"])))
        XCTAssertNil(WebPdfs.candidate(LibraryRow(id: "e", name: "", type: "pdf", path: "/p.pdf", url: "https://x.org/a.pdf")))
        let bytes = try await WebPdfs.readPdfResponse(HTTPResponse(url: "u", headers: ["content-type": "application/octet-stream"], data: PDF))
        XCTAssertEqual(bytes, PDF)
        let html = try await WebPdfs.readPdfResponse(HTTPResponse(url: "u", headers: ["content-type": "text/html"], data: Data("<html>hi</html>".utf8)))
        XCTAssertNil(html)
        await XCTAssertThrowsMatching({ try await WebPdfs.readPdfResponse(HTTPResponse(status: 404, url: "u", data: Data("no".utf8))) }, "404")
        await XCTAssertThrowsMatching({ try await WebPdfs.readPdfResponse(HTTPResponse(url: "u", data: self.PDF), max: 4) }, "larger")
    }

    func testTheChecker() async throws {
        let saved = try ctx.libraryDb.insert(page("Retrieval", "https://papers.example.org/retrieval.pdf"))
        let arxiv = try ctx.libraryDb.insert(page("arXiv 1706.03762", "https://arxiv.org/abs/1706.03762", ["paper"]))
        let plain = try ctx.libraryDb.insert(page("Blog", "https://blog.example.org/post"))
        let flaky = try ctx.libraryDb.insert(page("Flaky", "https://down.example.org/x.pdf"))
        try Library.writeAnnotations(ctx, arxiv.id, ["1": []])
        let asked = Box<[String]>([])
        let pdf = PDF
        let fetchPdf: WebPdfs.FetchPdf = { url in
            asked.value.append(url)
            if url.hasPrefix("https://down.") { throw StoreError("offline") }
            return url.hasPrefix("https://blog.") ? nil : pdf
        }
        let changes = Box(0)
        let first = await WebPdfs.check(ctx, fetchPdf: fetchPdf, inspectPdf: { _ in ["paper"] }, onChange: { changes.value += 1 }).value
        XCTAssertEqual(first, .init(pending: 4, saved: 2, pages: 1, failed: 1)); XCTAssertEqual(changes.value, 2)
        XCTAssertEqual(Array(asked.value.prefix(3)).sorted(), ["https://arxiv.org/pdf/1706.03762", "https://down.example.org/x.pdf", "https://papers.example.org/retrieval.pdf"])
        for id in [saved.id, arxiv.id] {
            let row = try ctx.libraryDb.get(id)!
            XCTAssertEqual(row.type, "pdf"); XCTAssertEqual(row.path, Paths.join(layout.testRoot, "assets", "pdfs", "\(id).pdf")); XCTAssertEqual(row.tags, ["paper"])
        }
        XCTAssertEqual(try ctx.libraryDb.get(arxiv.id)?.url, "https://arxiv.org/abs/1706.03762")
        XCTAssertEqual(try Library.readAnnotations(ctx, arxiv.id), ["1": []])
        XCTAssertEqual(try ctx.libraryDb.get(plain.id)?.type, "website")
        asked.value = []
        let second = await WebPdfs.check(ctx, fetchPdf: fetchPdf).value
        XCTAssertEqual(second.pending, 1); XCTAssertEqual(asked.value, ["https://down.example.org/x.pdf"])
        for _ in 2..<WebPdfs.maxAttempts { _ = await WebPdfs.check(ctx, fetchPdf: fetchPdf).value }
        XCTAssertEqual(WebPdfs.readRecord(ctx.dataRoot)["rows"]?[flaky.id]?["attempts"], .number(Double(WebPdfs.maxAttempts)))
        asked.value = []
        let awaited222 = await WebPdfs.check(ctx, fetchPdf: fetchPdf).value.pending
        XCTAssertEqual(awaited222, 0); XCTAssertEqual(asked.value, [])
        try ctx.libraryDb.updateRepo(plain.id, name: "Blog", url: "https://blog.example.org/post.pdf", folderPath: nil, githubId: nil)
        let awaited224 = await WebPdfs.check(ctx, fetchPdf: { _ in pdf }).value.saved
        XCTAssertEqual(awaited224, 1)
    }

    func testAgainFollowsTheRunAtWork() async throws {
        let first = try ctx.libraryDb.insert(page("First", "https://slow.example.org/first.pdf"))
        let gate = Gate(), reached = Gate()
        let pdf = PDF
        let fetchPdf: WebPdfs.FetchPdf = { url in if url.contains("/first.pdf") { reached.open(); await gate.wait() }; return pdf }
        let running = WebPdfs.check(ctx, fetchPdf: fetchPdf)
        await reached.wait()
        let second = try ctx.libraryDb.insert(page("Second", "https://slow.example.org/second.pdf"))
        XCTAssertEqual(WebPdfs.check(ctx, fetchPdf: fetchPdf), running, "without again, the run at work answers")
        let again = WebPdfs.check(ctx, fetchPdf: fetchPdf, again: true)
        let third = try ctx.libraryDb.insert(page("Third", "https://slow.example.org/third.pdf"))
        XCTAssertEqual(WebPdfs.check(ctx, fetchPdf: fetchPdf, again: true), again, "one run follows, however many adds")
        gate.open()
        let awaited240 = await running.value
        XCTAssertEqual(awaited240, .init(pending: 1, saved: 1, pages: 0, failed: 0))
        let awaited241 = await again.value
        XCTAssertEqual(awaited241, .init(pending: 2, saved: 2, pages: 0, failed: 0))
        for row in [first, second, third] { XCTAssertEqual(try ctx.libraryDb.get(row.id)?.type, "pdf", row.name) }
        let awaited243 = await WebPdfs.check(ctx, fetchPdf: fetchPdf, again: true).value.pending
        XCTAssertEqual(awaited243, 0)
    }

    func testDocxIsAType() async throws {
        write(Paths.join(home, "Report.docx"), "PK")
        let row = try await Library.addItem(ctx, Paths.join(home, "Report.docx"))
        XCTAssertEqual([row.type, row.name], ["docx", "Report.docx"])
    }

    // MARK: pdf-kind

    func filler(_ n: Int) -> [String] { (0..<n).map { "Body sentence number \($0) of the text." } }
    func pdfFile(_ name: String, _ pages: [[String]], info: [String: String]? = nil) -> String {
        let file = Paths.join(home, name); writeData(file, makePdf(pages, info: info)); return file
    }

    func testPdfKind() throws {
        let none = PdfKind.Signals(arxiv: false, doi: false, abstract: false, keywords: false, references: false)
        XCTAssertFalse(PdfKind.isPaper(none))
        var s = none; s.arxiv = true; XCTAssertTrue(PdfKind.isPaper(s))
        s = none; s.abstract = true; XCTAssertFalse(PdfKind.isPaper(s)); s.references = true; XCTAssertTrue(PdfKind.isPaper(s))
        s = none; s.doi = true; s.keywords = true; XCTAssertTrue(PdfKind.isPaper(s))

        let fixture = Paths.join(Library.bundledFixtures!, "hypocompass.pdf")
        let real = try PdfKind.paperSignals(fixture)
        XCTAssertTrue(real.arxiv, "\(real)"); XCTAssertTrue(real.abstract, "\(real)")
        XCTAssertEqual(try PdfKind.inspectPdf(fixture), ["paper"])

        XCTAssertEqual(try PdfKind.inspectPdf(pdfFile("invoice.pdf", [["Invoice 1042", "Bill to: Hudson", "Total due: $40.00", "Thank you for your business."]])), [])
        XCTAssertEqual(try PdfKind.inspectPdf(pdfFile("slides.pdf", [["Context engineering", "A talk"], ["Summary", "Three points."], ["Questions?"]])), [])
        let report = pdfFile("report.pdf", [["Quarterly report", "Abstract", "We did things this quarter. They went well.", "1 Introduction"] + filler(8), filler(10)])
        XCTAssertTrue(try PdfKind.paperSignals(report).abstract); XCTAssertEqual(try PdfKind.inspectPdf(report), [])
        let late = pdfFile("late-references.pdf", [["A Study of Things", "Ada Lovelace", "Abstract", "We study things. They matter.", "1 Introduction"] + filler(6), filler(12), filler(12), filler(12), filler(3) + ["References", "[1] A. Turing. 1936. On computable numbers."], ["A Appendix"] + filler(5)])
        let signals = try PdfKind.paperSignals(late)
        XCTAssertEqual([signals.abstract, signals.references == true, signals.arxiv, signals.doi], [true, true, false, false])
        XCTAssertEqual(try PdfKind.inspectPdf(late), ["paper"])
        let published = pdfFile("published.pdf", [["A Published Thing", "Keywords: tutoring, testing"] + filler(6)], info: ["Subject": "Proc. CHI 2023. https://doi.org/10.1145/3544548.3580919"])
        XCTAssertTrue(try PdfKind.paperSignals(published).doi); XCTAssertEqual(try PdfKind.inspectPdf(published), ["paper"])
        XCTAssertEqual(try PdfKind.inspectPdf(pdfFile("printed-doi.pdf", [["Title", "https://doi.org/10.1145/3544548.3580919", "ABSTRACT", "One paragraph of it.", "CCS CONCEPTS"] + filler(3)])), ["paper"])
        let inPassing = try PdfKind.paperSignals(pdfFile("in-passing.pdf", [["Notes", "Abstract", "A short one.", "1 Introduction", "See the references in chapter 2.", "Keywords are what you search by."] + filler(4)]))
        XCTAssertEqual([inPassing.abstract, inPassing.keywords, inPassing.references == true], [true, false, false])
        XCTAssertNil(try PdfKind.paperSignals(pdfFile("nothing.pdf", [filler(5)])).references)
        write(Paths.join(home, "broken.pdf"), "not a pdf")
        XCTAssertThrowsError(try PdfKind.inspectPdf(Paths.join(home, "broken.pdf")))
    }

    // MARK: shared

    func testAddressKeyAndPreviews() {
        XCTAssertEqual(AddressKey.key("https://www.Example.org/a/?utm_source=x&id=2#top"), "example.org/a?id=2")
        XCTAssertEqual(AddressKey.key("http://example.org"), "example.org")
        XCTAssertEqual(AddressKey.key("https://example.org/?fbclid=1&ref=x"), "example.org")
        XCTAssertEqual(AddressKey.key("file:///Users/h/a.pdf#page=2"), "file:///Users/h/a.pdf")
        XCTAssertEqual(AddressKey.key("about:blank"), "")
        XCTAssertEqual(AddressKey.key("not a url"), "not a url")
        XCTAssertEqual(AddressKey.key("https://a.org:443/x"), AddressKey.key("https://a.org/x"))
        for preview in ["http://localhost:3000", "http://app.localhost", "http://[::1]:8080/", "http://0.0.0.0", "http://127.0.0.1:5173", "https://3000-abc.e2b.app/x", "https://x.e2b.dev"] {
            XCTAssertTrue(AddressKey.isPreviewAddress(preview), preview)
        }
        for not in ["https://example.org", "file:///tmp/a", "not a url", "https://localhost.example.org"] { XCTAssertFalse(AddressKey.isPreviewAddress(not), not) }
        XCTAssertTrue(GitHubLinks.isGithubSignIn("https://github.com/login/device"))
        XCTAssertTrue(GitHubLinks.isGithubSignIn("https://github.com/apps/engelbart-mathetic/installations/new"))
        XCTAssertFalse(GitHubLinks.isGithubSignIn("https://github.com/o/r"))
        XCTAssertTrue(GitHubLinks.endedGithubSession(from: "https://github.com/o/r", to: "https://github.com/login?return_to=x"))
        XCTAssertFalse(GitHubLinks.endedGithubSession(from: "https://github.com/login", to: "https://github.com/login"))
        XCTAssertEqual(Mentions.mentionedIds("@[A](lib:11111111-1111-4111-8111-111111111111) and @[b paper] and @[W](ws:x)", library: [LibraryRow(id: "r", name: "B Paper", type: "pdf")]), ["11111111-1111-4111-8111-111111111111", "r"])
        XCTAssertEqual(Archive.titleOf("\n- [ ] **Plan** @[Paper](lib:x) ![Attachment 1](img:y)\n"), "Plan Paper")
        XCTAssertEqual(Archive.titleOf("bart> answer\n"), "Untitled")
        XCTAssertEqual(Archive.stampOf(Time.parse("2026-09-25T21:03:12.000Z")!), "2026-09-25T21-03-12Z")
    }

    // MARK: archive (Clear / Restore)

    func testClearImportAndRestore() throws {
        let project = try Projects.create(ctx, "Archive")
        let w = try Workspaces.create(ctx, project.id, name: "Draft")
        let paper = try ctx.libraryDb.insert(.init(name: "Paper", type: "website", url: "https://example.org/p"))
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: w.id), "# Plan\nSee @[Paper].\nbuild> abcdef1234\n")
        let at = Time.parse("2026-09-25T21:03:12.000Z")!
        let cleared = try Archive.clearWorkspace(ctx, project.id, w.id, keep: { $0 == "build> abcdef1234" }, now: { at })
        XCTAssertEqual(cleared.text, "build> abcdef1234\n"); XCTAssertEqual(cleared.archive?.file, "2026-09-25T21-03-12Z"); XCTAssertEqual(cleared.archive?.title, "Plan")
        XCTAssertEqual(cleared.linked, [paper.id])
        let record = try Workspaces.find(ctx, project.id, w.id).workspace
        XCTAssertEqual(record.context, [paper.id]); XCTAssertEqual(record.archives.map(\.file), ["2026-09-25T21-03-12Z"]); XCTAssertEqual(record.chars, 18)
        XCTAssertEqual(json(Paths.join(record.dir, ".archive", "2026-09-25T21-03-12Z.json"))?["mentions"], [.string(paper.id)])
        XCTAssertNil(try Archive.clearWorkspace(ctx, project.id, w.id, keep: { $0 == "build> abcdef1234" }).archive, "nothing but kept lines: not archived")
        let version = try Archive.readArchive(ctx, project.id, w.id, "2026-09-25T21-03-12Z")
        XCTAssertEqual(version.text, "# Plan\nSee @[Paper].\nbuild> abcdef1234\n")
        XCTAssertThrowsMatchingSync({ try Archive.readArchive(ctx, project.id, w.id, "nope") }, "archive is invalid")
        XCTAssertThrowsMatchingSync({ try Archive.readArchive(ctx, project.id, w.id, "2020-01-01T00-00-00Z") }, "That version is gone")
        let imported = try Archive.importTask(ctx, project.id, w.id, text: "Fix the bug", buildId: "0123456789", now: { at })
        XCTAssertEqual(imported.file, "2026-09-25T21-03-12Z-2"); XCTAssertEqual(imported.title, "Imported from Task: Fix the bug")
        XCTAssertEqual(try Archive.readArchive(ctx, project.id, w.id, imported.file).text, "Imported from Task:\nFix the bug\n\nbuild> 0123456789\n")
        XCTAssertThrowsMatchingSync({ try Archive.importTask(ctx, project.id, w.id, text: "x", buildId: "nope") }, "build id is invalid")
        XCTAssertEqual(try Archive.latestArchive(ctx, project.id, w.id)?.entry.file, imported.file)
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: w.id), "new text\nbuild> abcdef1234\n")
        let restored = try Archive.restoreArchive(ctx, project.id, w.id, "2026-09-25T21-03-12Z", keep: { $0 == "build> abcdef1234" }, now: { at.addingTimeInterval(60) })
        XCTAssertEqual(restored.text, "# Plan\nSee @[Paper].\nbuild> abcdef1234\n", "the kept line is already in the chosen version")
        XCTAssertEqual(try Workspaces.find(ctx, project.id, w.id).workspace.archives.count, 3, "the current one was archived first")
    }

    // MARK: store modes (store-modes.test.cjs)

    func testStoreModes() async throws {
        let fixtures = tempDir("engelbart-modes-fixtures-")
        write(Paths.join(fixtures, "hypocompass.pdf"), "%PDF-1.4 test"); write(Paths.join(fixtures, "problems.csv"), "a,b\n")
        let events = EventHub()
        let posted = Box<[String]>([])
        events.on("engelbart:data-root-changed") { _ in posted.value.append("root") }
        let homeDir = tempDir("engelbart-modes-")
        let store = try Store(homeDir: homeDir, rootDir: nil, fixturesDir: fixtures, inspectPdf: nil, pdfTitle: nil, testModeAvailable: true, events: events, webPdfs: false)
        XCTAssertEqual(store.config()["mode"], "normal")
        let awaited355 = try await store.setTestMode(true)["mode"]
        XCTAssertEqual(awaited355, "test")
        let testCtx = try await store.context()
        XCTAssertEqual(testCtx.dataRoot, store.layout.testRoot)
        XCTAssertEqual(try testCtx.libraryDb.list().count, 4, "the test library is seeded")
        let made = try Projects.createProjectWithWelcome(testCtx, .init(name: "Scratch"))
        XCTAssertTrue(exists(Paths.join(store.layout.testRoot, "scratch", "Welcome!.md")))
        let off = try await store.setTestMode(false)
        XCTAssertEqual(off["mode"], "normal"); XCTAssertEqual(off["dataRoot"]?.string, store.layout.root)
        let normalCtx = try await store.context()
        XCTAssertEqual(try normalCtx.libraryDb.list().count, 0)
        XCTAssertEqual(try Projects.listProjects(normalCtx).count, 0)
        let real = try Projects.createProject(normalCtx, .init(name: "Real work", path: "real"))
        XCTAssertTrue(exists(Paths.join(store.layout.root, "library.sqlite")))
        XCTAssertEqual(real.slug, "real")
        await XCTAssertThrowsMatching({ try await store.resetTestData() }, "Test mode is off")
        _ = try await store.setTestMode(true)
        let awaited371 = try Projects.listProjects(try await store.context()).first?.id
        XCTAssertEqual(awaited371, made.project.id)
        _ = try await store.resetTestData()
        XCTAssertFalse(exists(Paths.join(store.layout.testRoot, "scratch")))
        let fresh = try await store.context()
        XCTAssertEqual(try Projects.listProjects(fresh).count, 0); XCTAssertEqual(try fresh.libraryDb.list().count, 4)
        _ = try Projects.create(fresh, "Left over")
        _ = try await store.resetTestData(fresh: true)
        let empty = try await store.context()
        XCTAssertEqual(try empty.libraryDb.list().count, 0, "no sample library for a new user")
        _ = try await store.resetTestData()
        let awaited381 = try await store.context().libraryDb.list().count
        XCTAssertEqual(awaited381, 4)
        XCTAssertTrue(exists(Paths.join(store.layout.root, "real", "project.json")))
        store.close()

        let shipped = try Store(homeDir: tempDir("engelbart-shipped-"), rootDir: nil, fixturesDir: fixtures, inspectPdf: nil, pdfTitle: nil, testModeAvailable: false, events: events, webPdfs: false)
        let ctx2 = try await shipped.context()
        XCTAssertEqual(ctx2.dataRoot, shipped.layout.root); XCTAssertEqual(try ctx2.libraryDb.list().count, 0)
        XCTAssertFalse(exists(shipped.layout.testRoot))
        await XCTAssertThrowsMatching({ try await shipped.setTestMode(false) }, "only in developer builds")
        await XCTAssertThrowsMatching({ try await shipped.resetTestData() }, "only in developer builds")
        XCTAssertEqual(shipped.config()["testModeAvailable"], false)
        shipped.close()
    }

    func testStoreEventsAndRevisions() async throws {
        let events = EventHub()
        let seen = Box<[String]>([])
        for name in ["engelbart:project-changed", "engelbart:library-changed", "doc:changed", "engelbart:nav", "engelbart:starred", "engelbart:folders"] {
            events.on(name) { payload in seen.value.append(name + (payload["revision"].map { " \($0.int ?? 0)" } ?? "")) }
        }
        let store = try Store(homeDir: tempDir("engelbart-events-"), rootDir: nil, fixturesDir: nil, inspectPdf: nil, pdfTitle: nil, hooks: { var h = StoreHooks(); h.describe = nil; h.identifyRepo = nil; h.listRemoteFiles = nil; h.fetchPdf = nil; return h }(), events: events, webPdfs: false)
        let project = try await store.createProject(.init(name: "Events"))
        let w = try await store.createWorkspace(project.id, name: "W")
        let first = try await store.writeDoc(project.id, .workspace(workspaceId: w.id), "one")
        let same = try await store.writeDoc(project.id, .workspace(workspaceId: w.id), "one")
        let second = try await store.writeDoc(project.id, .workspace(workspaceId: w.id), "two")
        XCTAssertEqual([first.revision, same.revision, second.revision], [1, 1, 2]); XCTAssertNil(same.lastEdited)
        let row = try await store.addLibraryItem("https://example.org/page")
        await XCTAssertThrowsMatching({ try await store.addLibraryItem("https://example.org/page") }, "Already in the library")
        try await store.setStarred(project.id, row.row.id, true)
        _ = try await store.createFolder("Refs")
        try await Task.sleep(nanoseconds: 100_000_000) // posts from background threads land on the main queue
        for name in ["engelbart:project-changed", "engelbart:nav", "doc:changed 1", "doc:changed 2", "engelbart:library-changed", "engelbart:starred", "engelbart:folders"] {
            XCTAssertTrue(seen.value.contains(name), name)
        }
        XCTAssertEqual(seen.value.filter { $0.hasPrefix("doc:changed") }.count, 2, "a save that changes nothing posts nothing")
        store.close()
    }
}

extension MiscTests {
    func testStoreHandlersOffersPickerAndRenames() async throws {
        let told = Box(0)
        var hooks = StoreHooks(); hooks.describe = nil; hooks.identifyRepo = nil; hooks.listRemoteFiles = nil; hooks.fetchPdf = nil
        hooks.pdfAdded = { told.value += 1 }
        let homeDir = tempDir("engelbart-handlers-")
        let store = try Store(homeDir: homeDir, rootDir: nil, fixturesDir: nil, inspectPdf: nil, pdfTitle: nil, hooks: hooks, events: EventHub(), webPdfs: false)
        let offer = try await store.connectOffer()
        XCTAssertTrue(offer)
        try await store.connectOfferSeen("started")
        let after = try await store.connectOffer()
        XCTAssertFalse(after)
        XCTAssertEqual(json(Paths.join(store.dataRoot, ".connect", "offer.json"))?["how"], "started")
        setenv("ENGELBART_PICK_PATHS", "[\"/a.pdf\",\"/b\"]", 1)
        let picked = await store.pickLibraryPaths("pdf")
        XCTAssertEqual(picked, ["/a.pdf", "/b"])
        unsetenv("ENGELBART_PICK_PATHS")
        let pdf = try await store.addLibraryPdf("https://papers.example.org/x.pdf", bytes: Data("%PDF-1.7 x".utf8), name: "X")
        XCTAssertEqual(pdf.type, "pdf"); XCTAssertEqual(told.value, 1)
        let project = try await store.createProject(.init(name: "Renames"))
        let note = try await store.createNote(project.id, name: "Old name")
        let renamed = try await store.renameLibraryItem(note.id, "New name")
        XCTAssertEqual(renamed?.name, "New name")
        XCTAssertTrue(exists(Paths.join(project.dir, "New name.md")), "a note is renamed as a note: its file follows")
        let page = try await store.renameLibraryItem(pdf.id, "Renamed pdf")
        XCTAssertEqual(page?.name, "Renamed pdf")
        let memory = try await store.connectMemory()
        XCTAssertEqual(memory["exists"], false)
        await XCTAssertThrowsMatching({ try await store.addLibraryPage("tab-1", "https://example.org/p") }, "Pages cannot be saved here")
        await XCTAssertThrowsMatching({ try await store.addToProject(project.id, (0..<201).map { _ in uuid() }) }, "At most 200")
        store.close()
    }
}

/// A one-shot latch for async tests.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func open() { let w: [CheckedContinuation<Void, Never>] = lock.withLock { opened = true; let w = waiters; waiters = []; return w }; w.forEach { $0.resume() } }
    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let now: Bool = lock.withLock { if opened { return true }; waiters.append(c); return false }
            if now { c.resume() }
        }
    }
}
