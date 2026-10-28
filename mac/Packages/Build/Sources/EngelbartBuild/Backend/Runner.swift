import Foundation
import EngelbartCore

/// runner.cjs TurnError: kind is unavailable | failed | stopped. A turn stopped part way keeps its session, so the next one
/// can go on with it.
public struct TurnError: Error, LocalizedError, Sendable {
    public var kind: String
    public var message: String
    public var session: String?
    public init(_ kind: String, _ message: String, session: String? = nil) { self.kind = kind; self.message = message; self.session = session }
    public var errorDescription: String? { message }
}

/// The loopback bridge a turn's MCP server reaches (ToolBridge.connection).
public struct BridgeConnection: Codable, Sendable, Equatable {
    public var url: String
    public var token: String
    public init(url: String, token: String) { self.url = url; self.token = token }
}

/// What one turn is given (runner.cjs turn()).
public struct TurnInput: @unchecked Sendable {
    /// The record as the manager has it, with `worktree` already the folder the agent works in (task.cwd).
    public var task: TaskRecord
    public var message: String
    public var session: String?
    public var system: String
    public var policy: BuildPolicy
    public var engelbart: BridgeConnection?
    public var signal: CancelSignal
    public var timeout: TimeInterval
    public var onUpdate: (ActivityUpdate?) -> Void
    /// Each event the CLI streams, before it becomes an update (the Agent map's record); nil when nobody listens.
    public var onEvent: ((JSONValue) -> Void)?

    public init(task: TaskRecord, message: String, session: String?, system: String, policy: BuildPolicy, engelbart: BridgeConnection? = nil,
                signal: CancelSignal = CancelSignal(), timeout: TimeInterval = 3 * 3600, onUpdate: @escaping (ActivityUpdate?) -> Void = { _ in },
                onEvent: ((JSONValue) -> Void)? = nil) {
        self.task = task; self.message = message; self.session = session; self.system = system; self.policy = policy
        self.engelbart = engelbart; self.signal = signal; self.timeout = timeout; self.onUpdate = onUpdate; self.onEvent = onEvent
    }
}

public struct TurnOutput: Sendable, Equatable {
    public var text: String
    public var session: String?
    public init(text: String, session: String?) { self.text = text; self.session = session }
}

/// One turn of a Build agent. The real runner, the fake one (ENGELBART_BUILD_FAKE=1) and tests' scripted ones.
public protocol BuildRunner: Sendable {
    func turn(_ input: TurnInput) async throws -> TurnOutput
}

/// One turn of a Build agent (runner.cjs, 2026-09-25 B9–B12; the person's own setup since 2026-10-07): Claude Code or
/// Codex, hidden, on the person's subscription, in the Build's worktree, the way @bart runs them (the login shell, every
/// value through the environment, API keys removed, one process per turn, events read as they arrive) but able to write.
/// Flags verified on Claude Code 2.1.293 and codex-cli 0.160.0. Both get Engelbart's MCP server (this executable,
/// `--mcp engelbart <connection>`) when the turn has its bridge, and the git guard first on PATH when the policy names
/// the repository.
public final class CLIRunner: BuildRunner, @unchecked Sendable {
    public static let claudeTools = "Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch,Agent"
    public static let settingSources = "user,project,local"

    let environment: [String: String]
    let runDirectory: String
    let codexHome: String?
    let codexAuthFile: String?
    let tools: BuildTools?
    let shell: String
    /// Test hook: replaces running the shell; gets (shell, arguments, cwd, env) and returns stdout and the result.
    var execute: (@Sendable (String, [String], String, [String: String], CancelSignal, TimeInterval, @escaping (Data) -> Void) async -> ExecResult)?

    /// `codexHome`: the Codex home a Build uses, the person's own unless a test names one (CODEX_HOME, else ~/.codex).
    /// `runDirectory` holds what one turn needs on disk, and the git guard.
    public init(environment: [String: String] = ShellEnvironment.environment(), runDirectory: String, codexHome: String? = nil,
                codexAuthFile: String? = nil, tools: BuildTools? = nil) {
        self.environment = environment
        self.runDirectory = runDirectory
        self.codexHome = codexHome
        self.codexAuthFile = codexAuthFile
        self.tools = tools
        self.shell = LoginShell.resolveShell(environment)
    }

    func program(_ name: String) -> String { tools?.binaryFor(name) != nil ? "\"$ENGELBART_\(name.uppercased())_BIN\"" : name }
    func programEnv(_ name: String) -> [String: String] {
        guard let bin = tools?.binaryFor(name) else { return [:] }
        return ["ENGELBART_\(name.uppercased())_BIN": bin]
    }

    func childEnvironment(_ extra: [String: String]) -> [String: String] {
        var base = LoginShell.sanitize(LoginShell.scrubAgentSession(environment))
        for key in LoginShell.notTheSubscription { base[key] = nil }
        for (k, v) in tools?.environment() ?? [:] { base[k] = v } // Engelbart's own Git, when it stands in
        for (k, v) in extra { base[k] = v }
        return base
    }

    /// Whether Codex's auth.json is a ChatGPT sign-in (an API key is never used).
    static func chatGptSignIn(_ file: String) -> Bool {
        guard let auth = Files.readJSON(URL(fileURLWithPath: file)) else { return false }
        return auth["auth_mode"]?.string == "chatgpt" && auth["tokens"].map(isTruthy) == true
    }

    /// Whether the person's Codex config has an MCP server of that name (turning off one it lacks would make a half entry).
    static func codexHasServer(_ home: String, _ name: String) -> Bool {
        guard let config = FS.readText(NodePath.join(home, "config.toml")) else { return false }
        let key = NSRegularExpression.escapedPattern(for: name)
        return config.range(of: #"(?m)^\s*\[\s*mcp_servers\.(?:""# + key + #""|"# + key + #")\s*\]"#, options: .regularExpression) != nil
    }

    static func toml(_ value: JSONValue) -> String { value.text() } // a JSON string or array of strings is TOML too

    /// Codex's `-c` settings for a policy, each `key=value` in TOML.
    static func codexOverrides(_ policy: BuildPolicy, instructions: String, engelbart: (command: String, args: [String])?, home: String) -> [String] {
        var out = [
            "developer_instructions=\(toml(.string(instructions)))",
            "features.multi_agent=\(policy.subagents ? "true" : "false")",
            "sandbox_workspace_write.writable_roots=\(toml(.array(policy.writable.map(JSONValue.string))))",
        ]
        if !policy.computerUse {
            for feature in ["computer_use", "browser_use", "browser_use_external"] { out.append("features.\(feature)=false") }
            for server in BuildPolicy.computerUseServers where codexHasServer(home, server) { out.append("mcp_servers.\(server).enabled=false") }
        }
        if let engelbart {
            out.append("mcp_servers.engelbart.command=\(toml(.string(engelbart.command)))")
            out.append("mcp_servers.engelbart.args=\(toml(.array(engelbart.args.map(JSONValue.string))))")
        }
        return out
    }

    func run(_ command: String, cwd: String, env: [String: String], input: TurnInput, onEvent: @escaping (JSONValue) -> Void) async -> ExecResult {
        let reader = Activity.eventReader(onEvent)
        let args = LoginShell.arguments(shell, command, env)
        if let execute { return await execute(shell, args, cwd, env, input.signal, input.timeout, reader) }
        return await Exec.run(shell, args, environment: env, directory: cwd, timeout: input.timeout, signal: input.signal, onStdout: reader)
    }

    static func notFound(_ r: ExecResult) -> Bool { r.code == 127 || r.notFound }

    public func turn(_ input: TurnInput) async throws -> TurnOutput {
        let task = input.task
        let raw: (JSONValue) -> Void = { event in input.onEvent?(event) } // the map's problem, never the Build's
        try FS.mkdirs(runDirectory, mode: 0o700)
        let id = task.str("id") ?? "build"
        let stem = NodePath.join(runDirectory, "\(id)-\(IDs.new())")
        let inputFile = "\(stem).input.txt"
        try FS.write(inputFile, input.message, mode: 0o600)
        var connectionFile: String?
        if let bridge = input.engelbart {
            connectionFile = "\(stem).engelbart.json"
            try FS.write(connectionFile!, JSONValue.object(["url": .string(bridge.url), "token": .string(bridge.token)]).text(), mode: 0o600)
        }
        defer { for file in [inputFile, connectionFile].compactMap({ $0 }) { FS.unlink(file) } }
        let worktree = task.str("worktree") ?? FileManager.default.currentDirectoryPath
        let server: (command: String, args: [String])? = connectionFile.map { (MCPLaunch.executable, MCPLaunch.arguments("engelbart", [$0])) }
        let short = Activity.pathLabeller([worktree] + input.policy.folders)
        // The git ban: the guard first on PATH, after the login shell's startup files, and its config.
        var guarded: [String: String] = [:]
        if let gitDir = input.policy.gitDir {
            guarded = GitGuard.environment(try GitGuard.prepare(NodePath.join(runDirectory, "git-guard")), gitDir: gitDir, base: environment)
        }
        let guardFirst = guarded.isEmpty ? "" : GitGuard.path(shell)
        let provider = task.str("provider") ?? "anthropic"
        let effort = task.str("effort") ?? "high"
        let modelId = task.str("modelId") ?? ""

        if provider == "anthropic" {
            let promptFile = "\(stem).system.md", settingsFile = "\(stem).settings.json", mcpFile = "\(stem).mcp.json"
            defer { for f in [promptFile, settingsFile, mcpFile] { FS.unlink(f) } }
            try FS.write(promptFile, input.system, mode: 0o600)
            try FS.write(settingsFile, input.policy.claudeSettings().text(), mode: 0o600)
            if let server {
                try FS.write(mcpFile, JSONValue.object(["mcpServers": ["engelbart": ["type": "stdio", "command": .string(server.command), "args": .array(server.args.map(JSONValue.string)), "env": [:]]]]).text(), mode: 0o600)
            }
            let sessionId = input.session ?? IDs.new()
            let grants = input.policy.folders.indices.map { "--add-dir \"$ENGELBART_BUILD_DIR\($0)\"" }.joined(separator: " ")
            let command = "\(guardFirst)exec \(program("claude")) -p --output-format stream-json --verbose --include-partial-messages \(input.session != nil ? "--resume" : "--session-id") \"$ENGELBART_BUILD_SESSION\" --setting-sources \(CLIRunner.settingSources)\(server != nil ? " --mcp-config \"$ENGELBART_BUILD_MCP\"" : "") --no-chrome --tools \"\(CLIRunner.claudeTools)\" --permission-mode auto --permission-prompts none \(grants) --settings \"$ENGELBART_BUILD_SETTINGS\" --model \"$ENGELBART_BUILD_MODEL\" --effort \(effort) --append-system-prompt-file \"$ENGELBART_BUILD_PROMPT\" < \"$ENGELBART_BUILD_INPUT\""
            var extra = programEnv("claude").merging(guarded) { _, b in b }
            extra["ENGELBART_BUILD_SESSION"] = sessionId
            extra["ENGELBART_BUILD_MODEL"] = modelId
            extra["ENGELBART_BUILD_PROMPT"] = promptFile
            extra["ENGELBART_BUILD_SETTINGS"] = settingsFile
            if server != nil { extra["ENGELBART_BUILD_MCP"] = mcpFile }
            extra["ENGELBART_BUILD_INPUT"] = inputFile
            for (n, dir) in input.policy.folders.enumerated() { extra["ENGELBART_BUILD_DIR\(n)"] = dir }
            let env = childEnvironment(extra)
            let out = await run(command, cwd: worktree, env: env, input: input) { event in raw(event); input.onUpdate(Activity.claudeUpdate(event, short)) }
            if input.signal.isAborted { throw TurnError("stopped", "Stopped.", session: sessionId) }
            guard let result = LoginShell.lastResultLine(out.stdout) else {
                let failure = !out.ok
                if failure && CLIRunner.notFound(out) { throw TurnError("unavailable", "Claude Code was not found on the login shell PATH.") }
                if out.timedOut { throw TurnError("failed", "The turn ran past its time limit and was stopped.") }
                let why = failure ? " (\(BuildGit.firstLine(out.spawnError ?? out.stderr).isEmpty ? "exit code \(out.code.map(String.init) ?? "?")" : BuildGit.firstLine(out.spawnError ?? out.stderr)))" : ""
                throw TurnError("failed", "Claude Code did not return a result\(why).")
            }
            if result["is_error"]?.bool == true || result["result"]?.string == nil {
                let said = result["result"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? result["subtype"]?.string ?? "The model returned no text."
                throw TurnError("failed", String(said.prefix(500)))
            }
            return TurnOutput(text: result["result"]!.string!, session: sessionId)
        }

        let home = codexHome ?? environment["CODEX_HOME"] ?? NodePath.join(environment["HOME"] ?? NSHomeDirectory(), ".codex")
        if !CLIRunner.chatGptSignIn(codexAuthFile ?? NodePath.join(home, "auth.json")) {
            throw TurnError("unavailable", "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.")
        }
        let outFile = "\(stem).out.txt"
        defer { FS.unlink(outFile) }
        let overrides = CLIRunner.codexOverrides(input.policy, instructions: input.system, engelbart: server, home: home)
        let settings = overrides.indices.map { "-c \"$ENGELBART_BUILD_C\($0)\"" }.joined(separator: " ")
        let shared = "-m \"$ENGELBART_BUILD_MODEL\" -c 'model_reasoning_effort=\"\(effort)\"' -c 'sandbox_mode=\"workspace-write\"' -c 'approval_policy=\"on-request\"' -c 'approvals_reviewer=\"auto_review\"' -c 'tools.web_search=true' \(settings) --json -o \"$ENGELBART_BUILD_OUTPUT\" - < \"$ENGELBART_BUILD_INPUT\""
        let command = guardFirst + (input.session != nil ? "exec \(program("codex")) exec resume \"$ENGELBART_BUILD_SESSION\" \(shared)" : "exec \(program("codex")) exec --color never \(shared)")
        var extra = programEnv("codex").merging(guarded) { _, b in b }
        if let codexHome { extra["CODEX_HOME"] = codexHome }
        extra["ENGELBART_BUILD_SESSION"] = input.session ?? ""
        extra["ENGELBART_BUILD_MODEL"] = modelId
        extra["ENGELBART_BUILD_OUTPUT"] = outFile
        extra["ENGELBART_BUILD_INPUT"] = inputFile
        for (n, value) in overrides.enumerated() { extra["ENGELBART_BUILD_C\(n)"] = value }
        let env = childEnvironment(extra)
        let out = await run(command, cwd: worktree, env: env, input: input) { event in raw(event); input.onUpdate(Activity.codexUpdate(event, short)) }
        var thread = input.session
        let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .caseInsensitive)
        for line in out.stdout.components(separatedBy: "\n") where thread == nil && line.hasPrefix("{") {
            if let event = try? JSONValue.parse(line.trimmingCharacters(in: .whitespacesAndNewlines)), event["type"]?.string == "thread.started",
               let t = event["thread_id"]?.string, uuid.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil { thread = t }
        }
        if input.signal.isAborted { throw TurnError("stopped", "Stopped.", session: thread) }
        let text = FS.readText(outFile) ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if !out.ok && CLIRunner.notFound(out) { throw TurnError("unavailable", "Codex was not found on the login shell PATH.") }
            let errorLine = out.stdout.components(separatedBy: "\n").reversed().first {
                ($0.range(of: #""type":"(error|turn\.failed)"|^ERROR"#, options: .regularExpression) != nil) && !$0.contains("resuming with")
            }
            let reason = errorLine ?? (out.timedOut ? "The turn ran past its time limit and was stopped." : !out.ok ? (BuildGit.firstLine(out.spawnError ?? out.stderr).isEmpty ? "Command failed: exit code \(out.code.map(String.init) ?? "?")" : BuildGit.firstLine(out.spawnError ?? out.stderr)) : "Codex returned no message.")
            throw TurnError("failed", String(reason.prefix(500)))
        }
        return TurnOutput(text: text, session: thread)
    }
}

/// Scripted runs (ENGELBART_BUILD_FAKE=1; design B24): no model. The fake agent writes BUILD-FAKE.md in the worktree (one
/// line per turn), reports two things it did, and answers. A first message containing "question" asks one (NEEDS YOU); a
/// quick task containing "escalate" escalates; "fail" fails the turn. ENGELBART_BUILD_FAKE_MS sets how long a turn takes.
public final class FakeRunner: BuildRunner, @unchecked Sendable {
    let delay: TimeInterval
    public init(delayMs: Double = 900) { delay = delayMs / 1000 }

    public func turn(_ input: TurnInput) async throws -> TurnOutput {
        let task = input.task
        let session = input.session
        let raw: (JSONValue) -> Void = { input.onEvent?($0) }
        func wait(_ seconds: Double) async throws {
            await pause(seconds, input.signal)
            if input.signal.isAborted { throw TurnError("stopped", "Stopped.", session: session ?? "fake-session") }
        }
        let said = input.message
        input.onUpdate(ActivityUpdate(activity: "Reading the workspace", log: true))
        try await wait(delay / 3)
        if said.range(of: #"\bfail\b"#, options: [.regularExpression, .caseInsensitive]) != nil && session == nil {
            throw TurnError("failed", "The fake agent was asked to fail.")
        }
        if task.str("kind") == "quick" && said.range(of: "escalate", options: .caseInsensitive) != nil && session == nil {
            return TurnOutput(text: "ESCALATE: the fake agent was asked to escalate.", session: "fake-session")
        }
        input.onUpdate(ActivityUpdate(activity: "Editing BUILD-FAKE.md", log: true))
        let file = NodePath.join(task.str("worktree") ?? ".", "BUILD-FAKE.md")
        // The tool call it makes, as Claude Code streams one: the Agent map records it.
        raw(["type": "assistant", "message": ["content": [["type": "tool_use", "id": "fake-write", "name": "Write", "input": ["file_path": .string(file)]]]]])
        let held = FS.readText(file) ?? ""
        let turn = held.filter { $0 == "\n" }.count + 1
        var what = "first"
        if said.contains("<reply>") {
            what = String(said.replacingOccurrences(of: #"[\s\S]*<reply>\n?|\n?</reply>[\s\S]*"#, with: "", options: .regularExpression).prefix(80))
        }
        try FS.write(file, "\(held)turn \(turn): \(what)\n")
        raw(["type": "user", "message": ["content": [["type": "tool_result", "tool_use_id": "fake-write", "content": "written"]]]])
        try await wait(delay / 3)
        input.onUpdate(ActivityUpdate(textStart: true))
        input.onUpdate(ActivityUpdate(delta: "FAKE BUILD"))
        try await wait(delay / 3)
        if session == nil && said.range(of: "question", options: .caseInsensitive) != nil && task.str("kind") != "quick" {
            return TurnOutput(text: "I wrote BUILD-FAKE.md.\n\nNEEDS YOU: Should the fake build keep going?", session: "fake-session")
        }
        return TurnOutput(text: "FAKE BUILD: changed `BUILD-FAKE.md`.\n\n- \(session != nil ? "the same session, continued" : "a new session")\n- \(task.str("modelName") ?? "") \(task.str("effort") ?? "")",
                          session: session ?? "fake-session")
    }
}
