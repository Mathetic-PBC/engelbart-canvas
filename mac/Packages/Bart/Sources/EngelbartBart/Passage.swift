import Foundation

// shared/passage-link.cjs and shared/passage-text.cjs, ported here for the citation check (Cite) and the fake agents.
// The Doc package ports the same two files for the editor and the Stage; the two must keep agreeing (what main kept is
// what the Stage lands on). They are restated here so Bart does not depend on a half-finished Doc (API.md).

// MARK: passage-link.cjs — a link's target: the address, the passage to find there (`#find=`), where its section ends
// (`&to=`), and for a citation `&cite=you|other|source`, `&counter=1`, `&note=`, `&page=` in any order around `find`.

public struct LinkTarget: Equatable, Sendable {
    public var address: String
    public var find: String
    public var to: String
    /// 'you' | 'other' | 'source' | '' (invalid); nil when the link is no citation.
    public var cite: String?
    public var counter: Bool = false
    public var note: String?
    public var page: Int?
}

public enum PassageLink {
    public static let cites: Set<String> = ["you", "other", "source"]
    static let tailRE = JSRegex("&(to|page|note|cite|counter)=([^&]*)$")
    static let headRE = JSRegex("^(to|page|note|cite|counter)=([^&]*)&")

    static func words(_ value: String?) -> String { (decodeURIComponent(value ?? "") ?? (value ?? "")).squashedSpaces }

    static func fragmentParts(_ fragment: String) -> [String: String]? {
        if !JSRegex("(?:^|&)find=").test(fragment) { return wholeParts(fragment) }
        var rest = fragment
        var keys: [String: String] = [:]
        var lead = false
        while let m = headRE.match(rest), !rest.hasPrefix("find=") {
            if keys[m[1]!] != nil { return nil }
            keys[m[1]!] = m[2] ?? ""
            rest = rest.jsSlice(m.length)
            lead = true
        }
        if !rest.hasPrefix("find=") { return nil }
        while let m = tailRE.match(rest) {
            if keys[m[1]!] != nil { break }
            keys[m[1]!] = m[2] ?? ""
            rest = rest.jsSlice(0, m.index)
        }
        let cited = keys["cite"] != nil || keys["counter"] != nil
        if !cited {
            if lead { return nil }
            if let m = JSRegex("^find=([\\s\\S]*?)&to=([^&]*)$").match(fragment) ?? JSRegex("^find=([\\s\\S]*)$").match(fragment) {
                return ["find": m[1] ?? "", "to": m[2] ?? ""]
            }
            return nil
        }
        keys["find"] = rest.jsSlice(5)
        return keys
    }

    static func wholeParts(_ fragment: String) -> [String: String]? {
        var keys: [String: String] = [:]
        for pair in fragment.components(separatedBy: "&") {
            guard let m = JSRegex("^(page|note|cite|counter)=([^&]*)$").match(pair), keys[m[1]!] == nil else { return nil }
            keys[m[1]!] = m[2] ?? ""
        }
        if keys["cite"] == nil { return nil }
        keys["find"] = ""
        return keys
    }

    /// → { address, find, to }, and `cite`/`counter` when the link is a citation. A path keeps its percent-encoding off.
    public static func splitTarget(_ href: String?) -> LinkTarget {
        let link = (href ?? "").jsTrim
        let hash = link.jsIndexOf("#")
        let fragment = hash >= 0 ? link.jsSlice(hash + 1) : ""
        guard let parts = fragmentParts(fragment) else { return LinkTarget(address: link, find: "", to: "") }
        var address = link.jsSlice(0, hash)
        if JSRegex("^(?:/|~/)").test(address) && JSRegex("%[0-9a-f]{2}", "i").test(address) { address = decodeURIComponent(address) ?? address }
        var out = LinkTarget(address: address, find: words(parts["find"]), to: words(parts["to"]))
        if parts["cite"] != nil || parts["counter"] != nil {
            let cite = words(parts["cite"]).lowercased()
            out.cite = cites.contains(cite) ? cite : ""
            out.counter = words(parts["counter"]) == "1"
            if let note = parts["note"], !note.isEmpty { out.note = words(note) }
            if let p = parts["page"], JSRegex("^[1-9]\\d{0,5}$").test(p) { out.page = Int(p) }
        }
        return out
    }

    /// Percent-encoded, parentheses too: a link's target ends at its first `)`.
    public static func encode(_ value: String) -> String {
        encodeURIComponent(value).replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")
    }

    /// A path as a citation's address spells it: each segment percent-encoded. A web address as it is, but for its spaces
    /// and parentheses.
    public static func linkAddress(_ where_: String?) -> String {
        let w = where_ ?? ""
        if w.hasPrefix("/") { return w.components(separatedBy: "/").map(encode).joined(separator: "/") }
        return JSRegex("[()\\s]", "g").replace(w) { $0.whole == "(" ? "%28" : $0.whole == ")" ? "%29" : "%20" }
    }

    /// A citation's href: `address#find=…[&to=…][&page=N][&note=…]&cite=…[&counter=1]`, or a whole source's.
    public static func citeHref(address: String, find: String, to: String = "", page: Int = 0, note: String = "", cite: String, counter: Bool = false) -> String {
        let at = page > 0 ? "page=\(page)&" : ""
        let tail = "\(at)\(note.isEmpty ? "" : "note=\(encode(note))&")cite=\(cite)\(counter ? "&counter=1" : "")"
        if find.isEmpty { return "\(linkAddress(address))#\(tail)" }
        return "\(linkAddress(address))#find=\(encode(find))\(to.isEmpty ? "" : "&to=\(encode(to))")&\(tail)"
    }
}

// MARK: passage-text.cjs — how a quoted passage is found in a text: both folded (case, whitespace runs one space, curly
// quotes and primes straight, any dash a hyphen, fi/fl ligatures spelled out, soft hyphens gone, a word broken at a
// line's end whole); `prefixes`: a workspace's line prefixes are not text; `markdown`: emphasis marks, backticks, a
// link's brackets and address, and a heading's or list item's mark are not text either. Every folded character keeps
// the offset (UTF-16) it came from.

public enum PassageText {
    static let one: [UInt16: String] = {
        var m: [UInt16: String] = [:]
        for (k, v) in [("‘", "'"), ("’", "'"), ("‚", "'"), ("‛", "'"), ("′", "'"), ("“", "\""), ("”", "\""), ("„", "\""), ("‟", "\""), ("″", "\""),
                       ("‐", "-"), ("‑", "-"), ("‒", "-"), ("–", "-"), ("—", "-"), ("―", "-"), ("−", "-")] { m[k.utf16.first!] = v }
        return m
    }()
    static let ligatures: [UInt16: String] = {
        var m: [UInt16: String] = [:]
        for (k, v) in [("ﬀ", "ff"), ("ﬁ", "fi"), ("ﬂ", "fl"), ("ﬃ", "ffi"), ("ﬄ", "ffl"), ("ﬅ", "st"), ("ﬆ", "st")] { m[k.utf16.first!] = v }
        return m
    }()
    static let softHyphen: UInt16 = 0x00AD
    public static let prefixRE = JSRegex("^(?:@(?:bart|chat|brainstorm|discover|create|build)\\b(?:\\s+--\\S+)*\\s|bart[+?~]?> ?)", "i")
    static let mdLineRE = JSRegex("^(?:#{1,6}\\s+|[-*+]\\s+(?:\\[[ xX]\\]\\s+)?|\\d+[.)]\\s+)")

    /// JS `\s` for one UTF-16 unit.
    static func isSpace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }
    static func isHyphen(_ u: UInt16) -> Bool { u == 0x2D || (0x2010...0x2015).contains(u) || u == 0x2212 }
    static func isLetter(_ u: UInt16?) -> Bool {
        guard let u, !(0xD800...0xDFFF).contains(u), let s = Unicode.Scalar(u) else { return false }
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
        default: return false
        }
    }

    public struct Folded { public var text: [UInt16]; public var map: [Int]; public var string: String { String(decoding: text, as: UTF16.self) } }

    public static func foldPassage(_ input: String?, prefixes: Bool = false, markdown: Bool = false) -> Folded {
        let src = Array((input ?? "").utf16)
        let srcString = input ?? ""
        var out: [UInt16] = []
        var map: [Int] = []
        var lineStart = true
        func push(_ chars: String, _ at: Int) { for c in chars.utf16 { out.append(c); map.append(at) } }
        func space(_ at: Int) { if let last = out.last, last != 0x20 { out.append(0x20); map.append(at) } }
        func slice(_ a: Int, _ b: Int) -> String { srcString.jsSlice(a, b) }
        var i = 0
        while i < src.count {
            defer { i += 1 }
            let c = src[i]
            if c == 0x0A { space(i); lineStart = true; continue }
            if isSpace(c) { space(i); continue }
            if lineStart {
                lineStart = false
                let rest = slice(i, i + 80)
                if prefixes, let m = prefixRE.match(rest) { i += m.length - 1; lineStart = true; continue }
                if markdown, let m = mdLineRE.match(rest) { i += m.length - 1; continue }
            }
            if c == softHyphen { continue }
            // "construc-\ntion": a hyphen at a line's end between letters joins the word.
            if isHyphen(c) && i > 0 && isLetter(src[i - 1]) {
                if let m = JSRegex("^[ \\t]*\\r?\\n\\s*").match(slice(i + 1, i + 40)) {
                    let after = i + 1 + m.length
                    if isLetter(after < src.count ? src[after] : nil) {
                        var j = after
                        if prefixes, let p = prefixRE.match(slice(j, j + 80)) { j += p.length }
                        if j < src.count, isLetter(src[j]) {
                            let ch = String(utf16CodeUnits: [src[j]], count: 1)
                            if ch == ch.lowercased() { i = j - 1; continue }
                        }
                    }
                }
            }
            if markdown {
                if c == 0x2A || c == 0x60 || c == 0x5F || c == 0x5B { continue }
                if c == 0x5D && i + 1 < src.count && src[i + 1] == 0x28 {
                    var close = -1
                    var k = i + 2
                    while k < src.count { if src[k] == 0x29 { close = k; break }; k += 1 }
                    if close > 0 && !JSRegex("\\s").test(slice(i + 2, close)) { i = close; continue }
                }
                if c == 0x5D { continue }
            }
            if let o = one[c] { push(o, i); continue }
            if let l = ligatures[c] { push(l, i); continue }
            if (0xD800...0xDFFF).contains(c) { out.append(c); map.append(i); continue }
            push(String(utf16CodeUnits: [c], count: 1).lowercased(), i)
        }
        while out.last == 0x20 { out.removeLast(); map.removeLast() }
        return Folded(text: out, map: map)
    }

    public static func normalizePassage(_ text: String?, prefixes: Bool = false, markdown: Bool = false) -> String {
        foldPassage(text, prefixes: prefixes, markdown: markdown).string
    }

    static func without(_ folded: Folded, _ drop: (UInt16) -> Bool) -> Folded {
        var text: [UInt16] = [], map: [Int] = []
        for (i, c) in folded.text.enumerated() where !drop(c) { text.append(c); map.append(folded.map[i]) }
        return Folded(text: text, map: map)
    }

    static func indexOf(_ hay: [UInt16], _ needle: [UInt16], from: Int) -> Int {
        guard !needle.isEmpty, needle.count <= hay.count else { return -1 }
        var i = max(0, from)
        while i + needle.count <= hay.count {
            if hay[i] == needle[0] {
                var k = 1
                while k < needle.count && hay[i + k] == needle[k] { k += 1 }
                if k == needle.count { return i }
            }
            i += 1
        }
        return -1
    }

    /// Every place `words` are in `text` → [(start, end)] UTF-16 offsets into `text`. Hyphens, then spaces too, are let go
    /// when the plain fold finds nothing.
    public static func matchPassage(_ text: String?, _ words: String?, prefixes: Bool = false, markdown: Bool = false) -> [(start: Int, end: Int)] {
        let hay = foldPassage(text, prefixes: prefixes, markdown: markdown)
        let want = foldPassage(words, markdown: markdown).text
        if want.isEmpty { return [] }
        let tries: [(Folded, [UInt16])] = [
            (hay, want),
            (without(hay) { $0 == 0x2D }, want.filter { $0 != 0x2D }),
            (without(hay) { $0 == 0x2D || $0 == 0x20 }, want.filter { $0 != 0x2D && $0 != 0x20 }),
        ]
        for (h, w) in tries {
            if w.isEmpty { continue }
            var out: [(Int, Int)] = []
            var at = indexOf(h.text, w, from: 0)
            while at >= 0 { out.append((h.map[at], h.map[at + w.count - 1] + 1)); at = indexOf(h.text, w, from: at + 1) }
            if !out.isEmpty { return out }
        }
        return []
    }

    /// `haystack.includes(needle)` on folded texts.
    static func contains(_ hay: [UInt16], _ needle: [UInt16]) -> Bool { needle.isEmpty || indexOf(hay, needle, from: 0) >= 0 }
}
