import Foundation
import EngelbartCore

// src/main/zotero/oa.cjs (MATH-65 build 3–4): a free copy of a Zotero item that has no pdf of its own. For an item with a
// DOI, OpenAlex is asked (no key) for the pdf addresses it knows (best_oa_location first, then each location), tried in
// that order; the first that really is a pdf (Content-Type application/pdf and a body starting %PDF) is kept, a
// publisher's page (a sign-in, a bot check) passed over. When none is, Semantic Scholar (its openAccessPdf, passed over
// when only the doi.org link), then arXiv (the id Semantic Scholar names, else a title search whose entry's title
// closely matches), downloaded from <arxiv>/pdf/<id>. The copy goes to <mirror>/files/<itemKey>/<first author year short
// title>.pdf and where it came from to <mirror>/items/<itemKey>/open-access.json:
//   { v, found: true, source: 'OpenAlex' | 'Semantic Scholar' | 'arXiv', url, file, checkedAt }
//   { v, found: true, source: 'downloaded in browser' | 'added by hand', from, file, checkedAt }   (build 4)
//   { v, found: false, sources, checkedAt, until }   none from `sources`: not asked again for 7 days
// Asked only when the item is mentioned to Bart or its chip is clicked, never in a sync. A source that cannot be reached
// (or answers 429), or a pdf address that times out, with no copy found: nothing written, the item left alone for an hour
// in memory. Nothing here throws, logs, or writes back to Zotero.

/// A copy kept for an item (keptCopy): `source` 'open access' (found through `via`), 'downloaded in browser' or
/// 'added by hand' (`from` the file it was copied from).
public struct ZoteroKeptCopy: Equatable, Sendable {
    public var path: String
    public var url: String
    public var foundAt: String
    public var source: String
    public var via: String
    public var from: String?
}

public enum ZoteroOA {
    public static let openAlex = "https://api.openalex.org"
    public static let semanticScholar = "https://api.semanticscholar.org"
    public static let arxivApi = "https://export.arxiv.org"
    public static let arxiv = "https://arxiv.org"
    public static let sources = ["OpenAlex", "Semantic Scholar", "arXiv"]
    static let kinds: Set<String> = ["downloaded in browser", "added by hand"]
    public static let timeoutMs: Double = 15_000
    public static let bodyTimeoutMs: Double = 90_000
    public static let maxBytes = 200 * 1024 * 1024
    public static let missMs: Double = 7 * 24 * 60 * 60_000
    public static let unreachedMs: Double = 60 * 60_000
    static let maxCandidates = 8
    static let version = 1
    static let record = "open-access.json"
    static let arxivIdRE = re("^(\\d{4}\\.\\d{4,5}|[a-z-]+(\\.[A-Z]{2})?/\\d{7})(v\\d+)?$", .caseInsensitive)

    /// An item's DOI as OpenAlex takes it ("10.…"), from "https://doi.org/10.…", "doi:10.…" or itself; '' when none.
    public static func cleanDoi(_ value: String?) -> String {
        var doi = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        doi = re("^https?://(dx\\.)?doi\\.org/", .caseInsensitive).replace(doi, with: "")
        doi = re("^doi:\\s*", .caseInsensitive).replace(doi, with: "")
        return re("^10\\.\\d+(\\.\\d+)*/\\S+$").test(doi) ? doi : ""
    }

    /// "Smith 2020 Learning to Learn.pdf": first author's last name, the year, the title up to its colon (8 words at most).
    public static func pdfName(_ item: JSONValue) -> String {
        let creators = item["creators"]?.array ?? []
        let first = creators.first { $0["type"]?.string == "author" } ?? creators.first
        var last = ""
        if let first {
            let l = first["last"]?.string ?? ""
            last = !l.isEmpty ? l : ((first["name"]?.stringish ?? "").trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: { $0.isWhitespace }).last.map(String.init) ?? "")
        }
        let titleText = item["title"]?.stringish ?? ""
        let head = re("[:?!.]\\s").firstMatch(in: titleText, range: NSRange(titleText.startIndex..., in: titleText)).map { (titleText as NSString).substring(to: $0.range.location) } ?? titleText
        let title = head.split(whereSeparator: { $0.isWhitespace }).prefix(8).joined(separator: " ")
        var name = [last, item["year"]?.stringish ?? "", title].filter { !$0.isEmpty }.joined(separator: " ")
        name = re("[\\x00-\\x1f\\x7f/\\\\:*?\"<>|]").replace(name, with: " ")
        name = re("\\s+").replace(name, with: " ").trimmingCharacters(in: .whitespaces)
        name = jsSlice(name, 80).trimmingCharacters(in: .whitespaces)
        let key = item["key"]?.stringish ?? ""
        return "\(name.isEmpty ? (key.isEmpty ? "paper" : key) : name).pdf"
    }

    /// The pdf addresses an OpenAlex work names, best first, each once, at most 8.
    public static func candidates(_ work: JSONValue?) -> [String] {
        var out: [String] = []
        let add = { (location: JSONValue?) in
            let url = (location?["pdf_url"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if re("^https?://", .caseInsensitive).test(url) && !out.contains(url) { out.append(url) }
        }
        if let work {
            add(work["best_oa_location"])
            for location in work["locations"]?.array ?? [] { add(location) }
        }
        return Array(out.prefix(maxCandidates))
    }

    /// Semantic Scholar's pdf address for a paper, or none: a doi.org link is only the publisher's page again.
    public static func scholarCandidates(_ paper: JSONValue?) -> [String] {
        let url = (paper?["openAccessPdf"]?["url"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !re("^https?://", .caseInsensitive).test(url) || re("^https?://(dx\\.)?doi\\.org/", .caseInsensitive).test(url) { return [] }
        return [url]
    }

    /// An arXiv id ("2101.00001", "cs/0112017") from "arXiv:2101.00001v2", an abs or pdf address, or itself; '' when none.
    public static func arxivId(_ value: String?) -> String {
        var id = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        id = re("^arxiv:\\s*", .caseInsensitive).replace(id, with: "")
        id = re("^https?://(export\\.)?arxiv\\.org/(abs|pdf)/", .caseInsensitive).replace(id, with: "")
        id = re("\\.pdf$", .caseInsensitive).replace(id, with: "")
        return arxivIdRE.test(id) ? re("v\\d+$", .caseInsensitive).replace(id, with: "") : ""
    }

    /// A title's words, for comparing two titles: case, forms, punctuation and spacing put aside.
    public static func titleWords(_ title: String?) -> [String] {
        var s = (title ?? "").precomposedStringWithCompatibilityMapping.lowercased()
        s = re("<[^>]+>").replace(s, with: " ")
        s = re("[^\\p{L}\\p{N}]+").replace(s, with: " ")
        return s.trimmingCharacters(in: .whitespaces).split(separator: " ").map(String.init).filter { !$0.isEmpty }
    }

    /// Whether two titles name the same paper: the same words, or (four words or more) a Dice coefficient ≥ 0.9.
    public static func closeTitle(_ a: String?, _ b: String?) -> Bool {
        let x = titleWords(a), y = titleWords(b)
        if x.isEmpty || y.isEmpty { return false }
        if x.joined(separator: " ") == y.joined(separator: " ") { return true }
        if min(x.count, y.count) < 4 { return false }
        var left: [String: Int] = [:]
        for word in x { left[word, default: 0] += 1 }
        var shared = 0
        for word in y { if let n = left[word], n > 0 { shared += 1; left[word] = n - 1 } }
        return Double(2 * shared) / Double(x.count + y.count) >= 0.9
    }

    static func unxml(_ text: String?) -> String {
        var s = (text ?? "").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&apos;", with: "'")
        s = replaceMatches(re("&#(\\d+);"), in: s) { g in (Int(g[1] ?? "").flatMap(UnicodeScalar.init).map { String(Character($0)) }) ?? (g[0] ?? "") }
        return s.replacingOccurrences(of: "&amp;", with: "&")
    }

    /// The entries of an arXiv API answer (Atom) → [(id, title)].
    public static func arxivEntries(_ xml: String?) -> [(id: String, title: String)] {
        var out: [(String, String)] = []
        for m in re("<entry>([\\s\\S]*?)</entry>").allGroups(xml ?? "") {
            let entry = m[1] ?? ""
            let id = arxivId(unxml(re("<id>([\\s\\S]*?)</id>").groups(entry)?[1] ?? nil))
            let title = re("\\s+").replace(unxml(re("<title>([\\s\\S]*?)</title>").groups(entry)?[1] ?? nil), with: " ").trimmingCharacters(in: .whitespaces)
            if !id.isEmpty { out.append((id, title)) }
        }
        return out
    }

    /// The copy kept for an item, or nil (none, or its file is gone).
    public static func keptCopy(_ root: String?, _ key: String) -> ZoteroKeptCopy? {
        guard let root, ZoteroMirror.isKey(key), let record = FileOps.readJSON(join(root, "items", key, Self.record)),
              record["found"]?.truthy == true, let file = record["file"]?.string, FileOps.isFile(file) else { return nil }
        let via = record["source"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "OpenAlex"
        let kind = kinds.contains(via) ? via : "open access"
        return ZoteroKeptCopy(path: file, url: record["url"]?.stringish ?? "", foundAt: record["checkedAt"]?.stringish ?? "", source: kind, via: via,
                              from: kind != "open access" ? (record["from"]?.stringish ?? "") : nil)
    }

    /// Keeps `bytes` (a pdf) as `item`'s copy and records where it came from. → keptCopy's answer; throws when the mirror
    /// cannot be written.
    @discardableResult
    public static func saveCopy(_ root: String, _ item: JSONValue, _ bytes: Data, source: String, url: String = "", from: String = "", at: Double) throws -> ZoteroKeptCopy? {
        let key = item["key"]?.stringish ?? ""
        let file = join(root, "files", key, pdfName(item))
        FileOps.mkdir((file as NSString).deletingLastPathComponent)
        try FileOps.write(bytes, to: file)
        let checkedAt = isoString(at)
        var record: [String: JSONValue] = ["v": .number(Double(version)), "source": .string(source), "found": true, "file": .string(file), "checkedAt": .string(checkedAt)]
        if kinds.contains(source) { record["from"] = .string(from) } else { record["url"] = .string(url) }
        let recordPath = join(root, "items", key, Self.record)
        FileOps.mkdir((recordPath as NSString).deletingLastPathComponent)
        try FileOps.write(JSONText.stringify(.object(record), indent: 1) + "\n", to: recordPath)
        return keptCopy(root, key)
    }

    public struct PdfError: Error, LocalizedError, Equatable {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// The bytes of `file` when it is a pdf (starts with %PDF); throws with words to show otherwise.
    public static func readPdfFile(_ file: String) throws -> Data {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file) else { throw PdfError(message: "That file could not be read.") }
        guard (attributes[.type] as? FileAttributeType) == .typeRegular else { throw PdfError(message: "That is not a file.") }
        if ((attributes[.size] as? NSNumber)?.intValue ?? 0) > maxBytes { throw PdfError(message: "That PDF is too large.") }
        guard let bytes = FileManager.default.contents(atPath: file) else { throw PdfError(message: "That file could not be read.") }
        guard bytes.prefix(4) == Data("%PDF".utf8) else { throw PdfError(message: "That file is not a PDF.") }
        return bytes
    }
}

/// One library's finder of free copies (createOpenAccess). `root()`: the library's mirror folder; `onFinding(key, busy)`
/// as a lookup starts and ends (the chip says "Finding a free copy…").
@MainActor
public final class ZoteroOpenAccess {
    let http: HTTPClient
    let api: String
    let semanticScholar: String
    let arxivApi: String
    let arxiv: String
    let root: () -> String?
    let now: NowMs
    let timeoutMs: Double
    let bodyTimeoutMs: Double
    let onFinding: (String, Bool) -> Void
    private var running: [String: Task<ZoteroKeptCopy?, Never>] = [:]
    private var unreached: [String: Double] = [:]

    public init(http: HTTPClient = URLSessionHTTPClient.shared, api: String = ZoteroOA.openAlex, semanticScholar: String = ZoteroOA.semanticScholar,
                arxivApi: String = ZoteroOA.arxivApi, arxiv: String = ZoteroOA.arxiv, root: @escaping () -> String?, now: @escaping NowMs = systemNow,
                timeoutMs: Double = ZoteroOA.timeoutMs, bodyTimeoutMs: Double = ZoteroOA.bodyTimeoutMs, onFinding: @escaping (String, Bool) -> Void = { _, _ in }) {
        self.http = http; self.api = api; self.semanticScholar = semanticScholar; self.arxivApi = arxivApi; self.arxiv = arxiv
        self.root = root; self.now = now; self.timeoutMs = timeoutMs; self.bodyTimeoutMs = bodyTimeoutMs; self.onFinding = onFinding
    }

    struct Unreached: Error {}

    private func get(_ url: String, accept: String, maxBytes: Int? = nil) async throws -> HTTPResponse {
        guard let target = URL(string: url) else { throw Unreached() }
        return try await http.send(HTTPRequest(url: target, headers: ["accept": accept, "user-agent": "Engelbart"], redirect: .follow,
                                               timeout: timeoutMs / 1000, bodyTimeout: max(timeoutMs, bodyTimeoutMs) / 1000, maxBytes: maxBytes))
    }

    /// A source's answer at `url`: its body, nil (404/400: it has none), or throws (not reached).
    private func ask(_ url: String, json: Bool = true) async throws -> JSONValue? {
        let response = try await get(url, accept: json ? "application/json" : "application/atom+xml")
        if response.status == 404 || response.status == 400 { return nil }
        if !response.ok { throw Unreached() }
        if json { guard let value = response.json else { throw Unreached() }; return value }
        return .string(response.text)
    }

    private func doiPath(_ doi: String) -> String { doi.split(separator: "/", omittingEmptySubsequences: false).map { encodeURIComponent(String($0)) }.joined(separator: "/") }

    private func arxivByTitle(_ title: String) async throws -> String {
        let mainSplit = re(":\\s").firstMatch(in: title, range: NSRange(title.startIndex..., in: title)).map { (title as NSString).substring(to: $0.range.location) } ?? title
        let head = ZoteroOA.titleWords(mainSplit)
        let words = Array((head.count >= 3 ? head : ZoteroOA.titleWords(title)).prefix(20))
        if words.isEmpty { return "" }
        let query = queryString([("search_query", "ti:\"\(words.joined(separator: " "))\""), ("start", "0"), ("max_results", "10")])
        let entries = ZoteroOA.arxivEntries(try await ask("\(arxivApi)/api/query?\(query)", json: false)?.string)
        return entries.first { ZoteroOA.closeTitle($0.title, title) }?.id ?? ""
    }

    enum PdfAnswer { case bytes(Data), notPdf, unreached }

    private func pdfAt(_ url: String) async -> PdfAnswer {
        let response: HTTPResponse
        do { response = try await get(url, accept: "application/pdf", maxBytes: ZoteroOA.maxBytes) } catch {
            if let e = error as? HTTPError, e == .tooLarge { return .notPdf }
            return .unreached
        }
        let type = (response.header("content-type") ?? "").lowercased()
        if !response.ok || !type.hasPrefix("application/pdf") { return response.status >= 500 || response.status == 429 ? .unreached : .notPdf }
        if Int(response.header("content-length") ?? "") ?? 0 > ZoteroOA.maxBytes { return .notPdf }
        return response.body.count <= ZoteroOA.maxBytes && response.body.prefix(4) == Data("%PDF".utf8) ? .bytes(response.body) : .notPdf
    }

    private func lookup(_ at: String, _ item: JSONValue, _ doi: String) async -> ZoteroKeptCopy? {
        var tried = Set<String>()
        var missed = false
        let key = item["key"]?.stringish ?? ""
        enum Kept { case copy(ZoteroKeptCopy?), none }
        func first(_ urls: [String], _ source: String) async -> Kept {
            for url in urls {
                if !tried.insert(url).inserted { continue }
                switch await pdfAt(url) {
                case .unreached: missed = true; continue
                case .notPdf: continue
                case .bytes(let bytes):
                    do { return .copy(try ZoteroOA.saveCopy(at, item, bytes, source: source, url: url, at: now())) } catch { return .copy(nil) }
                }
            }
            return .none
        }
        func reach<T>(_ step: () async throws -> T?) async -> T? {
            do { return try await step() } catch { missed = true; return nil }
        }
        let work: JSONValue? = await reach { try await self.ask("\(self.api)/works/doi:\(self.doiPath(doi))") }
        if case .copy(let copy) = await first(ZoteroOA.candidates(work), "OpenAlex") { return copy }
        let paper: JSONValue? = await reach { try await self.ask("\(self.semanticScholar)/graph/v1/paper/DOI:\(self.doiPath(doi))?fields=openAccessPdf,externalIds") }
        if case .copy(let copy) = await first(ZoteroOA.scholarCandidates(paper), "Semantic Scholar") { return copy }
        var id = ZoteroOA.arxivId(paper?["externalIds"]?["ArXiv"]?.stringish)
        if id.isEmpty, let title = item["title"]?.string, !title.isEmpty { id = await reach { try await self.arxivByTitle(title) } ?? "" }
        if !id.isEmpty, case .copy(let copy) = await first(["\(arxiv)/pdf/\(id)"], "arXiv") { return copy }
        if missed { unreached[key] = now() + ZoteroOA.unreachedMs; return nil }
        let record: JSONValue = ["v": .number(Double(ZoteroOA.version)), "found": false, "sources": .array(ZoteroOA.sources.map { .string($0) }),
                                 "checkedAt": .string(isoString(now())), "until": .string(isoString(now() + ZoteroOA.missMs))]
        let path = join(at, "items", key, ZoteroOA.record)
        FileOps.mkdir((path as NSString).deletingLastPathComponent)
        try? FileOps.write(JSONText.stringify(record, indent: 1) + "\n", to: path)
        return nil
    }

    /// A free copy of `item` (an items.json entry): the one kept, else found now. nil when there is none; never throws.
    public func find(_ item: JSONValue) async -> ZoteroKeptCopy? {
        guard let at = root(), let key = item["key"]?.string, ZoteroMirror.isKey(key) else { return nil }
        if let kept = ZoteroOA.keptCopy(at, key) { return kept }
        let doi = ZoteroOA.cleanDoi(item["doi"]?.stringish)
        if doi.isEmpty { return nil }
        if (unreached[key] ?? 0) > now() { return nil }
        if let missed = FileOps.readJSON(join(at, "items", key, ZoteroOA.record)), missed["found"]?.bool == false {
            let sources = (missed["sources"]?.array ?? []).map(\.stringish)
            let asked = ZoteroOA.sources.allSatisfy { sources.contains($0) }
            if asked, let until = missed["until"]?.string.flatMap(parseISO), until > now() { return nil }
        }
        if let under = running[key] { return await under.value }
        onFinding(key, true)
        let task = Task { @MainActor in await self.lookup(at, item, doi) }
        running[key] = task
        let found = await task.value
        running[key] = nil
        onFinding(key, false)
        return found
    }

    public func kept(_ key: String) -> ZoteroKeptCopy? { ZoteroOA.keptCopy(root(), key) }
}
