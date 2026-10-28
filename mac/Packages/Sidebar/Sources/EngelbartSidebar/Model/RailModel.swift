import Foundation
import EngelbartCore
import EngelbartDoc
import EngelbartStore

// What the library searches: the sidebar's Search and Library, the add picker's search (src/renderer/model/rail.js, the
// parts the sidebar uses). The @ menu's rows (mentionRows, folderRows, nameParts) are the Editor's; "Add from library"
// (attachRows) is the Build panel's.

public extension LibraryRow {
    /// The Doc package's reading of this row (kind.js works on it).
    var lib: LibRow {
        LibRow(id: id, name: name, type: type, tags: tags, path: path, folderPath: folderPath, url: url, summary: summary, projectId: projectId, source: source)
    }
}

public extension Library.Found {
    var lib: LibRow { LibRow(id: "", name: name, type: type, tags: tags, path: path, folderPath: folderPath, url: url) }
}

/// A row of a library search.
public struct SearchResult: Equatable {
    public enum Kind: Equatable { case item, fresh }
    public var kind: Kind
    public var key: String
    public var name: String
    /// What sits at the right: "here", the kind words, "new <kind>" (a + is drawn for those).
    public var tag: String
    public var row: LibraryRow?
    public var found: Library.Found?
    public init(kind: Kind, key: String, name: String, tag: String, row: LibraryRow? = nil, found: Library.Found? = nil) {
        self.kind = kind; self.key = key; self.name = name; self.tag = tag; self.row = row; self.found = found
    }
}

/// What things say (MATH-29): library id and workspace id → text, lowercased once.
public struct Bodies: Equatable {
    public var items: [String: String]
    public var workspaces: [String: String]
    public init(items: [String: String] = [:], workspaces: [String: String] = [:]) { self.items = items; self.workspaces = workspaces }
}

/// One link or path of what was pasted into "Upload URL or path".
public struct ParsedSource: Equatable {
    public var text: String
    public var ok: Bool
    public var why: String?
    /// A path with spaces that may be one name: its words, judged, for when nothing is at it whole.
    public var split: [ParsedSource]?
}

public enum RailModel {
    // A web address without its scheme (github.com, example.org/page), as the main process reads one.
    static let BARE_HOST = Rx(#"^(?:www\.)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$"#, "i")
    static let FILE_NAME = Rx(#"^[^./]+\.(?:md|markdown|txt|pdf|html?|png|jpe?g|gif|webp|svg|docx?|pptx?|xlsx?|csv|json|ya?ml|py|js|ts|ipynb|tex|bib|zip)$"#, "i")
    static let QUOTED = Rx(#"^["'](.*)["']$"#)
    static let SPACE = Rx(#"\s"#)
    static let ADDRESSES = [Rx(#"^https?:\/\/\S+\.\S*"#, "i"), Rx(#"^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$"#, "i"), Rx(#"^(doi:\s*)?10\.\d{4,9}\/\S+$"#, "i"),
                            Rx(#"^(?:ssh|git):\/\/"#, "i"), Rx(#"^[\w.-]+@[\w.-]+:\S+"#), Rx(#"^(~\/|\/|file:\/\/)\S"#)]

    static func bareAddress(_ v: String) -> Bool { BARE_HOST.test(v) && !FILE_NAME.test(v) }

    /// Something the library could add, by its spelling alone. The main process decides for real.
    public static func looksAddable(_ value: String?) -> Bool {
        let v = QUOTED.replace((value ?? "").trimmed, with: "$1").trimmed
        if v.isEmpty || SPACE.test(v) { return false }
        return ADDRESSES.contains { $0.test(v) } || bareAddress(v)
    }

    static let PATHISH = Rx(#"^(~\/|\/)\S"#)
    static let PATH_START = Rx(#"^(~\/|\/|file:\/\/)"#)

    /// What is pasted into the add picker's "Upload URL or path": several at once.
    public static func parseSources(_ raw: String?) -> [ParsedSource] {
        func shaped(_ text: String) -> Bool { looksAddable(text) || PATHISH.test(text) }
        func judged(_ text: String) -> ParsedSource { shaped(text) ? ParsedSource(text: text, ok: true) : ParsedSource(text: text, ok: false, why: "\"\(text)\" is not a link or a path") }
        var out: [ParsedSource] = []
        for chunk in Rx(#"[\n,]+"#).split(raw ?? "").map({ $0.trimmed }).filter({ !$0.isEmpty }) {
            let pieces = Rx(#"\s+"#).split(chunk)
            if pieces.count > 1 && PATH_START.test(chunk) && !pieces.allSatisfy(shaped) { out.append(ParsedSource(text: chunk, ok: true, split: pieces.map(judged))) }
            else { out += pieces.map(judged) }
        }
        return out
    }

    /// What a row is searched by: its name, where it is, the words shown beside it, and its summary.
    static func hay(_ row: LibraryRow) -> String {
        [row.name, row.url ?? "", row.path ?? "", row.folderPath ?? "", Kind.kindLabel(row.lib), row.summary ?? ""].joined(separator: " ").lowercased()
    }

    /// `bodies` from the store's answer, lowercased once.
    public static func bodyMaps(_ reply: Library.Bodies?) -> Bodies {
        Bodies(items: (reply?.items ?? [:]).mapValues { $0.lowercased() }, workspaces: (reply?.workspaces ?? [:]).mapValues { $0.lowercased() })
    }

    /// How well a row matches (MATH-59), best first: 0 name starts, 1 name holds, 2 place or kind, 3 the rest (summary), 4 only what it says.
    static func matchRank(_ row: LibraryRow, _ needle: String, _ bodies: Bodies?) -> Int? {
        let name = row.name.lowercased()
        if name.hasPrefix(needle) { return 0 }
        if name.contains(needle) { return 1 }
        if [row.url ?? "", row.path ?? "", row.folderPath ?? "", Kind.kindLabel(row.lib)].joined(separator: " ").lowercased().contains(needle) { return 2 }
        if hay(row).contains(needle) { return 3 }
        return (bodies?.items[row.id] ?? "").contains(needle) ? 4 : nil
    }

    static func ranked(_ rows: [LibraryRow], _ needle: String, _ bodies: Bodies?) -> [LibraryRow] {
        rows.enumerated().compactMap { i, row in matchRank(row, needle, bodies).map { (row: row, i: i, rank: $0) } }
            .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.i < $1.i }.map(\.row)
    }

    /// The library's search (Canvas.dc.html `results`). `found`: the main process's answer for an address or a path
    /// (nil while it is on its way).
    public static func searchRows(query: String?, library: [LibraryRow], inRail: (String) -> Bool, found: Library.Lookup? = nil, bodies: Bodies? = nil) -> [SearchResult] {
        let typed = (query ?? "").trimmed
        func item(_ row: LibraryRow) -> SearchResult { SearchResult(kind: .item, key: row.id, name: row.name, tag: inRail(row.id) ? "here" : Kind.kindLabel(row.lib), row: row) }
        func answered() -> SearchResult? {
            guard let found, found.error == nil || found.error?.isEmpty == true else { return nil }
            if let row = found.row { return item(row) }
            if let fresh = found.found { return SearchResult(kind: .fresh, key: "fresh:\(typed)", name: fresh.name, tag: "new \(Kind.kindLabel(fresh.lib))", found: fresh) }
            return nil
        }
        // A bare address (anthropic.com) is still searched for as text first, then is the row the main process found for it.
        let bare = bareAddress(typed)
        if looksAddable(typed) && !bare { return answered().map { [$0] } ?? [] }
        let needle = typed.lowercased()
        let hits = !needle.isEmpty ? ranked(library, needle, bodies)
            : Array(library.filter { !inRail($0.id) && !$0.tags.contains("note") && $0.type != "image" }.prefix(4))
        let rows = hits.map(item)
        if bare, let one = answered(), !rows.contains(where: { $0.key == one.key }) { return rows + [one] }
        return rows
    }

    /// How many rows the sidebar's Library panel lists before anything is typed.
    public static let LIBRARY_RECENT = 40
    static func edited(_ row: LibraryRow) -> Double { JSTime.ms(row.lastEdited.isEmpty ? row.created : row.lastEdited) }

    /// The sidebar's Library panel: the chip narrows first; nothing typed, the 40 last edited; typed, searchRows over that.
    public static func libraryPanelRows(query: String?, library: [LibraryRow], chip: String = "all", inRail: (String) -> Bool, found: Library.Lookup? = nil, bodies: Bodies? = nil) -> [SearchResult] {
        let things = library.filter { Kind.libraryFilter($0.lib, chip) }
        let typed = (query ?? "").trimmed
        if typed.isEmpty {
            return Array(things.enumerated().sorted { a, b in
                let ea = edited(a.element), eb = edited(b.element)
                return ea != eb ? ea > eb : a.offset < b.offset
            }.prefix(LIBRARY_RECENT)).map { SearchResult(kind: .item, key: $0.element.id, name: $0.element.name, tag: inRail($0.element.id) ? "here" : "", row: $0.element) }
        }
        return searchRows(query: typed, library: things, inRail: inRail, found: found, bodies: bodies)
    }

    /// The notes let go of (MATH-58): trashed from a workspace and held by none of the project's workspaces any more.
    /// `workspaces` the tree's, nested; `notes` the tree's (id → the workspace it was made in). Store's ProjectHolds rule.
    public static func letGoNotes(workspaces: [WorkspaceNode], notes: [NoteInfo]) -> Set<String> {
        var all: [WorkspaceNode] = []
        func walk(_ list: [WorkspaceNode]) { for ws in list { all.append(ws); walk(ws.children) } }
        walk(workspaces)
        var madeIn: [String: String?] = [:]
        for note in notes { madeIn[note.id] = .some(note.workspaceId) }
        return ProjectHolds.letGo(all.map { ProjectHolds.WorkspaceHold(id: $0.id, context: $0.context, removed: $0.removed) }, madeIn)
    }
}
