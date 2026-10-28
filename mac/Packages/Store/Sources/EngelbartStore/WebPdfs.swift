import Foundation
import EngelbartCore

/// Pdfs that were saved as links (web-pdfs.cjs, 2026-09-23, Hudson: "old saved pdfs should all be downloaded in the
/// background and migrated to pdfs"). Every time a library opens, and as soon as a page row is added, every page row is
/// checked against `<data root>/.migrations/web-pdfs.json`; the ones that are pdfs are downloaded in the background and
/// become `pdf` rows with their copy in assets/pdfs/<id>.pdf — the same row (id, name, address, tags, summary).
public enum WebPdfs {
    static let recordVersion = 1
    public static let maxAttempts = 5
    static let parallel = 2
    static let arxivAbs = #"^https?://(?:www\.)?arxiv\.org/abs/([^?#]+?)/?$"#

    public static func recordFile(_ dataRoot: String) -> String { Paths.join(dataRoot, ".migrations", "web-pdfs.json") }

    public static func readRecord(_ dataRoot: String) -> JSONValue {
        if let value = JSONFiles.read(recordFile(dataRoot)), value["version"]?.double == Double(recordVersion), value["rows"]?.isPlainObject == true { return value }
        return ["version": .number(Double(recordVersion)), "rows": .object([:])]
    }

    static func writeRecord(_ dataRoot: String, _ record: JSONValue) throws {
        try JSONFiles.makeDir(Paths.dirname(recordFile(dataRoot)))
        try JSONFiles.writeText(recordFile(dataRoot), record.text(pretty: true))
    }

    public struct Candidate: Equatable, Sendable { public var id: String; public var url: String; public var from: String; public var sure: Bool }

    /// A page row that may be a pdf, and where its pdf would be fetched from; nil for anything else.
    public static func candidate(_ row: LibraryRow) -> Candidate? {
        guard row.type == "website", row.path == nil, row.folderPath == nil, let url = row.url, !row.hasTag("git"), !row.hasTag("note"),
              let parsed = WebURL(url), parsed.scheme == "http" || parsed.scheme == "https" else { return nil }
        if let m = RX.match(url, arxivAbs, ci: true), let id = m[1] { return Candidate(id: row.id, url: url, from: "https://arxiv.org/pdf/\(id)", sure: true) }
        return Candidate(id: row.id, url: url, from: url, sure: parsed.pathname.lowercased().hasSuffix(".pdf"))
    }

    /// Candidates never settled at their address, or failed fewer than five times.
    static func pending(_ rows: [LibraryRow], _ record: JSONValue) -> [Candidate] {
        rows.compactMap(candidate).filter { c in
            guard let seen = record["rows"]?[c.id], seen["url"]?.string == c.url else { return true }
            return seen["state"]?.string == "failed" && (seen["attempts"]?.int ?? 0) < maxAttempts
        }
    }

    /// A fetch answer read as a pdf, or nil: dropped as soon as its type and first bytes say it is not one. Throws on an
    /// HTTP error and past `max` bytes.
    public static func readPdfResponse(_ response: HTTPResponse, max: Int = Library.maxPdfBytes) async throws -> Data? {
        guard response.ok else { response.cancel(); throw StoreError("The address answered \(response.status)") }
        let typed = RX.test(response.headers["content-type"] ?? "", #"^\s*application/(?:x-)?pdf\b"#, ci: true)
        var all = Data()
        var decided = typed
        for try await chunk in response.body {
            all.append(chunk)
            if all.count > max { response.cancel(); throw StoreError("The pdf is larger than 200 MB") }
            if !decided && all.count >= 5 {
                if Data(all.prefix(1024)).range(of: Data("%PDF-".utf8)) == nil { response.cancel(); return nil }
                decided = true
            }
        }
        return Library.isPdfBytes(all) ? all : nil
    }

    public typealias FetchPdf = @Sendable (_ url: String) async throws -> Data?

    /// One row: download, keep the copy, turn the row into it. → the record entry
    static func migrateOne(_ ctx: StoreContext, _ c: Candidate, fetchPdf: FetchPdf, inspectPdf: Library.InspectPdf?) async throws -> [String: JSONValue] {
        guard let bytes = try await fetchPdf(c.from) else { return ["state": "page", "url": .string(c.url)] }
        let file = try Library.writePdfCopy(ctx, c.id, bytes)
        guard let row = try ctx.libraryDb.adoptPdf(c.id, file: file) else {
            try? FileManager.default.removeItem(atPath: file)
            return ["state": "page", "url": .string(c.url), "note": "changed meanwhile"]
        }
        if let inspectPdf, let tags = try? await inspectPdf(file) {
            _ = try? ctx.libraryDb.setCategory(row.id, type: "pdf", tags: Library.uniq(row.tags + tags), rules: Library.categoryRules)
        }
        return ["state": "saved", "url": .string(c.url)]
    }

    public struct Result: Equatable, Sendable { public var pending: Int; public var saved: Int; public var pages: Int; public var failed: Int
        public init(pending: Int, saved: Int, pages: Int, failed: Int) { self.pending = pending; self.saved = saved; self.pages = pages; self.failed = failed } }

    static let lock = NSLock()
    nonisolated(unsafe) static var running: [String: Task<Result, Never>] = [:]
    nonisolated(unsafe) static var following: [String: Task<Result, Never>] = [:]

    /// The checker. `fetchPdf(url)` answers a pdf's bytes, nil for something that is not a pdf, or throws. `onChange` after
    /// each row that became a pdf. `again` (a row was just added, 2026-10-02): a run already at work read the library before
    /// it, so one more run follows it; every add meanwhile waits for that same run. One run per data root.
    @discardableResult
    public static func check(_ ctx: StoreContext, fetchPdf: @escaping FetchPdf, inspectPdf: Library.InspectPdf? = nil, onChange: @escaping @Sendable () -> Void = {},
                             log: @escaping @Sendable (String) -> Void = { _ in }, again: Bool = false) -> Task<Result, Never> {
        let root = ctx.dataRoot
        lock.lock(); defer { lock.unlock() }
        if let current = running[root], again {
            if let next = following[root] { return next }
            let next = Task<Result, Never> {
                _ = await current.value
                lock.withLock { following[root] = nil }
                return await check(ctx, fetchPdf: fetchPdf, inspectPdf: inspectPdf, onChange: onChange, log: log).value
            }
            following[root] = next
            return next
        }
        if let current = running[root] { return current }
        let run = Task<Result, Never> {
            let result = await work(ctx, fetchPdf: fetchPdf, inspectPdf: inspectPdf, onChange: onChange, log: log)
            lock.withLock { running[root] = nil }
            return result
        }
        running[root] = run
        return run
    }

    final class Shared: @unchecked Sendable {
        let lock = NSLock()
        var record: JSONValue
        var queue: [Candidate]
        var result: Result
        init(record: JSONValue, queue: [Candidate], result: Result) { self.record = record; self.queue = queue; self.result = result }
        func next() -> Candidate? { lock.lock(); defer { lock.unlock() }; return queue.isEmpty ? nil : queue.removeFirst() }
    }

    static func work(_ ctx: StoreContext, fetchPdf: @escaping FetchPdf, inspectPdf: Library.InspectPdf?, onChange: @escaping @Sendable () -> Void, log: @escaping @Sendable (String) -> Void) async -> Result {
        let record = readRecord(ctx.dataRoot)
        let todo = pending((try? ctx.libraryDb.list()) ?? [], record)
        let shared = Shared(record: record, queue: todo.filter(\.sure) + todo.filter { !$0.sure }, // the sure ones first
                            result: Result(pending: todo.count, saved: 0, pages: 0, failed: 0))
        if todo.isEmpty { return shared.result }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<min(parallel, todo.count) {
                group.addTask {
                    while let c = shared.next() {
                        let before = shared.lock.withLock { shared.record["rows"]?[c.id] }
                        var entry: [String: JSONValue]
                        do { entry = try await migrateOne(ctx, c, fetchPdf: fetchPdf, inspectPdf: inspectPdf) }
                        catch {
                            let attempts = (before?["url"]?.string == c.url ? before?["attempts"]?.int ?? 0 : 0) + 1
                            entry = ["state": "failed", "url": .string(c.url), "attempts": .number(Double(attempts)), "error": .string(String(error.localizedDescription.prefix(300)))]
                            log("web pdf \(c.url): \(entry["error"]!.string!)")
                        }
                        entry["at"] = .string(Time.iso())
                        let done = entry
                        shared.lock.withLock {
                            var rows = shared.record["rows"]?.object ?? [:]
                            rows[c.id] = .object(done)
                            shared.record = shared.record.merging(["rows": .object(rows)])
                            try? writeRecord(ctx.dataRoot, shared.record)
                            switch done["state"]?.string {
                            case "saved": shared.result.saved += 1
                            case "page": shared.result.pages += 1
                            default: shared.result.failed += 1
                            }
                        }
                        if entry["state"]?.string == "saved" { onChange() }
                    }
                }
            }
        }
        return shared.result
    }
}
