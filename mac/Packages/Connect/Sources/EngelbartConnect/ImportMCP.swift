import Foundation
import EngelbartCore

// Port of src/main/connect/import-mcp.cjs: the import agents' tools served to Claude Code and Codex as the MCP server
// `engelbart`, now this executable started with `--mcp import <connection file>` (MCPLaunch). It holds no credentials; its
// loopback capability reaches only the one import that started it. The connection file names the agent's kind (survey,
// recall, import…) and only that kind's tools are listed (Tools.toolsFor); its `tools`, when there, narrow that to its
// job's. Its own stdio loop rather than Core.MCPServer: a tool's answer is passed on as the bridge gives it, image content
// (browser_screenshot) included, which Core.MCPServer's text-only tools could not carry.
public enum ImportMCP {
    /// The definitions to list for a connection file (unreadable: every import tool).
    public static func definitions(connectionFile: String) -> [JSONValue] {
        guard let conn = Files.readJSON(URL(fileURLWithPath: connectionFile)), let kind = conn["kind"]?.string, !kind.isEmpty else { return Tools.definitions }
        return Tools.toolsFor(kind, only: conn["tools"]?.array?.compactMap(\.string))
    }

    /// Serves until stdin closes: the app's entry point calls this for `--mcp import <file>` before any UI.
    public static func run(arguments: [String], input: FileHandle = .standardInput, output: FileHandle = .standardOutput) -> Int32 {
        guard let file = arguments.first, let conn = Files.readJSON(URL(fileURLWithPath: file)),
              let url = conn["url"]?.string, let token = conn["token"]?.string,
              let target = URL(string: url), target.scheme == "http", target.host == "127.0.0.1", target.path == "/tools", JS.test(token, "^[a-f0-9]{64}$") else {
            FileHandle.standardError.write(Data("Engelbart's import tools failed to start.\n".utf8))
            return 1
        }
        let tools = definitions(connectionFile: file)
        let lock = NSLock()
        let send: (JSONValue) -> Void = { value in lock.lock(); output.write(Data((value.text() + "\n").utf8)); lock.unlock() }
        let done = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        Thread.detachNewThread {
            var buffer = Data()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<nl]
                    buffer.removeSubrange(buffer.startIndex...nl)
                    guard let message = try? JSONValue.parse(Data(line)) else { continue }
                    group.enter()
                    Task { if let reply = await handle(message, tools: tools, target: target, token: token) { send(reply) }; group.leave() }
                }
            }
            group.wait()
            done.signal()
        }
        done.wait()
        return 0
    }

    /// One JSON-RPC message → the response (nil for a notification). Public for tests.
    public static func handle(_ message: JSONValue, tools: [JSONValue], target: URL, token: String, post: ((URLRequest) async throws -> (Data, Int))? = nil) async -> JSONValue? {
        let id = message["id"]
        let method = message["method"]?.string ?? ""
        let params = message["params"] ?? .object([:])
        var result: JSONValue?
        var error: JSONValue?
        switch method {
        case "initialize":
            result = ["protocolVersion": params["protocolVersion"] ?? "2025-06-18", "capabilities": ["tools": .object([:])], "serverInfo": ["name": "engelbart", "version": "1.0.0"]]
        case "ping": result = .object([:])
        case "tools/list": result = ["tools": .array(tools)]
        case "tools/call":
            var request = URLRequest(url: target, timeoutInterval: 230)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = Data(JSONValue.object(["name": params["name"] ?? "", "args": params["arguments"] ?? .object([:])]).text().utf8)
            do {
                let (data, status) = try await (post ?? { req in
                    let (d, r) = try await URLSession.shared.data(for: req)
                    return (d, (r as? HTTPURLResponse)?.statusCode ?? 0)
                })(request)
                guard (200..<300).contains(status) else { throw ConnectError("failed", "The import tool connection is unavailable") }
                result = try JSONValue.parse(data)
            } catch {
                result = ["isError": true, "content": [["type": "text", "text": .string((error as? ConnectError)?.message ?? "The import tool connection is unavailable")]]]
            }
        default:
            if id == nil || id?.isNull == true { return nil }
            error = ["code": -32601, "message": .string("Method not found: \(method)")]
        }
        guard let id, !id.isNull else { return nil }
        var response: [String: JSONValue] = ["jsonrpc": "2.0", "id": id]
        if let error { response["error"] = error } else { response["result"] = result ?? .object([:]) }
        return .object(response)
    }
}
