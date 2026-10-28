import Foundation
import EngelbartCore

/// What every store call works in (ipc.cjs createStore's `ctx`): the person's home, the Engelbart root, the data root of
/// the current mode (root or root/test) and its library database.
public final class StoreContext: @unchecked Sendable {
    public let homeDir: String
    public let root: String
    public let dataRoot: String
    public let mode: String
    public var libraryDb: LibraryDB

    public init(homeDir: String, root: String, dataRoot: String, mode: String = "normal", libraryDb: LibraryDB) {
        self.homeDir = homeDir; self.root = root; self.dataRoot = dataRoot; self.mode = mode; self.libraryDb = libraryDb
    }
}

/// A project as the renderer is sent it (projects.cjs publicProject), with what listProjects / summary add.
public struct PublicProject: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var slug: String
    public var dir: String
    public var created: String?
    /// The project's code directory, nil when none was chosen or it is gone (then `directoryMissing` names it).
    public var directory: String?
    public var directoryMissing: String?
    public var description: String
    public var workspaceCount: Int?
    public var lastEdited: String?
    public var recent: [RecentWorkspace]?
    public var libraryIds: [String]?

    enum CodingKeys: String, CodingKey { case id, name, slug, dir, created, directory, directoryMissing, description, workspaceCount, lastEdited, recent, libraryIds }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(slug, forKey: .slug); try c.encode(dir, forKey: .dir)
        try c.encode(created, forKey: .created); try c.encode(directory, forKey: .directory); try c.encode(directoryMissing, forKey: .directoryMissing)
        try c.encode(description, forKey: .description)
        try c.encodeIfPresent(workspaceCount, forKey: .workspaceCount); try c.encodeIfPresent(lastEdited, forKey: .lastEdited)
        try c.encodeIfPresent(recent, forKey: .recent); try c.encodeIfPresent(libraryIds, forKey: .libraryIds)
    }
}

/// A workspace touched lately, for the all-projects card.
public struct RecentWorkspace: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    public var chars: Int
    public var edited: String?
    public var text: String
}

/// An archived version of a workspace (archive.cjs): `.archive/<file>.md`.
public struct ArchiveEntry: Codable, Equatable, Sendable {
    public var file: String
    public var clearedAt: String?
    public var title: String
    public init(file: String, clearedAt: String?, title: String) { self.file = file; self.clearedAt = clearedAt; self.title = title }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(file, forKey: .file); try c.encode(clearedAt, forKey: .clearedAt); try c.encode(title, forKey: .title)
    }
    enum CodingKeys: String, CodingKey { case file, clearedAt, title }
    var json: JSONValue { ["file": .string(file), "clearedAt": clearedAt.map { .string($0) } ?? .null, "title": .string(title)] }
}

/// A workspace as the renderer is sent it (projects.cjs publicWorkspace).
public struct PublicWorkspace: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var context: [String]
    public var removed: [String]
    public var picked: [String]
    public var chars: Int
    public var builds: [String]
    public var archives: [ArchiveEntry]
    public var created: String?
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(context, forKey: .context)
        try c.encode(removed, forKey: .removed); try c.encode(picked, forKey: .picked); try c.encode(chars, forKey: .chars)
        try c.encode(builds, forKey: .builds); try c.encode(archives, forKey: .archives); try c.encode(created, forKey: .created)
    }
    enum CodingKeys: String, CodingKey { case id, name, context, removed, picked, chars, builds, archives, created }
}

/// One node of a project's workspace tree (projects.cjs workspaceTree): publicWorkspace, its folder name, when its
/// document was last saved, and its children.
public struct WorkspaceNode: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var context: [String]
    public var removed: [String]
    public var picked: [String]
    public var chars: Int
    public var builds: [String]
    public var archives: [ArchiveEntry]
    public var created: String?
    public var folder: String
    public var edited: String?
    public var children: [WorkspaceNode]
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(context, forKey: .context)
        try c.encode(removed, forKey: .removed); try c.encode(picked, forKey: .picked); try c.encode(chars, forKey: .chars)
        try c.encode(builds, forKey: .builds); try c.encode(archives, forKey: .archives); try c.encode(created, forKey: .created)
        try c.encode(folder, forKey: .folder); try c.encode(edited, forKey: .edited); try c.encode(children, forKey: .children)
    }
    enum CodingKeys: String, CodingKey { case id, name, context, removed, picked, chars, builds, archives, created, folder, edited, children }
}

/// Every workspace of a project, flat, with its path from the project directory ("Agents/Inline chat agent").
public struct FlatWorkspace: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    public var context: [String]
    public var removed: [String]
    public var chars: Int
    var hold: ProjectHolds.WorkspaceHold { .init(id: id, context: context, removed: removed) }
}

/// A note as the renderer is sent it (projects.cjs publicNote).
public struct NoteInfo: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    public var workspaceId: String?
    public var created: String
    public var lastEdited: String
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(path, forKey: .path)
        try c.encode(workspaceId, forKey: .workspaceId); try c.encode(created, forKey: .created); try c.encode(lastEdited, forKey: .lastEdited)
    }
    enum CodingKeys: String, CodingKey { case id, name, path, workspaceId, created, lastEdited }
    init(_ row: NoteRow) { id = row.id; name = row.name; path = row.path; workspaceId = row.topicId; created = row.created; lastEdited = row.lastEdited }
}

/// A workspace in the sidebar's trash.
public struct TrashedWorkspace: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var deleted: String
    public var expires: String
    public var nested: Int
}

/// A project in "Recently deleted".
public struct TrashedProject: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var deleted: String
    public var expires: String
    public var workspaceCount: Int
}

/// What `load-project` answers: the project, its workspace tree, its notes and its trash.
public struct ProjectTree: Codable, Equatable, Sendable {
    public var project: PublicProject
    public var workspaces: [WorkspaceNode]
    public var notes: [NoteInfo]
    public var trash: [TrashedWorkspace]
}

/// A document reference (ipc.cjs docRef): a note, a workspace's document, the project page, or (for agents) a mark.
public enum DocRef: Equatable, Sendable {
    case note(id: String)
    case workspace(workspaceId: String)
    case project

    /// How the renderer keys a document (`ws:<id>`, `note:<id>`, `project`).
    public var key: String {
        switch self {
        case .note(let id): return "note:\(id)"
        case .workspace(let id): return "ws:\(id)"
        case .project: return "project"
        }
    }

    /// `{ kind: 'note', id } | { kind: 'workspace', workspaceId } | { kind: 'project' }`.
    public init(json value: JSONValue?) throws {
        guard let value, value.isPlainObject else { throw StoreError.type("doc ref must be an object") }
        switch value["kind"]?.string {
        case "note": self = .note(id: try StoreArgs.str(value["id"], "note id", 64))
        case "workspace": self = .workspace(workspaceId: try StoreArgs.str(value["workspaceId"], "workspace id", 64))
        case "project": self = .project
        default: throw StoreError.type("Unknown doc kind")
        }
    }

    public var json: JSONValue {
        switch self {
        case .note(let id): return ["kind": "note", "id": .string(id)]
        case .workspace(let id): return ["kind": "workspace", "workspaceId": .string(id)]
        case .project: return ["kind": "project"]
        }
    }
}

/// ipc.cjs's argument checks, with its messages.
public enum StoreArgs {
    public static func str(_ value: JSONValue?, _ what: String, _ max: Int = 512) throws -> String {
        guard let s = value?.string, s.count <= max else { throw StoreError.type("\(what) must be a string of at most \(max) characters") }
        return s
    }
    public static func str(_ value: String?, _ what: String, _ max: Int = 512) throws -> String {
        guard let value, value.count <= max else { throw StoreError.type("\(what) must be a string of at most \(max) characters") }
        return value
    }
    public static func optStr(_ value: String?, _ what: String, _ max: Int = 512) throws -> String? {
        guard let value else { return nil }
        return try str(value, what, max)
    }
}

/// A stable sort (JavaScript's Array.prototype.sort is stable; the store's orders rely on it).
extension Array {
    func stableSorted(by less: (Element, Element) -> Bool) -> [Element] {
        enumerated().sorted { a, b in less(a.element, b.element) || (!less(b.element, a.element) && a.offset < b.offset) }.map(\.element)
    }
}
