import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartEditor

// Workspace.jsx "sidebar", "topics", folders, starred, the Welcome walkthrough and the tour: everything that brings a
// library item into this workspace links it (context, and off `removed`); adding makes the row first, or finds the
// library's own when it already holds the thing (addOrFind, MATH-67). The row that arrives flashes.
extension WorkspaceModel: WorkspaceSidebarHost {
    /// Links to this workspace (`picked`: the @ menu did, MATH-57); reload; the last flashes; a sandbox's refusal is said.
    public func linkIds(_ ids: [String], picked: Bool = false) async throws {
        guard let topic, !ids.isEmpty else { return }
        let refused = try await api.linkToWorkspace(projectId, topic.id, ids, picked: picked)
        await reload()
        flash(ids[ids.count - 1])
        if let refused { report(refused) }
    }

    static let alreadyRe = Rx(#"Already in the library as “"#)
    /// api.addLibraryItem, except that something the library holds comes back as its row (model/add-or-find.js).
    func addOrFind(_ input: String, name: String? = nil) async throws -> (row: LibraryRow, sandboxError: String?) {
        do { return try await api.addLibraryItem(input, name: name) }
        catch {
            guard Self.alreadyRe.test(Self.message(of: error)) else { throw error }
            if let found = try? await api.lookupLibraryItem(input), let row = found.row { return (row, nil) }
            throw error
        }
    }

    @discardableResult
    func addInput(_ input: String, name: String? = nil, picked: Bool = false) async throws -> LibraryRow {
        guard topic != nil else { throw WorkspaceError("Open a workspace first") }
        let got = try await addOrFind(input, name: name)
        try await linkIds([got.row.id], picked: picked)
        if let e = got.sandboxError { report(e) }
        return got.row
    }

    // MARK: WorkspaceSidebarHost

    public func selectWorkspace(_ id: String) { selectTopic(id) }

    /// A workspace made from the sidebar, named in its dialog, at the top or in `parentId`; with no name it is untitled
    /// and the caret goes to its title. Then it is gone into.
    public func createWorkspace(name: String = "", parentId: String? = nil) async throws {
        let level = parentId.flatMap { index[$0]?.node.children } ?? tree.workspaces
        let given = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = try await api.createWorkspace(projectId, name: given.isEmpty ? Names.nextUntitled("Project", level.map(\.name)) : given, parentId: parentId)
        await reload()
        if given.isEmpty { wantTitleFocus = true }
        selectTopic(id)
    }
    /// The empty project's + Project.
    public func addTopic() { Task { @MainActor [weak self] in do { try await self?.createWorkspace() } catch { self?.report(error) } } }

    public func renameWorkspace(_ id: String, _ name: String) {
        let api = self.api, pid = projectId
        Task { @MainActor [weak self] in do { try await api.renameWorkspace(pid, id, name); await self?.reload() } catch { self?.report(error) } }
    }

    /// Delete (2026-09-30): the workspace and all nested in it go into the trash. When the one open here is among them,
    /// the one above it opens instead (else the one below, else its parent).
    public func deleteWorkspace(_ id: String) {
        guard let at = index[id] else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                await self.flushAll()
                try await self.api.trashWorkspace(self.projectId, id)
                if self.index.within(self.topicId, id) {
                    let level = at.parent.flatMap { self.index[$0]?.node.children } ?? self.tree.workspaces
                    let i = level.firstIndex { $0.id == id } ?? 0
                    let instead = i > 0 ? level[i - 1].id : (i + 1 < level.count ? level[i + 1].id : at.parent)
                    if let instead { self.selectTopic(instead) }
                    else { self.wantedId = nil; self.tabs = [WorkspaceTabs.wsTab]; self.activeTab = WorkspaceTabs.ws; self.tabsChanged() }
                }
                await self.reload()
            } catch { self.report(error) }
        }
    }
    /// Restore, in the trash: the workspace back where it was, and open.
    public func restoreWorkspace(_ id: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do { try await self.api.restoreWorkspace(self.projectId, id); await self.reload(); self.selectTopic(id) } catch { self.report(error) }
        }
    }
    public func openVersion(workspaceId: String, file: String, title: String) { Task { @MainActor [weak self] in await self?.goToVersion(workspaceId, file: file, title: title) } }
    public func nextAgent() { goNextAgent() }
    public func openRow(_ row: LibraryRow, newTab: Bool) { onRowClick(row, newTab: newTab) }
    public func openChild(_ id: String) { selectTopic(id) }
    public func openArchive(file: String, title: String) { openTab("\(WorkspaceTabs.archivePrefix)\(file)", title: title) }

    public func renameRow(_ row: LibraryRow, _ name: String) {
        let api = self.api
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let updated = try await api.renameLibraryItem(row.id, name)
                if let n = updated?.name { self.tabs = self.tabs.map { $0.id == row.id ? DocTab(id: row.id, title: n) : $0 }; self.changed() }
                await self.reload()
            } catch { self.report(error) }
        }
    }
    public func renameChild(_ id: String, _ name: String) { renameWorkspace(id, name) }

    /// The trash: off this workspace, not out of the library. A note's tab closes.
    public func removeRow(_ row: LibraryRow) {
        guard let topic else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.api.unlinkFromWorkspace(self.projectId, topic.id, row.id, unmentioned: false)
                if self.tabs.contains(where: { $0.id == row.id }) { self.closeTab(row.id) }
                await self.reload()
            } catch { self.report(error) }
        }
    }
    public func linkRow(_ row: LibraryRow) { Task { @MainActor [weak self] in do { try await self?.linkIds([row.id]) } catch { self?.report(error) } } }
    public func openHeld(projectId pid: String, workspaceId: String?) { if pid == projectId, let wid = workspaceId, index.has(wid) { selectTopic(wid) } }

    /// Dropped on the sidebar's rows or into the document (MATH-19): each its own row, in order, then all linked here;
    /// what could not be added is said, joined by " · ".
    public func dropItems(_ items: [Drop.Item]) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            var made: [LibraryRow] = [], problems: [String] = []
            for item in items {
                do {
                    switch item {
                    case .path(let p): let got = try await self.api.addLibraryItem(p, name: nil); made.append(got.row); if let e = got.sandboxError { problems.append("\(got.row.name): \(e)") }
                    case .bytes(let data, let mime, let name): made.append(try await self.api.addLibraryFile(data, mime: mime, name: name))
                    case .url(let u): let got = try await self.api.addLibraryUrl(u); made.append(got.row); if let e = got.sandboxError { problems.append("\(got.row.name): \(e)") }
                    }
                } catch { problems.append(Self.message(of: error)) }
            }
            do {
                if self.topic != nil { try await self.linkIds(made.map(\.id)) } else if !made.isEmpty { await self.reload() }
            } catch { problems.append(Self.message(of: error)) }
            if !problems.isEmpty { self.report(problems.joined(separator: " · ")) }
        }
    }

    /// What + on a folder of Sources adds goes into that folder (the library's row, made or found); with no folder, here.
    public func addInput(_ input: String, folderId: String?) async throws -> LibraryRow {
        guard let folderId else { return try await addInput(input) }
        let got = try await addOrFind(input)
        await reload()
        try await addToFolder(folderId, [got.row.id])
        if let e = got.sandboxError { report(e) }
        return got.row
    }

    /// "Choose from disk…": every file and folder picked, each its own row; what could not be added is said.
    public func pickDisk(folderId: String?) async -> [String] {
        let paths = await api.pickLibraryPaths()
        var problems: [String] = [], ids: [String] = []
        for file in paths {
            do { ids.append(try await addOrFind(file).row.id) } catch { problems.append(Self.message(of: error)) }
        }
        do {
            if let folderId { if !ids.isEmpty { await reload(); try await addToFolder(folderId, ids) } }
            else { try await linkIds(ids) }
        } catch { problems.append(Self.message(of: error)) }
        return problems
    }

    /// A note made from the sidebar's + or the @ menu's Note: named after what was typed, else untitled; made here. In
    /// front with the caret in its title from the +; behind the document from the @ menu, whose line is still typed.
    @discardableResult
    public func makeNote(_ name: String, open: Bool) async throws -> NoteInfo {
        let given = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = try await api.createNote(projectId, name: given.isEmpty ? Names.nextUntitled("Note", tree.notes.map(\.name)) : given, workspaceId: topicId)
        try await linkIds([note.id])
        if open && given.isEmpty { wantTitleFocus = true }
        openTab(note.id, title: note.name, behind: !open)
        return note
    }
    public func newNote(folderId: String?) async throws {
        let note = try await makeNote("", open: true)
        if let folderId { try await addToFolder(folderId, [note.id]) }
    }

    /// A repository picked from the +'s GitHub view: the library's row for it, else added by its address.
    public func pickRepo(url: String, row: LibraryRow?, folderId: String?) async throws {
        if let folderId {
            let r: LibraryRow
            if let row { r = row } else { r = try await addOrFind(url).row }
            await reload()
            try await addToFolder(folderId, [r.id])
            return
        }
        if let row { try await linkIds([row.id]) } else { try await addInput(url) }
    }

    // folders (2026-10-13): the same in every project, each a list of library items
    public func createFolder(_ name: String) async throws { folders = try await api.createFolder(name); changed() }
    public func renameFolder(_ id: String, _ name: String) { Task { @MainActor [weak self] in do { if let s = self { s.folders = try await s.api.renameFolder(id, name); s.changed() } } catch { self?.report(error) } } }
    public func deleteFolder(_ id: String) { Task { @MainActor [weak self] in do { if let s = self { s.folders = try await s.api.deleteFolder(id); s.changed() } } catch { self?.report(error) } } }
    public func addToFolder(_ id: String, _ ids: [String]) async throws {
        folders = try await api.addToFolder(id, ids)
        if let last = ids.last { flash(last) }
        changed()
    }
    public func removeFromFolder(_ id: String, _ itemId: String) { Task { @MainActor [weak self] in do { if let s = self { s.folders = try await s.api.removeFromFolder(id, itemId); s.changed() } } catch { self?.report(error) } } }

    /// Starred: at once here, then main's answer.
    public func starRow(_ row: LibraryRow, on: Bool) {
        starred = on ? starred.filter { $0 != row.id } + [row.id] : starred.filter { $0 != row.id }
        changed()
        let api = self.api, pid = projectId
        Task { @MainActor [weak self] in do { let ids = try await api.setStarred(pid, row.id, on); self?.starred = ids; self?.changed() } catch { self?.report(error) } }
    }

    public func togglePostIts() { if active { setPostItsHidden(!postItsHidden) } }
    public func openProject(_ id: String) {
        let last = nav.recent.first { $0["projectId"]?.string == id }
        ctx.onOpenProject(id, last?["workspaceId"]?.string)
    }
    public func newProject() { ctx.onNewProject() }
    public func allProjects() { ctx.onHome() }
    public func renameProject(_ name: String) { Task { @MainActor [weak self] in await self?.renameProjectNamed(name) } }
    public func openRecent(kind: String, id: String) {
        if kind == "top" { openProjectPage() }
        else if kind == "project" { selectTopic(id) }
        else if kind == "note", let note = notesById[id] { openTab(note.id, title: note.name) }
    }
    public func panelOpened(_ kind: String) { if kind == "library" { tickWalk(1) } }
    public func openSettings(_ page: String) { ctx.onOpenSettings(page) }

    // MARK: the walkthrough (2026-10-09)

    func changeWalk(tick: [Int] = [], untick: [Int] = [], hidden: Bool = false) {
        guard let now = walk, now.object != nil else { return }
        let ticked = (now["ticked"]?.array ?? []).compactMap(\.int)
        guard let next = Walkthrough.changed(ticked, hiddenNow: now["hidden"]?.bool == true, tick: tick, untick: untick, hidden: hidden) else { return }
        var o = now.object!
        o["ticked"] = .array(next.ticked.map { .number(Double($0)) }); o["hidden"] = .bool(next.hidden)
        walk = .object(o)
        changed()
        let api = self.api, pid = projectId
        Task { @MainActor [weak self] in
            if let w = try? await api.setGettingStarted(pid, tick: next.tick, untick: next.untick, hidden: hidden), w.object != nil { self?.walk = w; self?.changed() }
        }
    }
    func tickWalk(_ n: Int) { changeWalk(tick: [n]) }
    public var walkShown: Bool { activeTab == WorkspaceTabs.ws && Walkthrough.shows(walk, workspaceId: topicId) }

    public func walkTick(_ n: Int, on: Bool) { on ? changeWalk(tick: [n]) : changeWalk(untick: [n]) }
    public func walkHide() { changeWalk(hidden: true) }
    public func walkOpenLibrary(chip: String?) { libraryRequest = ((libraryRequest?.n ?? 0) + 1, chip); tickWalk(1); changed() }
    public func walkWrite() { editor(at: 0)?.handleFocusEnd() }
    /// Step 2 (2026-10-10): @brainstorm at the end of the document, run; one already running there is not started again.
    public func walkBrainstorm() {
        let key = paneDocs[0].key
        let running = asks.values.contains { $0.progress.agent == "brainstorm" && $0.docKey == key }
        guard let editor = editor(at: 0), !running, editor.handleStartAgent("brainstorm") else { walkWrite(); return }
    }
    /// Step 3 (MATH-141): @discover on the brainstorm's result, else from the workspace at the end of the document.
    public func walkDiscover() {
        let key = paneDocs[0].key
        let running = asks.values.contains { $0.progress.agent == "discover" && $0.docKey == key }
        guard let editor = editor(at: 0), !running else { walkWrite(); return }
        if !editor.handleDiscoverLastResult(nil) && !editor.handleStartAgent("discover") { walkWrite() }
    }
    public func walkOpenPaper(_ address: String) { openLink(address) }

    // MARK: the sidebar tour (2026-10-14)

    static let tourSeenKey = "engelbart.sidebarTour.seen"
    public static let tourSteps = 3
    public var tourSeen: Bool { ctx.storage.string(forKey: Self.tourSeenKey) == "1" }
    public func startTour() { docFull = false; if railHidden { toggleRail() }; tourStep = 0; changed() }
    public func tourNext() { guard let step = tourStep else { return }; if step >= Self.tourSteps - 1 { tourClose() } else { tourStep = step + 1; changed() } }
    public func tourClose() { ctx.storage.set("1", forKey: Self.tourSeenKey); tourStep = nil; changed() }

    /// The import's "Open library": its workspace, its tab or the Workspace tab, then the tour unless seen; once per n.
    public func takeTourRequest(_ request: TourRequest?) {
        guard let request, request.n != tourTaken else { return }
        tourTaken = request.n
        if let id = request.workspaceId, index.has(id), id != topicId { selectTopic(id) }
        if let tab = request.tab { openTab(tab.id, title: tab.title) } else { showWs() }
        if !tourSeen { startTour() }
    }

    public func trashMoved(_ rect: CGRect?) { api.postItsTrashRect(active && !railHidden ? rect : nil) }

    /// What the sidebar is given now.
    public func sidebarState() -> WorkspaceSidebarState {
        let l = layout
        return WorkspaceSidebarState(
            width: l.rail, hidden: railHidden, project: project, roots: tree.workspaces, trash: tree.trash, hereId: topicId, recent: navHere.recent, visits: visits,
            notes: tree.notes, entries: entries, projectCounts: projectCounts, nodeCounts: nodeCounts, rows: railRows, activeRowId: activeRowId, flashId: flashId,
            library: findable, railIds: railIds, starred: starred, folders: folders, postItsHidden: postItsHidden, postItsToggle: active,
            trashFull: postItTrash > 0 || !tree.trash.isEmpty, postItTrashCount: postItTrash, postItDrag: postItDrag, libraryRequest: libraryRequest,
            tourStep: tourPaused ? nil : tourStep, walk: walk, walkShown: walkShown, walkPapers: paneDocs[0].key.map { Walkthrough.discoverPapers(docs[$0]) } ?? [])
    }

    // MARK: an @ menu pick

    /// An item picked from the @ menu comes into this workspace (linked as picked, MATH-57); the open page is added to
    /// the library first, under the name the mention carries.
    public func mentionPicked(_ item: MenuItem) {
        guard topic != nil else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                if item.kind == .fresh, let input = item.input { try await self.addInput(input, name: item.name, picked: true) }
                else if let row = item.row, row.id != "zotero" { try await self.linkIds([row.id], picked: true) }
            } catch { self.report(error) }
        }
    }
}
