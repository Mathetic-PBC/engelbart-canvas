import Foundation
import EngelbartCore
#if canImport(AppKit)
import AppKit
#endif

/// Runs async work one at a time, in the order it was asked for (ipc.cjs `queued` / the per-document save turns).
actor SerialLane {
    private var tail: Task<Void, Never>?
    func run<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task<T, Error> {
            await previous?.value
            return try await work()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }
}

/// What the app gives the store that is not the store's (all optional; each is the Electron handler's collaborator).
public struct StoreHooks: Sendable {
    /// A page asked for its title and description (page-meta). Default: PageMeta.describer().
    public var describe: PageMeta.Describe? = PageMeta.describer()
    /// GitHub asked who a repository is. Default: PageMeta.repoIdentifier() (the app passes one signed in).
    public var identifyRepo: PageMeta.IdentifyRepo? = PageMeta.repoIdentifier()
    /// A repository's top-level files, for the peek. Default: PageMeta.remoteFileLister().
    public var listRemoteFiles: PageMeta.ListRemoteFiles? = PageMeta.remoteFileLister()
    /// How a dropped link is read (the Stage's session, so a picture behind a sign-in comes too). Default: HTTP.fetch.
    public var fetchUrl: HTTPFetch = HTTP.fetch
    /// How a page row that may be a pdf is downloaded by the web-pdfs checker (the Stage's cookies). Default: HTTP.fetch, 120 s.
    public var fetchPdf: WebPdfs.FetchPdf? = { url in try await WebPdfs.readPdfResponse(try await HTTP.fetch(url, [:], 120)) }
    /// A pdf came into the library: the sweeper reads its text now (index.cjs pdfAdded → sweeper.sweepSoon).
    public var pdfAdded: (@Sendable () -> Void)?
    /// A saved GitHub repository's sandbox starts (sandbox/manager.cjs start, waitForClaude). Throws to report why.
    public var startSandbox: (@Sendable (_ ctx: StoreContext, _ libraryId: String) async throws -> Void)?
    /// A repository's sandbox stopped and its runs forgotten before its row can go (discard-library-item).
    public var releaseSandbox: (@Sendable (_ ctx: StoreContext, _ libraryId: String) async throws -> Void)?
    /// Every sandbox stopped before a data-mode change (ipc.cjs `changing`: sandbox.close, connect.suspendAll, beforeContextChange).
    public var beforeContextChange: (@Sendable () async -> Void)?
    /// The Build package's: a project's Builds stopped; worktrees removed or moved; the open Build ids of a project; a
    /// new project folder's repository prepared.
    public var stopBuilds: (@Sendable (_ ctx: StoreContext, _ projectId: String) async throws -> Void)?
    public var removeWorktrees: (@Sendable (_ tasks: [JSONValue]) async throws -> Void)?
    public var moveWorktree: (@Sendable (_ task: JSONValue, _ to: String) async throws -> Void)?
    public var openBuildIds: (@Sendable (_ ctx: StoreContext, _ projectId: String) -> Set<String>)?
    public var prepareDefault: (@Sendable (_ ctx: StoreContext, _ projectId: String) async -> Void)?
    /// The Bart package's: stop a running @bart ask (trash-project stops the project's asks first).
    public var stopAsk: (@Sendable (_ askId: String) -> Void)?
    /// The Connect package's: an import session's notes attached to the project made at the end of onboarding.
    public var attachProject: (@Sendable (_ ctx: StoreContext, _ importId: String, _ projectId: String, _ workspaceId: String) async throws -> Int)?
    /// The Stage package's: the page a window's Stage tab shows written into `dir` (views.savePage) → (url, title).
    public var savePage: (@Sendable (_ tabId: String, _ dir: String) async throws -> Library.SavedPage?)?
    /// The native picker for "Choose from disk…" ('pdf' or 'any'). Default: NSOpenPanel.
    public var pickPaths: (@Sendable (_ kind: String) async -> [String])?
    public init() {}
}

/// The data side of Engelbart: the Swift counterpart of ipc.cjs's createStore and its data handlers. Method names follow
/// preload.cjs's `engelbartAPI`; events are posted on `events` under the Electron channel names
/// (`engelbart:library-changed`, `engelbart:project-changed`, `doc:changed`, `engelbart:nav`, `engelbart:starred`,
/// `engelbart:folders`, `engelbart:data-root-changed`).
public final class Store: @unchecked Sendable {
    public let homeDir: String
    public let layout: Home.Layout
    public let testModeAvailable: Bool
    public let fixturesDir: String?
    public let inspectPdf: Library.InspectPdf?
    public let pdfTitle: Library.PdfTitle?
    public var hooks: StoreHooks
    public let events: EventHub
    /// `afterOpen(ctx, again)`: background work each time a library is opened (the web-pdfs checker). nil: none.
    public var afterOpen: (@Sendable (StoreContext, Bool) -> Void)?
    let rootDir: String?

    private let lock = NSLock()
    private var contexts: [String: Task<StoreContext, Error>] = [:]
    private var changingMode = false
    private let additions = SerialLane()
    private var revisions: [String: Int] = [:]
    private var docLanes: [String: SerialLane] = [:]
    private let libraryDebounce = Debouncer(delay: 0.4)

    static let freshMark = ".fresh"

    /// - homeDir: the person's home (`ENGELBART_HOME_DIR`); rootDir: the Engelbart root (`ENGELBART_ROOT_DIR`, default
    ///   `<home>/.engelbart-swift`); fixturesDir: the test library's seeds (default: this package's resources).
    public init(homeDir: String = ProcessInfo.processInfo.environment["ENGELBART_HOME_DIR"] ?? NSHomeDirectory(),
                rootDir: String? = ProcessInfo.processInfo.environment["ENGELBART_ROOT_DIR"],
                fixturesDir: String? = Library.bundledFixtures, inspectPdf: Library.InspectPdf? = PdfKind.inspect, pdfTitle: Library.PdfTitle? = PdfKind.title,
                testModeAvailable: Bool = false, hooks: StoreHooks = StoreHooks(), events: EventHub = .shared, webPdfs: Bool = ProcessInfo.processInfo.environment["ENGELBART_WEB_PDFS"] != "off") throws {
        self.homeDir = homeDir
        self.rootDir = rootDir
        self.layout = try Home.ensureHome(homeDir, rootDir: rootDir, test: testModeAvailable)
        self.testModeAvailable = testModeAvailable
        self.fixturesDir = fixturesDir
        self.inspectPdf = inspectPdf
        self.pdfTitle = pdfTitle
        self.hooks = hooks
        self.events = events
        if webPdfs {
            // Pdfs saved as links before the Stage kept copies: every library that opens is checked (ENGELBART_WEB_PDFS=off: never).
            afterOpen = { [weak self] ctx, again in
                guard let self, let fetchPdf = self.hooks.fetchPdf else { return }
                WebPdfs.check(ctx, fetchPdf: fetchPdf, inspectPdf: self.inspectPdf, onChange: { [weak self] in self?.libraryChangedSoon(); self?.hooks.pdfAdded?() },
                              log: { line in FileHandle.standardError.write(Data("[engelbart] \(line)\n".utf8)) }, again: again)
            }
        }
    }

    // MARK: modes

    public var mode: String { testModeAvailable && Home.readConfig(layout.root)["testMode"]?.bool == true ? "test" : "normal" }

    /// config.json + testMode, testModeAvailable, mode, home, testRoot, dataRoot.
    public func config() -> JSONValue {
        let current = mode
        return Home.readConfig(layout.root).merging([
            "testMode": .bool(current == "test"), "testModeAvailable": .bool(testModeAvailable), "mode": .string(current),
            "home": .string(layout.root), "testRoot": .string(layout.testRoot), "dataRoot": .string(current == "test" ? layout.testRoot : layout.root),
        ])
    }

    public var dataRoot: String { mode == "test" ? layout.testRoot : layout.root }

    /// The current mode's context, opened once: library database, the test library seeded, recategorized and retitled
    /// (awaited, so the first read sees the final rows), then `afterOpen` in the background.
    public func context() async throws -> StoreContext {
        let current = mode
        let task: Task<StoreContext, Error> = lock.withLock {
            if let held = contexts[current] { return held }
            let made = Task { try await self.open(current) }
            contexts[current] = made
            return made
        }
        do { return try await task.value }
        catch { _ = lock.withLock { contexts[current] = nil }; throw error }
    }

    private func open(_ current: String) async throws -> StoreContext {
        try Home.ensureHome(homeDir, rootDir: rootDir, test: testModeAvailable)
        let dataRoot = current == "test" ? layout.testRoot : layout.root
        let ctx = StoreContext(homeDir: homeDir, root: layout.root, dataRoot: dataRoot, mode: current, libraryDb: try LibraryDB.open(root: dataRoot))
        // Test mode's sample library, except after "Start as a new user".
        if current == "test" && !Paths.exists(Paths.join(dataRoot, Self.freshMark)) { try Library.seedIfEmpty(ctx, fixturesDir: fixturesDir) }
        // A library behind the category rules is brought up to them before anyone reads it; a failure leaves rows due.
        _ = try? await Library.recategorize(ctx, inspectPdf: inspectPdf)
        _ = try? await Library.describeRows(ctx, pdfTitle: pdfTitle)
        if let afterOpen { DispatchQueue.global().async { afterOpen(ctx, false) } }
        return ctx
    }

    /// The checker again for an open library, when a row it would act on was just added (2026-10-02).
    func recheck(_ ctx: StoreContext) { if let afterOpen { DispatchQueue.global().async { afterOpen(ctx, true) } } }

    public func close() {
        lock.withLock { contexts.removeAll() }
        SQLiteRegistry.closeAll()
    }

    public func requireTestMode() throws {
        if !testModeAvailable { throw StoreError("Test mode is only in developer builds of Engelbart") }
    }

    private func changing<T>(_ change: () async throws -> T) async throws -> T {
        try lock.withLock {
            if changingMode { throw StoreError("Data mode is already changing") }
            changingMode = true
        }
        defer { lock.withLock { changingMode = false } }
        _ = try? await additions.run { }
        await hooks.beforeContextChange?()
        return try await change()
    }

    private func queued<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        if lock.withLock({ changingMode }) { throw StoreError("Wait for the data mode change to finish") }
        return try await additions.run(work)
    }

    /// Refused before anything closes in a copy without test mode. Every other window starts over on the new root.
    @discardableResult
    public func setTestMode(_ value: Bool) async throws -> JSONValue {
        try requireTestMode()
        let out = try await changing {
            close()
            try Home.writeConfig(layout.root, ["testMode": .bool(value)])
            return config()
        }
        events.post("engelbart:data-root-changed", ["config": out, "fresh": false])
        return out
    }

    /// Wipes `<root>/test` and makes it again; `fresh` ("Start as a new user") leaves the library empty until the next plain reset.
    /// The confirmation dialog is the app's (ask before calling).
    @discardableResult
    public func resetTestData(fresh: Bool = false) async throws -> JSONValue {
        try requireTestMode()
        if mode != "test" { throw StoreError("Test mode is off") }
        let out = try await changing {
            close()
            try? FileManager.default.removeItem(atPath: layout.testRoot)
            try Home.ensureHome(homeDir, rootDir: rootDir)
            if fresh { try JSONFiles.writeText(Paths.join(layout.testRoot, Self.freshMark), "\(Time.iso())\n") }
            return config()
        }
        events.post("engelbart:data-root-changed", ["config": out, "fresh": .bool(fresh)])
        return out.merging(["reset": true])
    }

    // MARK: events

    func projectChanged(_ projectId: String?, extra: [String: JSONValue] = [:]) {
        guard let projectId else { return }
        events.post("engelbart:project-changed", JSONValue.object(["projectId": .string(projectId)]).merging(extra))
    }
    func libraryChanged() { events.post("engelbart:library-changed", .object([:])) }
    func libraryChangedSoon() { libraryDebounce.call { [weak self] in self?.libraryChanged() } }
    func navChanged() { events.post("engelbart:nav", .object([:])) }

    // MARK: state.json

    public func lastOpen() async throws -> AppState.LastOpen { AppState.readLastOpen(try await context().dataRoot) }
    @discardableResult public func setLastOpen(_ value: JSONValue) async throws -> AppState.LastOpen { try AppState.writeLastOpen(try await context().dataRoot, value) }
    public func views(_ projectId: String?) async throws -> [String: JSONValue] { AppState.readViews(try await context().dataRoot, projectId) }
    @discardableResult public func setView(_ projectId: String?, _ workspaceId: String?, _ view: JSONValue) async throws -> JSONValue { try AppState.writeView(try await context().dataRoot, projectId, workspaceId, view) }
    public func stage(_ projectId: String?) async throws -> JSONValue { AppState.readStage(try await context().dataRoot, projectId) }
    @discardableResult public func setStage(_ projectId: String?, _ value: JSONValue) async throws -> JSONValue { try AppState.writeStage(try await context().dataRoot, projectId, value) }
    public func nav() async throws -> JSONValue { AppState.readNav(try await context()) }

    /// A workspace was written in: front of ⌘J's list.
    @discardableResult public func recordEdit(_ projectId: String, _ workspaceId: String) async throws -> Bool {
        try AppState.recordEdit(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(workspaceId, "workspace id", 64))
        navChanged()
        return true
    }
    @discardableResult public func seenAgents(_ projectId: String, _ workspaceId: String) async throws -> Int {
        let seen = try AppState.seenAgents(try await context().dataRoot, projectId, workspaceId)
        if seen > 0 { navChanged() }
        return seen
    }
    public func agentStarted(id: String, kind: String = "bart", projectId: String?, workspaceId: String?, doc: JSONValue? = nil) async throws {
        try AppState.agentStarted(try await context().dataRoot, id: id, kind: kind, projectId: projectId, workspaceId: workspaceId, doc: doc); navChanged()
    }
    public func agentFinished(_ id: String) async throws { try AppState.agentFinished(try await context().dataRoot, id); navChanged() }
    public func agentStopped(_ id: String) async throws { try AppState.agentStopped(try await context().dataRoot, id); navChanged() }

    /// The windows as they were last kept (index.cjs saveWindows), and their keeping.
    public func windows() async throws -> [JSONValue] { AppState.readWindows(try await context().dataRoot) }
    @discardableResult public func setWindows(_ list: JSONValue) async throws -> [JSONValue] { try AppState.writeWindows(try await context().dataRoot, list) }

    public func folders() async throws -> [AppState.Folder] { AppState.readFolders(try await context().dataRoot) }
    private func foldersChanged(_ folders: [AppState.Folder]) -> [AppState.Folder] {
        events.post("engelbart:folders", ["folders": .array(folders.map(\.json))]); return folders
    }
    public func createFolder(_ name: String) async throws -> (folder: AppState.Folder, folders: [AppState.Folder]) {
        let out = try AppState.createFolder(try await context().dataRoot, try StoreArgs.str(name, "folder name", 400))
        _ = foldersChanged(out.folders)
        return out
    }
    @discardableResult public func renameFolder(_ id: String, _ name: String) async throws -> [AppState.Folder] {
        foldersChanged(try AppState.renameFolder(try await context().dataRoot, try StoreArgs.str(id, "folder id", 64), try StoreArgs.str(name, "folder name", 400)))
    }
    @discardableResult public func deleteFolder(_ id: String) async throws -> [AppState.Folder] {
        foldersChanged(try AppState.deleteFolder(try await context().dataRoot, try StoreArgs.str(id, "folder id", 64)))
    }
    @discardableResult public func addToFolder(_ id: String, _ ids: [String]) async throws -> [AppState.Folder] {
        foldersChanged(try AppState.addToFolder(try await context().dataRoot, try StoreArgs.str(id, "folder id", 64), try ids.prefix(200).map { try StoreArgs.str($0, "library id", 64) }))
    }
    @discardableResult public func removeFromFolder(_ id: String, _ item: String) async throws -> [AppState.Folder] {
        foldersChanged(try AppState.removeFromFolder(try await context().dataRoot, try StoreArgs.str(id, "folder id", 64), try StoreArgs.str(item, "library id", 64)))
    }

    public func starred(_ projectId: String?) async throws -> [String] { AppState.readStarred(try await context().dataRoot, projectId) }
    @discardableResult public func setStarred(_ projectId: String, _ itemId: String, _ on: Bool) async throws -> [String] {
        let ids = try AppState.setStarred(try await context().dataRoot, try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(itemId, "library id", 64), on)
        events.post("engelbart:starred", ["projectId": .string(projectId), "ids": .array(ids.map { .string($0) })])
        return ids
    }

    // MARK: projects

    public func listProjects() async throws -> [PublicProject] { try Projects.listProjects(try await context()) }

    @discardableResult
    public func createProject(_ input: Projects.NewProject) async throws -> PublicProject {
        let out = try Projects.createProject(try await context(), input)
        projectChanged(out.id)
        return out
    }

    @discardableResult
    public func createProjectWithWelcome(_ input: Projects.NewProject) async throws -> Projects.Welcomed {
        let out = try Projects.createProjectWithWelcome(try await context(), input)
        projectChanged(out.project.id)
        return out
    }

    public func instructions() async throws -> String { Onboarding.readInstructions(try await context().dataRoot) }
    @discardableResult public func setInstructions(_ text: String) async throws -> String {
        try Onboarding.writeInstructions(try await context().dataRoot, try StoreArgs.str(text, "instructions", 40000))
    }
    public func freeFolder(_ name: String) async throws -> Onboarding.FreeFolder { try Onboarding.freeFolder(try await context(), try StoreArgs.str(name, "name")) }
    public func checkFolder(_ value: String) async throws -> String { try Onboarding.existingFolder(try await context(), try StoreArgs.str(value, "directory", 4096)) }

    /// The project onboarding's last screens describe (ipc.cjs start-project): `onboarding` (a new user's) makes the Welcome
    /// page project and marks the guided offer 'onboarded'; `connect` attaches that import session; a folder made here
    /// gets its Build repository prepared in the background.
    @discardableResult
    public func startProject(_ input: Onboarding.StartProject, connect: String? = nil, onboarding: Bool = false) async throws -> Projects.Welcomed {
        let ctx = try await context()
        var request = input
        request.name = try StoreArgs.str(input.name, "name")
        request.context = try input.context.prefix(500).map { try StoreArgs.str($0, "library id", 64) }
        if onboarding { request.welcomePage = true }
        var made = try Onboarding.startProject(ctx, request)
        if request.folder == "new", let prepare = hooks.prepareDefault { let id = made.project.id; Task { await prepare(ctx, id) } }
        if let connect, let attach = hooks.attachProject { made.importedNotes = (try? await attach(ctx, connect, made.project.id, made.workspaceId)) ?? 0 }
        if onboarding { _ = try? GettingStarted.markGuidedOffer(ctx.dataRoot, "onboarded") }
        projectChanged(made.project.id)
        libraryChanged()
        return made
    }

    /// The guided setup started inside a project (2026-10-10): a Welcome workspace, its walkthrough, the offer marked.
    @discardableResult
    public func welcomeWorkspace(_ projectId: String, context ids: [String] = [], connect: String? = nil) async throws -> Onboarding.WelcomeWorkspace {
        let ctx = try await context()
        var made = try Onboarding.addWelcomeWorkspace(ctx, try StoreArgs.str(projectId, "project id", 64), context: try ids.prefix(500).map { try StoreArgs.str($0, "library id", 64) })
        if let connect, let attach = hooks.attachProject { made.importedNotes = (try? await attach(ctx, connect, made.project.id, made.workspaceId)) ?? 0 }
        made.gettingStarted = try GettingStarted.start(ctx, made.project.id, workspaceId: made.workspaceId)
        _ = try? GettingStarted.markGuidedOffer(ctx.dataRoot, "onboarded")
        projectChanged(projectId)
        libraryChanged()
        return made
    }

    @discardableResult
    public func discardLibraryItem(_ id: String) async throws -> Bool {
        let libraryId = try StoreArgs.str(id, "library id", 64)
        let out = try await queued { [self] in
            let ctx = try await context()
            let release = hooks.releaseSandbox
            return try await Onboarding.discardItem(ctx, libraryId, release: release.map { r in { try await r(ctx, libraryId) } })
        }
        libraryChanged()
        return out
    }

    public func gettingStarted(_ projectId: String) async throws -> GettingStartedState? { GettingStarted.read(try await context(), try StoreArgs.str(projectId, "project id", 64)) }
    @discardableResult public func setGettingStarted(_ projectId: String, tick: [Int] = [], untick: [Int] = [], hidden: Bool = false) async throws -> GettingStartedState {
        try GettingStarted.set(try await context(), try StoreArgs.str(projectId, "project id", 64), tick: Array(tick.prefix(GettingStarted.steps)), untick: Array(untick.prefix(GettingStarted.steps)), hidden: hidden)
    }
    /// ENGELBART_CONNECT_OFFER=off never shows it (the smokes).
    public func guidedOffer() async throws -> Bool {
        let root = try await context().dataRoot
        return ProcessInfo.processInfo.environment["ENGELBART_CONNECT_OFFER"] != "off" && GettingStarted.guidedOfferDue(root)
    }
    @discardableResult public func guidedOfferSeen(_ how: String) async throws -> JSONValue { try GettingStarted.markGuidedOffer(try await context().dataRoot, how) }
    public func connectOffer() async throws -> Bool {
        let root = try await context().dataRoot
        return ProcessInfo.processInfo.environment["ENGELBART_CONNECT_OFFER"] != "off" && GettingStarted.connectOfferDue(root)
    }
    public func connectOfferSeen(_ how: String) async throws { try GettingStarted.markConnectOffer(try await context().dataRoot, how) }
    /// MEMORY.md in this data root: { exists, path, updated, bytes }.
    public func connectMemory() async throws -> JSONValue {
        let file = Paths.join(try await context().dataRoot, "MEMORY.md")
        guard let info = Paths.stat(file) else { return ["exists": false, "path": .string(file)] }
        return ["exists": true, "path": .string(file), "updated": .string(Time.iso(Date(timeIntervalSince1970: info.mtimeMs / 1000))), "bytes": .number(Double(info.size))]
    }

    @discardableResult
    public func renameProject(_ id: String, _ name: String) async throws -> PublicProject {
        let out = try Projects.renameProject(try await context(), try StoreArgs.str(id, "project id", 64), try StoreArgs.str(name, "name"))
        projectChanged(id)
        return out
    }

    /// Delete (2026-10-03): the project's running asks and its Builds stopped first, then into the trash for a week.
    @discardableResult
    public func trashProject(_ id: String) async throws -> (id: String, name: String) {
        let ctx = try await context()
        let projectId = try StoreArgs.str(id, "project id", 64)
        let hooks = self.hooks
        let out = try await Projects.trashProject(ctx, projectId) { pid in
            for agent in AppState.readNav(ctx)["agents"]?.array ?? [] where agent["projectId"]?.string == pid && agent["kind"]?.string != "build" && agent["status"]?.string == "running" {
                if let id = agent["id"]?.string { hooks.stopAsk?(id) }
            }
            try await hooks.stopBuilds?(ctx, pid)
        }
        navChanged()
        projectChanged(projectId, extra: ["trashed": true])
        return out
    }

    @discardableResult
    public func restoreProject(_ id: String) async throws -> PublicProject {
        let out = try await Projects.restoreProject(try await context(), try StoreArgs.str(id, "project id", 64), moveWorktree: hooks.moveWorktree, removeWorktrees: hooks.removeWorktrees)
        navChanged()
        projectChanged(id)
        return out
    }

    public func trashedProjects() async throws -> [TrashedProject] { try await Projects.trashedProjects(try await context(), removeWorktrees: hooks.removeWorktrees) }
    public func loadProject(_ id: String) async throws -> ProjectTree { try Projects.loadProject(try await context(), try StoreArgs.str(id, "project id", 64)) }

    @discardableResult
    public func setProjectDirectory(_ id: String, _ directory: String) async throws -> PublicProject {
        let out = try Projects.setProjectDirectory(try await context(), try StoreArgs.str(id, "project id", 64), try StoreArgs.str(directory, "directory", 4096))
        projectChanged(id)
        return out
    }

    // MARK: workspaces

    /// Making a workspace counts as writing in it (⌘J's recent ones).
    @discardableResult
    public func createWorkspace(_ projectId: String, name: String? = nil, parentId: String? = nil) async throws -> PublicWorkspace {
        let ctx = try await context()
        let pid = try StoreArgs.str(projectId, "project id", 64)
        let created = try Workspaces.create(ctx, pid, name: try StoreArgs.optStr(name, "name"), parentId: try StoreArgs.optStr(parentId, "parent id", 64))
        try AppState.recordEdit(ctx, pid, created.id)
        navChanged()
        projectChanged(pid)
        return created
    }

    @discardableResult
    public func renameWorkspace(_ projectId: String, _ workspaceId: String, _ name: String) async throws -> PublicWorkspace {
        let out = try Workspaces.rename(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(workspaceId, "workspace id", 64), try StoreArgs.str(name, "name"))
        projectChanged(projectId)
        return out
    }

    @discardableResult
    public func trashWorkspace(_ projectId: String, _ workspaceId: String) async throws -> (id: String, name: String) {
        let out = try Workspaces.trash(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(workspaceId, "workspace id", 64))
        navChanged(); projectChanged(projectId)
        return out
    }

    @discardableResult
    public func restoreWorkspace(_ projectId: String, _ workspaceId: String) async throws -> PublicWorkspace {
        let out = try Workspaces.restore(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(workspaceId, "workspace id", 64))
        navChanged(); projectChanged(projectId)
        return out
    }

    /// A workspace's context changed: queued with the library additions; a saved GitHub repository newly in it starts
    /// its sandbox (a failure answers as `sandbox_error`, the change kept).
    private func changeContext(_ projectId: String, _ workspaceId: String, _ change: @escaping @Sendable (StoreContext, String, String) throws -> PublicWorkspace) async throws -> (workspace: PublicWorkspace, sandboxError: String?) {
        let pid = try StoreArgs.str(projectId, "project id", 64), wid = try StoreArgs.str(workspaceId, "workspace id", 64)
        let start = hooks.startSandbox
        let out: (PublicWorkspace, String?) = try await queued { [self] in
            let ctx = try await context()
            let held = try Workspaces.find(ctx, pid, wid).workspace
            let before = Set(held.context.filter { !held.removed.contains($0) })
            let workspace = try change(ctx, pid, wid)
            return (workspace, await startLinked(ctx, before, workspace.context, start))
        }
        projectChanged(pid)
        return out
    }

    private func startLinked(_ ctx: StoreContext, _ before: Set<String>, _ context: [String], _ start: (@Sendable (StoreContext, String) async throws -> Void)?) async -> String? {
        guard let start else { return nil }
        var errors: [String] = []
        for id in context where !before.contains(id) {
            guard let row = try? ctx.libraryDb.get(id), let url = row.url, RX.test(url, Library.github, ci: true) else { continue }
            do { try await start(ctx, id) } catch { errors.append("\(row.name): \(error.localizedDescription)") }
        }
        return errors.isEmpty ? nil : errors.joined(separator: "\n")
    }

    @discardableResult
    public func setWorkspaceContext(_ projectId: String, _ workspaceId: String, _ entries: JSONValue) async throws -> (workspace: PublicWorkspace, sandboxError: String?) {
        try await changeContext(projectId, workspaceId) { ctx, pid, wid in try Workspaces.setContext(ctx, pid, wid, entries) }
    }

    /// The sidebar's search, +, Save and an @mention; `picked`: the @ menu linked it.
    @discardableResult
    public func linkToWorkspace(_ projectId: String, _ workspaceId: String, _ ids: [String], picked: Bool = false) async throws -> (workspace: PublicWorkspace, sandboxError: String?) {
        let adding = try ids.prefix(200).map { try StoreArgs.str($0, "library id", 64) }
        return try await changeContext(projectId, workspaceId) { ctx, pid, wid in try Workspaces.link(ctx, pid, wid, adding, picked: picked) }
    }

    /// The trash; `unmentioned`: its last mention left the document (MATH-57).
    @discardableResult
    public func unlinkFromWorkspace(_ projectId: String, _ workspaceId: String, _ id: String, unmentioned: Bool = false) async throws -> (workspace: PublicWorkspace, sandboxError: String?) {
        let entry = try StoreArgs.str(id, "library id", 64)
        return try await changeContext(projectId, workspaceId) { ctx, pid, wid in try Workspaces.unlink(ctx, pid, wid, [entry], unmentioned: unmentioned) }
    }

    @discardableResult
    public func addToProject(_ projectId: String, _ ids: [String], workspaceId: String? = nil) async throws -> Projects.Added {
        let pid = try StoreArgs.str(projectId, "project id", 64)
        if ids.count > Projects.maxProjectChange { throw StoreError.range("At most \(Projects.maxProjectChange) items can be added or removed at once; \(ids.count) were sent.") }
        let adding = try ids.map { try StoreArgs.str($0, "library id", 64) }
        let wid = try StoreArgs.optStr(workspaceId, "workspace id", 64)
        let start = hooks.startSandbox
        let out: Projects.Added = try await queued { [self] in
            let ctx = try await context()
            let before = try wid.map { Set(try Workspaces.find(ctx, pid, $0).workspace.context) }
            var out = try Projects.addToProject(ctx, pid, adding, workspaceId: wid)
            if let wid, let before { out.sandboxError = await startLinked(ctx, before, try Workspaces.find(ctx, pid, wid).workspace.context, start) }
            return out
        }
        projectChanged(pid)
        return out
    }

    @discardableResult
    public func removeFromProject(_ projectId: String, _ ids: [String]) async throws -> Int {
        let pid = try StoreArgs.str(projectId, "project id", 64)
        if ids.count > Projects.maxProjectChange { throw StoreError.range("At most \(Projects.maxProjectChange) items can be added or removed at once; \(ids.count) were sent.") }
        let going = try ids.map { try StoreArgs.str($0, "library id", 64) }
        let out = try await queued { [self] in try Projects.removeFromProject(try await context(), pid, going) }
        projectChanged(pid)
        return out
    }

    public func projectItemMentions(_ projectId: String, _ id: String) async throws -> [Projects.WorkspacePlace] {
        try Projects.projectItemMentions(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(id, "library id", 64))
    }

    // MARK: notes, images, documents

    @discardableResult
    public func createNote(_ projectId: String, name: String? = nil, workspaceId: String? = nil) async throws -> NoteInfo {
        let out = try Documents.createNote(try await context(), try StoreArgs.str(projectId, "project id", 64), name: try StoreArgs.optStr(name, "name"), workspaceId: try StoreArgs.optStr(workspaceId, "workspace id", 64))
        projectChanged(projectId); libraryChanged()
        return out
    }

    @discardableResult
    public func saveImage(_ projectId: String, bytes: Data, mime: String, name: String? = nil) async throws -> LibraryRow {
        let out = try Documents.saveImage(try await context(), try StoreArgs.str(projectId, "project id", 64), bytes: bytes, mime: try StoreArgs.str(mime, "mime", 64), name: try StoreArgs.optStr(name, "name"))
        libraryChanged()
        return out
    }

    public func readImage(_ id: String) async throws -> Documents.ImageBytes { try Documents.readImage(try await context(), try StoreArgs.str(id, "image id", 64)) }

    @discardableResult
    public func renameNote(_ projectId: String, _ id: String, _ name: String) async throws -> NoteInfo {
        let out = try Documents.renameNote(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(id, "note id", 64), try StoreArgs.str(name, "name"))
        projectChanged(projectId); libraryChanged()
        return out
    }

    public func readDoc(_ projectId: String, _ ref: DocRef) async throws -> String { try Documents.readDoc(try await context(), try StoreArgs.str(projectId, "project id", 64), ref) }

    public struct Saved: Codable, Equatable, Sendable { public var lastEdited: String?; public var revision: Int
        public func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(lastEdited, forKey: .lastEdited); try c.encode(revision, forKey: .revision) }
        enum CodingKeys: String, CodingKey { case lastEdited, revision } }

    private func lane(_ id: String) -> SerialLane { lock.withLock { if let l = docLanes[id] { return l }; let l = SerialLane(); docLanes[id] = l; return l } }
    private func revised(_ projectId: String, _ key: String, _ text: String) -> Int {
        let revision: Int = lock.withLock { let next = (revisions["\(projectId) \(key)"] ?? 0) + 1; revisions["\(projectId) \(key)"] = next; return next }
        events.post("doc:changed", ["projectId": .string(projectId), "key": .string(key), "text": .string(text), "revision": .number(Double(revision))])
        return revision
    }
    private func revision(_ projectId: String, _ key: String) -> Int { lock.withLock { revisions["\(projectId) \(key)"] ?? 0 } }

    /// A document's saves, whichever window makes them, one at a time: each that changes its text counts up its revision
    /// and is posted as `doc:changed { projectId, key, text, revision }`; a save that changes nothing posts nothing.
    @discardableResult
    public func writeDoc(_ projectId: String, _ ref: DocRef, _ text: String) async throws -> Saved {
        let pid = try StoreArgs.str(projectId, "project id", 64)
        let key = ref.key
        return try await lane("\(pid) \(key)").run { [self] in
            let edited = try Documents.writeDoc(try await context(), pid, ref, text)
            return Saved(lastEdited: edited, revision: edited != nil ? revised(pid, key, text) : revision(pid, key))
        }
    }

    // MARK: Clear / Archived (B21-B22)

    private func keepOpenBuilds(_ ctx: StoreContext, _ projectId: String) -> @Sendable (String) -> Bool {
        let open = hooks.openBuildIds?(ctx, projectId) ?? []
        return { line in
            guard let m = RX.match(line.trimmingCharacters(in: .whitespacesAndNewlines), "^build> ([a-z0-9]{6,32})$"), let id = m[1] else { return false }
            return open.contains(id)
        }
    }

    private func rewrite(_ projectId: String, _ workspaceId: String, _ change: @escaping @Sendable (StoreContext, String, String) throws -> Archive.Cleared) async throws -> Archive.Cleared {
        let pid = try StoreArgs.str(projectId, "project id", 64), wid = try StoreArgs.str(workspaceId, "workspace id", 64)
        let key = "ws:\(wid)"
        return try await lane("\(pid) \(key)").run { [self] in
            let ctx = try await context()
            let before = try Documents.readDoc(ctx, pid, .workspace(workspaceId: wid))
            var out = try change(ctx, pid, wid)
            out.revision = out.text != before ? revised(pid, key, out.text) : revision(pid, key)
            projectChanged(pid) // its archived versions and links
            return out
        }
    }

    /// Clear: the document archived and started blank, keeping the lines of Builds still open.
    @discardableResult
    public func clearWorkspace(_ projectId: String, _ workspaceId: String) async throws -> Archive.Cleared {
        try await rewrite(projectId, workspaceId) { [self] ctx, pid, wid in try Archive.clearWorkspace(ctx, pid, wid, keep: keepOpenBuilds(ctx, pid)) }
    }

    /// Restore: an archived version back, the current one archived first.
    @discardableResult
    public func restoreArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> Archive.Cleared {
        let stamp = try StoreArgs.str(file, "archive", 64)
        return try await rewrite(projectId, workspaceId) { [self] ctx, pid, wid in try Archive.restoreArchive(ctx, pid, wid, stamp, keep: keepOpenBuilds(ctx, pid)) }
    }

    public func readArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> (path: String, text: String) {
        let got = try Archive.readArchive(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(workspaceId, "workspace id", 64), try StoreArgs.str(file, "archive", 64))
        return (got.path, got.text)
    }

    // MARK: typed paths

    public func resolvePageFile(_ projectId: String, _ input: String) async throws -> Documents.PageFile? {
        try Documents.resolvePageFile(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(input, "path", 4096))
    }
    public func readTextFile(_ projectId: String, _ input: String) async throws -> Documents.TextFile {
        try Documents.readProjectTextFile(try await context(), try StoreArgs.str(projectId, "project id", 64), try StoreArgs.str(input, "path", 4096))
    }

    // MARK: library

    public func library() async throws -> [LibraryRow] { try Library.listLibrary(try await context()) }
    public func projectsForLibraryItem(_ id: String) async throws -> [Library.Holder] { try Library.projectsForLibraryItem(try await context(), try StoreArgs.str(id, "library id", 64)) }
    public func libraryForProject(_ projectId: String) async throws -> [Library.HeldRow] { try Library.libraryForProject(try await context(), try StoreArgs.str(projectId, "project id", 64)) }
    /// nil: the whole library's (the all-projects screen).
    public func libraryBodies(_ projectId: String?) async throws -> Library.Bodies {
        let ctx = try await context()
        return try projectId.map { try Library.bodiesForProject(ctx, try StoreArgs.str($0, "project id", 64)) } ?? Library.bodiesForLibrary(ctx)
    }

    var addHooks: Library.AddHooks { Library.AddHooks(describe: hooks.describe, identifyRepo: hooks.identifyRepo, inspectPdf: inspectPdf) }

    /// A row just added: a pdf is read for search now; a page that may be a pdf is checked now; a GitHub repository added
    /// by its address starts its sandbox (a failure answers as `sandbox_error`, the row kept).
    public struct Added: Sendable { public var row: LibraryRow; public var sandboxError: String? }

    private func added(_ ctx: StoreContext, _ row: LibraryRow, _ value: String) async -> Added {
        if row.type == "pdf" { hooks.pdfAdded?() }
        if WebPdfs.candidate(row) != nil { recheck(ctx) }
        if let start = hooks.startSandbox, row.hasTag("git"), RX.test(value.trimmingCharacters(in: .whitespacesAndNewlines), #"^(?:(?:https?://)?(?:www\.)?github\.com/|git@github\.com:)"#, ci: true) {
            do { try await start(ctx, row.id) } catch { return Added(row: row, sandboxError: error.localizedDescription) }
        }
        return Added(row: row, sandboxError: nil)
    }

    /// + Add: a new row, or "Already in the library as …" (code EXISTS). `name` names it (the Browser's Save card).
    @discardableResult
    public func addLibraryItem(_ input: String, name: String? = nil) async throws -> Added {
        let value = try StoreArgs.str(input, "link or path", 4096)
        let given = try StoreArgs.optStr(name, "name", 200)
        let out = try await queued { [self] in
            let ctx = try await context()
            return await added(ctx, try await Library.addItem(ctx, value, hooks: addHooks, name: given), value)
        }
        libraryChanged()
        return out
    }

    /// Bytes dropped with no path (a picture or a pdf from a browser), kept as a copy.
    @discardableResult
    public func addLibraryFile(_ bytes: Data, mime: String, name: String? = nil, url: String? = nil) async throws -> LibraryRow {
        let ctx = try await context()
        let row = try await Library.addFileCopy(ctx, bytes: bytes, mime: try StoreArgs.str(mime, "mime", 128), name: try StoreArgs.optStr(name, "name"), url: try StoreArgs.optStr(url, "address", 8192), inspectPdf: inspectPdf)
        if row.type == "pdf" { hooks.pdfAdded?() }
        libraryChanged()
        return row
    }

    /// A dropped link, read here.
    @discardableResult
    public func addLibraryUrl(_ input: String) async throws -> Added {
        let value = try StoreArgs.str(input, "link", 8192)
        let fetch = hooks.fetchUrl
        let out = try await queued { [self] in
            let ctx = try await context()
            return await added(ctx, try await Library.addFromUrl(ctx, value, fetch: fetch, hooks: addHooks), value)
        }
        libraryChanged()
        return out
    }

    /// A pdf read from the web, saved as a copy with its address.
    @discardableResult
    public func addLibraryPdf(_ input: String, bytes: Data, name: String? = nil) async throws -> LibraryRow {
        let row = try await Library.addPdfCopy(try await context(), try StoreArgs.str(input, "address", 8192), bytes: bytes, inspectPdf: inspectPdf, name: try StoreArgs.optStr(name, "name", 200))
        hooks.pdfAdded?()
        libraryChanged()
        return row
    }

    /// A page from the web, saved as a copy: what the Stage tab `tabId` shows (hooks.savePage).
    @discardableResult
    public func addLibraryPage(_ tabId: String, _ input: String, name: String? = nil) async throws -> LibraryRow {
        guard let savePage = hooks.savePage else { throw StoreError("Pages cannot be saved here") }
        let tab = try StoreArgs.str(tabId, "tab id", 128)
        let row = try await Library.addPageCopy(try await context(), try StoreArgs.str(input, "address", 8192), save: { dir in try await savePage(tab, dir) }, name: try StoreArgs.optStr(name, "name", 200))
        libraryChanged()
        return row
    }

    public func lookupLibraryItem(_ input: String) async throws -> Library.Lookup { try Library.lookupItem(try await context(), try StoreArgs.str(input, "link or path", 4096)) }

    /// "Choose from disk…": the native picker ('pdf' or 'any'), several at once. ENGELBART_PICK_PATHS (JSON) for the driver.
    public func pickLibraryPaths(_ kind: String) async -> [String] {
        let which = kind == "pdf" ? "pdf" : "any"
        if let fake = ProcessInfo.processInfo.environment["ENGELBART_PICK_PATHS"], let list = (try? JSONValue.parse(fake))?.array { return list.compactMap(\.string) }
        if let pick = hooks.pickPaths { return await pick(which) }
        #if canImport(AppKit)
        return await MainActor.run {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = true
            panel.canChooseFiles = true
            panel.canChooseDirectories = which != "pdf"
            if which == "pdf" { panel.allowedContentTypes = [.pdf] }
            return panel.runModal() == .OK ? panel.urls.map(\.path) : []
        }
        #else
        return []
        #endif
    }

    public func previewLibraryItem(_ id: String) async throws -> Library.Preview {
        try await Library.previewItem(try await context(), try StoreArgs.str(id, "library id", 64), listRemoteFiles: hooks.listRemoteFiles)
    }

    public func listFolder(_ id: String, _ rel: String? = nil) async throws -> FolderFiles.Level {
        try FolderFiles.listFolder(try await context(), try StoreArgs.str(id, "library id", 64), try rel.map { try StoreArgs.str($0, "path", 4096) } ?? "")
    }
    public func folderFile(_ id: String, _ rel: String) async throws -> FolderFiles.File {
        try FolderFiles.folderFile(try await context(), try StoreArgs.str(id, "library id", 64), try StoreArgs.str(rel, "path", 4096))
    }
    public func folderFiles(_ list: [(folderId: String?, rel: String?)]) async throws -> [FolderFiles.Seen] { FolderFiles.folderFiles(try await context(), list) }

    /// A note made in a project is renamed as a note (its file follows); any other row by its name only.
    @discardableResult
    public func renameLibraryItem(_ id: String, _ name: String) async throws -> LibraryRow? {
        let ctx = try await context()
        guard let row = try ctx.libraryDb.get(try StoreArgs.str(id, "library id", 64)) else { throw StoreError("Unknown library item") }
        let out: LibraryRow?
        if row.hasTag("note"), let project = row.projectId {
            let note = try Documents.renameNote(ctx, project, row.id, try StoreArgs.str(name, "name"))
            out = try ctx.libraryDb.get(note.id)
        } else {
            out = try ctx.libraryDb.rename(row.id, try StoreArgs.str(name, "name"))
        }
        projectChanged(out?.projectId)
        libraryChanged()
        return out
    }

    public func readLibraryFile(_ id: String) async throws -> Library.FileBytes { try Library.readLibraryFile(try await context(), try StoreArgs.str(id, "library id", 64)) }
    public func readAnnotations(_ id: String) async throws -> JSONValue? { try Library.readAnnotations(try await context(), try StoreArgs.str(id, "library id", 64)) }
    @discardableResult public func writeAnnotations(_ id: String, _ value: JSONValue) async throws -> Bool { try Library.writeAnnotations(try await context(), try StoreArgs.str(id, "library id", 64), value) }
    public func readPageAnnotations(_ input: String) async throws -> JSONValue? { try Library.readPageAnnotations(try await context(), try StoreArgs.str(input, "address", 8192)) }
    @discardableResult public func writePageAnnotations(_ input: String, _ value: JSONValue) async throws -> Bool { try Library.writePageAnnotations(try await context(), try StoreArgs.str(input, "address", 8192), value) }
}
