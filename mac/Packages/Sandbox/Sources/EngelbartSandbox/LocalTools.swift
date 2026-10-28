import Foundation
import EngelbartCore

// src/main/sandbox/local-tools.cjs: the tools the local Claude Code uses to set a repository up in its E2B sandbox. Every
// path and command refers to the sandbox, never this Mac.

public enum SandboxToolsSpec {
    public static let root = "/home/user/repository"
    public static let hintLimit = 200
    public static let reasonLimit = 500

    static func schema(_ properties: [String: JSONValue], _ required: [String]) -> JSONValue {
        ["type": "object", "properties": .object(properties), "required": .array(required.map { .string($0) }), "additionalProperties": false]
    }
    static let text: JSONValue = ["type": "string"]

    /// The ten tools, in order, with the descriptions Claude reads (verbatim).
    public static let definitions: [(name: String, description: String, inputSchema: JSONValue)] = [
        ("declare_kind", "Call FIRST, before any install decision: how a person uses this repository. interface: a web UI exists (vite/next/express/etc., index.html, a dev server script). terminal: a CLI, library, scripts, notebooks-as-scripts, or a package bin/main with no server. both: a web UI and a meaningful CLI. Decide from the launch discovery JSON plus at most one README/manifest read. Tools that change anything are refused until it is declared; declaring again replaces it until the repository is ready.",
         schema(["kind": ["type": "string", "enum": ["interface", "terminal", "both"]], "reason": ["type": "string", "maxLength": .number(Double(reasonLimit))]], ["kind", "reason"])),
        ("terminal_ready", "For terminal or both, once dependency installation has succeeded or was skipped: the repository is ready to use from a shell. cwd: the directory, relative to the repository, a person should start in. hint: one example command to try there, e.g. \"python main.py --help\" (one line, at most 200 characters). The hint is shown to the person and never run. Starts nothing.",
         schema(["cwd": text, "hint": ["type": "string", "maxLength": .number(Double(hintLimit))]], ["cwd", "hint"])),
        ("run_command", "Run a foreground command ONLY in the assigned E2B Linux sandbox. Blocked while dependency installation is active: use read_file/list_files for concurrent inspection. Use dependency_install for installs and start_app for the web server; never background either here.",
         schema(["command": text, "cwd": text, "timeout_seconds": ["type": "integer", "minimum": 1, "maximum": 180]], ["command"])),
        ("read_file", "Read a UTF-8 file from the repository in E2B. Paths are relative to the repository root.", schema(["path": text], ["path"])),
        ("write_file", "Write a UTF-8 file in the repository in E2B. No access to files on the Mac.", schema(["path": text, "content": text], ["path", "content"])),
        ("start_app", "Save a reusable launch command, start the web app in E2B, and independently check its live preview. When the launch recipe is ready during installation, call with wait_for_install:true now: waits up to 30 seconds for confirmed install success, then launches directly without another agent turn. Failed, stopped or still-running installs never launch; an expired wait leaves no queued launch. Stops and confirms the previous owned attempt before replacing it; never kills an unrelated port owner. Command must stay in the foreground and start the server (not install dependencies). On failure, inspect returned app state/failed_check or call app_status before changing anything. Never diagnose by launching another server via run_command.",
         schema(["command": text, "cwd": text, "port": ["type": "integer", "minimum": 1024, "maximum": 65535], "path": text, "wait_for_install": ["type": "boolean"]], ["command", "port"])),
        ("app_status", "Read fresh worker-owned application state: living processes, listener ports/addresses/ownership, the local HTTP check, and recent output. Optionally inspect ownership of a particular port, including a backend or a conflict. A running process is NOT proof of a healthy preview. Safe during installs; does not start or stop anything. Other tool replies also include the latest observed app state and bounded state changes.",
         schema(["port": ["type": "integer", "minimum": 1024, "maximum": 65535]], [])),
        ("stop_app", "Stop only the current managed application and confirm its descendants are gone. Keeps the sandbox and installed files. Use before intentional app changes; never use broad pkill or launch a duplicate server to inspect it.", schema([:], [])),
        ("list_files", "List repository files/directories without executing repository code. Available while dependencies install. Omits generated dependency/build directories and bounds the listing.", schema(["path": text], [])),
        ("dependency_install", "Control the worker-owned dependency job in E2B. start runs command in cwd asynchronously, first stopping and confirming any previous job. For independent npm frontend + Python backend directories, instead provide parallel: [{manager:\"npm\",cwd:\"frontend\"},{manager:\"pip\",cwd:\"backend\"}]. This validates independence, runs npm ci and a requirements.txt install in a new backend .venv concurrently, and succeeds only when BOTH succeed. Shared workspaces, linked dependencies or custom setup must use sequential command jobs. npm audit is deferred until preview readiness; do not enable inline auditing. status returns outcome and log tail; optional wait_seconds (up to 180) waits without busy polling. stop confirms the whole process tree is gone before edits. skip requires a reason after verifying dependencies already exist or no install is needed. Continue read-only inspection/planning while running; wait for success before build/start.",
         schema(["action": ["type": "string", "enum": ["start", "status", "stop", "skip"]], "command": text, "cwd": text,
                 "parallel": ["type": "array", "minItems": 2, "maxItems": 2, "items": schema(["manager": ["type": "string", "enum": ["npm", "pip"]], "cwd": text], ["manager", "cwd"])],
                 "timeout_seconds": ["type": "integer", "minimum": 1, "maximum": 600], "wait_seconds": ["type": "integer", "minimum": 0, "maximum": 180], "reason": text], ["action"])),
    ]

    /// `path.posix.resolve(base, value)`.
    static func posixResolve(_ base: String, _ value: String) -> String {
        let joined = value.hasPrefix("/") ? value : base + "/" + value
        var parts: [Substring] = []
        for part in joined.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }

    /// `repoPath(value)`: a path inside the sandbox's repository, resolved.
    public static func repoPath(_ value: JSONValue? = nil) throws -> String {
        let raw: String
        if let value { guard let s = value.string else { throw SandboxError("Invalid repository path") }; raw = s } else { raw = "." }
        return try repoPath(raw)
    }

    public static func repoPath(_ value: String) throws -> String {
        if value.utf16.count > 4096 || value.contains("\0") { throw SandboxError("Invalid repository path") }
        let resolved = posixResolve(root, value)
        if resolved != root && !resolved.hasPrefix(root + "/") { throw SandboxError("Path must be inside the sandbox repository") }
        return resolved
    }

    /// `validateTool(name, args)`: the published schemas enforced (they are not, by themselves), plus the tools' own rules.
    @discardableResult
    public static func validate(_ name: String, _ raw: JSONValue?) throws -> [String: JSONValue] {
        guard let tool = definitions.first(where: { $0.name == name }), let args = raw?.object else { throw SandboxError("Unknown sandbox tool") }
        let properties = tool.inputSchema["properties"]?.object ?? [:]
        let required = (tool.inputSchema["required"]?.array ?? []).compactMap(\.string)
        if required.contains(where: { args[$0] == nil }) || args.keys.contains(where: { properties[$0] == nil }) { throw SandboxError("Invalid tool arguments") }
        for (key, value) in args {
            let type = properties[key]!
            switch type["type"]?.string {
            case "string":
                let limit = type["maxLength"]?.int ?? (key == "content" ? 64_000 : 8000)
                guard let s = value.string, !s.contains("\0"), s.utf16.count <= limit else { throw SandboxError("Invalid \(key)") }
            case "integer":
                guard let n = value.integer, n >= type["minimum"]?.int ?? Int.min, n <= type["maximum"]?.int ?? Int.max else { throw SandboxError("Invalid \(key)") }
            case "boolean":
                guard value.bool != nil else { throw SandboxError("Invalid \(key)") }
            default: break
            }
            if let options = type["enum"]?.array, !options.contains(value) { throw SandboxError("Invalid \(key)") }
        }
        if let cwd = args["cwd"] { _ = try repoPath(cwd) }
        if name.hasSuffix("_file") { _ = try repoPath(args["path"]) }
        if name == "list_files" { _ = try repoPath(args["path"]) }
        if let command = args["command"]?.string, command.trimmed.isEmpty { throw SandboxError("Command is empty") }
        if name == "dependency_install" {
            let allowed: [String: [String]] = ["start": ["action", "command", "cwd", "parallel", "timeout_seconds"], "status": ["action", "wait_seconds"],
                                               "stop": ["action"], "skip": ["action", "reason"]]
            let action = args["action"]?.string ?? ""
            let keys = allowed[action] ?? []
            if args.keys.contains(where: { !keys.contains($0) })
                || (action == "start" && !(args["command"]?.truthy ?? false) && !(args["parallel"]?.truthy ?? false))
                || (action == "skip" && (args["reason"]?.string?.trimmed ?? "").isEmpty) {
                throw SandboxError("Invalid dependency install action")
            }
            if let parallel = args["parallel"] {
                guard args["command"] == nil, args["cwd"] == nil, let items = parallel.array, items.count == 2,
                      items.allSatisfy({ item in
                          guard let o = item.object else { return false }
                          return o.keys.allSatisfy { ["manager", "cwd"].contains($0) } && ["npm", "pip"].contains(o["manager"]?.string ?? "") && o["cwd"]?.string != nil
                      }), Set(items.compactMap { $0["manager"]?.string }).count == 2 else { throw SandboxError("Invalid parallel dependency install plan") }
                for item in items { _ = try repoPath(item["cwd"]) }
            }
        }
        if name == "start_app" {
            if args["port"]?.integer == 43110 { throw SandboxError("Port 43110 is reserved for the preview proxy") }
            if let path = args["path"]?.string, !path.hasPrefix("/") || path.hasPrefix("//") || path.contains("\r") || path.contains("\n") || path.contains("\\") {
                throw SandboxError("Invalid preview path")
            }
        }
        if name == "declare_kind", (args["reason"]?.string ?? "").trimmed.isEmpty { throw SandboxError("Give a reason for the kind") }
        // The hint is printed into a terminal: one line of plain text, never an escape sequence.
        if name == "terminal_ready", let hint = args["hint"]?.string, hint.trimmed.isEmpty || hasControlCharacters(hint) {
            throw SandboxError("Invalid hint: one line of plain text")
        }
        return args
    }
}

/// The dependency job the tools drive (LocalInstall's `DependencyInstall`).
public protocol SandboxInstallControl: AnyObject {
    func status() -> JSONValue
    func control(_ args: [String: JSONValue]) async throws -> JSONValue
    func list(_ path: String) async throws -> JSONValue
    func assertIdle() throws
    func assertReady() throws
}

/// How the repository is used, as Claude declares it (local-setup.cjs's `kinds`).
public struct SandboxKindsControl {
    public var declared: () -> String?
    public var declare: (_ kind: String, _ reason: String) throws -> JSONValue
    public var terminal: (_ cwd: String, _ hint: String) throws -> JSONValue
    public init(declared: @escaping () -> String?, declare: @escaping (String, String) throws -> JSONValue, terminal: @escaping (String, String) throws -> JSONValue) {
        self.declared = declared; self.declare = declare; self.terminal = terminal
    }
}

/// `createSandboxTools`: the tool calls, one at a time (a start must not race an install, a file write or another start).
public final class SandboxTools: @unchecked Sendable {
    let sandbox: E2BSandbox?
    let startApp: (([String: JSONValue]) async throws -> JSONValue)?
    let appStatus: (([String: JSONValue]) async throws -> JSONValue)?
    let stopApp: (() async throws -> JSONValue)?
    let appState: (() -> JSONValue)?
    let install: SandboxInstallControl?
    let onEvent: (JSONValue) -> Void
    let signal: AbortSignal?
    let secrets: [String]
    let environment: [String: String]
    let kinds: SandboxKindsControl?
    private let chain = SerialChain()
    private let state = Locked((closed: false, verified: false))

    public init(sandbox: E2BSandbox?, startApp: (([String: JSONValue]) async throws -> JSONValue)? = nil,
                appStatus: (([String: JSONValue]) async throws -> JSONValue)? = nil, stopApp: (() async throws -> JSONValue)? = nil,
                appState: (() -> JSONValue)? = nil, install: SandboxInstallControl? = nil, onEvent: @escaping (JSONValue) -> Void,
                signal: AbortSignal? = nil, secrets: [String] = [], environment: [String: String] = [:], kinds: SandboxKindsControl? = nil) {
        self.sandbox = sandbox; self.startApp = startApp; self.appStatus = appStatus; self.stopApp = stopApp; self.appState = appState
        self.install = install; self.onEvent = onEvent; self.signal = signal; self.secrets = secrets; self.environment = environment; self.kinds = kinds
    }

    func emit(_ event: JSONValue) { if !(signal?.aborted ?? false) { onEvent(Redact.value(event, secrets)) } }

    static let guardPattern = #"\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\b(?:concurrently|nodemon|pkill|killall)\b|(?:^|[;|&\n]\s*)\s*(?:vite|kill)\b"#

    private func perform(_ name: String, _ raw: JSONValue?) async throws -> JSONValue {
        if state.value.closed { throw SandboxError("Sandbox tools are closed") }
        try signal?.throwIfAborted()
        let args = try SandboxToolsSpec.validate(name, raw)
        let reading = ["app_status", "list_files", "read_file"].contains(name) || (name == "dependency_install" && args["action"]?.string == "status")
        if state.value.verified && !reading {
            throw SandboxError("The repository is already verified and ready. Setup mutations are closed; finish with a short summary.")
        }
        if let kinds {
            let kind = kinds.declared()
            if kind == nil && !reading && name != "declare_kind" {
                throw SandboxError("Call declare_kind first: say whether this repository is used through a web interface, from a terminal, or both.")
            }
            if name == "start_app" && kind == "terminal" {
                throw SandboxError("This repository was declared terminal, so there is no web preview: install dependencies, then call terminal_ready (or declare_kind again if it has a web UI).")
            }
            if name == "terminal_ready" && kind == "interface" {
                throw SandboxError("This repository was declared interface: start it with start_app (or declare_kind again if it is also used from a terminal).")
            }
        } else if ["declare_kind", "terminal_ready"].contains(name) { throw SandboxError("Unknown sandbox tool") }
        // Record activity, not file contents, tool arguments, or private CLI diagnostics.
        let activity: String = {
            switch name {
            case "read_file": return "Reading \(args["path"]?.string ?? "")"
            case "list_files": return "Listing \(args["path"]?.string ?? ".")"
            case "write_file": return "Updating \(args["path"]?.string ?? "")"
            case "run_command": return "Running a setup command"
            case "start_app": return "Requesting application launch"
            case "app_status": return "Checking application processes and listeners"
            case "stop_app": return "Stopping the owned application"
            case "dependency_install": return "Dependency install · \(args["action"]?.string ?? "")"
            case "declare_kind": return "Declaring how the repository is used: \(args["kind"]?.string ?? "")"
            default: return "Marking the terminal ready"
            }
        }()
        emit(["phase": "agent", "status": "working", "tool": .string(name), "message": .string(activity)])
        switch name {
        case "declare_kind":
            return try kinds!.declare(args["kind"]!.string!, args["reason"]!.string!.trimmed)
        case "terminal_ready":
            try install?.assertReady()
            let cwd = try SandboxToolsSpec.repoPath(args["cwd"]!.string!)
            let given = args["cwd"]!.string!
            do {
                let result = try await sandbox!.run("test -d \(Shell.quote(cwd))", timeoutMs: 10_000)
                if result.exitCode != 0 { throw SandboxError("\(given) is not a directory in the repository") }
            } catch let error as SandboxError where error.exitCode != nil {
                throw SandboxError("\(given) is not a directory in the repository")
            }
            try signal?.throwIfAborted()
            let relative = cwd == SandboxToolsSpec.root ? "." : String(cwd.dropFirst(SandboxToolsSpec.root.count + 1))
            return try kinds!.terminal(relative, args["hint"]!.string!.trimmed)
        case "app_status": return try await appStatus!(args)
        case "stop_app": return try await stopApp!()
        case "dependency_install": return try await install!.control(args)
        case "list_files": return try await install!.list(args["path"]?.string ?? ".")
        case "start_app":
            var recipe = args
            let wait = recipe.removeValue(forKey: "wait_for_install")?.bool ?? false
            if wait, let install, ["starting", "running"].contains(install.status()["status"]?.string ?? "") {
                _ = try await install.control(["action": "status", "wait_seconds": 30])
                try signal?.throwIfAborted()
                if state.value.closed { throw SandboxError("Sandbox tools are closed; no app was started") }
                if ["starting", "running"].contains(install.status()["status"]?.string ?? "") {
                    throw SandboxError("Dependency installation is still running; no app was started or queued. Wait for its result, then retry start_app.")
                }
            }
            try install?.assertReady()
            return try await startApp!(recipe)
        case "read_file":
            let data = try await sandbox!.readFile(try SandboxToolsSpec.repoPath(args["path"]!.string!), maxBytes: 64_001, signal: signal, requestTimeoutMs: 15_000)
            try signal?.throwIfAborted()
            let text = String(decoding: data.prefix(64_000), as: UTF8.self)
            return ["content": .string(Redact.string(text, secrets)), "truncated": .bool(data.count > 64_000)]
        case "write_file":
            try install?.assertIdle()
            try await sandbox!.writeFile(try SandboxToolsSpec.repoPath(args["path"]!.string!), args["content"]!.string!)
            emit(["phase": "agent", "status": "working", "message": .string("Updated \(args["path"]!.string!) in sandbox")])
            return ["written": args["path"]!]
        default: break
        }
        // run_command
        try install?.assertIdle()
        let command = args["command"]!.string!
        // A guardrail for the common accidental bypasses, not a shell security boundary. start_app is the only supported
        // long-running server launcher.
        if command.matches(Self.guardPattern) {
            throw SandboxError("Use app_status to inspect the existing app, stop_app to stop owned processes, and start_app to launch it. Do not start duplicate servers or kill processes through run_command.")
        }
        emit(["phase": "stage", "stage": "setup", "actor": "setup-agent", "status": "running", "command": .string(command)])
        let output = Locked("")
        let receive: (String) -> (String) -> Void = { stream in { [self] chunk in
            let safe = Redact.output(chunk, secrets)
            output.with { $0 = ($0 + safe).tail(32_000) }
            emit(["phase": "log", "actor": "setup-agent", "stream": .string(stream), "text": .string(safe.tail(2000))])
        } }
        var envs = environment
        envs["npm_config_audit"] = "false"
        do {
            let result = try await sandbox!.run("cd \(Shell.quote(try SandboxToolsSpec.repoPath(args["cwd"]))) && \(command)",
                                                CommandOptions(timeoutMs: (args["timeout_seconds"]?.int ?? 120) * 1000, envs: envs,
                                                               onStdout: receive("stdout"), onStderr: receive("stderr"), signal: signal))
            try signal?.throwIfAborted()
            emit(["phase": "agent", "status": "working", "tool": .string(name), "tool_status": .string(result.exitCode == 0 ? "done" : "failed"),
                  "message": .string("Setup command exited with code \(result.exitCode)")])
            return ["exitCode": .number(Double(result.exitCode)), "output": .string(output.value)]
        } catch {
            try signal?.throwIfAborted()
            emit(["phase": "agent", "status": "working", "tool": .string(name), "tool_status": "failed",
                  "message": .string("Setup command failed: \(message(of: error).tail(2000))")])
            return ["exitCode": exitCodeOf(error).map { .number(Double($0)) } ?? .null,
                    "error": .string(Redact.string(message(of: error).tail(2000), secrets)), "output": .string(output.value)]
        }
    }

    private func observedState() -> [String: JSONValue] {
        var state = appState?().object ?? [:]
        if let install {
            // Keep replies small: the full log tail is available through action=status. Sampled after the operation so a
            // read can report an install that just ended.
            let s = install.status()
            var snapshot: [String: JSONValue] = [:]
            for key in ["id", "status", "started_at", "finished_at", "exitCode", "error", "reason"] { if let v = s[key] { snapshot[key] = v } }
            state["dependency_install"] = .object(snapshot)
        }
        return state
    }

    /// One tool call, after every earlier one has ended.
    public func call(_ name: String, _ args: JSONValue?) async throws -> JSONValue {
        if state.value.closed { throw SandboxError("Sandbox tools are closed") }
        let result = Deferred<JSONValue>()
        _ = chain.enqueue { [self] in
            do {
                let value = try await perform(name, args)
                if appState != nil || install != nil {
                    var merged = value.object ?? [:]
                    for (k, v) in observedState() { merged[k] = v }
                    result.resolve(.object(merged))
                } else { result.resolve(value) }
            } catch {
                emit(["phase": "agent", "status": "working", "tool": .string(name), "tool_status": "failed",
                      "message": .string("\(name): \(message(of: error).tail(2000))")])
                var failure = (error as? SandboxError) ?? SandboxError(message(of: error))
                for (k, v) in observedState() { failure.details[k] = v }
                result.reject(failure)
            }
        }
        return try await result.wait()
    }

    /// Setup ending must not race an unfinished tool or a queued write: rejects what is queued and waits for the current one.
    public func close() async {
        state.with { $0.closed = true }
        await chain.idle()
    }

    /// Fences queued as well as future mutations before the ready repository is published.
    public func freeze() { state.with { $0.verified = true } }
}
