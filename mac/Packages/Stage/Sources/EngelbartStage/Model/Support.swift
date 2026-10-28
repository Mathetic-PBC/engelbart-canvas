import Foundation

// Small helpers so the ports read like the JavaScript they come from: a regex over UTF-16 offsets (as JS strings are
// indexed), and a URL parsed the way `new URL()` parses the addresses the Stage deals in. Internal to the Stage: other
// packages have their own (Doc's Rx), and these never leak through the public surface.

/// A JavaScript-flavoured regular expression ("i", "m", "s" flags). Offsets are UTF-16, as in JS.
final class SRx: @unchecked Sendable {
    let re: NSRegularExpression

    init(_ pattern: String, _ flags: String = "") {
        var options: NSRegularExpression.Options = []
        if flags.contains("i") { options.insert(.caseInsensitive) }
        if flags.contains("m") { options.insert(.anchorsMatchLines) }
        if flags.contains("s") { options.insert(.dotMatchesLineSeparators) }
        // A pattern here is a literal of ours: a bad one is a programming error.
        re = try! NSRegularExpression(pattern: pattern, options: options) // swiftlint:disable:this force_try
    }

    struct Match {
        let range: NSRange
        let groups: [String?]
        let groupRanges: [NSRange]
        subscript(_ i: Int) -> String? { i < groups.count ? groups[i] : nil }
        var index: Int { range.location }
        var end: Int { range.location + range.length }
        var str: String { groups.first.flatMap { $0 } ?? "" }
    }

    private func wrap(_ m: NSTextCheckingResult, _ ns: NSString) -> Match {
        var groups: [String?] = []
        var ranges: [NSRange] = []
        for i in 0..<m.numberOfRanges {
            let r = m.range(at: i)
            ranges.append(r)
            groups.append(r.location == NSNotFound ? nil : ns.substring(with: r))
        }
        return Match(range: m.range, groups: groups, groupRanges: ranges)
    }

    func test(_ s: String) -> Bool {
        let ns = s as NSString
        return re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) != nil
    }

    func match(_ s: String, from: Int = 0) -> Match? {
        let ns = s as NSString
        guard from <= ns.length, let m = re.firstMatch(in: s, range: NSRange(location: from, length: ns.length - from)) else { return nil }
        return wrap(m, ns)
    }

    func matchAll(_ s: String) -> [Match] {
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { wrap($0, ns) }
    }

    /// `s.replace(re, fn)` with a global regex.
    func replace(_ s: String, global: Bool = true, _ fn: (Match) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var at = 0
        let all = global ? matchAll(s) : (match(s).map { [$0] } ?? [])
        for m in all {
            out += ns.substring(with: NSRange(location: at, length: m.index - at))
            out += fn(m)
            at = m.end
        }
        out += ns.substring(from: at)
        return out
    }

    func replace(_ s: String, with template: String, global: Bool = true) -> String {
        let ns = s as NSString
        let range = NSRange(location: 0, length: ns.length)
        if global { return re.stringByReplacingMatches(in: s, range: range, withTemplate: template) }
        guard let m = re.firstMatch(in: s, range: range) else { return s }
        return ns.replacingCharacters(in: m.range, with: re.replacementString(for: m, in: s, offset: 0, template: template))
    }
}

/// JavaScript string operations by UTF-16 offset.
enum JSStr {
    static func len(_ s: String) -> Int { (s as NSString).length }
    static func slice(_ s: String, _ from: Int, _ to: Int? = nil) -> String {
        let ns = s as NSString
        let n = ns.length
        var a = from < 0 ? max(0, n + from) : min(from, n)
        var b = to.map { $0 < 0 ? max(0, n + $0) : min($0, n) } ?? n
        if b < a { b = a }
        a = max(0, a)
        return ns.substring(with: NSRange(location: a, length: b - a))
    }
    static func indexOf(_ s: String, _ needle: String, from: Int = 0) -> Int {
        let ns = s as NSString
        guard !needle.isEmpty else { return min(max(0, from), ns.length) }
        guard from <= ns.length else { return -1 }
        let r = ns.range(of: needle, options: .literal, range: NSRange(location: max(0, from), length: ns.length - max(0, from)))
        return r.location == NSNotFound ? -1 : r.location
    }
    static func lastIndexOf(_ s: String, _ needle: String, before: Int) -> Int {
        let ns = s as NSString
        let end = min(ns.length, before + (needle as NSString).length)
        guard end > 0 else { return -1 }
        let r = ns.range(of: needle, options: [.literal, .backwards], range: NSRange(location: 0, length: end))
        return r.location == NSNotFound ? -1 : r.location
    }
    static func char(_ s: String, _ i: Int) -> String {
        let ns = s as NSString
        guard i >= 0, i < ns.length else { return "" }
        return ns.substring(with: NSRange(location: i, length: 1))
    }
    static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// encodeURIComponent
    static func encodeURIComponent(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
    /// decodeURIComponent; nil where JS would throw.
    static func decodeURIComponent(_ s: String) -> String? { s.removingPercentEncoding ?? (s.contains("%") ? nil : s) }
}

/// An address parsed as `new URL(value)` parses one: nil where it would throw (no scheme). Only what the Stage reads.
struct JSURL: Equatable {
    var `protocol`: String          // "https:"
    var username: String = ""
    var password: String = ""
    var hostname: String = ""       // lowercased; IPv6 in brackets
    var port: String = ""           // '' when default
    var pathname: String = ""
    var search: String = ""         // "" or "?…"
    var hash: String = ""           // "" or "#…"

    static let special: Set<String> = ["http:", "https:", "ftp:", "ws:", "wss:", "file:"]
    private static let schemeRx = SRx(#"^([a-zA-Z][a-zA-Z0-9+.\-]*):"#)
    private static let defaults = ["http:": "80", "https:": "443", "ws:": "80", "wss:": "443", "ftp:": "21"]

    var host: String { port.isEmpty ? hostname : "\(hostname):\(port)" }
    var origin: String { (self.protocol == "http:" || self.protocol == "https:") ? "\(self.protocol)//\(host)" : "null" }
    var isSpecial: Bool { JSURL.special.contains(self.protocol) }
    var href: String {
        if self.protocol == "file:" { return "file://\(hostname)\(pathname)\(search)\(hash)" }
        if !isSpecial && hostname.isEmpty && !pathname.hasPrefix("/") { return "\(self.protocol)\(pathname)\(search)\(hash)" }
        let user = username.isEmpty ? "" : (password.isEmpty ? "\(username)@" : "\(username):\(password)@")
        return "\(self.protocol)//\(user)\(host)\(pathname)\(search)\(hash)"
    }

    init?(_ value: String) {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = JSURL.schemeRx.match(raw), let scheme = m[1] else { return nil }
        let proto = scheme.lowercased() + ":"
        self.protocol = proto
        var rest = JSStr.slice(raw, m.end)
        // fragment and query first, as the parser does
        if let h = rest.firstIndex(of: "#") { hash = String(rest[h...]); rest = String(rest[..<h]); if hash == "#" { hash = "" } }
        if let q = rest.firstIndex(of: "?") { search = String(rest[q...]); rest = String(rest[..<q]); if search == "?" { search = "" } }
        hash = JSURL.encode(hash, keep: "#")
        search = JSURL.encode(search, keep: "?&=")
        let isSpecial = JSURL.special.contains(proto)
        if isSpecial {
            // "http:example.com" and "http:/example.com" read as "http://example.com"
            while rest.hasPrefix("/") || rest.hasPrefix("\\") { rest.removeFirst() }
            if proto == "file:" {
                // file: has an optional host and a path
                let slash = rest.firstIndex(of: "/")
                let authority = slash.map { String(rest[..<$0]) } ?? rest
                let path = slash.map { String(rest[$0...]) } ?? "/"
                if raw.lowercased().hasPrefix("file:///") { hostname = ""; pathname = JSURL.encode("/" + rest, keep: "/") } else {
                    hostname = authority.lowercased(); pathname = JSURL.encode(path, keep: "/")
                    if hostname == "localhost" { hostname = "" }
                }
                if pathname.isEmpty { pathname = "/" }
                return
            }
            let slash = rest.firstIndex(where: { $0 == "/" || $0 == "\\" })
            var authority = slash.map { String(rest[..<$0]) } ?? rest
            let path = slash.map { String(rest[$0...]).replacingOccurrences(of: "\\", with: "/") } ?? ""
            if let at = authority.lastIndex(of: "@") {
                let info = String(authority[..<at])
                authority = String(authority[authority.index(after: at)...])
                if let colon = info.firstIndex(of: ":") { username = String(info[..<colon]); password = String(info[info.index(after: colon)...]) } else { username = info }
            }
            var hostPart = authority
            if authority.hasPrefix("[") {
                guard let close = authority.firstIndex(of: "]") else { return nil }
                hostPart = String(authority[...close])
                let after = String(authority[authority.index(after: close)...])
                if after.hasPrefix(":") { port = String(after.dropFirst()) } else if !after.isEmpty { return nil }
            } else if let colon = authority.lastIndex(of: ":") {
                hostPart = String(authority[..<colon]); port = String(authority[authority.index(after: colon)...])
            }
            if !port.isEmpty {
                guard port.allSatisfy(\.isNumber), let n = Int(port), n <= 65535 else { return nil }
                port = String(n)
                if JSURL.defaults[proto] == port { port = "" }
            }
            guard !hostPart.isEmpty else { return nil }
            if hostPart.contains(where: { " <>^|%".contains($0) }) && !hostPart.hasPrefix("[") { return nil }
            hostname = hostPart.lowercased()
            pathname = JSURL.encode(path.isEmpty ? "/" : JSURL.dotSegments(path), keep: "/")
        } else {
            // a non-special scheme (mailto:, slack://…): kept opaque
            if rest.hasPrefix("//") {
                let body = String(rest.dropFirst(2))
                let slash = body.firstIndex(of: "/")
                hostname = (slash.map { String(body[..<$0]) } ?? body)
                pathname = slash.map { String(body[$0...]) } ?? ""
            } else { pathname = rest }
        }
    }

    private static func dotSegments(_ path: String) -> String {
        guard path.contains("/.") else { return path }
        var out: [String] = []
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for (i, p) in parts.enumerated() {
            if p == "." { if i == parts.count - 1 { out.append("") }; continue }
            if p == ".." { if out.count > 1 { out.removeLast() }; if i == parts.count - 1 { out.append("") }; continue }
            out.append(p)
        }
        return out.joined(separator: "/")
    }

    /// Percent-encodes what the URL parser would (spaces, quotes, angle brackets, non-ASCII), keeping existing escapes.
    private static func encode(_ s: String, keep: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.formUnion(CharacterSet(charactersIn: keep + "%:@!$&'()*+,;=~-._[]|"))
        allowed.remove(charactersIn: " \"<>`{}")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

extension BinaryFloatingPoint {
    /// JavaScript's Math.round: halves go up (toward +∞), so -2.5 is -2.
    var jsRounded: Self { (self + 0.5).rounded(.down) }
}
