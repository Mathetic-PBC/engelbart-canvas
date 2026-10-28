import Foundation

/// Whether a folder can take a Build (tools/repository.cjs inspectRepository, D17; the Tools package owns the original).
/// Read from the .git folder itself, without running git, so it answers even while Git is missing or busy.
public struct RepositoryReport: Sendable, Equatable {
    public struct Problem: Sendable, Equatable {
        public var code: String
        public var message: String
        var json: [String: String] { ["code": code, "message": message] }
    }
    public var repository: Bool
    public var top: String?
    public var branch: String?
    public var detached: Bool
    public var commits: Bool
    public var operation: String?
    public var locked: Bool
    public var problems: [Problem]
}

public enum Repository {
    static let operations: [(String, String)] = [("rebase-merge", "rebase"), ("rebase-apply", "rebase"), ("MERGE_HEAD", "merge"),
                                                 ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert"), ("BISECT_LOG", "bisect")]

    /// The folder holding the repository's files for `dir`, and the working tree's top: walks up like git does.
    static func findGitDir(_ dir: String) -> (gitDir: String, commonDir: String, top: String)? {
        var at = NodePath.resolve(dir)
        while true {
            let dotGit = NodePath.join(at, ".git")
            if FS.isDirectory(dotGit) { return (dotGit, dotGit, at) }
            if FS.isFile(dotGit), let text = FS.readText(dotGit),
               let re = try? NSRegularExpression(pattern: #"^gitdir:\s*(.+)$"#, options: .anchorsMatchLines),
               let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let r = Range(m.range(at: 1), in: text) {
                let gitDir = NodePath.resolve(at, text[r].trimmingCharacters(in: .whitespaces))
                let common = FS.readText(NodePath.join(gitDir, "commondir"))
                return (gitDir, common.map { NodePath.resolve(gitDir, $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? gitDir, at)
            }
            let up = NodePath.dirname(at)
            if up == at { return nil }
            at = up
        }
    }

    static func refExists(_ commonDir: String, _ ref: String) -> Bool {
        if FS.exists(NodePath.join(commonDir, ref)) { return true }
        let packed = FS.readText(NodePath.join(commonDir, "packed-refs")) ?? ""
        return packed.components(separatedBy: .newlines).contains { $0.hasSuffix(" \(ref)") }
    }

    /// `problems`: what stands in Build's way, in the order to fix them.
    public static func inspect(_ dir: String) -> RepositoryReport {
        guard let found = findGitDir(dir) else {
            return RepositoryReport(repository: false, top: nil, branch: nil, detached: false, commits: false, operation: nil, locked: false,
                                    problems: [.init(code: "not-a-repository", message: "This folder has no history yet.")])
        }
        let head = (FS.readText(NodePath.join(found.gitDir, "HEAD")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var symbolic: String?
        if let r = head.range(of: #"^ref:\s*(refs/\S+)$"#, options: .regularExpression) {
            symbolic = String(head[r]).replacingOccurrences(of: #"^ref:\s*"#, with: "", options: .regularExpression)
        }
        let detached = symbolic == nil && head.range(of: "^[0-9a-f]{40}([0-9a-f]{24})?$", options: .regularExpression) != nil
        let branch = symbolic.map { $0.hasPrefix("refs/heads/") ? String($0.dropFirst("refs/heads/".count)) : $0 }
        let commits = detached || (symbolic.map { refExists(found.commonDir, $0) } ?? false)
        let operation = operations.first { FS.exists(NodePath.join(found.gitDir, $0.0)) }?.1
        let locked = FS.exists(NodePath.join(found.gitDir, "index.lock"))
        var problems: [RepositoryReport.Problem] = []
        if !commits { problems.append(.init(code: "no-commits", message: "Nothing has been saved in this folder’s history yet.")) }
        if detached { problems.append(.init(code: "detached", message: "The folder is not on a branch.")) }
        if let operation { problems.append(.init(code: "operation", message: "A \(operation) is not finished in this folder.")) }
        if locked { problems.append(.init(code: "locked", message: "Git left a lock file (.git/index.lock), usually after a crash.")) }
        return RepositoryReport(repository: true, top: found.top, branch: branch, detached: detached, commits: commits, operation: operation, locked: locked, problems: problems)
    }

    /// sandbox/runs.cjs githubRepo: `https://github.com/<owner>/<name>` → its parts and plain address.
    public static func github(_ value: String?) -> (owner: String, name: String, url: String)? {
        guard let value, let re = try? NSRegularExpression(pattern: #"^https://github\.com/([\w.-]+)/([\w.-]+)/?$"#, options: .caseInsensitive),
              let m = re.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              let o = Range(m.range(at: 1), in: value), let n = Range(m.range(at: 2), in: value) else { return nil }
        let owner = String(value[o]), name = String(value[n])
        if [".", ".."].contains(owner) || [".", ".."].contains(name) { return nil }
        return (owner, name, "https://github.com/\(owner)/\(name)")
    }

    /// store/home.cjs slugify.
    public static func slugify(_ value: String) -> String {
        let lower = value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let dashed = lower.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        let trimmed = dashed.replacingOccurrences(of: "^-+|-+$", with: "", options: .regularExpression)
        return String(trimmed.prefix(48))
    }

    /// store/home.cjs sanitizeName.
    public static func sanitizeName(_ name: String) -> String {
        var value = name.replacingOccurrences(of: "[\\x00-\\x1f\\x7f]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[/\\\\]", with: "-", options: .regularExpression)
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: #"^\.+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if value.count > 120 { value = String(value.prefix(120)).trimmingCharacters(in: .whitespaces) }
        return value.isEmpty ? "Untitled" : value
    }
}
