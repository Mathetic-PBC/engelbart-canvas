import XCTest
import EngelbartCore
@testable import EngelbartBuild

/// run-step.test.cjs: launch facts, the tools and the paths they may reach, Engelbart's processes and checks, and the step
/// inside the Build's lifecycle. The agent is scripted: it calls the tools through the real loopback bridge.
final class RunStepTests: XCTestCase {
    var host: TestHost!
    var git: BuildGit!
    var processes: [RunProcesses] = []
    var n = 0
    var home: String { host.homeDir }

    override func setUp() { host = TestHost(); git = BuildGit(environment: Sh.env(host.homeDir)) }
    override func tearDown() async throws {
        for p in processes { await p.stopAll() }
        host.cleanup()
    }

    static let app = ["package.json": "{\n  \"name\": \"demo\",\n  \"scripts\": { \"start\": \"node server.cjs\" },\n  \"bin\": \"cli.cjs\"\n}",
                      "server.cjs": "require('node:http').createServer((q, r) => r.end('hello from the build')).listen(Number(process.env.PORT), 'localhost');\n",
                      "cli.cjs": "console.log(process.argv.includes('--help') ? 'usage: demo' : 'ran'); process.exit(0);\n"]

    func repository(_ name: String, _ files: [String: String] = RunStepTests.app) -> String {
        let dir = "\(home)/\(name)-\(UUID().uuidString.prefix(6))"
        try! FS.mkdirs(dir)
        Sh.git(dir, home, "init", "-q", "-b", "main")
        for (f, t) in files { Sh.write("\(dir)/\(f)", t) }
        Sh.git(dir, home, "add", "-A"); Sh.git(dir, home, "commit", "-qm", "init")
        return dir
    }

    func procs(appAlive: TimeInterval = 0.4, uiReady: TimeInterval = 8) -> RunProcesses {
        let p = RunProcesses(environment: Sh.env(home), appAlive: appAlive, uiReady: uiReady)
        processes.append(p)
        return p
    }

    static func answers(_ url: String?) async -> Bool { guard let url else { return false }; return await RunProcesses.respondsAt(url) }

    func testLaunchFactsAreBoundedAndNeverThroughALink() throws {
        let root = "\(home)/facts"
        Sh.write("\(root)/package.json", "{\"name\":\"mono\",\"workspaces\":[\"apps/*\"],\"scripts\":{\"dev\":\"turbo dev\",\"test\":\"x\"}}")
        Sh.write("\(root)/apps/web/package.json", "{\"scripts\":{\"dev\":\"vite\",\"build\":\"vite build\"},\"devDependencies\":{\"vite\":\"5\"}}")
        Sh.write("\(root)/apps/web/vite.config.js", "")
        Sh.write("\(root)/apps/desktop/package.json", "{\"main\":\"main.js\",\"scripts\":{\"start\":\"electron .\"},\"devDependencies\":{\"electron\":\"30\"}}")
        Sh.write("\(root)/tools/cli/package.json", "{\"name\":\"mycli\",\"bin\":{\"mycli\":\"index.js\"}}")
        Sh.write("\(root)/api/requirements.txt", "flask\n")
        Sh.write("\(root)/api/app.py", "")
        Sh.write("\(root)/node_modules/x/package.json", "{}")
        let outside = "\(home)/outside"
        Sh.write("\(outside)/package.json", "{}")
        try FileManager.default.createSymbolicLink(atPath: "\(root)/linked", withDestinationPath: outside)
        let facts = LaunchDiscovery.discover(root)
        let by = Dictionary(uniqueKeysWithValues: (facts["components"]?.array ?? []).map { ($0["cwd"]!.string!, $0) })
        XCTAssertEqual(by.keys.sorted(), [".", "api", "apps/desktop", "apps/web", "tools/cli"])
        XCTAssertEqual(by["apps/web"]?["hints"], ["web": ["vite"]])
        XCTAssertEqual(by["apps/web"]?["workspace_root"], ".")
        XCTAssertEqual(by["apps/desktop"]?["hints"], ["desktop": ["electron"], "main": "main.js"])
        XCTAssertEqual(by["tools/cli"]?["hints"], ["bin": ["mycli"]])
        XCTAssertNil(by["tools/cli"]?["workspace_root"])
        XCTAssertEqual(by["api"]?["evidence"], ["api/app.py"])
        XCTAssertNil(by["."]?["scripts"]?["test"], "only the launch scripts")
        for i in 0..<12 { Sh.write("\(root)/many/p\(i)/package.json", "{}") }
        let capped = LaunchDiscovery.discover(root)
        XCTAssertEqual(capped["components"]?.array?.count, 8)
        XCTAssertEqual(capped["scan_truncated"], true)
        XCTAssertEqual(LaunchDiscovery.discover("relative/path")["components"], [])
    }

    func testTheToolsReachTheWorktreeOnly() throws {
        let root = repository("paths")
        let outside = "\(home)/outside-\(UUID().uuidString.prefix(4))"
        try FS.mkdirs(outside)
        try FileManager.default.createSymbolicLink(atPath: "\(root)/escape", withDestinationPath: outside)
        try FileManager.default.createSymbolicLink(atPath: "\(root)/dangling", withDestinationPath: "\(outside)/missing")
        XCTAssertEqual(try RunTools.worktreePath(root, "src/new.js"), "\(NodePath.real(root))/src/new.js")
        XCTAssertEqual(try RunTools.worktreePath(root), NodePath.real(root))
        for bad in ["..", "../x", "/etc/passwd", "escape/file", "dangling", "a/../../b", ".git/config", "x\0y"] { XCTAssertThrowsError(try RunTools.worktreePath(root, bad), bad) }
        XCTAssertTrue(RunTools.definitions.allSatisfy { $0.inputSchema["additionalProperties"] == false })
        XCTAssertThrowsError(try RunTools.validate("start_runnable", ["name": "web"])) { XCTAssertEqual($0.text, "Invalid tool arguments") }
        XCTAssertThrowsError(try RunTools.validate("declare_runnables", ["runnables": [["name": "x", "folder": ".", "type": "server"]]], kinds: RunTools.allKinds)) { XCTAssertEqual($0.text, "Invalid runnable type server: ui, app, terminal") }
        XCTAssertThrowsError(try RunTools.validate("run_command", ["command": "ls", "extra": 1]))
        XCTAssertThrowsError(try RunTools.validate("rm_rf", [:])) { XCTAssertTrue($0.text.contains("Unknown")) }
        for type in ["app", "terminal"] {
            XCTAssertThrowsError(try RunTools.validate("declare_runnables", ["runnables": [["name": "desktop", "folder": ".", "type": .string(type)]]])) {
                XCTAssertTrue($0.text.hasPrefix("desktop is not a web UI: for now the run step runs only web interfaces (\"ui\")"))
            }
            XCTAssertNoThrow(try RunTools.validate("declare_runnables", ["runnables": [["name": "desktop", "folder": ".", "type": .string(type)]]], kinds: RunTools.allKinds))
        }
        XCTAssertEqual(RunTools.runKinds, ["ui"])
    }

    func testRunCommandRefusesLaunchesAndFilesStayInside() async throws {
        let root = repository("commands")
        let none = RunTools.Handlers(declare: { _ in [:] }, start: { _ in [:] }, status: { [:] })
        let call = RunToolCaller(root: root, handlers: none, processes: procs(), key: "test")
        let ran = try await call.call("run_command", ["command": "pwd && echo made > made.txt", "cwd": "."])
        XCTAssertEqual(ran["exit_code"], 0)
        XCTAssertEqual(ran["output"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last, NodePath.real(root))
        XCTAssertEqual(Sh.read("\(root)/made.txt"), "made\n")
        let exit3 = try await call.call("run_command", ["command": "exit 3"])
        XCTAssertEqual(exit3["exit_code"], 3)
        let slow = try await call.call("run_command", ["command": "sleep 5", "timeout_seconds": 1])
        XCTAssertEqual(slow["timed_out"], true)
        for refused in ["npm run dev", "npm start", "yarn dev", "kill 1", "pkill node", "node server.cjs &", "nohup node x", "sudo ls", "vite", "open -a Calculator", "npx electron ."] {
            do { _ = try await call.call("run_command", ["command": .string(refused)]); XCTFail(refused) } catch { XCTAssertTrue(error.text.contains("start_runnable"), refused) }
        }
        let viteBuild = try await call.call("run_command", ["command": "echo vite build ok"])
        XCTAssertEqual(viteBuild["exit_code"], 0)
        _ = try await call.call("write_file", ["path": "src/fix.js", "content": "fixed\n"])
        let fixRead = try await call.call("read_file", ["path": "src/fix.js"])
        XCTAssertEqual(fixRead, ["content": "fixed\n", "truncated": false])
        let listing = try await call.call("list_files", [:])
        XCTAssertTrue(listing["entries"]?.array?.contains("src/") == true)
        do { _ = try await call.call("write_file", ["path": "../out.txt", "content": "x"]); XCTFail() } catch { XCTAssertTrue(error.text.contains("inside the repository")) }
        await call.close()
        do { _ = try await call.call("list_files", [:]); XCTFail() } catch { XCTAssertTrue(error.text.contains("closed")) }
    }

    func testEngelbartsProcessesAndTheirChecks() async throws {
        let root = repository("processes")
        let p = procs()
        let port = RunProcesses.freePort()
        try await p.start("web", "PORT=\(port) node server.cjs", root)
        let web = await p.check("web", type: "ui", port: port)
        XCTAssertTrue(web.ok); XCTAssertEqual(web.url, "http://localhost:\(port)/")
        let pid = p.status("web")["pid"]!.int!
        let stopped = await p.stop("web")
        XCTAssertTrue(stopped)
        let answering = await RunStepTests.answers("http://localhost:\(port)/")
        XCTAssertFalse(answering, "nothing answers after stop")
        XCTAssertNotEqual(kill(-Int32(pid), 0), 0, "the group is gone")
        try await p.start("dead", "node -e \"console.error('boom'); process.exit(2)\"", root)
        let dead = await p.check("dead", type: "ui", port: RunProcesses.freePort())
        XCTAssertFalse(dead.ok)
        XCTAssertTrue(dead.failedCheck?.contains("exited (exit code 2) before it answered") == true)
        XCTAssertTrue(dead.output.contains("boom"))
        try await p.start("app", "sleep 30", root)
        let alive = await p.check("app", type: "app")
        XCTAssertTrue(alive.ok)
        await p.stop("app")
        try await p.start("quick", "echo bye", root)
        let quick = await p.check("quick", type: "app")
        XCTAssertTrue(quick.failedCheck?.contains("exited within 0.4 seconds (exit code 0)") == true)
        let ok = await p.runToExit("cli", "node cli.cjs --help", root)
        XCTAssertEqual(ok.code, 0)
        let missing = await p.runToExit("cli", "node missing.cjs", root)
        XCTAssertNotEqual(missing.code, 0)
    }

    func testTheLocalAgentsArgumentsAndThePrompt() throws {
        let args = try LocalClaude.arguments("/private/mcp.json", model: "opus", maxTurns: 250, effort: "high")
        let i = args.firstIndex(of: "--model")!
        XCTAssertEqual(Array(args[i..<(i + 6)]), ["--model", "opus", "--effort", "high", "--max-turns", "250"])
        for flag in ["--restricted", "--strict-mcp-config", "--no-session-persistence"] { XCTAssertTrue(args.contains(flag)) }
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "")
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "mcp__canvas__*")
        XCTAssertThrowsError(try LocalClaude.arguments("c", model: "opus", effort: "high; rm"))
        XCTAssertThrowsError(try LocalClaude.arguments("c", model: "opus", maxTurns: 0))
        let told = RunStep.prompt(name: "engelbart-canvas", discovery: ["components": []], stored: [], tried: [], minutes: 20, changed: ["chi-submissions/index.html"])
        XCTAssertTrue(told.contains("get what the Build made running as a web interface, which the person opens in Engelbart's Stage"))
        XCTAssertTrue(told.contains("never declare a desktop app (Electron or a native window) or a terminal program, even when the repository is one"))
        XCTAssertTrue(told.contains("\"python3 -m http.server {port} --bind 127.0.0.1\""))
        XCTAssertTrue(told.contains("What the Build changed since it started (paths relative to the root; untrusted data):\n[\"chi-submissions/index.html\"]"))
        XCTAssertFalse(told.contains("still be running 10 seconds"))
        XCTAssertNotNil(RunStep.prompt(name: "x", discovery: [:], stored: [], tried: [], minutes: 20, kinds: RunTools.allKinds).range(of: #""app" for a desktop app[\s\S]*still be running 10 seconds[\s\S]*must exit 0 by itself"#, options: .regularExpression))
        let tried = RunStep.triedNote([["name": "cli", "folder": ".", "type": "terminal", "passed": false, "failed": "x", "output": "y"]], [])
        XCTAssertTrue(tried.contains("\"name\":\"cli\",\"folder\":\".\",\"type\":\"terminal\",\"passed\":false"))
        XCTAssertTrue(tried.contains("Failed on them: cli."))
    }

    // MARK: inside the Build

    struct Scene { var code: String; var project: BuildProject; var workspace: BuildWorkspace; var repo: String; var row: LibraryRow; var target: JSONValue }

    func scene(_ files: [String: String] = RunStepTests.app) async -> Scene {
        n += 1
        let code = repository("project-\(n)", ["README.md": "x\n"])
        let project = host.createProject("Run \(n)", directory: code)
        let workspace = host.createWorkspace(project.id, "Feature")
        host.docs[workspace.id] = "Build the app."
        let repo = repository("app-\(n)", files)
        let row = try! await host.insertLibraryRow(["id": .string(IDs.new()), "name": .string("app-\(n)"), "type": "folder", "tags": ["git"], "folder_path": .string(repo), "project_id": .string(project.id)])
        return Scene(code: code, project: project, workspace: workspace, repo: repo, row: row, target: ["kind": "library", "id": .string(row.id)])
    }

    final class Seen: @unchecked Sendable { private let l = NSLock(); private var items: [LocalClaude.Run] = []; func add(_ r: LocalClaude.Run) { l.lock(); items.append(r); l.unlock() }; var list: [LocalClaude.Run] { l.lock(); defer { l.unlock() }; return items } }

    func manager(_ runner: BuildRunner, agent: @escaping RunStep.Agent, runnableTime: TimeInterval = RunStep.runnableTime) -> (BuildManager, Events, RunStep) {
        let events = Events()
        let step = RunStep(processes: procs(), prepareClaude: { LocalClaude.Auth(file: "claude", env: [:]) }, runAgent: agent, kinds: RunTools.allKinds,
                           openTerminal: { cwd, command in ["id": "term-1", "cwd": .string(cwd), "command": .string(command), "status": "running"] },
                           runnableTime: runnableTime, tick: 0.1)
        let config = BuildConfiguration(host: host, git: git, runner: runner, notify: { events.add($0, $1) }, runShell: { _, _, _ in ShellOutcome(ok: true, output: "") },
                                        runStep: step, keepDir: "\(host.root)/keep")
        return (BuildManager(config), events, step)
    }

    func stepped(_ m: BuildManager, _ s: Scene, _ id: String, turn: Int) async -> TaskRecord {
        let p = try! host.project(s.project.id)
        _ = await eventually(60) {
            guard let t = TaskStore.readTask(p, id), let step = t.obj("runStep") else { return false }
            let working = await m.isStepping(id)
            return step["turn"]?.int == turn && step["status"]?.string != "running" && !working
        }
        return TaskStore.readTask(p, id)!
    }

    func testAfterATurnTheRunnablesAreStartedCheckedAndKeptOnTheRecordUntilAccept() async throws {
        let s = await scene()
        let seen = Seen()
        let agent: RunStep.Agent = { input in
            seen.add(input)
            let use = { (name: String, args: JSONValue) in try await ToolBridge.use(input.bridge, name, args) }
            do { _ = try await use("start_runnable", ["name": "web", "run_command": "PORT={port} npm start"]); XCTFail() } catch { XCTAssertTrue(error.text.contains("not declared")) }
            let declared = try await use("declare_runnables", ["runnables": [["name": "web", "folder": ".", "type": "ui"], ["name": "cli", "folder": ".", "type": "terminal"]]])
            XCTAssertEqual(declared["runnables"]?.array?.map { $0["status"]!.string! }, ["waiting", "waiting"])
            do { _ = try await use("start_runnable", ["name": "web", "run_command": "npm start"]); XCTFail() } catch { XCTAssertTrue(error.text.contains("must hold {port}")) }
            let failed = try await use("start_runnable", ["name": "web", "run_command": "node nowhere.cjs {port}"])
            XCTAssertEqual(failed["ok"], false)
            let web = try await use("start_runnable", ["name": "web", "run_command": "PORT={port} npm start"])
            XCTAssertEqual(web["ok"], true)
            let again = try await use("start_runnable", ["name": "web", "run_command": "PORT={port} npm start"])
            XCTAssertEqual(again["url"], web["url"]); XCTAssertTrue(again["message"]?.string?.contains("already passed") == true)
            let started = try await use("start_runnable", ["name": "cli", "run_command": "node cli.cjs --help"])
            XCTAssertEqual(started["ok"], true)
            return "web and cli run."
        }
        let (m, events, _) = manager(Scripted([.text("Built it.")]), agent: agent)
        let id = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id, provider: "anthropic", model: "opus", effort: "max", target: s.target))["id"]!.string!
        let task = await stepped(m, s, id, turn: 1)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual(task.obj("runStep")?["status"], "done")
        let web = task.obj("runStep")!["runnables"]!.array!.first { $0["name"] == "web" }!
        XCTAssertEqual(web["status"], "running")
        let runsNow = await RunStepTests.answers(web["url"]?.string)
        XCTAssertTrue(runsNow)
        XCTAssertEqual([seen.list[0].model, seen.list[0].effort], ["opus", "max"])
        XCTAssertEqual(seen.list[0].server, "run")
        XCTAssertTrue(seen.list[0].prompt.contains("\"cwd\":\".\""))
        let rows = try await RunnableStore(host.table).list(s.row.id)
        XCTAssertEqual(rows, [], "nothing is written while it runs")
        XCTAssertFalse(events.all.contains { $0.0 == "engelbart:build-run" }, "nothing is shown until Review opens it")
        XCTAssertNotNil(task.arr("messages").last!["text"]!.string!.range(of: #"^Run step: web \(web UI\) runs at http://localhost:\d+/; cli \(terminal\) runs\.$"#, options: .regularExpression))
        _ = try await m.showRunnable(s.project.id, id, "web")
        XCTAssertEqual(events.all.last { $0.0 == "engelbart:build-run" }?.1["kind"], "ui")
        _ = try await m.showRunnable(s.project.id, id, "cli")
        XCTAssertEqual(events.all.last { $0.0 == "engelbart:build-run" }?.1["session"]?["id"], "term-1")
        do { _ = try await m.showRunnable(s.project.id, id, "nothing"); XCTFail() } catch { XCTAssertTrue(error.text.contains("not running")) }
        _ = try await m.discard(s.project.id, id)
        let afterDiscard = await RunStepTests.answers(web["url"]?.string)
        XCTAssertFalse(afterDiscard, "Discard stops it")
        XCTAssertTrue(record(s, id).obj("runStep")!["runnables"]!.array!.allSatisfy { $0["status"] == "stopped" })
    }

    func record(_ s: Scene, _ id: String) -> TaskRecord { TaskStore.readTask(try! host.project(s.project.id), id)! }

    func testRunStepChangesAreItsOwnCheckpointAndAcceptKeepsWhatPassed() async throws {
        let s = await scene(RunStepTests.app.merging(["server.cjs": "require('node:http').createServer((q, r) => r.end('hi')).listen(4999, 'localhost');\n"]) { _, b in b })
        let seen = Seen()
        let agent: RunStep.Agent = { input in
            seen.add(input)
            let use = { (name: String, args: JSONValue) in try await ToolBridge.use(input.bridge, name, args) }
            _ = try await use("declare_runnables", ["runnables": [["name": "web", "folder": ".", "type": "ui"]]])
            _ = try await use("write_file", ["path": "server.cjs", "content": "require('node:http').createServer((q, r) => r.end('hi')).listen(Number(process.env.PORT), 'localhost');\n"])
            let started = try await use("start_runnable", ["name": "web", "run_command": "PORT={port} node server.cjs"])
            XCTAssertEqual(started["ok"], true)
            return "web runs; server.cjs now reads PORT."
        }
        let build = Scripted([.run { Sh.write("\($0.task.str("worktree")!)/feature.js", "one\n"); return "Added feature.js." }])
        let (m, _, _) = manager(build, agent: agent)
        let id = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id, target: s.target))["id"]!.string!
        let task = await stepped(m, s, id, turn: 1)
        XCTAssertEqual(task.arr("checkpoints").map { $0["step"]?.string ?? "turn" }, ["turn", "run"])
        let review = try await m.review(s.project.id, id)
        XCTAssertEqual(review["files"]?.array?.compactMap { $0["path"]?.string }, ["feature.js"], "the Build's own work")
        XCTAssertEqual(review["runStep"]?["apart"], true)
        XCTAssertEqual(review["runStep"]?["files"]?.array?.compactMap { $0["path"]?.string }, ["server.cjs"])
        let url = task.obj("runStep")!["runnables"]!.array![0]["url"]!.string!
        _ = try await m.accept(s.project.id, id)
        let accepted = record(s, id)
        let still = await RunStepTests.answers(url)
        XCTAssertTrue(still, "Accept keeps it running, on what landed")
        XCTAssertEqual(accepted.str("status"), "accepted"); XCTAssertTrue(accepted.truthy("keptCopy"))
        XCTAssertTrue(Sh.read("\(s.repo)/server.cjs").contains("process.env.PORT"), "the run step's change lands with the Build")
        let kept = try await RunnableStore(host.table).list(s.row.id)
        XCTAssertEqual(kept.map { [$0.name, $0.type, $0.status, $0.runCommand ?? "", $0.verifiedCommit ?? ""] }, [["web", "ui", "verified", "PORT={port} node server.cjs", accepted.obj("accepted")!["sha"]!.string!]])
        _ = try await m.stopRunnable(s.project.id, id, nil)
        let gone = await RunStepTests.answers(url)
        XCTAssertFalse(gone)
        XCTAssertFalse(record(s, id).truthy("keptCopy"))
        XCTAssertEqual(record(s, id).arr("messages").last?["text"], "Stopped web. Nothing of it runs now, and its copy is removed.")
    }

    func testNoRunStepForAQuickTaskOrANeedsYouAndAFailingAgentLeavesTheBuildAsItWas() async throws {
        let s = await scene()
        let seen = Seen()
        let agent: RunStep.Agent = { input in seen.add(input); throw BuildError("Sign in to your Claude subscription using Claude Code in the Canvas terminal.") }
        let (m, _, _) = manager(Scripted([.text("Fixed."), .text("Half done.\n\nNEEDS YOU: Which port?"), .text("Done now.")]), agent: agent)
        let quick = try await m.start(s.project.id, BuildStart(kind: "quick", text: "fix the typo"))["id"]!.string!
        _ = await eventually(30) { TaskStore.readTask(try! self.host.project(s.project.id), quick)?.str("status") == "accepted" }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(record(s, quick).obj("runStep")); XCTAssertEqual(seen.list.count, 0)
        let id = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id, target: s.target))["id"]!.string!
        _ = await eventually(30) { self.record(s, id).str("status") == "needs-you" }
        XCTAssertNil(record(s, id).obj("runStep"))
        _ = try await m.reply(s.project.id, id, "Any port.")
        let task = await stepped(m, s, id, turn: 2)
        XCTAssertEqual(task.str("status"), "review")
        XCTAssertEqual(task.obj("runStep")?["status"], "failed")
        XCTAssertTrue(task.arr("messages").last!["text"]!.string!.hasPrefix("Run step failed: Sign in"))
        _ = try await m.discard(s.project.id, id)
    }

    func testTheFakeAgentFindsAStartScriptAndABin() async throws {
        let s = await scene()
        let (m, _, _) = manager(Scripted([.text("Built it.")]), agent: FakeRunAgent.make(kinds: RunTools.allKinds))
        let id = try await m.start(s.project.id, BuildStart(workspaceId: s.workspace.id, target: s.target))["id"]!.string!
        let task = await stepped(m, s, id, turn: 1)
        XCTAssertEqual(task.obj("runStep")!["runnables"]!.array!.map { "\($0["name"]!.string!) \($0["type"]!.string!) \($0["status"]!.string!)" }, ["web ui running", "cli terminal running"])
        await m.stopAll()
    }

    func testALeftoverGroupIsStoppedOnlyInsideItsCopy() async throws {
        let inside = "\(home)/leftover", elsewhere = "\(home)/elsewhere"
        try FS.mkdirs(inside); try FS.mkdirs(elsewhere)
        let child = try ChildProcess(executable: "/bin/sleep", arguments: ["30"], environment: [:], directory: inside, newSession: true, stdin: false)
        try? await Task.sleep(nanoseconds: 200_000_000)
        let elsewhereStopped = await RunProcesses.stopLeftover(child.pid, within: elsewhere)
        XCTAssertFalse(elsewhereStopped, "not in that copy: left alone")
        XCTAssertTrue(child.isRunning)
        let nothing = await RunProcesses.stopLeftover(123456789, within: inside)
        XCTAssertFalse(nothing)
        let stopped = await RunProcesses.stopLeftover(child.pid, within: inside)
        XCTAssertTrue(stopped)
        _ = await child.wait()
        XCTAssertFalse(child.isRunning)
    }
}
