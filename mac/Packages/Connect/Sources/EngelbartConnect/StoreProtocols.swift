import Foundation
import EngelbartCore

// What Connect needs from the Store and Integrations (the dependency rule: the app adapts EngelbartStore, the Zotero and
// GitHub parts of EngelbartIntegrations to these). The Electron code called src/main/store/library.cjs, projects.cjs and
// zotero/mirror.cjs directly; these are exactly the calls it made.

/// A library row as Connect sees it (store/library.cjs row).
public struct LibraryRow: Sendable, Equatable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public init(id: String, name: String, type: String = "", tags: [String] = []) { self.id = id; self.name = name; self.type = type; self.tags = tags }
}

/// library.cjs's EXISTS: the thing is in the library already (`row`, when it can say which).
public struct LibraryExists: Error, Sendable { public var row: LibraryRow?; public init(row: LibraryRow?) { self.row = row } }

/// The library, the projects and the data root as the import tools and the session use them.
public protocol ConnectStore: AnyObject, Sendable {
    /// The data root open now (`store.context().dataRoot`): a session stops when it is no longer its own.
    func dataRoot() async -> String
    /// Every row (for the librarian's library counts: their type and tags).
    func rows() async -> [LibraryRow]
    /// library.addMarkdownCopy: `<data root>/assets/md/<id>/<name>.md`, its pictures copied beside it.
    func addMarkdownCopy(name: String, text: String, pictures: [Notes.Picture], about: JSONValue?) async throws -> LibraryRow
    /// library.addItem (describe, identifyRepo and inspectPdf as the sidebar's add): a link, an id or a path in place.
    /// Throws LibraryExists.
    func addItem(_ input: String, name: String?, describe: Bool, about: JSONValue?) async throws -> LibraryRow
    /// library.addFileCopy: bytes kept as the library's own copy (a downloaded pdf or picture). Throws LibraryExists.
    func addFileCopy(bytes: Data, mime: String, name: String, url: String?, about: JSONValue?) async throws -> LibraryRow
    /// deps.inspectPdf: the tags reading a pdf's first pages gives ('paper' among them for a research paper).
    func inspectPdf(_ path: String) async throws -> [String]

    // Projects (store/projects.cjs).
    func projectDir(_ projectId: String) async -> String?
    func workspaceExists(projectId: String, workspaceId: String) async -> Bool
    func saveImage(projectId: String, bytes: Data, mime: String, name: String) async throws -> String
    func createNote(projectId: String, name: String, text: String) async throws -> (id: String, name: String)
    /// projects.keepInProject → the ids put on the project's list; `removed` the ones the person took out before.
    func keepInProject(projectId: String, rowIds: [String]) async throws -> (listed: [String], removed: [String])
    /// projects.findWorkspace + linkToWorkspace for onboarding's Welcome workspace → the ids linked.
    func linkToWorkspace(projectId: String, workspaceId: String, rowIds: [String]) async throws -> [String]
    /// projects.listProjects names (discovery's "existing").
    func projectNames() async -> [String]
}

/// Zotero (Integrations owns the sign-in and the mirror; zotero/mirror.cjs functions as closures).
public struct ConnectZotero: @unchecked Sendable {
    public var status: () -> ZoteroStatus?
    public var root: () -> String?
    /// zoteroLibrary.download(key, filename) → the file's path.
    public var download: ((String, String) async throws -> String)?
    /// zotero.connect(): Engelbart's own sign-in started → { connected } | { pending: { userCode? } } | { failed }.
    public var connect: (() async throws -> JSONValue)?
    /// zoteroLibrary.autoSync(): the first sync, waited for → its status ({ state, error? }).
    public var ready: (() async -> JSONValue?)?
    public var syncWaitMs: Double?
    // zotero/mirror.cjs
    public var itemOf: (String, String) -> JSONValue?
    public var collectionNames: (String, JSONValue) -> [String]
    public var openableOf: (JSONValue) -> JSONValue?
    /// The attachment's file on this Mac → (path, source: 'downloaded' | …) or nil.
    public var localFile: (String, JSONValue) -> (path: String, source: String)?
    public init(status: @escaping () -> ZoteroStatus?, root: @escaping () -> String?, download: ((String, String) async throws -> String)? = nil,
                connect: (() async throws -> JSONValue)? = nil, ready: (() async -> JSONValue?)? = nil, syncWaitMs: Double? = nil,
                itemOf: @escaping (String, String) -> JSONValue? = { _, _ in nil }, collectionNames: @escaping (String, JSONValue) -> [String] = { _, _ in [] },
                openableOf: @escaping (JSONValue) -> JSONValue? = { _ in nil }, localFile: @escaping (String, JSONValue) -> (path: String, source: String)? = { _, _ in nil }) {
        self.status = status; self.root = root; self.download = download; self.connect = connect; self.ready = ready; self.syncWaitMs = syncWaitMs
        self.itemOf = itemOf; self.collectionNames = collectionNames; self.openableOf = openableOf; self.localFile = localFile
    }
    public static let none = ConnectZotero(status: { nil }, root: { nil })
    var scan: ScanZotero { let s = status, r = root; return ScanZotero(status: { s() }, root: { r() }) }
}

/// GitHub (Integrations): its sign-in and the repositories it can read.
public struct ConnectGitHub: @unchecked Sendable {
    public var status: () -> GitHubStatus?
    /// github.repos({ dirs }) → { repos: [{ fullName, url, description, private }], missingOrgs: [{ login, repos }] }.
    public var repos: (([String]) async throws -> JSONValue)?
    public var connect: (() async throws -> JSONValue)?
    public init(status: @escaping () -> GitHubStatus?, repos: (([String]) async throws -> JSONValue)? = nil, connect: (() async throws -> JSONValue)? = nil) {
        self.status = status; self.repos = repos; self.connect = connect
    }
    public static let none = ConnectGitHub(status: { nil })
    var scan: ScanGitHub {
        let s = status, r = repos
        return ScanGitHub(status: { s() }, repos: r.map { fetch in { dirs in
            let v = try await fetch(dirs)
            return GitHubRepos(repos: (v["repos"]?.array ?? []).map { JS.string($0["fullName"]) },
                               missingOrgs: (v["missingOrgs"]?.array ?? []).map { (JS.string($0["login"]), $0["repos"]?.array?.count ?? 0) })
        } })
    }
}
