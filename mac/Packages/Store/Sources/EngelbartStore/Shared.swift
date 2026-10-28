import Foundation
import EngelbartCore

/// A web address as the WHATWG `URL` the Electron code used reads it, for the parts the store asks about: scheme, host
/// (lower-cased, default port dropped), pathname, search, hash and `href`.
public struct WebURL: Equatable, Sendable {
    public var scheme: String
    public var user: String?
    public var hostname: String
    public var port: Int?
    public var pathname: String
    public var query: String?
    public var fragment: String?
    let opaque: String?

    public init?(_ input: String) {
        let trimmed = input.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r\u{0}\u{0c}"))
        guard let colon = trimmed.firstIndex(of: ":") else { return nil }
        let scheme = String(trimmed[..<colon]).lowercased()
        guard scheme.range(of: "^[a-z][a-z0-9+.-]*$", options: .regularExpression) != nil else { return nil }
        self.scheme = scheme
        let special = ["http", "https", "file", "ftp", "ws", "wss"].contains(scheme)
        guard special else {
            // An opaque URL (about:blank, javascript:…, data:…, mailto:…): kept as written, its #fragment apart.
            let rest = String(trimmed[trimmed.index(after: colon)...])
            if let hash = rest.firstIndex(of: "#") { opaque = String(rest[..<hash]); fragment = String(rest[rest.index(after: hash)...]) }
            else { opaque = rest; fragment = nil }
            user = nil; hostname = ""; port = nil; pathname = opaque ?? ""; query = nil
            return
        }
        opaque = nil
        guard let url = URL(string: trimmed, encodingInvalidCharacters: true),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let host = (parts.percentEncodedHost ?? "").lowercased()
        if scheme != "file" && host.isEmpty { return nil }
        hostname = host
        user = parts.percentEncodedUser.map { u in parts.percentEncodedPassword.map { "\(u):\($0)" } ?? u }
        let defaults = ["http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21]
        port = parts.port.flatMap { $0 == defaults[scheme] ? nil : $0 }
        let path = parts.percentEncodedPath
        pathname = path.isEmpty ? "/" : Paths.normalizeURLPath(path)
        query = parts.percentEncodedQuery
        fragment = parts.percentEncodedFragment
    }

    public var protocolName: String { "\(scheme):" }
    /// `host`: the hostname and a port that is not the scheme's own.
    public var host: String { port.map { "\(hostname):\($0)" } ?? hostname }
    /// `search`: "?…" or "" (also for "?" alone).
    public var search: String { (query ?? "").isEmpty ? "" : "?\(query!)" }
    public var hash: String { (fragment ?? "").isEmpty ? "" : "#\(fragment!)" }
    public var href: String {
        if let opaque { return "\(scheme):\(opaque)\(fragment.map { "#\($0)" } ?? "")" }
        let auth = user.map { "\($0)@" } ?? ""
        return "\(scheme)://\(auth)\(host)\(pathname)\(query.map { "?\($0)" } ?? "")\(fragment.map { "#\($0)" } ?? "")"
    }
}

extension Paths {
    /// WHATWG folds "." and ".." segments in a special URL's path.
    static func normalizeURLPath(_ path: String) -> String {
        guard path.contains("/.") else { return path }
        var out: [String] = []
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        for (i, part) in parts.enumerated() {
            if part == "." { if i == parts.count - 1 { out.append("") }; continue }
            if part == ".." { if !out.isEmpty { out.removeLast() }; if i == parts.count - 1 { out.append("") }; continue }
            out.append(String(part))
        }
        return "/" + out.joined(separator: "/")
    }
}

/// How one address is spelled wherever a page is matched or filed (shared/address-key.cjs, MATH-54).
public enum AddressKey {
    /// Query parameters that say how someone came to a page, not which page it is.
    static func isTracking(_ name: String) -> Bool {
        name.range(of: "^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref)$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// A query without its tracking parameters, the rest as written: '' when none is left.
    static func cleanSearch(_ search: String) -> String {
        let body = search.hasPrefix("?") ? String(search.dropFirst()) : search
        let kept = body.split(separator: "&", omittingEmptySubsequences: true).filter { part in
            var name = String(part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
            name = (name.replacingOccurrences(of: "+", with: " ")).removingPercentEncoding ?? name
            return !isTracking(name)
        }
        return kept.isEmpty ? "" : "?" + kept.joined(separator: "&")
    }

    /// http or https, www. or not, a trailing slash, a #fragment, tracking parameters: one address. Another scheme loses
    /// its #fragment only; anything that is no URL is as it came.
    public static func key(_ value: String?) -> String {
        let v = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty || v == "about:blank" { return "" }
        guard let u = WebURL(v) else { return v }
        if u.scheme != "http" && u.scheme != "https" {
            let href = u.href
            return href.range(of: "#") != nil ? String(href[..<href.range(of: "#")!.lowerBound]) : href
        }
        var host = u.host.lowercased()
        if host.hasPrefix("www.") { host.removeFirst(4) }
        var path = u.pathname
        while path.hasSuffix("/") { path.removeLast() }
        return host + path + cleanSearch(u.search)
    }

    /// A local server or a sandbox preview: localhost, *.localhost, ::1, 0.0.0.0, 127.x, *.e2b.app / *.e2b.dev.
    public static func isPreviewAddress(_ value: String?) -> Bool {
        guard let u = WebURL(value ?? ""), u.scheme == "http" || u.scheme == "https" else { return false }
        var host = u.hostname.lowercased()
        if host.hasPrefix("[") { host.removeFirst() }
        if host.hasSuffix("]") { host.removeLast() }
        if host.hasSuffix(".") { host.removeLast() }
        return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "0.0.0.0"
            || host.range(of: #"^127(?:\.\d{1,3}){3}$"#, options: .regularExpression) != nil
            || host.range(of: #"(?:^|\.)e2b\.(?:app|dev)$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
}

/// What a project holds (shared/project-holds.cjs, 2026-10-11): one rule for the catalog, the all-projects cards, the
/// project's library and the notes the @ menu and search leave out.
public enum ProjectHolds {
    public struct WorkspaceHold: Sendable {
        public var id: String
        public var context: [String]
        public var removed: [String]
        public init(id: String, context: [String], removed: [String]) { self.id = id; self.context = context; self.removed = removed }
    }

    /// The notes let go of (MATH-58): trashed from a workspace and held by none any more (neither in its context nor made
    /// in it, unless that one threw it away too). Only notes. `madeIn`: note id → workspace id (nil for none).
    public static func letGo(_ workspaces: [WorkspaceHold], _ madeIn: [String: String?]) -> Set<String> {
        var trashed = Set<String>(), held = Set<String>()
        for workspace in workspaces {
            let removed = Set(workspace.removed)
            trashed.formUnion(removed)
            for id in workspace.context where !removed.contains(id) { held.insert(id) }
            for (id, at) in madeIn { if let at, at == workspace.id, !removed.contains(id) { held.insert(id) } }
        }
        return trashed.filter { madeIn.keys.contains($0) && !held.contains($0) }
    }

    /// The rule for one project → (row) -> held. Removal wins over the origin, the project's list and any context.
    public static func holder(projectId: String, library: [String], removed: [String], workspaces: [WorkspaceHold],
                              madeIn: [String: String?] = [:]) -> (LibraryRow) -> Bool {
        let removedSet = Set(removed), listed = Set(library)
        var inContext = Set<String>()
        for workspace in workspaces {
            let thrown = Set(workspace.removed)
            for id in workspace.context where !thrown.contains(id) { inContext.insert(id) }
        }
        let gone = letGo(workspaces, madeIn)
        return { row in
            !removedSet.contains(row.id) && !gone.contains(row.id)
                && (row.projectId == projectId || listed.contains(row.id) || inContext.contains(row.id))
        }
    }
}

/// Which library rows a document mentions (shared/mentions.cjs, MATH-57).
public enum Mentions {
    static let token = try! NSRegularExpression(pattern: #"@\[([^\]\n]+)\](?:\((ws|lib|zotero):([\w-]+)(?::[\w.~%/-]+)?\))?"#)

    public static func mentionedIds(_ text: String, library: [LibraryRow]) -> Set<String> {
        var ids = Set<String>(), names = Set<String>()
        guard text.contains("@[") else { return ids }
        let ns = text as NSString
        for match in token.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: match.range(at: 1))
            let kind = match.range(at: 2).location == NSNotFound ? nil : ns.substring(with: match.range(at: 2))
            if kind == "lib" { ids.insert(ns.substring(with: match.range(at: 3))) }
            else if kind == nil { names.insert(name.lowercased()) }
        }
        if !names.isEmpty { for row in library where names.contains(row.name.lowercased()) { ids.insert(row.id) } }
        return ids
    }
}

/// shared/github.cjs: GitHub's sign-in pages go to the default browser; a page sent to /login means the sign-in ended.
public enum GitHubLinks {
    static let hosts = ["github.com", "www.github.com", "gist.github.com"]
    static let signIn = [
        #"^/(login|logout|session|sessions|signup|join|password_reset)(/|$)"#,
        #"^/login/(oauth|device)(/|$)"#,
        #"^/auth(/|$)"#,
        #"^/apps/[^/]+/installations(/|$)"#,
        #"^/settings/(installations|connections/applications|apps/authorizations)(/|$)"#,
    ]
    public static let sessionCookies = ["user_session", "__Host-user_session_same_site"]

    public static func isGithubSignIn(_ value: String) -> Bool {
        guard let url = WebURL(value), url.scheme == "https" || url.scheme == "http", hosts.contains(url.hostname), url.user == nil else { return false }
        return signIn.contains { url.pathname.range(of: $0, options: .regularExpression) != nil }
    }

    /// A GitHub page (not a sign-in page) redirected to GitHub's /login: GitHub no longer takes the browser's sign-in.
    public static func endedGithubSession(from: String, to: String) -> Bool {
        guard let page = WebURL(from), let login = WebURL(to), page.scheme == "https", hosts.contains(page.hostname), !isGithubSignIn(from) else { return false }
        var path = login.pathname
        while path.hasSuffix("/") { path.removeLast() }
        return isGithubSignIn(to) && login.hostname == "github.com" && path == "/login"
    }
}

/// browser/boxes.cjs's names for a box's pictures (MATH-70), which the store's web-mark writes keep.
enum Boxes {
    static func isBox(_ mark: JSONValue?) -> Bool { mark?["box"]?.isPlainObject == true }
    static let cropPattern = #"^crops/([\w-]{1,64})\.png$"#

    static func cropId(_ crop: String?) -> String? {
        guard let crop, let range = crop.range(of: cropPattern, options: .regularExpression), range == crop.startIndex..<crop.endIndex else { return nil }
        return String(crop.dropFirst("crops/".count).dropLast(".png".count))
    }

    /// 0 for "crops/<id>.png", n for "crops/<id>-<n>.png", -1 for none of its.
    static func cropNumber(_ id: String?, _ crop: String?) -> Int {
        guard let id, let name = cropId(crop) else { return -1 }
        if name == id { return 0 }
        guard name.hasPrefix("\(id)-") else { return -1 }
        let n = String(name.dropFirst(id.count + 1))
        return n.range(of: #"^[1-9]\d{0,5}$"#, options: .regularExpression) != nil ? Int(n)! : -1
    }

    static func cropsOf(_ mark: JSONValue?) -> [String] {
        guard let mark, mark.isPlainObject else { return [] }
        var all: [String] = []
        for crop in [mark["crop"]] + (mark["asks"]?.array ?? []).map({ $0["crop"] }) {
            if let c = crop?.string, cropId(c) != nil, !all.contains(c) { all.append(c) }
        }
        return all
    }

    static func nextCropName(_ mark: JSONValue) -> String {
        let id = mark["id"]?.string ?? ""
        let n = max(0, cropsOf(mark).map { cropNumber(id, $0) }.max() ?? 0)
        return "crops/\(id)-\(n + 1).png"
    }
}

/// Test mode is for developing Engelbart, never for the app people download (developer.cjs, 2026-09-28).
public enum Developer {
    public static let buildFile = "build.json"

    /// `packaged`: running from an app bundle a person downloaded; `distDir` holds build.json { "developer": true } for a
    /// developer's package. ENGELBART_TEST_MODE=off takes test mode away from a developer's copy too.
    public static func hasTestMode(packaged: Bool, distDir: String, env: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        if env["ENGELBART_TEST_MODE"] == "off" { return false }
        if !packaged { return true }
        guard let value = JSONFiles.read(Paths.join(distDir, buildFile)) else { return false }
        return value["developer"] == .bool(true)
    }
}

/// What windows.cjs keeps of a window: where it is, and where a new one goes.
public enum WindowPlaces {
    public struct Rect: Equatable, Codable, Sendable {
        public var x: Double?, y: Double?, width: Double, height: Double
        public init(x: Double? = nil, y: Double? = nil, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
    }

    /// Where a window is: { projectId, workspaceId }, projectId nil on the projects screen.
    public static func cleanPlace(_ value: JSONValue?) -> (projectId: String?, workspaceId: String?) {
        let projectId = Ids.idOrNull(value?["projectId"])
        return (projectId, projectId == nil ? nil : Ids.idOrNull(value?["workspaceId"]))
    }

    /// `bounds` (a saved window's) when enough of it is on a screen, else that size centred (no x, y); one opened from
    /// another a step (24) down and right; else the default size. Never below the minimum.
    public static func placement(bounds: Rect? = nil, from: Rect? = nil, workAreas: [Rect] = [], min: (width: Double, height: Double) = (900, 560),
                                 size: (width: Double, height: Double) = (1440, 900)) -> Rect {
        func onScreen(_ r: Rect) -> Bool {
            workAreas.contains { area in
                let w = Swift.min(r.x! + r.width, area.x! + area.width) - Swift.max(r.x!, area.x!)
                let h = Swift.min(r.y! + r.height, area.y! + area.height) - Swift.max(r.y!, area.y!)
                return w >= 200 && h >= 120
            }
        }
        func sized(_ r: Rect) -> Rect { Rect(width: Swift.max(min.width, r.width), height: Swift.max(min.height, r.height)) }
        func at(_ r: Rect) -> Rect {
            var out = sized(r); out.x = r.x ?? 0; out.y = r.y ?? 0
            return onScreen(out) ? out : sized(r)
        }
        if let bounds { return at(bounds) }
        if let from { return at(Rect(x: (from.x ?? 0) + 24, y: (from.y ?? 0) + 24, width: from.width, height: from.height)) }
        return Rect(width: size.width, height: size.height)
    }
}

/// The id checks every store file repeats.
public enum Ids {
    public static func isUUID(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: LibraryDB.uuidPattern, options: .regularExpression) != nil
    }
    static func idOrNull(_ value: JSONValue?) -> String? { value?.string.flatMap { isUUID($0) ? $0 : nil } }
    static func idOrNull(_ value: String?) -> String? { isUUID(value) ? value : nil }

    /// "<what> id is invalid" unless a uuid.
    @discardableResult
    static func assert(_ value: String?, _ what: String) throws -> String {
        guard let value, isUUID(value) else { throw StoreError.type("\(what) id is invalid") }
        return value
    }
}
