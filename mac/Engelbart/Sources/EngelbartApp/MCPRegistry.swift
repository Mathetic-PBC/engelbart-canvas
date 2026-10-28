import EngelbartCore
import Foundation

/// Engelbart's own MCP servers, by name. The Electron app gave the `claude`/`codex` CLIs its servers
/// (bart/papers-mcp.cjs, build/engelbart-mcp.cjs, build/run-mcp.cjs, connect/import-mcp.cjs, sandbox/local-mcp.cjs) by
/// launching Electron as Node on a script; the Swift app launches itself: `Engelbart --mcp <name> [args…]`
/// (EngelbartCore.MCPLaunch builds the command). The entry point looks for `--mcp` before it starts any UI.
///
/// WAVE 2: each package registers its server at startup of the `--mcp` path, before `serve` runs, from
/// `MCPServers.registerAll()` (MCPServers.swift), e.g. `MCPRegistry.register("papers") { args in Papers.server(args) }`.
public enum MCPRegistry {
    public typealias Factory = ([String]) throws -> MCPServer
    private static var factories: [String: Factory] = [:]
    private static let lock = NSLock()

    public static func register(_ name: String, _ factory: @escaping Factory) {
        lock.lock(); factories[name] = factory; lock.unlock()
    }

    public static var names: [String] { lock.lock(); defer { lock.unlock() }; return factories.keys.sorted() }

    public static func factory(_ name: String) -> Factory? { lock.lock(); defer { lock.unlock() }; return factories[name] }

    /// `--mcp <name> [args…]` in `arguments` (argv without the executable) → (name, the arguments after it); nil otherwise.
    public static func request(in arguments: [String]) -> (name: String, args: [String])? {
        guard let at = arguments.firstIndex(of: "--mcp") else { return nil }
        let rest = Array(arguments[(at + 1)...])
        guard let name = rest.first, !name.isEmpty else { return ("", []) }
        return (name, Array(rest.dropFirst()))
    }

    /// Serves the named server until stdin closes. → the exit status: 0 when it ran, 2 for an unknown name or one that
    /// failed to build (the message on stderr).
    public static func serve(_ name: String, args: [String], input: FileHandle = .standardInput,
                             errors: FileHandle = .standardError) -> Int32 {
        guard let factory = factory(name) else {
            errors.write(Data("Unknown MCP server: \(name)\n".utf8))
            return 2
        }
        do {
            let server = try factory(args)
            server.runForever(input: input)
            return 0
        } catch {
            errors.write(Data("MCP server \(name) failed to start: \(error.localizedDescription)\n".utf8))
            return 2
        }
    }
}

/// The app's MCP servers. WAVE 2: add each package's `MCPRegistry.register` call here.
public enum MCPServers {
    public static func registerAll() {
        // A server that answers `ping` and lists no tools: proves the `--mcp` path from a CLI (and the tests) end to end.
        MCPRegistry.register("ping") { _ in MCPServer(name: "engelbart-ping", tools: []) }
    }
}
