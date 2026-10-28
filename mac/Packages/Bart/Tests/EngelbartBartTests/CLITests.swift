import XCTest
import EngelbartCore
import EngelbartDoc
@testable import EngelbartBart

// The real CLI paths with no real CLI: tiny `claude` and `codex` executables, first on PATH in the test's environment,
// print recorded event sequences (the shapes of test/bart.test.cjs and activity.cjs) and log what they were given. The
// login shell, the argument building, the process handling and the parsing are all the app's own.

final class FakeCLIs {
    let dir: String, log: String, home: String
    init(claudeLines: [String] = [], codexLines: [String] = [], codexOut: String = "", claudeExit: Int = 0) throws {
        let root = tempDir("fakecli").path
        dir = root + "/bin"; log = root + "/log"; home = root + "/home"
        for d in [dir, log, home] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
        try (claudeLines.joined(separator: "\n") + "\n").write(toFile: root + "/claude.jsonl", atomically: true, encoding: .utf8)
        try (codexLines.joined(separator: "\n") + "\n").write(toFile: root + "/codex.jsonl", atomically: true, encoding: .utf8)
        try codexOut.write(toFile: root + "/codex.out", atomically: true, encoding: .utf8)
        let claude = """
        #!/bin/sh
        n=$(ls "$FAKE_LOG" | grep -c claude-args)
        printf '%s\\n' "$@" > "$FAKE_LOG/claude-args-$n"
        cat > "$FAKE_LOG/claude-input-$n"
        cat "\(root)/claude.jsonl"
        exit \(claudeExit)
        """
        let codex = """
        #!/bin/sh
        n=$(ls "$FAKE_LOG" | grep -c codex-args)
        printf '%s\\n' "$@" > "$FAKE_LOG/codex-args-$n"
        out=""; prev=""
        for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
        cat > "$FAKE_LOG/codex-input-$n"
        env > "$FAKE_LOG/codex-env-$n"
        cat "\(root)/codex.jsonl"
        if [ -n "$out" ]; then cat "\(root)/codex.out" > "$out"; fi
        """
        for (name, text) in [("claude", claude), ("codex", codex)] {
            let path = dir + "/" + name
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            chmod(path, 0o755)
        }
        try #"{"auth_mode":"chatgpt","tokens":{"a":1}}"#.write(toFile: root + "/auth.json", atomically: true, encoding: .utf8)
    }
    var auth: String { (log as NSString).deletingLastPathComponent + "/auth.json" }
    /// The environment the app runs the CLIs from: these first on PATH, a home with no rc files.
    var environment: [String: String] { ["SHELL": "/bin/zsh", "HOME": home, "PATH": "\(dir):/usr/bin:/bin", "FAKE_LOG": log, "ANTHROPIC_API_KEY": "never-sent", "LANG": "en_US.UTF-8"] }
    /// One argument a line, as the fake wrote them (an empty argument is an empty line).
    func args(_ cli: String, _ n: Int = 0) -> [String] { Array(((try? String(contentsOfFile: "\(log)/\(cli)-args-\(n)", encoding: .utf8)) ?? "").components(separatedBy: "\n").dropLast()) }
    func input(_ cli: String, _ n: Int = 0) -> String { (try? String(contentsOfFile: "\(log)/\(cli)-input-\(n)", encoding: .utf8)) ?? "" }
    func env(_ n: Int = 0) -> String { (try? String(contentsOfFile: "\(log)/codex-env-\(n)", encoding: .utf8)) ?? "" }

    func bart(_ models: ModelsList, tweak: (inout Bart.Config) -> Void = { _ in }) -> Bart {
        let root = (log as NSString).deletingLastPathComponent
        var c = Bart.Config(readModels: { models }, environment: environment, runDirectory: root + "/runs", codexHome: root + "/ch", brainstormCodexHome: root + "/chb",
                            discoverCodexHome: root + "/chd", createCodexHome: root + "/chc", routerCodexHome: root + "/chr", makingCodexHome: root + "/chm")
        c.codexAuthFile = auth
        tweak(&c)
        return Bart(c)
    }
}

final class CLITests: XCTestCase {
    func testChatThroughClaudeCode() async throws {
        let store = TestStore(document: "@chat why?\nbart~> c1")
        let fake = try FakeCLIs(claudeLines: [
            #"{"type":"system","subtype":"init","session_id":"0199aaaa-bbbb-cccc-dddd-eeeeffff0002"}"#,
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"\#(store.dataRoot)/notes.md"}}]}}"#,
            #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"body"}]}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Because "}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"of the lock."}}}"#,
            #"{"type":"result","subtype":"success","is_error":false,"result":"Because of the lock."}"#,
        ])
        let log = RunLog()
        let bart = fake.bart(DEFAULTS) { $0.runLog = log }
        let progress = ProgressBox()
        let out = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "c1", ref: .workspace("w1"), workspaceId: "w1", text: "why?")) { progress.add($0) }
        XCTAssertEqual(out.lines.first, "bart> Because of the lock.")
        XCTAssertTrue(out.lines.last!.hasPrefix("bart> *Chat · Sonnet · high · "))
        XCTAssertTrue(progress.all.contains(.activity("Reading notes.md", log: true)), "\(progress.all)")
        let args = fake.args("claude")
        XCTAssertEqual(Array(args.prefix(6)), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id"])
        XCTAssertTrue(args.contains("--restricted") && args.contains("claude-sonnet-5-5") && args.contains(store.dataRoot))
        XCTAssertEqual(args[args.firstIndex(of: "--effort")! + 1], "high")
        XCTAssertTrue(fake.input("claude").hasSuffix("<question>\nwhy?\n</question>"))
        XCTAssertEqual(log.get("c1")?["steps"]?.array?.first?["tools"]?.array?.first?["name"], "Read")
    }

    func testChatThroughCodexAndResume() async throws {
        let store = TestStore(document: "@chat why?\nbart~> x1")
        let fake = try FakeCLIs(codexLines: [
            #"{"type":"thread.started","thread_id":"0199aaaa-bbbb-cccc-dddd-eeeeffff0003"}"#,
            #"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"/bin/zsh -lc 'cat notes.md'"}}"#,
            #"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"It loops."}}"#,
            #"{"type":"turn.completed","usage":{"input_tokens":1}}"#,
        ], codexOut: "It loops.")
        let bart = fake.bart(MODELS)
        let progress = ProgressBox()
        let out = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "x1", ref: .workspace("w1"), workspaceId: "w1", text: "why?")) { progress.add($0) }
        XCTAssertEqual(out.lines.first, "bart> It loops.")
        XCTAssertTrue(progress.all.contains(.activity("Reading notes.md", log: true)))
        // The preview flushes at most every 100 ms and a run that ends first sends none (createFeed's end clears its timer).
        let args = fake.args("codex")
        XCTAssertEqual(Array(args.prefix(4)), ["exec", "--color", "never", "--skip-git-repo-check"])
        XCTAssertTrue(args.contains("model_reasoning_effort=\"medium\"") && args.contains("sandbox_mode=\"read-only\"") && args.contains("tools.web_search=true"))
        let env = fake.env()
        XCTAssertFalse(env.contains("ANTHROPIC_API_KEY"), "never an API key")
        XCTAssertTrue(env.contains("CODEX_HOME="))
        _ = try await bart.ask(store: store, projectId: "p1", AskRequest(askId: "x2", ref: .workspace("w1"), workspaceId: "w1", text: "and?", turns: [AskTurn(question: "why?", answer: "It loops.")])) { _ in }
        let again = fake.args("codex", 1)
        XCTAssertEqual(Array(again.prefix(3)), ["exec", "resume", "0199aaaa-bbbb-cccc-dddd-eeeeffff0003"])
        XCTAssertEqual(fake.input("codex", 1).components(separatedBy: "<question>").count, 2)
        XCTAssertFalse(fake.input("codex", 1).contains("<engelbart>"), "a resumed session is sent the question alone")
    }

    func testClaudeCodeNotFoundAndFailed() async throws {
        let store = TestStore(document: "@chat q\nbart~> n1")
        let fake = try FakeCLIs()
        try FileManager.default.removeItem(atPath: fake.dir + "/claude")
        do { _ = try await fake.bart(DEFAULTS).ask(store: store, projectId: "p1", AskRequest(askId: "n1", ref: .workspace("w1"), workspaceId: "w1", text: "q")) { _ in }; XCTFail() }
        catch { XCTAssertEqual(error as? BartError, BartError("unavailable", "Claude Code was not found on the login shell PATH.")) }
        let failing = try FakeCLIs(claudeLines: [#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Rate limited"}"#])
        do { _ = try await failing.bart(DEFAULTS).ask(store: store, projectId: "p1", AskRequest(askId: "n2", ref: .workspace("w1"), workspaceId: "w1", text: "q")) { _ in }; XCTFail() }
        catch { XCTAssertEqual(error as? BartError, BartError("failed", "Rate limited")) }
    }

    func testSummarizerBothCLIs() async throws {
        let fake = try FakeCLIs(claudeLines: [#"{"type":"result","subtype":"success","is_error":false,"result":"A blurb  about it.","modelUsage":{"claude-opus-5-5":{}},"total_cost_usd":0.01,"usage":{"input_tokens":3}}"#],
                                codexLines: [#"{"type":"turn.completed","usage":{"input_tokens":5}}"#], codexOut: "A Codex blurb.")
        let root = tempDir("sum").path
        let claude = Summarizer.cli(readSettings: { ["provider": "claude"] }, environment: fake.environment, runDirectory: root, codexHome: root + "/ch", codexAuthFile: fake.auth)
        let out = try await claude("Note", "the text", "old", Prompts.summary, AgentShell.Stopper())
        XCTAssertEqual(out.summary, "A blurb about it.")
        XCTAssertEqual(out.meta["model"], "claude-opus-5-5"); XCTAssertEqual(out.meta["costUsd"], 0.01)
        XCTAssertEqual(fake.input("claude"), "<file name=\"Note\">\nthe text\n</file>\n\n<current_summary>\nold\n</current_summary>")
        let args = fake.args("claude")
        XCTAssertTrue(args.contains("--no-session-persistence") && args.contains("claude-opus-5-5"))
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "")
        let codex = Summarizer.cli(readSettings: { nil }, environment: fake.environment, runDirectory: root, codexHome: root + "/ch", codexAuthFile: fake.auth)
        let c = try await codex("Note", "the text", nil, Prompts.summary, AgentShell.Stopper())
        XCTAssertEqual(c.summary, "A Codex blurb."); XCTAssertEqual(c.meta["usage"]?["input_tokens"], 5)
        XCTAssertTrue(fake.args("codex").contains("--ephemeral") && fake.args("codex").contains("gpt-6-luna"))
        XCTAssertEqual(try String(contentsOfFile: root + "/ch/AGENTS.md", encoding: .utf8), Prompts.summary)
        do { _ = try await codex("Big", String(repeating: "x", count: Summarizer.maxInputChars + 1), nil, "", AgentShell.Stopper()); XCTFail() }
        catch { XCTAssertEqual((error as? SummaryError)?.kind, "too-long") }
        let none = Summarizer.cli(readSettings: { nil }, environment: fake.environment, runDirectory: root, codexHome: root + "/ch2", codexAuthFile: root + "/missing.json")
        do { _ = try await none("N", "t", nil, "", AgentShell.Stopper()); XCTFail() }
        catch { XCTAssertEqual((error as? SummaryError)?.kind, "unavailable") }
    }

    func testRouterAndNamerThroughTheCLIs() async throws {
        let fake = try FakeCLIs(claudeLines: [#"{"type":"result","subtype":"success","is_error":false,"result":"{\"agent\": \"discover\", \"sure\": 0.9}"}"#], codexOut: "Retry loops")
        let root = tempDir("route").path
        let router = Router.live(readModels: { DEFAULTS }, environment: fake.environment, runDirectory: root, codexHome: root + "/ch", codexAuthFile: fake.auth)
        let picked = await router.route(RouteRequest(projectId: "p", text: "--sonnet papers on tutors"))
        XCTAssertEqual(picked.agent, "discover"); XCTAssertEqual(picked.model?.name, "Haiku")
        XCTAssertTrue(fake.input("claude").hasSuffix("<line>\npapers on tutors\n</line>"), "model flags left out")
        let quick = QuickRun(environment: fake.environment, runDirectory: root, codexHome: root + "/chn", codexAuthFile: fake.auth)
        let named = await ChatNamer(readModels: { MODELS }, quickRun: quick)(text: "why do runs loop?", provider: "openai")
        XCTAssertEqual(named.title, "Retry loops"); XCTAssertTrue(named.named); XCTAssertEqual(named.modelName, "Luna")
        XCTAssertTrue(fake.args("codex").contains("tools.web_search=false"))
    }

    func testPapersMCPOverPipes() async throws {
        let papers = Papers(fetch: { url, _ in
            url.path == "/works/W1" ? (200, Data(#"{"id":"https://openalex.org/W1","title":"Tutors"}"#.utf8)) : (404, Data())
        }, wait: { _ in })
        let input = Pipe(), output = Pipe()
        let serving = Task { await PapersMCP.serve(papers: papers, input: input.fileHandleForReading, output: output.fileHandleForWriting) }
        let messages = [
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            #"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve","arguments":{"query":"W1"}}}"#,
            #"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"resolve","arguments":{"bad":1}}}"#,
        ]
        input.fileHandleForWriting.write(Data((messages.joined(separator: "\n") + "\n").utf8))
        try input.fileHandleForWriting.close()
        await serving.value
        try output.fileHandleForWriting.close()
        let lines = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).components(separatedBy: "\n").filter { !$0.isEmpty }.map { j($0) }
        XCTAssertEqual(lines.count, 4, "no answer to a notification")
        XCTAssertEqual(lines[0]["result"]?["serverInfo"]?["name"], "engelbart-papers")
        XCTAssertEqual(lines[1]["result"]?["tools"]?.array?.first?["annotations"]?["readOnlyHint"], true)
        XCTAssertTrue(lines[2]["result"]?["content"]?[0]?["text"]?.string?.contains("\"title\":\"Tutors\"") == true)
        XCTAssertEqual(lines[3]["result"]?["isError"], true)
        XCTAssertEqual(lines[3]["result"]?["content"]?[0]?["text"], "Invalid argument: bad.")
    }
}
