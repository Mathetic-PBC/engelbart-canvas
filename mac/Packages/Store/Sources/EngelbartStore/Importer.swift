import Foundation
import EngelbartCore

/// The one-time move of the Electron app's data into the Swift app's root (ARCHITECTURE §3). The only code allowed to read
/// `~/.engelbart`, and only from the app, never in tests: every file is cloned (APFS `clonefile`) into the Swift root, and
/// each PGlite database (`library.pglite`, each project's `notes.pglite`) is read from a COPY by a Node script
/// (Resources/pglite-dump.cjs) and inserted into SQLite (`library.sqlite`, `notes.sqlite`).
public enum StoreImporter {
    /// How the Node script runs: an executable, its environment.
    public struct NodeRuntime: Sendable {
        public var executable: String
        public var environment: [String: String]
        public var name: String
        public init(executable: String, environment: [String: String], name: String) { self.executable = executable; self.environment = environment; self.name = name }
    }

    /// The installed Electron app's own runtime, with pglite from its `app.asar.unpacked` (Engelbart 0.1.25 ships
    /// @electric-sql/pglite 0.5.8 there).
    public static let electronApp = "/Applications/Engelbart.app/Contents/MacOS/Engelbart"
    public static let electronModules = "/Applications/Engelbart.app/Contents/Resources/app.asar.unpacked/node_modules"
    /// The fallback: `node` with a checkout's node_modules (`ENGELBART_NODE_MODULES` overrides).
    public static let checkoutModules = "/Users/hudsonmitchell-pullman/engelbart-canvas/node_modules"

    /// First choice the installed Electron app as Node (ELECTRON_RUN_AS_NODE=1), else `node` + a checkout's node_modules.
    public static func findRuntime() -> NodeRuntime? {
        var base = ShellEnvironment.environment()
        if Paths.exists(electronApp), Paths.exists(Paths.join(electronModules, "@electric-sql", "pglite", "package.json")) {
            base["ELECTRON_RUN_AS_NODE"] = "1"
            base["NODE_PATH"] = electronModules
            return NodeRuntime(executable: electronApp, environment: base, name: "Engelbart.app (ELECTRON_RUN_AS_NODE)")
        }
        return nodeRuntime()
    }

    /// `node` on the login PATH with `modules` (default: ENGELBART_NODE_MODULES, else the checkout's).
    public static func nodeRuntime(modules: String? = nil) -> NodeRuntime? {
        var env = ShellEnvironment.environment()
        let dir = modules ?? env["ENGELBART_NODE_MODULES"] ?? checkoutModules
        guard let node = ShellEnvironment.resolve("node", environment: env), Paths.exists(Paths.join(dir, "@electric-sql", "pglite", "package.json")) else { return nil }
        env["NODE_PATH"] = dir
        env["ELECTRON_RUN_AS_NODE"] = nil
        return NodeRuntime(executable: node.path, environment: env, name: "node")
    }

    static var dumpScript: String? { Bundle.module.url(forResource: "pglite-dump", withExtension: "cjs", subdirectory: "Resources")?.path }

    public struct Report: Sendable {
        /// Files cloned.
        public var files: Int
        /// SQLite file → rows inserted.
        public var databases: [String: Int]
        public var runtime: String
    }

    /// Copies the Electron root `from` into the Swift root `to`, converting every PGlite database. `to` must not hold a
    /// library yet (refused unless `replace`). Nothing in `from` is written.
    @discardableResult
    public static func importElectronRoot(from: URL, to: URL, runtime: NodeRuntime? = nil, replace: Bool = false) async throws -> Report {
        let source = Paths.normalize(from.path), target = Paths.normalize(to.path)
        guard Paths.isDirectory(source) else { throw StoreError("Nothing is at \(source)") }
        if !replace && Paths.exists(Paths.join(target, LibraryDB.fileName)) { throw StoreError("\(target) already has a library") }
        guard let runtime = runtime ?? findRuntime() else { throw StoreError("No Node runtime with @electric-sql/pglite was found to read the Electron databases") }
        guard let script = dumpScript else { throw StoreError("The importer's script is missing from the app") }
        try JSONFiles.makeDir(target)
        var report = Report(files: 0, databases: [:], runtime: runtime.name)
        var databases: [(pglite: String, sqlite: String)] = []

        func walk(_ from: String, _ to: String) throws {
            for name in (Paths.listDir(from) ?? []).sorted() {
                let s = Paths.join(from, name), t = Paths.join(to, name)
                if name.hasSuffix(".pglite") && Paths.isRealDirectory(s) {
                    databases.append((s, Paths.join(to, String(name.dropLast(".pglite".count)) + ".sqlite")))
                    continue
                }
                if Paths.isSymlink(s) { continue }
                if Paths.isRealDirectory(s) { try JSONFiles.makeDir(t); try walk(s, t); continue }
                if Paths.exists(t) { if replace { try FileManager.default.removeItem(atPath: t) } else { continue } }
                try Files.cloneItem(at: URL(fileURLWithPath: s), to: URL(fileURLWithPath: t))
                report.files += 1
            }
        }
        try walk(source, target)

        let scratch = Paths.join(NSTemporaryDirectory(), "engelbart-import-\(IDs.new())")
        try JSONFiles.makeDir(scratch)
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        for (index, db) in databases.enumerated() {
            // Read a COPY: the Electron app may have its database open.
            let copy = Paths.join(scratch, "db-\(index).pglite"), out = Paths.join(scratch, "db-\(index).json")
            try JSONFiles.makeDir(scratch)
            try Files.cloneItem(at: URL(fileURLWithPath: db.pglite), to: URL(fileURLWithPath: copy))
            let result = try await ProcessRunner.run(runtime.executable, [script, copy, out], environment: runtime.environment, timeout: 600)
            guard result.exit.succeeded, let data = FileManager.default.contents(atPath: out) else {
                throw StoreError("Could not read \(db.pglite): \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
            try JSONFiles.makeDir(Paths.dirname(db.sqlite))
            report.databases[db.sqlite] = try insert(dump: try JSONValue.parse(data), into: db.sqlite, replace: replace)
        }
        return report
    }

    static let libraryOrder = ["library", "library_text", "sandbox_environments", "repo_runnables", "sandbox_runs"]
    static let notesOrder = ["notes", "post_its"]

    /// A dumped database into SQLite: the Store's schema made first (by opening it), then every row, each column the two
    /// share, values in SQLite's types (arrays and objects as JSON text, booleans 0/1). → rows inserted.
    static func insert(dump: JSONValue, into file: String, replace: Bool) throws -> Int {
        if replace { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: file + suffix) } }
        let isLibrary = Paths.basename(file) == LibraryDB.fileName
        let tables = dump.object ?? [:]
        if isLibrary, let library = tables["library"], !(library["columns"]?.array ?? []).contains(where: { $0["column_name"]?.string == "tags" }) {
            // A library typed the old way: written as it was, then opening it converts it (after a copy set aside).
            let raw = try SQLiteDatabase(path: file)
            let columns = (library["columns"]?.array ?? []).compactMap { $0["column_name"]?.string }
            try raw.execute("create table library (\(columns.map { "\"\($0)\"" }.joined(separator: ", ")))")
            var n = 0
            for row in library["rows"]?.array ?? [] { try insertRow(raw, "library", row, columns); n += 1 }
            raw.close()
            let db = try LibraryDB.open(root: Paths.dirname(file))
            let rest = try insertTables(db.db, tables, order: libraryOrder.filter { $0 != "library" })
            try db.backfillMilestones()
            return n + rest
        }
        if isLibrary {
            let library = try LibraryDB.open(root: Paths.dirname(file))
            let n = try insertTables(library.db, tables, order: libraryOrder)
            try library.backfillMilestones()
            return n
        }
        return try insertTables(try NotesDB.open(projectDir: Paths.dirname(file)).db, tables, order: notesOrder)
    }

    static func insertTables(_ db: SQLiteDatabase, _ tables: [String: JSONValue], order: [String]) throws -> Int {
        var count = 0
        try db.transaction {
            for table in order {
                guard let dumped = tables[table] else { continue }
                let columns = Set(try db.columns(table))
                for row in dumped["rows"]?.array ?? [] {
                    try insertRow(db, table, row, (row.object ?? [:]).keys.filter(columns.contains).sorted())
                    count += 1
                }
            }
        }
        return count
    }

    static func insertRow(_ db: SQLiteDatabase, _ table: String, _ row: JSONValue, _ columns: [String]) throws {
        guard !columns.isEmpty else { return }
        let values: [SQLValue] = columns.map { column in
            switch row[column] ?? .null {
            case .null: return .null
            case .bool(let b): return .int(b ? 1 : 0)
            case .number(let n): return n.rounded() == n && abs(n) < 9e15 ? .int(Int64(n)) : .double(n)
            case .string(let s): return .text(s)
            case let other: return .text(other.text())
            }
        }
        try db.run("insert or replace into \(table) (\(columns.map { "\"\($0)\"" }.joined(separator: ", "))) values (\(columns.map { _ in "?" }.joined(separator: ", ")))", values)
    }
}
