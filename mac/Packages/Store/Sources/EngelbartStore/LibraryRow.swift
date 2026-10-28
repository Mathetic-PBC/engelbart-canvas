import Foundation
import EngelbartCore

/// One row of the root library, exactly as `select * from library` gave it to the renderer (db.cjs). Keys are the
/// table's column names (snake_case) when encoded, so a JSON row reads the same as Electron's.
public struct LibraryRow: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var name: String
    /// What the row is (a file's format, or folder/website/image): `Library.types`.
    public var type: String
    public var path: String?
    public var url: String?
    public var folderPath: String?
    public var projectId: String?
    public var created: String
    public var lastEdited: String
    public var summary: String?
    public var summaryEdited: String?
    public var charCount: Int?
    public var githubId: String?
    /// What was inferred about it: `Library.tags` (paper, git, note).
    public var tags: [String]
    public var categorized: Int?
    public var source: String?
    public var category: String?
    public var itemDate: String?
    public var originUrl: String?
    public var place: String?
    public var messages: Int?
    public var minutes: Int?
    public var titled: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, type, path, url
        case folderPath = "folder_path"
        case projectId = "project_id"
        case created
        case lastEdited = "last_edited"
        case summary
        case summaryEdited = "summary_edited"
        case charCount = "char_count"
        case githubId = "github_id"
        case tags, categorized, source, category
        case itemDate = "item_date"
        case originUrl = "origin_url"
        case place, messages, minutes, titled
    }

    public init(id: String, name: String, type: String, path: String? = nil, url: String? = nil, folderPath: String? = nil,
                projectId: String? = nil, created: String = Time.iso(), lastEdited: String = Time.iso(), summary: String? = nil,
                summaryEdited: String? = nil, charCount: Int? = nil, githubId: String? = nil, tags: [String] = [],
                categorized: Int? = nil, source: String? = nil, category: String? = nil, itemDate: String? = nil,
                originUrl: String? = nil, place: String? = nil, messages: Int? = nil, minutes: Int? = nil, titled: Int? = nil) {
        self.id = id; self.name = name; self.type = type; self.path = path; self.url = url; self.folderPath = folderPath
        self.projectId = projectId; self.created = created; self.lastEdited = lastEdited; self.summary = summary
        self.summaryEdited = summaryEdited; self.charCount = charCount; self.githubId = githubId; self.tags = tags
        self.categorized = categorized; self.source = source; self.category = category; self.itemDate = itemDate
        self.originUrl = originUrl; self.place = place; self.messages = messages; self.minutes = minutes; self.titled = titled
    }

    /// Every key present (null for a missing value), as the JavaScript row had them.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(type, forKey: .type)
        try c.encode(path, forKey: .path); try c.encode(url, forKey: .url); try c.encode(folderPath, forKey: .folderPath)
        try c.encode(projectId, forKey: .projectId); try c.encode(created, forKey: .created); try c.encode(lastEdited, forKey: .lastEdited)
        try c.encode(summary, forKey: .summary); try c.encode(summaryEdited, forKey: .summaryEdited); try c.encode(charCount, forKey: .charCount)
        try c.encode(githubId, forKey: .githubId); try c.encode(tags, forKey: .tags); try c.encode(categorized, forKey: .categorized)
        try c.encode(source, forKey: .source); try c.encode(category, forKey: .category); try c.encode(itemDate, forKey: .itemDate)
        try c.encode(originUrl, forKey: .originUrl); try c.encode(place, forKey: .place); try c.encode(messages, forKey: .messages)
        try c.encode(minutes, forKey: .minutes); try c.encode(titled, forKey: .titled)
    }

    public func hasTag(_ tag: String) -> Bool { tags.contains(tag) }

    /// The row as JSON (for callers that add fields, as libraryForProject adds `origin` and `workspaces`).
    public var json: JSONValue { JSONValue.encode(self) }

    /// The 23 column names, in the order `select *` returns them.
    public static let columns = ["id", "name", "type", "path", "url", "folder_path", "project_id", "created", "last_edited", "summary",
                                 "summary_edited", "char_count", "github_id", "tags", "categorized", "source", "category", "item_date",
                                 "origin_url", "place", "messages", "minutes", "titled"]

    init(sql row: SQLRow) {
        func text(_ key: String) -> String? { row[key]?.string }
        func int(_ key: String) -> Int? { row[key]?.int }
        var tags: [String] = []
        if let raw = text("tags"), let data = raw.data(using: .utf8), let list = try? JSONDecoder().decode([String].self, from: data) { tags = list }
        self.init(id: text("id") ?? "", name: text("name") ?? "", type: text("type") ?? "", path: text("path"), url: text("url"),
                  folderPath: text("folder_path"), projectId: text("project_id"), created: text("created") ?? "",
                  lastEdited: text("last_edited") ?? "", summary: text("summary"), summaryEdited: text("summary_edited"),
                  charCount: int("char_count"), githubId: text("github_id"), tags: tags, categorized: int("categorized"),
                  source: text("source"), category: text("category"), itemDate: text("item_date"), originUrl: text("origin_url"),
                  place: text("place"), messages: int("messages"), minutes: int("minutes"), titled: int("titled"))
    }
}

extension JSONValue {
    /// Any Encodable as JSON (`null` when it cannot be encoded).
    public static func encode<T: Encodable>(_ value: T) -> JSONValue {
        guard let data = try? JSONEncoder().encode(value), let json = try? JSONValue.parse(data) else { return .null }
        return json
    }

    /// Decodes this JSON as `T`.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }

    /// `self` (an object) with `extra`'s keys set.
    public func merging(_ extra: [String: JSONValue]) -> JSONValue {
        guard case .object(var o) = self else { return self }
        for (k, v) in extra { o[k] = v }
        return .object(o)
    }
}

/// What a row may be and say (db.cjs LIBRARY_TYPES, LIBRARY_TAGS; shared/connect-sources.cjs ITEM_SOURCES, ITEM_CATEGORIES).
public enum LibraryVocabulary {
    /// `docx` (2026-09-23): a Word document, read on the Stage through macOS textutil.
    public static let types = ["md", "pdf", "html", "csv", "tsv", "json", "jsonl", "parquet", "xlsx", "docx", "folder", "website", "image"]
    /// `paper`: an arXiv or DOI address or a pdf that reads like one. `git`: a repository. `note`: written in Engelbart.
    public static let tags = ["paper", "git", "note"]
    /// connect-sources.cjs ITEM_SOURCES: every app the person can bring things in from, then engelbart, mac, web, github, create.
    public static let sources = ["Obsidian", "Notion", "Apple Notes", "OneNote", "Google Docs", "Evernote", "Granola", "Google Meet", "Zoom",
                                 "Gmail", "ChatGPT", "Codex", "Claude", "Claude Code", "Grok", "Gemini", "Perplexity", "Cursor", "Zotero",
                                 "Overleaf", "PDFs on this Mac", "Linear", "engelbart", "mac", "web", "github", "create"]
    public static let categories = ["chat", "meeting", "email", "note", "paper", "repo", "web", "data", "document", "image", "file"]
    /// The chat apps, whose kept chats begin with a `*<App> · <date> · <project>*` line.
    public static let chatApps = ["ChatGPT", "Codex", "Claude", "Claude Code", "Grok", "Gemini", "Perplexity", "Cursor"]
    /// connect-sources.cjs categoryOfApp for the apps the head lines name.
    public static func categoryOfApp(_ app: String) -> String? {
        switch app {
        case "Gmail": return "email"
        case "Google Docs", "Obsidian", "Notion", "Apple Notes", "OneNote", "Evernote": return "note"
        case "Overleaf", "Zotero", "PDFs on this Mac": return "paper"
        case "Granola", "Google Meet", "Zoom": return "meeting"
        default: return chatApps.contains(app) ? "chat" : nil
        }
    }
}
