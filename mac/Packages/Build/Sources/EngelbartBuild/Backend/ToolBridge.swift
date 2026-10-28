import Foundation
import Network
import EngelbartCore

/// The loopback bridge between a CLI's MCP server and the app (sandbox/local-tools.cjs openToolBridge, which the Build
/// turns and the run step use): an HTTP server on 127.0.0.1 with one route, POST /tools, reached only with a random
/// 64-hex bearer token, no Origin header and the exact Host. Each call is `{ name, args }`; the answer is MCP content:
/// the tool's value as JSON text, or `isError` with the message's last 2000 characters. The MCP server (this executable
/// with `--mcp engelbart|run <connection.json>`) holds no credentials: the token reaches only the one turn that opened it.
public final class ToolBridge: @unchecked Sendable {
    public typealias Call = @Sendable (_ name: String, _ args: JSONValue) async throws -> JSONValue

    public let connection: BridgeConnection
    private let listener: NWListener
    private let queue = DispatchQueue(label: "engelbart.build.bridge")
    private let call: Call
    private let maxBody: Int
    private let signal: CancelSignal?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private let lock = NSLock()

    private init(listener: NWListener, port: UInt16, token: String, call: @escaping Call, maxBody: Int, signal: CancelSignal?) {
        self.listener = listener
        self.connection = BridgeConnection(url: "http://127.0.0.1:\(port)/tools", token: token)
        self.call = call
        self.maxBody = maxBody
        self.signal = signal
    }

    static func token() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Opens the bridge on a free loopback port.
    public static func open(maxBody: Int = 128_000, signal: CancelSignal? = nil, _ call: @escaping Call) async throws -> ToolBridge {
        if signal?.isAborted == true { throw BuildError("Stopped.") }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params)
        let token = token()
        let box = BridgeBox()
        let port: UInt16 = try await withCheckedThrowingContinuation { (c: CheckedContinuation<UInt16, Error>) in
            let once = OnceFlag()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: if once.claim() { c.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error): if once.claim() { c.resume(throwing: error) }
                case .cancelled: if once.claim() { c.resume(throwing: BuildError("The bridge closed.")) }
                default: break
                }
            }
            listener.newConnectionHandler = { conn in box.bridge?.accept(conn) ?? conn.cancel() }
            listener.start(queue: DispatchQueue(label: "engelbart.build.bridge.listener"))
        }
        let bridge = ToolBridge(listener: listener, port: port, token: token, call: call, maxBody: maxBody, signal: signal)
        box.bridge = bridge
        return bridge
    }

    public func close() async {
        listener.cancel()
        lock.lock(); let open = Array(connections.values); connections = [:]; lock.unlock()
        open.forEach { $0.cancel() }
    }

    private func accept(_ conn: NWConnection) {
        lock.lock(); connections[ObjectIdentifier(conn)] = conn; lock.unlock()
        conn.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state { self?.forget(conn) }
            if case .failed = state { self?.forget(conn) }
        }
        conn.start(queue: queue)
        read(conn, Data())
    }

    private func forget(_ conn: NWConnection) { lock.lock(); connections[ObjectIdentifier(conn)] = nil; lock.unlock() }

    private func read(_ conn: NWConnection, _ held: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { conn.cancel(); return }
            var buffer = held
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
                let body = buffer[end.upperBound...]
                self.handle(conn, head: head, body: Data(body), complete: complete || error != nil)
                return
            }
            if complete || error != nil { conn.cancel(); return }
            if buffer.count > 64_000 { self.reply(conn, 431, ["error": "Request too large"]); return }
            self.read(conn, buffer)
        }
    }

    private func handle(_ conn: NWConnection, head: String, body: Data, complete: Bool) {
        let lines = head.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ").map(String.init)
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let supplied = Data((headers["authorization"] ?? "").utf8), expected = Data("Bearer \(connection.token)".utf8)
        let port = URL(string: connection.url)?.port ?? 0
        guard request.count >= 2, request[0] == "POST", request[1] == "/tools", headers["origin"] == nil,
              headers["host"] == "127.0.0.1:\(port)", supplied.count == expected.count, ToolBridge.constantTimeEqual(supplied, expected) else {
            reply(conn, 403, ["error": "Forbidden"]); return
        }
        let length = Int(headers["content-length"] ?? "") ?? body.count
        if length > maxBody { reply(conn, 413, ["error": "Request too large"]); return }
        readBody(conn, body, length)
    }

    private func readBody(_ conn: NWConnection, _ held: Data, _ length: Int) {
        if held.count >= length { run(conn, held.prefix(length)); return }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = held
            if let data { buffer.append(data) }
            if buffer.count > self.maxBody { self.reply(conn, 413, ["error": "Request too large"]); return }
            if buffer.count >= length || complete || error != nil { self.run(conn, buffer.prefix(length)); return }
            self.readBody(conn, buffer, length)
        }
    }

    private func run(_ conn: NWConnection, _ body: Data) {
        let call = self.call, signal = self.signal
        Task {
            do {
                if signal?.isAborted == true { throw BuildError("This operation was aborted") }
                let request = try JSONValue.parse(body)
                let value = try await call(request["name"]?.string ?? "", request["args"] ?? .null)
                self.reply(conn, 200, ["content": [["type": "text", "text": .string(value.text())]]])
            } catch {
                self.reply(conn, 200, ["isError": true, "content": [["type": "text", "text": .string(String(error.text.suffix(2000)))]]])
            }
        }
    }

    private func reply(_ conn: NWConnection, _ status: Int, _ data: JSONValue) {
        let body = Data(data.text().utf8)
        let reason = [200: "OK", 403: "Forbidden", 413: "Payload Too Large", 431: "Request Header Fields Too Large"][status] ?? "Error"
        let head = "HTTP/1.1 \(status) \(reason)\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: \(body.count)\r\nconnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
    }

    static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    /// A call through the bridge, as the MCP server makes it (and the tests, and the fake run agent): → the MCP response
    /// `{ content, isError? }`.
    public static func post(_ connection: BridgeConnection, name: String, args: JSONValue, timeout: TimeInterval = 230) async throws -> JSONValue {
        guard let url = URL(string: connection.url) else { throw BuildError("Invalid local tool connection") }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(JSONValue.object(["name": .string(name), "args": args]).text().utf8)
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BuildError("The sandbox tool connection is unavailable") }
        return try JSONValue.parse(data)
    }

    /// A tool's value through the bridge, as an agent's client reads it: the JSON in its text, or the error thrown.
    public static func use(_ connection: BridgeConnection, _ name: String, _ args: JSONValue) async throws -> JSONValue {
        let out = try await post(connection, name: name, args: args)
        let text = out["content"]?[0]?["text"]?.string ?? ""
        if out["isError"]?.bool == true { throw BuildError(text) }
        return try JSONValue.parse(text)
    }
}

private final class BridgeBox: @unchecked Sendable { weak var bridge: ToolBridge? }
