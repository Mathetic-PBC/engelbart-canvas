import Foundation
import EngelbartCore

// The `fetch` the Electron main process used for GitHub, Zotero, OpenAlex, arXiv and Overleaf, as a protocol so tests
// answer with fakes (or a loopback server) and the app with URLSession. Every request Electron made had
// `credentials: 'omit'`: the default client keeps no cookies and sends none. Overleaf's copy is the exception: it is
// downloaded with the Stage's own session (its sign-in), so the app hands that client in (Stage's WKWebsiteDataStore
// cookies), never this one.

public struct HTTPRequest: Sendable {
    /// `redirect` as fetch has it: follow them, hand the 3xx back (`manual`), or fail on one (`error`).
    public enum Redirect: Sendable { case follow, manual, error }

    public var url: URL
    public var method: String
    /// Header names as written; compared case-insensitively by servers.
    public var headers: [String: String]
    public var body: Data?
    public var redirect: Redirect
    /// Seconds until the response's headers must have come (fetch's AbortSignal.timeout).
    public var timeout: TimeInterval
    /// Seconds for the whole body, from the start (zotero/oa.cjs BODY_TIMEOUT_MS); nil: `timeout`.
    public var bodyTimeout: TimeInterval?
    /// A body larger than this fails with `HTTPError.tooLarge` as soon as it is seen (declared or streamed).
    public var maxBytes: Int?

    public init(url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil,
                redirect: Redirect = .follow, timeout: TimeInterval = 15, bodyTimeout: TimeInterval? = nil, maxBytes: Int? = nil) {
        self.url = url; self.method = method; self.headers = headers; self.body = body
        self.redirect = redirect; self.timeout = timeout; self.bodyTimeout = bodyTimeout; self.maxBytes = maxBytes
    }

    /// `application/x-www-form-urlencoded` body (URLSearchParams.toString()).
    public static func formBody(_ fields: [(String, String)]) -> Data {
        Data(fields.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&").utf8)
    }

    static func formEncode(_ text: String) -> String {
        // URLSearchParams: alphanumerics and *-._ kept, space as +, everything else percent-encoded.
        var allowed = asciiAlphanumerics
        allowed.insert(charactersIn: "*-._ ")
        let encoded = text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
        return encoded.replacingOccurrences(of: " ", with: "+")
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    /// Header names lowercased.
    public var headers: [String: String]
    public var body: Data
    /// The address the answer came from (after redirects that were followed).
    public var url: URL?

    public init(status: Int, headers: [String: String] = [:], body: Data = Data(), url: URL? = nil) {
        self.status = status
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, b in b })
        self.body = body
        self.url = url
    }

    public var ok: Bool { (200..<300).contains(status) }
    public func header(_ name: String) -> String? { headers[name.lowercased()] }
    /// `response.json()`, or nil when the body is not JSON.
    public var json: JSONValue? { try? JSONValue.parse(body) }
    public var text: String { String(decoding: body, as: UTF8.self) }

    public static func json(_ status: Int, _ value: JSONValue, headers: [String: String] = [:]) -> HTTPResponse {
        var all = headers
        all["content-type"] = all["content-type"] ?? "application/json"
        return HTTPResponse(status: status, headers: all, body: Data(value.text().utf8))
    }
}

public enum HTTPError: Error, LocalizedError, Equatable {
    case timedOut
    case tooLarge
    case redirected
    case cancelled
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .timedOut: return "The request timed out"
        case .tooLarge: return "The answer is too large"
        case .redirected: return "The request was redirected"
        case .cancelled: return "Stopped"
        case .failed(let why): return why
        }
    }
}

public protocol HTTPClient: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

/// A client from a closure (tests' fakes, and adapters the app makes).
public struct ClosureHTTPClient: HTTPClient {
    let handler: @Sendable (HTTPRequest) async throws -> HTTPResponse
    public init(_ handler: @escaping @Sendable (HTTPRequest) async throws -> HTTPResponse) { self.handler = handler }
    public func send(_ request: HTTPRequest) async throws -> HTTPResponse { try await handler(request) }
}

/// URLSession, with no cookies, no cache, and fetch's redirect modes.
public final class URLSessionHTTPClient: HTTPClient, @unchecked Sendable {
    private let configuration: URLSessionConfiguration

    public init(configuration: URLSessionConfiguration? = nil) {
        if let configuration { self.configuration = configuration } else {
            let c = URLSessionConfiguration.ephemeral
            c.httpCookieStorage = nil
            c.httpShouldSetCookies = false
            c.httpCookieAcceptPolicy = .never
            c.urlCache = nil
            c.requestCachePolicy = .reloadIgnoringLocalCacheData
            c.urlCredentialStorage = nil
            self.configuration = c
        }
    }

    public static let shared = URLSessionHTTPClient()

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        urlRequest.httpBody = request.body
        urlRequest.timeoutInterval = request.timeout
        let runner = TaskRunner(request: request)
        let config = configuration.copy() as! URLSessionConfiguration
        config.timeoutIntervalForRequest = request.timeout
        config.timeoutIntervalForResource = max(request.timeout, request.bodyTimeout ?? request.timeout)
        let session = URLSession(configuration: config, delegate: runner, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withTaskCancellationHandler {
            try await runner.run(session: session, request: urlRequest)
        } onCancel: {
            runner.cancel()
        }
    }

    private final class TaskRunner: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        let request: HTTPRequest
        private let lock = NSLock()
        private var continuation: CheckedContinuation<HTTPResponse, Error>?
        private var response: HTTPURLResponse?
        private var data = Data()
        private var task: URLSessionDataTask?
        private var redirectRefused = false
        private var tooLarge = false
        private var finished = false
        private var bodyTimer: DispatchWorkItem?
        private var timedOut = false

        init(request: HTTPRequest) { self.request = request }

        func run(session: URLSession, request urlRequest: URLRequest) async throws -> HTTPResponse {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<HTTPResponse, Error>) in
                lock.lock()
                continuation = c
                let task = session.dataTask(with: urlRequest)
                self.task = task
                lock.unlock()
                if let limit = request.bodyTimeout {
                    let work = DispatchWorkItem { [weak self] in
                        guard let self else { return }
                        self.lock.lock(); self.timedOut = true; let t = self.task; self.lock.unlock()
                        t?.cancel()
                    }
                    bodyTimer = work
                    DispatchQueue.global().asyncAfter(deadline: .now() + max(limit, request.timeout), execute: work)
                }
                task.resume()
            }
        }

        func cancel() {
            lock.lock(); let t = task; lock.unlock()
            t?.cancel()
        }

        private func finish(_ result: Result<HTTPResponse, Error>) {
            lock.lock()
            guard !finished, let c = continuation else { lock.unlock(); return }
            finished = true
            continuation = nil
            lock.unlock()
            bodyTimer?.cancel()
            c.resume(with: result)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            switch request.redirect {
            case .follow: completionHandler(newRequest)
            case .manual: completionHandler(nil)
            case .error:
                lock.lock(); redirectRefused = true; lock.unlock()
                completionHandler(nil)
            }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            let http = response as? HTTPURLResponse
            lock.lock(); self.response = http; let refused = redirectRefused; lock.unlock()
            if refused, let http, (300..<400).contains(http.statusCode) {
                completionHandler(.cancel)
                finish(.failure(HTTPError.redirected))
                return
            }
            if let limit = request.maxBytes, response.expectedContentLength > Int64(limit) {
                lock.lock(); tooLarge = true; lock.unlock()
                completionHandler(.cancel)
                finish(.failure(HTTPError.tooLarge))
                return
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
            lock.lock()
            data.append(chunk)
            let over = request.maxBytes.map { data.count > $0 } ?? false
            if over { tooLarge = true }
            lock.unlock()
            if over {
                dataTask.cancel()
                finish(.failure(HTTPError.tooLarge))
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let http = response ?? (task.response as? HTTPURLResponse)
            let body = data
            let refused = redirectRefused
            let wasTimedOut = timedOut
            lock.unlock()
            if let error {
                let ns = error as NSError
                if wasTimedOut || ns.code == NSURLErrorTimedOut { finish(.failure(HTTPError.timedOut)); return }
                if ns.code == NSURLErrorCancelled { finish(.failure(HTTPError.cancelled)); return }
                finish(.failure(HTTPError.failed(ns.localizedDescription)))
                return
            }
            guard let http else { finish(.failure(HTTPError.failed("No answer"))); return }
            if refused, (300..<400).contains(http.statusCode) { finish(.failure(HTTPError.redirected)); return }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let k = key as? String { headers[k.lowercased()] = "\(value)" }
            }
            finish(.success(HTTPResponse(status: http.statusCode, headers: headers, body: body, url: http.url)))
        }
    }
}

extension URL {
    /// `new URL(base) + path` for a fixed path on a base address that may carry its own path (`http://127.0.0.1:3000`).
    static func joined(_ base: String, _ path: String) -> URL? {
        URL(string: base.hasSuffix("/") && path.hasPrefix("/") ? String(base.dropLast()) + path : base + path)
    }
}

/// `URLSearchParams(...).toString()` for a query.
func queryString(_ fields: [(String, String)]) -> String {
    fields.map { "\(HTTPRequest.formEncode($0.0))=\(HTTPRequest.formEncode($0.1))" }.joined(separator: "&")
}

/// `encodeURIComponent`.
func encodeURIComponent(_ text: String) -> String {
    var allowed = asciiAlphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
}

/// A–Z, a–z, 0–9 only (CharacterSet.alphanumerics holds every script's letters, which URL encoding must escape).
let asciiAlphanumerics = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
