import Foundation

// The JavaScript string and regex semantics the Electron model is written in, so the port can read like the source.
// Offsets are UTF-16 code units everywhere, as JavaScript's are and as NSTextView's NSRange is: an offset the Doc model
// computes is one the editor can hand straight to its text view.

public extension String {
    /// `s.length`: UTF-16 code units.
    var len: Int { utf16.count }

    /// `s.slice(from, to)`: negative counts from the end, out of range is clamped.
    func slice(_ from: Int, _ to: Int? = nil) -> String {
        let n = len
        var a = from < 0 ? max(0, n + from) : min(from, n)
        var b = to.map { $0 < 0 ? max(0, n + $0) : min($0, n) } ?? n
        if b < a { b = a }
        if a == 0 && b == n { return self }
        a = max(0, a)
        return (self as NSString).substring(with: NSRange(location: a, length: b - a))
    }

    /// `s[i]` as a one-unit string, '' outside the string.
    func charAt(_ i: Int) -> String { i < 0 || i >= len ? "" : slice(i, i + 1) }

    /// `s.indexOf(needle, from)`, -1 when absent.
    func indexOf(_ needle: String, _ from: Int = 0) -> Int {
        let ns = self as NSString
        let start = max(0, min(from, ns.length))
        if needle.isEmpty { return start }
        let r = ns.range(of: needle, options: .literal, range: NSRange(location: start, length: ns.length - start))
        return r.location == NSNotFound ? -1 : r.location
    }

    /// `s.lastIndexOf(needle)`.
    func lastIndexOf(_ needle: String) -> Int {
        let r = (self as NSString).range(of: needle, options: [.literal, .backwards])
        return r.location == NSNotFound ? -1 : r.location
    }

    /// `s.split('\n')` and the like: a literal separator, every piece kept (empty ones too).
    func jsSplit(_ sep: String) -> [String] { components(separatedBy: sep) }

    /// `s.trim()`: JavaScript's whitespace (\s), both ends.
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimStart: String { String(drop(while: { $0.isWhitespace })) }
    var trimEnd: String {
        var s = Substring(self)
        while let last = s.last, last.isWhitespace { s.removeLast() }
        return String(s)
    }

    /// `encodeURIComponent`.
    var encodeURIComponent: String {
        var allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        allowed.remove(charactersIn: "")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? self
    }

    /// `decodeURIComponent`, nil where JavaScript would throw (a malformed escape).
    var decodeURIComponent: String? {
        if !contains("%") { return self }
        return removingPercentEncoding
    }

    /// `decodeURI`: like decodeURIComponent but escapes of reserved characters stay escaped.
    var decodeURI: String? {
        guard contains("%") else { return self }
        let reserved = Set(";/?:@&=+$,#".unicodeScalars)
        var out = ""
        var bytes: [UInt8] = []
        var pending = ""
        let scalars = Array(unicodeScalars)
        var i = 0
        func flush() -> Bool {
            if bytes.isEmpty { return true }
            guard let s = String(bytes: bytes, encoding: .utf8) else { return false }
            if s.unicodeScalars.count == 1, let u = s.unicodeScalars.first, reserved.contains(u) { out += pending } else { out += s }
            bytes = []; pending = ""
            return true
        }
        while i < scalars.count {
            let c = scalars[i]
            if c == "%" {
                guard i + 2 < scalars.count, let v = UInt8(String(scalars[i + 1]) + String(scalars[i + 2]), radix: 16) else { return nil }
                if v < 0x80 { guard flush() else { return nil } }
                bytes.append(v); pending += "%" + String(scalars[i + 1]) + String(scalars[i + 2])
                if v < 0x80 { guard flush() else { return nil } }
                i += 3
                continue
            }
            guard flush() else { return nil }
            out.unicodeScalars.append(c)
            i += 1
        }
        return flush() ? out : nil
    }

    /// `[...s]`: the string's code points as strings.
    var codePoints: [String] { unicodeScalars.map { String($0) } }

    func repeated(_ n: Int) -> String { n <= 0 ? "" : String(repeating: self, count: n) }
}

/// One match of an `Rx`: `m[0]` the whole, `m[k]` a group (nil when it took no part), `index` where it starts.
public struct RxMatch {
    public let index: Int
    public let length: Int
    public let groups: [String?]
    public subscript(_ i: Int) -> String? { i < groups.count ? groups[i] : nil }
    public var str: String { groups[0] ?? "" }
    public var end: Int { index + length }
    /// The offset group `i` starts at (-1 when it took no part).
    public let groupStarts: [Int]
}

/// A JavaScript regular expression on NSRegularExpression. The pattern is written as in the JS source; `\w` and `\d` are
/// rewritten to their ASCII classes (ICU's are Unicode-wide), `$` outside a class to JavaScript's end of input (ICU's also
/// matches before a final line break), and a `[` inside a class is escaped (ICU nests sets there; JavaScript reads it as
/// a bracket). Flags: `i` case-insensitive, `m` multiline, `u` (no-op; `\p{…}` works either way), `g`/`s` ignored/dotall.
public final class Rx: @unchecked Sendable {
    public let source: String
    public let re: NSRegularExpression

    public init(_ pattern: String, _ flags: String = "") {
        source = pattern
        var options: NSRegularExpression.Options = []
        if flags.contains("i") { options.insert(.caseInsensitive) }
        let multiline = flags.contains("m")
        if multiline { options.insert(.anchorsMatchLines) }
        if flags.contains("s") { options.insert(.dotMatchesLineSeparators) }
        do { re = try NSRegularExpression(pattern: Rx.translate(pattern, multiline: multiline), options: options) }
        catch { fatalError("Rx: bad pattern \(pattern): \(error)") }
    }

    static func translate(_ p: String, multiline: Bool) -> String {
        let cs = Array(p.unicodeScalars)
        var out = ""
        var inClass = false
        var classStart = false
        var i = 0
        while i < cs.count {
            let c = cs[i]
            if c == "\\" && i + 1 < cs.count {
                let n = cs[i + 1]
                switch n {
                case "w": out += inClass ? "A-Za-z0-9_" : "[A-Za-z0-9_]"
                case "d": out += inClass ? "0-9" : "[0-9]"
                case "W": out += inClass ? "\\W" : "[^A-Za-z0-9_]"
                case "D": out += inClass ? "\\D" : "[^0-9]"
                default: out.unicodeScalars.append(c); out.unicodeScalars.append(n)
                }
                i += 2; classStart = false
                continue
            }
            if inClass {
                if c == "]" && !classStart { inClass = false; out += "]" }
                else if c == "[" { out += "\\[" }
                else if c == "&" && i + 1 < cs.count && cs[i + 1] == "&" { out += "\\&" }
                else if c == "-" && i + 1 < cs.count && cs[i + 1] == "-" { out += "\\-" }
                else { out.unicodeScalars.append(c) }
                classStart = classStart && c == "^"
                i += 1
                continue
            }
            if c == "[" { inClass = true; classStart = true; out += "["; i += 1; if i < cs.count && cs[i] == "^" { out += "^"; i += 1 }; continue }
            if c == "$" && !multiline { out += "(?![\\s\\S])"; i += 1; continue }
            out.unicodeScalars.append(c)
            i += 1
        }
        return out
    }

    private func make(_ r: NSTextCheckingResult, _ ns: NSString) -> RxMatch {
        var groups: [String?] = []
        var starts: [Int] = []
        for k in 0..<r.numberOfRanges {
            let g = r.range(at: k)
            if g.location == NSNotFound { groups.append(nil); starts.append(-1) }
            else { groups.append(ns.substring(with: g)); starts.append(g.location) }
        }
        return RxMatch(index: r.range.location, length: r.range.length, groups: groups, groupStarts: starts)
    }

    public func test(_ s: String) -> Bool {
        let ns = s as NSString
        return re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) != nil
    }

    /// `s.match(re)` without `g`: the first match, or nil.
    public func match(_ s: String, from: Int = 0) -> RxMatch? {
        let ns = s as NSString
        let start = max(0, min(from, ns.length))
        guard let r = re.firstMatch(in: s, options: [], range: NSRange(location: start, length: ns.length - start)) else { return nil }
        return make(r, ns)
    }

    /// `s.matchAll(re)`.
    public func matchAll(_ s: String) -> [RxMatch] {
        let ns = s as NSString
        return re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)).map { make($0, ns) }
    }

    /// `s.split(re)`: the pieces between matches with each match's groups spliced in (a group that took no part as '').
    public func split(_ s: String) -> [String] {
        let ns = s as NSString
        if ns.length == 0 { return re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: 0)) != nil ? [] : [""] }
        var out: [String] = []
        var last = 0
        for r in re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)) {
            if r.range.length == 0 && (r.range.location == 0 || r.range.location >= ns.length) { continue }
            out.append(ns.substring(with: NSRange(location: last, length: r.range.location - last)))
            for k in 1..<max(1, r.numberOfRanges) {
                let g = r.range(at: k)
                out.append(g.location == NSNotFound ? "" : ns.substring(with: g))
            }
            last = r.range.location + r.range.length
        }
        out.append(ns.substring(from: last))
        return out
    }

    /// `s.split(re).filter(Boolean)`.
    public func tokens(_ s: String) -> [String] { split(s).filter { !$0.isEmpty } }

    /// `s.replace(re /g, fn)`.
    public func replace(_ s: String, global: Bool = true, _ fn: (RxMatch) -> String) -> String {
        let ns = s as NSString
        let all = re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length))
        let ms = global ? all : Array(all.prefix(1))
        if ms.isEmpty { return s }
        var out = ""
        var last = 0
        for r in ms {
            out += ns.substring(with: NSRange(location: last, length: r.range.location - last))
            out += fn(make(r, ns))
            last = r.range.location + r.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    /// `s.replace(re /g, literal)`, with `$1`-style group references as JavaScript reads them.
    public func replace(_ s: String, with template: String, global: Bool = true) -> String {
        replace(s, global: global) { m in Rx.expand(template, m) }
    }

    static func expand(_ template: String, _ m: RxMatch) -> String {
        guard template.contains("$") else { return template }
        var out = ""
        let cs = Array(template)
        var i = 0
        while i < cs.count {
            if cs[i] == "$", i + 1 < cs.count {
                if cs[i + 1] == "$" { out += "$"; i += 2; continue }
                if cs[i + 1] == "&" { out += m.str; i += 2; continue }
                if let d = cs[i + 1].wholeNumberValue {
                    out += m[d] ?? ""; i += 2; continue
                }
            }
            out.append(cs[i]); i += 1
        }
        return out
    }
}

/// Number(...) of a decimal string, as an Int when it is one.
func jsInt(_ s: String?) -> Int? { s.flatMap { Int($0) } }
