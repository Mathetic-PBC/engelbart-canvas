import Foundation
import EngelbartDoc

// JavaScript string and regular-expression semantics, so the ported code reads like the Electron code and behaves like
// it: lengths and offsets are UTF-16 code units (JS `.length`, `.slice`, `match.index`), and patterns are ICU regular
// expressions over UTF-16 (NSRegularExpression), which agree with JS for the patterns this package uses. Where JS's `\w`
// or `\d` is ASCII-only and ICU's is not, the ported patterns spell the ASCII class out.

public struct JSRegex: @unchecked Sendable {
    public let regex: NSRegularExpression
    public let global: Bool

    /// `flags` as JS writes them: g (global), i (case-insensitive), s (dot matches newline), m (multiline), u (ignored).
    public init(_ pattern: String, _ flags: String = "") {
        var options: NSRegularExpression.Options = []
        if flags.contains("i") { options.insert(.caseInsensitive) }
        if flags.contains("s") { options.insert(.dotMatchesLineSeparators) }
        if flags.contains("m") { options.insert(.anchorsMatchLines) }
        // A pattern that does not compile is a programming error in this package: fail loudly in tests.
        regex = try! NSRegularExpression(pattern: pattern, options: options)
        global = flags.contains("g")
    }

    /// `re.test(s)`.
    public func test(_ s: String) -> Bool {
        let ns = s as NSString
        return regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) != nil
    }

    /// `s.match(re)` without g: the groups of the first match (nil for a group that did not take part), or nil.
    public func match(_ s: String) -> JSMatch? {
        let ns = s as NSString
        guard let m = regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return JSMatch(m, ns)
    }

    /// `[...s.matchAll(re)]`.
    public func matchAll(_ s: String) -> [JSMatch] {
        let ns = s as NSString
        return regex.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { JSMatch($0, ns) }
    }

    /// `s.replace(re, fn)`: every match when global, else the first. `fn` gets the match.
    public func replace(_ s: String, _ fn: (JSMatch) -> String) -> String {
        let ns = s as NSString
        let all = regex.matches(in: s, range: NSRange(location: 0, length: ns.length))
        let matches = global ? all : Array(all.prefix(1))
        if matches.isEmpty { return s }
        var out = ""
        var at = 0
        for m in matches {
            out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
            out += fn(JSMatch(m, ns))
            at = m.range.location + m.range.length
        }
        out += ns.substring(from: at)
        return out
    }

    /// `s.replace(re, 'literal')` (no `$` patterns).
    public func replace(_ s: String, with literal: String) -> String { replace(s) { _ in literal } }

    /// `s.split(re)` (no capture groups in the patterns this package splits on).
    public func split(_ s: String) -> [String] {
        let ns = s as NSString
        var parts: [String] = []
        var at = 0
        for m in regex.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            if m.range.length == 0 && m.range.location == at && at < ns.length { continue }
            parts.append(ns.substring(with: NSRange(location: at, length: m.range.location - at)))
            at = m.range.location + m.range.length
        }
        parts.append(ns.substring(from: at))
        return parts
    }
}

public struct JSMatch {
    /// groups[0] is the whole match.
    public let groups: [String?]
    /// UTF-16 offset of the match (`match.index`).
    public let index: Int
    public let length: Int
    public let ranges: [NSRange]

    init(_ m: NSTextCheckingResult, _ ns: NSString) {
        var g: [String?] = []
        var r: [NSRange] = []
        for i in 0..<m.numberOfRanges {
            let range = m.range(at: i)
            r.append(range)
            g.append(range.location == NSNotFound ? nil : ns.substring(with: range))
        }
        groups = g
        ranges = r
        index = m.range.location
        length = m.range.length
    }

    public subscript(_ i: Int) -> String? { i < groups.count ? groups[i] : nil }
    public var whole: String { groups[0] ?? "" }
}

extension String {
    /// JS `.length` (UTF-16 code units).
    public var jsLength: Int { utf16.count }

    /// JS `.slice(start, end)` on UTF-16 offsets, negative offsets counted from the end.
    public func jsSlice(_ start: Int, _ end: Int? = nil) -> String {
        let ns = self as NSString
        let n = ns.length
        func clamp(_ v: Int) -> Int { v < 0 ? max(0, n + v) : min(v, n) }
        let s = clamp(start)
        let e = end.map(clamp) ?? n
        guard e > s else { return "" }
        return ns.substring(with: NSRange(location: s, length: e - s))
    }

    /// JS `.charAt(i)`.
    public func jsCharAt(_ i: Int) -> String {
        let ns = self as NSString
        guard i >= 0, i < ns.length else { return "" }
        return ns.substring(with: NSRange(location: i, length: 1))
    }

    /// JS `.charCodeAt(i)`.
    public func jsCharCode(_ i: Int) -> UInt16? {
        let ns = self as NSString
        guard i >= 0, i < ns.length else { return nil }
        return ns.character(at: i)
    }

    /// JS `.trim()`: JS whitespace (which includes U+FEFF and the line separators).
    public var jsTrim: String { trimmingCharacters(in: jsWhitespace) }
    public var jsTrimStart: String {
        guard let i = firstIndex(where: { !$0.unicodeScalars.allSatisfy { jsWhitespace.contains($0) } }) else { return "" }
        return String(self[i...])
    }
    public var jsTrimEnd: String {
        guard let i = lastIndex(where: { !$0.unicodeScalars.allSatisfy { jsWhitespace.contains($0) } }) else { return "" }
        return String(self[...i])
    }

    /// JS `.indexOf(s)` in UTF-16 units, -1 when absent.
    public func jsIndexOf(_ s: String, from: Int = 0) -> Int {
        let ns = self as NSString
        guard from <= ns.length else { return -1 }
        let r = ns.range(of: s, options: [.literal], range: NSRange(location: max(0, from), length: ns.length - max(0, from)))
        return r.location == NSNotFound ? -1 : r.location
    }

    /// JS `.split(sep)` on a literal separator.
    public func jsSplit(_ sep: String) -> [String] { components(separatedBy: sep) }

    /// `/\s+/g` collapsed to one space and trimmed: `String(x).replace(/\s+/g, ' ').trim()`.
    public var squashedSpaces: String { JSRegex("\\s+", "g").replace(self, with: " ").jsTrim }

    /// Lowercased the way JS `toLowerCase` does for the ASCII-heavy text here.
    public var jsLower: String { lowercased() }
}

let jsWhitespace: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}\u{2028}\u{2029}\u{00A0}")
    return set
}()

/// `n.toLocaleString('en-US')` for integers: thousands separated by commas.
func localeNumber(_ n: Int) -> String {
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US")
    f.numberStyle = .decimal
    return f.string(from: NSNumber(value: n)) ?? String(n)
}

/// `encodeURIComponent`.
public func encodeURIComponent(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(127)))
    allowed.insert(charactersIn: "-_.!~*'()")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

/// `decodeURIComponent`, nil where JS would throw.
public func decodeURIComponent(_ s: String) -> String? { s.removingPercentEncoding }

/// `Math.round` (halves round up, toward +∞).
func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }
