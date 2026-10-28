import Foundation
import EngelbartCore

/// Regular expressions with JavaScript's match semantics for the store's patterns.
enum RX {
    static var cache: [String: NSRegularExpression] = [:]
    static let lock = NSLock()
    static func re(_ pattern: String, _ ci: Bool) -> NSRegularExpression {
        let key = (ci ? "i:" : "s:") + pattern
        lock.lock(); defer { lock.unlock() }
        if let held = cache[key] { return held }
        let made = try! NSRegularExpression(pattern: pattern, options: ci ? [.caseInsensitive] : [])
        cache[key] = made
        return made
    }
    /// `text.match(re)`: the match and its groups (nil for a group that did not take part), or nil.
    static func match(_ text: String, _ pattern: String, ci: Bool = false) -> [String?]? {
        let ns = text as NSString
        guard let m = re(pattern, ci).firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? nil : ns.substring(with: m.range(at: $0)) }
    }
    static func test(_ text: String, _ pattern: String, ci: Bool = false) -> Bool { match(text, pattern, ci: ci) != nil }
}

/// Adding to the library (library.cjs): one resolver behind every way of adding (the field, a dropped file), an address
/// or a path in, a row out. Files and folders are linked where they are, never copied. `type` is read off the thing and
/// nothing is guessed into it; what can be told from the address or from a `.git` goes into `tags`.
extension Library {
    // A web address typed without its scheme; a name that ends like a file is not one.
    static let bareHost = #"^(?:www\.)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$"#
    static let fileName = #"^[^./]+\.(?:md|markdown|txt|pdf|html?|png|jpe?g|gif|webp|svg|docx?|pptx?|xlsx?|csv|json|ya?ml|py|js|ts|ipynb|tex|bib|zip)$"#
    static let github = #"^(?:https?://(?:www\.)?github\.com/|git@github\.com:)([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$"#
    static let arxiv = #"^(?:arxiv:\s*|https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/?$"#
    static let doi = #"^(?:doi:\s*|https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/\S+)$"#
    static let maxGitConfigBytes = 1024 * 1024

    /// The formats the library reads, by extension. A picture on disk is linked where it is.
    public static let fileTypes: [String: String] = [
        ".md": "md", ".markdown": "md", ".pdf": "pdf", ".html": "html", ".htm": "html", ".csv": "csv", ".tsv": "tsv", ".json": "json",
        ".jsonl": "jsonl", ".ndjson": "jsonl", ".parquet": "parquet", ".xlsx": "xlsx", ".docx": "docx",
        ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".heic": "image", ".svg": "image",
    ]
    /// What the peek can show the first lines of.
    static let textTypes: Set<String> = ["csv", "tsv", "json", "jsonl"]

    // MARK: repositories

    /// `git@host:o/r.git`, `ssh://git@host/o/r`, `git://…`, `https://user:token@host/o/r.git` → `https://host/o/r`.
    /// Never keeps credentials. A path or `file:` remote is nil.
    public static func canonicalRemote(_ remote: String?) -> String? {
        let value = (remote ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = RX.match(value, #"^(?:https?|ssh|git)://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$"#, ci: true)
                ?? RX.match(value, #"^(?:[\w.-]+@)?([\w.-]+\.[\w.-]+):(?!/)(.+)$"#), let host = m[1], var repo = m[2] else { return nil }
        repo = repo.replacingOccurrences(of: "[?#].*$", with: "", options: .regularExpression)
        while repo.hasSuffix("/") { repo.removeLast() }
        if repo.lowercased().hasSuffix(".git") { repo.removeLast(4) }
        while repo.hasSuffix("/") { repo.removeLast() }
        if repo.isEmpty { return nil }
        var h = host.lowercased()
        if h.hasPrefix("www.") { h.removeFirst(4) }
        return "https://\(h)/\(repo)"
    }

    /// What two spellings of one repository share. GitHub owners and names compare without case.
    static func repoKey(_ url: String?) -> String? {
        guard let canonical = canonicalRemote(url) else { return nil }
        return canonical.hasPrefix("https://github.com/") ? canonical.lowercased() : canonical
    }

    /// A worktree's or submodule's `.git` is a file that points at the real git directory.
    static func gitConfigFile(_ dir: String) -> String? {
        let dotGit = Paths.join(dir, ".git")
        guard let info = Paths.stat(dotGit) else { return nil }
        if info.isDirectory { return Paths.join(dotGit, "config") }
        guard let text = try? String(contentsOfFile: dotGit, encoding: .utf8), let m = RX.match(text, #"(?m)^gitdir:\s*(.+)$"#), let pointer = m[1] else { return nil }
        let pointerPath = pointer.trimmingCharacters(in: .whitespacesAndNewlines)
        let gitDir = Paths.resolve(pointerPath.hasPrefix("/") ? pointerPath : Paths.join(dir, pointerPath))
        var common = gitDir
        if let text = try? String(contentsOfFile: Paths.join(gitDir, "commondir"), encoding: .utf8) {
            let rel = text.trimmingCharacters(in: .whitespacesAndNewlines)
            common = Paths.resolve(rel.hasPrefix("/") ? rel : Paths.join(gitDir, rel))
        }
        return Paths.join(common, "config")
    }

    /// The remote a clone came from (`origin`, else the first one), in the one spelling; nil when none.
    public static func readCloneRemote(_ dir: String?) -> String? {
        guard let dir, let file = gitConfigFile(dir), let size = Paths.stat(file)?.size, size <= maxGitConfigBytes,
              let text = try? String(contentsOfFile: file, encoding: .utf8) else { return nil }
        var remotes: [(String, String)] = []
        var section: String?
        for line in text.components(separatedBy: "\n") {
            if let header = RX.match(line, #"^\s*\[\s*remote\s+"([^"]+)"\s*\]"#) { section = header[1]; continue }
            if RX.test(line, #"^\s*\["#) { section = nil; continue }
            if let section, let url = RX.match(line, #"^\s*url\s*=\s*(.+?)\s*$"#), !remotes.contains(where: { $0.0 == section }) { remotes.append((section, url[1] ?? "")) }
        }
        let ordered = remotes.filter { $0.0 == "origin" }.map(\.1) + remotes.map(\.1)
        for remote in ordered { if let canonical = canonicalRemote(remote) { return canonical } }
        return nil
    }

    /// A project's code directory that is a clone of `url`, if one is.
    static func findProjectClone(_ ctx: StoreContext, _ url: String?) -> String? {
        guard let key = repoKey(url), let home = Paths.realOrNil(ctx.homeDir) else { return nil }
        for project in Projects.records(ctx) {
            guard let directory = project.directory, let real = Paths.realOrNil(directory) else { continue }
            if real.hasPrefix(home + "/") && repoKey(readCloneRemote(real)) == key { return real }
        }
        return nil
    }

    static func folderThere(_ folder: String?) -> Bool { folder.map { Paths.stat($0)?.isDirectory == true } ?? false }
    static func fileThere(_ file: String) -> Bool { Paths.stat(file)?.isFile == true }

    // MARK: resolving

    /// What an address says by itself: arXiv and DOI are papers, a GitHub repository is a repository.
    public static func addressTags(_ url: String?) -> [String] {
        let value = url ?? ""
        if RX.test(value, arxiv, ci: true) || RX.test(value, doi, ci: true) { return ["paper"] }
        return RX.test(value, github, ci: true) ? ["git"] : []
    }

    /// What a row is, from where it is: a file's format, else a folder, else an address.
    static func typeOfRow(_ row: LibraryRow) -> String {
        if let path = row.path { return fileTypes[Paths.extname(path).lowercased()] ?? row.type }
        if row.folderPath != nil { return "folder" }
        return row.url != nil ? "website" : row.type
    }

    static func stripQuotes(_ value: String) -> String {
        if let m = RX.match(value, #"^["'](.*)["']$"#), let inner = m[1] { return inner }
        return value
    }

    public static func resolveAddition(_ input: String, homeDir: String) throws -> Found {
        guard input.count <= 4096, !input.contains("\0") else { throw StoreError.type("Paste a link or a path") }
        var value = stripQuotes(input.trimmingCharacters(in: .whitespacesAndNewlines)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw StoreError.type("Paste a link or a path") }
        // A bare address (github.com, example.org/page): an https link, unless it reads as a file's name.
        if RX.test(value, bareHost, ci: true) && !RX.test(value, fileName, ci: true) { value = "https://\(value)" }
        func address(_ name: String, _ url: String) -> Found { Found(type: "website", tags: addressTags(url), name: name, url: url) }
        if let m = RX.match(value, arxiv, ci: true), let id = m[1] { return address("arXiv \(id)", "https://arxiv.org/abs/\(id)") }
        if let m = RX.match(value, doi, ci: true), let id = m[1] { return address("doi \(id)", "https://doi.org/\(id)") }
        if let m = RX.match(value, github, ci: true), let owner = m[1], let repo = m[2] { return address("\(owner)/\(repo)", "https://github.com/\(owner)/\(repo)") }
        // any other spelling of a remote (ssh://, git://, git@host:group/tool.git, https://host/tool.git)
        if RX.test(value, #"^(?:ssh|git)://|^[\w.-]+@[\w.-]+:|^https?://\S+\.git/?$"#, ci: true), let url = canonicalRemote(value) {
            let gh = RX.match(url, github, ci: true)
            let name = gh.map { "\($0[1]!)/\($0[2]!)" } ?? url.replacingOccurrences(of: "^https://[^/]+/", with: "", options: .regularExpression)
            return Found(type: "website", tags: ["git"], name: name, url: url)
        }
        if RX.test(value, "^https?://", ci: true) {
            guard let url = WebURL(value) else { throw StoreError.type("That link is not a valid address") }
            var shown = url.host
            if shown.hasPrefix("www.") { shown.removeFirst(4) }
            shown += url.pathname
            while shown.hasSuffix("/") { shown.removeLast() }
            return Found(type: "website", tags: [], name: String(shown.prefix(200)), url: url.href)
        }
        if value.lowercased().hasPrefix("file://") { value = Paths.fromFileURL(value) ?? value }
        if value == "~" || value.hasPrefix("~/") { value = Paths.join(homeDir, String(value.dropFirst())) }
        guard value.hasPrefix("/") else { throw StoreError.type("Paste a link, or a path that starts with / or ~/") }
        guard let resolved = Paths.realOrNil(value) else { throw StoreError("Nothing is at that path") }
        let homeReal = (try? Paths.real(homeDir)) ?? homeDir
        guard resolved.hasPrefix(homeReal + "/") else { throw StoreError("Only files inside your home directory can be added") }
        guard let info = Paths.stat(resolved) else { throw StoreError("Nothing is at that path") }
        let base = Paths.basename(resolved)
        let ext = Paths.extname(resolved).lowercased()
        if info.isDirectory {
            if !Paths.exists(Paths.join(resolved, ".git")) { return Found(type: "folder", tags: [], name: base, folderPath: resolved) }
            // a clone is the same repository as its address: same name, and the address comes with it
            let url = readCloneRemote(resolved)
            let gh = url.flatMap { RX.match($0, github, ci: true) }
            return Found(type: "folder", tags: ["git"], name: gh.map { "\($0[1]!)/\($0[2]!)" } ?? base, url: url, folderPath: resolved)
        }
        guard info.isFile else { throw StoreError("That is not a file or a folder") }
        let type = fileTypes[ext]
        if type == "pdf" { return Found(type: "pdf", tags: [], name: (base as NSString).deletingPathExtension, path: resolved) }
        if type == "html" { return Found(type: "html", tags: [], name: base, path: resolved, url: Paths.fileURL(resolved)) }
        if let type { return Found(type: type, tags: [], name: base, path: resolved) }
        throw StoreError("Engelbart does not know what a \(ext.isEmpty ? "file without an extension" : ext) is yet")
    }

    /// The row that already is what `found` names, or nil. A repository is one row whatever its spelling: the same GitHub id
    /// (`who`) is the same repository; without an id on both sides the address decides — never against a row with a
    /// different id. Anything else is the same file, the same folder, or the same page (addressKey).
    public static func sameAs(_ rows: [LibraryRow], _ found: Found, who: PageMeta.RepoIdentity? = nil) -> LibraryRow? {
        if found.hasTag("git"), let url = found.url {
            let key = repoKey(url)
            func addressOf(_ row: LibraryRow) -> String? { repoKey(row.url ?? (row.folderPath != nil ? readCloneRemote(row.folderPath) : nil)) }
            if let repo = (who.flatMap { w in rows.first { $0.githubId == w.id } })
                ?? rows.first(where: { $0.hasTag("git") && (who == nil || $0.githubId == nil) && addressOf($0) == key }) { return repo }
        }
        let page = (found.path == nil && found.folderPath == nil && found.githubId == nil && found.url != nil) ? AddressKey.key(found.url) : nil
        return rows.first { row in
            (found.path != nil && row.path == found.path) || (found.folderPath != nil && row.folderPath == found.folderPath)
                || (page != nil && row.url != nil && AddressKey.key(row.url) == page)
        }
    }

    /// A repository row learns its other half: the clone, the id, the name since a rename (only when the name was the old
    /// owner/name), the place a moved clone is now.
    static func learnRepo(_ ctx: StoreContext, _ repo: LibraryRow, _ found: Found, _ who: PageMeta.RepoIdentity?) throws -> LibraryRow {
        let was = repo.url.flatMap { RX.match($0, github, ci: true) }
        let name: String
        if let who, let was, repo.name.lowercased() == "\(was[1]!)/\(was[2]!)".lowercased() { name = who.fullName } else { name = repo.name }
        let url = who?.url ?? repo.url ?? found.url
        let folder = (found.folderPath != nil && (!folderThere(repo.folderPath) || repo.folderPath == found.folderPath)) ? found.folderPath : repo.folderPath
        let id = repo.githubId ?? who?.id
        let learned = name != repo.name || (url ?? nil) != repo.url || folder != repo.folderPath || id != repo.githubId
        return learned ? (try ctx.libraryDb.updateRepo(repo.id, name: name, url: url, folderPath: folder, githubId: id) ?? repo) : repo
    }

    /// "Already in the library as “X”" (code EXISTS), naming the row as the library calls it.
    static func alreadyThere(_ row: LibraryRow) -> StoreError {
        StoreError("Already in the library as “\(row.name)”", code: "EXISTS", row: row)
    }

    public struct Lookup: Codable, Equatable, Sendable {
        public var row: LibraryRow?
        public var found: Found?
        public var error: String?
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(row, forKey: .row); try c.encode(found, forKey: .found); try c.encode(error, forKey: .error)
        }
        enum CodingKeys: String, CodingKey { case row, found, error }
    }

    /// What an address or a path would be in the library, asked without adding it and without the network.
    public static func lookupItem(_ ctx: StoreContext, _ input: String) throws -> Lookup {
        let found: Found
        do { found = try resolveAddition(input, homeDir: ctx.homeDir) } catch { return Lookup(row: nil, found: nil, error: error.localizedDescription) }
        return Lookup(row: sameAs(try ctx.libraryDb.list(), found), found: found, error: nil)
    }

    // MARK: adding

    /// What a caller knows about a thing it adds; `source`/`category` nil fall back to what the add itself tells.
    static func aboutRow(_ about: AboutFields?, fallbackSource: String? = nil, fallbackCategory: String? = nil) -> AboutFields {
        var out = about ?? AboutFields()
        if out.source == nil { out.source = fallbackSource }
        if out.category == nil { out.category = fallbackCategory }
        return out
    }

    /// Where a thing came from by what it is: a repository github, a file or folder mac, an address web.
    static func sourceOfFound(_ found: Found) -> String? {
        if found.hasTag("git") { return "github" }
        if found.path != nil || found.folderPath != nil { return "mac" }
        return found.url != nil ? "web" : nil
    }

    /// A page known only by its address, no repository and no paper.
    static func plainPage(_ found: Found) -> Bool { found.type == "website" && found.tags.isEmpty }

    public typealias InspectPdf = @Sendable (_ file: String) async throws -> [String]

    public struct AddHooks: Sendable {
        public var describe: PageMeta.Describe?
        public var identifyRepo: PageMeta.IdentifyRepo?
        public var inspectPdf: InspectPdf?
        public init(describe: PageMeta.Describe? = nil, identifyRepo: PageMeta.IdentifyRepo? = nil, inspectPdf: InspectPdf? = nil) {
            self.describe = describe; self.identifyRepo = identifyRepo; self.inspectPdf = inspectPdf
        }
    }

    static func clean200(_ value: String?) -> String { String((value ?? "").collapsingWhitespace().prefix(200)) }

    // A picture or a pdf outside the home folder (2026-10-13, "Get rid of this issue!"): kept as a copy rather than refused.
    static let copyFromOutside = [".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf"]

    static func outsideHomeCopy(_ input: String, homeDir: String) -> (file: String, mime: String, name: String)? {
        var value = stripQuotes(input.trimmingCharacters(in: .whitespacesAndNewlines))
        if value.lowercased().hasPrefix("file://") { guard let path = Paths.fromFileURL(value) else { return nil }; value = path }
        guard value.hasPrefix("/"), let resolved = Paths.realOrNil(value), let home = Paths.realOrNil(homeDir) else { return nil }
        if resolved.hasPrefix(home + "/") { return nil }
        guard let mime = copyFromOutside[Paths.extname(resolved).lowercased()], Paths.stat(resolved)?.isFile == true else { return nil }
        return (resolved, mime, Paths.basename(resolved))
    }

    /// Adds what the address or path names as a new row; something the library already holds throws EXISTS (a repository
    /// row learning what it can first). A page is asked for its title and description, a repository who it is, a pdf
    /// whether it is a paper; `name` is what the row is called; `about`: what an import knows of it.
    public static func addItem(_ ctx: StoreContext, _ input: String, hooks: AddHooks = AddHooks(), name given: String? = nil, about knows: AboutFields? = nil) async throws -> LibraryRow {
        if let outside = outsideHomeCopy(input, homeDir: ctx.homeDir) {
            return try await addFileCopy(ctx, bytes: try Documents.readData(outside.file), mime: outside.mime, name: given ?? outside.name, inspectPdf: hooks.inspectPdf)
        }
        var found = try resolveAddition(input, homeDir: ctx.homeDir)
        let rows = try ctx.libraryDb.list()
        var about: PageMeta.About?
        var who: PageMeta.RepoIdentity?
        if found.hasTag("git"), let url = found.url {
            if let gh = RX.match(url, github, ci: true), let identify = hooks.identifyRepo { who = try? await identify(gh[1]!, gh[2]!) }
            if let who { found.githubId = who.id; found.url = who.url; found.name = who.fullName }
        }
        if let same = sameAs(rows, found, who: who) {
            throw alreadyThere(found.hasTag("git") && same.hasTag("git") ? try learnRepo(ctx, same, found, who) : same)
        }
        if found.hasTag("git"), found.url != nil {
            if found.folderPath == nil {
                found.folderPath = findProjectClone(ctx, found.url)
                if found.folderPath != nil { found.type = "folder" } // a repository that has a folder is a folder
            }
            if let who { about = PageMeta.About(title: "", description: who.description) }
        }
        let page = plainPage(found)
        if page, let describe = hooks.describe { about = (try? await describe(found)) ?? nil }
        let title = clean200(about?.title)
        let named = clean200(given)
        var row = try ctx.libraryDb.insert(NewLibraryRow(
            name: !named.isEmpty ? named : (page && !title.isEmpty ? title : found.name), type: found.type, tags: found.tags, path: found.path,
            url: found.url, folderPath: found.folderPath, projectId: nil, githubId: found.githubId,
            // Everything but a pdf is fully categorized by the resolver; a pdf is once it has been read.
            categorized: found.type == "pdf" ? nil : categoryRules,
            about: aboutRow(knows, fallbackSource: sourceOfFound(found), fallbackCategory: found.hasTag("git") ? "repo" : nil)))
        if let inspect = hooks.inspectPdf, row.type == "pdf", let path = row.path {
            if let tags = try? await inspect(path) { row = (try? ctx.libraryDb.setCategory(row.id, type: row.type, tags: tags, rules: categoryRules)) ?? row }
        }
        let description = String((about?.description ?? "").collapsingWhitespace().prefix(1200))
        if !description.isEmpty { return try ctx.libraryDb.setSummary(row.id, description, at: Date()) ?? row }
        return row
    }

    /// Bytes that are a pdf: `%PDF-` within the first 1024, as readers allow.
    public static func isPdfBytes(_ bytes: Data) -> Bool {
        guard !bytes.isEmpty else { return false }
        return Data(bytes.prefix(1024)).range(of: Data("%PDF-".utf8)) != nil
    }

    /// Where a row's saved pdf lives, written whole or not at all: <data root>/assets/pdfs/<id>.pdf.
    @discardableResult
    public static func writePdfCopy(_ ctx: StoreContext, _ id: String, _ bytes: Data) throws -> String {
        guard Ids.isUUID(id) else { throw StoreError.type("library id is invalid") }
        let dir = Paths.join(ctx.dataRoot, "assets", "pdfs")
        try JSONFiles.makeDir(dir)
        let file = Paths.join(dir, "\(id).pdf")
        try JSONFiles.writeData(file, bytes)
        return file
    }

    /// A pdf read from the web, saved as itself (2026-09-23): `assets/pdfs/<id>.pdf`, its `url` where it came from (an
    /// arXiv or DOI address as the library spells it, `paper` kept). Ink drawn before saving comes along.
    public static func addPdfCopy(_ ctx: StoreContext, _ input: String, bytes: Data, inspectPdf: InspectPdf? = nil, name given: String? = nil, about: AboutFields? = nil) async throws -> LibraryRow {
        guard RX.test(input.trimmingCharacters(in: .whitespacesAndNewlines), "^https?://", ci: true) else { throw StoreError.type("Only a pdf from the web is saved as a copy") }
        guard isPdfBytes(bytes) else { throw StoreError.type("That is not a pdf") }
        if bytes.count > maxPdfBytes { throw StoreError("The pdf is larger than 200 MB") }
        let found = try resolveAddition(input, homeDir: ctx.homeDir)
        if let same = sameAs(try ctx.libraryDb.list(), found) { throw alreadyThere(same) }
        let id = IDs.new()
        let file = try writePdfCopy(ctx, id, bytes)
        var fromAddress = lastSegment(input.trimmingCharacters(in: .whitespacesAndNewlines))
        if fromAddress.lowercased().hasSuffix(".pdf") { fromAddress.removeLast(4) }
        let named = clean200(given)
        var row: LibraryRow
        do {
            row = try ctx.libraryDb.insert(NewLibraryRow(id: id, name: !named.isEmpty ? named : (!fromAddress.isEmpty ? String(fromAddress.prefix(200)) : found.name), type: "pdf",
                                                         tags: found.tags, path: file, url: found.url, about: aboutRow(about, fallbackSource: "web")))
        } catch { try? FileManager.default.removeItem(atPath: file); throw error }
        try carryInk(ctx, found, id)
        if let inspectPdf, let tags = try? await inspectPdf(file) {
            row = (try? ctx.libraryDb.setCategory(id, type: "pdf", tags: uniq(found.tags + tags), rules: categoryRules)) ?? row
        }
        return row
    }

    static func uniq(_ list: [String]) -> [String] { var out: [String] = []; for x in list where !out.contains(x) { out.append(x) }; return out }

    /// What the Stage's tab wrote (views.savePage): where it is now and what it is called.
    public struct SavedPage: Sendable { public var url: String; public var title: String; public init(url: String, title: String) { self.url = url; self.title = title } }

    /// A page from the web saved as itself (MATH-17): `save(dir)` writes the tab into `assets/pages/<id>/`; the row is an
    /// html whose path is its index.html and whose url is where it came from. Only a plain page; EXISTS before anything is
    /// written; a failed save, a tab that moved on, or a row that cannot be written leaves no folder.
    public static func addPageCopy(_ ctx: StoreContext, _ input: String, save: (String) async throws -> SavedPage?, name given: String? = nil, about: AboutFields? = nil) async throws -> LibraryRow {
        guard RX.test(input.trimmingCharacters(in: .whitespacesAndNewlines), "^https?://", ci: true) else { throw StoreError.type("Only a page from the web is saved as a copy") }
        let found = try resolveAddition(input, homeDir: ctx.homeDir)
        guard plainPage(found) else { throw StoreError.type("Only a plain web page is saved as a copy") }
        if let same = sameAs(try ctx.libraryDb.list(), found) { throw alreadyThere(same) }
        let id = IDs.new()
        let pages = Paths.join(ctx.dataRoot, "assets", "pages")
        try JSONFiles.makeDir(pages)
        let dir = Paths.join(try Paths.real(pages), id)
        let file = Paths.join(dir, "index.html")
        try JSONFiles.makeNewDir(dir)
        let row: LibraryRow
        do {
            guard let saved = try await save(dir), AddressKey.key(saved.url) == AddressKey.key(found.url) else { throw StoreError("The page changed before it was saved. Save it again.") }
            guard fileThere(file) else { throw StoreError("The page was not saved") }
            let named = clean200(given), titled = clean200(saved.title)
            row = try ctx.libraryDb.insert(NewLibraryRow(id: id, name: !named.isEmpty ? named : (!titled.isEmpty ? titled : found.name), type: "html", tags: [], path: file,
                                                         url: found.url, categorized: categoryRules, about: aboutRow(about, fallbackSource: "web")))
        } catch { try? FileManager.default.removeItem(atPath: dir); throw error }
        try carryInk(ctx, found, id)
        // the description the page gives of itself, read from the copy, not the network
        let summary = String(PageMeta.readHtmlMeta(readBody(file)).description.collapsingWhitespace().prefix(1200))
        return summary.isEmpty ? row : (try ctx.libraryDb.setSummary(id, summary, at: Date()) ?? row)
    }

    /// A Markdown text kept as a file of the library's own (2026-10-08, Connect your library): `assets/md/<id>/<name>.md`,
    /// its pictures beside it, a row of type md with no note tag and no project, its name kept (titled).
    public static func addMarkdownCopy(_ ctx: StoreContext, name: String?, text: String?, pictures: [(file: String, name: String)] = [], about: AboutFields? = nil) throws -> LibraryRow {
        let stripped = String((name ?? "").unicodeScalars.filter { !($0.value < 0x20 || $0.value == 0x7f) }.map(Character.init))
        let title = String(stripped.collapsingWhitespace().prefix(200)).isEmpty ? "Untitled" : String(stripped.collapsingWhitespace().prefix(200))
        var stem = title.replacingOccurrences(of: #"[/\\:]"#, with: "-", options: .regularExpression)
        while stem.hasPrefix(".") { stem.removeFirst() }
        stem = stem.trimmingCharacters(in: .whitespacesAndNewlines)
        if stem.isEmpty { stem = "Untitled" }
        let id = IDs.new()
        let base = Paths.join(ctx.dataRoot, "assets", "md")
        try JSONFiles.makeDir(base)
        let dir = Paths.join(try Paths.real(base), id)
        try JSONFiles.makeNewDir(dir)
        let file = Paths.join(dir, "\(stem).md")
        do {
            for picture in pictures { try FileManager.default.copyItem(atPath: picture.file, toPath: Paths.join(dir, Paths.basename(picture.name))) }
            try JSONFiles.writeText(file, text ?? "")
            return try ctx.libraryDb.insert(NewLibraryRow(id: id, name: title, type: "md", tags: [], path: file, categorized: categoryRules, about: aboutRow(about), titled: titleRules))
        } catch { try? FileManager.default.removeItem(atPath: dir); throw error }
    }

    // MARK: dragged in (MATH-19)

    static let imageMimes = ["image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"]
    static let pdfMimes: Set<String> = ["application/pdf", "application/x-pdf"]
    public static let downloadTimeout: TimeInterval = 60
    /// What a server that picks a format by Accept is asked for: the pictures kept here before any other.
    static let downloadAccept = "image/png,image/jpeg,image/gif,image/webp,application/pdf;q=0.9,*/*;q=0.8"

    static func mimeOf(_ value: String?) -> String {
        (value ?? "").lowercased().split(separator: ";", omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    }

    /// Which picture the bytes are by their first bytes (png, jpeg, gif or webp); nil for anything else.
    public static func imageMimeOf(_ bytes: Data) -> String? {
        guard bytes.count >= 3 else { return nil }
        let head = [UInt8](bytes.prefix(12))
        if head.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { return "image/png" }
        if head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff { return "image/jpeg" }
        let text = String(decoding: head, as: Unicode.ASCII.self)
        if text.hasPrefix("GIF87a") || text.hasPrefix("GIF89a") { return "image/gif" }
        if head.count >= 12 && text.hasPrefix("RIFF") && String(decoding: head[8..<12], as: Unicode.ASCII.self) == "WEBP" { return "image/webp" }
        return nil
    }

    static func writeImageCopy(_ ctx: StoreContext, _ id: String, _ bytes: Data, _ ext: String) throws -> String {
        guard Ids.isUUID(id) else { throw StoreError.type("library id is invalid") }
        let dir = Paths.join(ctx.dataRoot, "assets", "images")
        try JSONFiles.makeDir(dir)
        let file = Paths.join(dir, "\(id).\(ext)")
        try JSONFiles.writeData(file, bytes)
        return file
    }

    /// An address a copy came from, as the library spells it; a file inside a GitHub repository is that file.
    static func copiedFrom(_ ctx: StoreContext, _ input: String) throws -> Found {
        guard RX.test(input.trimmingCharacters(in: .whitespacesAndNewlines), "^https?://", ci: true) else { throw StoreError.type("Only an address from the web is kept with a copy") }
        let found = try resolveAddition(input, homeDir: ctx.homeDir)
        if found.hasTag("git") { return Found(type: "website", tags: [], name: found.name, url: WebURL(input.trimmingCharacters(in: .whitespacesAndNewlines))?.href) }
        return found
    }

    /// The last part of an address's path, decoded; '' when it has none.
    static func lastSegment(_ url: String?) -> String {
        guard let url, let parsed = WebURL(url) else { return "" }
        let last = parsed.pathname.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        return last.removingPercentEncoding ?? ""
    }

    /// A dropped picture or pdf saved as a copy (png/jpeg/gif/webp ≤ 20 MB, told by its bytes; pdf ≤ 200 MB). `url`, when
    /// given, is where it came from (EXISTS when the library holds that address). A row that cannot be written leaves no file.
    public static func addFileCopy(_ ctx: StoreContext, bytes: Data, mime: String, name given: String? = nil, url: String? = nil, about: AboutFields? = nil, inspectPdf: InspectPdf? = nil) async throws -> LibraryRow {
        guard !bytes.isEmpty else { throw StoreError.type("The file is empty") }
        let said = mimeOf(mime)
        let pdf = pdfMimes.contains(said)
        guard pdf || imageMimes[said] != nil else { throw StoreError.type("Only png, jpeg, gif and webp images and pdfs can be added this way") }
        var image: String?
        if pdf {
            if bytes.count > maxPdfBytes { throw StoreError("The pdf is larger than 200 MB") }
            guard isPdfBytes(bytes) else { throw StoreError.type("That is not a pdf") }
        } else {
            if bytes.count > maxImageBytes { throw StoreError("The image is larger than 20 MB") }
            image = imageMimeOf(bytes)
            guard image != nil else { throw StoreError.type("That is not a png, jpeg, gif or webp image") }
        }
        // A pdf takes the address as the library spells it, with what it says; a picture keeps the address it was given.
        let from = try url.map { try copiedFrom(ctx, $0) }
        let found: Found? = from.map { f in !pdf ? Found(type: "image", tags: [], name: f.name, url: WebURL(url!.trimmingCharacters(in: .whitespacesAndNewlines))?.href) : f }
        if let found, let same = sameAs(try ctx.libraryDb.list(), found) { throw alreadyThere(same) }
        let id = IDs.new()
        let file = pdf ? try writePdfCopy(ctx, id, bytes) : try writeImageCopy(ctx, id, bytes, imageMimes[image!]!)
        func bare(_ value: String) -> String {
            var v = value
            if pdf && v.lowercased().hasSuffix(".pdf") { v.removeLast(4) }
            return String(v.collapsingWhitespace().prefix(200))
        }
        var named = bare(given ?? "")
        if named.isEmpty, let found { named = bare(lastSegment(found.url)) }
        if named.isEmpty { named = pdf ? (found?.name ?? "Untitled pdf") : "Image" }
        let tags = found?.tags ?? []
        var row: LibraryRow
        do {
            row = try ctx.libraryDb.insert(NewLibraryRow(id: id, name: named, type: pdf ? "pdf" : "image", tags: tags, path: file, url: found?.url,
                                                         categorized: pdf ? nil : categoryRules,
                                                         about: aboutRow(about, fallbackSource: found != nil ? "web" : "mac", fallbackCategory: pdf ? nil : "image")))
        } catch { try? FileManager.default.removeItem(atPath: file); throw error }
        if pdf, let found { try carryInk(ctx, found, id) }
        if pdf, let inspectPdf, let more = try? await inspectPdf(file) {
            row = (try? ctx.libraryDb.setCategory(id, type: "pdf", tags: uniq(tags + more), rules: categoryRules)) ?? row
        }
        return row
    }

    /// What a link answers when it is a picture or a pdf: (bytes, mime). Nil for anything else and for an address that
    /// cannot be read now; only a picture or pdf larger than the library keeps throws.
    static func download(_ url: String, fetch: HTTPFetch, timeout: TimeInterval) async throws -> (bytes: Data, mime: String)? {
        guard let response = try? await fetch(url, ["accept": downloadAccept], timeout) else { return nil }
        guard response.ok, RX.test(response.url.isEmpty ? url : response.url, "^https?:", ci: true) else { response.cancel(); return nil }
        let type = mimeOf(response.headers["content-type"])
        let image = imageMimes[type] != nil, pdf = pdfMimes.contains(type)
        let unsure = type.isEmpty || RX.test(type, "^(?:application|binary)/octet-stream$")
        guard image || pdf || unsure else { response.cancel(); return nil }
        let max = image ? maxImageBytes : maxPdfBytes
        let tooLarge = image ? "The image is larger than 20 MB" : "The file is larger than 200 MB"
        if let length = response.headers["content-length"].flatMap(Double.init), length > Double(max) { response.cancel(); throw StoreError(tooLarge) }
        let bytes: Data
        do { bytes = try await response.data(max: max, tooLarge: tooLarge) }
        catch { if (error as? StoreError)?.code == "TOO_LARGE" { throw StoreError(tooLarge) }; return nil }
        if image || pdf { return (bytes, type) }
        if isPdfBytes(bytes) { return (bytes, "application/pdf") }
        return imageMimeOf(bytes).map { (bytes, $0) }
    }

    /// A link dropped onto the library or a workspace: a picture or pdf is kept as a copy with the link; anything else is
    /// added as + Add adds it. `fetch` is the app's (the Stage's session, so a page behind a sign-in answers too).
    public static func addFromUrl(_ ctx: StoreContext, _ input: String, fetch: HTTPFetch = HTTP.fetch, timeout: TimeInterval = downloadTimeout, hooks: AddHooks = AddHooks()) async throws -> LibraryRow {
        guard input.count <= 8192 else { throw StoreError.type("Drop a link from the web") }
        guard let address = WebURL(input) else { throw StoreError.type("That link is not a valid address") }
        guard address.scheme == "http" || address.scheme == "https" else { throw StoreError.type("Only http(s) links can be added") }
        guard let got = try await download(address.href, fetch: fetch, timeout: timeout) else { return try await addItem(ctx, address.href, hooks: hooks) }
        return try await addFileCopy(ctx, bytes: got.bytes, mime: got.mime, url: address.href, inspectPdf: hooks.inspectPdf)
    }
}
