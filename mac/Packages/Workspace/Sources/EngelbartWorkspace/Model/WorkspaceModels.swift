import Foundation
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// The pure parts of src/renderer/screens/Workspace.jsx, DocTabs.jsx's reorder and model/notepick.js: what a tab stands
// for, which tabs a workspace reopens with, the rows the sidebar is given, and the small pieces of text the screen writes.
// Nothing here touches a view or the disk; WorkspaceModel (the component's state and logic) calls these.

public typealias StoreDocRef = EngelbartStore.DocRef
/// The library row is the Store's (Bart and Build declare their own of the same name).
public typealias LibraryRow = EngelbartStore.LibraryRow

/// A document tab (Workspace.jsx `tabs`): 'ws' (the workspace's own document), 'project' (the top-level project's page),
/// `archive:<file>` (an archived version, read-only) or a note's library id.
public struct DocTab: Equatable, Sendable {
    public var id: String
    public var title: String
    public init(id: String, title: String) { self.id = id; self.title = title }
    public var json: JSONValue { ["id": .string(id), "title": .string(title)] }
}

/// What a pane shows, and how main reads it (Workspace.jsx docOf's `ref`).
public enum PaneRef: Equatable, Sendable {
    case workspace(String)
    case note(String)
    case project
    case archive(workspaceId: String, file: String)

    /// The Store's reference (nil for an archive, which is read by readArchive and never written).
    public var store: StoreDocRef? {
        switch self {
        case .workspace(let id): return .workspace(workspaceId: id)
        case .note(let id): return .note(id: id)
        case .project: return .project
        case .archive: return nil
        }
    }
    public var isArchive: Bool { if case .archive = self { return true }; return false }
    public var workspaceId: String? { if case .workspace(let id) = self { return id }; return nil }
    /// The renderer's `{ kind, … }` shape (what ask-bart, build places and reveal targets carry).
    public var json: JSONValue {
        switch self {
        case .workspace(let id): return ["kind": "workspace", "workspaceId": .string(id)]
        case .note(let id): return ["kind": "note", "id": .string(id)]
        case .project: return ["kind": "project"]
        case .archive(let w, let f): return ["kind": "archive", "workspaceId": .string(w), "file": .string(f)]
        }
    }
}

/// A pane's document: its key in `docs`, its ref, the workspace whose document it is, the archived version's file.
public struct PaneDoc: Equatable, Sendable {
    public var key: String?
    public var ref: PaneRef?
    public var workspaceId: String?
    public var archive: String?
    public static let none = PaneDoc(key: nil, ref: nil, workspaceId: nil, archive: nil)
}

public enum WorkspaceTabs {
    public static let ws = "ws"
    public static let project = "project"
    /// An archived version's tab (2026-09-27: it opens in the middle, read-only, not on the Stage).
    public static let archivePrefix = "archive:"
    public static let wsTab = DocTab(id: ws, title: "Project")

    public static func workspaceDoc(_ id: String) -> PaneDoc { PaneDoc(key: "ws:\(id)", ref: .workspace(id), workspaceId: id, archive: nil) }

    /// The document a tab stands for in this workspace (`topicId`). A note beside the document is its note's tab.
    public static func docOf(_ tabId: String, topicId: String?) -> PaneDoc {
        if tabId == ws { return topicId.map(workspaceDoc) ?? .none }
        if tabId == project { return PaneDoc(key: "project", ref: .project, workspaceId: nil, archive: nil) }
        if tabId.hasPrefix(archivePrefix) {
            guard let topicId else { return .none }
            let file = String(tabId.dropFirst(archivePrefix.count))
            return PaneDoc(key: "archive:\(topicId):\(file)", ref: .archive(workspaceId: topicId, file: file), workspaceId: nil, archive: file)
        }
        return PaneDoc(key: "note:\(tabId)", ref: .note(tabId), workspaceId: nil, archive: nil)
    }

    /// A workspace's remembered tabs, less notes that are gone, with their current names; `extra` is a note being opened
    /// into it. The Workspace tab is the only workspace document in the strip (2026-09-25: "I should not be able to have
    /// two workspace tabs open"); another workspace's tab remembered from the 2026-09-23 build is left behind.
    public static func restoredTabs(view: JSONValue?, notes: [String: String], extra: DocTab?) -> (tabs: [DocTab], active: String) {
        var tabs = [wsTab]
        for tab in view?["tabs"]?.array ?? [] {
            guard let id = tab["id"]?.string else { continue }
            if tabs.contains(where: { $0.id == id }) || tab["kind"]?.string == "workspace" { continue }
            if id == project { tabs.append(DocTab(id: project, title: tab["title"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "Project page")); continue }
            if let name = notes[id] { tabs.append(DocTab(id: id, title: name)) }
        }
        if let extra, !tabs.contains(where: { $0.id == extra.id }) { tabs.append(extra) }
        let wanted = view?["active"]?.string
        let active = extra?.id ?? (wanted.flatMap { w in tabs.contains(where: { $0.id == w }) ? w : nil } ?? ws)
        return (tabs, active)
    }

    /// Dragging a note tab onto another takes its place; Workspace is not part of the shuffle. → nil when nothing moves.
    public static func moveTab(_ tabs: [DocTab], _ id: String, over overId: String) -> [DocTab]? {
        guard let from = tabs.firstIndex(where: { $0.id == id }), let to = tabs.firstIndex(where: { $0.id == overId }),
              id != ws, overId != ws, from != to else { return nil }
        var next = tabs
        let moved = next.remove(at: from)
        next.insert(moved, at: to)
        return next
    }

    /// Any note's tab closes; Workspace is always there (2026-09-25); the last tab never closes. The one in front closing
    /// puts the last one in front. → nil when nothing closes.
    public static func closeTab(_ tabs: [DocTab], active: String, _ id: String) -> (tabs: [DocTab], active: String)? {
        guard id != ws, tabs.contains(where: { $0.id == id }), tabs.count >= 2 else { return nil }
        let next = tabs.filter { $0.id != id }
        return (next, active == id ? next[next.count - 1].id : active)
    }

    /// A tab's title as the strip shows it: the project page's is the project's name now.
    public static func shown(_ tabs: [DocTab], projectName: String) -> [DocTab] {
        tabs.map { $0.id == project ? DocTab(id: project, title: projectName) : $0 }
    }
}

/// Every workspace of the tree by id, with its parent's id (Workspace.jsx indexWorkspaces).
public struct WorkspaceIndex {
    public struct Entry { public var node: WorkspaceNode; public var parent: String? }
    public private(set) var byId: [String: Entry] = [:]
    /// Tree order (depth first).
    public private(set) var order: [String] = []
    public init(_ roots: [WorkspaceNode]) {
        func walk(_ list: [WorkspaceNode], _ parent: String?) {
            for node in list { byId[node.id] = Entry(node: node, parent: parent); order.append(node.id); walk(node.children, node.id) }
        }
        walk(roots, nil)
    }
    public func has(_ id: String?) -> Bool { id.map { byId[$0] != nil } ?? false }
    public subscript(_ id: String) -> Entry? { byId[id] }
    /// The siblings of `id` (the parent's children, or the top level).
    public func level(of id: String, roots: [WorkspaceNode]) -> [WorkspaceNode] {
        guard let at = byId[id] else { return roots }
        return at.parent.flatMap { byId[$0]?.node.children } ?? roots
    }
    /// The names of the workspaces above `id`, top first.
    public func above(_ id: String) -> [String] {
        var out: [String] = []
        var up = byId[id]?.parent
        while let p = up, let e = byId[p] { out.insert(e.node.name, at: 0); up = e.parent }
        return out
    }
    /// Whether `id` is `from` or lies under it.
    public func within(_ id: String?, _ from: String) -> Bool {
        var at = id
        while let a = at { if a == from { return true }; at = byId[a]?.parent }
        return false
    }
}

/// A file @create made, as a Stage tab shows it (Workspace.jsx madeAt): `<…>/.created/<askId>/<rel>` or its file:// address.
public struct MadeRef: Equatable, Hashable, Sendable {
    public var askId: String
    public var rel: String
    public var name: String
    public var key: String { "\(askId)/\(rel)" }
    public init(askId: String, rel: String, name: String) { self.askId = askId; self.rel = rel; self.name = name }

    static let place = Rx(#"\/\.created\/([\w-]+)\/(.+)$"#)
    public static func at(_ place: String?) -> MadeRef? {
        var whereTo = place ?? ""
        if whereTo.lowercased().hasPrefix("file:") {
            guard let url = URL(string: whereTo) else { return nil }
            whereTo = url.path
        }
        guard let m = MadeRef.place.match(whereTo.replacingOccurrences(of: "\\", with: "/")), let askId = m[1], let rel = m[2] else { return nil }
        if rel.components(separatedBy: "/").contains("..") { return nil }
        return MadeRef(askId: askId, rel: rel, name: rel.components(separatedBy: "/").last ?? rel)
    }
}

public enum WorkspaceText {
    /// Copy's word while it shows what it did: "Copied · 3 files · 1 missing".
    public static func copiedLabel(files: Int, missing: Int) -> String {
        var parts = ["Copied"]
        if files > 0 { parts.append("\(files) file\(files == 1 ? "" : "s")") }
        if missing > 0 { parts.append("\(missing) missing") }
        return parts.joined(separator: " · ")
    }

    /// Why a question from a highlight's note got no answer, as its box says it: the reply's words without "No answer.".
    public static func paperFailure(_ lines: [String]?) -> String {
        Rx(#"^\*\*No answer\.\*\*\s*"#).replace(MarkAnswers.answerOf(lines ?? []).answer, with: "")
    }

    /// An answer's words, for naming the conversation an empty line started (2026-10-14).
    public static func answerText(_ lines: [String]) -> String {
        String(MarkAnswers.answerOf(lines).answer.prefix(4000))
    }

    /// A new ask id for a research box this window puts in (DocEditor newAskId).
    public static func newAskId() -> String { EditorTextIds.newAskId() }

    /// A highlight ask's id: `h<time base 36><6 random>`.
    public static func highlightAskId(now: Date = Date()) -> String {
        let chars = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return "h" + String(Int64(now.timeIntervalSince1970 * 1000), radix: 36) + String((0..<6).map { _ in chars.randomElement()! })
    }

    /// The empty project's words (noWorkspace).
    public static func emptyProject(_ name: String) -> String {
        "Nothing in \(name) yet. A project holds a document, its sources, and any projects nested inside it."
    }

    /// Copy's tooltip.
    public static func copyTitle(workspaceDoc: Bool, projectPage: Bool) -> String {
        workspaceDoc ? "Copy current project" : projectPage ? "Copy the project page" : "Copy current note"
    }
}

/// A new ask id as the editor makes them (time base 36, a dash, 8 random): kept here so the model needs no editor.
enum EditorTextIds {
    static func newAskId(now: Date = Date()) -> String {
        let chars = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String(Int64(now.timeIntervalSince1970 * 1000), radix: 36) + "-" + String((0..<8).map { _ in chars.randomElement()! })
    }
}

/// The + beside the document's tabs (model/notepick.js, 2026-09-25): "the plus button on middle canvas should allow me to
/// search for a note to open (it does not necessarily have to be linked to current workspace) or to create a new note —
/// it should not automatically create a new note."
public enum NotePick {
    public static let recent = 8 // notes shown before anything is typed

    public struct Row: Equatable {
        public enum Kind: Equatable { case new, note }
        public var kind: Kind
        public var key: String
        public var name: String
        public var row: LibraryRow?
        /// 'open' (in a tab), 'here' (in this workspace) or ''.
        public var tag: String
    }

    static func when(_ row: LibraryRow) -> Double { WorkspaceTime.ms(row.lastEdited.isEmpty ? row.created : row.lastEdited) }

    /// Empty: New note first, then the notes written in last. Typed: every note of the whole library whose name holds all
    /// the words, the ones that start with what was typed first, then New note named what was typed.
    public static func rows(query: String, library: [LibraryRow], openIds: [String] = [], inRail: (String) -> Bool = { _ in false }) -> [Row] {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let needle = typed.lowercased()
        let words = needle.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let notes = library.filter { $0.isNote }
        let hits = words.isEmpty ? notes : notes.filter { row in words.allSatisfy { row.name.lowercased().contains($0) } }
        func starts(_ row: LibraryRow) -> Int { !words.isEmpty && row.name.lowercased().hasPrefix(needle) ? 0 : 1 }
        let sorted = hits.enumerated().sorted { a, b in
            let sa = starts(a.element), sb = starts(b.element)
            if sa != sb { return sa < sb }
            let wa = when(a.element), wb = when(b.element)
            if wa != wb { return wa > wb }
            return a.offset < b.offset
        }.map(\.element)
        let open = Set(openIds)
        let found = (words.isEmpty ? Array(sorted.prefix(recent)) : sorted).map { row in
            Row(kind: .note, key: row.id, name: row.name, row: row, tag: open.contains(row.id) ? "open" : inRail(row.id) ? "here" : "")
        }
        let make = Row(kind: .new, key: "new", name: typed, row: nil, tag: "")
        return words.isEmpty ? [make] + found : found + [make]
    }
}

public enum WorkspaceTime {
    /// Date.parse of an ISO time in milliseconds, 0 when it is not one.
    public static func ms(_ iso: String?) -> Double {
        guard let iso, !iso.isEmpty else { return 0 }
        if let d = formatter.date(from: iso) ?? plain.date(from: iso) { return d.timeIntervalSince1970 * 1000 }
        return 0
    }
    public static func iso(_ date: Date = Date()) -> String { formatter.string(from: date) }
    nonisolated(unsafe) static let formatter: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    nonisolated(unsafe) static let plain: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
}

public extension LibraryRow {
    var isNote: Bool { tags.contains("note") }
    /// Doc's row (what the editor, the @ menu and kind.js read).
    var libRow: LibRow { LibRow(id: id, name: name, type: type, tags: tags, path: path, folderPath: folderPath, url: url, summary: summary, projectId: projectId, source: source) }
}

/// The rows the sidebar and the editors are given (Workspace.jsx `mentioned`, `rows`, `describe`).
public enum WorkspaceRows {
    // A note or a library row by its name; `@[Name](ws:<id>)` is a workspace, `@[Name](lib:<folderId>:<path>)` a file in a
    // library folder (MATH-22), and `@[Title](zotero:<key>)` a Zotero item (MATH-65): no rows of their own.
    static let mentionRe = Rx(#"@\[([^\]\n]+)\](?!\(ws:|\(lib:[\w-]+:|\(zotero:)"#, "g")
    static let libIdRe = Rx(#"@\[[^\]\n]+\]\(lib:([\w-]+)\)"#, "g")
    static let imageRefRe = Rx(#"\]\(img:([\w-]+)\)"#, "g")

    /// The pictures a text shows (`](img:<id>)`), in order, each once.
    public static func imageIds(_ text: String) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for m in imageRefRe.matchAll(text) { if let id = m[1], seen.insert(id).inserted { out.append(id) } }
        return out
    }

    /// What a workspace's document mentions: by name (`@[Name]`), by id (`(lib:<id>)`, a web page's is never its address,
    /// 2026-10-17), pictures by id only (pasted ones share names, "Attachment 1").
    public static func mentioned(_ text: String, library: [LibraryRow]) -> [LibraryRow] {
        guard !text.isEmpty else { return [] }
        let names = Set(mentionRe.matchAll(text).compactMap { $0[1]?.lowercased() })
        let ids = Set(libIdRe.matchAll(text).compactMap { $0[1] })
        let shown = Set(imageRefRe.matchAll(text).compactMap { $0[1] })
        return library.filter { row in
            row.type == "image" ? shown.contains(row.id) || ids.contains(row.id) : names.contains(row.name.lowercased()) || ids.contains(row.id)
        }
    }

    /// This workspace's sources (the sidebar's Your sources): its context, the notes made in it and what its document
    /// mentions, never what it threw away (`removed`), each once.
    public static func rail(topic: WorkspaceNode?, library: [LibraryRow], notes: [NoteInfo], mentioned: [LibraryRow]) -> [LibraryRow] {
        guard let topic else { return [] }
        let byId = Dictionary(library.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var present = Set(topic.removed)
        var out: [LibraryRow] = []
        for id in topic.context {
            guard let row = byId[id], !present.contains(row.id) else { continue }
            present.insert(row.id); out.append(row)
        }
        for note in notes where note.workspaceId == topic.id && !present.contains(note.id) {
            present.insert(note.id)
            out.append(byId[note.id] ?? LibraryRow.stub(id: note.id, name: note.name))
        }
        for row in mentioned where !present.contains(row.id) { present.insert(row.id); out.append(row) }
        return out
    }

    /// A row as the editor's hover card describes it (Workspace.jsx describe): a note of this project or another, a
    /// repository's clone or address, a page's address, a file's folder or name; the catalog's summary once there is one.
    public static func describe(_ row: LibraryRow, projectId: String, trashed: Bool = false) -> (summary: String, facts: String) {
        var summary: String
        if row.isNote { summary = row.projectId == projectId ? "A note in this project." : "A note in another project." }
        else if row.hasTag("git") { summary = row.folderPath.map { "Cloned at \($0)" } ?? row.url ?? "A repository." }
        else if row.type == "website" { summary = row.url ?? "A linked page." }
        else { summary = row.folderPath ?? row.path.map { ($0 as NSString).lastPathComponent } ?? "" }
        if let s = row.summary, !s.isEmpty { summary = s }
        let label = KindIcons.kind(Kind.kindKey(row.libRow)).label
        let edited = row.lastEdited.isEmpty ? "" : " · edited \(row.lastEdited.prefix(10))"
        return (summary, "\(label)\(edited)")
    }
}

extension LibraryRow {
    /// A note the library has not listed yet (a row made from the tree's note).
    static func stub(id: String, name: String) -> LibraryRow {
        LibraryRow(id: id, name: name, type: "md", created: "", lastEdited: "", tags: ["note"])
    }
}

/// What a Zotero item's chip does with main's answer to zotero-open (model/zotero.js): a pdf opens on the Stage; an item
/// with no pdf opens its DOI's page or its URL in the default browser, never on the Stage (publishers' bot checks).
public enum ZoteroChip {
    public enum Action: Equatable { case pdf(String), external(String), error(String) }
    public static func action(_ target: JSONValue?, name: String) -> Action {
        if let path = target?["path"]?.string, !path.isEmpty { return .pdf(path) }
        if let url = target?["url"]?.string, url.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil { return .external(url) }
        return .error(target?["error"]?.string ?? "\"\(name.isEmpty ? "This item" : name)\" could not be opened")
    }
}

/// The Welcome walkthrough's pure bits used here (model/getting-started.js); the card itself is the sidebar slot's.
public enum Walkthrough {
    /// The hint on an empty last line of a document while the walkthrough shows.
    public static let emptyHint = "Write your thoughts…"
    public static let steps = 3
    /// Whether a workspace shows the steps: the Welcome workspace's, unless hidden.
    public static func shows(_ state: JSONValue?, workspaceId: String?) -> Bool {
        guard let state, state.object != nil, state["hidden"]?.bool != true, let workspaceId, workspaceId == state["workspaceId"]?.string else { return false }
        return true
    }
    /// The ticks after a change (Workspace.jsx changeWalk): nil when nothing changes.
    public static func changed(_ ticked: [Int], hiddenNow: Bool, tick: [Int], untick: [Int], hidden: Bool) -> (ticked: [Int], hidden: Bool, tick: [Int], untick: [Int])? {
        if hiddenNow { return nil }
        let t = tick.filter { !ticked.contains($0) }, u = untick.filter { ticked.contains($0) }
        if t.isEmpty && u.isEmpty && !hidden { return nil }
        let next = (ticked + t).filter { !u.contains($0) }.sorted()
        return (next, hidden, t, u)
    }

    static let guideTitle = Rx(#"^\*\*\[([^\]\n]+)\]\(([^)\s]+)\)\*\*\s*(?:·\s*(.*))?$"#)
    static let guideRead = Rx(#"^\*\*Read:\*\*\s*\[([^\]\n]+)\]\(([^)\s]+)\)"#)
    static let guideWhy = Rx(#"^\*\*Why:\*\*\s*(.+)$"#)
    public struct Paper: Equatable { public var key: String; public var title: String; public var byline: String; public var why: String; public var address: String }
    /// Step 3's papers: the ones @discover's guides in a document found, in order, each once, at most `max`.
    public static func discoverPapers(_ text: String?, max: Int = 3) -> [Paper] {
        struct Entry { var key, title, by, section, why, address: String }
        var out: [Entry] = []
        var seen = Set<String>()
        var at: Int? = nil
        for raw in (text ?? "").components(separatedBy: "\n") {
            guard let reply = DocRx.REPLY.match(raw) else { at = nil; continue }
            let line = (reply[2] ?? "").trimmingCharacters(in: .whitespaces)
            if let t = guideTitle.match(line) {
                at = nil
                let address = Rx(#"#.*$"#).replace(t[2] ?? "", with: "")
                if seen.contains(address) || out.count >= max { continue }
                seen.insert(address)
                let by = Rx(#"\s+et al\.?"#, "i").replace(t[3] ?? "", with: "").trimmingCharacters(in: .whitespaces)
                out.append(Entry(key: address, title: (t[1] ?? "").trimmingCharacters(in: .whitespaces), by: by, section: "", why: "", address: t[2] ?? ""))
                at = out.count - 1
                continue
            }
            guard let i = at else { continue }
            if let r = guideRead.match(line), out[i].section.isEmpty { out[i].section = (r[1] ?? "").trimmingCharacters(in: .whitespaces); out[i].address = r[2] ?? ""; continue }
            if let w = guideWhy.match(line), out[i].why.isEmpty { out[i].why = (w[1] ?? "").trimmingCharacters(in: .whitespaces) }
        }
        return out.map { Paper(key: $0.key, title: $0.title, byline: [$0.by, $0.section].filter { !$0.isEmpty }.joined(separator: " · "), why: $0.why, address: $0.address) }
    }
}

/// The screen's widths (Workspace.jsx "resizing", Add - Mention.dc.html 2026-09-22): the sidebar 220–520 (300 by default),
/// the document at least 280, the right pane at least 320 and half of what the sidebar leaves until its edge is dragged.
public struct WorkspaceLayout: Equatable {
    public static let railMin: CGFloat = 220, railMax: CGFloat = 520, railDefault: CGFloat = 300, docMin: CGFloat = 280, rightMin: CGFloat = 320
    /// A column too narrow for two of these side by side scrolls sideways instead (MATH-23).
    public static let paneMin: CGFloat = 240
    public static let titleLine: CGFloat = 27
    public static let titleBar: CGFloat = 44 // TITLE_LINE + 17: a tab is 34px, its title in its middle

    public var rail: CGFloat
    public var railShown: Bool
    public var railSpace: CGFloat
    public var right: CGFloat
    /// The right pane's width as drawn (its full screen takes the document's place).
    public var paneWidth: CGFloat
    public var rightRoom: CGFloat

    public static func clamp(_ v: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat { Swift.max(a, Swift.min(b, v)) }

    public init(viewWidth: CGFloat, railWidth: CGFloat, railHidden: Bool, rightWidth: CGFloat?, stageFull: Bool) {
        let railRoom = Swift.max(Self.railMin, viewWidth - 2 - Self.docMin - Self.rightMin)
        rail = Self.clamp(railWidth, Self.railMin, Swift.min(Self.railMax, railRoom))
        // Folded away, the sidebar and its edge take no room. The document's full screen keeps it (2026-10-15, David).
        railShown = !railHidden
        railSpace = railShown ? rail + 1 : 0
        rightRoom = Swift.max(Self.rightMin, viewWidth - railSpace - 1 - Self.docMin)
        right = Self.clamp(rightWidth ?? ((viewWidth - railSpace - 1) / 2).rounded(), Self.rightMin, rightRoom)
        paneWidth = stageFull ? Swift.max(Self.rightMin, viewWidth - railSpace) : right
    }

    /// The sidebar's edge dragged to `x` (from the body's left): the document gives, the right pane keeps `right`.
    public static func railDragged(x: CGFloat, viewWidth: CGFloat, right: CGFloat) -> CGFloat {
        clamp(x, railMin, Swift.min(railMax, Swift.max(railMin, viewWidth - 2 - docMin - right)))
    }
    /// The right pane's edge dragged to `x` (window coordinates), `bodyRight` the body's right edge.
    public static func rightDragged(x: CGFloat, bodyRight: CGFloat, rightRoom: CGFloat) -> CGFloat {
        clamp((bodyRight - x - 1).rounded(), rightMin, rightRoom)
    }
}
