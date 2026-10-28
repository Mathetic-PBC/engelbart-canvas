import Foundation
import EngelbartCore
import EngelbartStage

// The announcements Workspace.jsx listens to (api.on…), and the post-its' side (ProjectPostIts, PostItBuild, PostItTask).
extension WorkspaceModel {
    func subscribe() {
        let hub = ctx.hub
        func on(_ name: String, _ handle: @escaping (WorkspaceModel, JSONValue) -> Void) {
            hubTokens.append(hub.on(name) { [weak self] payload in
                MainActor.assumeIsolated { if let self, self.live { handle(self, payload) } }
            })
        }
        on(WorkspaceEvents.docChanged) { $0.announced($1) }
        on(WorkspaceEvents.bartProgress) { $0.onBartProgress($1) }
        on(WorkspaceEvents.paperAskDone) { $0.onPaperAskDone($1) }
        on(WorkspaceEvents.modelsChanged) { m, _ in m.loadBartModels() }
        on(WorkspaceEvents.build) { $0.onBuild($1) }
        on(WorkspaceEvents.buildProgress) { $0.onBuildProgress($1) }
        on(WorkspaceEvents.buildDiff) { $0.onBuildDiff($1) }
        on(WorkspaceEvents.buildRun) { $0.onBuildRun($1) }
        on(WorkspaceEvents.buildQuick) { $0.onBuildQuick($1) }
        on(WorkspaceEvents.buildQuickOpen) { $0.onBuildQuickOpen($1) }
        on(WorkspaceEvents.nav) { m, _ in m.loadNav() }
        on(WorkspaceEvents.starred) { m, change in
            if change["projectId"]?.string == m.projectId, let ids = change["ids"]?.array { m.starred = ids.compactMap(\.string); m.changed() }
        }
        on(WorkspaceEvents.folders) { m, change in if let list = change["folders"]?.array { m.folders = list; m.changed() } }
        on(WorkspaceEvents.zoteroFinding) { m, e in
            guard let key = e["key"]?.string else { return }
            if e["finding"]?.bool == true { m.zoteroFinding.insert(key) } else { m.zoteroFinding.remove(key) }
            m.changed()
        }
        on(WorkspaceEvents.zoteroWaiting) { m, e in
            guard let key = e["key"]?.string else { return }
            if e["waiting"]?.bool == true { m.zoteroWaiting.insert(key) } else { m.zoteroWaiting.remove(key) }
            m.changed()
        }
        on(WorkspaceEvents.zoteroDownloaded) { m, found in if m.active, m.windowIsKey(), let path = found["path"]?.string { m.openZoteroPdf(path) } }
        on(WorkspaceEvents.agentReveal) { m, _ in
            let api = m.api, pid = m.projectId
            Task { @MainActor [weak m] in if let target = await api.takeAgentReveal(pid) { m?.revealAsk(target) } }
        }
        on(WorkspaceEvents.openSandboxTerminal) { m, e in if m.windowIsKey() { m.onSandboxTerminal(e) } }
        // ⌘J pressed in a page on the Stage (main/browser/views.cjs forwards it).
        on(WorkspaceEvents.nextWorkspace) { m, _ in if m.active, m.windowIsKey() { m.goNextAgent() } }
        // A link clicked in the terminal opens on the Stage (which adds the tab itself); the pane turns to show it.
        on(WorkspaceEvents.openInBrowser) { m, _ in if m.windowIsKey() { m.showRight("stage") } }
        // What the window itself would open in a new window or tab: to the Stage while this listens (index.cjs 2026-10-02).
        on(WorkspaceEvents.stageOpenLink) { m, link in if m.active, m.windowIsKey(), let url = link["url"]?.string { m.openLink(url, newTab: link["newTab"]?.bool == true) } }
    }
}

extension WorkspaceModel: WorkspacePostItsHost {
    public func postItsShown() { setPostItsHidden(false) }
    public func postItsDrag(active: Bool, over: Bool) { postItDrag = (active, over); changed() }
    public func postItsTrashCount(_ n: Int) { if n != postItTrash { postItTrash = n; changed() } }
    /// +Note on a card: a note in no workspace, opened here as a tab once the library knows it.
    public func postItsOpenNote(id: String, name: String) { Task { @MainActor [weak self] in await self?.reload(); self?.openTab(id, title: name) } }
    public func postItsOpenLink(_ url: String) { openLink(url) }
    public func postItsStartQuick(_ input: JSONValue) async throws { try await startQuick(input) }
    public func postItsCloseBuild() { postItBuild = nil; changed() }
    public func postItsQuickAction(_ action: String) async -> Bool {
        guard let id = quickTask?.id else { return false }
        return await onBuildAction(id, action)
    }
    public func postItsPromote(workspaceId: String, choice: JSONValue?) async throws -> JSONValue {
        guard let id = quickTask?.id else { throw WorkspaceError("No quick task is open") }
        return try await promoteQuick(id, workspaceId: workspaceId, choice: choice)
    }
    public func postItsGoToTask(_ task: JSONValue) { goToTask(task) }
    public func postItsThrowOut(postItId: String) {
        let api = self.api, pid = projectId
        Task { @MainActor [weak self] in do { try await api.postItsThrowOut(pid, postItId) } catch { self?.report(error) } }
    }
    public func postItsCloseQuick() { quickTask = nil; changed() }

    /// What the post-its are given now.
    public func postItsState() -> WorkspacePostItsState {
        let task = quickTask.flatMap { q in builds[q.id].map { (task: $0, progress: buildProgress[q.id], anchor: q.anchor) } }
        return WorkspacePostItsState(projectId: projectId, active: active, hidden: postItsHidden, buildPopup: postItBuild, quickTask: task,
                                     workspaces: Nav.flatWorkspaces(tree.workspaces), hereId: topicId)
    }
}
