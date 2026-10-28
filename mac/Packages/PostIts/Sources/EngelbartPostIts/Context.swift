import AppKit
import SwiftUI
import EngelbartCore
import EngelbartStore
import EngelbartBuild

/// What the post-its need of the app's data. `StorePostItsData` adapts the Store.
public protocol PostItsData: AnyObject {
    /// The project's folder, where its `notes.sqlite` (with `post_its`) is.
    func projectDir(_ projectId: String) async throws -> String
    /// +Note (projects.createNote with text): a note in no workspace. → its id and name.
    func createNote(_ projectId: String, name: String, text: String) async throws -> (id: String, name: String)
    /// The name of a workspace a quick task was added to (nil when it is gone).
    func workspaceName(_ projectId: String, _ workspaceId: String) async -> String?
}

/// The Store as post-its read it (views.cjs: findProject, openNotesDb, createNote, findWorkspace).
public final class StorePostItsData: PostItsData {
    let store: Store
    public init(store: Store) { self.store = store }
    public func projectDir(_ projectId: String) async throws -> String { try Projects.find(try await store.context(), projectId).dir }
    public func createNote(_ projectId: String, name: String, text: String) async throws -> (id: String, name: String) {
        let note = try Documents.createNote(try await store.context(), projectId, name: name, workspaceId: nil, text: text)
        return (note.id, note.name)
    }
    public func workspaceName(_ projectId: String, _ workspaceId: String) async -> String? {
        guard let ctx = try? await store.context() else { return nil }
        return try? Workspaces.find(ctx, projectId, workspaceId).workspace.name
    }
}

/// The Build calls post-its make (preload.cjs build*). `BuildService` is one.
public protocol PostItsBuild: AnyObject {
    func buildModels(_ place: String) async throws -> JSONValue
    func rememberModelChoice(_ place: String, provider: String, model: String, effort: String) async throws
    func buildPreflight(_ projectId: String, _ target: JSONValue?) async throws -> JSONValue
    func buildStart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue
    func buildList(_ projectId: String) async throws -> [JSONValue]
    func buildStop(_ projectId: String, _ id: String) async throws -> Bool
    func buildDiscard(_ projectId: String, _ id: String) async throws -> JSONValue
    func buildPromote(_ projectId: String, _ id: String, _ workspaceId: String, choice: JSONValue?) async throws -> JSONValue
}

extension BuildService: PostItsBuild {}

/// A card being dragged, for the sidebar's foot (`post-its:drag`): `over` the trash; `thrown` when one was let go there.
public struct PostItDrag: Equatable, Sendable {
    public var active: Bool, over: Bool, thrown: Bool
    public init(active: Bool, over: Bool, thrown: Bool = false) { self.active = active; self.over = over; self.thrown = thrown }
}

/// A card in the trash (post-its:trashed): its text (first 4000 characters), when it went and when it will be purged.
public struct TrashedPostIt: Equatable, Sendable, Identifiable {
    public var id: String
    public var text: String
    public var deleted: String
    public var expires: Date
}

/// What the app fills in when it attaches post-its to a window (ProjectPostIts.jsx props + views.cjs createPostItViews
/// options + the Workspace's post-it state). Every callback runs on the main thread.
@MainActor
public struct PostItsContext {
    public var data: PostItsData
    /// Build (quick tasks). nil: no Build button state, no popup.
    public var build: PostItsBuild?
    /// Where `engelbart:build` and `engelbart:build-progress` are heard.
    public var events: EventHub = .shared
    /// The other windows' post-its (one `PostItPeers` for the app).
    public var peers: PostItPeers? = nil
    /// The show/hide toggle, one for the app (UserDefaults `engelbart.postIts.hidden`).
    public var visibility: PostItsVisibility = .shared
    /// `engelbart.postIt.build`: each model's last effort in the Build popup.
    public var pickMemory: PickMemory = PickMemory()
    public var now: () -> Date = { Date() }

    // What the window does for the cards
    /// +Note made a note: open it as a tab once the library knows it (`post-its:open-note`).
    public var openNote: (_ projectId: String, _ id: String, _ name: String) -> Void = { _, _, _ in }
    /// A link clicked on a card: open it on the Stage (`post-its:open-link`).
    public var openLink: (_ url: String) -> Void = { _ in }
    /// `post-its:error`.
    public var onError: (Error) -> Void = { _ in }
    /// The keyboard back to the workspace (Electron: the window's page focused).
    public var focusWorkspace: (() -> Void)? = nil
    /// A quick task added to a workspace: that workspace with the archived version open (Workspace.jsx goToVersion).
    public var goToVersion: (_ workspaceId: String, _ version: JSONValue) -> Void = { _, _ in }

    // What the Build popup and the task card read
    /// The library rows Context can attach (the window's `library`).
    public var library: () -> [PickRow] = { [] }
    /// What each library row says (useBodies), asked each time Context opens.
    public var bodies: (() async -> [String: String])? = nil
    /// "Upload URL or path" (addLibraryItem). → the row added.
    public var addLibraryItem: ((String) async throws -> PickRow)? = nil
    /// "Choose from disk…" (pickLibraryPaths).
    public var pickPaths: (() async -> [String])? = nil
    /// "Add from GitHub…": the GitHub pane (Integrations' GithubPaneView), given busy, back and pick (a repository's url,
    /// or its row when the library holds it already).
    public var githubPane: ((_ busy: Bool, _ back: @escaping () -> Void, _ pick: @escaping (_ url: String, _ row: PickRow?) -> Void) -> AnyView)? = nil
    /// The library changed (Context added something): the sidebar reads it again.
    public var libraryChanged: () -> Void = {}
    /// Every workspace of the project, nested ones after their parent (flatWorkspaces).
    public var workspaces: () -> [WorkspaceEntry] = { [] }
    /// The workspace open now (the task card's picker starts on it).
    public var hereWorkspaceId: () -> String? = { nil }

    public init(data: PostItsData, build: PostItsBuild? = nil) { self.data = data; self.build = build }
}

/// The sidebar's show/hide toggle (2026-09-25): every card out of sight or back, remembered across launches, global
/// across projects and windows. Showing or hiding writes no row.
@MainActor
public final class PostItsVisibility: ObservableObject {
    public static let shared = PostItsVisibility()
    public static let key = "engelbart.postIts.hidden"
    let defaults: UserDefaults
    @Published public private(set) var hidden: Bool
    private var listeners: [UUID: (Bool) -> Void] = [:]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hidden = defaults.string(forKey: PostItsVisibility.key) == "1"
    }

    public func set(_ value: Bool) {
        guard value != hidden else { return }
        hidden = value
        defaults.set(value ? "1" : "0", forKey: PostItsVisibility.key)
        for listener in Array(listeners.values) { listener(value) }
    }
    public func toggle() { set(!hidden) }

    func listen(_ fn: @escaping (Bool) -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = fn
        return { [weak self] in self?.listeners[id] = nil }
    }
}

/// Every window's cards (2026-10-03, views.cjs createPostItPeers): what one window saves of a card (its text, place, size,
/// stacking), and a card made, thrown away or restored, reaches every other window showing that project.
@MainActor
public final class PostItPeers {
    public enum Change {
        case added(PostItCardRow)
        case removed(String)
        case row(PostItCardRow)
    }
    private var members: [ObjectIdentifier: (String, Change) -> Void] = [:]
    public init() {}
    func join(_ member: AnyObject, hear: @escaping (String, Change) -> Void) -> () -> Void {
        let key = ObjectIdentifier(member)
        members[key] = hear
        return { [weak self] in self?.members[key] = nil }
    }
    func tell(from member: AnyObject, _ projectId: String, _ change: Change) {
        let me = ObjectIdentifier(member)
        for (key, hear) in members where key != me { hear(projectId, change) }
    }
}

/// A card's row as the controller keeps it (the post_its columns that change).
public struct PostItCardRow: Equatable, Sendable {
    public var id: String
    public var text: String
    public var nx: Double, ny: Double, width: Double, height: Double
    public var z: Double
    public init(id: String, text: String, nx: Double, ny: Double, width: Double, height: Double, z: Double) {
        self.id = id; self.text = text; self.nx = nx; self.ny = ny; self.width = width; self.height = height; self.z = z
    }
    init(_ row: PostItRow) { self.init(id: row.id, text: row.text, nx: row.nx, ny: row.ny, width: row.width, height: row.height, z: row.z) }
    var layout: CardLayout {
        get { CardLayout(nx: nx, ny: ny, width: width, height: height) }
        set { nx = newValue.nx; ny = newValue.ny; width = newValue.width; height = newValue.height }
    }
    var values: PostItValues { PostItValues(text: text, nx: nx, ny: ny, width: width, height: height, z: z) }
}
