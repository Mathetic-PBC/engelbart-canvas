import Foundation
import EngelbartCore

/// The MCP servers Build gives the CLIs (engelbart-mcp.cjs, run-mcp.cjs over sandbox/local-mcp.cjs): the app launched as
/// `<Engelbart> --mcp engelbart <connection.json>` (a Build turn's tools) or `--mcp run <connection.json>` (the run
/// step's). Each holds no credentials: it reads the loopback bridge's address and token from the file and forwards every
/// call there (230 s a call). The app's entry point calls `BuildMCP.server(name, arguments)` when it sees `--mcp`.
public enum BuildMCP {
    public static let names = ["engelbart", "run"]

    /// The connection file, checked as local-mcp.cjs checks it.
    public static func connection(_ file: String) throws -> BridgeConnection {
        guard let value = Files.readJSON(URL(fileURLWithPath: file)), let url = value["url"]?.string, let token = value["token"]?.string,
              let parsed = URL(string: url), parsed.scheme == "http", parsed.host == "127.0.0.1", parsed.path == "/tools",
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw BuildError("Invalid local tool connection")
        }
        return BridgeConnection(url: url, token: token)
    }

    /// The server for `--mcp <name> <connection.json>`; nil for a name that is not Build's.
    public static func server(_ name: String, _ arguments: [String], output: FileHandle = .standardOutput) throws -> MCPServer? {
        let definitions: [MCPServer.Tool.Definition]
        let serverName: String
        switch name {
        case "engelbart": definitions = EngelbartTools.definitions; serverName = "engelbart"
        case "run": definitions = RunTools.definitions; serverName = "engelbart-run-step"
        default: return nil
        }
        guard let file = arguments.first else { throw BuildError("Invalid local tool connection") }
        let conn = try connection(file)
        let tools = definitions.map { def in
            MCPServer.Tool(name: def.name, description: def.description, inputSchema: def.inputSchema) { args in
                // The bridge validates arguments too; published JSON schemas are not enforcement.
                let out: JSONValue
                do { out = try await ToolBridge.post(conn, name: def.name, args: args) }
                catch { throw BuildError("The sandbox tool connection is unavailable") }
                let text = out["content"]?[0]?["text"]?.string ?? ""
                if out["isError"]?.bool == true { throw BuildError(text) }
                return text
            }
        }
        return MCPServer(name: serverName, version: "1.0.0", tools: tools, output: output)
    }
}
