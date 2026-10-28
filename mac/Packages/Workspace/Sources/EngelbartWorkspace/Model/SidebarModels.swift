import Foundation
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartSandbox

// The parts of model/nav.js, model/sidebar.js and model/rail.js that Workspace.jsx itself computes (the next place and
// ⌘J, the Agents list it hands the sidebar, the @ menu's rows, the links a mention made). The Sidebar package ports
// the same files for what the sidebar draws; these copies exist because a wave-2 package cannot depend on another
// (ARCHITECTURE §2). Keep them in step with the JavaScript: their tests are ported from test/nav-model, sidebar-model and
// rail-model.

// MARK: nav.js

/// state.json's `recent` and `agents` (main/store/projects.cjs readNav).
public struct NavState: Equatable {
    public var recent: [JSONValue]
    public var agents: [JSONValue]
    public init(recent: [JSONValue] = [], agents: [JSONValue] = []) { self.recent = recent; self.agents = agents }
    public init(json: JSONValue?) { recent = json?["recent"]?.array ?? []; agents = json?["agents"]?.array ?? [] }
    /// Only one project's (the next row and ⌘J stay in the project, 2026-10-01).
    public func only(_ projectId: String) -> NavState {
        NavState(recent: recent.filter { $0["projectId"]?.string == projectId }, agents: agents.filter { $0["projectId"]?.string == projectId })
    }
}

public struct Place: Equatable {
    public var projectId: String
    public var workspaceId: String
    public var name: String?
    public var why: String // 'agent' | 'recent'
    public var kind: String?
    public var at: String?
    public var waiting: Int
}

public enum Nav {
    static func same(_ a: JSONValue, _ here: (projectId: String, workspaceId: String)?) -> Bool {
        guard let here else { return false }
        return a["projectId"]?.string == here.projectId && a["workspaceId"]?.string == here.workspaceId
    }

    /// An agent waiting for you comes first, the one that has waited longest; the workspace you are in never counts. With
    /// nothing waiting, the workspaces written in last take turns: the one after where you are in `recent`, or its first.
    public static func nextPlace(here: (projectId: String, workspaceId: String)?, recent: [JSONValue], agents: [JSONValue]) -> Place? {
        let waiting = agents
            .filter { $0["status"]?.string == "waiting" && !($0["workspaceId"]?.string ?? "").isEmpty && !same($0, here) }
            .enumerated().sorted { a, b in
                let fa = a.element["finished"]?.string ?? "", fb = b.element["finished"]?.string ?? ""
                return fa != fb ? fa < fb : a.offset < b.offset
            }.map(\.element)
        if let first = waiting.first {
            let places = Set(waiting.map { "\($0["projectId"]?.string ?? "")/\($0["workspaceId"]?.string ?? "")" })
            return Place(projectId: first["projectId"]?.string ?? "", workspaceId: first["workspaceId"]?.string ?? "", name: first["name"]?.string, why: "agent",
                         kind: first["kind"]?.string ?? "bart", at: first["finished"]?.string, waiting: places.count)
        }
        let at = recent.firstIndex { same($0, here) }
        if recent.isEmpty { return nil }
        for step in 1...recent.count {
            let entry = recent[at == nil ? step - 1 : (at! + step) % recent.count]
            if !same(entry, here), let wid = entry["workspaceId"]?.string {
                return Place(projectId: entry["projectId"]?.string ?? "", workspaceId: wid, name: entry["name"]?.string, why: "recent", kind: nil, at: entry["at"]?.string, waiting: 0)
            }
        }
        return nil
    }

    public struct Flat: Equatable { public var id: String; public var name: String; public var above: [String] }
    /// Every workspace of a project's tree, flat, with the names of the workspaces above it.
    public static func flatWorkspaces(_ roots: [WorkspaceNode]) -> [Flat] {
        var out: [Flat] = []
        func walk(_ list: [WorkspaceNode], _ above: [String]) { for n in list { out.append(Flat(id: n.id, name: n.name, above: above)); walk(n.children, above + [n.name]) } }
        walk(roots, [])
        return out
    }

    /// The workspace search: every workspace whose name holds the words typed, names that start with them first.
    public static func findWorkspaces(_ all: [Flat], _ query: String) -> [Flat] {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let first = words.first else { return [] }
        let hits = all.enumerated().filter { e in let name = e.element.name.lowercased(); return words.allSatisfy { name.contains($0) } }
        func starts(_ w: Flat) -> Int { w.name.lowercased().hasPrefix(first) ? 0 : 1 }
        return hits.sorted { a, b in starts(a.element) != starts(b.element) ? starts(a.element) < starts(b.element) : a.offset < b.offset }.map(\.element)
    }
}

// MARK: sidebar.js — agents and counts

/// A row of Agents (model/sidebar.js agentEntries / repoEntries).
public struct AgentEntry: Equatable {
    public var id: String
    /// bart | brainstorm | discover | create | build | quick | connect | repo
    public var kind: String
    public var title: String
    /// The workspace it is in, or nil.
    public var node: String?
    public var doc: JSONValue?
    /// running | needs | unseen | failed | done
    public var state: String
    public var status: String?
    public var at: String?
    public var task: JSONValue?
    public var sessionId: String?
    public var did: String?
    public var viewed = false
    public var notification: BuildNotificationRow?
    public var run: JSONValue?
    public var sandbox: String?
    public var repo: JSONValue?
}

/// A Connect your library note for Agents (model/connect.js connectInbox + dockLine's tone), as the app gives it.
public struct ConnectNote: Equatable {
    public var id: String
    public var sessionId: String
    public var name: String
    public var did: String
    public var at: String?
    /// 'warn' | 'needs' | 'done' | …
    public var tone: String
    public init(id: String, sessionId: String, name: String, did: String = "", at: String? = nil, tone: String = "done") {
        self.id = id; self.sessionId = sessionId; self.name = name; self.did = did; self.at = at; self.tone = tone
    }
}

public struct AgentSummary: Equatable { public var total: Int; public var running: Int; public var ready: Int }

public enum Agents {
    public static let names = ["bart": "Bart", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create", "build": "Build"]
    public static let buildWords = ["setting-up": "Setting up", "queued": "Waiting for a slot", "running": "Working", "needs-you": "Needs you", "review": "Ready to review",
                                    "stopped": "Stopped", "failed": "Failed", "escalated": "Too big for a quick task", "interrupted": "Interrupted", "accepting": "Accepting",
                                    "conflict": "Conflict", "accepted": "Accepted", "discarded": "Discarded"]
    public static let readyStates: Set<String> = ["needs", "unseen", "failed"]
    public static let keptMs: Double = 3 * 24 * 60 * 60 * 1000
    public static let clickedMs: Double = 24 * 60 * 60 * 1000
    static let marksKeptMs: Double = 7 * 24 * 60 * 60 * 1000
    /// ⌘J's order: what failed, then what needs you, then what finished.
    public static let rank = ["failed": 4, "needs": 3, "unseen": 2]

    /// A Build's place in the Agents list.
    public static func buildState(_ status: String?) -> String {
        switch status ?? "" {
        case "setting-up", "queued", "running", "accepting": return "running"
        case "needs-you", "review": return "needs"
        case "failed", "conflict", "interrupted", "escalated": return "failed"
        default: return "done"
        }
    }

    static func time(_ iso: String?) -> Double { WorkspaceTime.ms(iso) }

    /// This project's asks (running, or waiting = unseen), its Builds, and Connect's notes; newest first.
    public static func entries(agents: [JSONValue], builds: [JSONValue], connect: [ConnectNote], projectId: String) -> [AgentEntry] {
        var out: [AgentEntry] = []
        for a in agents {
            guard a["projectId"]?.string == projectId, a["kind"]?.string != "build" else { continue }
            let status = a["status"]?.string
            guard status == "running" || status == "waiting" else { continue }
            let kind = a["kind"]?.string ?? "bart"
            let running = status == "running"
            out.append(AgentEntry(id: "agent:\(a["id"]?.string ?? "")", kind: kind, title: names[kind] ?? "Agent", node: a["workspaceId"]?.string.flatMap { $0.isEmpty ? nil : $0 },
                                  doc: a["doc"].flatMap { $0.isNull ? nil : $0 }, state: running ? "running" : "unseen",
                                  at: running ? a["started"]?.string : (a["finished"]?.string ?? a["started"]?.string)))
        }
        for t in builds {
            guard t["projectId"]?.string == projectId else { continue }
            let status = t["status"]?.string
            let title = t["title"]?.string ?? ""
            out.append(AgentEntry(id: "build:\(t["id"]?.string ?? "")", kind: t["kind"]?.string == "quick" ? "quick" : "build", title: title.isEmpty ? "Untitled Build" : title,
                                  node: t["workspaceId"]?.string.flatMap { $0.isEmpty ? nil : $0 }, state: buildState(status), status: status.map { buildWords[$0] ?? $0 },
                                  at: t["updated"]?.string ?? t["created"]?.string, task: t))
        }
        for n in connect {
            out.append(AgentEntry(id: n.id, kind: "connect", title: n.name.isEmpty ? "Import your context" : n.name, node: nil, state: n.tone == "warn" || n.tone == "needs" ? "needs" : "unseen",
                                  at: n.at, sessionId: n.sessionId, did: n.did))
        }
        return out.enumerated().sorted { a, b in
            let ta = time(a.element.at), tb = time(b.element.at)
            return ta != tb ? ta > tb : a.offset < b.offset
        }.map(\.element)
    }

    /// The repositories' builds the bell held, as rows of Agents (2026-10-16).
    public static func repoEntries(_ rows: [BuildNotificationRow], items: [String: SandboxItem], library: [LibraryRow]) -> [AgentEntry] {
        var out: [AgentEntry] = []
        for n in rows {
            guard let item = items[n.libraryId] else { continue }
            let run = item.run
            let repo = library.first { $0.id == n.libraryId }
            let status = run["status"]?.string
            let state = status == "starting" ? "running" : status == "failed" ? "failed" : "unseen"
            var e = AgentEntry(id: "repo:\(n.id)", kind: "repo", title: repo?.name ?? "Repository", node: nil, state: state, at: n.at)
            e.viewed = n.read && state != "running"
            e.notification = n; e.run = run; e.sandbox = item.sandbox; e.repo = repo?.json
            out.append(e)
        }
        return out
    }

    /// One count for a list: the running ones and the ones to look at, less the ones already clicked.
    public static func summarize(_ list: [AgentEntry]) -> AgentSummary {
        var running = 0, ready = 0
        for e in list { if e.state == "running" { running += 1 } else if readyStates.contains(e.state) && !e.viewed { ready += 1 } }
        return AgentSummary(total: running + ready, running: running, ready: ready)
    }

    /// A row clicked or put away with its ×; marks older than a week are dropped.
    public static func mark(_ marks: [String: [String: String]], _ id: String, _ what: String, at: String = WorkspaceTime.iso()) -> [String: [String: String]] {
        let now = time(at)
        var out: [String: [String: String]] = [:]
        for (key, mark) in marks where max(time(mark["clicked"]), time(mark["dismissed"])) >= now - marksKeptMs { out[key] = mark }
        var m = out[id] ?? [:]
        m[what] = at
        out[id] = m
        return out
    }

    static func buildInProgress(_ e: AgentEntry) -> Bool { e.state == "running" && (e.kind == "build" || e.kind == "quick") }

    /// What Agents shows: no row put away since it last changed, none not running once three days old or a day past the
    /// click; a row clicked since it last changed is `viewed`. A Build in progress stays whatever its marks say.
    public static func kept(_ entries: [AgentEntry], marks: [String: [String: String]], now: Double) -> [AgentEntry] {
        var out: [AgentEntry] = []
        for var e in entries {
            let mark = marks[e.id] ?? [:]
            if let d = mark["dismissed"], time(d) >= time(e.at), !buildInProgress(e) { continue }
            let clicked = time(mark["clicked"]) >= time(e.at) ? time(mark["clicked"]) : 0
            if e.state != "running" {
                if let at = e.at, !at.isEmpty, now - time(at) > keptMs { continue }
                if clicked > 0 && now - clicked > clickedMs { continue }
            }
            if clicked > 0 { e.viewed = true }
            out.append(e)
        }
        return out
    }

    /// Each project's count with everything under it (an agent once), keyed by workspace id.
    public static func rollUp(_ index: WorkspaceIndex, _ entries: [AgentEntry]) -> [String: AgentSummary] {
        var lists: [String: [AgentEntry]] = [:]
        for e in entries {
            guard let node = e.node, index.has(node) else { continue }
            var at: String? = node
            while let a = at { lists[a, default: []].append(e); at = index[a]?.parent }
        }
        return lists.mapValues(summarize)
    }

    /// ⌘J's queue (2026-10-13 "Next agent needing attention"): failed, then needs-you, then finished, oldest first; never
    /// the one just gone to, never one viewed; only rows that lead somewhere here.
    public static func queue(_ entries: [AgentEntry], last: String?, index: WorkspaceIndex) -> [AgentEntry] {
        entries.enumerated()
            .filter { readyStates.contains($0.element.state) && !$0.element.viewed && $0.element.id != last && ($0.element.kind == "connect" || index.has($0.element.node)) }
            .sorted { a, b in
                let ra = rank[a.element.state] ?? 0, rb = rank[b.element.state] ?? 0
                if ra != rb { return ra > rb }
                let ta = time(a.element.at), tb = time(b.element.at)
                return ta != tb ? ta < tb : a.offset < b.offset
            }.map(\.element)
    }
}

// MARK: sidebar.js — visits, openings, shortcuts

public struct Visit: Equatable, Codable { public var kind: String; public var id: String; public var at: String }

public enum Visits {
    public static let shortcuts = 9
    /// Ctrl+1–9: the top-level workspaces, in order.
    public static func shortcutProjects(_ roots: [WorkspaceNode]) -> [String] { roots.prefix(shortcuts).map(\.id) }
    /// A visit recorded: it moves to the front; the list keeps `max`.
    public static func visited(_ visits: [Visit], kind: String, id: String, at: String = WorkspaceTime.iso(), max: Int = 60) -> [Visit] {
        Array(([Visit(kind: kind, id: id, at: at)] + visits.filter { !($0.kind == kind && $0.id == id) }).prefix(max))
    }
    /// An opening remembered: `opened` with `id` at `at`, keeping the `max` newest.
    public static func noteOpened(_ opened: [String: String], _ id: String, at: String = WorkspaceTime.iso(), max: Int = 400) -> [String: String] {
        var next = opened
        next[id] = at
        guard next.count > max else { return next }
        let keep = next.sorted { WorkspaceTime.ms($0.value) > WorkspaceTime.ms($1.value) }.prefix(max)
        return Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
    }
    /// A project's own folder, the source opened last first (2026-10-16), else when it came into the library; ties keep order.
    public static func byOpened(_ rows: [LibraryRow], _ opened: [String: String]) -> [LibraryRow] {
        func when(_ r: LibraryRow) -> Double { max(WorkspaceTime.ms(opened[r.id]), WorkspaceTime.ms(r.created)) }
        return rows.enumerated().sorted { a, b in
            let wa = when(a.element), wb = when(b.element)
            return wa != wb ? wa > wb : a.offset < b.offset
        }.map(\.element)
    }
}

// MARK: rail.js — the @ menu, let-go notes, picked mentions

public enum MentionRows {
    static let maxMentions = 10
    static let maxWorkspaces = 6 // typed
    static let firstWorkspaces = 3 // before anything is typed
    /// Bart, Chat, Brainstorm, Discover, Create and Note, matched from their first letters.
    public static let verbs: [(id: String, name: String)] = [("bart", "Bart"), ("chat", "Chat"), ("brainstorm", "Brainstorm"), ("discover", "Discover"), ("create", "Create"), ("note", "Note")]
    public static let zoteroRow = LibRow(id: "zotero", name: "Zotero", type: "folder", tags: [])

    /// What things say (MATH-29): library id → text and workspace id → text, lowercased.
    public struct Bodies: Equatable {
        public var items: [String: String]
        public var workspaces: [String: String]
        public init(items: [String: String] = [:], workspaces: [String: String] = [:]) {
            self.items = items.mapValues { $0.lowercased() }; self.workspaces = workspaces.mapValues { $0.lowercased() }
        }
    }

    static func hay(_ row: LibRow) -> String {
        [row.name, row.url ?? "", row.path ?? "", row.folderPath ?? "", Kind.kindLabel(row), row.summary ?? ""].joined(separator: " ").lowercased()
    }
    /// 0 name starts with it, 1 name holds it, 2 where it is or its kind, 3 its summary, 4 only what it says; nil none.
    static func matchRank(_ row: LibRow, _ needle: String, _ bodies: Bodies?) -> Int? {
        let name = row.name.lowercased()
        if name.hasPrefix(needle) { return 0 }
        if name.contains(needle) { return 1 }
        if [row.url ?? "", row.path ?? "", row.folderPath ?? "", Kind.kindLabel(row)].joined(separator: " ").lowercased().contains(needle) { return 2 }
        if hay(row).contains(needle) { return 3 }
        return (bodies?.items[row.id] ?? "").contains(needle) ? 4 : nil
    }

    public struct Page: Equatable { public var input: String; public var title: String }

    /// The @ menu (rail.js mentionRows): the verbs; the page open in the Stage (its row, or a fresh one by its web name);
    /// the project's other workspaces (3 before typing, else up to 6 by name then by what their documents say); Zotero when
    /// connected; then ten library rows, ranked, what this workspace holds first, pictures last before anything is typed.
    public static func rows(query: String, library: [LibRow], page: Page?, pageRow: LibRow?, workspaces: [Nav.Flat], hereId: String?, bodies: Bodies?, zotero: Bool, here: Set<String>?) -> [MenuItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var out: [MenuItem] = verbs.filter { needle.isEmpty || $0.name.lowercased().hasPrefix(needle) }
            .map { MenuItem(kind: .verb, key: "verb:\($0.id)", name: $0.name, id: $0.id) }
        let pool = needle.isEmpty ? library.filter { $0.type != "image" } + library.filter { $0.type == "image" } : library
        func tier(_ row: LibRow) -> Int {
            (!needle.isEmpty && matchRank(row, needle, bodies) == 4 ? 2 : 0) + (here.map { $0.contains(row.id) ? 0 : 1 } ?? 1) + (needle.isEmpty && row.type == "image" ? 4 : 0)
        }
        var found = pool
        if !needle.isEmpty {
            found = pool.enumerated().compactMap { e in matchRank(e.element, needle, bodies).map { (e.element, e.offset, $0) } }
                .sorted { $0.2 != $1.2 ? $0.2 < $1.2 : $0.1 < $1.1 }.map(\.0)
        }
        let ordered = here == nil ? found : found.enumerated().sorted { a, b in
            let ta = tier(a.element), tb = tier(b.element)
            return ta != tb ? ta < tb : a.offset < b.offset
        }.map(\.element)
        var hits = ordered.map { Mention.menuItem($0) }
        if let page, !page.title.isEmpty, needle.isEmpty || "\(page.title) \(page.input)".lowercased().contains(needle) {
            if let pageRow {
                out.append(Mention.menuItem(pageRow))
                hits = hits.filter { $0.key != pageRow.id }
            } else {
                let isWeb = page.input.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
                out.append(MenuItem(kind: .fresh, key: "page:\(page.input)", name: isWeb ? WebName.webName(page.title, page.input) : mentionName(page.title), input: page.input))
            }
        }
        let others = workspaces.filter { $0.id != hereId }
        let named = needle.isEmpty ? [] : Nav.findWorkspaces(others, needle)
        let said = needle.isEmpty ? [] : others.filter { w in !named.contains(w) && (bodies?.workspaces[w.id] ?? "").contains(needle) }
        let spaces = (needle.isEmpty ? Array(others.prefix(firstWorkspaces)) : Array((named + said).prefix(maxWorkspaces)))
            .map { MenuItem(kind: .workspace, key: "ws:\($0.id)", name: $0.name, id: $0.id, hint: $0.above.isEmpty ? nil : $0.above.joined(separator: " / ")) }
        let zoteroRows = zotero && (needle.isEmpty || "zotero".hasPrefix(needle)) ? [MenuItem(kind: .item, key: "zotero", name: "Zotero", row: zoteroRow)] : []
        return out + spaces + zoteroRows + Array(hits.prefix(maxMentions))
    }

    /// A mention's name: no brackets, one space between words, 200 characters, "Untitled page" when empty.
    public static func mentionName(_ value: String) -> String {
        let s = Rx(#"\s+"#).replace(Rx(#"[\[\]]"#).replace(value, with: ""), with: " ").trimmingCharacters(in: .whitespaces)
        let cut = String(s.prefix(200))
        return cut.isEmpty ? "Untitled page" : cut
    }

    /// The notes let go of (MATH-58): trashed from a workspace and held by none any more.
    public static func letGoNotes(_ roots: [WorkspaceNode], notes: [NoteInfo]) -> Set<String> {
        var all: [ProjectHolds.WorkspaceHold] = []
        func walk(_ list: [WorkspaceNode]) { for w in list { all.append(.init(id: w.id, context: w.context, removed: w.removed)); walk(w.children) } }
        walk(roots)
        var madeIn: [String: String?] = [:]
        for n in notes { madeIn[n.id] = n.workspaceId }
        return ProjectHolds.letGo(all, madeIn)
    }

    /// What an edit of a workspace's document does to its links (MATH-57): a picked item whose last mention went is
    /// unlinked; one unlinked that way whose mention came back is linked again.
    public static func pickedChanges(before: Set<String>, after: Set<String>, picked: [String], dropped: Set<String>) -> (unlink: [String], relink: [String]) {
        (before.filter { !after.contains($0) && picked.contains($0) }.sorted(), after.filter { !before.contains($0) && dropped.contains($0) }.sorted())
    }
}
