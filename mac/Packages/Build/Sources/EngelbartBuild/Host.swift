import Foundation
import EngelbartCore

// What Build needs from the rest of the app, as protocols the app implements (ARCHITECTURE §2: a wave-1 package never
// depends on Store or another feature package). The Electron code reached these through `ctx` (the data root and the
// library database), store/projects.cjs, store/library.cjs, store/archive.cjs, context/expand-mentions.cjs,
// bart/context.cjs, store/onboarding.cjs, connect/memory.cjs and bart/models.cjs.

/// A project as Build reads it (store/projects.cjs findProject).
public struct BuildProject: Sendable, Equatable {
    public var id: String
    public var name: String
    /// The folder name under the data root (`worktrees/<slug>/<id>`).
    public var slug: String
    /// The project's Engelbart folder (`<dataRoot>/<slug>`), where `builds/` and `project.json` live.
    public var dir: String
    /// The code directory (project.json `directory`), when there is one.
    public var directory: String?
    public var description: String?
    /// project.json `defaultTarget` ({ kind: 'project' } or { kind: 'library', id }), nil when not set yet.
    public var defaultTarget: JSONValue?
    /// project.json `defaultRepo` (a folder name a Build of an older branch made), for migrateDefault.
    public var defaultRepo: String?

    public init(id: String, name: String, slug: String, dir: String, directory: String? = nil, description: String? = nil,
                defaultTarget: JSONValue? = nil, defaultRepo: String? = nil) {
        self.id = id; self.name = name; self.slug = slug; self.dir = dir; self.directory = directory
        self.description = description; self.defaultTarget = defaultTarget; self.defaultRepo = defaultRepo
    }
}

public struct BuildWorkspace: Sendable, Equatable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

/// The newest archived version of a workspace (store/archive.cjs latestArchive).
public struct BuildArchive: Sendable, Equatable {
    public var file: String
    public var clearedAt: String?
    public var text: String
    public init(file: String, clearedAt: String?, text: String) { self.file = file; self.clearedAt = clearedAt; self.text = text }
}

/// A library row (library.pglite → library). Only the columns Build reads are typed; `fields` holds the row as the
/// Store has it, for whatever a host wants to round-trip.
public struct LibraryRow: Sendable, Equatable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public var path: String?
    public var folderPath: String?
    public var url: String?
    public var projectId: String?
    public var githubId: JSONValue?

    public init(id: String, name: String, type: String, tags: [String] = [], path: String? = nil, folderPath: String? = nil,
                url: String? = nil, projectId: String? = nil, githubId: JSONValue? = nil) {
        self.id = id; self.name = name; self.type = type; self.tags = tags; self.path = path; self.folderPath = folderPath
        self.url = url; self.projectId = projectId; self.githubId = githubId
    }

    /// A folder tagged git: a repository row (manager.cjs isRepo).
    public var isRepo: Bool { tags.contains("git") }
}

/// The ids already expanded into a Build's first message (context.cjs `seen`): shared between expansions, as the Set
/// was, so a note mentioned twice is placed once.
public final class MentionSeen: @unchecked Sendable {
    private let lock = NSLock()
    private var ids = Set<String>()
    public init(_ ids: Set<String> = []) { self.ids = ids }
    public func insert(_ id: String) { lock.lock(); ids.insert(id); lock.unlock() }
    public func contains(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
    public var all: Set<String> { lock.lock(); defer { lock.unlock() }; return ids }
}

/// Everything Build reads and writes outside its own records. The Store (projects, library, archive), the Doc/Bart
/// context expansion and the onboarding/memory blocks are adapted to it by the app.
public protocol BuildHost: AnyObject, Sendable {
    /// `ctx.dataRoot`: the data root in force (test mode's root in test mode).
    var dataRoot: String { get }
    /// `ctx.homeDir`: the person's home (for `~/` in the agent's paths).
    var homeDir: String { get }

    // --- projects (store/projects.cjs)
    /// Throws "Unknown project" (or the Store's own error) when it is not there.
    func project(_ projectId: String) throws -> BuildProject
    /// Every project record (projects.projectRecords), for recovery.
    func projectRecords() -> [BuildProject]
    /// `projects.findWorkspace(ctx, projectId, workspaceId)`; a nil id is the project's first workspace. Throws when gone.
    func workspace(_ projectId: String, _ workspaceId: String?) throws -> BuildWorkspace
    func setDefaultTarget(_ projectId: String, _ target: JSONValue) throws
    func addWorkspaceBuild(_ projectId: String, _ workspaceId: String, _ buildId: String) throws
    func linkToWorkspace(_ projectId: String, _ workspaceId: String, _ ids: [String]) async throws
    /// ⌘J's recent workspaces (projects.recordEdit).
    func recordEdit(_ projectId: String, _ workspaceId: String)
    /// state.json → agents (B20): `{ id, kind: 'build', projectId, workspaceId, doc }`.
    func agentStarted(_ record: JSONValue)
    func agentFinished(_ id: String)
    func agentStopped(_ id: String)
    /// The workspace's document text (projects.readDoc).
    func readWorkspaceDoc(_ projectId: String, _ workspaceId: String) async throws -> String
    func latestArchive(_ projectId: String, _ workspaceId: String) -> BuildArchive?
    /// archive.importTask: one more archived version, "Imported from Task:" → `{ file, clearedAt, title }`.
    func importTask(_ projectId: String, _ workspaceId: String, text: String, buildId: String) async throws -> JSONValue
    /// projects.createNote → the note's library row.
    func createNote(_ projectId: String, name: String, workspaceId: String?, text: String) async throws -> LibraryRow
    /// The project page block (projects.projectPageBlock), the custom instructions (`<custom_instructions>`,
    /// store/onboarding.cjs instructionsBlock) and MEMORY.md (connect/memory.cjs memoryBlock), when there are any.
    func projectPageBlock(_ projectId: String) -> String?
    func instructionsBlock() -> String?
    func memoryBlock() -> String?

    // --- library (store/library.cjs, ctx.libraryDb)
    func libraryRow(_ id: String) async -> LibraryRow?
    func libraryRows() async -> [LibraryRow]
    /// libraryForProject: the rows this project holds (made in it, or in one of its workspaces' context).
    func libraryRows(forProject projectId: String) async -> [LibraryRow]
    /// insert: `fields` are the row's columns (id, name, type, tags, folder_path, project_id, source, category…).
    func insertLibraryRow(_ fields: [String: JSONValue]) async throws -> LibraryRow
    func updateRepo(_ id: String, name: String, url: String?, folderPath: String, githubId: JSONValue?) async throws
    /// library.addItem(ctx, file, { inspectPdf, name }): a file of a format the library reads, kept as it is.
    func addLibraryItem(file: String, name: String?) async throws -> LibraryRow
    /// library.addFileCopy: a pdf or a picture saved as Engelbart's own copy.
    func addFileCopy(bytes: Data, mime: String, name: String) async throws -> LibraryRow
    /// library.FILE_TYPES: the library type of a lowercase extension (".md" → "md"), nil when it does not keep it.
    func libraryFileType(_ ext: String) -> String?
    var libraryFileExtensions: [String] { get }

    // --- the first message (context/expand-mentions.cjs, bart/context.cjs)
    /// `expandMentions(text, source, seen)`: the text with every mention's file placed under its line.
    func expandMentions(_ text: String, projectId: String, rows: [LibraryRow], seen: MentionSeen) async -> String
    /// `expandRows(rows, source, seen)`: the rows as `<file>` blocks.
    func expandRows(_ rows: [LibraryRow], projectId: String, allRows: [LibraryRow], seen: MentionSeen) async -> String
    /// `JSON.stringify(catalogEntries(project, rows, seen), null, 1)`.
    func catalogJSON(projectId: String, rows: [LibraryRow], seen: MentionSeen) -> String

    // --- repo_runnables (library.sqlite)
    var runnables: RepoRunnablesTable { get }
}

/// One row of repo_runnables.
public struct RunnableRow: Sendable, Equatable {
    public var id: String
    public var libraryId: String
    public var folder: String
    public var name: String
    public var type: String
    public var status: String // pending | verified | failed
    public var installCommand: String?
    public var runCommand: String?
    public var lastError: String?
    public var verifiedCommit: String?
    public init(id: String, libraryId: String, folder: String, name: String, type: String, status: String = "pending",
                installCommand: String? = nil, runCommand: String? = nil, lastError: String? = nil, verifiedCommit: String? = nil) {
        self.id = id; self.libraryId = libraryId; self.folder = folder; self.name = name; self.type = type; self.status = status
        self.installCommand = installCommand; self.runCommand = runCommand; self.lastError = lastError; self.verifiedCommit = verifiedCommit
    }
}

/// repo_runnables as the Store keeps it in library.sqlite (src/main/store/db.cjs). The SQL each method stands for is in
/// API.md; `MemoryRunnablesTable` is the reference semantics. Values arrive validated (Runnables.swift).
public protocol RepoRunnablesTable: Sendable {
    /// `select * from repo_runnables where library_id = $1 order by folder, name`
    func list(libraryId: String) async throws -> [RunnableRow]
    func get(id: String) async throws -> RunnableRow?
    /// insert … on conflict (library_id, folder, name) do update: type replaced; the same type keeps status and
    /// commands, another type is `pending` with no commands; updated_at = now. Throws when the library row is unknown.
    func declare(id: String, libraryId: String, folder: String, name: String, type: String) async throws -> RunnableRow
    /// status verified, the commands, verified_commit, last_error null.
    func verify(id: String, installCommand: String?, runCommand: String, commit: String?) async throws -> RunnableRow?
    /// status failed, last_error.
    func fail(id: String, error: String) async throws -> RunnableRow?
}

/// The CLIs' tool lock and Engelbart's own Git (../tools): `use` holds a CLI while a turn runs (updates wait), `ensure`
/// installs/updates it first when needed.
public protocol BuildTools: Sendable {
    func use<T: Sendable>(_ agent: String, _ work: @Sendable () async throws -> T) async throws -> T
    func ensure(_ agent: String) async throws
    /// Added to every child's environment (ENGELBART_GIT_BIN while Engelbart's own Git stands in, ENGELBART_AGENT_PATH).
    func environment() -> [String: String]
    /// A CLI's binary when the tool check found it somewhere its name does not reach (ENGELBART_<NAME>_BIN).
    func binaryFor(_ name: String) -> String?
}

/// The Agent map's record of each turn (bart/runlog.cjs; a developer copy's only). Never in a Build's way.
public protocol BuildRunLog: Sendable {
    func start(_ record: JSONValue)
    func step(_ id: String, _ step: JSONValue)
    func event(_ id: String, _ event: JSONValue)
    func output(_ id: String, _ output: JSONValue)
    func note(_ id: String, _ note: JSONValue)
    func finish(_ id: String, _ end: JSONValue)
}

/// Where announcements go (the Electron `notify(channel, payload)`): by default the app's EventHub.
public typealias BuildNotify = @Sendable (_ channel: String, _ payload: JSONValue) -> Void
