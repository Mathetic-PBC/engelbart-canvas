import Foundation
import SQLite3
import EngelbartCore

/// What the Store throws. `kind` keeps the JavaScript error class the Electron store threw (TypeError for a bad
/// argument, RangeError for too many, a plain Error otherwise) so callers and tests can tell them apart; `code` is
/// Electron's `error.code` (`EXISTS` for "Already in the library as …", which carries the row it names).
public struct StoreError: Error, LocalizedError, CustomStringConvertible {
    public enum Kind: String, Sendable { case type, range, plain }
    public var kind: Kind
    public var message: String
    public var code: String?
    public var row: LibraryRow?

    public init(_ message: String, kind: Kind = .plain, code: String? = nil, row: LibraryRow? = nil) {
        self.message = message; self.kind = kind; self.code = code; self.row = row
    }
    public static func type(_ message: String) -> StoreError { StoreError(message, kind: .type) }
    public static func range(_ message: String) -> StoreError { StoreError(message, kind: .range) }

    public var errorDescription: String? { message }
    public var description: String { message }
}

/// One SQLite value. uuid → text, timestamptz → ISO text, text[]/jsonb → JSON text, boolean → integer (ARCHITECTURE §3).
public enum SQLValue: Equatable, Sendable {
    case null
    case int(Int64)
    case double(Double)
    case text(String)

    public var string: String? { if case .text(let s) = self { return s }; return nil }
    public var int: Int? {
        switch self {
        case .int(let n): return Int(n)
        case .double(let d): return Int(exactly: d)
        default: return nil
        }
    }
    public var double: Double? {
        switch self {
        case .int(let n): return Double(n)
        case .double(let d): return d
        default: return nil
        }
    }
    public var isNull: Bool { self == .null }

    public static func of(_ s: String?) -> SQLValue { s.map { .text($0) } ?? .null }
    public static func of(_ n: Int?) -> SQLValue { n.map { .int(Int64($0)) } ?? .null }

    /// As JSON (what a JavaScript caller of `query()` would have seen).
    public var json: JSONValue {
        switch self {
        case .null: return .null
        case .int(let n): return .number(Double(n))
        case .double(let d): return .number(d)
        case .text(let s): return .string(s)
        }
    }
}

public typealias SQLRow = [String: SQLValue]

/// A SQLite database file, every statement run on one serial queue (ARCHITECTURE §3). WAL, foreign keys on.
/// Calls made from inside the queue (a transaction composing several statements) run directly.
public final class SQLiteDatabase: @unchecked Sendable {
    public let path: String
    private var handle: OpaquePointer?
    private let queue: DispatchQueue
    private let key = DispatchSpecificKey<UUID>()
    private let token = UUID()

    public init(path: String) throws {
        self.path = path
        queue = DispatchQueue(label: "engelbart.sqlite.\(URL(fileURLWithPath: path).lastPathComponent)")
        queue.setSpecific(key: key, value: token)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open"
            sqlite3_close(db)
            throw StoreError("Could not open \(path): \(message)")
        }
        handle = db
        chmod(path, 0o600)
        try execute("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;")
    }

    deinit { if let handle { sqlite3_close_v2(handle) } }

    public var isOpen: Bool { onQueue { handle != nil } }

    public func onQueue<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: key) == token { return try body() }
        return try queue.sync(execute: body)
    }

    private func db() throws -> OpaquePointer {
        guard let handle else { throw StoreError("The database is closed") }
        return handle
    }

    private func failure(_ db: OpaquePointer) -> StoreError {
        StoreError(String(cString: sqlite3_errmsg(db)))
    }

    /// Several statements, no parameters (the schema).
    public func execute(_ sql: String) throws {
        try onQueue {
            let db = try db()
            var error: UnsafeMutablePointer<CChar>?
            if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK {
                let message = error.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(db))
                sqlite3_free(error)
                throw StoreError(message)
            }
        }
    }

    /// One statement; → the rows it returns.
    @discardableResult
    public func query(_ sql: String, _ params: [SQLValue] = []) throws -> [SQLRow] {
        try onQueue { try step(sql, params).rows }
    }

    /// One statement; → how many rows it changed.
    @discardableResult
    public func run(_ sql: String, _ params: [SQLValue] = []) throws -> Int {
        try onQueue { try step(sql, params).changes }
    }

    private func step(_ sql: String, _ params: [SQLValue]) throws -> (rows: [SQLRow], changes: Int) {
        let db = try db()
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure(db) }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in params.enumerated() {
            let at = Int32(index + 1)
            switch value {
            case .null: sqlite3_bind_null(statement, at)
            case .int(let n): sqlite3_bind_int64(statement, at, n)
            case .double(let d): sqlite3_bind_double(statement, at, d)
            case .text(let s): sqlite3_bind_text(statement, at, s, -1, transient)
            }
        }
        var rows: [SQLRow] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else { throw failure(db) }
            var row: SQLRow = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(statement, column))
                case SQLITE_FLOAT: row[name] = .double(sqlite3_column_double(statement, column))
                case SQLITE_NULL: row[name] = .null
                default:
                    if let text = sqlite3_column_text(statement, column) { row[name] = .text(String(cString: text)) } else { row[name] = .null }
                }
            }
            rows.append(row)
        }
        return (rows, Int(sqlite3_changes(db)))
    }

    /// `body` in one transaction (rolled back when it throws).
    public func transaction<T>(_ body: () throws -> T) throws -> T {
        try onQueue {
            try execute("begin immediate")
            do {
                let out = try body()
                try execute("commit")
                return out
            } catch {
                try? execute("rollback")
                throw error
            }
        }
    }

    /// The column names of `table` (empty when there is no such table).
    public func columns(_ table: String) throws -> [String] {
        try query("select name from pragma_table_info(?)", [.text(table)]).compactMap { $0["name"]?.string }
    }

    public func close() {
        onQueue {
            guard let handle else { return }
            sqlite3_exec(handle, "pragma wal_checkpoint(truncate)", nil, nil, nil)
            sqlite3_close_v2(handle)
            self.handle = nil
        }
    }
}

/// One open instance per database file, as db.cjs keeps `instances`: opening a file twice gives the same database;
/// `close(path)` answers whether one was open.
public enum SQLiteRegistry {
    private static let lock = NSLock()
    private static var open: [String: AnyObject] = [:]

    static func instance<T: AnyObject>(_ path: String, make: () throws -> T) throws -> T {
        let key = Paths.normalize(path)
        lock.lock(); defer { lock.unlock() }
        if let held = open[key] as? T { return held }
        let made = try make()
        open[key] = made
        return made
    }

    /// Closes the database at `path`. → whether it was open (db.cjs closeDb).
    @discardableResult
    public static func close(_ path: String) -> Bool {
        let key = Paths.normalize(path)
        lock.lock()
        let held = open.removeValue(forKey: key)
        lock.unlock()
        guard let held else { return false }
        (held as? Closable)?.closeDatabase()
        return true
    }

    public static func closeAll() {
        lock.lock()
        let all = Array(open.values)
        open.removeAll()
        lock.unlock()
        for held in all { (held as? Closable)?.closeDatabase() }
    }

    /// Every open database whose file is under `dir` (a project folder about to move).
    public static func close(under dir: String) {
        let prefix = Paths.normalize(dir) + "/"
        lock.lock()
        let keys = open.keys.filter { $0.hasPrefix(prefix) }
        lock.unlock()
        for key in keys { close(key) }
    }
}

protocol Closable: AnyObject { func closeDatabase() }
