import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// test/sandbox-local.test.cjs (tools, bridge, adapter, Claude)
final class LocalToolsTests: XCTestCase {
    let root = SandboxToolsSpec.root

    func testValidationRejectsEscapesTypesAndUnsafeRoutes() throws {
        XCTAssertEqual(try SandboxToolsSpec.repoPath("src/../package.json"), "\(root)/package.json")
        for value in ["/etc/passwd", "../elsewhere", "\0"] { XCTAssertThrowsError(try SandboxToolsSpec.repoPath(value), value) }
        XCTAssertThrowsError(try SandboxToolsSpec.repoPath(JSONValue.number(1)))
        let bad: [(String, JSONValue)] = [
            ("run_command", ["command": 12]), ("run_command", ["command": "ls", "sandbox_id": "another"]),
            ("run_command", ["command": "ls", "timeout_seconds": 1000]), ("run_command", ["command": ""]),
            ("start_app", ["command": "npm start", "port": 43110]), ("start_app", ["command": "npm start", "port": 3000, "path": "//other.example/"]),
            ("start_app", ["command": "npm start", "port": 3000, "wait_for_install": "true"]),
            ("read_file", ["path": "../../secret"]), ("write_file", ["path": "a", "content": [:]]), ("delete_sandbox", [:]),
            ("declare_kind", ["kind": "desktop", "reason": "x"]), ("declare_kind", ["kind": "terminal", "reason": "  "]),
            ("terminal_ready", ["cwd": "../x", "hint": "make"]), ("terminal_ready", ["cwd": ".", "hint": "make\nrm"]),
            ("terminal_ready", ["cwd": ".", "hint": .string(String(repeating: "x", count: 201))]),
            ("dependency_install", ["action": "start"]), ("dependency_install", ["action": "skip", "reason": " "]),
            ("dependency_install", ["action": "status", "command": "npm ci"]),
            ("dependency_install", ["action": "start", "parallel": [["manager": "npm", "cwd": "a"], ["manager": "npm", "cwd": "b"]]]),
        ]
        for (name, args) in bad { XCTAssertThrowsError(try SandboxToolsSpec.validate(name, args), "\(name) \(args.text())") }
        XCTAssertNoThrow(try SandboxToolsSpec.validate("dependency_install", ["action": "start", "parallel": [["manager": "npm", "cwd": "web"], ["manager": "pip", "cwd": "api"]]]))
        XCTAssertNoThrow(try SandboxToolsSpec.validate("terminal_ready", ["cwd": "cli", "hint": "python main.py --help"]))
        XCTAssertEqual(SandboxToolsSpec.definitions.map(\.name), ["declare_kind", "terminal_ready", "run_command", "read_file", "write_file", "start_app", "app_status", "stop_app", "list_files", "dependency_install"])
    }

    func testToolsRunRemotelyBoundRedactAndSerialize() async throws {
        let sandbox = FakeSandbox()
        let active = Locked(0)
        sandbox.runHandler = { _, options in
            XCTAssertEqual(active.with { $0 += 1; return $0 }, 1)
            XCTAssertEqual(options.envs["npm_config_audit"], "false")
            XCTAssertEqual(options.envs["APP_KEY"], "test-secret")
            options.onStdout?("test-secret\n")
            try await Task.sleep(nanoseconds: 5_000_000)
            active.with { $0 -= 1 }
            return CommandResult(exitCode: 0)
        }
        sandbox.readHandler = { path, limit in XCTAssertEqual(path, "\(self.root)/package.json"); XCTAssertEqual(limit, 64_001); return Data("test-secret".utf8) }
        let events = Locked<[JSONValue]>([])
        let tools = SandboxTools(sandbox: sandbox, startApp: { args in ["port": args["port"]!] }, onEvent: { e in events.with { $0.append(e) } },
                                 signal: AbortSignal(), secrets: ["test-secret"], environment: ["APP_KEY": "test-secret"])
        async let a = tools.call("run_command", ["command": "npm ci"])
        async let b = tools.call("run_command", ["command": "ls"])
        let results = try await [a, b]
        XCTAssertEqual(sandbox.commands.value, ["cd '\(root)' && npm ci", "cd '\(root)' && ls"])
        XCTAssertEqual(results[0]["output"], "[redacted]\n")
        try await assertEqualAsync(try await tools.call("read_file", ["path": "package.json"])["content"], "[redacted]")
        XCTAssertFalse(JSONValue.array(events.value).text().contains("test-secret"))
        XCTAssertTrue(events.value.contains { $0["phase"] == "agent" && $0["message"] == "Reading package.json" })
        XCTAssertTrue(events.value.contains { $0["phase"] == "agent" && $0["tool_status"] == "done" })
        XCTAssertTrue(events.value.filter { ["stage", "log"].contains($0["phase"]?.string ?? "") }.allSatisfy { $0["actor"] == "setup-agent" })
        await assertThrows(try await tools.call("run_command", ["command": "npm run dev"]), "start_app to launch it")
        await assertThrows(try await tools.call("run_command", ["command": "echo ok; kill 12"]), "Do not start duplicate servers")
    }

    func testFileReadsStopAtTheLimit() async throws {
        let sandbox = FakeSandbox()
        sandbox.readHandler = { _, limit in Data(repeating: 65, count: limit) }
        let tools = SandboxTools(sandbox: sandbox, onEvent: { _ in })
        let result = try await tools.call("read_file", ["path": "large.txt"])
        XCTAssertEqual(result["content"]?.string?.count, 64_000)
        XCTAssertEqual(result["truncated"], true)
    }

    func testClosingDrainsAndRejectsQueuedWrites() async throws {
        let sandbox = FakeSandbox()
        let began = Deferred<Void>(), finish = Deferred<Void>()
        sandbox.writeHandler = { _, _ in began.resolve(()); try await finish.wait() }
        let tools = SandboxTools(sandbox: sandbox, onEvent: { _ in })
        let first = Task { try await tools.call("write_file", ["path": "first.txt", "content": "test"]) }
        try await began.wait()
        let second = Task { try await tools.call("write_file", ["path": "queued.txt", "content": "test"]) }
        try await Task.sleep(nanoseconds: 10_000_000)
        let drained = Locked(false)
        let closed = Task { await tools.close(); drained.with { $0 = true } }
        try await Task.sleep(nanoseconds: 10_000_000)
        await assertThrows(try await tools.call("write_file", ["path": "later.txt", "content": "test"]), "closed")
        XCTAssertFalse(drained.value)
        finish.resolve(())
        _ = try await first.value
        await assertThrows(try await second.value, "closed")
        await closed.value
        XCTAssertTrue(drained.value)
        XCTAssertEqual(Array(sandbox.files.value.keys), ["\(root)/first.txt"])
    }

    func testKindGatesAndFreeze() async throws {
        let sandbox = FakeSandbox()
        var kind: String?
        let kinds = SandboxKindsControl(declared: { kind }, declare: { k, _ in kind = k; return ["kind": .string(k)] },
                                        terminal: { cwd, hint in ["cwd": .string(cwd), "hint": .string(hint)] })
        let tools = SandboxTools(sandbox: sandbox, startApp: { _ in ["ok": true] }, appStatus: { _ in ["running": false] }, onEvent: { _ in }, kinds: kinds)
        await assertThrows(try await tools.call("run_command", ["command": "ls"]), "Call declare_kind first")
        try await assertEqualAsync(try await tools.call("app_status", [:])["running"], false, "reading is allowed")
        _ = try await tools.call("declare_kind", ["kind": "terminal", "reason": "A CLI"])
        await assertThrows(try await tools.call("start_app", ["command": "npm start", "port": 3000]), "declared terminal")
        let ready = try await tools.call("terminal_ready", ["cwd": "cli/./", "hint": " make test "])
        XCTAssertEqual(ready, ["cwd": "cli", "hint": "make test"])
        sandbox.runHandler = { _, _ in throw SandboxError("exit status 1", exitCode: 1) }
        await assertThrows(try await tools.call("terminal_ready", ["cwd": "missing", "hint": "make"]), "missing is not a directory in the repository")
        kind = "interface"
        await assertThrows(try await tools.call("terminal_ready", ["cwd": ".", "hint": "make"]), "declared interface")
        tools.freeze()
        await assertThrows(try await tools.call("write_file", ["path": "a", "content": "b"]), "already verified and ready")
        try await assertEqualAsync(try await tools.call("app_status", [:])["running"], false)
        let plain = SandboxTools(sandbox: sandbox, onEvent: { _ in })
        await assertThrows(try await plain.call("declare_kind", ["kind": "terminal", "reason": "x"]), "Unknown sandbox tool")
    }

    func testBridgeRefusesStrangersAndForwards() async throws {
        let bridge = try await ToolBridge.open({ name, args in try SandboxToolsSpec.validate(name, args); return ["ok": true] })
        defer { bridge.close() }
        let url = URL(string: bridge.connection.url)!
        func post(_ body: String, headers: [String: String] = [:], method: String = "POST") async throws -> (Int, JSONValue?) {
            var request = URLRequest(url: url)
            request.httpMethod = method
            if method == "POST" { request.httpBody = Data(body.utf8) }
            for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
            let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
            return ((response as! HTTPURLResponse).statusCode, try? JSONValue.parse(data))
        }
        try await assertEqualAsync(try await post("", method: "GET").0, 403)
        try await assertEqualAsync(try await post("{}").0, 403)
        let auth = ["authorization": "Bearer \(bridge.connection.token)", "content-type": "application/json"]
        try await assertEqualAsync(try await post("{}", headers: auth.merging(["origin": "https://repo.example"]) { a, _ in a }).0, 403)
        let invalid = try await post(#"{"name":"run_command","args":{"command":1}}"#, headers: auth)
        XCTAssertEqual(invalid.1?["isError"], true)
        let ok = try await post(#"{"name":"run_command","args":{"command":"pwd"}}"#, headers: auth)
        XCTAssertEqual(try JSONValue.parse(ok.1!["content"]![0]!["text"]!.string!), ["ok": true])
        try await assertEqualAsync(try await post(String(repeating: "x", count: 130_000), headers: auth).0, 413)
        XCTAssertTrue(bridge.connection.token.matches("^[a-f0-9]{64}$"))
    }

    func testStdioAdapterAdvertisesAndForwards() async throws {
        let bridge = try await ToolBridge.open({ name, args in
            XCTAssertEqual(name, "read_file"); XCTAssertEqual(args?["path"], "package.json")
            return ["content": "fixture"]
        })
        defer { bridge.close() }
        let dir = temporaryDirectory()
        let file = (dir as NSString).appendingPathComponent("bridge.json")
        try JSONValue.object(["url": .string(bridge.connection.url), "token": .string(bridge.connection.token)]).text().write(toFile: file, atomically: true, encoding: .utf8)
        let connection = try SandboxLocalMCP.connection(file)
        let sink = Pipe()
        let server = SandboxLocalMCP.server(connection, output: sink.fileHandleForWriting)
        let list = await server.handle(["jsonrpc": "2.0", "id": 1, "method": "tools/list"])
        XCTAssertEqual(list?["result"]?["tools"]?.array?.map { $0["name"]!.string! }, SandboxToolsSpec.definitions.map(\.name))
        let call = await server.handle(["jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": ["name": "read_file", "arguments": ["path": "package.json"]]])
        XCTAssertEqual(try JSONValue.parse(call!["result"]!["content"]![0]!["text"]!.string!)["content"], "fixture")
        try #"{"url":"https://example.com/tools","token":"x"}"#.write(toFile: file, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try SandboxLocalMCP.connection(file))
    }

    func testLocalClaudeEnvironmentStatusAndArguments() throws {
        let source = ["HOME": "/users/test", "SHELL": "/bin/zsh", "PATH": "/bin", "CLAUDE_CONFIG_DIR": "/users/test/.claude", "ANTHROPIC_API_KEY": "secret",
                      "ANTHROPIC_AUTH_TOKEN": "secret", "CLAUDE_CODE_OAUTH_TOKEN": "secret", "CLAUDECODE": "1", "E2B_API_KEY": "secret", "NODE_OPTIONS": "--inspect"]
        XCTAssertEqual(LocalClaude.subscriptionEnvironment(source), ["HOME": "/users/test", "SHELL": "/bin/zsh", "PATH": "/bin", "CLAUDE_CONFIG_DIR": "/users/test/.claude"])
        XCTAssertTrue(LocalClaude.subscriptionStatus(["loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"]))
        for status: JSONValue in [[:], ["loggedIn": true], ["loggedIn": true, "authMethod": "api_key"],
                                  ["loggedIn": true, "authMethod": "claude.ai", "apiProvider": "bedrock", "subscriptionType": "max"]] {
            XCTAssertFalse(LocalClaude.subscriptionStatus(status))
        }
        let args = try LocalClaude.arguments(config: "/private/mcp.json")
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "")
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "mcp__canvas__*")
        XCTAssertEqual(args[args.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
        XCTAssertTrue(args.contains("--restricted") && args.contains("--strict-mcp-config") && args.contains("--no-session-persistence"))
        XCTAssertEqual(args[args.firstIndex(of: "--max-turns")! + 1], "32")
        XCTAssertThrowsError(try LocalClaude.arguments(config: "c", model: "sonnet --bad"))
        XCTAssertThrowsError(try LocalClaude.arguments(config: "c", maxTurns: 501))
        XCTAssertThrowsError(try LocalClaude.arguments(config: "c", effort: "HIGH"))
        XCTAssertEqual(Array(try LocalClaude.arguments(config: "c", effort: "high").suffix(4)), ["--effort", "high", "--max-turns", "32"])
    }

    func testPrepareFindsClaudeWhereTheInstallerPutIt() async throws {
        let home = temporaryDirectory()
        let launcher = (home as NSString).appendingPathComponent(".local/bin/claude")
        try FileManager.default.createDirectory(atPath: (launcher as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: launcher, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        let asked = Locked<[String]>([])
        let run: LocalClaude.Exec = { _, args, _, _ in
            asked.with { $0.append(args[0]) }
            if args[0] == "-ilc" { throw SandboxError("not found") }
            if args[0] == "--version" { return "2.1.285 (Claude Code)\n" }
            return #"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}"#
        }
        let auth = try await LocalClaude.prepare(["HOME": home, "SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin"], run: run)
        XCTAssertEqual(auth.file, launcher)
        XCTAssertEqual(asked.value, ["-ilc", "--version", "auth"])
        let signedOut: LocalClaude.Exec = { _, args, _, _ in args[0] == "-ilc" ? "\(launcher)\n" : args[0] == "--version" ? "2.1.285\n" : #"{"loggedIn":false}"# }
        await assertThrows(try await LocalClaude.prepare(["HOME": home, "SHELL": "/bin/zsh"], run: signedOut), "not signed in")
        let old: LocalClaude.Exec = { _, args, _, _ in args[0] == "-ilc" ? "\(launcher)\n" : "2.1.200\n" }
        await assertThrows(try await LocalClaude.prepare(["HOME": home, "SHELL": "/bin/zsh"], run: old), "Update Claude Code to 2.1.248")
        let missing: LocalClaude.Exec = { _, _, _, _ in throw SandboxError("none") }
        await assertThrows(try await LocalClaude.prepare(["HOME": temporaryDirectory(), "SHELL": "/bin/zsh"], run: missing), "not installed yet")
    }

    final class FakeChild: ClaudeChild {
        var onStdout: ((String) -> Void)?
        var input = ""
        var signals: [Int32] = []
        let exit = Deferred<Int32>()
        var script: (FakeChild) -> Void = { _ in }
        func writeInput(_ text: String) { input += text; script(self) }
        func kill(_ signal: Int32) { signals.append(signal); exit.resolve(143) }
        func wait() async -> Int32 { (try? await exit.wait()) ?? 1 }
    }

    func testRunLocalClaudeStreamsAndCleansUp() async throws {
        let child = FakeChild()
        let seen = Locked<(String, [String], [String: String], String)?>(nil)
        child.script = { c in
            c.onStdout?(#"{"type":"system","subtype":"init","mcp_servers":[{"name":"canvas","status":"connected"}]}"# + "\n")
            c.onStdout?(#"{"type":"assistant","message":{"content":[{"type":"text","text":"Installing in E2B"}]}}"# + "\n" + #"{"type":"result","subtype":"suc"#)
            c.onStdout?(#"cess","is_error":false,"result":"done"}"# + "\n")
            c.exit.resolve(0)
        }
        let messages = Locked<[String]>([])
        let result = try await LocalClaude.run(auth: LocalClaudeAuth(file: "/bin/claude", env: ["HOME": "/users/test"]),
                                               bridge: ToolBridge.Connection(url: "http://127.0.0.1:1234/tools", token: String(repeating: "0", count: 64)),
                                               prompt: "Prepare this sandbox", onMessage: { m in messages.with { $0.append(m) } },
                                               spawnProcess: { file, args, env, cwd in
            seen.with { $0 = (file, args, env, cwd) }
            let mode = (try? FileManager.default.attributesOfItem(atPath: cwd)[.posixPermissions] as? Int) ?? 0
            XCTAssertEqual(mode & 0o777, 0o700)
            let config = try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: args[args.firstIndex(of: "--mcp-config")! + 1])))
            let connection = config["mcpServers"]!["canvas"]!["args"]!.array!.last!.string!
            XCTAssertEqual(((try? FileManager.default.attributesOfItem(atPath: connection)[.posixPermissions] as? Int) ?? 0) & 0o777, 0o600)
            XCTAssertEqual(config["mcpServers"]!["canvas"]!["args"]!.array!.prefix(2).map { $0.string! }, ["--mcp", "sandbox-local"])
            return child
        })
        XCTAssertEqual(result, "done")
        XCTAssertEqual(child.input, "Prepare this sandbox")
        XCTAssertEqual(messages.value, ["Installing in E2B"])
        XCTAssertNil(seen.value!.2["ANTHROPIC_API_KEY"])
        XCTAssertEqual(seen.value!.2["MCP_TOOL_TIMEOUT"], "240000")
        XCTAssertFalse(FileManager.default.fileExists(atPath: seen.value!.3))
    }

    func testRunLocalClaudeAbortAndToolFailure() async throws {
        let signal = AbortSignal()
        let child = FakeChild()
        child.script = { _ in DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { signal.abort() } }
        await assertThrows(try await LocalClaude.run(auth: LocalClaudeAuth(file: "claude", env: [:]), bridge: .init(url: "", token: ""), prompt: "t",
                                                     signal: signal, spawnProcess: { _, _, _, _ in child }), "abort")
        XCTAssertEqual(child.signals.first, SIGTERM)
        let disconnected = FakeChild()
        disconnected.script = { c in c.onStdout?(#"{"type":"system","subtype":"init","mcp_servers":[{"name":"canvas","status":"failed"}]}"# + "\n") }
        await assertThrows(try await LocalClaude.run(auth: LocalClaudeAuth(file: "claude", env: [:]), bridge: .init(url: "", token: ""), prompt: "t",
                                                     spawnProcess: { _, _, _, _ in disconnected }), "could not connect to the sandbox tools")
        let failed = FakeChild()
        failed.script = { c in c.onStdout?(#"{"type":"result","subtype":"error_max_turns","is_error":true}"# + "\n"); c.exit.resolve(1) }
        await assertThrows(try await LocalClaude.run(auth: LocalClaudeAuth(file: "claude", env: [:]), bridge: .init(url: "", token: ""), prompt: "t",
                                                     spawnProcess: { _, _, _, _ in failed }), "Claude Code did not finish: error_max_turns\\.")
    }

    func testGroupProcessRunsAndKillsItsGroup() async throws {
        let child = try GroupProcess(file: "/bin/sh", args: ["-c", "read line; echo got:$line"], env: ["PATH": "/bin:/usr/bin"], cwd: NSTemporaryDirectory())
        let out = Locked("")
        child.onStdout = { text in out.with { $0 += text } }
        child.writeInput("hello\n")
        let code = await child.wait()
        XCTAssertEqual(code, 0)
        XCTAssertEqual(out.value.trimmed, "got:hello")
        let sleeper = try GroupProcess(file: "/bin/sh", args: ["-c", "sleep 30 & wait"], env: ["PATH": "/bin:/usr/bin"], cwd: NSTemporaryDirectory())
        sleeper.kill(SIGTERM)
        let killed = await sleeper.wait()
        XCTAssertEqual(killed, 128 + SIGTERM)
    }
}
