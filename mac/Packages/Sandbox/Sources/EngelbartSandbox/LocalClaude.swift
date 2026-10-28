import Foundation
import EngelbartCore

// src/main/sandbox/local-claude.cjs: the setup agent is the installed, unmodified Claude Code CLI on the person's own
// subscription. Its credential files and keychain are never read, and its environment never goes to E2B.

/// The Claude Code to run, and the environment to run it in (`prepareLocalClaude`'s answer).
public struct LocalClaudeAuth: Equatable, Sendable {
    public var file: String
    public var env: [String: String]
    public init(file: String, env: [String: String]) { self.file = file; self.env = env }
}

/// A child process as `runLocalClaude` uses it (tests pass a fake).
public protocol ClaudeChild: AnyObject {
    var onStdout: ((String) -> Void)? { get set }
    func writeInput(_ text: String)
    /// Signals the whole process group (it was started in its own).
    func kill(_ signal: Int32)
    /// The exit status (signals as 128+n), once it has exited.
    func wait() async -> Int32
}

public enum LocalClaude {
    public static let minimumVersion = (2, 1, 248)
    public static let notInstalled = "Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it)."
    public static let outdated = "Update Claude Code to 2.1.248 or newer for restricted sandbox setup."
    public static let signedOut = "Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in)."

    /// Only these reach the Claude process: no API key, OAuth token, parent session or app variable.
    public static func subscriptionEnvironment(_ source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        source.filter { ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "CLAUDE_CONFIG_DIR"].contains($0.key) }
    }

    public static func subscriptionStatus(_ status: JSONValue?) -> Bool {
        guard let status, status["loggedIn"]?.bool == true, status["authMethod"]?.string == "claude.ai", status["apiProvider"]?.string == "firstParty",
              let type = status["subscriptionType"]?.string else { return false }
        return type.matches("^(pro|max|team|enterprise)$", options: .caseInsensitive)
    }

    /// terminal/launch.cjs's `resolveShell`.
    static func resolveShell(_ env: [String: String]) -> String {
        let candidate = env["SHELL"] ?? ""
        if candidate.hasPrefix("/"), ["zsh", "bash", "fish"].contains((candidate as NSString).lastPathComponent), FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        if FileManager.default.isExecutableFile(atPath: "/bin/zsh") { return "/bin/zsh" }
        return "/bin/bash"
    }

    /// tools/detect.cjs's `knownPlaces('claude', home)`: where the installers put it.
    public static func knownPlaces(home: String) -> [String] {
        var places = [".local/bin/claude", ".claude/local/claude", ".bun/bin/claude", ".npm-global/bin/claude", ".volta/bin/claude"].map { (home as NSString).appendingPathComponent($0) }
        places += ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
        let nvm = (home as NSString).appendingPathComponent(".nvm/versions/node")
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            places += entries.filter { $0.matches(#"^v\d+"#) }.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                .map { (nvm as NSString).appendingPathComponent("\($0)/bin/claude") }
        }
        return places
    }

    /// Runs a program to completion: (file, args, env, cwd) → stdout; throws on a non-zero exit. Tests pass a fake.
    public typealias Exec = (_ file: String, _ args: [String], _ env: [String: String], _ cwd: String?) async throws -> String

    public static let exec: Exec = { file, args, env, cwd in
        try await ProcessRunner.check(file, args, environment: env, directory: cwd.map { URL(fileURLWithPath: $0) }, timeout: 15)
    }

    static func isFile(_ path: String?) -> Bool {
        var dir: ObjCBool = false
        guard let path, !path.isEmpty else { return false }
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && !dir.boolValue
    }

    /// `prepareLocalClaude`: found (through the login shell, then where installers put it), new enough, and signed in to a
    /// subscription; else what to do.
    public static func prepare(_ source: [String: String] = ProcessInfo.processInfo.environment, run: Exec = exec) async throws -> LocalClaudeAuth {
        let env = subscriptionEnvironment(source)
        let shell = resolveShell(env)
        let base = (shell as NSString).lastPathComponent
        let fish = base == "fish"
        let query = fish ? "command -s claude" : base == "bash" ? "type -P claude" : "whence -p claude"
        var file: String?
        do {
            var found: String?
            if let stdout = try? await run(shell, fish ? ["--login", "--interactive", "--command", query] : ["-ilc", query], env, NSTemporaryDirectory()) {
                found = stdout.components(separatedBy: .newlines).map { $0.trimmed }.last { $0.hasPrefix("/") }
            }
            file = isFile(found) ? found : knownPlaces(home: env["HOME"] ?? NSHomeDirectory()).first { FileManager.default.isExecutableFile(atPath: $0) && isFile($0) }
            guard let file else { throw SandboxError("missing") }
            let version = try await run(file, ["--version"], env, nil)
            guard let m = version.captures(#"^(\d+)\.(\d+)\.(\d+)"#), let a = Int(m[1]!), let b = Int(m[2]!), let c = Int(m[3]!),
                  (a, b, c) >= minimumVersion else { throw SandboxError("version") }
        } catch {
            throw SandboxError(message(of: error) == "version" ? outdated : notInstalled)
        }
        do {
            let stdout = try await run(file!, ["auth", "status", "--json"], env, NSTemporaryDirectory())
            if !subscriptionStatus(try JSONValue.parse(stdout)) { throw SandboxError("not subscription") }
        } catch { throw SandboxError(signedOut) }
        return LocalClaudeAuth(file: file!, env: env)
    }

    /// `claudeArguments(config, model, { maxTurns, effort })`: only the per-run MCP tools, no built-in tools or hooks, a
    /// bounded session that is not kept in the person's history.
    public static func arguments(config: String, model: String = "claude-sonnet-5-5", maxTurns: Int = 32, effort: String? = nil) throws -> [String] {
        if !model.matches("^[a-zA-Z0-9._:-]{1,100}$") { throw SandboxError("Invalid local Claude model") }
        if maxTurns < 1 || maxTurns > 500 { throw SandboxError("Invalid local Claude turn limit") }
        if let effort, !effort.matches("^[a-z]{1,16}$") { throw SandboxError("Invalid local Claude effort") }
        return ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
                "--restricted", "--setting-sources", "", "--settings", "{\"disableAllHooks\":true}",
                "--strict-mcp-config", "--mcp-config", config, "--tools", "",
                "--allowedTools", "mcp__canvas__*", "--permission-mode", "dontAsk",
                "--model", model] + (effort.map { ["--effort", $0] } ?? []) + ["--max-turns", String(maxTurns)]
    }

    /// Starts a program in a process group of its own (`detached: true`), so stopping it also stops the MCP adapter it ran.
    public typealias Spawn = (_ file: String, _ args: [String], _ env: [String: String], _ cwd: String) throws -> ClaudeChild

    public static let spawn: Spawn = { file, args, env, cwd in try GroupProcess(file: file, args: args, env: env, cwd: cwd) }

    /// `runLocalClaude`: one `claude -p` with the given MCP server (by default this app's `--mcp sandbox-local`) on the
    /// bridge. `server`: the MCP config entry's (command, args) for the connection file. → the final result text.
    public static func run(auth: LocalClaudeAuth, bridge: ToolBridge.Connection, prompt: String, model: String = "claude-sonnet-5-5", effort: String? = nil,
                           maxTurns: Int = 32, server: (String) -> (command: String, args: [String], env: [String: String]) = { connection in
                               (MCPLaunch.executable, MCPLaunch.arguments(SandboxLocalMCP.name, [connection]), [:])
                           },
                           signal: AbortSignal? = nil, onMessage: @escaping (String) -> Void = { _ in }, onEvent: @escaping (JSONValue) -> Void = { _ in },
                           spawnProcess: Spawn = spawn) async throws -> String {
        let fm = FileManager.default
        let directory = (NSTemporaryDirectory() as NSString).appendingPathComponent("canvas-claude-setup-\(UUID().uuidString.prefix(8))")
        try fm.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        chmod(directory, 0o700)
        let config = (directory as NSString).appendingPathComponent("mcp.json")
        let connection = (directory as NSString).appendingPathComponent("bridge.json")
        defer {
            // Only the two files made here, and then this task-owned directory if empty (the CLI may have left a diagnostic).
            for file in [config, connection] { try? fm.removeItem(atPath: file) }
            rmdir(directory)
        }
        let bridgeJSON: JSONValue = ["url": .string(bridge.url), "token": .string(bridge.token)]
        guard fm.createFile(atPath: connection, contents: Data(bridgeJSON.text().utf8), attributes: [.posixPermissions: 0o600]) else { throw SandboxError("Could not prepare the sandbox tools") }
        let entry = server(connection)
        let mcp: JSONValue = ["mcpServers": ["canvas": ["command": .string(entry.command), "args": .array(entry.args.map { .string($0) }),
                                                        "env": .object(entry.env.mapValues { .string($0) })]]]
        guard fm.createFile(atPath: config, contents: Data(mcp.text().utf8), attributes: [.posixPermissions: 0o600]) else { throw SandboxError("Could not prepare the sandbox tools") }
        try signal?.throwIfAborted()
        var env = auth.env
        env["MCP_TOOL_TIMEOUT"] = "240000"
        let child = try spawnProcess(auth.file, try arguments(config: config, model: model, maxTurns: maxTurns, effort: effort), env, directory)
        let killing = Locked(false)
        let abort: () -> Void = {
            if !killing.with({ let was = $0; $0 = true; return !was }) { return }
            child.kill(SIGTERM)
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { child.kill(SIGKILL) }
        }
        let abortId = signal?.onAbort(abort)
        defer { if let abortId { signal?.removeListener(abortId) } }
        let state = Locked((buffer: "", result: JSONValue?.none, failure: String?.none))
        let consume: (String) -> Void = { line in
            guard let event = try? JSONValue.parse(line) else { return }
            onEvent(event) // a watcher's problem (the Agent map's record), never the run's
            if event["type"]?.string == "system" && event["subtype"]?.string == "init" {
                let connected = (event["mcp_servers"]?.array ?? []).contains { $0["name"]?.string == "canvas" && $0["status"]?.string == "connected" }
                if !connected || !(event["mcp_server_errors"]?.array ?? []).isEmpty {
                    state.with { $0.failure = "Claude could not connect to the sandbox tools." }
                    abort()
                }
            }
            if event["type"]?.string == "assistant" {
                for block in event["message"]?["content"]?.array ?? [] where block["type"]?.string == "text" { onMessage(block["text"]?.string ?? "") }
            }
            if event["type"]?.string == "result" { state.with { $0.result = event } }
        }
        child.onStdout = { chunk in
            var lines: [String] = []
            let over = state.with { s -> Bool in
                s.buffer += chunk
                if s.buffer.utf16.count > 2_000_000 { s.failure = "Claude output exceeded its size limit."; return true }
                while let nl = s.buffer.firstIndex(of: "\n") { lines.append(String(s.buffer[..<nl])); s.buffer = String(s.buffer[s.buffer.index(after: nl)...]) }
                return false
            }
            if over { abort(); return }
            lines.forEach(consume)
        }
        // Raw CLI diagnostics are not kept: they can hold account or configuration details.
        child.writeInput(prompt)
        let code = await child.wait()
        let rest = state.with { s -> String in let r = s.buffer; s.buffer = ""; return r }
        if !rest.trimmed.isEmpty { consume(rest) }
        try signal?.throwIfAborted()
        let final = state.value
        if let failure = final.failure { throw SandboxError(failure) }
        guard code == 0, let result = final.result, result["is_error"]?.bool != true, result["subtype"]?.string == "success" else {
            let reason = (final.result?["result"]?.string ?? final.result?["subtype"]?.string ?? "Claude Code exited without a result").head(200)
            throw SandboxError("Claude Code did not finish: \(reason).")
        }
        return result["result"]?.string ?? ""
    }
}

/// A child in a new process group (posix_spawn with POSIX_SPAWN_SETPGROUP), stdin written then closed, stdout read in
/// chunks, stderr drained and dropped.
final class GroupProcess: ClaudeChild, @unchecked Sendable {
    private var pid: pid_t = 0
    private let stdinWrite: FileHandle
    private let stdoutRead: FileHandle
    private let stderrRead: FileHandle
    private let exited = Deferred<Int32>()
    var onStdout: ((String) -> Void)?

    init(file: String, args: [String], env: [String: String], cwd: String) throws {
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, inPipe.fileHandleForReading.fileDescriptor, 0)
        posix_spawn_file_actions_adddup2(&actions, outPipe.fileHandleForWriting.fileDescriptor, 1)
        posix_spawn_file_actions_adddup2(&actions, errPipe.fileHandleForWriting.fileDescriptor, 2)
        posix_spawn_file_actions_addchdir_np(&actions, cwd)
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Its own process group, default signal handling and nothing blocked (a blocked or ignored SIGTERM would be
        // inherited across exec and the stop would not stop it).
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        posix_spawnattr_setpgroup(&attributes, 0)
        var all = sigset_t(), none = sigset_t()
        sigfillset(&all); sigemptyset(&none)
        posix_spawnattr_setsigdefault(&attributes, &all)
        posix_spawnattr_setsigmask(&attributes, &none)
        let argv = ([file] + args).map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
        let status = posix_spawn(&pid, file, &actions, &attributes, argv, envp)
        try? inPipe.fileHandleForReading.close()
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        guard status == 0 else { throw SandboxError("Could not start Claude Code (\(status))") }
        stdinWrite = inPipe.fileHandleForWriting
        stdoutRead = outPipe.fileHandleForReading
        stderrRead = errPipe.fileHandleForReading
        stderrRead.readabilityHandler = { handle in _ = handle.availableData }
        let readDone = Deferred<Void>()
        stdoutRead.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; readDone.resolve(()); return }
            self?.onStdout?(String(decoding: data, as: UTF8.self))
        }
        let child = pid
        DispatchQueue.global().async { [exited] in
            var status: Int32 = 0
            while waitpid(child, &status, 0) == -1 && errno == EINTR {}
            let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
            Task { _ = await readDone.settled(); exited.resolve(code) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { readDone.resolve(()) }
        }
    }

    func writeInput(_ text: String) {
        try? stdinWrite.write(contentsOf: Data(text.utf8))
        try? stdinWrite.close()
    }

    func kill(_ signal: Int32) { if pid > 0 { Darwin.kill(-pid, signal) } }

    func wait() async -> Int32 { (try? await exited.wait()) ?? 1 }
}
