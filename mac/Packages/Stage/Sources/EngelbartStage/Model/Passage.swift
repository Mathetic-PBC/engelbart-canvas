import Foundation

/// A link's target (src/shared/passage-link.cjs splitTarget): the address, the passage to find there (`#find=`), where
/// its section ends (`&to=`), and for a citation whose words they are (`&cite=`, `&counter=1`, `&note=`, `&page=`).
public struct LinkTarget: Equatable, Sendable {
    public var address: String
    public var find: String = ""
    public var to: String = ""
    public var cite: String?
    public var counter: Bool?
    public var note: String?
    public var page: Int?
}

// The Doc package ports passage-link and passage-text too; the Stage keeps its own so the two are never built in lock
// step. Both follow the Electron source line for line.
public enum PassageLink {
    static let cites: Set<String> = ["you", "other", "source"]
    private static let tailRx = SRx(#"&(to|page|note|cite|counter)=([^&]*)$"#)
    private static let headRx = SRx(#"^(to|page|note|cite|counter)=([^&]*)&"#)

    static func words(_ value: String?) -> String {
        let v = value ?? ""
        let out = JSStr.decodeURIComponent(v) ?? v
        return JSStr.trim(SRx(#"\s+"#).replace(out, with: " "))
    }

    /// The fragment's keys around `find=`, each once, or nil.
    static func fragmentParts(_ fragment: String) -> [String: String]? {
        if !SRx(#"(?:^|&)find="#).test(fragment) { return wholeParts(fragment) }
        var rest = fragment
        var keys: [String: String] = [:]
        var lead = false
        while !rest.hasPrefix("find="), let m = headRx.match(rest) {
            let k = m[1] ?? ""
            if keys[k] != nil { return nil }
            keys[k] = m[2] ?? ""
            rest = JSStr.slice(rest, m.end)
            lead = true
        }
        if !rest.hasPrefix("find=") { return nil }
        while let m = tailRx.match(rest) {
            let k = m[1] ?? ""
            if keys[k] != nil { break }
            keys[k] = m[2] ?? ""
            rest = JSStr.slice(rest, 0, m.index)
        }
        let cited = keys["cite"] != nil || keys["counter"] != nil
        if !cited {
            if lead { return nil }
            if let m = SRx(#"^find=([\s\S]*?)&to=([^&]*)$"#).match(fragment) { return ["find": m[1] ?? "", "to": m[2] ?? ""] }
            if let m = SRx(#"^find=([\s\S]*)$"#).match(fragment) { return ["find": m[1] ?? "", "to": ""] }
            return nil
        }
        keys["find"] = JSStr.slice(rest, 5)
        return keys
    }

    static func wholeParts(_ fragment: String) -> [String: String]? {
        var keys: [String: String] = [:]
        for pair in fragment.components(separatedBy: "&") {
            guard let m = SRx(#"^(page|note|cite|counter)=([^&]*)$"#).match(pair), let k = m[1], keys[k] == nil else { return nil }
            keys[k] = m[2] ?? ""
        }
        guard keys["cite"] != nil else { return nil }
        keys["find"] = ""
        return keys
    }

    public static func splitTarget(_ href: String?) -> LinkTarget {
        let link = JSStr.trim(href ?? "")
        let hash = JSStr.indexOf(link, "#")
        let fragment = hash >= 0 ? JSStr.slice(link, hash + 1) : ""
        guard let parts = fragmentParts(fragment) else { return LinkTarget(address: link) }
        var address = JSStr.slice(link, 0, hash)
        if SRx(#"^(?:\/|~\/)"#).test(address) && SRx("%[0-9a-f]{2}", "i").test(address) { address = JSStr.decodeURIComponent(address) ?? address }
        var out = LinkTarget(address: address, find: words(parts["find"]), to: words(parts["to"]))
        if parts["cite"] != nil || parts["counter"] != nil {
            let cite = words(parts["cite"]).lowercased()
            out.cite = cites.contains(cite) ? cite : ""
            out.counter = words(parts["counter"]) == "1"
            if let note = parts["note"], !note.isEmpty { out.note = words(note) }
            if let page = parts["page"], SRx(#"^[1-9]\d{0,5}$"#).test(page) { out.page = Int(page) }
        }
        return out
    }
}

/// How a quoted passage is found in a text (src/shared/passage-text.cjs): both folded the same way, each folded
/// character keeping the UTF-16 offset it came from.
public enum PassageText {
    static let one: [Character: String] = [
        "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "“": "\"", "”": "\"", "„": "\"", "‟": "\"", "″": "\"",
        "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
    ]
    static let ligatures: [Character: String] = ["ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"]
    static let prefixRx = SRx(#"^(?:@(?:bart|chat|brainstorm|discover|create|build)\b(?:\s+--\S+)*\s|bart[+?~]?> ?)"#, "i")
    static let mdLineRx = SRx(#"^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)"#)

    public struct Folded { public var text: [Character]; public var map: [Int] }

    private static func isSpace(_ c: Character) -> Bool { c.isWhitespace }
    private static func isLetter(_ c: Character?) -> Bool { c?.isLetter ?? false }
    private static func isHyphen(_ c: Character) -> Bool { c == "-" || ("\u{2010}"..."\u{2015}").contains(c) || c == "\u{2212}" }

    /// `text` folded; offsets are into `text`'s characters (Swift Characters; callers map back as they need).
    public static func fold(_ input: String, prefixes: Bool = false, markdown: Bool = false) -> Folded {
        let src = Array(input)
        var out: [Character] = []
        var map: [Int] = []
        var lineStart = true
        func push(_ s: String, _ at: Int) { for c in s { out.append(c); map.append(at) } }
        func space(_ at: Int) { if let last = out.last, last != " " { push(" ", at) } }
        func rest(_ i: Int, _ n: Int) -> String { String(src[i..<min(src.count, i + n)]) }
        var i = 0
        while i < src.count {
            let c = src[i]
            if c == "\n" { space(i); lineStart = true; i += 1; continue }
            if isSpace(c) { space(i); i += 1; continue }
            if lineStart {
                lineStart = false
                let r = rest(i, 80)
                if prefixes, let m = prefixRx.match(r) { i += Array((r as NSString).substring(to: m.end)).count; lineStart = true; continue }
                if markdown, let m = mdLineRx.match(r) { i += Array((r as NSString).substring(to: m.end)).count; continue }
            }
            if c == "\u{00AD}" { i += 1; continue }
            if isHyphen(c), i > 0, isLetter(src[i - 1]) {
                let after = rest(i + 1, 40)
                if let m = SRx(#"^[ \t]*\r?\n\s*"#).match(after) {
                    var j = i + 1 + Array((after as NSString).substring(to: m.end)).count
                    if isLetter(j < src.count ? src[j] : nil) {
                        if prefixes, let p = prefixRx.match(rest(j, 80)) { j += Array((rest(j, 80) as NSString).substring(to: p.end)).count }
                        if j < src.count, isLetter(src[j]), String(src[j]) == String(src[j]).lowercased() { i = j; continue }
                    }
                }
            }
            if markdown {
                if c == "*" || c == "`" || c == "_" || c == "[" { i += 1; continue }
                if c == "]", i + 1 < src.count, src[i + 1] == "(" {
                    if let close = src[(i + 2)...].firstIndex(of: ")"), !src[(i + 2)..<close].contains(where: { $0.isWhitespace }) { i = close + 1; continue }
                }
                if c == "]" { i += 1; continue }
            }
            if let o = one[c] { push(o, i); i += 1; continue }
            if let l = ligatures[c] { push(l, i); i += 1; continue }
            push(String(c).lowercased(), i)
            i += 1
        }
        while out.last == " " { out.removeLast(); map.removeLast() }
        return Folded(text: out, map: map)
    }

    public static func normalize(_ text: String, prefixes: Bool = false, markdown: Bool = false) -> String {
        String(fold(text, prefixes: prefixes, markdown: markdown).text)
    }

    private static func without(_ f: Folded, _ drop: (Character) -> Bool) -> Folded {
        var t: [Character] = []; var m: [Int] = []
        for (i, c) in f.text.enumerated() where !drop(c) { t.append(c); m.append(f.map[i]) }
        return Folded(text: t, map: m)
    }

    /// Every place `words` are in `text` → [(start, end)] in `text`'s Character offsets.
    public static func match(_ text: String, _ words: String, prefixes: Bool = false, markdown: Bool = false) -> [(start: Int, end: Int)] {
        let hay = fold(text, prefixes: prefixes, markdown: markdown)
        let want = fold(words, markdown: markdown).text
        guard !want.isEmpty else { return [] }
        let tries: [(Folded, [Character])] = [
            (hay, want),
            (without(hay) { $0 == "-" }, want.filter { $0 != "-" }),
            (without(hay) { $0 == "-" || $0 == " " }, want.filter { $0 != "-" && $0 != " " }),
        ]
        for (h, w) in tries where !w.isEmpty {
            var out: [(Int, Int)] = []
            if w.count <= h.text.count {
                var at = 0
                while at + w.count <= h.text.count {
                    if h.text[at] == w[0] && Array(h.text[at..<(at + w.count)]) == w { out.append((h.map[at], h.map[at + w.count - 1] + 1)) }
                    at += 1
                }
            }
            if !out.isEmpty { return out.map { (start: $0.0, end: $0.1) } }
        }
        return []
    }
}

/// A markdown file read on the Stage (src/renderer/model/markdown.js): blocks and inline runs as data, so nothing in the
/// file is ever read as html.
public enum StageMarkdown {
    public enum Block: Equatable, Sendable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case item(ordered: Bool, marker: String, depth: Int, checked: Bool?, text: String)
        case quote(String)
        case code(lang: String, text: String)
        case rule
    }
    public struct Run: Equatable, Sendable {
        public var text: String
        public var bold = false, italic = false, code = false
        public var href: String?
    }

    static let fence = SRx(#"^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)"#)
    static let heading = SRx(#"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$"#)
    static let item = SRx(#"^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$"#)
    static let quoteRx = SRx(#"^\s{0,3}>\s?(.*)$"#)
    static let ruleRx = SRx(#"^\s{0,3}([-*_])(\s*\1){2,}\s*$"#)

    public static func blocks(_ source: String) -> [Block] {
        let lines = SRx(#"\r\n?"#).replace(source, with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var para: [String]?
        func endPara() { if let p = para { blocks.append(.paragraph(p.joined(separator: " "))); para = nil } }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if let f = fence.match(line) {
                endPara()
                var body: [String] = []
                var j = i + 1
                while j < lines.count && !JSStr.trim(lines[j]).hasPrefix(f[1] ?? "```") { body.append(lines[j]); j += 1 }
                blocks.append(.code(lang: f[2] ?? "", text: body.joined(separator: "\n")))
                i = j + 1
                continue
            }
            if JSStr.trim(line).isEmpty { endPara(); i += 1; continue }
            if let m = heading.match(line) { endPara(); blocks.append(.heading(level: JSStr.len(m[1] ?? ""), text: m[2] ?? "")); i += 1; continue }
            if ruleRx.test(line) { endPara(); blocks.append(.rule); i += 1; continue }
            if let m = item.match(line) {
                endPara()
                let box: Bool? = m[3].map { SRx("x", "i").test($0) }
                let indent = (m[1] ?? "").replacingOccurrences(of: "\t", with: "    ")
                let marker = m[2] ?? "-"
                blocks.append(.item(ordered: SRx(#"\d"#).test(marker), marker: marker, depth: JSStr.len(indent) / 2, checked: box, text: m[4] ?? ""))
                i += 1; continue
            }
            if let m = quoteRx.match(line) {
                endPara()
                if case .quote(let text)? = blocks.last { blocks[blocks.count - 1] = .quote(text + " " + (m[1] ?? "")) } else { blocks.append(.quote(m[1] ?? "")) }
                i += 1; continue
            }
            if para == nil { para = [] }
            para?.append(JSStr.trim(line))
            i += 1
        }
        endPara()
        return blocks
    }

    static let inline = SRx(#"(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])"#)

    public static func runs(_ text: String) -> [Run] {
        var runs: [Run] = []
        var at = 0
        for m in inline.matchAll(text) {
            if m.index > at { runs.append(Run(text: JSStr.slice(text, at, m.index))) }
            if m[1] != nil { runs.append(Run(text: m[2] ?? "", code: true)) }
            else if let b = m[3] ?? m[4] { runs.append(Run(text: b, bold: true)) }
            else if let it = m[5] ?? m[6] { runs.append(Run(text: it, italic: true)) }
            else if let label = m[7] { runs.append(Run(text: label, href: m[8])) }
            else { runs.append(Run(text: m[9] ?? "", href: m[9])) }
            at = m.end
        }
        if at < JSStr.len(text) { runs.append(Run(text: JSStr.slice(text, at))) }
        return runs
    }
}
