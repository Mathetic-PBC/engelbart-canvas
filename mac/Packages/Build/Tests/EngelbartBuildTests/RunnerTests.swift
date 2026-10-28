import XCTest
import EngelbartCore
@testable import EngelbartBuild

/// The runner parts of build.test.cjs: command lines for both CLIs (stubbed), the person's own setup, the git guard,
/// Engelbart's MCP server, the fake agent, the models.
final class RunnerTests: XCTestCase {
    var host: TestHost!
    override func setUp() { host = TestHost(); MCPLaunch.executable = "/Applications/Engelbart.app/Contents/MacOS/Engelbart" }
    override func tearDown() { host.cleanup() }

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        var items: [(command: String, env: [String: String], cwd: String, input: String?, settings: String?, mcp: String?)] = []
        func add(_ c: (command: String, env: [String: String], cwd: String, input: String?, settings: String?, mcp: String?)) { lock.lock(); items.append(c); lock.unlock() }
    }

    func stubbed(_ runner: CLIRunner, _ calls: Calls, codexOut: String = "codex did it", thread: String = "01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc", stream: String? = nil) {
        runner.execute = { shell, args, cwd, env, signal, timeout, onStdout in
            let command = args.last!
            calls.add((command, env, cwd, env["ENGELBART_BUILD_INPUT"].flatMap(FS.readText), env["ENGELBART_BUILD_SETTINGS"].flatMap(FS.readText), env["ENGELBART_BUILD_MCP"].flatMap(FS.readText)))
            if command.contains("codex") {
                try? FS.write(env["ENGELBART_BUILD_OUTPUT"]!, codexOut)
                let out = stream ?? "{\"type\":\"thread.started\",\"thread_id\":\"\(thread)\"}\n"
                onStdout(Data(out.utf8))
                return ExecResult(code: signal.isAborted ? nil : 0, signal: nil, stdout: out, stderr: "", aborted: signal.isAborted)
            }
            let out = stream ?? "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"claude did it\"}\n"
            onStdout(Data(out.utf8))
            return ExecResult(code: signal.isAborted ? nil : 0, signal: nil, stdout: signal.isAborted ? "" : out, stderr: "", aborted: signal.isAborted)
        }
    }

    func testCommandLinesForBothCLIsWithNoAPIKey() async throws {
        let auth = "\(host.root)/auth.json"
        try FS.write(auth, "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"x\"}}")
        let codexHome = "\(host.homeDir)/codex-home-build"
        let runner = CLIRunner(environment: ["PATH": "/usr/bin", "SHELL": "/bin/zsh", "HOME": host.homeDir, "ANTHROPIC_API_KEY": "sk-never", "OPENAI_API_KEY": "sk-never"],
                               runDirectory: "\(host.homeDir)/build-runs", codexHome: codexHome, codexAuthFile: auth)
        let calls = Calls()
        stubbed(runner, calls)
        let worktree = "\(host.homeDir)/wt"
        try FS.mkdirs(worktree)
        let policy = BuildPolicy.make(projectDir: "\(host.dataRoot)/p", dataRoot: host.dataRoot)
        let task: TaskRecord = ["id": "abcdef0123", "provider": "anthropic", "modelId": "opus", "effort": "high", "worktree": .string(worktree)]
        let claude = try await runner.turn(TurnInput(task: task, message: "do it", session: nil, system: "SYSTEM", policy: policy))
        XCTAssertEqual(claude.text, "claude did it")
        let c0 = calls.items[0]
        XCTAssertNotNil(c0.command.range(of: #"^exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id "\$ENGELBART_BUILD_SESSION" --setting-sources user,project,local --no-chrome --tools "Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch,Agent" --permission-mode auto --permission-prompts none --add-dir "\$ENGELBART_BUILD_DIR0" --add-dir "\$ENGELBART_BUILD_DIR1" --settings "\$ENGELBART_BUILD_SETTINGS" --model "\$ENGELBART_BUILD_MODEL" --effort high --append-system-prompt-file "\$ENGELBART_BUILD_PROMPT" < "\$ENGELBART_BUILD_INPUT"$"#, options: .regularExpression), c0.command)
        XCTAssertEqual([c0.env["ENGELBART_BUILD_DIR0"], c0.env["ENGELBART_BUILD_DIR1"]], policy.folders.map { Optional($0) })
        XCTAssertNil(c0.mcp, "no bridge, no engelbart server")
        XCTAssertNil(c0.env["GIT_CONFIG_PARAMETERS"], "no repository named, no git guard")
        XCTAssertEqual(c0.cwd, worktree)
        XCTAssertEqual(c0.input, "do it")
        XCTAssertNil(c0.env["ANTHROPIC_API_KEY"]); XCTAssertNil(c0.env["OPENAI_API_KEY"])
        XCTAssertFalse((try JSONValue.parse(c0.settings!))["permissions"]?["deny"]?.array?.isEmpty ?? true)
        _ = try await runner.turn(TurnInput(task: task, message: "again", session: claude.session, system: "SYSTEM", policy: policy))
        XCTAssertTrue(calls.items[1].command.contains("--resume \"$ENGELBART_BUILD_SESSION\""))
        XCTAssertEqual(calls.items[1].env["ENGELBART_BUILD_SESSION"], claude.session)
        var codexTask = task; codexTask["provider"] = "openai"; codexTask["modelId"] = "gpt-6-sol"
        let codex = try await runner.turn(TurnInput(task: codexTask, message: "do it", session: nil, system: "SYSTEM", policy: policy))
        XCTAssertEqual(codex, TurnOutput(text: "codex did it", session: "01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"))
        let c2 = calls.items[2]
        XCTAssertNotNil(c2.command.range(of: #"^exec codex exec --color never -m "\$ENGELBART_BUILD_MODEL" -c 'model_reasoning_effort="high"' -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' -c 'tools\.web_search=true' -c "\$ENGELBART_BUILD_C0" -c "\$ENGELBART_BUILD_C1" .* --json -o"#, options: .regularExpression), c2.command)
        XCTAssertEqual(c2.env["CODEX_HOME"], codexHome)
        let settings = (0..<20).compactMap { c2.env["ENGELBART_BUILD_C\($0)"] }
        XCTAssertEqual(settings, ["developer_instructions=\"SYSTEM\"", "features.multi_agent=true", "sandbox_workspace_write.writable_roots=[\"\(host.dataRoot)/p\"]", "features.computer_use=false", "features.browser_use=false", "features.browser_use_external=false"])
        XCTAssertFalse(FS.exists("\(codexHome)/AGENTS.md"))
        _ = try await runner.turn(TurnInput(task: codexTask, message: "again", session: codex.session, system: "SYSTEM", policy: policy))
        XCTAssertTrue(calls.items[3].command.hasPrefix("exec codex exec resume \"$ENGELBART_BUILD_SESSION\" -m"))
        XCTAssertEqual(FS.list("\(host.homeDir)/build-runs") ?? [], [], "nothing of a turn stays on disk")
        // a turn stopped part way keeps its session
        let stopped = CancelSignal(); stopped.abort()
        do { _ = try await runner.turn(TurnInput(task: task, message: "x", session: nil, system: "SYSTEM", policy: policy, signal: stopped)); XCTFail() }
        catch let e as TurnError { XCTAssertEqual(e.kind, "stopped"); XCTAssertEqual(e.session?.count, 36) }
        let cut = CLIRunner(environment: ["PATH": "/usr/bin", "SHELL": "/bin/zsh", "HOME": host.homeDir], runDirectory: "\(host.homeDir)/build-runs", codexHome: codexHome, codexAuthFile: auth)
        stubbed(cut, calls, codexOut: "", thread: "01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd")
        do { _ = try await cut.turn(TurnInput(task: codexTask, message: "x", session: nil, system: "SYSTEM", policy: policy, signal: stopped)); XCTFail() }
        catch let e as TurnError { XCTAssertEqual(e.kind, "stopped"); XCTAssertEqual(e.session, "01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd") }
    }

    func testEngelbartServerGitGuardAndThePersonsCodexHome() async throws {
        let personal = "\(host.homeDir)/person-codex"
        try FS.mkdirs(personal)
        try FS.write("\(personal)/auth.json", "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"x\"}}")
        try FS.write("\(personal)/config.toml", "model = \"gpt-6-sol\"\n\n[mcp_servers.computer-use]\ncommand = \"/Applications/Codex.app/cu\"\n")
        let runDirectory = "\(host.homeDir)/build-runs-reach"
        let runner = CLIRunner(environment: ["PATH": "/usr/bin", "SHELL": "/bin/zsh", "HOME": host.homeDir, "CODEX_HOME": personal], runDirectory: runDirectory)
        let calls = Calls()
        let connections = LockedStrings()
        runner.execute = { shell, args, cwd, env, signal, timeout, onStdout in
            let command = args.last!
            if let mcp = env["ENGELBART_BUILD_MCP"].flatMap(FS.readText), let file = (try? JSONValue.parse(mcp))?["mcpServers"]?["engelbart"]?["args"]?[2]?.string { connections.add(FS.readText(file) ?? "") }
            if let served = (0..<20).compactMap({ env["ENGELBART_BUILD_C\($0)"] }).first(where: { $0.hasPrefix("mcp_servers.engelbart.args=") }),
               let file = (try? JSONValue.parse(String(served.dropFirst(27))))?[2]?.string { connections.add(FS.readText(file) ?? "") }
            calls.add((command, env, cwd, nil, nil, env["ENGELBART_BUILD_MCP"].flatMap(FS.readText)))
            if command.contains("codex") { try? FS.write(env["ENGELBART_BUILD_OUTPUT"]!, "codex did it"); return ExecResult(code: 0, signal: nil, stdout: "{\"type\":\"thread.started\",\"thread_id\":\"01a0bc2d-7c18-77d2-8b21-3cc7e942cbce\"}\n", stderr: "") }
            return ExecResult(code: 0, signal: nil, stdout: "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"claude did it\"}\n", stderr: "")
        }
        let worktree = "\(host.homeDir)/wt-reach"
        try FS.mkdirs(worktree)
        let policy = BuildPolicy.make(projectDir: "\(host.dataRoot)/p", dataRoot: host.dataRoot, gitDir: "/repo/.git")
        let bridge = BridgeConnection(url: "http://127.0.0.1:1/tools", token: String(repeating: "a", count: 64))
        let task: TaskRecord = ["id": "abcdef0125", "provider": "anthropic", "modelId": "opus", "effort": "high", "worktree": .string(worktree)]
        _ = try await runner.turn(TurnInput(task: task, message: "do it", session: nil, system: "SYSTEM", policy: policy, engelbart: bridge))
        let c0 = calls.items[0]
        XCTAssertNotNil(c0.command.range(of: #"^PATH="\$ENGELBART_BUILD_GUARD:\$PATH"; exec claude -p .* --setting-sources user,project,local --mcp-config "\$ENGELBART_BUILD_MCP" --no-chrome --tools "#, options: .regularExpression), c0.command)
        let server = try JSONValue.parse(c0.mcp!)["mcpServers"]!["engelbart"]!
        XCTAssertEqual(server["command"]?.string, MCPLaunch.executable, "this app, as its own MCP server")
        XCTAssertEqual(Array(server["args"]!.array!.prefix(2)), ["--mcp", "engelbart"])
        XCTAssertEqual(try JSONValue.parse(connections.list[0]), ["url": .string(bridge.url), "token": .string(bridge.token)], "the bridge reaches the server through a file of its own")
        XCTAssertEqual(c0.env["ENGELBART_BUILD_GUARD"], "\(runDirectory)/git-guard/bin")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: "\(c0.env["ENGELBART_BUILD_GUARD"]!)/git"))
        XCTAssertEqual(c0.env["ENGELBART_BUILD_GIT_DIR"], "/repo/.git")
        XCTAssertNotNil(c0.env["GIT_CONFIG_PARAMETERS"]!.range(of: #"^'includeIf\.gitdir:/repo/\.git\.path'='[^']+build\.gitconfig' 'includeIf\.gitdir:/repo/\.git/\*\*\.path'="#, options: .regularExpression))
        var codexTask = task; codexTask["provider"] = "openai"; codexTask["modelId"] = "gpt-6-sol"
        let codex = try await runner.turn(TurnInput(task: codexTask, message: "do it", session: nil, system: "SYSTEM", policy: policy, engelbart: bridge))
        XCTAssertEqual(codex.text, "codex did it")
        let c1 = calls.items[1]
        XCTAssertTrue(c1.command.hasPrefix("PATH=\"$ENGELBART_BUILD_GUARD:$PATH\"; exec codex exec --color never "))
        XCTAssertNil(c1.env["CODEX_HOME"].flatMap { $0 == personal ? nil : $0 }, "the person's own Codex home")
        let settings = (0..<20).compactMap { c1.env["ENGELBART_BUILD_C\($0)"] }
        for value in ["developer_instructions=\"SYSTEM\"", "features.multi_agent=true", "features.computer_use=false", "features.browser_use=false", "mcp_servers.computer-use.enabled=false", "mcp_servers.engelbart.command=\"\(MCPLaunch.executable)\""] {
            XCTAssertTrue(settings.contains(value), value)
        }
        XCTAssertEqual(try JSONValue.parse(connections.list[1]), ["url": .string(bridge.url), "token": .string(bridge.token)])
        XCTAssertEqual(FS.list(runDirectory), ["git-guard"], "nothing of a turn stays on disk but the guard")
        try FS.write("\(personal)/auth.json", "{\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"sk-never\"}")
        do { _ = try await runner.turn(TurnInput(task: codexTask, message: "x", session: nil, system: "SYSTEM", policy: policy)); XCTFail() }
        catch let e as TurnError { XCTAssertEqual(e.kind, "unavailable"); XCTAssertTrue(e.message.contains("ChatGPT")) }
    }

    func testEngelbartsOwnGitFirstOnPathForAgentAndChecks() async throws {
        final class Tools: BuildTools, @unchecked Sendable {
            func use<T: Sendable>(_ agent: String, _ work: @Sendable () async throws -> T) async throws -> T { try await work() }
            func ensure(_ agent: String) async throws {}
            func environment() -> [String: String] { ["ENGELBART_GIT_BIN": "/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin"] }
            func binaryFor(_ name: String) -> String? { nil }
        }
        let calls = Calls()
        let runner = CLIRunner(environment: ["PATH": "/usr/bin", "SHELL": "/bin/zsh", "HOME": host.homeDir], runDirectory: "\(host.homeDir)/runs-git", tools: Tools())
        stubbed(runner, calls)
        try FS.mkdirs("\(host.homeDir)/wt-git")
        _ = try await runner.turn(TurnInput(task: ["id": "abcdef0124", "provider": "anthropic", "modelId": "opus", "effort": "high", "worktree": .string("\(host.homeDir)/wt-git")],
                                            message: "do it", session: nil, system: "SYSTEM", policy: BuildPolicy.make(projectDir: "\(host.dataRoot)/p", dataRoot: host.dataRoot)))
        XCTAssertEqual(calls.items[0].env["ENGELBART_GIT_BIN"], "/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin")
        XCTAssertEqual(LoginShell.arguments("/bin/zsh", "exec claude -p", calls.items[0].env), ["-ilc", "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; exec claude -p"])
        XCTAssertEqual(LoginShell.arguments("/bin/zsh", "npm test", [:]), ["-ilc", "npm test"], "without the tool check the command is left as it is")
    }

    func testRawEventsComeBeforeUpdatesAndAWatcherNeverBreaksTheTurn() async throws {
        let auth = "\(host.root)/auth-map.json"
        try FS.write(auth, "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"x\"}}")
        let worktree = "\(host.homeDir)/wt-map"
        try FS.mkdirs(worktree)
        let claudeEvents = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\",\"input\":{\"file_path\":\"\(worktree)/a.txt\"}}]}}\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"claude did it\"}\n"
        let runner = CLIRunner(environment: ["PATH": "/usr/bin", "SHELL": "/bin/zsh", "HOME": host.homeDir], runDirectory: "\(host.homeDir)/runs-map", codexHome: "\(host.homeDir)/ch", codexAuthFile: auth)
        stubbed(runner, Calls(), stream: claudeEvents)
        let order = LockedStrings()
        let updates = LockedStrings()
        _ = try await runner.turn(TurnInput(task: ["id": "abcdef0123", "provider": "anthropic", "modelId": "opus", "effort": "high", "worktree": .string(worktree)], message: "do it", session: nil, system: "S",
                                            policy: BuildPolicy.make(projectDir: "\(host.dataRoot)/p", dataRoot: host.dataRoot),
                                            onUpdate: { u in order.add("update"); if let a = u?.activity { updates.add(a) } }, onEvent: { _ in order.add("event") }))
        XCTAssertEqual(Array(order.list.prefix(2)), ["event", "update"])
        XCTAssertEqual(updates.list, ["Reading a.txt"])
        XCTAssertEqual(Activity.codexUpdate(["type": "item.started", "item": ["type": "command_execution", "command": "bash -lc 'cat src/x.js | head'"]], Activity.pathLabeller([])),
                       ActivityUpdate(activity: "Reading src/x.js", log: true))
        XCTAssertEqual(Activity.claudeUpdate(["type": "assistant", "message": ["content": [["type": "tool_use", "name": "mcp__engelbart__save_file", "input": ["name": "Notes"]]]]], Activity.pathLabeller([]))?.activity, "Saving “Notes” to Engelbart")
    }

    func testFakeAgentEditsAsksAndStops() async throws {
        let fake = FakeRunner(delayMs: 30)
        let worktree = "\(host.homeDir)/fake-wt"
        try FS.mkdirs(worktree)
        let task: TaskRecord = ["id": "abcdef0123", "kind": "build", "worktree": .string(worktree), "modelName": "Opus", "effort": "high"]
        let policy = BuildPolicy.make(projectDir: nil, dataRoot: nil)
        let events = LockedStrings()
        let first = try await fake.turn(TurnInput(task: task, message: "please ask a question", session: nil, system: "", policy: policy, onEvent: { events.add($0["type"]?.string ?? "") }))
        XCTAssertTrue(first.text.contains("NEEDS YOU: "))
        XCTAssertEqual(events.list, ["assistant", "user"], "its Write, and its result")
        let second = try await fake.turn(TurnInput(task: task, message: "<reply>\nkeep going\n</reply>", session: first.session, system: "", policy: policy))
        XCTAssertTrue(second.text.contains("the same session, continued"))
        XCTAssertEqual(Sh.read("\(worktree)/BUILD-FAKE.md"), "turn 1: first\nturn 2: keep going\n")
        let signal = CancelSignal()
        Task { try? await Task.sleep(nanoseconds: 5_000_000); signal.abort() }
        do { _ = try await fake.turn(TurnInput(task: task, message: "x", session: nil, system: "", policy: policy, signal: signal)); XCTFail() }
        catch let e as TurnError { XCTAssertEqual(e.kind, "stopped") }
        var quick = task; quick["kind"] = "quick"
        let escalated = try await fake.turn(TurnInput(task: quick, message: "escalate this", session: nil, system: "", policy: policy))
        XCTAssertTrue(escalated.text.hasPrefix("ESCALATE:"))
    }

    func testBuildHasModelsOfItsOwn() {
        let choices = BuildChoices.defaults
        XCTAssertEqual(choices.entry("openai")?.model("sol")?.id, "gpt-6.1-sol")
        XCTAssertEqual(choices.entry("anthropic")?.model("sonnet")?.id, "claude-sonnet-5-5")
        XCTAssertEqual(choices.provider, "anthropic")
        XCTAssertTrue(choices.entry("openai")!.start == ("sol", "high"))
        XCTAssertTrue(choices.entry("anthropic")!.start == ("opus", "high"))
        XCTAssertEqual(choices.resolve(provider: "anthropic"), .init(provider: "anthropic", model: "opus", modelId: "opus", modelName: "Opus", effort: "high"))
        XCTAssertEqual(choices.resolve(provider: "openai", model: "astra", effort: "ultra").modelId, "gpt-6-astra")
        XCTAssertEqual(choices.resolve(provider: "openai", model: "nope", effort: "max").effort, "high", "what the list does not offer falls back to the default")
        XCTAssertEqual(choices.resolve(), .init(provider: "anthropic", model: "opus", modelId: "opus", modelName: "Opus", effort: "high"))
        let round = BuildChoices(json: choices.json)
        XCTAssertEqual(round, choices)
        XCTAssertEqual(EffortLabels.label("xhigh"), "Extra high")
    }
}
