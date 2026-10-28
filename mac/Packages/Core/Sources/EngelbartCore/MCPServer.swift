import Foundation

/// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): `initialize`, `tools/list`, `tools/call`, `ping`.
///
/// The Electron app gave the `claude`/`codex` CLIs its own MCP servers (bart/papers-mcp.cjs, build/engelbart-mcp.cjs,
/// build/run-mcp.cjs, connect/import-mcp.cjs, sandbox/local-mcp.cjs) by launching Electron as Node on a script. The Swift
/// app launches *itself*: `<Engelbart executable> --mcp <name> [args…]` (see `MCPLaunch`). The app's entry point looks
/// for `--mcp` before it starts any UI and hands stdin/stdout to the server the named package builds.
public final class MCPServer: @unchecked Sendable {
    public struct Tool {
        public var name: String
        public var description: String
        /// JSON Schema of the arguments (`{"type":"object","properties":{…},"required":[…]}`).
        public var inputSchema: JSONValue
        /// Returns the text the tool answers with; throw to answer with `isError: true`.
        public var call: (JSONValue) async throws -> String
        public init(name: String, description: String, inputSchema: JSONValue, call: @escaping (JSONValue) async throws -> String) {
            self.name = name; self.description = description; self.inputSchema = inputSchema; self.call = call
        }
    }

    public let name: String
    public let version: String
    public var instructions: String?
    private var tools: [Tool]
    private let output: FileHandle
    private let writeLock = NSLock()

    public init(name: String, version: String = "1.0.0", instructions: String? = nil, tools: [Tool], output: FileHandle = .standardOutput) {
        self.name = name; self.version = version; self.instructions = instructions; self.tools = tools; self.output = output
    }

    /// Serves until stdin closes. Blocks the calling thread (call it from the `--mcp` entry point).
    public func runForever(input: FileHandle = .standardInput) {
        let done = DispatchSemaphore(value: 0)
        Task.detached { [self] in
            var buffer = Data()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<nl]
                    buffer.removeSubrange(buffer.startIndex...nl)
                    if let message = try? JSONValue.parse(Data(line)) { await self.handle(message) }
                }
            }
            done.signal()
        }
        done.wait()
    }

    /// Handles one JSON-RPC message; returns the response (nil for notifications). Public for tests.
    @discardableResult
    public func handle(_ message: JSONValue) async -> JSONValue? {
        let id = message["id"]
        let method = message["method"]?.string ?? ""
        let params = message["params"] ?? .object([:])
        var result: JSONValue?
        var error: JSONValue?
        switch method {
        case "initialize":
            var info: [String: JSONValue] = [
                "protocolVersion": params["protocolVersion"] ?? "2025-06-18",
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": .string(name), "version": .string(version)],
            ]
            if let instructions { info["instructions"] = .string(instructions) }
            result = .object(info)
        case "ping":
            result = .object([:])
        case "tools/list":
            result = ["tools": .array(tools.map { ["name": .string($0.name), "description": .string($0.description), "inputSchema": $0.inputSchema] })]
        case "tools/call":
            let toolName = params["name"]?.string ?? ""
            if let tool = tools.first(where: { $0.name == toolName }) {
                do {
                    let text = try await tool.call(params["arguments"] ?? .object([:]))
                    result = ["content": [["type": "text", "text": .string(text)]], "isError": false]
                } catch {
                    result = ["content": [["type": "text", "text": .string(error.localizedDescription)]], "isError": true]
                }
            } else {
                error = ["code": -32602, "message": .string("Unknown tool: \(toolName)")]
            }
        default:
            if id == nil || id?.isNull == true { return nil } // a notification (notifications/initialized, cancelled…)
            error = ["code": -32601, "message": .string("Method not found: \(method)")]
        }
        guard let id, !id.isNull else { return nil }
        var response: [String: JSONValue] = ["jsonrpc": "2.0", "id": id]
        if let error { response["error"] = error } else { response["result"] = result ?? .object([:]) }
        let value = JSONValue.object(response)
        send(value)
        return value
    }

    private func send(_ value: JSONValue) {
        writeLock.lock(); defer { writeLock.unlock() }
        output.write(Data((value.text() + "\n").utf8))
    }
}

/// How a CLI is told to start one of Engelbart's MCP servers: this executable with `--mcp <name>`. Tests and packages
/// that are not the app pass their own `executable`.
public enum MCPLaunch {
    public static var executable: String = Bundle.main.executablePath ?? CommandLine.arguments[0]

    public static func arguments(_ name: String, _ extra: [String] = []) -> [String] { ["--mcp", name] + extra }

    /// The `mcpServers` entry for a Claude Code `--mcp-config` file (and the same command for Codex's `-c mcp_servers…`).
    public static func claudeConfigEntry(_ name: String, _ extra: [String] = [], env: [String: String] = [:]) -> JSONValue {
        [
            "type": "stdio",
            "command": .string(executable),
            "args": .array(arguments(name, extra).map { .string($0) }),
            "env": .object(env.mapValues { .string($0) }),
        ]
    }
}
