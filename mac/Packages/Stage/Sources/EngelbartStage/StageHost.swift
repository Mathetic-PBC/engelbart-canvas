import AppKit
import EngelbartCore

/// What the Stage needs from the app (the Workspace screen adapts the Store, the PDF package and the Bart package to it).
/// Every library and file operation goes through here: the Stage never reads the Store itself.
@MainActor
public protocol StageHost: AnyObject {
    /// The project the Stage's tabs are kept for (state.json `stages`).
    var projectId: String { get }
    /// The project's folder (for relative paths the host resolves) — informational for the Stage.
    var projectDirectory: String? { get }
    /// The library rows the Stage can open and search (notes included: the Stage leaves them out itself).
    func library() -> [StageRow]
    /// Whether a row is in this workspace's rail.
    func inRail(_ id: String) -> Bool
    /// library.lookupItem: the row a typed place is, and how the library would take it (for Save's copy of a page).
    func lookupLibraryItem(_ input: String) async -> StageLookup
    /// stage-file: a path typed or picked, resolved inside the home folder (project folder, data root, root, code folder
    /// for a relative one; projects.cjs resolveTypedPath) and read (StageFiles.readStageFile into <data root>/.cache/stage).
    func readStageFile(_ input: String) async throws -> StageFile
    /// A library pdf row's bytes (read-library-file).
    func readLibraryFile(_ rowId: String) async throws -> Data
    /// A pdf's ink: a row's own, or kept by the pdf's address (read/write(Page)Annotations).
    func readAnnotations(rowId: String) async -> JSONValue?
    func readPageAnnotations(url: String) async -> JSONValue?
    func writeAnnotations(rowId: String, _ marks: JSONValue) async throws
    func writePageAnnotations(url: String, _ marks: JSONValue) async throws
    /// The project's Stage tabs as kept (MATH-10), and keeping them.
    func stage() async -> StageSnapshot?
    func setStage(_ snapshot: StageSnapshot)
    /// The native file picker (several files; ENGELBART_PICK_PATHS in scripted runs).
    func pickPaths() async throws -> [String]
    /// The default browser (⋮ → Open in default browser, GitHub's sign-in pages).
    func openExternal(_ url: String)
    /// The pdf viewer (the PDF package's PaperView) for a tab's pdf.
    func makePDFView(_ request: StagePDFRequest) -> StagePDFViewing
    /// @bart from a highlight on a pdf or from a web page's card: the finished answer's entry for the mark, or nil.
    func ask(_ ask: StageAsk) async -> JSONValue?
    func stopAsk(_ askId: String)
    func dismissAsk(_ askId: String)
    /// A library row opened from a pdf's note mention (opens it as the sidebar does).
    func openMention(_ row: StageRow)
    /// A citation of the person's own workspace or note: opened beside the document → whether it was one.
    func openCited(_ href: String) -> Bool
    /// What is in front changed: the savable page (for Save), the library row in front, the places every tab shows.
    func stagePageChanged(_ page: StagePage?)
    func stageFrontChanged(_ rowId: String?)
    func stageTabsChanged(_ places: [String])
    /// Bring the Stage forward (⌘T / ⌘W from anywhere but the terminal).
    func showStage()
    /// Whether the middle canvas was clicked last and so has ⌘T, ⌘W and ⌘F (model/key-side.js).
    func keysToDoc() -> Bool
    /// A sandbox preview behind an address: its row's name, whether it is one; Build details.
    func previewRow(for url: String) -> StageRow?
    func openBuildDetails(_ row: StageRow, from view: NSView)
    /// The page keeps a live preview awake while it shows.
    func previewTouch(_ url: String, visible: Bool)
}

/// library.lookupItem's answer.
public struct StageLookup: Equatable, Sendable {
    public var row: StageRow?
    public var type: String?
    public var tags: [String]?
    public init(row: StageRow? = nil, type: String? = nil, tags: [String]? = nil) { self.row = row; self.type = type; self.tags = tags }
}

/// What is in front for the library (Stage.jsx onPage): its address or path, a web pdf's bytes (Save keeps a copy), and
/// the tab whose page Save can keep whole (MATH-17).
public struct StagePage: Equatable, Sendable {
    public var input: String
    public var title: String
    public var bytes: Data?
    public var tabId: String
    public var webPage: Bool
}

/// The address field's save button, as the workspace decides it from `stagePageChanged`.
public struct StageSave {
    public var state: StageModel.SaveState
    /// A file @create made, once saved: where the library keeps it ("Library / Assets / <name>").
    public var crumb: String?
    public var busy = false
    /// Save from the card: the name and whether it goes into this workspace too.
    public var onSave: (_ name: String, _ here: Bool) async throws -> Void
    /// "+ Workspace": the row in the library, linked here.
    public var onLink: () async throws -> Void
    public init(state: StageModel.SaveState, crumb: String? = nil, busy: Bool = false, onSave: @escaping (String, Bool) async throws -> Void, onLink: @escaping () async throws -> Void) {
        self.state = state; self.crumb = crumb; self.busy = busy; self.onSave = onSave; self.onLink = onLink
    }
}

/// @bart asked from a pdf highlight or a web mark: as Stage.jsx hands it to `onAsk`.
public struct StageAsk {
    public var markId: String
    /// 'web' for a web page's mark; nil for a pdf's.
    public var source: String?
    public var rowId: String?
    public var url: String?
    public var page: Int?
    public var question: String
    public var note: String
    public var turns: [JSONValue]
    public var quote: String
    public var pageText: String
    /// The pdf's or page's name.
    public var paper: String
    /// Everything else the pdf viewer sent with it.
    public var extra: JSONValue
}

/// The pdf viewer the host makes (PDF package): what the Stage asks of it.
@MainActor
public protocol StagePDFViewing: AnyObject {
    var view: NSView { get }
    /// Find: a new query starts over (step 0), else steps ±1 → (matches, active), or nil when nothing can be searched.
    func find(_ text: String, step: Int, fromStart: Bool) -> (matches: Int, active: Int)?
    func stopFind()
    func showSection(find: String, to: String)
    func clearSection()
    /// The page in view (1-based), 0 when unknown.
    func currentPage() -> Int
    /// A finished answer onto a mark it shows.
    func addAsk(page: Int, markId: String, entry: JSONValue)
}

/// What a pdf view is made from, and what it tells the Stage.
public struct StagePDFRequest {
    public var tabId: String
    public var bytes: Data
    public var marks: JSONValue
    /// A link's passage to find once drawn, where its section ends, the page it is on.
    public var target: String?
    public var targetTo: String?
    public var targetPage: Int?
    /// A guide's section shown at first (no target).
    public var initialSection: GuideSection?
    /// The viewer's place (page, zoom) the tab kept.
    public var viewState: JSONValue?
    /// The pdf: its library row, else its address, and its name.
    public var rowId: String?
    public var url: String
    public var name: String
    /// The answers being written for this pdf.
    public var pendingAsks: [JSONValue]
    public var onView: (JSONValue) -> Void
    public var onTarget: (_ text: String, _ result: (matches: Int, active: Int)?) -> Void
    public var onFind: (_ result: (matches: Int, active: Int)?) -> Void
    public var onMarksChange: (JSONValue) -> Void
    public var onAsk: ((StageAsk) -> Void)?
    /// A link in a note or an answer: opened on the Stage in a tab of its own (or beside the document when it cites one).
    public var onOpenLink: (String) -> Void
}
