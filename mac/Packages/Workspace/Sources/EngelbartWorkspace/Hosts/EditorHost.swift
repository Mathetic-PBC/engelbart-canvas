import AppKit
import SwiftUI
import EngelbartCore
import EngelbartDoc
import EngelbartUI
import EngelbartEditor
import EngelbartBuild
import EngelbartStage

// What every pane's editor is given (Workspace.jsx `editorProps` + each pane's own onChange/onAsk/onRoute/onBuild): the
// DocEditorHost a DocEditorView talks through. One per pane; the document is the editor's own (its docKey).

extension DocEditorView: EditorHandle {
    public var handleKey: String? { core.docKey.isEmpty ? nil : core.docKey }
    public var handleLines: [String] { core.lines }
    public func handleShowLine(_ i: Int, flash: Bool) -> Bool { showLine(i, flash: flash) }
    public func handleShowPassage(_ i: Int, find: String) -> Bool { showPassage(i, find: find) }
    public func handleDiscoverLastResult(_ askId: String?) -> Bool {
        let ok = core.discoverLastResult(askId)
        if ok { setAsks(core.asks) } // the editor draws its new lines (setAsks redraws)
        return ok
    }
    public func handleAskBoxed(_ askId: String) -> Bool { askBoxed(askId) }
    public func handleStartAgent(_ agent: String) -> Bool { startAgent(agent) }
    public func handleFocusEnd() { focusEnd() }
    public func handleFocusStart() { focusStart() }
    public var handleIsActive: Bool { isActive }
    public func handleShutMenus() -> Bool { shutMenus() }
    public func handleCaretNow() -> (line: Int, a: Int, b: Int)? { caretNow() }
}

/// A pane's editor host. `pane`: 0 the document in front, 1 the one beside it.
@MainActor
final class WorkspaceEditorHost: @preconcurrency DocEditorHost {
    unowned let model: WorkspaceModel
    let pane: Int
    /// The Build cards drawn in this pane's editor, by id (their reply texts live here, so a redraw never loses one).
    var cards: [String: BuildCardHost] = [:]

    init(model: WorkspaceModel, pane: Int) { self.model = model; self.pane = pane }

    /// The pane's document now: by the editor's key, else the pane's.
    func doc(_ editor: DocEditorView) -> PaneDoc {
        let docs = model.paneDocs
        if let d = docs.first(where: { $0.key != nil && $0.key == editor.handleKey }) { return d }
        return pane < docs.count ? docs[pane] : .none
    }
    static func ref(forKey key: String) -> PaneRef? {
        if key == "project" { return .project }
        if key.hasPrefix("ws:") { return .workspace(String(key.dropFirst(3))) }
        if key.hasPrefix("note:") { return .note(String(key.dropFirst(5))) }
        return nil
    }

    // the document
    func docEditor(_ editor: DocEditorView, changed text: String) {
        let d = doc(editor)
        let typed = (editor.window?.firstResponder as? NSView).map { $0.isDescendant(of: editor) } ?? false
        model.onDocChange(key: d.key, ref: d.ref, text: text, typed: typed)
    }
    func docEditor(_ editor: DocEditorView, textOf key: String) -> String? { model.docs[key] }
    func docEditor(_ editor: DocEditorView, change key: String, text: String) {
        guard let ref = Self.ref(forKey: key) else { return }
        model.changeDoc(key, ref, text)
    }

    // mentions
    func docEditorMentionable(_ editor: DocEditorView) -> [EditorRow] { model.mentionable }
    func docEditor(_ editor: DocEditorView, mentionItems query: String) -> [MenuItem]? { model.mentionItems(query) }
    func docEditor(_ editor: DocEditorView, listFolder id: String, rel: String, done: @escaping (FolderListing) -> Void) {
        Task { @MainActor in done(Self.listing(await model.listFolder(id, rel: rel))) }
    }
    static func listing(_ json: JSONValue) -> FolderListing {
        let entries = (json["entries"]?.array ?? []).map { e in
            FolderListing.Entry(name: e["name"]?.string ?? "", rel: e["rel"]?.string ?? "", dir: e["dir"]?.bool ?? false, type: e["type"]?.string,
                                zotero: e["zotero"]?.string ?? e["key"]?.string, hint: e["hint"]?.string, find: e["find"]?.string)
        }
        return FolderListing(entries: entries, error: json["error"]?.string, missing: json["missing"]?.bool ?? false, total: json["total"]?.int)
    }
    func docEditor(_ editor: DocEditorView, fileState folderId: String, rel: String) -> FileState {
        model.missingFiles.contains("\(folderId):\(rel)") ? .missing : .unknown
    }
    func docEditor(_ editor: DocEditorView, picked row: MenuItem) { model.mentionPicked(row) }
    func docEditor(_ editor: DocEditorView, mentionMenuOpen open: Bool) { model.setMentionOpen(open) }
    func docEditor(_ editor: DocEditorView, makeNote name: String, done: @escaping (String?) -> Void) {
        Task { @MainActor in
            do { done(try await model.makeNote(name, open: false).name) } catch { model.report(error); done(nil) }
        }
    }

    // agents
    func docEditorModels(_ editor: DocEditorView) -> QuestionModels? { model.questionModels }
    func docEditorCanAsk(_ editor: DocEditorView) -> Bool { true }
    func docEditor(_ editor: DocEditorView, ask: AskRequest) {
        let d = doc(editor)
        guard let key = d.key, let ref = d.ref else { return }
        Task { @MainActor in await model.askBart(key: key, ref: ref, ask) }
    }
    func docEditorHasRouter(_ editor: DocEditorView) -> Bool { true }
    func docEditor(_ editor: DocEditorView, route: RouteRequest, done: @escaping (RoutePick?) -> Void) {
        let d = doc(editor)
        Task { @MainActor in done(await model.routeLine(key: d.key ?? "", ref: d.ref, RouteAsk(route))) }
    }
    func docEditor(_ editor: DocEditorView, routeGone askId: String) { model.routeGone(askId) }
    func docEditor(_ editor: DocEditorView, stop askId: String) {
        let api = model.api
        Task { @MainActor in do { try await api.stopBart(askId) } catch { model.report(error) } }
    }
    /// Build only from a workspace's document (or any document while there is a workspace), never an archive.
    func docEditorCanBuild(_ editor: DocEditorView) -> Bool {
        guard let ref = doc(editor).ref else { return false }
        if ref.isArchive { return false }
        if case .workspace = ref { return true }
        return model.topic != nil
    }
    func docEditor(_ editor: DocEditorView, build: BuildRequest) {
        let d = doc(editor)
        guard let key = d.key, let ref = d.ref else { return }
        Task { @MainActor in await model.buildFromEditor(key: key, ref: ref, BuildAsk(build)) }
    }
    func docEditor(_ editor: DocEditorView, buildView id: String) -> NSView? {
        let card = cards[id] ?? BuildCardHost(model: model, id: id, editorKey: { [weak editor] in editor?.handleKey })
        cards[id] = card
        if model.builds[id] != nil, model.buildDiffs[id] == nil { model.wantBuildDiff(id) }
        return card.view
    }
    /// Every card drawn again with what main says now.
    func refreshCards() { for card in cards.values { card.render() } }

    // an @discover guide's papers
    func docEditor(_ editor: DocEditorView, paperState address: String) -> String? { model.guidePaperState(address) }
    func docEditor(_ editor: DocEditorView, savePaper title: String, address: String, done: @escaping (Error?) -> Void) {
        Task { @MainActor in do { try await model.saveGuidePaper(address: address, title: title); done(nil) } catch { done(error) } }
    }
    func docEditorCanUnsavePaper(_ editor: DocEditorView) -> Bool { model.topic != nil }
    func docEditor(_ editor: DocEditorView, unsavePaper title: String, address: String, done: @escaping (Error?) -> Void) {
        Task { @MainActor in do { try await model.unsaveGuidePaper(address: address); done(nil) } catch { done(error) } }
    }

    // @create's files
    func docEditor(_ editor: DocEditorView, madeFile key: String) -> MadeFile? { model.madeFile(key) }
    func docEditor(_ editor: DocEditorView, saveMade key: String, name: String) {
        guard let made = Self.made(key, name: name) else { return }
        Task { @MainActor in await model.saveMade(made) }
    }
    func docEditor(_ editor: DocEditorView, madeNeeded keys: [String]) { model.needMade(keys.compactMap { Self.made($0, name: nil) }) }
    func docEditor(_ editor: DocEditorView, openMade key: String) {
        guard let made = Self.made(key, name: nil) else { return }
        Task { @MainActor in await model.openMade(made) }
    }
    /// `<askId>/<rel>` → the file.
    static func made(_ key: String, name: String?) -> MadeRef? {
        guard let slash = key.firstIndex(of: "/") else { return nil }
        let askId = String(key[..<slash]), rel = String(key[key.index(after: slash)...])
        guard !askId.isEmpty, !rel.isEmpty else { return nil }
        return MadeRef(askId: askId, rel: rel, name: name ?? (rel.components(separatedBy: "/").last ?? rel))
    }

    // opening things
    func docEditor(_ editor: DocEditorView, openLink href: String, newTab: Bool, sections: [String]?) {
        // A guide's sections come as (label, find, to) triplets; the editor sends none yet (see API.md, Needs).
        let guide: [GuideSection]? = sections.flatMap { list in
            list.count >= 3 ? stride(from: 0, to: list.count - 2, by: 3).map { GuideSection(label: list[$0], find: list[$0 + 1], to: list[$0 + 2]) } : nil
        }
        model.openLink(href, newTab: newTab, sections: guide)
    }
    func docEditor(_ editor: DocEditorView, open row: LibRow) {
        if let held = model.library.first(where: { $0.id == row.id }) { model.openItem(held) }
        else if row.type == "workspace" { model.showWs() }
    }
    func docEditor(_ editor: DocEditorView, openBeside kind: String, id: String, name: String) {
        model.openDocBeside(kind: kind, id: id, name: name, link: kind == "workspace" ? id : name)
    }
    /// A ⌘-click on a workspace's mention goes there.
    func docEditor(_ editor: DocEditorView, openWorkspace id: String) { if model.index.has(id) { model.selectTopic(id) } }
    func docEditor(_ editor: DocEditorView, openFile folderId: String, rel: String, name: String, newTab: Bool) {
        Task { @MainActor in await model.openFolderFile(folderId: folderId, rel: rel, name: name, newTab: newTab) }
    }
    func docEditor(_ editor: DocEditorView, openZotero key: String, name: String, newTab: Bool) {
        Task { @MainActor in await model.openZotero(key: key, name: name, newTab: newTab) }
    }

    // pictures and drops
    func docEditor(_ editor: DocEditorView, image id: String) -> NSImage? { model.images[id] }
    func docEditor(_ editor: DocEditorView, pasteImage data: Data, mime: String, label: String, done: @escaping (String?) -> Void) {
        Task { @MainActor in done(await model.pasteImage(data, mime: mime, name: label)) }
    }
    func docEditor(_ editor: DocEditorView, dropItems: [Drop.Item]) { model.dropItems(dropItems) }
    func docEditor(_ editor: DocEditorView, dropOnZotero key: String, name: String, file: String) {
        Task { @MainActor in await model.dropOnZotero(key: key, name: name, file: file) }
    }

    // the clipboard, places, errors
    func docEditor(_ editor: DocEditorView, copy text: String) { model.api.copyText(text) }
    /// Where the document was scrolled to is kept for the document in front; one beside opens at its top.
    func docEditor(_ editor: DocEditorView, viewOf scope: String, key: String) -> ViewPosition? {
        guard pane == 0, let json = model.viewOf(scope: scope, key: key) else { return nil }
        return Self.position(json)
    }
    func docEditor(_ editor: DocEditorView, reportView position: ViewPosition, scope: String, key: String, now: Bool) {
        guard pane == 0 else { return }
        var o: [String: JSONValue] = ["top": .number(position.top)]
        if let l = position.line { o["line"] = .number(Double(l)) }
        if let off = position.offset { o["offset"] = .number(off) }
        if let h = position.hash { o["hash"] = .string(h) }
        model.recordPosition(scope: scope, key: key, position: .object(o), now: now)
    }
    static func position(_ json: JSONValue) -> ViewPosition? {
        guard let top = json["top"]?.double else { return nil }
        return ViewPosition(top: top, line: json["line"]?.int, offset: json["offset"]?.double, hash: json["hash"]?.string)
    }
    func docEditor(_ editor: DocEditorView, error: Error) { model.report(error) }
}

extension WorkspaceModel {
    /// What a document can mention (Workspace.jsx `mentionable`): the agents first, then every library row described; a
    /// note let go of is marked trashed (its mentions grey, still opened by a click).
    public var mentionable: [EditorRow] {
        let gone = letGo
        let agents: [EditorRow] = [
            EditorRow(row: LibRow(id: "bart", name: "bart", type: "chat", summary: "Ask anything. Bart picks Chat, Brainstorm, Discover, Create or Build, then steps aside."), title: "Bart", facts: "picks, never answers"),
            EditorRow(row: LibRow(id: "chat", name: "chat", type: "chat", summary: "Ask a question about this document, the project's code or the web. Add --opus or --high to pick the model or the effort by hand."), title: "Chat", facts: "reads, never edits"),
            EditorRow(row: LibRow(id: "brainstorm", name: "brainstorm", type: "chat", summary: "Think something through out loud: a topic, a paper or what is on your mind. It follows where you take it, and you decide where that is."), title: "Brainstorm", facts: "helps you think, never decides"),
            EditorRow(row: LibRow(id: "discover", name: "discover", type: "chat", summary: "Find what to read about a problem, and where in it to look: it traces the citations of the papers in your library and the pages of the people you follow. Pick Quick, Standard or Deep on the line's chip."), title: "Discover", facts: "finds, never concludes"),
            EditorRow(row: LibRow(id: "create", name: "create", type: "chat", summary: "Makes a new file (a page, a chart, a document) under your line; Save puts the ones you want in your library."), title: "Create", facts: "adds, never edits"),
        ]
        return agents + library.map { row in
            let d = WorkspaceRows.describe(row, projectId: projectId)
            var lib = row.libRow
            lib.summary = d.summary
            return EditorRow(row: lib, title: row.name, facts: d.facts, trashed: gone.contains(row.id))
        }
    }
}

/// A `build> <id>` line's card in an editor (the Build package's BuildCardView), kept per Build so its reply text and
/// history toggle survive redraws.
@MainActor
final class BuildCardHost {
    unowned let model: WorkspaceModel
    let id: String
    let editorKey: () -> String?
    var reply = ""
    var open = false
    lazy var hosting = NSHostingView(rootView: AnyView(EmptyView()))
    var view: NSView { render(); return hosting }

    init(model: WorkspaceModel, id: String, editorKey: @escaping () -> String?) { self.model = model; self.id = id; self.editorKey = editorKey }

    func render() {
        let card = BuildCardModel(id: id, task: model.builds[id], progress: model.buildProgress[id], open: open)
        let binding = Binding<String>(get: { [weak self] in self?.reply ?? "" }, set: { [weak self] in self?.reply = $0 })
        hosting.rootView = AnyView(BuildCardView(card: card, diff: model.buildDiffs[id], reply: binding) { [weak self] act, run in self?.act(act, run) })
        hosting.setAccessibilityIdentifier("build-card=\(id)")
    }

    /// DocEditor's card buttons (DocEditor.jsx 2010-2023).
    func act(_ k: String, _ run: String?) {
        switch k {
        case "buildhistory": open.toggle(); render(); return
        case "buildsteps", "buildprompt": render(); return
        case "buildsend":
            let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            Task { @MainActor in if await model.onBuildAction(id, "reply", text: text, interrupt: true) { reply = ""; render() } }
            return
        case "buildremove":
            // the card's line goes from the document; what still runs is stopped first (main)
            guard let key = editorKey(), let text = model.docs[key], let ref = WorkspaceEditorHost.ref(forKey: key) else { return }
            let kept = text.components(separatedBy: "\n").filter { line in let p = Doc.parseLine(line); return !(p.type == .build && p.id == id) }
            model.changeDoc(key, ref, (kept.isEmpty ? [""] : kept).joined(separator: "\n"))
            return
        default: break
        }
        let action: String?
        switch k {
        case "buildrunshow": action = "runshow"
        case "buildrunstop": action = "runstop"
        case "buildrunstopone": action = "runstopone"
        case "buildrunstopall": action = "runstopall"
        default: action = ["buildstop": "stop", "buildpreview": "review", "buildreview": "review", "buildaccept": "accept", "buildreject": "reject", "buildresume": "resume"][k]
        }
        guard let action else { return }
        Task { @MainActor in await model.onBuildAction(id, action, name: run) }
    }
}
