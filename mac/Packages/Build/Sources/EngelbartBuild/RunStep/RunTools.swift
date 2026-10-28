import Foundation
import EngelbartCore

/// The run step's tools (run-tools.cjs, 2026-09-29), served to Claude Code by `--mcp run` over the loopback bridge: every
/// path is inside the Build's worktree (a link that leads out is refused, and so is .git), every command runs there, one
/// at a time. run_command refuses the common ways around start_runnable (a server, something in the background, kill);
/// like a Build agent's own shell it is not a sandbox.
public enum RunTools {
    /// What the run step gets running, for now (2026-09-29): a web interface, which Review opens in the Stage. Desktop
    /// apps and terminal programs are still understood below and by the run step, but not offered to the agent.
    public static let runKinds = ["ui"]
    public static let allKinds = ["ui", "app", "terminal"]
    static let ignore: Set<String> = [".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build"]
    static let maxRead = 64_000
    static let maxList = 300

    /// The definitions, verbatim from run-tools.cjs.
    public static let definitions: [MCPServer.Tool.Definition] = MCPServer.Tool.Definition.parse(#"[{"name":"declare_runnables","description":"Name the web interfaces that show what this Build made, all at once, before starting any: each is a web UI (\"ui\"), served on a port and opened in Engelbart's Stage (a browser tab) when the person reviews the Build. For now only web UIs: a desktop app or a terminal program is never declared, even when the repository is one. A page of plain HTML, CSS and JavaScript is a web UI served from its folder by a static server. A backend or API that a UI needs is part of that UI (one run command starts both), not a runnable of its own; libraries, tests and build tools are not runnables. name: a short label (\"web\", \"page\"); folder: where its commands run, relative to the repository root (\".\" for the root). Calling it again replaces the list (what is already running stays). Returns each runnable with its stored commands, its state and its time left.","inputSchema":{"type":"object","properties":{"runnables":{"type":"array","maxItems":8,"items":{"type":"object","properties":{"name":{"type":"string"},"folder":{"type":"string"},"type":{"type":"string","enum":["ui"]}},"required":["name","folder","type"],"additionalProperties":false}}},"required":["runnables"],"additionalProperties":false}},{"name":"start_runnable","description":"Run a declared runnable's install_command (optional; to its end, e.g. \"npm install\") and then its run_command in its folder, as a process Engelbart owns, and check it the same way every time: it must answer on the port Engelbart gives it (put {port} in run_command where the port goes, e.g. \"npm run dev -- --port {port}\", \"PORT={port} npm start\", or for a plain page \"python3 -m http.server {port} --bind 127.0.0.1\"). A pass keeps it running (the person opens it when they review the Build; its commands are kept once they accept it): move on to the next runnable. A failure stops what was started and returns the failed check and the output: fix the cause, then call again. Each runnable has 20 minutes from its first start_runnable.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"install_command":{"type":"string"},"run_command":{"type":"string"}},"required":["name","run_command"],"additionalProperties":false}},{"name":"runnable_status","description":"Engelbart's fresh state of every declared runnable: whether it runs, its address, its last error and recent output, its time left. Starts and stops nothing.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},{"name":"run_command","description":"Run a command to its end in the Build's worktree on this Mac: installs, builds, code generation, a quick look at something. Never a server or an app (start_runnable launches those), never in the background, never kill. cwd is relative to the repository root. Returns the exit code and the end of the output.","inputSchema":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeout_seconds":{"type":"integer","minimum":1,"maximum":600}},"required":["command"],"additionalProperties":false}},{"name":"read_file","description":"Read a UTF-8 file of the repository (the first 64 KB). The path is relative to the repository root.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}},{"name":"write_file","description":"Write a UTF-8 file in the repository. Only when a runnable cannot run without the change, and as little as it takes: what you change is committed as the run step and shown to the person apart from the Build's own work.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}},{"name":"list_files","description":"List a folder of the repository (files, and folders with a trailing /), without running anything. Dependency and build folders are left out.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":[],"additionalProperties":false}}]"#)

    /// `value` (relative to `root`) as a path inside the worktree: never outside it, through a link, or into .git.
    public static func worktreePath(_ root: String, _ value: String = ".") throws -> String {
        if value.count > 4096 || value.contains("\0") { throw BuildError("Invalid repository path") }
        guard let base = NodePath.realOrNil(root) else { throw BuildError("Paths must be inside the repository") }
        let resolved = NodePath.resolve(base, value)
        if !NodePath.inside(base, resolved) { throw BuildError("Paths must be inside the repository") }
        if NodePath.relative(base, resolved).split(separator: "/").contains(".git") { throw BuildError(".git is Engelbart's; it cannot be read or written") }
        var probe = resolved
        while !FS.present(probe) { probe = NodePath.dirname(probe) }
        guard let real = NodePath.realOrNil(probe), NodePath.inside(base, real) else { throw BuildError("Paths must be inside the repository") }
        return resolved
    }

    /// `kinds`: the runnable types the run step takes (runKinds unless it says otherwise).
    @discardableResult
    public static func validate(_ name: String, _ args: JSONValue, kinds: [String] = runKinds) throws -> [String: JSONValue] {
        guard let tool = definitions.first(where: { $0.name == name }), let given = args.object else { throw BuildError("Unknown run step tool") }
        let properties = tool.inputSchema["properties"]?.object ?? [:]
        let required = tool.inputSchema["required"]?.array?.compactMap(\.string) ?? []
        if required.contains(where: { given[$0] == nil }) || given.keys.contains(where: { properties[$0] == nil }) { throw BuildError("Invalid tool arguments") }
        for (key, value) in given {
            let type = properties[key]?["type"]?.string
            if type == "string" {
                guard let s = value.string, !s.contains("\0"), s.count <= (key == "content" ? 256_000 : 8000) else { throw BuildError("Invalid \(key)") }
            }
            if type == "integer" {
                let lo = properties[key]?["minimum"]?.int ?? Int.min, hi = properties[key]?["maximum"]?.int ?? Int.max
                guard let d = value.double, d.rounded() == d, Int(d) >= lo, Int(d) <= hi else { throw BuildError("Invalid \(key)") }
            }
            if type == "array" {
                let max = properties[key]?["maxItems"]?.int ?? Int.max
                guard let list = value.array, list.count <= max else { throw BuildError("Invalid \(key)") }
                for item in list {
                    guard let o = item.object, !o.keys.contains(where: { !["name", "folder", "type"].contains($0) }),
                          ["name", "folder", "type"].allSatisfy({ o[$0]?.string != nil }) else { throw BuildError("Invalid \(key)") }
                    let t = o["type"]!.string!
                    if !allKinds.contains(t) { throw BuildError("Invalid runnable type \(t): \(kinds.joined(separator: ", "))") }
                    if !kinds.contains(t) { throw BuildError("\(o["name"]!.string!) is not a web UI: for now the run step runs only web interfaces (\"ui\"), which open in the Stage. Declare what the Build made as a web UI, or leave it out.") }
                }
            }
        }
        if let c = given["command"]?.string, c.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw BuildError("Command is empty") }
        if let c = given["run_command"]?.string, c.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw BuildError("run_command is empty") }
        return given
    }

    // A guardrail for the common ways around start_runnable, not a security boundary.
    static let launches = try! NSRegularExpression(pattern: #"\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\b(?:concurrently|nodemon|pkill|killall|nohup|disown|sudo)\b|(?:^|[;|&\n]\s*)\s*(?:vite\b(?!\s+(?:build|optimize)\b)|kill\b|open\b)|&\s*$|\belectron\s+\."#)

    /// The run step's own handlers (declare, start, status).
    public struct Handlers: Sendable {
        public var declare: @Sendable ([JSONValue]) async throws -> JSONValue
        public var start: @Sendable ([String: JSONValue]) async throws -> JSONValue
        public var status: @Sendable () async throws -> JSONValue
        public init(declare: @escaping @Sendable ([JSONValue]) async throws -> JSONValue, start: @escaping @Sendable ([String: JSONValue]) async throws -> JSONValue, status: @escaping @Sendable () async throws -> JSONValue) {
            self.declare = declare; self.start = start; self.status = status
        }
    }
}

/// The tools of one run step (createRunTools): one call at a time; closed once the step ends.
public final class RunToolCaller: @unchecked Sendable {
    let root: String
    let handlers: RunTools.Handlers
    let processes: RunProcesses
    let key: String
    let signal: CancelSignal?
    let kinds: [String]
    let onActivity: @Sendable (String) -> Void
    private let gate = AsyncGate()
    private let lock = NSLock()
    private var closed = false
    private var commands = 0

    public init(root: String, handlers: RunTools.Handlers, processes: RunProcesses, key: String, signal: CancelSignal? = nil,
                kinds: [String] = RunTools.runKinds, onActivity: @escaping @Sendable (String) -> Void = { _ in }) {
        self.root = root; self.handlers = handlers; self.processes = processes; self.key = key; self.signal = signal; self.kinds = kinds; self.onActivity = onActivity
    }

    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    public func call(_ name: String, _ args: JSONValue) async throws -> JSONValue {
        if isClosed { throw BuildError("The run step is over; its tools are closed") }
        return try await gate.run { try await self.perform(name, args) }
    }

    public func close() async {
        lock.lock(); closed = true; lock.unlock()
        await gate.drain()
    }

    func perform(_ name: String, _ raw: JSONValue) async throws -> JSONValue {
        if isClosed { throw BuildError("The run step is over; its tools are closed") }
        if signal?.isAborted == true { throw BuildError("This operation was aborted") }
        let args = try RunTools.validate(name, raw, kinds: kinds)
        let s = { (k: String) in args[k]?.string ?? "" }
        let activity: String = [
            "declare_runnables": "Naming what runs", "start_runnable": "Starting \(s("name"))", "runnable_status": "Checking what runs",
            "run_command": "Running \(String((s("command").components(separatedBy: "\n").first ?? "").prefix(80)))", "read_file": "Reading \(s("path"))",
            "write_file": "Changing \(s("path"))", "list_files": "Listing \(args["path"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? ".")",
        ][name] ?? name
        onActivity(activity)
        switch name {
        case "declare_runnables": return try await handlers.declare(args["runnables"]?.array ?? [])
        case "start_runnable": return try await handlers.start(args)
        case "runnable_status": return try await handlers.status()
        case "read_file":
            let file = try RunTools.worktreePath(root, s("path"))
            guard let handle = FileHandle(forReadingAtPath: file) else { throw BuildError("ENOENT: no such file or directory, open '\(file)'") }
            defer { try? handle.close() }
            let data = handle.readData(ofLength: RunTools.maxRead + 1)
            return ["content": .string(String(decoding: data.prefix(RunTools.maxRead), as: UTF8.self)), "truncated": .bool(data.count > RunTools.maxRead)]
        case "write_file":
            let file = try RunTools.worktreePath(root, s("path"))
            if FS.isSymlink(file) { throw BuildError("That path is a link; it cannot be written") }
            try FS.mkdirs(NodePath.dirname(file))
            try FS.write(file, s("content"))
            return ["written": .string(NodePath.relative(NodePath.real(root), file))]
        case "list_files":
            let dir = try RunTools.worktreePath(root, args["path"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? ".")
            let names = (FS.list(dir) ?? []).filter { !RunTools.ignore.contains($0) }.sorted { $0.localizedCompare($1) == .orderedAscending }
            return ["entries": .array(names.prefix(RunTools.maxList).map { .string(FS.isDirectory(NodePath.join(dir, $0)) && !FS.isSymlink(NodePath.join(dir, $0)) ? "\($0)/" : $0) }),
                    "truncated": .bool(names.count > RunTools.maxList)]
        default: // run_command
            let command = s("command")
            if RunTools.launches.firstMatch(in: command, range: NSRange(command.startIndex..., in: command)) != nil {
                throw BuildError("Launch a server or an app only with start_runnable, and never stop processes yourself: Engelbart owns them. run_command is for commands that end by themselves (installs, builds, checks).")
            }
            let cwd = try RunTools.worktreePath(root, args["cwd"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? ".")
            lock.lock(); commands += 1; let n = commands; lock.unlock()
            let out = await processes.runToExit("\(key):command:\(n)", command, cwd, timeout: TimeInterval(args["timeout_seconds"]?.int ?? 120), signal: signal, env: ["CI": "1"])
            return ["exit_code": out.code.map { .number(Double($0)) } ?? .null, "timed_out": .bool(out.timedOut), "output": .string(String(out.output.suffix(16_000)))]
        }
    }
}

/// One at a time, in order (the JS promise chain).
actor AsyncGate {
    private var tail: Task<Void, Never>?
    func run<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task<T, Error> {
            await previous?.value
            return try await work()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }
    func drain() async { await tail?.value }
}

extension MCPServer.Tool {
    /// A tool's published definition: name, description, input schema (what `tools/list` answers).
    public struct Definition: Sendable {
        public var name: String
        public var description: String
        public var inputSchema: JSONValue
        static func parse(_ json: String) -> [Definition] {
            ((try? JSONValue.parse(json))?.array ?? []).map {
                Definition(name: $0["name"]?.string ?? "", description: $0["description"]?.string ?? "", inputSchema: $0["inputSchema"] ?? [:])
            }
        }
    }
}
