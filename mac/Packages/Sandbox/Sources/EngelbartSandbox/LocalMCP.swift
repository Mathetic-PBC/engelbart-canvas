import Foundation
import EngelbartCore

/// src/main/sandbox/local-mcp.cjs: a trusted local stdio MCP adapter. It holds no E2B or Claude credentials; its loopback
/// capability (the connection file: `{ url, token }`) reaches only the setup that owns this one sandbox. Launched by the
/// local Claude Code as `<Engelbart> --mcp sandbox-local <connection.json>`; the app's `--mcp` entry point calls
/// `SandboxLocalMCP.main(arguments:)`.
public enum SandboxLocalMCP {
    public static let name = "sandbox-local"
    /// The server name Claude Code sees (its tools are `mcp__canvas__*`; the config's key is `canvas`).
    public static let serverName = "canvas-sandbox"

    /// Reads and checks the connection file: http, 127.0.0.1, `/tools`, a 64-hex token.
    public static func connection(_ file: String) throws -> ToolBridge.Connection {
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        let value = try JSONValue.parse(data)
        guard let url = value["url"]?.string, let token = value["token"]?.string, let target = URL(string: url),
              target.scheme == "http", target.host == "127.0.0.1", target.path == "/tools", token.matches("^[a-f0-9]{64}$") else {
            throw SandboxError("Invalid local tool connection")
        }
        return ToolBridge.Connection(url: url, token: token)
    }

    /// The MCP server: the tool definitions, each call forwarded to the bridge (the worker validates the arguments too;
    /// published JSON schemas are not enforcement). `definitions`: another tool set served the same way.
    public static func server(_ connection: ToolBridge.Connection, definitions: [(name: String, description: String, inputSchema: JSONValue)] = SandboxToolsSpec.definitions,
                              name: String = serverName, session: URLSession = .shared, output: FileHandle = .standardOutput) -> MCPServer {
        let tools = definitions.map { definition in
            MCPServer.Tool(name: definition.name, description: definition.description, inputSchema: definition.inputSchema) { arguments in
                let answer = try await forward(connection, name: definition.name, arguments: arguments, session: session)
                let text = (answer["content"]?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n")
                if answer["isError"]?.bool == true { throw SandboxError(text) }
                return text
            }
        }
        return MCPServer(name: name, version: "1.0.0", tools: tools, output: output)
    }

    static func forward(_ connection: ToolBridge.Connection, name: String, arguments: JSONValue, session: URLSession) async throws -> JSONValue {
        var request = URLRequest(url: URL(string: connection.url)!)
        request.httpMethod = "POST"
        request.timeoutInterval = 230
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = Data(JSONValue.object(["name": .string(name), "args": arguments.isNull ? .object([:]) : arguments]).text().utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SandboxError("The sandbox tool connection is unavailable")
        }
        return try JSONValue.parse(data)
    }

    /// `--mcp sandbox-local <connection>`: serves until stdin closes. → the process exit status.
    public static func main(arguments: [String]) -> Int32 {
        do {
            guard let file = arguments.first else { throw SandboxError("Invalid local tool connection") }
            server(try connection(file)).runForever()
            return 0
        } catch {
            FileHandle.standardError.write(Data("Canvas sandbox tools failed to start.\n".utf8))
            return 1
        }
    }
}
