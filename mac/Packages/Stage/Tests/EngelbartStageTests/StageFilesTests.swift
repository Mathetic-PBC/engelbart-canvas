import XCTest
@testable import EngelbartStage

// test/stage-files.test.cjs, test/stage-links.test.cjs, test/window-open.test.cjs, ported.

final class StageFilesTests: XCTestCase {
    var dir: URL!
    var cacheDir: URL { dir.appendingPathComponent(".cache/stage") }
    static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-stage-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    @discardableResult func at(_ name: String, _ content: Data) -> String {
        let file = dir.appendingPathComponent(name).path
        FileManager.default.createFile(atPath: file, contents: content)
        return file
    }
    @nonobjc func at(_ name: String, _ text: String) -> String { at(name, Data(text.utf8)) }

    func testByFormat() async throws {
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub"), withIntermediateDirectories: true)
        let folder = try await StageFiles.readStageFile(dir.appendingPathComponent("sub").path, cacheDir: cacheDir)
        XCTAssertEqual(folder, StageFile(kind: .folder, path: dir.appendingPathComponent("sub").path, name: "sub"))
        let pdf = try await StageFiles.readStageFile(at("Paper.pdf", "%PDF-1.4 x"), cacheDir: cacheDir)
        XCTAssertEqual(pdf.kind, .pdf); XCTAssertEqual(pdf.name, "Paper"); XCTAssertEqual(pdf.bytes, Data("%PDF-1.4 x".utf8))
        XCTAssertEqual(URL(string: pdf.url!)?.path, dir.appendingPathComponent("Paper.pdf").path)
        let page = try await StageFiles.readStageFile(at("r.html", "<p>x"), cacheDir: cacheDir)
        XCTAssertEqual(page.kind, .page); XCTAssertEqual(URL(string: page.url!)?.path, dir.appendingPathComponent("r.html").path)
        let md = try await StageFiles.readStageFile(at("a.md", "# A"), cacheDir: cacheDir)
        XCTAssertEqual(md, StageFile(kind: .md, path: dir.appendingPathComponent("a.md").path, name: "a.md", text: "# A", truncated: false))
        let csv = try await StageFiles.readStageFile(at("t.csv", "a,b"), cacheDir: cacheDir)
        XCTAssertEqual(csv.delimiter, ",")
        let tsv = try await StageFiles.readStageFile(at("t.tsv", "a\tb"), cacheDir: cacheDir)
        XCTAssertEqual(tsv.delimiter, "\t")
        let png = try await StageFiles.readStageFile(at("p.png", Self.png), cacheDir: cacheDir)
        XCTAssertEqual(png.mime, "image/png"); XCTAssertEqual(png.bytes?.count, Self.png.count)
        let json = try await StageFiles.readStageFile(at("d.json", "{\"a\":1}"), cacheDir: cacheDir)
        XCTAssertEqual([json.kind.rawValue, json.ext, json.text], ["text", "json", "{\"a\":1}"])
        let blob = try await StageFiles.readStageFile(at("b.bin", Data([1, 0, 2])), cacheDir: cacheDir)
        XCTAssertEqual([blob.kind.rawValue, blob.ext], ["unsupported", "bin"])
    }

    func testLongTextAndMissing() async throws {
        let long = try await StageFiles.readStageFile(at("long.txt", String(repeating: "x", count: 500_001)), cacheDir: cacheDir)
        XCTAssertEqual(long.text?.count, 500_000); XCTAssertTrue(long.truncated)
        do { _ = try await StageFiles.readStageFile(dir.appendingPathComponent("nothing.md").path, cacheDir: cacheDir); XCTFail() }
        catch { XCTAssertEqual(error.localizedDescription, "Nothing is at that path") }
    }

    func testReadFailure() async throws {
        XCTAssertEqual(StageFiles.readFailure(code: ENOENT, message: "x").message, "Nothing is at that path")
        XCTAssertEqual(StageFiles.readFailure(code: EPERM, message: "x").message, StageFiles.blocked)
        XCTAssertEqual(StageFiles.readFailure(code: EACCES, message: "x").message, StageFiles.blocked)
        XCTAssertEqual(StageFiles.readFailure(code: ENOTDIR, message: "Not a directory").message, "Not a directory")
        XCTAssertEqual(StageFiles.blocked, "macOS blocked Engelbart from reading this file. Allow access in System Settings → Privacy & Security → Files and Folders.")
        if getuid() != 0 {
            let shut = at("shut.md", "x")
            chmod(shut, 0)
            defer { chmod(shut, 0o600) }
            do { _ = try await StageFiles.readStageFile(shut, cacheDir: cacheDir); XCTFail() } catch { XCTAssertEqual(error.localizedDescription, StageFiles.blocked) }
        }
    }

    func testConversionsOncePerVersion() async throws {
        var calls: [String] = []
        let runTool: StageFiles.RunTool = { tool, args in
            calls.append((tool as NSString).lastPathComponent)
            let out = tool.hasSuffix("textutil") ? args[3] : args[args.count - 1]
            FileManager.default.createFile(atPath: out, contents: tool.hasSuffix("textutil") ? Data("<p>hi</p>".utf8) : Self.png)
        }
        let docx = at("w.docx", "not really")
        let first = try await StageFiles.readStageFile(docx, cacheDir: cacheDir, runTool: runTool)
        XCTAssertEqual(first.kind, .doc); XCTAssertEqual(first.path, docx)
        XCTAssertTrue(URL(string: first.url!)!.path.hasPrefix(cacheDir.path))
        _ = try await StageFiles.readStageFile(docx, cacheDir: cacheDir, runTool: runTool)
        XCTAssertEqual(calls, ["textutil"])
        let heic = try await StageFiles.readStageFile(at("i.heic", "x"), cacheDir: cacheDir, runTool: runTool)
        XCTAssertEqual([heic.kind.rawValue, heic.mime, heic.path], ["image", "image/jpeg", dir.appendingPathComponent("i.heic").path])
        do { _ = try await StageFiles.readStageFile(at("bad.rtf", "x"), cacheDir: cacheDir) { _, _ in throw StageFiles.Failure("no") }; XCTFail() }
        catch { XCTAssertEqual(error.localizedDescription, "no") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cacheDir.path).filter { $0.contains(".tmp") }.count, 0)
    }

    func testRealTextutil() async throws {
        let rtf = at("real.rtf", "{\\rtf1\\ansi Hello {\\b world}}")
        let doc = try await StageFiles.readStageFile(rtf, cacheDir: cacheDir)
        XCTAssertEqual(doc.kind, .doc)
        let html = try String(contentsOf: URL(string: doc.url!)!, encoding: .utf8)
        XCTAssertTrue(html.contains("world"))
    }
}

final class StageLinksTests: XCTestCase {
    func setup(delivered: Bool = true) -> (StageLinks, () -> [[String: Any]], () -> [String]) {
        var sent: [[String: Any]] = [], opened: [String] = []
        let links = StageLinks(send: { channel, payload in var p = payload; p["channel"] = channel; sent.append(p); return delivered }, openExternal: { opened.append($0) })
        return (links, { sent }, { opened })
    }

    func testListeningStageTakesLinks() {
        let (links, sent, opened) = setup()
        links.listen(true)
        links.windowOpen("https://github.com/mqo00/rope")
        links.windowOpen("http://example.org/a")
        XCTAssertEqual(sent().map { $0["url"] as? String }, ["https://github.com/mqo00/rope", "http://example.org/a"])
        XCTAssertEqual(sent().map { $0["newTab"] as? Bool }, [true, true])
        XCTAssertEqual(sent().map { $0["channel"] as? String }, ["stage:open-link", "stage:open-link"])
        XCTAssertEqual(opened(), [])
    }

    func testNoStageDefaultBrowserAndCounts() {
        let (links, sent, opened) = setup()
        links.windowOpen("https://example.org/a")
        XCTAssertEqual(opened(), ["https://example.org/a"]); XCTAssertTrue(sent().isEmpty)
        links.listen(true); links.listen(true); links.listen(false)
        XCTAssertTrue(links.listening)
        links.listen(false); links.listen(false)
        XCTAssertFalse(links.listening)
        links.listen(true); links.reset()
        links.windowOpen("https://example.org/b")
        XCTAssertEqual(opened().last, "https://example.org/b")
        let (undelivered, sent2, opened2) = setup(delivered: false)
        undelivered.listen(true)
        undelivered.windowOpen("https://example.org/c")
        XCTAssertEqual(sent2().count, 1); XCTAssertEqual(opened2(), ["https://example.org/c"])
    }

    func testGithubSignInAndOtherSchemes() {
        let (links, sent, opened) = setup()
        links.listen(true)
        links.windowOpen("https://github.com/login/oauth/authorize?client_id=x")
        links.windowOpen("https://github.com/apps/engelbart/installations/new")
        XCTAssertTrue(sent().isEmpty)
        XCTAssertEqual(opened(), ["https://github.com/login/oauth/authorize?client_id=x", "https://github.com/apps/engelbart/installations/new"])
        for url in ["file:///etc/passwd", "javascript:alert(1)", "slack://open", "mailto:a@b.c", ""] { links.windowOpen(url) }
        XCTAssertEqual(opened().count, 2)
    }

    func testWindowOpenRoute() {
        XCTAssertEqual(StageLinks.windowOpenRoute("https://example.org", stage: true), .stage("https://example.org/"))
        XCTAssertEqual(StageLinks.windowOpenRoute("https://example.org", stage: false), .external("https://example.org/"))
        XCTAssertEqual(StageLinks.windowOpenRoute("https://github.com/login", stage: true), .external("https://github.com/login"))
        XCTAssertNil(StageLinks.windowOpenRoute("file:///x", stage: true))
        XCTAssertNil(StageLinks.windowOpenRoute("javascript:1", stage: false))
    }
}
