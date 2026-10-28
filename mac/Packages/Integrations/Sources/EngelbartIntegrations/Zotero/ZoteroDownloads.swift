import Foundation
import PDFKit
import EngelbartCore

// src/main/zotero/downloads.cjs (MATH-65 build 4): a paper downloaded in the person's browser, brought back. A Zotero item
// with no pdf opens its DOI's page in the default browser (publishers' bot checks refuse the Stage, which is never
// disguised nor given the browser's cookies). From then, for 10 minutes, the Downloads folder is watched for a new .pdf:
// a browser's partial download (.crdownload, .download, .part, or Firefox's empty placeholder beside its .part) is passed
// over until it is finished, and a file is only read once its size and time have held still between two looks. Its first
// two pages' text must carry the item's DOI or most of its title (pdfMatches); a pdf that matches no item waited for is
// left alone. Several items may be waited for at once: one look serves them all, each file goes to at most one of them
// (a DOI before a title, the item clicked last first). A wait ends on a match, after 10 minutes, or when the app quits
// (stopAll); the chip is told each time. The download itself is never moved, renamed or deleted: onMatch copies it.

public enum ZoteroDownloads {
    public static let waitMs: Double = 10 * 60_000
    public static let pollMs: Double = 1500
    static let partialRE = re("\\.(crdownload|download|part|partial|opdownload)$", .caseInsensitive)
    static let partials = [".crdownload", ".download", ".part"]
    /// Items that are not papers: their page opened in the browser is not waited on for a pdf (unless they have a DOI).
    static let notPapers: Set<String> = ["webpage", "blogPost", "forumPost", "videoRecording", "audioRecording", "podcast", "film", "tvBroadcast",
                                         "radioBroadcast", "artwork", "map", "computerProgram", "email", "instantMessage", "interview"]

    /// Whether `item` is a paper whose pdf may be downloaded: it has a DOI, or is a kind that has one.
    public static func paperLike(_ item: JSONValue?) -> Bool {
        guard let item else { return false }
        return !ZoteroOA.cleanDoi(item["doi"]?.stringish).isEmpty || !notPapers.contains(item["itemType"]?.stringish ?? "")
    }

    /// The text of a pdf's first two pages, its lines joined (pdf.js in Electron; PDFKit here).
    public static func firstPagesText(_ file: String) async throws -> String {
        guard let document = PDFDocument(url: URL(fileURLWithPath: file)) else { throw ZoteroOA.PdfError(message: "That file could not be read.") }
        return (0..<min(2, document.pageCount)).compactMap { document.page(at: $0)?.string }.joined(separator: "\n")
    }

    /// Whether the text of a pdf's first pages is the paper `item`: its DOI is in it (spaces and line breaks put aside), or
    /// most of its title: the longest run of the title's words found together is the whole title (three words or 15
    /// letters at least), or 70% of its letters and at least three words. → "doi" | "title" | ""
    public static func pdfMatches(_ text: String?, _ item: JSONValue?) -> String {
        let doi = ZoteroOA.cleanDoi(item?["doi"]?.stringish).lowercased()
        let squashed = re("\\s+").replace((text ?? "").precomposedStringWithCompatibilityMapping.lowercased(), with: "")
        if !doi.isEmpty && squashed.contains(re("\\s+").replace(doi, with: "")) { return "doi" }
        let page = ZoteroOA.titleWords(text).joined()
        let words = ZoteroOA.titleWords(item?["title"]?.stringish)
        if page.isEmpty || words.isEmpty { return "" }
        let whole = words.joined().count
        var best = (chars: 0, count: 0)
        for from in 0..<words.count {
            var run = ""
            for to in from..<words.count {
                run += words[to]
                if !page.contains(run) { break }
                if run.count > best.chars { best = (run.count, to - from + 1) }
            }
        }
        if best.count == words.count && (words.count >= 3 || whole >= 15) { return "title" }
        return best.count >= 3 && Double(best.chars) >= 0.7 * Double(whole) ? "title" : ""
    }
}

/// The Downloads folder watched for the papers waited for (createDownloadWatch).
@MainActor
public final class ZoteroDownloadWatch {
    let dir: () -> String
    let onMatch: (JSONValue, String) async -> Bool
    let onWaiting: (String, Bool) -> Void
    let readText: (String) async throws -> String
    let waitMs: Double
    let pollMs: Double
    let watchFolder: Bool

    private struct Wait { var item: JSONValue; var timer: DispatchWorkItem; var order: Int }
    private var waits: [String: Wait] = [:]
    private var keyOrder: [String] = [] // Map insertion order, as waiting() lists them
    private var clicks = 0
    private var seen: [String: String] = [:]
    private var pending: [String: String] = [:]
    private var poll: DispatchSourceTimer?
    private var watcher: DispatchSourceFileSystemObject?
    private var scanning: Task<Void, Never>?
    private var again = false
    private var folder = ""

    public init(dir: @escaping () -> String, onMatch: @escaping (JSONValue, String) async -> Bool, onWaiting: @escaping (String, Bool) -> Void = { _, _ in },
                readText: @escaping (String) async throws -> String = ZoteroDownloads.firstPagesText, waitMs: Double = ZoteroDownloads.waitMs,
                pollMs: Double = ZoteroDownloads.pollMs, watch: Bool = true) {
        self.dir = dir; self.onMatch = onMatch; self.onWaiting = onWaiting; self.readText = readText
        self.waitMs = waitMs; self.pollMs = pollMs; self.watchFolder = watch
    }

    private func signature(_ file: String) -> (size: Int, sig: String)? {
        guard FileOps.isFile(file), let size = FileOps.size(file), let mtime = FileOps.mtimeMs(file) else { return nil }
        return (size, "\(size):\(mtime)")
    }

    // The pdfs in the folder now, as they are: what was there before the first wait is not new.
    private func start() {
        folder = dir()
        if folder.isEmpty { return }
        seen = [:]; pending = [:]
        for name in FileOps.list(folder) where name.lowercased().hasSuffix(".pdf") {
            if let got = signature(join(folder, name)) { seen[name] = got.sig }
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + pollMs / 1000, repeating: pollMs / 1000)
        timer.setEventHandler { [weak self] in MainActor.assumeIsolated { _ = self?.scan() } }
        timer.resume()
        poll = timer
        if watchFolder {
            let fd = open(folder, O_EVTONLY)
            if fd >= 0 {
                let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .extend], queue: .main)
                source.setEventHandler { [weak self] in MainActor.assumeIsolated { _ = self?.scan() } }
                source.setCancelHandler { close(fd) }
                source.resume()
                watcher = source
            }
        }
    }

    private func halt() {
        poll?.cancel(); poll = nil
        watcher?.cancel(); watcher = nil
        seen = [:]; pending = [:]
    }

    @discardableResult
    private func end(_ key: String) -> Bool {
        guard let held = waits[key] else { return false }
        held.timer.cancel()
        waits[key] = nil
        keyOrder.removeAll { $0 == key }
        if waits.isEmpty { halt() }
        onWaiting(key, false)
        return true
    }

    /// The finished pdfs new since the last look that have held still since it.
    private func fresh() -> [String] {
        var out: [String] = []
        let names = FileOps.list(folder).sorted()
        let here = Set(names)
        for name in names {
            if !name.lowercased().hasSuffix(".pdf") || ZoteroDownloads.partialRE.test(name) { continue }
            if ZoteroDownloads.partials.contains(where: { here.contains(name + $0) }) { continue }
            guard let got = signature(join(folder, name)), got.size > 0 else { continue }
            if seen[name] == got.sig { continue }
            if pending[name] != got.sig { pending[name] = got.sig; continue }
            pending[name] = nil
            seen[name] = got.sig
            out.append(join(folder, name))
        }
        return out
    }

    /// Which of the papers waited for `file` is, or nil.
    private func whose(_ file: String) async -> JSONValue? {
        guard let handle = FileHandle(forReadingAtPath: file) else { return nil }
        let head = handle.readData(ofLength: 4)
        try? handle.close()
        guard head == Data("%PDF".utf8) else { return nil }
        guard let text = try? await readText(file) else { return nil }
        let latest = waits.values.sorted { $0.order > $1.order }.map(\.item)
        return latest.first { ZoteroDownloads.pdfMatches(text, $0) == "doi" } ?? latest.first { ZoteroDownloads.pdfMatches(text, $0) == "title" }
    }

    /// One look at the folder (a change seen, or the clock); never two at once.
    @discardableResult
    public func scan() -> Task<Void, Never> {
        if let scanning { again = true; return scanning }
        if waits.isEmpty || folder.isEmpty { return Task {} }
        let task = Task { @MainActor in
            repeat {
                self.again = false
                for file in self.fresh() {
                    if self.waits.isEmpty { break }
                    guard let item = await self.whose(file), let key = item["key"]?.string, self.waits[key] != nil else { continue }
                    if await self.onMatch(item, file) { self.end(key) }
                }
            } while self.again && !self.waits.isEmpty
            self.scanning = nil
        }
        scanning = task
        return task
    }

    /// Waits for `item`'s pdf (again: its 10 minutes start over). `item["key"]` is the ref it is waited for by.
    @discardableResult
    public func wait(_ item: JSONValue) -> Bool {
        guard let key = item["key"]?.string, !key.isEmpty else { return false }
        let held = waits[key]
        held?.timer.cancel()
        if waits.isEmpty { start() }
        let timer = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { _ = self?.end(key) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + waitMs / 1000, execute: timer)
        clicks += 1
        waits[key] = Wait(item: item, timer: timer, order: clicks)
        if !keyOrder.contains(key) { keyOrder.append(key) }
        if held == nil { onWaiting(key, true) }
        return true
    }

    @discardableResult
    public func stop(_ key: String) -> Bool { end(key) }
    public func stopAll() { for key in Array(waits.keys) { end(key) }; halt() }
    public func waiting() -> [String] { keyOrder }
}
