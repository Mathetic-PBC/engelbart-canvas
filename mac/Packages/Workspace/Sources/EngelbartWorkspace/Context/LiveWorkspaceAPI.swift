import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartStage
import EngelbartBart
import EngelbartBuild
import EngelbartIntegrations

/// The wave-1 services behind the screen's API, as the app has them. The Store, Bart's IPC and Build's service answer
/// most calls directly; what has no single owner (Copy's expansion, @create's files, sandboxes, Connect, the Agent
/// Viewer's reveal, post-its) is a closure the app fills.
public struct LiveServices {
    public var store: Store
    public var bart: BartIPC?
    public var build: BuildService?
    public var zotero: ZoteroChannels?
    /// This window's id (Bart keeps a highlight's ask per window: running-paper-asks).
    public var window: String
    /// copy-doc: the document with every mention's content in place, on the clipboard (Bart's expandDoc + the clipboard).
    /// Nil: the document's own text is copied.
    public var copyDoc: ((_ projectId: String, _ ref: JSONValue) async throws -> (files: Int, missing: Int))?
    /// created-file / created-save (bart/create.cjs readCreated / saveCreated, with the app's CreatedLibrary).
    public var createdFile: ((_ projectId: String, _ askId: String, _ rel: String) async throws -> JSONValue)?
    public var saveCreated: ((_ projectId: String, _ askId: String, _ rel: String, _ workspaceId: String?) async throws -> LibraryRow)?
    public var startSandbox: ((_ libraryId: String) async throws -> Void)?
    public var connectDismiss: ((_ sessionId: String) async -> Void)?
    public var takeAgentReveal: ((_ projectId: String) async -> JSONValue?)?
    public var postItsTrashRect: ((CGRect?) -> Void)?
    public var postItsThrowOut: ((_ projectId: String, _ postItId: String) async throws -> Void)?
    public var openExternal: (String) -> Void = { if let u = URL(string: $0), ["http", "https"].contains(u.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(u) } }
    public var copyText: (String) -> Void = { NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string) }

    public init(store: Store, bart: BartIPC? = nil, build: BuildService? = nil, zotero: ZoteroChannels? = nil, window: String = "main") {
        self.store = store; self.bart = bart; self.build = build; self.zotero = zotero; self.window = window
    }
}

/// `WorkspaceAPI` over the app's services (ipc.cjs's handlers as the Swift packages have them).
@MainActor
public final class LiveWorkspaceAPI: @preconcurrency WorkspaceAPI {
    public var services: LiveServices
    var store: Store { services.store }
    public init(_ services: LiveServices) { self.services = services }

    static func missing(_ what: String) -> WorkspaceError { WorkspaceError("\(what) is not available") }
    static func json<T: Encodable>(_ v: T) -> JSONValue { JSONValue.encode(v) }

    // documents
    public func readDoc(_ projectId: String, _ ref: StoreDocRef) async throws -> String { try await store.readDoc(projectId, ref) }
    public func writeDoc(_ projectId: String, _ ref: StoreDocRef, _ text: String) async throws -> Double? { Double(try await store.writeDoc(projectId, ref, text).revision) }
    public func readArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> String { try await store.readArchive(projectId, workspaceId, file).text }
    public func clearWorkspace(_ projectId: String, _ workspaceId: String) async throws -> (text: String, revision: Double?) {
        let out = try await store.clearWorkspace(projectId, workspaceId)
        return (out.text, out.revision.map(Double.init))
    }
    public func restoreArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> (text: String, revision: Double?) {
        let out = try await store.restoreArchive(projectId, workspaceId, file)
        return (out.text, out.revision.map(Double.init))
    }
    public func copyDoc(_ projectId: String, _ ref: PaneRef) async throws -> (files: Int, missing: Int) {
        if let copy = services.copyDoc { return try await copy(projectId, ref.json) }
        let text: String
        if case .archive(let w, let f) = ref { text = try await store.readArchive(projectId, w, f).text } else { text = try await store.readDoc(projectId, ref.store!) }
        services.copyText(text)
        return (0, 0)
    }
    public func readImage(_ id: String) async throws -> (data: Data, mime: String) { let f = try await store.readImage(id); return (f.bytes, f.mime) }
    public func saveImage(_ projectId: String, data: Data, mime: String, name: String?) async throws -> LibraryRow { try await store.saveImage(projectId, bytes: data, mime: mime, name: name) }

    // state.json
    public func setView(_ projectId: String, _ workspaceId: String, _ view: JSONValue) async { _ = try? await store.setView(projectId, workspaceId, view) }
    public func recordEdit(_ projectId: String, _ workspaceId: String) async { _ = try? await store.recordEdit(projectId, workspaceId) }
    public func nav() async throws -> NavState { NavState(json: try await store.nav()) }
    public func seenAgents(_ projectId: String, _ workspaceId: String) async { _ = try? await store.seenAgents(projectId, workspaceId) }
    public func starred(_ projectId: String) async throws -> [String] { try await store.starred(projectId) }
    public func setStarred(_ projectId: String, _ itemId: String, _ on: Bool) async throws -> [String] { try await store.setStarred(projectId, itemId, on) }
    public func folders() async throws -> [JSONValue] { try await store.folders().map(Self.json) }
    public func addToFolder(_ folderId: String, _ ids: [String]) async throws -> [JSONValue] { try await store.addToFolder(folderId, ids).map(Self.json) }
    public func removeFromFolder(_ folderId: String, _ id: String) async throws -> [JSONValue] { try await store.removeFromFolder(folderId, id).map(Self.json) }
    public func createFolder(_ name: String) async throws -> [JSONValue] { try await store.createFolder(name).folders.map(Self.json) }
    public func renameFolder(_ folderId: String, _ name: String) async throws -> [JSONValue] { try await store.renameFolder(folderId, name).map(Self.json) }
    public func deleteFolder(_ folderId: String) async throws -> [JSONValue] { try await store.deleteFolder(folderId).map(Self.json) }
    public func gettingStarted(_ projectId: String) async throws -> JSONValue? { try await store.gettingStarted(projectId).map(Self.json) }
    public func setGettingStarted(_ projectId: String, tick: [Int], untick: [Int], hidden: Bool) async throws -> JSONValue? {
        Self.json(try await store.setGettingStarted(projectId, tick: tick, untick: untick, hidden: hidden))
    }

    // the tree
    public func createWorkspace(_ projectId: String, name: String, parentId: String?) async throws -> String { try await store.createWorkspace(projectId, name: name, parentId: parentId).id }
    public func renameWorkspace(_ projectId: String, _ workspaceId: String, _ name: String) async throws { _ = try await store.renameWorkspace(projectId, workspaceId, name) }
    public func trashWorkspace(_ projectId: String, _ workspaceId: String) async throws { _ = try await store.trashWorkspace(projectId, workspaceId) }
    public func restoreWorkspace(_ projectId: String, _ workspaceId: String) async throws { _ = try await store.restoreWorkspace(projectId, workspaceId) }
    public func renameProject(_ projectId: String, _ name: String) async throws { _ = try await store.renameProject(projectId, name) }
    public func createNote(_ projectId: String, name: String, workspaceId: String?) async throws -> NoteInfo { try await store.createNote(projectId, name: name, workspaceId: workspaceId) }
    public func renameNote(_ projectId: String, _ id: String, _ name: String) async throws -> String { try await store.renameNote(projectId, id, name).name }
    public func linkToWorkspace(_ projectId: String, _ workspaceId: String, _ ids: [String], picked: Bool) async throws -> String? {
        try await store.linkToWorkspace(projectId, workspaceId, ids, picked: picked).sandboxError
    }
    public func unlinkFromWorkspace(_ projectId: String, _ workspaceId: String, _ id: String, unmentioned: Bool) async throws {
        _ = try await store.unlinkFromWorkspace(projectId, workspaceId, id, unmentioned: unmentioned)
    }

    // the library
    public func library() async throws -> [LibraryRow] { try await store.library() }
    public func addLibraryItem(_ input: String, name: String?) async throws -> (row: LibraryRow, sandboxError: String?) {
        let a = try await store.addLibraryItem(input, name: name); return (a.row, a.sandboxError)
    }
    public func addLibraryFile(_ data: Data, mime: String, name: String?) async throws -> LibraryRow { try await store.addLibraryFile(data, mime: mime, name: name) }
    public func addLibraryUrl(_ input: String) async throws -> (row: LibraryRow, sandboxError: String?) { let a = try await store.addLibraryUrl(input); return (a.row, a.sandboxError) }
    public func addLibraryPdf(_ input: String, bytes: Data, name: String?) async throws -> LibraryRow { try await store.addLibraryPdf(input, bytes: bytes, name: name) }
    public func addLibraryPage(_ tabId: String, _ input: String, name: String?) async throws -> LibraryRow { try await store.addLibraryPage(tabId, input, name: name) }
    public func lookupLibraryItem(_ input: String) async throws -> LibraryLookup {
        let l = try await store.lookupLibraryItem(input)
        return LibraryLookup(row: l.row, type: l.found?.type, tags: l.found?.tags, error: l.error)
    }
    public func renameLibraryItem(_ id: String, _ name: String) async throws -> LibraryRow? { try await store.renameLibraryItem(id, name) }
    public func pickLibraryPaths() async -> [String] { await store.pickLibraryPaths("any") }
    public func listFolder(_ id: String, _ rel: String) async throws -> JSONValue { Self.json(try await store.listFolder(id, rel.isEmpty ? nil : rel)) }
    public func folderFile(_ folderId: String, _ rel: String) async throws -> (exists: Bool, path: String?, folder: String?) {
        let f = try await store.folderFile(folderId, rel); return (f.exists, f.path, f.folder)
    }
    public func libraryBodies(_ projectId: String) async throws -> MentionRows.Bodies {
        let b = try await store.libraryBodies(projectId); return MentionRows.Bodies(items: b.items, workspaces: b.workspaces)
    }
    public func readLibraryFile(_ id: String) async throws -> Data { try await store.readLibraryFile(id).bytes }
    public func readAnnotations(_ id: String) async throws -> JSONValue? { try await store.readAnnotations(id) }
    public func writeAnnotations(_ id: String, _ value: JSONValue) async throws { _ = try await store.writeAnnotations(id, value) }
    public func readPageAnnotations(_ url: String) async throws -> JSONValue? { try await store.readPageAnnotations(url) }
    public func writePageAnnotations(_ url: String, _ value: JSONValue) async throws { _ = try await store.writePageAnnotations(url, value) }
    /// stage-file: resolved inside home as projects.cjs resolveTypedPath, read into <data root>/.cache/stage.
    public func readStageFile(_ projectId: String, _ input: String) async throws -> StageFile {
        let ctx = try await store.context()
        let project = try Projects.find(ctx, projectId)
        let path = try Documents.resolveTypedPath(ctx, project, input)
        return try await StageFiles.readStageFile(path, cacheDir: URL(fileURLWithPath: ctx.dataRoot).appendingPathComponent(".cache/stage"))
    }
    public func stage(_ projectId: String) async -> JSONValue? { try? await store.stage(projectId) }
    public func setStage(_ projectId: String, _ value: JSONValue) async { _ = try? await store.setStage(projectId, value) }

    // @bart
    func bartIPC() throws -> BartIPC { guard let b = services.bart else { throw Self.missing("Bart") }; return b }
    public func bartModels() async throws -> JSONValue { try bartIPC().bartModels().jsonValue }
    public func askBart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue {
        try await bartIPC().askBart(window: services.window, pid: .string(projectId), input: input).jsonValue
    }
    public func runningPaperAsks(_ projectId: String) async throws -> [JSONValue] {
        try bartIPC().runningPaperAsks(window: services.window, pid: .string(projectId)).map(\.jsonValue)
    }
    public func routeLine(_ projectId: String, _ input: JSONValue) async throws -> JSONValue? { try await bartIPC().routeLine(pid: .string(projectId), input: input).jsonValue }
    public func routeHanded(_ routeId: String, _ to: String) async { _ = try? services.bart?.routeHanded(.string(routeId), .string(to)) }
    public func stopBart(_ askId: String) async throws { _ = try bartIPC().stopBart(.string(askId)) }
    public func nameChat(_ input: JSONValue) async throws -> String? { try await bartIPC().nameChat(input).jsonValue["title"]?.string }
    public func createdFile(_ projectId: String, _ askId: String, _ rel: String) async throws -> JSONValue {
        guard let f = services.createdFile else { throw Self.missing("@create's files") }
        return try await f(projectId, askId, rel)
    }
    public func saveCreated(_ projectId: String, _ askId: String, _ rel: String, _ workspaceId: String?) async throws -> LibraryRow {
        guard let f = services.saveCreated else { throw Self.missing("Saving @create's files") }
        return try await f(projectId, askId, rel, workspaceId)
    }

    // Build
    func buildService() throws -> BuildService { guard let b = services.build else { throw Self.missing("Build") }; return b }
    public func buildList(_ projectId: String) async throws -> [JSONValue] { try await buildService().buildList(projectId) }
    public func buildStart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue { try await buildService().buildStart(projectId, input) }
    public func buildReply(_ projectId: String, _ id: String, _ text: String, interrupt: Bool, images: [JSONValue]) async throws {
        _ = try await buildService().buildReply(projectId, id, text, interrupt: interrupt, images: [])
    }
    public func buildStop(_ projectId: String, _ id: String) async throws { _ = try await buildService().buildStop(projectId, id) }
    public func buildResume(_ projectId: String, _ id: String) async throws { _ = try await buildService().buildResume(projectId, id) }
    public func buildFix(_ projectId: String, _ id: String) async throws { _ = try await buildService().buildFix(projectId, id) }
    public func buildDiscard(_ projectId: String, _ id: String) async throws { _ = try await buildService().buildDiscard(projectId, id) }
    public func buildAccept(_ projectId: String, _ id: String) async throws { _ = try await buildService().buildAccept(projectId, id) }
    public func buildReview(_ projectId: String, _ id: String) async throws -> JSONValue { try await buildService().buildReview(projectId, id) }
    public func buildRunShow(_ projectId: String, _ id: String, _ name: String) async throws { _ = try await buildService().buildRunShow(projectId, id, name) }
    public func buildRunStop(_ projectId: String, _ id: String) async throws { _ = try await buildService().buildRunStop(projectId, id) }
    public func buildRunStopRunnable(_ projectId: String, _ id: String, _ name: String?) async throws { _ = try await buildService().buildRunStopRunnable(projectId, id, name) }
    public func buildPromote(_ projectId: String, _ id: String, _ workspaceId: String, choice: JSONValue?) async throws -> JSONValue {
        try await buildService().buildPromote(projectId, id, workspaceId, choice: choice)
    }

    // Zotero
    func zotero() throws -> ZoteroChannels { guard let z = services.zotero else { throw Self.missing("Zotero") }; return z }
    public func zoteroList(_ rel: String) async throws -> JSONValue { try zotero().list(rel.isEmpty ? nil : rel).json }
    public func zoteroOpen(_ key: String) async throws -> JSONValue { try await zotero().open(key).json }
    public func zoteroAttach(_ key: String, _ file: String) async throws -> JSONValue { try zotero().attach(key, file: file) }

    // the rest
    public func openExternal(_ url: String) { services.openExternal(url) }
    public func copyText(_ text: String) { services.copyText(text) }
    public func startSandbox(_ libraryId: String) async throws {
        guard let s = services.startSandbox else { throw Self.missing("Sandboxes") }
        try await s(libraryId)
    }
    public func connectDismiss(_ sessionId: String) async { await services.connectDismiss?(sessionId) }
    public func takeAgentReveal(_ projectId: String) async -> JSONValue? { await services.takeAgentReveal?(projectId) }
    public func postItsTrashRect(_ rect: CGRect?) { services.postItsTrashRect?(rect) }
    public func postItsThrowOut(_ projectId: String, _ postItId: String) async throws { try await services.postItsThrowOut?(projectId, postItId) }
}
