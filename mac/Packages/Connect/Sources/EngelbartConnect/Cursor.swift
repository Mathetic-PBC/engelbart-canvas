import Foundation
import SQLite3
import EngelbartCore

/// A read-only SQLite database (Cursor's state.vscdb, a browser's History): `node:sqlite`'s DatabaseSync with readOnly.
public final class SQLiteReader {
    private var db: OpaquePointer?

    public init(path: String, immutable: Bool = false) throws {
        // `immutable=1` reads a database another program holds open without taking its locks (a browser's History).
        let uri = immutable ? "file:\(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)?mode=ro&immutable=1" : path
        let flags = SQLITE_OPEN_READONLY | (immutable ? SQLITE_OPEN_URI : 0)
        if sqlite3_open_v2(uri, &db, flags, nil) != SQLITE_OK {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unable to open"
            sqlite3_close(db); db = nil
            throw ConnectError("failed", message)
        }
    }

    deinit { close() }

    public func close() { if let db { sqlite3_close(db) }; db = nil }

    public enum Value { case null, int(Int64), real(Double), text(String), blob(Data)
        public var string: String? {
            switch self { case .text(let s): return s; case .blob(let d): return String(decoding: d, as: UTF8.self); case .int(let i): return String(i); case .real(let r): return String(r); case .null: return nil }
        }
        public var int: Int64? { switch self { case .int(let i): return i; case .real(let r): return Int64(r); case .text(let s): return Int64(s); default: return nil } }
        public var double: Double? { switch self { case .int(let i): return Double(i); case .real(let r): return r; case .text(let s): return Double(s); default: return nil } }
    }

    /// Every row of `sql` with `args` bound (strings, ints, doubles), each as column name → value.
    public func all(_ sql: String, _ args: [Any] = []) throws -> [[String: Value]] {
        guard let db else { throw ConnectError("failed", "closed") }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw ConnectError("failed", String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, arg) in args.enumerated() {
            let n = Int32(i + 1)
            switch arg {
            case let s as String: sqlite3_bind_text(stmt, n, s, -1, transient)
            case let v as Int: sqlite3_bind_int64(stmt, n, Int64(v))
            case let v as Int64: sqlite3_bind_int64(stmt, n, v)
            case let v as Double: sqlite3_bind_double(stmt, n, v)
            default: sqlite3_bind_null(stmt, n)
            }
        }
        var rows: [[String: Value]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw ConnectError("failed", String(cString: sqlite3_errmsg(db))) }
            var row: [String: Value] = [:]
            for c in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: row[name] = .real(sqlite3_column_double(stmt, c))
                case SQLITE_TEXT: row[name] = .text(String(cString: sqlite3_column_text(stmt, c)))
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(stmt, c))
                    row[name] = .blob(count > 0 ? Data(bytes: sqlite3_column_blob(stmt, c), count: count) : Data())
                default: row[name] = .null
                }
            }
            rows.append(row)
        }
        return rows
    }

    public func get(_ sql: String, _ args: [Any] = []) throws -> [String: Value]? { try all(sql, args).first }
}

// Port of src/main/connect/cursor.cjs (Connect your library, 2026-10-07, second build): Cursor's chats on this Mac. Cursor
// keeps its composer and chat panes in one SQLite database (state.vscdb, often hundreds of MB): table cursorDiskKV,
// `composerData:<id>` a chat's head (name, createdAt, lastUpdatedAt, the ids of its turns in order) and
// `bubbleId:<chat id>:<turn id>` one turn ({ type: 1 the person, 2 Cursor; text }). Read in place, read-only; nothing is
// ever written to it. An older or newer layout fails with a plain error, which the agent says in its reply.
public enum Cursor {
    static let dayMs = 86_400_000.0
    static let idRE = "^[0-9a-f-]{8,64}$"

    /// cursor.cjs's clip (no trimEnd before the ellipsis).
    static func clip(_ text: String?, _ max: Int) -> String {
        let value = JS.replace(text ?? "", #"\s+"#, " ").trimmingCharacters(in: .whitespaces)
        return value.count > max ? String(value.prefix(max - 1)) + "…" : value
    }

    public static func dbPath(homeDir: String) -> String {
        (homeDir as NSString).appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    }

    static func open(_ homeDir: String) throws -> SQLiteReader {
        let file = dbPath(homeDir: homeDir)
        guard FileManager.default.fileExists(atPath: file) else { throw ConnectError("failed", "Cursor has no chats on this Mac") }
        do { return try SQLiteReader(path: file) } catch {
            throw ConnectError("failed", "Cursor's database could not be opened (\(String(error.localizedDescription.prefix(120))))")
        }
    }

    static func parse(_ value: SQLiteReader.Value?) -> JSONValue? {
        guard let text = value?.string else { return nil }
        return try? JSONValue.parse(text)
    }

    public struct Chat: Sendable, Equatable { public var id: String; public var title: String; public var first: String; public var project: String; public var date: String?; public var turns: Int }

    /// Cursor's chats, newest first: changed in `days`, matching `query`, at most `limit`.
    public static func chats(homeDir: String, days: Double? = nil, query: String = "", limit: Int = 200, now: Date = Date()) throws -> [Chat] {
        let db = try open(homeDir)
        defer { db.close() }
        let since = (days.map { $0.isFinite && $0 > 0 } ?? false) ? Time.ms(now) - days! * dayMs : 0
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        struct Row { var id: String; var name: String; var updated: Double; var turns: Int; var firstTurn: String? }
        var rows: [Row] = []
        for row in try db.all("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'") {
            guard let head = parse(row["value"]), let turns = head["fullConversationHeadersOnly"]?.array, !turns.isEmpty else { continue }
            let key = row["key"]?.string ?? ""
            let id = JS.truthy(head["composerId"]) ? JS.string(head["composerId"]) : String(key.dropFirst("composerData:".count))
            let updated = (JS.truthy(head["lastUpdatedAt"]) ? head["lastUpdatedAt"]?.double : head["createdAt"]?.double) ?? 0
            if since > 0 && updated < since { continue }
            let firstTurn = turns.first { $0["type"]?.double == 1 }?["bubbleId"].map { JS.string($0) }
            rows.append(Row(id: id, name: JS.string(head["name"]), updated: updated, turns: turns.count, firstTurn: firstTurn))
        }
        rows.sort { $0.updated > $1.updated }
        var out: [Chat] = []
        for entry in rows {
            var first = ""
            if let turn = entry.firstTurn, !turn.isEmpty, let bubble = parse(try db.get("SELECT value FROM cursorDiskKV WHERE key = ?", ["bubbleId:\(entry.id):\(turn)"])?["value"]) {
                first = clip(JS.string(bubble["text"]), 300)
            }
            let title = clip(!entry.name.isEmpty ? entry.name : !first.isEmpty ? first : "Cursor chat", 120)
            let chat = Chat(id: entry.id, title: title, first: first, project: "", date: entry.updated > 0 ? Time.iso(Date(timeIntervalSince1970: entry.updated / 1000)) : nil, turns: entry.turns)
            if !words.isEmpty && !words.allSatisfy({ "\(chat.title) \(chat.first)".lowercased().contains($0) }) { continue }
            out.append(chat)
            if out.count >= limit { break }
        }
        return out
    }

    public struct Turn: Sendable, Equatable { public var role: String; public var text: String }
    public struct Transcript: Sendable, Equatable { public var title: String; public var project: String; public var date: String?; public var turns: [Turn] }

    /// One Cursor chat as turns of text.
    public static func transcript(homeDir: String, id: String) throws -> Transcript {
        guard JS.test(id, idRE, options: .caseInsensitive) else { throw ConnectError("failed", "No Cursor chat \(id)") }
        let db = try open(homeDir)
        defer { db.close() }
        guard let head = parse(try db.get("SELECT value FROM cursorDiskKV WHERE key = ?", ["composerData:\(id)"])?["value"]) else {
            throw ConnectError("failed", "No Cursor chat \(id)")
        }
        var turns: [Turn] = []
        for header in head["fullConversationHeadersOnly"]?.array ?? [] {
            let value = parse(try db.get("SELECT value FROM cursorDiskKV WHERE key = ?", ["bubbleId:\(id):\(JS.string(header["bubbleId"]))"])?["value"])
            let text = JS.string(value?["text"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let type = JS.truthy(value?["type"]) ? value?["type"]?.double : header["type"]?.double
            let role = type == 1 ? "user" : "assistant"
            if let last = turns.last, last.role == role { turns[turns.count - 1].text = "\(last.text)\n\n\(text)" } else { turns.append(Turn(role: role, text: text)) }
        }
        let updated = (JS.truthy(head["lastUpdatedAt"]) ? head["lastUpdatedAt"]?.double : head["createdAt"]?.double) ?? 0
        let name = JS.string(head["name"])
        return Transcript(title: clip(!name.isEmpty ? name : (turns.first?.text ?? "Cursor chat"), 120), project: "",
                          date: updated > 0 ? Time.iso(Date(timeIntervalSince1970: updated / 1000)) : nil, turns: turns)
    }
}
