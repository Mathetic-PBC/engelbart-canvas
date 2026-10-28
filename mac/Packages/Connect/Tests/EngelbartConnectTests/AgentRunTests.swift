import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// The tool manager as the Tools package gives it: where each CLI is, its lock, and the check after an unavailable run.
final class FakeToolManager: ConnectToolManager, @unchecked Sendable {
    let bin: String?
    let lock = NSLock()
    var ensured: [String] = [], used: [String] = [], checked: [[String]] = []
    init(bin: String?) { self.bin = bin }
    func binaryFor(_ name: String) -> String? { bin.map { "\($0)/\(name)" } }
    func environment() -> [String: String] { ["ENGELBART_TOOLS_ENV": "1"] }
    func ensure(_ cli: String) async throws { lock.lock(); ensured.append(cli); lock.unlock() }
    func use<T>(_ cli: String, _ work: () async throws -> T) async throws -> T { lock.lock(); used.append(cli); lock.unlock(); return try await work() }
    func check(_ clis: [String]) async { lock.lock(); checked.append(clis); lock.unlock() }
}

/// The Engelbart terminal as the Terminal package gives it, replaying recorded lines (browse turns).
final class FakeTerminal: AgentTerminal, @unchecked Sendable {
    let lines: [String]
    let exitCode: Int32
    var commands: [(command: String, env: [String: String])] = []
    var onRun: ((String, [String: String]) -> Void)?
    init(lines: [String], exitCode: Int32 = 0) { self.lines = lines; self.exitCode = exitCode }
    func run(command: String, environment: [String: String], directory: String, signal: AbortSignal?, timeout: TimeInterval, onLine: @escaping (String) -> Void) async -> (output: String, exitCode: Int32, timedOut: Bool, stopped: Bool) {
        commands.append((command, environment))
        onRun?(command, environment)
        for line in lines { onLine(line) }
        return (lines.joined(separator: "\n"), exitCode, false, false)
    }
}

final class AgentRunTests: XCTestCase {
    let anthropic = ConnectModels.choice("anthropic", models: nil)
    let openai = ConnectModels.choice("openai", models: nil)

    func agents(_ fake: FakeCLIs, tools: FakeToolManager? = nil, terminal: AgentTerminal? = nil) -> CLIAgents {
        CLIAgents(environment: fake.environment, runDirectory: fake.root + "/runs", interviewHome: fake.root + "/interview", codexAuthFile: fake.auth,
                  tools: tools ?? FakeToolManager(bin: fake.dir), terminal: terminal, retryWaits: [0, 0], sleep: { _, _ in })
    }

    // agents.cjs claudeTurn: the exact command line, the system prompt and the message through files, the result line.
    func testClaudeInterviewTurn() async throws {
        let fake = try FakeCLIs(claudeLines: [
            #"{"type":"system","subtype":"init","session_id":"x"}"#,
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/notes/a.md"}}]}}"#,
            #"{"type":"result","subtype":"success","is_error":false,"result":"{\"say\":\"Hello.\"}"}"#])
        let tools = FakeToolManager(bin: fake.dir)
        var activity: [String] = []
        let out = try await agents(fake, tools: tools).turn(AgentTurnInput(choice: anthropic, kind: "interview", system: "SYSTEM TEXT", message: "Start.", dirs: ["/tmp/notes"],
                                                                         onUpdate: { if let a = $0.activity { activity.append(a) } }, meta: AgentMeta(kind: "interview")))
        XCTAssertEqual(out.text, #"{"say":"Hello."}"#)
        XCTAssertTrue(JS.test(out.session ?? "", AgentKinds.uuidRE, options: .caseInsensitive))
        let args = fake.args("claude")
        XCTAssertEqual(Array(args.prefix(4)), ["-p", "--output-format", "stream-json", "--verbose"])
        XCTAssertTrue(args.contains("--session-id")); XCTAssertFalse(args.contains("--no-session-persistence"), "the interview is kept for --resume")
        XCTAssertTrue(args.contains("--restricted") && args.contains("--strict-mcp-config") && args.contains("--no-chrome"))
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "Read,Grep,Glob")
        XCTAssertEqual(args[args.firstIndex(of: "--model")! + 1], anthropic.modelId)
        XCTAssertEqual(args[args.firstIndex(of: "--effort")! + 1], "high")
        XCTAssertEqual(args[args.firstIndex(of: "--add-dir")! + 1], "/tmp/notes")
        XCTAssertEqual(fake.file("claude-input-0"), "Start.")
        XCTAssertTrue(fake.file("claude-env-0").contains("ENGELBART_TOOLS_ENV=1"))
        XCTAssertEqual(tools.ensured, ["claude"]); XCTAssertEqual(tools.used, ["claude"])
        XCTAssertFalse(activity.isEmpty, "the Read said in words")
        // resumed: --resume with the id, and an import runs without session persistence
        _ = try await agents(fake).turn(AgentTurnInput(choice: anthropic, kind: "interview", system: "", message: "again", session: "0199aaaa-bbbb-cccc-dddd-eeeeffff0001", meta: AgentMeta(kind: "interview")))
        XCTAssertEqual(fake.args("claude", 1)[fake.args("claude", 1).firstIndex(of: "--resume")! + 1], "0199aaaa-bbbb-cccc-dddd-eeeeffff0001")
        _ = try await agents(fake).turn(AgentTurnInput(choice: anthropic, kind: "survey", system: "", message: "m", meta: AgentMeta(kind: "survey")))
        XCTAssertTrue(fake.args("claude", 2).contains("--no-session-persistence"))
    }

    // A bridged import: the MCP config file names Engelbart's server with the connection file, the connectors' tools allowed.
    func testClaudeBridgedImportAndErrors() async throws {
        let fake = try FakeCLIs(claudeLines: [#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#])
        let bridge = ToolBridge.Connection(url: "http://127.0.0.1:9/tools", token: String(repeating: "a", count: 64))
        do {
            _ = try await agents(fake).turn(AgentTurnInput(choice: anthropic, kind: "import", system: "", message: "m", bridge: bridge,
                                                          connectors: [ConnectorServer(app: "Granola", name: "granola", url: "https://mcp.granola.ai/mcp", token: "t")], toolNames: ["add_note"], meta: AgentMeta(kind: "import")))
            XCTFail("is_error")
        } catch { XCTAssertEqual((error as? ConnectError)?.message, "Not logged in · Please run /login"); XCTAssertEqual((error as? ConnectError)?.kind, "failed") }
        let args = fake.args("claude")
        XCTAssertTrue(args.contains("--mcp-config"))
        XCTAssertTrue(args[args.firstIndex(of: "--allowedTools")! + 1].contains("mcp__granola__list_meetings"))
        // Every file of the turn is removed after it.
        XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: fake.root + "/runs")) ?? [], [])
        // No result line and no CLI: unavailable, and the tool manager asked to check.
        let none = try FakeCLIs(claudeLines: ["not json"])
        do { _ = try await agents(none).turn(AgentTurnInput(choice: anthropic, kind: "survey", system: "", message: "m", meta: AgentMeta(kind: "survey"))); XCTFail() }
        catch { XCTAssertTrue((error as? ConnectError)?.message.hasPrefix("Claude Code did not return a result") == true, "\(error)") }
        let tools = FakeToolManager(bin: "/nonexistent-dir")
        do { _ = try await agents(none, tools: tools).turn(AgentTurnInput(choice: anthropic, kind: "survey", system: "", message: "m", meta: AgentMeta(kind: "survey"))); XCTFail() }
        catch { XCTAssertEqual((error as? ConnectError)?.message, "Claude Code was not found on the login shell PATH.") }
        let checkedAgain = await eventually(5) { tools.checked == [["claude"]] }
        XCTAssertTrue(checkedAgain, "an unavailable CLI is checked again")
        // A busy model is tried again, then gives up with the service's words.
        let busy = try FakeCLIs(claudeLines: [#"{"type":"result","is_error":true,"result":"API Error: 529 overloaded_error"}"#])
        var said: [String] = []
        do { _ = try await agents(busy).turn(AgentTurnInput(choice: anthropic, kind: "survey", system: "", message: "m", onUpdate: { if let a = $0.activity { said.append(a) } }, meta: AgentMeta(kind: "survey"))); XCTFail() }
        catch { XCTAssertTrue((error as? ConnectError)?.message.contains("overloaded") == true) }
        XCTAssertEqual(said, ["The model is busy: trying again", "The model is busy: trying again"])
        XCTAssertEqual(busy.args("claude", 2).isEmpty, false, "three runs in all")
    }

    // agents.cjs codexTurn: a ChatGPT sign-in copied into a home of the turn's own, the -o file read, the thread id kept.
    func testCodexTurns() async throws {
        let thread = "0199aaaa-bbbb-cccc-dddd-eeeeffff0003"
        let fake = try FakeCLIs(codexLines: [#"{"type":"thread.started","thread_id":"\#(thread)"}"#, #"{"type":"item.started","item":{"type":"command_execution","command":"bash -lc 'rg -n foo src'"}}"#], codexOut: "Done.")
        var activity: [String] = []
        let out = try await agents(fake).turn(AgentTurnInput(choice: openai, kind: "interview", system: "BE THE LIBRARIAN", message: "Start.", onUpdate: { if let a = $0.activity { activity.append(a) } }, meta: AgentMeta(kind: "interview")))
        XCTAssertEqual(out.text, "Done."); XCTAssertEqual(out.session, thread)
        let args = fake.args("codex")
        XCTAssertEqual(Array(args.prefix(4)), ["exec", "--color", "never", "--skip-git-repo-check"])
        XCTAssertTrue(args.contains("sandbox_mode=\"read-only\"")); XCTAssertTrue(args.contains("tools.web_search=false"))
        XCTAssertEqual(fake.file("codex-agents-0"), "BE THE LIBRARIAN", "the system prompt is the home's AGENTS.md")
        XCTAssertTrue(fake.file("codex-env-0").contains("CODEX_HOME=\(fake.root)/interview"))
        XCTAssertEqual(activity, ["Searching code for “foo”"])
        // resumed
        _ = try await agents(fake).turn(AgentTurnInput(choice: openai, kind: "interview", system: "", message: "x", session: thread, meta: AgentMeta(kind: "interview")))
        XCTAssertEqual(Array(fake.args("codex", 1).prefix(3)), ["exec", "resume", thread])
        // bridged import: config.toml with Engelbart's server and the connector's token in the environment; the home removed after
        let bridge = ToolBridge.Connection(url: "http://127.0.0.1:9/tools", token: String(repeating: "b", count: 64))
        _ = try await agents(fake).turn(AgentTurnInput(choice: openai, kind: "import", system: "", message: "m", bridge: bridge,
                                                      connectors: [ConnectorServer(app: "Granola", name: "granola", url: "https://mcp.granola.ai/mcp", token: "tok")], meta: AgentMeta(kind: "import")))
        XCTAssertTrue(fake.file("codex-config-2").contains("[mcp_servers.engelbart]"))
        XCTAssertTrue(fake.file("codex-config-2").contains("bearer_token_env_var = \"ENGELBART_CONNECTOR_GRANOLA\""))
        XCTAssertTrue(fake.file("codex-env-2").contains("ENGELBART_CONNECTOR_GRANOLA=tok"))
        XCTAssertTrue(fake.args("codex", 2).contains("tools.web_search=true"))
        let homes = ((try? FileManager.default.contentsOfDirectory(atPath: fake.root)) ?? []).filter { $0.hasPrefix("interview-import-") }
        XCTAssertEqual(homes, [], "the turn's own home is removed")
    }

    func testCodexFailures() async throws {
        let empty = try FakeCLIs(codexLines: [#"{"type":"turn.failed","error":{"message":"usage limit"}}"#], codexOut: "")
        do { _ = try await agents(empty).turn(AgentTurnInput(choice: openai, kind: "survey", system: "", message: "m", meta: AgentMeta(kind: "survey"))); XCTFail() }
        catch { XCTAssertTrue((error as? ConnectError)?.message.contains("turn.failed") == true, "\(error)") }
        let fake = try FakeCLIs(codexOut: "x")
        try #"{"auth_mode":"apikey","OPENAI_API_KEY":"sk"}"#.write(toFile: fake.auth, atomically: true, encoding: .utf8)
        do { _ = try await agents(fake).turn(AgentTurnInput(choice: openai, kind: "survey", system: "", message: "m", meta: AgentMeta(kind: "survey"))); XCTFail() }
        catch { XCTAssertEqual((error as? ConnectError)?.message, "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.") }
        XCTAssertTrue(fake.args("codex").isEmpty, "never run with an API key")
        let missing = try FakeCLIs()
        do { _ = try await agents(missing, tools: FakeToolManager(bin: "/nonexistent-dir")).turn(AgentTurnInput(choice: openai, kind: "survey", system: "", message: "m", meta: AgentMeta(kind: "survey"))); XCTFail() }
        catch { XCTAssertEqual((error as? ConnectError)?.message, "Codex was not found on the login shell PATH.") }
    }

    // Browse turns in the Engelbart terminal: the command, the steps' screenshots kept (≤80), the result read.
    func testBrowseInTheTerminal() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        let terminal = FakeTerminal(lines: [
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__claude-in-chrome__navigate","input":{"url":"https://docs.google.com/x"}}]}}"#,
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"\#(png)"}}]}]}}"#,
            #"{"type":"result","is_error":false,"result":"Read 3 docs."}"#])
        let fake = try FakeCLIs()
        let steps = fake.root + "/steps"
        var pictures: [String] = [], commands: [String] = [], transcript = ""
        let out = try await agents(fake, terminal: terminal).turn(AgentTurnInput(choice: anthropic, kind: "browse", system: "S", message: "m",
                                                                                onUpdate: { u in if let p = u.picture { pictures.append(p) }; if let c = u.command { commands.append(c) }; if let t = u.transcript { transcript = t } },
                                                                                browse: (steps: steps, enable: true, browser: "Chrome"), meta: AgentMeta(kind: "browse")))
        XCTAssertEqual(out.text, "Read 3 docs.")
        XCTAssertEqual(pictures, [steps + "/001.png"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: steps + "/001.png"))
        XCTAssertTrue(commands.first?.hasPrefix("claude -p --chrome") == true)
        XCTAssertTrue(terminal.commands[0].command.contains("--permission-mode auto"))
        XCTAssertFalse(transcript.isEmpty)
        // Codex: browser use enabled, the -o file read.
        let codexTerminal = FakeTerminal(lines: [#"{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}"#])
        codexTerminal.onRun = { _, env in try? "From Codex.".write(toFile: env["ENGELBART_CONNECT_OUTPUT"]!, atomically: true, encoding: .utf8) }
        let codexOut = try await agents(fake, terminal: codexTerminal).turn(AgentTurnInput(choice: openai, kind: "browse", system: "S", message: "m", browse: (steps: steps, enable: true, browser: "Chrome"), meta: AgentMeta(kind: "browse")))
        XCTAssertEqual(codexOut.text, "From Codex.")
        XCTAssertTrue(codexTerminal.commands[0].command.contains("--enable browser_use"))
        XCTAssertTrue(codexTerminal.commands[0].command.contains("--ephemeral"))
        // No terminal: said plainly.
        do { _ = try await agents(fake).turn(AgentTurnInput(choice: anthropic, kind: "browse", system: "", message: "m", browse: (steps: steps, enable: false, browser: "Chrome"), meta: AgentMeta(kind: "browse"))); XCTFail() }
        catch { XCTAssertEqual((error as? ConnectError)?.message, "The Engelbart terminal is not available here.") }
    }

    func testTimeoutsPerKind() {
        XCTAssertEqual(AgentKinds.timeouts["interview"], 10 * 60_000)
        XCTAssertEqual(AgentKinds.timeouts["import"], 45 * 60_000)
        XCTAssertEqual(AgentKinds.timeouts["redact"], 6 * 60_000)
    }
}
