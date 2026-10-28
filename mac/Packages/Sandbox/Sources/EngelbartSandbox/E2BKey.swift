import Foundation
import EngelbartCore

/// An HTTP layer the package's own requests go through (the E2B key, the preview check, GitHub's tree). Tests pass a fake;
/// nothing in a test reaches the network.
public protocol HTTPFetching: Sendable {
    /// → (status, headers, body). `followRedirects: false` answers a redirect as itself (`redirect: 'manual'`).
    func fetch(_ request: URLRequest, followRedirects: Bool) async throws -> (Int, [String: String], Data)
}

/// URLSession, with redirects followed or not.
public final class URLSessionFetcher: NSObject, HTTPFetching, URLSessionTaskDelegate, @unchecked Sendable {
    public static let shared = URLSessionFetcher()
    private let session: URLSession
    private let noRedirects: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        session = URLSession(configuration: configuration)
        let delegate = NoRedirect()
        noRedirects = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        super.init()
    }

    public func fetch(_ request: URLRequest, followRedirects: Bool) async throws -> (Int, [String: String], Data) {
        let (data, response) = try await (followRedirects ? session : noRedirects).data(for: request)
        let http = response as? HTTPURLResponse
        var headers: [String: String] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] { headers[String(describing: k).lowercased()] = String(describing: v) }
        return (http?.statusCode ?? 0, headers, data)
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}

/// src/main/github/e2b-key.cjs: the E2B API key for whoever is signed in, from mathetic.com's `/api/e2b/key`, which answers
/// any token GitHub confirms was issued to the Engelbart App. Memory only: never written to disk or logged, dropped on
/// sign-out, fetched again after. `override`: an unpackaged copy's own E2B_API_KEY, answered as is, signed in or not;
/// never in a release.
public final class E2BKey: @unchecked Sendable {
    public static let keyHost = "https://mathetic.com"

    private let token: @Sendable () async -> String?
    private let version: String
    private let target: URL
    private let fetcher: HTTPFetching
    private let override: String?
    private let lock = NSLock()
    private var pending: Task<String, Error>?

    /// `token`: the GitHub sign-in's token, nil when signed out. `host`: `ENGELBART_E2B_KEY_HOST` for scripted runs.
    public init(token: @escaping @Sendable () async -> String?, version: String, host: String = E2BKey.keyHost,
                fetcher: HTTPFetching = URLSessionFetcher.shared, override: String? = nil) throws {
        guard let url = URL(string: host), url.scheme == "https" || (url.scheme == "http" && url.host == "127.0.0.1") else {
            throw SandboxError("The E2B key requires HTTPS")
        }
        self.token = token; self.version = version; self.target = url; self.fetcher = fetcher; self.override = override
    }

    private func request(_ token: String) async throws -> String {
        var request = URLRequest(url: target.appendingPathComponent("api/e2b/key"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("engelbart-desktop/\(version)", forHTTPHeaderField: "x-engelbart-client")
        // redirect: 'error': a redirect is refused.
        let (status, _, body) = try await fetcher.fetch(request, followRedirects: false)
        if (300..<400).contains(status) { throw SandboxError("E2B key request failed (\(status))") }
        guard (200..<300).contains(status) else { throw SandboxError("E2B key request failed (\(status))") }
        guard let key = (try? JSONValue.parse(body))?["e2bApiKey"]?.string, !key.isEmpty else { throw SandboxError("E2B key response had no key") }
        return key
    }

    /// The key, or nil when signed out. Callers at the same time share one request; a failed one is not kept.
    public func get() async throws -> String? {
        if let override { return override }
        guard let token = await token() else {
            lock.withLock { pending = nil }
            return nil
        }
        let attempt: Task<String, Error> = lock.withLock {
            if let pending { return pending }
            let attempt = Task { try await self.request(token) }
            pending = attempt
            return attempt
        }
        do { return try await attempt.value } catch {
            lock.withLock { if pending == attempt { pending = nil } }
            throw error
        }
    }

    public func forget() { lock.lock(); pending = nil; lock.unlock() }
}

// src/main/sandbox/config.cjs: the sandbox's configuration from dotenv files and the environment. Keys stay in the main
// process; nothing here reaches a renderer. Setup is the local Claude Code subscription's alone: no Anthropic key or hc
// model setting is read.
public enum SandboxConfig {
    public static let keys: Set<String> = ["E2B_API_KEY", "E2B_TEMPLATE", "E2B_DOCKER_TEMPLATE", "ENGELBART_SANDBOX_CLAUDE_MODEL"]

    /// `readSandboxEnv(root, env)`. `localFile`: the checkout's `.env.local` (Electron read the repository's own; a
    /// bundled app has none).
    public static func read(root: String, env: [String: String] = ProcessInfo.processInfo.environment, localFile: String? = nil) throws -> [String: String] {
        func load(_ file: String?) throws -> [String: String] {
            guard let file else { return [:] }
            do { return parseEnv(try String(contentsOfFile: file, encoding: .utf8)) }
            catch let error as NSError where error.domain == NSCocoaErrorDomain && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError) { return [:] }
        }
        let local = try load(localFile)
        let personal = try load((root as NSString).appendingPathComponent("sandbox.env"))
        let selected = env["ENGELBART_SANDBOX_ENV_FILE"] ?? personal["ENGELBART_SANDBOX_ENV_FILE"] ?? local["ENGELBART_SANDBOX_ENV_FILE"]
        var values = local
        for (k, v) in try load(selected?.isEmpty == false ? selected : nil) { values[k] = v }
        for (k, v) in personal { values[k] = v }
        for (k, v) in env { values[k] = v }
        return values.filter { keys.contains($0.key) }
    }

    /// Node's `util.parseEnv`: `KEY=value` lines, `export ` allowed, `#` comments, single/double/backtick quotes
    /// (double quotes expand `\n`), unquoted values end at ` #`.
    public static func parseEnv(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            var line = lines[i].trimmingCharacters(in: .whitespaces)
            i += 1
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if let quote = value.first, ["\"", "'", "`"].contains(quote) {
                var body = String(value.dropFirst())
                // A quoted value may span lines.
                while !body.contains(quote), i < lines.count { body += "\n" + lines[i]; i += 1 }
                if let end = body.firstIndex(of: quote) { body = String(body[..<end]) }
                value = quote == "\"" ? body.replacingOccurrences(of: "\\n", with: "\n") : body
            } else if let hash = value.range(of: " #") {
                value = value[..<hash.lowerBound].trimmingCharacters(in: .whitespaces)
            }
            if !key.isEmpty { out[key] = value }
        }
        return out
    }
}
