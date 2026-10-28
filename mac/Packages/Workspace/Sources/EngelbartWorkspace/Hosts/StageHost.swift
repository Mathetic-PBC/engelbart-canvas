import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartStage
import EngelbartPDF
import EngelbartEditor
import EngelbartSandbox

/// The Stage's side of the workspace (workspace/RightPane.jsx's props to <Stage>): the library, the project's Stage tabs
/// in state.json, files and ink through the API, the pdf viewer (PDF's PaperView), @bart from a highlight, and what the
/// Stage tells the screen (the page in front for Save, the row in front for the sidebar, every tab's place).
@MainActor
final class WorkspaceStageHost: StageHost {
    unowned let model: WorkspaceModel
    var keysToDocNow: () -> Bool = { false }
    var makePaper: () -> PaperViewController = { PaperViewController() }
    lazy var touch: SandboxTouch? = model.ctx.touchSandbox.map { t in SandboxTouch(touch: t) }

    init(model: WorkspaceModel) { self.model = model }

    var projectId: String { model.projectId }
    var projectDirectory: String? { model.project.directory }
    func library() -> [StageRow] { model.library.map(WorkspaceModel.stageRow) }
    func inRail(_ id: String) -> Bool { model.inRail(id) }
    func lookupLibraryItem(_ input: String) async -> StageLookup {
        guard let found = try? await model.api.lookupLibraryItem(input) else { return StageLookup() }
        return StageLookup(row: found.row.map(WorkspaceModel.stageRow), type: found.type, tags: found.tags)
    }
    func readStageFile(_ input: String) async throws -> StageFile { try await model.api.readStageFile(model.projectId, input) }
    func readLibraryFile(_ rowId: String) async throws -> Data { try await model.api.readLibraryFile(rowId) }
    func readAnnotations(rowId: String) async -> JSONValue? { (try? await model.api.readAnnotations(rowId)) ?? nil }
    func readPageAnnotations(url: String) async -> JSONValue? { (try? await model.api.readPageAnnotations(url)) ?? nil }
    func writeAnnotations(rowId: String, _ marks: JSONValue) async throws { try await model.api.writeAnnotations(rowId, marks) }
    func writePageAnnotations(url: String, _ marks: JSONValue) async throws { try await model.api.writePageAnnotations(url, marks) }
    func stage() async -> StageSnapshot? { await model.api.stage(model.projectId).map { StageSnapshot(json: $0) } }
    func setStage(_ snapshot: StageSnapshot) { let api = model.api, pid = model.projectId, json = snapshot.json; Task { await api.setStage(pid, json) } }
    func pickPaths() async throws -> [String] { await model.api.pickLibraryPaths() }
    func openExternal(_ url: String) { model.api.openExternal(url) }

    func makePDFView(_ request: StagePDFRequest) -> StagePDFViewing { makePaperView(PaperRequest(request)) }
    func makePaperView(_ request: PaperRequest) -> StagePDFViewing {
        let adapter = PaperAdapter(model: model, request: request, paper: makePaper())
        adapter.load()
        papers = papers.filter { $0.value != nil } + [WeakPaper(value: adapter)]
        return adapter
    }

    struct WeakPaper { weak var value: PaperAdapter? }
    var papers: [WeakPaper] = []
    /// The paper asks running now, to every pdf view that shows their pdf (the Stage hands a viewer its asks only when it
    /// is made).
    func pushPending(_ list: [JSONValue]) {
        for p in papers.compactMap(\.value) {
            let mine = list.filter { a in
                if let rowId = p.request.rowId { return a["rowId"]?.string == rowId }
                return a["rowId"]?.string == nil && a["url"]?.string == p.request.url
            }
            p.setPending(mine)
        }
    }

    /// @bart from a highlight on a pdf (MATH-27) or a box's card on a web page (MATH-70).
    func ask(_ ask: StageAsk) async -> JSONValue? {
        await model.askHighlight(markId: ask.markId, page: ask.page, quote: ask.quote, note: ask.note, question: ask.question, turns: ask.turns,
                                 rowId: ask.rowId, url: ask.url, paper: ask.paper.isEmpty ? nil : ask.paper, pageText: ask.pageText, source: ask.source)
    }
    func stopAsk(_ askId: String) { let api = model.api; Task { @MainActor [weak model] in do { try await api.stopBart(askId) } catch { model?.report(error) } } }
    func dismissAsk(_ askId: String) { model.dropPaperAsk(askId) }
    func openMention(_ row: StageRow) { if let held = model.library.first(where: { $0.id == row.id }) { model.openItem(held) } }
    func openCited(_ href: String) -> Bool { model.openIfCited(href) }
    func stagePageChanged(_ page: StagePage?) { model.setOpenPage(page.map(OpenPage.init)) }
    func stageFrontChanged(_ rowId: String?) {
        if model.stageFront != rowId { model.stageFront = rowId; model.noteOpen(rowId); model.changed() }
    }
    func stageTabsChanged(_ places: [String]) { if model.stagePlaces != places { model.stagePlaces = places; model.changed() } }
    func showStage() { model.showRight("stage") }
    func keysToDoc() -> Bool { keysToDocNow() }

    /// A sandbox preview behind an address (its repository's row).
    func previewRow(for url: String) -> StageRow? {
        guard let s = model.ctx.sandboxes, let id = SandboxNotifications.previewLibraryId(s.items, url), let row = model.library.first(where: { $0.id == id }) else { return nil }
        return WorkspaceModel.stageRow(row)
    }
    func openBuildDetails(_ row: StageRow, from view: NSView) {
        if let held = model.library.first(where: { $0.id == row.id }) { model.ctx.sandboxes?.openBuild(held.json) }
    }
    /// The page keeps a live preview awake while it shows (usePreviewTouch).
    func previewTouch(_ url: String, visible: Bool) {
        guard let touch, let s = model.ctx.sandboxes else { return }
        touch.updatePreview(url: url, showing: visible, items: s.items, focused: model.windowIsKey())
    }
}

/// A pdf on the Stage: the PDF package's PaperView behind the Stage's StagePDFViewing, its PaperHost answering through the
/// Stage's request (ink, finds, the place read to, asks) and the workspace (mentions, links, Continue in project).
@MainActor
final class PaperAdapter: StagePDFViewing, @preconcurrency PaperHost {
    unowned let model: WorkspaceModel
    let request: PaperRequest
    let paper: PaperViewController

    init(model: WorkspaceModel, request: PaperRequest, paper: PaperViewController) {
        self.model = model; self.request = request; self.paper = paper
        paper.host = self
    }

    func load() {
        let state = request.viewState.flatMap { v -> PaperViewState? in
            guard let z = v["zoom"]?.double else { return nil }
            return PaperViewState(zoom: z, at: v["at"]?.double ?? 0, left: v["left"]?.double ?? 0)
        }
        paper.load(data: request.bytes, marks: AnnotationJSON.decode(request.marks), view: state, target: request.target, targetTo: request.targetTo,
                   targetPage: request.targetPage, initialSection: request.initialSection)
        paper.pendingAsks = Self.pending(request.pendingAsks)
    }

    /// The Stage's paper asks for this pdf, as the viewer draws them.
    static func pending(_ list: [JSONValue]) -> [PendingAsk] {
        list.compactMap { a in
            guard let askId = a["askId"]?.string, let markId = a["markId"]?.string else { return nil }
            return PendingAsk(askId: askId, markId: markId, page: a["page"]?.int ?? 0, question: a["question"]?.string ?? "", activity: a["activity"]?.string,
                              movedUp: a["movedUp"]?.bool ?? false, name: a["name"]?.string, effort: a["effort"]?.string,
                              lines: a["lines"]?.array?.compactMap(\.string) ?? [], log: a["log"]?.array?.compactMap(\.string) ?? [], error: a["error"]?.string)
        }
    }

    // StagePDFViewing
    var view: NSView { paper.view }
    func find(_ text: String, step: Int, fromStart: Bool) -> (matches: Int, active: Int)? {
        if text.isEmpty { paper.stopFind(); return nil }
        return paper.find(text, step: step, fromStart: fromStart)
    }
    func stopFind() { paper.stopFind() }
    func showSection(find: String, to: String) { _ = paper.showSection(find, to: to) }
    func clearSection() { paper.clearSection() }
    /// The page in view: PaperViewController does not say it publicly yet, so 0 ("unknown") — API.md, Needs.
    func currentPage() -> Int { 0 }
    func addAsk(page: Int, markId: String, entry: JSONValue) {
        // the entry as the ink file keeps it, read back as the viewer's AskEntry
        let wrapped: JSONValue = .object([String(page): .array([.object(["id": .string(markId), "asks": .array([entry])])])])
        if let e = AnnotationJSON.decode(wrapped).pages[page]?.first?.asks?.first { _ = paper.addAsk(page: page, markId: markId, entry: e) }
    }
    func setPending(_ list: [JSONValue]) { paper.pendingAsks = Self.pending(list) }

    // PaperHost
    func paperMarksChanged(_ marks: PaperMarks, json: String) { if let v = try? JSONValue.parse(json) { request.onMarksChange(v) } }
    func paperReadAnnotations() -> PaperMarks? { AnnotationJSON.decode(request.marks) }
    var paperCanAsk: Bool { request.canAsk && model.topic != nil }
    /// The Stage's askFromPaper, done here (StageAsk cannot be made outside the Stage): asked of this workspace with the
    /// pdf's row or address and name, and the finished answer landed on every tab holding the pdf.
    func paperAsk(_ ask: PaperAsk) {
        let turns: [JSONValue] = ask.turns.map { ["question": .string($0.question), "answer": .string($0.answer)] }
        let rowId = request.rowId, url = request.rowId == nil ? request.url : nil
        Task { @MainActor in
            guard let entry = await model.askHighlight(markId: ask.markId, page: ask.page, quote: ask.quote, note: ask.note, question: ask.question, turns: turns,
                                                       rowId: rowId, url: url, paper: request.name, pageText: ask.pageText, source: nil) else { return }
            if let stage = model.stage { stage.landAnswer(rowId: rowId, url: url, page: ask.page, markId: ask.markId, entry: entry) }
            else { addAsk(page: ask.page, markId: ask.markId, entry: entry) }
        }
    }
    func paperStopAsk(_ askId: String) { let api = model.api; Task { try? await api.stopBart(askId) } }
    func paperDismissAsk(_ askId: String) { model.dropPaperAsk(askId) }
    var paperCanContinue: Bool { model.topic != nil }
    /// Continue in project: the passage, the question and the answer at the end of this workspace's document.
    func paperContinue(_ c: PaperContinue) {
        let lines = Canvas.continueLines(quote: c.quote, question: c.question, answer: c.answer, foot: c.foot,
                                         paper: Canvas.PaperRef(name: request.name, rowId: request.rowId, url: request.rowId == nil ? request.url : nil), page: c.page)
        Task { @MainActor in await model.continueAsk(lines: lines, paperRowId: request.rowId) }
    }
    var paperCanCopy: Bool { true }
    func paperCopy(_ text: String) { model.api.copyText(text) }
    func paperOpenLink(_ href: String) { request.onOpenLink(href) }
    var paperOpensMentions: Bool { true }
    func paperOpenMention(_ id: String) { if let row = model.library.first(where: { $0.id == id }) { model.openItem(row) } }
    func paperOpenFile(folderId: String, rel: String, name: String) { Task { @MainActor in await model.openFolderFile(folderId: folderId, rel: rel, name: name) } }
    func paperLibraryName(_ id: String) -> String?? {
        if let row = model.library.first(where: { $0.id == id }) { return .some(row.name) }
        return model.library.isEmpty ? nil : .some(nil)
    }
    func paperCitationSource(_ address: String) -> String? { StageModel.paperRow(model.library.map(WorkspaceModel.stageRow), address)?.name }
    func paperFileState(folderId: String, rel: String) -> PaperFileState? { model.missingFiles.contains("\(folderId):\(rel)") ? .missing : nil }
    /// A note's @ menu: Bart, then the library rows the document's menu would offer.
    func paperMentionItems(_ query: String) -> [MentionRow]? {
        model.mentionItems(query).compactMap { m in
            if m.kind == .verb { return m.id == "bart" ? MentionRow.bart : nil }
            guard m.kind == .item, let row = m.row else { return nil }
            return MentionRow.item(id: row.id, name: m.name, browsable: row.id == "zotero" || (row.type == "folder" && !(row.folderPath ?? "").isEmpty), zotero: row.id == "zotero", type: row.type)
        }
    }
    func paperListFolder(_ folderId: String, rel: String, done: @escaping (EngelbartPDF.FolderListing) -> Void) -> Bool {
        Task { @MainActor in
            let json = await model.listFolder(folderId, rel: rel)
            let entries = (json["entries"]?.array ?? []).map { EngelbartPDF.FolderListing.Entry(name: $0["name"]?.string ?? "", rel: $0["rel"]?.string ?? "", dir: $0["dir"]?.bool ?? false, type: $0["type"]?.string) }
            done(EngelbartPDF.FolderListing(entries: entries, total: json["total"]?.int ?? entries.count, missing: json["missing"]?.bool ?? false, error: json["error"]?.string))
        }
        return true
    }
    func paperMentionMenu(open: Bool) { model.setMentionOpen(open) }
    func paperView(_ state: PaperViewState) {
        request.onView(["zoom": .number(state.zoom), "at": .number(state.at), "left": .number(state.left)])
    }
    func paperFound(matches: Int, active: Int) { request.onFind((matches, active)) }
    func paperTarget(_ text: String, matches: Int, active: Int) { request.onTarget(text, (matches, active)) }
    func paperError(_ message: String) { model.report(message) }
}
