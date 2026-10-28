import Foundation

// Copy and cut (doc.js, 2026-10-02): what a selection copies is the document's markdown, so links keep their addresses;
// the HTML a copy carries beside it for apps that paste HTML; text pasted from a web page gets its links back.

/// A place in a document: a line and an offset into lineText() (as the editor's caret gives it). `Int.max` is a line's end.
public struct DocPoint: Equatable, Hashable, Sendable, Comparable {
    public var line: Int
    public var offset: Int
    public init(line: Int, offset: Int) { self.line = line; self.offset = offset }
    public static func < (a: DocPoint, b: DocPoint) -> Bool { a.line < b.line || (a.line == b.line && a.offset < b.offset) }
}

extension Doc {
    public static func esc(_ s: String) -> String {
        var out = ""
        for c in s {
            switch c { case "&": out += "&amp;"; case "<": out += "&lt;"; case ">": out += "&gt;"; case "\"": out += "&quot;"; default: out.append(c) }
        }
        return out
    }

    // Where a line's shown text starts in lineText(): after a heading's `# ` or a quote's `> `, and in an answer after a
    // heading or bullet mark of its own.
    static func shownFrom(_ p: ParsedLine, _ line: String) -> Int {
        if p.type == .h { return p.level + 1 }
        if p.type == .quote { return line.len - p.text.len }
        if p.type == .reply && p.code == nil { let q = parseLine(p.text); return q.type == .h || isMarked(q.type) ? p.text.len - q.text.len : 0 }
        return 0
    }

    // One token cut to [lo, hi) of its source; what is left keeps its markup (doc.js cutToken).
    static func cutToken(_ tok: String, _ lo: Int, _ hi: Int, _ inside: Bool) -> String {
        if lo <= 0 && hi >= tok.len { return tok }
        if tok.hasPrefix("**") && tok.hasSuffix("**") && tok.len > 4 {
            let inner = tok.slice(2, -2)
            let x = max(0, min(inner.len, lo - 2)), y = max(0, min(inner.len, hi - 2))
            if x >= y { return "" }
            if lo <= 0 && y == inner.len { return tok }
            let part = sliceInline(inner, x, y, inside)
            return inside || part.isEmpty ? part : "**\(part)**"
        }
        // Drawn math copies as its LaTeX, whole, unless the selection is within its source.
        let t = Inline.tokShown(tok)
        if t.unit { return inside ? tok.slice(lo, hi) : tok }
        if t.pre == 0 { return tok.slice(lo, hi) }
        let n = t.shown.len
        if lo >= t.pre + n { return lo == t.pre + n && hi >= tok.len ? "" : tok.slice(lo, hi) }
        let x = max(0, lo - t.pre), y = max(0, min(n, hi - t.pre))
        if x >= y { return "" }
        if y == n && (lo <= 0 || (!inside && x == 0)) { return tok }
        let part = t.shown.slice(x, y)
        if inside { return part }
        if let link = Inline.LINK.match(tok) { return "[\(part)](\(link[2]!))" }
        if tok.hasPrefix("`") { return "`\(part)`" }
        if tok.hasPrefix("*") { return "*\(part)*" }
        return tok
    }

    static func sliceInline(_ text: String, _ a: Int, _ b: Int, _ alone: Bool) -> String {
        var out = ""
        var s = 0
        for tok in Inline.INLINE.split(text) where !tok.isEmpty {
            let e = s + tok.len
            if a < e && b > s { out += cutToken(tok, max(0, a - s), min(tok.len, b - s), alone && a >= s && b <= e) }
            s = e
        }
        return out
    }

    /// What a selection copies: the document's markdown from `start` to `end` (either order; offsets into lineText()).
    public static func selectionMarkdown(_ lines: [String], _ startIn: DocPoint?, _ endIn: DocPoint?) -> String {
        guard var start = startIn, var end = endIn else { return "" }
        if end < start { swap(&start, &end) }
        let ps = parseLines(lines)
        var feet = Set<Int>()
        for thread in threads(lines, ps) { for turn in thread.turns where turn.foot >= 0 { feet.insert(turn.foot) } }
        var out: [String] = []
        let lo = max(0, start.line), hi = min(end.line, lines.count - 1)
        if lo > hi { return "" }
        for i in lo...hi {
            let p = ps[i], line = lines[i]
            if p.type == .pending || p.type == .build || feet.contains(i) { continue }
            let text = lineText(p, line)
            let code = isCode(p) || isFence(p)
            func at(_ o: Int) -> Int { max(0, min(text.len, o)) }
            var a = i == start.line ? at(start.offset) : 0
            let b = i == end.line ? (end.offset == Int.max ? text.len : at(end.offset)) : text.len
            if start.line == end.line { return code ? text.slice(a, b) : sliceInline(text, a, b, true) }
            let lead = code ? 0 : shownFrom(p, line)
            // The selection reaches the last line without taking any of its text: the line break is all it holds of it.
            if i == end.line && b <= lead && b < text.len { out.append(""); continue }
            if a <= lead { a = 0 }
            let part = code ? text.slice(a, b) : sliceInline(text, a, b, false)
            out.append(a == 0 && isMarked(p.type) ? line.slice(0, line.len - p.text.len) + part : part)
        }
        return out.joined(separator: "\n")
    }

    static let SAFE_HREF = Rx(#"^(https?:|mailto:)"#, "i")

    // Inline markdown as plain HTML for other apps: no styles, no chips.
    static func plainHtml(_ text: String) -> String {
        Inline.INLINE.split(text).map { tok -> String in
            if tok.isEmpty || DocRx.ATTACH.test(tok) { return "" }
            if tok == "\\$" { return "$" }
            if Inline.isMathToken(tok) { return esc(tok) }
            if tok.hasPrefix("**") && tok.hasSuffix("**") && tok.len > 4 { return "<strong>\(plainHtml(tok.slice(2, -2)))</strong>" }
            if tok.hasPrefix("`") && tok.hasSuffix("`") && tok.len > 2 { return "<code>\(esc(tok.slice(1, -1)))</code>" }
            if tok.hasPrefix("*") && tok.hasSuffix("*") && tok.len > 2 { return "<em>\(esc(tok.slice(1, -1)))</em>" }
            if let ws = Inline.WS_MENTION.match(tok) { return esc(ws[1]!) }
            if let lib = Inline.LIB_MENTION.match(tok) { return esc(lib[1]!) }
            if let file = Inline.FILE_MENTION.match(tok) { return esc(file[1]!) }
            if let z = Inline.ZOTERO_MENTION.match(tok) { return esc(z[1]!) }
            if tok.hasPrefix("@[") { return esc(tok.slice(2, -1)) }
            if let m = Inline.LINK.match(tok) { return SAFE_HREF.test(m[2]!) ? "<a href=\"\(esc(m[2]!))\">\(esc(m[1]!))</a>" : esc(m[1]!) }
            if Inline.URL_RE.test(tok) { return "<a href=\"\(esc(tok))\">\(esc(tok))</a>" }
            return esc(tok)
        }.joined()
    }

    /// The HTML a copy carries beside its markdown: links, bold and italic, one line per line (`<br>`).
    public static func selectionHtml(_ markdown: String?) -> String {
        let ls = (markdown ?? "").jsSplit("\n")
        let ps = parseLines(ls)
        func pad(_ depth: Int) -> String { "&nbsp;&nbsp;&nbsp;&nbsp;".repeated(depth) }
        return ls.enumerated().compactMap { i, line -> String? in
            let p = ps[i]
            switch p.type {
            case .fence: return nil
            case .code: return "<code>\(Rx(#"^ +"#).replace(esc(line)) { "&nbsp;".repeated($0.str.len) })</code>"
            case .h: return "<strong>\(plainHtml(p.text))</strong>"
            case .todo: return "\(pad(p.depth))\(p.done ? "☑" : "☐") \(plainHtml(p.text))"
            case .list: return "\(pad(p.depth))\(listMark(p)) \(plainHtml(p.text))"
            case .img: return Rx(#"^https?:"#).test(p.src) ? "<a href=\"\(esc(p.src))\">\(esc(p.text.isEmpty ? p.src : p.text))</a>" : nil
            default: return plainHtml(line)
            }
        }.joined(separator: "<br>")
    }

    /// Text pasted from a web page: each link of the page's HTML written back where its title next stands.
    public static func withLinks(_ plain: String?, _ anchors: [(text: String, href: String)]) -> String {
        let text = plain ?? ""
        let word = Rx(#"[\p{L}\p{N}]"#, "u")
        var out = "", at = 0
        for anchor in anchors {
            let title = Rx(#"\s+"#).replace(anchor.text, with: " ").trimmed
            let url = anchor.href.trimmed
            if title.isEmpty || Rx(#"[\[\]]"#).test(title) || !Rx(#"^https?:\/\/\S+$"#, "i").test(url) || Rx(#"\/$"#).replace(title, with: "") == Rx(#"\/$"#).replace(url, with: "") { continue }
            var k = text.indexOf(title, at)
            while k >= 0 && ((word.test(title.charAt(0)) && word.test(text.charAt(k - 1))) || (word.test(title.charAt(title.len - 1)) && word.test(text.charAt(k + title.len)))) {
                k = text.indexOf(title, k + 1)
            }
            if k < 0 { continue }
            out += text.slice(at, k) + "[\(title)](\(url.replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")))"
            at = k + title.len
        }
        return out + text.slice(at)
    }

    // MARK: code colouring

    // Code is coloured only where it can be read one line at a time without guessing: JSON (keys ink, strings blue, numbers
    // and literals grey, punctuation faint), in the app's one ink, grays and one blue.
    public static let JSON_LANGS: Set<String> = ["json", "jsonc", "json5", "jsonl", "ndjson", "geojson"]
    static let JSON_TOKEN = Rx(#"("(?:[^"\\]|\\.)*"?)([ \t]*:)?|((?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.]))|\b(true|false|null)\b|([{}\[\],:])|(\/\/.*$)"#)

    public enum CodeLook: String, Sendable { case plain, key, str, num, punct, note }
    /// The colour of each look: `#171717` key, `#0761d1` string, `#4d4d4d` number, `#8f8f8f` punctuation and comment (italic).
    public static let CODE_COLORS: [CodeLook: String] = [.key: "#171717", .str: "#0761d1", .num: "#4d4d4d", .punct: "#8f8f8f", .note: "#8f8f8f"]

    /// One line of code as runs of its text exactly, each with its look.
    public static func highlightRuns(_ text: String, _ lang: String?) -> [(text: String, look: CodeLook)] {
        guard JSON_LANGS.contains((lang ?? "").lowercased()) else { return text.isEmpty ? [] : [(text, .plain)] }
        var out: [(String, CodeLook)] = []
        var at = 0
        func plain(_ s: String) { if !s.isEmpty { out.append((s, .plain)) } }
        for m in JSON_TOKEN.matchAll(text) {
            plain(text.slice(at, m.index)); at = m.end
            if let s = m[1], let colon = m[2] { out.append((s, .key)); plain(colon.slice(0, -1)); out.append((":", .punct)) }
            else if let s = m[1] { out.append((s, .str)) }
            else if m[3] != nil || m[4] != nil { out.append((m.str, .num)) }
            else if m[5] != nil { out.append((m.str, .punct)) }
            else { out.append((m.str, .note)) }
        }
        plain(text.slice(at))
        return out
    }

    /// One line of code as HTML (doc.js highlight).
    public static func highlight(_ text: String, _ lang: String?) -> String {
        guard JSON_LANGS.contains((lang ?? "").lowercased()) else { return esc(text) }
        let looks: [CodeLook: String] = [.key: "color:#171717", .str: "color:#0761d1", .num: "color:#4d4d4d", .punct: "color:#8f8f8f", .note: "color:#8f8f8f;font-style:italic"]
        return highlightRuns(text, lang).map { r in r.look == .plain ? esc(r.text) : "<span style=\"\(looks[r.look]!)\">\(esc(r.text))</span>" }.joined()
    }
}
