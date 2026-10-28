import Foundation
import EngelbartCore

/// git.cjs GitError: `code` is failed | conflict | overwrite | moved | missing.
public struct GitError: Error, LocalizedError, Sendable {
    public var message: String
    public var code: String
    public var files: [String]
    public var output: String
    public init(_ message: String, code: String = "failed", files: [String] = [], output: String = "") {
        self.message = message; self.code = code; self.files = files; self.output = output
    }
    public var errorDescription: String? { message }
}

public struct GitHead: Sendable, Equatable {
    public var sha: String
    /// nil when HEAD is detached.
    public var branch: String?
}

public struct GitIdentity: Sendable, Equatable {
    public var name: String
    public var email: String
    public var own: Bool
}

public struct DiffFile: Sendable, Equatable {
    public var path: String
    public var was: String?
    public var status: String
    public var adds: Int
    public var dels: Int
    public var binary: Bool
    var json: JSONValue {
        ["path": .string(path), "was": was.map(JSONValue.string) ?? .null, "status": .string(status),
         "adds": .number(Double(adds)), "dels": .number(Double(dels)), "binary": .bool(binary)]
    }
}

public struct GitDiff: Sendable, Equatable {
    public var files: [DiffFile]
    public var patch: String
    public var truncated: Bool
    var json: [String: JSONValue] {
        ["files": .array(files.map(\.json)), "patch": .string(patch), "truncated": .bool(truncated)]
    }
}

struct GitOut {
    var code: Int32
    var stdout: String
    var stderr: String
    var missing: Bool
}

/// Every git command a Build runs (git.cjs; design B5–B17). Nothing here is shown to the person as git: the manager turns
/// results into Build states. Engelbart's own commands run with hooks off, no prompts, no pager, English messages (a few
/// are read). Values reach git as arguments, never through a shell. `gitPath()` is the git the tool check found.
public final class BuildGit: @unchecked Sendable {
    public static let fallbackName = "Engelbart"
    public static let fallbackEmail = "build@engelbart.local"
    static let timeout: TimeInterval = 120
    static let long: TimeInterval = 600

    // A clone's credential helper for the GitHub sign-in: it answers `get` for https://github.com alone, from
    // ENGELBART_GITHUB_TOKEN, and ignores `store` and `erase`. An empty credential.helper first leaves the person's own
    // helpers out of that command. Config through GIT_CONFIG_COUNT keeps it off the command line.
    public static let githubHelper = #"!f() { test "$1" = get || exit 0; protocol=; host=; while IFS== read -r key value; do test -z "$key" && break; case "$key" in protocol) protocol=$value ;; host) host=$value ;; esac; done; test "$protocol" = https && test "$host" = github.com && test -n "$ENGELBART_GITHUB_TOKEN" || exit 0; printf 'username=x-access-token\npassword=%s\n' "$ENGELBART_GITHUB_TOKEN"; }; f"#
    public static func credentialEnv() -> [String: String] {
        ["GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "",
         "GIT_CONFIG_KEY_1": "credential.helper", "GIT_CONFIG_VALUE_1": githubHelper]
    }

    let gitPath: @Sendable () -> String
    let environment: [String: String]
    /// Test hook: sees each call's arguments and environment (build-git.test's spy).
    var observe: (@Sendable (_ args: [String], _ env: [String: String]) -> Void)?
    /// Test hook: replaces clone (build.test's `{ ...git, clone }` stubs).
    var cloneOverride: (@Sendable (_ url: String, _ dir: String, _ token: String?) async throws -> Void)?
    /// The same git with the same environment, for a stub.
    func copy() -> BuildGit { BuildGit(gitPath: gitPath, environment: environment) }

    public init(gitPath: @escaping @Sendable () -> String = { "git" }, environment: [String: String] = ShellEnvironment.environment()) {
        self.gitPath = gitPath
        self.environment = environment
    }

    func env() -> [String: String] {
        var base = environment.filter { !$0.key.hasPrefix("GIT_") } // an outer git's GIT_DIR / GIT_INDEX_FILE would redirect everything
        base["GIT_TERMINAL_PROMPT"] = "0"; base["GIT_EDITOR"] = "true"; base["GIT_SEQUENCE_EDITOR"] = "true"
        base["GIT_MERGE_AUTOEDIT"] = "no"; base["GIT_PAGER"] = "cat"; base["PAGER"] = "cat"; base["LC_MESSAGES"] = "C"; base["LANGUAGE"] = "en"
        return base
    }

    func executable() -> String? {
        let name = gitPath()
        return ShellEnvironment.resolve(name, environment: environment)?.path
    }

    /// → { code, stdout, stderr }; never throws. `extra`: environment for this one command.
    func exec(_ cwd: String, _ args: [String], timeout: TimeInterval = BuildGit.timeout, input: String? = nil, env extra: [String: String] = [:]) async -> GitOut {
        guard let git = executable() else { return GitOut(code: -1, stdout: "", stderr: "", missing: true) }
        var full = env()
        for (k, v) in extra { full[k] = v }
        let all = ["-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off", "-c", "advice.detachedHead=false"] + args
        observe?(all, full)
        let out = await Exec.run(git, all, environment: full, directory: cwd, input: input.map { Data($0.utf8) }, timeout: timeout)
        if out.notFound || out.spawnError != nil { return GitOut(code: -1, stdout: "", stderr: out.spawnError ?? "", missing: out.notFound) }
        return GitOut(code: out.code ?? -1, stdout: out.stdout, stderr: out.stderr, missing: false)
    }

    /// Public form for the manager's one-off reads (`git.exec`): nil when git could not run.
    public func run(_ cwd: String, _ args: [String]) async -> (code: Int32, stdout: String)? {
        let out = await exec(cwd, args)
        return out.missing ? nil : (out.code, out.stdout)
    }

    static func firstLine(_ text: String) -> String {
        text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    /// The same, throwing a GitError with git's first line when it fails.
    @discardableResult
    func must(_ cwd: String, _ args: [String], timeout: TimeInterval = BuildGit.timeout, input: String? = nil, env extra: [String: String] = [:]) async throws -> String {
        let out = await exec(cwd, args, timeout: timeout, input: input, env: extra)
        if out.missing { throw GitError("Git was not found.", code: "missing") }
        if out.code != 0 {
            let first = BuildGit.firstLine(out.stderr).isEmpty ? BuildGit.firstLine(out.stdout) : BuildGit.firstLine(out.stderr)
            throw GitError(first.isEmpty ? "git \(args.first ?? "") failed" : first, output: String((out.stdout + out.stderr).suffix(4000)))
        }
        return out.stdout
    }

    func trim(_ cwd: String, _ args: [String]) async throws -> String {
        try await must(cwd, args).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func top(_ dir: String) async throws -> String { try await trim(dir, ["rev-parse", "--show-toplevel"]) }

    public func head(_ dir: String) async throws -> GitHead {
        let sha = try await trim(dir, ["rev-parse", "HEAD"])
        let named = await exec(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        return GitHead(sha: sha, branch: named.code == 0 ? named.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
    }

    public func revParse(_ dir: String, _ ref: String) async throws -> String { try await trim(dir, ["rev-parse", "--verify", "\(ref)^{commit}"]) }

    /// What `git status` lists as changed or new (ignored files are not), as paths.
    public func dirtyPaths(_ dir: String) async throws -> [String] {
        let out = try await must(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        var paths: [String] = []
        let parts = out.components(separatedBy: "\0")
        var i = 0
        while i < parts.count {
            let entry = parts[i]
            if !entry.isEmpty {
                paths.append(String(entry.dropFirst(3)))
                if entry.hasPrefix("R") || entry.hasPrefix("C") { i += 1 } // a rename carries its old path next
            }
            i += 1
        }
        return paths
    }

    /// The person's own name and email when their git has them, else Engelbart's.
    public func identity(_ dir: String) async -> GitIdentity {
        let name = (await exec(dir, ["config", "user.name"])).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (await exec(dir, ["config", "user.email"])).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && !email.isEmpty ? GitIdentity(name: name, email: email, own: true)
            : GitIdentity(name: BuildGit.fallbackName, email: BuildGit.fallbackEmail, own: false)
    }

    func asWho(_ who: GitIdentity) -> [String] { ["-c", "user.name=\(who.name)", "-c", "user.email=\(who.email)"] }

    public func branchExists(_ repo: String, _ branch: String) async -> Bool {
        (await exec(repo, ["show-ref", "--verify", "--quiet", "refs/heads/\(branch)"])).code == 0
    }

    /// A new branch at `startSha`, checked out in `dir` (which must not exist yet); a branch left by an earlier try is reused.
    public func addWorktree(_ repo: String, _ dir: String, _ branch: String, _ startSha: String) async throws {
        try FS.mkdirs(NodePath.dirname(dir), mode: 0o700)
        _ = await exec(repo, ["worktree", "prune"])
        let args = await branchExists(repo, branch) ? ["worktree", "add", "--quiet", dir, branch] : ["worktree", "add", "--quiet", "-b", branch, dir, startSha]
        try await must(repo, args, timeout: BuildGit.long)
    }

    /// The folder and git's record of it go; a folder already gone is only pruned.
    public func removeWorktree(_ repo: String, _ dir: String) async {
        if FS.exists(dir) {
            let out = await exec(repo, ["worktree", "remove", "--force", "--force", dir], timeout: BuildGit.long)
            if out.code != 0 && FS.exists(dir) { FS.remove(dir) }
        }
        _ = await exec(repo, ["worktree", "prune"])
    }

    /// A worktree moved to `to` (which must not exist yet): its project came back from the trash under another folder name.
    public func moveWorktree(_ repo: String, _ from: String, _ to: String) async throws {
        try FS.mkdirs(NodePath.dirname(to), mode: 0o700)
        try await must(repo, ["worktree", "move", from, to], timeout: BuildGit.long)
    }

    @discardableResult
    public func deleteBranch(_ repo: String, _ branch: String) async -> Bool {
        (await exec(repo, ["branch", "-D", branch])).code == 0
    }

    func gitDir(_ dir: String) async -> String { (await exec(dir, ["rev-parse", "--git-dir"])).stdout.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// A merge started by mergeInto and not yet concluded.
    public func merging(_ dir: String) async -> Bool {
        let g = await gitDir(dir)
        return !g.isEmpty && FS.exists(NodePath.resolve(dir, g, "MERGE_HEAD"))
    }

    @discardableResult
    public func abortMerge(_ dir: String) async -> Bool { (await exec(dir, ["merge", "--abort"])).code == 0 }

    /// Everything in the worktree as it stands, committed. → the new commit, or nil when nothing changed.
    public func checkpoint(_ dir: String, _ message: String, _ who: GitIdentity) async throws -> String? {
        try await must(dir, ["add", "-A"])
        if (await exec(dir, ["diff", "--cached", "--quiet"])).code == 0 { return nil }
        try await must(dir, asWho(who) + ["commit", "--quiet", "--no-verify", "-m", message])
        return try await trim(dir, ["rev-parse", "HEAD"])
    }

    /// What changed since `from`: the files with their counts, and the patch.
    public func diff(_ dir: String, _ from: String, _ to: String = "HEAD", maxPatch: Int = 2_000_000, env extra: [String: String] = [:]) async throws -> GitDiff {
        let names = try await must(dir, ["diff", "--name-status", "-z", "--find-renames", from, to], env: extra)
        let numbers = try await must(dir, ["diff", "--numstat", "-z", "--find-renames", from, to], env: extra)
        var counts: [String: (Int, Int, Bool)] = [:]
        let numParts = numbers.components(separatedBy: "\0")
        var i = 0
        while i < numParts.count {
            let entry = numParts[i]
            if !entry.isEmpty {
                let fields = entry.components(separatedBy: "\t")
                if fields.count >= 3 {
                    var file = fields[2...].joined(separator: "\t")
                    if file.isEmpty && i + 2 < numParts.count { file = numParts[i + 2]; i += 2 } // a rename: "adds\tdels\t" then old, new
                    let bin = fields[0] == "-"
                    counts[file] = (bin ? 0 : Int(fields[0]) ?? 0, fields[1] == "-" ? 0 : Int(fields[1]) ?? 0, bin)
                }
            }
            i += 1
        }
        var files: [DiffFile] = []
        let parts = names.components(separatedBy: "\0")
        i = 0
        while i < parts.count {
            let status = parts[i]
            if status.isEmpty { i += 1; continue }
            var file = i + 1 < parts.count ? parts[i + 1] : ""
            var was: String?
            if status.hasPrefix("R") || status.hasPrefix("C") {
                was = file; file = i + 2 < parts.count ? parts[i + 2] : ""; i += 3
            } else { i += 2 }
            let c = counts[file] ?? (0, 0, false)
            files.append(DiffFile(path: file, was: was, status: String(status.prefix(1)), adds: c.0, dels: c.1, binary: c.2))
        }
        let patch = try await must(dir, ["diff", "--find-renames", "--no-color", "--no-ext-diff", from, to], env: extra)
        // `patch.length > maxPatch` counts UTF-16 units, as JavaScript does.
        let units = patch.utf16
        let cut = units.count > maxPatch
        return GitDiff(files: files, patch: cut ? String(decoding: Array(units.prefix(maxPatch)), as: UTF16.self) : patch, truncated: cut)
    }

    /// What changed since `from` as the worktree stands now, new files too, with nothing committed (2026-09-29: the card's
    /// diff while the agent works). The files go into a copy of the worktree's index, never the index itself.
    public func workingDiff(_ dir: String, _ from: String, maxPatch: Int = 2_000_000) async throws -> GitDiff {
        let gd = NodePath.resolve(dir, try await trim(dir, ["rev-parse", "--git-dir"]))
        let index = NodePath.join(gd, "engelbart-live-\(getpid())-\(UUID().uuidString.prefix(8).lowercased()).index")
        let own = ["GIT_INDEX_FILE": index]
        defer { FS.unlink(index) }
        if (try? FileManager.default.copyItem(atPath: NodePath.join(gd, "index"), toPath: index)) == nil {
            try await must(dir, ["read-tree", "HEAD"], env: own)
        }
        try await must(dir, ["add", "-A"], env: own)
        let tree = try await must(dir, ["write-tree"], env: own).trimmingCharacters(in: .whitespacesAndNewlines)
        return try await diff(dir, from, tree, maxPatch: maxPatch)
    }

    public func mergeBase(_ dir: String, _ a: String, _ b: String) async throws -> String { try await trim(dir, ["merge-base", a, b]) }
    public func isAncestor(_ dir: String, _ a: String, _ b: String) async -> Bool { (await exec(dir, ["merge-base", "--is-ancestor", a, b])).code == 0 }
    public func conflicted(_ dir: String) async -> [String] {
        (await exec(dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Accept's first half, on a detached HEAD in the Build's worktree (its branch is untouched): everything since `base`
    /// as one commit, then that commit replayed onto `onto`. → the commit (nil: nothing to land). A conflict undoes the
    /// replay and throws with the files; the worktree goes back to its branch either way.
    public func squashOnto(_ dir: String, branch: String, base: String, onto: String, message: String, who: GitIdentity) async throws -> String? {
        try await must(dir, ["checkout", "--quiet", "--detach"])
        do {
            try await must(dir, ["reset", "--quiet", "--soft", base])
            if (await exec(dir, ["diff", "--cached", "--quiet"])).code == 0 { return nil }
            try await must(dir, asWho(who) + ["commit", "--quiet", "--no-verify", "-F", "-"], input: message)
            if base != onto {
                let replay = await exec(dir, asWho(who) + ["rebase", "--quiet", onto], timeout: BuildGit.long)
                if replay.code != 0 {
                    let files = await conflicted(dir)
                    _ = await exec(dir, ["rebase", "--abort"])
                    let first = BuildGit.firstLine(replay.stderr)
                    throw GitError(files.isEmpty ? (first.isEmpty ? "The Build could not be replayed onto your branch." : first) : "Your branch changed the same lines in \(files.joined(separator: ", ")).",
                                   code: files.isEmpty ? "failed" : "conflict", files: files, output: String((replay.stdout + replay.stderr).suffix(4000)))
                }
            }
            return try await trim(dir, ["rev-parse", "HEAD"])
        } catch {
            _ = await exec(dir, ["checkout", "--quiet", "--force", branch])
            throw error
        }
    }

    /// Back on the Build's branch (after Accept's checks, or a failure).
    public func checkoutBranch(_ dir: String, _ branch: String) async throws {
        try await must(dir, ["checkout", "--quiet", "--force", branch])
    }

    static func listed(_ pattern: String, in text: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let r = Range(m.range(at: 1), in: text) else { return nil }
        return text[r].components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// The person's branch moves to `sha`, their files with it: only by fast-forward, only while their folder is still on
    /// `branch` at `expected`. Their uncommitted edits to files the Build changed make git refuse; those files are named.
    /// Swift (memory note accept-blocked-by-dirty-file): before refusing for edited files, the staging trick is tried
    /// (stageBuildPatch); it only ever lands when the Build's change applies cleanly on top of their edits.
    public func fastForward(_ repo: String, branch: String, expected: String, sha: String) async throws {
        let now = try await head(repo)
        if now.branch != branch || now.sha != expected { throw GitError("Your folder moved while this was being accepted.", code: "moved") }
        let out = await exec(repo, ["merge", "--ff-only", "--quiet", sha], timeout: BuildGit.long)
        if out.code == 0 { return }
        let text = out.stdout + out.stderr
        let tailOut = String(text.suffix(4000))
        if let untracked = BuildGit.listed(#"untracked working tree files would be (?:overwritten|removed) by merge:\n([\s\S]*?)\n(?:Please|Aborting)"#, in: text) {
            throw GitError("Files the Build adds already exist, uncommitted, in your folder: \(untracked.joined(separator: ", ")). Move them, then Accept again.", code: "overwrite", files: untracked, output: tailOut)
        }
        if let edited = BuildGit.listed(#"local changes to the following files would be overwritten by merge:\n([\s\S]*?)\n(?:Please|Aborting)"#, in: text) {
            if await stageBuildPatch(repo, files: edited, from: expected, to: sha) { return }
            throw GitError("You have uncommitted edits to \(edited.joined(separator: ", ")). Commit or discard them, then Accept again.", code: "overwrite", files: edited, output: tailOut)
        }
        let first = BuildGit.firstLine(out.stderr)
        throw GitError(first.isEmpty ? "Your branch could not be moved forward." : first, output: tailOut)
    }

    /// The dirty-file staging trick (memory note, 2026-09-29): for each file git named, whose index still equals HEAD,
    /// the Build's change (`from`..`to`) is applied to the index and to the person's file on top of their edits; a
    /// two-way merge then keeps the index entry that already equals the target, so the fast-forward goes through and
    /// their edits stay, unstaged. Any file whose index differs, or whose patch does not apply cleanly to both: nothing
    /// is done. A fast-forward that still fails puts their files and index back exactly. → whether it landed
    func stageBuildPatch(_ repo: String, files: [String], from: String, to: String) async -> Bool {
        var saved: [(String, Data?)] = []
        var patches: [String] = []
        for file in files {
            if (await exec(repo, ["diff", "--cached", "--quiet", "--", file])).code != 0 { return false } // something staged: theirs
            let patch = await exec(repo, ["diff", "--binary", "--full-index", from, to, "--", file])
            guard patch.code == 0, !patch.stdout.isEmpty else { return false }
            if (await exec(repo, ["apply", "--cached", "--check", "-"], input: patch.stdout)).code != 0 { return false }
            if (await exec(repo, ["apply", "--check", "-"], input: patch.stdout)).code != 0 { return false }
            patches.append(patch.stdout)
            let full = NodePath.join(repo, file)
            saved.append((full, FileManager.default.contents(atPath: full)))
        }
        let restore: () async -> Void = {
            for (full, data) in saved { if let data { try? data.write(to: URL(fileURLWithPath: full)) } }
            _ = await self.exec(repo, ["reset", "-q", "--"] + files)
        }
        for patch in patches {
            if (await exec(repo, ["apply", "--cached", "-"], input: patch)).code != 0 { await restore(); return false }
            if (await exec(repo, ["apply", "-"], input: patch)).code != 0 { await restore(); return false }
        }
        let again = await exec(repo, ["merge", "--ff-only", "--quiet", to], timeout: BuildGit.long)
        if again.code == 0 { return true }
        await restore()
        return false
    }

    /// The person's branch brought into the Build's, conflicts left in the files for the agent. → conflicted files
    public func mergeInto(_ dir: String, _ ref: String, _ who: GitIdentity) async throws -> [String] {
        let out = await exec(dir, asWho(who) + ["merge", "--no-ff", "--no-edit", "--quiet", ref], timeout: BuildGit.long)
        if out.code == 0 { return [] }
        let files = await conflicted(dir)
        if files.isEmpty {
            let first = BuildGit.firstLine(out.stderr)
            throw GitError(first.isEmpty ? "Your branch could not be merged in." : first, output: String((out.stdout + out.stderr).suffix(4000)))
        }
        return files
    }

    /// Finishes a merge the agent resolved (or any merge in progress): everything added and committed.
    @discardableResult
    public func concludeMerge(_ dir: String, _ message: String, _ who: GitIdentity) async throws -> String? {
        let gd = try await trim(dir, ["rev-parse", "--git-dir"])
        let isMerging = FS.exists(NodePath.resolve(dir, gd, "MERGE_HEAD"))
        try await must(dir, ["add", "-A"])
        if isMerging {
            try await must(dir, asWho(who) + ["commit", "--quiet", "--no-verify", "-m", message])
            return try await trim(dir, ["rev-parse", "HEAD"])
        }
        return try await checkpoint(dir, message, who)
    }

    /// HEAD's tree with the changes of `shas` (a Build's run steps) taken back out, newest first, in a scratch index.
    /// → the tree, or nil when a later commit changed the same lines and they cannot be taken out.
    public func treeWithout(_ dir: String, _ shas: [String]) async throws -> String? {
        let index = NodePath.join(NSTemporaryDirectory(), "engelbart-index-\(getpid())-\(TaskStore.newId())")
        let scratch = ["GIT_INDEX_FILE": index]
        defer { FS.unlink(index) }
        try await must(dir, ["read-tree", "HEAD"], env: scratch)
        for sha in shas.reversed() {
            let patch = try await must(dir, ["diff", "--binary", "--full-index", "\(sha)^", sha])
            if patch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            let out = await exec(dir, ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], input: patch, env: scratch)
            if out.code != 0 { return nil }
        }
        return try await must(dir, ["write-tree"], env: scratch).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A folder with no history gets one: git init, a .gitignore when there is none, everything in a first commit.
    /// `own`: `dir` gets a repository of its own even inside another one (the default repo, never a parent's commit).
    @discardableResult
    public func initRepository(_ dir: String, own: Bool = false) async throws -> GitHead {
        let insideCode: Int32 = own ? (FS.exists(NodePath.join(dir, ".git")) ? 0 : 1) : (await exec(dir, ["rev-parse", "--is-inside-work-tree"])).code
        if insideCode != 0 { try await must(dir, ["init", "--quiet"]) }
        let ignore = NodePath.join(dir, ".gitignore")
        if !FS.exists(ignore) { try FS.write(ignore, "node_modules/\n.env\n.env.*\n.DS_Store\n") }
        let who = await identity(dir)
        try await must(dir, ["add", "-A"], timeout: BuildGit.long)
        try await must(dir, asWho(who) + ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", "First snapshot (Engelbart)"], timeout: BuildGit.long)
        return try await head(dir)
    }

    /// `url` cloned into `dir` (which must not exist yet), never with a prompt. With `token` (the GitHub sign-in), its
    /// helper answers GitHub alone; the token is in that command's environment only, never kept.
    public func clone(_ url: String, _ dir: String, token: String? = nil) async throws {
        if let cloneOverride { try await cloneOverride(url, dir, token); return }
        try FS.mkdirs(NodePath.dirname(dir))
        var extra: [String: String] = [:]
        if let token { extra = BuildGit.credentialEnv(); extra["ENGELBART_GITHUB_TOKEN"] = token }
        try await must(NodePath.dirname(dir), ["clone", "--quiet", "--", url, dir], timeout: BuildGit.long, env: extra)
    }

    public func message(_ dir: String, _ sha: String = "HEAD") async throws -> String { try await trim(dir, ["log", "-1", "--format=%B", sha]) }

    /// The worktree back on `branch` at `sha`, where its turn started, when the agent moved it (2026-10-07). The files stay
    /// as they are, for the turn's checkpoint. A merge the turn was given to conclude and did is kept. → { branch, commits }
    public func holdBranch(_ dir: String, _ branch: String, _ sha: String, merging wasMerging: Bool = false) async throws -> (branch: Bool, commits: Bool) {
        let ref = "refs/heads/\(branch)"
        let at = await exec(dir, ["symbolic-ref", "--quiet", "HEAD"])
        let moved = at.code != 0 || at.stdout.trimmingCharacters(in: .whitespacesAndNewlines) != ref
        let tip = (await exec(dir, ["rev-parse", "--verify", "--quiet", "\(ref)^{commit}"])).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        var commits = tip != sha
        if commits && wasMerging && !tip.isEmpty && !moved {
            commits = (await exec(dir, ["rev-parse", "--verify", "--quiet", "\(tip)^1"])).stdout.trimmingCharacters(in: .whitespacesAndNewlines) != sha
        }
        if commits { try await must(dir, ["update-ref", "-m", "Engelbart: where the turn started", ref, sha]) }
        if moved { try await must(dir, ["symbolic-ref", "-m", "Engelbart: back on the Build's branch", "HEAD", ref]) }
        return (moved, commits)
    }

    /// Files whose added lines still hold a conflict marker between two commits (a merge left half resolved).
    public func markers(_ dir: String, _ from: String, _ to: String) async throws -> [String] {
        let out = try await must(dir, ["diff", "--no-color", "--no-ext-diff", "-U0", from, to])
        var files: [String] = []
        var file: String?
        let marker = try! NSRegularExpression(pattern: #"^\+(<{7}|>{7})( |$)"#)
        for line in out.components(separatedBy: "\n") {
            if line.hasPrefix("+++ ") {
                var name = String(line.dropFirst(4))
                if name.hasPrefix("b/") { name.removeFirst(2) }
                file = name
                continue
            }
            if let f = file, marker.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil, !files.contains(f) { files.append(f) }
        }
        return files
    }
}
