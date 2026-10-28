import Foundation

/// What runs in a repository (runnables.cjs; library.sqlite → repo_runnables, 2026-09-29): each web UI (`ui`), desktop
/// app (`app`) or terminal program (`terminal`) a Build's run step found in a library repository, and the commands that
/// passed Engelbart's own check. Commands are written only when a check passed (`verify`); a runnable that never passed
/// in its time keeps the commands that last worked and is `failed`, with why.
public enum Runnables {
    public static let types = ["ui", "app", "terminal"]
    public static let port = "{port}"
    static let maxCommand = 4000
    static let maxError = 4000

    /// A folder relative to the repository's root, as it is kept: '.', or 'web', 'apps/desktop' … never outside the root.
    public static func folder(_ value: String?) throws -> String {
        let raw = (value == nil || value == "") ? "." : value!
        if raw.count > 1024 || raw.contains("\0") || raw.contains("\\") || raw.hasPrefix("/") { throw BuildError("folder must be relative to the repository") }
        var normalized = NodePath.normalize(raw)
        while normalized.hasSuffix("/") && normalized.count > 1 { normalized.removeLast() }
        let folder = normalized.isEmpty ? "." : normalized
        if folder == ".." || folder.hasPrefix("../") { throw BuildError("folder must be inside the repository") }
        return folder
    }

    public static func name(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: #"^[\w][\w .@+-]{0,63}$"#, options: .regularExpression) != nil else {
            throw BuildError("name must be 1 to 64 letters, digits, spaces or ._@+-")
        }
        return trimmed
    }

    public static func type(_ value: String) throws -> String {
        guard types.contains(value) else { throw BuildError("type must be one of \(types.joined(separator: ", "))") }
        return value
    }

    /// A command as it is kept: a UI's holds {port}, where Engelbart puts the port it gives it.
    public static func command(_ value: String?, type: String? = nil, optional: Bool = false, name: String = "command") throws -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if optional { return nil }
            throw BuildError("\(name) is required")
        }
        if value.count > maxCommand || value.contains("\0") { throw BuildError("\(name) must be a string of at most \(maxCommand) characters") }
        if type == "ui" && !value.contains(port) {
            throw BuildError("A web UI's run command must hold \(port) where its port goes (for example \"npm run dev -- --port \(port)\" or \"PORT=\(port) npm start\"): Engelbart gives it a free port each time it runs.")
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The command with Engelbart's port in it.
    public static func withPort(_ command: String, _ port: Int) -> String { command.replacingOccurrences(of: self.port, with: String(port)) }
}

/// runnableStore: the validated operations over repo_runnables.
public struct RunnableStore: Sendable {
    let table: RepoRunnablesTable
    public init(_ table: RepoRunnablesTable) { self.table = table }

    /// A repository's runnables, by folder and name.
    public func list(_ libraryId: String) async throws -> [RunnableRow] { try await table.list(libraryId: libraryId) }
    public func get(_ id: String) async throws -> RunnableRow? { try await table.get(id: id) }

    /// A runnable the run step named: made `pending` when it is new. A known one keeps its commands; given another type,
    /// its commands are for something else, so it is `pending` again.
    public func declare(_ libraryId: String, folder: String?, name: String, type: String) async throws -> RunnableRow {
        try await table.declare(id: IDsLower.new(), libraryId: libraryId, folder: Runnables.folder(folder), name: Runnables.name(name), type: Runnables.type(type))
    }

    /// The check passed: these are its commands now, checked at `commit`.
    @discardableResult
    public func verify(_ id: String, install: String?, run: String?, commit: String?) async throws -> RunnableRow? {
        guard let row = try await get(id) else { throw BuildError("Unknown runnable") }
        let sha = commit.flatMap { $0.range(of: "^[0-9a-f]{7,64}$", options: .regularExpression) != nil ? $0 : nil }
        return try await table.verify(id: id, installCommand: try Runnables.command(install, optional: true, name: "install_command"),
                                      runCommand: try Runnables.command(run, type: row.type, name: "run_command")!, commit: sha)
    }

    /// It never passed in its time: `failed`, with the last error; the commands that last worked stay.
    @discardableResult
    public func fail(_ id: String, _ error: String?) async throws -> RunnableRow? {
        let text = (error?.isEmpty == false ? error! : "It did not pass its check.")
        return try await table.fail(id: id, error: String(text.suffix(Runnables.maxError)))
    }
}

enum IDsLower { static func new() -> String { UUID().uuidString.lowercased() } }

/// repo_runnables kept in memory, with the Store's semantics (tests, and a host without a database). The foreign key and
/// the check constraints are the Store's (db.cjs); `knownLibrary` stands in for the foreign key.
public final class MemoryRunnablesTable: RepoRunnablesTable, @unchecked Sendable {
    private let lock = NSLock()
    private var rows: [RunnableRow] = []
    public var knownLibrary: (@Sendable (String) -> Bool)?
    public init(knownLibrary: (@Sendable (String) -> Bool)? = nil) { self.knownLibrary = knownLibrary }

    public func list(libraryId: String) async throws -> [RunnableRow] {
        lock.lock(); defer { lock.unlock() }
        return rows.filter { $0.libraryId == libraryId }.sorted { ($0.folder, $0.name) < ($1.folder, $1.name) }
    }
    public func get(id: String) async throws -> RunnableRow? { lock.lock(); defer { lock.unlock() }; return rows.first { $0.id == id } }
    public func declare(id: String, libraryId: String, folder: String, name: String, type: String) async throws -> RunnableRow {
        if let known = knownLibrary, !known(libraryId) { throw BuildError("insert or update on table \"repo_runnables\" violates foreign key constraint", code: "23503") }
        lock.lock(); defer { lock.unlock() }
        if let i = rows.firstIndex(where: { $0.libraryId == libraryId && $0.folder == folder && $0.name == name }) {
            if rows[i].type != type { rows[i].status = "pending"; rows[i].installCommand = nil; rows[i].runCommand = nil }
            rows[i].type = type
            return rows[i]
        }
        let row = RunnableRow(id: id, libraryId: libraryId, folder: folder, name: name, type: type)
        rows.append(row)
        return row
    }
    public func verify(id: String, installCommand: String?, runCommand: String, commit: String?) async throws -> RunnableRow? {
        lock.lock(); defer { lock.unlock() }
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return nil }
        rows[i].status = "verified"; rows[i].installCommand = installCommand; rows[i].runCommand = runCommand
        rows[i].verifiedCommit = commit; rows[i].lastError = nil
        return rows[i]
    }
    public func fail(id: String, error: String) async throws -> RunnableRow? {
        lock.lock(); defer { lock.unlock() }
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return nil }
        rows[i].status = "failed"; rows[i].lastError = error
        return rows[i]
    }
    /// The rows of a library row that went (`on delete cascade`).
    public func removeLibrary(_ libraryId: String) { lock.lock(); rows.removeAll { $0.libraryId == libraryId }; lock.unlock() }
}
