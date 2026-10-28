import Foundation
import Network
import EngelbartCore

/// What a tool call answers when it is not plain JSON: MCP content (a screenshot), passed through as it is
/// (sandbox/local-tools.cjs mcpContent).
public struct MCPContent: Sendable { public var content: JSONValue; public init(_ content: JSONValue) { self.content = content } }

/// Port of sandbox/local-tools.cjs openToolBridge: the loopback HTTP endpoint an import's `--mcp import` server calls. One
/// per import: http://127.0.0.1:<port>/tools, a 64-hex bearer token, POST only, the Host checked, no Origin (no page can
/// reach it), the body at most `maxBody` (413), the tool's answer as `{ content }`, an error as `{ isError, content }`.
public final class ToolBridge: @unchecked Sendable {
    public struct Connection: Sendable, Equatable, Codable { public var url: String; public var token: String }
    public typealias Call = (_ name: String, _ args: JSONValue) async throws -> Any

    public let connection: Connection
    private let listener: NWListener
    private let queue = DispatchQueue(label: "engelbart.connect.bridge")
    private let call: Call
    private let maxBody: Int
    private let signal: AbortSignal?

    private init(listener: NWListener, port: UInt16, token: String, call: @escaping Call, maxBody: Int, signal: AbortSignal?) {
        self.listener = listener; self.call = call; self.maxBody = maxBody; self.signal = signal
        connection = Connection(url: "http://127.0.0.1:\(port)/tools", token: token)
    }

    public static func open(_ call: @escaping Call, signal: AbortSignal? = nil, maxBody: Int = 128_000) async throws -> ToolBridge {
        if signal?.isAborted == true { throw ConnectError.stopped() }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        let ready = AsyncReady()
        let holder = Holder()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.resume(.success(listener.port?.rawValue ?? 0))
            case .failed(let error): ready.resume(.failure(error))
            default: break
            }
        }
        listener.newConnectionHandler = { conn in holder.bridge?.serve(conn) }
        listener.start(queue: DispatchQueue(label: "engelbart.connect.bridge.listener"))
        let port = try await ready.value()
        let bridge = ToolBridge(listener: listener, port: port, token: token, call: call, maxBody: maxBody, signal: signal)
        holder.bridge = bridge
        return bridge
    }

    public func close() { listener.cancel() }

    final class Holder: @unchecked Sendable { var bridge: ToolBridge? }
    final class AsyncReady: @unchecked Sendable {
        private let lock = NSLock()
        private var result: Result<UInt16, Error>?
        private var waiter: CheckedContinuation<UInt16, Error>?
        func resume(_ r: Result<UInt16, Error>) {
            lock.lock()
            if result != nil { lock.unlock(); return }
            result = r
            let w = waiter
            waiter = nil
            lock.unlock()
            w?.resume(with: r)
        }
        func value() async throws -> UInt16 {
            try await withCheckedThrowingContinuation { c in
                lock.lock()
                if let result { lock.unlock(); c.resume(with: result); return }
                waiter = c
                lock.unlock()
            }
        }
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        var buffer = Data()
        func receive() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
                guard let self else { conn.cancel(); return }
                if let data { buffer.append(data) }
                if let request = HTTPRequest.parse(buffer) {
                    if request.contentLength > self.maxBody { self.reply(conn, 413, ["error": "Request too large"]); return }
                    if request.complete { self.handle(conn, request); return }
                }
                if buffer.count > self.maxBody + 16_384 { self.reply(conn, 413, ["error": "Request too large"]); return }
                if complete || error != nil { conn.cancel(); return }
                receive()
            }
        }
        receive()
    }

    private func handle(_ conn: NWConnection, _ request: HTTPRequest) {
        let port = listener.port?.rawValue ?? 0
        let expected = "Bearer \(connection.token)"
        guard request.method == "POST", request.path == "/tools", request.headers["origin"] == nil, request.headers["host"] == "127.0.0.1:\(port)",
              constantTimeEqual(request.headers["authorization"] ?? "", expected) else {
            reply(conn, 403, ["error": "Forbidden"]); return
        }
        Task {
            do {
                if self.signal?.isAborted == true { throw ConnectError.stopped() }
                let body = try JSONValue.parse(request.body)
                let value = try await self.call(body["name"]?.string ?? "", body["args"] ?? .object([:]))
                if let content = value as? MCPContent { self.reply(conn, 200, ["content": content.content]); return }
                let json = (value as? JSONValue) ?? JSONValue(any: value)
                self.reply(conn, 200, ["content": [["type": "text", "text": .string(json.text())]]])
            } catch {
                let message = (error as? ConnectError)?.message ?? error.localizedDescription
                self.reply(conn, 200, ["isError": true, "content": [["type": "text", "text": .string(String(message.suffix(2000)))]]])
            }
        }
    }

    private func reply(_ conn: NWConnection, _ status: Int, _ body: JSONValue) {
        let data = Data(body.text().utf8)
        let reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : "Payload Too Large"
        var head = "HTTP/1.1 \(status) \(reason)\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: \(data.count)\r\nconnection: close\r\n\r\n"
        if status == 0 { head = "" }
        conn.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in conn.cancel() })
    }
}

func constantTimeEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
}

/// A small HTTP/1.1 request reader for the loopback servers (the tool bridge, the connectors' sign-in callback).
struct HTTPRequest {
    var method: String
    var path: String
    var query: [String: String]
    var headers: [String: String]
    var body: Data
    var contentLength: Int
    var complete: Bool

    static func parse(_ data: Data) -> HTTPRequest? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[data.startIndex..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[end.upperBound...]
        let target = String(first[1])
        let comps = URLComponents(string: "http://localhost\(target)")
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] where query[item.name] == nil { query[item.name] = item.value ?? "" }
        return HTTPRequest(method: String(first[0]), path: comps?.path ?? target, query: query, headers: headers,
                           body: Data(body.prefix(length)), contentLength: length, complete: body.count >= length)
    }
}
