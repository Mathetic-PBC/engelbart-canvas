import Foundation
import EngelbartCore
import EngelbartStore
import EngelbartStage

/// Everything the Workspace screen asks of the rest of the app: the `api.*` calls Workspace.jsx makes (preload.cjs
/// engelbartAPI), one method each, named as there. `LiveWorkspaceAPI` answers them from the wave-1 services the app hands
/// over in `WorkspaceContext`; tests answer them with a fake. JSON-shaped answers are the Electron objects as they were.
/// Every method is called on the main thread; async ones may finish anywhere (the model hops back to the main actor).
public protocol WorkspaceAPI: AnyObject {
    // documents (ipc.cjs read-doc, write-doc, read-archive, clear-workspace, restore-archive, copy-doc)
    func readDoc(_ projectId: String, _ ref: StoreDocRef) async throws -> String
    /// → the save's revision (doc-sync), nil when main gave none.
    func writeDoc(_ projectId: String, _ ref: StoreDocRef, _ text: String) async throws -> Double?
    func readArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> String
    func clearWorkspace(_ projectId: String, _ workspaceId: String) async throws -> (text: String, revision: Double?)
    func restoreArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> (text: String, revision: Double?)
    /// The document with every mention's content in place, on the clipboard → how many files went in, how many were missing.
    func copyDoc(_ projectId: String, _ ref: PaneRef) async throws -> (files: Int, missing: Int)
    func readImage(_ id: String) async throws -> (data: Data, mime: String)
    func saveImage(_ projectId: String, data: Data, mime: String, name: String?) async throws -> LibraryRow

    // state.json (views, recent, agents, starred, folders) and the walkthrough
    func setView(_ projectId: String, _ workspaceId: String, _ view: JSONValue) async
    func recordEdit(_ projectId: String, _ workspaceId: String) async
    func nav() async throws -> NavState
    func seenAgents(_ projectId: String, _ workspaceId: String) async
    func starred(_ projectId: String) async throws -> [String]
    func setStarred(_ projectId: String, _ itemId: String, _ on: Bool) async throws -> [String]
    func folders() async throws -> [JSONValue]
    func addToFolder(_ folderId: String, _ ids: [String]) async throws -> [JSONValue]
    func removeFromFolder(_ folderId: String, _ id: String) async throws -> [JSONValue]
    func createFolder(_ name: String) async throws -> [JSONValue]
    func renameFolder(_ folderId: String, _ name: String) async throws -> [JSONValue]
    func deleteFolder(_ folderId: String) async throws -> [JSONValue]
    func gettingStarted(_ projectId: String) async throws -> JSONValue?
    func setGettingStarted(_ projectId: String, tick: [Int], untick: [Int], hidden: Bool) async throws -> JSONValue?

    // the tree
    func createWorkspace(_ projectId: String, name: String, parentId: String?) async throws -> String
    func renameWorkspace(_ projectId: String, _ workspaceId: String, _ name: String) async throws
    func trashWorkspace(_ projectId: String, _ workspaceId: String) async throws
    func restoreWorkspace(_ projectId: String, _ workspaceId: String) async throws
    func renameProject(_ projectId: String, _ name: String) async throws
    func createNote(_ projectId: String, name: String, workspaceId: String?) async throws -> NoteInfo
    /// → the name it took.
    func renameNote(_ projectId: String, _ id: String, _ name: String) async throws -> String
    /// → the sandbox's refusal, if a repository could not start.
    func linkToWorkspace(_ projectId: String, _ workspaceId: String, _ ids: [String], picked: Bool) async throws -> String?
    func unlinkFromWorkspace(_ projectId: String, _ workspaceId: String, _ id: String, unmentioned: Bool) async throws

    // the library
    func library() async throws -> [LibraryRow]
    func addLibraryItem(_ input: String, name: String?) async throws -> (row: LibraryRow, sandboxError: String?)
    func addLibraryFile(_ data: Data, mime: String, name: String?) async throws -> LibraryRow
    func addLibraryUrl(_ input: String) async throws -> (row: LibraryRow, sandboxError: String?)
    func addLibraryPdf(_ input: String, bytes: Data, name: String?) async throws -> LibraryRow
    func addLibraryPage(_ tabId: String, _ input: String, name: String?) async throws -> LibraryRow
    /// library.lookupItem: the row the library holds for it, and how it would take it (`type`, `tags`); `error` when it
    /// could not take it at all.
    func lookupLibraryItem(_ input: String) async throws -> LibraryLookup
    func renameLibraryItem(_ id: String, _ name: String) async throws -> LibraryRow?
    func pickLibraryPaths() async -> [String]
    /// A library folder's level (store/folder-files.cjs listFolder) as JSON: { entries: [{name, rel, dir, type}], missing, total, error }.
    func listFolder(_ id: String, _ rel: String) async throws -> JSONValue
    func folderFile(_ folderId: String, _ rel: String) async throws -> (exists: Bool, path: String?, folder: String?)
    /// What the project's things say, for the @ menu (MATH-29).
    func libraryBodies(_ projectId: String) async throws -> MentionRows.Bodies
    func readLibraryFile(_ id: String) async throws -> Data
    func readAnnotations(_ id: String) async throws -> JSONValue?
    func writeAnnotations(_ id: String, _ value: JSONValue) async throws
    func readPageAnnotations(_ url: String) async throws -> JSONValue?
    func writePageAnnotations(_ url: String, _ value: JSONValue) async throws
    /// stage-file: a typed path resolved inside home (projects.cjs resolveTypedPath) and read for the Stage.
    func readStageFile(_ projectId: String, _ input: String) async throws -> StageFile
    func stage(_ projectId: String) async -> JSONValue?
    func setStage(_ projectId: String, _ value: JSONValue) async

    // @bart (bart/ipc): the input and answer objects are Electron's
    func bartModels() async throws -> JSONValue
    func askBart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue
    func runningPaperAsks(_ projectId: String) async throws -> [JSONValue]
    func routeLine(_ projectId: String, _ input: JSONValue) async throws -> JSONValue?
    func routeHanded(_ routeId: String, _ to: String) async
    func stopBart(_ askId: String) async throws
    /// → the title, or nil.
    func nameChat(_ input: JSONValue) async throws -> String?
    func createdFile(_ projectId: String, _ askId: String, _ rel: String) async throws -> JSONValue
    func saveCreated(_ projectId: String, _ askId: String, _ rel: String, _ workspaceId: String?) async throws -> LibraryRow

    // Build
    func buildList(_ projectId: String) async throws -> [JSONValue]
    func buildStart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue
    func buildReply(_ projectId: String, _ id: String, _ text: String, interrupt: Bool, images: [JSONValue]) async throws
    func buildStop(_ projectId: String, _ id: String) async throws
    func buildResume(_ projectId: String, _ id: String) async throws
    func buildFix(_ projectId: String, _ id: String) async throws
    func buildDiscard(_ projectId: String, _ id: String) async throws
    func buildAccept(_ projectId: String, _ id: String) async throws
    func buildReview(_ projectId: String, _ id: String) async throws -> JSONValue
    func buildRunShow(_ projectId: String, _ id: String, _ name: String) async throws
    func buildRunStop(_ projectId: String, _ id: String) async throws
    func buildRunStopRunnable(_ projectId: String, _ id: String, _ name: String?) async throws
    func buildPromote(_ projectId: String, _ id: String, _ workspaceId: String, choice: JSONValue?) async throws -> JSONValue

    // Zotero (MATH-65)
    func zoteroList(_ rel: String) async throws -> JSONValue
    func zoteroOpen(_ key: String) async throws -> JSONValue
    func zoteroAttach(_ key: String, _ file: String) async throws -> JSONValue

    // the rest
    func openExternal(_ url: String)
    func copyText(_ text: String)
    func startSandbox(_ libraryId: String) async throws
    func connectDismiss(_ sessionId: String) async
    /// The Agent Viewer's reveal kept for this window (agentMap:take-reveal), taken once.
    func takeAgentReveal(_ projectId: String) async -> JSONValue?
    /// Where the sidebar's trash is (window points, y down), for the post-its; nil for none.
    func postItsTrashRect(_ rect: CGRect?)
    /// A quick task's post-it thrown out (post-its:throw-out).
    func postItsThrowOut(_ projectId: String, _ postItId: String) async throws
}

/// library.lookupItem's answer as the screen reads it.
public struct LibraryLookup: Equatable {
    public var row: LibraryRow?
    public var type: String?
    public var tags: [String]?
    public var error: String?
    public init(row: LibraryRow? = nil, type: String? = nil, tags: [String]? = nil, error: String? = nil) { self.row = row; self.type = type; self.tags = tags; self.error = error }
}

/// The announcements the screen listens to on `EventHub` (Electron channel names; preload.cjs subscribe calls).
public enum WorkspaceEvents {
    public static let docChanged = "doc:changed"
    public static let bartProgress = "engelbart:bart-progress"
    public static let paperAskDone = "engelbart:paper-ask-done"
    public static let modelsChanged = "engelbart:models-changed"
    public static let build = "engelbart:build"
    public static let buildProgress = "engelbart:build-progress"
    public static let buildDiff = "engelbart:build-diff"
    public static let buildRun = "engelbart:build-run"
    public static let buildQuick = "engelbart:build-quick"
    public static let buildQuickOpen = "engelbart:build-quick-open"
    public static let nav = "engelbart:nav"
    public static let starred = "engelbart:starred"
    public static let folders = "engelbart:folders"
    public static let zotero = "engelbart:zotero"
    public static let zoteroFinding = "engelbart:zotero-finding"
    public static let zoteroWaiting = "engelbart:zotero-waiting"
    public static let zoteroDownloaded = "engelbart:zotero-downloaded"
    public static let agentReveal = "engelbart:agent-reveal"
    public static let openSandboxTerminal = "engelbart:open-sandbox-terminal"
    public static let nextWorkspace = "engelbart:next-workspace"
    public static let browserFocused = "browser:focused"
    public static let browserShortcut = "browser:shortcut"
    public static let openInBrowser = "engelbart:open-in-browser"
    public static let showTerminal = "engelbart:show-terminal"
    public static let stageOpenLink = "stage:open-link"
}
