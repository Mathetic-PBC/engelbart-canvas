import Foundation
import EngelbartDoc
import EngelbartCore

// What Bart needs of the Store, the Doc package and the other packages, as protocols the app implements (ARCHITECTURE
// §2's dependency rule: a wave-1 package never depends on Store or on another feature package). Each method names the
// Electron function it stands for.

/// The library database (store/db.cjs `libraryDb`).
public protocol BartLibraryDB: AnyObject, Sendable {
    /// `list()`: every library row.
    func list() async throws -> [LibraryRow]
    /// `get(id)`.
    func get(_ id: String) async throws -> LibraryRow?
    /// `textsFor(ids, max)`: the kept text of each row (library_text), cut to `max` characters.
    func texts(for ids: [String], max: Int) async throws -> [String: String]
    /// `textStamps()`: row id → the file time (ms) its kept text was read at.
    func textStamps() async throws -> [String: Double]
    /// `setText(id, text, modified)`.
    func setText(_ id: String, text: String, modified: Double) async throws
    /// `setSummary(id, summary, readAt)`: summary and summary_edited (= readAt, or now) and nothing else; nil clears both.
    func setSummary(_ id: String, summary: String?, readAt: Date?) async throws
    /// `setCharCount(id, n)`.
    func setCharCount(_ id: String, _ count: Int) async throws
    /// `papersWithFiles()`: rows of type pdf with a path.
    func papersWithFiles() async throws -> [LibraryRow]
    /// `uncountedNotes()`: notes (md tagged note) with no char_count.
    func uncountedNotes() async throws -> [LibraryRow]
    /// `summaryCandidates(before, minChars)`: notes edited before `before`, longer than `minChars`, with no summary or one
    /// older than their last edit (or a summary while now too short, so it is cleared).
    func summaryCandidates(before: Date, minChars: Int) async throws -> [LibraryRow]
}

/// How a question's document is named (ipc.cjs docRef): a workspace's, a note's, the project page, or a highlight's mark.
public struct DocRef: Equatable, Sendable {
    /// 'workspace' | 'note' | 'project' | 'mark'
    public var kind: String
    public var id: String?
    public var workspaceId: String?
    /// A mark's paper or page: its library row, else its address; its page (nil on a web page); `source` 'web'.
    public var rowId: String?
    public var url: String?
    public var page: Int?
    public var source: String?
    public init(kind: String, id: String? = nil, workspaceId: String? = nil, rowId: String? = nil, url: String? = nil, page: Int? = nil, source: String? = nil) {
        self.kind = kind; self.id = id; self.workspaceId = workspaceId; self.rowId = rowId; self.url = url; self.page = page; self.source = source
    }
    public static func workspace(_ id: String) -> DocRef { DocRef(kind: "workspace", workspaceId: id) }
    /// What threadKey hashes: `ref.id || ref.workspaceId`.
    var keyId: String? { (id?.isEmpty == false ? id : nil) ?? workspaceId }
}

/// Everything else of the Store and of the other packages that @bart's context reads.
public protocol BartStore: AnyObject, Sendable {
    /// The data root (`ctx.dataRoot`), and the home folder (`ctx.homeDir`).
    var dataRoot: String { get }
    var homeDir: String { get }
    var libraryDb: BartLibraryDB { get }

    /// projects.findWorkspace → the project and the workspace (with its folder).
    func findWorkspace(projectId: String, workspaceId: String) throws -> (project: ProjectRecord, workspace: WorkspaceRecord, workspaceDir: String)
    /// projects.findProject.
    func findProject(projectId: String) throws -> ProjectRecord
    /// projects.projectRecords: every project under the data root.
    func projects() -> [ProjectRecord]
    /// projects.flattenWorkspaces.
    func flattenWorkspaces(projectDir: String) -> [WorkspaceRecord]
    /// projects.notesMadeIn: note id → the workspace it was made in (nil for none). `workspaces` lets the Store skip
    /// opening the notes database when none of them threw anything away.
    func notesMadeIn(projectDir: String, workspaces: [WorkspaceRecord]?) async -> [String: String?]
    /// projects.recountWorkspaces (the sweep keeps workspace char counts honest).
    func recountWorkspaces()

    /// expand-mentions expandDoc: the document `ref` with its mentions placed (Doc + Store). `seen` (in insertion order, as
    /// the JS Set) comes back holding every
    /// library id placed, and `file:<folderId>:<rel>` / `zfile:<path>` keys for files inside folders and Zotero items.
    func expandDoc(projectId: String, ref: DocRef, seen: [String]) async throws -> (title: String, body: String, seen: [String])
    /// expand-mentions imagePaths(text, projectSource(…)): each `![label](img:<id>)` as its file's path.
    func imagePaths(projectId: String, text: String) async -> String

    /// store/onboarding.cjs instructionsBlock: <custom_instructions …> or ''.
    func instructionsBlock() -> String
    /// connect/memory.cjs memoryBlock: <memory …> or ''.
    func memoryBlock() -> String
    /// zotero/mirror.cjs pointerLine(mirrorDir(dataRoot)): '' without a mirror.
    func zoteroPointerLine() -> String
    /// store/getting-started.cjs: the Welcome walkthrough of the project (hidden, its workspace), nil without one.
    func gettingStarted(projectId: String) -> (hidden: Bool, workspaceId: String?)?

    /// store/library.cjs readAnnotations(rowId) / readPageAnnotations(url) / annotationsFileOf / lookupItem / readWebMark /
    /// inkFileOf, and store/folder-files.cjs fileInRow.
    func readAnnotations(rowId: String) async throws -> JSONValue?
    func readPageAnnotations(url: String) async throws -> JSONValue?
    func annotationsFile(rowId: String?, url: String?) async -> String
    func lookupItem(url: String) async -> LibraryRow?
    func readWebMark(rowId: String?, url: String?, markId: String) async -> JSONValue?
    func inkFile(of row: LibraryRow) -> String?
    func fileInRow(_ row: LibraryRow, rel: String) -> (path: String, exists: Bool)?
    /// store/library.cjs addMarkAnswer: an answer to a highlight's question put on its mark (ipc.cjs ask-bart).
    func addMarkAnswer(rowId: String?, url: String?, page: Int?, markId: String, entry: JSONValue) async throws
    /// projects.agentStarted / agentFinished / agentStopped: the ask as an agent of its workspace (nav.json).
    func agentStarted(id: String, kind: String, projectId: String, workspaceId: String, doc: DocRef)
    func agentFinished(id: String)
    func agentStopped(id: String)
}

/// The web page in front's tab (browser/views.cjs, through ipc.cjs stagePageFor): asked for what is selected on it and
/// a picture of it, as they are now.
public struct LivePage: Sendable {
    public var selection: (@Sendable () async -> JSONValue?)?
    public var screenshot: (@Sendable () async -> Data?)?
    public init(selection: (@Sendable () async -> JSONValue?)?, screenshot: (@Sendable () async -> Data?)?) { self.selection = selection; self.screenshot = screenshot }
}

/// The window's Overleaf tabs (overleaf/stage.cjs forTurn, Integrations): the one in front as a <stage source="overleaf">
/// block (given the picture's path), and the others as <overleaf_tabs>.
public struct OverleafTabs: Sendable {
    public var front: (@Sendable (_ screenshot: String) -> String)?
    public var tabsBlock: String
    public init(front: (@Sendable (String) -> String)?, tabsBlock: String) { self.front = front; self.tabsBlock = tabsBlock }
}

/// The project page as every agent in the project reads it first (projects.cjs projectPageBlock): '' while it is empty or
/// still says only the project's description.
public func projectPageBlock(_ project: ProjectRecord) -> String {
    guard !project.dir.isEmpty else { return "" }
    let text = ((try? String(contentsOfFile: (project.dir as NSString).appendingPathComponent(".project.md"), encoding: .utf8)) ?? "").jsTrim
    if text.isEmpty || text.squashedSpaces == (project.description ?? "").squashedSpaces { return "" }
    return "<project_page name=\"\(Highlights.attrOf(project.name, 200))\" note=\"The project page: what the person wants every agent in this project to know.\">\n\(text.jsSlice(0, 20000))\n</project_page>"
}
