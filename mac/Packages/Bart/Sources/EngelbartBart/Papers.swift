import Foundation
import EngelbartDoc
import EngelbartCore

// papers.cjs — @discover's paper tools (2026-09-30): resolve, references, citations, author_works, related and search,
// over OpenAlex (api.openalex.org), which answers without a key. Served to either CLI by `--mcp papers` (PapersMCP).
// Nothing here reads or writes the disk, and nothing of the person's is sent: only what the agent looks up.
//
// OpenAlex prices each call against a small daily allowance for callers without a key ($0.10 a day; a record by its id
// is free, a filtered list $0.0001, a search $0.001), so the tools prefer lookups by id and filters to searches.
// 2026-10-15: search finds starting points by meaning (search.semantic), at most one call a second; with OPENALEX_API_KEY
// the allowance is $1 a day. by "words" is the search of before.

public struct PapersError: Error, LocalizedError, Equatable {
    public let message: String
    public let status: Int?
    public init(_ message: String, status: Int? = nil) { self.message = message; self.status = status }
    public var errorDescription: String? { message }
}

/// One HTTP GET: (status, body). Injected in tests; URLSession in the app.
public typealias PapersFetch = @Sendable (_ url: URL, _ accept: String) async throws -> (status: Int, body: Data)

public final class Papers: @unchecked Sendable {
    public static let api = "https://api.openalex.org"
    static let arxivAPI = "https://export.arxiv.org/api/query"
    static let timeout: TimeInterval = 20
    public static let maxList = 100
    static let semanticGapMs: Double = 1100
    static let semanticMaxChars = 2000
    static let listFields = "id,title,publication_year,authorships,primary_location,doi,cited_by_count,type"
    static let fullFields = "\(listFields),abstract_inverted_index,best_oa_location,open_access,locations,referenced_works_count,referenced_works,related_works"
    static let doiRE = JSRegex("^(?:https?://(?:dx\\.)?doi\\.org/|doi:\\s*)?(10\\.\\d{4,9}/\\S+)$", "i")
    static let arxivRE = JSRegex("^(?:https?://(?:www\\.)?arxiv\\.org/(?:abs|pdf)/|arxiv:\\s*)?((?:\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[A-Z]{2})?/\\d{7}))(?:v\\d+)?(?:\\.pdf)?$", "i")
    static let workRE = JSRegex("^(?:https?://openalex\\.org/)?(W\\d+)$", "i")
    static let authorRE = JSRegex("^(?:https?://openalex\\.org/)?(A\\d+)$", "i")

    let fetch: PapersFetch
    let wait: @Sendable (Double) async -> Void
    let now: @Sendable () -> Double
    let apiKey: String?
    let semanticGate = SemanticGate()

    public static let urlSessionFetch: PapersFetch = { url, accept in
        var request = URLRequest(url: url, timeoutInterval: Papers.timeout)
        request.setValue("Engelbart (research desktop app)", forHTTPHeaderField: "user-agent")
        request.setValue(accept, forHTTPHeaderField: "accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    public init(fetch: @escaping PapersFetch = Papers.urlSessionFetch, wait: @escaping @Sendable (Double) async -> Void = { ms in try? await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000)) },
                now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }, apiKey: String? = nil) {
        self.fetch = fetch; self.wait = wait; self.now = now; self.apiKey = apiKey
    }

    static func short(_ id: JSONValue?) -> String { JSRegex("^https?://openalex\\.org/").replace(Activity.textOf(id ?? .null) ?? "", with: "") }
    static func bareDoi(_ doi: JSONValue?) -> JSONValue {
        guard let d = doi?.string, !d.isEmpty else { return .null }
        return .string(JSRegex("^https?://(?:dx\\.)?doi\\.org/", "i").replace(d, with: ""))
    }

    /// OpenAlex keeps an abstract as word → positions; this puts the words back in order.
    public static func abstractOf(_ index: JSONValue?) -> JSONValue {
        guard let o = index?.object else { return .null }
        var words: [Int: String] = [:]
        for (word, places) in o { for at in places.array ?? [] { if let n = at.double, n == n.rounded(), n >= 0, n < 20000 { words[Int(n)] = word } } }
        let text = words.keys.sorted().compactMap { words[$0] }.filter { !$0.isEmpty }.joined(separator: " ").squashedSpaces
        return text.isEmpty ? .null : .string(text.jsSlice(0, 4000))
    }

    static func authorsOf(_ work: JSONValue, _ max: Int) -> JSONValue {
        let names = (work["authorships"]?.array ?? []).compactMap { $0["author"]?["display_name"]?.string }.filter { !$0.isEmpty }
        let shown = names.count > max ? Array(names.prefix(max)) + ["et al. (\(names.count) authors)"] : names
        return .array(shown.map { .string($0) })
    }

    static func venueOf(_ work: JSONValue) -> JSONValue {
        let p = work["primary_location"]
        if let s = p?["source"]?["display_name"]?.string, !s.isEmpty { return .string(s) }
        if let s = p?["raw_source_name"]?.string, !s.isEmpty { return .string(s) }
        return .null
    }

    static func arxivOf(_ work: JSONValue) -> JSONValue {
        for place in work["locations"]?.array ?? [] {
            if let m = JSRegex("arxiv\\.org/abs/([^?#\\s]+)", "i").match(place["landing_page_url"]?.string ?? "") {
                return .string("https://arxiv.org/abs/\(JSRegex("v\\d+$").replace(m[1]!, with: ""))")
            }
        }
        if let doi = bareDoi(work["doi"]).string, let m = JSRegex("^10\\.48550/arxiv\\.(.+)$", "i").match(doi) { return .string("https://arxiv.org/abs/\(m[1]!)") }
        return .null
    }

    static func openAccessOf(_ work: JSONValue) -> JSONValue {
        let best = work["best_oa_location"]
        if let u = best?["pdf_url"]?.string, !u.isEmpty { return .string(u) }
        for place in work["locations"]?.array ?? [] { if place["is_oa"]?.bool == true, let u = place["pdf_url"]?.string, !u.isEmpty { return .string(u) } }
        if work["open_access"]?["is_oa"]?.bool == true, let u = work["open_access"]?["oa_url"]?.string, !u.isEmpty { return .string(u) }
        if let u = best?["landing_page_url"]?.string, !u.isEmpty { return .string(u) }
        return .null
    }

    static func num(_ v: JSONValue?) -> JSONValue { (v?.double).map { $0 == 0 ? 0 : .number($0) } ?? 0 }
    static func orNull(_ v: JSONValue?) -> JSONValue {
        switch v { case .string(let s)? where !s.isEmpty: return .string(s); case .number(let n)? where n != 0: return .number(n); default: return .null }
    }

    /// An OpenAlex work as a list shows it.
    public static func listRecord(_ work: JSONValue) -> OJ {
        let title = work["title"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "(untitled)"
        return ["id": .string(short(work["id"])), "title": .string(title), "authors": OJ(authorsOf(work, 3)), "year": OJ(orNull(work["publication_year"])),
                "venue": OJ(venueOf(work)), "type": OJ(orNull(work["type"])), "doi": OJ(bareDoi(work["doi"])), "cited_by": OJ(num(work["cited_by_count"]))]
    }

    /// An OpenAlex work in full: what resolve returns.
    public static func fullRecord(_ work: JSONValue) -> OJ {
        var r = listRecord(work).setting("authors", OJ(authorsOf(work, 12)))
        r = r.setting("abstract", OJ(abstractOf(work["abstract_inverted_index"])))
            .setting("open_access", OJ(openAccessOf(work)))
            .setting("arxiv", OJ(arxivOf(work)))
            .setting("doi_url", OJ(orNull(work["doi"])))
            .setting("references", OJ(num(work["referenced_works_count"])))
            .setting("openalex", OJ(orNull(work["id"])))
        return r
    }

    func get(_ url: URL, json: Bool = true) async throws -> JSONValue? {
        var attempt = 0
        while true {
            defer { attempt += 1 }
            let response: (status: Int, body: Data)
            do { response = try await fetch(url, json ? "application/json" : "*/*") }
            catch {
                if attempt == 0 { await wait(1500); continue }
                throw PapersError("OpenAlex could not be reached (\(error.localizedDescription.components(separatedBy: "\n")[0])).")
            }
            if response.status == 404 { return nil }
            if (response.status == 429 || response.status >= 500) && attempt == 0 { await wait(1500); continue }
            if response.status == 429 { throw PapersError("OpenAlex refused the call: the daily allowance for callers without a key is used up, or too many calls came at once.") }
            if !(200...299).contains(response.status) { throw PapersError("OpenAlex answered \(response.status).", status: response.status) }
            if !json { return .string(String(decoding: response.body, as: UTF8.self)) }
            return try JSONValue.parse(response.body)
        }
    }

    func apiCall(_ route: String, _ params: [(String, String?)] = []) async throws -> JSONValue? {
        var c = URLComponents(string: "\(Papers.api)\(route)")!
        var items: [URLQueryItem] = []
        for (k, v) in params { if let v, !v.isEmpty { items.append(URLQueryItem(name: k, value: v)) } }
        if let apiKey { items.append(URLQueryItem(name: "api_key", value: apiKey)) }
        if !items.isEmpty { c.queryItems = items }
        // URLSearchParams encodes as application/x-www-form-urlencoded: spaces as +, and : , | encoded.
        c.percentEncodedQuery = items.map { "\(formEncode($0.name))=\(formEncode($0.value ?? ""))" }.joined(separator: "&")
        return try await get(c.url!)
    }

    func work(_ id: String) async throws -> JSONValue? { try await apiCall("/works/\(id)", [("select", Papers.fullFields)]) }

    func list(_ filter: String?, sort: String? = nil, limit: Int, search: String? = nil, semantic: String? = nil) async throws -> (total: Int, results: [OJ]) {
        let page = try await apiCall("/works", [("filter", filter), ("sort", sort), ("search", search), ("search.semantic", semantic), ("per_page", String(min(Papers.maxList, limit))), ("select", Papers.listFields)])
        return (page?["meta"]?["count"]?.int ?? 0, (page?["results"]?.array ?? []).map(Papers.listRecord))
    }

    /// Semantic calls at least SEMANTIC_GAP_MS apart, in the order they were asked.
    func spaced<T>(_ call: @escaping @Sendable () async throws -> T) async throws -> T {
        let box = SpacedBox<T>()
        let gap = Papers.semanticGapMs, clock = now, pause = wait
        let task = await semanticGate.enqueue {
            let wanted = await self.semanticGate.last() + gap - clock()
            if wanted > 0 { await pause(wanted) }
            await self.semanticGate.mark(clock())
            do { box.result = .success(try await call()) } catch { box.result = .failure(error) }
        }
        await task.value
        return try box.result!.get()
    }

    func byIds(_ ids: [String]) async throws -> [OJ] {
        var out: [String: OJ] = [:]
        var n = 0
        while n < ids.count {
            let chunk = Array(ids[n..<min(ids.count, n + 50)])
            let page = try await apiCall("/works", [("filter", "openalex:\(chunk.joined(separator: "|"))"), ("per_page", "50"), ("select", Papers.listFields)])
            for one in page?["results"]?.array ?? [] { out[Papers.short(one["id"])] = Papers.listRecord(one) }
            n += 50
        }
        return ids.compactMap { out[$0] }
    }

    static func clean(_ text: String?) -> String { JSRegex("[,|:]", "g").replace(text ?? "", with: " ").squashedSpaces }
    static func years(_ from: Int?, _ until: Int?) -> [String] {
        [from.map { "from_publication_date:\($0)-01-01" }, until.map { "to_publication_date:\($0)-12-31" }].compactMap { $0 }
    }
    static func count(_ value: Int?, _ fallback: Int, _ max: Int = maxList) -> Int { Swift.max(1, Swift.min(max, value ?? fallback)) }

    /// A DOI, an arXiv id or address, an OpenAlex id, or a title → the one work it names, in full, or nil.
    func findWork(_ query: String?) async throws -> JSONValue? {
        let text = (query ?? "").jsTrim
        if text.isEmpty { throw PapersError("Give a DOI, an arXiv id or a title.") }
        if let m = Papers.workRE.match(text) { return try await work(m[1]!.uppercased()) }
        if let m = Papers.doiRE.match(text) { return try await work("doi:\(JSRegex("[.,;]+$").replace(m[1]!, with: ""))") }
        if let m = Papers.arxivRE.match(text) {
            if let byDoi = try await work("doi:10.48550/arxiv.\(m[1]!)") { return byDoi }
            // Not every arXiv paper has its DataCite DOI in OpenAlex: its title, from arXiv, finds it.
            let feed = try? await get(URL(string: "\(Papers.arxivAPI)?id_list=\(encodeURIComponent(m[1]!))")!, json: false)
            guard let title = JSRegex("<entry>[\\s\\S]*?<title>([\\s\\S]*?)</title>").match((feed ?? nil)?.string ?? "")?[1] else { return nil }
            return try await findWork(title.squashedSpaces)
        }
        let hits = try await apiCall("/works", [("filter", "title.search:\(Papers.clean(text))"), ("per_page", "5"), ("select", "id,title,cited_by_count")])
        let results = hits?["results"]?.array ?? []
        if results.isEmpty { return nil }
        func plain(_ v: String?) -> String { JSRegex("[^a-z0-9]+", "g").replace((v ?? "").lowercased(), with: " ").jsTrim }
        let exact = results.filter { plain($0["title"]?.string) == plain(text) }
        let pool = exact.isEmpty ? results : exact
        let pick = pool.enumerated().sorted { a, b in
            let ca = a.element["cited_by_count"]?.double ?? 0, cb = b.element["cited_by_count"]?.double ?? 0
            return ca != cb ? ca > cb : a.offset < b.offset
        }[0].element
        return try await work(Papers.short(pick["id"]))
    }

    func need(_ id: String?) async throws -> JSONValue {
        guard let found = try await findWork(id) else { throw PapersError("No paper was found for \(jsonQuote(String((id ?? "").prefix(200)))).") }
        return found
    }

    // MARK: the tools

    public func resolve(query: String?) async throws -> OJ {
        if let found = try await findWork(query) { return ["found": true, "paper": Papers.fullRecord(found)] }
        return ["found": false, "query": .string((query ?? "").jsSlice(0, 200))]
    }

    public func references(id: String?, limit: Int?) async throws -> OJ {
        let paper = try await need(id)
        let all = (paper["referenced_works"]?.array ?? []).map { Papers.short($0) }
        let records = try await byIds(all).enumerated().sorted { a, b in
            let ca = a.element["cited_by"]?.double ?? 0, cb = b.element["cited_by"]?.double ?? 0
            return ca != cb ? ca > cb : a.offset < b.offset
        }.map { $0.element }.prefix(Papers.count(limit, Papers.maxList))
        return ["of": Papers.listRecord(paper), "total": .number(Double(all.count)), "listed": .number(Double(records.count)), "order": "most cited first", "results": .array(Array(records))]
    }

    public func citations(id: String?, limit: Int?, sort: String? = "recent", fromYear: Int? = nil) async throws -> OJ {
        let paper = try await need(id)
        let cited = sort == "cited"
        let out = try await list((["cites:\(Papers.short(paper["id"]))"] + Papers.years(fromYear, nil)).joined(separator: ","), sort: cited ? "cited_by_count:desc" : "publication_date:desc", limit: Papers.count(limit, 25))
        return ["of": Papers.listRecord(paper), "total": .number(Double(out.total)), "order": .string(cited ? "most cited first" : "most recent first"), "results": .array(out.results)]
    }

    public func related(id: String?, limit: Int?) async throws -> OJ {
        let paper = try await need(id)
        let ids = (paper["related_works"]?.array ?? []).map { Papers.short($0) }.prefix(Papers.count(limit, 10, 25))
        return ["of": Papers.listRecord(paper), "results": .array(try await byIds(Array(ids))), "about": "OpenAlex's related works: papers that share its concepts and were published near it."]
    }

    public func authorWorks(author: String?, limit: Int?, sort: String? = "cited") async throws -> OJ {
        let text = (author ?? "").jsTrim
        if text.isEmpty { throw PapersError("Give an author's name or OpenAlex id.") }
        var people: [JSONValue]
        if let m = Papers.authorRE.match(text) { people = (try await apiCall("/authors/\(m[1]!.uppercased())")).map { [$0] } ?? [] }
        else { people = (try await apiCall("/authors", [("search", text), ("per_page", "5")]))?["results"]?.array ?? [] }
        guard let person = people.first else { return ["found": false, "author": .string(text.jsSlice(0, 200))] }
        func describe(_ one: JSONValue) -> OJ {
            let inst = one["last_known_institutions"]?.array?.first?["display_name"]?.string
            return ["id": .string(Papers.short(one["id"])), "name": OJ(one["display_name"] ?? .null), "works": OJ(Papers.num(one["works_count"])),
                    "cited_by": OJ(Papers.num(one["cited_by_count"])), "institution": inst.flatMap { $0.isEmpty ? nil : OJ.string($0) } ?? .null]
        }
        let recent = sort == "recent"
        let out = try await list("author.id:\(Papers.short(person["id"]))", sort: recent ? "publication_date:desc" : "cited_by_count:desc", limit: Papers.count(limit, 25))
        return ["found": true, "author": describe(person), "others_with_that_name": .array(people.dropFirst().map(describe)), "total": .number(Double(out.total)),
                "order": .string(recent ? "most recent first" : "most cited first"), "results": .array(out.results)]
    }

    /// By meaning (the default): the problem in plain sentences, closest first; OpenAlex refusing it (a 4xx but 429)
    /// falls back to words, and says so. By words: words matched, the most cited ranked high.
    public func search(query: String?, limit: Int?, fromYear: Int? = nil, untilYear: Int? = nil, by: String? = "meaning") async throws -> OJ {
        let yearsFilter = Papers.years(fromYear, untilYear).joined(separator: ",")
        let filter: String? = yearsFilter.isEmpty ? nil : yearsFilter
        let max = Papers.count(limit, 10, 25)
        func words(_ note: String = "") async throws -> OJ {
            let text = Papers.clean(query)
            if text.isEmpty { throw PapersError("Give words to search for.") }
            let out = try await list(filter, limit: max, search: text)
            return ["total": .number(Double(out.total)), "order": .string("\(note)relevance (OpenAlex ranks the most cited high: prefer the citation graph)"), "results": .array(out.results)]
        }
        if by == "words" { return try await words() }
        let text = (query ?? "").squashedSpaces.jsSlice(0, Papers.semanticMaxChars)
        if text.isEmpty { throw PapersError("Give the problem to search for, in plain sentences.") }
        do {
            let out = try await spaced { try await self.list(filter, limit: max, semantic: text) }
            return ["total": .number(Double(out.total)), "order": "closest in meaning first (title and abstract)", "results": .array(out.results)]
        } catch let error as PapersError {
            guard let s = error.status, s >= 400, s < 500, s != 429 else { throw error }
            return try await words("OpenAlex refused the search by meaning (\(s)), so this matched words instead: ")
        }
    }

    // MARK: MCP

    static let idText = "A paper: its OpenAlex id (W…) from an earlier result, a DOI, an arXiv id, or a title."
    static func schema(_ properties: OJ, _ required: [String]) -> OJ {
        ["type": "object", "properties": properties, "required": .array(required.map { .string($0) }), "additionalProperties": false]
    }
    static let string: OJ = ["type": "string"]
    static func integer(_ max: Int) -> OJ { ["type": "integer", "minimum": 1, "maximum": .number(Double(max))] }
    static let year: OJ = ["type": "integer", "minimum": 1600, "maximum": 2100]

    /// The six tools as tools/list gives them, each marked read-only (Codex runs a tool marked so without asking).
    public static let tools: [(name: String, description: String, inputSchema: OJ)] = [
        ("resolve", "Find the one paper a DOI, an arXiv id or address, an OpenAlex id (W…) or a title names. Returns its record in full: id (pass it to the other tools), title, authors, year, venue, DOI, abstract, an open-access address and its arXiv page when there are any, and how many works it cites and are cited by it. found: false when nothing matches.", schema(["query": string], ["query"])),
        ("references", "What a paper cites, most cited first, without abstracts (resolve gives one). \(idText)", schema(["id": string, "limit": integer(maxList)], ["id"])),
        ("citations", "What cites a paper: most recent first (sort \"recent\", the default) or most cited first (\"cited\"), from a year on when from_year is given. Without abstracts. \(idText)", schema(["id": string, "limit": integer(maxList), "sort": ["type": "string", "enum": ["recent", "cited"]], "from_year": year], ["id"])),
        ("author_works", "An author's works, most cited first (sort \"cited\", the default) or most recent first (\"recent\"). author: a name or an OpenAlex author id (A…). The best match is used; others with that name are listed, so check the institution.", schema(["author": string, "limit": integer(maxList), "sort": ["type": "string", "enum": ["cited", "recent"]]], ["author"])),
        ("related", "Papers OpenAlex links to this one by shared concepts and time, up to 25. \(idText)", schema(["id": string, "limit": integer(25)], ["id"])),
        ("search", "Find papers by meaning: give one to three plain sentences stating the problem. OpenAlex compares them with each paper's title and abstract and returns the closest first, up to 25, without abstracts (resolve gives one). by \"words\" matches words instead and ranks the most cited high. Use it only to find starting points.", schema(["query": string, "limit": integer(25), "from_year": year, "until_year": year, "by": ["type": "string", "enum": ["meaning", "words"]]], ["query"])),
    ]

    public static var toolsListJSON: OJ {
        .array(tools.map { ["name": .string($0.name), "description": .string($0.description), "inputSchema": $0.inputSchema,
                            "annotations": ["readOnlyHint": true, "destructiveHint": false, "openWorldHint": true]] })
    }

    /// One tool call → (text, isError): the answer as JSON text, or what went wrong (papers.cjs callTool).
    public func callTool(_ name: String, _ args: JSONValue?) async -> (text: String, isError: Bool) {
        guard let tool = Papers.tools.first(where: { $0.name == name }) else { return ("There is no tool \(name).", true) }
        let given = args?.object ?? [:]
        let properties = tool.inputSchema["properties"]?.keys ?? []
        let required = tool.inputSchema["required"]?.array?.compactMap { $0.string } ?? []
        // Object.keys order is the arguments' order; a dictionary has none, so unknown keys are reported sorted.
        if let bad = given.keys.sorted().first(where: { !properties.contains($0) }) ?? required.first(where: { given[$0]?.string == nil }) {
            return ("Invalid argument: \(bad).", true)
        }
        func s(_ k: String) -> String? { given[k]?.string }
        func i(_ k: String) -> Int? { given[k]?.double.flatMap { $0 == $0.rounded() ? Int($0) : nil } }
        do {
            let out: OJ
            switch name {
            case "resolve": out = try await resolve(query: s("query"))
            case "references": out = try await references(id: s("id"), limit: i("limit"))
            case "citations": out = try await citations(id: s("id"), limit: i("limit"), sort: s("sort") ?? "recent", fromYear: i("from_year"))
            case "related": out = try await related(id: s("id"), limit: i("limit"))
            case "author_works": out = try await authorWorks(author: s("author"), limit: i("limit"), sort: s("sort") ?? "cited")
            default: out = try await search(query: s("query"), limit: i("limit"), fromYear: i("from_year"), untilYear: i("until_year"), by: s("by") ?? "meaning")
            }
            return (out.stringify(), false)
        } catch let error as PapersError {
            return (error.message, true)
        } catch {
            return ("The lookup failed: \(error.localizedDescription.components(separatedBy: "\n")[0])", true)
        }
    }
}

final class SpacedBox<T>: @unchecked Sendable { var result: Result<T, Error>? }

/// The order and spacing of OpenAlex's semantic searches.
actor SemanticGate {
    private var at = -Double.infinity
    private var tail: Task<Void, Never>?
    func enqueue(_ body: @escaping @Sendable () async -> Void) -> Task<Void, Never> {
        let previous = tail
        let task = Task { await previous?.value; await body() }
        tail = task
        return task
    }
    func last() -> Double { at }
    func mark(_ value: Double) { at = value }
}

/// `application/x-www-form-urlencoded` as URLSearchParams writes it.
func formEncode(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(127)))
    allowed.insert(charactersIn: "*-._")
    return (s.addingPercentEncoding(withAllowedCharacters: allowed.union(CharacterSet(charactersIn: " "))) ?? s).replacingOccurrences(of: " ", with: "+")
}

/// papers-mcp.cjs — the paper tools as an MCP server over stdio, started by Claude Code (--mcp-config) or Codex (its
/// private home's config.toml) as `<Engelbart> --mcp papers`. It reads nothing on disk and holds no credentials but an
/// OpenAlex key from its environment when there is one. Core.MCPServer serves it; tools/list is answered here, since its
/// tools carry `annotations` (read-only) that Core's list does not write.
public enum PapersMCP {
    public static let name = "papers"

    public static func server(papers: Papers, output: FileHandle = .standardOutput) -> MCPServer {
        MCPServer(name: "engelbart-papers", version: "1.0.0", tools: Papers.tools.map { tool in
            MCPServer.Tool(name: tool.name, description: tool.description, inputSchema: tool.inputSchema.jsonValue) { args in
                let out = await papers.callTool(tool.name, args)
                if out.isError { throw PapersError(out.text) }
                return out.text
            }
        }, output: output)
    }

    /// One JSON-RPC message: tools/list answered with the annotations, anything else by Core's server. → the response.
    @discardableResult
    public static func handle(_ message: JSONValue, server: MCPServer, output: FileHandle) async -> JSONValue? {
        if message["method"]?.string == "tools/list", let id = message["id"], !id.isNull {
            let response: OJ = ["jsonrpc": "2.0", "id": OJ(id), "result": ["tools": Papers.toolsListJSON]]
            output.write(Data((response.stringify() + "\n").utf8))
            return response.jsonValue
        }
        return await server.handle(message)
    }

    /// `--mcp papers`: serves until stdin closes. The app's entry point calls this.
    public static func run(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let key = environment["OPENALEX_API_KEY"].flatMap { $0.isEmpty ? nil : $0 } // a free key: $1 a day, not $0.10
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            await serve(papers: Papers(apiKey: key), input: .standardInput, output: .standardOutput)
            done.signal()
        }
        done.wait()
    }

    /// The server's loop: newline-delimited JSON-RPC from `input` until it closes, each answer a line on `output`.
    public static func serve(papers: Papers, input: FileHandle, output: FileHandle) async {
        let s = server(papers: papers, output: output)
        var buffer = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                if let message = try? JSONValue.parse(Data(line)) { await handle(message, server: s, output: output) }
            }
        }
    }
}
