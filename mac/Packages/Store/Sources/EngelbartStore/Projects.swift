import Foundation
import EngelbartCore

/// A project is a directory of workspaces, nested (projects.cjs). Notes are flat markdown files in the project directory,
/// indexed by the project's notes database and mirrored in the root library; pasted images live in <project>/assets.
///
///   <dataRoot>/<slug>/project.json                   { id, name, created, directory, description, library, removed, … }
///   <dataRoot>/<slug>/.project.md                    the project page
///   <dataRoot>/<slug>/notes.sqlite                   (Electron: notes.pglite/)
///   <dataRoot>/<slug>/<Note>.md
///   <dataRoot>/<slug>/assets/<id>.<ext>
///   <dataRoot>/<slug>/<Workspace>/meta.json          { id, status, context, created, chars, builds, archives, … }
///   <dataRoot>/<slug>/<Workspace>/workspace.md
///   <dataRoot>/<slug>/<Workspace>/.archive/<t>.md    (Archive)
///   <dataRoot>/<slug>/.trash/<Workspace>/…           a deleted workspace, restorable for a week
///   <dataRoot>/<slug>/builds/<id>/                   a Build's record
///   <dataRoot>/.trash/<slug>/…                       a deleted project, restorable for a week
public enum Projects {
    // A workspace's meta.json `status` is no longer shown or changed (2026-09-25). It stays on disk only as the mark that
    // a folder is a workspace and not an older layout's goal (Migrate).
    public static let statuses = ["open", "progress", "done"]
    static let reserved: Set<String> = ["annotations", "seed", "test"]
    /// A project's own folders, never workspaces: pasted images, and Build records.
    static let projectReserved: Set<String> = ["assets", "builds"]
    /// Folders of the data root that are not projects: Build's worktrees.
    static let rootReserved: Set<String> = reserved.union(["worktrees"])
    static let buildIdPattern = "^[a-z0-9]{6,32}$"
    public static let archivePattern = #"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d{1,3})?$"#
    static let imageTypes = ["image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"]
    static let maxImageBytes = 20 * 1024 * 1024
    /// "Context has too many entries" (2026-10-13): the limit has room for what imports put there before.
    public static let maxTreeEntries = 2000
    static let maxTreeDepth = 6
    /// Projects nest four levels deep (2026-10-13): the top-level project, then three under it.
    public static let maxNesting = 3
    /// The project page (2026-10-13): project-wide instructions, a dot file no note or workspace can take.
    public static let projectPage = ".project.md"
    static let maxDescription = 4000

    public static let welcomeNote = [
        "This is a note. Notes are plain markdown files in your project folder, and the sidebar lists what this workspace can see.",
        "",
        "- [ ] Type @Task or \"- []\" for a task, then press Build",
        "- [ ] Type @ to mention a paper, folder or note from your library",
        "- [ ] Type @bart, a question, and press Enter",
        "- A bare dash is a bullet; Tab and Shift-Tab nest it",
        "",
        "The Workspace tab is this workspace's own document. Add papers, folders and notes from the sidebar with + Context and + Folder, and nest a workspace inside this one with + Workspace. Paste an image anywhere.",
        "",
    ].joined(separator: "\n")

    static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }

    // MARK: disk

    /// Directories of `dir`: not dot folders, not `.pglite` (an Electron database copied over), not annotations/seed/test.
    /// Symlinks are not followed (a Dirent's isDirectory). Sorted by name so every listing is the same.
    static func subdirs(_ dir: String) -> [String] {
        guard let names = Paths.listDir(dir) else { return [] }
        return names.sorted().compactMap { name in
            if name.hasPrefix(".") || name.hasSuffix(".pglite") || reserved.contains(name) { return nil }
            let full = Paths.join(dir, name)
            return Paths.isRealDirectory(full) ? full : nil
        }
    }

    /// Database files of either app, which a write in the app is not (Electron skipped `notes.pglite/`).
    static func isDatabaseFile(_ name: String) -> Bool {
        name.hasSuffix(".pglite") || name.hasSuffix(".sqlite") || name.hasSuffix(".sqlite-wal") || name.hasSuffix(".sqlite-shm")
    }

    /// When a project was last written in. A Build writing its record (`builds/`) is not the person writing.
    static func latestMtime(_ dir: String, depth: Int = 3) -> String? {
        var latest: Double = 0
        func walk(_ current: String, _ level: Int) {
            guard let names = Paths.listDir(current) else { return }
            for name in names {
                if isDatabaseFile(name) || name.hasPrefix(".") || (level == 0 && name == "builds") { continue }
                let full = Paths.join(current, name)
                guard let info = Paths.stat(full) else { continue }
                latest = max(latest, info.mtimeMs)
                if Paths.isRealDirectory(full) && level < depth { walk(full, level + 1) }
            }
        }
        walk(dir, 0)
        return latest > 0 ? Time.iso(Date(timeIntervalSince1970: latest / 1000)) : nil
    }

    // MARK: context tree

    /// A context entry from an old client: an id, or a folder { id, name, children }.
    static func validateTree(_ entries: JSONValue, depth: Int = 0, counter: inout (n: Int, seen: Set<String>)) throws -> [String] {
        guard case .array(let list) = entries else { throw StoreError.type("context must be an array") }
        if depth > maxTreeDepth { throw StoreError.type("context folders are nested too deep") }
        var out: [String] = []
        for entry in list {
            counter.n += 1
            if counter.n > maxTreeEntries { throw StoreError.type("context has too many entries") }
            if case .string(let id) = entry {
                try Ids.assert(id, "library item")
                if counter.seen.contains(id) { continue }
                counter.seen.insert(id)
                out.append(id)
            } else if case .object(let folder) = entry {
                let id = try Ids.assert(folder["id"]?.string, "folder")
                if counter.seen.contains(id) { continue }
                counter.seen.insert(id)
                out.append(contentsOf: try validateTree(folder["children"] ?? .array([]), depth: depth + 1, counter: &counter))
            } else {
                throw StoreError.type("context entry must be an id or a folder")
            }
        }
        return out
    }

    /// A context is a flat list of library ids; folders an old client sends are flattened, in order.
    public static func flatContext(_ entries: JSONValue) throws -> [String] {
        var counter: (n: Int, seen: Set<String>) = (0, [])
        var out: [String] = []
        for id in try validateTree(entries, counter: &counter) where !out.contains(id) { out.append(id) }
        return out
    }
    public static func flatContext(_ ids: [String]) throws -> [String] { try flatContext(.array(ids.map { .string($0) })) }

    /// A saved context, read: flatContext's, or the valid ids it holds (≤ 2000). Never emptied for one bad entry.
    static func contextOf(_ entries: JSONValue?) -> [String] {
        if let out = try? flatContext(entries ?? .array([])) { return out }
        var ids: [String] = []
        func walk(_ list: JSONValue?, _ depth: Int) {
            guard case .array(let items)? = list, depth <= maxTreeDepth else { return }
            for item in items {
                if case .string(let id) = item { if Ids.isUUID(id) && !ids.contains(id) { ids.append(id) } }
                else if case .object(let o) = item { walk(o["children"], depth + 1) }
            }
        }
        walk(entries, 0)
        return Array(ids.prefix(maxTreeEntries))
    }

    // MARK: records

    public struct Record: Equatable, Sendable {
        public var id: String
        public var name: String
        public var slug: String
        public var dir: String
        public var created: String?
        public var directory: String?
        public var directoryMissing: String?
        public var description: String
        public var defaultTarget: JSONValue?
        public var defaultRepo: String?
        public var library: [String]
        public var removed: [String]
    }

    static let migratedLock = NSLock()
    nonisolated(unsafe) static var migrated = Set<String>()
    static func markMigrated(_ dir: String) { migratedLock.lock(); migrated.insert(dir); migratedLock.unlock() }
    static func forgetMigrated(_ dir: String) { migratedLock.lock(); migrated.remove(dir); migratedLock.unlock() }

    /// A default repo as project.json keeps it: { kind: 'project' } or { kind: 'library', id }; else nil.
    static func targetOrNull(_ value: JSONValue?) -> JSONValue? {
        guard let value, value.isPlainObject else { return nil }
        if value["kind"]?.string == "project" { return ["kind": "project"] }
        if value["kind"]?.string == "library", let id = value["id"]?.string, Ids.isUUID(id) { return ["kind": "library", "id": .string(id)] }
        return nil
    }

    /// A project.json list of library ids: the ids alone, once each.
    static func idList(_ value: JSONValue?) -> [String] {
        var out: [String] = []
        for item in value?.array ?? [] { if let id = item.string, Ids.isUUID(id), !out.contains(id) { out.append(id) } }
        return out
    }

    public static func record(_ dir: String) -> Record? {
        guard let meta = JSONFiles.read(Paths.join(dir, "project.json")), let id = meta["id"]?.string else { return nil }
        migratedLock.lock()
        let first = !migrated.contains(dir)
        if first { migrated.insert(dir) }
        migratedLock.unlock()
        if first {
            do { _ = try Migrate.migrateProjectDir(dir) }
            catch { FileHandle.standardError.write(Data("Engelbart: could not convert \(dir) to the workspace layout: \(error.localizedDescription)\n".utf8)) }
        }
        let name = meta["name"]?.string.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } ?? Paths.basename(dir)
        let saved = meta["directory"]?.string.flatMap { $0.hasPrefix("/") ? $0 : nil }
        // A saved directory that is gone (moved, unmounted) counts as not chosen: the project asks again.
        let exists = saved.map(Paths.isDirectory) ?? false
        let description = meta["description"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var defaultRepo: String?
        if let repo = meta["defaultRepo"]?.string, matches(repo, #"^[^/\\\x00]{1,255}$"#), repo != ".", repo != ".." { defaultRepo = repo }
        return Record(id: id, name: name, slug: Paths.basename(dir), dir: dir, created: meta["created"]?.string, directory: exists ? saved : nil,
                      directoryMissing: saved != nil && !exists ? saved : nil, description: description,
                      defaultTarget: targetOrNull(meta["defaultTarget"]), defaultRepo: defaultRepo,
                      library: idList(meta["library"]), removed: idList(meta["removed"]))
    }

    public static func records(_ ctx: StoreContext) -> [Record] {
        subdirs(ctx.dataRoot).compactMap(record)
    }

    public static func find(_ ctx: StoreContext, _ id: String) throws -> Record {
        try Ids.assert(id, "project")
        guard let project = records(ctx).first(where: { $0.id == id }) else { throw StoreError("Unknown project") }
        return project
    }

    static func publicProject(_ p: Record) -> PublicProject {
        PublicProject(id: p.id, name: p.name, slug: p.slug, dir: p.dir, created: p.created, directory: p.directory,
                      directoryMissing: p.directoryMissing, description: p.description)
    }

    static func countWorkspaces(_ dir: String) -> Int {
        Workspaces.records(dir).reduce(0) { $0 + 1 + countWorkspaces($1.dir) }
    }

    /// publicProject + { workspaceCount, lastEdited }.
    static func summary(_ p: Record) -> PublicProject {
        var out = publicProject(p)
        out.workspaceCount = countWorkspaces(p.dir)
        out.lastEdited = latestMtime(p.dir) ?? p.created
        return out
    }

    static let recentCount = 4
    static let recentTextChars = 4000

    /// The workspaces whose document changed last, newest first, each with the start of its text.
    static func recentWorkspaces(_ projectDir: String, _ workspaces: [FlatWorkspace], limit: Int = recentCount) -> [RecentWorkspace] {
        workspaces
            .map { w -> (FlatWorkspace, String, Double) in
                let file = Paths.join(projectDir, w.path, "workspace.md")
                return (w, file, Paths.stat(file)?.mtimeMs ?? 0)
            }
            .stableSorted { $0.2 > $1.2 }
            .prefix(limit)
            .map { w, file, edited in
                let text = (try? String(contentsOfFile: file, encoding: .utf8)).map { String($0.prefix(recentTextChars)) } ?? ""
                return RecentWorkspace(id: w.id, name: w.name, path: w.path, chars: w.chars, edited: edited > 0 ? Time.iso(Date(timeIntervalSince1970: edited / 1000)) : nil, text: text)
            }
    }

    /// The holder rule for one project (shared/project-holds.cjs).
    static func holder(_ p: Record, _ workspaces: [FlatWorkspace], madeIn: [String: String?]) -> (LibraryRow) -> Bool {
        ProjectHolds.holder(projectId: p.id, library: p.library, removed: p.removed, workspaces: workspaces.map(\.hold), madeIn: madeIn)
    }

    /// Each project with what the all-projects screen draws on its card, the last edited first.
    public static func listProjects(_ ctx: StoreContext) throws -> [PublicProject] {
        let rows = try ctx.libraryDb.list()
        var listed: [PublicProject] = []
        for p in records(ctx) {
            let workspaces = Workspaces.flatten(p.dir)
            let held = holder(p, workspaces, madeIn: try Workspaces.notesMadeIn(p.dir, workspaces))
            var out = publicProject(p)
            out.workspaceCount = workspaces.count
            out.lastEdited = latestMtime(p.dir) ?? p.created
            out.recent = recentWorkspaces(p.dir, workspaces)
            out.libraryIds = rows.filter(held).map(\.id)
            listed.append(out)
        }
        return listed.stableSorted { ($0.lastEdited ?? "") > ($1.lastEdited ?? "") }
    }

    // MARK: making

    /// A project called "test", "seed" or "annotations" would take a folder the data root keeps for itself.
    static func freeSlug(_ ctx: StoreContext, _ raw: String) -> String {
        let slug = Names.slugify(raw).isEmpty ? "engelbart" : Names.slugify(raw)
        return Names.uniqueName(ctx.dataRoot, rootReserved.contains(slug) ? "\(slug)-project" : slug)
    }

    /// The project's code directory: absolute, existing, a directory.
    static func checkDirectory(_ value: String) throws -> String {
        guard !value.isEmpty, value.count <= 4096, !value.contains("\0"), value.hasPrefix("/") else { throw StoreError.type("directory must be an absolute path") }
        let resolved = Paths.resolve(value)
        guard let info = Paths.stat(resolved) else { throw StoreError.type("directory does not exist") }
        guard info.isDirectory else { throw StoreError.type("directory must be a directory") }
        return resolved
    }

    public struct NewProject: Sendable {
        public var name: String?
        /// The folder name under the data root ("./<path>" on the create screen); the name's slug when nil.
        public var path: String?
        public var directory: String?
        public var description: String?
        public init(name: String?, path: String? = nil, directory: String? = nil, description: String? = nil) {
            self.name = name; self.path = path; self.directory = directory; self.description = description
        }
    }

    static func projectPageText(_ description: String) -> String { description.isEmpty ? "" : "\(description)\n" }

    @discardableResult
    public static func createProject(_ ctx: StoreContext, _ input: NewProject) throws -> PublicProject {
        let name = Names.sanitizeName(input.name)
        let directory = try input.directory.map(checkDirectory)
        let description = String((input.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxDescription))
        let raw = (input.path?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? input.path! : name
        let slug = freeSlug(ctx, raw)
        let dir = Paths.join(ctx.dataRoot, slug)
        try JSONFiles.makeNewDir(dir)
        var meta: [String: JSONValue] = ["id": .string(IDs.new()), "name": .string(name), "created": .string(Time.iso())]
        if let directory { meta["directory"] = .string(directory) }
        if !description.isEmpty { meta["description"] = .string(description) }
        try JSONFiles.write(Paths.join(dir, "project.json"), .object(meta))
        try JSONFiles.writeText(Paths.join(dir, projectPage), projectPageText(description))
        markMigrated(dir)
        _ = try NotesDB.open(projectDir: dir)
        var out = publicProject(record(dir)!)
        out.workspaceCount = 0
        out.lastEdited = meta["created"]!.string
        return out
    }

    public struct Welcomed: Codable, Equatable, Sendable {
        public var project: PublicProject
        public var workspaceId: String
        public var noteId: String?
        public var noteName: String?
        public var welcomePage: Bool?
        /// What Connect's attachProject answered (start-project with a session).
        public var importedNotes: Int?
        public var gettingStarted: GettingStartedState?
    }

    /// First-run flow: the project, a first workspace, and a "Welcome!" note open in its context; the description starts
    /// the workspace's document; `context` (library ids) after the note.
    public static func createProjectWithWelcome(_ ctx: StoreContext, _ input: NewProject, workspaceName: String = "Getting started", context: [String] = []) throws -> Welcomed {
        let project = try createProject(ctx, input)
        let workspace = try Workspaces.create(ctx, project.id, name: workspaceName)
        let note = try Documents.createNote(ctx, project.id, name: "Welcome!", workspaceId: workspace.id, text: welcomeNote)
        _ = try Workspaces.setContext(ctx, project.id, workspace.id, [note.id] + context.filter { $0 != note.id })
        if !project.description.isEmpty { _ = try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: workspace.id), "\(project.description)\n") }
        return Welcomed(project: project, workspaceId: workspace.id, noteId: note.id, noteName: note.name)
    }

    /// A new user's first project (2026-10-14): "Welcome to Engelbart!" whose page starts with the picture.
    public static let welcomeName = "Welcome to Engelbart!"
    public static func welcomePageText(_ imageId: String?) -> String {
        ((imageId.map { ["![Attachment 1](img:\($0))"] } ?? []) + [
            "Engelbart is a **research notebook** that *remembers where all of your thoughts came from.*",
            "",
            // No "still in beta" line (2026-10-15).
            "*Thanks for being a beta user* :)",
            "<3 Hudson + David",
            "",
            "P.S. If you have any questions, feedback, or need help, never hesitate to reach out!",
            "[founders@mathetic.com](mailto:founders@mathetic.com)",
            "",
        ]).joined(separator: "\n")
    }

    static var welcomeImage: URL? { StoreResources.bundle.url(forResource: "welcome", withExtension: "png", subdirectory: "Resources") }

    public static func createProjectWithWelcomePage(_ ctx: StoreContext, _ input: NewProject, context: [String] = []) throws -> Welcomed {
        let project = try createProject(ctx, input)
        let workspace = try Workspaces.create(ctx, project.id, name: welcomeName)
        var image: LibraryRow?
        if let url = welcomeImage, let bytes = try? Data(contentsOf: url) {
            image = try? Documents.saveImage(ctx, project.id, bytes: bytes, mime: "image/png", name: "Attachment 1")
        }
        _ = try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: workspace.id), welcomePageText(image?.id))
        if !context.isEmpty { _ = try Workspaces.setContext(ctx, project.id, workspace.id, context) }
        return Welcomed(project: project, workspaceId: workspace.id, welcomePage: true)
    }

    @discardableResult
    public static func setProjectDirectory(_ ctx: StoreContext, _ id: String, _ directory: String) throws -> PublicProject {
        let p = try find(ctx, id)
        let resolved = try checkDirectory(directory)
        let file = Paths.join(p.dir, "project.json")
        try JSONFiles.write(file, (JSONFiles.read(file) ?? .object([:])).merging(["directory": .string(resolved)]))
        return summary(record(p.dir)!)
    }

    /// Where the project's Builds work by default: { kind: 'project' } or { kind: 'library', id }.
    @discardableResult
    public static func setDefaultTarget(_ ctx: StoreContext, _ id: String, _ target: JSONValue) throws -> JSONValue {
        let p = try find(ctx, id)
        guard let value = targetOrNull(target) else { throw StoreError.type("the default repo must be the code directory or a library row") }
        let file = Paths.join(p.dir, "project.json")
        let meta = JSONFiles.read(file) ?? .object([:])
        if targetOrNull(meta["defaultTarget"]) != value { try JSONFiles.write(file, meta.merging(["defaultTarget": value])) }
        return value
    }

    /// The name changes; the folder follows only while it is still the old name's own slug.
    @discardableResult
    public static func renameProject(_ ctx: StoreContext, _ id: String, _ name: String) throws -> PublicProject {
        let p = try find(ctx, id)
        let next = Names.sanitizeName(name)
        if next == p.name { return summary(p) }
        let file = Paths.join(p.dir, "project.json")
        try JSONFiles.write(file, (JSONFiles.read(file) ?? .object([:])).merging(["name": .string(next)]))
        var dir = p.dir
        if p.slug == Names.slugify(p.name) {
            let slug = freeSlug(ctx, next)
            let target = Paths.join(ctx.dataRoot, slug)
            if target != dir {
                NotesDB.close(projectDir: dir)
                try FileManager.default.moveItem(atPath: dir, toPath: target)
                markMigrated(target)
                try ctx.libraryDb.rewritePathPrefix(dir + "/", target + "/")
                dir = target
            }
        }
        return summary(record(dir)!)
    }

    public static func loadProject(_ ctx: StoreContext, _ id: String) throws -> ProjectTree {
        let p = try find(ctx, id)
        let notes = try NotesDB.open(projectDir: p.dir).list().map(NoteInfo.init)
        return ProjectTree(project: publicProject(p), workspaces: Workspaces.tree(p.dir), notes: notes, trash: try Workspaces.trashed(ctx, id))
    }
}

extension Paths {
    struct Info { var isDirectory: Bool; var isFile: Bool; var mtimeMs: Double; var size: Int }
    /// fs.statSync (follows symlinks); nil when nothing is there.
    static func stat(_ path: String) -> Info? {
        var s = Darwin.stat()
        guard posixStat(path, &s) == 0 else { return nil }
        let mode = s.st_mode & S_IFMT
        let ms = Double(s.st_mtimespec.tv_sec) * 1000 + Double(s.st_mtimespec.tv_nsec) / 1_000_000
        return Info(isDirectory: mode == S_IFDIR, isFile: mode == S_IFREG, mtimeMs: ms, size: Int(s.st_size))
    }
    /// fs.statSync that throws Node's ENOENT/EPERM/EACCES.
    static func statOrThrow(_ path: String) throws -> Info {
        var s = Darwin.stat()
        guard posixStat(path, &s) == 0 else { throw POSIXFailure(code: errno, path: path) }
        let mode = s.st_mode & S_IFMT
        let ms = Double(s.st_mtimespec.tv_sec) * 1000 + Double(s.st_mtimespec.tv_nsec) / 1_000_000
        return Info(isDirectory: mode == S_IFDIR, isFile: mode == S_IFREG, mtimeMs: ms, size: Int(s.st_size))
    }
    /// A directory that is not a symlink (a Dirent's isDirectory()).
    static func isRealDirectory(_ path: String) -> Bool {
        var s = Darwin.stat()
        guard lstat(path, &s) == 0 else { return false }
        return (s.st_mode & S_IFMT) == S_IFDIR
    }
    static func isSymlink(_ path: String) -> Bool {
        var s = Darwin.stat()
        guard lstat(path, &s) == 0 else { return false }
        return (s.st_mode & S_IFMT) == S_IFLNK
    }
}
