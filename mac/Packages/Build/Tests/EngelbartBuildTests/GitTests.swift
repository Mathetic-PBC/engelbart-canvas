import XCTest
import EngelbartCore
@testable import EngelbartBuild

/// build-git.test.cjs: Build's git layer against real repositories in a temp folder. The global git config is hidden
/// (HOME is a temp folder), so the identity fallback is what a machine without a git name would get.
final class GitTests: XCTestCase {
    var root = ""
    var home = ""
    var git: BuildGit!
    var n = 0

    override func setUp() {
        root = NodePath.real(FileManager.default.temporaryDirectory.path) + "/engelbart-build-git-" + UUID().uuidString.prefix(8)
        home = root + "/home"
        try! FS.mkdirs(home)
        git = BuildGit(environment: Sh.env(home))
    }
    override func tearDown() { FS.remove(root) }

    func repo() -> String {
        n += 1
        let dir = "\(root)/repo\(n)"
        try! FS.mkdirs(dir)
        Sh.git(dir, home, "init", "-q", "-b", "main")
        Sh.write("\(dir)/a.txt", "one\ntwo\nthree\n")
        Sh.write("\(dir)/b.txt", "bee\n")
        Sh.git(dir, home, "add", "-A")
        Sh.git(dir, home, "commit", "-qm", "init")
        return dir
    }

    func build(_ dir: String, _ id: String? = nil) async throws -> (worktree: String, branch: String, base: String) {
        let start = try await git.head(dir)
        let id = id ?? "t\(n)"
        let worktree = "\(root)/worktrees/\(NodePath.basename(dir))-\(id)"
        try await git.addWorktree(dir, worktree, "engelbart/\(id)", start.sha)
        return (worktree, "engelbart/\(id)", start.sha)
    }

    func testHeadDirtyPathsAndIdentityFallback() async throws {
        let dir = repo()
        let at = try await git.head(dir)
        XCTAssertEqual(at.branch, "main")
        XCTAssertNotNil(at.sha.range(of: "^[0-9a-f]{40}$", options: .regularExpression))
        Sh.write("\(dir)/a.txt", "changed\n")
        Sh.write("\(dir)/new dir/c.txt", "new\n")
        let dirty = try await git.dirtyPaths(dir)
        XCTAssertEqual(dirty.sorted(), ["a.txt", "new dir/c.txt"])
        let who = await git.identity(dir)
        XCTAssertEqual(who, GitIdentity(name: "Engelbart", email: "build@engelbart.local", own: false))
        Sh.git(dir, home, "config", "user.name", "Hudson")
        Sh.git(dir, home, "config", "user.email", "h@example.com")
        let mine = await git.identity(dir)
        XCTAssertEqual(mine, GitIdentity(name: "Hudson", email: "h@example.com", own: true))
    }

    func testWorktreeCheckpointsDiffAndPersonUntouched() async throws {
        let dir = repo()
        Sh.write("\(dir)/b.txt", "the person is mid-edit\n")
        let b = try await build(dir)
        XCTAssertEqual(Sh.read("\(b.worktree)/b.txt"), "bee\n", "the build starts from the last commit")
        let who = await git.identity(b.worktree)
        let none = try await git.checkpoint(b.worktree, "nothing", who)
        XCTAssertNil(none, "no change, no commit")
        Sh.write("\(b.worktree)/a.txt", "one\nTWO\nthree\n")
        Sh.write("\(b.worktree)/docs/new.md", "# new\n")
        let first = try await git.checkpoint(b.worktree, "Build t: turn 1", who)
        XCTAssertNotNil(first)
        try FileManager.default.moveItem(atPath: "\(b.worktree)/b.txt", toPath: "\(b.worktree)/bee.txt")
        _ = try await git.checkpoint(b.worktree, "Build t: turn 2", who)
        let d = try await git.diff(b.worktree, b.base)
        XCTAssertEqual(d.files.map { "\($0.status) \($0.path)\($0.was.map { " < \($0)" } ?? "")" }.sorted(), ["A docs/new.md", "M a.txt", "R bee.txt < b.txt"])
        XCTAssertEqual(d.files.first { $0.path == "a.txt" }?.adds, 1)
        XCTAssertTrue(d.patch.contains("-two\n+TWO"))
        XCTAssertEqual(Sh.read("\(dir)/b.txt"), "the person is mid-edit\n")
        let head = try await git.head(dir)
        XCTAssertEqual(head.branch, "main")
    }

    func testAcceptOneCommitReplayedThenFastForward() async throws {
        let dir = repo()
        let b = try await build(dir)
        let who = await git.identity(b.worktree)
        Sh.write("\(b.worktree)/a.txt", "one\nTWO\nthree\n")
        _ = try await git.checkpoint(b.worktree, "turn 1", who)
        Sh.write("\(b.worktree)/c.txt", "see\n")
        _ = try await git.checkpoint(b.worktree, "turn 2", who)
        Sh.write("\(dir)/b.txt", "bee and more\n")
        Sh.git(dir, home, "commit", "-qam", "theirs")
        Sh.write("\(dir)/notes.txt", "scratch\n")
        let target = try await git.head(dir)
        let base = try await git.mergeBase(b.worktree, b.branch, target.sha)
        let sha = try await git.squashOnto(b.worktree, branch: b.branch, base: base, onto: target.sha, message: "Build title\n\nWhat the agent said.", who: who)
        try await git.fastForward(dir, branch: "main", expected: target.sha, sha: sha!)
        XCTAssertEqual(Sh.git(dir, home, "log", "--format=%s", "-3").components(separatedBy: "\n"), ["Build title", "theirs", "init"])
        XCTAssertEqual(Sh.read("\(dir)/a.txt"), "one\nTWO\nthree\n")
        XCTAssertEqual(Sh.read("\(dir)/c.txt"), "see\n")
        XCTAssertEqual(Sh.read("\(dir)/notes.txt"), "scratch\n", "an unrelated uncommitted file is left alone")
        XCTAssertEqual(Sh.git(dir, home, "log", "-1", "--format=%B"), "Build title\n\nWhat the agent said.")
        await git.removeWorktree(dir, b.worktree)
        let deleted = await git.deleteBranch(dir, b.branch)
        XCTAssertTrue(deleted)
        XCTAssertFalse(FS.exists(b.worktree))
        let exists = await git.branchExists(dir, b.branch)
        XCTAssertFalse(exists)
    }

    func testAcceptRefusesConflictOverlappingEditsAndMovedFolder() async throws {
        let dir = repo()
        let b = try await build(dir)
        let who = await git.identity(b.worktree)
        Sh.write("\(b.worktree)/a.txt", "one\nBUILD\nthree\n")
        let tip = try await git.checkpoint(b.worktree, "turn 1", who)
        Sh.write("\(dir)/a.txt", "one\nPERSON\nthree\n")
        Sh.git(dir, home, "commit", "-qam", "theirs")
        let target = try await git.head(dir)
        let base = try await git.mergeBase(b.worktree, b.branch, target.sha)
        do {
            _ = try await git.squashOnto(b.worktree, branch: b.branch, base: base, onto: target.sha, message: "m", who: who)
            XCTFail("a conflict")
        } catch let e as GitError { XCTAssertEqual(e.code, "conflict"); XCTAssertEqual(e.files, ["a.txt"]) }
        let back = try await git.head(b.worktree)
        XCTAssertEqual(back.branch, b.branch, "the worktree is back on its branch")
        XCTAssertEqual(back.sha, tip, "with its checkpoints")

        let files = try await git.mergeInto(b.worktree, target.sha, who)
        XCTAssertEqual(files, ["a.txt"])
        XCTAssertTrue(Sh.read("\(b.worktree)/a.txt").contains("<<<<<<<"))
        Sh.write("\(b.worktree)/a.txt", "one\nBUILD AND PERSON\nthree\n")
        try await git.concludeMerge(b.worktree, "resolved", who)
        let base2 = try await git.mergeBase(b.worktree, b.branch, target.sha)
        XCTAssertEqual(base2, target.sha, "the branch now holds theirs")
        let sha = try await git.squashOnto(b.worktree, branch: b.branch, base: base2, onto: target.sha, message: "resolved build", who: who)!

        // their uncommitted edit to the same file: git refuses and names it
        Sh.write("\(dir)/a.txt", "uncommitted by the person\n")
        do { try await git.fastForward(dir, branch: "main", expected: target.sha, sha: sha); XCTFail("refused") }
        catch let e as GitError { XCTAssertEqual(e.code, "overwrite"); XCTAssertEqual(e.files, ["a.txt"]); XCTAssertEqual(e.message, "You have uncommitted edits to a.txt. Commit or discard them, then Accept again.") }
        XCTAssertEqual(Sh.read("\(dir)/a.txt"), "uncommitted by the person\n")
        Sh.git(dir, home, "checkout", "-q", "--", "a.txt")
        // their folder moved on in between
        Sh.write("\(dir)/b.txt", "moved\n")
        Sh.git(dir, home, "commit", "-qam", "moved")
        do { try await git.fastForward(dir, branch: "main", expected: target.sha, sha: sha); XCTFail("moved") }
        catch let e as GitError { XCTAssertEqual(e.code, "moved") }
    }

    /// The memory note's staging trick: the person's uncommitted edit elsewhere in a file the Build changed no longer
    /// blocks Accept; their edit stays, unstaged, on top of what landed.
    func testDirtyFileStagingTrickLandsAndKeepsTheirEdit() async throws {
        let dir = repo()
        Sh.write("\(dir)/a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n")
        Sh.git(dir, home, "commit", "-qam", "longer")
        let b = try await build(dir)
        let who = await git.identity(b.worktree)
        Sh.write("\(b.worktree)/a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n")
        _ = try await git.checkpoint(b.worktree, "turn 1", who)
        Sh.write("\(dir)/a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT (theirs)\n")
        let target = try await git.head(dir)
        let sha = try await git.squashOnto(b.worktree, branch: b.branch, base: target.sha, onto: target.sha, message: "m", who: who)!
        try await git.fastForward(dir, branch: "main", expected: target.sha, sha: sha)
        XCTAssertEqual(Sh.git(dir, home, "rev-parse", "HEAD"), sha, "it landed")
        XCTAssertEqual(Sh.read("\(dir)/a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT (theirs)\n", "both")
        XCTAssertEqual(Sh.git(dir, home, "diff", "--cached", "--name-only"), "", "nothing of theirs staged")
        XCTAssertEqual(Sh.git(dir, home, "diff", "--name-only"), "a.txt", "their edit stays, unstaged")
    }

    func testUntrackedFileTheBuildAddsIsNamed() async throws {
        let dir = repo()
        let b = try await build(dir)
        let who = await git.identity(b.worktree)
        Sh.write("\(b.worktree)/report.md", "from the build\n")
        _ = try await git.checkpoint(b.worktree, "turn 1", who)
        Sh.write("\(dir)/report.md", "the person's own\n")
        let target = try await git.head(dir)
        let sha = try await git.squashOnto(b.worktree, branch: b.branch, base: target.sha, onto: target.sha, message: "m", who: who)!
        do { try await git.fastForward(dir, branch: "main", expected: target.sha, sha: sha); XCTFail("refused") }
        catch let e as GitError { XCTAssertEqual(e.code, "overwrite"); XCTAssertEqual(e.files, ["report.md"]) }
    }

    func testFolderWithNoHistoryGetsOne() async throws {
        let dir = "\(root)/plain"
        Sh.write("\(dir)/index.js", "console.log(1)\n")
        Sh.write("\(dir)/node_modules/x/i.js", "x\n")
        let at = try await git.initRepository(dir)
        XCTAssertEqual(at.sha.count, 40)
        XCTAssertEqual(Sh.read("\(dir)/.gitignore").components(separatedBy: "\n")[0], "node_modules/")
        XCTAssertEqual(Sh.git(dir, home, "ls-files").components(separatedBy: "\n").sorted(), [".gitignore", "index.js"])
        let dirty = try await git.dirtyPaths(dir)
        XCTAssertEqual(dirty, [])
    }

    func testCloneWithGitHubSignInKeepsNothing() async throws {
        let origin = repo()
        let seen = LockedPairs()
        let spy = BuildGit(environment: Sh.env(home))
        spy.observe = { args, env in seen.add(args, env) }
        let into = "\(root)/clones/app"
        try await spy.clone(origin, into, token: "ghu_test_token")
        XCTAssertTrue(FS.exists("\(into)/a.txt"))
        XCTAssertFalse(seen.list[0].0.joined(separator: " ").contains("ghu_test_token"), "never on the command line")
        XCTAssertEqual(seen.list[0].1["ENGELBART_GITHUB_TOKEN"], "ghu_test_token")
        let config = Sh.read("\(into)/.git/config")
        XCTAssertFalse(config.contains("ghu_test_token"))
        XCTAssertFalse(config.contains("helper"))
        try await spy.clone(origin, "\(root)/clones/plain")
        XCTAssertNil(seen.list.last!.1["ENGELBART_GITHUB_TOKEN"], "signed out: nothing of it")
    }

    func testHoldBranchPutsAMovedWorktreeBack() async throws {
        let dir = repo()
        let b = try await build(dir, "abc")
        let start = Sh.git(b.worktree, home, "rev-parse", "HEAD")
        let none = try await git.holdBranch(b.worktree, "engelbart/abc", start)
        XCTAssertFalse(none.branch || none.commits, "nothing to put right")
        Sh.write("\(b.worktree)/c.txt", "c\n")
        Sh.git(b.worktree, home, "add", "c.txt")
        Sh.git(b.worktree, home, "commit", "-qm", "the agent's own")
        Sh.git(b.worktree, home, "checkout", "-q", "-b", "elsewhere")
        Sh.write("\(b.worktree)/d.txt", "d\n")
        let held = try await git.holdBranch(b.worktree, "engelbart/abc", start)
        XCTAssertTrue(held.branch && held.commits)
        XCTAssertEqual(Sh.git(b.worktree, home, "symbolic-ref", "--short", "HEAD"), "engelbart/abc")
        XCTAssertEqual(Sh.git(b.worktree, home, "rev-parse", "HEAD"), start)
        let sha = try await git.checkpoint(b.worktree, "Build: turn 1", GitIdentity(name: "Engelbart", email: "build@engelbart.local", own: false))!
        XCTAssertEqual(Sh.git(b.worktree, home, "rev-parse", "\(sha)^"), start)
        XCTAssertEqual(Sh.git(b.worktree, home, "show", "--name-only", "--format=", sha).components(separatedBy: "\n").sorted(), ["c.txt", "d.txt"])
        // a merge it was given to conclude and concluded is kept
        Sh.git(b.worktree, home, "checkout", "-q", "-b", "side", start)
        Sh.write("\(b.worktree)/e.txt", "e\n")
        Sh.git(b.worktree, home, "add", "e.txt")
        Sh.git(b.worktree, home, "commit", "-qm", "side")
        Sh.git(b.worktree, home, "checkout", "-q", "engelbart/abc")
        let before = Sh.git(b.worktree, home, "rev-parse", "HEAD")
        Sh.git(b.worktree, home, "merge", "-q", "--no-ff", "--no-commit", "side")
        Sh.git(b.worktree, home, "commit", "-qm", "merged by the agent")
        let merged = try await git.holdBranch(b.worktree, "engelbart/abc", before, merging: true)
        XCTAssertFalse(merged.branch || merged.commits)
        XCTAssertNotEqual(Sh.git(b.worktree, home, "rev-parse", "HEAD"), before)
    }

    func testMarkersAndTreeWithout() async throws {
        let dir = repo()
        let b = try await build(dir)
        let who = await git.identity(b.worktree)
        Sh.write("\(b.worktree)/a.txt", "one\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> side\n")
        let sha = try await git.checkpoint(b.worktree, "marked", who)!
        let marked = try await git.markers(b.worktree, b.base, sha)
        XCTAssertEqual(marked, ["a.txt"])
        Sh.write("\(b.worktree)/run.txt", "run\n")
        let run = try await git.checkpoint(b.worktree, "run step", who)!
        let tree = try await git.treeWithout(b.worktree, [run])
        XCTAssertNotNil(tree)
        let own = try await git.diff(b.worktree, b.base, tree!)
        XCTAssertEqual(own.files.map(\.path), ["a.txt"])
    }
}

final class LockedPairs: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [([String], [String: String])] = []
    func add(_ a: [String], _ e: [String: String]) { lock.lock(); items.append((a, e)); lock.unlock() }
    var list: [([String], [String: String])] { lock.lock(); defer { lock.unlock() }; return items }
}
