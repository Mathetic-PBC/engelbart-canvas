import Foundation
import EngelbartCore

/// A Build's record as task.json holds it. Kept untyped, as the Electron record is (`{ ...held, ...change }` keeps every
/// field a newer version wrote), with typed reads below.
public typealias TaskRecord = [String: JSONValue]

extension Dictionary where Key == String, Value == JSONValue {
    func str(_ key: String) -> String? { self[key]?.string }
    func int(_ key: String) -> Int { self[key]?.int ?? 0 }
    func bool(_ key: String) -> Bool { self[key]?.bool ?? false }
    func arr(_ key: String) -> [JSONValue] { self[key]?.array ?? [] }
    func obj(_ key: String) -> [String: JSONValue]? { self[key]?.object }
    /// JS truthiness of a field (null, '', 0, false, missing → false).
    func truthy(_ key: String) -> Bool { self[key].map(isTruthy) ?? false }
    func merging(_ change: TaskRecord) -> TaskRecord { merging(change) { _, new in new } }
}

func isTruthy(_ v: JSONValue) -> Bool {
    switch v {
    case .null: return false
    case .bool(let b): return b
    case .number(let n): return n != 0 && !n.isNaN
    case .string(let s): return !s.isEmpty
    default: return true
    }
}

/// store.cjs: `<dataRoot>/<slug>/builds/<id>/task.json` and `context.md` (B4). Records outlive their worktrees.
public enum TaskStore {
    public static let kinds = ["build", "quick"]
    public static let statuses = ["setting-up", "queued", "running", "needs-you", "review", "stopped", "failed", "escalated",
                                  "interrupted", "accepting", "conflict", "accepted", "discarded"]
    public static let final: Set<String> = ["accepted", "discarded"]
    /// States a turn or git is at work in: at launch, a record left in one of these was cut off by the app closing (B19).
    public static let working: Set<String> = ["setting-up", "queued", "running", "accepting"]
    static let maxMessages = 200
    static let maxMessageChars = 40_000

    public static func isId(_ id: String) -> Bool { id.range(of: "^[0-9a-f]{10}$", options: .regularExpression) != nil }

    /// 10 lowercase hex characters (randomBytes(5)).
    public static func newId() -> String {
        var bytes = [UInt8](repeating: 0, count: 5)
        _ = SecRandomCopyBytes(kSecRandomDefault, 5, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    public static func buildsDir(_ project: BuildProject) -> String { NodePath.join(project.dir, "builds") }

    public static func taskDir(_ project: BuildProject, _ id: String) throws -> String {
        guard isId(id) else { throw BuildError("build id is invalid") }
        return NodePath.join(buildsDir(project), id)
    }

    public static func readTask(_ project: BuildProject, _ id: String) -> TaskRecord? {
        guard let dir = try? taskDir(project, id),
              let value = Files.readJSON(URL(fileURLWithPath: NodePath.join(dir, "task.json"))),
              let record = value.object, record.str("id") == id else { return nil }
        return record
    }

    /// The record written whole (atomically), stamped `updated`. → the record
    @discardableResult
    public static func writeTask(_ project: BuildProject, _ task: TaskRecord, now: Date = Date()) throws -> TaskRecord {
        let dir = try taskDir(project, task.str("id") ?? "")
        try FS.mkdirs(dir, mode: 0o700)
        var next = task
        let messages = task.arr("messages")
        next["messages"] = .array(Array(messages.suffix(maxMessages)))
        next["updated"] = .string(Time.iso(now))
        try Files.writeJSON(.object(next), to: URL(fileURLWithPath: NodePath.join(dir, "task.json")))
        return next
    }

    /// A fresh id: unused here and, when `taken(id)` says so, elsewhere (a branch of that name in the repository).
    public static func freeId(_ project: BuildProject, taken: (String) async -> Bool = { _ in false }) async throws -> String {
        for _ in 0..<20 {
            let id = newId()
            if !FS.exists(NodePath.join(buildsDir(project), id)), !(await taken(id)) { return id }
        }
        throw BuildError("No free Build id")
    }

    public static func listTasks(_ project: BuildProject) -> [TaskRecord] {
        let names = FS.list(buildsDir(project)) ?? []
        return names.filter(isId).compactMap { readTask(project, $0) }
            .sorted { ($0.str("created") ?? "undefined") < ($1.str("created") ?? "undefined") }
    }

    public static func writeContext(_ project: BuildProject, _ id: String, _ text: String) throws {
        let dir = try taskDir(project, id)
        try FS.mkdirs(dir, mode: 0o700)
        let file = NodePath.join(dir, "context.md")
        let temporary = "\(file).\(getpid()).tmp"
        try FS.write(temporary, text, mode: 0o600)
        try FS.rename(temporary, file)
    }

    public static func readContext(_ project: BuildProject, _ id: String) -> String? {
        guard let dir = try? taskDir(project, id) else { return nil }
        return FS.readText(NodePath.join(dir, "context.md"))
    }

    /// A message for the conversation: who said it, what, when (cut to a size a record can carry). `images`: a reply's
    /// pasted images ([{ n, id }], 2026-09-29), numbered across the Build.
    public static func message(_ role: String, _ text: String, at: Date = Date(), images: [JSONValue]? = nil) -> JSONValue {
        var m: [String: JSONValue] = ["role": .string(role), "text": .string(String(text.prefix(maxMessageChars))), "at": .string(Time.iso(at))]
        if let images, !images.isEmpty { m["images"] = .array(images) }
        return .object(m)
    }

    /// What the renderer is sent: the record less nothing it could not show, plus whether it is done with.
    public static func publicTask(_ task: TaskRecord?) -> JSONValue {
        guard let task else { return .null }
        func or(_ key: String) -> JSONValue { (task[key].map(isTruthy) ?? false) ? task[key]! : .null }
        let postIt: JSONValue = task[ "postIt"]?.string != nil ? task["postIt"]! : .null
        return .object([
            "id": task["id"] ?? .null,
            "kind": task["kind"] ?? .null,
            "projectId": task["projectId"] ?? .null,
            "workspaceId": or("workspaceId"),
            "postItId": or("postItId"),
            "title": task["title"] ?? .null,
            // what it was given to do (2026-10-13): a line's request, a post-it's text, the panel's; the card's Prompt row
            "postIt": postIt,
            "provider": task["provider"] ?? .null,
            "model": task["model"] ?? .null,
            "modelName": task["modelName"] ?? .null,
            "effort": task["effort"] ?? .null,
            "status": task["status"] ?? .null,
            "question": or("question"),
            "escalation": or("escalation"),
            "error": or("error"),
            "queued": or("queued"),
            "queuedImages": or("queuedImages"),
            "turn": .number(Double(task.int("turn"))),
            "target": or("target"), // { kind, id, name }; null for a record from before 2026-09-29
            "branch": task["branch"] ?? .null,
            "baseBranch": task["baseBranch"] ?? .null,
            "worktree": task["worktree"] ?? .null,
            "checkpoints": .number(Double(task.arr("checkpoints").count)),
            "messages": task["messages"] ?? .array([]),
            "checks": or("checks"),
            "conflict": or("conflict"),
            "accepted": or("accepted"),
            "landing": or("landing"), // Accept refused and sent to the agent by itself: { attempt } (2026-09-29)
            "version": or("version"), // a post-it added to a workspace: the archived version it was put in as
            "runStep": or("runStep"),
            "keptCopy": .bool(task.truthy("keptCopy")),
            "created": task["created"] ?? .null,
            "updated": task["updated"] ?? .null,
            "final": .bool(final.contains(task.str("status") ?? "")),
        ])
    }
}

/// An Error whose message is the sentence the person sees (Electron's `new Error(message)`), with an optional code.
public struct BuildError: Error, LocalizedError, CustomStringConvertible, Sendable {
    public var message: String
    public var code: String?
    public var files: [String] = []
    public var markers = false
    public var checks: JSONValue?
    public var stopped = false
    public init(_ message: String, code: String? = nil) { self.message = message; self.code = code }
    public var errorDescription: String? { message }
    public var description: String { message }
}

extension Error {
    /// The sentence an Error carries, as `error.message` is read in the Electron code.
    var text: String {
        if let b = self as? BuildError { return b.message }
        if let g = self as? GitError { return g.message }
        if let t = self as? TurnError { return t.message }
        return (self as NSError).localizedDescription
    }
}
