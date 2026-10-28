import XCTest
import EngelbartCore
@testable import EngelbartBuild

/// build.test.cjs: the lifecycle against real git, with the agent scripted. What a Build is given, where its record is,
/// how a turn ends, replies, Stop, Accept (one commit, checks, refusals), Discard, recovery, quick tasks.
final class ManagerTests: XCTestCase {
    var host: TestHost!
    var git: BuildGit!
    var n = 0
    var home: String { host.homeDir }

    override func setUp() {
        host = TestHost()
        git = BuildGit(environment: Sh.env(host.homeDir))
    }
    override func tearDown() { host.cleanup() }

    struct Scene { var code: String; var project: BuildProject; var workspace: BuildWorkspace }

    /// A project whose code folder is a git repository with one commit, and a workspace.
    func scene(files: [String: String] = ["a.txt": "one\ntwo\nthree\n"], doc: String = "Build the thing.") -> Scene {
        n += 1
        let code = "\(home)/code\(n)"
        try! FS.mkdirs(code)
        Sh.git(code, home, "init", "-q", "-b", "main")
        for (name, text) in files { Sh.write("\(code)/\(name)", text) }
        Sh.git(code, home, "add", "-A")
        Sh.git(code, home, "commit", "-qm", "init")
        let project = host.createProject("Build \(n)", directory: code)
        let workspace = host.createWorkspace(project.id, "Feature")
        host.docs[workspace.id] = doc
        return Scene(code: code, project: project, workspace: workspace)
    }

    final class Shells: @unchecked Sendable { private let l = NSLock(); private var c: [String] = []; func add(_ s: String) { l.lock(); c.append(s); l.unlock() }; var list: [String] { l.lock(); defer { l.unlock() }; return c } }

    func manager(_ runner: BuildRunner, git: BuildGit? = nil, autoFixes: Int = 2, limits: [String: Int] = BuildConfiguration.defaultLimits, diffDelay: TimeInterval = 0.7,
                 runShell: BuildShell? = nil, gitReady: Bool = true, runLog: BuildRunLog? = nil, githubToken: String? = nil, libraryChanged: (@Sendable () -> Void)? = nil) -> (BuildManager, Events, Shells) {
        let events = Events(), shells = Shells()
        let shell: BuildShell = runShell ?? { command, _, _ in shells.add(command); return command.contains("fail") ? ShellOutcome(ok: false, output: "test failed: 1 of 3") : ShellOutcome(ok: true, output: "ok") }
        let config = BuildConfiguration(host: host, git: git ?? self.git, runner: runner, notify: { events.add($0, $1) }, gitReady: { gitReady }, runShell: shell,
                                        githubToken: { githubToken }, libraryChanged: libraryChanged ?? {}, keepDir: "\(host.root)/keep", limits: limits,
                                        autoFixes: autoFixes, diffDelay: diffDelay, runLog: runLog)
        return (BuildManager(config), events, shells)
    }

    let project_: JSONValue = ["kind": "project"]

    func start(_ m: BuildManager, _ s: Scene, _ input: BuildStart = BuildStart()) async throws -> JSONValue {
        var i = input
        if i.workspaceId == nil && i.kind == "build" { i.workspaceId = s.workspace.id }
        if i.target == nil { i.target = project_ }
        return try await m.start(s.project.id, i)
    }

    func record(_ s: Scene, _ id: String) -> TaskRecord { TaskStore.readTask(try! host.project(s.project.id), id)! }

    func settled(_ s: Scene, _ id: String, not: [String] = ["setting-up", "queued", "running", "accepting"]) async -> TaskRecord {
        let p = try! host.project(s.project.id)
        _ = await eventually(20) { TaskStore.readTask(p, id).map { !not.contains($0.str("status") ?? "") } ?? false }
        try? await Task.sleep(nanoseconds: 30_000_000)
        return TaskStore.readTask(p, id)!
    }

    func turned(_ s: Scene, _ id: String, _ turns: Int) async -> TaskRecord {
        let p = try! host.project(s.project.id)
        _ = await eventually(20) { TaskStore.readTask(p, id).map { $0.int("turn") >= turns && !["setting-up", "queued", "running", "accepting"].contains($0.str("status") ?? "") } ?? false }
        return TaskStore.readTask(p, id)!
    }

    func texts(_ t: TaskRecord, roles: Set<String> = ["agent", "you"]) -> [String] {
        t.arr("messages").filter { roles.contains($0["role"]?.string ?? "") }.map { "\($0["role"]!.string!): \($0["text"]!.string!)" }
    }

    func setProjectBuild(_ s: Scene, _ build: JSONValue) { host.writeProjectJSON(s.project, ["build": build]) }

    // MARK: lifecycle

    func testRecordFrozenContextWorktreeFromLastCommitTurnCheckpoint() async throws {
        let s = scene(doc: "Build @[Spec] now.\n@bart what?\nbart> An old answer.")
        _ = try await host.createNote(s.project.id, name: "Spec", workspaceId: s.workspace.id, text: "The spec says: add b.txt.")
        let paper = LibraryRow(id: "6f7f8f9f-0000-4000-8000-000000000001", name: "A paper", type: "pdf", path: "\(home)/paper.pdf", projectId: s.project.id)
        host.insert(paper)
        Sh.write("\(s.code)/a.txt", "uncommitted edit\n")
        let agent = Scripted([.run { input in Sh.write("\(input.task.str("worktree")!)/b.txt", "bee\n"); return "Added b.txt." }])
        let (m, events, _) = manager(agent)
        let pre = try await m.preflight(s.project.id, project_)
        XCTAssertEqual(pre["ok"], true); XCTAssertEqual(pre["dirty"], 1); XCTAssertEqual(pre["branch"], "main")
        let started = try await start(m, s, BuildStart(provider: "anthropic", model: "opus", effort: "max", attach: [paper.id]))
        XCTAssertEqual(started["status"], "setting-up")
        let id = started["id"]!.string!
        XCTAssertTrue(TaskStore.isId(id))
        let task = await settled(s, id)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual([task.str("provider"), task.str("modelId"), task.str("effort")], ["anthropic", "opus", "max"])
        XCTAssertEqual(task.int("turn"), 1)
        XCTAssertEqual(task.str("worktree"), "\(host.dataRoot)/worktrees/\(s.project.slug)/\(id)")
        XCTAssertEqual(task.str("branch"), "engelbart/\(id)")
        XCTAssertEqual(Sh.read("\(task.str("worktree")!)/a.txt"), "one\ntwo\nthree\n", "uncommitted work is left out")
        XCTAssertEqual(Sh.read("\(s.code)/a.txt"), "uncommitted edit\n", "and untouched")
        XCTAssertFalse(FS.exists("\(s.code)/b.txt"), "nothing reaches the person's folder before Accept")
        XCTAssertEqual(task.arr("checkpoints").count, 1)
        XCTAssertEqual(Sh.git(task.str("worktree")!, home, "log", "-1", "--format=%s"), "Build Feature: turn 1")
        XCTAssertEqual(task.arr("messages").compactMap { $0["role"]?.string }, ["engelbart", "agent"])
        XCTAssertNotNil(task.arr("messages")[0]["text"]!.string!.range(of: #"^Started on Opus max in code\d+, from main at [0-9a-f]{7}; 1 uncommitted file left out\.$"#, options: .regularExpression))
        XCTAssertEqual(task["target"], ["kind": "project", "name": .string(NodePath.basename(s.code))])
        let context = Sh.read("\(s.project.dir)/builds/\(id)/context.md")
        XCTAssertEqual(agent.call(0).message, context)
        XCTAssertNil(agent.call(0).session)
        XCTAssertEqual(agent.call(0).task.str("worktree"), task.str("worktree"))
        XCTAssertTrue(context.contains("your working copy (make every change to the code here): \(host.dataRoot)/worktrees"))
        XCTAssertTrue(context.contains("notes and workspaces (you may write here; the engelbart tools add to the library): "))
        XCTAssertNotNil(context.range(of: #"<workspace name="Feature">\nBuild @\[Spec\] now\.\n\n<file name="Spec" type="md" tags="note"[^>]*>\nThe spec says: add b\.txt\.\n</file>"#, options: .regularExpression))
        XCTAssertTrue(context.contains("<attached>\n<file name=\"A paper\" type=\"pdf\""))
        XCTAssertFalse(context.contains("<history"), "no archived version yet")
        XCTAssertTrue(context.contains("\"mentioned\": true"))
        XCTAssertEqual(host.workspaceBuilds[s.workspace.id], [id])
        XCTAssertTrue(host.workspaceContext[s.workspace.id]!.contains(paper.id))
        XCTAssertTrue(events.all.contains { $0.0 == "engelbart:build" && $0.1["status"] == "running" })
        let seen = try await m.review(s.project.id, id)
        XCTAssertEqual(seen["files"]?.array?.map { "\($0["status"]!.string!) \($0["path"]!.string!)" }, ["A b.txt"])
        let listed = try await m.list(s.project.id)
        XCTAssertEqual(listed.first?["working"], false)
    }

    func testTurnReachBridgePaperPutBackBranchHeld() async throws {
        let s = scene()
        let paperFile = "\(home)/reach-paper.pdf"
        Sh.write(paperFile, "%PDF-1.4\n%%EOF\n")
        host.insert(LibraryRow(id: "6f7f8f9f-0000-4000-8000-0000000000aa", name: "Reach paper", type: "pdf", path: paperFile, projectId: s.project.id))
        let saved = LockedStrings()
        let home = self.home
        let agent = Scripted([.run { input in
            XCTAssertEqual(input.policy.gitDir, NodePath.real("\(input.task.str("repo")!)/.git"))
            XCTAssertTrue(input.policy.papers.contains(paperFile))
            let out = try await ToolBridge.use(input.engelbart!, "save_file", ["name": "Build notes", "content": "# What I found"])
            saved.add(out.text())
            let wt = input.task.str("worktree")!
            FS.remove(paperFile)
            Sh.write("\(wt)/c.txt", "sea\n")
            Sh.git(wt, home, "add", "c.txt")
            Sh.git(wt, home, "commit", "-qm", "the agent's own commit")
            Sh.git(wt, home, "checkout", "-q", "-b", "side")
            Sh.write("\(wt)/d.txt", "dee\n")
            return "Did it."
        }])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        let task = await settled(s, id)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual(Sh.read(paperFile), "%PDF-1.4\n%%EOF\n", "the paper is back")
        let wt = task.str("worktree")!
        XCTAssertEqual(Sh.git(wt, home, "rev-parse", "--abbrev-ref", "HEAD"), task.str("branch"), "back on its branch")
        XCTAssertEqual(Sh.git(wt, home, "rev-parse", "HEAD^"), task.str("baseSha"), "one checkpoint on where it started")
        XCTAssertEqual(Sh.git(wt, home, "show", "--name-only", "--format=", "HEAD").components(separatedBy: "\n").sorted(), ["c.txt", "d.txt"])
        let said = texts(task, roles: ["engelbart"]).joined(separator: "\n")
        XCTAssertTrue(said.contains("The agent deleted “Reach paper” from the library. Engelbart put it back."))
        XCTAssertTrue(said.contains("The agent left the Build's branch"))
        XCTAssertTrue(said.contains("The agent moved the Build's branch"))
        let note = try JSONValue.parse(saved.list[0])
        XCTAssertEqual(note["name"], "Build notes")
        XCTAssertEqual(Sh.read(note["path"]!.string!), "# What I found")
        XCTAssertTrue(host.workspaceContext[s.workspace.id]!.contains(note["id"]!.string!))
    }

    func testStopWhileTheTurnIsMadeReadyNeverStartsTheAgent() async throws {
        let s = scene()
        let agent = Scripted([.text("First."), .text("Never said.")])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        let gate = Gate()
        host.slowRows = { await gate.wait() }
        _ = try await m.reply(s.project.id, id, "Again.")
        let stopped = await eventually(5) { await m.stop(s.project.id, id) }
        XCTAssertTrue(stopped)
        host.slowRows = nil
        await gate.open()
        let p = try host.project(s.project.id)
        _ = await eventually(10) { TaskStore.readTask(p, id)?.str("status") == "stopped" }
        XCTAssertEqual(record(s, id).str("status"), "stopped")
        XCTAssertEqual(agent.count, 1, "the agent was never started for the reply")
    }

    func testNeedsYouReplySameSessionQueuedReplyStop() async throws {
        let s = scene()
        let release = Gate()
        let agent = Scripted([
            .text("Half done.\n\nNEEDS YOU: Blue or green?"),
            .run { input in XCTAssertTrue(input.message.contains("<reply>\nGreen.\n</reply>")); await release.wait(); return "Painted it green." },
            .run { input in XCTAssertTrue(input.message.contains("<reply>\nAlso the border.\n</reply>")); return "Border too." },
            .run { input in try await untilStopped(input) },
        ])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        var task = await settled(s, id)
        XCTAssertEqual(task.str("status"), "needs-you"); XCTAssertEqual(task.str("question"), "Blue or green?")
        XCTAssertEqual(task.arr("messages").last?["text"], "Half done.", "the question is on the card, not in the text")
        _ = try await m.reply(s.project.id, id, "Green.")
        _ = await eventually { agent.count >= 2 }
        XCTAssertEqual(agent.call(1).session, "session-1", "the same session")
        _ = await eventually { self.record(s, id).str("status") == "running" }
        _ = try await m.reply(s.project.id, id, "Also the border.") // while the turn runs: it waits
        XCTAssertEqual(record(s, id).str("queued"), "Also the border.")
        await release.open()
        _ = await eventually { agent.count >= 3 }
        task = await turned(s, id, 3)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual(texts(task), ["agent: Half done.", "you: Green.", "agent: Painted it green.", "you: Also the border.", "agent: Border too."])
        _ = try await m.reply(s.project.id, id, "One more.")
        _ = await eventually { agent.count >= 4 }
        let stopped = await eventually(5) { await m.stop(s.project.id, id) }
        XCTAssertTrue(stopped)
        task = await turned(s, id, 4)
        XCTAssertEqual(task.str("status"), "stopped")
    }

    func testReplyInterruptsTheRunningTurnAndGoesOnInTheSameSession() async throws {
        let s = scene()
        let agent = Scripted([
            .run { input in Sh.write("\(input.task.str("worktree")!)/half.txt", "half done\n"); return try await untilStopped(input, session: "session-cut") },
            .run { input in XCTAssertEqual(input.message, "<reply>\nUse the blue one.\n</reply>"); return "Blue it is." },
        ])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await eventually { agent.count >= 1 }
        _ = try await m.reply(s.project.id, id, "Use the blue one.", interrupt: true)
        let task = await turned(s, id, 2)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual(agent.call(1).session, "session-cut", "the turn cut short kept its session")
        XCTAssertEqual(texts(task), ["you: Use the blue one.", "agent: Blue it is."])
        XCTAssertFalse(task.arr("messages").contains { $0["text"]?.string?.contains("Stopped") == true }, "no Stopped note: the person only replied")
        XCTAssertEqual(task.arr("checkpoints").compactMap { $0["turn"]?.int }, [1], "what the cut turn had done was saved")

        // a first turn cut short before it had a session: the reply goes to a new one with everything again
        let bare = Scripted([.run { try await untilStopped($0) }, .text("Started again.")])
        let (other, _, _) = manager(bare)
        let second = try await start(other, s)["id"]!.string!
        _ = await eventually { bare.count >= 1 }
        _ = try await other.reply(s.project.id, second, "Smaller, please.", interrupt: true)
        _ = await turned(s, second, 2)
        XCTAssertNil(bare.call(1).session)
        XCTAssertNotNil(bare.call(1).message.range(of: #"<workspace name="Feature">[\s\S]*<reply>\nSmaller, please\.\n</reply>$"#, options: .regularExpression))
        let none = await other.stop(s.project.id, "ffffffffff")
        XCTAssertFalse(none)
    }

    func testAcceptOneCommitAfterTheirsChecksRunWorktreeGone() async throws {
        let s = scene(files: ["a.txt": "one\ntwo\nthree\n", "package.json": "{\"scripts\":{\"test\":\"node t.js\"}}"])
        let agent = Scripted([
            .run { Sh.write("\($0.task.str("worktree")!)/a.txt", "one\nTWO\nthree\n"); return "Changed two." },
            .run { Sh.write("\($0.task.str("worktree")!)/c.txt", "see\n"); return "Added c.\n\nThe tests pass." },
        ])
        let (m, _, shells) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        _ = try await m.reply(s.project.id, id, "Add c too.")
        var task = await turned(s, id, 2)
        Sh.git(s.code, home, "checkout", "-q", "-b", "feature")
        Sh.write("\(s.code)/b.txt", "theirs\n")
        Sh.git(s.code, home, "add", "-A")
        Sh.git(s.code, home, "commit", "-qm", "theirs meanwhile")
        let done = try await m.accept(s.project.id, id)
        XCTAssertEqual(done["status"], "accepted")
        XCTAssertEqual(done["accepted"]?["branch"], "feature", "the branch their folder is on")
        XCTAssertEqual(Sh.git(s.code, home, "log", "--format=%s", "-3").components(separatedBy: "\n"), ["Feature", "theirs meanwhile", "init"])
        XCTAssertNotNil(Sh.git(s.code, home, "log", "-1", "--format=%b").range(of: #"Added c\.[\s\S]*Engelbart Build [0-9a-f]{10} · Opus high · 2 turns"#, options: .regularExpression))
        XCTAssertEqual(Sh.read("\(s.code)/c.txt"), "see\n")
        XCTAssertEqual(shells.list, ["npm test"])
        task = record(s, id)
        XCTAssertFalse(FS.exists(task.str("worktree")!))
        let branch = await git.branchExists(s.code, task.str("branch")!)
        XCTAssertFalse(branch)
        let after = try await m.review(s.project.id, id)
        XCTAssertEqual(after["files"]?.array?.compactMap { $0["path"]?.string }.sorted(), ["a.txt", "c.txt"], "an accepted Build's review is its commit")
    }

    func testAcceptRefusesFailedChecksOverlappingEditAndConflictThenTheAgentResolves() async throws {
        let s = scene()
        setProjectBuild(s, ["check": "npm run fail"])
        let agent = Scripted([
            .run { Sh.write("\($0.task.str("worktree")!)/a.txt", "one\nBUILD\nthree\n"); return "Changed." },
            .run { input in
                XCTAssertNotNil(input.message.range(of: #"<from_engelbart>[\s\S]*conflict markers"#, options: .regularExpression))
                XCTAssertTrue(Sh.read("\(input.task.str("worktree")!)/a.txt").contains("<<<<<<<"))
                Sh.write("\(input.task.str("worktree")!)/a.txt", "one\nBUILD+PERSON\nthree\n")
                return "Resolved."
            },
        ])
        let (m, _, _) = manager(agent, autoFixes: 0)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        let head = Sh.git(s.code, home, "rev-parse", "HEAD")
        do { _ = try await m.accept(s.project.id, id); XCTFail() } catch { XCTAssertTrue(error.text.contains("checks failed (npm run fail)")) }
        var task = record(s, id)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual(task.obj("checks")?["ok"], false)
        XCTAssertEqual(task.obj("checks")?["output"], "test failed: 1 of 3")
        XCTAssertEqual(Sh.git(s.code, home, "rev-parse", "HEAD"), head)
        XCTAssertEqual(Sh.git(task.str("worktree")!, home, "rev-parse", "--abbrev-ref", "HEAD"), task.str("branch"), "back on its branch")

        setProjectBuild(s, ["check": ""])
        Sh.write("\(s.code)/a.txt", "the person, uncommitted\n")
        do { _ = try await m.accept(s.project.id, id); XCTFail() } catch { XCTAssertTrue(error.text.contains("uncommitted edits to a.txt")) }
        XCTAssertEqual(Sh.read("\(s.code)/a.txt"), "the person, uncommitted\n")

        Sh.write("\(s.code)/a.txt", "one\nPERSON\nthree\n")
        Sh.git(s.code, home, "commit", "-qam", "theirs")
        do { _ = try await m.accept(s.project.id, id); XCTFail() } catch { XCTAssertTrue(error.text.contains("same lines in a.txt")) }
        task = record(s, id)
        XCTAssertEqual(task.str("status"), "conflict")
        XCTAssertEqual(task.obj("conflict")?["files"], ["a.txt"])
        _ = try await m.fix(s.project.id, id)
        _ = await turned(s, id, 2)
        task = await settled(s, id, not: ["conflict", "setting-up", "queued", "running", "accepting"])
        XCTAssertEqual(task.str("status"), "review")
        let done = try await m.accept(s.project.id, id)
        XCTAssertEqual(done["status"], "accepted")
        XCTAssertEqual(Sh.read("\(s.code)/a.txt"), "one\nBUILD+PERSON\nthree\n")
        XCTAssertEqual(Sh.git(s.code, home, "log", "--format=%s", "-2").components(separatedBy: "\n"), ["Feature", "theirs"])
    }

    func testConflictMarkersLeftBehindNeverLand() async throws {
        let s = scene()
        let agent = Scripted([
            .run { Sh.write("\($0.task.str("worktree")!)/a.txt", "one\nBUILD\nthree\n"); return "Changed." },
            .text("Resolved, I think."), // leaves the markers in a.txt
            .run { input in XCTAssertTrue(input.message.contains("a.txt still holds conflict markers")); Sh.write("\(input.task.str("worktree")!)/a.txt", "one\nBOTH\nthree\n"); return "Really resolved." },
        ])
        let (m, _, _) = manager(agent, autoFixes: 0)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        Sh.write("\(s.code)/a.txt", "one\nPERSON\nthree\n")
        Sh.git(s.code, home, "commit", "-qam", "theirs")
        do { _ = try await m.accept(s.project.id, id); XCTFail() } catch { XCTAssertTrue(error.text.contains("same lines")) }
        _ = try await m.fix(s.project.id, id)
        _ = await turned(s, id, 2)
        do { _ = try await m.accept(s.project.id, id); XCTFail() } catch { XCTAssertTrue(error.text.contains("a.txt still holds conflict markers")) }
        XCTAssertEqual(Sh.git(s.code, home, "log", "-1", "--format=%s"), "theirs", "nothing landed")
        let task = record(s, id)
        XCTAssertEqual(task.str("status"), "conflict")
        XCTAssertEqual(task["conflict"], ["files": ["a.txt"], "markers": true])
        _ = try await m.fix(s.project.id, id)
        _ = await turned(s, id, 3)
        let done = try await m.accept(s.project.id, id)
        XCTAssertEqual(done["status"], "accepted")
        XCTAssertEqual(Sh.read("\(s.code)/a.txt"), "one\nBOTH\nthree\n")
    }

    func testARefusedAcceptGoesToTheAgentByItselfAndRunsAgain() async throws {
        let s = scene()
        setProjectBuild(s, ["check": "npm test"])
        let agent = Scripted([
            .run { Sh.write("\($0.task.str("worktree")!)/a.txt", "one\nBUILD\nthree\n"); return "Changed." },
            .run { input in XCTAssertNotNil(input.message.range(of: #"checks failed[\s\S]*npm test[\s\S]*broken"#, options: .regularExpression)); Sh.write("\(input.task.str("worktree")!)/fixed.txt", "yes\n"); return "Fixed the test." },
        ])
        let shell: BuildShell = { _, cwd, _ in FS.exists("\(cwd)/fixed.txt") ? ShellOutcome(ok: true, output: "ok") : ShellOutcome(ok: false, output: "broken") }
        let (m, _, _) = manager(agent, runShell: shell)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        let pressed = try await m.accept(s.project.id, id) // no rejection: it was sent on
        XCTAssertEqual(pressed["landing"]?["attempt"], 1)
        var task = await settled(s, id, not: ["setting-up", "queued", "running", "accepting", "review"])
        XCTAssertEqual(task.str("status"), "accepted")
        XCTAssertEqual(agent.count, 2)
        XCTAssertEqual(Sh.read("\(s.code)/fixed.txt"), "yes\n")
        XCTAssertFalse(task.truthy("landing"))

        let second = scene()
        let agent2 = Scripted([
            .run { Sh.write("\($0.task.str("worktree")!)/a.txt", "one\nBUILD\nthree\n"); return "Changed." },
            .run { input in XCTAssertTrue(input.message.contains("conflict markers")); Sh.write("\(input.task.str("worktree")!)/a.txt", "one\nBUILD+PERSON\nthree\n"); return "Resolved." },
        ])
        let (m2, _, _) = manager(agent2)
        let id2 = try await start(m2, second)["id"]!.string!
        _ = await settled(second, id2)
        Sh.write("\(second.code)/a.txt", "one\nPERSON\nthree\n")
        Sh.git(second.code, home, "commit", "-qam", "theirs")
        _ = try await m2.accept(second.project.id, id2)
        task = await settled(second, id2, not: ["setting-up", "queued", "running", "accepting", "review", "conflict"])
        XCTAssertEqual(task.str("status"), "accepted")
        XCTAssertEqual(Sh.read("\(second.code)/a.txt"), "one\nBUILD+PERSON\nthree\n")
    }

    func testAnAcceptTheAgentCannotFixGoesBackTwiceAtMost() async throws {
        let s = scene()
        setProjectBuild(s, ["check": "npm run fail"])
        let agent = Scripted([.run { Sh.write("\($0.task.str("worktree")!)/a.txt", "one\nBUILD\nthree\n"); return "Changed." }, .text("Tried once."), .text("Tried twice.")])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        let head = Sh.git(s.code, home, "rev-parse", "HEAD")
        _ = try await m.accept(s.project.id, id)
        _ = await eventually(20) { let t = self.record(s, id); return t.int("turn") >= 3 && !t.truthy("landing") && !["running", "queued", "accepting"].contains(t.str("status") ?? "") }
        let task = record(s, id)
        XCTAssertEqual(agent.count, 3, "the first turn and two fixes")
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertFalse(task.truthy("landing"))
        XCTAssertEqual(task.obj("checks")?["ok"], false)
        XCTAssertTrue(task.arr("messages").last!["text"]!.string!.contains("Still refused after the agent's 2 fixes"))
        XCTAssertEqual(Sh.git(s.code, home, "rev-parse", "HEAD"), head, "nothing landed")
    }

    func testTheCardIsSentTheDiffWhileTheAgentWorksAndOnceMore() async throws {
        let s = scene()
        let events = Events()
        let agent = Scripted([.run { input in
            Sh.write("\(input.task.str("worktree")!)/new.txt", "fresh\n")
            input.onUpdate(ActivityUpdate(activity: "Editing new.txt", log: true))
            _ = await eventually(3) { events.all.contains { $0.0 == "engelbart:build-diff" && $0.1["running"] == true } }
            return "Done."
        }])
        let config = BuildConfiguration(host: host, git: git, runner: agent, notify: { events.add($0, $1) }, runShell: { _, _, _ in ShellOutcome(ok: true, output: "") }, keepDir: "\(host.root)/keep", diffDelay: 0.005)
        let m = BuildManager(config)
        let id = try await start(m, s)["id"]!.string!
        let task = await settled(s, id)
        let during = events.all.first { $0.0 == "engelbart:build-diff" && $0.1["running"] == true }?.1
        XCTAssertNotNil(during, "a diff while the turn ran")
        XCTAssertEqual(during?["files"]?.array?.compactMap { $0["path"]?.string }, ["new.txt"])
        XCTAssertTrue(during?["patch"]?.string?.contains("+fresh") == true)
        XCTAssertEqual(Sh.git(task.str("worktree")!, home, "status", "--porcelain"), "", "the turn's checkpoint took it all")
        _ = await eventually { events.all.last { $0.0 == "engelbart:build-diff" }?.1["running"] == false }
        let last = events.all.last { $0.0 == "engelbart:build-diff" }!.1
        XCTAssertEqual(last["running"], false, "the turn's last diff comes last")
        XCTAssertEqual(last["files"]?.array?.compactMap { $0["path"]?.string }, ["new.txt"])
        Sh.write("\(task.str("worktree")!)/later.txt", "unsaved\n")
        let review = try await m.review(s.project.id, id)
        XCTAssertEqual(review["files"]?.array?.compactMap { $0["path"]?.string }.sorted(), ["later.txt", "new.txt"])
        XCTAssertTrue(Sh.git(task.str("worktree")!, home, "status", "--porcelain").contains("?? later.txt"), "still untracked after the review")
    }

    func testPastedImagesReachTheAgentAsFiles() async throws {
        let s = scene()
        let agent = Scripted([.text("First."), .text("Seen it.")])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        let one = IDs.new(), two = IDs.new()
        for (rid, name) in [(one, "a1"), (two, "a2")] {
            let file = "\(s.project.dir)/assets/\(rid).png"
            Sh.write(file, "png")
            host.insert(LibraryRow(id: rid, name: name, type: "image", path: file, projectId: s.project.id))
        }
        _ = try await m.reply(s.project.id, id, "Match this: [Attachment 1]", images: [PastedImage(n: 1, id: one), PastedImage(n: 2, id: two), PastedImage(n: 3, id: "not-an-id")])
        let task = await turned(s, id, 2)
        let sent = agent.call(1).message
        XCTAssertTrue(sent.contains("<reply>\nMatch this: [Attachment 1]\n</reply>"))
        XCTAssertTrue(sent.contains("[Attachment 1]: \(s.project.dir)/assets/\(one).png"))
        XCTAssertFalse(sent.contains(two), "an attachment taken out of the text is not sent")
        let mine = task.arr("messages").first { $0["role"] == "you" }!
        XCTAssertEqual(mine["text"], "Match this: [Attachment 1]")
        XCTAssertEqual(mine["images"], [["n": 1, "id": .string(one)]])
    }

    func testDiscardFailedTurnRecoveryAndResume() async throws {
        let s = scene()
        let agent = Scripted([.fail(TurnError("failed", "rate limited")), .text("Went on.")])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        var task = await settled(s, id)
        XCTAssertEqual(task.str("status"), "failed"); XCTAssertEqual(task.str("error"), "rate limited")
        // the app closed while it worked: a new manager finds the record left running
        var left = task; left["status"] = "running"
        try TaskStore.writeTask(try host.project(s.project.id), left)
        let (second, _, _) = manager(agent)
        let listed = try await second.list(s.project.id).first { $0["id"]?.string == id }!
        XCTAssertEqual(listed["status"], "interrupted")
        _ = try await second.resume(s.project.id, id)
        task = await turned(s, id, 2)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertTrue(agent.call(1).message.contains("cut off"))
        let gone = try await second.discard(s.project.id, id)
        XCTAssertEqual(gone["status"], "discarded")
        XCTAssertFalse(FS.exists(task.str("worktree")!))
        let branch = await git.branchExists(s.code, task.str("branch")!)
        XCTAssertFalse(branch)
        do { _ = try await second.reply(s.project.id, id, "hello"); XCTFail() } catch { XCTAssertTrue(error.text.contains("closed")) }
    }

    func testAProjectGoingToTheTrashStopsItsBuildsAndTheirCopiesFollowAndGo() async throws {
        let s = scene()
        let begun = Gate()
        let agent = Scripted([
            .run { input in Sh.write("\(input.task.str("worktree")!)/half.txt", "half\n"); await begun.open(); return try await untilStopped(input, session: "session-1") },
            .run { input in XCTAssertTrue(input.message.contains("cut off")); return "Went on." },
            .run { input in XCTAssertTrue(input.message.contains("<reply>\nAnd the tests.\n</reply>")); return "Tests too." },
        ])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        await begun.wait()
        _ = try await m.reply(s.project.id, id, "And the tests.") // waits for the turn
        try await m.stopProject(s.project.id)
        let running = await m.running()
        XCTAssertEqual(running, [], "its turn was stopped")
        var task = record(s, id)
        XCTAssertEqual(task.str("status"), "stopped"); XCTAssertEqual(task.str("sessionId"), "session-1"); XCTAssertEqual(task.str("queued"), "And the tests.")
        XCTAssertEqual(task.arr("checkpoints").count, 1)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(agent.count, 1, "the waiting reply did not start a turn in a deleted project")
        // restored under another folder name: the worktree follows (the Store rewrites the record's paths)
        let to = "\(host.dataRoot)/worktrees/\(s.project.slug) 2/\(id)"
        try await m.moveWorktree(task, to: to)
        task["worktree"] = .string(to); task["cwd"] = .string(to)
        try TaskStore.writeTask(try host.project(s.project.id), task)
        XCTAssertEqual(Sh.read("\(to)/half.txt"), "half\n")
        XCTAssertEqual(Sh.git(to, home, "rev-parse", "--abbrev-ref", "HEAD"), task.str("branch"))
        _ = try await m.resume(s.project.id, id)
        task = await turned(s, id, 3)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual([agent.call(1).session, agent.call(2).session], ["session-1", "session-1"])
        XCTAssertEqual([agent.call(1).task.str("worktree"), agent.call(2).task.str("worktree")], [to, to])
        // purged: worktree and branch go
        await m.removeWorktrees([task])
        XCTAssertFalse(FS.exists(to))
        let branch = await git.branchExists(s.code, task.str("branch")!)
        XCTAssertFalse(branch)
    }

    func testAProjectWhoseBuildIsBeingAcceptedCannotBeDeleted() async throws {
        let s = scene()
        let (m, _, _) = manager(Scripted([.text("Done.")]))
        let id = try await start(m, s)["id"]!.string!
        var task = await settled(s, id)
        task["status"] = "accepting"
        try TaskStore.writeTask(try host.project(s.project.id), task)
        do { try await m.stopProject(s.project.id); XCTFail() } catch { XCTAssertTrue(error.text.contains("being accepted")) }
    }

    func testAFolderWithoutHistoryIsGivenOneWhenTheBuildStarts() async throws {
        let code = "\(home)/no-history"
        Sh.write("\(code)/index.js", "x\n")
        let project = host.createProject("No history", directory: code)
        let s = Scene(code: code, project: project, workspace: host.createWorkspace(project.id, "W"))
        let (m, _, _) = manager(Scripted([]))
        let pre = try await m.preflight(project.id, project_)
        XCTAssertEqual(pre["ok"], true); XCTAssertEqual(pre["init"], true); XCTAssertEqual(pre["problems"], [])
        let after = try await m.initRepository(project.id, project_)
        XCTAssertEqual(after["ok"], true); XCTAssertNil(after["init"]); XCTAssertEqual(after["dirty"], 0)
        let other = "\(home)/no-history-2"
        Sh.write("\(other)/index.js", "y\n")
        let second = host.createProject("No history 2", directory: other)
        let s2 = Scene(code: other, project: second, workspace: host.createWorkspace(second.id, "W"))
        let (m2, _, _) = manager(Scripted([.text("Looked.")]))
        let started = try await start(m2, s2)
        XCTAssertTrue(FS.exists("\(other)/.git"), "the history was started by the Build")
        XCTAssertEqual(Sh.git(other, home, "log", "-1", "--format=%s"), "First snapshot (Engelbart)")
        let firstTurn = await turned(s2, started["id"]!.string!, 1)
        XCTAssertEqual(firstTurn.int("turn"), 1)
        let bare = host.createProject("No folder")
        let bareCheck = try await m.preflight(bare.id, project_)
        XCTAssertEqual(bareCheck["problems"]?[0]?["code"], "no-directory")
        let (noGit, _, _) = manager(Scripted([]), gitReady: false)
        let noGitCheck = try await noGit.preflight(project.id, project_)
        XCTAssertEqual(noGitCheck["problems"]?[0]?["code"], "no-git")
        _ = s
    }

    func testAProjectFolderEngelbartMadeGetsItsDefaultRepoInTheBackground() async throws {
        let code = "\(home)/made-by-engelbart"
        try FS.mkdirs(code)
        let project = host.createProject("Made Here", directory: code)
        let (notReady, _, _) = manager(Scripted([]), gitReady: false)
        let none = try await notReady.prepareDefault(project.id)
        XCTAssertNil(none)
        let (m, _, _) = manager(Scripted([]))
        let folder = try await m.prepareDefault(project.id)
        XCTAssertEqual(folder, "\(code)/made-here")
        XCTAssertEqual(Sh.git(folder!, home, "log", "-1", "--format=%s"), "First snapshot (Engelbart)")
        let row = host.rows.first { $0.folderPath == folder }!
        XCTAssertEqual(try host.project(project.id).defaultTarget, ["kind": "library", "id": .string(row.id)])
        let pre = try await m.preflight(project.id, ["kind": "default"])
        XCTAssertEqual(pre["ok"], true); XCTAssertNil(pre["create"]); XCTAssertEqual(pre["directory"]?.string, folder)
        XCTAssertFalse(FS.exists("\(code)/.git"), "the project folder itself is left alone")
    }

    func testTheDefaultRepoIsAFolderNamedAfterTheProjectMadeByTheFirstBuild() async throws {
        let s = scene()
        let agent = Scripted([.run { Sh.write("\($0.task.str("worktree")!)/b.txt", "bee\n"); return "Added b.txt." }])
        let (m, _, _) = manager(agent)
        let named = s.project.name.lowercased().replacingOccurrences(of: " ", with: "-")
        let mine = "\(s.code)/\(named)"
        let list = try await m.targets(s.project.id)
        XCTAssertEqual(list.map { [$0["kind"]!.string!, $0["name"]!.string!, $0["folder"]!.string!] }, [["default", named, mine], ["project", NodePath.basename(s.code), s.code]])
        let pre = try await m.preflight(s.project.id, nil)
        XCTAssertEqual(pre["ok"], true); XCTAssertEqual(pre["create"], true); XCTAssertEqual(pre["target"], ["kind": "default", "name": .string(named)])
        XCTAssertFalse(FS.exists(mine), "asking makes nothing")
        let started = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id))
        let task = await settled(s, started["id"]!.string!)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual([task.str("repo"), task.str("source")], [mine, mine])
        XCTAssertEqual(task["target"], ["kind": "default", "name": .string(named)])
        XCTAssertNotNil(task.arr("messages")[0]["text"]!.string!.range(of: "in \(named), from \\S+ at [0-9a-f]{7}\\.", options: .regularExpression))
        XCTAssertTrue(FS.exists("\(mine)/.git"), "a repository of its own")
        XCTAssertEqual(Sh.git(mine, home, "log", "--format=%s"), "First snapshot (Engelbart)")
        XCTAssertEqual(Sh.git(s.code, home, "log", "--format=%s"), "init", "the project folder's own history is untouched")
        let rows = { self.host.rows.filter { $0.folderPath == mine } }
        let row = rows()[0]
        XCTAssertEqual([row.name, row.type], [named, "folder"]); XCTAssertEqual(row.tags, ["git"]); XCTAssertEqual(row.projectId, s.project.id)
        let listedAgain = try await m.targets(s.project.id)
        XCTAssertEqual(listedAgain.map { [$0["kind"]!.string!, $0["folder"]!.string!] }, [["default", mine], ["project", s.code]])
        XCTAssertEqual(try host.project(s.project.id).defaultTarget, ["kind": "library", "id": .string(row.id)])
        _ = try await m.accept(s.project.id, task.str("id")!)
        XCTAssertEqual(Sh.read("\(mine)/b.txt"), "bee\n", "Accept lands in the default repo")
        XCTAssertFalse(FS.exists("\(s.code)/b.txt"))
        let again = try await m.preflight(s.project.id, ["kind": "default"])
        XCTAssertEqual(again["ok"], true); XCTAssertNil(again["create"]); XCTAssertEqual(again["top"]?.string, mine)
        let (m2, _, _) = manager(Scripted([.text("Nothing to do.")]))
        let second = try await m2.start(s.project.id, BuildStart(workspaceId: s.workspace.id))
        _ = await settled(s, second["id"]!.string!)
        XCTAssertEqual(rows().count, 1, "a second Build there makes no second row")
    }

    func testTheDefaultRepoWithARowAlreadyIsNotGivenASecond() async throws {
        let s = scene()
        let named = s.project.name.lowercased().replacingOccurrences(of: " ", with: "-")
        let mine = "\(s.code)/\(named)"
        let theirs = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "my name for it", "type": "folder", "tags": ["git"], "folder_path": .string(mine)])
        let (m, _, _) = manager(Scripted([.text("Done.")]))
        let started = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id))
        _ = await settled(s, started["id"]!.string!)
        XCTAssertEqual(host.rows.filter { $0.folderPath == mine }.map { [$0.id, $0.name] }, [[theirs.id, "my name for it"]])
    }

    func testThePickerListsTheGitRowsThisProjectHolds() async throws {
        let s = scene()
        let other = host.createProject("Elsewhere \(n)")
        func repo(_ name: String, project: String? = nil) async -> LibraryRow {
            let dir = "\(home)/\(name)-\(n)"
            try! FS.mkdirs(dir)
            Sh.git(dir, home, "init", "-q", "-b", "main")
            var fields: [String: JSONValue] = ["id": .string(IDs.new()), "name": .string(name), "type": "folder", "tags": ["git"], "folder_path": .string(dir)]
            if let project { fields["project_id"] = .string(project) }
            return try! await host.insertLibraryRow(fields)
        }
        let made = await repo("made-here", project: s.project.id)
        let linked = await repo("in-context")
        let theirs = await repo("theirs", project: other.id)
        let loose = await repo("nobodys")
        let notes = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "A folder, not a repository", "type": "folder", "folder_path": .string(home), "project_id": .string(s.project.id)])
        try await host.linkToWorkspace(s.project.id, s.workspace.id, [linked.id])
        let (m, _, _) = manager(Scripted([]))
        let ids = try await m.targets(s.project.id).map { $0["id"]?.string ?? $0["kind"]!.string! }
        XCTAssertEqual(ids, ["default", "project", made.id, linked.id])
        XCTAssertFalse([theirs.id, loose.id, notes.id].contains { ids.contains($0) })
    }

    func testTheDefaultRepoNeverTakesTheirFolder() async throws {
        let s = scene()
        let named = s.project.name.lowercased().replacingOccurrences(of: " ", with: "-")
        Sh.write("\(s.code)/\(named)/module.py", "x = 1\n")
        try FS.mkdirs("\(s.code)/\(named)-2")
        let (m, _, _) = manager(Scripted([]))
        let pre = try await m.preflight(s.project.id, nil)
        XCTAssertEqual(pre["ok"], true); XCTAssertEqual(pre["create"], true)
        XCTAssertEqual(pre["directory"]?.string, "\(s.code)/\(named)-2")
        XCTAssertEqual(pre["target"]?["name"]?.string, "\(named)-2")
        XCTAssertFalse(FS.exists("\(s.code)/\(named)/.git"))
    }

    func testLibraryRepositoriesLocalAsItIsGitHubClonedFirst() async throws {
        let s = scene()
        let remotes = "\(home)/remotes", origin = "\(remotes)/app"
        try FS.mkdirs(origin)
        Sh.git(origin, home, "init", "-q", "-b", "main")
        Sh.write("\(origin)/app.js", "app\n")
        Sh.git(origin, home, "add", "-A"); Sh.git(origin, home, "commit", "-qm", "app")
        let gitconfig = "\(home)/.gitconfig"
        try FS.write(gitconfig, (FS.readText(gitconfig) ?? "") + "[url \"file://\(remotes)/\"]\n\tinsteadOf = https://github.com/example/\n")
        let local = "\(home)/local-lib-\(n)"
        try FS.mkdirs(local)
        Sh.git(local, home, "init", "-q", "-b", "main")
        Sh.write("\(local)/lib.js", "lib\n")
        Sh.git(local, home, "add", "-A"); Sh.git(local, home, "commit", "-qm", "lib")
        let hub = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "example/app", "type": "website", "tags": ["git"], "url": "https://github.com/example/app", "project_id": .string(s.project.id)])
        let mine = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "local-lib", "type": "folder", "tags": ["git"], "folder_path": .string(local), "project_id": .string(s.project.id)])
        let (m, _, _) = manager(Scripted([.run { Sh.write("\($0.task.str("worktree")!)/more.js", "more\n"); return "Added more.js." }]))
        var list = try await m.targets(s.project.id)
        let find = { (id: String) in list.first { $0["id"]?.string == id }! }
        XCTAssertEqual(find(hub.id)["place"], "github"); XCTAssertEqual(find(hub.id)["folder"], .null)
        XCTAssertEqual(find(mine.id)["place"], "local"); XCTAssertEqual(find(mine.id)["folder"]?.string, local)
        let target: JSONValue = ["kind": "library", "id": .string(hub.id)]
        let pre = try await m.preflight(s.project.id, target)
        XCTAssertEqual(pre["ok"], false); XCTAssertEqual(pre["canClone"], true); XCTAssertEqual(pre["cloneTo"], "repos/app")
        XCTAssertEqual(pre["problems"]?[0]?["message"], "example/app is not on this Mac yet.")
        let cloned = try await m.cloneRepository(s.project.id, target)
        let into = "\(s.code)/repos/app"
        XCTAssertEqual(cloned["ok"], true); XCTAssertEqual(cloned["top"]?.string, into)
        XCTAssertEqual(cloned["target"], ["kind": "library", "id": .string(hub.id), "name": "example/app"])
        XCTAssertEqual(Sh.read("\(into)/app.js"), "app\n")
        let row = await host.libraryRow(hub.id)!
        XCTAssertEqual([row.folderPath, row.type, row.url], [into, "folder", "https://github.com/example/app"])
        do { _ = try await m.cloneRepository(s.project.id, target); XCTFail() } catch { XCTAssertTrue(error.text.contains("already on this Mac")) }
        list = try await m.targets(s.project.id)
        XCTAssertEqual(find(hub.id)["place"], "local")
        let started = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id, target: ["kind": "library", "id": .string(mine.id)]))
        let task = await settled(s, started["id"]!.string!)
        XCTAssertEqual([task.str("status"), task.str("repo"), task.obj("target")?["name"]?.string], ["review", local, "local-lib"])
        _ = try await m.accept(s.project.id, task.str("id")!)
        XCTAssertEqual(Sh.read("\(local)/more.js"), "more\n", "Accept lands in the library repository")
        do { _ = try await m.preflight(s.project.id, ["kind": "library", "id": .string(IDs.new())]); XCTFail() } catch { XCTAssertTrue(error.text.contains("not in the library")) }
    }

    func testABuildInARepositoryNotOnThisMacClonesItFirstAndARefusalMakesNothing() async throws {
        let s = scene()
        let origin = "\(home)/remotes-auto-\(n)/sandboxed"
        try FS.mkdirs(origin)
        Sh.git(origin, home, "init", "-q", "-b", "main")
        Sh.write("\(origin)/index.js", "hi\n")
        Sh.git(origin, home, "add", "-A"); Sh.git(origin, home, "commit", "-qm", "first")
        let into = "\(s.code)/repos/sandboxed"
        let real = git!
        let stub = git.copy()
        stub.cloneOverride = { url, dir, _ in XCTAssertEqual(url, "https://github.com/example/sandboxed"); try await real.clone(origin, dir) }
        let clonedFirst = LockedStrings()
        let changed = LockedStrings()
        let (m, _, _) = manager(Scripted([.run { input in clonedFirst.add(String(FS.exists("\(into)/index.js"))); Sh.write("\(input.task.str("worktree")!)/more.js", "more\n"); return "Added more.js." }]),
                                git: stub, libraryChanged: { changed.add("x") })
        let row = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "example/sandboxed", "type": "website", "tags": ["git"], "url": "https://github.com/example/sandboxed", "project_id": .string(s.project.id)])
        let started = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id, target: ["kind": "library", "id": .string(row.id)]))
        XCTAssertEqual(started["target"], ["kind": "library", "id": .string(row.id), "name": "example/sandboxed"])
        XCTAssertEqual(started["status"], "setting-up")
        let clonedRow = await host.libraryRow(row.id)
        XCTAssertEqual(clonedRow?.folderPath, into, "the clone is on the row before start returns")
        XCTAssertGreaterThanOrEqual(changed.list.count, 1, "the sidebar is told")
        let task = await settled(s, started["id"]!.string!)
        XCTAssertEqual([task.str("status"), task.str("repo")], ["review", into]); XCTAssertEqual(clonedFirst.list, ["true"])
        let refused = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "example/refused", "type": "website", "tags": ["git"], "url": "https://github.com/example/refused", "project_id": .string(s.project.id)])
        let failing = git.copy()
        failing.cloneOverride = { _, _, _ in throw GitError("fatal: repository not found") }
        let before = TaskStore.listTasks(try host.project(s.project.id)).count
        let (bad, _, _) = manager(Scripted([]), git: failing)
        do { _ = try await bad.start(s.project.id, BuildStart(workspaceId: s.workspace.id, target: ["kind": "library", "id": .string(refused.id)])); XCTFail() }
        catch { XCTAssertTrue(error.text.contains("example/refused could not be cloned: GitHub refused")) }
        XCTAssertEqual(TaskStore.listTasks(try host.project(s.project.id)).count, before, "no record")
        let refusedRow = await host.libraryRow(refused.id)
        XCTAssertNil(refusedRow?.folderPath)
    }

    func testCloningWithTheSignInFirstThenTheirOwnGit() async throws {
        let s = scene()
        let origin = "\(home)/origin-\(n)"
        try FS.mkdirs(origin)
        Sh.git(origin, home, "init", "-q", "-b", "main")
        Sh.write("\(origin)/x.js", "x\n")
        Sh.git(origin, home, "add", "-A"); Sh.git(origin, home, "commit", "-qm", "x")
        let row = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "example/private", "type": "website", "tags": ["git"], "url": "https://github.com/example/private"])
        try await host.linkToWorkspace(s.project.id, s.workspace.id, [row.id])
        let calls = LockedStrings()
        let theirs = Flag(true)
        let real = git!
        let stub = git.copy()
        stub.cloneOverride = { url, dir, token in
            calls.add("\(url) \(token ?? "nil")")
            if token != nil || !theirs.value { throw GitError("fatal: Authentication failed for 'https://github.com/example/private.git/'") }
            try await real.clone(origin, dir)
        }
        let (m, _, _) = manager(Scripted([]), git: stub, githubToken: "ghu_test_token")
        let cloned = try await m.cloneRepository(s.project.id, ["kind": "library", "id": .string(row.id)])
        XCTAssertEqual(calls.list, ["https://github.com/example/private ghu_test_token", "https://github.com/example/private nil"])
        XCTAssertEqual(cloned["ok"], true); XCTAssertEqual(cloned["top"]?.string, "\(s.code)/repos/private")
        let other = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": "example/hidden", "type": "website", "tags": ["git"], "url": "https://github.com/example/hidden"])
        theirs.value = false
        do { _ = try await m.cloneRepository(s.project.id, ["kind": "library", "id": .string(other.id)]); XCTFail() }
        catch { XCTAssertNotNil(error.text.range(of: #"example/hidden could not be cloned: GitHub refused \(.*Authentication failed.*\)\. If it is private, Engelbart's GitHub App must be installed where it lives, with access to it\."#, options: .regularExpression), error.text) }
        let otherRow = await host.libraryRow(other.id)
        XCTAssertNil(otherRow?.folderPath, "nothing is kept of a refused clone")
    }

    func testQuickTasksTheirOwnSlotLandByThemselvesEscalateAndBecomeABuild() async throws {
        let s = scene()
        let hold = Gate()
        final class Router: BuildRunner, @unchecked Sendable {
            let big: Scripted, hold: Gate, quickIds = LockedStrings(), calls = LockedPairs()
            init(_ big: Scripted, _ hold: Gate) { self.big = big; self.hold = hold }
            func turn(_ input: TurnInput) async throws -> TurnOutput {
                if input.task.str("kind") == "quick" || quickIds.list.contains(input.task.str("id")!) {
                    calls.add([input.message, input.system, input.session ?? "nil"], [:])
                    if input.message.contains("escalate") && input.session == nil { return TurnOutput(text: "ESCALATE: needs a schema change.", session: "q") }
                    if input.message.contains("full Build") { return TurnOutput(text: "Did it properly.", session: input.session) }
                    Sh.write("\(input.task.str("worktree")!)/quick.txt", "quick\n")
                    return TurnOutput(text: "Fixed the typo.", session: "q")
                }
                return try await big.turn(input)
            }
        }
        let router = Router(Scripted([.run { _ in await hold.wait(); return "Big done." }]), hold)
        let (m, _, _) = manager(router, limits: ["build": 1, "quick": 1])
        let big = try await start(m, s)["id"]!.string!
        _ = await eventually { self.record(s, big).str("status") == "running" }
        let quick = try await m.start(s.project.id, BuildStart(kind: "quick", postItId: "card-1", text: "- [ ] fix the typo in the header"))
        XCTAssertEqual([quick["kind"], quick["workspaceId"], quick["postItId"], quick["title"]], ["quick", .null, "card-1", "fix the typo in the header"])
        let landed = await settled(s, quick["id"]!.string!, not: ["setting-up", "queued", "running", "review", "accepting"])
        XCTAssertEqual(landed.str("status"), "accepted", "a quick task does not wait behind a running Build, and lands by itself")
        let named = s.project.name.lowercased().replacingOccurrences(of: " ", with: "-")
        XCTAssertEqual(landed["target"], ["kind": "default", "name": .string(named)], "a post-it's Build works in the default repo")
        XCTAssertEqual(Sh.read("\(s.code)/\(named)/quick.txt"), "quick\n")
        XCTAssertFalse(FS.exists("\(s.code)/quick.txt"))
        XCTAssertTrue(router.calls.list[0].0[1].contains("This is a quick task"))
        XCTAssertTrue(router.calls.list[0].0[0].contains("<post-it>\n- [ ] fix the typo in the header\n</post-it>"))
        XCTAssertTrue(landed.arr("messages").last!["text"]!.string!.contains("(a quick task that finished cleanly lands by itself)"))
        await hold.open()
        _ = await settled(s, big)

        let hard = try await m.start(s.project.id, BuildStart(kind: "quick", text: "escalate: rework the storage"))["id"]!.string!
        router.quickIds.add(hard)
        let escalated = await settled(s, hard)
        XCTAssertEqual(escalated.str("status"), "escalated"); XCTAssertEqual(escalated.str("escalation"), "needs a schema change.")
        // a record from before 2026-09-27 has no `postIt`: its post-it is read back from the frozen context
        var old = record(s, hard); old["postIt"] = nil
        try TaskStore.writeTask(try host.project(s.project.id), old)
        let promoted = try await m.promote(s.project.id, hard, workspaceId: s.workspace.id)
        let moved = await turned(s, hard, 2)
        XCTAssertEqual([moved.str("kind"), moved.str("workspaceId"), moved.str("status")], ["build", s.workspace.id, "review"])
        XCTAssertEqual(router.calls.list.last!.0[2], "q", "the same session goes on")
        XCTAssertTrue(host.workspaceBuilds[s.workspace.id]!.contains(hard))
        XCTAssertEqual(promoted["version"]?["title"], "Imported from Task: escalate: rework the storage")
        XCTAssertEqual(host.archives[s.workspace.id]!.last!.text, "Imported from Task:\nescalate: rework the storage\n\nbuild> \(hard)\n")
        XCTAssertEqual(host.docs[s.workspace.id], "Build the thing.")
        XCTAssertEqual(host.recent.first, s.workspace.id, "first of ⌘J's recent workspaces")
    }

    func testPromoteOnAnotherModelSameProviderGoesOnAnotherStartsAgain() async throws {
        let s = scene()
        final class Agent: BuildRunner, @unchecked Sendable {
            let calls = LockedPairs()
            func turn(_ input: TurnInput) async throws -> TurnOutput {
                calls.add([input.message, input.session ?? "nil", input.task.str("model") ?? ""], [:])
                if input.message.contains("escalate") && input.session == nil && !input.message.contains("full Build") { return TurnOutput(text: "ESCALATE: too big.", session: "q1") }
                return TurnOutput(text: "Done properly.", session: input.session ?? "fresh")
            }
        }
        let agent = Agent()
        let (m, _, _) = manager(agent)
        let first = try await m.start(s.project.id, BuildStart(kind: "quick", text: "escalate: one", provider: "openai", model: "sol", effort: "high"))["id"]!.string!
        _ = await settled(s, first)
        let same = try await m.promote(s.project.id, first, workspaceId: s.workspace.id, picked: ("openai", "astra", "xhigh"))
        XCTAssertEqual([same["provider"], same["model"], same["effort"]], ["openai", "astra", "xhigh"])
        _ = await turned(s, first, 2)
        XCTAssertEqual(agent.calls.list.last!.0[1], "q1", "same provider: the session goes on")
        XCTAssertEqual(agent.calls.list.last!.0[2], "astra")
        XCTAssertNotNil(same["messages"]?.array?.last?["text"]?.string?.range(of: #"as a Build on .* xhigh\.$"#, options: .regularExpression))
        let second = try await m.start(s.project.id, BuildStart(kind: "quick", text: "escalate: two", provider: "openai", model: "sol", effort: "high"))["id"]!.string!
        _ = await settled(s, second)
        let other = try await m.promote(s.project.id, second, workspaceId: s.workspace.id, picked: ("anthropic", "opus", "max"))
        XCTAssertEqual([other["provider"], other["model"], other["effort"]], ["anthropic", "opus", "max"])
        _ = await turned(s, second, 2)
        let fresh = agent.calls.list.last!.0
        XCTAssertEqual(fresh[1], "nil", "another provider cannot resume the session")
        XCTAssertTrue(fresh[0].contains("<post-it>\nescalate: two\n</post-it>"), "so it is given everything again")
        XCTAssertTrue(fresh[0].contains("full Build"))
    }

    func testAPostItAddedToAWorkspaceIsABuildOfItArchivedTheDocumentUntouched() async throws {
        let s = scene(doc: "Old plan.")
        host.clear(s.workspace.id)
        host.docs[s.workspace.id] = "The plan in front now."
        let agent = Scripted([.text("Renamed it.\n\nNEEDS YOU: Keep the old name as an alias?")])
        let (m, _, _) = manager(agent)
        let task = try await start(m, s, BuildStart(postItId: "card-9", text: "- [ ] rename the header\n"))
        XCTAssertEqual([task["kind"], task["workspaceId"], task["postItId"], task["title"]], ["build", .string(s.workspace.id), "card-9", "rename the header"])
        XCTAssertEqual(task["target"]?["kind"], "default", "a post-it's Build: the default repo, though the project folder was asked for")
        XCTAssertEqual(task["version"]?["title"], "Imported from Task: rename the header")
        let done = await settled(s, task["id"]!.string!)
        XCTAssertEqual(done.str("status"), "needs-you", "a full Build: it may ask")
        let context = agent.call(0).message
        XCTAssertTrue(context.contains("<post-it>\n- [ ] rename the header\n</post-it>"))
        XCTAssertTrue(context.contains("added it to a workspace as a full Build"))
        XCTAssertTrue(context.contains("built from: a post-it added to the workspace \"Feature\""))
        XCTAssertNotNil(context.range(of: #"<history [^>]*>\nOld plan\.\n</history>"#, options: .regularExpression), "the version before it, as history")
        XCTAssertFalse(context.contains("The plan in front now"))
        XCTAssertFalse(agent.call(0).system.contains("This is a quick task"))
        XCTAssertEqual(host.archives[s.workspace.id]!.last!.text, "Imported from Task:\n- [ ] rename the header\n\nbuild> \(task["id"]!.string!)\n")
        XCTAssertEqual(host.docs[s.workspace.id], "The plan in front now.", "the workspace is not cleared")
        XCTAssertEqual(host.recent.first, s.workspace.id)
        do { _ = try await start(m, s, BuildStart(text: "  ")); XCTFail() } catch { XCTAssertTrue(error.text.contains("empty")) }
    }

    func testABuildFromALineIsOnlyTheRequestNoHistoryNothingArchived() async throws {
        let s = scene(doc: "Old plan.")
        host.clear(s.workspace.id)
        host.docs[s.workspace.id] = "The plan in front now.\n@bart --build implement @[Spec]"
        _ = try await host.createNote(s.project.id, name: "Spec", workspaceId: nil, text: "Greet in French.")
        let archivesBefore = host.archives[s.workspace.id]!.count
        let agent = Scripted([.text("Done.")])
        let (m, _, _) = manager(agent)
        let task = try await start(m, s, BuildStart(text: "implement @[Spec]", fromLine: true))
        XCTAssertEqual([task["kind"], task["title"]], ["build", "implement @[Spec]"])
        XCTAssertEqual(task["target"]?["kind"], "default")
        XCTAssertEqual(task["version"], .null, "not put in as an archived version")
        _ = await settled(s, task["id"]!.string!)
        let context = agent.call(0).message
        XCTAssertNotNil(context.range(of: #"<request>\nimplement @\[Spec\]\n\n<file name="Spec"[^>]*>\nGreet in French\.\n</file>\n</request>"#, options: .regularExpression), context)
        XCTAssertTrue(context.contains("built from: a request typed on a line of the workspace \"Feature\""))
        XCTAssertTrue(context.contains("Do what the request below asks. The person typed it on a line of a workspace as a full Build"))
        for absent in ["<workspace ", "<history ", "<post-it>", "The plan in front now", "Old plan"] { XCTAssertFalse(context.contains(absent), absent) }
        XCTAssertEqual(host.archives[s.workspace.id]!.count, archivesBefore)
        XCTAssertTrue(host.workspaceBuilds[s.workspace.id]!.contains(task["id"]!.string!))
        XCTAssertTrue(host.recent.isEmpty, "no edit recorded")
    }

    func testABuildAfterAClearIsGivenTheNewestArchivedVersionAsHistory() async throws {
        let s = scene()
        _ = try await host.createNote(s.project.id, name: "Old spec", workspaceId: nil, text: "The old spec.")
        host.docs[s.workspace.id] = "Phase one per @[Old spec].\nbuild> 0123456789\n"
        host.clear(s.workspace.id)
        host.docs[s.workspace.id] = "Phase two: the new thing."
        let agent = Scripted([.text("ok")])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await settled(s, id)
        let context = agent.call(0).message
        XCTAssertTrue(context.contains("<workspace name=\"Feature\">\nPhase two: the new thing.\n</workspace>"))
        XCTAssertNotNil(context.range(of: #"<history cleared="[^"]+" note="An earlier version of this workspace, cleared by the person\. Context only: do not implement anything that appears only here\.">\nPhase one per @\[Old spec\]\.\n\n<file name="Old spec"[^>]*>\nThe old spec\.\n</file>\n</history>"#, options: .regularExpression))
        XCTAssertFalse(context.contains("build> 0123456789"))
        XCTAssertEqual(record(s, id).str("archive"), host.archives[s.workspace.id]![0].file)
    }

    func testStorageIdsAndQuitInterruptsWork() async throws {
        let s = scene()
        XCTAssertThrowsError(try TaskStore.taskDir(s.project, "../x")) { XCTAssertEqual($0.text, "build id is invalid") }
        let agent = Scripted([.run { try await untilStopped($0, session: "s1") }])
        let (m, _, _) = manager(agent)
        let id = try await start(m, s)["id"]!.string!
        _ = await eventually { agent.count >= 1 }
        await m.stopAll()
        let task = record(s, id)
        XCTAssertEqual(task.str("status"), "interrupted")
        XCTAssertTrue(task.arr("messages").last!["text"]!.string!.contains("Engelbart closed while this turn was working."))
        let open = try await m.openIds(s.project.id)
        XCTAssertEqual(open, [id])
    }

    func testTheAgentMapRecordsEachTurn() async throws {
        let s = scene()
        let log = RecordingLog()
        let agent = Scripted([
            .run { input in
                input.onEvent?(["type": "assistant", "message": ["content": [["type": "tool_use", "id": "r1", "name": "Read", "input": ["file_path": "a.txt"]]]]])
                return "Read it.\n\nNEEDS YOU: Blue or green?"
            },
            .text("Painted it green."),
        ])
        let (m, _, _) = manager(agent, runLog: log)
        let ref: JSONValue = ["kind": "workspace", "workspaceId": .string(s.workspace.id)]
        let id = try await start(m, s, BuildStart(text: "add a page", fromLine: true, place: ["ref": ref, "line": 1, "text": "@bart --build add a page"]))["id"]!.string!
        _ = await settled(s, id)
        let first = log.started["\(id):1"]!
        XCTAssertEqual([first["agent"], first["kind"], first["buildId"], first["turn"], first["provider"], first["workspaceName"]], ["build", "build", .string(id), 1, "anthropic", "Feature"])
        XCTAssertEqual(first["place"], ["projectId": .string(s.project.id), "ref": ref, "line": 1, "text": "@bart --build add a page"])
        XCTAssertEqual(first["system"]?.string, BuildPrompt.load(dataRoot: host.dataRoot))
        XCTAssertEqual(Set(first["context"]!.object!.keys), ["engelbart", "task", "request", "context_json"])
        XCTAssertEqual(log.finished["\(id):1"]?["ending"], "needs-you")
        XCTAssertEqual(log.events["\(id):1"]?.count, 1)
        _ = try await m.reply(s.project.id, id, "Green.")
        _ = await turned(s, id, 2)
        XCTAssertEqual(log.started["\(id):2"]?["context"], ["reply": .string(agent.call(1).message)])
        XCTAssertNil(log.started["\(id):2"]?["place"], "the first turn alone")
        XCTAssertEqual(log.finished["\(id):2"]?["ending"], "review")
        let panel = try await start(m, s, BuildStart(place: ["line": 7, "text": "ignored"]))
        XCTAssertEqual(record(s, panel["id"]!.string!)["place"], ["projectId": .string(s.project.id), "ref": ref, "line": .null, "text": .null], "the panel: its workspace, no line")
    }
}

final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock(); if opened { lock.unlock(); c.resume(); return }; waiters.append(c); lock.unlock()
        }
    }
    func open() async { lock.lock(); opened = true; let w = waiters; waiters = []; lock.unlock(); w.forEach { $0.resume() } }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock(); private var v: Bool
    init(_ v: Bool) { self.v = v }
    var value: Bool { get { lock.lock(); defer { lock.unlock() }; return v } set { lock.lock(); v = newValue; lock.unlock() } }
}

final class RecordingLog: BuildRunLog, @unchecked Sendable {
    private let lock = NSLock()
    var started: [String: JSONValue] = [:], finished: [String: JSONValue] = [:], events: [String: [JSONValue]] = [:], notes: [String: [JSONValue]] = [:], steps: [String: [JSONValue]] = [:], outputs: [String: JSONValue] = [:]
    func start(_ record: JSONValue) { lock.lock(); started[record["id"]!.string!] = record; lock.unlock() }
    func step(_ id: String, _ step: JSONValue) { lock.lock(); steps[id, default: []].append(step); lock.unlock() }
    func event(_ id: String, _ event: JSONValue) { lock.lock(); events[id, default: []].append(event); lock.unlock() }
    func output(_ id: String, _ output: JSONValue) { lock.lock(); outputs[id] = output; lock.unlock() }
    func note(_ id: String, _ note: JSONValue) { lock.lock(); notes[id, default: []].append(note); lock.unlock() }
    func finish(_ id: String, _ end: JSONValue) { lock.lock(); finished[id] = end; lock.unlock() }
}
