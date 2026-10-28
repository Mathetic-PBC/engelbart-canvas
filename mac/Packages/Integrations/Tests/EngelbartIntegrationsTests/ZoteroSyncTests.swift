import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/zotero-sync.test.cjs and test/zotero-groups.test.cjs against the in-process fake api.zotero.org.

@MainActor
final class ZoteroSyncTests: XCTestCase {
    func testFirstSyncMirrorsEverythingTrashLeftOutNothingHoldsTheKey() async throws {
        let world = FakeZoteroWorld(mine: seedLibrary())
        world.groupOrder = []
        let root = join(tempDir("first"), "zotero")
        var changes: [String] = []
        let sync = makeSync(world, root: root, onChange: { changes.append($0.state) })
        let done = await sync.sync()
        XCTAssertEqual(done.state, "synced")
        XCTAssertEqual(done.items, 5, "five top-level items, the trashed one left out")
        XCTAssertEqual(changes, ["syncing", "synced"])
        XCTAssertTrue(world.seen.allSatisfy { $0.key == ZKEY && $0.apiVersion == "3" })
        XCTAssertEqual(world.seen.filter { $0.path.hasSuffix("/items") && $0.query["itemKey"] == nil }.map { [$0.query["since"] ?? "", $0.query["includeTrashed"] ?? ""] }, [["0", "1"]])

        let items = readJSONFile(join(root, "items.json")).array!
        var by: [String: JSONValue] = [:]
        for i in items { by[i["key"]!.string!] = i }
        XCTAssertEqual(by.keys.sorted(), ["JONES001", "LEE00001", "LEE00002", "SMITH001", "WEB00001"])
        let smith = by["SMITH001"]!
        XCTAssertEqual(smith["title"], "Learning to Learn")
        XCTAssertEqual(smith["year"], "2020")
        XCTAssertEqual(smith["publication"], "Journal of Learning")
        XCTAssertEqual(smith["doi"], "10.1/abc")
        XCTAssertEqual(smith["url"], "https://example.org/smith")
        XCTAssertEqual(smith["abstractNote"], "We learn to learn.")
        XCTAssertEqual(smith["tags"], ["meta"])
        XCTAssertEqual(smith["collections"], ["COLL0001"])
        XCTAssertEqual(smith["citeKey"], "smithLearning2020")
        XCTAssertEqual(smith["creators"]!.array!.map { $0["name"]!.string! }, ["Ann Smith", "Bo Ng"])
        XCTAssertEqual(smith["attachments"], [["key": "ATTPDF01", "title": "Full Text PDF", "contentType": "application/pdf", "filename": "smith.pdf", "linkMode": "imported_file"]])
        XCTAssertEqual(by["JONES001"]!["citeKey"], "jonesField")
        XCTAssertEqual(by["JONES001"]!["publication"], "Press")
        XCTAssertEqual([by["LEE00001"]!["citeKey"]!, by["LEE00002"]!["citeKey"]!], ["lee2021graph", "lee2021grapha"])

        let collections = readJSONFile(join(root, "collections.json")).array!
        XCTAssertEqual(collections.map { [$0["key"]!.string!, $0["path"]!.string!] }, [["COLL0001", "Reading"], ["COLL0002", "Reading / Methods/Tools"]])
        let children = readJSONFile(join(root, "items", "SMITH001", "children.json"))
        XCTAssertEqual(children["notes"], [["key": "NOTE0001", "text": "Read section 3 & compare.\nSecond line"]])
        XCTAssertEqual(children["annotations"], [["key": "ANNOT001", "type": "highlight", "text": "learning is recursive", "comment": "key claim", "page": "3", "color": "#ffd400", "attachment": "ATTPDF01"]])
        XCTAssertEqual(FileOps.read(join(root, "items", "SMITH001", "fulltext-ATTPDF01.txt")), "The full text of Smith and Ng.")
        XCTAssertEqual(FileOps.read(join(root, "items", "SMITH001", "item.bib")), "@article{smithLearning2020,\n\ttitle = {Learning to Learn}\n}\n")
        XCTAssertTrue(FileOps.read(join(root, "items", "LEE00002", "item.bib"))!.hasPrefix("@article{lee2021grapha,"))
        let all = FileOps.read(join(root, "library.bib"))!
        for key in ["smithLearning2020", "jonesField", "lee2021graph", "lee2021grapha"] { XCTAssertTrue(all.contains("@article{\(key),")) }
        let batches = world.seen.filter { $0.query["itemKey"] != nil }
        XCTAssertEqual(batches.count, 1)
        XCTAssertFalse(batches[0].query["itemKey"]!.split(separator: ",").contains("ATTPDF01"))
        XCTAssertEqual(readJSONFile(join(root, "state.json"))["version"]?.int, world.mine.version)
        for file in walk(root) { XCTAssertFalse((FileOps.read(file) ?? "").contains(ZKEY), file) }
    }

    func testNextSyncAsksOnlyWhatChangedAndAppliesDeletionsAndTrash() async throws {
        let lib = seedLibrary()
        let world = FakeZoteroWorld(mine: lib)
        let root = join(tempDir("again"), "zotero")
        let sync = makeSync(world, root: root)
        await sync.sync()
        let at = lib.version
        world.clearSeen()
        lib.item(lib.items["LEE00001"]!.data.with("title", "The Graph Thing, Revised"))
        lib.remove("JONES001")
        lib.item(lib.items["WEB00001"]!.data.with("deleted", 1))
        lib.item(["key": "NEW00001", "itemType": "preprint", "title": "Fresh", "creators": [["creatorType": "author", "lastName": "Smith"]], "date": "2020", "dateAdded": "2022-01-01T00:00:00Z"])
        lib.text("ATTPDF01", "Indexed again.")
        let done = await sync.sync()
        XCTAssertEqual(done.items, 4)
        for route in ["/collections", "/items", "/deleted", "/fulltext"] {
            XCTAssertEqual(world.seen.filter { $0.path == "/users/\(ZUSER)\(route)" && $0.query["itemKey"] == nil }.map { $0.query["since"]! }, [String(at)], route)
        }
        XCTAssertEqual(world.seen.first { $0.query["itemKey"] != nil }!.query["itemKey"]!.split(separator: ",").map(String.init).sorted(), ["LEE00001", "NEW00001"])
        var by: [String: JSONValue] = [:]
        for i in readJSONFile(join(root, "items.json")).array! { by[i["key"]!.string!] = i }
        XCTAssertEqual(by["LEE00001"]!["title"], "The Graph Thing, Revised")
        XCTAssertEqual(by["LEE00001"]!["citeKey"], "lee2021graph", "its key stays")
        XCTAssertNil(by["JONES001"]); XCTAssertNil(by["WEB00001"])
        XCTAssertFalse(FileOps.exists(join(root, "items", "JONES001")) || FileOps.exists(join(root, "items", "WEB00001")))
        XCTAssertEqual(by["NEW00001"]!["citeKey"], "smith2020fresh")
        XCTAssertTrue(FileOps.read(join(root, "items", "LEE00001", "item.bib"))!.contains("Revised"))
        XCTAssertEqual(FileOps.read(join(root, "items", "SMITH001", "fulltext-ATTPDF01.txt")), "Indexed again.")
        XCTAssertFalse(FileOps.read(join(root, "library.bib"))!.contains("jonesField"))
        world.clearSeen()
        await sync.sync()
        XCTAssertEqual(world.seen.map { [String($0.path.split(separator: "/").last!), $0.unless ?? "nil"] }, [["collections", String(lib.version)], ["groups", "nil"]])
    }

    func testPagesOf100UntilTotalResults() async {
        let lib = seedLibrary()
        for i in 0..<230 { lib.item(["key": .string(String(format: "FILL%04d", i)), "itemType": "report", "title": .string("Filler \(i)"), "creators": [["creatorType": "author", "lastName": "Filler"]], "date": "2010", "dateAdded": .string(String(format: "2010-01-01T00:00:%02dZ", i % 60))]) }
        let world = FakeZoteroWorld(mine: lib)
        let sync = makeSync(world, root: join(tempDir("pages"), "zotero"))
        let done = await sync.sync()
        XCTAssertEqual(done.items, 235)
        XCTAssertEqual(world.seen.filter { $0.path.hasSuffix("/items") && $0.query["itemKey"] == nil }.map { [$0.query["limit"]!, $0.query["start"]!] }, [["100", "0"], ["100", "100"], ["100", "200"]])
        XCTAssertEqual(world.seen.filter { $0.query["itemKey"] != nil }.count, 5)
    }

    func testBackoffAndRetryAfter() async {
        let world = FakeZoteroWorld(mine: seedLibrary())
        var collectionsTries = 0, itemsTries = 0
        world.trouble = { comps, _ in
            if comps.path.hasSuffix("/collections") { collectionsTries += 1; if collectionsTries == 1 { return HTTPResponse(status: 429, headers: ["retry-after": "2"]) } }
            if comps.path.hasSuffix("/items") && !(comps.query ?? "").contains("itemKey") { itemsTries += 1; if itemsTries == 1 { return HTTPResponse(status: 503, headers: ["retry-after": "7"]) } }
            return nil
        }
        let clock = FakeClock(1_000_000)
        let waits = Box<[Double]>([])
        let withBackoff = ClosureHTTPClient { request in
            var response = try await world.answer(request)
            if request.url.path.hasSuffix("/collections") && response.status == 200 { response.headers["backoff"] = "5" }
            return response
        }
        var sources = ZoteroSources(); sources.api = FakeZoteroWorld.api
        let backoffRoot = join(tempDir("backoff"), "zotero")
        let sync = ZoteroSync(http: withBackoff, sources: sources, root: { backoffRoot }, account: { ZoteroAccount(userID: ZUSER, key: ZKEY) },
                              sleep: { ms in waits.value.append(ms); clock.advance(ms) }, now: { clock.now })
        let done = await sync.sync()
        XCTAssertEqual(done.state, "synced")
        XCTAssertEqual(waits.value, [2000, 5000, 7000], "Retry-After 2 s, the Backoff of 5 s, then Retry-After 7 s")
        XCTAssertEqual(collectionsTries, 2)

        let stuck = FakeZoteroWorld(mine: seedLibrary())
        stuck.trouble = { _, _ in HTTPResponse(status: 429) }
        let failed = await makeSync(stuck, root: join(tempDir("stuck"), "zotero")).sync()
        XCTAssertEqual(failed.state, "error")
        XCTAssertTrue(failed.error.contains("slow down"))
        XCTAssertFalse(failed.error.contains(ZKEY))
    }

    func testRefusedKeyClearAndAnotherAccountsMirror() async throws {
        let world = FakeZoteroWorld(mine: seedLibrary())
        let root = join(tempDir("refused"), "zotero")
        let refused = makeSync(world, root: root, key: "wrong")
        let answer = await refused.sync()
        XCTAssertEqual(answer.state, "error")
        XCTAssertTrue(answer.error.contains("refused the key"))
        let sync = makeSync(world, root: root)
        await sync.sync()
        FileOps.mkdir(join(root, "files", "ATTPDF01"))
        try "%PDF".write(toFile: join(root, "files", "ATTPDF01", "smith.pdf"), atomically: true, encoding: .utf8)
        sync.clear()
        XCTAssertFalse(FileOps.exists(root))
        XCTAssertEqual(sync.status().state, "idle")
        await sync.sync()
        let state = readJSONFile(join(root, "state.json"))
        try state.with("userID", "999").text().write(toFile: join(root, "state.json"), atomically: true, encoding: .utf8)
        world.clearSeen()
        await sync.sync()
        XCTAssertEqual(world.seen.first { $0.path.hasSuffix("/items") }?.query["since"], "0")
    }

    func testUnchangedLibraryCostsOne304() async {
        let lib = seedLibrary()
        let world = FakeZoteroWorld(mine: lib)
        let root = join(tempDir("304"), "zotero")
        let clock = FakeClock(parseISO("2026-10-06T10:00:00Z")!)
        let sync = makeSync(world, root: root, now: { clock.now })
        await sync.sync()
        XCTAssertNil(world.seen[0].unless)
        let before = FileOps.read(join(root, "items.json"))
        world.clearSeen()
        clock.advance(10 * 60_000)
        let done = await sync.autoSync()
        XCTAssertEqual(world.seen.count, 2)
        XCTAssertEqual(world.seen[0].path, "/users/\(ZUSER)/collections")
        XCTAssertEqual(world.seen[0].unless, String(lib.version))
        XCTAssertEqual(world.seen[1].path, "/users/\(ZUSER)/groups")
        XCTAssertEqual(done.state, "synced")
        XCTAssertEqual(done.syncedAt, isoString(clock.now))
        XCTAssertEqual(sync.lastSyncAt(), clock.now)
        XCTAssertEqual(FileOps.read(join(root, "items.json")), before)
        lib.item(["key": "NEW00001", "itemType": "journalArticle", "title": "Fresh", "creators": [], "date": "2026"])
        world.clearSeen()
        await sync.autoSync()
        XCTAssertGreaterThan(world.seen.count, 1)
        XCTAssertTrue(readJSONFile(join(root, "items.json")).array!.contains { $0["key"] == "NEW00001" })
        XCTAssertEqual(readJSONFile(join(root, "state.json"))["version"]?.int, lib.version)
    }

    func testScheduleNeverTwoAtOnceNoneSignedOut() async {
        let world = FakeZoteroWorld(mine: seedLibrary())
        let root = join(tempDir("clock"), "zotero")
        let clock = FakeClock(parseISO("2026-10-06T10:00:00Z")!)
        let sync = makeSync(world, root: root, now: { clock.now })
        var connected = true
        let schedule = ZoteroSchedule(library: sync, connected: { connected }, now: { clock.now }, startClock: false)
        schedule.focus()
        await sync.autoSync()
        let first = world.seen.count
        XCTAssertGreaterThan(first, 1)
        clock.advance(60_000)
        schedule.focus()
        await settle(50)
        XCTAssertEqual(world.seen.count, first, "synced a minute ago: left alone")

        clock.advance(3 * 60_000)
        world.clearSeen()
        let gate = Box(false)
        world.hold = { while !gate.value { try? await Task.sleep(nanoseconds: 1_000_000) } }
        schedule.tick()
        await until { sync.isSyncing }
        schedule.tick(); schedule.focus(); schedule.tick()
        XCTAssertEqual(sync.status().state, "syncing")
        gate.value = true
        await sync.autoSync()
        await settle(50)
        XCTAssertEqual(world.seen.count, 2, "one sync: the 304, and the list of groups")
        XCTAssertEqual(world.most, 1, "never two requests at once")
        world.hold = nil

        connected = false
        clock.advance(20 * 60_000)
        world.clearSeen()
        schedule.tick(); schedule.focus()
        await settle(50)
        XCTAssertEqual(world.seen.count, 0)
    }

    func testAttachmentFromStorageLinkedPathThenDownloadWithoutTheKey() async throws {
        let lib = seedLibrary()
        let linked = join(tempDir("linked"), "mine.pdf")
        try "%PDF linked".write(toFile: linked, atomically: true, encoding: .utf8)
        lib.item(["key": "LINK0001", "itemType": "report", "title": "Linked", "creators": []])
        lib.item(["key": "ATTLNK01", "itemType": "attachment", "parentItem": "LINK0001", "linkMode": "linked_file", "contentType": "application/pdf", "path": .string(linked), "title": "mine.pdf"])
        lib.item(["key": "SNAP0001", "itemType": "webpage", "title": "Snap", "url": "https://example.org/snap", "creators": []])
        lib.item(["key": "ATTHTML1", "itemType": "attachment", "parentItem": "SNAP0001", "linkMode": "imported_url", "contentType": "text/html", "filename": "snap.html", "url": "https://example.org/snap"])
        let world = FakeZoteroWorld(mine: lib)
        let root = join(tempDir("attach"), "zotero")
        let storage = tempDir("storage")
        let sync = makeSync(world, root: root, storage: storage)
        await sync.sync()
        world.clearSeen()
        let download: @Sendable (String, String) async throws -> String = { key, name in try await sync.download(key, name) }
        FileOps.mkdir(join(storage, "ATTPDF01"))
        try "%PDF stored".write(toFile: join(storage, "ATTPDF01", "smith.pdf"), atomically: true, encoding: .utf8)
        var t = await ZoteroMirror.openTarget(root, "SMITH001", storageDir: storage, download: download)
        XCTAssertEqual(t, .file(path: join(storage, "ATTPDF01", "smith.pdf"), source: "storage"))
        t = await ZoteroMirror.openTarget(root, "LINK0001", storageDir: storage, download: download)
        XCTAssertEqual(t, .file(path: linked, source: "linked"))
        XCTAssertEqual(world.seen.count, 0)
        FileOps.remove(join(storage, "ATTPDF01"))
        let fetched = await ZoteroMirror.openTarget(root, "SMITH001", storageDir: storage, download: download)
        XCTAssertEqual(fetched, .file(path: join(root, "files", "ATTPDF01", "smith.pdf"), source: "downloaded"))
        XCTAssertTrue(FileOps.read(join(root, "files", "ATTPDF01", "smith.pdf"))!.hasPrefix("%PDF-1.4 downloaded"))
        XCTAssertEqual(world.seen.map(\.path), ["/users/\(ZUSER)/items/ATTPDF01/file"])
        XCTAssertEqual(world.files.map(\.path), ["/s3/ATTPDF01?signature=x"])
        XCTAssertNil(world.files[0].key, "where the file is kept never gets the key")
        _ = await ZoteroMirror.openTarget(root, "SMITH001", storageDir: storage, download: download)
        XCTAssertEqual(world.seen.count, 1)
        FileOps.mkdir(join(storage, "ATTHTML1"))
        try "<p>snap</p>".write(toFile: join(storage, "ATTHTML1", "snap.html"), atomically: true, encoding: .utf8)
        t = await ZoteroMirror.openTarget(root, "SNAP0001", storageDir: storage, download: download)
        XCTAssertEqual(t, .file(path: join(storage, "ATTHTML1", "snap.html"), source: "storage"))
        FileOps.remove(linked)
        t = await ZoteroMirror.openTarget(root, "LINK0001", storageDir: storage, download: download)
        guard case .error(let why) = t else { return XCTFail("\(t)") }
        XCTAssertTrue(why.contains("no file or address"))
        XCTAssertEqual(world.seen.count, 1)
    }

    func testItemBlockAndPointerLine() async throws {
        let world = FakeZoteroWorld(mine: seedLibrary())
        let root = join(tempDir("bart"), "zotero")
        let storage = tempDir("bart-storage")
        let sync = makeSync(world, root: root, storage: storage)
        await sync.sync()
        let block = await ZoteroMirror.itemBlock(root, "SMITH001", name: "Learning to Learn", storageDir: storage, download: { key, name in try await sync.download(key, name) })
        let body = block.lines.joined(separator: "\n")
        let file = join(root, "files", "ATTPDF01", "smith.pdf")
        for line in ["<zotero_item key=\"SMITH001\" cite=\"smithLearning2020\">", "title: Learning to Learn", "creators: Ann Smith; Bo Ng", "year: 2020", "type: journalArticle",
                     "publication: Journal of Learning", "doi: 10.1/abc", "url: https://example.org/smith", "tags: meta", "collection: Reading",
                     "attachment: \(file) (application/pdf)", "full text: \(join(root, "items", "SMITH001", "fulltext-ATTPDF01.txt"))",
                     "<abstract>\nWe learn to learn.\n</abstract>", "<bibtex>\n@article{smithLearning2020,\n\ttitle = {Learning to Learn}\n}\n</bibtex>",
                     "<notes>\n<note>\nRead section 3 & compare.\nSecond line\n</note>\n</notes>",
                     "<annotations>\n<annotation type=\"highlight\" page=\"3\">\n<quote>\nlearning is recursive\n</quote>\n<comment>\nkey claim\n</comment>\n</annotation>\n</annotations>"] {
            XCTAssertTrue(body.contains(line), "has: \(line)")
        }
        XCTAssertEqual(block.file, file)
        XCTAssertTrue(FileOps.exists(file))
        let gone = await ZoteroMirror.itemBlock(root, "GONE0001", name: "Gone")
        XCTAssertEqual(gone.lines, ["<zotero_item key=\"GONE0001\" title=\"Gone\" missing=\"true\" />"])
        XCTAssertFalse(body.contains(ZKEY))
        XCTAssertEqual(ZoteroMirror.pointerLine(root), "zotero library: \(root) (My Library, 5 items; items.json, collections.json, library.bib, and items/<key>/ with item.bib, children.json and fulltext-*.txt)")
        XCTAssertEqual(ZoteroMirror.pointerLine(tempDir("empty")), "")
        let mention = await ZoteroMirror.mentionBlock(root, "SMITH001", name: "x", service: { _ in sync.library("") })
        XCTAssertTrue(mention.lines[0].hasPrefix("<zotero_item key=\"SMITH001\" cite=\"smithLearning2020\" library=\"My Library\">"))
        XCTAssertTrue(mention.lines.contains("library: My Library (the person's own Zotero library)"))
    }

    func testListingsForTheAtMenu() async {
        let world = FakeZoteroWorld(mine: seedLibrary())
        let root = join(tempDir("menu"), "zotero")
        await makeSync(world, root: root).sync()
        XCTAssertFalse(ZoteroMirror.mirrorDir("/data").hasSuffix("/zotero"))
        guard case .entries(let top, _) = ZoteroMirror.listLibraries(root, "") else { return XCTFail() }
        XCTAssertEqual(top.first.map { [$0.name, String($0.dir), $0.rel] }, ["My Library", "true", "My Library"])
        guard case .entries(let lib, _) = ZoteroMirror.listLibraries(root, "My Library") else { return XCTFail() }
        XCTAssertEqual(lib.first.map { [$0.name, $0.rel] }, ["Reading", "My Library/Reading"])
        guard case .entries(let reading, _) = ZoteroMirror.listLibraries(root, "My Library/Reading") else { return XCTFail() }
        XCTAssertEqual(reading.map(\.name), ["Methods∕Tools", "Learning to Learn"])
        guard case .entries(let methods, _) = ZoteroMirror.listLibraries(root, "My Library/Reading/Methods∕Tools") else { return XCTFail() }
        XCTAssertEqual(methods.map(\.name), ["A Book"])
        XCTAssertEqual(ZoteroMirror.listLibraries(root, "Nope"), .missing)
        XCTAssertEqual(ZoteroMirror.listLibraries(root, "My Library/Nope"), .missing)
        guard case .entries(let level, _) = ZoteroMirror.listLevel(root, "") else { return XCTFail() }
        let smith = level.first { $0.zotero == "SMITH001" }!
        XCTAssertEqual(smith.hint, "Smith and Ng · 2020")
        XCTAssertTrue(smith.find!.contains("smith"))
        XCTAssertEqual(level.filter { $0.find?.contains("2021") ?? false }.map { $0.zotero! }.sorted(), ["LEE00001", "LEE00002"])
        XCTAssertEqual(ZoteroMirror.listLevel(tempDir("none"), ""), .error("Your Zotero library is still syncing…"))
    }

    func testCitationKeysAndHelpers() {
        XCTAssertEqual(ZoteroViews.madeKey(["title": "The Ünïcödé Way", "creators": [["creatorType": "author", "lastName": "Ölsen-Berg"]], "date": "2019-02-03"]), "olsenberg2019unicode")
        XCTAssertEqual(ZoteroViews.madeKey(["title": "", "creators": [], "date": ""]), "anonnd")
        XCTAssertEqual(ZoteroViews.madeKey(["title": "Notes", "creators": [["creatorType": "editor", "name": "World Health Organization"]], "date": "n.d."]), "organizationndnotes")
        let keys = ZoteroViews.citeKeys([
            ["key": "A", "title": "X", "creators": [["lastName": "Doe"]], "date": "2000", "dateAdded": "2000-01-03"],
            ["key": "B", "title": "X", "creators": [["lastName": "Doe"]], "date": "2000", "dateAdded": "2000-01-01"],
            ["key": "C", "title": "X", "creators": [["lastName": "Doe"]], "date": "2000", "dateAdded": "2000-01-02", "extra": "tex.foo: 1\nCitation Key: doe2000x"],
        ])
        XCTAssertEqual([keys["C"], keys["B"], keys["A"]], ["doe2000x", "doe2000xa", "doe2000xb"])
        XCTAssertEqual(ZoteroViews.rekeyed("\n@book{zotero_x,\n title={T}\n}", "mine2020"), "@book{mine2020,\n title={T}\n}")
        XCTAssertEqual(ZoteroViews.noteText("<ul><li>one</li><li>two &#x2014; &#8212;</li></ul>"), "- one\n- two — —")
        XCTAssertEqual(ZoteroViews.suffix(0), "a")
        XCTAssertEqual(ZoteroViews.suffix(25), "z")
        XCTAssertEqual(ZoteroViews.suffix(26), "aa")
    }

    // MARK: groups (build 5)

    func testGroupsListedEveryPageAndMirroredBesideMyLibrary() async {
        let (world, lab, club) = groupsWorld()
        for i in 0..<120 { world.group(String(5000 + i), String(format: "Big %03d", i), FakeZoteroLibrary(1)) }
        let root = join(tempDir("mirror"), ".zotero")
        let sync = makeSync(world, root: root)
        let done = await sync.sync()
        XCTAssertEqual(done.state, "synced")
        XCTAssertEqual(done.problems, [])
        XCTAssertEqual(done.groups, 122)
        XCTAssertEqual(done.items, 5)
        XCTAssertEqual(world.seen.filter { $0.path == "/users/\(ZUSER)/groups" }.map { [$0.query["limit"]!, $0.query["start"]!] }, [["100", "0"], ["100", "100"]])
        XCTAssertTrue(world.seen.allSatisfy { $0.method == "GET" })
        XCTAssertEqual(readJSONFile(join(root, "items.json")).array!.map { $0["title"]!.string! }, ["My Own Paper"])
        let labDir = join(root, "groups", LAB)
        for file in ["state.json", "raw.json", "collections.json", "items.json", "library.bib", "items/SAME0001/item.bib", "items/SAME0001/children.json", "items/SAME0001/fulltext-ATTSAME1.txt"] {
            XCTAssertTrue(FileOps.exists(join(labDir, file)), file)
        }
        XCTAssertEqual(readJSONFile(join(labDir, "items.json")).array!.map { $0["key"]!.string! }.sorted(), ["FREELAB1", "SAME0001", "SHUTLAB1"])
        let state = readJSONFile(join(labDir, "state.json"))
        XCTAssertEqual(state["groupID"], .string(LAB)); XCTAssertEqual(state["name"], "Lab Readings"); XCTAssertEqual(state["userID"], .string(ZUSER))
        XCTAssertEqual(state["version"]?.int, lab.version); XCTAssertEqual(state["items"]?.int, 3)
        XCTAssertEqual(readJSONFile(join(root, "groups", CLUB, "items.json")).array![0]["title"], "Club Book")
        for file in walk(root) { XCTAssertFalse((FileOps.read(file) ?? "").contains(ZKEY)) }

        lab.item(["key": "NEWLAB01", "itemType": "report", "title": "New in the lab", "creators": [], "dateAdded": "2024-01-01"])
        world.group(CLUB, "Journal Club (renamed)", club)
        world.clearSeen()
        let again = await sync.sync()
        XCTAssertEqual(again.items, 6)
        XCTAssertEqual(world.seen.first { $0.path.hasPrefix("/groups/\(LAB)") && $0.path.hasSuffix("/collections") }?.unless, String(state["version"]!.int!))
        XCTAssertEqual(world.seen.filter { $0.path.hasPrefix("/groups/\(CLUB)/") }.count, 1)
        XCTAssertEqual(readJSONFile(join(root, "groups", CLUB, "state.json"))["name"], "Journal Club (renamed)")
    }

    func testGroupLeftOrRefusedIsDeletedListFailureLeavesThem() async throws {
        let (world, _, _) = groupsWorld()
        var refuse = ""
        var brokenList = false
        world.trouble = { comps, _ in
            if brokenList && comps.path == "/users/\(ZUSER)/groups" { return HTTPResponse(status: 400, body: Data("{}".utf8)) }
            if !refuse.isEmpty && comps.path.hasPrefix("/groups/\(refuse)/") { return HTTPResponse(status: 403, body: Data("Forbidden".utf8)) }
            return nil
        }
        let root = join(tempDir("gone"), ".zotero")
        let sync = makeSync(world, root: root)
        await sync.sync()
        FileOps.mkdir(join(root, "groups", LAB, "files", "ATTSAME1"))
        try "%PDF".write(toFile: join(root, "groups", LAB, "files", "ATTSAME1", "lab.pdf"), atomically: true, encoding: .utf8)
        world.dropGroup(CLUB)
        var done = await sync.sync()
        XCTAssertFalse(FileOps.exists(join(root, "groups", CLUB)))
        XCTAssertTrue(FileOps.exists(join(root, "groups", LAB, "files", "ATTSAME1", "lab.pdf")))
        XCTAssertEqual(done.state, "synced"); XCTAssertEqual(done.groups, 1); XCTAssertEqual(done.problems, [])
        XCTAssertEqual(ZoteroMirror.listLibraries(root, "Journal Club"), .missing)
        refuse = LAB
        done = await sync.sync()
        XCTAssertFalse(FileOps.exists(join(root, "groups", LAB)))
        XCTAssertEqual(done.groups, 0)
        XCTAssertTrue(FileOps.exists(join(root, "items.json")))
        refuse = ""
        await sync.sync()
        XCTAssertTrue(FileOps.exists(join(root, "groups", LAB, "items.json")))
        brokenList = true
        done = await sync.sync()
        XCTAssertEqual(done.state, "synced")
        XCTAssertTrue(done.problems.map(\.error).joined().contains("list of your groups could not be had"))
        XCTAssertTrue(FileOps.exists(join(root, "groups", LAB, "items.json")))
        sync.clear()
        XCTAssertFalse(FileOps.exists(root))
    }

    func testOneGroupFailingLeavesTheOthers() async {
        let (world, _, _) = groupsWorld()
        world.trouble = { comps, _ in comps.path.hasPrefix("/groups/\(LAB)/") ? HTTPResponse(status: 500, body: Data("oops".utf8)) : nil }
        let root = join(tempDir("fail"), ".zotero")
        let done = await makeSync(world, root: root).sync()
        XCTAssertEqual(done.state, "synced")
        XCTAssertEqual(done.problems, [ZoteroProblem(name: "Lab Readings", error: "Zotero is not answering right now. Try again later.")])
        XCTAssertTrue(FileOps.exists(join(root, "groups", CLUB, "items.json")))
        XCTAssertFalse(FileOps.exists(join(root, "groups", LAB)))
        XCTAssertEqual(world.seen.filter { $0.path == "/groups/\(LAB)/collections" }.count, 5)
        let line = ZoteroChips.syncLine(done)!
        XCTAssertEqual(line.text, "Synced · 2 items · 1 group")
        XCTAssertFalse(line.error)
        XCTAssertEqual(line.groups, "Lab Readings: Zotero is not answering right now. Try again later.")
        XCTAssertEqual(ZoteroChips.syncLine(ZoteroSyncStatus(state: "synced", items: 1204))!.text, "Synced · 1204 items")

        let (other, _, _) = groupsWorld()
        other.trouble = { comps, _ in comps.path == "/users/\(ZUSER)/collections" ? HTTPResponse(status: 400, body: Data("bad".utf8)) : nil }
        let otherRoot = join(tempDir("mine-down"), ".zotero")
        let failed = await makeSync(other, root: otherRoot).sync()
        XCTAssertEqual(failed.state, "error")
        XCTAssertTrue(failed.error.contains("Zotero answered 400"))
        XCTAssertTrue(FileOps.exists(join(otherRoot, "groups", LAB, "items.json")))

        world.trouble = { _, _ in nil }
        world.clearSeen()
        let no = await makeSync(world, root: root, key: "wrong").sync()
        XCTAssertTrue(no.error.contains("refused the key"))
        XCTAssertEqual(world.seen.map(\.path), ["/users/\(ZUSER)/collections"])
    }

    func testSameKeyInTwoLibrariesTwoItemsTwoFiles() async {
        let (world, _, _) = groupsWorld()
        let root = join(tempDir("same"), ".zotero")
        let sync = makeSync(world, root: root)
        await sync.sync()
        guard case .entries(let top, _) = ZoteroMirror.listLibraries(root, "") else { return XCTFail() }
        XCTAssertEqual(top.filter(\.dir).map { [$0.name, $0.rel] }, [["My Library", "My Library"], ["Journal Club", "Journal Club"], ["Lab Readings", "Lab Readings"]])
        XCTAssertEqual(top.filter { ["My Own Paper", "The Lab Paper"].contains($0.name) }.map { [$0.name, $0.zotero!, $0.hint!] },
                       [["My Own Paper", "SAME0001", "Mine · 2020"], ["The Lab Paper", "g\(LAB):SAME0001", "Lab · 2023 · Lab Readings"]])
        let mine = await ZoteroMirror.mentionBlock(root, "SAME0001", service: { sync.library($0) })
        let theirs = await ZoteroMirror.mentionBlock(root, "g\(LAB):SAME0001", service: { sync.library($0) })
        XCTAssertTrue(mine.lines.contains("title: My Own Paper"))
        XCTAssertTrue(theirs.lines.contains("title: The Lab Paper"))
        XCTAssertTrue(theirs.lines[0].contains("library=\"Lab Readings\" group=\"\(LAB)\""))
        XCTAssertTrue(mine.file.hasSuffix("/files/ATTSAME1/mine.pdf"))
        XCTAssertTrue(theirs.file.hasSuffix("/groups/\(LAB)/files/ATTSAME1/lab.pdf"))
        XCTAssertTrue(world.files.allSatisfy { $0.key == nil })
    }
}
