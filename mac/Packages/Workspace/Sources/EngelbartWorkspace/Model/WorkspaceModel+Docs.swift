import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore

// Workspace.jsx "documents", "Clear", "Copy", "images": reading each pane's document once, saving 400 ms after typing,
// the same document saved in another window (model/doc-sync.js), Clear / Restore / Copy, pasted pictures.
extension WorkspaceModel {
    /// Every pane's document is read once, when first shown; a read under way is not asked again.
    func readMissing() {
        for pane in paneDocs {
            guard let key = pane.key, let ref = pane.ref, docs[key] == nil, !reading.contains(key) else { continue }
            reading.insert(key)
            let api = self.api, pid = projectId
            Task { @MainActor [weak self] in
                do {
                    let text: String
                    if case .archive(let wid, let file) = ref { text = try await api.readArchive(pid, wid, file) }
                    else { text = try await api.readDoc(pid, ref.store!) }
                    guard let self, self.live else { return }
                    self.reading.remove(key)
                    // A document from before the router (2026-10-12): its answered `@bart` lines become `@chat`, saved as an
                    // ordinary edit. An archived version is read as it was.
                    let moved = ref.isArchive ? (text: text, count: 0) : Doc.migrateChatLines(text)
                    if self.docs[key] == nil { self.docs[key] = moved.text }
                    if moved.count > 0 { self.changeDoc(key, ref, moved.text) }
                    self.loadImages()
                    self.changed()
                } catch {
                    self?.reading.remove(key)
                    self?.report(error)
                }
            }
        }
    }

    func takeText(_ key: String, _ text: String) {
        guard let held = docs[key], held != text else { return }
        docs[key] = text
        changed()
    }

    func putConflict(_ key: String, _ change: (text: String, revision: Double)?) {
        if let change { conflicts[key] = change } else { conflicts[key] = nil }
        changed()
    }

    /// Another window saved the document `key` (doc:changed).
    func announced(_ change: JSONValue) {
        guard change["projectId"]?.string == projectId, let key = change["key"]?.string, let text = change["text"]?.string else { return }
        docSync.announced(key, (text, change["revision"]?.double ?? 0))
    }

    /// The edits waiting for `key` go to disk now (none while the conflict notice waits for an answer).
    @discardableResult
    func flush(_ key: String) -> Task<Void, Never>? {
        guard let entry = pending[key] else { return nil }
        entry.work.cancel()
        if conflicts[key] != nil { return nil } // until Keep mine or Take theirs
        pending[key] = nil
        guard let ref = entry.ref.store else { return nil }
        docSync.saving(key)
        let api = self.api, pid = projectId, text = entry.text
        return Task { @MainActor [weak self] in
            var revision: Double?
            do { revision = try await api.writeDoc(pid, ref, text) } catch { self?.report(error) }
            self?.docSync.saved(key, revision)
        }
    }

    /// Everything open saved (before an agent reads the documents from disk).
    func flushAll() async {
        let tasks = Array(pending.keys).compactMap { flush($0) }
        for t in tasks { await t.value }
    }

    public func keepMine(_ key: String) {
        guard let held = conflicts[key] else { return }
        docSync.seen(key, held.revision)
        putConflict(key, nil)
        flush(key)
    }

    public func takeTheirs(_ key: String) {
        guard let held = conflicts[key] else { return }
        if let entry = pending[key] { entry.work.cancel(); pending[key] = nil }
        putConflict(key, nil)
        docSync.seen(key, held.revision)
        docs[key] = held.text
        changed()
    }

    /// A document's text changes: from an editor (any pane's), or from an answer (any document).
    func changeDoc(_ key: String, _ ref: PaneRef, _ text: String) {
        docs[key] = text
        pending[key]?.work.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { _ = self?.flush(key) } }
        pending[key] = (ref, text, work)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDelay, execute: work)
        loadImages()
        changed()
    }

    /// A pane's editor changed its document. Typing here makes this the workspace written in last (state.json `recent`):
    /// told at once when it was another one, then at most every half minute. `typed`: the edit came from the keyboard.
    public func onDocChange(key: String?, ref: PaneRef?, text: String, typed: Bool = true) {
        if let ref, ref.isArchive { return } // an archived version is only read
        if case .workspace(let wid)? = ref, let key { unmention(wid, before: docs[key], after: text) }
        if let key, let ref { changeDoc(key, ref, text) }
        let wrote = ref?.workspaceId ?? topicId
        let now = Date()
        guard typed, let wrote, !(lastEdit.id == wrote && now.timeIntervalSince(lastEdit.at) < 30) else { return }
        lastEdit = (wrote, now)
        let api = self.api, pid = projectId
        Task { await api.recordEdit(pid, wrote) }
    }

    // MARK: Clear, Restore, Copy

    static let conflictFirst = "This document was changed in another window: keep yours or take theirs first."

    /// Clear (B21): the workspace's document is archived and starts blank; everything it mentioned stays on the sidebar.
    public func clearDoc() async {
        guard let topic, paneDocs[0].key == "ws:\(topic.id)" else { return }
        let key = "ws:\(topic.id)"
        if conflicts[key] != nil { report(Self.conflictFirst); return }
        do {
            await flush(key)?.value
            let out = try await api.clearWorkspace(projectId, topic.id)
            docSync.seen(key, out.revision)
            docs[key] = out.text
            changed()
            await reload()
        } catch { report(error) }
    }

    /// Restore (B22): the current document is archived first, then the chosen version is the document again.
    public func restoreVersion(_ file: String) async {
        guard let topic else { return }
        let key = "ws:\(topic.id)"
        if conflicts[key] != nil { report(Self.conflictFirst); return }
        do {
            await flush(key)?.value
            let out = try await api.restoreArchive(projectId, topic.id, file)
            docSync.seen(key, out.revision)
            docs[key] = out.text
            showWs()
            await reload()
        } catch { report(error) }
    }

    /// Copy (the document's lower left): the open document with every @mentioned file's content in place, read from disk,
    /// so everything open is saved first; "Copied · n files" for 1.8 s.
    public func copyDoc() async {
        guard let ref = paneDocs[0].ref else { return }
        do {
            await flushAll()
            copied = try await api.copyDoc(projectId, ref)
            copiedWork?.cancel()
            let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.copied = nil; self?.changed() } }
            copiedWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8, execute: work)
            changed()
        } catch { report(error) }
    }

    // MARK: pictures

    /// Every `](img:<id>)` in any pane's text is read once.
    func loadImages() {
        let text = paneDocs.map { $0.key.flatMap { docs[$0] } ?? "" }.joined(separator: "\n")
        for id in WorkspaceRows.imageIds(text) where !imagesAsked.contains(id) {
            imagesAsked.insert(id)
            let api = self.api
            Task { @MainActor [weak self] in
                guard let file = try? await api.readImage(id), let image = NSImage(data: file.data) else { return }
                self?.images[id] = image
                self?.changed()
            }
        }
    }

    /// A picture pasted into a document: saved as a library row (named as its label), its id back; reload.
    public func pasteImage(_ data: Data, mime: String, name: String) async -> String? {
        do {
            let row = try await api.saveImage(projectId, data: data, mime: mime, name: name)
            imagesAsked.insert(row.id)
            if let image = NSImage(data: data) { images[row.id] = image }
            await reload()
            changed()
            return row.id
        } catch { report(error); return nil }
    }

    // MARK: the links a mention made (MATH-57)

    /// This workspace's document edited: an item the @ menu linked whose last mention went is unlinked; one unlinked that
    /// way whose mention came back (⌘Z, or typed again) is linked again.
    func unmention(_ workspaceId: String, before: String?, after: String) {
        guard let topic, workspaceId == topic.id, let before else { return } // not yet read: nothing was removed
        if !before.contains("@[") && !after.contains("@[") { return }
        let rows = library.map(\.libRow)
        let prefix = "\(topic.id) "
        let mine = Set(dropped.filter { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) })
        let change = MentionRows.pickedChanges(before: Mention.mentionedIds(before, rows), after: Mention.mentionedIds(after, rows), picked: topic.picked, dropped: mine)
        let api = self.api, pid = projectId
        for id in change.unlink {
            dropped.insert(prefix + id)
            Task { @MainActor [weak self] in
                do { try await api.unlinkFromWorkspace(pid, topic.id, id, unmentioned: true); await self?.reload() } catch { self?.report(error) }
            }
        }
        for id in change.relink { dropped.remove(prefix + id) }
        if !change.relink.isEmpty { Task { @MainActor [weak self] in do { try await self?.linkIds(change.relink, picked: true) } catch { self?.report(error) } } }
    }
}
