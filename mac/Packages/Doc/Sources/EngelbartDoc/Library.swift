import Foundation

// A library row as the renderer's models read it, and those models: kind.js (isNote/hasTag/kindKey/kindLabel and the
// Library chips), names.js, mention.js (the token a picked row writes), shared/mentions.cjs, askLine.js. The Store owns
// the real row; the app maps it onto this.

public struct LibRow: Equatable, Hashable, Sendable {
    public var id: String
    public var name: String
    /// What it is: a file's format, or folder / website / image / chat.
    public var type: String
    /// What was inferred about it: paper, git, note.
    public var tags: [String]
    public var path: String?
    public var folderPath: String?
    public var url: String?
    public var summary: String?
    public var projectId: String?
    public var source: String?
    public init(id: String, name: String, type: String, tags: [String] = [], path: String? = nil, folderPath: String? = nil, url: String? = nil, summary: String? = nil, projectId: String? = nil, source: String? = nil) {
        self.id = id; self.name = name; self.type = type; self.tags = tags; self.path = path; self.folderPath = folderPath; self.url = url; self.summary = summary; self.projectId = projectId; self.source = source
    }
}

public enum Kind {
    public static func hasTag(_ row: LibRow?, _ tag: String) -> Bool { row?.tags.contains(tag) ?? false }
    /// Written in Engelbart: opens as a tab, is renamed through its project, is read whole by Copy.
    public static func isNote(_ row: LibRow?) -> Bool { hasTag(row, "note") }
    static let DATA_TYPES: Set<String> = ["csv", "tsv", "json", "jsonl", "parquet", "xlsx"]
    /// Which glyph stands for the row and where it sorts.
    public static func kindKey(_ row: LibRow?) -> String {
        guard let row else { return "note" }
        if hasTag(row, "git") { return "git" }
        if row.type == "md" { return isNote(row) ? "note" : "md" }
        return DATA_TYPES.contains(row.type) ? "data" : row.type
    }
    public static let KIND_ORDER = ["note", "md", "docx", "pdf", "git", "folder", "website", "html", "data"]
    public static func kindRank(_ row: LibRow?) -> Int { KIND_ORDER.firstIndex(of: kindKey(row)) ?? KIND_ORDER.count }
    /// The words beside a row: its type ("link" for a website), then its tags.
    public static func kindLabel(_ row: LibRow) -> String { ([row.type == "website" ? "link" : row.type] + row.tags).joined(separator: " · ") }

    public struct Chip: Equatable { public var id: String; public var label: String; public var noun: String }
    /// The sidebar Library panel's chips (2026-10-09), in order; All is the default.
    public static let LIBRARY_CHIPS = [Chip(id: "all", label: "All", noun: ""), Chip(id: "notes", label: "Notes", noun: "notes"),
        Chip(id: "papers", label: "Papers", noun: "papers"), Chip(id: "repos", label: "Repos", noun: "repos"),
        Chip(id: "web", label: "Web", noun: "web pages"), Chip(id: "files", label: "Files", noun: "files"), Chip(id: "assets", label: "Assets", noun: "assets")]
    static let CHIP_KINDS: [String: [String]] = ["notes": ["note"], "papers": ["pdf"], "repos": ["git"], "web": ["website", "html"]]
    static let CHIPPED: Set<String> = Set(CHIP_KINDS.values.flatMap { $0 })
    /// Whether `row` is under `chip`.
    public static func libraryFilter(_ row: LibRow?, _ chip: String = "all") -> Bool {
        if row?.source == "create" { return chip == "all" || chip == "assets" }
        if chip == "assets" { return false }
        let key = kindKey(row)
        if key == "image" { return false }
        if chip == "all" { return true }
        if chip == "files" { return !CHIPPED.contains(key) }
        return CHIP_KINDS[chip]?.contains(key) ?? false
    }
    public static func libraryCounts(_ rows: [LibRow]) -> [String: Int] {
        var counts = Dictionary(uniqueKeysWithValues: LIBRARY_CHIPS.map { ($0.id, 0) })
        for row in rows { for chip in LIBRARY_CHIPS where libraryFilter(row, chip.id) { counts[chip.id]! += 1 } }
        return counts
    }
}

public enum Names {
    static let UNTITLED = Rx(#"^Untitled (?:Workspace|Project|Note) \d+$"#)
    public static func isUntitled(_ name: String?) -> Bool { UNTITLED.test(name ?? "") }
    /// The first free "Untitled <kind> n" among `names`.
    public static func nextUntitled(_ kind: String, _ names: [String]) -> String {
        let taken = Set(names)
        var n = 1
        while taken.contains("Untitled \(kind) \(n)") { n += 1 }
        return "Untitled \(kind) \(n)"
    }
    /// A workspace's name where "Workspace" stood (MATH-20): nine characters at most; longer, its first eight and "…".
    public static func wsLabel(_ name: String?, max: Int = 9) -> String {
        let s = Rx(#"\s+"#).replace(name ?? "", with: " ").trimmed
        if s.isEmpty { return "Workspace" }
        let chars = s.codePoints
        return chars.count <= max ? s : chars.prefix(max - 1).joined().trimEnd + "\u{2026}"
    }
}

/// A row of the @ menu (model/rail.js menu items): what it is and what picking it writes.
public struct MenuItem: Equatable {
    public enum Kind: String, Sendable { case workspace, entry, `self`, item, fresh, verb, task, note, folder, back }
    public var kind: Kind
    public var key: String
    public var name: String
    public var id: String = ""
    public var row: LibRow? = nil
    public var rel: String? = nil
    public var entryName: String? = nil
    public var zotero: String? = nil
    public var input: String? = nil
    public init(kind: Kind, key: String, name: String, id: String = "", row: LibRow? = nil, rel: String? = nil, entryName: String? = nil, zotero: String? = nil, input: String? = nil) {
        self.kind = kind; self.key = key; self.name = name; self.id = id; self.row = row; self.rel = rel; self.entryName = entryName; self.zotero = zotero; self.input = input
    }
}

public enum Mention {
    /// A library row of a page on the web: an address and nothing on this Mac.
    public static func isWebRow(_ row: LibRow?) -> Bool { guard let r = row else { return false }; return r.type == "website" && !(r.url ?? "").isEmpty && (r.path ?? "").isEmpty && (r.folderPath ?? "").isEmpty }

    /// The token a picked row of the @ menu writes (mention.js mentionToken).
    public static func mentionToken(_ r: MenuItem) -> String {
        if r.kind == .workspace { return Inline.wsMention(r.name, r.id) }
        if r.kind == .entry, let z = r.zotero { return Inline.zoteroMention(r.name, z) }
        if (r.kind == .entry || r.kind == .self), let rel = r.rel, !rel.isEmpty, let row = r.row { return Inline.fileMention(r.kind == .self ? r.entryName : r.name, row.id, rel) }
        if r.kind == .item, let row = r.row, isWebRow(row) { return Inline.libMention(WebName.webName(row.name, row.url), row.id) }
        if r.kind == .item, let row = r.row, row.type == "image" { return Inline.libMention(row.name, row.id) }
        if r.kind == .fresh, let input = r.input, WebName.isAddress(input) { return "@[\(WebName.webName(r.name, input))]" }
        return "@[\(r.name)]"
    }
    public static func menuItem(_ row: LibRow) -> MenuItem { MenuItem(kind: .item, key: row.id, name: row.name, row: row) }
    public static func rowMention(_ row: LibRow) -> String { mentionToken(menuItem(row)) }

    /// The pasteboard type a drag of sidebar rows carries (mention.js LIB_DRAG_TYPE).
    public static let LIB_DRAG_TYPE = "application/x-engelbart-lib"

    static let TOKEN = Rx(#"@\[([^\]\n]+)\](?:\((ws|lib|zotero):([\w-]+)(?::[\w.~%/-]+)?\))?"#)
    /// The library rows a document mentions, by id (shared/mentions.cjs, MATH-57).
    public static func mentionedIds(_ text: String?, _ library: [LibRow] = []) -> Set<String> {
        var ids = Set<String>(), names = Set<String>()
        let body = text ?? ""
        if !body.contains("@[") { return ids }
        for m in TOKEN.matchAll(body) {
            if m[2] == "lib" { ids.insert(m[3]!) } else if m[2] == nil { names.insert(m[1]!.lowercased()) }
        }
        if !names.isEmpty { for row in library where !row.name.isEmpty && names.contains(row.name.lowercased()) { ids.insert(row.id) } }
        return ids
    }
}

/// Where an ask's line is now (model/askLine.js, the Agent Viewer's click).
public enum AskLine {
    static let REWRITTEN: [String: [String]] = ["chat": ["chat"], "brainstorm": ["brainstorm"], "discover": ["discover"], "create": ["create"], "build": ["chat"]]
    public static func askLineTexts(_ text: String?, _ routedTo: String?) -> [String] {
        let typed = (text ?? "").trimEnd
        if typed.trimmed.isEmpty { return [] }
        var out = [typed]
        for token in REWRITTEN[routedTo ?? ""] ?? [] {
            let swapped = Rx(#"^(\s*)@bart\b"#).replace(typed, global: false) { "\($0[1] ?? "")@\(token)" }
            if !out.contains(swapped) { out.append(swapped) }
        }
        return out
    }
    /// The index of the ask's line in `lines` now, the nearest to `line`; -1 when it is gone.
    public static func findAskLine(_ lines: [String], text: String?, line: Int? = nil, routedTo: String? = nil) -> Int {
        let wants = Set(askLineTexts(text, routedTo))
        if wants.isEmpty { return -1 }
        let near = line ?? 0
        var best = -1
        for (i, held) in lines.enumerated() where wants.contains(held.trimEnd) && (best < 0 || abs(i - near) < abs(best - near)) { best = i }
        return best
    }
    /// A Build's card line, or -1.
    public static func findBuildLine(_ lines: [String], _ buildId: String?) -> Int {
        guard let buildId, !buildId.isEmpty else { return -1 }
        return lines.firstIndex { $0.trimmed == Doc.buildLine(buildId) } ?? -1
    }
}
