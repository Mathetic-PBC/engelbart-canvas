import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/zotero-oa.test.cjs and test/zotero-downloads.test.cjs: free copies (OpenAlex, Semantic Scholar, arXiv) against
// loopback fakes, and the Downloads folder watched for a paper downloaded in the browser.

private let NOW = parseISO("2026-10-06T12:00:00Z")!
private let DAY: Double = 24 * 60 * 60_000
private let TITLE_A = "Behavioral Context for Adaptive Tutoring at Scale"
private let DOI_A = "10.1145/3586183.3606700"
private let TITLE_B = "Learning to Learn: A Survey of Methods for Novice Programmers"
private let DOI_B = "10.1016/j.cell.2020.01.001"

final class Hits: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: [String]] = [:]
    func add(_ name: String, _ value: String) { lock.lock(); items[name, default: []].append(value); lock.unlock() }
    func of(_ name: String) -> [String] { lock.lock(); defer { lock.unlock() }; return items[name] ?? [] }
}

/// OpenAlex, Semantic Scholar, arXiv and a publisher on loopback. Answers by DOI; `base` is the publisher's address.
final class OASources: @unchecked Sendable {
    var openalex: [String: (String) -> JSONValue] = [:]
    var scholar: [String: (String) -> JSONValue] = [:]
    var scholarStatus: Int?
    var feed = "<feed></feed>"
    var arxivPdfs: [String] = []
    var hang = false
    let hits = Hits()
    var servers: [LoopbackServer] = []
    var publisher = "", openalexBase = "", scholarBase = "", arxivBase = ""

    static func make(_ configure: (OASources) -> Void = { _ in }) async throws -> OASources {
        let s = OASources()
        configure(s)
        let pub = try await LoopbackServer.start { req in
            s.hits.add("publisher", req.target)
            if req.target == "/hang" { try? await Task.sleep(nanoseconds: 5_000_000_000); return .text(200, "") }
            if req.target == "/blocked" { return .text(200, "<html><body>There was a problem providing the content you requested</body></html>", type: "text/html; charset=utf-8") }
            if req.target == "/fake.pdf" { return .text(200, "<html>Please sign in</html>", type: "application/pdf") }
            if req.target == "/paper.pdf" { return .text(200, "%PDF-1.7 the free copy", type: "application/pdf") }
            return LoopbackResponse(status: 404)
        }
        s.publisher = "http://127.0.0.1:\(pub.port)"
        let oa = try await LoopbackServer.start { req in
            s.hits.add("openalex", req.target)
            if s.hang { try? await Task.sleep(nanoseconds: 5_000_000_000); return .json(404, "{}") }
            let doi = ((re("^/works/doi:(.+)$").groups(req.path)?[1] ?? nil) ?? "").removingPercentEncoding ?? ""
            guard let work = s.openalex[doi] else { return .json(404, "{}") }
            return .json(200, work(s.publisher).text())
        }
        s.openalexBase = "http://127.0.0.1:\(oa.port)"
        let sch = try await LoopbackServer.start { req in
            s.hits.add("scholar", req.target)
            if s.hang { try? await Task.sleep(nanoseconds: 5_000_000_000); return .json(404, "{}") }
            if let status = s.scholarStatus { return .json(status, "{}") }
            let doi = ((re("^/graph/v1/paper/DOI:(.+)$").groups(req.path)?[1] ?? nil) ?? "").removingPercentEncoding ?? ""
            guard let paper = s.scholar[doi] else { return .json(404, "{}") }
            return .json(200, paper(s.publisher).text())
        }
        s.scholarBase = "http://127.0.0.1:\(sch.port)"
        let ax = try await LoopbackServer.start { req in
            s.hits.add("arxiv", req.target)
            if s.hang { try? await Task.sleep(nanoseconds: 5_000_000_000); return .text(200, "") }
            if req.target.hasPrefix("/api/query") { return .text(200, s.feed, type: "application/atom+xml") }
            if let id = re("^/pdf/(.+)$").groups(req.target)?[1] ?? nil, s.arxivPdfs.contains(id) { return .text(200, "%PDF-1.5 arXiv \(id)", type: "application/pdf") }
            return .text(200, "<html>Are you a robot?</html>", type: "text/html")
        }
        s.arxivBase = "http://127.0.0.1:\(ax.port)"
        s.servers = [pub, oa, sch, ax]
        return s
    }

    func close() { servers.forEach { $0.closeAll() } }

    @MainActor
    func finder(root: String, now: @escaping NowMs = { NOW }, timeoutMs: Double = ZoteroOA.timeoutMs, onFinding: @escaping (String, Bool) -> Void = { _, _ in }) -> ZoteroOpenAccess {
        ZoteroOpenAccess(http: URLSessionHTTPClient(), api: openalexBase, semanticScholar: scholarBase, arxivApi: arxivBase, arxiv: arxivBase,
                         root: { root }, now: now, timeoutMs: timeoutMs, onFinding: onFinding)
    }

    func sources(api: String = "http://127.0.0.1:9", storage: String) -> ZoteroSources {
        var s = ZoteroSources()
        s.api = api; s.openAlex = openalexBase; s.semanticScholar = scholarBase; s.arxivApi = arxivBase; s.arxiv = arxivBase; s.storageDir = storage
        return s
    }
}

private func work(_ best: String?, _ rest: String?...) -> (String) -> JSONValue {
    { base in
        ["best_oa_location": best.map { ["pdf_url": .string("\(base)\($0)")] } ?? .null,
         "locations": .array(rest.map { p in ["pdf_url": p.map { .string("\(base)\($0)") } ?? .null] })]
    }
}

/// A mirror as a sync leaves it (test/zotero-oa.test.cjs mirrorOf).
private func oaMirror(_ root: String, _ storage: String) {
    var raw = ZoteroViews.Raw()
    raw.items = [
        "SMITH001": ["key": "SMITH001", "itemType": "journalArticle", "title": "Learning to Learn: A Survey of Methods", "creators": [["creatorType": "author", "firstName": "Ann", "lastName": "Smith"]], "date": "2020", "DOI": "10.1016/j.cell.2020.01.001", "url": "https://www.sciencedirect.com/science/article/pii/S0092867420300015", "abstractNote": "We learn to learn.", "dateAdded": "2020-01-01"],
        "NOCOPY01": ["key": "NOCOPY01", "itemType": "journalArticle", "title": "Closed Paper", "creators": [["creatorType": "author", "lastName": "Shut"]], "date": "2019", "DOI": "https://doi.org/10.1016/closed.1", "dateAdded": "2020-01-02"],
        "LEE00001": ["key": "LEE00001", "itemType": "journalArticle", "title": "Own Copy", "creators": [["creatorType": "author", "lastName": "Lee"]], "date": "2021", "DOI": "10.1/own", "dateAdded": "2020-01-03"],
        "ATTLEE01": ["key": "ATTLEE01", "itemType": "attachment", "parentItem": "LEE00001", "linkMode": "imported_file", "contentType": "application/pdf", "filename": "lee.pdf"],
        "PAGE0001": ["key": "PAGE0001", "itemType": "webpage", "title": "A Page", "url": "https://example.org/page", "creators": [], "dateAdded": "2020-01-04"],
    ]
    FileOps.mkdir(root)
    ZoteroViews.writeViews(root, raw)
    FileOps.mkdir(join(storage, "ATTLEE01"))
    try! "%PDF own".write(toFile: join(storage, "ATTLEE01", "lee.pdf"), atomically: true, encoding: .utf8)
}

/// test/zotero-downloads.test.cjs mirrorOf: papers A and B without pdfs, one with no DOI, a web page.
private func dlMirror(_ root: String) {
    var raw = ZoteroViews.Raw()
    raw.items = [
        "PAPERA01": ["key": "PAPERA01", "itemType": "conferencePaper", "title": .string(TITLE_A), "creators": [["creatorType": "author", "firstName": "Ada", "lastName": "Barron"]], "date": "2026", "DOI": .string(DOI_A), "dateAdded": "2020-01-01"],
        "PAPERB01": ["key": "PAPERB01", "itemType": "journalArticle", "title": .string(TITLE_B), "creators": [["creatorType": "author", "firstName": "Ann", "lastName": "Smith"]], "date": "2020", "DOI": .string("https://doi.org/\(DOI_B)"), "dateAdded": "2020-01-02"],
        "NODOI001": ["key": "NODOI001", "itemType": "preprint", "title": "Attention Is All You Need", "creators": [["creatorType": "author", "lastName": "Vaswani"]], "date": "2017", "dateAdded": "2020-01-03"],
        "WEB00001": ["key": "WEB00001", "itemType": "webpage", "title": "A Page", "url": "https://example.org/page", "creators": [], "dateAdded": "2020-01-04"],
    ]
    FileOps.mkdir(root)
    ZoteroViews.writeViews(root, raw)
}

private func feed(_ entries: (String, String)...) -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed xmlns=\"http://www.w3.org/2005/Atom\">" + entries.map { "<entry><id>http://arxiv.org/abs/\($0.0)</id><title>\($0.1)</title></entry>" }.joined() + "</feed>"
}

/// A one-page PDF with the given lines of text (test/zotero-downloads.test.cjs makePdf).
func makePdf(_ lines: [String]) -> Data {
    let escape = { (t: String) in t.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "(", with: "\\(").replacingOccurrences(of: ")", with: "\\)") }
    let content = "BT\n/F1 10 Tf\n12 TL\n50 780 Td\n\(lines.map { "(\(escape($0))) Tj T*" }.joined(separator: "\n"))\nET"
    let objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                   "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
                   "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream"]
    var body = "%PDF-1.4\n"
    var offsets: [Int] = []
    for (i, o) in objects.enumerated() { offsets.append(body.utf8.count); body += "\(i + 1) 0 obj\n\(o)\nendobj\n" }
    let xref = body.utf8.count
    body += "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n" + offsets.map { String(format: "%010d 00000 n \n", $0) }.joined()
    body += "trailer\n<< /Size \(objects.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
    return Data(body.utf8)
}

@MainActor
final class ZoteroOATests: XCTestCase {
    func testHelpers() {
        XCTAssertEqual(ZoteroOA.cleanDoi("https://doi.org/10.1/ABC"), "10.1/ABC")
        XCTAssertEqual(ZoteroOA.cleanDoi("doi: 10.1000/x.y"), "10.1000/x.y")
        XCTAssertEqual(ZoteroOA.cleanDoi("not a doi"), "")
        XCTAssertEqual(ZoteroOA.pdfName(["key": "K", "title": "Learning to Learn: A Survey of Methods", "year": "2020", "creators": [["type": "author", "name": "Ann Smith", "last": "Smith"]]]), "Smith 2020 Learning to Learn.pdf")
        XCTAssertEqual(ZoteroOA.pdfName(["key": "K", "title": "a/b: c", "year": "", "creators": []]), "a b.pdf")
        XCTAssertEqual(ZoteroOA.pdfName(["key": "K0000001", "title": "", "creators": []]), "K0000001.pdf")
        XCTAssertEqual(ZoteroOA.candidates(["best_oa_location": ["pdf_url": "https://a/x.pdf"], "locations": [["pdf_url": "https://a/x.pdf"], ["pdf_url": nil], ["pdf_url": "ftp://no"], ["pdf_url": "https://b/y.pdf"]]]), ["https://a/x.pdf", "https://b/y.pdf"])
        XCTAssertTrue(ZoteroOA.closeTitle("Learning to Learn: A Survey of Methods", "Learning to learn — a survey of methods"))
        XCTAssertTrue(ZoteroOA.closeTitle("Behavioral Context for Adaptive Tutoring at Scale in Introductory Programming", "Behavioral Context for Adaptive Tutoring at Scale in Introductory Python Programming"))
        XCTAssertFalse(ZoteroOA.closeTitle("Behavioral Context for Adaptive Tutoring", "Adaptive Tutoring without Behavioral Data"))
        XCTAssertFalse(ZoteroOA.closeTitle("Deep Learning", "Deep Learning Survey"))
        XCTAssertFalse(ZoteroOA.closeTitle("", "x"))
        XCTAssertEqual(ZoteroOA.arxivId("http://arxiv.org/abs/2101.00001v3"), "2101.00001")
        XCTAssertEqual(ZoteroOA.arxivId("arXiv:cs/0112017"), "cs/0112017")
        XCTAssertEqual(ZoteroOA.arxivId("2101.00001"), "2101.00001")
        XCTAssertEqual(ZoteroOA.arxivId("../etc/passwd"), "")
        let entries = ZoteroOA.arxivEntries(feed(("2101.00001v2", "A &amp; B:\n  the Title")))
        XCTAssertEqual(entries.map { [$0.id, $0.title] }, [["2101.00001", "A & B: the Title"]])
        XCTAssertEqual(ZoteroOA.scholarCandidates(["openAccessPdf": ["url": "https://doi.org/10.1/x", "status": "BRONZE"]]), [])
        XCTAssertEqual(ZoteroOA.scholarCandidates(["openAccessPdf": ["url": "http://dx.doi.org/10.1/x"]]), [])
        XCTAssertEqual(ZoteroOA.scholarCandidates(["openAccessPdf": ["url": ""]]), [])
        XCTAssertEqual(ZoteroOA.scholarCandidates(["openAccessPdf": ["url": "https://europepmc.org/x.pdf"]]), ["https://europepmc.org/x.pdf"])
        XCTAssertEqual(ZoteroOA.scholarCandidates(nil), [])
    }

    func testFreeCopyFoundFirstRealPdfKeptAndRecorded() async throws {
        let root = join(tempDir("found"), ".zotero")
        oaMirror(root, tempDir("storage"))
        let w = try await OASources.make { $0.openalex["10.1016/j.cell.2020.01.001"] = work("/blocked", "/blocked", "/fake.pdf", "/paper.pdf") }
        defer { w.close() }
        var told: [String] = []
        let oa = w.finder(root: root, onFinding: { key, busy in told.append("\(key):\(busy)") })
        let item = ZoteroMirror.itemOf(root, "SMITH001")!
        async let a = oa.find(item)
        async let b = oa.find(item)
        let (found, again) = await (a, b)
        let file = join(root, "files", "SMITH001", "Smith 2020 Learning to Learn.pdf")
        XCTAssertEqual(found, ZoteroKeptCopy(path: file, url: "\(w.publisher)/paper.pdf", foundAt: "2026-10-06T12:00:00.000Z", source: "open access", via: "OpenAlex", from: nil))
        XCTAssertEqual(again, found)
        XCTAssertEqual(w.hits.of("openalex"), ["/works/doi:10.1016/j.cell.2020.01.001"])
        XCTAssertEqual(w.hits.of("publisher"), ["/blocked", "/fake.pdf", "/paper.pdf"])
        XCTAssertEqual(FileOps.read(file), "%PDF-1.7 the free copy")
        XCTAssertEqual(readJSONFile(join(root, "items", "SMITH001", "open-access.json")), ["v": 1, "source": "OpenAlex", "found": true, "url": .string("\(w.publisher)/paper.pdf"), "file": .string(file), "checkedAt": "2026-10-06T12:00:00.000Z"])
        XCTAssertEqual(told, ["SMITH001:true", "SMITH001:false"])
        let kept = await oa.find(item)
        XCTAssertEqual(kept, found)
        XCTAssertEqual(w.hits.of("openalex").count, 1)
        var raw = ZoteroViews.Raw(); raw.items = ["SMITH001": ["key": "SMITH001", "itemType": "journalArticle", "title": "Learning to Learn: A Survey of Methods", "creators": [], "DOI": "10.1016/j.cell.2020.01.001"]]
        ZoteroViews.writeViews(root, raw)
        XCTAssertTrue(FileOps.exists(join(root, "items", "SMITH001", "open-access.json")), "a sync keeps the record")
        FileOps.remove(file)
        XCTAssertNil(oa.kept("SMITH001"))
        let refound = await oa.find(item)
        XCTAssertEqual(refound?.path, file)
        XCTAssertEqual(w.hits.of("openalex").count, 2)
        let none = await oa.find(["key": "NODOI001", "title": "x", "creators": []])
        XCTAssertNil(none)
        XCTAssertEqual(w.hits.of("openalex").count, 2)
    }

    func testNoFreeCopyMissRememberedSevenDays() async throws {
        let root = join(tempDir("miss"), ".zotero")
        oaMirror(root, tempDir("storage"))
        let w = try await OASources.make { $0.openalex["10.1016/closed.1"] = work(nil, nil, "/blocked") }
        defer { w.close() }
        let clock = FakeClock(NOW)
        let oa = w.finder(root: root, now: { clock.now })
        let item = ZoteroMirror.itemOf(root, "NOCOPY01")!
        var got = await oa.find(item)
        XCTAssertNil(got)
        XCTAssertEqual(w.hits.of("openalex")[0], "/works/doi:10.1016/closed.1")
        XCTAssertEqual(readJSONFile(join(root, "items", "NOCOPY01", "open-access.json")), ["v": 1, "found": false, "sources": ["OpenAlex", "Semantic Scholar", "arXiv"], "checkedAt": "2026-10-06T12:00:00.000Z", "until": "2026-10-13T12:00:00.000Z"])
        XCTAssertFalse(FileOps.exists(join(root, "files", "NOCOPY01")))
        clock.advance(6 * DAY)
        got = await oa.find(item)
        XCTAssertNil(got)
        XCTAssertEqual(w.hits.of("openalex").count, 1)
        got = await w.finder(root: root, now: { clock.now }).find(item)
        XCTAssertEqual(w.hits.of("openalex").count, 1)
        clock.set(NOW + ZoteroOA.missMs + 1)
        got = await oa.find(item)
        XCTAssertEqual(w.hits.of("openalex").count, 2)
        _ = await oa.find(item.with("key", "UNKNOWN1").with("doi", "10.9/unknown"))
        XCTAssertEqual(readJSONFile(join(root, "items", "UNKNOWN1", "open-access.json"))["found"], false)
    }

    func testHangingAddressPassedOverHangingOpenAlexIsNoPdfForAnHour() async throws {
        let root = join(tempDir("timeout"), ".zotero")
        oaMirror(root, tempDir("storage"))
        let w = try await OASources.make { $0.openalex["10.1016/j.cell.2020.01.001"] = work("/hang", "/paper.pdf") }
        defer { w.close() }
        let clock = FakeClock(NOW)
        let started = Date()
        let found = await w.finder(root: root, now: { clock.now }, timeoutMs: 150).find(ZoteroMirror.itemOf(root, "SMITH001")!)
        XCTAssertEqual(found?.url, "\(w.publisher)/paper.pdf")
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        let hanging = try await OASources.make { $0.hang = true }
        defer { hanging.close() }
        let stuck = hanging.finder(root: root, now: { clock.now }, timeoutMs: 150)
        let item = ZoteroMirror.itemOf(root, "NOCOPY01")!
        var got = await stuck.find(item)
        XCTAssertNil(got)
        XCTAssertFalse(FileOps.exists(join(root, "items", "NOCOPY01", "open-access.json")))
        got = await stuck.find(item)
        XCTAssertEqual(hanging.hits.of("openalex").count, 1)
        clock.advance(61 * 60_000)
        got = await stuck.find(item)
        XCTAssertNil(got)
        XCTAssertEqual(hanging.hits.of("openalex").count, 2)
    }

    func testChipOpensPdfOrDoiPage() async throws {
        let root = join(tempDir("chip"), ".zotero")
        let storage = tempDir("storage")
        oaMirror(root, storage)
        let w = try await OASources.make { $0.openalex["10.1016/j.cell.2020.01.001"] = work("/paper.pdf") }
        defer { w.close() }
        var finding: [String] = []
        let zapi = ClosureHTTPClient { request in
            if request.url.host == "zotero.invalid" { return reply(404, [:]) }
            return try await URLSessionHTTPClient().send(request)
        }
        var sources = w.sources(storage: storage)
        sources.api = "https://zotero.invalid"
        let library = ZoteroSync(http: zapi, sources: sources, root: { root }, account: { ZoteroAccount(userID: ZUSER, key: ZKEY) }, sleep: { _ in },
                                 onFinding: { key, busy in finding.append("\(key):\(busy)") })
        let channels = ZoteroChannels(zotero: ZoteroConnection(file: { nil }), library: library)
        _ = channels
        let open = { (key: String) async -> ZoteroOpenTarget in
            let lib = library.library(ZoteroMirror.parseRef(key)!.group)!
            return await ZoteroMirror.openTarget(lib.root, ZoteroMirror.parseRef(key)!.key, storageDir: lib.storageDir, download: lib.download, openAccess: lib.openAccess)
        }
        let smith = await open("SMITH001")
        XCTAssertEqual(smith, .file(path: join(root, "files", "SMITH001", "Smith 2020 Learning to Learn.pdf"), source: "open access"))
        XCTAssertEqual(ZoteroChips.chipAction(smith), .pdf(join(root, "files", "SMITH001", "Smith 2020 Learning to Learn.pdf")))
        XCTAssertEqual(finding, ["SMITH001:true", "SMITH001:false"])
        let lee = await open("LEE00001")
        XCTAssertEqual(lee, .file(path: join(storage, "ATTLEE01", "lee.pdf"), source: "storage"))
        XCTAssertEqual(w.hits.of("openalex").count, 1)
        let closed = await open("NOCOPY01")
        XCTAssertEqual(closed, .external(url: "https://doi.org/10.1016/closed.1", waiting: false))
        XCTAssertEqual(ZoteroChips.chipAction(closed), .external("https://doi.org/10.1016/closed.1"))
        let page = await open("PAGE0001")
        XCTAssertEqual(ZoteroChips.chipAction(page), .external("https://example.org/page"))
        XCTAssertEqual(ZoteroChips.chipAction(.error("gone")), .error("gone"))
        XCTAssertEqual(ZoteroChips.chipAction(nil, name: "Paper"), .error("\"Paper\" could not be opened"))
    }

    func testSemanticScholarThenArxivByIdThenByTitle() async throws {
        let root = join(tempDir("s2"), ".zotero")
        dlMirror(root)
        let w = try await OASources.make {
            $0.openalex[DOI_A] = { base in ["best_oa_location": ["pdf_url": .string("\(base)/blocked")], "locations": []] }
            $0.scholar[DOI_A] = { base in ["paperId": "p", "openAccessPdf": ["url": .string("\(base)/paper.pdf")], "externalIds": ["DOI": .string(DOI_A)]] }
        }
        defer { w.close() }
        let oa = w.finder(root: root)
        let found = await oa.find(ZoteroMirror.itemOf(root, "PAPERA01")!)
        let file = join(root, "files", "PAPERA01", "Barron 2026 Behavioral Context for Adaptive Tutoring at Scale.pdf")
        XCTAssertEqual(found, ZoteroKeptCopy(path: file, url: "\(w.publisher)/paper.pdf", foundAt: "2026-10-06T12:00:00.000Z", source: "open access", via: "Semantic Scholar", from: nil))
        XCTAssertEqual(w.hits.of("scholar"), ["/graph/v1/paper/DOI:\(DOI_A)?fields=openAccessPdf,externalIds"])
        XCTAssertEqual(w.hits.of("publisher"), ["/blocked", "/paper.pdf"])
        XCTAssertEqual(w.hits.of("arxiv").count, 0)
        let block = await ZoteroMirror.itemBlock(root, "PAPERA01", name: TITLE_A, openAccess: { await oa.find($0) })
        XCTAssertTrue(block.lines.contains("pdf: \(file) (source=\"open access\": found through Semantic Scholar at \(w.publisher)/paper.pdf on 2026-10-06)"), block.lines.joined(separator: "\n"))

        let byId = try await OASources.make {
            $0.scholar[DOI_B] = { _ in ["openAccessPdf": ["url": .string("https://doi.org/\(DOI_B)")], "externalIds": ["ArXiv": "2001.01234", "DOI": .string(DOI_B)]] }
            $0.arxivPdfs = ["2001.01234"]
        }
        defer { byId.close() }
        let root2 = join(tempDir("arxiv-id"), ".zotero")
        dlMirror(root2)
        let viaId = await byId.finder(root: root2).find(ZoteroMirror.itemOf(root2, "PAPERB01")!)
        XCTAssertEqual(viaId?.via, "arXiv")
        XCTAssertEqual(viaId?.url, "\(byId.arxivBase)/pdf/2001.01234")
        XCTAssertEqual(byId.hits.of("arxiv"), ["/pdf/2001.01234"])

        let byTitle = try await OASources.make {
            $0.feed = feed(("2309.99999v1", "Behavioral Context Is Not Enough"), ("2309.12345v2", "Behavioral context for adaptive tutoring\n at scale"))
            $0.arxivPdfs = ["2309.12345", "2309.99999"]
        }
        defer { byTitle.close() }
        let root3 = join(tempDir("arxiv-title"), ".zotero")
        dlMirror(root3)
        let viaTitle = await byTitle.finder(root: root3).find(ZoteroMirror.itemOf(root3, "PAPERA01")!)
        XCTAssertEqual(viaTitle?.url, "\(byTitle.arxivBase)/pdf/2309.12345")
        let query = URLComponents(string: "http://x\(byTitle.hits.of("arxiv")[0])")!
        XCTAssertEqual(query.path, "/api/query")
        XCTAssertEqual(query.queryItems!.first { $0.name == "search_query" }!.value?.replacingOccurrences(of: "+", with: " "), "ti:\"behavioral context for adaptive tutoring at scale\"")
        XCTAssertEqual(byTitle.hits.of("scholar").count, 1)

        let none = try await OASources.make { $0.feed = feed(("2309.99999", "Something Else Entirely About Tutors")); $0.arxivPdfs = ["2309.99999"] }
        defer { none.close() }
        let missed = await none.finder(root: root3).find(ZoteroMirror.itemOf(root3, "PAPERB01")!)
        XCTAssertNil(missed)
        XCTAssertFalse(none.hits.of("arxiv").contains { $0.hasPrefix("/pdf/") })
        XCTAssertEqual(URLComponents(string: "http://x\(none.hits.of("arxiv")[0])")!.queryItems!.first { $0.name == "search_query" }!.value?.replacingOccurrences(of: "+", with: " "), "ti:\"learning to learn\"")
        XCTAssertEqual(readJSONFile(join(root3, "items", "PAPERB01", "open-access.json"))["found"], false)
    }

    func testArxivPageNotKeptThrottlingIsTryLaterOldMissAskedAgain() async throws {
        let root = join(tempDir("arxiv-page"), ".zotero")
        dlMirror(root)
        let w = try await OASources.make { $0.scholar[DOI_A] = { _ in ["openAccessPdf": nil, "externalIds": ["ArXiv": "2309.12345"]] } }
        defer { w.close() }
        let a = await w.finder(root: root).find(ZoteroMirror.itemOf(root, "PAPERA01")!)
        XCTAssertNil(a)
        XCTAssertFalse(FileOps.exists(join(root, "files", "PAPERA01")))
        XCTAssertEqual(readJSONFile(join(root, "items", "PAPERA01", "open-access.json"))["found"], false)
        let throttled = try await OASources.make { $0.scholarStatus = 429 }
        defer { throttled.close() }
        let b = await throttled.finder(root: root).find(ZoteroMirror.itemOf(root, "PAPERB01")!)
        XCTAssertNil(b)
        XCTAssertFalse(FileOps.exists(join(root, "items", "PAPERB01", "open-access.json")))
        XCTAssertEqual(throttled.hits.of("arxiv").count, 1)
        FileOps.mkdir(join(root, "items", "PAPERB01"))
        try "{\"v\":1,\"source\":\"OpenAlex\",\"found\":false,\"checkedAt\":\"2026-10-05T12:00:00.000Z\",\"until\":\"2026-10-12T12:00:00.000Z\"}".write(toFile: join(root, "items", "PAPERB01", "open-access.json"), atomically: true, encoding: .utf8)
        let later = try await OASources.make { $0.scholar[DOI_B] = { base in ["openAccessPdf": ["url": .string("\(base)/paper.pdf")]] } }
        defer { later.close() }
        let c = await later.finder(root: root).find(ZoteroMirror.itemOf(root, "PAPERB01")!)
        XCTAssertEqual(c?.via, "Semantic Scholar")
    }

    func testPdfMatches() {
        let a: JSONValue = ["key": "A", "doi": .string(DOI_A), "title": .string(TITLE_A)]
        XCTAssertEqual(ZoteroDownloads.pdfMatches("Proceedings\nhttps://doi.org/10.1145/3586183.\n3606700\nSomething", a), "doi")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("BEHAVIORAL CONTEXT FOR ADAPTIVE\nTUTORING AT SCALE\nAda Barron", a), "title")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("Behavioral Context for Adaptive Tutor-\ning at Scale", a), "title")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("Behavioral Context for Adaptive Tutoring\nAbstract", a), "title")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("We study tutoring at scale with adaptive methods and behavioral data in context.", a), "")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("A Different Paper Altogether\ndoi:10.1145/3586183.9999999", a), "")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("Deep Learning is everywhere", ["key": "S", "title": "Deep Learning"]), "")
        XCTAssertEqual(ZoteroDownloads.pdfMatches("anything", ["key": "S", "title": ""]), "")
        XCTAssertFalse(ZoteroDownloads.paperLike(["itemType": "webpage"]))
        XCTAssertTrue(ZoteroDownloads.paperLike(["itemType": "webpage", "doi": "10.1/x"]))
        XCTAssertTrue(ZoteroDownloads.paperLike(["itemType": "journalArticle"]))
    }

    // MARK: the Downloads watch

    private func manual(_ dir: String, _ texts: [String: String], waitMs: Double = ZoteroDownloads.waitMs) -> (ZoteroDownloadWatch, Box<[String]>, Box<[String]>) {
        let told = Box<[String]>([]), matched = Box<[String]>([])
        let watch = ZoteroDownloadWatch(dir: { dir }, onMatch: { item, file in matched.value.append("\(item["key"]!.string!) \((file as NSString).lastPathComponent)"); return true },
                                        onWaiting: { key, on in told.value.append("\(key):\(on)") },
                                        readText: { file in
                                            guard let text = texts[(file as NSString).lastPathComponent] else { throw ZoteroOA.PdfError(message: "unreadable") }
                                            return text
                                        }, waitMs: waitMs, pollMs: 60_000, watch: false)
        return (watch, told, matched)
    }

    private let A: JSONValue = ["key": "PAPERA01", "doi": .string(DOI_A), "title": .string(TITLE_A)]
    private let B: JSONValue = ["key": "PAPERB01", "doi": .string(DOI_B), "title": .string(TITLE_B)]

    func testPartialDownloadsPassedOverUntilFinished() async throws {
        let dir = tempDir("partial")
        let pdf = "%PDF-1.4 bytes"
        let (watch, _, matched) = manual(dir, ["paper.pdf": "doi \(DOI_A)", "firefox.pdf": "doi \(DOI_A)", "safari.pdf": "doi \(DOI_A)"])
        let twice = { await watch.scan().value; await watch.scan().value }
        watch.wait(A)
        try pdf.write(toFile: join(dir, "Unconfirmed 81234.crdownload"), atomically: true, encoding: .utf8)
        try pdf.write(toFile: join(dir, "paper.pdf.crdownload"), atomically: true, encoding: .utf8)
        FileOps.mkdir(join(dir, "safari.pdf.download"))
        try pdf.write(toFile: join(dir, "safari.pdf.download", "safari.pdf"), atomically: true, encoding: .utf8)
        try "".write(toFile: join(dir, "firefox.pdf"), atomically: true, encoding: .utf8)
        try pdf.write(toFile: join(dir, "firefox.pdf.part"), atomically: true, encoding: .utf8)
        await twice(); await twice()
        XCTAssertEqual(matched.value, [])
        try pdf.write(toFile: join(dir, "firefox.pdf"), atomically: true, encoding: .utf8)
        await twice()
        XCTAssertEqual(matched.value, [])
        FileOps.remove(join(dir, "firefox.pdf.part"))
        await watch.scan().value
        XCTAssertEqual(matched.value, [], "looked at once more before it is read")
        await watch.scan().value
        XCTAssertEqual(matched.value, ["PAPERA01 firefox.pdf"])
        XCTAssertEqual(watch.waiting(), [])
    }

    func testGrowingFileWaitsOldPdfNotNew() async throws {
        let dir = tempDir("growing")
        try "%PDF-1.4 old".write(toFile: join(dir, "old.pdf"), atomically: true, encoding: .utf8)
        let (watch, _, matched) = manual(dir, ["old.pdf": "doi \(DOI_A)", "new.pdf": "doi \(DOI_A)"])
        watch.wait(A)
        try "%PDF-1.4 part".write(toFile: join(dir, "new.pdf"), atomically: true, encoding: .utf8)
        await watch.scan().value
        let handle = FileHandle(forWritingAtPath: join(dir, "new.pdf"))!
        handle.seekToEndOfFile(); handle.write(Data(" more of it".utf8)); handle.closeFile()
        await watch.scan().value
        XCTAssertEqual(matched.value, [])
        await watch.scan().value
        XCTAssertEqual(matched.value, ["PAPERA01 new.pdf"])
    }

    func testTwoPapersWatchedAtOnce() async throws {
        let dir = tempDir("two")
        let (watch, told, matched) = manual(dir, ["b.pdf": "\(TITLE_B.uppercased())\nAnn Smith", "other.pdf": "An Unrelated Paper About Compilers\ndoi:10.9/other", "a.pdf": "x\n\(TITLE_A)\ny"])
        let twice = { await watch.scan().value; await watch.scan().value }
        watch.wait(A); watch.wait(B)
        XCTAssertEqual(watch.waiting().sorted(), ["PAPERA01", "PAPERB01"])
        try "%PDF-1.4 other".write(toFile: join(dir, "other.pdf"), atomically: true, encoding: .utf8)
        try "not a pdf at all".write(toFile: join(dir, "notes.pdf"), atomically: true, encoding: .utf8)
        await twice()
        XCTAssertEqual(matched.value, [])
        try "%PDF-1.4 b".write(toFile: join(dir, "b.pdf"), atomically: true, encoding: .utf8)
        await twice()
        XCTAssertEqual(matched.value, ["PAPERB01 b.pdf"])
        XCTAssertEqual(watch.waiting(), ["PAPERA01"])
        try "%PDF-1.4 a".write(toFile: join(dir, "a.pdf"), atomically: true, encoding: .utf8)
        await twice()
        XCTAssertEqual(matched.value, ["PAPERB01 b.pdf", "PAPERA01 a.pdf"])
        XCTAssertEqual(told.value, ["PAPERA01:true", "PAPERB01:true", "PAPERB01:false", "PAPERA01:false"])
    }

    func testWaitEndsAfterItsTimeAndStopAll() async throws {
        let dir = tempDir("timeout")
        let (watch, told, matched) = manual(dir, ["a.pdf": "doi \(DOI_A)"], waitMs: 600)
        watch.wait(A)
        try await Task.sleep(nanoseconds: 350_000_000)
        watch.wait(A)
        try await Task.sleep(nanoseconds: 350_000_000)
        XCTAssertEqual(watch.waiting(), ["PAPERA01"])
        await until({ watch.waiting().isEmpty }, tries: 2000)
        XCTAssertEqual(told.value, ["PAPERA01:true", "PAPERA01:false"])
        try "%PDF-1.4 a".write(toFile: join(dir, "a.pdf"), atomically: true, encoding: .utf8)
        await watch.scan().value; await watch.scan().value
        XCTAssertEqual(matched.value, [])
        let (quit, quitTold, _) = manual(tempDir("quit"), [:])
        quit.wait(A); quit.wait(B)
        quit.stopAll()
        XCTAssertEqual(quit.waiting(), [])
        XCTAssertEqual(quitTold.value.filter { $0.hasSuffix(":false") }.sorted(), ["PAPERA01:false", "PAPERB01:false"])
    }

    func testMatchingDownloadEndToEndThroughTheChannels() async throws {
        let root = join(tempDir("match"), ".zotero")
        dlMirror(root)
        let downloads = tempDir("match-downloads")
        let w = try await OASources.make()
        defer { w.close() }
        var waiting: [String] = [], downloaded: [String] = []
        let library = ZoteroSync(http: URLSessionHTTPClient(), sources: w.sources(storage: tempDir("storage")), root: { root }, account: { ZoteroAccount(userID: ZUSER, key: ZKEY) },
                                 sleep: { _ in }, now: { NOW }, downloadsDir: { downloads }, onWaiting: { k, on in waiting.append("\(k):\(on)") },
                                 onDownloaded: { k, copy in downloaded.append("\(k) \(copy.path)") }, downloadPollMs: 20)
        defer { library.stopWatching() }
        let crypt = ReversingCrypt()
        let dir = tempDir("acct")
        let account: JSONValue = ["v": 1, "userID": .string(ZUSER), "username": "r", "key": .string(try crypt.encrypt(ZKEY))]
        try account.text().write(toFile: join(dir, "zotero.json"), atomically: true, encoding: .utf8)
        let channels = ZoteroChannels(zotero: ZoteroConnection(file: { join(dir, "zotero.json") }, crypt: crypt), library: library)
        let opened = try await channels.open("PAPERA01")
        XCTAssertEqual(opened, .external(url: "https://doi.org/\(DOI_A)", waiting: true))
        XCTAssertEqual(opened.json, ["url": .string("https://doi.org/\(DOI_A)"), "external": true, "waiting": true])
        XCTAssertEqual(ZoteroChips.chipAction(opened), .external("https://doi.org/\(DOI_A)"))
        XCTAssertEqual(channels.waiting(), ["PAPERA01"])
        let web = try await channels.open("WEB00001")
        XCTAssertEqual(web, .external(url: "https://example.org/page", waiting: false))
        let download = join(downloads, "barron-2026.pdf")
        let bytes = makePdf(["Behavioral Context for Adaptive", "Tutoring at Scale", "Ada Barron", "DOI: https://doi.org/\(DOI_A)"])
        try bytes.write(to: URL(fileURLWithPath: download))
        await until({ downloaded.count == 1 }, tries: 3000)
        let file = join(root, "files", "PAPERA01", "Barron 2026 Behavioral Context for Adaptive Tutoring at Scale.pdf")
        XCTAssertEqual(downloaded, ["PAPERA01 \(file)"])
        XCTAssertEqual(waiting, ["PAPERA01:true", "PAPERA01:false"])
        XCTAssertEqual(FileManager.default.contents(atPath: file), bytes)
        XCTAssertEqual(FileManager.default.contents(atPath: download), bytes, "the download is still there")
        XCTAssertEqual(readJSONFile(join(root, "items", "PAPERA01", "open-access.json")), ["v": 1, "source": "downloaded in browser", "found": true, "from": .string(download), "file": .string(file), "checkedAt": "2026-10-06T12:00:00.000Z"])
        XCTAssertEqual(channels.waiting(), [])
        let now = try await channels.open("PAPERA01")
        XCTAssertEqual(now, .file(path: file, source: "downloaded in browser"))
        let block = await ZoteroMirror.itemBlock(root, "PAPERA01", name: TITLE_A, openAccess: { await library.openAccess($0) })
        XCTAssertTrue(block.lines.contains("attachment: none"))
        XCTAssertTrue(block.lines.contains("pdf: \(file) (source=\"downloaded in browser\": the person downloaded it in their browser on 2026-10-06, after Engelbart opened the item's page there)"))
        XCTAssertEqual(block.file, file)
        XCTAssertEqual(ZoteroOA.keptCopy(root, "PAPERA01"), ZoteroKeptCopy(path: file, url: "", foundAt: "2026-10-06T12:00:00.000Z", source: "downloaded in browser", via: "downloaded in browser", from: download))

        // A pdf dropped on a chip: "added by hand"; a file that is not a pdf is refused with words.
        let dropped = join(tempDir("drop"), "mine.pdf")
        try "%PDF-1.4 by hand".write(toFile: dropped, atomically: true, encoding: .utf8)
        let attached = try channels.attach("PAPERB01", file: dropped)
        XCTAssertEqual(attached["source"], "added by hand")
        let text = join(tempDir("drop2"), "notes.txt")
        try "hello".write(toFile: text, atomically: true, encoding: .utf8)
        XCTAssertEqual(try channels.attach("PAPERB01", file: text), ["error": "That file is not a PDF."])
        XCTAssertThrowsError(try channels.attach("PAPERB01", file: "relative.pdf"))
        XCTAssertThrowsError(try channels.attach("../x", file: dropped))
    }
}
