import Foundation
import EngelbartCore

// src/main/github/browser-auth.cjs: the shared GitHub App's sign-in in the person's default browser. Only this process
// knows the PKCE verifier; the browser carries a single-use code and a sealed ticket to a random loopback port, and
// Engelbart exchanges them at the broker (Mathetic-PBC/landing api/github) for the tokens. The broker refreshes too:
// the shared App's secret lives only there (docs/github-app-setup.md).

/// A browser sign-in under way: its start page, when it expires, its result, and how to stop it.
public final class BrowserFlow<Result: Sendable>: @unchecked Sendable {
    public let url: String
    public let expiresAt: Double
    private let lock = NSLock()
    private var outcome: Swift.Result<Result, Error>?
    private var waiters: [CheckedContinuation<Result, Error>] = []
    var onFinish: (() -> Void)?
    var cancelError: () -> Error = { HTTPError.cancelled }

    init(url: String, expiresAt: Double) { self.url = url; self.expiresAt = expiresAt }

    /// The tokens (or credentials), or the reason it ended.
    public func result() async throws -> Result {
        try await withCheckedThrowingContinuation { c in
            lock.lock()
            if let outcome { lock.unlock(); c.resume(with: outcome); return }
            waiters.append(c)
            lock.unlock()
        }
    }

    public var finished: Bool { lock.lock(); defer { lock.unlock() }; return outcome != nil }

    /// Ends it (cancel or timeout): the listener closes, the result fails. A second end changes nothing.
    @discardableResult
    func finish(_ value: Swift.Result<Result, Error>) -> Bool {
        lock.lock()
        if outcome != nil { lock.unlock(); return false }
        outcome = value
        let waiting = waiters
        waiters = []
        lock.unlock()
        onFinish?()
        waiting.forEach { $0.resume(with: value) }
        return true
    }

    public func cancel() { finish(.failure(cancelError())) }
}

public protocol GithubBrowserAuthorizing: Sendable {
    func start() async throws -> BrowserFlow<JSONValue>
    /// The broker's refresh of a browser token: GitHub's token answer ({ access_token, … } or { error }).
    func refresh(_ refreshToken: String) async throws -> JSONValue
}

public struct GithubBrokerError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

public final class GithubBrowserAuth: GithubBrowserAuthorizing, @unchecked Sendable {
    public static let broker = "https://engelbart.mathetic.com"
    public static let clientId = "Iv23liAZNYl96zlluMDs"

    let target: URL
    let http: HTTPClient
    let timeoutMs: Double
    let now: NowMs

    public init(broker: String = GithubBrowserAuth.broker, http: HTTPClient = URLSessionHTTPClient.shared, timeoutMs: Double = 600_000, now: @escaping NowMs = systemNow) throws {
        guard let url = URL(string: broker), let scheme = url.scheme else { throw GithubBrokerError(message: "GitHub sign-in requires HTTPS") }
        guard scheme == "https" || (scheme == "http" && url.host == "127.0.0.1") else { throw GithubBrokerError(message: "GitHub sign-in requires HTTPS") }
        self.target = url
        self.http = http
        self.timeoutMs = timeoutMs
        self.now = now
    }

    func exchange(_ body: JSONValue) async throws -> JSONValue {
        guard let url = URL(string: "/api/github/token", relativeTo: target)?.absoluteURL else { throw GithubBrokerError(message: "GitHub sign-in service is unavailable. Try again.") }
        let response = try await http.send(HTTPRequest(url: url, method: "POST", headers: ["content-type": "application/json"],
                                                       body: Data(body.text().utf8), redirect: .error, timeout: 20))
        guard let data = response.json else {
            if !response.ok && response.status >= 500 { throw GithubBrokerError(message: "GitHub sign-in service is unavailable. Try again.") }
            throw GithubBrokerError(message: "GitHub did not authorize this sign-in. Try again.")
        }
        if !response.ok && response.status >= 500 { throw GithubBrokerError(message: "GitHub sign-in service is unavailable. Try again.") }
        return data
    }

    public func refresh(_ refreshToken: String) async throws -> JSONValue {
        try await exchange(["refreshToken": .string(refreshToken)])
    }

    public func start() async throws -> BrowserFlow<JSONValue> {
        let state = PKCE.random(32), verifier = PKCE.random(48)
        let challenge = PKCE.challenge(verifier)
        let consuming = Box(false)
        let flowBox = Box<BrowserFlow<JSONValue>?>(nil)
        let portBox = Box<UInt16>(0)
        let server = try await LoopbackServer.start { [self] req in
            let port = portBox.value
            if req.headers["origin"] != nil || req.headers["host"] != "127.0.0.1:\(port)" { return signInPage(403, "Request refused") }
            guard req.method == "GET", req.path == "/oauth/github/callback", PKCE.same(req.query("state"), state) else {
                return signInPage(400, "Invalid sign-in callback")
            }
            guard let flow = flowBox.value else { return signInPage(400, "Invalid sign-in callback") }
            if flow.finished || consuming.value { return signInPage(409, "Sign-in already handled") }
            if req.hasQuery("error") {
                flow.finish(.failure(GithubBrokerError(message: "GitHub sign-in cancelled.")))
                return signInPage(200, "Sign-in cancelled")
            }
            guard let code = req.query("code"), !code.isEmpty, code.count <= 512, let ticket = req.query("ticket"), !ticket.isEmpty, ticket.count <= 2048 else {
                return signInPage(400, "Invalid sign-in callback")
            }
            consuming.value = true
            do {
                let data = try await self.exchange(["code": .string(code), "ticket": .string(ticket), "verifier": .string(verifier)])
                if flow.finished { return signInPage(410, "Sign-in expired or cancelled") }
                guard let token = data["access_token"]?.string, !token.isEmpty else {
                    throw GithubBrokerError(message: "GitHub did not authorize this sign-in. Try again.")
                }
                _ = token
                flow.finish(.success(data))
                return signInPage(200, "GitHub connected")
            } catch {
                flow.finish(.failure(error))
                return signInPage(502, "Sign-in did not complete. Try again in Engelbart.")
            }
        }
        portBox.value = server.port
        var start = URLComponents(url: URL(string: "/api/github/start", relativeTo: target)!.absoluteURL, resolvingAgainstBaseURL: false)!
        start.percentEncodedQuery = queryString([("port", String(server.port)), ("state", state), ("challenge", challenge)])
        let flow = BrowserFlow<JSONValue>(url: start.url!.absoluteString, expiresAt: now() + timeoutMs)
        flow.cancelError = { GithubBrokerError(message: "GitHub sign-in cancelled.") }
        let timer = DispatchWorkItem { [weak flow] in flow?.finish(.failure(GithubBrokerError(message: "GitHub sign-in expired. Try again."))) }
        flow.onFinish = { timer.cancel(); server.close() }
        flowBox.value = flow
        DispatchQueue.global().asyncAfter(deadline: .now() + timeoutMs / 1000, execute: timer)
        return flow
    }
}
