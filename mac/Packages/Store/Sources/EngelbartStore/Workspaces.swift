import Foundation
import EngelbartCore

/// Workspaces: directories of a project, nested (projects.cjs). A workspace's `context` is a flat list of library ids.
public enum Workspaces {
    public struct Record: Equatable, Sendable {
        public var id: String
        public var name: String
        public var context: [String]
        public var removed: [String]
        /// What the @ menu linked (MATH-57): it leaves with its last mention in the document.
        public var picked: [String]
        public var chars: Int
        public var builds: [String]
        public var archives: [ArchiveEntry]
        public var dir: String
        public var created: String?
        var publicValue: PublicWorkspace {
            PublicWorkspace(id: id, name: name, context: context, removed: removed, picked: picked, chars: chars, builds: builds, archives: archives, created: created)
        }
    }

    static func uuids(_ value: JSONValue?) -> [String] { (value?.array ?? []).compactMap { $0.string.flatMap { Ids.isUUID($0) ? $0 : nil } } }

    public static func record(_ dir: String) -> Record? {
        guard let meta = JSONFiles.read(Paths.join(dir, "meta.json")), let id = meta["id"]?.string,
              let status = meta["status"]?.string, Projects.statuses.contains(status) else { return nil }
        // Kept by every save through the app; a workspace last saved before the count existed is measured.
        let chars = meta["chars"]?.double.flatMap { $0 >= 0 && $0.rounded() == $0 ? Int($0) : nil } ?? docChars(dir)
        let builds = (meta["builds"]?.array ?? []).compactMap { $0.string.flatMap { Projects.matches($0, Projects.buildIdPattern) ? $0 : nil } }
        let archives = (meta["archives"]?.array ?? []).compactMap { entry -> ArchiveEntry? in
            guard let file = entry["file"]?.string, Projects.matches(file, Projects.archivePattern) else { return nil }
            return ArchiveEntry(file: file, clearedAt: entry["clearedAt"]?.string, title: String((entry["title"]?.string ?? "").prefix(200)))
        }
        return Record(id: id, name: Paths.basename(dir), context: Projects.contextOf(meta["context"]), removed: uuids(meta["removed"]),
                      picked: uuids(meta["picked"]), chars: chars, builds: builds, archives: archives, dir: dir, created: meta["created"]?.string)
    }

    /// workspace.md's length in UTF-16 units (JavaScript's `.length`); 0 when it cannot be read.
    static func docChars(_ dir: String) -> Int {
        (try? String(contentsOfFile: Paths.join(dir, "workspace.md"), encoding: .utf8))?.utf16.count ?? 0
    }

    /// The workspaces directly under `parentDir`, oldest first; `assets` and `builds` never are.
    public static func records(_ parentDir: String) -> [Record] {
        Projects.subdirs(parentDir)
            .filter { !Projects.projectReserved.contains(Paths.basename($0)) }
            .compactMap(record)
            .stableSorted { ($0.created ?? "") < ($1.created ?? "") }
    }

    static func findIn(_ parentDir: String, _ id: String, depth: Int = 0) -> (workspace: Record, parentDir: String)? {
        if depth > 32 { return nil }
        for workspace in records(parentDir) {
            if workspace.id == id { return (workspace, parentDir) }
            if let deeper = findIn(workspace.dir, id, depth: depth + 1) { return deeper }
        }
        return nil
    }

    public static func find(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String) throws -> (project: Projects.Record, workspace: Record, parentDir: String) {
        let project = try Projects.find(ctx, projectId)
        guard let found = findIn(project.dir, try Ids.assert(workspaceId, "workspace")) else { throw StoreError("Unknown workspace") }
        return (project, found.workspace, found.parentDir)
    }

    /// Every workspace of a project, flat, with its path from the project directory.
    public static func flatten(_ projectDir: String, prefix: String = "", depth: Int = 0) -> [FlatWorkspace] {
        if depth > 32 { return [] }
        var out: [FlatWorkspace] = []
        for workspace in records(depth == 0 ? projectDir : Paths.join(projectDir, prefix)) {
            let at = prefix.isEmpty ? workspace.name : "\(prefix)/\(workspace.name)"
            out.append(FlatWorkspace(id: workspace.id, name: workspace.name, path: at, context: workspace.context, removed: workspace.removed, chars: workspace.chars))
            out.append(contentsOf: flatten(projectDir, prefix: at, depth: depth + 1))
        }
        return out
    }

    /// Library id → the paths of the workspaces that have it in context.
    public static func referencedBy(_ workspaces: [FlatWorkspace]) -> [String: [String]] {
        var refs: [String: [String]] = [:]
        for workspace in workspaces { for id in workspace.context { refs[id, default: []].append(workspace.path) } }
        return refs
    }

    /// The project's notes → the workspace each was made in (topic_id), nil for none. With `workspaces`, the notes
    /// database is not opened when none of them trashed anything (no note can be let go of then).
    public static func notesMadeIn(_ projectDir: String, _ workspaces: [FlatWorkspace]? = nil) throws -> [String: String?] {
        if let workspaces, !workspaces.contains(where: { !$0.removed.isEmpty }) { return [:] }
        var out: [String: String?] = [:]
        for note in try NotesDB.open(projectDir: projectDir).list() { out[note.id] = .some(note.topicId) }
        return out
    }

    /// A workspace.md written from outside the app (an agent in a terminal): the stored count follows the file.
    @discardableResult
    public static func recount(_ ctx: StoreContext) -> Int {
        var fixed = 0
        func walk(_ parentDir: String, _ depth: Int) {
            if depth > 32 { return }
            for workspace in records(parentDir) {
                if let meta = JSONFiles.read(Paths.join(workspace.dir, "meta.json")), let stored = meta["chars"]?.double, stored.rounded() == stored,
                   Int(stored) != docChars(workspace.dir) {
                    _ = try? patchMeta(workspace.dir, ["chars": .number(Double(docChars(workspace.dir)))])
                    fixed += 1
                }
                walk(workspace.dir, depth + 1)
            }
        }
        for project in Projects.records(ctx) { walk(project.dir, 0) }
        return fixed
    }

    /// When a workspace's document was last saved (workspace.md's mtime).
    static func editedAt(_ dir: String) -> String? {
        Paths.stat(Paths.join(dir, "workspace.md")).map { Time.iso(Date(timeIntervalSince1970: $0.mtimeMs / 1000)) }
    }

    public static func tree(_ parentDir: String, depth: Int = 0) -> [WorkspaceNode] {
        if depth > 32 { return [] }
        return records(parentDir).map { w in
            WorkspaceNode(id: w.id, name: w.name, context: w.context, removed: w.removed, picked: w.picked, chars: w.chars, builds: w.builds,
                          archives: w.archives, created: w.created, folder: Paths.basename(w.dir), edited: editedAt(w.dir), children: tree(w.dir, depth: depth + 1))
        }
    }

    /// A workspace's directory name: never one the project keeps for itself.
    static func dirName(_ parentDir: String, _ name: String?, fallback: String) -> String {
        var base = Names.sanitizeName((name?.isEmpty == false) ? name : fallback)
        if Projects.projectReserved.contains(base.lowercased()) || base.lowercased().hasSuffix(".pglite") { base = "\(base) workspace" }
        return Names.uniqueName(parentDir, base)
    }

    /// How deep a workspace is under its project: 1 for one at the top.
    static func nesting(_ projectDir: String, _ dir: String) -> Int {
        Paths.relative(projectDir, dir).split(separator: "/").count
    }

    @discardableResult
    public static func create(_ ctx: StoreContext, _ projectId: String, name: String? = nil, parentId: String? = nil) throws -> PublicWorkspace {
        let parentDir: String
        if let parentId {
            let found = try find(ctx, projectId, parentId)
            if nesting(found.project.dir, found.workspace.dir) >= Projects.maxNesting { throw StoreError("Projects go four levels deep: there is no room for one inside this one.") }
            parentDir = found.workspace.dir
        } else {
            parentDir = try Projects.find(ctx, projectId).dir
        }
        let dir = Paths.join(parentDir, dirName(parentDir, name, fallback: "Untitled Workspace 1"))
        try JSONFiles.makeNewDir(dir)
        try JSONFiles.write(Paths.join(dir, "meta.json"), ["id": .string(IDs.new()), "status": "open", "context": [], "created": .string(Time.iso()), "chars": 0])
        try JSONFiles.writeText(Paths.join(dir, "workspace.md"), "")
        return record(dir)!.publicValue
    }

    @discardableResult
    public static func rename(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ name: String) throws -> PublicWorkspace {
        let found = try find(ctx, projectId, workspaceId)
        if Names.sanitizeName(name) == found.workspace.name { return found.workspace.publicValue }
        let next = Paths.join(found.parentDir, dirName(found.parentDir, name, fallback: found.workspace.name))
        try FileManager.default.moveItem(atPath: found.workspace.dir, toPath: next)
        return record(next)!.publicValue
    }

    // MARK: trash (2026-09-30)

    static let trashDir = ".trash"
    static let trashDays = 7.0
    static let dayMs = 24.0 * 60 * 60 * 1000

    /// The workspace and everything nested in it into `<project>/.trash`, with `trashed { at, name, parentId }`.
    @discardableResult
    public static func trash(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String) throws -> (id: String, name: String) {
        let found = try find(ctx, projectId, workspaceId)
        let parent = found.parentDir == found.project.dir ? nil : record(found.parentDir)
        let bin = Paths.join(found.project.dir, trashDir)
        try JSONFiles.makeDir(bin)
        let into = Paths.join(bin, Names.uniqueName(bin, found.workspace.name))
        try FileManager.default.moveItem(atPath: found.workspace.dir, toPath: into)
        try patchMeta(into, ["trashed": ["at": .string(Time.iso()), "name": .string(found.workspace.name), "parentId": parent.map { .string($0.id) } ?? .null]])
        return (found.workspace.id, found.workspace.name)
    }

    struct TrashEntry { var workspace: Record; var dir: String; var at: Double; var name: String; var parentId: String? }

    static func trashedRecords(_ projectDir: String) -> [TrashEntry] {
        Projects.subdirs(Paths.join(projectDir, trashDir)).compactMap { dir in
            guard let workspace = record(dir), let trashed = JSONFiles.read(Paths.join(dir, "meta.json"))?["trashed"],
                  let at = trashed["at"]?.string.flatMap(JSDate.parse) else { return nil }
            let name = trashed["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? workspace.name
            return TrashEntry(workspace: workspace, dir: dir, at: at.timeIntervalSince1970 * 1000, name: name, parentId: Ids.idOrNull(trashed["parentId"]?.string))
        }
    }

    /// Newest first; those in the trash a week are purged.
    public static func trashed(_ ctx: StoreContext, _ projectId: String, now: Date = Date()) throws -> [TrashedWorkspace] {
        let project = try Projects.find(ctx, projectId)
        let nowMs = now.timeIntervalSince1970 * 1000
        var out: [TrashedWorkspace] = []
        for entry in trashedRecords(project.dir) {
            if entry.at < nowMs - trashDays * dayMs { try? FileManager.default.removeItem(atPath: entry.dir); continue }
            out.append(TrashedWorkspace(id: entry.workspace.id, name: entry.name, deleted: Time.iso(Date(timeIntervalSince1970: entry.at / 1000)),
                                        expires: Time.iso(Date(timeIntervalSince1970: (entry.at + trashDays * dayMs) / 1000)), nested: Projects.countWorkspaces(entry.dir)))
        }
        return out.stableSorted { $0.deleted > $1.deleted }
    }

    /// Back under its parent (at the top when that one is gone too), under a free name, `trashed` dropped.
    @discardableResult
    public static func restore(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String) throws -> PublicWorkspace {
        let project = try Projects.find(ctx, projectId)
        try Ids.assert(workspaceId, "workspace")
        guard let entry = trashedRecords(project.dir).first(where: { $0.workspace.id == workspaceId }) else { throw StoreError("That workspace is no longer in the trash") }
        let parent = entry.parentId.flatMap { findIn(project.dir, $0) }
        let parentDir = parent?.workspace.dir ?? project.dir
        let back = Paths.join(parentDir, dirName(parentDir, entry.name, fallback: entry.workspace.name))
        try FileManager.default.moveItem(atPath: entry.dir, toPath: back)
        let metaFile = Paths.join(back, "meta.json")
        if case .object(var meta)? = JSONFiles.read(metaFile) { meta["trashed"] = nil; try JSONFiles.write(metaFile, .object(meta)) }
        return record(back)!.publicValue
    }

    // MARK: meta.json

    @discardableResult
    static func patchMeta(_ dir: String, _ patch: [String: JSONValue]) throws -> PublicWorkspace? {
        let file = Paths.join(dir, "meta.json")
        try JSONFiles.write(file, (JSONFiles.read(file) ?? .object([:])).merging(patch))
        return record(dir)?.publicValue
    }

    static func ids(_ list: [String]) -> JSONValue { .array(list.map { .string($0) }) }

    @discardableResult
    public static func patch(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ patch: [String: JSONValue]) throws -> PublicWorkspace {
        try patchMeta(try find(ctx, projectId, workspaceId).workspace.dir, patch)!
    }

    @discardableResult
    public static func setContext(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ entries: JSONValue) throws -> PublicWorkspace {
        let found = try find(ctx, projectId, workspaceId)
        return try patchMeta(found.workspace.dir, ["context": ids(try Projects.flatContext(entries))])!
    }
    @discardableResult
    public static func setContext(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ ids: [String]) throws -> PublicWorkspace {
        try setContext(ctx, projectId, workspaceId, .array(ids.map { .string($0) }))
    }

    /// A Build started from this workspace (2026-09-25): its id joins meta.json `builds` (the last 500).
    @discardableResult
    public static func addBuild(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ buildId: String) throws -> PublicWorkspace {
        guard Projects.matches(buildId, Projects.buildIdPattern) else { throw StoreError.type("build id is invalid") }
        let found = try find(ctx, projectId, workspaceId)
        if found.workspace.builds.contains(buildId) { return found.workspace.publicValue }
        return try patchMeta(found.workspace.dir, ["builds": ids(Array((found.workspace.builds + [buildId]).suffix(500)))])!
    }

    static let maxRemoved = 1000

    /// The sidebar's search, +, Save and an @mention bring items into a workspace; the trash takes them out (and
    /// remembers that it did). `picked`: linked by picking it from the @ menu (MATH-57), remembered for an item not
    /// linked already; linked any other way, it stays when its mentions go.
    @discardableResult
    public static func link(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ ids: [String], picked: Bool = false) throws -> PublicWorkspace {
        let workspace = try find(ctx, projectId, workspaceId).workspace
        let adding = try ids.map { try Ids.assert($0, "library") }
        var context = workspace.context
        var chosen: [String]
        if picked {
            chosen = workspace.picked
            for id in adding where !context.contains(id) && !chosen.contains(id) { chosen.append(id) }
        } else {
            chosen = workspace.picked.filter { !adding.contains($0) }
        }
        for id in adding where !context.contains(id) { context.append(id) }
        if context.count > Projects.maxTreeEntries {
            throw StoreError("This workspace's sidebar is full (\(Projects.maxTreeEntries) items): take some out first. Everything stays in the library.")
        }
        return try patchMeta(workspace.dir, ["context": self.ids(try Projects.flatContext(context)), "removed": self.ids(workspace.removed.filter { !adding.contains($0) }), "picked": self.ids(chosen)])!
    }

    /// `unmentioned` (MATH-57): the document's last mention of an item the @ menu linked went; only such an item goes,
    /// and it is not remembered as thrown away. Otherwise out of context and onto `removed` (the last 1000).
    @discardableResult
    public static func unlink(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ ids: [String], unmentioned: Bool = false) throws -> PublicWorkspace {
        let workspace = try find(ctx, projectId, workspaceId).workspace
        let going = try ids.map { try Ids.assert($0, "library") }
        let context = workspace.context.filter { !going.contains($0) }, picked = workspace.picked.filter { !going.contains($0) }
        if unmentioned {
            return going.contains(where: workspace.picked.contains)
                ? try patchMeta(workspace.dir, ["context": self.ids(context), "picked": self.ids(picked)])!
                : workspace.publicValue
        }
        let removed = Array((workspace.removed.filter { !going.contains($0) } + going).suffix(maxRemoved))
        return try patchMeta(workspace.dir, ["context": self.ids(context), "removed": self.ids(removed), "picked": self.ids(picked)])!
    }
}
