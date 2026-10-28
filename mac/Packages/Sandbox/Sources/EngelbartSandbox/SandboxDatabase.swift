import Foundation
import SQLite3
import EngelbartCore

/// What this package needs of the library database (`<root>/library.sqlite`, owned by the Store): the tables
/// `sandbox_runs` and `sandbox_environments` through plain SQL (SQLite dialect), and the library rows it reads. The app
/// adapts the Store's connection to it; `SQLiteSandboxDatabase` is a ready adapter over a file (and the tests' database).
///
/// Values: TEXT ↔ `.string`, INTEGER/REAL ↔ `.number`, NULL ↔ `.null`. JSON columns (`build_log`, `build_milestones`,
/// `env_report`, `terminal`) hold JSON text; `RunStore` decodes them.
public protocol SandboxDatabase: AnyObject {
    func query(_ sql: String, _ params: [JSONValue]) throws -> [[String: JSONValue]]
    /// Runs `body` in one write transaction (BEGIN IMMEDIATE … COMMIT; ROLLBACK on a throw).
    func transaction<T>(_ body: () throws -> T) throws -> T
    /// A library row as the Electron `libraryDb.get` answers it (`id`, `name`, `url`, `tags` [array]…), or nil.
    func libraryRow(_ id: String) throws -> JSONValue?
    /// Every library row (`libraryDb.list`), for `sandbox-ensure`.
    func libraryRows() throws -> [JSONValue]
}

/// A SQLite connection implementing `SandboxDatabase`. `createSchema` makes the sandbox tables as
/// src/main/store/db.cjs declares them (and a minimal `library` table when there is none), for tests and fresh files.
public final class SQLiteSandboxDatabase: SandboxDatabase, @unchecked Sendable {
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()

    public init(path: String, createSchema: Bool = false) throws {
        if sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
            throw SandboxError("Could not open \(path)")
        }
        sqlite3_busy_timeout(db, 5000)
        _ = try query("pragma foreign_keys = on", [])
        _ = try query("pragma journal_mode = wal", [])
        if createSchema { try Self.createSchema(self) }
    }

    deinit { sqlite3_close_v2(db) }

    public func close() { lock.lock(); sqlite3_close_v2(db); db = nil; lock.unlock() }

    /// The sandbox tables, as db.cjs makes them (types mapped per ARCHITECTURE §3).
    public static func createSchema(_ database: SandboxDatabase) throws {
        let statements = [
            """
            create table if not exists library (id text primary key, name text not null, type text not null default 'website',
              url text, tags text not null default '[]', created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')))
            """,
            """
            create table if not exists sandbox_runs (
              id text primary key,
              library_id text not null references library (id) on delete restrict,
              sandbox_id text,
              status text not null default 'starting' check (status in ('starting', 'ready', 'failed', 'stopped')),
              preview_url text,
              port integer check (port between 1 and 65535),
              error text,
              created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              finished_at text,
              build_log text not null default '[]',
              build_milestones text default '{}',
              env_revision text,
              env_report text,
              last_opened_at text,
              kind text,
              kind_reason text,
              terminal text
            )
            """,
            "create index if not exists sandbox_runs_library_created on sandbox_runs (library_id, created_at desc)",
            """
            create table if not exists sandbox_environments (
              library_id text primary key references library (id) on delete cascade,
              revision text not null,
              encrypted text not null,
              updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )
            """,
            "create unique index if not exists sandbox_runs_one_active on sandbox_runs (library_id) where status in ('starting', 'ready')",
        ]
        for sql in statements { _ = try database.query(sql, []) }
    }

    public func query(_ sql: String, _ params: [JSONValue]) throws -> [[String: JSONValue]] {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw SandboxError("The library database is closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw SandboxError(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, value) in params.enumerated() {
            let index = Int32(i + 1)
            switch value {
            case .null: sqlite3_bind_null(statement, index)
            case .bool(let b): sqlite3_bind_int64(statement, index, b ? 1 : 0)
            case .number(let n):
                if n.rounded() == n, abs(n) < 9.0e15 { sqlite3_bind_int64(statement, index, Int64(n)) } else { sqlite3_bind_double(statement, index, n) }
            case .string(let s): sqlite3_bind_text(statement, index, s, -1, transient)
            case .array, .object: sqlite3_bind_text(statement, index, value.text(), -1, transient)
            }
        }
        var rows: [[String: JSONValue]] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else {
                let code = sqlite3_extended_errcode(db)
                throw SandboxError(String(cString: sqlite3_errmsg(db)), name: "SQLiteError", status: Int(code))
            }
            var row: [String: JSONValue] = [:]
            for c in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, c))
                switch sqlite3_column_type(statement, c) {
                case SQLITE_NULL: row[name] = .null
                case SQLITE_INTEGER: row[name] = .number(Double(sqlite3_column_int64(statement, c)))
                case SQLITE_FLOAT: row[name] = .number(sqlite3_column_double(statement, c))
                default: row[name] = .string(String(cString: sqlite3_column_text(statement, c)))
                }
            }
            rows.append(row)
        }
        return rows
    }

    public func transaction<T>(_ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        _ = try query("begin immediate", [])
        do {
            let value = try body()
            _ = try query("commit", [])
            return value
        } catch {
            _ = try? query("rollback", [])
            throw error
        }
    }

    public func libraryRow(_ id: String) throws -> JSONValue? {
        try query("select * from library where id = ?", [.string(id)]).first.map(Self.libraryJSON)
    }

    public func libraryRows() throws -> [JSONValue] {
        try query("select * from library order by created_at, id", []).map(Self.libraryJSON)
    }

    static func libraryJSON(_ row: [String: JSONValue]) -> JSONValue {
        var o = row
        if let tags = row["tags"]?.string { o["tags"] = (try? JSONValue.parse(tags)) ?? .array([]) }
        return .object(o)
    }

    /// Test helper: a library row.
    @discardableResult
    public func insertLibrary(id: String = IDs.new(), name: String, url: String?, tags: [String] = ["git"]) throws -> String {
        _ = try query("insert into library (id, name, url, tags) values (?, ?, ?, ?)",
                      [.string(id), .string(name), url.map { .string($0) } ?? .null, .array(tags.map { .string($0) })])
        return id
    }
}
