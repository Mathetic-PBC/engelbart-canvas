import Foundation
import EngelbartCore

// src/main/zotero/sync.cjs (MATH-65 build 2–5): the connected Zotero library mirrored on disk so Bart can read it and the
// @ menu can list it. One account's user library goes to <dataRoot>/.zotero/ through the Web API (Zotero-API-Version 3),
// the key sent only as a header to api.zotero.org:
//   state.json        { v, userID, version, syncedAt, items } (never the key)
//   raw.json          the API's own `data` of every collection and item kept, and each top-level item's BibTeX
//   collections.json  [{ key, name, parent, path }]
//   items.json        the top-level items (ZoteroMirror reads these)
//   library.bib       every item's BibTeX, one after another
//   items/<key>/      item.bib, children.json (notes and annotations as text), fulltext-<attachmentKey>.txt
//   files/<key>/      attachments downloaded when mentioned or opened, never up front
// The first sync asks for everything; a later one only for what changed since the version kept (?since=), what was
// deleted (/deleted?since=), with If-Modified-Since-Version on its first request (an unchanged library costs one 304).
// Trashed items are left out. Pages of 100. A Backoff header holds every request after it; a 429 or 503 waits its
// Retry-After and tries again. Citation keys: Better BibTeX's, else first author + year + first title word, stable.
// Build 3: synced every 10 minutes and when a window comes to the front after 2 (scheduleSyncs), one at a time.
// Build 4: a paper's pdf waited for in Downloads after its chip opened it in the browser; a pdf dropped on a chip.
// Build 5: groups, each mirrored in groups/<groupID>/ with the same files, My Library first. Every request is a GET.

public struct ZoteroSyncError: Error, LocalizedError, Equatable {
    public let message: String
    public let code: String
    public let status: Int
    public init(_ message: String, code: String = "zotero-sync", status: Int = 0) { self.message = message; self.code = code; self.status = status }
    public var errorDescription: String? { message }
}

public struct ZoteroProblem: Equatable, Sendable {
    public var name: String
    public var error: String
}

/// What the Zotero row says of the mirror (status()).
public struct ZoteroSyncStatus: Equatable, Sendable {
    public var state: String // idle | syncing | synced | error
    public var items: Int
    public var syncedAt: String
    public var error: String
    public var groups: Int
    public var problems: [ZoteroProblem]

    public init(state: String = "idle", items: Int = 0, syncedAt: String = "", error: String = "", groups: Int = 0, problems: [ZoteroProblem] = []) {
        self.state = state; self.items = items; self.syncedAt = syncedAt; self.error = error; self.groups = groups; self.problems = problems
    }

    public var json: JSONValue {
        ["state": .string(state), "items": .number(Double(items)), "syncedAt": .string(syncedAt), "error": .string(error),
         "groups": .number(Double(groups)), "problems": .array(problems.map { ["name": .string($0.name), "error": .string($0.error)] })]
    }
}

// MARK: - the mirror's views (pure)

public enum ZoteroViews {
    static let entities: [String: String] = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]

    /// A Zotero note's HTML as plain text: paragraphs and line breaks kept, tags dropped, entities read.
    public static func noteText(_ html: String?) -> String {
        var s = html ?? ""
        s = re("<\\s*br\\s*/?>", .caseInsensitive).replace(s, with: "\n")
        s = re("</\\s*(p|div|h[1-6]|li|blockquote|pre|tr)\\s*>", .caseInsensitive).replace(s, with: "\n")
        s = re("<\\s*li[^>]*>", .caseInsensitive).replace(s, with: "- ")
        s = re("<[^>]*>").replace(s, with: "")
        s = replaceMatches(re("&(#x[0-9a-f]+|#\\d+|\\w+);", .caseInsensitive), in: s) { g in
            let all = g[0] ?? "", code = g[1] ?? ""
            if code.hasPrefix("#") {
                let n = code.dropFirst().lowercased().hasPrefix("x") ? Int(code.dropFirst(2), radix: 16) : Int(code.dropFirst())
                if let n, n > 0, n < 0x110000, let scalar = UnicodeScalar(n) { return String(Character(scalar)) }
                return all
            }
            return entities[code.lowercased()] ?? all
        }
        s = re("[ \\t]+\\n").replace(s, with: "\n")
        s = re("\\n{3,}").replace(s, with: "\n\n")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Better BibTeX's key for an item: the citationKey field (no spaces), else a "Citation Key:" line in Extra.
    public static func betterBibtexKey(_ data: JSONValue) -> String {
        let field = (data["citationKey"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !field.isEmpty && field.rangeOfCharacter(from: .whitespacesAndNewlines) == nil { return field }
        return re("^\\s*citation key\\s*:\\s*(\\S+)\\s*$", [.caseInsensitive, .anchorsMatchLines]).groups(data["extra"]?.stringish ?? "")?[1] ?? ""
    }

    static let functionWords: Set<String> = ["a", "an", "the", "on", "of", "in", "for", "to", "and", "or", "with", "at", "by", "from", "is", "are"]

    static func plain(_ text: String?) -> String {
        let decomposed = (text ?? "").decomposedStringWithCompatibilityMapping
        let stripped = re("[\\u0300-\\u036f]").replace(decomposed, with: "")
        return re("[^a-z0-9]").replace(stripped.lowercased(), with: "")
    }

    static func yearOf(_ data: JSONValue) -> String { re("\\b(\\d{4})\\b").groups(data["date"]?.stringish ?? "")?[1] ?? "" }

    static func firstAuthor(_ data: JSONValue) -> JSONValue? {
        let creators = data["creators"]?.array ?? []
        return creators.first { $0["creatorType"]?.string == "author" } ?? creators.first
    }

    /// The key made for an item without Better BibTeX's: first author's last name, year, first word of the title.
    public static func madeKey(_ data: JSONValue) -> String {
        var last = ""
        if let who = firstAuthor(data) {
            let l = who["lastName"]?.string ?? ""
            last = !l.isEmpty ? l : ((who["name"]?.stringish ?? "").trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: { $0.isWhitespace }).last.map(String.init) ?? "")
        }
        let words = (data["title"]?.stringish ?? "").components(separatedBy: CharacterSet(charactersIn: " \t\n\r-–—:;,.!?/()[]\"'“”‘’")).map(plain).filter { !$0.isEmpty }
        let word = words.first { !functionWords.contains($0) } ?? words.first ?? ""
        let who = plain(last)
        let year = yearOf(data)
        return "\(who.isEmpty ? "anon" : who)\(year.isEmpty ? "nd" : year)\(word)"
    }

    static func suffix(_ n: Int) -> String {
        var s = "", m = n + 1
        while m > 0 { m -= 1; s = String(UnicodeScalar(97 + (m % 26))!) + s; m /= 26 }
        return s
    }

    /// Each top-level item's citation key: Better BibTeX's kept; made ones that clash get a, b, c… in the order the
    /// items were added (then by key), so an item added later never changes an earlier one's.
    public static func citeKeys(_ items: [JSONValue]) -> [String: String] {
        var out: [String: String] = [:], taken = Set<String>()
        for data in items {
            let bbt = betterBibtexKey(data)
            if !bbt.isEmpty, let key = data["key"]?.string { out[key] = bbt; taken.insert(bbt) }
        }
        let rest = items.filter { out[$0["key"]?.string ?? ""] == nil }.sorted {
            let a = $0["dateAdded"]?.stringish ?? "", b = $1["dateAdded"]?.stringish ?? ""
            return a != b ? a < b : ($0["key"]?.stringish ?? "") < ($1["key"]?.stringish ?? "")
        }
        for data in rest {
            let base = madeKey(data)
            var key = base
            var n = 0
            while taken.contains(key) { key = base + suffix(n); n += 1 }
            taken.insert(key)
            out[data["key"]?.stringish ?? ""] = key
        }
        return out
    }

    /// An entry Zotero exported, under `citeKey` in place of the key Zotero gave it.
    public static func rekeyed(_ bib: String?, _ citeKey: String) -> String {
        let trimmed = (bib ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return replaceMatches(re("^(\\s*@\\w+\\s*\\{)[^,\\s]*,"), in: trimmed) { g in "\(g[1] ?? "")\(citeKey)," }
    }

    static let publicationFields = ["publicationTitle", "proceedingsTitle", "bookTitle", "conferenceName", "websiteTitle", "blogTitle", "forumTitle", "programTitle", "university", "institution", "publisher", "repository"]
    static func isTop(_ data: JSONValue?) -> Bool {
        guard let data, data.object != nil else { return false }
        let parent = data["parentItem"]
        if let parent, parent.truthy { return false }
        let type = data["itemType"]?.string ?? ""
        return type != "note" && type != "annotation"
    }

    static func creatorOf(_ c: JSONValue) -> JSONValue {
        let name = c["name"]?.truthy == true ? c["name"]!.stringish : [c["firstName"]?.string, c["lastName"]?.string].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        var o: [String: JSONValue] = ["type": .string(c["creatorType"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "author"), "name": .string(name.trimmingCharacters(in: .whitespaces))]
        if let last = c["lastName"]?.string, !last.isEmpty { o["last"] = .string(last) }
        return .object(o)
    }

    static func doiOf(_ data: JSONValue) -> String {
        if let doi = data["DOI"], doi.truthy { return doi.stringish.trimmingCharacters(in: .whitespacesAndNewlines) }
        return re("^\\s*doi\\s*:\\s*(\\S+)\\s*$", [.caseInsensitive, .anchorsMatchLines]).groups(data["extra"]?.stringish ?? "")?[1] ?? ""
    }

    static func attachmentOf(_ data: JSONValue) -> JSONValue {
        var o: [String: JSONValue] = ["key": data["key"] ?? "", "title": .string(data["title"]?.stringish ?? ""), "contentType": .string(data["contentType"]?.stringish ?? ""),
                                      "filename": .string(data["filename"]?.stringish ?? ""), "linkMode": .string(data["linkMode"]?.stringish ?? "")]
        if data["linkMode"]?.string == "linked_file", let p = data["path"], p.truthy { o["path"] = p }
        if let u = data["url"], u.truthy { o["url"] = u }
        return .object(o)
    }

    static func annotationOf(_ data: JSONValue, attachment: String) -> JSONValue {
        var o: [String: JSONValue] = ["key": data["key"] ?? "", "type": .string(data["annotationType"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "highlight"),
                                      "text": .string(data["annotationText"]?.stringish ?? ""), "comment": .string(data["annotationComment"]?.stringish ?? ""),
                                      "page": .string(data["annotationPageLabel"]?.stringish ?? ""), "attachment": .string(attachment)]
        if let color = data["annotationColor"], color.truthy { o["color"] = color }
        return .object(o)
    }

    /// The raw collections and items kept between syncs (raw.json).
    public struct Raw {
        public var collections: [String: JSONValue] = [:]
        public var items: [String: JSONValue] = [:]
        public var bib: [String: String] = [:]

        public init() {}
        init?(_ json: JSONValue?) {
            guard let json, let c = json["collections"]?.object, let i = json["items"]?.object else { return nil }
            collections = c
            items = i
            bib = (json["bib"]?.object ?? [:]).compactMapValues { $0.string }
        }

        var json: JSONValue { ["collections": .object(collections), "items": .object(items), "bib": .object(bib.mapValues { .string($0) })] }
    }

    /// collections.json from the raw collections: each with the path of names down to it.
    static func collectionsView(_ raw: Raw) -> [JSONValue] {
        func pathOf(_ key: String, _ guardSet: Set<String> = []) -> [String] {
            guard let c = raw.collections[key], !guardSet.contains(key) else { return [] }
            var next = guardSet; next.insert(key)
            let parent = c["parentCollection"]
            let name = c["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled"
            return (parent?.truthy == true ? pathOf(parent!.stringish, next) : []) + [name]
        }
        return raw.collections.values.map { c -> JSONValue in
            let key = c["key"]?.stringish ?? ""
            let parent = c["parentCollection"]
            return ["key": .string(key), "name": .string(c["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled"),
                    "parent": parent?.truthy == true ? .string(parent!.stringish) : .null, "path": .string(pathOf(key).joined(separator: " / "))]
        }.sorted { ($0["path"]?.stringish ?? "").localizedCompare($1["path"]?.stringish ?? "") == .orderedAscending }
    }

    struct Kids { var attachments: [JSONValue] = []; var notes: [JSONValue] = []; var annotations: [JSONValue] = [] }

    /// The children of each top-level item.
    static func childrenView(_ raw: Raw) -> [String: Kids] {
        var out: [String: Kids] = [:]
        let items = raw.items
        for data in items.values {
            let type = data["itemType"]?.string
            if type == "attachment" {
                let top = data["parentItem"]?.truthy == true ? data["parentItem"]!.stringish : (data["key"]?.stringish ?? "")
                if isTop(items[top]) { out[top, default: Kids()].attachments.append(attachmentOf(data)) }
            } else if type == "note", let parent = data["parentItem"], parent.truthy, isTop(items[parent.stringish]) {
                out[parent.stringish, default: Kids()].notes.append(["key": data["key"] ?? "", "text": .string(noteText(data["note"]?.stringish))])
            }
        }
        for data in items.values {
            guard data["itemType"]?.string == "annotation", let parent = data["parentItem"], parent.truthy, let attachment = items[parent.stringish] else { continue }
            let top = attachment["parentItem"]?.truthy == true ? attachment["parentItem"]!.stringish : (attachment["key"]?.stringish ?? "")
            if !top.isEmpty && isTop(items[top]) { out[top, default: Kids()].annotations.append(annotationOf(data, attachment: attachment["key"]?.stringish ?? "")) }
        }
        for key in out.keys {
            out[key]!.attachments.sort { ($0["key"]?.stringish ?? "") < ($1["key"]?.stringish ?? "") }
            out[key]!.notes.sort { ($0["key"]?.stringish ?? "") < ($1["key"]?.stringish ?? "") }
            out[key]!.annotations.sort {
                let pa = Double($0["page"]?.stringish ?? "") ?? 0, pb = Double($1["page"]?.stringish ?? "") ?? 0
                return pa != pb ? pa < pb : ($0["key"]?.stringish ?? "") < ($1["key"]?.stringish ?? "")
            }
        }
        return out
    }

    /// items.json's entry for a top-level item.
    static func itemView(_ data: JSONValue, citeKey: String, kids: Kids) -> JSONValue {
        let title = data["title"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? data["filename"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled"
        let publication = publicationFields.compactMap { data[$0] }.first { $0.truthy }?.stringish ?? ""
        return [
            "key": data["key"] ?? "", "citeKey": .string(citeKey), "itemType": data["itemType"] ?? .null, "title": .string(title),
            "creators": .array((data["creators"]?.array ?? []).map(creatorOf)), "year": .string(yearOf(data)), "date": .string(data["date"]?.stringish ?? ""),
            "publication": .string(publication), "doi": .string(doiOf(data)), "url": .string(data["url"]?.stringish ?? ""),
            "abstractNote": .string(data["abstractNote"]?.stringish ?? ""),
            "tags": .array((data["tags"]?.array ?? []).compactMap { $0["tag"] }.filter { $0.truthy }),
            "collections": .array(data["collections"]?.array ?? []),
            "attachments": .array(kids.attachments), "notes": .number(Double(kids.notes.count)), "annotations": .number(Double(kids.annotations.count)),
            "dateAdded": .string(data["dateAdded"]?.stringish ?? ""), "dateModified": .string(data["dateModified"]?.stringish ?? ""),
        ]
    }

    /// `text` into `file` through a temporary file; nothing when it already holds that.
    static func writeFile(_ file: String, _ text: String) {
        if FileOps.read(file) == text { return }
        FileOps.mkdir((file as NSString).deletingLastPathComponent)
        try? FileOps.write(text, to: file)
    }

    static func writeJSON(_ file: String, _ value: JSONValue) { writeFile(file, JSONText.stringify(value, indent: 1) + "\n") }

    /// The mirror's files from raw.json: collections.json, items.json, library.bib and each item's folder; a folder whose
    /// item is gone goes, and so does the text of an attachment the item no longer has. → the number of items
    @discardableResult
    public static func writeViews(_ root: String, _ raw: Raw, fulltext: [String: String] = [:]) -> Int {
        let tops = raw.items.values.filter { isTop($0) }
        let keys = citeKeys(Array(tops))
        let kids = childrenView(raw)
        let items = tops.map { itemView($0, citeKey: keys[$0["key"]?.stringish ?? ""] ?? "", kids: kids[$0["key"]?.stringish ?? ""] ?? Kids()) }
            .sorted {
                let a = $0["title"]?.stringish ?? "", b = $1["title"]?.stringish ?? ""
                return a != b ? a.localizedCompare(b) == .orderedAscending : ($0["key"]?.stringish ?? "") < ($1["key"]?.stringish ?? "")
            }
        let dir = join(root, "items")
        FileOps.mkdir(dir)
        var bibs: [String] = []
        for item in items {
            let key = item["key"]?.stringish ?? ""
            let at = join(dir, key)
            FileOps.mkdir(at)
            if let raw = raw.bib[key] {
                let bib = rekeyed(raw, item["citeKey"]?.stringish ?? "") + "\n"
                writeFile(join(at, "item.bib"), bib)
                bibs.append(bib)
            } else {
                FileOps.remove(join(at, "item.bib"))
            }
            let kid = kids[key] ?? Kids()
            writeJSON(join(at, "children.json"), ["notes": .array(kid.notes), "annotations": .array(kid.annotations)])
            let attachments = item["attachments"]?.array ?? []
            let own = Set(attachments.map { "fulltext-\($0["key"]?.stringish ?? "").txt" })
            for a in attachments { if let text = fulltext[a["key"]?.stringish ?? ""] { writeFile(join(at, "fulltext-\(a["key"]?.stringish ?? "").txt"), text) } }
            for name in FileOps.list(at) where re("^fulltext-.+\\.txt$").test(name) && !own.contains(name) { FileOps.remove(join(at, name)) }
        }
        let keptKeys = Set(items.map { $0["key"]?.stringish ?? "" })
        for name in FileOps.list(dir) where !keptKeys.contains(name) { FileOps.remove(join(dir, name)) }
        writeJSON(join(root, "collections.json"), .array(collectionsView(raw)))
        writeJSON(join(root, "items.json"), .array(items))
        writeFile(join(root, "library.bib"), bibs.joined(separator: "\n"))
        return items.count
    }
}

// MARK: - the sync

public struct ZoteroAccount: Sendable, Equatable {
    public var userID: String
    public var key: String
    public init(userID: String, key: String) { self.userID = userID; self.key = key }
}

/// Where the free sources and fakes are (index.cjs's ENGELBART_* overrides).
public struct ZoteroSources: Sendable {
    public var api = ZoteroConnection.api
    public var openAlex = ZoteroOA.openAlex
    public var semanticScholar = ZoteroOA.semanticScholar
    public var arxivApi = ZoteroOA.arxivApi
    public var arxiv = ZoteroOA.arxiv
    public var storageDir: String?
    public var broker = ZoteroBrowserAuth.broker

    public init() {}

    /// ENGELBART_ZOTERO_BROKER, _API, _STORAGE, ENGELBART_OPENALEX_API, ENGELBART_SEMANTIC_SCHOLAR_API, ENGELBART_ARXIV_API,
    /// ENGELBART_ARXIV: fakes for scripted runs only.
    public init(environment env: [String: String]) {
        let v = { (name: String) in env[name].flatMap { $0.isEmpty ? nil : $0 } }
        if let x = v("ENGELBART_ZOTERO_API") { api = x }
        if let x = v("ENGELBART_ZOTERO_BROKER") { broker = x }
        storageDir = v("ENGELBART_ZOTERO_STORAGE")
        if let x = v("ENGELBART_OPENALEX_API") { openAlex = x }
        if let x = v("ENGELBART_SEMANTIC_SCHOLAR_API") { semanticScholar = x }
        if let x = v("ENGELBART_ARXIV_API") { arxivApi = x }
        if let x = v("ENGELBART_ARXIV") { arxiv = x }
    }
}

@MainActor
public final class ZoteroSync {
    static let page = 100
    static let keyBatch = 50
    static let timeout: TimeInterval = 60
    static let maxTries = 5
    static let maxWaitMs: Double = 10 * 60_000
    static let version = 1
    nonisolated public static let everyMs: Double = 10 * 60_000
    nonisolated public static let staleMs: Double = 2 * 60_000
    /// A failure of My Library that ends the whole sync, and one of a group that ends the rest.
    static let endsAll: Set<String> = ["signed-out", "no-root", "forbidden", "busy", "network", "aborted"]
    static let endsGroups: Set<String> = ["signed-out", "no-root", "busy", "aborted"]

    let http: HTTPClient
    let sources: ZoteroSources
    let root: () -> String?
    let account: () -> ZoteroAccount?
    let sleep: SleepMs
    let onChange: (ZoteroSyncStatus) -> Void
    let now: NowMs
    public let storageDir: String?
    let onFinding: (String, Bool) -> Void
    let openAccessTimeoutMs: Double?
    private(set) var downloads: ZoteroDownloadWatch?

    private var running: Task<ZoteroSyncStatus, Never>?
    private var current: Task<Void, Never>?
    private var finishedAt: Double = 0
    private var again = false
    private var generation = 0
    private var notBefore: Double = 0
    private var state = (state: "idle", error: "", problems: [ZoteroProblem]())
    private var finders: [String: ZoteroOpenAccess] = [:]

    public init(http: HTTPClient = URLSessionHTTPClient.shared, sources: ZoteroSources = ZoteroSources(), root: @escaping () -> String?,
                account: @escaping () -> ZoteroAccount?, sleep: @escaping SleepMs = systemSleep, onChange: @escaping (ZoteroSyncStatus) -> Void = { _ in },
                now: @escaping NowMs = systemNow, onFinding: @escaping (String, Bool) -> Void = { _, _ in }, openAccessTimeoutMs: Double? = nil,
                downloadsDir: (() -> String)? = nil, onWaiting: @escaping (String, Bool) -> Void = { _, _ in },
                onDownloaded: @escaping (String, ZoteroKeptCopy) -> Void = { _, _ in },
                readPdfText: ((String) async throws -> String)? = nil, downloadWaitMs: Double = ZoteroDownloads.waitMs,
                downloadPollMs: Double = ZoteroDownloads.pollMs, watchDownloads: Bool = true) {
        self.http = http; self.sources = sources; self.root = root; self.account = account; self.sleep = sleep
        self.onChange = onChange; self.now = now; self.storageDir = sources.storageDir; self.onFinding = onFinding
        self.openAccessTimeoutMs = openAccessTimeoutMs
        if let downloadsDir {
            downloads = ZoteroDownloadWatch(dir: downloadsDir, onMatch: { [weak self] waited, file in
                guard let self, let base = self.root(), let ref = waited["key"]?.string, let parsed = ZoteroMirror.parseRef(ref) else { return false }
                guard let bytes = try? ZoteroOA.readPdfFile(file) else { return false }
                let item = waited.with("key", .string(parsed.key))
                guard let copy = try? ZoteroOA.saveCopy(ZoteroMirror.libraryRoot(base, parsed.group), item, bytes, source: "downloaded in browser", from: file, at: self.now()) else { return false }
                onDownloaded(ref, copy)
                return true
            }, onWaiting: onWaiting, readText: readPdfText ?? ZoteroDownloads.firstPagesText, waitMs: downloadWaitMs, pollMs: downloadPollMs, watch: watchDownloads)
        }
    }

    private func changed() { onChange(status()) }

    /// { state, items (every library's), syncedAt, error, groups, problems }: what the Zotero row says.
    public func status() -> ZoteroSyncStatus {
        let at = root()
        let kept = at.flatMap { FileOps.readJSON(join($0, "state.json")) }
        let groups = at.map { ZoteroMirror.groupIds($0) } ?? []
        var items = kept?["items"]?.double.map { Int($0) } ?? 0
        for group in groups {
            if let held = FileOps.readJSON(join(ZoteroMirror.groupDir(at!, group), "state.json"))?["items"]?.double { items += Int(held) }
        }
        let syncedAt = kept?["syncedAt"]?.stringish ?? ""
        let shown = state.state == "idle" && (kept != nil || !groups.isEmpty) ? "synced" : state.state
        return ZoteroSyncStatus(state: shown, items: items, syncedAt: syncedAt, error: state.error, groups: groups.count, problems: state.problems)
    }

    // MARK: requests

    private func checkAborted(_ run: Int) throws {
        if Task.isCancelled || run != generation { throw ZoteroSyncError("Stopped", code: "aborted") }
    }

    private func wait(_ ms: Double, run: Int) async throws {
        try checkAborted(run)
        do { try await sleep(ms) } catch { throw ZoteroSyncError("Stopped", code: "aborted") }
        try checkAborted(run)
    }

    /// One request to a library (`route` under /users/<id>, or /groups/<group>). Waits out a Backoff, and a 429 or 503's
    /// Retry-After (else a little longer each time) before trying again.
    func request(_ route: String, _ params: [(String, String)] = [], run: Int, file: Bool = false, redirect: HTTPRequest.Redirect = .error,
                 headers extra: [String: String] = [:], group: String = "") async throws -> HTTPResponse {
        guard let who = account(), !who.key.isEmpty, !who.userID.isEmpty else { throw ZoteroSyncError("Zotero is not connected.", code: "signed-out") }
        if !group.isEmpty && !ZoteroMirror.isGroup(group) { throw ZoteroSyncError("That is not a Zotero group.", code: "key") }
        let query = queryString(params.filter { !$0.1.isEmpty })
        let prefix = group.isEmpty ? "/users/\(encodeURIComponent(who.userID))" : "/groups/\(group)"
        guard let url = URL(string: "\(sources.api)\(prefix)\(route)\(query.isEmpty ? "" : "?\(query)")") else { throw ZoteroSyncError("Bad address") }
        var tries = 1
        while true {
            let waitMs = notBefore - now()
            if waitMs > 0 { try await wait(min(waitMs, Self.maxWaitMs), run: run) }
            var headers = extra
            headers["zotero-api-key"] = who.key
            headers["zotero-api-version"] = "3"
            headers["accept"] = file ? "*/*" : "application/json"
            let response: HTTPResponse
            do {
                try checkAborted(run)
                response = try await http.send(HTTPRequest(url: url, headers: headers, redirect: redirect, timeout: Self.timeout))
            } catch let error as ZoteroSyncError {
                throw error
            } catch {
                try checkAborted(run)
                if tries < Self.maxTries { try await wait(1000 * Double(tries), run: run); tries += 1; continue }
                throw ZoteroSyncError("Could not reach Zotero. Check your connection and try again.", code: "network")
            }
            if let backoff = Double(response.header("backoff") ?? ""), backoff > 0 { notBefore = max(notBefore, now() + backoff * 1000) }
            if response.status == 429 || response.status == 503 || (response.status >= 500 && response.status != 501) {
                if tries >= Self.maxTries {
                    throw response.status == 429 ? ZoteroSyncError("Zotero asked to slow down. Try again in a few minutes.", code: "busy", status: 429)
                        : ZoteroSyncError("Zotero is not answering right now. Try again later.", code: "unavailable", status: response.status)
                }
                let after = Double(response.header("retry-after") ?? "")
                try await wait(min(after.flatMap { $0 >= 0 ? $0 * 1000 : nil } ?? 1000 * pow(2, Double(tries - 1)), Self.maxWaitMs), run: run)
                tries += 1
                continue
            }
            if response.status == 403 {
                throw ZoteroSyncError(group.isEmpty ? "Zotero refused the key. Disconnect and connect Zotero again." : "Zotero refused access to this group.", code: "forbidden", status: 403)
            }
            return response
        }
    }

    struct Page { var notModified = false; var body: JSONValue? = nil; var version = 0.0; var total: Double? = nil }

    private func json(_ route: String, _ params: [(String, String)], run: Int, group: String, headers: [String: String] = [:]) async throws -> Page {
        let response = try await request(route, params, run: run, headers: headers, group: group)
        if response.status == 304 { return Page(notModified: true) }
        guard response.ok else { throw ZoteroSyncError("Zotero answered \(response.status) for \(route.components(separatedBy: "?")[0]).", code: "http", status: response.status) }
        return Page(body: response.json, version: Double(response.header("last-modified-version") ?? "") ?? 0, total: Double(response.header("total-results") ?? ""))
    }

    /// Every page of a list (limit=100&start=…), the library's version at the first page; `unless` sent with the first
    /// page as If-Modified-Since-Version → notModified on a 304.
    private func paged(_ route: String, _ params: [(String, String)], run: Int, group: String, unless: Double = 0) async throws -> (notModified: Bool, list: [JSONValue], version: Double) {
        var list: [JSONValue] = []
        var version = 0.0
        var start = 0
        while true {
            let headers = start == 0 && unless > 0 ? ["if-modified-since-version": JSONText.number(unless)] : [:]
            let page = try await json(route, params + [("limit", String(Self.page)), ("start", String(start))], run: run, group: group, headers: headers)
            if page.notModified { return (true, [], 0) }
            if version == 0 { version = page.version }
            let got = page.body?.array ?? []
            list += got
            start += got.count
            if got.count < Self.page || (page.total.map { Double(start) >= $0 } ?? false) { break }
        }
        return (false, list, version)
    }

    // MARK: sync

    /// Brings the mirror up to the library. One at a time: asked again while one runs, one more runs after it.
    @discardableResult
    public func sync() async -> ZoteroSyncStatus { await startSync().value }

    /// sync() without waiting for it: the status says "syncing" as this returns (JS's sync() runs to its first await
    /// before answering, so zotero-sync's answer already says it).
    @discardableResult
    public func startSync() -> Task<ZoteroSyncStatus, Never> {
        if let running { again = true; return running }
        let run = generation
        state = ("syncing", "", [])
        changed()
        let task = Task { @MainActor in
            var first = true
            repeat {
                self.again = false
                let announced = first
                first = false
                let once = Task { @MainActor in await self.once(announced: announced && run == self.generation) }
                self.current = once
                await once.value
                self.current = nil
            } while self.again
            self.running = nil
            return self.status()
        }
        running = task
        return task
    }

    /// A sync from the clock or a window brought forward: none when one is under way (never two, none queued).
    @discardableResult
    public func autoSync() async -> ZoteroSyncStatus {
        if let running { return await running.value }
        return await startSync().value
    }

    public var isSyncing: Bool { running != nil }

    /// When the last sync ended (ms): this run's, else the mirror's syncedAt, else 0.
    public func lastSyncAt() -> Double {
        if finishedAt > 0 { return finishedAt }
        guard let at = root(), let synced = FileOps.readJSON(join(at, "state.json"))?["syncedAt"]?.string, let t = parseISO(synced) else { return 0 }
        return t
    }

    private func once(announced: Bool = false) async {
        let run = generation
        if !announced {
            state = ("syncing", "", [])
            changed()
        }
        do {
            let problems = try await pullAll(run)
            if run == generation {
                state = problems.mine.isEmpty ? ("idle", "", problems.groups) : ("error", problems.mine, problems.groups)
            }
        } catch {
            if run == generation {
                state = ("error", (error as? ZoteroSyncError)?.message ?? "The Zotero library could not be synced.", [])
            }
        }
        finishedAt = now()
        if run == generation { changed() }
    }

    private func words(_ error: Error) -> String { (error as? ZoteroSyncError)?.message ?? "It could not be synced." }

    /// My Library, then the groups, one after another.
    private func pullAll(_ run: Int) async throws -> (mine: String, groups: [ZoteroProblem]) {
        guard account() != nil else { throw ZoteroSyncError("Zotero is not connected.", code: "signed-out") }
        guard let at = root() else { throw ZoteroSyncError("There is no data folder to keep the library in.", code: "no-root") }
        var out = (mine: "", groups: [ZoteroProblem]())
        do { try await pull(group: "", name: "", root: at, run: run) } catch {
            if let e = error as? ZoteroSyncError, Self.endsAll.contains(e.code) { throw e }
            out.mine = words(error)
        }
        if run != generation { return out }
        var listed: [(id: String, name: String)]?
        do { listed = try await listGroups(run) } catch {
            if let e = error as? ZoteroSyncError, Self.endsGroups.contains(e.code) { throw e }
            out.groups.append(ZoteroProblem(name: "Your groups", error: "The list of your groups could not be had: \(words(error))"))
        }
        guard run == generation, let listed else { return out }
        let ids = Set(listed.map(\.id))
        for group in ZoteroMirror.groupIds(at) where !ids.contains(group) { dropGroup(at, group) }
        for group in listed {
            if run != generation { return out }
            do { try await pull(group: group.id, name: group.name, root: ZoteroMirror.groupDir(at, group.id), run: run) } catch {
                if let e = error as? ZoteroSyncError, Self.endsGroups.contains(e.code) { throw e }
                if let e = error as? ZoteroSyncError, e.code == "forbidden" || (e.code == "http" && e.status == 404) {
                    if run == generation { dropGroup(at, group.id) }
                    continue
                }
                out.groups.append(ZoteroProblem(name: group.name, error: words(error)))
            }
        }
        return out
    }

    /// The groups the person is in (/users/<id>/groups, every page).
    private func listGroups(_ run: Int) async throws -> [(id: String, name: String)] {
        let list = try await paged("/groups", [("format", "json")], run: run, group: "").list
        var out: [(String, String)] = [], seen = Set<String>()
        for entry in list {
            let raw = entry["id"] ?? entry["data"]?["id"]
            let id = raw?.stringish ?? ""
            guard ZoteroMirror.isGroup(id), seen.insert(id).inserted else { continue }
            let name = (entry["data"]?["name"]?.stringish ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            out.append((id, name.isEmpty ? "Group \(id)" : name))
        }
        return out
    }

    /// Deletes a group's mirror (left, or access lost) and stops waiting for its downloads.
    private func dropGroup(_ at: String, _ group: String) {
        if let downloads { for ref in downloads.waiting() where ZoteroMirror.parseRef(ref)?.group == group { downloads.stop(ref) } }
        FileOps.remove(ZoteroMirror.groupDir(at, group))
    }

    /// One library brought up to Zotero's. Its state.json says whose and at which version; another's, or an older
    /// layout's, is started over.
    private func pull(group: String, name: String, root at: String, run: Int) async throws {
        guard let who = account() else { throw ZoteroSyncError("Zotero is not connected.", code: "signed-out") }
        let kept = FileOps.readJSON(join(at, "state.json"))
        let ours = kept?["v"]?.double == Double(Self.version) && kept?["userID"]?.stringish == who.userID && (kept?["groupID"]?.stringish ?? "") == group
        var raw = ours ? ZoteroViews.Raw(FileOps.readJSON(join(at, "raw.json"))) : nil
        var since = 0.0
        if raw != nil { since = kept?["version"]?.numberish ?? 0 } else {
            // None yet, another account's, or an older layout's: from the start. My Library's folder holds the groups'
            // too: they stay, unless the mirror was another account's.
            let other = group.isEmpty && (kept?["userID"]?.truthy ?? false) && kept?["userID"]?.stringish != who.userID
            if !group.isEmpty || other { FileOps.remove(at) } else {
                for name in FileOps.list(at) where name != "groups" { FileOps.remove(join(at, name)) }
            }
            raw = ZoteroViews.Raw()
        }
        var mirror = raw!
        var whose: [String: JSONValue] = ["userID": .string(who.userID)]
        if !group.isEmpty { whose["groupID"] = .string(group); whose["name"] = .string(name.isEmpty ? "Group \(group)" : name) }
        let sinceText = since > 0 ? JSONText.number(since) : "0"

        let collections = try await paged("/collections", [("since", sinceText), ("format", "json")], run: run, group: group, unless: since)
        if collections.notModified {
            if run == generation {
                var state = kept?.object ?? [:]
                for (k, v) in whose { state[k] = v }
                state["syncedAt"] = .string(isoString(now()))
                ZoteroViews.writeJSON(join(at, "state.json"), .object(state))
            }
            return
        }
        let items = try await paged("/items", [("since", sinceText), ("format", "json"), ("includeTrashed", "1")], run: run, group: group)
        let version = collections.version != 0 ? collections.version : items.version
        let deleted = since > 0 ? (try await json("/deleted", [("since", sinceText)], run: run, group: group).body ?? .object([:])) : .object([:])
        let texts = try await json("/fulltext", [("since", sinceText)], run: run, group: group).body ?? .object([:])

        for entry in collections.list {
            guard let data = entry["data"], let key = data["key"]?.string, !key.isEmpty else { continue }
            if data["deleted"]?.truthy ?? false { mirror.collections[key] = nil }
            else { mirror.collections[key] = ["key": .string(key), "name": .string(data["name"]?.stringish ?? ""), "parentCollection": (data["parentCollection"]?.truthy ?? false) ? data["parentCollection"]! : .null] }
        }
        var fresh: [String] = []
        for entry in items.list {
            guard let data = entry["data"], let key = data["key"]?.string, !key.isEmpty else { continue }
            if data["deleted"]?.truthy ?? false { mirror.items[key] = nil; mirror.bib[key] = nil; continue }
            mirror.items[key] = data
            if ZoteroViews.isTop(data) { fresh.append(key) }
        }
        for key in deleted["collections"]?.array ?? [] { mirror.collections[key.stringish] = nil }
        for key in deleted["items"]?.array ?? [] { mirror.items[key.stringish] = nil; mirror.bib[key.stringish] = nil }

        // BibTeX for what is new or changed, in batches (include=bibtex gives each item's own entry, by key).
        var i = 0
        while i < fresh.count {
            let batch = Array(fresh[i..<min(i + Self.keyBatch, fresh.count)])
            let answer = try await json("/items", [("itemKey", batch.joined(separator: ",")), ("format", "json"), ("include", "bibtex")], run: run, group: group)
            for entry in answer.body?.array ?? [] {
                if let key = entry["key"]?.string, let bib = entry["bibtex"]?.string, !bib.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { mirror.bib[key] = bib }
            }
            i += Self.keyBatch
        }

        // What Zotero indexed of the attachments whose text changed, each by itself.
        var fulltext: [String: String] = [:]
        for key in (texts.object ?? [:]).keys.sorted() {
            guard ZoteroMirror.isKey(key), mirror.items[key] != nil else { continue }
            let response = try await request("/items/\(key)/fulltext", run: run, group: group)
            if response.status == 404 { continue }
            guard response.ok else { throw ZoteroSyncError("Zotero answered \(response.status) for an attachment's text.", code: "http", status: response.status) }
            if let content = response.json?["content"]?.string { fulltext[key] = content }
        }

        if run != generation { return }
        let snapshot = mirror
        let count = await Task.detached {
            FileOps.mkdir(at)
            ZoteroViews.writeJSON(join(at, "raw.json"), snapshot.json)
            return ZoteroViews.writeViews(at, snapshot, fulltext: fulltext)
        }.value
        if run != generation { return }
        var state: [String: JSONValue] = ["v": .number(Double(Self.version)), "syncedAt": .string(isoString(now())), "items": .number(Double(count)),
                                          "version": .number(version != 0 ? version : (kept?["version"]?.numberish ?? 0))]
        for (k, v) in whose { state[k] = v }
        ZoteroViews.writeJSON(join(at, "state.json"), .object(state))
    }

    // MARK: attachments

    /// An attachment's file from Zotero's storage → its path under its library's files/<key>/. The redirect to where the
    /// file is kept is followed here, without the key. Throws when there is none to download.
    public func download(_ attachmentKey: String, _ filename: String, group: String = "") async throws -> String {
        guard ZoteroMirror.isKey(attachmentKey) else { throw ZoteroSyncError("That is not a Zotero attachment.", code: "key") }
        guard let base = root() else { throw ZoteroSyncError("There is no data folder to keep the file in.", code: "no-root") }
        let at = ZoteroMirror.libraryRoot(base, group)
        let safe = ZoteroMirror.safeName(filename)
        let target = join(at, "files", attachmentKey, safe.isEmpty ? "\(attachmentKey).pdf" : safe)
        if FileOps.exists(target) { return target }
        var response = try await request("/items/\(attachmentKey)/file", run: generation, file: true, redirect: .manual, group: group)
        var hops = 0
        while response.status >= 300 && response.status < 400 && hops < 5 {
            guard let location = response.header("location"), let next = URL(string: location, relativeTo: URL(string: "\(sources.api)/")),
                  let scheme = next.scheme, scheme == "http" || scheme == "https" else { break }
            // Where the file is kept: never sent the key.
            response = try await http.send(HTTPRequest(url: next.absoluteURL, redirect: .manual, timeout: Self.timeout * 5))
            hops += 1
        }
        if response.status == 404 { throw ZoteroSyncError("Zotero has no copy of this file. Open it in Zotero on the computer that holds it.", code: "no-file") }
        guard response.ok else { throw ZoteroSyncError("Zotero answered \(response.status) for the file.", code: "http") }
        FileOps.mkdir((target as NSString).deletingLastPathComponent)
        try FileOps.write(response.body, to: target)
        return target
    }

    // MARK: clear

    /// Stops a sync under way and deletes the mirror (signing out).
    public func clear() {
        generation += 1
        current?.cancel()
        again = false
        finishedAt = 0
        state = ("idle", "", [])
        downloads?.stopAll()
        if let at = root() { FileOps.remove(at) }
        changed()
    }

    // MARK: free copies, downloads, drops

    /// One finder a library, kept in its own folder; the chip is told by the item's ref.
    func finder(_ group: String = "") -> ZoteroOpenAccess {
        if let held = finders[group] { return held }
        let made = ZoteroOpenAccess(http: http, api: sources.openAlex, semanticScholar: sources.semanticScholar, arxivApi: sources.arxivApi, arxiv: sources.arxiv,
                                    root: { [weak self] in self?.root().map { ZoteroMirror.libraryRoot($0, group) } }, now: now,
                                    timeoutMs: openAccessTimeoutMs ?? ZoteroOA.timeoutMs,
                                    onFinding: { [weak self] key, busy in self?.onFinding(ZoteroMirror.refOf(group, key), busy) })
        finders[group] = made
        return made
    }

    /// The item a ref names, in its library's mirror.
    func itemFor(_ ref: String) -> (item: JSONValue, root: String, group: String)? {
        guard let base = root(), let parsed = ZoteroMirror.parseRef(ref) else { return nil }
        let at = ZoteroMirror.libraryRoot(base, parsed.group)
        guard let item = ZoteroMirror.itemOf(at, parsed.key) else { return nil }
        return (item, at, parsed.group)
    }

    /// Waits for item `ref`'s pdf in the Downloads folder (its chip opened its page in the browser) → whether it does.
    @discardableResult
    public func awaitDownload(_ ref: String) -> Bool {
        guard let downloads, let found = itemFor(ref), ZoteroDownloads.paperLike(found.item) else { return false }
        return downloads.wait(found.item.with("key", .string(ZoteroMirror.refOf(found.group, found.item["key"]?.stringish ?? ""))))
    }

    /// Makes `file` (a pdf dropped on the item's chip) item `ref`'s pdf: copied in as 'added by hand', no title check.
    public func attach(_ ref: String, _ file: String) throws -> ZoteroKeptCopy? {
        guard let found = itemFor(ref) else {
            throw ZoteroSyncError((ZoteroMirror.parseRef(ref)?.group ?? "").isEmpty ? "This item is no longer in your Zotero library." : "This item is no longer in that Zotero group.", code: "missing")
        }
        let copy = try ZoteroOA.saveCopy(found.root, found.item, try ZoteroOA.readPdfFile(file), source: "added by hand", from: file, at: now())
        downloads?.stop(ZoteroMirror.refOf(found.group, found.item["key"]?.stringish ?? ""))
        return copy
    }

    /// Library `group` ('' My Library) as ZoteroMirror reads it, or nil with no data folder.
    public func library(_ group: String = "") -> ZoteroLibraryAccess? {
        guard let base = root(), group.isEmpty || ZoteroMirror.isGroup(group) else { return nil }
        let oa = finder(group)
        return ZoteroLibraryAccess(group: group, name: ZoteroMirror.libraryName(base, group), root: ZoteroMirror.libraryRoot(base, group),
                                   download: { [weak self] key, filename in
                                       guard let self else { throw ZoteroSyncError("Zotero is not connected.", code: "signed-out") }
                                       return try await self.download(key, filename, group: group)
                                   },
                                   openAccess: { item in await oa.find(item) },
                                   storageDir: storageDir)
    }

    /// My Library's free copy of an item.
    public func openAccess(_ item: JSONValue) async -> ZoteroKeptCopy? { await finder("").find(item) }
    public func waitingFor() -> [String] { downloads?.waiting() ?? [] }
    public func stopWatching() { downloads?.stopAll() }
    public func rootPath() -> String? { root() }
}

/// Syncs `library` while the app is open, when `connected()`: every `every` ms, and on focus() (a window back to the
/// front) when the last sync ended over `stale` ms ago. Each through autoSync, so one under way is never doubled.
@MainActor
public final class ZoteroSchedule {
    let library: ZoteroSync
    let connected: () -> Bool
    let stale: Double
    let now: NowMs
    private var timer: DispatchSourceTimer?

    public init(library: ZoteroSync, connected: @escaping () -> Bool, every: Double = ZoteroSync.everyMs, stale: Double = ZoteroSync.staleMs,
                now: @escaping NowMs = systemNow, startClock: Bool = true) {
        self.library = library; self.connected = connected; self.stale = stale; self.now = now
        if startClock {
            let t = DispatchSource.makeTimerSource(queue: .main)
            t.schedule(deadline: .now() + every / 1000, repeating: every / 1000)
            t.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.tick() } }
            t.resume()
            timer = t
        }
    }

    /// The clock's tick (also called by tests).
    public func tick() { if connected() { Task { @MainActor in await library.autoSync() } } }

    public func focus() { if connected() && now() - library.lastSyncAt() > stale { tick() } }

    public func stop() { timer?.cancel(); timer = nil }
}
