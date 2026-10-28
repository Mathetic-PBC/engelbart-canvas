import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartStage
import EngelbartTerminal
import EngelbartPDF
import EngelbartBuild
import EngelbartSandbox

/// Where the project opens (App.jsx `entry`): the workspace, a note's tab to open into it, every workspace's remembered
/// view (state.json `views[projectId]`), and what the Stage shows first.
public struct WorkspaceEntry {
    public var workspaceId: String?
    public var tab: DocTab?
    public var views: [String: JSONValue]
    public var stage: StageRequest?
    public init(workspaceId: String? = nil, tab: DocTab? = nil, views: [String: JSONValue] = [:], stage: StageRequest? = nil) {
        self.workspaceId = workspaceId; self.tab = tab; self.views = views; self.stage = stage
    }
}

/// Opened from the all-projects screen: a library row on the Stage, or sites to sign in to again (the first in front).
public enum StageRequest: Equatable {
    case row(LibraryRow)
    case links([String])
}

/// The import's "Open library" (App.jsx tourRequest): show this workspace (and tab), then the sidebar tour, once per `n`.
public struct TourRequest: Equatable {
    public var n: Int
    public var workspaceId: String?
    public var tab: DocTab?
    public init(n: Int, workspaceId: String?, tab: DocTab?) { self.n = n; self.workspaceId = workspaceId; self.tab = tab }
}

/// What the app fills to show a project (App.jsx's props to <Workspace>). Everything with a default may be left.
public struct WorkspaceContext {
    /// The api.* calls (LiveWorkspaceAPI over the Store, Bart, Build, Zotero…; a fake in tests).
    public var api: WorkspaceAPI
    public var tree: ProjectTree
    public var library: [LibraryRow]
    public var entry: WorkspaceEntry
    /// The project has its code directory: keys and the post-its' trash work; false sits blurred and inert under the
    /// app's DirectoryGate.
    public var active: Bool { get { tree.project.directory != nil } }

    /// App.jsx reload: the tree and the library read again → the new ones (the screen takes them), nil when it failed.
    public var reload: () async -> (tree: ProjectTree, library: [LibraryRow])?
    /// Escape with nothing else to do, and "All projects".
    public var onClose: () -> Void = {}
    public var onHome: () -> Void = {}
    /// The sidebar's project menu: another project at a workspace (nil: where it was left).
    public var onOpenProject: (_ projectId: String, _ workspaceId: String?) -> Void = { _, _ in }
    public var onNewProject: () -> Void = {}
    /// Every workspace shown (App.jsx onVisit: setLastOpen + reportPlace).
    public var onVisit: (_ workspaceId: String) -> Void = { _ in }
    /// The app's error line (App.jsx fail).
    public var onError: (_ message: String) -> Void = { _ in }
    /// A Connect note's popup (App.jsx openSession).
    public var onOpenConnect: (_ sessionId: String) -> Void = { _ in }
    /// Settings on a page ("connections" from the sidebar's gear and Connections).
    public var onOpenSettings: (_ page: String) -> Void = { _ in }
    /// While the sidebar shows its own gear the window's top-right one hides (data-sidebar-gear).
    public var onSidebarGear: (_ shown: Bool) -> Void = { _ in }
    /// How far the window's top-right controls reach in from the right edge (the strip stops short of them in the
    /// document's full screen; ui/WindowControls.jsx).
    public var controlsRoom: () -> CGFloat = { 0 }

    /// The sidebar (the Sidebar package, adapted by the app): made once per screen.
    public var makeSidebar: ((WorkspaceSidebarHost) -> WorkspaceSidebar)?
    /// The post-its over the window (the PostIts package, adapted by the app).
    public var makePostIts: ((WorkspacePostItsHost) -> WorkspacePostIts)?
    /// The Stage; nil → `StageController(host:pageMarks:)`.
    public var makeStage: ((StageHost) -> StageController)?
    /// The library's web marks for the Stage's pages.
    public var stagePageMarks: StagePageMarks?
    /// The terminal pane; nil → `TerminalPaneController(host:)` on `TerminalSessions.shared`. Tests pass a closure
    /// returning nil to leave the pane empty.
    public var makeTerminal: ((TerminalHost) -> TerminalPaneController?)?
    /// A Build or sandbox shell's session JSON adopted as a tab of this project's terminal → its session id; and a Build's
    /// session that closed.
    public var adoptTerminal: (_ session: JSONValue, _ projectId: String) -> String? = { session, _ in session["id"]?.string }
    public var dropTerminal: (_ sessionId: String) -> Void = { _ in }
    /// The Build panel's calls (BuildService conforms).
    public var buildActions: BuildActions?
    /// The window's sandboxes (ui/SandboxProgress.jsx useSandboxes).
    public var sandboxes: SandboxProgressModel?
    /// sandbox-touch: a sandbox kept awake while its preview or terminal is in front (SandboxService.touch).
    public var touchSandbox: ((String) async throws -> Void)?
    /// Zotero is connected (the @ menu's Zotero row).
    public var zoteroConnected: () -> Bool = { false }
    /// Where `engelbart.*` remembered UI lives (localStorage).
    public var storage: UserDefaults = .standard
    public var hub: EventHub = .shared

    public init(api: WorkspaceAPI, tree: ProjectTree, library: [LibraryRow], entry: WorkspaceEntry = WorkspaceEntry(),
                reload: @escaping () async -> (tree: ProjectTree, library: [LibraryRow])?) {
        self.api = api; self.tree = tree; self.library = library; self.entry = entry; self.reload = reload
    }
}

// MARK: the sidebar slot

/// What the sidebar is given (Workspace.jsx's props to <Rail>), recomputed by the screen whenever any of it changes.
public struct WorkspaceSidebarState {
    public var width: CGFloat
    public var hidden: Bool
    public var project: PublicProject
    public var roots: [WorkspaceNode]
    public var trash: [TrashedWorkspace]
    public var hereId: String?
    /// state.json `recent`, this project's.
    public var recent: [JSONValue]
    public var visits: [Visit]
    public var notes: [NoteInfo]
    /// Agents (kept by marks), and the counts per top-level project and per workspace.
    public var entries: [AgentEntry]
    public var projectCounts: [String: AgentSummary]
    public var nodeCounts: [String: AgentSummary]
    /// This workspace's sources, newest opened first.
    public var rows: [LibraryRow]
    public var activeRowId: String?
    public var flashId: String?
    /// The library less let-go notes (what search and Library offer).
    public var library: [LibraryRow]
    public var railIds: Set<String>
    public var starred: [String]
    public var folders: [JSONValue]
    public var postItsHidden: Bool
    public var postItsToggle: Bool
    public var trashFull: Bool
    public var postItTrashCount: Int
    public var postItDrag: (active: Bool, over: Bool)
    /// Library opened on a tab by the walkthrough's step 1: { n, chip }.
    public var libraryRequest: (n: Int, chip: String?)?
    public var tourStep: Int?
    /// The walkthrough (main's getting-started state) and whether this workspace shows it.
    public var walk: JSONValue?
    public var walkShown: Bool
    /// The papers @discover found in the document in front (step 3).
    public var walkPapers: [Walkthrough.Paper]
}

/// The screen's side of the sidebar (Rail's callbacks). The model implements it.
@MainActor
public protocol WorkspaceSidebarHost: AnyObject {
    func selectWorkspace(_ id: String)
    func createWorkspace(name: String, parentId: String?) async throws
    func renameWorkspace(_ id: String, _ name: String)
    func deleteWorkspace(_ id: String)
    func restoreWorkspace(_ id: String)
    func openVersion(workspaceId: String, file: String, title: String)
    func goAgent(_ entry: AgentEntry, rect: CGRect?)
    func dismissAgent(_ entry: AgentEntry)
    func nextAgent()
    func seenAll()
    func toggleRail()
    func openRow(_ row: LibraryRow, newTab: Bool)
    /// A child workspace's row or an archived version's row (Rail's `type: 'child' | 'archive'`).
    func openChild(_ id: String)
    func openArchive(file: String, title: String)
    func renameRow(_ row: LibraryRow, _ name: String)
    func renameChild(_ id: String, _ name: String)
    func removeRow(_ row: LibraryRow)
    func linkRow(_ row: LibraryRow)
    func openHeld(projectId: String, workspaceId: String?)
    func dropItems(_ items: [Drop.Item])
    func addInput(_ input: String, folderId: String?) async throws -> LibraryRow
    /// "Choose from disk…" → what could not be added.
    func pickDisk(folderId: String?) async -> [String]
    func newNote(folderId: String?) async throws
    func pickRepo(url: String, row: LibraryRow?, folderId: String?) async throws
    func createFolder(_ name: String) async throws
    func renameFolder(_ id: String, _ name: String)
    func deleteFolder(_ id: String)
    func addToFolder(_ id: String, _ ids: [String]) async throws
    func removeFromFolder(_ id: String, _ itemId: String)
    func starRow(_ row: LibraryRow, on: Bool)
    func togglePostIts()
    func openProject(_ projectId: String)
    func newProject()
    func allProjects()
    func renameProject(_ name: String)
    func openProjectPage()
    /// The clock's page: 'top' | 'project' | 'note'.
    func openRecent(kind: String, id: String)
    func panelOpened(_ kind: String)
    func openSettings(_ page: String)
    // the walkthrough's card
    func walkTick(_ n: Int, on: Bool)
    func walkHide()
    func walkOpenLibrary(chip: String?)
    func walkWrite()
    func walkBrainstorm()
    func walkDiscover()
    func walkOpenPaper(_ address: String)
    // the tour
    func tourNext()
    func tourClose()
    /// The sidebar's trash moved (window points, y down; nil: none shown).
    func trashMoved(_ rect: CGRect?)
}

/// The sidebar the app injects (the Sidebar package's Rail, RecentPages, GettingStarted and SidebarTour).
@MainActor
public protocol WorkspaceSidebar: AnyObject {
    /// The rail column (the screen sizes it).
    var view: NSView { get }
    func update(_ state: WorkspaceSidebarState)
    /// The clock right of the sidebar toggle in the title bar (workspace/RecentPages.jsx), or nil.
    func makeRecentPages() -> NSView?
    /// The walkthrough's card above the Welcome workspace's document (workspace/GettingStarted.jsx), or nil.
    func makeWalkCard() -> NSView?
}

// MARK: the post-its slot

/// What the post-its are given (<ProjectPostIts>, <PostItBuild>, <PostItTask>).
public struct WorkspacePostItsState {
    public var projectId: String
    public var active: Bool
    public var hidden: Bool
    /// A post-it's Build popup: { postItId, text } and where its button is (window points, y down).
    public var buildPopup: (postItId: String, text: String, anchor: CGRect?)?
    /// A quick task's card: its record and progress, and where it hangs from.
    public var quickTask: (task: JSONValue, progress: JSONValue?, anchor: CGRect?)?
    public var workspaces: [Nav.Flat]
    public var hereId: String?
}

@MainActor
public protocol WorkspacePostItsHost: AnyObject {
    func postItsShown()
    func postItsDrag(active: Bool, over: Bool)
    func postItsTrashCount(_ n: Int)
    /// +Note on a card: open it as a tab once the library knows it.
    func postItsOpenNote(id: String, name: String)
    func postItsOpenLink(_ url: String)
    /// The popup sends its quick task (buildStart kind 'quick').
    func postItsStartQuick(_ input: JSONValue) async throws
    func postItsCloseBuild()
    /// The quick task card's buttons, promote, go to the version, throw the post-it out, close.
    func postItsQuickAction(_ action: String) async -> Bool
    func postItsPromote(workspaceId: String, choice: JSONValue?) async throws -> JSONValue
    func postItsGoToTask(_ task: JSONValue)
    func postItsThrowOut(postItId: String)
    func postItsCloseQuick()
}

@MainActor
public protocol WorkspacePostIts: AnyObject {
    /// Drawn over the whole screen (it lets presses through where there is no card), or nil when the post-its are windows.
    var overlay: NSView? { get }
    func update(_ state: WorkspacePostItsState)
}
