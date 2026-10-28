import Foundation
import Network

// The loopback listener of the browser sign-ins (github/browser-auth.cjs, zotero/browser-auth.cjs): Node's
// `http.createServer().listen(0, '127.0.0.1')`. Only 127.0.0.1, a port the system picks, one request per connection
// (the browser's single callback), answered and closed. Tests also use it to stand in for a broker or an API.

public struct LoopbackRequest: Sendable {
    public var method: String
    /// The request target as sent: path and query (`/oauth/github/callback?state=…`).
    public var target: String
    /// Header names lowercased.
    public var headers: [String: String]
    public var body: Data

    /// The target as a URL on 127.0.0.1, for its path and query.
    public var url: URL { URL(string: "http://127.0.0.1\(target.hasPrefix("/") ? target : "/" + target)") ?? URL(string: "http://127.0.0.1/")! }
    public var path: String { url.path }
    public func query(_ name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == name })?.value
    }
    public func hasQuery(_ name: String) -> Bool {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == name }) ?? false
    }
}

public struct LoopbackResponse: Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
    public static func text(_ status: Int, _ text: String, type: String = "text/plain; charset=utf-8") -> LoopbackResponse {
        LoopbackResponse(status: status, headers: ["Content-Type": type], body: Data(text.utf8))
    }
    public static func json(_ status: Int, _ text: String) -> LoopbackResponse {
        LoopbackResponse(status: status, headers: ["Content-Type": "application/json"], body: Data(text.utf8))
    }
}

public final class LoopbackServer: @unchecked Sendable {
    public typealias Handler = @Sendable (LoopbackRequest) async -> LoopbackResponse

    private let listener: NWListener
    private let queue = DispatchQueue(label: "engelbart.loopback")
    private let handler: Handler
    private let lock = NSLock()
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var closed = false
    public private(set) var port: UInt16 = 0

    private init(listener: NWListener, handler: @escaping Handler) {
        self.listener = listener
        self.handler = handler
    }

    /// Listens on 127.0.0.1 and a free port; answers once it is ready.
    public static func start(_ handler: @escaping Handler) async throws -> LoopbackServer {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        let server = LoopbackServer(listener: listener, handler: handler)
        try await server.begin()
        return server
    }

    private func begin() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            var resumed = false
            let once = NSLock()
            let resume: (Result<Void, Error>) -> Void = { result in
                once.lock(); defer { once.unlock() }
                guard !resumed else { return }
                resumed = true
                c.resume(with: result)
            }
            listener.stateUpdateHandler = { [weak self] state in 
                switch state {
                case .ready:
                    self?.port = self?.listener.port?.rawValue ?? 0
                    resume(.success(()))
                case .failed(let error): resume(.failure(error))
                case .cancelled: resume(.failure(HTTPError.cancelled))
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
        }
    }

    /// Stops listening (Node's server.close()): a later request is refused, one being answered still gets its answer.
    public func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        lock.unlock()
        listener.cancel()
    }

    /// close(), and every connection still open dropped (Node's closeAllConnections()).
    public func closeAll() {
        close()
        lock.lock()
        let open = Array(connections.values)
        connections.removeAll()
        lock.unlock()
        open.forEach { $0.cancel() }
    }

    public var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    private func accept(_ connection: NWConnection) {
        lock.lock()
        if closed { lock.unlock(); connection.cancel(); return }
        connections[ObjectIdentifier(connection)] = connection
        lock.unlock()
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.lock.lock(); self?.connections[ObjectIdentifier(connection)] = nil; self?.lock.unlock()
            default: break
            }
        }
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] chunk, _, complete, error in
            guard let self else { return }
            var data = buffer
            if let chunk { data.append(chunk) }
            if let request = Self.parse(data) {
                Task { [handler] in
                    let response = await handler(request)
                    self.respond(connection, response)
                }
                return
            }
            if complete || error != nil || data.count > 1_000_000 { connection.cancel(); return }
            self.read(connection, buffer: data)
        }
    }

    private func respond(_ connection: NWConnection, _ response: LoopbackResponse) {
        var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        for (name, value) in headers.sorted(by: { $0.key < $1.key }) { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(response.body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// One whole request (head, and a body as long as Content-Length says), or nil while more is to come.
    static func parse(_ data: Data) -> LoopbackRequest? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[data.startIndex..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let first = lines.removeFirst().split(separator: " ", maxSplits: 2).map(String.init)
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = end.upperBound
        guard data.count - (bodyStart - data.startIndex) >= length else { return nil }
        let body = data[bodyStart..<(bodyStart + length)]
        return LoopbackRequest(method: first[0], target: first[1], headers: headers, body: Data(body))
    }

    static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 302: return "Found"
        case 304: return "Not Modified"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 410: return "Gone"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }
}
