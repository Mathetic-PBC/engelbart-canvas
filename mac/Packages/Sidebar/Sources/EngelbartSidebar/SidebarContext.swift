import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartIntegrations
import EngelbartStore

// What the app (the Workspace screen) gives the sidebar: Rail.jsx's props, split into the data it draws (`SidebarInput`,
// handed again with `update(_:)` whenever the Workspace's state changes), what the sidebar does with it (`SidebarActions`,
// the Workspace's handlers) and what it asks the Store for itself (`SidebarServices`: lookups, previews, bodies, the
// project list for the switcher, the file picker, and the person's folders, which the sidebar now loads and follows on
// `engelbart:folders` itself, as Workspace.jsx did for it).

/// The top-level project the switcher picked.
public struct SidebarProject: Equatable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

/// A sticky being dragged over the workspace (Workspace.jsx postItDrag): `over` while it is over the sidebar's foot.
public struct StickyDrag: Equatable, Sendable {
    public var active: Bool
    public var over: Bool
    public init(active: Bool, over: Bool = false) { self.active = active; self.over = over }
}

public struct SidebarInput: Equatable {
    /// The sidebar's width (the Workspace's railWidth, clamped 220–520).
    public var width: CGFloat = 300
    /// Folded away (⌘\) or the document's full screen (MATH-23): not drawn, kept as it is.
    public var hidden = false
    public var project: SidebarProject
    /// The top-level project's tree (level 2 down).
    public var roots: [ProjectNode] = []
    /// The project open here (a level 2–4 one), or nil.
    public var hereId: String? = nil
    /// state.json `recent`, this top-level project's.
    public var recent: [RecentPlace] = []
    /// The clock's visits (this machine's, per top-level project).
    public var visits: [Visit] = []
    /// Agents' rows: SidebarModel.keptAgents(agentEntries + repoEntries, marks, now).
    public var entries: [AgentEntry] = []
    /// The switcher's counts (SidebarModel.projectCounts).
    public var projectCounts: [String: AgentSummary] = [:]
    /// This project's sources, newest opened first (SidebarModel.byOpened).
    public var rows: [LibraryRow] = []
    /// The source open in front (a tab or the Stage's front page).
    public var activeRowId: String? = nil
    /// A row that just arrived (it flashes).
    public var flashId: String? = nil
    /// The library the searches see (letGo notes left out).
    public var library: [LibraryRow] = []
    /// What this project holds (inRail).
    public var inRail: Set<String> = []
    /// New note is offered (a project is open here).
    public var canNewNote = true
    /// The stickies' Show/Hide works (this window is the active one).
    public var canToggleStickies = true
    public var stickiesHidden = false
    /// The trash holds something (stickies thrown away, or projects trashed).
    public var trashFull = false
    public var stickyDrag: StickyDrag? = nil
    /// The sidebar is folded away (for the shortcuts dialog's "Show/Hide sidebar").
    public var railHidden = false
    /// The sidebar tour's card (0–2), nil when none is up.
    public var tourStep: Int? = nil
    /// The person's folders. nil: the sidebar loads them from the Store and follows `engelbart:folders` itself.
    public var folders: [AppState.Folder]? = nil

    public init(project: SidebarProject) { self.project = project }
}

/// The Workspace's handlers (Rail.jsx's `on…` props).
public struct SidebarActions {
    // the top-level project
    public var openProject: (String) -> Void = { _ in }
    public var newProject: () -> Void = {}
    public var allProjects: () -> Void = {}
    public var renameProject: (String) -> Void = { _ in }
    public var openProjectPage: () -> Void = {}
    /// The gear (App's Settings; RootModel.settingsPage).
    public var openSettings: () -> Void = {}
    // projects of the tree
    public var selectWorkspace: (String) -> Void = { _ in }
    public var createWorkspace: (_ name: String, _ parentId: String?) async throws -> Void = { _, _ in }
    public var renameWorkspace: (String, String) -> Void = { _, _ in }
    public var deleteWorkspace: (String) -> Void = { _ in }
    public var openVersion: (ArchivedVersion) -> Void = { _ in }
    // agents
    /// A row of Agents pressed; the rect is the row's (window content, y down), for the quick task's card.
    public var goAgent: (AgentEntry, CGRect?) -> Void = { _, _ in }
    /// A row's × (nil: no ×).
    public var dismissAgent: ((AgentEntry) -> Void)? = { _ in }
    public var nextAgent: () -> Void = {}
    public var seenAll: () -> Void = {}
    public var toggleRail: () -> Void = {}
    // sources
    public var openRow: (LibraryRow) -> Void = { _ in }
    public var renameRow: (LibraryRow, String) -> Void = { _, _ in }
    /// Off this project (meta.json `removed`), never out of the library.
    public var removeRow: (LibraryRow) -> Void = { _ in }
    /// Brings a library row into this project.
    public var linkRow: (LibraryRow) async throws -> Void = { _ in }
    /// Another project's place, from a peek's "held by".
    public var openHeld: (_ projectId: String, _ workspaceId: String?) -> Void = { _, _ in }
    /// Files, pictures or links dropped on Sources.
    public var dropItems: ([Drop.Item]) async -> Void = { _ in }
    /// A link or a path added to this project (Workspace addInput: addOrFind + link) → the row.
    public var addInput: (String) async throws -> LibraryRow = { _ in throw StoreError("No project open") }
    /// "Upload or add files" / "Choose from disk…" into this project → what could not be added.
    public var pickDisk: () async -> [String] = { [] }
    /// A new note in this project (opened as a tab) → its id.
    public var newNote: () async throws -> String? = { nil }
    /// A GitHub repository picked into this project.
    public var pickRepo: (GithubRow) async throws -> Void = { _ in }
    /// The library changed under the sidebar (it added a row into a folder): the app reloads.
    public var libraryChanged: () async -> Void = {}
    /// A row just arrived (Workspace flash).
    public var flash: (String) -> Void = { _ in }
    // the foot
    public var toggleStickies: () -> Void = {}
    /// The trash beside its button (the PostIts package's TrashPanel); the rect is the button's (window content, y down).
    public var openTrash: (NSWindow, CGRect) -> Void = { _, _ in }
    /// A panel opened (`agents`, `library`, …): the walkthrough ticks step 1 on Library.
    public var panelOpened: (String) -> Void = { _ in }
    public init() {}
}

/// What the sidebar asks the Store for. `SidebarServices.store(_:)` wires a Store; tests pass fakes.
public struct SidebarServices {
    public var lookup: (String) async throws -> Library.Lookup = { _ in StoreValues.lookup() }
    public var preview: (String) async throws -> Library.Preview = { id in StoreValues.preview(id: id) }
    /// What the project's (or, with nil, the whole library's) things say.
    public var bodies: (String?) async throws -> Library.Bodies = { _ in StoreValues.bodies() }
    public var listProjects: () async throws -> [PublicProject] = { [] }
    /// The native file picker ("Upload or add files").
    public var pickPaths: () async -> [String] = { [] }
    /// `library.addItem` (refuses a duplicate with StoreError EXISTS).
    public var addLibraryItem: (String) async throws -> LibraryRow = { _ in throw StoreError("Not wired") }
    public var folders: () async throws -> [AppState.Folder] = { [] }
    public var createFolder: (String) async throws -> [AppState.Folder] = { _ in [] }
    public var renameFolder: (String, String) async throws -> [AppState.Folder] = { _, _ in [] }
    public var deleteFolder: (String) async throws -> [AppState.Folder] = { _ in [] }
    public var addToFolder: (String, [String]) async throws -> [AppState.Folder] = { _, _ in [] }
    public var removeFromFolder: (String, String) async throws -> [AppState.Folder] = { _, _ in [] }
    public init() {}

    public static func store(_ store: Store) -> SidebarServices {
        var s = SidebarServices()
        s.lookup = { try await store.lookupLibraryItem($0) }
        s.preview = { try await store.previewLibraryItem($0) }
        s.bodies = { try await store.libraryBodies($0) }
        s.listProjects = { try await store.listProjects() }
        s.pickPaths = { await store.pickLibraryPaths("any") }
        s.addLibraryItem = { try await store.addLibraryItem($0).row }
        s.folders = { try await store.folders() }
        s.createFolder = { try await store.createFolder($0).folders }
        s.renameFolder = { try await store.renameFolder($0, $1) }
        s.deleteFolder = { try await store.deleteFolder($0) }
        s.addToFolder = { try await store.addToFolder($0, $1) }
        s.removeFromFolder = { try await store.removeFromFolder($0, $1) }
        return s
    }
}

/// Everything the sidebar is made with.
public struct SidebarContext {
    public var services: SidebarServices
    public var actions: SidebarActions
    /// This machine's conveniences (localStorage's keys).
    public var storage: KeyValueStorage
    public var hub: EventHub
    /// The + menu's GitHub view (Integrations; nil: "Add from GitHub" is not offered).
    public var github: GithubPaneModel?
    /// Timings (tests shorten them).
    public var timing: SidebarTiming
    public init(services: SidebarServices = SidebarServices(), actions: SidebarActions = SidebarActions(), storage: KeyValueStorage = UserDefaultsStorage(),
                hub: EventHub = .shared, github: GithubPaneModel? = nil, timing: SidebarTiming = SidebarTiming()) {
        self.services = services; self.actions = actions; self.storage = storage; self.hub = hub; self.github = github; self.timing = timing
    }
}

/// The sidebar's beats (Rail.jsx, SidebarPanels.jsx), in seconds.
public struct SidebarTiming {
    /// HOVER_OPEN / PEEK_OPEN: a hover card, a tooltip or a peek shows after resting this long.
    public var open: TimeInterval = 0.35
    /// HOVER_SWITCH: from one hover card to the next.
    public var switchTo: TimeInterval = 0.09
    /// HOVER_CLOSE: gone this long after the pointer left.
    public var close: TimeInterval = 0.18
    /// PICKER_LEAVE: the add picker hides this long after the pointer left it.
    public var pickerLeave: TimeInterval = 0.18
    /// The project menu's Switch list stays this long after the pointer moved to another row.
    public var switchShut: TimeInterval = 0.3
    /// Lookups wait this long after typing stops.
    public var lookup: TimeInterval = 0.12
    /// The added flash.
    public var flash: TimeInterval = 1.6
    public init() {}
}

/// Store values made here (their memberwise initializers are internal to the Store): through their JSON, as the Store
/// itself would write them. For fakes, tests and adapters.
public enum StoreValues {
    static func make<T: Decodable>(_ json: JSONValue) -> T? { try? json.decode(T.self) }

    public static func lookup(row: LibraryRow? = nil, found: Library.Found? = nil, error: String? = nil) -> Library.Lookup {
        make(.object(["row": row.map(\.json) ?? .null, "found": found.map { JSONValue.encode($0) } ?? .null, "error": error.map { .string($0) } ?? .null]))!
    }
    public static func preview(id: String, text: String? = nil, lines: [String]? = nil, files: [String]? = nil, owner: String? = nil, folder: String? = nil,
                               folderMissing: String? = nil, heldBy: [Library.Holder] = []) -> Library.Preview {
        func s(_ v: String?) -> JSONValue { v.map { .string($0) } ?? .null }
        func a(_ v: [String]?) -> JSONValue { v.map { .array($0.map { .string($0) }) } ?? .null }
        return make(.object(["id": .string(id), "text": s(text), "lines": a(lines), "files": a(files), "owner": s(owner), "folder": s(folder),
                             "folderMissing": s(folderMissing), "heldBy": .array(heldBy.map { JSONValue.encode($0) })]))!
    }
    public static func holder(id: String, name: String, origin: Bool = false, workspaces: [(id: String, name: String, path: String)] = []) -> Library.Holder {
        make(.object(["id": .string(id), "name": .string(name), "origin": .bool(origin),
                      "workspaces": .array(workspaces.map { .object(["id": .string($0.id), "name": .string($0.name), "path": .string($0.path)]) })]))!
    }
    public static func bodies(items: [String: String] = [:], workspaces: [String: String] = [:]) -> Library.Bodies {
        make(.object(["items": .object(items.mapValues { .string($0) }), "workspaces": .object(workspaces.mapValues { .string($0) })]))!
    }
    public static func folder(id: String, name: String, items: [String] = [], created: String? = nil) -> AppState.Folder {
        make(.object(["id": .string(id), "name": .string(name), "items": .array(items.map { .string($0) }), "created": created.map { .string($0) } ?? .null]))!
    }
    public static func project(id: String, name: String) -> PublicProject {
        make(.object(["id": .string(id), "name": .string(name), "slug": .string(name), "dir": .string("/tmp/\(name)"), "description": .string("")]))!
    }
    /// The folders an `engelbart:folders` payload carries.
    public static func folders(_ payload: JSONValue?) -> [AppState.Folder]? {
        guard let list = payload?["folders"]?.array else { return nil }
        return list.compactMap { make($0) }
    }
}
