import Foundation
import EngelbartCore

/// What a caller knows about a row it adds (db.cjs ABOUT_COLUMNS): each checked, each nil when unknown.
public struct AboutFields: Equatable, Sendable {
    public var source: String?
    public var category: String?
    public var itemDate: String?
    public var originUrl: String?
    public var place: String?
    public var messages: Int?
    public var minutes: Int?
    public init(source: String? = nil, category: String? = nil, itemDate: String? = nil, originUrl: String? = nil,
                place: String? = nil, messages: Int? = nil, minutes: Int? = nil) {
        self.source = source; self.category = category; self.itemDate = itemDate; self.originUrl = originUrl
        self.place = place; self.messages = messages; self.minutes = minutes
    }
}

/// A row to insert (db.cjs insert's argument).
public struct NewLibraryRow: Sendable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public var path: String?
    public var url: String?
    public var folderPath: String?
    public var projectId: String?
    public var githubId: String?
    public var categorized: Int?
    public var about: AboutFields
    public var titled: Int?
    public init(id: String = IDs.new(), name: String, type: String, tags: [String] = [], path: String? = nil, url: String? = nil,
                folderPath: String? = nil, projectId: String? = nil, githubId: String? = nil, categorized: Int? = nil,
                about: AboutFields = AboutFields(), titled: Int? = nil) {
        self.id = id; self.name = name; self.type = type; self.tags = tags; self.path = path; self.url = url
        self.folderPath = folderPath; self.projectId = projectId; self.githubId = githubId; self.categorized = categorized
        self.about = about; self.titled = titled
    }
}

/// `<dataRoot>/library.sqlite` (db.cjs openLibraryDb): `library`, `library_text`, `sandbox_runs`, `sandbox_environments`,
/// `repo_runnables`. Every method checks its arguments as db.cjs does, with the same messages.
public final class LibraryDB: Closable, @unchecked Sendable {
    public let file: String
    public let db: SQLiteDatabase
    /// db.cjs `dir` (the database's place on disk): here the SQLite file.
    public var dir: String { file }

    static let fileName = "library.sqlite"

    /// Opens (once per file) `<root>/library.sqlite`, converting a library typed the old way after copying it aside.
    public static func open(root: String) throws -> LibraryDB {
        let file = (root as NSString).appendingPathComponent(fileName)
        return try SQLiteRegistry.instance(file) { try LibraryDB(file: file) }
    }

    private init(file: String) throws {
        self.file = file
        db = try SQLiteDatabase(path: file)
        try setUp()
    }

    func closeDatabase() { db.close() }
    public func close() { SQLiteRegistry.close(file) }

    // MARK: schema

    static let now = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    static var typeList: String { LibraryVocabulary.types.map { "'\($0)'" }.joined(separator: ",") }

    static var libraryTable: String {
        """
        create table if not exists library (
          id text primary key,
          name text not null,
          type text not null constraint library_type_check check (type in (\(typeList))),
          path text,
          url text,
          folder_path text,
          project_id text,
          created text not null default \(now),
          last_edited text not null default \(now),
          summary text,
          summary_edited text,
          char_count integer,
          github_id text,
          tags text not null default '[]',
          categorized integer,
          source text,
          category text,
          item_date text,
          origin_url text,
          place text,
          messages integer,
          minutes integer,
          titled integer,
          constraint library_note_is_md check (type = 'md' or instr(tags, '"note"') = 0)
        );
        """
    }

    static let libraryIndexes = """
    create index if not exists library_project on library (project_id);
    create unique index if not exists library_github_id on library (github_id) where github_id is not null;
    """

    static var otherTables: String {
        """
        create table if not exists sandbox_runs (
          id text primary key,
          library_id text not null references library (id) on delete restrict,
          sandbox_id text,
          status text not null default 'starting' check (status in ('starting', 'ready', 'failed', 'stopped')),
          preview_url text,
          port integer check (port between 1 and 65535),
          error text,
          created_at text not null default \(now),
          updated_at text not null default \(now),
          finished_at text,
          build_log text not null default '[]',
          build_milestones text default '{}',
          env_revision text,
          env_report text,
          last_opened_at text,
          kind text,
          kind_reason text,
          terminal text
        );
        create index if not exists sandbox_runs_library_created on sandbox_runs (library_id, created_at desc);
        create table if not exists sandbox_environments (
          library_id text primary key references library (id) on delete cascade,
          revision text not null,
          encrypted text not null,
          updated_at text not null default \(now)
        );
        create table if not exists repo_runnables (
          id text primary key,
          library_id text not null references library (id) on delete cascade,
          folder text not null default '.',
          name text not null,
          type text not null check (type in ('ui', 'app', 'terminal')),
          install_command text,
          run_command text,
          status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
          last_error text,
          verified_commit text,
          created_at text not null default \(now),
          updated_at text not null default \(now),
          check (type <> 'ui' or run_command is null or instr(run_command, '{port}') > 0)
        );
        create unique index if not exists repo_runnables_one on repo_runnables (library_id, folder, name);
        create table if not exists library_text (
          library_id text primary key references library (id) on delete cascade,
          text text not null,
          file_mtime real not null,
          extracted_at text not null default \(now)
        );
        create unique index if not exists sandbox_runs_one_active on sandbox_runs (library_id) where status in ('starting', 'ready');
        """
    }

    /// Columns added after the first table (db.cjs `alter table … add column if not exists`), with their SQLite types.
    static let laterColumns: [(String, String)] = [
        ("summary", "text"), ("summary_edited", "text"), ("char_count", "integer"), ("github_id", "text"),
        ("categorized", "integer"), ("source", "text"), ("category", "text"), ("item_date", "text"), ("origin_url", "text"),
        ("place", "text"), ("messages", "integer"), ("minutes", "integer"), ("titled", "integer"),
    ]
    static let laterRunColumns: [(String, String)] = [
        ("build_log", "text not null default '[]'"), ("build_milestones", "text default '{}'"), ("env_revision", "text"),
        ("env_report", "text"), ("last_opened_at", "text"), ("kind", "text"), ("kind_reason", "text"), ("terminal", "text"),
    ]

    private func setUp() throws {
        let existing = try db.columns("library")
        if !existing.isEmpty && !existing.contains("tags") {
            // A library typed the old way (before 2026-09-21) is about to be rewritten row by row: the file is copied
            // first, closed, to <root>/.backups/library-<when>.sqlite. It happens once: the converted table has `tags`.
            try setAside()
            try convertOldTypes(existing)
        } else if !existing.isEmpty {
            for (column, type) in Self.laterColumns where !existing.contains(column) {
                try db.execute("alter table library add column \(column) \(type)")
            }
        }
        try db.execute(Self.libraryTable + Self.libraryIndexes)
        let runs = try db.columns("sandbox_runs")
        if !runs.isEmpty {
            for (column, type) in Self.laterRunColumns where !runs.contains(column) {
                try db.execute("alter table sandbox_runs add column \(column) \(type)")
            }
        }
        try db.execute(Self.otherTables)
        try backfillMilestones()
    }

    /// Null marks pre-upgrade runs for a one-time backfill from whatever history remains (on open, and after an import).
    func backfillMilestones() throws {
        for run in try db.query("select id, build_log from sandbox_runs where build_milestones is null") {
            let log = (try? JSONValue.parse(run["build_log"]?.string ?? "[]"))?.array ?? []
            try db.run("update sandbox_runs set build_milestones = ? where id = ? and build_milestones is null",
                       [.text(BuildHistory.collect(log).text()), run["id"] ?? .null])
        }
    }

    private func setAside() throws {
        let root = (file as NSString).deletingLastPathComponent
        let backups = (root as NSString).appendingPathComponent(".backups")
        try FileManager.default.createDirectory(atPath: backups, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try db.execute("pragma wal_checkpoint(truncate)")
        let stamp = Time.iso().replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
        let target = (backups as NSString).appendingPathComponent("library-\(stamp).sqlite")
        try FileManager.default.copyItem(atPath: file, toPath: target)
    }

    /// Databases from before 2026-09-21 typed a row by what it was for (note, paper, git_repo, dataset; website also meant
    /// an html file). Each becomes its format plus the tag that says the rest; categorized stays null, so recategorize
    /// applies the rules to every row before the library is handed to anyone. Nothing a row knew is lost.
    private func convertOldTypes(_ columns: [String]) throws {
        try db.execute("pragma foreign_keys = off")
        defer { try? db.execute("pragma foreign_keys = on") }
        try db.transaction {
            let rows = try db.query("select * from library")
            try db.execute(Self.libraryTable.replacingOccurrences(of: "create table if not exists library (", with: "create table library_new ("))
            for old in rows {
                let type = old["type"]?.string ?? ""
                let path = old["path"]?.string, folder = old["folder_path"]?.string
                var next = type, tags: [String] = []
                switch type {
                case "note": next = "md"; tags = ["note"]
                case "paper": if path == nil { next = "website"; tags = ["paper"] } else { next = "pdf" }
                case "git_repo": next = folder == nil ? "website" : "folder"; tags = ["git"]
                case "dataset":
                    if path == nil { next = "folder" } else {
                        let ext = (path! as NSString).pathExtension.lowercased()
                        switch ext {
                        case "tsv": next = "tsv"; case "json": next = "json"; case "jsonl", "ndjson": next = "jsonl"
                        case "parquet": next = "parquet"; case "xlsx": next = "xlsx"; default: next = "csv"
                        }
                    }
                case "website": if path != nil { next = "html" }
                default: break
                }
                var names: [String] = [], values: [SQLValue] = []
                for column in LibraryRow.columns where columns.contains(column) || column == "tags" {
                    names.append(column)
                    switch column {
                    case "type": values.append(.text(next))
                    case "tags": values.append(.text(JSONValue.array(tags.map { .string($0) }).text()))
                    case "categorized": values.append(.null)
                    default: values.append(old[column] ?? .null)
                    }
                }
                try db.run("insert into library_new (\(names.joined(separator: ", "))) values (\(names.map { _ in "?" }.joined(separator: ", ")))", values)
            }
            try db.execute("drop table library; alter table library_new rename to library;")
        }
    }

    // MARK: checks (db.cjs)

    static let uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

    static func requireText(_ value: String?, _ name: String, optional: Bool = false, max: Int = 4096) throws -> String? {
        guard let value, !value.isEmpty else {
            if optional { return nil }
            throw StoreError.type("\(name) is required")
        }
        if value.count > max { throw StoreError.type("\(name) must be a string of at most \(max) characters") }
        return value
    }
    static func id(_ value: String) throws -> String { try requireText(value, "id", max: 64)! }

    static func optionalGithubId(_ value: String?) throws -> String? {
        guard let value, !value.isEmpty else { return nil }
        guard value.range(of: #"^[1-9]\d{0,18}$"#, options: .regularExpression) != nil else { throw StoreError.type("github id must be a string of digits") }
        return value
    }

    static func requireTags(_ value: [String], type: String) throws -> [String] {
        var tags: [String] = []
        for tag in value where !tags.contains(tag) { tags.append(tag) }
        for tag in tags where !LibraryVocabulary.tags.contains(tag) { throw StoreError.type("Unknown library tag: \(tag)") }
        if tags.contains("note") && type != "md" { throw StoreError.type("Only a note written in Engelbart (an md) can be tagged note") }
        return tags
    }

    static func requireType(_ type: String) throws -> String {
        guard LibraryVocabulary.types.contains(type) else { throw StoreError.type("Unknown library type: \(type)") }
        return type
    }

    static func requireCount(_ value: Int) throws -> Int {
        guard value >= 0, value <= 2_000_000_000 else { throw StoreError.type("count must be a non-negative integer") }
        return value
    }

    static func checkedAbout(_ about: AboutFields) throws -> AboutFields {
        var out = AboutFields()
        if let source = about.source {
            guard LibraryVocabulary.sources.contains(source) else {
                throw StoreError.type("Unknown library source: \(String(source.prefix(60))) (one of \(LibraryVocabulary.sources.joined(separator: ", ")))")
            }
            out.source = source
        }
        if let category = about.category {
            guard LibraryVocabulary.categories.contains(category) else {
                throw StoreError.type("Unknown library category: \(String(category.prefix(60))) (one of \(LibraryVocabulary.categories.joined(separator: ", ")))")
            }
            out.category = category
        }
        if let day = about.itemDate, !day.isEmpty {
            guard day.range(of: #"^\d{4}(?:-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))?$"#, options: .regularExpression) != nil else {
                throw StoreError.type("item date must be YYYY or YYYY-MM-DD")
            }
            out.itemDate = day
        }
        if let origin = about.originUrl, !origin.isEmpty {
            guard origin.count <= 8192, origin.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil else {
                throw StoreError.type("origin url must be an http(s) address")
            }
            out.originUrl = origin
        }
        if let place = about.place {
            let clean = String(place.collapsingWhitespace().prefix(512))
            out.place = clean.isEmpty ? nil : clean
        }
        if let messages = about.messages { out.messages = try requireCount(messages) }
        if let minutes = about.minutes { out.minutes = try requireCount(minutes) }
        return out
    }

    static func tagsText(_ tags: [String]) -> SQLValue { .text(JSONValue.array(tags.map { .string($0) }).text()) }

    private func one(_ sql: String, _ params: [SQLValue]) throws -> LibraryRow? {
        try db.query(sql, params).first.map(LibraryRow.init(sql:))
    }

    // MARK: rows

    @discardableResult
    public func insert(_ row: NewLibraryRow) throws -> LibraryRow {
        let type = try Self.requireType(try Self.requireText(row.type, "type")!)
        let about = try Self.checkedAbout(row.about)
        let now = Time.iso()
        let values: [SQLValue] = [
            .text(try Self.requireText(row.id, "id", max: 64)!),
            .text(try Self.requireText(row.name, "name", max: 512)!),
            .text(type),
            .of(try Self.requireText(row.path, "path", optional: true)),
            .of(try Self.requireText(row.url, "url", optional: true)),
            .of(try Self.requireText(row.folderPath, "folder_path", optional: true)),
            .of(try Self.requireText(row.projectId, "project_id", optional: true, max: 64)),
            .of(try Self.optionalGithubId(row.githubId)),
            Self.tagsText(try Self.requireTags(row.tags, type: type)),
            .of(try row.categorized.map(Self.requireCount)),
            .of(about.source), .of(about.category), .of(about.itemDate), .of(about.originUrl), .of(about.place), .of(about.messages), .of(about.minutes),
            .of(try row.titled.map(Self.requireCount)),
            .text(now), .text(now),
        ]
        return try db.onQueue {
            try db.run("""
                insert into library (id, name, type, path, url, folder_path, project_id, github_id, tags, categorized, source, category, item_date, origin_url, place, messages, minutes, titled, created, last_edited)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, values)
            return try one("select * from library where id = ?", [values[0]])!
        }
    }

    public func list() throws -> [LibraryRow] {
        try db.query("select * from library order by created, name").map(LibraryRow.init(sql:))
    }

    public func get(_ id: String) throws -> LibraryRow? {
        try one("select * from library where id = ?", [.text(try Self.id(id))])
    }

    private func update(_ sql: String, _ params: [SQLValue], id: String) throws -> LibraryRow? {
        try db.onQueue {
            let changed = try db.run(sql, params)
            return changed > 0 ? try one("select * from library where id = ?", [.text(id)]) : nil
        }
    }

    @discardableResult
    public func rename(_ id: String, _ name: String) throws -> LibraryRow? {
        let id = try Self.id(id)
        return try update("update library set name = ?, last_edited = ? where id = ?", [.text(try Self.requireText(name, "name", max: 512)!), .text(Time.iso()), .text(id)], id: id)
    }

    @discardableResult
    public func updatePath(_ id: String, _ path: String) throws -> LibraryRow? {
        let id = try Self.id(id)
        return try update("update library set path = ?, last_edited = ? where id = ?", [.text(try Self.requireText(path, "path")!), .text(Time.iso()), .text(id)], id: id)
    }

    @discardableResult
    public func touch(_ id: String) throws -> Bool {
        try db.run("update library set last_edited = ? where id = ?", [.text(Time.iso()), .text(try Self.id(id))])
        return true
    }

    /// A note was saved with different text: it counts as edited now, and its length is recorded with it.
    @discardableResult
    public func recordEdit(_ id: String, _ charCount: Int) throws -> Bool {
        try db.run("update library set last_edited = ?, char_count = ? where id = ?", [.text(Time.iso()), .int(Int64(try Self.requireCount(charCount))), .text(try Self.id(id))])
        return true
    }

    /// Length only (a new note, or a backfill): does not count as an edit.
    @discardableResult
    public func setCharCount(_ id: String, _ charCount: Int) throws -> Bool {
        try db.run("update library set char_count = ? where id = ?", [.int(Int64(try Self.requireCount(charCount))), .text(try Self.id(id))])
        return true
    }

    /// `at` is when the text that was summarized was read. Never touches last_edited.
    @discardableResult
    public func setSummary(_ id: String, _ summary: String?, at: Date) throws -> LibraryRow? {
        let id = try Self.id(id)
        let text = try summary.flatMap { try Self.requireText($0, "summary", max: 4000) }
        return try update("update library set summary = ?, summary_edited = ? where id = ?", [.of(text), text == nil ? .null : .text(Time.iso(at)), .text(id)], id: id)
    }

    /// What the category rules make of a row; `rules` nil leaves the mark where it was. Not an edit.
    @discardableResult
    public func setCategory(_ id: String, type: String, tags: [String], rules: Int?) throws -> LibraryRow {
        let type = try Self.requireType(type)
        let id = try Self.id(id)
        guard let row = try update("update library set type = ?, tags = ?, categorized = coalesce(?, categorized) where id = ?",
                                   [.text(type), Self.tagsText(try Self.requireTags(tags, type: type)), .of(try rules.map(Self.requireCount)), .text(id)], id: id)
        else { throw StoreError("Unknown library item") }
        return row
    }

    public func uncategorized(_ rules: Int) throws -> [LibraryRow] {
        try db.query("select * from library where categorized is null or categorized < ? order by created, name", [.int(Int64(try Self.requireCount(rules)))]).map(LibraryRow.init(sql:))
    }

    /// A note and a pasted image are what Engelbart made them. → how many were marked.
    @discardableResult
    public func settleUninferable(_ rules: Int) throws -> Int {
        let r = SQLValue.int(Int64(try Self.requireCount(rules)))
        return try db.run("update library set categorized = ? where (categorized is null or categorized < ?) and (type = 'image' or instr(tags, '\"note\"') > 0)", [r, r])
    }

    public func untitled(_ rules: Int) throws -> [LibraryRow] {
        try db.query("select * from library where titled is null or titled < ? order by created, name", [.int(Int64(try Self.requireCount(rules)))]).map(LibraryRow.init(sql:))
    }

    @discardableResult
    public func setTitle(_ id: String, name: String?, rules: Int?) throws -> LibraryRow {
        let id = try Self.id(id)
        let name = try name.flatMap { try Self.requireText($0, "name", max: 512) }
        guard let row = try update("update library set name = coalesce(?, name), titled = coalesce(?, titled) where id = ?",
                                   [.of(name), .of(try rules.map(Self.requireCount)), .text(id)], id: id)
        else { throw StoreError("Unknown library item") }
        return row
    }

    /// Each field written only where the row has none. Not an edit.
    @discardableResult
    public func fillAbout(_ id: String, _ fields: AboutFields) throws -> LibraryRow {
        let id = try Self.id(id)
        let about = try Self.checkedAbout(fields)
        guard let row = try update("""
            update library set source = coalesce(source, ?), category = coalesce(category, ?), item_date = coalesce(item_date, ?),
              origin_url = coalesce(origin_url, ?), place = coalesce(place, ?), messages = coalesce(messages, ?), minutes = coalesce(minutes, ?)
            where id = ?
            """, [.of(about.source), .of(about.category), .of(about.itemDate), .of(about.originUrl), .of(about.place), .of(about.messages), .of(about.minutes), .text(id)], id: id)
        else { throw StoreError("Unknown library item") }
        return row
    }

    /// Where a row came from, set over what it was added with. → the row, or nil.
    @discardableResult
    public func setSource(_ id: String, _ source: String?) throws -> LibraryRow? {
        let id = try Self.id(id)
        let about = try Self.checkedAbout(AboutFields(source: source))
        return try update("update library set source = ? where id = ?", [.of(about.source), .text(id)], id: id)
    }

    /// What is known about a repository, all on its one row. A repository that has a folder is a folder; one that has
    /// only its address is a website. Not an edit.
    @discardableResult
    public func updateRepo(_ id: String, name: String, url: String?, folderPath: String?, githubId: String?) throws -> LibraryRow? {
        let id = try Self.id(id)
        let folder = try Self.requireText(folderPath, "folder_path", optional: true)
        return try update("update library set name = ?, url = ?, folder_path = ?, github_id = ?, type = ? where id = ?", [
            .text(try Self.requireText(name, "name", max: 512)!), .of(try Self.requireText(url, "url", optional: true)), .of(folder),
            .of(try Self.optionalGithubId(githubId)), .text(folder == nil ? "website" : "folder"), .text(id),
        ], id: id)
    }

    /// A page that was a pdf all along becomes its saved copy; nil when it is not a plain page any more.
    @discardableResult
    public func adoptPdf(_ id: String, file: String) throws -> LibraryRow? {
        let id = try Self.id(id)
        return try update("update library set type = 'pdf', path = ?, categorized = null where id = ? and type = 'website' and path is null and folder_path is null",
                          [.text(try Self.requireText(file, "path", max: 4096)!), .text(id)], id: id)
    }

    public func uncountedNotes() throws -> [(id: String, path: String)] {
        try db.query("select id, path from library where instr(tags, '\"note\"') > 0 and path is not null and char_count is null").map { ($0["id"]?.string ?? "", $0["path"]?.string ?? "") }
    }

    public func summaryCandidates(quietBefore: Date, minChars: Int) throws -> [LibraryRow] {
        try db.query("""
            select * from library
             where instr(tags, '"note"') > 0 and path is not null and last_edited <= ?
               and ((summary is null and (char_count is null or char_count > ?))
                 or (summary is not null and (summary_edited is null or summary_edited < last_edited)))
             order by last_edited
            """, [.text(Time.iso(quietBefore)), .int(Int64(try Self.requireCount(minChars)))]).map(LibraryRow.init(sql:))
    }

    public func papersWithFiles() throws -> [LibraryRow] {
        try db.query("select * from library where type = 'pdf' and path is not null order by created").map(LibraryRow.init(sql:))
    }

    /// library id → the modification time (ms) of the file its text was taken from.
    public func textStamps() throws -> [String: Double] {
        var out: [String: Double] = [:]
        for row in try db.query("select library_id, file_mtime from library_text") { out[row["library_id"]?.string ?? ""] = row["file_mtime"]?.double }
        return out
    }

    /// A pdf's text read from its file at `mtime` ('' when it held none), NUL removed.
    @discardableResult
    public func setText(_ id: String, _ text: String, mtime: Double) throws -> Bool {
        guard mtime.isFinite else { throw StoreError.type("mtime must be a number") }
        try db.run("""
            insert into library_text (library_id, text, file_mtime, extracted_at) values (?, ?, ?, ?)
            on conflict (library_id) do update set text = excluded.text, file_mtime = excluded.file_mtime, extracted_at = excluded.extracted_at
            """, [.text(try Self.id(id)), .text(text.replacingOccurrences(of: "\u{0}", with: "")), .double(mtime), .text(Time.iso())])
        return true
    }

    /// The kept text of the pdfs among `ids`, each cut at `max` characters; one that held none is left out.
    public func textsFor(_ ids: [String], max: Int) throws -> [String: String] {
        if ids.isEmpty { return [:] }
        let max = try Self.requireCount(max)
        var out: [String: String] = [:]
        for chunk in stride(from: 0, to: ids.count, by: 500) {
            let part = try ids[chunk..<min(ids.count, chunk + 500)].map { SQLValue.text(try Self.id($0)) }
            let marks = part.map { _ in "?" }.joined(separator: ",")
            for row in try db.query("select library_id, substr(text, 1, ?) as text from library_text where library_id in (\(marks)) and text <> ''", [.int(Int64(max))] + part) {
                out[row["library_id"]?.string ?? ""] = row["text"]?.string ?? ""
            }
        }
        return out
    }

    /// Escape hatch for tests, repairs and the packages that keep their own tables here (sandbox runs, runnables).
    @discardableResult
    public func query(_ sql: String, _ params: [SQLValue] = []) throws -> [SQLRow] { try db.query(sql, params) }

    /// `projectId`: only the rows made in that project.
    @discardableResult
    public func rewritePathPrefix(_ oldPrefix: String, _ newPrefix: String, projectId: String? = nil) throws -> Int {
        let old = try Self.requireText(oldPrefix, "oldPrefix")!, new = try Self.requireText(newPrefix, "newPrefix")!
        let project = try Self.requireText(projectId, "projectId", optional: true, max: 64)
        return try db.run("""
            update library set path = ? || substr(path, length(?) + 1)
             where path is not null and substr(path, 1, length(?)) = ? and (? is null or project_id = ?)
            """, [.text(new), .text(old), .text(old), .text(old), .of(project), .of(project)])
    }

    /// → whether a row went; a row a sandbox run still names is refused (the run must be cleaned up first).
    @discardableResult
    public func remove(_ id: String) throws -> Bool {
        try db.run("delete from library where id = ?", [.text(try Self.id(id))]) > 0
    }
}

extension String {
    /// `replace(/\s+/g, ' ').trim()`.
    func collapsingWhitespace() -> String {
        components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }
}
