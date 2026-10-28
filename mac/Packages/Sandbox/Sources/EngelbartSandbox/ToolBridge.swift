import Foundation
import Network
import CryptoKit
import EngelbartCore

/// local-tools.cjs's `openToolBridge`: a loopback HTTP endpoint (`POST http://127.0.0.1:<port>/tools`) that the stdio MCP
/// adapter (`--mcp sandbox-local`, LocalMCP.swift) forwards Claude's tool calls to. Its random 64-hex capability reaches
/// only the tools of the one setup that opened it. A Build's run step and Connect's imports serve their own tools the same
/// way (they may use this type through the app).
public final class ToolBridge: @unchecked Sendable {
    public struct Connection: Codable, Equatable, Sendable {
        public var url: String
        public var token: String
    }

    /// A tool's answer that is MCP content as it stands (local-tools.cjs's `mcpContent`), not a value to wrap as text.
    public static func mcpContent(_ content: [JSONValue]) -> JSONValue { ["__mcpContent": .array(content)] }

    public let connection: Connection
    private let listener: NWListener
    private let queue = DispatchQueue(label: "engelbart.sandbox.bridge")
    private let call: (String, JSONValue?) async throws -> JSONValue
    private let secrets: [String]
    private let maxBody: Int
    private let signal: AbortSignal?
    private let connections = Locked<[ObjectIdentifier: NWConnection]>([:])

    private init(listener: NWListener, port: UInt16, token: String, call: @escaping (String, JSONValue?) async throws -> JSONValue,
                 secrets: [String], maxBody: Int, signal: AbortSignal?) {
        self.listener = listener; self.call = call; self.secrets = secrets; self.maxBody = maxBody; self.signal = signal
        connection = Connection(url: "http://127.0.0.1:\(port)/tools", token: token)
    }

    /// Opens the bridge on a free loopback port.
    public static func open(_ call: @escaping (String, JSONValue?) async throws -> JSONValue, secrets: [String] = [],
                            signal: AbortSignal? = nil, maxBody: Int = 128_000) async throws -> ToolBridge {
        try signal?.throwIfAborted()
        let token = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        let ready = Deferred<UInt16>()
        let holder = Locked<ToolBridge?>(nil)
        listener.newConnectionHandler = { connection in holder.value?.accept(connection) }
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.resolve(listener.port?.rawValue ?? 0)
            case .failed(let error): ready.reject(error)
            default: break
            }
        }
        let queue = DispatchQueue(label: "engelbart.sandbox.bridge.listener")
        // The bridge is made before the listener starts so no connection arrives without it.
        let pending = Locked<(UInt16) -> ToolBridge>({ port in
            ToolBridge(listener: listener, port: port, token: token, call: call, secrets: secrets, maxBody: maxBody, signal: signal)
        })
        listener.start(queue: queue)
        let port = try await ready.wait()
        let bridge = pending.value(port)
        holder.with { $0 = bridge }
        return bridge
    }

    public func close() {
        listener.cancel()
        for connection in connections.value.values { connection.cancel() }
        connections.with { $0 = [:] }
    }

    private func accept(_ connection: NWConnection) {
        connections.with { $0[ObjectIdentifier(connection)] = connection }
        connection.start(queue: queue)
        receive(connection, Data())
    }

    private func receive(_ connection: NWConnection, _ buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = HTTPRequest.parse(buffer) {
                if request.bodyTooLarge(self.maxBody) { self.reply(connection, 413, ["error": "Request too large"]); return }
                if request.complete { self.handle(connection, request); return }
            }
            if buffer.count > self.maxBody + 16_384 { self.reply(connection, 413, ["error": "Request too large"]); return }
            if complete || error != nil { connection.cancel(); self.forget(connection); return }
            self.receive(connection, buffer)
        }
    }

    private func forget(_ connection: NWConnection) { connections.with { $0[ObjectIdentifier(connection)] = nil } }

    private func handle(_ connection: NWConnection, _ request: HTTPRequest) {
        let port = URL(string: self.connection.url)?.port ?? 0
        let supplied = Data((request.headers["authorization"] ?? "").utf8)
        let expected = Data("Bearer \(self.connection.token)".utf8)
        guard request.method == "POST", request.path == "/tools", request.headers["origin"] == nil,
              request.headers["host"] == "127.0.0.1:\(port)", supplied.count == expected.count, Self.equalInConstantTime(supplied, expected) else {
            reply(connection, 403, ["error": "Forbidden"]); return
        }
        Task {
            do {
                try self.signal?.throwIfAborted()
                let body = try JSONValue.parse(request.body)
                let value = try await self.call(body["name"]?.string ?? "", body["args"])
                if let content = value["__mcpContent"]?.array { self.reply(connection, 200, ["content": .array(content)]); return }
                self.reply(connection, 200, ["content": [["type": "text", "text": .string(Redact.value(value, self.secrets).text())]]])
            } catch {
                let failure = error as? SandboxError
                let text: String
                if let failure, failure.details["app"] != nil || failure.details["dependency_install"] != nil {
                    var details: [String: JSONValue] = ["error": .string(failure.message.tail(2000))]
                    for key in ["app", "app_changes", "failed_check", "dependency_install"] { if let v = failure.details[key] { details[key] = v } }
                    text = JSONValue.object(details).text()
                } else { text = message(of: error).tail(2000) }
                self.reply(connection, 200, ["isError": true, "content": [["type": "text", "text": .string(Redact.string(text, self.secrets))]]])
            }
        }
    }

    static func equalInConstantTime(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    private func reply(_ connection: NWConnection, _ status: Int, _ body: JSONValue) {
        let data = Data(body.text().utf8)
        let reason = [200: "OK", 403: "Forbidden", 413: "Payload Too Large"][status] ?? "Error"
        var head = "HTTP/1.1 \(status) \(reason)\r\ncontent-type: application/json\r\ncache-control: no-store\r\n"
        head += "content-length: \(data.count)\r\nconnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + data, completion: .contentProcessed { [weak self] _ in
            connection.cancel(); self?.forget(connection)
        })
    }
}

/// A minimal HTTP/1.1 request reader: request line, headers (lowercased names), a Content-Length body.
struct HTTPRequest {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data
    var contentLength: Int
    var complete: Bool { body.count >= contentLength }
    func bodyTooLarge(_ max: Int) -> Bool { contentLength > max || body.count > max }

    static func parse(_ data: Data) -> HTTPRequest? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[data.startIndex..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let body = Data(data[end.upperBound...])
        return HTTPRequest(method: String(first[0]), path: String(first[1]), headers: headers, body: body,
                           contentLength: Int(headers["content-length"] ?? "0") ?? 0)
    }
}
