import Foundation

// Whether a project's code directory can take a Build (src/main/tools/repository.cjs, 2026-09-23; design D17). Read from
// the .git folder itself, without running git, so it answers even while Git is missing or busy. Build starts from every
// case Bart listed: not a repository, no commit yet, a detached HEAD, a merge/rebase/cherry-pick/revert/bisect under way,
// a lock left by a crashed git, submodules, Git LFS, and the free space a worktree will need.

private let OPERATIONS: [(String, String)] = [
    ("rebase-merge", "rebase"), ("rebase-apply", "rebase"), ("MERGE_HEAD", "merge"),
    ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert"), ("BISECT_LOG", "bisect"),
]
private let SHA_RE = Rx(#"^[0-9a-f]{40}([0-9a-f]{24})?$"#)

private func exists(_ file: String) -> Bool { FileManager.default.fileExists(atPath: file) }
private func read(_ file: String) -> String? { try? String(contentsOfFile: file, encoding: .utf8) }
private func join(_ a: String, _ b: String) -> String { (a as NSString).appendingPathComponent(b) }
/// path.resolve(base, p): "." and ".." folded, nothing else touched (NSString's standardizingPath drops /private).
private func resolve(_ base: String, _ p: String) -> String { normalize(p.hasPrefix("/") ? p : "\(base)/\(p)") }

func normalize(_ path: String) -> String {
    var parts: [Substring] = []
    for part in path.split(separator: "/", omittingEmptySubsequences: true) {
        if part == "." { continue }
        if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
        parts.append(part)
    }
    return "/" + parts.joined(separator: "/")
}

public struct GitDir: Equatable, Sendable {
    public let gitDir: String
    public let commonDir: String
    public let top: String
}

/// The folder holding the repository's files for `dir`, and the working tree's top: walks up like git does.
public func findGitDir(_ dir: String) -> GitDir? {
    var at = normalize(dir.hasPrefix("/") ? dir : "\(FileManager.default.currentDirectoryPath)/\(dir)")
    while true {
        let dotGit = join(at, ".git")
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dotGit, isDirectory: &isDir) {
            if isDir.boolValue { return GitDir(gitDir: dotGit, commonDir: dotGit, top: at) }
            // A linked worktree or a submodule: ".git" is a file naming the real one.
            if let named = Rx(#"^gitdir:\s*(.+)$"#, [.anchorsMatchLines]).exec(read(dotGit) ?? ""), let target = named[1] {
                let gitDir = resolve(at, target.trimmingCharacters(in: .whitespacesAndNewlines))
                let common = read(join(gitDir, "commondir"))
                return GitDir(gitDir: gitDir, commonDir: common.map { resolve(gitDir, $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? gitDir, top: at)
            }
        }
        let up = (at as NSString).deletingLastPathComponent
        if up == at || up.isEmpty { return nil }
        at = up
    }
}

func refExists(_ commonDir: String, _ ref: String) -> Bool {
    if exists(join(commonDir, ref)) { return true }
    let packed = read(join(commonDir, "packed-refs")) ?? ""
    return packed.components(separatedBy: "\n").contains { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\r")).hasSuffix(" \(ref)") }
}

public struct RepositoryProblem: Equatable, Sendable {
    public let code: String
    public let message: String
}

public struct RepositoryState: Equatable, Sendable {
    public var repository: Bool
    public var top: String?
    public var branch: String?
    public var detached: Bool
    public var commits: Bool
    public var operation: String?
    public var locked: Bool
    public var submodules: Bool
    public var lfs: Bool
    public var freeBytes: Double?
    /// What stands in Build's way, in the order to fix them.
    public var problems: [RepositoryProblem]
}

public func inspectRepository(_ dir: String) -> RepositoryState {
    let found = findGitDir(dir)
    let free = freeBytes(dir)
    guard let found else {
        return RepositoryState(repository: false, top: nil, branch: nil, detached: false, commits: false, operation: nil, locked: false, submodules: false,
                               lfs: false, freeBytes: free, problems: [RepositoryProblem(code: "not-a-repository", message: "This folder has no history yet.")])
    }
    let head = (read(join(found.gitDir, "HEAD")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let symbolic = Rx(#"^ref:\s*(refs/\S+)$"#).exec(head)?[1] ?? nil
    let detached = symbolic == nil && SHA_RE.test(head)
    let branch = symbolic.map { $0.hasPrefix("refs/heads/") ? String($0.dropFirst("refs/heads/".count)) : $0 }
    let commits = detached || (symbolic.map { refExists(found.commonDir, $0) } ?? false)
    let operation = OPERATIONS.first { exists(join(found.gitDir, $0.0)) }?.1
    let locked = exists(join(found.gitDir, "index.lock"))
    let submodules = exists(join(found.top, ".gitmodules"))
    let attributes = read(join(found.top, ".gitattributes")) ?? ""
    let lfs = attributes.contains("filter=lfs") || exists(join(found.commonDir, "lfs"))
    var problems: [RepositoryProblem] = []
    if !commits { problems.append(RepositoryProblem(code: "no-commits", message: "Nothing has been saved in this folder’s history yet.")) }
    if detached { problems.append(RepositoryProblem(code: "detached", message: "The folder is not on a branch.")) }
    if let operation { problems.append(RepositoryProblem(code: "operation", message: "A \(operation) is not finished in this folder.")) }
    if locked { problems.append(RepositoryProblem(code: "locked", message: "Git left a lock file (.git/index.lock), usually after a crash.")) }
    return RepositoryState(repository: true, top: found.top, branch: branch, detached: detached, commits: commits, operation: operation, locked: locked,
                           submodules: submodules, lfs: lfs, freeBytes: free, problems: problems)
}
