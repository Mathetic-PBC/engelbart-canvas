import Foundation
import EngelbartCore
import EngelbartStore

// src/renderer/model/sidebar.js, whole. Pure: the project's tree, state.json's `recent` and `agents`, the Builds and the
// project's rows come in; what each part of the sidebar lists goes out. SidebarView draws it.
//
// 2026-10-13, the "Sidebar" project and its mockup (design/sidebar-mockup/Sidebar.html, "exactly how I want it"). What
// were workspaces are projects now, nested under the top-level project the switcher picks, four levels in all: level 1 the
// switcher's, levels 2 to 4 the Projects section's (roots are level 2). The section shows at most three level-2 projects,
// a stable shortlist that a click never reorders, and ten rows in all, counting what is open under them and every More;
// a group of siblings shows five, or four and More; one path is open at a time. Every row counts the agents running or
// waiting under it, each agent once.

/// JavaScript's `Date.parse` for the ISO times the stores write, in ms; nil where JS answers NaN.
public enum JSTime {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    private static let dateOnly: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate]; return f
    }()
    public static func parse(_ iso: String?) -> Double? {
        guard let s = iso?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if let d = withFraction.date(from: s) ?? plain.date(from: s) { return (d.timeIntervalSince1970 * 1000).rounded() }
        if s.count == 10, let d = dateOnly.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        // "2026-10-13T10:00:00" with no zone: JS reads it as local time.
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        for format in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
            local.dateFormat = format
            if let d = local.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        }
        return nil
    }
    /// sidebar.js `time`: 0 for no time.
    public static func ms(_ iso: String?) -> Double { parse(iso) ?? 0 }
    /// `new Date(ms).toISOString()`.
    public static func iso(_ ms: Double) -> String { withFraction.string(from: Date(timeIntervalSince1970: ms / 1000)) }
    public static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
}

/// A project of the tree (a workspace on disk): what the sidebar reads of the Store's WorkspaceNode.
public struct ProjectNode: Equatable, Sendable {
    public var id: String
    public var name: String
    /// When its document was last saved.
    public var edited: String?
    /// Its archived versions (one per Clear).
    public var archives: [ArchiveEntry]
    public var children: [ProjectNode]
    public init(id: String, name: String, edited: String? = nil, archives: [ArchiveEntry] = [], children: [ProjectNode] = []) {
        self.id = id; self.name = name; self.edited = edited; self.archives = archives; self.children = children
    }
    public init(_ node: WorkspaceNode) {
        self.init(id: node.id, name: node.name, edited: node.edited, archives: node.archives, children: node.children.map(ProjectNode.init))
    }
}

/// One project of the index: { node, parent (an id or nil), level (2 at the top of the section), path (ids from level 2 down to it) }.
public struct TreeEntry: Equatable, Sendable {
    public var node: ProjectNode
    public var parent: String?
    public var level: Int
    public var path: [String]
}

/// `indexTree`'s Map, in insertion order (the tree's, depth first).
public struct TreeIndex: Equatable, Sendable {
    public private(set) var ids: [String] = []
    private var byId: [String: TreeEntry] = [:]
    public init() {}
    public subscript(_ id: String?) -> TreeEntry? { id.flatMap { byId[$0] } }
    public func has(_ id: String?) -> Bool { id.map { byId[$0] != nil } ?? false }
    public var count: Int { ids.count }
    public var values: [TreeEntry] { ids.compactMap { byId[$0] } }
    mutating func set(_ id: String, _ entry: TreeEntry) { if byId[id] == nil { ids.append(id) }; byId[id] = entry }
}

/// A count: the agents running and the ones to look at.
public struct AgentSummary: Equatable, Sendable {
    public var total: Int
    public var running: Int
    public var ready: Int
    public init(total: Int = 0, running: Int = 0, ready: Int = 0) { self.total = total; self.running = running; self.ready = ready }
}

/// One of state.json's `agents` (main/store: agentStarted/agentFinished).
public struct NavAgent: Equatable, Sendable {
    public var id: String
    public var kind: String
    public var projectId: String
    public var workspaceId: String?
    public var status: String
    public var started: String?
    public var finished: String?
    public var doc: JSONValue?
    public var name: String?
    public var path: String?
    public var projectName: String?
    public init(id: String, kind: String = "bart", projectId: String, workspaceId: String? = nil, status: String, started: String? = nil,
                finished: String? = nil, doc: JSONValue? = nil, name: String? = nil, path: String? = nil, projectName: String? = nil) {
        self.id = id; self.kind = kind; self.projectId = projectId; self.workspaceId = workspaceId; self.status = status; self.started = started
        self.finished = finished; self.doc = doc; self.name = name; self.path = path; self.projectName = projectName
    }
    public init?(json: JSONValue) {
        guard let id = json["id"]?.string else { return nil }
        self.init(id: id, kind: json["kind"]?.string ?? "bart", projectId: json["projectId"]?.string ?? "", workspaceId: json["workspaceId"]?.string,
                  status: json["status"]?.string ?? "", started: json["started"]?.string, finished: json["finished"]?.string,
                  doc: json["doc"].flatMap { $0.isNull ? nil : $0 }, name: json["name"]?.string, path: json["path"]?.string, projectName: json["projectName"]?.string)
    }
}

/// One of state.json's `recent` (the places written in last).
public struct RecentPlace: Equatable, Sendable {
    public var projectId: String
    public var workspaceId: String?
    public var at: String?
    public var name: String?
    public var path: String?
    public var projectName: String?
    public init(projectId: String, workspaceId: String?, at: String? = nil, name: String? = nil, path: String? = nil, projectName: String? = nil) {
        self.projectId = projectId; self.workspaceId = workspaceId; self.at = at; self.name = name; self.path = path; self.projectName = projectName
    }
    public init?(json: JSONValue) {
        guard let pid = json["projectId"]?.string else { return nil }
        self.init(projectId: pid, workspaceId: json["workspaceId"]?.string, at: json["at"]?.string, name: json["name"]?.string,
                  path: json["path"]?.string, projectName: json["projectName"]?.string)
    }
}

/// A Build's record as the Agents list reads it (main/build task.json).
public struct BuildInfo: Equatable, Sendable {
    public var id: String
    public var kind: String?
    public var projectId: String
    public var workspaceId: String?
    public var title: String?
    public var status: String
    public var updated: String?
    public var created: String?
    public var postItId: String?
    /// `{ file, title }` when its card was archived by a Clear.
    public var version: JSONValue?
    public init(id: String, kind: String? = "build", projectId: String, workspaceId: String? = nil, title: String? = nil, status: String,
                updated: String? = nil, created: String? = nil, postItId: String? = nil, version: JSONValue? = nil) {
        self.id = id; self.kind = kind; self.projectId = projectId; self.workspaceId = workspaceId; self.title = title; self.status = status
        self.updated = updated; self.created = created; self.postItId = postItId; self.version = version
    }
    public init?(json: JSONValue) {
        guard let id = json["id"]?.string else { return nil }
        self.init(id: id, kind: json["kind"]?.string, projectId: json["projectId"]?.string ?? "", workspaceId: json["workspaceId"]?.string,
                  title: json["title"]?.string, status: json["status"]?.string ?? "", updated: json["updated"]?.string, created: json["created"]?.string,
                  postItId: json["postItId"]?.string, version: json["version"].flatMap { $0.isNull ? nil : $0 })
    }
}

/// A Connect your library note (model/connect.js connectInbox, with its dockLine tone).
public struct ConnectNote: Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var name: String?
    public var did: String?
    public var tone: String?
    public var at: String?
    public init(id: String, sessionId: String, name: String? = nil, did: String? = nil, tone: String? = nil, at: String? = nil) {
        self.id = id; self.sessionId = sessionId; self.name = name; self.did = did; self.tone = tone; self.at = at
    }
}

/// A repository build the bell holds (ui/SandboxNotifications.jsx).
public struct RepoNotification: Equatable, Sendable {
    public var id: String
    public var libraryId: String
    public var at: String?
    public var read: Bool
    public init(id: String, libraryId: String, at: String? = nil, read: Bool = false) { self.id = id; self.libraryId = libraryId; self.at = at; self.read = read }
}

/// What the bell knows of a repository: its run (`status` at least) and its sandbox's state.
public struct RepoItem: Equatable, Sendable {
    public var run: JSONValue
    public var sandbox: JSONValue?
    public init(run: JSONValue, sandbox: JSONValue? = nil) { self.run = run; self.sandbox = sandbox }
}

/// A row of Agents.
public struct AgentEntry: Equatable, Sendable {
    public var id: String
    /// bart, brainstorm, discover, create, build, quick, connect, repo
    public var kind: String
    public var title: String
    /// The project it is in, or nil.
    public var node: String?
    public var doc: JSONValue?
    /// running | needs | unseen | failed | done
    public var state: String
    /// A Build's state in its card's words.
    public var status: String?
    public var at: String?
    public var task: BuildInfo?
    public var did: String?
    public var sessionId: String?
    public var viewed: Bool = false
    public var notification: RepoNotification?
    public var run: JSONValue?
    public var sandbox: JSONValue?
    public var repo: LibraryRow?
    public init(id: String, kind: String = "bart", title: String = "", node: String? = nil, doc: JSONValue? = nil, state: String, status: String? = nil,
                at: String? = nil, task: BuildInfo? = nil, did: String? = nil, sessionId: String? = nil, viewed: Bool = false,
                notification: RepoNotification? = nil, run: JSONValue? = nil, sandbox: JSONValue? = nil, repo: LibraryRow? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.node = node; self.doc = doc; self.state = state; self.status = status; self.at = at
        self.task = task; self.did = did; self.sessionId = sessionId; self.viewed = viewed; self.notification = notification; self.run = run
        self.sandbox = sandbox; self.repo = repo
    }
}

/// A row clicked or put away (`marks[id]`).
public struct AgentMark: Codable, Equatable, Sendable {
    public var clicked: String?
    public var dismissed: String?
    public init(clicked: String? = nil, dismissed: String? = nil) { self.clicked = clicked; self.dismissed = dismissed }
}

/// A page opened (the clock's list).
public struct Visit: Codable, Equatable, Sendable {
    public var kind: String
    public var id: String
    public var at: String
    public init(kind: String, id: String, at: String) { self.kind = kind; self.id = id; self.at = at }
}

/// The section's rows (projectPlan).
public struct ProjectPlan: Equatable, Sendable {
    public var order: [String]
    public var shown: Set<String>
    /// Level-2 ids behind the section's More.
    public var hidden: [String]
    /// Ids in the order drawn.
    public var visible: [String]
    /// Open rows that show some of what is in them, in the order drawn.
    public var opened: [String]
    /// The deepest of those: the one whose children get the guide line.
    public var guide: String?
    /// Lines used.
    public var rows: Int
}

/// An archived version of a project (one per Clear).
public struct ArchivedVersion: Equatable, Sendable {
    public var workspaceId: String
    public var name: String
    public var file: String
    public var title: String
    public var clearedAt: String?
}

/// A page of the clock's list.
public struct RecentPage: Equatable, Hashable, Sendable {
    public var kind: String // top | project | note
    public var id: String
}

public enum SidebarModel {
    public static let MAX_DEPTH = 4
    public static let ROOT_ROWS = 3
    public static let PROJECT_ROWS = 10
    public static let LEVEL_ROWS = 5
    public static let RECENT_PAGES = 10
    public static let SHORTCUTS = 9

    static func time(_ iso: String?) -> Double { JSTime.ms(iso) }

    /* ---------------------------------------------------------------- the tree */

    public static func indexTree(_ roots: [ProjectNode]) -> TreeIndex {
        var index = TreeIndex()
        func walk(_ list: [ProjectNode], _ parent: String?, _ level: Int, _ above: [String]) {
            for node in list {
                let path = above + [node.id]
                index.set(node.id, TreeEntry(node: node, parent: parent, level: level, path: path))
                walk(node.children, node.id, level + 1, path)
            }
        }
        walk(roots, nil, 2, [])
        return index
    }

    static func kidsOf(_ index: TreeIndex, _ id: String?) -> [ProjectNode] { index[id]?.node.children ?? [] }
    static func childIds(_ index: TreeIndex, _ id: String?) -> [String] { kidsOf(index, id).map(\.id) }

    /// Whether `id` is `from` or lies under it.
    public static func within(_ index: TreeIndex, _ id: String, _ from: String) -> Bool { index[id]?.path.contains(from) ?? false }

    /// What is open when `id` is gone to: the way down to it, and it too when it has projects in it.
    public static func openPath(_ index: TreeIndex, _ id: String?) -> Set<String> {
        guard let at = index[id] else { return [] }
        var open = Set(at.path)
        if kidsOf(index, id).isEmpty { open.remove(at.node.id) }
        return open
    }

    /// A chevron's press: open folds what is under it; folded opens, folding its siblings and what is under them.
    public static func toggleOpen(_ index: TreeIndex, _ expanded: Set<String>, _ id: String) -> Set<String> {
        var next = expanded
        guard let at = index[id] else { return next }
        if next.contains(id) && !kidsOf(index, id).isEmpty {
            for held in next where within(index, held, id) { next.remove(held) }
            return next
        }
        let siblings = at.parent != nil ? childIds(index, at.parent) : index.values.filter { $0.level == 2 }.map(\.node.id)
        for sibling in siblings where sibling != id { for held in next where within(index, held, sibling) { next.remove(held) } }
        next.insert(id)
        return next
    }

    /// The level-2 projects the section shows (at most `rootRows`), in the tree's order; `held` the shortlist as it was.
    public static func projectSlots(roots: [ProjectNode], index: TreeIndex, focusId: String? = nil, held: [String]? = nil,
                                    recency: [String: Double] = [:], rootRows: Int = ROOT_ROWS) -> [String] {
        let tops = roots.map(\.id)
        let branch = index[focusId]?.path.first
        var slots = (held ?? []).filter { tops.contains($0) }
        if let branch, !slots.contains(branch) { slots = Array(slots.prefix(max(0, rootRows - 1))) + [branch] }
        if slots.count < rootRows {
            let rest = tops.enumerated().filter { !slots.contains($0.element) }.map { (id: $0.element, i: $0.offset, at: recency[$0.element] ?? 0) }
                .sorted { $0.at != $1.at ? $0.at > $1.at : $0.i < $1.i }
            slots += rest.prefix(rootRows - slots.count).map(\.id)
        }
        return Array(tops.filter { slots.contains($0) }.prefix(rootRows))
    }

    /// The section's rows (the mockup's sectionPlan).
    public static func projectPlan(index: TreeIndex, order: [String], expanded: Set<String>, rows budget: Int = PROJECT_ROWS, levelRows: Int = LEVEL_ROWS) -> ProjectPlan {
        func isOpen(_ id: String) -> Bool { expanded.contains(id) && !kidsOf(index, id).isEmpty }
        let tops = index.values.filter { $0.level == 2 }.map(\.node.id)
        var shown = Set(order)
        let hidden = tops.filter { !shown.contains($0) }
        func visible(_ id: String) -> Bool { (index[id]?.path.dropLast() ?? []).allSatisfy(isOpen) }
        func lines() -> Int {
            var count = shown.count + (hidden.isEmpty ? 0 : 1)
            for id in shown {
                let kids = childIds(index, id), seen = kids.filter { shown.contains($0) }.count
                if isOpen(id) && seen > 0 && seen < kids.count { count += 1 } // its More
            }
            return count
        }
        var candidates: [String] = []
        func add(_ ids: [String]) { for id in ids where !candidates.contains(id) { candidates.append(id) } }
        func visit(_ id: String) { if isOpen(id) { add(childIds(index, id)); childIds(index, id).forEach(visit) } }
        order.forEach(visit)
        var grew = true
        while grew {
            grew = false
            for id in candidates {
                guard let at = index[id] else { continue }
                if shown.contains(id) || !visible(id) || !(at.parent.map { shown.contains($0) } ?? false) { continue }
                let siblings = childIds(index, at.parent)
                let limit = siblings.count > levelRows ? levelRows - 1 : levelRows
                if siblings.filter({ shown.contains($0) }).count >= limit { continue }
                shown.insert(id)
                if lines() > budget { shown.remove(id) } else { grew = true }
            }
        }
        var drawn: [String] = []
        var opened: [String] = []
        func walk(_ id: String) {
            drawn.append(id)
            if !isOpen(id) { return }
            let kids = childIds(index, id).filter { shown.contains($0) }
            if !kids.isEmpty { opened.append(id) }
            kids.forEach(walk)
        }
        order.forEach(walk)
        var guide: String? = nil
        var deepest = Int.min
        for id in opened { let level = index[id]?.level ?? 0; if level > deepest { deepest = level; guide = id } }
        return ProjectPlan(order: order, shown: shown, hidden: hidden, visible: drawn, opened: opened, guide: guide, rows: lines())
    }

    /// Ctrl+1–9: the level-2 projects, in the tree's order.
    public static func shortcutProjects(_ roots: [ProjectNode]) -> [String] { Array(roots.prefix(SHORTCUTS)).map(\.id) }
    /// A level-2 project's number for Ctrl+number, or 0.
    public static func shortcutOf(_ roots: [ProjectNode], _ id: String) -> Int {
        guard let at = shortcutProjects(roots).firstIndex(of: id) else { return 0 }
        return at + 1
    }

    /* ------------------------------------------------------ agents and counts */

    static let BUILD_RUNNING: Set<String> = ["setting-up", "queued", "running", "accepting"]
    static let BUILD_NEEDS: Set<String> = ["needs-you", "review"]
    static let BUILD_FAILED: Set<String> = ["failed", "conflict", "interrupted", "escalated"]
    /// A Build's place in the Agents list: running, needs, failed, or done.
    public static func buildState(_ status: String) -> String {
        if BUILD_RUNNING.contains(status) { return "running" }
        if BUILD_NEEDS.contains(status) { return "needs" }
        if BUILD_FAILED.contains(status) { return "failed" }
        return "done"
    }

    public static let AGENT_DID = ["bart": "Bart answered", "brainstorm": "Brainstorm asked", "discover": "Discover found reading", "create": "Create made a file", "build": "Build finished a turn"]
    public static let AGENT_NAME = ["bart": "Bart", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create", "build": "Build"]
    /// A Build's state, in the words its card uses (DocEditor.jsx BUILD_STATUS).
    public static let BUILD_STATE = ["setting-up": "Setting up", "queued": "Waiting for a slot", "running": "Working", "needs-you": "Needs you", "review": "Ready to review",
                                     "stopped": "Stopped", "failed": "Failed", "escalated": "Too big for a quick task", "interrupted": "Interrupted", "accepting": "Accepting",
                                     "conflict": "Conflict", "accepted": "Accepted", "discarded": "Discarded"]

    /// Newest first, ties in the order given (JS sort is stable).
    static func newestFirst<T>(_ list: [T], _ at: (T) -> String?) -> [T] {
        list.enumerated().sorted { a, b in
            let ta = time(at(a.element)), tb = time(at(b.element))
            return ta != tb ? ta > tb : a.offset < b.offset
        }.map(\.element)
    }

    /// The Agents list, the Inbox folded into it: this project's asks (running, or waiting = unseen), its Builds by where
    /// they stand, and Connect your library's notes. Newest first.
    public static func agentEntries(agents: [NavAgent] = [], builds: [BuildInfo] = [], connect: [ConnectNote] = [], projectId: String) -> [AgentEntry] {
        var out: [AgentEntry] = []
        for agent in agents {
            if agent.projectId != projectId || agent.kind == "build" { continue }
            if agent.status != "running" && agent.status != "waiting" { continue }
            let running = agent.status == "running"
            out.append(AgentEntry(id: "agent:\(agent.id)", kind: agent.kind, title: AGENT_NAME[agent.kind] ?? "Agent", node: agent.workspaceId, doc: agent.doc,
                                  state: running ? "running" : "unseen", at: running ? agent.started : (agent.finished ?? agent.started)))
        }
        for task in builds where task.projectId == projectId {
            out.append(AgentEntry(id: "build:\(task.id)", kind: task.kind == "quick" ? "quick" : "build", title: (task.title?.isEmpty == false ? task.title! : "Untitled Build"),
                                  node: task.workspaceId, state: buildState(task.status), status: BUILD_STATE[task.status] ?? task.status,
                                  at: task.updated ?? task.created, task: task))
        }
        for note in connect {
            out.append(AgentEntry(id: note.id, kind: "connect", title: (note.name?.isEmpty == false ? note.name! : "Import your context"), node: nil,
                                  state: note.tone == "warn" || note.tone == "needs" ? "needs" : "unseen", at: note.at, did: note.did ?? "", sessionId: note.sessionId))
        }
        return newestFirst(out, \.at)
    }

    /// The repositories' builds the bell held, as rows of Agents among the rest.
    public static func repoEntries(_ rows: [RepoNotification] = [], items: [String: RepoItem] = [:], library: [LibraryRow] = []) -> [AgentEntry] {
        var out: [AgentEntry] = []
        for notification in rows {
            guard let item = items[notification.libraryId] else { continue }
            let run = item.run
            if run.isNull { continue }
            let repo = library.first { $0.id == notification.libraryId }
            let status = run["status"]?.string
            let state = status == "starting" ? "running" : status == "failed" ? "failed" : "unseen"
            out.append(AgentEntry(id: "repo:\(notification.id)", kind: "repo", title: repo?.name ?? "Repository", node: nil, state: state, at: notification.at,
                                  viewed: notification.read && state != "running", notification: notification, run: run, sandbox: item.sandbox, repo: repo))
        }
        return out
    }

    public static let READY_STATES: Set<String> = ["needs", "unseen", "failed"]

    /// One count for a list of agents: the running ones and the ones to look at, less the ones already clicked.
    public static func summarize(_ list: [AgentEntry]) -> AgentSummary {
        var running = 0, ready = 0
        for entry in list {
            if entry.state == "running" { running += 1 } else if READY_STATES.contains(entry.state) && !entry.viewed { ready += 1 }
        }
        return AgentSummary(total: running + ready, running: running, ready: ready)
    }

    // How long an agent stays in Agents (2026-10-16, Hudson: "it should just like go away after 3d or after 1d of me
    // clicking on it"). One still running stays.
    public static let AGENT_KEPT_MS: Double = 3 * 24 * 60 * 60 * 1000
    public static let AGENT_CLICKED_MS: Double = 24 * 60 * 60 * 1000
    static let MARKS_KEPT_MS: Double = 7 * 24 * 60 * 60 * 1000

    /// A row clicked or put away: `marks` with that one's time set; marks older than a week are dropped.
    public static func markAgent(_ marks: [String: AgentMark], _ id: String, _ what: String, at: String = JSTime.iso(JSTime.now())) -> [String: AgentMark] {
        let now = time(at)
        var out: [String: AgentMark] = [:]
        for (key, mark) in marks where max(time(mark.clicked), time(mark.dismissed)) >= now - MARKS_KEPT_MS { out[key] = mark }
        var mark = out[id] ?? AgentMark()
        if what == "dismissed" { mark.dismissed = at } else { mark.clicked = at }
        out[id] = mark
        return out
    }

    public static let BUILD_KINDS: Set<String> = ["build", "quick"]
    public static func buildInProgress(_ entry: AgentEntry?) -> Bool { guard let entry else { return false }; return entry.state == "running" && BUILD_KINDS.contains(entry.kind) }

    /// What Agents shows (keptAgents).
    public static func keptAgents(_ entries: [AgentEntry], marks: [String: AgentMark] = [:], now: Double = JSTime.now()) -> [AgentEntry] {
        var out: [AgentEntry] = []
        for entry in entries {
            let mark = marks[entry.id] ?? AgentMark()
            if mark.dismissed != nil && time(mark.dismissed) >= time(entry.at) && !buildInProgress(entry) { continue }
            let clicked = time(mark.clicked) >= time(entry.at) ? time(mark.clicked) : 0
            if entry.state != "running" {
                if entry.at != nil && now - time(entry.at) > AGENT_KEPT_MS { continue }
                if clicked != 0 && now - clicked > AGENT_CLICKED_MS { continue }
            }
            var kept = entry
            if clicked != 0 { kept.viewed = true }
            out.append(kept)
        }
        return out
    }

    /// Each project's count, with everything under it (each agent once): id → summary.
    public static func rollUp(_ index: TreeIndex, _ entries: [AgentEntry] = []) -> [String: AgentSummary] {
        var lists: [String: [AgentEntry]] = [:]
        for entry in entries {
            guard let at = index[entry.node] else { continue }
            for id in at.path { lists[id, default: []].append(entry) }
        }
        return lists.mapValues(summarize)
    }

    /// The count of several projects together (a More's), each agent once.
    public static func summaryOf(_ index: TreeIndex, _ entries: [AgentEntry], _ ids: [String]) -> AgentSummary {
        let set = Set(ids)
        return summarize(entries.filter { entry in index[entry.node].map { $0.path.contains(where: set.contains) } ?? false })
    }

    /// The switcher's counts (Workspace.jsx projectCounts): the other top-level projects from state.json's agents, this one from `entries`.
    public static func projectCounts(agents: [NavAgent], entries: [AgentEntry], projectId: String, marks: [String: AgentMark] = [:], now: Double = JSTime.now()) -> [String: AgentSummary] {
        var by: [String: [AgentEntry]] = [:]
        var order: [String] = []
        for agent in agents where agent.projectId != projectId && (agent.status == "running" || agent.status == "waiting") {
            if by[agent.projectId] == nil { order.append(agent.projectId) }
            let running = agent.status == "running"
            by[agent.projectId, default: []].append(AgentEntry(id: "agent:\(agent.id)", state: running ? "running" : "unseen", at: running ? agent.started : (agent.finished ?? agent.started)))
        }
        var out: [String: AgentSummary] = [:]
        for id in order { out[id] = summarize(keptAgents(by[id] ?? [], marks: marks, now: now)) }
        out[projectId] = summarize(entries)
        return out
    }

    /// A count as it is drawn: at most "9+".
    public static func countLabel(_ n: Int) -> String { n > 9 ? "9+" : String(n) }
    /// The library's size beside Library: at most "999+".
    public static func libraryLabel(_ n: Int) -> String { n > 999 ? "999+" : String(n) }

    /* ---------------------------------------------------------- recent pages */

    /// The clock's list: the top-level project's page first, then the pages opened last, newest first, once each.
    public static func recentPages(visits: [Visit] = [], index: TreeIndex, notes: Set<String> = [], count: Int = RECENT_PAGES) -> [RecentPage] {
        var out = [RecentPage(kind: "top", id: "top")]
        var seen = Set<String>()
        for visit in newestFirst(visits, \.at) {
            if out.count >= count { break }
            let key = "\(visit.kind):\(visit.id)"
            if seen.contains(key) { continue }
            let known = visit.kind == "project" ? index.has(visit.id) : visit.kind == "note" ? notes.contains(visit.id) : false
            if !known { continue }
            seen.insert(key)
            out.append(RecentPage(kind: visit.kind, id: visit.id))
        }
        return out
    }

    /// A visit recorded: it moves to the front; the list keeps `max`.
    public static func visited(_ visits: [Visit], kind: String, id: String, at: String = JSTime.iso(JSTime.now()), max: Int = 60) -> [Visit] {
        Array(([Visit(kind: kind, id: id, at: at)] + visits.filter { !($0.kind == kind && $0.id == id) }).prefix(max))
    }

    /// A crumb cut from the front, a level at a time, to "./".
    public static func crumbFrom(_ parts: [String], _ dropped: Int) -> String {
        if dropped == 0 { return parts.joined(separator: "/") }
        return "./" + parts.dropFirst(dropped).joined(separator: "/")
    }

    /* --------------------------------------------------------------- sources */

    /// A source's icon (2026-10-13: "image attachments have the image icon, html have code icon, websites have website icon").
    public static func sourceIcon(_ row: LibraryRow?) -> String {
        guard let row else { return "file" }
        if row.hasTag("note") { return "note" }
        if row.hasTag("git") { return "git" }
        switch row.type {
        case "website": return "website"
        case "image": return "image"
        case "html": return "html"
        case "pdf": return "pdf"
        case "folder": return "folder"
        default: return "file"
        }
    }

    /// A project's own folder, the source opened or looked at last first; ties keep their order.
    public static func byOpened(_ rows: [LibraryRow], opened: [String: String] = [:]) -> [LibraryRow] {
        rows.enumerated().map { (row: $0.element, i: $0.offset, at: max(time(opened[$0.element.id]), time($0.element.created))) }
            .sorted { $0.at != $1.at ? $0.at > $1.at : $0.i < $1.i }.map(\.row)
    }

    /// An opening remembered: `opened` with `id` at `at`, keeping the `max` newest.
    public static func noteOpened(_ opened: [String: String], _ id: String, at: String = JSTime.iso(JSTime.now()), max: Int = 400) -> [String: String] {
        var next = opened
        next[id] = at
        if next.count <= max { return next }
        let keep = next.keys.sorted { time(next[$0]) > time(next[$1]) }.prefix(max)
        return Dictionary(uniqueKeysWithValues: keep.map { ($0, next[$0]!) })
    }

    /// A folder's rows as the sidebar draws them: five, or four and More.
    public static func folderRows<T>(_ rows: [T], cap: Int = LEVEL_ROWS) -> (shown: [T], more: Bool) {
        let shown = rows.count > cap ? Array(rows.prefix(cap - 1)) : rows
        return (shown, rows.count > shown.count)
    }

    /* -------------------------------------------------------------- archived */

    /// One project's own archived versions, newest first.
    public static func versionsOf(_ node: ProjectNode) -> [ArchivedVersion] {
        newestFirst(node.archives.map { ArchivedVersion(workspaceId: node.id, name: node.name, file: $0.file, title: $0.title.isEmpty ? "Untitled" : $0.title, clearedAt: $0.clearedAt) }, \.clearedAt)
    }

    /// Every project's archived versions, newest first.
    public static func archivedVersions(_ roots: [ProjectNode]) -> [ArchivedVersion] {
        var out: [ArchivedVersion] = []
        func walk(_ list: [ProjectNode]) { for node in list { out += versionsOf(node); walk(node.children) } }
        walk(roots)
        return newestFirst(out, \.clearedAt)
    }

    /// How long ago, in words: "just now", "4 min ago", "2 h ago", "3 d ago"; '' for no time.
    public static func sinceWords(_ iso: String?, now: Double = JSTime.now()) -> String {
        let then = time(iso)
        if then == 0 { return "" }
        let minutes = Int((max(0, now - then) / 60000).rounded(.down))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        if minutes < 60 * 24 { return "\(minutes / 60) h ago" }
        return "\(minutes / (60 * 24)) d ago"
    }

    /// How long ago, short (SidebarPanels.jsx since): now, 4m, 2h, 3d.
    public static func since(_ iso: String?, now: Double = JSTime.now()) -> String {
        guard let at = JSTime.parse(iso) else { return "" }
        let m = Int((max(0, now - at) / 60000).rounded(.toNearestOrAwayFromZero))
        if m < 1 { return "now" }
        if m < 60 { return "\(m)m" }
        if m < 1440 { return "\(Int((Double(m) / 60).rounded(.toNearestOrAwayFromZero)))h" }
        return "\(Int((Double(m) / 1440).rounded(.toNearestOrAwayFromZero)))d"
    }

    /* ------------------------------------------- workspaces (pre-10-13, kept) */

    /// When each project was last worked in: its document saved or a note typed in while it was open (state.json recent).
    public static func workspaceActivity(_ roots: [ProjectNode], recent: [RecentPlace] = []) -> (own: [String: Double], within: [String: Double]) {
        var own: [String: Double] = [:], within: [String: Double] = [:]
        var typed: [String: Double] = [:]
        for entry in recent { if let ws = entry.workspaceId { typed[ws] = max(typed[ws] ?? 0, time(entry.at)) } }
        @discardableResult func walk(_ node: ProjectNode) -> Double {
            let mine = max(time(node.edited), typed[node.id] ?? 0)
            own[node.id] = mine
            var most = mine
            for child in node.children { most = max(most, walk(child)) }
            within[node.id] = most
            return most
        }
        for root in roots { walk(root) }
        return (own, within)
    }

    /// The projects from a root down to `id`, or [] when it is not in the tree.
    public static func pathTo(_ roots: [ProjectNode], _ id: String?) -> [ProjectNode] {
        guard let id else { return [] }
        func walk(_ list: [ProjectNode], _ above: [ProjectNode]) -> [ProjectNode]? {
            for node in list {
                let here = above + [node]
                if node.id == id { return here }
                if let deeper = walk(node.children, here) { return deeper }
            }
            return nil
        }
        return walk(roots, []) ?? []
    }

    public static func countWorkspaces(_ roots: [ProjectNode]) -> Int { roots.reduce(0) { $0 + 1 + countWorkspaces($1.children) } }

    public struct RecentWorkspace: Equatable { public var node: ProjectNode; public var at: Double; public var holdsHere: Bool; public var children: [(node: ProjectNode, at: Double)]
        public static func == (a: RecentWorkspace, b: RecentWorkspace) -> Bool { a.node == b.node && a.at == b.at && a.holdsHere == b.holdsHere && a.children.map(\.node.id) == b.children.map(\.node.id) }
    }

    /// The pre-10-13 "Workspaces" section (kept and tested as sidebar.js keeps it).
    public static func recentWorkspaces(roots: [ProjectNode] = [], recent: [RecentPlace] = [], hereId: String? = nil, count: Int = 3) -> [RecentWorkspace] {
        let (own, within) = workspaceActivity(roots, recent: recent)
        func order(_ list: [ProjectNode], _ times: [String: Double]) -> [(node: ProjectNode, i: Int, at: Double)] {
            list.enumerated().map { (node: $0.element, i: $0.offset, at: times[$0.element.id] ?? 0) }.sorted { $0.at != $1.at ? $0.at > $1.at : $0.i < $1.i }
        }
        let ranked = order(roots, within)
        let top = pathTo(roots, hereId).first
        var picked = Array(ranked.prefix(count))
        if let top, !picked.contains(where: { $0.node.id == top.id }), let mine = ranked.first(where: { $0.node.id == top.id }) {
            picked = (Array(picked.prefix(max(0, count - 1))) + [mine]).sorted { $0.at != $1.at ? $0.at > $1.at : $0.i < $1.i }
        }
        return picked.map { entry in
            RecentWorkspace(node: entry.node, at: entry.at, holdsHere: top?.id == entry.node.id,
                            children: order(entry.node.children, within).map { (node: $0.node, at: max(own[$0.node.id] ?? 0, $0.at)) })
        }
    }

    /// How many sub-workspaces each open row shows in `room` lines, dealt out one at a time.
    public static func fitChildren(_ rows: [(id: String, open: Bool, count: Int)], room: Int) -> [String: Int] {
        var shown = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, 0) })
        var left = room, grew = true
        while grew && left > 0 {
            grew = false
            for row in rows {
                if !row.open || shown[row.id]! >= row.count || left <= 0 { continue }
                shown[row.id]! += 1
                left -= 1
                grew = true
            }
        }
        return shown
    }

    public struct SourceGroup: Equatable { public var key: String; public var label: String; public var header: Bool?; public var rows: [LibraryRow] }
    public static let SOURCE_GROUPS: [(key: String, label: String, header: Bool?)] = [("starred", "Starred", nil), ("notes", "Notes", nil), ("other", "Sources", false)]

    /// What a row of a project is (pre-10-13): notes, code, websites, files.
    public static func sourceKind(_ row: LibraryRow) -> String {
        if row.hasTag("note") { return "notes" }
        if row.hasTag("git") { return "code" }
        if row.type == "website" { return "websites" }
        return "files"
    }
    public static func sourceGroup(_ row: LibraryRow) -> String { sourceKind(row) == "notes" ? "notes" : "other" }
    public static func sourceGroups(_ rows: [LibraryRow], starredIds: [String] = [], library: [LibraryRow] = []) -> [SourceGroup] {
        var by: [String: [LibraryRow]] = ["starred": [], "notes": [], "other": []]
        for row in rows { by[sourceGroup(row)]!.append(row) }
        var known: [String: LibraryRow] = [:]
        for row in library + rows { known[row.id] = row }
        by["starred"] = starredIds.compactMap { known[$0] }
        return SOURCE_GROUPS.map { SourceGroup(key: $0.key, label: $0.label, header: $0.header, rows: by[$0.key] ?? []) }
    }

    /// How many rows each group shows when they share `room` lines (pre-10-13).
    public static func fitGroups(_ groups: [(key: String, count: Int, header: Bool?)], room: Int, cap: Int = 5) -> (shown: [String: Int], more: [String: Bool], lines: Int, fits: Bool) {
        var shown: [String: Int] = [:], more: [String: Bool] = [:]
        var lines = 0
        var open: [(key: String, count: Int, header: Bool?)] = []
        for group in groups {
            let headed = group.header != false
            if headed { lines += 1 }
            shown[group.key] = 0
            more[group.key] = false
            if group.count == 0 { if headed { lines += 1 }; continue }
            shown[group.key] = 1
            more[group.key] = group.count > 1
            lines += more[group.key]! ? 2 : 1
            open.append(group)
        }
        let fits = lines <= room
        var grew = fits
        while grew {
            grew = false
            for group in open {
                let n = shown[group.key]!
                if n >= min(group.count, cap) { continue }
                let last = n + 1 == group.count
                let cost = last ? 0 : 1
                if lines + cost > room { continue }
                shown[group.key] = n + 1
                more[group.key] = !last
                lines += cost
                grew = true
            }
        }
        return (shown, more, lines, fits)
    }

    public struct InboxEntry: Equatable { public var id, kind: String; public var workspaceId: String?; public var name, did: String; public var at: String? }
    /// The pre-10-13 Inbox.
    public static func inboxEntries(_ agents: [NavAgent], projectId: String) -> [InboxEntry] {
        newestFirst(agents.filter { $0.status == "waiting" && $0.projectId == projectId && $0.workspaceId != nil }
            .map { InboxEntry(id: $0.id, kind: $0.kind, workspaceId: $0.workspaceId, name: $0.name ?? "", did: AGENT_DID[$0.kind] ?? "An agent finished", at: $0.finished ?? $0.started) }, \.at)
    }

    public struct AgentGroupEntry: Equatable { public var id, kind, title: String; public var workspaceId: String?; public var state: String; public var at: String?; public var task: BuildInfo? }
    /// The pre-10-13 Agents groups.
    public static func agentGroups(agents: [NavAgent] = [], builds: [BuildInfo] = [], projectId: String) -> (running: [AgentGroupEntry], waiting: [AgentGroupEntry], done: [AgentGroupEntry]) {
        var running: [AgentGroupEntry] = [], waiting: [AgentGroupEntry] = [], done: [AgentGroupEntry] = []
        for agent in agents where agent.projectId == projectId && agent.status == "running" && agent.kind != "build" {
            running.append(AgentGroupEntry(id: "agent:\(agent.id)", kind: agent.kind, title: AGENT_NAME[agent.kind] ?? "Agent", workspaceId: agent.workspaceId, state: "Working", at: agent.started))
        }
        for task in builds where task.projectId == projectId {
            let entry = AgentGroupEntry(id: "build:\(task.id)", kind: task.kind == "quick" ? "quick" : "build", title: task.title ?? "Untitled Build", workspaceId: task.workspaceId,
                                        state: BUILD_STATE[task.status] ?? task.status, at: task.updated ?? task.created, task: task)
            if BUILD_RUNNING.contains(task.status) { running.append(entry) } else if ["accepted", "discarded"].contains(task.status) { done.append(entry) } else { waiting.append(entry) }
        }
        return (newestFirst(running, \.at), newestFirst(waiting, \.at), Array(newestFirst(done, \.at).prefix(12)))
    }
}
