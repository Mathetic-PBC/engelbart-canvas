import Foundation

// The import's "Open library" (model/welcome-place.js, 2026-10-14): which workspace of the project it lands on, and which
// tab (App.jsx openLibrary).

public struct WelcomeTree: Sendable {
    public struct Workspace: Sendable {
        public var id: String, name: String, children: [Workspace]
        public init(id: String, name: String, children: [Workspace] = []) { self.id = id; self.name = name; self.children = children }
    }
    public struct Note: Sendable {
        public var id: String, name: String, workspaceId: String?
        public init(id: String, name: String, workspaceId: String?) { self.id = id; self.name = name; self.workspaceId = workspaceId }
    }
    public var workspaces: [Workspace]
    public var notes: [Note]
    public init(workspaces: [Workspace], notes: [Note]) { self.workspaces = workspaces; self.notes = notes }
}

public struct WelcomeLanding: Equatable, Sendable {
    public struct Tab: Equatable, Sendable { public var id: String, title: String }
    public var workspaceId: String?
    public var tab: Tab?
}

public enum WelcomePlace {
    /// Where "Open library" lands in `tree`: the workspace the run was given (`given`, when the tree has it), else the newest
    /// workspace named Welcome ("Welcome", "Welcome 2", …), else the one open (`current`), else the first. Its page opens; a
    /// "Welcome!" note there opens instead when the workspace is not a Welcome one (an older onboarding's Getting started).
    public static func landing(_ tree: WelcomeTree?, given: String? = nil, current: String? = nil) -> WelcomeLanding {
        var all: [WelcomeTree.Workspace] = []
        func walk(_ list: [WelcomeTree.Workspace]) { for node in list { all.append(node); walk(node.children) } }
        walk(tree?.workspaces ?? [])
        func byId(_ id: String?) -> WelcomeTree.Workspace? { id.flatMap { id in all.first { $0.id == id } } }
        func number(_ node: WelcomeTree.Workspace) -> Int {
            let name = node.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if let match = name.range(of: #" (\d+)$"#, options: .regularExpression) {
                return Int(name[match].trimmingCharacters(in: .whitespaces)) ?? 1
            }
            return 1
        }
        let welcomeNames = all.filter {
            $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                .range(of: #"^welcome( to engelbart)?!?( \d+)?$"#, options: [.regularExpression, .caseInsensitive]) != nil
        }
        // A stable sort, newest (highest number) first; equal numbers keep the tree's order, as Array.sort does in JS.
        let welcome = welcomeNames.enumerated().sorted { a, b in
            let na = number(a.element), nb = number(b.element)
            return na != nb ? na > nb : a.offset < b.offset
        }.first?.element
        guard let workspace = byId(given) ?? welcome ?? byId(current) ?? all.first else { return WelcomeLanding(workspaceId: nil, tab: nil) }
        let isWelcome = workspace.name.range(of: "^welcome", options: [.regularExpression, .caseInsensitive]) != nil
        let note = isWelcome ? nil : (tree?.notes ?? []).first {
            $0.workspaceId == workspace.id && $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                .range(of: "^welcome!?$", options: [.regularExpression, .caseInsensitive]) != nil
        }
        return WelcomeLanding(workspaceId: workspace.id, tab: note.map { .init(id: $0.id, title: $0.name) })
    }
}
