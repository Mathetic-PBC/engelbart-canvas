import Foundation

// Where ⌘J goes when no agent waits, and the switchers' searches (src/renderer/model/nav.js, 2026-09-22). Pure:
// state.json's `recent` and `agents` come in (main/store readNav), one place goes out.

/// A place to go: a project (workspace) of a top-level project.
public struct Place: Equatable, Sendable {
    public var projectId: String
    public var workspaceId: String?
    public var name: String?
    public var path: String?
    public var projectName: String?
    /// agent | recent
    public var why: String
    public var kind: String?
    public var at: String?
    /// How many places wait (nextPlace).
    public var waiting: Int = 0
    /// The one ⌘J goes to (placesToGo).
    public var next: Bool = false
}

/// A project of the tree, flat, with the names of the projects above it.
public struct FlatProject: Equatable, Sendable {
    public var id: String
    public var name: String
    public var above: [String]
    public init(id: String, name: String, above: [String]) { self.id = id; self.name = name; self.above = above }
}

public enum NavModel {
    static func same(_ a: (String, String?)?, _ b: (String, String?)?) -> Bool {
        guard let a, let b else { return false }
        return a.0 == b.0 && a.1 == b.1
    }

    /// An agent waiting for you comes first, the one that has waited longest; with nothing waiting, the places written in
    /// last take turns. `here` (projectId, workspaceId).
    public static func nextPlace(here: (String, String?), recent: [RecentPlace] = [], agents: [NavAgent] = []) -> Place? {
        let waiting = agents.filter { $0.status == "waiting" && $0.workspaceId != nil && !same(($0.projectId, $0.workspaceId), here) }
            .enumerated().sorted { a, b in
                let fa = a.element.finished ?? "", fb = b.element.finished ?? ""
                return fa != fb ? fa < fb : a.offset < b.offset
            }.map(\.element)
        if let first = waiting.first {
            let places = Set(waiting.map { "\($0.projectId)/\($0.workspaceId ?? "")" })
            return Place(projectId: first.projectId, workspaceId: first.workspaceId, name: first.name, path: first.path, projectName: first.projectName,
                         why: "agent", kind: first.kind, at: first.finished, waiting: places.count)
        }
        let at = recent.firstIndex { same(($0.projectId, $0.workspaceId), here) } ?? -1
        if recent.isEmpty { return nil }
        for step in 1...recent.count {
            let entry = recent[at < 0 ? step - 1 : (at + step) % recent.count]
            if !same((entry.projectId, entry.workspaceId), here) {
                return Place(projectId: entry.projectId, workspaceId: entry.workspaceId, name: entry.name, path: entry.path, projectName: entry.projectName,
                             why: "recent", at: entry.at, waiting: 0)
            }
        }
        return nil
    }

    /// Every place the next row could take you: waiting agents (longest first, once each), then the ones written in.
    public static func placesToGo(here: (String, String?), recent: [RecentPlace] = [], agents: [NavAgent] = []) -> [Place] {
        let target = nextPlace(here: here, recent: recent, agents: agents)
        var out: [Place] = []
        func add(_ projectId: String, _ workspaceId: String?, _ name: String?, _ path: String?, _ projectName: String?, _ why: String, _ kind: String?, _ at: String?) {
            guard workspaceId != nil, !same((projectId, workspaceId), here), !out.contains(where: { same(($0.projectId, $0.workspaceId), (projectId, workspaceId)) }) else { return }
            out.append(Place(projectId: projectId, workspaceId: workspaceId, name: name, path: path, projectName: projectName, why: why,
                             kind: why == "agent" ? (kind ?? "bart") : nil, at: at,
                             next: target.map { same(($0.projectId, $0.workspaceId), (projectId, workspaceId)) } ?? false))
        }
        for agent in agents.filter({ $0.status == "waiting" }).enumerated().sorted(by: { a, b in
            let fa = a.element.finished ?? "", fb = b.element.finished ?? ""
            return fa != fb ? fa < fb : a.offset < b.offset
        }).map(\.element) {
            add(agent.projectId, agent.workspaceId, agent.name, agent.path, agent.projectName, "agent", agent.kind, agent.finished)
        }
        for entry in recent { add(entry.projectId, entry.workspaceId, entry.name, entry.path, entry.projectName, "recent", nil, entry.at) }
        return out
    }

    /// How long ago, the short way: "now", "4 min", "2 h", "3 d".
    public static func ago(_ iso: String?, now: Double = JSTime.now()) -> String {
        guard let then = JSTime.parse(iso) else { return "" }
        let minutes = Int((max(0, now - then) / 60000).rounded(.down))
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes) min" }
        if minutes < 60 * 24 { return "\(minutes / 60) h" }
        return "\(minutes / (60 * 24)) d"
    }

    /// Every project of a tree, flat, with the names of the projects above it.
    public static func flatWorkspaces(_ roots: [ProjectNode]) -> [FlatProject] {
        var out: [FlatProject] = []
        func walk(_ list: [ProjectNode], _ above: [String]) {
            for node in list { out.append(FlatProject(id: node.id, name: node.name, above: above)); walk(node.children, above + [node.name]) }
        }
        walk(roots, [])
        return out
    }

    /// The switcher's search: every project whose name holds the words typed, in any order; names that start with them first.
    public static func findWorkspaces(_ all: [FlatProject], _ query: String?) -> [FlatProject] {
        let words = (query ?? "").lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let first = words.first else { return [] }
        let hits = all.filter { ws in let name = ws.name.lowercased(); return words.allSatisfy { name.contains($0) } }
        return hits.enumerated().sorted { a, b in
            let sa = a.element.name.lowercased().hasPrefix(first) ? 0 : 1, sb = b.element.name.lowercased().hasPrefix(first) ? 0 : 1
            return sa != sb ? sa < sb : a.offset < b.offset
        }.map(\.element)
    }
}
