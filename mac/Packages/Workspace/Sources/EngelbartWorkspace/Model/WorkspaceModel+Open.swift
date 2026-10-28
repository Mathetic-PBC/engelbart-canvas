import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartUI
import EngelbartStore
import EngelbartStage
import EngelbartEditor
import EngelbartSandbox

// Workspace.jsx "opening", "the pane beside", Zotero, @create's files, the Browser's Save and an @discover guide's papers.
// Anything that is not a note opens on the Stage (2026-09-23): a sidebar row, a mention, a link in a document or the
// terminal, never the default browser.
extension WorkspaceModel {
    /// A library row as the Stage knows it.
    static func stageRow(_ r: LibraryRow) -> StageRow {
        r.libRow // the Stage's row is Doc's LibRow (Stage Kind.swift)
    }

    /// A row opened: a workspace → its document; a note → its tab; anything else on the Stage (⌘-click: its own tab).
    public func openItem(_ row: LibraryRow, newTab: Bool = false) {
        if row.id == "chat" { return }
        if row.type == "workspace" { showWs(); return }
        if row.isNote { openTab(row.id, title: row.name); return }
        let s = Self.stageRow(row)
        guard StageModel.onStage(s), let stage else { return }
        showRight("stage")
        stage.openRow(s, newTab: newTab)
    }

    /// A sidebar row clicked (Workspace.jsx onRowClick): a GitHub repository opens its live preview, its sandbox's shell,
    /// both, or its build; anything else as openItem.
    public func onRowClick(_ row: LibraryRow, newTab: Bool = false) {
        noteOpen(row.id)
        if row.hasTag("git"), let sandboxes = ctx.sandboxes {
            let item = sandboxes.items[row.id]
            switch SandboxNotifications.repositoryClick(item) {
            case "preview": if let run = item?.run { sandboxes.open(run) }; return
            case "terminal": if let run = item?.run { sandboxes.openTerminal(run) }; return
            case "both": if let run = item?.run { sandboxes.openTerminal(run, show: false); sandboxes.open(run) }; return
            case "start":
                sandboxes.openBuild(row.json)
                let api = self.api
                Task { @MainActor [weak self] in do { try await api.startSandbox(row.id) } catch { self?.report(error) } }
                return
            case "details": sandboxes.openBuild(row.json); return
            default: break
            }
        }
        openItem(row, newTab: newTab)
    }

    /// A link in a document goes to the Stage; ⌘-click in a tab of its own. A citation of a workspace's document or a
    /// note goes beside the document instead.
    public func openLink(_ href: String, newTab: Bool = false, sections: [GuideSection]? = nil) {
        if openIfCited(href) { return }
        guard let stage else { return }
        showRight("stage")
        stage.openInput(href, newTab: newTab, sections: sections)
    }

    /// A file inside a library folder (MATH-22): found on disk now and opened on the Stage; one that is gone says so.
    public func openFolderFile(folderId: String, rel: String, name: String, newTab: Bool = false) async {
        do {
            let found = try await api.folderFile(folderId, rel)
            guard found.exists, let path = found.path else {
                report("\"\(name.isEmpty ? rel : name)\" is no longer in \(found.folder ?? "its folder") (\(rel))")
                missingFiles.insert("\(folderId):\(rel)")
                changed()
                return
            }
            guard let stage else { return }
            showRight("stage")
            stage.openFile(path, newTab: newTab)
        } catch { report(error) }
    }

    /// A library folder's level, or the connected Zotero library's (MATH-65).
    public func listFolder(_ id: String, rel: String) async -> JSONValue {
        do { return id == "zotero" ? try await api.zoteroList(rel) : try await api.listFolder(id, rel) }
        catch { return ["entries": .array([]), "error": .string(Self.message(of: error))] }
    }

    /// A Zotero item's chip: its pdf on the Stage, its DOI/URL in the default browser, or why not.
    public func openZotero(key: String, name: String, newTab: Bool = false) async {
        do {
            switch ZoteroChip.action(try await api.zoteroOpen(key), name: name.isEmpty ? key : name) {
            case .pdf(let path): guard let stage else { return }; showRight("stage"); stage.openFile(path, newTab: newTab)
            case .external(let url): api.openExternal(url)
            case .error(let message): report(message)
            }
        } catch { report(error) }
    }

    func openZoteroPdf(_ file: String) {
        guard let stage, !file.isEmpty else { return }
        showRight("stage")
        stage.openFile(file)
    }

    /// A pdf dropped on a Zotero chip becomes the item's pdf and opens.
    public func dropOnZotero(key: String, name: String, file: String) async {
        do {
            switch ZoteroChip.action(try await api.zoteroAttach(key, file), name: name.isEmpty ? key : name) {
            case .pdf(let path): openZoteroPdf(path)
            case .error(let message): report(message)
            case .external: break
            }
        } catch { report(error) }
    }

    // MARK: the page in front on the Stage, and Save

    /// The Stage's page in front changed (onPage).
    public func setOpenPage(_ page: OpenPage?) {
        if page == openPage { return }
        openPage = page
        refreshPageInfo()
        if let made = page.flatMap({ MadeRef.at($0.input) }), madeFiles[made.key] == nil { needMade([made]) }
        changed()
    }

    /// What the library holds for the page in front, asked again whenever the page or the library changes.
    func refreshPageInfo() {
        guard let page = openPage else { if pageInfo != nil { pageInfo = nil; changed() }; return }
        let input = page.input, api = self.api
        Task { @MainActor [weak self] in
            let answer = try? await api.lookupLibraryItem(input)
            guard let self, self.openPage?.input == input else { return }
            self.pageInfo = (input, answer?.row, answer != nil && answer?.error == nil, answer)
            self.changed()
        }
    }

    var pageKnown: (input: String, row: LibraryRow?, addable: Bool, found: LibraryLookup?)? {
        guard let page = openPage, let info = pageInfo, info.input == page.input, info.addable else { return nil }
        return info
    }
    /// 'none' (the library does not hold it), 'lib' (it does, this workspace does not), 'here'.
    public var pageState: String? {
        guard let known = pageKnown else { return nil }
        guard let row = known.row else { return "none" }
        return inRail(row.id) ? "here" : "lib"
    }

    /// The address field's Save as the Stage draws it: Create's file's own, else the page's.
    public var stageSave: StageSave? {
        if let page = openPage, let made = MadeRef.at(page.input), let file = madeFiles[made.key], !file.missing, file.error == nil {
            if let saved = file.saved { return StageSave(state: .madeSaved, crumb: "Library / Assets / \(saved.name)", onSave: { _, _ in }, onLink: {}) }
            return StageSave(state: .made, busy: file.saving, onSave: { [weak self] _, _ in await self?.saveMade(MadeRef(askId: made.askId, rel: made.rel, name: file.name.isEmpty ? made.name : file.name)) }, onLink: {})
        }
        guard topic != nil, let state = pageState else { return nil }
        let s: StageModel.SaveState = state == "here" ? .here : state == "lib" ? .lib : .none
        return StageSave(state: s, onSave: { [weak self] name, here in try await self?.savePage(name: name, here: here) },
                         onLink: { [weak self] in if let id = self?.pageKnown?.row?.id { try await self?.linkIds([id]) } })
    }

    /// The Browser's Save: the page as a new row, named in the card, into the library alone or also into this workspace.
    /// A web pdf and a plain page are kept as copies; anything else is linked by its address.
    public func savePage(name: String, here: Bool) async throws {
        guard let page = openPage else { return }
        let row: LibraryRow
        if let bytes = page.bytes { row = try await api.addLibraryPdf(page.input, bytes: bytes, name: name) }
        else if StageModel.savesPageCopy(webPage: page.webPage, tabId: page.tabId, hasBytes: false, foundType: pageKnown?.found?.type, foundTags: pageKnown?.found?.tags) {
            do { row = try await api.addLibraryPage(page.tabId, page.input, name: name) } catch { report(error); return }
        } else {
            let added = try await api.addLibraryItem(page.input, name: name)
            row = added.row
            if let e = added.sandboxError { report(e) }
        }
        if here { try await linkIds([row.id]) } else { await reload() }
    }

    /// An @discover guide's paper: where it is (none / lib / here).
    public func guidePaperState(_ address: String) -> String {
        guard let row = StageModel.paperRow(library.map(Self.stageRow), address) else { return "none" }
        return inRail(row.id) ? "here" : "lib"
    }
    /// + Save adds it (named with its title) and links it here; + Workspace links the library's row; never a second row.
    public func saveGuidePaper(address: String, title: String) async throws {
        let row = StageModel.paperRow(library.map(Self.stageRow), address)
        if row == nil { _ = try await addInput(address, name: title) }
        else if let id = row?.id, !inRail(id) { try await linkIds([id]) }
    }
    /// Its filled bookmark (2026-10-16): the paper leaves this workspace and stays in the library.
    public func unsaveGuidePaper(address: String) async throws {
        guard let topic, let row = StageModel.paperRow(library.map(Self.stageRow), address), inRail(row.id) else { return }
        try await api.unlinkFromWorkspace(projectId, topic.id, row.id, unmentioned: false)
        if tabs.contains(where: { $0.id == row.id }) { closeTab(row.id) }
        await reload()
    }

    // MARK: @create's files (2026-10-14)

    /// What each file a Create answer stands for is, read once when an editor shows it.
    public func needMade(_ list: [MadeRef]) {
        for made in list where !madeAsked.contains(made.key) {
            madeAsked.insert(made.key)
            Task { @MainActor [weak self] in await self?.readMade(made) }
        }
    }
    func readMade(_ made: MadeRef) async {
        do {
            let file = try await api.createdFile(projectId, made.askId, made.rel)
            var shown = madeFiles[made.key] ?? MadeFileState(name: made.name)
            shown.name = file["name"]?.string ?? made.name
            shown.type = file["type"]?.string ?? ""; shown.ext = file["ext"]?.string ?? ""
            shown.path = file["path"]?.string; shown.missing = file["missing"]?.bool == true
            shown.text = file["text"]?.string
            if let saved = file["saved"], let id = saved["id"]?.string { shown.saved = (id, saved["name"]?.string ?? shown.name) }
            if shown.ext == "svg", let t = shown.text { shown.image = NSImage(data: Data(t.utf8)) }
            else if shown.type == "image", let b64 = file["bytes"]?.string, let data = Data(base64Encoded: b64) { shown.image = NSImage(data: data) }
            else if let path = shown.path, shown.type == "image" { shown.image = NSImage(contentsOfFile: path) }
            if let b64 = file["preview"]?.string, let data = Data(base64Encoded: b64) { shown.image = NSImage(data: data) }
            shown.saving = false
            madeFiles[made.key] = shown
        } catch {
            madeFiles[made.key] = MadeFileState(name: made.name, error: Self.message(of: error))
        }
        changed()
    }

    /// Save: into the library (the Assets chip), linked here. It reads Saved wherever the file shows.
    public func saveMade(_ made: MadeRef) async {
        var held = madeFiles[made.key] ?? MadeFileState(name: made.name)
        held.saving = true
        madeFiles[made.key] = held
        changed()
        do {
            let row = try await api.saveCreated(projectId, made.askId, made.rel, topicId)
            held.saving = false; held.saved = (row.id, row.name)
            madeFiles[made.key] = held
            changed()
            await reload()
        } catch {
            held.saving = false
            madeFiles[made.key] = held
            changed()
            report(error)
        }
    }

    /// The name, or Open in Stage: the file in a Stage tab (one already showing it comes to the front).
    public func openMade(_ made: MadeRef) async {
        do {
            var path = madeFiles[made.key]?.path
            var missing = madeFiles[made.key]?.missing ?? false
            if path == nil {
                let file = try await api.createdFile(projectId, made.askId, made.rel)
                path = file["path"]?.string; missing = file["missing"]?.bool == true
            }
            if missing { report("\"\(made.name)\" is no longer there"); return }
            guard let stage, let path else { return }
            showRight("stage")
            stage.openFile(path)
        } catch { report(error) }
    }

    /// A Create run's answer placed: each file saved, then the first opened (a save that fails is told; it still opens).
    func madeLanded(_ list: [MadeRef], open: MadeRef?) {
        guard !list.isEmpty else { return }
        Task { @MainActor [weak self] in
            for made in list { await self?.saveMade(made) }
            if let open { await self?.openMade(open) }
        }
    }

    /// Which made files a Stage tab shows (the editor greys their rows).
    public var madeOpen: Set<String> { Set(stagePlaces.compactMap { MadeRef.at($0)?.key }) }

    /// The editor's view of a made file.
    public func madeFile(_ key: String) -> MadeFile? {
        guard let f = madeFiles[key] else { return nil }
        return MadeFile(name: f.name, type: f.ext.isEmpty ? f.type : f.ext, saved: f.saved?.name, saving: f.saving, missing: f.missing, error: f.error, image: f.image, text: f.text)
    }

    // MARK: the pane beside (MATH-23)

    /// What the document in front shows ({kind, id}): the workspace's own, a note's, or nothing (an archive, the project page).
    var besideFront: (kind: EngelbartUI.DocRef.Kind, id: String)? {
        if activeTab == WorkspaceTabs.ws { return topicId.map { (.workspace, $0) } }
        if activeTab.hasPrefix(WorkspaceTabs.archivePrefix) || activeTab == WorkspaceTabs.project { return nil }
        return (.note, activeTab)
    }

    /// A note's or a workspace's mention clicked in either pane: its document in the pane beside, in place of what was
    /// there; one already in front is not opened again. → the pane that shows it (the column scrolls to it).
    @discardableResult
    public func openDocBeside(kind: String, id: String, name: String, link: String) -> Int? {
        let isWs = kind == "workspace"
        if isWs && !index.has(id) { return nil } // a workspace that is gone
        let title = isWs ? (index[id]?.node.name ?? name) : name
        let out = Panes.openBeside(beside, front: besideFront, item: EngelbartUI.DocRef(kind: isWs ? .workspace : .note, id: id, title: title), link: link)
        guard let at = out.at else { return nil }
        if out.panes != beside { beside = out.panes; readMissing(); changed() }
        revealPane = at
        changed()
        return at
    }
    /// Its ×: the pane beside closes; what was typed in it is saved now.
    public func closeBeside(_ at: Int) {
        for doc in paneDocs.dropFirst(at) { if let key = doc.key { flush(key) } }
        beside = Panes.closePane(beside, at)
        if let f = docFind, f.pane >= paneDocs.count { docFind = nil }
        changed()
    }

    /// A citation of the person's own thinking (2026-10-21, model/cite-open.js): its workspace or note opened beside the
    /// document in front (or the one in front scrolled), to the passage it quotes, lit up.
    func openIfCited(_ href: String) -> Bool {
        let nodes = Dictionary(index.order.compactMap { id in index[id].map { (id, CiteOpen.WorkspaceNode(id: id, name: $0.node.name, folder: $0.node.folder, parentId: $0.parent)) } }, uniquingKeysWith: { a, _ in a })
        guard let cited = CiteOpen.citedDoc(href, projectDir: project.dir, index: nodes, order: index.order, notes: notesById.values.map(\.libRow)) else { return false }
        openCited(kind: cited.kind, id: cited.id, name: cited.name, find: cited.find, cite: cited.cite)
        return true
    }
    func openCited(kind: String, id: String, name: String, find: String, cite: String) {
        openDocBeside(kind: kind, id: id, name: name, link: "")
        guard !find.isEmpty else { return } // the whole document: nothing to light
        let key = kind == "workspace" ? "ws:\(id)" : "note:\(id)"
        retry(every: 0.1, tries: 60) { [weak self] in
            guard let self, let editor = self.editor(for: key), self.docs[key] != nil else { return false }
            let at = CiteOpen.passageLine(editor.handleLines, find, cite: cite)
            if at < 0 { return true }
            self.retry(every: 0.1, tries: 20, first: 0.05) { editor.handleShowPassage(at, find: find) }
            return true
        }
    }

    // MARK: renaming from a title

    /// The document in front's title named anew: the workspace, the note, or (the project page) the project.
    public func renameDoc(_ next: String) async {
        if paneDocs[0].archive != nil { return }
        if activeTab == WorkspaceTabs.project { await renameProjectNamed(next); return }
        if activeTab != WorkspaceTabs.ws { await renameNoteDoc(activeTab, next); return }
        do {
            if let wid = paneDocs[0].workspaceId { try await api.renameWorkspace(projectId, wid, next) }
            await reload()
        } catch { report(error) }
    }
    /// A note renamed from its title: its tab and its pane take the new name.
    public func renameNoteDoc(_ id: String, _ name: String) async {
        do {
            let renamed = try await api.renameNote(projectId, id, name)
            tabs = tabs.map { $0.id == id ? DocTab(id: id, title: renamed) : $0 }
            beside = beside.map { $0.kind != .workspace && $0.id == id ? Pane(kind: $0.kind, id: $0.id, title: renamed, link: $0.link) : $0 }
            changed()
            await reload()
        } catch { report(error) }
    }
    /// Another workspace's document beside, renamed from its title.
    public func renameWorkspaceBeside(_ id: String, _ name: String) async {
        do {
            try await api.renameWorkspace(projectId, id, name)
            beside = beside.map { $0.kind == .workspace && $0.id == id ? Pane(kind: $0.kind, id: $0.id, title: name, link: $0.link) : $0 }
            changed()
            await reload()
        } catch { report(error) }
    }
    public func renameProjectNamed(_ name: String) async {
        do { try await api.renameProject(projectId, name); await reload() } catch { report(error) }
    }

    /// Opened from the all-projects screen: shown once the Stage is there.
    func openInitialStage() {
        guard let request = ctx.entry.stage else { return }
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch request {
                case .links(let urls): for (i, url) in urls.enumerated() { self.openLink(url, newTab: i > 0) }
                case .row(let row): self.openItem(row)
                }
            }
        }
    }
}
