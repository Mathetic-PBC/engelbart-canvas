import Foundation
import EngelbartCore

/// An HTTP answer, its body read chunk by chunk (as the Electron code read `response.body.getReader()`), so a page that
/// is not what is wanted can be dropped after its first bytes.
public struct HTTPResponse: Sendable {
    public var status: Int
    /// Where it ended up after redirects.
    public var url: String
    /// Header names lower-cased.
    public var headers: [String: String]
    public var body: AsyncThrowingStream<Data, Error>
    public var cancel: @Sendable () -> Void

    public init(status: Int, url: String, headers: [String: String] = [:], body: AsyncThrowingStream<Data, Error>, cancel: @escaping @Sendable () -> Void = {}) {
        self.status = status; self.url = url; self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
        self.body = body; self.cancel = cancel
    }

    /// A whole body given at once (tests, fakes).
    public init(status: Int = 200, url: String, headers: [String: String] = [:], data: Data) {
        self.init(status: status, url: url, headers: headers, body: AsyncThrowingStream { c in if !data.isEmpty { c.yield(data) }; c.finish() })
    }

    public var ok: Bool { (200..<300).contains(status) }

    /// The whole body, refused past `max` bytes (`tooLarge` names why).
    public func data(max: Int = 50 * 1024 * 1024, tooLarge: String = "The answer is too large") async throws -> Data {
        var all = Data()
        for try await chunk in body {
            all.append(chunk)
            if all.count > max { cancel(); throw StoreError(tooLarge, code: "TOO_LARGE") }
        }
        return all
    }
}

/// `fetch(url, { headers, signal: timeout })`, following redirects, no cookies unless the app's session gives them.
public typealias HTTPFetch = @Sendable (_ url: String, _ headers: [String: String], _ timeout: TimeInterval) async throws -> HTTPResponse

public enum HTTP {
    /// URLSession, streaming, cookies off (page-meta.cjs: `credentials: 'omit'`).
    public static let fetch: HTTPFetch = { url, headers, timeout in
        guard let address = URL(string: url) else { throw StoreError.type("That link is not a valid address") }
        var request = URLRequest(url: address, timeoutInterval: timeout)
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration)
        let (bytes, response) = try await session.bytes(for: request)
        let http = response as? HTTPURLResponse
        var fields: [String: String] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] { if let k = k as? String, let v = v as? String { fields[k.lowercased()] = v } }
        let task = bytes.task
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            let reader = Task {
                do {
                    var chunk = Data(); chunk.reserveCapacity(65536)
                    for try await byte in bytes {
                        chunk.append(byte)
                        if chunk.count >= 65536 { continuation.yield(chunk); chunk = Data(); chunk.reserveCapacity(65536) }
                    }
                    if !chunk.isEmpty { continuation.yield(chunk) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
                session.finishTasksAndInvalidate()
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
        return HTTPResponse(status: http?.statusCode ?? 0, url: response.url?.absoluteString ?? url, headers: fields, body: stream, cancel: { task.cancel(); session.invalidateAndCancel() })
    }
}

/// The only network the library does (page-meta.cjs): a page added by its address is asked once for its own title and
/// description; a GitHub repository who it is; a repository with no clone for its top-level files. Best effort: a
/// timeout, http(s) only, no cookies.
public enum PageMeta {
    static let timeout: TimeInterval = 4
    static let maxHTMLChars = 300_000
    static let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]

    public struct About: Codable, Equatable, Sendable {
        public var title: String
        public var description: String
        public init(title: String, description: String) { self.title = title; self.description = description }
    }

    static func decode(_ text: String) -> String {
        var out = text
        out = replace(out, #"&#(\d+);"#) { m in Int(m[1]).flatMap(UnicodeScalar.init).map { String(Character($0)) } ?? m[0] }
        out = replace(out, #"&#x([0-9a-fA-F]+);"#) { m in Int(m[1], radix: 16).flatMap(UnicodeScalar.init).map { String(Character($0)) } ?? m[0] }
        out = replace(out, #"&(\w+);"#) { m in entities[m[1]] ?? m[0] }
        return out.collapsingWhitespace()
    }

    /// `text.replace(re, fn)` for every match; `fn` gets the match and its groups.
    static func replace(_ text: String, _ pattern: String, options: NSRegularExpression.Options = [], _ fn: ([String]) -> String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        let ns = text as NSString
        var out = "", last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let groups = (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
            out += fn(groups)
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    static func firstGroups(_ text: String, _ pattern: String, options: NSRegularExpression.Options = [.caseInsensitive]) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? nil : ns.substring(with: m.range(at: $0)) }
    }

    static func metaContent(_ html: String, _ key: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"<meta\b[^>]*>"#, options: [.caseInsensitive]) else { return "" }
        let ns = html as NSString
        let escaped = NSRegularExpression.escapedPattern(for: key)
        for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let tag = ns.substring(with: m.range)
            guard firstGroups(tag, #"\b(?:name|property)\s*=\s*["']"# + escaped + #"["']"#) != nil else { continue }
            if let content = firstGroups(tag, #"\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')"#) { return decode(content[1] ?? content[2] ?? "") }
        }
        return ""
    }

    /// `<title>` and the description a page gives of itself, from its html.
    public static func readHtmlMeta(_ html: String) -> About {
        let text = html.utf16.count > maxHTMLChars ? String(decoding: Array(html.utf16.prefix(maxHTMLChars)), as: UTF16.self) : html
        let title = firstGroups(text, #"<title\b[^>]*>([\s\S]*?)</title>"#)?[1] ?? ""
        let decoded = decode(title)
        return About(title: decoded.isEmpty ? metaContent(text, "og:title") : decoded,
                     description: metaContent(text, "description").isEmpty ? metaContent(text, "og:description") : metaContent(text, "description"))
    }

    static func get(_ url: String, fetch: HTTPFetch, headers: [String: String]) async throws -> HTTPResponse {
        guard url.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil else { throw StoreError.type("Only http(s) addresses are read") }
        let response = try await fetch(url, headers, timeout)
        guard response.ok else { response.cancel(); throw StoreError("The address answered \(response.status)") }
        return response
    }

    /// A GET of GitHub's API, signed in when `auth` gives headers; a refused token is tried once more without them.
    static func githubGet(_ url: String, fetch: HTTPFetch, auth: (@Sendable () async -> [String: String])?) async throws -> HTTPResponse {
        let plain = ["accept": "application/vnd.github+json"]
        let signed = await auth?() ?? [:]
        if signed["authorization"] != nil {
            do { return try await get(url, fetch: fetch, headers: plain.merging(signed) { _, b in b }) }
            catch { if error.localizedDescription.range(of: " 40[13]$", options: .regularExpression) == nil { throw error } }
        }
        return try await get(url, fetch: fetch, headers: plain)
    }

    /// Who a GitHub repository is: its id (which never changes), its current name and address, its description.
    public struct RepoIdentity: Codable, Equatable, Sendable {
        public var id: String
        public var fullName: String
        public var url: String
        public var description: String
        public init(id: String, fullName: String, url: String, description: String) { self.id = id; self.fullName = fullName; self.url = url; self.description = description }
    }
    public typealias IdentifyRepo = @Sendable (_ owner: String, _ name: String) async throws -> RepoIdentity
    public typealias Describe = @Sendable (_ found: Library.Found) async throws -> About?
    public typealias ListRemoteFiles = @Sendable (_ owner: String, _ repo: String) async throws -> [String]

    static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))) ?? s }

    public static func repoIdentifier(fetch: @escaping HTTPFetch = HTTP.fetch, auth: (@Sendable () async -> [String: String])? = nil) -> IdentifyRepo {
        { owner, name in
            let response = try await githubGet("https://api.github.com/repos/\(enc(owner))/\(enc(name))", fetch: fetch, auth: auth)
            let repo = try JSONValue.parse(try await response.data())
            guard let id = repo["id"]?.double, id.rounded() == id, id > 0, id < 9_007_199_254_740_992 else { throw StoreError("GitHub did not give the repository an id") }
            let fullName = repo["full_name"]?.string.flatMap { $0.range(of: #"^[\w.-]+/[\w.-]+$"#, options: .regularExpression) != nil ? $0 : nil } ?? "\(owner)/\(name)"
            return RepoIdentity(id: String(Int64(id)), fullName: fullName, url: "https://github.com/\(fullName)", description: repo["description"]?.string ?? "")
        }
    }

    /// What `addItem` asks of a page before it writes the row: html only.
    public static func describer(fetch: @escaping HTTPFetch = HTTP.fetch) -> Describe {
        { found in
            let response = try await get(found.url ?? "", fetch: fetch, headers: ["accept": "text/html"])
            guard (response.headers["content-type"] ?? "").range(of: "html", options: .caseInsensitive) != nil else { response.cancel(); return nil }
            return readHtmlMeta(String(decoding: try await response.data(max: 5 * 1024 * 1024), as: UTF8.self))
        }
    }

    /// Top-level files of a GitHub repository, folders first; remembered for as long as the app runs.
    public static func remoteFileLister(fetch: @escaping HTTPFetch = HTTP.fetch, auth: (@Sendable () async -> [String: String])? = nil, limit: Int = 40) -> ListRemoteFiles {
        let known = KnownFiles()
        return { owner, repo in
            let key = "\(owner)/\(repo)".lowercased()
            if let held = known.get(key) { return held }
            let response = try await githubGet("https://api.github.com/repos/\(owner)/\(repo)/contents", fetch: fetch, auth: auth)
            let entries = (try JSONValue.parse(try await response.data())).array ?? []
            let files = entries
                .filter { $0["name"]?.string != nil }
                .stableSorted { a, b in
                    let ad = a["type"]?.string == "dir", bd = b["type"]?.string == "dir"
                    if ad != bd { return ad }
                    return a["name"]!.string!.localizedCompare(b["name"]!.string!) == .orderedAscending
                }
                .prefix(limit)
                .map { $0["name"]!.string! + ($0["type"]?.string == "dir" ? "/" : "") }
            known.set(key, Array(files))
            return Array(files)
        }
    }

    final class KnownFiles: @unchecked Sendable {
        private let lock = NSLock(); private var files: [String: [String]] = [:]
        func get(_ key: String) -> [String]? { lock.lock(); defer { lock.unlock() }; return files[key] }
        func set(_ key: String, _ value: [String]) { lock.lock(); files[key] = value; lock.unlock() }
    }
}
