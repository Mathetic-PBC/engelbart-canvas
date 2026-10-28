import EngelbartCore
import Foundation

// What the root of a window (App.jsx) reads and changes, as a protocol the app adapts the Store to in wave 2. Each method
// names the `api.*` call it stands for (src/renderer/api.js → src/main/ipc.cjs). Announcements from other windows arrive
// on EventHub under the Electron channel names (ShellEvents).

public struct ShellConfig: Equatable, Sendable {
    public var dataRoot: String
    public var testMode: Bool
    /// A developer's copy only (Developer.hasTestMode).
    public var testModeAvailable: Bool
    public var testRoot: String
    public init(dataRoot: String, testMode: Bool, testModeAvailable: Bool, testRoot: String) {
        self.dataRoot = dataRoot; self.testMode = testMode; self.testModeAvailable = testModeAvailable; self.testRoot = testRoot
    }
}

public struct ProjectSummary: Equatable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct ProjectTree: Sendable {
    public struct Project: Sendable {
        public var id: String
        public var name: String
        public var description: String
        /// Where its code lives; nil holds the window behind the DirectoryGate.
        public var directory: String?
        /// The folder it had, when that folder is gone.
        public var directoryMissing: String?
        public init(id: String, name: String, description: String = "", directory: String?, directoryMissing: String? = nil) {
            self.id = id; self.name = name; self.description = description; self.directory = directory; self.directoryMissing = directoryMissing
        }
    }
    public struct Workspace: Sendable {
        public var id: String, name: String, children: [Workspace]
        public init(id: String, name: String, children: [Workspace] = []) { self.id = id; self.name = name; self.children = children }
    }
    public struct Note: Sendable {
        public var id: String, name: String, workspaceId: String?
        public init(id: String, name: String, workspaceId: String?) { self.id = id; self.name = name; self.workspaceId = workspaceId }
    }
    public var project: Project
    public var workspaces: [Workspace]
    public var notes: [Note]
    /// The Store's whole tree, for the Workspace screen.
    public var raw: JSONValue
    public init(project: Project, workspaces: [Workspace], notes: [Note], raw: JSONValue = .null) {
        self.project = project; self.workspaces = workspaces; self.notes = notes; self.raw = raw
    }
}

/// A tab to open: a note's id and title.
public struct TabRef: Equatable, Sendable {
    public var id: String, title: String
    public init(id: String, title: String) { self.id = id; self.title = title }
}

/// What a project opens on: { workspaceId, tab, stage } (App.jsx openProject's `prefer`).
public struct OpenRequest: Sendable {
    public var workspaceId: String?
    public var tab: TabRef?
    public var stage: JSONValue?
    public init(workspaceId: String? = nil, tab: TabRef? = nil, stage: JSONValue? = nil) { self.workspaceId = workspaceId; self.tab = tab; self.stage = stage }
}

/// The project being shown: its workspace, the tab and Stage request it opened with, and its saved views (state.json).
public struct WorkspaceEntry: Sendable {
    public var workspaceId: String
    public var tab: TabRef?
    public var stage: JSONValue?
    public var views: JSONValue
}

public protocol ShellBackend: AnyObject {
    /// api.config()
    func config() async throws -> ShellConfig
    /// api.trashedProjects(): read first, since reading purges projects a week in the trash.
    func trashedProjects() async throws -> [ProjectSummary]
    /// api.listProjects()
    func listProjects() async throws -> [ProjectSummary]
    /// api.library(): the library's rows, as the screens read them.
    func library() async throws -> [JSONValue]
    /// api.loadProject(id)
    func loadProject(_ id: String) async throws -> ProjectTree
    /// api.views(id): the workspaces' saved tabs, documents and scroll positions.
    func views(_ id: String) async throws -> JSONValue
    /// api.createWorkspace(id, { name })
    func createWorkspace(_ projectId: String, name: String) async throws
    /// api.lastOpen()
    func lastOpen() async -> WindowPlace?
    /// api.setLastOpen(place)
    func setLastOpen(_ place: WindowPlace) async
    /// api.setProjectDirectory(id, directory)
    func setProjectDirectory(_ id: String, _ directory: String) async throws
    /// api.setTestMode(on) → the config on the other root
    func setTestMode(_ on: Bool) async throws -> ShellConfig
    /// api.resetTestData({ fresh }) → whether it reset (the confirmation can be cancelled), and the config
    func resetTestData(fresh: Bool) async throws -> (reset: Bool, config: ShellConfig)
    func trashProject(_ id: String) async throws
    func restoreProject(_ id: String) async throws
    func renameProject(_ id: String, _ name: String) async throws
    /// api.guidedOffer() → whether to show the guided-setup offer
    func guidedOffer() async -> Bool
    /// api.guidedOfferSeen('shown' | 'started' | 'dismissed')
    func guidedOfferSeen(_ how: String) async
    /// api.importFlow(): the project a pending Import your context run goes into (after the Full Disk Access relaunch)
    func pendingImport() async -> String?
}

/// The announcements the root listens for (Electron channel names, on EventHub).
public enum ShellEvents {
    /// { } : rows the main process changed on its own.
    public static let libraryChanged = "engelbart:library-changed"
    /// { projectId, trashed? }: another window saved a project's tree, or trashed it.
    public static let projectChanged = "engelbart:project-changed"
    /// { config, fresh? }: another window switched the data root (test mode).
    public static let dataRootChanged = "engelbart:data-root-changed"
    /// The tool check's snapshot.
    public static let tools = "engelbart:tools"
    /// Engelbart ▸ Set Up Tools… (to the focused window).
    public static let toolsOpen = "engelbart:tools-open"
    /// { place: { projectId, ref } }: an Agent Viewer row clicked.
    public static let agentReveal = "engelbart:agent-reveal"
}

/// Until the Store is wired in (wave 2): a backend with no projects, so a window shows onboarding's slot. Test mode moves
/// between the two roots in memory.
public final class EmptyBackend: ShellBackend {
    var current: ShellConfig
    let paths: AppPaths
    public init(paths: AppPaths, testModeAvailable: Bool) {
        self.paths = paths
        current = ShellConfig(dataRoot: paths.dataRoot.path, testMode: false, testModeAvailable: testModeAvailable, testRoot: paths.testRoot.path)
    }
    public func config() async throws -> ShellConfig { current }
    public func trashedProjects() async throws -> [ProjectSummary] { [] }
    public func listProjects() async throws -> [ProjectSummary] { [] }
    public func library() async throws -> [JSONValue] { [] }
    public func loadProject(_ id: String) async throws -> ProjectTree { throw NSError(domain: "Engelbart", code: 404, userInfo: [NSLocalizedDescriptionKey: "No such project"]) }
    public func views(_ id: String) async throws -> JSONValue { .object([:]) }
    public func createWorkspace(_ projectId: String, name: String) async throws {}
    public func lastOpen() async -> WindowPlace? { nil }
    public func setLastOpen(_ place: WindowPlace) async {}
    public func setProjectDirectory(_ id: String, _ directory: String) async throws {}
    public func setTestMode(_ on: Bool) async throws -> ShellConfig {
        guard current.testModeAvailable else { return current }
        current.testMode = on
        current.dataRoot = on ? paths.testRoot.path : paths.dataRoot.path
        return current
    }
    public func resetTestData(fresh: Bool) async throws -> (reset: Bool, config: ShellConfig) { (true, current) }
    public func trashProject(_ id: String) async throws {}
    public func restoreProject(_ id: String) async throws {}
    public func renameProject(_ id: String, _ name: String) async throws {}
    public func guidedOffer() async -> Bool { false }
    public func guidedOfferSeen(_ how: String) async {}
    public func pendingImport() async -> String? { nil }
}
