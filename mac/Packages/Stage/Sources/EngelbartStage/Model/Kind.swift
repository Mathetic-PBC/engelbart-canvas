import Foundation

/// A library row as the Stage reads it (the Store's `library` table, adapted by the app). `type` says what it is (a
/// file's format, or folder / website / image); `tags` what was inferred (paper, git, note).
public struct StageRow: Equatable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public var url: String?
    public var path: String?
    public var folderPath: String?
    public var source: String?
    public var summary: String?

    public init(id: String, name: String, type: String, tags: [String] = [], url: String? = nil, path: String? = nil,
                folderPath: String? = nil, source: String? = nil, summary: String? = nil) {
        self.id = id; self.name = name; self.type = type; self.tags = tags; self.url = url; self.path = path
        self.folderPath = folderPath; self.source = source; self.summary = summary
    }
}

// How a library row is shown (src/renderer/model/kind.js): the type is never read for meaning it does not have; whether
// a row is a note, a paper or a repository is asked of its tags.
public enum StageKind {
    public static func hasTag(_ row: StageRow?, _ tag: String) -> Bool { row?.tags.contains(tag) ?? false }
    /// Written in Engelbart: opens as a tab in the middle, never on the Stage.
    public static func isNote(_ row: StageRow?) -> Bool { hasTag(row, "note") }

    static let dataTypes: Set<String> = ["csv", "tsv", "json", "jsonl", "parquet", "xlsx"]

    /// Which glyph stands for the row and where it sorts.
    public static func kindKey(_ row: StageRow?) -> String {
        guard let row else { return "note" }
        if hasTag(row, "git") { return "git" }
        if row.type == "md" { return isNote(row) ? "note" : "md" }
        return dataTypes.contains(row.type) ? "data" : row.type
    }

    public static let kindOrder = ["note", "md", "docx", "pdf", "git", "folder", "website", "html", "data"]
    public static func kindRank(_ row: StageRow?) -> Int { kindOrder.firstIndex(of: kindKey(row)) ?? kindOrder.count }

    /// The words beside a row: its type ("link" for a website), then its tags.
    public static func kindLabel(_ row: StageRow) -> String {
        ([row.type == "website" ? "link" : row.type] + row.tags).joined(separator: " · ")
    }

    public struct Chip: Equatable, Sendable { public let id: String; public let label: String; public let noun: String }
    /// The sidebar Library panel's chips (2026-10-09), in order; one on at a time, All the default.
    public static let libraryChips = [
        Chip(id: "all", label: "All", noun: ""), Chip(id: "notes", label: "Notes", noun: "notes"),
        Chip(id: "papers", label: "Papers", noun: "papers"), Chip(id: "repos", label: "Repos", noun: "repos"),
        Chip(id: "web", label: "Web", noun: "web pages"), Chip(id: "files", label: "Files", noun: "files"),
        Chip(id: "assets", label: "Assets", noun: "assets"),
    ]
    static let chipKinds: [String: [String]] = ["notes": ["note"], "papers": ["pdf"], "repos": ["git"], "web": ["website", "html"]]
    static let chipped = Set(chipKinds.values.flatMap { $0 })

    /// Whether `row` is under `chip` (what @create made: All and Assets only; a picture: none; Files: what no other takes).
    public static func libraryFilter(_ row: StageRow, _ chip: String = "all") -> Bool {
        if row.source == "create" { return chip == "all" || chip == "assets" }
        if chip == "assets" { return false }
        let key = kindKey(row)
        if key == "image" { return false }
        if chip == "all" { return true }
        if chip == "files" { return !chipped.contains(key) }
        return (chipKinds[chip] ?? []).contains(key)
    }

    public static func libraryCounts(_ rows: [StageRow]) -> [String: Int] {
        var counts = Dictionary(uniqueKeysWithValues: libraryChips.map { ($0.id, 0) })
        for row in rows { for chip in libraryChips where libraryFilter(row, chip.id) { counts[chip.id, default: 0] += 1 } }
        return counts
    }
}
