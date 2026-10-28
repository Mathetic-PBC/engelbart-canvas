import Foundation
import EngelbartCore

/// The Build records a project folder holds (build/store.cjs, owned by the Build package): `<project>/builds/<id>/task.json`.
/// The store reads and rewrites them only where a project's trash needs it (purge, restore under another folder name).
public enum BuildRecords {
    public static let idPattern = "^[0-9a-f]{10}$"
    public static let final: Set<String> = ["accepted", "discarded"]
    static let maxMessages = 200
    static let maxMessageChars = 40_000

    static func dir(_ projectDir: String, _ id: String) -> String { Paths.join(projectDir, "builds", id) }

    public static func read(_ projectDir: String, _ id: String) -> JSONValue? {
        guard Projects.matches(id, idPattern), let task = JSONFiles.read(Paths.join(dir(projectDir, id), "task.json")), task["id"]?.string == id else { return nil }
        return task
    }

    /// The record written whole, stamped `updated`, its messages the last 200.
    @discardableResult
    public static func write(_ projectDir: String, _ task: JSONValue, now: Date = Date()) throws -> JSONValue {
        guard let id = task["id"]?.string, Projects.matches(id, idPattern) else { throw StoreError.type("build id is invalid") }
        try JSONFiles.makeDir(dir(projectDir, id))
        let next = task.merging(["messages": .array(Array((task["messages"]?.array ?? []).suffix(maxMessages))), "updated": .string(Time.iso(now))])
        try JSONFiles.write(Paths.join(dir(projectDir, id), "task.json"), next)
        return next
    }

    public static func list(_ projectDir: String) -> [JSONValue] {
        (Paths.listDir(Paths.join(projectDir, "builds")) ?? [])
            .filter { Projects.matches($0, idPattern) }
            .compactMap { read(projectDir, $0) }
            .stableSorted { ($0["created"]?.string ?? "") < ($1["created"]?.string ?? "") }
    }

    /// A message for the conversation: who said it, what, when.
    public static func message(_ role: String, _ text: String, now: Date = Date()) -> JSONValue {
        ["role": .string(role), "text": .string(String(text.prefix(maxMessageChars))), "at": .string(Time.iso(now))]
    }
}

/// Delete and restore projects (2026-10-03): the project's folder goes into `<dataRoot>/.trash` for a week; Restore puts
/// it back under its old folder name when free; then it is purged with its Builds' worktrees, rows and state.
extension Projects {
    static let trashDir = ".trash"
    static let worktreesDir = "worktrees"

    static func folderName(_ value: JSONValue?) -> String? {
        guard let s = value?.string, matches(s, #"^[^/\\\x00]{1,255}$"#), !s.hasPrefix(".") else { return nil }
        return s
    }

    static func insideFolder(_ child: String, _ parent: String) -> Bool {
        let rel = Paths.relative(Paths.realOrResolved(parent), Paths.realOrResolved(child))
        return rel.isEmpty || (!rel.hasPrefix("..") && !rel.hasPrefix("/"))
    }

    /// `stopBuilds(id)`: its Builds stopped first. → (id, name)
    @discardableResult
    public static func trashProject(_ ctx: StoreContext, _ id: String, stopBuilds: ((String) async throws -> Void)? = nil) async throws -> (id: String, name: String) {
        let project = try find(ctx, id)
        if let directory = project.directory, insideFolder(directory, project.dir) {
            throw StoreError("\(project.name)'s code folder is inside its Engelbart folder, so deleting the project would take the code with it.")
        }
        if let stopBuilds { try await stopBuilds(id) }
        NotesDB.close(projectDir: project.dir)
        let bin = Paths.join(ctx.dataRoot, trashDir)
        try JSONFiles.makeDir(bin)
        let name = Names.uniqueName(bin, project.slug)
        let into = Paths.join(bin, name)
        let file = Paths.join(project.dir, "project.json")
        let meta = JSONFiles.read(file) ?? .object([:])
        // `trashed` is written before the folder moves: a delete cut short is then a project still listed with `trashed`.
        try JSONFiles.write(file, meta.merging(["trashed": ["at": .string(Time.iso()), "slug": .string(project.slug), "name": .string(name)]]))
        do { try FileManager.default.moveItem(atPath: project.dir, toPath: into) }
        catch { try? JSONFiles.write(file, meta); throw error }
        forgetMigrated(project.dir)
        try ctx.libraryDb.rewritePathPrefix(project.dir + "/", into + "/")
        return (project.id, project.name)
    }

    struct TrashedEntry { var id: String; var name: String; var dir: String; var at: Double; var slug: String?; var into: String? }

    static func trashedEntry(_ dir: String) -> TrashedEntry? {
        guard let meta = JSONFiles.read(Paths.join(dir, "project.json")), let id = meta["id"]?.string, Ids.isUUID(id),
              let trashed = meta["trashed"], trashed.isPlainObject, let at = trashed["at"]?.string.flatMap(JSDate.parse) else { return nil }
        let name = meta["name"]?.string.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } ?? Paths.basename(dir)
        return TrashedEntry(id: id, name: name, dir: dir, at: at.timeIntervalSince1970 * 1000, slug: folderName(trashed["slug"]), into: folderName(trashed["name"]))
    }

    static func trashedRecords(_ ctx: StoreContext) -> [TrashedEntry] { subdirs(Paths.join(ctx.dataRoot, trashDir)).compactMap(trashedEntry) }
    /// Projects in the data root whose project.json still has `trashed`: a delete or a restore cut short.
    static func cutShort(_ ctx: StoreContext) -> [TrashedEntry] { subdirs(ctx.dataRoot).compactMap(trashedEntry) }

    /// A project folder back where it belongs: its rows that point into the trash (or at the folder it had) point at it
    /// again, then `trashed` goes. Running it again repairs what a crash left.
    static func settleRestored(_ ctx: StoreContext, _ entry: TrashedEntry, _ dir: String) throws {
        let from = [entry.into.map { Paths.join(ctx.dataRoot, trashDir, $0) }, entry.slug.map { Paths.join(ctx.dataRoot, $0) }].compactMap { $0 }.filter { $0 != dir }
        for old in from { try ctx.libraryDb.rewritePathPrefix(old + "/", dir + "/", projectId: entry.id) }
        let file = Paths.join(dir, "project.json")
        if case .object(var meta)? = JSONFiles.read(file), meta["trashed"] != nil { meta["trashed"] = nil; try JSONFiles.write(file, .object(meta)) }
    }

    /// The projects in the trash, newest first; those in it a week purged first (`removeWorktrees`: the Build package's),
    /// and a project whose delete or restore was cut short finished as restored.
    public static func trashedProjects(_ ctx: StoreContext, now: Date = Date(), removeWorktrees: (([JSONValue]) async throws -> Void)? = nil) async throws -> [TrashedProject] {
        for entry in cutShort(ctx) {
            do { try settleRestored(ctx, entry, entry.dir) }
            catch { FileHandle.standardError.write(Data("Engelbart: could not finish restoring \(entry.dir): \(error.localizedDescription)\n".utf8)) }
        }
        let nowMs = now.timeIntervalSince1970 * 1000
        var out: [TrashedProject] = []
        for entry in trashedRecords(ctx) {
            if entry.at < nowMs - Workspaces.trashDays * Workspaces.dayMs {
                do { try await purgeProject(ctx, entry, removeWorktrees: removeWorktrees) }
                catch { FileHandle.standardError.write(Data("Engelbart: could not purge \(entry.dir): \(error.localizedDescription)\n".utf8)) }
                continue
            }
            out.append(TrashedProject(id: entry.id, name: entry.name, deleted: Time.iso(Date(timeIntervalSince1970: entry.at / 1000)),
                                      expires: Time.iso(Date(timeIntervalSince1970: (entry.at + Workspaces.trashDays * Workspaces.dayMs) / 1000)),
                                      workspaceCount: countWorkspaces(entry.dir)))
        }
        return out.stableSorted { $0.deleted > $1.deleted }
    }

    /// Gone for good: open Builds' worktrees (and accepted ones whose copy outlived a crash), the library rows made in it,
    /// its views and places in state.json, then its folder — last, so a purge cut short runs again.
    static func purgeProject(_ ctx: StoreContext, _ entry: TrashedEntry, removeWorktrees: (([JSONValue]) async throws -> Void)?) async throws {
        let open = BuildRecords.list(entry.dir).filter { !BuildRecords.final.contains($0["status"]?.string ?? "") || $0["keptCopy"]?.bool == true }
        if !open.isEmpty, let removeWorktrees { try? await removeWorktrees(open) }
        for row in try ctx.libraryDb.list() where row.projectId == entry.id {
            _ = try? ctx.libraryDb.remove(row.id) // a row a sandbox run still names stays
        }
        try AppState.forgetProject(ctx.dataRoot, entry.id)
        NotesDB.close(projectDir: entry.dir)
        try? FileManager.default.removeItem(atPath: entry.dir)
    }

    /// Restore: back under the folder name it had when free, else the next free one; its open Builds' worktrees follow
    /// (`moveWorktree(task, to)`); one that cannot move is discarded (`removeWorktrees`).
    @discardableResult
    public static func restoreProject(_ ctx: StoreContext, _ id: String, moveWorktree: ((JSONValue, String) async throws -> Void)? = nil,
                                      removeWorktrees: (([JSONValue]) async throws -> Void)? = nil) async throws -> PublicProject {
        try Ids.assert(id, "project")
        if let half = cutShort(ctx).first(where: { $0.id == id }) {
            try settleRestored(ctx, half, half.dir)
            return summary(record(half.dir)!)
        }
        guard let entry = trashedRecords(ctx).first(where: { $0.id == id }) else { throw StoreError("That project is no longer in the trash") }
        let slug: String
        if let old = entry.slug, !rootReserved.contains(old), !Paths.exists(Paths.join(ctx.dataRoot, old)) { slug = old }
        else { slug = freeSlug(ctx, entry.slug ?? entry.name) }
        let back = Paths.join(ctx.dataRoot, slug)
        if slug != entry.slug { await followSlug(ctx, entry, slug, moveWorktree: moveWorktree, removeWorktrees: removeWorktrees) }
        try FileManager.default.moveItem(atPath: entry.dir, toPath: back)
        markMigrated(back)
        try ctx.libraryDb.rewritePathPrefix(entry.dir + "/", back + "/")
        try settleRestored(ctx, entry, back)
        return summary(record(back)!)
    }

    /// A restored project's new folder name: each open Build's worktree moves to worktrees/<slug>/<id>.
    static func followSlug(_ ctx: StoreContext, _ entry: TrashedEntry, _ slug: String, moveWorktree: ((JSONValue, String) async throws -> Void)?,
                           removeWorktrees: (([JSONValue]) async throws -> Void)?) async {
        for task in BuildRecords.list(entry.dir) {
            guard !BuildRecords.final.contains(task["status"]?.string ?? ""), let worktree = task["worktree"]?.string, let taskId = task["id"]?.string else { continue }
            let to = Paths.join(ctx.dataRoot, worktreesDir, slug, taskId)
            if worktree == to { continue }
            let cwdInside = task["cwd"]?.string.map { Paths.relative(worktree, $0) } ?? ""
            let moved: [String: JSONValue] = ["worktree": .string(to), "cwd": .string(cwdInside.isEmpty ? to : Paths.join(to, cwdInside))]
            do {
                // Nothing where it was: moved before a restore was cut short, or gone (Resume makes it again).
                if Paths.exists(worktree) {
                    guard let moveWorktree else { continue } // left where it is: a Build works wherever its record says
                    try await moveWorktree(task, to)
                }
                try BuildRecords.write(entry.dir, task.merging(moved))
            } catch {
                if let removeWorktrees { try? await removeWorktrees([task]) }
                let messages = (task["messages"]?.array ?? []) + [BuildRecords.message("engelbart", "Its copy could not be moved when the project came back from the trash (\(error.localizedDescription)), so it was discarded.")]
                _ = try? BuildRecords.write(entry.dir, task.merging(["status": "discarded", "queued": .null, "finished": .string(Time.iso()), "messages": .array(messages)]))
            }
        }
    }
}
