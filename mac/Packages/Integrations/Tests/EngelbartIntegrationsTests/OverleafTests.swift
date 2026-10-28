import Foundation
import JavaScriptCore
import XCTest
import zlib
import EngelbartCore
@testable import EngelbartIntegrations

// test/overleaf.test.cjs: the script read against a fake Overleaf page (a fake CodeMirror 6 view behind .cm-content, a
// file tree) in JavaScriptCore, the zip copy from a fake overleaf.com on loopback, and the <stage source="overleaf"> block.

private let ID = "5f3c2a1b9d8e7f6a5b4c3d2e"
private let OTHER = "65a1b2c3d4e5f60718293a4b"
private let EDITOR_URL = "https://www.overleaf.com/project/\(ID)"
private let PAPER = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nWe study tutors.\n\\input{sections/method}\n\\end{document}\n"
private let TYPED = "Tutors notice struggle before students ask."
private let LIVE = PAPER.replacingOccurrences(of: "We study tutors.", with: "We study tutors. \(TYPED)")

/// The fake page of the Electron test, in JavaScript: cmDoc, cmView, node, overleafPage.
private let FAKE_PAGE = #"""
function cmDoc(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return { length: text.length, lines: starts.length, toString: () => text, sliceString: (from, to = text.length) => text.slice(from, to),
    lineAt(pos) { let n = 0; while (n + 1 < starts.length && starts[n + 1] <= pos) n += 1; return { number: n + 1, from: starts[n] }; } };
}
function cmView(text, { anchor = 0, head = anchor, focus = false } = {}) {
  return { state: { doc: cmDoc(text), selection: { main: { from: Math.min(anchor, head), to: Math.max(anchor, head), head } } },
    hasFocus: focus, dom: { offsetParent: {} }, dispatched: [], dispatch(spec) { this.dispatched.push(spec); } };
}
function node({ attrs = {}, cls = [], parent = null, text = '', props = {} } = {}) {
  const el = { parentElement: parent, textContent: text, getAttribute: (name) => (name in attrs ? attrs[name] : null), querySelector: () => null,
    closest(selector) { for (let at = el; at; at = at.parentElement) {
      if (selector === '.cm-editor' && at.cls.includes('cm-editor')) return at;
      if (selector === '[role="treeitem"]' && at.getAttribute('role') === 'treeitem') return at; } return null; }, cls };
  return Object.assign(el, props);
}
function overleafPage({ view, file = 'main.tex', projectName = 'My Paper', tile = false } = {}) {
  const editor = node({ cls: ['cm-editor'] });
  const content = node({ cls: ['cm-content'], parent: editor, props: view ? (tile ? { cmTile: { root: { view } } } : { cmView: { rootView: { view } } }) : {} });
  let selected = null;
  if (file) { const tree = node({ attrs: { role: 'tree' } }); let parent = tree;
    for (const part of file.split('/')) parent = node({ attrs: { role: 'treeitem', 'aria-label': part }, parent: node({ attrs: { role: 'group' }, parent }) });
    selected = parent; }
  const meta = projectName ? node({ attrs: { name: 'ol-projectName', content: projectName } }) : null;
  return { title: `${projectName || 'Untitled'} - Overleaf, Online LaTeX Editor`,
    querySelectorAll: (selector) => (selector === '.cm-content' ? [content] : []),
    querySelector: (selector) => {
      if (selector === '[role="tree"] [role="treeitem"][aria-selected="true"]') return selected;
      if (selector === 'meta[name="ol-projectName"]') return meta;
      return null; } };
}
"""#

/// The script run on a page made by `setup` (JavaScript that sets `document` and `view`) → its answer as JSON.
private func runScript(_ setup: String) -> JSONValue? {
    let context = JSContext()!
    context.evaluateScript(FAKE_PAGE)
    context.evaluateScript(setup)
    let out = context.evaluateScript("JSON.stringify(\(OverleafEditor.readScript))")
    if let exception = context.exception { XCTFail("JS: \(exception)") }
    return out?.toString().flatMap { try? JSONValue.parse($0) }
}

private func jsString(_ s: String) -> String { JSONValue.string(s).text() }

private func page(_ text: String?, anchor: Int = 0, head: Int? = nil, file: String? = "main.tex", tile: Bool = false) -> String {
    let view = text.map { "cmView(\(jsString($0)), { anchor: \(anchor), head: \(head ?? anchor) })" } ?? "null"
    return "var view = \(view); var document = overleafPage({ view, file: \(file.map(jsString) ?? "''"), tile: \(tile) });"
}

private func utf16Index(_ s: String, of part: String) -> Int { (s as NSString).range(of: part).location }

/// A zip of `entries`, deflated, as Overleaf's download is.
func zipOf(_ entries: [(String, Data)]) -> Data {
    var locals = Data(), centrals = Data()
    var offset = 0
    func le16(_ v: Int) -> Data { Data([UInt8(v & 0xff), UInt8((v >> 8) & 0xff)]) }
    func le32(_ v: UInt32) -> Data { Data([UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]) }
    for (name, raw) in entries {
        let nameBuf = Data(name.utf8)
        let body = deflateRaw(raw)
        let crc = raw.withUnsafeBytes { UInt32(crc32(0, $0.bindMemory(to: Bytef.self).baseAddress, uInt(raw.count))) }
        var local = le32(0x04034b50) + le16(20) + le16(0x800) + le16(8) + le16(0) + le16(0)
        local += le32(crc) + le32(UInt32(body.count)) + le32(UInt32(raw.count)) + le16(nameBuf.count) + le16(0)
        var central = le32(0x02014b50) + le16(20) + le16(20) + le16(0x800) + le16(8) + le16(0) + le16(0)
        central += le32(crc) + le32(UInt32(body.count)) + le32(UInt32(raw.count)) + le16(nameBuf.count) + le16(0) + le16(0) + le16(0) + le16(0) + le32(0) + le32(UInt32(offset))
        locals += local + nameBuf + body
        centrals += central + nameBuf
        offset += 30 + nameBuf.count + body.count
    }
    let end = le32(0x06054b50) + le16(0) + le16(0) + le16(entries.count) + le16(entries.count) + le32(UInt32(centrals.count)) + le32(UInt32(offset)) + le16(0)
    return locals + centrals + end
}

func deflateRaw(_ data: Data) -> Data {
    var stream = z_stream()
    deflateInit2_(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
    defer { deflateEnd(&stream) }
    var input = [UInt8](data)
    var output = [UInt8](repeating: 0, count: Int(deflateBound(&stream, uLong(input.count))) + 64)
    input.withUnsafeMutableBufferPointer { src in
        output.withUnsafeMutableBufferPointer { dst in
            stream.next_in = src.baseAddress; stream.avail_in = uInt(src.count)
            stream.next_out = dst.baseAddress; stream.avail_out = uInt(dst.count)
            deflate(&stream, Z_FINISH)
        }
    }
    return Data(output.prefix(Int(stream.total_out)))
}

private let PROJECT_FILES: [(String, Data)] = [
    ("main.tex", Data(PAPER.utf8)),
    ("sections/method.tex", Data("\\section{Method}\nWe watched 480 students.\n".utf8)),
    ("refs.bib", Data("@article{chi2001, title={Learning from human tutoring}}\n".utf8)),
    ("figs/plot.png", Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
]

final class FakeOverleaf: @unchecked Sendable {
    private let lock = NSLock()
    var zips: [String: Data]
    private var _hits: [String] = []
    private var running = 0
    private(set) var most = 0
    var delayMs: UInt64 = 0
    var signedIn = true
    var server: LoopbackServer!
    var base: String { "http://127.0.0.1:\(server.port)" }
    var hits: [String] { lock.lock(); defer { lock.unlock() }; return _hits }

    init(_ zips: [String: Data]) { self.zips = zips }

    static func start(_ zips: [String: Data]) async throws -> FakeOverleaf {
        let f = FakeOverleaf(zips)
        f.server = try await LoopbackServer.start { req in
            guard let id = re("^/project/([0-9a-f]{24})/download/zip$").groups(req.target)?[1] ?? nil, let zip = f.zips[id] else { return LoopbackResponse(status: 404) }
            f.lock.lock(); f._hits.append(id); f.running += 1; f.most = max(f.most, f.running); f.lock.unlock()
            if f.delayMs > 0 { try? await Task.sleep(nanoseconds: f.delayMs * 1_000_000) }
            f.lock.lock(); f.running -= 1; f.lock.unlock()
            if !f.signedIn { return .text(200, "<!doctype html><title>Log in to Overleaf</title>", type: "text/html") }
            return LoopbackResponse(status: 200, headers: ["content-type": "application/zip"], body: zip)
        }
        return f
    }
}

@MainActor
final class OverleafTests: XCTestCase {
    func testProjectIdAndTitle() {
        XCTAssertEqual(OverleafEditor.projectId(EDITOR_URL), ID)
        XCTAssertEqual(OverleafEditor.projectId("https://overleaf.com/project/\(ID.uppercased())/?a=1#x"), ID)
        for not in ["https://www.overleaf.com/project", "https://www.overleaf.com/project/\(ID)/download/zip", "http://www.overleaf.com/project/\(ID)",
                    "https://evil.com/project/\(ID)", "https://www.overleaf.com.evil.com/project/\(ID)", "https://www.overleaf.com/project/abc", "not a url"] {
            XCTAssertEqual(OverleafEditor.projectId(not), "", not)
        }
        XCTAssertEqual(OverleafEditor.projectId(nil), "")
        XCTAssertEqual(OverleafEditor.projectTitle("My Paper - Overleaf, Online LaTeX Editor"), "My Paper")
    }

    func testScriptReadsTheWholeFileFromTheView() {
        let at = utf16Index(LIVE, of: TYPED) + TYPED.utf16.count
        for tile in [false, true] {
            let read = OverleafEditor.editorInput(runScript(page(LIVE, anchor: at, file: "chapters/intro.tex", tile: tile)))!
            XCTAssertEqual(read.text, LIVE)
            XCTAssertEqual(read.head, at)
            XCTAssertEqual(read.cursorLine, 4)
            XCTAssertEqual(read.lines, 7)
            XCTAssertEqual(read.selection, "")
            XCTAssertEqual(read.file, "chapters/intro.tex")
            XCTAssertEqual(read.projectName, "My Paper")
        }
        let from = utf16Index(LIVE, of: "\\section"), to = utf16Index(LIVE, of: "tutors.") + "tutors.".utf16.count
        let read = OverleafEditor.editorInput(runScript(page(LIVE, anchor: to, head: from)))!
        XCTAssertEqual(read.selection, "\\section{Intro}\nWe study tutors.")
        XCTAssertEqual([read.fromLine, read.toLine, read.cursorLine], [3, 4, 3])
        let none = OverleafEditor.editorInput(runScript(page(nil, file: "figs/plot.png")))
        XCTAssertEqual(none, OverleafRead(found: false, file: "figs/plot.png", projectName: "My Paper"))
        let dispatched = { () -> String? in
            let context = JSContext()!
            context.evaluateScript(FAKE_PAGE)
            context.evaluateScript(page(LIVE))
            context.evaluateScript(OverleafEditor.readScript)
            return context.evaluateScript("JSON.stringify(view.dispatched)")?.toString()
        }()
        XCTAssertEqual(dispatched, "[]", "the view is only read")
    }

    func testEditorInputRefusesWhatDoesNotAddUp() {
        let good = runScript(page(PAPER, anchor: 5))!
        XCTAssertNotNil(OverleafEditor.editorInput(good))
        for bad: JSONValue? in [nil, "x", [], ["found": true], good.with("head", .number(Double(PAPER.utf16.count + 1))), good.with("text", 7), good.with("cursorLine", 0), good.with("from", 9).with("to", 2)] {
            XCTAssertNil(OverleafEditor.editorInput(bad))
        }
        XCTAssertEqual(OverleafEditor.editorInput(good.with("file", "../../etc/passwd"))?.file, "")
        XCTAssertEqual(OverleafEditor.editorInput(good.with("file", "/main.tex"))?.file, "main.tex")
    }

    func testPageThatNeverAnswersGivenUpAfter500ms() async {
        XCTAssertEqual(OverleafEditor.readTimeoutMs, 500)
        let started = Date()
        let got = await OverleafEditor.readEditor({ _ in try await Task.sleep(nanoseconds: 60_000_000_000); return nil })
        let took = Date().timeIntervalSince(started) * 1000
        XCTAssertEqual(got, .failed("timeout"))
        XCTAssertTrue(took >= 480 && took < 1500, "\(took)")
        let error = await OverleafEditor.readEditor({ _ in throw OverleafZipError(message: "boom") })
        XCTAssertEqual(error, .failed("error"))
        let none = await OverleafEditor.readEditor(nil)
        XCTAssertEqual(none, .failed("error"))
        let junk = await OverleafEditor.readEditor({ _ in "junk" })
        XCTAssertEqual(junk, .failed("unreadable"))
    }

    func testCopyUnpackedRefreshedAfter60sNeverTwoDownloads() async throws {
        XCTAssertEqual(OverleafCopy.maxAgeMs, 60_000)
        let fake = try await FakeOverleaf.start([ID: zipOf(PROJECT_FILES)])
        defer { fake.server.closeAll() }
        let root = tempDir("copy")
        let clock = FakeClock(1_000_000)
        let copies = OverleafCopies(http: URLSessionHTTPClient(), now: { clock.now }, base: fake.base)
        fake.delayMs = 150
        async let a = copies.ensure(root, ID)
        async let b = copies.ensure(root, ID)
        async let c = copies.ensure(root, ID)
        let all = await [a, b, c]
        XCTAssertEqual(fake.hits, [ID])
        XCTAssertEqual(fake.most, 1)
        for got in all { XCTAssertEqual(got.folder, join(root, ".overleaf", ID)) }
        XCTAssertEqual(all[0].fetchedAt, 1_000_000)
        XCTAssertEqual(FileOps.read(join(root, ".overleaf", ID, "sections", "method.tex")), "\\section{Method}\nWe watched 480 students.\n")
        XCTAssertEqual(FileManager.default.contents(atPath: join(root, ".overleaf", ID, "figs", "plot.png")), Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
        XCTAssertEqual(readJSONFile(join(root, ".overleaf", "\(ID).json"))["files"]?.int, 4)
        clock.advance(59_000)
        let same = await copies.ensure(root, ID)
        XCTAssertEqual(same.fetchedAt, 1_000_000)
        XCTAssertEqual(fake.hits.count, 1)
        clock.advance(2_000)
        async let x = copies.ensure(root, ID)
        async let y = copies.ensure(root, ID)
        let again = await [x, y]
        XCTAssertEqual(fake.hits.count, 2)
        XCTAssertEqual(fake.most, 1)
        XCTAssertEqual(again[0].fetchedAt, clock.now)
        XCTAssertFalse(copies.inFlight(root, ID))
        clock.advance(61_000)
        try "x".write(toFile: join(root, ".overleaf", ID, "stray.tex"), atomically: true, encoding: .utf8)
        _ = await copies.ensure(root, ID)
        XCTAssertFalse(FileOps.exists(join(root, ".overleaf", ID, "stray.tex")))
        XCTAssertEqual(FileOps.list(join(root, ".overleaf")).sorted(), [ID, "\(ID).json"])
    }

    func testSignedOutErrorSaidOldCopyKept() async throws {
        let fake = try await FakeOverleaf.start([ID: zipOf(PROJECT_FILES)])
        defer { fake.server.closeAll() }
        let root = tempDir("signed-out")
        let clock = FakeClock(0)
        let copies = OverleafCopies(http: URLSessionHTTPClient(), now: { clock.now }, base: fake.base)
        fake.signedIn = false
        let none = await copies.ensure(root, ID)
        XCTAssertTrue(none.error!.contains("signed in to overleaf.com"))
        XCTAssertNil(none.folder)
        fake.signedIn = true
        _ = await copies.ensure(root, ID)
        clock.advance(120_000)
        fake.signedIn = false
        let kept = await copies.ensure(root, ID)
        XCTAssertTrue(kept.error!.contains("signed in"))
        XCTAssertEqual(kept.folder, OverleafCopy.copyDir(root, ID))
        XCTAssertEqual(kept.fetchedAt, 0)
        XCTAssertTrue(FileOps.exists(join(root, ".overleaf", ID, "main.tex")))
        let before = fake.hits.count
        let bad = await copies.ensure(root, "../../etc")
        XCTAssertNotNil(bad.error)
        XCTAssertEqual(fake.hits.count, before)
    }

    func testBinaryOver20MBSkippedTextKeptUnsafeNamesNotWritten() async throws {
        XCTAssertEqual(OverleafCopy.maxBinaryBytes, 20 * 1024 * 1024)
        let big = Data(count: 21 * 1024 * 1024)
        let zip = zipOf(PROJECT_FILES + [("video/talk.mp4", big), ("data/huge.csv", Data(repeating: 0x61, count: 21 * 1024 * 1024)), ("../escape.tex", Data("no".utf8)), ("figs/", Data())])
        let listed = try OverleafCopy.readZip(zip)
        XCTAssertEqual(listed.skipped, [OverleafSkipped(path: "video/talk.mp4", bytes: big.count, why: "binary over the size limit")])
        XCTAssertEqual(listed.files.map(\.name), ["main.tex", "sections/method.tex", "refs.bib", "figs/plot.png", "data/huge.csv"])
        let fake = try await FakeOverleaf.start([ID: zip])
        defer { fake.server.closeAll() }
        let root = tempDir("binary")
        let got = await OverleafCopies(http: URLSessionHTTPClient(), base: fake.base).ensure(root, ID)
        XCTAssertEqual(got.skipped, [OverleafSkipped(path: "video/talk.mp4", bytes: big.count, why: "binary over the size limit")])
        XCTAssertFalse(FileOps.exists(join(root, ".overleaf", ID, "video")))
        XCTAssertFalse(FileOps.exists(join(root, ".overleaf", "escape.tex")) || FileOps.exists(join(root, "escape.tex")))
        XCTAssertEqual(FileOps.size(join(root, ".overleaf", ID, "data", "huge.csv")), 21 * 1024 * 1024)
        XCTAssertEqual(["a/./b.tex", "/abs.tex", "a/../../b", "C:/x", "d/"].map(OverleafCopy.safeName), ["a/b.tex", "", "", "", ""])
        XCTAssertEqual(["main.tex", ".latexmkrc", "Makefile", "fig.pdf", "x.PNG"].map(OverleafCopy.isText), [true, true, true, false, false])
    }

    func testReadZipReadsTheZipCommandsZip() async throws {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/zip") else { throw XCTSkip("no zip command") }
        let dir = tempDir("zipcmd")
        FileOps.mkdir(join(dir, "p", "sections"))
        try String(repeating: PAPER, count: 20).write(toFile: join(dir, "p", "main.tex"), atomically: true, encoding: .utf8)
        try "é ü — unicode\n".write(toFile: join(dir, "p", "sections", "a.tex"), atomically: true, encoding: .utf8)
        try "x".write(toFile: join(dir, "p", "tiny.txt"), atomically: true, encoding: .utf8)
        _ = try await ProcessRunner.check("/usr/bin/zip", ["-qr", join(dir, "out.zip"), "."], directory: URL(fileURLWithPath: join(dir, "p")))
        let files = try OverleafCopy.readZip(Data(contentsOf: URL(fileURLWithPath: join(dir, "out.zip")))).files
        var byName: [String: String] = [:]
        for f in files { byName[f.name] = String(decoding: f.data, as: UTF8.self) }
        XCTAssertEqual(byName["main.tex"], String(repeating: PAPER, count: 20))
        XCTAssertEqual(byName["sections/a.tex"], "é ü — unicode\n")
        XCTAssertEqual(byName["tiny.txt"], "x")
        XCTAssertThrowsError(try OverleafCopy.readZip(Data("<!doctype html>".utf8))) { XCTAssertTrue($0.localizedDescription.contains("did not send a zip")) }
    }

    func testOpenFileXmlMarksTheCursorLongFileWholeLines() {
        let at = utf16Index(LIVE, of: TYPED) + TYPED.utf16.count
        let read = OverleafEditor.editorInput(runScript(page(LIVE, anchor: at)))!
        let ns = LIVE as NSString
        XCTAssertEqual(OverleafStage.openFileXml(read), "<open_file path=\"main.tex\" lines=\"7\" cursor_line=\"4\">\n\(ns.substring(to: at))\(OverleafStage.cursor)\(ns.substring(from: at))\n</open_file>\n")
        let long = (1...5000).map { "line \($0) of the thesis" }.joined(separator: "\n")
        let head = utf16Index(long, of: "line 2500 ") + 4
        let cut = OverleafStage.openFileXml(OverleafEditor.editorInput(runScript(page(long, anchor: head)))!, max: 2000)
        let m = re("shown_lines=\"(\\d+)-(\\d+)\"").groups(cut)!
        let first = m[1]!, last = m[2]!
        let body = Array(cut.components(separatedBy: "\n").dropFirst().dropLast(2))
        XCTAssertEqual(body.first, "line \(first) of the thesis")
        XCTAssertEqual(body.last, "line \(last) of the thesis")
        XCTAssertTrue(Int(first)! < 2500 && Int(last)! > 2500 && Int(last)! - Int(first)! < 100, "\(first)-\(last)")
        XCTAssertTrue(body.contains("line\(OverleafStage.cursor) 2500 of the thesis"))
        XCTAssertTrue(cut.contains("cursor_line=\"2500\""))
    }

    func testStageBlockAndTabsBlock() {
        let copy = OverleafCopyInfo(projectId: ID, folder: "/data/.overleaf/\(ID)", fetchedAt: Date(timeIntervalSince1970: 1_791_374_400).timeIntervalSince1970 * 1000)
        let from = utf16Index(PAPER, of: "We study"), to = from + "We study tutors.".utf16.count
        let read = OverleafEditor.editorInput(runScript(page(PAPER, anchor: from, head: to)))!
        let ns = PAPER as NSString
        let block = OverleafStage.stageBlock(name: "My Paper", live: .read(read), copy: copy, screenshot: "/data/bart-shots/t.png")
        XCTAssertEqual(block, [
            "<stage source=\"overleaf\" project=\"My Paper\" file=\"main.tex\" folder=\"/data/.overleaf/\(ID)\" copied_at=\"\(isoString(copy.fetchedAt!))\">",
            "<open_file path=\"main.tex\" lines=\"7\" cursor_line=\"4\">",
            "\(ns.substring(to: to))\(OverleafStage.cursor)\(ns.substring(from: to))",
            "</open_file>",
            "<selection from_line=\"4\" to_line=\"4\">",
            "We study tutors.",
            "</selection>",
            "<screenshot path=\"/data/bart-shots/t.png\"/>",
            "</stage>",
        ].joined(separator: "\n"))
        let late = OverleafStage.stageBlock(name: "My Paper", live: .failed("timeout"), copy: copy)
        XCTAssertTrue(re("^<stage source=\"overleaf\" project=\"My Paper\" folder=\"/data/\\.overleaf/\(ID)\" copied_at=\"[^\"]+\" live=\"unavailable\">\\n<note>The Overleaf editor did not answer within 500 ms[^<]*Read the project from the folder").test(late), late)
        XCTAssertFalse(late.contains("<open_file"))
        XCTAssertTrue(OverleafStage.stageBlock(name: "P", live: .failed("error"), copy: OverleafCopyInfo(projectId: ID, error: "Overleaf did not send the project: is the Stage signed in to overleaf.com?")).contains("<note>There is no copy of the project on disk: Overleaf did not send the project"))
        var skipped = copy; skipped.skipped = [OverleafSkipped(path: "talk.mp4", bytes: 22_000_000, why: "binary over the size limit")]
        XCTAssertTrue(OverleafStage.stageBlock(name: "P", live: .read(read), copy: skipped).contains("<note>Not in the copy: talk.mp4 (21 MB, binary over the size limit).</note>"))
        var pending = copy; pending.pending = true
        XCTAssertTrue(OverleafStage.stageBlock(name: "P", live: .read(read), copy: pending).contains("<note>A newer copy is still downloading"))
        XCTAssertEqual(OverleafStage.tabsBlock([OverleafBackground(projectId: "x", name: "Thesis", copy: OverleafCopyInfo(projectId: "x", folder: "/d/.overleaf/x")),
                                                OverleafBackground(projectId: "y", name: "Grant", copy: OverleafCopyInfo(projectId: "y", error: "no"))]),
                       "<overleaf_tabs>\n<project name=\"Thesis\" folder=\"/d/.overleaf/x\"/>\n<project name=\"Grant\" copy=\"unavailable\"/>\n</overleaf_tabs>")
        XCTAssertEqual(OverleafStage.tabsBlock([]), "")
    }

    func testATurnFrontReadLiveCopiesOtherTabs() async throws {
        let fake = try await FakeOverleaf.start([ID: zipOf(PROJECT_FILES), OTHER: zipOf([("thesis.tex", Data("Thesis".utf8))])])
        defer { fake.server.closeAll() }
        let copies = OverleafCopies(http: URLSessionHTTPClient(), base: fake.base)
        let at = utf16Index(LIVE, of: TYPED) + TYPED.utf16.count
        let script = page(LIVE, anchor: at)
        let tabs = [OverleafTab(id: "o1", projectId: ID, title: "My Paper - Overleaf, Online LaTeX Editor"), OverleafTab(id: "o2", projectId: OTHER, title: "Thesis - Overleaf, Online LaTeX Editor"),
                    OverleafTab(id: "o3", projectId: OTHER, title: "Thesis - Overleaf")]
        let read = { (id: String) async -> OverleafLive in
            await OverleafEditor.readEditor({ code in id == "o1" ? runScript(script + "\n") : nil })
        }
        XCTAssertNil(OverleafTurn.forTurn(tabs: [], stageKind: "web", stageTab: "o1", copies: copies))
        let turn = OverleafTurn.forTurn(tabs: tabs, read: read, stageKind: "web", stageTab: "o1", copies: copies)!
        XCTAssertTrue(turn.front)
        let root = tempDir("turn")
        let got = await turn.gather(dataRoot: root)
        XCTAssertEqual(got.front?.name, "My Paper")
        XCTAssertEqual(got.front?.live.readValue?.text, LIVE)
        XCTAssertEqual(got.front?.copy?.folder, join(root, ".overleaf", ID))
        XCTAssertEqual(got.background.map(\.name), ["Thesis"])
        XCTAssertEqual(got.background[0].copy?.folder, join(root, ".overleaf", OTHER))
        let block = OverleafStage.stageBlock(name: got.front!.name, live: got.front!.live, copy: got.front!.copy)
        XCTAssertTrue(block.contains(TYPED + OverleafStage.cursor))
        XCTAssertFalse(FileOps.read(join(root, ".overleaf", ID, "main.tex"))!.contains(TYPED), "what was just typed is not in the copy yet")
        let notFront = OverleafTurn.forTurn(tabs: tabs, stageKind: "pdf", stageTab: nil, copies: copies)!
        XCTAssertFalse(notFront.front)
    }
}
