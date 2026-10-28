import Foundation
import EngelbartCore

/// Re-categorizing, retitling and the peek (library.cjs).
/// Set once: the first `take()` answers true.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock(); private var done = false
    func take() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
}

extension Library {
    /// `promise` within `seconds`, else "timed out".
    /// Not a task group: a group waits for every child, and a reader stuck in PDFKit cannot be cancelled. Here the answer
    /// that comes first wins and the other is left to finish on its own, as a JavaScript promise race leaves it.
    static func within<T: Sendable>(_ seconds: Double, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let once = OnceFlag()
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            let task = Task {
                do { let value = try await work(); if once.take() { continuation.resume(returning: value) } }
                catch { if once.take() { continuation.resume(throwing: error) } }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
                if once.take() { task.cancel(); continuation.resume(throwing: StoreError("timed out")) }
            }
        }
    }

    public struct Recategorized: Sendable { public var changed: [(id: String, name: String, type: String, tags: [String])]; public var due: Int }

    /// Brings every row behind CATEGORY_RULES up to them, once per row per set of rules: what + Add would tell about it
    /// today, from the thing itself. Writes type, tags and categorized only; a tag is only ever added. A pdf that is not
    /// there (or nobody can read) stays due; one that cannot be read, or whose reader does not answer within
    /// `inspectTimeout`, is settled without a tag, so no file can hold the library shut.
    @discardableResult
    public static func recategorize(_ ctx: StoreContext, inspectPdf: InspectPdf? = nil, inspectTimeout: Double = 15) async throws -> Recategorized {
        var report = Recategorized(changed: [], due: 0)
        try ctx.libraryDb.settleUninferable(categoryRules)
        for row in try ctx.libraryDb.uncategorized(categoryRules) {
            let type = typeOfRow(row)
            var tags = Set(row.tags + addressTags(row.url))
            if row.githubId != nil { tags.insert("git") }
            if let folder = row.folderPath, Paths.exists(Paths.join(folder, ".git")) { tags.insert("git") }
            var settled = true
            if type == "pdf" {
                if let inspectPdf, let path = row.path, Paths.exists(path) {
                    if let more = try? await within(inspectTimeout, { try await inspectPdf(path) }) { tags.formUnion(more) }
                } else { settled = false }
            }
            let next = LibraryVocabulary.tags.filter(tags.contains)
            let differs = type != row.type || next.count != row.tags.count
            if differs || settled { try ctx.libraryDb.setCategory(row.id, type: type, tags: next, rules: settled ? categoryRules : nil) }
            if differs { report.changed.append((row.id, row.name, type, next)) }
            if !settled { report.due += 1 }
        }
        return report
    }

    // MARK: what a row says about itself (Library Phase B)

    /// Before 2026-10-08 onboarding kept what it imported as notes; a note from before that with an import's head line is
    /// that import, one from after is the person's own.
    static let notesWereImportsUntil = JSDate.parse("2026-10-08T00:00:00Z")!
    static let maxHeadBytes = 8 * 1024
    static let maxCountedBytes = 4 * 1024 * 1024
    static let turn = #"(?:^|\n\n)\*\*(?:You|ChatGPT|Codex|Cursor|Claude):\*\* "#

    static func readHead(_ file: String, _ bytes: Int) -> String? {
        guard let handle = FileHandle(forReadingAtPath: file) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: bytes) else { return nil }
        return String(decoding: data ?? Data(), as: UTF8.self)
    }

    /// A date as a day, YYYY-MM-DD, from anything Date.parse reads ("Mon, Oct 6, 2025 at 3:14 PM"); nil otherwise.
    public static func dayOf(_ text: String?) -> String? {
        let value = (text ?? "").replacingOccurrences(of: #"\s+at\s+"#, with: " ", options: [.regularExpression, .caseInsensitive]).collapsingWhitespace()
        if value.isEmpty { return nil }
        let first = String(value.prefix(10))
        if RX.test(first, #"^\d{4}-\d{2}-\d{2}$"#), JSDate.parse(first) != nil { return first }
        guard let at = JSDate.parse(value) else { return nil }
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: at)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    /// What an import's head line says (`*<App> · <date> · <project>*`, Gmail, Google Drive, Overleaf), or nil.
    public static func headAbout(_ text: String) -> AboutFields? {
        var body = text
        if body.hasPrefix("\u{FEFF}") { body.removeFirst() }
        let first = (body.components(separatedBy: "\n").first ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let head = RX.match(first, #"^\*([^*\n]+)\*$"#), let inner = head[1] else { return nil }
        let parts = inner.components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let app = parts[0]
        if LibraryVocabulary.chatApps.contains(app) {
            let day = parts.count > 1 && RX.test(parts[1], #"^\d{4}-\d{2}-\d{2}$"#) ? parts[1] : nil
            let project = parts.dropFirst(day != nil ? 2 : 1).joined(separator: " · ")
            let counted = String(decoding: Array(text.utf8.prefix(maxCountedBytes)), as: UTF8.self)
            let turns = RX.re(turn, false).numberOfMatches(in: counted, range: NSRange(location: 0, length: (counted as NSString).length))
            return AboutFields(source: app, category: "chat", itemDate: day, place: project.isEmpty ? nil : project, messages: turns > 0 ? turns : nil)
        }
        if app == "Gmail" {
            // the dates are one or a span joined by an en dash; the people never parse as a date
            let day = parts.count > 1 ? dayOf(parts[1].components(separatedBy: "–").last) : nil
            return AboutFields(source: "Gmail", category: LibraryVocabulary.categoryOfApp("Gmail"), itemDate: day)
        }
        let link = parts.count > 1 && RX.test(parts[1], #"^https?://\S+$"#) ? parts[1] : nil
        if app == "Google Drive", let link { return AboutFields(source: "Google Docs", category: LibraryVocabulary.categoryOfApp("Google Docs"), originUrl: link) }
        if app == "Overleaf", let link { return AboutFields(source: "Overleaf", category: LibraryVocabulary.categoryOfApp("Overleaf"), originUrl: link) }
        return nil
    }

    /// Where a row from before Library Phase B came from: an import's head line, else what the row is.
    static func rowAbout(_ ctx: StoreContext, _ row: LibraryRow) -> (about: AboutFields?, marked: Bool) {
        let assets = Paths.join(ctx.dataRoot, "assets")
        let real = Paths.realOrNil(assets) ?? assets
        let at = row.path ?? row.folderPath
        let inAssets = at.map { Paths.inside($0, assets) || Paths.inside($0, real) } ?? false
        if row.type == "md", let path = row.path {
            let note = row.hasTag("note")
            if !note || (JSDate.parse(row.created).map { $0 < notesWereImportsUntil } ?? false) {
                if let head = readHead(path, maxHeadBytes), var about = headAbout(head) {
                    // a chat's turns are counted over the whole file, not its first 8 KB
                    if about.category == "chat", let whole = readHead(path, maxCountedBytes), let all = headAbout(whole) { about = all }
                    return (about, true)
                }
            }
            if note { return (AboutFields(source: "engelbart", category: "note"), false) }
        }
        if row.hasTag("note") { return (AboutFields(source: "engelbart", category: "note"), false) }
        if row.hasTag("git") { return (AboutFields(source: "github", category: "repo"), false) }
        if row.url != nil && (at == nil || inAssets) { return (AboutFields(source: "web"), false) }
        if at != nil && !inAssets { return (AboutFields(source: "mac"), false) }
        return (nil, false)
    }

    /// A row whose name is its file's name, with or without the extension, was never named by anyone.
    static func namedByFile(_ row: LibraryRow) -> Bool {
        guard let path = row.path else { return false }
        let base = Paths.basename(path)
        return row.name == base || row.name == (base as NSString).deletingPathExtension
    }

    /// An md's first `# ` heading outside a code block, among its first 8 KB; '' when it has none.
    static func mdHeading(_ file: String) -> String? {
        guard let head = readHead(file, maxHeadBytes) else { return nil }
        var fenced = false
        for line in head.components(separatedBy: "\n") {
            if RX.test(line, #"^\s*(?:```|~~~)"#) { fenced.toggle(); continue }
            if !fenced, let m = RX.match(line, #"^#\s+(.+?)\s*#*\s*$"#), let title = m[1] { return title }
        }
        return ""
    }

    static func cleanTitle(_ value: String?) -> String {
        let stripped = (value ?? "").replacingOccurrences(of: "[\\x{00}-\\x{1f}\\x{7f}]", with: " ", options: .regularExpression)
        return String(stripped.collapsingWhitespace().prefix(200))
    }

    public struct Described: Sendable { public var renamed: [(id: String, from: String, to: String)]; public var described: Int; public var due: Int }
    public typealias PdfTitle = @Sendable (_ file: String) async throws -> String

    /// Brings every row behind TITLE_RULES up to them, once per row per version: an older row is told where it came from
    /// (only empty columns filled), then a row still named by its file takes the name the file gives (a pdf's metadata
    /// Title, an md's first heading). Never a note written here, never an import with a head line. Writes name and titled.
    @discardableResult
    public static func describeRows(_ ctx: StoreContext, pdfTitle: PdfTitle? = nil, timeout: Double = 15) async throws -> Described {
        var report = Described(renamed: [], described: 0, due: 0)
        for var row in try ctx.libraryDb.untitled(titleRules) {
            var marked = false
            if row.source == nil {
                let told = rowAbout(ctx, row)
                marked = told.marked
                if let about = told.about { row = try ctx.libraryDb.fillAbout(row.id, about); report.described += 1 }
            } else if row.type == "md", let path = row.path, !row.hasTag("note") {
                marked = headAbout(readHead(path, maxHeadBytes) ?? "") != nil
            }
            var name: String?
            var settled = true
            if !marked && !row.hasTag("note") && namedByFile(row) && (row.type == "pdf" || row.type == "md"), let path = row.path {
                if !Paths.exists(path) || (row.type == "pdf" && pdfTitle == nil) { settled = false }
                else if row.type == "md" { name = cleanTitle(mdHeading(path)) }
                else if let pdfTitle { name = cleanTitle((try? await within(timeout, { try await pdfTitle(path) })) ?? nil) }
            }
            let renaming = (name.map { !$0.isEmpty && $0 != row.name } ?? false) ? name : nil
            try ctx.libraryDb.setTitle(row.id, name: renaming, rules: settled ? titleRules : nil)
            if let renaming { report.renamed.append((row.id, row.name, renaming)) }
            if !settled { report.due += 1 }
        }
        return report
    }

    // MARK: the peek

    static let peekChars = 6000
    static let peekFiles = 40
    /// What a folder's listing leaves out: the peek's and the @ menu's.
    public static let peekSkip: Set<String> = [".git", ".DS_Store"]

    public struct Preview: Codable, Equatable, Sendable {
        public var id: String
        public var text: String?
        public var lines: [String]?
        public var files: [String]?
        public var owner: String?
        public var folder: String?
        public var folderMissing: String?
        public var heldBy: [Holder]
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id); try c.encode(text, forKey: .text); try c.encode(lines, forKey: .lines); try c.encode(files, forKey: .files)
            try c.encode(owner, forKey: .owner); try c.encode(folder, forKey: .folder); try c.encode(folderMissing, forKey: .folderMissing); try c.encode(heldBy, forKey: .heldBy)
        }
        enum CodingKeys: String, CodingKey { case id, text, lines, files, owner, folder, folderMissing, heldBy }
    }

    static func prefixUnits(_ text: String, _ n: Int) -> String {
        text.utf16.count > n ? String(decoding: Array(text.utf16.prefix(n)), as: UTF16.self) : text
    }

    /// What hovering a library row shows beyond the row: an md's text, a data file's first lines, a repository's top-level
    /// files (from the clone, else asked of GitHub), and the projects and workspaces that hold it.
    public static func previewItem(_ ctx: StoreContext, _ id: String, listRemoteFiles: PageMeta.ListRemoteFiles? = nil) async throws -> Preview {
        guard Ids.isUUID(id) else { throw StoreError.type("library id is invalid") }
        guard let row = try ctx.libraryDb.get(id) else { throw StoreError("Unknown library item") }
        var out = Preview(id: row.id, heldBy: try projectsForLibraryItem(ctx, row.id))
        let home = try Paths.real(ctx.homeDir)
        func readable(_ file: String) -> String? { Paths.realOrNil(file).flatMap { Paths.inside($0, home) ? $0 : nil } }
        if row.type == "md", let path = row.path, let file = readable(path) {
            out.text = (try? String(contentsOfFile: file, encoding: .utf8)).map { prefixUnits($0, peekChars) }
        } else if textTypes.contains(row.type), let path = row.path, let file = readable(path), let size = Paths.stat(file)?.size, size <= 2 * 1024 * 1024,
                  let text = try? String(contentsOfFile: file, encoding: .utf8) {
            out.lines = Array(prefixUnits(text, peekChars).components(separatedBy: "\n").prefix(12))
        }
        var folder = row.folderPath.flatMap(readable)
        if folder == nil, row.hasTag("git"), let url = row.url {
            // No clone on the row, or the one it had is gone: a project may be working in one. It is remembered.
            folder = findProjectClone(ctx, url)
            if let folder { _ = try ctx.libraryDb.updateRepo(row.id, name: row.name, url: row.url, folderPath: folder, githubId: row.githubId) }
        }
        func tilde(_ value: String) -> String { Paths.inside(value, home) ? "~" + value.dropFirst(home.count) : value }
        // The folder was deleted, moved, or is on a disk that is not mounted: the row stays and says so.
        if folder == nil, let saved = row.folderPath { out.folderMissing = tilde(saved) }
        if let folder {
            out.folder = tilde(folder)
            if let names = Paths.listDir(folder) {
                out.files = names.filter { !peekSkip.contains($0) }
                    .map { ($0, Paths.isRealDirectory(Paths.join(folder, $0))) }
                    .stableSorted { a, b in a.1 != b.1 ? a.1 : a.0.localizedCompare(b.0) == .orderedAscending }
                    .prefix(peekFiles).map { $0.0 + ($0.1 ? "/" : "") }
            }
        }
        if row.hasTag("git"), let url = row.url, let gh = RX.match(url, github, ci: true) {
            out.owner = gh[1]
            if out.files == nil, let listRemoteFiles { out.files = try? await listRemoteFiles(gh[1]!, gh[2]!) }
        }
        return out
    }
}
