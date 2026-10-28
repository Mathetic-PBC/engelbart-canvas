import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// The fake api.zotero.org of test/zotero-sync.test.cjs and test/zotero-groups.test.cjs: My Library and groups, versions,
// deletions, indexed text and BibTeX; every request recorded. Answered in-process (no network).

let ZKEY = "Zk3yN0tToB3S3ntAnywh3r3"
let ZUSER = "475425"
let LAB = "1001"
let CLUB = "2002"

final class FakeZoteroLibrary: @unchecked Sendable {
    private(set) var version: Int
    var collectionOrder: [String] = []
    var collections: [String: (version: Int, data: JSONValue)] = [:]
    var itemOrder: [String] = []
    var items: [String: (version: Int, data: JSONValue)] = [:]
    var deleted: [(key: String, kind: String, version: Int)] = []
    var fulltext: [String: (content: String, version: Int)] = [:]

    init(_ start: Int = 10) { version = start }
    @discardableResult func bump() -> Int { version += 1; return version }

    func collection(_ data: JSONValue) {
        let key = data["key"]!.string!
        let v = bump()
        if collections[key] == nil { collectionOrder.append(key) }
        collections[key] = (v, data.with("version", .number(Double(v))))
    }

    func item(_ data: JSONValue) {
        let key = data["key"]!.string!
        let v = bump()
        var o: [String: JSONValue] = ["relations": .object([:]), "tags": [], "collections": []]
        for (k, value) in data.object! { o[k] = value }
        o["version"] = .number(Double(v))
        if items[key] == nil { itemOrder.append(key) }
        items[key] = (v, .object(o))
    }

    func remove(_ key: String) {
        items[key] = nil
        itemOrder.removeAll { $0 == key }
        deleted.append((key, "items", bump()))
    }

    func text(_ key: String, _ content: String) { fulltext[key] = (content, bump()) }
}

struct Seen: Sendable {
    var method: String
    var host: String
    var path: String
    var query: [String: String]
    var key: String?
    var apiVersion: String?
    var unless: String?
}

final class FakeZoteroWorld: @unchecked Sendable {
    let mine: FakeZoteroLibrary
    var groupOrder: [String] = []
    var groups: [String: (name: String, lib: FakeZoteroLibrary)] = [:]
    private let lock = NSLock()
    private var _seen: [Seen] = []
    var files: [(path: String, key: String?)] = []
    var trouble: (URLComponents, Int) -> HTTPResponse? = { _, _ in nil }
    var hold: (() async -> Void)?
    var busy = 0, most = 0

    init(mine: FakeZoteroLibrary) { self.mine = mine }

    func group(_ id: String, _ name: String, _ lib: FakeZoteroLibrary) {
        if groups[id] == nil { groupOrder.append(id) }
        groups[id] = (name, lib)
    }
    func dropGroup(_ id: String) { groups[id] = nil; groupOrder.removeAll { $0 == id } }

    var seen: [Seen] { lock.lock(); defer { lock.unlock() }; return _seen }
    func clearSeen() { lock.lock(); _seen = []; lock.unlock() }

    static let api = "https://zotero.test"
    static let filesHost = "https://files.test"

    lazy var client: HTTPClient = ClosureHTTPClient { [unowned self] request in try await self.answer(request) }

    func answer(_ request: HTTPRequest) async throws -> HTTPResponse {
        let comps = URLComponents(url: request.url, resolvingAgainstBaseURL: false)!
        let headers = Dictionary(request.headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, b in b })
        if "https://\(comps.host ?? "")" == Self.filesHost {
            files.append((comps.path + (comps.query.map { "?\($0)" } ?? ""), headers["zotero-api-key"]))
            return HTTPResponse(status: 200, headers: ["content-type": "application/pdf"], body: Data("%PDF-1.4 downloaded \(comps.path)".utf8))
        }
        var query: [String: String] = [:]
        for item in comps.queryItems ?? [] { query[item.name] = item.value ?? "" }
        lock.lock()
        _seen.append(Seen(method: request.method, host: comps.host ?? "", path: comps.path, query: query, key: headers["zotero-api-key"], apiVersion: headers["zotero-api-version"], unless: headers["if-modified-since-version"]))
        let count = _seen.count
        busy += 1; most = max(most, busy)
        lock.unlock()
        defer { lock.lock(); busy -= 1; lock.unlock() }
        if let hold { await hold() }
        if headers["zotero-api-key"] != ZKEY || headers["zotero-api-version"] != "3" { return reply(403, ["error": "forbidden"]) }
        let path = comps.path
        let start = Int(query["start"] ?? "0") ?? 0, limit = Int(query["limit"] ?? "25") ?? 25
        if path == "/users/\(ZUSER)/groups" {
            if let special = trouble(comps, count) { return special }
            let list: [JSONValue] = groupOrder.map { id in ["id": .number(Double(id)!), "version": 3, "data": ["id": .number(Double(id)!), "name": .string(groups[id]!.name), "type": "Private"]] }
            return reply(200, .array(Array(list.dropFirst(start).prefix(limit))), headers: ["total-results": String(list.count)])
        }
        var lib: FakeZoteroLibrary?
        var route = ""
        if let m = re("^/users/(\\d+)(/.*)$").groups(path), m[1] == ZUSER { lib = mine; route = m[2]! }
        if let m = re("^/groups/(\\d+)(/.*)$").groups(path) {
            guard let g = groups[m[1]!] else { return HTTPResponse(status: 404, body: Data("Not found".utf8)) }
            lib = g.lib; route = m[2]!
        }
        guard let lib else { return reply(404, [:]) }
        let version = String(lib.version)
        let json = { (value: JSONValue, extra: [String: String]) -> HTTPResponse in
            var h = extra; h["last-modified-version"] = version; h["content-type"] = "application/json"
            return reply(200, value, headers: h)
        }
        if let special = trouble(comps, count) { return special }
        if let unless = headers["if-modified-since-version"], let n = Int(unless), n >= lib.version {
            return HTTPResponse(status: 304, headers: ["last-modified-version": version])
        }
        let since = Int(query["since"] ?? "0") ?? 0
        let page = { (list: [JSONValue]) in json(.array(Array(list.dropFirst(start).prefix(limit))), ["total-results": String(list.count)]) }
        if route == "/collections" {
            return page(lib.collectionOrder.compactMap { lib.collections[$0] }.filter { $0.version > since }.map { c in ["key": c.data["key"]!, "version": .number(Double(c.version)), "data": c.data] })
        }
        if route == "/items", let keys = query["itemKey"] {
            let list = keys.split(separator: ",").map(String.init)
            XCTAssertLessThanOrEqual(list.count, 50, "at most 50 keys a batch")
            XCTAssertEqual(query["include"], "bibtex")
            return json(.array(list.compactMap { k -> JSONValue? in
                guard let item = lib.items[k] else { return nil }
                return ["key": .string(k), "version": .number(Double(item.version)), "bibtex": .string("\n@article{zotero_\(k.lowercased()),\n\ttitle = {\(item.data["title"]?.stringish ?? "")}\n}\n")]
            }), [:])
        }
        if route == "/items" {
            return page(lib.itemOrder.compactMap { lib.items[$0] }.filter { $0.version > since && (query["includeTrashed"] == "1" || !($0.data["deleted"]?.truthy ?? false)) }
                .map { i in ["key": i.data["key"]!, "version": .number(Double(i.version)), "data": i.data] })
        }
        if route == "/deleted" {
            var out: [String: [JSONValue]] = ["collections": [], "items": [], "searches": [], "tags": [], "settings": []]
            for d in lib.deleted where d.version > since { out[d.kind]!.append(.string(d.key)) }
            return json(.object(out.mapValues { .array($0) }), [:])
        }
        if route == "/fulltext" {
            return json(.object(Dictionary(uniqueKeysWithValues: lib.fulltext.filter { $0.value.version > since }.map { ($0.key, JSONValue.number(Double($0.value.version))) })), [:])
        }
        if let m = re("^/items/(\\w+)/fulltext$").groups(route) {
            if let t = lib.fulltext[m[1]!] { return json(["content": .string(t.content), "indexedPages": 1, "totalPages": 1], [:]) }
            return reply(404, [:])
        }
        if let m = re("^/items/(\\w+)/file$").groups(route) {
            let location = lib === mine ? "\(Self.filesHost)/s3/\(m[1]!)?signature=x" : "\(Self.filesHost)/s3\(path)"
            return HTTPResponse(status: 302, headers: ["location": location])
        }
        return reply(404, [:])
    }
}

/// The library test/zotero-sync.test.cjs starts from.
func seedLibrary() -> FakeZoteroLibrary {
    let lib = FakeZoteroLibrary(10)
    lib.collection(["key": "COLL0001", "name": "Reading", "parentCollection": false])
    lib.collection(["key": "COLL0002", "name": "Methods/Tools", "parentCollection": "COLL0001"])
    lib.collection(["key": "COLL0003", "name": "Old", "parentCollection": false, "deleted": true])
    lib.item(["key": "SMITH001", "itemType": "journalArticle", "title": "Learning to Learn", "creators": [["creatorType": "author", "firstName": "Ann", "lastName": "Smith"], ["creatorType": "author", "firstName": "Bo", "lastName": "Ng"]], "date": "2020-03-01", "publicationTitle": "Journal of Learning", "DOI": "10.1/abc", "url": "https://example.org/smith", "abstractNote": "We learn to learn.", "extra": "Citation Key: smithLearning2020", "tags": [["tag": "meta"]], "collections": ["COLL0001"], "dateAdded": "2020-01-01T00:00:00Z"])
    lib.item(["key": "ATTPDF01", "itemType": "attachment", "parentItem": "SMITH001", "linkMode": "imported_file", "contentType": "application/pdf", "filename": "smith.pdf", "title": "Full Text PDF"])
    lib.item(["key": "NOTE0001", "itemType": "note", "parentItem": "SMITH001", "note": "<p>Read <b>section 3</b> &amp; compare.</p><p>Second&nbsp;line</p>"])
    lib.item(["key": "ANNOT001", "itemType": "annotation", "parentItem": "ATTPDF01", "annotationType": "highlight", "annotationText": "learning is recursive", "annotationComment": "key claim", "annotationPageLabel": "3", "annotationColor": "#ffd400"])
    lib.text("ATTPDF01", "The full text of Smith and Ng.")
    lib.item(["key": "JONES001", "itemType": "book", "title": "A Book", "creators": [["creatorType": "editor", "name": "Jones"]], "date": "1999", "publisher": "Press", "citationKey": "jonesField", "collections": ["COLL0002"], "dateAdded": "2020-01-02T00:00:00Z"])
    lib.item(["key": "LEE00002", "itemType": "journalArticle", "title": "Graph Other", "creators": [["creatorType": "author", "firstName": "Kim", "lastName": "Lee"]], "date": "2021", "dateAdded": "2021-05-01T00:00:00Z"])
    lib.item(["key": "LEE00001", "itemType": "journalArticle", "title": "The Graph Thing", "creators": [["creatorType": "author", "firstName": "Kim", "lastName": "Lee"]], "date": "June 2021", "dateAdded": "2021-01-01T00:00:00Z"])
    lib.item(["key": "TRASH001", "itemType": "journalArticle", "title": "Thrown Away", "creators": [], "deleted": 1])
    lib.item(["key": "WEB00001", "itemType": "webpage", "title": "A Page", "url": "https://example.org/page", "creators": []])
    return lib
}

/// test/zotero-groups.test.cjs's world: My Library and two groups; SAME0001 is a key in My Library and in the lab.
func groupsWorld() -> (world: FakeZoteroWorld, lab: FakeZoteroLibrary, club: FakeZoteroLibrary) {
    let mine = FakeZoteroLibrary(10)
    mine.collection(["key": "COLLMINE", "name": "Reading", "parentCollection": false])
    mine.item(["key": "SAME0001", "itemType": "journalArticle", "title": "My Own Paper", "creators": [["creatorType": "author", "lastName": "Mine"]], "date": "2020", "collections": ["COLLMINE"], "dateAdded": "2020-01-01"])
    mine.item(["key": "ATTSAME1", "itemType": "attachment", "parentItem": "SAME0001", "linkMode": "imported_file", "contentType": "application/pdf", "filename": "mine.pdf"])
    let lab = FakeZoteroLibrary(500)
    lab.collection(["key": "COLLLAB1", "name": "Methods", "parentCollection": false])
    lab.item(["key": "SAME0001", "itemType": "journalArticle", "title": "The Lab Paper", "creators": [["creatorType": "author", "firstName": "Ada", "lastName": "Lab"]], "date": "2023", "publicationTitle": "Lab Journal", "abstractNote": "What the lab found.", "collections": ["COLLLAB1"], "dateAdded": "2023-01-01"])
    lab.item(["key": "ATTSAME1", "itemType": "attachment", "parentItem": "SAME0001", "linkMode": "imported_file", "contentType": "application/pdf", "filename": "lab.pdf"])
    lab.item(["key": "NOTELAB1", "itemType": "note", "parentItem": "SAME0001", "note": "<p>Shared note from the lab.</p>"])
    lab.item(["key": "ANNLAB01", "itemType": "annotation", "parentItem": "ATTSAME1", "annotationType": "highlight", "annotationText": "a lab claim", "annotationComment": "check this", "annotationPageLabel": "4"])
    lab.text("ATTSAME1", "The full text of the lab paper.")
    lab.item(["key": "FREELAB1", "itemType": "journalArticle", "title": "Behavioral Context for Adaptive Tutoring", "creators": [["creatorType": "author", "lastName": "Barron"]], "date": "2026", "DOI": "10.5555/lab.free", "dateAdded": "2023-01-02"])
    lab.item(["key": "SHUTLAB1", "itemType": "journalArticle", "title": "Closed Group Paper", "creators": [["creatorType": "author", "lastName": "Shut"]], "date": "2019", "DOI": "10.5555/lab.closed", "dateAdded": "2023-01-03"])
    let club = FakeZoteroLibrary(900)
    club.item(["key": "CLUB0001", "itemType": "book", "title": "Club Book", "creators": [["creatorType": "author", "lastName": "Reader"]], "date": "2001", "dateAdded": "2021-01-01"])
    let world = FakeZoteroWorld(mine: mine)
    world.group(LAB, "Lab Readings", lab)
    world.group(CLUB, "Journal Club", club)
    return (world, lab, club)
}

@MainActor
func makeSync(_ world: FakeZoteroWorld, root: String, key: String = ZKEY, waits: Box<[Double]>? = nil, now: NowMs? = nil, storage: String? = nil,
              http: HTTPClient? = nil, extra: ((inout ZoteroSources) -> Void)? = nil, onChange: ((ZoteroSyncStatus) -> Void)? = nil,
              onFinding: ((String, Bool) -> Void)? = nil) -> ZoteroSync {
    var sources = ZoteroSources()
    sources.api = FakeZoteroWorld.api
    sources.storageDir = storage ?? tempDir("nostorage")
    extra?(&sources)
    return ZoteroSync(http: http ?? world.client, sources: sources, root: { root }, account: { ZoteroAccount(userID: ZUSER, key: key) },
                      sleep: { ms in waits?.value.append(ms) }, onChange: onChange ?? { _ in }, now: now ?? systemNow, onFinding: onFinding ?? { _, _ in })
}

func readJSONFile(_ path: String) -> JSONValue { FileOps.readJSON(path) ?? .null }

func walk(_ dir: String) -> [String] {
    guard let e = FileManager.default.enumerator(atPath: dir) else { return [] }
    return e.compactMap { $0 as? String }.map { join(dir, $0) }.filter { FileOps.isFile($0) }
}
