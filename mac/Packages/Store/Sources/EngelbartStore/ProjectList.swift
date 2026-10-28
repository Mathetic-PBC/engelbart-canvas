import Foundation
import EngelbartCore

/// The project's own list (2026-10-11, the Library's Phase A): project.json `library` and `removed`. Removing takes a row
/// off the list, onto `removed`, and out of every workspace; removed wins over every other way a project holds a row.
extension Projects {
    public static let maxProjectChange = 200

    /// The ids one add or remove may take: at most 200, refused past that (the Library sends them in batches).
    static func projectChange(_ ids: [String]) throws -> [String] {
        if ids.count > maxProjectChange { throw StoreError.range("At most \(maxProjectChange) items can be added or removed at once; \(ids.count) were sent.") }
        var out: [String] = []
        for id in ids { let checked = try Ids.assert(id, "library"); if !out.contains(checked) { out.append(checked) } }
        return out
    }

    static func patchProjectMeta(_ project: Record, _ patch: [String: JSONValue]) throws {
        let file = Paths.join(project.dir, "project.json")
        try JSONFiles.write(file, (JSONFiles.read(file) ?? .object([:])).merging(patch))
    }

    static func ids(_ list: [String]) -> JSONValue { .array(list.map { .string($0) }) }

    public struct Added: Codable, Equatable, Sendable { public var added: Int; public var inWorkspace: Int; public var sandboxError: String?
        enum CodingKeys: String, CodingKey { case added, inWorkspace, sandboxError = "sandbox_error" } }

    /// Onto the project's list and off its `removed`; with `workspaceId`, into that workspace's context too, as many as it
    /// has room for. Unknown ids → "Not in the library: …".
    @discardableResult
    public static func addToProject(_ ctx: StoreContext, _ projectId: String, _ ids: [String], workspaceId: String? = nil) throws -> Added {
        let adding = try projectChange(ids)
        let project = try find(ctx, projectId)
        let workspace = try workspaceId.map { try Workspaces.find(ctx, projectId, $0).workspace }
        var missing: [String] = []
        for id in adding where try ctx.libraryDb.get(id) == nil { missing.append(id) }
        if !missing.isEmpty { throw StoreError("Not in the library: \(missing.joined(separator: ", "))") }
        try patchProjectMeta(project, ["library": self.ids(project.library + adding.filter { !project.library.contains($0) }),
                                       "removed": self.ids(project.removed.filter { !adding.contains($0) })])
        guard let workspace else { return Added(added: adding.count, inWorkspace: 0) }
        let room = max(0, maxTreeEntries - workspace.context.count)
        let fits = Array(adding.filter { !workspace.context.contains($0) }.prefix(room))
        let linking = adding.filter { workspace.context.contains($0) || fits.contains($0) }
        if !linking.isEmpty { try Workspaces.link(ctx, projectId, workspace.id, linking) }
        return Added(added: adding.count, inWorkspace: linking.count)
    }

    /// Off the project's list, onto `removed`, and out of every workspace. A row written here (made in the project, its
    /// source engelbart or unknown) is refused: that is the trash's. → removed count
    @discardableResult
    public static func removeFromProject(_ ctx: StoreContext, _ projectId: String, _ ids: [String]) throws -> Int {
        let going = try projectChange(ids)
        let project = try find(ctx, projectId)
        var made: [String] = []
        for id in going {
            if let row = try ctx.libraryDb.get(id), row.projectId == project.id, row.source == nil || row.source == "engelbart" { made.append(row.name) }
        }
        if !made.isEmpty {
            throw StoreError("Made in this project, so it goes to the trash instead of being removed (only what was brought in from elsewhere can be removed): \(made.joined(separator: ", "))")
        }
        try patchProjectMeta(project, ["library": self.ids(project.library.filter { !going.contains($0) }),
                                       "removed": self.ids(project.removed.filter { !going.contains($0) } + going)])
        for workspace in Workspaces.flatten(project.dir) { try Workspaces.unlink(ctx, projectId, workspace.id, going) }
        return going.count
    }

    /// Rows an import brought in, onto the project's list: not one on `removed`. No cap. → the ids that went on
    @discardableResult
    public static func keepInProject(_ ctx: StoreContext, _ projectId: String, _ ids: [String]) throws -> [String] {
        let project = try find(ctx, projectId)
        var fresh: [String] = []
        for id in ids where Ids.isUUID(id) && !project.library.contains(id) && !project.removed.contains(id) && !fresh.contains(id) { fresh.append(id) }
        if !fresh.isEmpty { try patchProjectMeta(project, ["library": self.ids(project.library + fresh)]) }
        return fresh
    }

    public struct WorkspacePlace: Codable, Equatable, Sendable { public var id: String; public var name: String; public var path: String }

    /// The workspaces whose document mentions the item (the rail's grammar).
    public static func projectItemMentions(_ ctx: StoreContext, _ projectId: String, _ id: String) throws -> [WorkspacePlace] {
        let project = try find(ctx, projectId)
        guard let row = try ctx.libraryDb.get(try Ids.assert(id, "library")) else { throw StoreError("Unknown library item") }
        return Workspaces.flatten(project.dir).compactMap { workspace in
            let text = (try? String(contentsOfFile: Paths.join(project.dir, workspace.path, "workspace.md"), encoding: .utf8)) ?? ""
            return Mentions.mentionedIds(text, library: [row]).contains(row.id) ? WorkspacePlace(id: workspace.id, name: workspace.name, path: workspace.path) : nil
        }
    }
}
