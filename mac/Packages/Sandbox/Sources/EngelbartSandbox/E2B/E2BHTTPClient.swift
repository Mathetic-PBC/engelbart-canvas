import Foundation
import EngelbartCore

/// E2B over URLSession: the REST API (`https://api.<domain>`, `X-API-KEY`) and each sandbox's envd (`https://sandbox.<domain>`
/// with `E2b-Sandbox-Id`/`E2b-Sandbox-Port: 49983`/`X-Access-Token`), whose process service is Connect-RPC with the JSON
/// codec (`useBinaryFormat: false`): unary calls as `application/json`, server streams as `application/connect+json`
/// envelopes (1 flag byte, 4-byte big-endian length, JSON; flag 0x02 ends the stream). Names and fields follow
/// node_modules/e2b/dist/index.js (SandboxApi, Sandbox, Commands, Pty, Filesystem, CommandHandle).
public final class E2BHTTPClient: E2BService, @unchecked Sendable {
    public struct Configuration: Sendable {
        public var domain: String
        public var apiURL: String
        /// `E2B_SANDBOX_URL`: one address for every sandbox's envd (debug setups).
        public var sandboxURL: String?
        public var debug: Bool

        /// From the environment as the SDK reads it: `E2B_DOMAIN`, `E2B_API_URL`, `E2B_SANDBOX_URL`, `E2B_DEBUG`.
        public static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Configuration {
            let domain = env["E2B_DOMAIN"].flatMap { $0.isEmpty ? nil : $0 } ?? "e2b.app"
            let debug = (env["E2B_DEBUG"] ?? "false").lowercased() == "true"
            return Configuration(domain: domain, apiURL: env["E2B_API_URL"].flatMap { $0.isEmpty ? nil : $0 } ?? (debug ? "http://localhost:3000" : "https://api.\(domain)"),
                                 sandboxURL: env["E2B_SANDBOX_URL"].flatMap { $0.isEmpty ? nil : $0 }, debug: debug)
        }

        public init(domain: String = "e2b.app", apiURL: String? = nil, sandboxURL: String? = nil, debug: Bool = false) {
            self.domain = domain; self.apiURL = apiURL ?? "https://api.\(domain)"; self.sandboxURL = sandboxURL; self.debug = debug
        }
    }

    static let supportedDomains = ["e2b.app", "e2b.dev", "e2b.pro", "e2b-staging.dev"]
    static let envdPort = 49983
    static let defaultRequestTimeoutMs = 60_000
    static let defaultSandboxTimeoutMs = 300_000

    let configuration: Configuration
    let sessionConfiguration: URLSessionConfiguration
    let session: URLSession

    public init(configuration: Configuration = .fromEnvironment(), sessionConfiguration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
        let config = sessionConfiguration
        config.timeoutIntervalForResource = 30 * 24 * 3600 // long-lived streams (an app's command lives as long as its sandbox)
        self.sessionConfiguration = config
        self.session = URLSession(configuration: config)
    }

    // MARK: REST

    static func seconds(_ ms: Int) -> Int { Int((Double(ms) / 1000).rounded(.up)) }

    func rest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: JSONValue? = nil, apiKey: String, requestTimeoutMs: Int?) async throws -> (Int, JSONValue?) {
        guard var components = URLComponents(string: configuration.apiURL + path) else { throw SandboxError("Invalid E2B address") }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw SandboxError("Invalid E2B address") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = Double(requestTimeoutMs ?? Self.defaultRequestTimeoutMs) / 1000
        request.setValue(apiKey, forHTTPHeaderField: "X-API-KEY")
        request.setValue("e2b", forHTTPHeaderField: "publisher")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(body.text().utf8)
        }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch let error as URLError where error.code == .timedOut {
            throw SandboxError("Request timed out", name: "TimeoutError")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (status, data.isEmpty ? nil : try? JSONValue.parse(data))
    }

    /// `handleApiError` / `apiErrorFromCode`.
    static func apiError(_ status: Int, _ body: JSONValue?) -> SandboxError {
        let content = body?["message"]?.string ?? body?.string ?? HTTPURLResponse.localizedString(forStatusCode: status)
        switch status {
        case 401: return SandboxError("Unauthorized, please check your credentials.\(content.isEmpty ? "" : " - \(content)")", name: "AuthenticationError", status: status)
        case 429: return SandboxError("Rate limit exceeded, please try again later\(content.isEmpty ? "" : " - \(content)")", name: "RateLimitError", status: status)
        case 503: return SandboxError("Service temporarily unavailable, please retry\(content.isEmpty ? "" : " - \(content)")", name: "ServiceBusyError", status: status)
        default: return SandboxError("\(status): \(content)", name: "SandboxError", status: status)
        }
    }

    static func isOK(_ status: Int) -> Bool { (200..<300).contains(status) }

    public func create(template: String, _ options: E2BCreateOptions, apiKey: String) async throws -> E2BSandbox {
        var body: [String: JSONValue] = [
            "templateID": .string(template),
            "timeout": .number(Double(Self.seconds(options.timeoutMs))),
            "secure": true, "allow_internet_access": true,
        ]
        if !options.metadata.isEmpty { body["metadata"] = .object(options.metadata.mapValues { .string($0) }) }
        if options.pauseOnTimeout { body["autoPause"] = true }
        if options.autoResume { body["autoResume"] = ["enabled": true] }
        let (status, data) = try await rest("POST", "/sandboxes", body: .object(body), apiKey: apiKey, requestTimeoutMs: options.requestTimeoutMs)
        guard Self.isOK(status), let data else { throw Self.apiError(status, data) }
        return try sandbox(from: data, apiKey: apiKey)
    }

    func sandbox(from data: JSONValue, apiKey: String, id: String? = nil) throws -> E2BSandbox {
        guard let sandboxId = id ?? data["sandboxID"]?.string else { throw SandboxError("Sandbox not found") }
        return E2BRemoteSandbox(client: self, sandboxId: sandboxId, sandboxDomain: data["domain"]?.string.flatMap { $0.isEmpty ? nil : $0 },
                                envdVersion: data["envdVersion"]?.string ?? "0.4.0", envdAccessToken: data["envdAccessToken"]?.string, apiKey: apiKey)
    }

    public func connect(_ sandboxId: String, apiKey: String, timeoutMs: Int?, requestTimeoutMs: Int?) async throws -> E2BSandbox {
        let (status, data) = try await rest("POST", "/sandboxes/\(sandboxId)/connect",
                                            body: ["timeout": .number(Double(Self.seconds(timeoutMs ?? Self.defaultSandboxTimeoutMs)))],
                                            apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
        if status == 404 { throw SandboxError("Paused sandbox \(sandboxId) not found", name: "SandboxNotFoundError", status: 404) }
        guard Self.isOK(status), let data else { throw Self.apiError(status, data) }
        return try sandbox(from: data, apiKey: apiKey, id: sandboxId)
    }

    public func kill(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> Bool {
        let (status, data) = try await rest("DELETE", "/sandboxes/\(sandboxId)", apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
        if status == 404 { return false }
        guard Self.isOK(status) else { throw Self.apiError(status, data) }
        return true
    }

    static func info(_ data: JSONValue) -> E2BSandboxInfo {
        var metadata: [String: String] = [:]
        for (k, v) in data["metadata"]?.object ?? [:] { if let s = v.string { metadata[k] = s } }
        let endAt = data["endAt"]?.string.flatMap { Time.parse($0) }.map { Time.ms($0) } ?? 0
        return E2BSandboxInfo(sandboxId: data["sandboxID"]?.string ?? "", state: data["state"]?.string ?? "", endAt: endAt, metadata: metadata)
    }

    public func getInfo(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> E2BSandboxInfo {
        let (status, data) = try await rest("GET", "/sandboxes/\(sandboxId)", apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
        if status == 404 { throw SandboxError("Sandbox \(sandboxId) not found", name: "SandboxNotFoundError", status: 404) }
        guard Self.isOK(status), let data else { throw Self.apiError(status, data) }
        return Self.info(data)
    }

    public func pause(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> Bool {
        let (status, data) = try await rest("POST", "/sandboxes/\(sandboxId)/pause", body: ["memory": true], apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
        if status == 404 { throw SandboxError("Sandbox \(sandboxId) not found", name: "SandboxNotFoundError", status: 404) }
        if status == 409 { return false }
        guard Self.isOK(status) else { throw Self.apiError(status, data) }
        return true
    }

    public func setTimeout(_ sandboxId: String, timeoutMs: Int, apiKey: String, requestTimeoutMs: Int?) async throws {
        let (status, data) = try await rest("POST", "/sandboxes/\(sandboxId)/timeout", body: ["timeout": .number(Double(Self.seconds(timeoutMs)))],
                                            apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
        if status == 404 { throw SandboxError("Sandbox \(sandboxId) not found", name: "SandboxNotFoundError", status: 404) }
        guard Self.isOK(status) else { throw Self.apiError(status, data) }
    }

    public func list(metadata: [String: String], states: [String], apiKey: String, requestTimeoutMs: Int?) async throws -> [E2BSandboxInfo] {
        var query: [URLQueryItem] = []
        if !metadata.isEmpty {
            // URLSearchParams of the encoded pairs, as the SDK builds it.
            var pairs = URLComponents()
            pairs.queryItems = metadata.keys.sorted().map { URLQueryItem(name: $0, value: metadata[$0]) }
            query.append(URLQueryItem(name: "metadata", value: pairs.percentEncodedQuery ?? ""))
        }
        if !states.isEmpty { query.append(URLQueryItem(name: "state", value: states.joined(separator: ","))) }
        let (status, data) = try await rest("GET", "/v2/sandboxes", query: query, apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
        guard Self.isOK(status) else { throw Self.apiError(status, data) }
        return (data?.array ?? []).map(Self.info)
    }
}

/// One connected sandbox: its envd.
final class E2BRemoteSandbox: E2BSandbox, @unchecked Sendable {
    let client: E2BHTTPClient
    let sandboxId: String
    let sandboxDomain: String
    let envdVersion: String
    let envdAccessToken: String?
    let apiKey: String
    let envdURL: String

    init(client: E2BHTTPClient, sandboxId: String, sandboxDomain: String?, envdVersion: String, envdAccessToken: String?, apiKey: String) {
        self.client = client; self.sandboxId = sandboxId; self.envdVersion = envdVersion; self.envdAccessToken = envdAccessToken; self.apiKey = apiKey
        let domain = sandboxDomain ?? client.configuration.domain
        self.sandboxDomain = domain
        let c = client.configuration
        if let url = c.sandboxURL { envdURL = url }
        else if c.debug { envdURL = "http://localhost:\(E2BHTTPClient.envdPort)" }
        else if E2BHTTPClient.supportedDomains.contains(domain) { envdURL = "https://sandbox.\(domain)" }
        else { envdURL = "https://\(E2BHTTPClient.envdPort)-\(sandboxId).\(domain)" }
    }

    func getHost(_ port: Int) -> String {
        client.configuration.debug ? "localhost:\(port)" : "\(port)-\(sandboxId).\(sandboxDomain)"
    }

    func setTimeout(_ timeoutMs: Int, requestTimeoutMs: Int?) async throws {
        try await client.setTimeout(sandboxId, timeoutMs: timeoutMs, apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
    }

    func kill(requestTimeoutMs: Int?) async throws {
        _ = try await client.kill(sandboxId, apiKey: apiKey, requestTimeoutMs: requestTimeoutMs)
    }

    /// `authenticationHeader(envdVersion, user)`: envd before 0.4.0 needs the default user named.
    func authorization(_ user: String?) -> String? {
        var user = user
        if user == nil, compareVersions(envdVersion, "0.4.0") < 0 { user = "user" }
        guard let user else { return nil }
        return "Basic " + Data("\(user):".utf8).base64EncodedString()
    }

    func envdRequest(_ path: String, query: [URLQueryItem] = [], contentType: String? = nil) -> URLRequest {
        var components = URLComponents(string: envdURL + path)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(sandboxId, forHTTPHeaderField: "E2b-Sandbox-Id")
        request.setValue(String(E2BHTTPClient.envdPort), forHTTPHeaderField: "E2b-Sandbox-Port")
        if let envdAccessToken { request.setValue(envdAccessToken, forHTTPHeaderField: "X-Access-Token") }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return request
    }

    // MARK: Connect-RPC unary

    func unary(_ method: String, _ body: JSONValue, user: String? = nil, requestTimeoutMs: Int?) async throws -> JSONValue {
        var request = envdRequest("/process.Process/\(method)", contentType: "application/json")
        request.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
        let timeout = requestTimeoutMs ?? E2BHTTPClient.defaultRequestTimeoutMs
        if timeout > 0 {
            request.setValue(String(timeout), forHTTPHeaderField: "Connect-Timeout-Ms")
            request.timeoutInterval = Double(timeout) / 1000
        }
        if let auth = authorization(user) { request.setValue(auth, forHTTPHeaderField: "Authorization") }
        request.httpBody = Data(body.text().utf8)
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await client.session.data(for: request) }
        catch { throw SandboxError("[unavailable] \(message(of: error))", name: "TimeoutError") }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONValue.parse(data)) ?? .object([:])
        if status != 200 { throw ConnectRPC.error(code: json["code"]?.string ?? ConnectRPC.code(forHTTP: status), message: json["message"]?.string ?? "") }
        return json
    }

    // MARK: Commands

    func startProcess(_ body: JSONValue, user: String?, timeoutMs: Int?, requestTimeoutMs: Int?, signal: AbortSignal?,
                      onStdout: ((String) -> Void)?, onStderr: ((String) -> Void)?, onPty: ((Data) -> Void)?, method: String = "Start") async throws -> E2BCommandHandle {
        var request = envdRequest("/process.Process/\(method)", contentType: "application/connect+json")
        request.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
        request.setValue("50", forHTTPHeaderField: "Keepalive-Ping-Interval")
        let timeout = timeoutMs ?? 60_000
        if timeout > 0 { request.setValue(String(timeout), forHTTPHeaderField: "Connect-Timeout-Ms") }
        request.timeoutInterval = 300 // idle limit between packets; envd pings every 50 s
        if let auth = authorization(user) { request.setValue(auth, forHTTPHeaderField: "Authorization") }
        request.httpBody = ConnectRPC.envelope(body)
        let handle = RemoteCommandHandle(sandbox: self, onStdout: onStdout, onStderr: onStderr, onPty: onPty)
        try await handle.open(request, configuration: client.sessionConfiguration,
                              requestTimeoutMs: requestTimeoutMs ?? E2BHTTPClient.defaultRequestTimeoutMs, signal: signal)
        return handle
    }

    func processBody(_ command: String, _ options: CommandOptions) -> JSONValue {
        var process: [String: JSONValue] = ["cmd": "/bin/bash", "args": ["-l", "-c", .string(command)],
                                            "envs": .object(options.envs.mapValues { .string($0) })]
        if let cwd = options.cwd { process["cwd"] = .string(cwd) }
        return ["process": .object(process), "stdin": false]
    }

    func run(_ command: String, _ options: CommandOptions) async throws -> CommandResult {
        let handle = try await start(command, options)
        return try await handle.wait()
    }

    func start(_ command: String, _ options: CommandOptions) async throws -> E2BCommandHandle {
        try await startProcess(processBody(command, options), user: options.user, timeoutMs: options.timeoutMs, requestTimeoutMs: options.requestTimeoutMs,
                               signal: options.signal, onStdout: options.onStdout, onStderr: options.onStderr, onPty: nil)
    }

    func signal(pid: Int, requestTimeoutMs: Int?) async throws -> Bool {
        do {
            _ = try await unary("SendSignal", ["process": ["selector": ["pid": .number(Double(pid))]], "signal": "SIGNAL_SIGKILL"], requestTimeoutMs: requestTimeoutMs)
            return true
        } catch let error as SandboxError where error.isNotFound { return false }
    }

    // MARK: Files

    func writeFile(_ path: String, _ text: String) async throws {
        let boundary = "engelbart-\(UUID().uuidString)"
        var query = [URLQueryItem(name: "path", value: path)]
        if compareVersions(envdVersion, "0.4.0") < 0 { query.append(URLQueryItem(name: "username", value: "user")) }
        var request = envdRequest("/files", query: query, contentType: "multipart/form-data; boundary=\(boundary)")
        request.timeoutInterval = Double(E2BHTTPClient.defaultRequestTimeoutMs) / 1000
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(path)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
        body.append(Data(text.utf8))
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        request.httpBody = body
        let (data, response) = try await client.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { throw SandboxError("File not found", name: "NotFoundError", status: 404) }
        guard (200..<300).contains(status) else {
            throw SandboxError((try? JSONValue.parse(data))?["message"]?.string ?? "Could not write \(path) (\(status))", status: status)
        }
    }

    func readFile(_ path: String, maxBytes: Int, signal: AbortSignal?, requestTimeoutMs: Int?) async throws -> Data {
        var query = [URLQueryItem(name: "path", value: path)]
        if compareVersions(envdVersion, "0.4.0") < 0 { query.append(URLQueryItem(name: "username", value: "user")) }
        var request = envdRequest("/files", query: query)
        request.httpMethod = "GET"
        request.timeoutInterval = Double(requestTimeoutMs ?? E2BHTTPClient.defaultRequestTimeoutMs) / 1000
        let reader = BoundedReader(limit: maxBytes)
        return try await reader.read(request, configuration: client.sessionConfiguration, signal: signal)
    }

    // MARK: Pty

    func ptyCreate(cols: Int, rows: Int, cwd: String?, envs: [String: String], timeoutMs: Int, requestTimeoutMs: Int?,
                   onData: @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle {
        var env = envs
        if env["TERM"] == nil { env["TERM"] = "xterm-256color" }
        if env["LANG"] == nil { env["LANG"] = "C.UTF-8" }
        if env["LC_ALL"] == nil { env["LC_ALL"] = "C.UTF-8" }
        var process: [String: JSONValue] = ["cmd": "/bin/bash", "args": ["-i", "-l"], "envs": .object(env.mapValues { .string($0) })]
        if let cwd { process["cwd"] = .string(cwd) }
        let body: JSONValue = ["process": .object(process), "pty": ["size": ["cols": .number(Double(cols)), "rows": .number(Double(rows))]]]
        return try await startProcess(body, user: nil, timeoutMs: timeoutMs, requestTimeoutMs: requestTimeoutMs, signal: nil,
                                      onStdout: nil, onStderr: nil, onPty: onData)
    }

    func ptyConnect(pid: Int, timeoutMs: Int, requestTimeoutMs: Int?, onData: @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle {
        try await startProcess(["process": ["selector": ["pid": .number(Double(pid))]]], user: nil, timeoutMs: timeoutMs, requestTimeoutMs: requestTimeoutMs,
                               signal: nil, onStdout: nil, onStderr: nil, onPty: onData, method: "Connect")
    }

    func ptySendInput(pid: Int, _ data: Data, requestTimeoutMs: Int?) async throws {
        _ = try await unary("SendInput", ["process": ["selector": ["pid": .number(Double(pid))]], "input": ["pty": .string(data.base64EncodedString())]],
                            requestTimeoutMs: requestTimeoutMs)
    }

    func ptyResize(pid: Int, cols: Int, rows: Int, requestTimeoutMs: Int?) async throws {
        _ = try await unary("Update", ["process": ["selector": ["pid": .number(Double(pid))]], "pty": ["size": ["cols": .number(Double(cols)), "rows": .number(Double(rows))]]],
                            requestTimeoutMs: requestTimeoutMs)
    }

    func ptyKill(pid: Int, requestTimeoutMs: Int?) async throws -> Bool { try await signal(pid: pid, requestTimeoutMs: requestTimeoutMs) }
}

/// `compare-versions` for envd's x.y.z.
func compareVersions(_ a: String, _ b: String) -> Int {
    let pa = a.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    let pb = b.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    for i in 0..<max(pa.count, pb.count) {
        let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
        if x != y { return x < y ? -1 : 1 }
    }
    return 0
}

enum ConnectRPC {
    static func envelope(_ message: JSONValue, flags: UInt8 = 0) -> Data {
        let json = Data(message.text().utf8)
        var data = Data([flags])
        var length = UInt32(json.count).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        data.append(json)
        return data
    }

    static func code(forHTTP status: Int) -> String {
        switch status {
        case 400: return "invalid_argument"
        case 401: return "unauthenticated"
        case 403: return "permission_denied"
        case 404: return "not_found"
        case 408: return "deadline_exceeded"
        case 429, 502, 503, 504: return "unavailable"
        default: return "unknown"
        }
    }

    /// `handleRpcError`'s map from Connect codes to the SDK's errors.
    static func error(code: String, message: String) -> SandboxError {
        let text = "[\(code)] \(message)"
        switch code {
        case "not_found": return SandboxError(text, name: "NotFoundError", status: 404)
        case "invalid_argument": return SandboxError(text, name: "InvalidArgumentError")
        case "unauthenticated": return SandboxError(text, name: "AuthenticationError")
        case "resource_exhausted": return SandboxError("\(text): Rate limit exceeded, please try again later.", name: "RateLimitError")
        case "unavailable", "canceled", "deadline_exceeded": return SandboxError(text, name: "TimeoutError")
        default: return SandboxError("\(code): \(message)", name: "SandboxError")
        }
    }
}

/// A Connect server stream to one process: its start event gives the pid, data events its output, the end event its result.
final class RemoteCommandHandle: NSObject, E2BCommandHandle, URLSessionDataDelegate, @unchecked Sendable {
    private weak var sandbox: E2BRemoteSandbox?
    private let onStdout: ((String) -> Void)?
    private let onStderr: ((String) -> Void)?
    private let onPty: ((Data) -> Void)?
    private let lock = NSLock()
    private var buffer = Data()
    private var stdoutText = "", stderrText = ""
    private var stdoutBytes = Data(), stderrBytes = Data()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var disconnected = false
    private var result: CommandResult?
    private var streamError: SandboxError?
    private var httpStatus = 200
    private let started = Deferred<Int>()
    private let finished = Deferred<Void>()
    private(set) var pid: Int = 0

    init(sandbox: E2BRemoteSandbox, onStdout: ((String) -> Void)?, onStderr: ((String) -> Void)?, onPty: ((Data) -> Void)?) {
        self.sandbox = sandbox; self.onStdout = onStdout; self.onStderr = onStderr; self.onPty = onPty
    }

    func open(_ request: URLRequest, configuration: URLSessionConfiguration, requestTimeoutMs: Int, signal: AbortSignal?) async throws {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: request)
        lock.withLock { self.session = session; self.task = task }
        let abortId = signal?.onAbort { [weak self] in self?.fail(SandboxError("This operation was aborted", name: "AbortError")) }
        // The handshake's limit: the start event must come within requestTimeoutMs.
        if requestTimeoutMs > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + Double(requestTimeoutMs) / 1000) { [weak self] in
                guard let self, !self.started.isSettled else { return }
                self.fail(SandboxError("Request handshake timed out after \(requestTimeoutMs)ms", name: "TimeoutError"))
            }
        }
        task.resume()
        do { pid = try await started.wait() } catch {
            if let abortId { signal?.removeListener(abortId) }
            throw error
        }
    }

    private func fail(_ error: SandboxError) {
        lock.withLock { if streamError == nil && result == nil { streamError = error } }
        started.reject(error)
        lock.withLock { task }?.cancel()
        finished.resolve(())
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if httpStatus != 200 { lock.withLock { buffer.append(data) }; return }
        lock.lock(); buffer.append(data)
        var messages: [(UInt8, JSONValue)] = []
        while buffer.count >= 5 {
            let flags = buffer[buffer.startIndex]
            let length = buffer[(buffer.startIndex + 1)..<(buffer.startIndex + 5)].reduce(0) { ($0 << 8) | Int($1) }
            guard buffer.count >= 5 + length else { break }
            let payload = buffer[(buffer.startIndex + 5)..<(buffer.startIndex + 5 + length)]
            buffer = Data(buffer[(buffer.startIndex + 5 + length)...])
            messages.append((flags, (try? JSONValue.parse(Data(payload))) ?? .null))
        }
        lock.unlock()
        for (flags, message) in messages { handle(flags: flags, message) }
    }

    private func handle(flags: UInt8, _ message: JSONValue) {
        if flags & 0x02 != 0 {
            if let error = message["error"], !error.isNull {
                let code = error["code"]?.string ?? "unknown"
                // A process stream lost before its start: the sandbox is not running (handleProcessStartEvent).
                if !started.isSettled && code == "unavailable" { fail(SandboxError("Sandbox is probably not running anymore", name: "SandboxNotFoundError")); return }
                fail(ConnectRPC.error(code: code, message: error["message"]?.string ?? ""))
            }
            return
        }
        guard let event = message["event"] else { return }
        if let start = event["start"] { started.resolve(start["pid"]?.int ?? 0); return }
        if let data = event["data"] {
            let disconnected = lock.withLock { self.disconnected }
            if let b = data["stdout"]?.string.flatMap({ Data(base64Encoded: $0) }) {
                let text = decode(b, stderr: false)
                lock.withLock { stdoutText += text }
                if !disconnected, !text.isEmpty { onStdout?(text) }
            }
            if let b = data["stderr"]?.string.flatMap({ Data(base64Encoded: $0) }) {
                let text = decode(b, stderr: true)
                lock.withLock { stderrText += text }
                if !disconnected, !text.isEmpty { onStderr?(text) }
            }
            if let b = data["pty"]?.string.flatMap({ Data(base64Encoded: $0) }), !disconnected { onPty?(b) }
            return
        }
        if let end = event["end"] {
            let r = lock.withLock { () -> CommandResult in
                // proto3 JSON leaves out zero values: no exitCode is 0.
                let value = CommandResult(exitCode: end["exitCode"]?.int ?? 0, stdout: stdoutText, stderr: stderrText,
                                          error: end["error"]?.string ?? (end["exitCode"]?.int ?? 0 != 0 ? end["status"]?.string : nil))
                result = value
                return value
            }
            _ = r
        }
    }

    /// UTF-8 across chunk boundaries (TextDecoder's stream mode): an incomplete tail waits for the next chunk.
    private func decode(_ data: Data, stderr: Bool) -> String {
        lock.lock(); defer { lock.unlock() }
        var bytes = (stderr ? stderrBytes : stdoutBytes) + data
        var cut = bytes.count
        // Back up over a partial trailing sequence.
        var i = bytes.count - 1, back = 0
        while i >= 0, back < 4, (bytes[bytes.startIndex + i] & 0xC0) == 0x80 { i -= 1; back += 1 }
        if i >= 0 {
            let lead = bytes[bytes.startIndex + i]
            let need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
            if need > back + 1 { cut = i }
        }
        let text = String(decoding: bytes.prefix(cut), as: UTF8.self)
        bytes = Data(bytes.suffix(from: bytes.startIndex + cut))
        if stderr { stderrBytes = bytes } else { stdoutBytes = bytes }
        return text
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if httpStatus != 200 {
            let body = lock.withLock { buffer }
            let json = (try? JSONValue.parse(body)) ?? .object([:])
            fail(ConnectRPC.error(code: json["code"]?.string ?? ConnectRPC.code(forHTTP: httpStatus), message: json["message"]?.string ?? ""))
        } else if let error, lock.withLock({ result == nil && !disconnected }) {
            // The connection dropped mid-stream (a sandbox going to sleep does this): no exit code.
            fail(SandboxError("[unavailable] the connection to sandbox ended before the stream completed: \(error.localizedDescription)", name: "TimeoutError"))
        } else if !started.isSettled {
            fail(SandboxError("Expected start event"))
        }
        finished.resolve(())
        session.finishTasksAndInvalidate()
    }

    func wait() async throws -> CommandResult {
        _ = try? await finished.wait()
        let (result, error) = lock.withLock { (self.result, self.streamError) }
        if let result {
            if result.exitCode != 0 {
                throw SandboxError(result.error ?? "exit status \(result.exitCode)", name: "CommandExitError", exitCode: result.exitCode)
            }
            return result
        }
        throw error ?? SandboxError("Process exited without a result")
    }

    func disconnect() async {
        lock.withLock { disconnected = true }
        lock.withLock { task }?.cancel()
    }

    func kill() async throws -> Bool {
        guard let sandbox else { return false }
        return try await sandbox.signal(pid: pid, requestTimeoutMs: nil)
    }
}

/// A GET that stops after `limit` bytes and cancels the rest.
final class BoundedReader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int
    private var data = Data()
    private var status = 0
    private let done = Deferred<Data>()
    private let lock = NSLock()

    init(limit: Int) { self.limit = limit }

    func read(_ request: URLRequest, configuration: URLSessionConfiguration, signal: AbortSignal?) async throws -> Data {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: request)
        signal?.onAbort { [weak self] in self?.done.reject(signal?.reason ?? SandboxError("This operation was aborted", name: "AbortError")); task.cancel() }
        task.resume()
        defer { session.invalidateAndCancel() }
        return try await done.wait()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        let full = lock.withLock { () -> Bool in data.append(chunk); return status == 200 && data.count >= limit }
        if full { done.resolve(lock.withLock { Data(data.prefix(limit)) }); dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = lock.withLock { data }
        if status == 404 { done.reject(SandboxError((try? JSONValue.parse(body))?["message"]?.string ?? "File not found", name: "NotFoundError", status: 404)); return }
        if status != 200 && status != 0 { done.reject(SandboxError((try? JSONValue.parse(body))?["message"]?.string ?? "Could not read the file (\(status))", status: status)); return }
        if let error { done.reject(SandboxError(error.localizedDescription, name: "TimeoutError")); return }
        done.resolve(Data(body.prefix(limit)))
    }
}
