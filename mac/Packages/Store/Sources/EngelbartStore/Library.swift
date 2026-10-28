import Foundation
import CryptoKit
import EngelbartCore

/// The root library (library.cjs): seeds for test mode, file bytes for papers, PDF annotations, adding by address or path,
/// and the two questions the all-projects screen asks (what a project holds, where an item is held). Nothing here copies
/// a person's files, except what came without one: a pdf read from the web (assets/pdfs), a page saved from the Stage
/// (assets/pages), a picture or pdf dragged in from a browser (assets/images, assets/pdfs), an import's Markdown (assets/md).
public enum Library {
    public static let maxPdfBytes = 200 * 1024 * 1024
    public static let maxImageBytes = 20 * 1024 * 1024
    /// Bump when a category rule changes: every installed library then goes through the rules once more on its next open.
    public static let categoryRules = 1
    /// Bump when a title rule changes (Library Phase B, 2026-10-11).
    public static let titleRules = 1

    /// What a thing being added resolves to (resolveAddition's answer). Keys as Electron's object (absent when nil).
    public struct Found: Codable, Equatable, Sendable {
        public var type: String
        public var tags: [String]
        public var name: String
        public var path: String?
        public var url: String?
        public var folderPath: String?
        public var githubId: String?
        enum CodingKeys: String, CodingKey { case type, tags, name, path, url, folderPath = "folder_path", githubId = "github_id" }
        public init(type: String, tags: [String], name: String, path: String? = nil, url: String? = nil, folderPath: String? = nil, githubId: String? = nil) {
            self.type = type; self.tags = tags; self.name = name; self.path = path; self.url = url; self.folderPath = folderPath; self.githubId = githubId
        }
        func hasTag(_ tag: String) -> Bool { tags.contains(tag) }
    }

    // MARK: seeds (spec §2 #7)

    static func seedRows(_ seedDir: String) -> [NewLibraryRow] {
        [
            NewLibraryRow(name: "How to Teach Programming in the AI Era?", type: "pdf", path: Paths.join(seedDir, "hypocompass.pdf")), // tagged paper once it is looked into
            NewLibraryRow(name: "arXiv 2310.05292", type: "website", tags: ["paper"], url: "https://arxiv.org/abs/2310.05292"),
            NewLibraryRow(name: "mqo00/hypocompass", type: "website", tags: ["git"], url: "https://github.com/mqo00/hypocompass"),
            NewLibraryRow(name: "backend/problems", type: "csv", path: Paths.join(seedDir, "problems.csv")),
        ]
    }

    /// The app's own fixtures (package resources): hypocompass.pdf, problems.csv.
    public static var bundledFixtures: String? { Bundle.module.url(forResource: "fixtures", withExtension: nil, subdirectory: "Resources")?.path }

    /// Test mode's sample library: the four rows, once, when the library is empty. → how many were made.
    @discardableResult
    public static func seedIfEmpty(_ ctx: StoreContext, fixturesDir: String?) throws -> Int {
        if !(try ctx.libraryDb.list()).isEmpty { return 0 }
        let seedDir = Paths.join(ctx.dataRoot, "seed")
        try JSONFiles.makeDir(seedDir)
        for name in ["hypocompass.pdf", "problems.csv"] {
            let target = Paths.join(seedDir, name)
            if let fixturesDir, !Paths.exists(target), Paths.exists(Paths.join(fixturesDir, name)) {
                try FileManager.default.copyItem(atPath: Paths.join(fixturesDir, name), toPath: target)
            }
        }
        var count = 0
        for row in seedRows(seedDir) {
            if let path = row.path, !Paths.exists(path) { continue }
            try ctx.libraryDb.insert(row)
            count += 1
        }
        return count
    }

    public static func listLibrary(_ ctx: StoreContext) throws -> [LibraryRow] { try ctx.libraryDb.list() }

    // MARK: files

    public struct FileBytes: Sendable { public var id: String; public var name: String; public var bytes: Data }

    /// A downloaded pdf's bytes: inside the home directory, at most 200 MB.
    public static func readLibraryFile(_ ctx: StoreContext, _ id: String) throws -> FileBytes {
        guard Ids.isUUID(id) else { throw StoreError.type("library id is invalid") }
        guard let row = try ctx.libraryDb.get(id), let path = row.path else { throw StoreError("This item has no local file") }
        let file = Paths.resolve(path)
        guard Paths.extname(file).lowercased() == ".pdf" else { throw StoreError("Only downloaded pdf files open for now") }
        guard file.hasPrefix(ctx.homeDir + "/") else { throw StoreError("The file is outside your home directory") }
        let info = try Documents.reading { try Paths.statOrThrow(file) }
        guard info.isFile, info.size <= maxPdfBytes else { throw StoreError("The file is not a readable pdf") }
        return FileBytes(id: row.id, name: row.name, bytes: try Documents.reading { try Documents.readData(file) })
    }

    // MARK: who holds what

    public struct Holder: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var origin: Bool
        public var workspaces: [Projects.WorkspacePlace]
    }

    /// Every project that holds the item: `origin` when it was made there, `workspaces` that have it in context.
    public static func projectsForLibraryItem(_ ctx: StoreContext, _ itemId: String) throws -> [Holder] {
        guard Ids.isUUID(itemId) else { throw StoreError.type("library id is invalid") }
        guard let row = try ctx.libraryDb.get(itemId) else { throw StoreError("Unknown library item") }
        var out: [Holder] = []
        for project in Projects.records(ctx) {
            let all = Workspaces.flatten(project.dir)
            guard Projects.holder(project, all, madeIn: try Workspaces.notesMadeIn(project.dir, all))(row) else { continue }
            let workspaces = all.filter { $0.context.contains(row.id) }.map { Projects.WorkspacePlace(id: $0.id, name: $0.name, path: $0.path) }
            out.append(Holder(id: project.id, name: project.name, origin: row.projectId == project.id, workspaces: workspaces))
        }
        return out
    }

    /// A row of a project's library: the row, `origin`, and the paths of the workspaces that have it in context.
    public struct HeldRow: Codable, Equatable, Sendable {
        public var row: LibraryRow
        public var origin: Bool
        public var workspaces: [String]
        public init(from decoder: Decoder) throws {
            row = try LibraryRow(from: decoder)
            let c = try decoder.container(keyedBy: Extra.self)
            origin = try c.decode(Bool.self, forKey: .origin); workspaces = try c.decode([String].self, forKey: .workspaces)
        }
        init(row: LibraryRow, origin: Bool, workspaces: [String]) { self.row = row; self.origin = origin; self.workspaces = workspaces }
        public func encode(to encoder: Encoder) throws {
            try row.encode(to: encoder)
            var c = encoder.container(keyedBy: Extra.self)
            try c.encode(origin, forKey: .origin); try c.encode(workspaces, forKey: .workspaces)
        }
        enum Extra: String, CodingKey { case origin, workspaces }
    }

    /// Every library row the project holds.
    public static func libraryForProject(_ ctx: StoreContext, _ projectId: String) throws -> [HeldRow] {
        let project = try Projects.find(ctx, projectId)
        let workspaces = Workspaces.flatten(project.dir)
        let refs = Workspaces.referencedBy(workspaces)
        let held = Projects.holder(project, workspaces, madeIn: try Workspaces.notesMadeIn(project.dir, workspaces))
        return try ctx.libraryDb.list().filter(held).map { HeldRow(row: $0, origin: $0.projectId == project.id, workspaces: refs[$0.id] ?? []) }
    }

    // MARK: what search reads inside (MATH-29)

    public static let maxBodyChars = 500_000
    static let maxBodyBytes = maxBodyChars * 4

    public struct Bodies: Codable, Equatable, Sendable { public var items: [String: String]; public var workspaces: [String: String] }

    /// The start of a text file, at most 500 000 UTF-16 units; '' when it is not there or not a file.
    static func readBody(_ file: String) -> String {
        guard let info = Paths.stat(file), info.isFile, let handle = FileHandle(forReadingAtPath: file) else { return "" }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: min(info.size, maxBodyBytes))) ?? Data()
        let text = String(decoding: data ?? Data(), as: UTF8.self)
        let units = text.utf16
        return units.count > maxBodyChars ? String(decoding: Array(units.prefix(maxBodyChars)), as: UTF16.self) : text
    }

    /// What the project's things say: a pdf's kept text or an md's file per library id, each workspace's workspace.md.
    public static func bodiesForProject(_ ctx: StoreContext, _ projectId: String) throws -> Bodies {
        let project = try Projects.find(ctx, projectId)
        let rows = try libraryForProject(ctx, projectId).map(\.row)
        var workspaces: [String: String] = [:]
        for workspace in Workspaces.flatten(project.dir) {
            let text = readBody(Paths.join(project.dir, workspace.path, "workspace.md"))
            if !text.isEmpty { workspaces[workspace.id] = text }
        }
        return Bodies(items: try bodiesOfRows(ctx, rows), workspaces: workspaces)
    }

    /// What every row of the library says (the all-projects screen's search: no workspaces).
    public static func bodiesForLibrary(_ ctx: StoreContext) throws -> Bodies {
        Bodies(items: try bodiesOfRows(ctx, try ctx.libraryDb.list()), workspaces: [:])
    }

    static func bodiesOfRows(_ ctx: StoreContext, _ rows: [LibraryRow]) throws -> [String: String] {
        var items = try ctx.libraryDb.textsFor(rows.filter { $0.type == "pdf" }.map(\.id), max: maxBodyChars)
        // A file the library links to is read where it is, as the peek reads it: inside the home directory or the data root.
        let roots = [ctx.homeDir, ctx.dataRoot].compactMap(Paths.realOrNil)
        for row in rows where row.type == "md" {
            guard let path = row.path, let real = Paths.realOrNil(path), roots.contains(where: { Paths.inside(real, $0) }) else { continue }
            let text = readBody(real)
            if !text.isEmpty { items[row.id] = text }
        }
        return items
    }
}

extension Data {
    var sha256Hex: String { SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined() }
}
