import Foundation
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartSandbox

// Workspace.jsx "next place", "agents, pages, folders" and "the Agent Viewer": state.json's recent workspaces and agents,
// the Agents list the sidebar draws (the Inbox folded in, 2026-10-13), going to an agent, ⌘J, Ctrl+1–9, the @ menu's rows.
extension WorkspaceModel {
    func loadNav() {
        let api = self.api
        Task { @MainActor [weak self] in
            if let n = try? await api.nav(), let self, self.live { self.nav = n; self.seeAgentsHere(); self.changed() }
        }
    }

    /// Being in a workspace is looking at whatever an agent left there.
    func seeAgentsHere() {
        guard active, let wid = topicId else { return }
        if nav.agents.contains(where: { $0["status"]?.string == "waiting" && $0["projectId"]?.string == projectId && $0["workspaceId"]?.string == wid }) {
            let api = self.api, pid = projectId
            Task { await api.seenAgents(pid, wid) }
        }
    }

    /// The next row and ⌘J go only to this project's workspaces (2026-10-01).
    public var navHere: NavState { nav.only(projectId) }

    /// Where ⌘J goes when no agent waits: the next place, named from the tree (current after a rename).
    public var nextPlace: Place? {
        let here = topicId.map { (projectId: projectId, workspaceId: $0) }
        guard var place = Nav.nextPlace(here: here, recent: navHere.recent, agents: navHere.agents), let at = index[place.workspaceId] else { return nil }
        place.name = at.node.name
        return place
    }

    /// The Agents list: this project's asks, Builds and Connect notes, and the repositories' builds; kept by this machine's
    /// marks (3 days, a day after a click, × until it changes).
    public var entries: [AgentEntry] {
        let repos = ctx.sandboxes.map { s in Agents.repoEntries(SandboxNotifications.available(s.notifications, s.items), items: s.items, library: library) } ?? []
        let all = Agents.entries(agents: navHere.agents, builds: Array(builds.values), connect: connectNotes, projectId: projectId) + repos
        return Agents.kept(all, marks: agentMarks, now: minute.timeIntervalSince1970 * 1000)
    }

    /// The count of each other top-level project (from state.json's agents) and of this one.
    public var projectCounts: [String: AgentSummary] {
        var by: [String: [AgentEntry]] = [:]
        for a in nav.agents {
            guard let pid = a["projectId"]?.string, pid != projectId else { continue }
            let status = a["status"]?.string
            guard status == "running" || status == "waiting" else { continue }
            let running = status == "running"
            by[pid, default: []].append(AgentEntry(id: "agent:\(a["id"]?.string ?? "")", kind: a["kind"]?.string ?? "bart", title: "", node: nil, state: running ? "running" : "unseen",
                                                   at: running ? a["started"]?.string : (a["finished"]?.string ?? a["started"]?.string)))
        }
        var out = by.mapValues { Agents.summarize(Agents.kept($0, marks: agentMarks, now: minute.timeIntervalSince1970 * 1000)) }
        out[projectId] = Agents.summarize(entries)
        return out
    }
    public var nodeCounts: [String: AgentSummary] { Agents.rollUp(index, entries) }

    func markAgentRow(_ id: String, _ what: String) {
        agentMarks = Agents.mark(agentMarks, id, what)
        let json = JSONValue.object(agentMarks.mapValues { .object($0.mapValues { .string($0) }) })
        ctx.storage.set(json.text(), forKey: Self.agentMarksKey)
        changed()
    }

    /// Going to an agent (2026-10-16): an ask, the note or project it was asked in; a Build, its card, or its archived
    /// version; a quick task, its card with the stickies in sight; a repository's build, its preview / terminal / details;
    /// a Connect note, its popup. The row is marked clicked.
    public func goAgent(_ entry: AgentEntry, rect: CGRect? = nil) {
        markAgentRow(entry.id, "clicked")
        if entry.kind == "connect" { if let s = entry.sessionId { ctx.onOpenConnect(s) }; return }
        if entry.kind == "repo" {
            guard let sandboxes = ctx.sandboxes else { return }
            if let n = entry.notification { sandboxes.markRead([n.id]) }
            if SandboxNotifications.canOpenPreview(entry.run), let run = entry.run { sandboxes.open(run) }
            else if SandboxNotifications.canOpenTerminal(entry.run), let run = entry.run { sandboxes.openTerminal(run) }
            else if let repo = entry.repo { sandboxes.openBuild(repo) }
            return
        }
        if let task = entry.task, task["kind"]?.string == "quick" {
            setPostItsHidden(false)
            postItBuild = nil
            quickTask = (task["id"]?.string ?? "", task["postItId"]?.string, rect)
            changed()
            return
        }
        if let task = entry.task, let wid = task["workspaceId"]?.string, index.has(wid) {
            let version = task["version"].flatMap { $0.isNull ? nil : $0 }
            revealAsk(["place": ["projectId": .string(projectId), "ref": ["kind": "workspace", "workspaceId": .string(wid)]], "buildId": task["id"] ?? .null, "flash": false],
                      onMissing: version.map { v in { [weak self] in Task { @MainActor in await self?.goToVersion(wid, file: v["file"]?.string ?? "", title: v["title"]?.string ?? "") } } })
            return
        }
        if let doc = entry.doc {
            // a note asked in from a project: that project, with the note in front
            if doc["kind"]?.string == "note", let node = entry.node, index.has(node), node != topicId { selectTopic(node) }
            revealAsk(["place": ["projectId": .string(projectId), "ref": doc], "flash": false])
            return
        }
        if let node = entry.node, index.has(node) { selectTopic(node) }
    }

    /// A row's × (2026-10-16): put away until it changes again; a finished Connect note dismissed; a repo's note cleared.
    public func dismissAgent(_ entry: AgentEntry) {
        markAgentRow(entry.id, "dismissed")
        if entry.kind == "connect", entry.state != "running", let s = entry.sessionId { let api = self.api; Task { await api.connectDismiss(s) } }
        if entry.kind == "repo", let n = entry.notification { ctx.sandboxes?.clear([n.id]) }
    }

    /// ⌘J (2026-10-13: "Next agent needing attention"): what failed, then what needs you, then what finished, oldest
    /// first, never the one just gone to; with nothing waiting, the workspace written in before.
    public func goNextAgent() {
        if let first = Agents.queue(entries, last: lastAgent, index: index).first {
            lastAgent = first.id
            goAgent(first)
            return
        }
        lastAgent = nil
        if let place = nextPlace { selectTopic(place.workspaceId) }
    }

    /// Mark all seen.
    public func seenAll() {
        let list = entries
        let api = self.api, pid = projectId
        for node in Set(list.filter { $0.state == "unseen" && $0.node != nil }.compactMap(\.node)) { Task { await api.seenAgents(pid, node) } }
        for n in connectNotes where n.tone == "done" { Task { await api.connectDismiss(n.sessionId) } }
        let unseen = list.filter { $0.state == "unseen" && !$0.viewed }.map(\.id)
        if !unseen.isEmpty {
            var marks = agentMarks
            for id in unseen { marks = Agents.mark(marks, id, "clicked") }
            agentMarks = marks
            ctx.storage.set(JSONValue.object(marks.mapValues { .object($0.mapValues { .string($0) }) }).text(), forKey: Self.agentMarksKey)
        }
        let unread = list.filter { $0.kind == "repo" && !$0.viewed }.compactMap { $0.notification?.id }
        if !unread.isEmpty { ctx.sandboxes?.markRead(unread) }
        changed()
    }

    /// Ctrl+1–9 (2026-10-13): this project's top-level workspaces, in order.
    public func goShortcut(_ n: Int) -> Bool {
        let ids = Visits.shortcutProjects(tree.workspaces)
        guard n >= 1, n <= ids.count else { return false }
        selectTopic(ids[n - 1])
        return true
    }

    /// A row clicked in the Agent Viewer (2026-10-12) or Agents: the workspace or note the ask was on comes to the front
    /// and its line is shown and lit up; a highlight's paper opens on the Stage at its passage; a Build with no line of its
    /// own shows its card. A line that is gone says so. `flash: false` shows it without lighting it up.
    public func revealAsk(_ target: JSONValue, onMissing: (() -> Void)? = nil) {
        guard let place = target["place"], place["projectId"]?.string == projectId, let ref = place["ref"], !ref.isNull else { return }
        let routedTo = target["routedTo"]?.string, buildId = target["buildId"]?.string
        if ref["kind"]?.string == "mark" {
            let row = ref["rowId"]?.string.flatMap { id in library.first { $0.id == id } }
            guard let stage, row != nil || ref["url"]?.string != nil else { report("This highlight's paper is no longer here"); return }
            showRight("stage")
            if let row { stage.openRow(Self.stageRow(row), find: place["quote"]?.string ?? "") } else if let url = ref["url"]?.string { stage.openInput(url) }
            return
        }
        let key: String
        if ref["kind"]?.string == "note" {
            guard let id = ref["id"]?.string, let note = notesById[id] else { report("This note is no longer here"); return }
            openTab(note.id, title: note.name)
            key = "note:\(note.id)"
        } else {
            guard let wid = ref["workspaceId"]?.string, index.has(wid) else { report("This workspace is no longer here"); return }
            selectTopic(wid)
            showWs()
            key = "ws:\(wid)"
        }
        let text = place["text"]?.string, line = place["line"]?.int
        let flash = target["flash"]?.bool != false
        retry(every: 0.1, tries: 60) { [weak self] in
            guard let self, let editor = self.editor(for: key), self.docs[key] != nil else { return false }
            let lines = editor.handleLines
            var at = text.map { AskLine.findAskLine(lines, text: $0, line: line, routedTo: routedTo) } ?? -1
            if at < 0, let buildId { at = AskLine.findBuildLine(lines, buildId) }
            if at < 0 {
                if let onMissing { onMissing() } else if text != nil { self.report("This line is no longer here") }
                return true
            }
            self.retry(every: 0.1, tries: 20, first: 0.05) { editor.handleShowLine(at, flash: flash) }
            return true
        }
    }

    // MARK: the @ menu

    /// The project's workspaces for the @ menu, the ones written in last first, then the tree's order.
    public var mentionSpaces: [Nav.Flat] {
        var order: [String: Int] = [:]
        for (i, entry) in nav.recent.enumerated() where entry["projectId"]?.string == projectId {
            if let wid = entry["workspaceId"]?.string, order[wid] == nil { order[wid] = i }
        }
        return Nav.flatWorkspaces(tree.workspaces).enumerated().sorted { a, b in
            let ra = order[a.element.id] ?? Int.max, rb = order[b.element.id] ?? Int.max
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    /// The @ menu's rows for `query` (MATH-29 bodies while it is open).
    public func mentionItems(_ query: String) -> [MenuItem] {
        let known = pageKnown
        let page = known != nil ? openPage.map { MentionRows.Page(input: $0.input, title: $0.title) } : nil
        return MentionRows.rows(query: query, library: findable.map(\.libRow), page: page, pageRow: known?.row?.libRow, workspaces: mentionSpaces, hereId: topicId,
                                bodies: mentionBodies, zotero: ctx.zoteroConnected(), here: railIds)
    }

    /// The @ menu opened or shut: what the project's things say is read while it is open.
    public func setMentionOpen(_ open: Bool) {
        guard open != mentionOpen else { return }
        mentionOpen = open
        guard open else { return }
        let api = self.api, pid = projectId
        Task { @MainActor [weak self] in
            if let b = try? await api.libraryBodies(pid), let self, self.mentionOpen { self.mentionBodies = b }
        }
    }

    /// A mentioned workspace's peek (workspace/WorkspacePeek.jsx): its name, the workspaces above it, Bart waiting or
    /// running there, when it was written in last.
    public func workspacePeek(_ id: String) -> (name: String, above: [String], bart: String?, editedAt: String?)? {
        guard let at = index[id] else { return nil }
        let theirs = nav.agents.filter { $0["projectId"]?.string == projectId && $0["workspaceId"]?.string == id }
        let bart = theirs.contains { $0["status"]?.string == "waiting" } ? "waiting" : theirs.contains { $0["status"]?.string == "running" } ? "running" : nil
        let edit = nav.recent.first { $0["projectId"]?.string == projectId && $0["workspaceId"]?.string == id }
        return (at.node.name, index.above(id), bart, edit?["at"]?.string)
    }
    /// Its document as open here (unsaved words included) or as saved.
    public func workspacePeekText(_ id: String) async -> String? {
        if let open = docs["ws:\(id)"] { return open }
        return try? await api.readDoc(projectId, .workspace(workspaceId: id))
    }
}
