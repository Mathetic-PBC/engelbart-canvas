import Foundation

// Chat's citations (src/renderer/model/cite.js, cite-open.js; src/shared/passage-link.cjs, passage-text.cjs,
// address-key.cjs). A link whose fragment has `cite=` is a small grey circle with a number; the markdown keeps the whole
// link: this is drawing only. Numbers go by the answer: each distinct passage its own, in the order first cited.

/// A link's target: { address, find, to } and, for a citation, `cite`, `counter`, `note`, `page` (passage-link.cjs).
public struct LinkTarget: Equatable, Sendable {
    public var address: String
    public var find: String
    public var to: String
    public var cite: String? = nil
    public var counter: Bool? = nil
    public var note: String? = nil
    public var page: Int? = nil
}

public struct Citation: Equatable, Sendable {
    public var label: String
    public var href: String
    public var address: String
    public var key: String
    public var find: String
    public var cite: String
    public var counter: Bool
    public var note: String?
}

public enum PassageLink {
    public static let CITES: Set<String> = ["you", "other", "source"]
    static let TAIL = Rx(#"&(to|page|note|cite|counter)=([^&]*)$"#)
    static let HEAD = Rx(#"^(to|page|note|cite|counter)=([^&]*)&"#)

    static func words(_ value: String?) -> String {
        let v = value ?? ""
        let out = v.decodeURIComponent ?? v
        return Rx(#"\s+"#).replace(out, with: " ").trimmed
    }

    static func fragmentParts(_ fragment: String) -> [String: String]? {
        if !Rx(#"(?:^|&)find="#).test(fragment) { return wholeParts(fragment) }
        var rest = fragment
        var keys: [String: String] = [:]
        var lead = false
        while !rest.hasPrefix("find="), let m = HEAD.match(rest) {
            if keys[m[1]!] != nil { return nil }
            keys[m[1]!] = m[2]!
            rest = rest.slice(m.str.len)
            lead = true
        }
        if !rest.hasPrefix("find=") { return nil }
        while let m = TAIL.match(rest) {
            if keys[m[1]!] != nil { break }
            keys[m[1]!] = m[2]!
            rest = rest.slice(0, m.index)
        }
        let cited = keys["cite"] != nil || keys["counter"] != nil
        if !cited {
            if lead { return nil }
            if let m = Rx(#"^find=([\s\S]*?)&to=([^&]*)$"#).match(fragment) ?? Rx(#"^find=([\s\S]*)$"#).match(fragment) {
                return ["find": m[1] ?? "", "to": m[2] ?? ""]
            }
            return nil
        }
        keys["find"] = rest.slice("find=".len)
        return keys
    }

    static func wholeParts(_ fragment: String) -> [String: String]? {
        var keys: [String: String] = [:]
        for pair in fragment.jsSplit("&") {
            guard let m = Rx(#"^(page|note|cite|counter)=([^&]*)$"#).match(pair), keys[m[1]!] == nil else { return nil }
            keys[m[1]!] = m[2]!
        }
        guard keys["cite"] != nil else { return nil }
        keys["find"] = ""
        return keys
    }

    /// → { address, find, to }, and `cite`/`counter` when the link is a citation.
    public static func splitTarget(_ href: String?) -> LinkTarget {
        let link = (href ?? "").trimmed
        let hash = link.indexOf("#")
        let fragment = hash >= 0 ? link.slice(hash + 1) : ""
        guard let parts = fragmentParts(fragment) else { return LinkTarget(address: link, find: "", to: "") }
        var address = link.slice(0, hash)
        if Rx(#"^(?:\/|~\/)"#).test(address) && Rx(#"%[0-9a-f]{2}"#, "i").test(address) { address = address.decodeURIComponent ?? address }
        var out = LinkTarget(address: address, find: words(parts["find"]), to: words(parts["to"]))
        if parts["cite"] != nil || parts["counter"] != nil {
            let cite = words(parts["cite"]).lowercased()
            out.cite = CITES.contains(cite) ? cite : ""
            out.counter = words(parts["counter"]) == "1"
            if let note = parts["note"], !note.isEmpty { out.note = words(note) }
            if let page = parts["page"], Rx(#"^[1-9]\d{0,5}$"#).test(page) { out.page = Int(page) }
        }
        return out
    }

    static func encode(_ value: String) -> String { value.encodeURIComponent.replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29") }

    /// A path as a citation's address spells it: each segment percent-encoded. A web address as it is but its spaces and parentheses.
    public static func linkAddress(_ where_: String?) -> String {
        let w = where_ ?? ""
        if w.hasPrefix("/") { return w.jsSplit("/").map(encode).joined(separator: "/") }
        return Rx(#"[()\s]"#).replace(w) { m in m.str == "(" ? "%28" : m.str == ")" ? "%29" : "%20" }
    }

    /// A citation's href.
    public static func citeHref(address: String, find: String = "", to: String = "", page: Int = 0, note: String = "", cite: String, counter: Bool = false) -> String {
        let at = page > 0 ? "page=\(page)&" : ""
        let tail = "\(at)\(note.isEmpty ? "" : "note=\(encode(note))&")cite=\(cite)\(counter ? "&counter=1" : "")"
        if find.isEmpty { return "\(linkAddress(address))#\(tail)" }
        return "\(linkAddress(address))#find=\(encode(find))\(to.isEmpty ? "" : "&to=\(encode(to))")&\(tail)"
    }
}

/// How one address is spelled wherever a page is matched (shared/address-key.cjs).
public enum AddressKey {
    static let TRACKING = Rx(#"^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref)$"#, "i")

    static func cleanSearch(_ search: String?) -> String {
        let kept = Rx(#"^\?"#).replace(search ?? "", with: "").jsSplit("&").filter { part in
            if part.isEmpty { return false }
            var name = part.jsSplit("=")[0]
            name = name.replacingOccurrences(of: "+", with: " ").decodeURIComponent ?? name
            return !TRACKING.test(name)
        }
        return kept.isEmpty ? "" : "?" + kept.joined(separator: "&")
    }

    /// http or https, www. or not, a trailing slash, a #fragment and tracking parameters aside: one address.
    public static func addressKey(_ value: String?) -> String {
        let v = (value ?? "").trimmed
        if v.isEmpty || v == "about:blank" { return "" }
        guard let u = URLComponents(string: v), let scheme = u.scheme?.lowercased() else { return v }
        if scheme != "http" && scheme != "https" { return Rx(#"#.*$"#).replace(v, with: "") }
        let host = (u.percentEncodedHost ?? "").lowercased() + (u.port.map { ":\($0)" } ?? "")
        var path = u.percentEncodedPath
        if path.isEmpty { path = "/" }
        return Rx(#"^www\."#).replace(host, with: "") + Rx(#"\/+$"#).replace(path, with: "") + cleanSearch(u.percentEncodedQuery.map { "?" + $0 })
    }

    /// Whether `value` is a local server or a sandbox preview.
    public static func isPreviewAddress(_ value: String?) -> Bool {
        guard let u = URLComponents(string: (value ?? "").trimmed), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        var host = (u.host ?? "").lowercased()
        host = Rx(#"^\[|\]$"#).replace(host, with: "")
        host = Rx(#"\.$"#).replace(host, with: "")
        return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "0.0.0.0" || Rx(#"^127(?:\.\d{1,3}){3}$"#).test(host) || Rx(#"(?:^|\.)e2b\.(?:app|dev)$"#, "i").test(host)
    }
}

/// How a quoted passage is found in a text (shared/passage-text.cjs): both texts folded the same way, every folded
/// character keeping the offset it came from.
public enum PassageText {
    static let ONE: [Character: String] = [
        "\u{2018}": "'", "\u{2019}": "'", "\u{201A}": "'", "\u{201B}": "'", "\u{2032}": "'",
        "\u{201C}": "\"", "\u{201D}": "\"", "\u{201E}": "\"", "\u{201F}": "\"", "\u{2033}": "\"",
        "\u{2010}": "-", "\u{2011}": "-", "\u{2012}": "-", "\u{2013}": "-", "\u{2014}": "-", "\u{2015}": "-", "\u{2212}": "-",
    ]
    static let LIGATURES: [Character: String] = ["\u{FB00}": "ff", "\u{FB01}": "fi", "\u{FB02}": "fl", "\u{FB03}": "ffi", "\u{FB04}": "ffl", "\u{FB05}": "st", "\u{FB06}": "st"]
    public static let PREFIX = Rx(#"^(?:@(?:bart|chat|brainstorm|discover|create|build)\b(?:\s+--\S+)*\s|bart[+?~]?> ?)"#, "i")
    static let MD_LINE = Rx(#"^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)"#)

    public struct Folded { public var text: [String]; public var map: [Int]; public var string: String { text.joined() } }

    static func isSpace(_ u: UInt16) -> Bool {
        guard let s = Unicode.Scalar(u) else { return false }
        return CharacterSet.whitespacesAndNewlines.contains(s) || u == 0xFEFF
    }
    static func isLetter(_ s: String) -> Bool { !s.isEmpty && Rx(#"^\p{L}$"#).test(s) }
    static func isHyphen(_ u: UInt16) -> Bool { u == 0x2D || (u >= 0x2010 && u <= 0x2015) || u == 0x2212 }

    /// `text` folded → characters and, for each, the offset in `text` it came from (UTF-16).
    public static func fold(_ input: String?, prefixes: Bool = false, markdown: Bool = false) -> Folded {
        let src = input ?? ""
        let u = Array(src.utf16)
        var out: [String] = []
        var map: [Int] = []
        var lineStart = true
        func push(_ chars: String, _ at: Int) { for c in chars { out.append(String(c)); map.append(at) } }
        func space(_ at: Int) { if let last = out.last, last != " " { push(" ", at) } }
        func unit(_ i: Int) -> String { i >= 0 && i < u.count ? String(utf16CodeUnits: [u[i]], count: 1) : "" }
        var i = 0
        while i < u.count {
            let c = u[i]
            if c == 0x0A { space(i); lineStart = true; i += 1; continue }
            if isSpace(c) { space(i); i += 1; continue }
            if lineStart {
                lineStart = false
                let rest = src.slice(i, i + 80)
                if prefixes, let m = PREFIX.match(rest) { i += m.str.len; lineStart = true; continue }
                if markdown, let m = MD_LINE.match(rest) { i += m.str.len; continue }
            }
            if c == 0xAD { i += 1; continue }
            // "construc-\ntion": a hyphen at a line's end between letters joins the word.
            if isHyphen(c) && i > 0 && isLetter(unit(i - 1)) {
                if let m = Rx(#"^[ \t]*\r?\n\s*"#).match(src.slice(i + 1, i + 40)), isLetter(unit(i + 1 + m.str.len)) {
                    var j = i + 1 + m.str.len
                    if prefixes, let p = PREFIX.match(src.slice(j, j + 80)) { j += p.str.len }
                    let cj = unit(j)
                    if isLetter(cj) && cj == cj.lowercased() { i = j; continue }
                }
            }
            if markdown {
                if c == 0x2A || c == 0x60 || c == 0x5F || c == 0x5B { i += 1; continue }
                if c == 0x5D && i + 1 < u.count && u[i + 1] == 0x28 {
                    let close = src.indexOf(")", i + 2)
                    if close > 0 && !Rx(#"\s"#).test(src.slice(i + 2, close)) { i = close + 1; continue }
                }
                if c == 0x5D { i += 1; continue }
            }
            // A surrogate pair stays whole, mapped to its first unit.
            if c >= 0xD800 && c < 0xDC00 && i + 1 < u.count {
                let pair = String(utf16CodeUnits: [c, u[i + 1]], count: 2)
                push(pair.lowercased(), i); i += 2; continue
            }
            let ch = Character(unit(i))
            if let one = ONE[ch] { push(one, i); i += 1; continue }
            if let lig = LIGATURES[ch] { push(lig, i); i += 1; continue }
            push(unit(i).lowercased(), i)
            i += 1
        }
        while out.last == " " { out.removeLast(); map.removeLast() }
        return Folded(text: out, map: map)
    }

    public static func normalizePassage(_ text: String?, prefixes: Bool = false, markdown: Bool = false) -> String { fold(text, prefixes: prefixes, markdown: markdown).string }

    static func without(_ f: Folded, _ drop: Set<String>) -> Folded {
        var t: [String] = [], m: [Int] = []
        for (k, c) in f.text.enumerated() where !drop.contains(c) { t.append(c); m.append(f.map[k]) }
        return Folded(text: t, map: m)
    }

    /// Every place `words` are in `text` → [(start, end)], offsets into `text`.
    public static func matchPassage(_ text: String?, _ words: String?, prefixes: Bool = false, markdown: Bool = false) -> [(start: Int, end: Int)] {
        let hay = fold(text, prefixes: prefixes, markdown: markdown)
        let want = fold(words, markdown: markdown).string
        if want.isEmpty { return [] }
        let tries: [(Folded, String)] = [
            (hay, want),
            (without(hay, ["-"]), want.replacingOccurrences(of: "-", with: "")),
            (without(hay, ["-", " "]), want.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: " ", with: "")),
        ]
        for (h, w) in tries where !w.isEmpty {
            // Search the folded text as one string; each UTF-16 offset in it maps back to its folded character.
            var entryAt: [Int] = []   // utf16 offset in `joined` → index of its folded character
            for (k, c) in h.text.enumerated() { for _ in 0..<c.utf16.count { entryAt.append(k) } }
            let joined = h.string
            var out: [(start: Int, end: Int)] = []
            var at = joined.indexOf(w)
            while at >= 0 {
                let endUnit = at + w.len - 1
                if endUnit < entryAt.count {
                    let first = entryAt[at], last = entryAt[endUnit]
                    out.append((h.map[first], h.map[last] + h.text[last].utf16.count))
                }
                at = joined.indexOf(w, at + 1)
            }
            if !out.isEmpty { return out }
        }
        return []
    }
}

public enum Cite {
    static let LINK = Rx(#"^\[([^\]]+)\]\(([^)]+)\)$"#)
    static let INLINE_LINK = Rx(#"\[([^\]\n]+)\]\(([^)\s]+)\)"#)
    static let STREAM_CITE = Rx(#"[ \t]?\[[^\]\n]*\]\((?:(?!\]\()[^\n])*?[#&]cite=[A-Za-z]*(?:&(?:to|counter)=[^&)\n]*)*\)"#)
    static let STREAM_TAIL = Rx(#"[ \t]?\[[^\]\n]*(?:\]\([^)\n]*)?$"#)

    /// An answer so far without its citations, or the link being written at its end (2026-10-21, David).
    public static func streamingText(_ text: String?) -> String { STREAM_TAIL.replace(STREAM_CITE.replace(text ?? "", with: ""), with: "") }

    /// Which source an address is, for numbering.
    public static func citationKey(_ address: String) -> String { Rx(#"^https?:\/\/"#, "i").test(address) ? AddressKey.addressKey(address) : address }

    /// A citation's parts from an inline token, or nil for any other token.
    public static func citationOf(_ tok: String?) -> Citation? {
        guard let m = LINK.match(tok ?? ""), Rx(#"[#&]cite="#).test(m[2]!) else { return nil }
        let t = PassageLink.splitTarget(m[2])
        guard let cite = t.cite, !cite.isEmpty, PassageLink.CITES.contains(cite) else { return nil }
        return Citation(label: m[1]!, href: m[2]!, address: t.address, key: citationKey(t.address), find: t.find, cite: cite, counter: t.counter ?? false, note: t.note)
    }

    /// Which passage a citation is, for numbering.
    public static func citationPassage(_ c: Citation) -> String { "\(c.key)\n\(c.find)\(c.note.map { "\n\($0)" } ?? "")" }

    /// An answer's citation numbers: passage → 1, 2, … in the order first cited.
    public static func citationNumbers(_ texts: [String]) -> [String: Int] {
        var out: [String: Int] = [:]
        for text in texts {
            for m in INLINE_LINK.matchAll(text) {
                if let c = citationOf(m.str), out[citationPassage(c)] == nil { out[citationPassage(c)] = out.count + 1 }
            }
        }
        return out
    }

    /// How each token draws among citations: a run of three or more is folded.
    public static func citationRuns(_ tokens: [String], citation: (String) -> Bool = { citationOf($0) != nil }) -> [CiteRunRole?] {
        var out: [CiteRunRole?] = Array(repeating: nil, count: tokens.count)
        var i = 0
        while i < tokens.count {
            if !citation(tokens[i]) { i += 1; continue }
            var cites = [i]
            var j = i + 1, last = i
            while j < tokens.count {
                if citation(tokens[j]) { cites.append(j); last = j; j += 1; continue }
                if Rx(#"^\s+$"#).test(tokens[j]) && j + 1 < tokens.count && citation(tokens[j + 1]) { j += 1; continue }
                break
            }
            if cites.count >= 3 { for k in i...last { out[k] = CiteRunRole(run: i, role: k == i ? .first : .rest, last: last, more: cites.count - 1) } }
            i = last + 1
        }
        return out
    }

    /// What a citation's card says of its source.
    public static func citationSource(_ c: Citation, _ name: ((String) -> String?)?) -> String {
        if let named = name?(c.address), !named.isEmpty { return named }
        let parts = c.address.jsSplit("/").filter { !$0.isEmpty }
        if parts.last == "workspace.md" && parts.count > 1 { return parts[parts.count - 2] }
        if Rx(#"^https?:\/\/"#, "i").test(c.address) {
            if let host = URLComponents(string: c.address)?.host { return Rx(#"^www\."#).replace(host, with: "") }
            return c.address
        }
        return parts.last ?? c.address
    }

    /// What the library calls the source at `address`, among `rows`; nil when it does not have it.
    public static func libraryName(_ rows: [LibRow], _ address: String) -> String? {
        let list = rows.filter { $0.type != "chat" }
        let key = Rx(#"^https?:\/\/"#, "i").test(address) ? AddressKey.addressKey(address) : nil
        if let row = list.first(where: { ($0.path != nil && $0.path == address) || (key != nil && $0.url != nil && AddressKey.addressKey($0.url) == key) }) {
            return row.name.isEmpty ? nil : row.name
        }
        let folder = list.first { r in
            guard let dir = r.folderPath ?? (r.type == "folder" ? r.path : nil) else { return false }
            return address.hasPrefix(Rx(#"\/+$"#).replace(dir, with: "") + "/")
        }
        return folder.map { "\($0.name) / \(address.jsSplit("/").last ?? "")" }
    }

    public struct SourcePassage: Equatable { public var n: Int; public var href: String; public var label: String; public var find: String; public var note: String; public var cite: String; public var counter: Bool }
    public struct Source: Equatable { public var n: Int; public var name: String; public var href: String; public var passages: [SourcePassage] }

    /// An answer's sources, in the order it first cites each.
    public static func citationSources(_ text: String, cites: [String: Int]? = nil, citeSource: ((String) -> String?)? = nil) -> [Source] {
        let nums = cites ?? citationNumbers([text])
        var order: [String] = []
        var seen: [String: Source] = [:]
        for m in INLINE_LINK.matchAll(text) {
            guard let c = citationOf(m.str) else { continue }
            let n = nums[citationPassage(c)] ?? nums.count + 1
            if seen[c.key] == nil { seen[c.key] = Source(n: n, name: citationSource(c, citeSource), href: c.href, passages: []); order.append(c.key) }
            if !(seen[c.key]!.passages.contains { $0.n == n }) {
                seen[c.key]!.passages.append(SourcePassage(n: n, href: c.href, label: c.label, find: c.find, note: c.note ?? "", cite: c.cite, counter: c.counter))
            }
        }
        return order.map { seen[$0]! }.sorted { $0.n < $1.n }
    }

    public struct Card: Equatable { public var quote: String; public var lead: String; public var where_: String; public var when: String; public var counter: Bool }
    static let AGENTS: Set<String> = ["Chat", "ChatGPT", "Claude", "Codex", "Cursor"]

    /// A citation's card (2026-10-21, David's mock): the quote, then where and when it is from.
    public static func citationCard(label: String, cite: String, find: String, note: String, source: String, counter: Bool) -> Card {
        let parts = label.components(separatedBy: " · ")
        let who = parts.first ?? ""
        let rest = parts.dropFirst().joined(separator: " · ")
        let isSource = cite == "source"
        return Card(quote: note.isEmpty ? find : note,
                    lead: !note.isEmpty ? "Your note" : (cite == "other" && AGENTS.contains(who) ? who : ""),
                    where_: isSource ? (label.isEmpty ? source : label) : source,
                    when: isSource ? "" : rest,
                    counter: counter)
    }
    public static func citationCard(_ c: Citation, source: String) -> Card {
        citationCard(label: c.label, cite: c.cite, find: c.find, note: c.note ?? "", source: source, counter: c.counter)
    }

    /// How long a card waits, the pointer gone from its circle, for the pointer to reach it.
    public static let CARD_GRACE: TimeInterval = 0.2
}

public struct CiteRunRole: Equatable {
    public enum Role: Equatable { case first, rest }
    public var run: Int
    public var role: Role
    public var last: Int
    public var more: Int
}

/// Where a citation of the person's own thinking opens (src/renderer/model/cite-open.js).
public enum CiteOpen {
    public struct WorkspaceNode { public var id: String; public var name: String; public var folder: String?; public var parentId: String?
        public init(id: String, name: String, folder: String?, parentId: String?) { self.id = id; self.name = name; self.folder = folder; self.parentId = parentId } }
    public struct Cited: Equatable { public var kind: String; public var id: String; public var name: String; public var find: String; public var cite: String }

    static func workspaceFile(_ projectDir: String, _ index: [String: WorkspaceNode], _ id: String) -> String? {
        var folders: [String] = []
        var at = index[id]
        while let node = at {
            guard let folder = node.folder, !folder.isEmpty else { return nil }
            folders.insert(folder, at: 0)
            at = node.parentId.flatMap { index[$0] }
        }
        return "\(Rx(#"\/+$"#).replace(projectDir, with: ""))/\(folders.joined(separator: "/"))/workspace.md"
    }

    /// The document a citation at `href` quotes, when it is one the middle column shows.
    public static func citedDoc(_ href: String, projectDir: String?, index: [String: WorkspaceNode]?, order: [String]? = nil, notes: [LibRow]) -> Cited? {
        let target = PassageLink.splitTarget(href)
        guard let cite = target.cite, !cite.isEmpty, target.address.hasPrefix("/") else { return nil }
        let address = target.address
        if address.hasSuffix("/workspace.md"), let projectDir, let index {
            for id in order ?? Array(index.keys) {
                if workspaceFile(projectDir, index, id) == address, let node = index[id] { return Cited(kind: "workspace", id: id, name: node.name, find: target.find, cite: cite) }
            }
            return nil
        }
        guard let note = notes.first(where: { $0.path != nil && $0.path == address }) else { return nil }
        return Cited(kind: "note", id: note.id, name: note.name, find: target.find, cite: cite)
    }

    static let ANSWER_LINE = Rx(#"^bart[+?]?> ?"#)

    /// The line of `lines` where the quoted words start, or -1; the person's own line first for their words.
    public static func passageLine(_ lines: [String], _ find: String, cite: String = "you") -> Int {
        let text = lines.joined(separator: "\n")
        let hits = PassageText.matchPassage(text, find, prefixes: true, markdown: true)
        if hits.isEmpty { return -1 }
        var starts: [Int] = []
        var at = 0
        for l in lines { starts.append(at); at += l.len + 1 }
        func lineOf(_ offset: Int) -> Int { var i = starts.count - 1; while i > 0 && starts[i] > offset { i -= 1 }; return i }
        let ats = hits.map { lineOf($0.start) }
        func answer(_ i: Int) -> Bool { ANSWER_LINE.test(i < lines.count ? lines[i] : "") }
        return ats.first { cite == "you" ? !answer($0) : answer($0) } ?? ats[0]
    }
}
