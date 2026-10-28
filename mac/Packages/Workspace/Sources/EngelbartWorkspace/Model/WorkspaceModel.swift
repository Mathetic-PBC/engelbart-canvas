import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartUI
import EngelbartEditor
import EngelbartStage

/// What a pane's editor can be asked (Workspace.jsx's editorRefs: DocEditor's ref methods). DocEditorView conforms; tests
/// give fakes.
@MainActor
public protocol EditorHandle: AnyObject {
    var handleKey: String? { get }
    var handleLines: [String] { get }
    @discardableResult func handleShowLine(_ i: Int, flash: Bool) -> Bool
    @discardableResult func handleShowPassage(_ i: Int, find: String) -> Bool
    func handleDiscoverLastResult(_ askId: String?) -> Bool
    func handleAskBoxed(_ askId: String) -> Bool
    func handleStartAgent(_ agent: String) -> Bool
    func handleFocusEnd()
    func handleFocusStart()
    var handleIsActive: Bool { get }
    func handleShutMenus() -> Bool
    func handleCaretNow() -> (line: Int, a: Int, b: Int)?
}

/// A run at work in a document (Workspace.jsx `asks[askId]`): which document it writes into, when it began, and what the
/// editor draws on its pending row.
public struct AskRun: Equatable {
    public var docKey: String?
    public var at: Date?
    public var progress: AskProgress
}

/// A workspace's remembered view (state.json views[projectId][workspaceId]).
public struct ViewRecord: Equatable {
    public var active: String
    public var tabs: [DocTab]
    /// Document key → where it was scrolled to, the most recent last.
    public var positions: [(key: String, value: JSONValue)]
    public init(active: String = WorkspaceTabs.ws, tabs: [DocTab] = [], positions: [(key: String, value: JSONValue)] = []) { self.active = active; self.tabs = tabs; self.positions = positions }
    public init(json: JSONValue?) {
        active = json?["active"]?.string ?? WorkspaceTabs.ws
        tabs = (json?["tabs"]?.array ?? []).compactMap { t in t["id"]?.string.map { DocTab(id: $0, title: t["title"]?.string ?? "") } }
        positions = (json?["positions"]?.object ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }
    public var json: JSONValue {
        ["active": .string(active), "tabs": .array(tabs.map(\.json)), "positions": .object(Dictionary(positions.map { ($0.key, $0.value) }, uniquingKeysWith: { _, b in b }))]
    }
    public func position(_ key: String) -> JSONValue? { positions.last { $0.key == key }?.value }
    public static func == (a: ViewRecord, b: ViewRecord) -> Bool { a.active == b.active && a.tabs == b.tabs && a.positions.map(\.key) == b.positions.map(\.key) && a.positions.map(\.value) == b.positions.map(\.value) }
}

/// A file @create made, as this window has read it (Workspace.jsx `madeFiles[key]`).
public struct MadeFileState: Equatable {
    public var name: String
    public var type: String = ""
    public var ext: String = ""
    public var path: String?
    public var saved: (id: String, name: String)?
    public var saving = false
    public var missing = false
    public var error: String?
    public var text: String?
    public var image: NSImage?
    public static func == (a: MadeFileState, b: MadeFileState) -> Bool {
        a.name == b.name && a.type == b.type && a.path == b.path && a.saved?.id == b.saved?.id && a.saving == b.saving && a.missing == b.missing && a.error == b.error && a.text == b.text && a.image === b.image
    }
}

/// The Workspace screen's state and logic (screens/Workspace.jsx without its markup). The view controller draws it and
/// calls into it; every change calls `onChange`. Main-thread only.
@MainActor
public final class WorkspaceModel {
    public internal(set) var ctx: WorkspaceContext
    var api: WorkspaceAPI { ctx.api }
    public internal(set) var tree: ProjectTree
    public internal(set) var library: [LibraryRow]
    public internal(set) var index: WorkspaceIndex
    public internal(set) var notesById: [String: LibraryRow] = [:]
    public var project: PublicProject { tree.project }
    public var projectId: String { tree.project.id }

    /// Called after every change (the view controller redraws, coalesced).
    public var onChange: (() -> Void)?
    /// The editors of the panes now (pane 0 first), as the view controller has them.
    public var editors: () -> [EditorHandle?] = { [] }
    /// The Stage and the terminal pane, once the view controller has made them.
    public weak var stage: StageController?
    public var showTerminalSession: ((String) -> Void)?
    /// A place on screen for a Build panel / a popup (the view controller's).
    public var anchorOfFooterBuild: (() -> CGRect?)?
    /// The window has the keyboard (for per-window announcements like browser:focused).
    public var windowIsKey: () -> Bool = { true }

    // the component's state
    var views: [String: ViewRecord] = [:]
    public internal(set) var wantedId: String?
    public internal(set) var tabs: [DocTab] = []
    public internal(set) var activeTab: String = WorkspaceTabs.ws
    public internal(set) var docs: [String: String] = [:]
    public var rightMode = "stage" { didSet { if rightMode != oldValue { changed() } } }
    public internal(set) var stageFull = false
    public internal(set) var docFull = false
    public var railWidth: CGFloat = WorkspaceLayout.railDefault { didSet { changed() } }
    public var rightWidth: CGFloat? { didSet { changed() } }
    public var viewWidth: CGFloat = 1440 { didSet { if viewWidth != oldValue { changed() } } }
    public internal(set) var railHidden = false
    public internal(set) var postItsHidden = false
    public internal(set) var starred: [String] = []
    public internal(set) var openPage: OpenPage?
    var pageInfo: (input: String, row: LibraryRow?, addable: Bool, found: LibraryLookup?)?
    public internal(set) var images: [String: NSImage] = [:]
    var imagesAsked = Set<String>()
    public internal(set) var beside: [Pane] = []
    var besideHeldFor = ""
    var pending: [String: (ref: PaneRef, text: String, work: DispatchWorkItem)] = [:]
    public internal(set) var conflicts: [String: (text: String, revision: Double)] = [:]
    var docSync: DocSync!
    var reading = Set<String>()
    public internal(set) var walk: JSONValue?
    public internal(set) var asks: [String: AskRun] = [:]
    public internal(set) var bartModels: JSONValue?
    public internal(set) var paperAsks: [String: JSONValue] = [:]
    var paperEnded = Set<String>()
    public internal(set) var builds: [String: JSONValue] = [:]
    public internal(set) var buildProgress: [String: JSONValue] = [:]
    public internal(set) var buildDiffs: [String: JSONValue] = [:]
    var diffAsked = Set<String>()
    /// The Build panel, hung from the footer's Build (its rect, window points y down).
    public internal(set) var buildDialog: CGRect?
    public internal(set) var rejecting: (id: String, title: String)?
    public internal(set) var review: (id: String, title: String, review: JSONValue?, error: String)?
    public internal(set) var postItBuild: (postItId: String, text: String, anchor: CGRect?)?
    public internal(set) var quickTask: (id: String, postItId: String?, anchor: CGRect?)?
    public internal(set) var copied: (files: Int, missing: Int)?
    var copiedWork: DispatchWorkItem?
    public internal(set) var madeFiles: [String: MadeFileState] = [:]
    var madeAsked = Set<String>()
    var madeOpened = Set<String>()
    public internal(set) var stagePlaces: [String] = []
    public internal(set) var stageFront: String?
    var opened: [String: String] = [:]
    public internal(set) var nav = NavState()
    var agentMarks: [String: [String: String]] = [:]
    var minute = Date()
    public internal(set) var visits: [Visit] = []
    public internal(set) var folders: [JSONValue] = []
    public internal(set) var tourStep: Int?
    public var tourPaused = false { didSet { changed() } }
    var tourTaken = 0
    /// ⌘F's card: the pane searched, a counter that refocuses it, where the caret goes back to.
    public internal(set) var docFind: (pane: Int, focus: Int, back: (line: Int, a: Int, b: Int)?)?
    public internal(set) var notePlus = false
    public internal(set) var flashId: String?
    var flashWork: DispatchWorkItem?
    public internal(set) var mentionOpen = false
    public internal(set) var mentionBodies: MentionRows.Bodies?
    public internal(set) var libraryRequest: (n: Int, chip: String?)?
    var lastEdit: (id: String?, at: Date) = (nil, .distantPast)
    var dropped = Set<String>()
    var lastAgent: String?
    public internal(set) var postItDrag = (active: false, over: false)
    public internal(set) var postItTrash = 0
    public internal(set) var connectNotes: [ConnectNote] = []
    public internal(set) var zoteroFinding = Set<String>()
    public internal(set) var zoteroWaiting = Set<String>()
    /// A note or workspace just made: the caret belongs in its title.
    public var wantTitleFocus = false
    /// Library folder files found gone (`<folderId>:<rel>`): their chips turn grey (useFolderFiles recheck).
    public internal(set) var missingFiles = Set<String>()
    /// The pane to scroll the column to after the next draw (revealPane), taken by the view controller.
    public var revealPane: Int?
    public internal(set) var active: Bool
    var viewTimers: [String: DispatchWorkItem] = [:]
    var hubTokens: [EventHub.Token] = []
    var minuteTimer: Timer?
    var live = true

    // remembered UI (localStorage keys of Workspace.jsx)
    static let sidebarHiddenKey = "engelbart.sidebar.hidden"
    static let postItsHiddenKey = "engelbart.postIts.hidden"
    static let agentMarksKey = "engelbart.agentMarks"
    static let openedKey = "engelbart.openedAt"
    static let visitsKey = "engelbart.recentPages"
    static let saveDelay: TimeInterval = 0.4
    static let viewSaveDelay: TimeInterval = 0.4

    public init(_ ctx: WorkspaceContext) {
        self.ctx = ctx
        tree = ctx.tree
        library = ctx.library
        index = WorkspaceIndex(ctx.tree.workspaces)
        active = ctx.active
        notesById = Dictionary(ctx.library.filter(\.isNote).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        views = ctx.entry.views.mapValues { ViewRecord(json: $0) }
        wantedId = ctx.entry.workspaceId
        let opening = WorkspaceTabs.restoredTabs(view: topicId.flatMap { ctx.entry.views[$0] }, notes: notesById.mapValues(\.name), extra: ctx.entry.tab)
        tabs = opening.tabs
        activeTab = opening.active
        besideHeldFor = "\(topicId ?? "")\n\(activeTab)"
        let store = ctx.storage
        railHidden = store.string(forKey: Self.sidebarHiddenKey) == "1"
        postItsHidden = store.string(forKey: Self.postItsHiddenKey) == "1"
        agentMarks = Self.readStored(store, Self.agentMarksKey).compactMapValues { $0.object?.compactMapValues(\.string) }
        opened = Self.readStored(store, Self.openedKey).compactMapValues(\.string)
        visits = Self.readVisits(store, projectId)
        docSync = DocSync(hasEdits: { [weak self] key in self?.pending[key] != nil },
                          take: { [weak self] key, text in self?.takeText(key, text) },
                          conflict: { [weak self] key, change in self?.putConflict(key, change) })
    }

    /// Starts the reads and the announcements (the component's effects on mount). The view controller calls it once.
    public func start() {
        subscribe()
        loadBartModels()
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let w = try? await api.gettingStarted(projectId), live { walk = w; changed() }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let ids = try? await api.starred(projectId), live { starred = ids; changed() }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let list = try? await api.buildList(projectId), live {
                builds = Dictionary(list.compactMap { t in t["id"]?.string.map { ($0, t) } }, uniquingKeysWith: { _, b in b }); changed()
            }
        }
        loadNav()
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let list = try? await api.folders(), live { folders = list; changed() }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let list = try? await api.runningPaperAsks(projectId), live { paperAsks = Self.runningBack(paperAsks, list, ended: paperEnded); changed() }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let target = await api.takeAgentReveal(projectId), live { revealAsk(target) }
        }
        minuteTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.minute = Date(); self?.changed() } }
        visit()
        readMissing()
        noteOpenedTab()
        openInitialStage()
    }

    /// Leaving the screen (unmount): every pending view and edit is written now, a notice unanswered is saved as shown.
    public func teardown() {
        guard live else { return }
        for (wid, work) in viewTimers { work.cancel(); if let v = views[wid] { let api = self.api, pid = projectId; Task { await api.setView(pid, wid, v.json) } } }
        viewTimers = [:]
        let held = Array(conflicts.keys)
        conflicts = [:]
        for key in Array(pending.keys) + held { flush(key) }
        live = false
        for t in hubTokens { ctx.hub.off(t) }
        hubTokens = []
        minuteTimer?.invalidate()
        ctx.onSidebarGear(false)
        api.postItsTrashRect(nil)
    }

    var changeQueued = false
    /// Something changed: the view controller redraws (once per turn of the run loop).
    public func changed() {
        guard !changeQueued else { return }
        changeQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.changeQueued = false
            self.onChange?()
        }
    }

    // MARK: tree and library (App.jsx reload, other windows)

    /// The tree and the library read again (App.jsx reload, another window's change).
    public func update(tree next: ProjectTree, library rows: [LibraryRow]) {
        tree = next
        library = rows
        index = WorkspaceIndex(next.workspaces)
        notesById = Dictionary(rows.filter(\.isNote).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let wasActive = active
        active = next.project.directory != nil
        if active != wasActive { ctx.onSidebarGear(active && !railHidden) }
        refreshPageInfo()
        checkBeside()
        changed()
        visitIfMoved()
    }

    /// App.jsx reload: the app reads them again; the screen takes what comes back.
    @discardableResult
    public func reload() async -> Bool {
        guard let got = await ctx.reload() else { return false }
        update(tree: got.tree, library: got.library)
        return true
    }

    public func setActive(_ value: Bool) { if active != value { active = value; ctx.onSidebarGear(value && !railHidden); changed() } }

    public func setConnectNotes(_ notes: [ConnectNote]) { if notes != connectNotes { connectNotes = notes; changed() } }

    // MARK: where we are

    /// The workspace shown: the one wanted when the tree has it, else the first.
    public var topicId: String? {
        if let w = wantedId, index.has(w) { return w }
        return tree.workspaces.first?.id
    }
    public var topic: WorkspaceNode? { topicId.flatMap { index[$0]?.node } }
    /// The current workspace's siblings.
    public var topics: [WorkspaceNode] {
        guard let id = topicId, let at = index[id] else { return tree.workspaces }
        return at.parent.flatMap { index[$0]?.node.children } ?? tree.workspaces
    }
    var lastVisited: String?
    func visit() { if let id = topicId { lastVisited = id; ctx.onVisit(id) } }
    func visitIfMoved() { if topicId != lastVisited { visit(); onTopicChanged() } }

    /// Every pane's document: pane 0 is the tab in front, pane 1 the one beside it.
    public var paneDocs: [PaneDoc] {
        [WorkspaceTabs.docOf(activeTab, topicId: topicId)] + beside.map { $0.kind == .workspace ? WorkspaceTabs.workspaceDoc($0.id) : WorkspaceTabs.docOf($0.id, topicId: topicId) }
    }

    /// The document in front's title (renameDoc's field).
    public var docTitle: String {
        if activeTab == WorkspaceTabs.ws { return topic?.name ?? "" }
        if activeTab == WorkspaceTabs.project { return project.name }
        return tabs.first { $0.id == activeTab }?.title ?? ""
    }

    // MARK: tabs and workspaces

    /// A note as a tab; `behind` adds it without bringing it to the front.
    public func openTab(_ id: String, title: String, behind: Bool = false) {
        if !tabs.contains(where: { $0.id == id }) { tabs.append(DocTab(id: id, title: title)) }
        if !behind { setActiveTab(id) } else { tabsChanged() }
    }

    public func setActiveTab(_ id: String) {
        guard tabs.contains(where: { $0.id == id }) || id == WorkspaceTabs.ws else { return }
        activeTab = id
        tabsChanged()
    }

    /// Any note's tab closes (its document saved first); Workspace never does, nor the last tab.
    public func closeTab(_ id: String) {
        guard id != WorkspaceTabs.ws else { return }
        flush(id == WorkspaceTabs.project ? "project" : "note:\(id)")
        guard let next = WorkspaceTabs.closeTab(tabs, active: activeTab, id) else { return }
        tabs = next.tabs
        activeTab = next.active
        tabsChanged()
    }

    public func showWs() {
        if !tabs.contains(where: { $0.id == WorkspaceTabs.ws }) { tabs.insert(WorkspaceTabs.wsTab, at: 0) }
        activeTab = WorkspaceTabs.ws
        tabsChanged()
    }

    public func moveTab(_ id: String, over overId: String) {
        guard let next = WorkspaceTabs.moveTab(tabs, id, over: overId) else { return }
        tabs = next
        tabsChanged()
    }

    public func openProjectPage() {
        if !tabs.contains(where: { $0.id == WorkspaceTabs.project }) { tabs.append(DocTab(id: WorkspaceTabs.project, title: project.name)) }
        setActiveTab(WorkspaceTabs.project)
    }

    /// Going to another workspace opens what it had open when it was left; its own name again opens its document.
    public func selectTopic(_ id: String) {
        if id == topicId { showWs(); return }
        let restored = WorkspaceTabs.restoredTabs(view: views[id]?.json, notes: notesById.mapValues(\.name), extra: nil)
        wantedId = id
        tabs = restored.tabs
        activeTab = restored.active
        tabsChanged()
        visitIfMoved()
    }

    /// The tabs or the tab in front changed: the pane beside closes when the workspace or the tab changed, the view is
    /// saved, documents not read yet are read.
    func tabsChanged() {
        checkBeside()
        recordView()
        readMissing()
        noteOpenedTab()
        if let f = docFind, f.pane >= paneDocs.count { docFind = nil }
        changed()
    }

    func checkBeside() {
        let now = "\(topicId ?? "")\n\(activeTab)"
        if now != besideHeldFor { besideHeldFor = now; beside = [] }
    }

    func onTopicChanged() {
        seeAgentsHere()
        if let id = topicId { visits = Visits.visited(visits, kind: "project", id: id); writeVisits() }
        refreshPageInfo()
    }

    // MARK: views (state.json `views`)

    func recordView() {
        guard let wid = topicId else { return }
        let held = views[wid] ?? ViewRecord()
        let open = tabs.filter { $0.id != WorkspaceTabs.ws }
        if held.active == activeTab && held.tabs == open && views[wid] != nil { return }
        var next = held
        next.active = activeTab; next.tabs = open
        views[wid] = next
        saveView(wid)
    }

    /// A workspace's view is saved a moment after it changes, and at once when the editor lets go of a document.
    func saveView(_ wid: String, now: Bool = false) {
        viewTimers[wid]?.cancel()
        viewTimers[wid] = nil
        let send = { [weak self] in
            guard let self else { return }
            self.viewTimers[wid] = nil
            guard let v = self.views[wid] else { return }
            let api = self.api, pid = self.projectId, json = v.json
            Task { await api.setView(pid, wid, json) }
        }
        if now { send(); return }
        let work = DispatchWorkItem(block: send)
        viewTimers[wid] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.viewSaveDelay, execute: work)
    }

    /// Where a document was scrolled to, in the workspace it was read in.
    public func recordPosition(scope: String, key: String, position: JSONValue, now: Bool) {
        var held = views[scope] ?? ViewRecord()
        held.positions.removeAll { $0.key == key } // the most recent last: the oldest go first when there are too many
        held.positions.append((key, position))
        views[scope] = held
        saveView(scope, now: now)
    }
    public func viewOf(scope: String, key: String) -> JSONValue? { views[scope]?.position(key) }
    public func view(of workspaceId: String) -> ViewRecord? { views[workspaceId] }

    // MARK: layout state

    public var layout: WorkspaceLayout { WorkspaceLayout(viewWidth: viewWidth, railWidth: railWidth, railHidden: railHidden, rightWidth: rightWidth, stageFull: stageFull) }

    public func toggleStageFull() { if !stageFull { docFull = false }; stageFull.toggle(); changed() }
    public func toggleDocFull() { if !docFull { stageFull = false }; docFull.toggle(); changed() }
    public func leaveDocFull() { if docFull { docFull = false; changed() } }
    /// What opens on the right (the Stage or the terminal) brings the right pane back from the document's full screen.
    public func showRight(_ mode: String) { rightMode = mode; if docFull { docFull = false }; changed() }
    /// What is in front in the Stage when @bart is asked (MATH-27): only while the Stage shows.
    var stageShown: Bool { rightMode == "stage" && !docFull }
    public func stageNow() -> JSONValue? { stageShown ? stage?.front() : nil }

    public func toggleRail() {
        railHidden.toggle()
        ctx.storage.set(railHidden ? "1" : "0", forKey: Self.sidebarHiddenKey)
        ctx.onSidebarGear(active && !railHidden)
        changed()
    }
    public func setPostItsHidden(_ value: Bool) {
        postItsHidden = value
        ctx.storage.set(value ? "1" : "0", forKey: Self.postItsHiddenKey)
        changed()
    }
    /// The sidebar's edge pressed: from here the right pane keeps the width it has.
    public func railDragBegan() { if rightWidth == nil { rightWidth = layout.right } }

    // MARK: the sidebar's rows

    public var mentioned: [LibraryRow] { WorkspaceRows.mentioned(topic.flatMap { docs["ws:\($0.id)"] } ?? "", library: library) }
    public var rows: [LibraryRow] { WorkspaceRows.rail(topic: topic, library: library, notes: tree.notes, mentioned: mentioned) }
    public var railRows: [LibraryRow] { Visits.byOpened(rows, opened) }
    public var railIds: Set<String> { Set(rows.map(\.id)) }
    public func inRail(_ id: String) -> Bool { railIds.contains(id) }
    public var letGo: Set<String> { MentionRows.letGoNotes(tree.workspaces, notes: tree.notes) }
    /// The library less the notes trashed from their last workspace (MATH-58).
    public var findable: [LibraryRow] { let gone = letGo; return gone.isEmpty ? library : library.filter { !gone.contains($0.id) } }
    /// The row the sidebar marks: the note tab in front, else the Stage's front row while the Stage shows, else 'ws'.
    public var activeRowId: String {
        if activeTab != WorkspaceTabs.ws { return activeTab }
        return rightMode == "stage" ? (stageFront ?? WorkspaceTabs.ws) : WorkspaceTabs.ws
    }

    /// A row that just arrived in the sidebar flashes for 1.7 s.
    public func flash(_ id: String) {
        flashWork?.cancel()
        flashId = id
        let work = DispatchWorkItem { [weak self] in self?.flashId = nil; self?.changed() }
        flashWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.7, execute: work)
        changed()
    }

    /// When each source was opened last (2026-10-16): a note put in front, the Stage's front row, a sidebar row clicked.
    public func noteOpen(_ id: String?) {
        guard let id, !id.isEmpty else { return }
        opened = Visits.noteOpened(opened, id)
        ctx.storage.set(JSONValue.object(opened.mapValues { .string($0) }).text(), forKey: Self.openedKey)
    }
    func noteOpenedTab() {
        if activeTab != WorkspaceTabs.ws && !activeTab.hasPrefix(WorkspaceTabs.archivePrefix) && activeTab != WorkspaceTabs.project { noteOpen(activeTab) }
        if notesById[activeTab] != nil { visits = Visits.visited(visits, kind: "note", id: activeTab); writeVisits() }
    }
    func writeVisits() {
        var all = Self.readStored(ctx.storage, Self.visitsKey)
        all[projectId] = .array(visits.map { ["kind": .string($0.kind), "id": .string($0.id), "at": .string($0.at)] })
        ctx.storage.set(JSONValue.object(all).text(), forKey: Self.visitsKey)
    }

    static func readStored(_ store: UserDefaults, _ key: String) -> [String: JSONValue] {
        guard let text = store.string(forKey: key), let held = try? JSONValue.parse(text), let o = held.object else { return [:] }
        return o
    }
    static func readVisits(_ store: UserDefaults, _ projectId: String) -> [Visit] {
        (readStored(store, visitsKey)[projectId]?.array ?? []).compactMap { v in
            guard let kind = v["kind"]?.string, let id = v["id"]?.string else { return nil }
            return Visit(kind: kind, id: id, at: v["at"]?.string ?? "")
        }
    }

    // MARK: errors

    public func report(_ error: Error) { ctx.onError(Self.message(of: error)) }
    public func report(_ message: String) { ctx.onError(message) }
    /// api.js errorMessage: what the error says.
    public static func message(of error: Error) -> String {
        if let e = error as? LocalizedError, let d = e.errorDescription, !d.isEmpty { return d }
        return String(describing: error)
    }

    /// `setTimeout(attempt, ms)` retried `tries` times until `attempt` says it is done.
    func retry(every seconds: TimeInterval, tries: Int, first: TimeInterval = 0, _ attempt: @escaping () -> Bool) {
        var left = tries
        func go() {
            if attempt() { return }
            left -= 1
            if left > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { MainActor.assumeIsolated { go() } } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + first) { MainActor.assumeIsolated { go() } }
    }

    /// The editor showing the document `key`, if any pane does.
    func editor(for key: String) -> EditorHandle? { editors().compactMap { $0 }.first { $0.handleKey == key } }
    func editor(at pane: Int) -> EditorHandle? { let all = editors(); return pane < all.count ? all[pane] : nil }
}
