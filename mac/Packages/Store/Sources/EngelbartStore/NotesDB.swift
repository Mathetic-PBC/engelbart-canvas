import Foundation
import EngelbartCore

/// A row of a project's `notes` table. `topic_id` holds the workspace id (topic ids became workspace ids when the layout
/// changed); `goal_id` is no longer written.
public struct NoteRow: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    public var goalId: String?
    public var topicId: String?
    public var created: String
    public var lastEdited: String
    enum CodingKeys: String, CodingKey { case id, name, path, goalId = "goal_id", topicId = "topic_id", created, lastEdited = "last_edited" }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(path, forKey: .path)
        try c.encode(goalId, forKey: .goalId); try c.encode(topicId, forKey: .topicId)
        try c.encode(created, forKey: .created); try c.encode(lastEdited, forKey: .lastEdited)
    }
    init(sql row: SQLRow) {
        id = row["id"]?.string ?? ""; name = row["name"]?.string ?? ""; path = row["path"]?.string ?? ""
        goalId = row["goal_id"]?.string; topicId = row["topic_id"]?.string
        created = row["created"]?.string ?? ""; lastEdited = row["last_edited"]?.string ?? ""
    }
}

/// A post-it card (db.cjs post_its). `deleted`: in the trash since, purged a week later (post-its/views.cjs).
public struct PostItRow: Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var nx: Double
    public var ny: Double
    public var width: Double
    public var height: Double
    public var z: Double
    public var created: String
    public var lastEdited: String
    public var deleted: String?
    enum CodingKeys: String, CodingKey { case id, text, nx, ny, width, height, z, created, lastEdited = "last_edited", deleted }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(text, forKey: .text); try c.encode(nx, forKey: .nx); try c.encode(ny, forKey: .ny)
        try c.encode(width, forKey: .width); try c.encode(height, forKey: .height); try c.encode(z, forKey: .z)
        try c.encode(created, forKey: .created); try c.encode(lastEdited, forKey: .lastEdited); try c.encode(deleted, forKey: .deleted)
    }
    init(sql row: SQLRow) {
        id = row["id"]?.string ?? ""; text = row["text"]?.string ?? ""
        nx = row["nx"]?.double ?? 0; ny = row["ny"]?.double ?? 0; width = row["width"]?.double ?? 0; height = row["height"]?.double ?? 0
        z = row["z"]?.double ?? 0; created = row["created"]?.string ?? ""; lastEdited = row["last_edited"]?.string ?? ""
        deleted = row["deleted"]?.string
    }
}

/// What a post-it save carries (db.cjs postItValues).
public struct PostItValues: Sendable {
    public var text: String, nx: Double, ny: Double, width: Double, height: Double, z: Double
    public init(text: String, nx: Double, ny: Double, width: Double, height: Double, z: Double) {
        self.text = text; self.nx = nx; self.ny = ny; self.width = width; self.height = height; self.z = z
    }
}

/// `<project>/notes.sqlite` (db.cjs openNotesDb): the project's `notes` and `post_its`.
public final class NotesDB: Closable, @unchecked Sendable {
    public let file: String
    public let db: SQLiteDatabase
    public var dir: String { file }
    public let postIts: PostIts

    static let fileName = "notes.sqlite"

    public static func open(projectDir: String) throws -> NotesDB {
        let file = (projectDir as NSString).appendingPathComponent(fileName)
        return try SQLiteRegistry.instance(file) { try NotesDB(file: file) }
    }

    /// Closes a project's notes database (db.cjs closeDb on notes.pglite). → whether it was open.
    @discardableResult
    public static func close(projectDir: String) -> Bool {
        SQLiteRegistry.close((projectDir as NSString).appendingPathComponent(fileName))
    }

    private init(file: String) throws {
        self.file = file
        db = try SQLiteDatabase(path: file)
        postIts = PostIts(db: db)
        try db.execute("""
            create table if not exists notes (
              id text primary key,
              name text not null,
              path text not null,
              goal_id text,
              topic_id text,
              created text not null default \(LibraryDB.now),
              last_edited text not null default \(LibraryDB.now)
            );
            create table if not exists post_its (
              id text primary key,
              text text not null default '',
              nx real not null check (nx between 0 and 1),
              ny real not null check (ny between 0 and 1),
              width real not null check (width between 180 and 2400),
              height real not null check (height between 140 and 2400),
              z real not null default 0,
              created text not null default \(LibraryDB.now),
              last_edited text not null default \(LibraryDB.now),
              deleted text
            );
            """)
        if try !db.columns("post_its").contains("deleted") { try db.execute("alter table post_its add column deleted text") }
    }

    func closeDatabase() { db.close() }

    @discardableResult
    public func insert(id: String, name: String, path: String, goalId: String? = nil, topicId: String? = nil) throws -> NoteRow {
        let now = Time.iso()
        let values: [SQLValue] = [
            .text(try LibraryDB.requireText(id, "id", max: 64)!), .text(try LibraryDB.requireText(name, "name", max: 512)!),
            .text(try LibraryDB.requireText(path, "path")!), .of(try LibraryDB.requireText(goalId, "goal_id", optional: true, max: 64)),
            .of(try LibraryDB.requireText(topicId, "topic_id", optional: true, max: 64)), .text(now), .text(now),
        ]
        return try db.onQueue {
            try db.run("insert into notes (id, name, path, goal_id, topic_id, created, last_edited) values (?, ?, ?, ?, ?, ?, ?)", values)
            return NoteRow(sql: try db.query("select * from notes where id = ?", [values[0]])[0])
        }
    }

    public func list() throws -> [NoteRow] { try db.query("select * from notes order by created, name").map(NoteRow.init(sql:)) }

    public func get(_ id: String) throws -> NoteRow? {
        try db.query("select * from notes where id = ?", [.text(try LibraryDB.id(id))]).first.map(NoteRow.init(sql:))
    }

    @discardableResult
    public func rename(_ id: String, name: String, path: String) throws -> NoteRow? {
        let id = try LibraryDB.id(id)
        return try db.onQueue {
            try db.run("update notes set name = ?, path = ?, last_edited = ? where id = ?", [.text(try LibraryDB.requireText(name, "name", max: 512)!), .text(try LibraryDB.requireText(path, "path")!), .text(Time.iso()), .text(id)])
            return try db.query("select * from notes where id = ?", [.text(id)]).first.map(NoteRow.init(sql:))
        }
    }

    @discardableResult
    public func touch(_ id: String) throws -> Bool {
        try db.run("update notes set last_edited = ? where id = ?", [.text(Time.iso()), .text(try LibraryDB.id(id))])
        return true
    }

    /// The cards on screen; the trash holds the rest (trashed / restore / purge).
    public final class PostIts: @unchecked Sendable {
        let db: SQLiteDatabase
        init(db: SQLiteDatabase) { self.db = db }

        static func values(_ row: PostItValues) throws -> [SQLValue] {
            guard row.text.count <= 400_000 else { throw StoreError.type("Sticky text must be at most 400000 characters") }
            for (key, value, low, high) in [("nx", row.nx, 0.0, 1.0), ("ny", row.ny, 0, 1), ("width", row.width, 180, 2400), ("height", row.height, 140, 2400), ("z", row.z, 0, 9_007_199_254_740_991)] {
                if !value.isFinite || value < low || value > high { throw StoreError.type("Sticky \(key) is out of range") }
            }
            return [.text(row.text), .double(row.nx), .double(row.ny), .double(row.width), .double(row.height), .double(row.z)]
        }

        private func row(_ id: String) throws -> PostItRow? {
            try db.query("select * from post_its where id = ?", [.text(id)]).first.map(PostItRow.init(sql:))
        }

        public func list() throws -> [PostItRow] {
            try db.query("select * from post_its where deleted is null order by z, created, id").map(PostItRow.init(sql:))
        }

        @discardableResult
        public func create(id: String, _ values: PostItValues) throws -> PostItRow {
            let id = try LibraryDB.id(id)
            let now = Time.iso()
            return try db.onQueue {
                try db.run("insert into post_its (id, text, nx, ny, width, height, z, created, last_edited) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [.text(id)] + (try Self.values(values)) + [.text(now), .text(now)])
                return try row(id)!
            }
        }

        /// UPDATE, never UPSERT: a save already in flight must not resurrect a purged card. It leaves `deleted` alone.
        @discardableResult
        public func update(id: String, _ values: PostItValues) throws -> PostItRow? {
            let id = try LibraryDB.id(id)
            return try db.onQueue {
                let changed = try db.run("update post_its set text = ?, nx = ?, ny = ?, width = ?, height = ?, z = ?, last_edited = ? where id = ?", (try Self.values(values)) + [.text(Time.iso()), .text(id)])
                return changed > 0 ? try row(id) : nil
            }
        }

        @discardableResult
        public func trash(_ id: String) throws -> PostItRow? {
            let id = try LibraryDB.id(id)
            return try db.onQueue { try db.run("update post_its set deleted = ? where id = ? and deleted is null", [.text(Time.iso()), .text(id)]) > 0 ? try row(id) : nil }
        }

        @discardableResult
        public func restore(_ id: String) throws -> PostItRow? {
            let id = try LibraryDB.id(id)
            return try db.onQueue { try db.run("update post_its set deleted = null where id = ? and deleted is not null", [.text(id)]) > 0 ? try row(id) : nil }
        }

        public func trashed() throws -> [PostItRow] {
            try db.query("select * from post_its where deleted is not null order by deleted desc, id").map(PostItRow.init(sql:))
        }

        /// Gone for good: cards in the trash since before `before`. → how many.
        @discardableResult
        public func purge(before: Date) throws -> Int {
            try db.run("delete from post_its where deleted is not null and deleted < ?", [.text(Time.iso(before))])
        }

        @discardableResult
        public func remove(_ id: String) throws -> Bool {
            try db.run("delete from post_its where id = ?", [.text(try LibraryDB.id(id))]) > 0
        }
    }
}
