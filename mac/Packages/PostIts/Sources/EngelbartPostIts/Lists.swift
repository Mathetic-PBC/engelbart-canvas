import Foundation
import EngelbartDoc

/// A workspace as model/nav.js flatWorkspaces lists them: every one, nested ones after their parent, `above` the names
/// of the workspaces it is inside (outermost first).
public struct WorkspaceEntry: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var above: [String]
    public init(id: String, name: String, above: [String] = []) { self.id = id; self.name = name; self.above = above }
}

/// A library row the Build popup's Context can pick, with when it was last written in (rail.js `when`).
public struct PickRow: Equatable, Sendable, Identifiable {
    public var row: LibRow
    public var lastEdited: Date?
    public var id: String { row.id }
    public var name: String { row.name }
    public init(row: LibRow, lastEdited: Date? = nil) { self.row = row; self.lastEdited = lastEdited }
}

public enum PostItLists {
    /// A nested tree (`{ id, name, children }`) flattened as nav.js flatWorkspaces does.
    public struct Node: Sendable {
        public var id: String, name: String, children: [Node]
        public init(id: String, name: String, children: [Node] = []) { self.id = id; self.name = name; self.children = children }
    }
    public static func flatWorkspaces(_ roots: [Node]) -> [WorkspaceEntry] {
        var out: [WorkspaceEntry] = []
        func walk(_ list: [Node], _ above: [String]) {
            for node in list {
                out.append(WorkspaceEntry(id: node.id, name: node.name, above: above))
                walk(node.children, above + [node.name])
            }
        }
        walk(roots, [])
        return out
    }

    static func words(_ query: String) -> [String] {
        query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// The workspace switcher's search (nav.js findWorkspaces): every workspace whose name holds the words typed, in any
    /// order; names that start with them first.
    public static func findWorkspaces(_ all: [WorkspaceEntry], _ query: String) -> [WorkspaceEntry] {
        let words = words(query)
        guard let first = words.first else { return [] }
        let hits = all.enumerated().filter { _, w in let name = w.name.lowercased(); return words.allSatisfy { name.contains($0) } }
        let starts = { (w: WorkspaceEntry) in w.name.lowercased().hasPrefix(first) ? 0 : 1 }
        return hits.sorted { (starts($0.element), $0.offset) < (starts($1.element), $1.offset) }.map(\.element)
    }

    /// What "Add from library" lists before anything is typed.
    public static let ATTACH_RECENT = 8

    /// rail.js attachRows: empty, the things written in last; typed, everything whose name, place, kind or summary holds
    /// all the words, names that start with them first, then (with `bodies`) what holds them only in what it says. Never an
    /// image (a Build is not given pictures) nor what is attached already (`taken`).
    public static func attachRows(query: String, library: [PickRow], taken: Set<String> = [], bodies: [String: String]? = nil) -> [PickRow] {
        let words = words(query.trimmingCharacters(in: .whitespacesAndNewlines))
        let pool = library.filter { $0.row.type != "image" && !taken.contains($0.row.id) }
        func hay(_ r: PickRow) -> String {
            [r.row.name, r.row.url ?? "", r.row.path ?? "", r.row.folderPath ?? "", Kind.kindLabel(r.row), r.row.summary ?? ""].joined(separator: " ").lowercased()
        }
        let inHay = { (r: PickRow) in let text = hay(r); return words.allSatisfy { text.contains($0) } }
        let inEither = { (r: PickRow) -> Bool in
            let text = hay(r), body = bodies?[r.row.id]?.lowercased() ?? ""
            return words.allSatisfy { text.contains($0) || body.contains($0) }
        }
        let hits = words.isEmpty ? pool : pool.filter(inHay)
        let found = Set(hits.map(\.row.id))
        let said = words.isEmpty ? [] : pool.filter { !found.contains($0.row.id) && inEither($0) }
        let starts = { (r: PickRow) in !words.isEmpty && r.row.name.lowercased().hasPrefix(words[0]) ? 0 : 1 }
        let when = { (r: PickRow) in r.lastEdited?.timeIntervalSince1970 ?? 0 }
        func order(_ rows: [PickRow]) -> [PickRow] {
            rows.enumerated().sorted { a, b in
                let sa = starts(a.element), sb = starts(b.element)
                if sa != sb { return sa < sb }
                let wa = when(a.element), wb = when(b.element)
                if wa != wb { return wa > wb }
                return a.offset < b.offset // Array.sort is stable in JavaScript
            }.map(\.element)
        }
        let sorted = order(hits) + order(said)
        return words.isEmpty ? Array(sorted.prefix(ATTACH_RECENT)) : sorted
    }
}
