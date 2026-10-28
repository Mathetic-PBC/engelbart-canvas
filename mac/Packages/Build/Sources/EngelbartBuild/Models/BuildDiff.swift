import Foundation
import EngelbartCore

/// A Build's diff as its card shows it (renderer/model/build-diff.js, 2026-09-29: the diff streams into the card). Main
/// sends `{ files, patch, truncated }` (BuildGit.diff); the card draws rows: a header per file, then its hunks' lines.
public enum BuildDiffRows {
    public struct Row: Equatable, Sendable {
        /// file | hunk | add | del | ctx | note
        public var kind: String
        public var text: String = ""
        public var path: String = ""
        public var was: String?
        public var adds = 0
        public var dels = 0
        public var binary = false
    }

    static let skip = try! NSRegularExpression(pattern: "^(index |--- |\\+\\+\\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (from|to) |copy (from|to) )")
    static let fileHead = try! NSRegularExpression(pattern: "^diff --git a/(.*) b/(.*)$")

    /// → { files, adds, dels } over every file of the diff.
    public static func totals(_ files: [JSONValue]) -> (files: Int, adds: Int, dels: Int) {
        (files.count, files.reduce(0) { $0 + ($1["adds"]?.int ?? 0) }, files.reduce(0) { $0 + ($1["dels"]?.int ?? 0) })
    }

    static func fileRow(_ f: JSONValue, path: String) -> Row {
        Row(kind: "file", path: f["path"]?.string ?? path, was: f["was"]?.string, adds: f["adds"]?.int ?? 0, dels: f["dels"]?.int ?? 0, binary: f["binary"]?.bool ?? false)
    }

    /// The rows to draw. At most `maxLines` lines of code are kept; `cut` is how many were left out.
    public static func rows(_ diff: JSONValue?, maxLines: Int = 2500) -> (rows: [Row], cut: Int, truncated: Bool) {
        let fileList = diff?["files"]?.array ?? []
        var files: [String: JSONValue] = [:]
        for f in fileList { if let p = f["path"]?.string { files[p] = f } }
        var rows: [Row] = []
        var lines = 0, cut = 0, inHunk = false
        for line in (diff?["patch"]?.string ?? "").components(separatedBy: "\n") {
            if let m = fileHead.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) {
                let a = String(line[Range(m.range(at: 1), in: line)!]), b = String(line[Range(m.range(at: 2), in: line)!])
                let f = files[b] ?? files[a] ?? ["path": .string(b)]
                rows.append(fileRow(f, path: b))
                inHunk = false
                continue
            }
            if rows.isEmpty { continue }
            if !inHunk {
                if line.hasPrefix("@@") { inHunk = true }
                else if line.hasPrefix("Binary files") { rows.append(Row(kind: "note", text: "Binary file")); continue }
                else if line.isEmpty || skip.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil { continue }
            }
            if lines >= maxLines { cut += 1; continue }
            lines += 1
            if line.hasPrefix("@@") { rows.append(Row(kind: "hunk", text: line)) }
            else if line.hasPrefix("+") { rows.append(Row(kind: "add", text: line)) }
            else if line.hasPrefix("-") { rows.append(Row(kind: "del", text: line)) }
            else if line.hasPrefix("\\") { rows.append(Row(kind: "note", text: String(line.dropFirst(2)))) }
            else if !line.isEmpty { rows.append(Row(kind: "ctx", text: line)) }
        }
        // a file the patch did not reach (it was cut short) still gets its header
        let shown = Set(rows.filter { $0.kind == "file" }.map(\.path))
        for f in fileList where !shown.contains(f["path"]?.string ?? "") { rows.append(fileRow(f, path: f["path"]?.string ?? "")) }
        return (rows, cut, diff?["truncated"]?.bool ?? false)
    }

    /// The next [Attachment n] of a Build: after every image its replies have sent and the draft holds.
    public static func nextAttachment(_ messages: [JSONValue], _ draft: [Int]) -> Int {
        var n = 0
        for m in messages { for image in m["images"]?.array ?? [] { n = max(n, image["n"]?.int ?? 0) } }
        for d in draft { n = max(n, d) }
        return n + 1
    }
}

/// Where a workspace's Builds work (renderer/model/build-target.js, 2026-09-29): the repository last picked in the Build
/// panel, remembered per workspace (a pick saved before that, per project, counts until the workspace has its own); the
/// project's default repo until one is picked, and again when the one picked is gone. A post-it's Build has no picker.
public enum BuildTarget {
    public static let defaultTarget: JSONValue = ["kind": "default"]

    /// What the window's localStorage was: the app passes UserDefaults or a test store. Failures change nothing.
    public protocol Storage { func get(_ key: String) -> String?; func set(_ key: String, _ value: String) }

    static func storageKey(_ projectId: String, _ workspaceId: String?) -> String { "engelbart:build-target:\(projectId):\(workspaceId ?? "")" }
    static func projectKey(_ projectId: String) -> String { "engelbart:build-target:\(projectId)" } // before 2026-09-29

    static func clean(_ value: JSONValue?) -> JSONValue {
        guard let v = value?.object else { return defaultTarget }
        if v["kind"]?.string == "library", let id = v["id"]?.string, !id.isEmpty { return ["kind": "library", "id": .string(id)] }
        if v["kind"]?.string == "project" { return ["kind": "project"] }
        return defaultTarget
    }

    public static func key(_ target: JSONValue) -> String { target["kind"]?.string == "library" ? "library:\(target["id"]?.string ?? "")" : target["kind"]?.string ?? "default" }
    public static func same(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        guard let a, let b, !a.isNull, !b.isNull else { return false }
        return key(clean(a)) == key(clean(b))
    }

    /// The workspace's remembered target (else the project's) when `targets` still holds it, else the default repo.
    public static func picked(_ projectId: String, _ workspaceId: String?, _ targets: [JSONValue], storage: Storage?) -> JSONValue {
        let text = storage?.get(storageKey(projectId, workspaceId)) ?? storage?.get(projectKey(projectId))
        let wanted = clean(text.flatMap { try? JSONValue.parse($0) })
        return targets.contains { same($0, wanted) } ? wanted : defaultTarget
    }

    public static func remember(_ projectId: String, _ workspaceId: String?, _ target: JSONValue, storage: Storage?) {
        storage?.set(storageKey(projectId, workspaceId), clean(target).text())
    }

    /// A picker row's small label: what kind of repository it is. `sandboxed`: a sandbox preview exists for the row.
    public static func tag(_ item: JSONValue, sandboxed: Bool = false) -> String {
        switch item["kind"]?.string {
        case "default": return "default"
        case "project": return "project"
        default: return sandboxed ? "sandbox" : item["place"]?.string == "github" ? "github" : "local"
        }
    }

    /// UserDefaults as the window's storage.
    public struct Defaults: Storage {
        let defaults: UserDefaults
        public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }
        public func get(_ key: String) -> String? { defaults.string(forKey: key) }
        public func set(_ key: String, _ value: String) { defaults.set(value, forKey: key) }
    }
}
