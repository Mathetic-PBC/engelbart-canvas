import Foundation
import EngelbartCore

// src/main/sandbox/runs.cjs: a GitHub repository's sandbox runs, one row per attempt, in the library database.

/// How a person uses a repository (local-tools.cjs's declare_kind).
public let sandboxKinds = ["interface", "terminal", "both"]

public struct GithubRepo: Equatable, Sendable {
    public var owner: String
    public var name: String
    public var url: String

    /// `githubRepo(value)`: `https://github.com/<owner>/<name>` (a trailing slash allowed), never `.` or `..`.
    public static func parse(_ value: String?) -> GithubRepo? {
        guard let value, let m = value.captures(#"^https://github\.com/([\w.-]+)/([\w.-]+)/?$"#, options: [.caseInsensitive]),
              let owner = m[1], let name = m[2], ![".", ".."].contains(owner), ![".", ".."].contains(name) else { return nil }
        return GithubRepo(owner: owner, name: name, url: "https://github.com/\(owner)/\(name)")
    }
}

/// A run, as the Electron code passes it around: the `sandbox_runs` row with its JSON columns decoded.
public typealias SandboxRun = JSONValue

public struct RunStore {
    public let db: SandboxDatabase
    public init(_ db: SandboxDatabase) { self.db = db }

    static let jsonColumns = ["build_log", "build_milestones", "env_report", "terminal"]

    /// A row with its JSON text columns parsed.
    static func decode(_ row: [String: JSONValue]) -> SandboxRun {
        var o = row
        o["rn"] = nil
        for key in jsonColumns {
            if let text = row[key]?.string { o[key] = (try? JSONValue.parse(text)) ?? .null }
        }
        if o["build_log"] == nil || o["build_log"]!.isNull { o["build_log"] = .array([]) }
        return .object(o)
    }

    public func get(_ id: String) throws -> SandboxRun? {
        try db.query("select * from sandbox_runs where id = ?", [.string(id)]).first.map(Self.decode)
    }

    public func active(_ libraryId: String) throws -> SandboxRun? {
        try db.query("select * from sandbox_runs where library_id = ? and status in ('starting', 'ready')", [.string(libraryId)]).first.map(Self.decode)
    }

    /// The newest run of each library item (`distinct on (library_id) … order by created_at desc, id desc`).
    public func latest() throws -> [SandboxRun] {
        try db.query("""
            select * from (select *, row_number() over (partition by library_id order by created_at desc, id desc) as rn
            from sandbox_runs) where rn = 1 order by library_id
            """, []).map(Self.decode)
    }

    public func latest(for libraryId: String) throws -> SandboxRun? {
        try db.query("select * from sandbox_runs where library_id = ? order by created_at desc, id desc limit 1", [.string(libraryId)]).first.map(Self.decode)
    }

    public func all(for libraryId: String) throws -> [SandboxRun] {
        try db.query("select * from sandbox_runs where library_id = ? order by created_at, id", [.string(libraryId)]).map(Self.decode)
    }

    /// The newest run's environment scan for this repository (its stored report, or a scan still in its log).
    public func environment(_ libraryId: String) throws -> JSONValue? {
        let rows = try db.query("select id, env_report, build_log from sandbox_runs where library_id = ? order by created_at desc, id desc", [.string(libraryId)])
        for row in rows.map(Self.decode) {
            let scanned = (row["env_report"].map { !$0.isNull } ?? false) || (row["build_log"]?.array ?? []).contains {
                $0["data"]?["phase"]?.string == "environment" && $0["data"]?["variables"]?.array != nil
            }
            if scanned { return EnvironmentReport.of(row) }
        }
        return nil
    }

    /// A new run, or nil when the repository already has an active one (the partial unique index).
    public func create(_ libraryId: String) throws -> SandboxRun? {
        let now = Time.iso()
        return try db.query("""
            insert into sandbox_runs (id, library_id, created_at, updated_at) values (?, ?, ?, ?) on conflict do nothing returning *
            """, [.string(IDs.new()), .string(libraryId), .string(now), .string(now)]).first.map(Self.decode)
    }

    /// Appends a log entry: the last 300 kept, `seq` one past the last, its milestone first/last kept apart from the
    /// rolling log, agent activity in a bounded tail, and an environment scan kept as the run's report.
    @discardableResult
    public func record(_ id: String, _ message: String, _ details: [String: JSONValue] = [:]) throws -> SandboxRun? {
        try db.transaction {
            guard let row = try get(id) else { return nil }
            let at = Time.iso()
            var entry = details
            entry["id"] = .string(IDs.new())
            entry["time"] = .string(at)
            entry["message"] = .string(message)
            let report = EnvironmentReport.make(details["data"], runId: id, at: at)
            let log = row["build_log"]?.array ?? []
            let seq = (log.last?["seq"].flatMap { $0.double ?? $0.string.flatMap(Double.init) } ?? 0) + 1
            entry["seq"] = .number(seq)
            let stored = JSONValue.object(entry)
            let key = BuildHistory.milestoneKey(stored)
            var nextLog = log + [stored]
            if nextLog.count > 300 { nextLog = Array(nextLog.suffix(300)) }
            var milestones = row["build_milestones"]?.object ?? [:]
            if let key {
                let first = milestones[key]?["first"] ?? stored
                milestones[key] = ["first": first, "last": stored]
            }
            if BuildHistory.isAgentActivity(stored) {
                let entries = (milestones["agent:activity"]?["entries"]?.array ?? []) + [stored]
                milestones["agent:activity"] = ["entries": .array(Array(entries.suffix(BuildHistory.agentLogLimit)))]
            }
            var sets = "build_log = ?, build_milestones = ?, updated_at = ?"
            var params: [JSONValue] = [.string(JSONValue.array(nextLog).text()), .string(JSONValue.object(milestones).text()), .string(at)]
            if let report { sets += ", env_report = ?"; params.append(.string(report.text())) }
            params.append(.string(id))
            return try db.query("update sandbox_runs set \(sets) where id = ? returning *", params).first.map(Self.decode)
        }
    }

    public func reopen(_ id: String, revision: String?) throws -> SandboxRun? {
        try db.query("""
            update sandbox_runs set status = 'starting', preview_url = null, error = null, finished_at = null, build_milestones = '{}',
            env_revision = ?, updated_at = ? where id = ? and status in ('ready', 'failed') returning *
            """, [revision.map { .string($0) } ?? .null, .string(Time.iso()), .string(id)]).first.map(Self.decode)
    }

    public func stoppedAfterFailure(_ id: String) throws -> SandboxRun? {
        let now = Time.iso()
        return try db.query("update sandbox_runs set status = 'stopped', finished_at = ?, updated_at = ? where id = ? and status = 'failed' returning *",
                            [.string(now), .string(now), .string(id)]).first.map(Self.decode)
    }

    static let updatable = ["sandbox_id", "status", "preview_url", "port", "error", "finished_at", "env_revision", "last_opened_at", "kind", "kind_reason", "terminal"]

    /// Changes allowed fields of an active (starting/ready) run; nil when it is no longer active.
    @discardableResult
    public func update(_ id: String, _ fields: [(String, JSONValue)]) throws -> SandboxRun? {
        if fields.isEmpty || fields.contains(where: { !Self.updatable.contains($0.0) }) { throw SandboxError("Invalid sandbox run update") }
        if let kind = fields.first(where: { $0.0 == "kind" })?.1, !kind.isNull, !sandboxKinds.contains(kind.string ?? "") {
            throw SandboxError("Invalid sandbox run kind")
        }
        let set = fields.map { "\($0.0) = ?" }.joined(separator: ", ")
        var params: [JSONValue] = fields.map { key, value in key == "terminal" && !value.isNull ? .string(value.text()) : value }
        params.append(.string(Time.iso()))
        params.append(.string(id))
        return try db.query("update sandbox_runs set \(set), updated_at = ? where id = ? and status in ('starting', 'ready') returning *", params).first.map(Self.decode)
    }

    public func deleteAll(_ libraryId: String) throws {
        _ = try db.query("delete from sandbox_runs where library_id = ?", [.string(libraryId)])
    }
}
