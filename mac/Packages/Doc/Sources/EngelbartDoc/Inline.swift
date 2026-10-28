import Foundation

// Inline markup of a line (src/renderer/model/doc.js INLINE, tokShown, rawOffset, inlineHtml): bold, italic, code, links,
// bare addresses, mentions of every kind, pasted images, math, the [[build]] hammer and Chat's citations. inlineHtml is
// ported as `Inline.runs`, a drawing-neutral tree the editor turns into attributed text; the HTML variants the clipboard
// needs (selectionHtml) live in Copy.swift.

public enum Inline {
    // Math (2026-10-12): `$…$` inline by Pandoc's rule (no space just inside either `$`, the closing `$` not followed by a
    // digit, so "$5 and $10" stays text), `$$…$$` display, and `\$` a dollar as typed.
    static let MATH_SRC = #"\$\$(?:[^$\n\\]|\\.)+?\$\$|\$(?=[^\s$])(?:[^$\n\\]|\\.)+?(?<!\s)\$(?!\d)|\\\$"#
    static let REST_SRC = #"!\[[^\]\n]*\]\(img:[\w-]+\)|\[\[build\]\]|@(?:[Bb]art|[Cc]hat|[Bb]rainstorm|[Oo]rient|[Dd]iscover|[Cc]reate)(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]\(ws:[\w-]+\)|@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%\/-]+)?\)|@\[[^\]\n]+\]\(zotero:(?:g[0-9]+:)?[A-Za-z0-9]+\)|@\[[^\]\n]+\]\(made:[\w-]+\/[\w.~%\/-]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`]"#
    /// The source of INLINE as JavaScript spells it. main's context/expand-mentions.cjs keeps a copy that must stay identical;
    /// in Swift there is one definition, this one, used by both (ExpandMentions.swift).
    public static let INLINE_SOURCE = "(" + MATH_SRC + "|" + REST_SRC + ")"
    public static let INLINE = Rx(INLINE_SOURCE)

    /// `text.split(INLINE).filter(Boolean)`.
    public static func tokens(_ text: String) -> [String] { INLINE.tokens(text) }

    static let LINK = Rx(#"^\[([^\]]+)\]\(([^)]+)\)$"#)
    static let URL_RE = Rx(#"^https?:\/\/\S+$"#)
    public static let WS_MENTION = Rx(#"^@\[([^\]\n]+)\]\(ws:([\w-]+)\)$"#)
    public static let LIB_MENTION = Rx(#"^@\[([^\]\n]+)\]\(lib:([\w-]+)\)$"#)
    public static let FILE_MENTION = Rx(#"^@\[([^\]\n]+)\]\(lib:([\w-]+):([\w.~%/-]+)\)$"#)
    public static let ZOTERO_MENTION = Rx(#"^@\[([^\]\n]+)\]\(zotero:((?:g[0-9]{1,20}:)?[A-Za-z0-9]{1,32})\)$"#)
    public static let MADE_MENTION = Rx(#"^@\[([^\]\n]+)\]\(made:([\w-]+)\/([\w.~%/-]+)\)$"#)
    /// The token that starts a question line, as INLINE splits it out.
    public static let AGENT_TOKEN = Rx(#"^@(bart|chat|brainstorm|orient|discover|create)$"#, "i")
    static let CHAT_MENTION = Rx(#"^(bart|chat)(?::[\w-]+)?$"#, "i")
    static let DISPLAY_MATH = Rx(#"^\$\$((?:[^$\n\\]|\\.)+?)\$\$$"#)
    static let INLINE_MATH = Rx(#"^\$(?=[^\s$])((?:[^$\n\\]|\\.)+?)(?<!\s)\$$"#)

    // MARK: mention tokens

    static func cleanName(_ name: String?) -> String { Rx(#"[\[\]\n]"#).replace(name ?? "", with: "").trimmed }

    /// The token that mentions a workspace (2026-09-25): `@[Name](ws:<id>)`.
    public static func wsMention(_ name: String?, _ id: String) -> String { let n = cleanName(name); return "@[\(n.isEmpty ? "Workspace" : n)](ws:\(id))" }
    /// The token that mentions a library item (MATH-21): `@[Name](lib:<id>)`.
    public static func libMention(_ name: String?, _ id: String) -> String { let n = cleanName(name); return "@[\(n.isEmpty ? "Untitled" : n)](lib:\(id))" }

    /// A path inside a folder as a file mention carries it: each segment encodeURIComponent'd, and `!'()*` too.
    public static func encodeRel(_ rel: String?) -> String {
        (rel ?? "").jsSplit("/").filter { !$0.isEmpty && $0 != "." }.map { part in
            Rx(#"[!'()*]"#).replace(part.encodeURIComponent) { m in "%" + String(format: "%02X", m.str.utf16.first!) }
        }.joined(separator: "/")
    }
    /// encodeRel's inverse; a segment that does not decode is kept as written.
    public static func decodeRel(_ rel: String?) -> String {
        (rel ?? "").jsSplit("/").filter { !$0.isEmpty }.map { $0.decodeURIComponent ?? $0 }.joined(separator: "/")
    }
    /// The token that mentions the file at `rel` inside the library folder `folderId` (MATH-22).
    public static func fileMention(_ name: String?, _ folderId: String, _ rel: String?) -> String {
        var n = cleanName(name)
        if n.isEmpty { n = Rx(#"[\[\]\n]"#).replace((rel ?? "").jsSplit("/").last ?? "", with: "") }
        if n.isEmpty { n = "Untitled" }
        return "@[\(n)](lib:\(folderId):\(encodeRel(rel)))"
    }
    public struct FileMention: Equatable { public var name: String; public var folderId: String; public var rel: String }
    public static func fileMentionOf(_ tok: String?) -> FileMention? {
        guard let m = FILE_MENTION.match(tok ?? "") else { return nil }
        return FileMention(name: m[1]!, folderId: m[2]!, rel: decodeRel(m[3]))
    }
    /// The token that mentions the Zotero item `ref` under its title (MATH-65).
    public static func zoteroMention(_ title: String?, _ ref: String) -> String {
        var n = Rx(#"\s+"#).replace(Rx(#"[\[\]\n]"#).replace(title ?? "", with: ""), with: " ").trimmed
        n = n.slice(0, 200)
        return "@[\(n.isEmpty ? "Untitled" : n)](zotero:\(ref))"
    }
    public struct ZoteroMention: Equatable { public var name: String; public var key: String; public var group: String }
    public static func zoteroMentionOf(_ tok: String?) -> ZoteroMention? {
        guard let m = ZOTERO_MENTION.match(tok ?? "") else { return nil }
        let key = m[2]!
        let group = Rx(#"^g([0-9]+):"#).match(key)?[1] ?? ""
        return ZoteroMention(name: m[1]!, key: key, group: group)
    }
    public struct MadeMention: Equatable { public var name: String; public var askId: String; public var rel: String; public var key: String { "\(askId)/\(rel)" } }
    /// A file @create made (2026-10-14): `@[name](made:<askId>/<path>)`.
    public static func madeMentionOf(_ tok: String?) -> MadeMention? {
        guard let m = MADE_MENTION.match((tok ?? "").trimmed) else { return nil }
        return MadeMention(name: m[1]!, askId: m[2]!, rel: decodeRel(m[3]))
    }

    static let FILE_KINDS: [String: String] = ["md": "md", "markdown": "md", "pdf": "pdf", "html": "html", "htm": "html", "csv": "data", "tsv": "data", "json": "data", "jsonl": "data", "ndjson": "data", "parquet": "data", "xlsx": "data", "docx": "md", "png": "image", "jpg": "image", "jpeg": "image", "gif": "image", "webp": "image", "heic": "image", "svg": "image"]
    /// What kind of file a name is, by its extension: the chip's glyph.
    public static func fileKindOf(_ name: String?) -> String {
        guard let ext = Rx(#"\.([^./]+)$"#).match(name ?? "") else { return "file" }
        return FILE_KINDS[ext[1]!.lowercased()] ?? "file"
    }

    /// A plain mention's name as a chat → (shown, live), or nil when it names no chat (MATH-60).
    public static func chatMention(_ name: String?) -> (shown: String, live: Bool)? {
        guard let m = CHAT_MENTION.match(name ?? "") else { return nil }
        return (m[1]!.lowercased(), Rx(#"^bart$"#, "i").test(name ?? ""))
    }

    // MARK: the @ menu's query

    static let MENTION_QUERY = Rx(#"@([^\s@[\]]{0,30})$"#)
    static let NAMED_QUERY = Rx(#"@([^\s@[\]][^@[\]\n]{0,59})$"#)

    /// The @ menu's query in `text` before `caret` → (query, start), or nil. `holds(query)`, when given, says whether a name
    /// the menu offers holds a query with a space in it (2026-10-16).
    public static func mentionAt(_ text: String?, _ caret: Int, holds: ((String) -> Bool)? = nil) -> (query: String, start: Int)? {
        let before = (text ?? "").slice(0, caret)
        if let m = MENTION_QUERY.match(before) { return (m[1]!, caret - m.str.len) }
        if let holds, let named = NAMED_QUERY.match(before), holds(named[1]!) { return (named[1]!, caret - named.str.len) }
        return nil
    }

    /// What a library folder opened from the @ menu writes into the line (MATH-22): `@Folder/`, `@Folder/sub/`, …
    public static func folderPath(_ name: String, _ rel: String?) -> String {
        "@" + ([name] + ((rel?.isEmpty ?? true) ? [] : rel!.jsSplit("/"))).joined(separator: "/") + "/"
    }

    public enum FolderQuery: Equatable { case query(String, start: Int), into(String, start: Int) }
    /// The @ menu's query inside a library folder opened from it (MATH-22); nil when the path is no longer before the caret.
    public static func folderMentionAt(_ text: String?, _ caret: Int, start: Int, path: String) -> FolderQuery? {
        let s = text ?? ""
        let end = start + path.len
        if caret < end || s.slice(start, end) != path { return nil }
        let rest = s.slice(end, caret)
        if Rx(#"[@\[\]\n]"#).test(rest) || rest.len > 80 { return nil }
        let slash = rest.indexOf("/")
        if slash < 0 { return .query(rest, start: start) }
        return slash > 0 && slash == rest.len - 1 ? .into(rest.slice(0, -1), start: start) : nil
    }

    // MARK: math

    public static func mathOf(_ tok: String) -> (tex: String, display: Bool)? {
        if let d = DISPLAY_MATH.match(tok) { return (d[1]!, true) }
        if let m = INLINE_MATH.match(tok) { return (m[1]!, false) }
        return nil
    }
    public static func isMathToken(_ tok: String) -> Bool { mathOf(tok) != nil }

    // MARK: shown text and offsets

    static func nameShown(_ name: String) -> String { WebName.isAddress(name) ? WebName.webLabel(name) : name }
    static func libShown(_ name: String, _ id: String, _ libName: ((String) -> NameNow)?) -> String {
        if let libName, case .name(let now) = libName(id), !now.isEmpty { return nameShown(now) }
        return nameShown(name)
    }

    /// What an inline token shows when rendered, and how many source characters precede the shown text; `unit`: one
    /// piece the caret stands before or after, never inside.
    public static func tokShown(_ tok: String, _ opts: InlineOpts? = nil) -> (shown: String, pre: Int, unit: Bool) {
        if tok == "\\$" { return ("$", 1, false) }
        if tok == Doc.BUILD_TOKEN { return ("", 1, true) } // the hammer: a drawing, no text
        if let math = mathOf(tok) {
            if let r = MathText.render(math.tex, display: math.display) { return (r, 1, true) }
            return (tok, 0, false)
        }
        // A pasted image is one unit too (2026-10-15, David): its source is never shown.
        if let a = DocRx.ATTACH.match(tok) { let label = a[1] ?? ""; return ("[\(label.isEmpty ? "Attachment" : label)]", 1, true) }
        if tok.hasPrefix("**") && tok.hasSuffix("**") && tok.len > 4 {
            return (tokens(tok.slice(2, -2)).map { tokShown($0, opts).shown }.joined(), 2, false)
        }
        if tok.hasPrefix("`") && tok.hasSuffix("`") && tok.len > 2 { return (tok.slice(1, -1), 1, false) }
        if tok.hasPrefix("*") && tok.hasSuffix("*") && tok.len > 2 { return (tok.slice(1, -1), 1, false) }
        if let ws = WS_MENTION.match(tok) { return ("@" + ws[1]!, 1, false) } // the icon after the @ is not text
        if let file = FILE_MENTION.match(tok) { return ("@" + file[1]!, 1, false) }
        if let z = ZOTERO_MENTION.match(tok) { return ("@" + z[1]!, 1, false) }
        if let made = MADE_MENTION.match(tok) { return ("@" + made[1]!, 1, false) }
        if let lib = LIB_MENTION.match(tok) { return ("@" + libShown(lib[1]!, lib[2]!, opts?.libName), 1, false) }
        if tok.hasPrefix("@[") {
            let nm = tok.slice(2, -1)
            if let chat = chatMention(nm) { return ("@" + chat.shown, 1, false) }
            return ("@" + nameShown(nm), 1, false)
        }
        // A citation (2026-10-21) is a circle whose number is drawn: no text, one unit.
        if Cite.citationOf(tok) != nil { return ("", 1, true) }
        if let m = LINK.match(tok) { return (m[1]!, 1, false) }
        return (tok, 0, false)
    }

    /// The source tokens of a line as edited on the active line (prefixes for headings/quotes are their own token).
    public static func tokensOf(_ p: ParsedLine, _ line: String) -> [String] {
        let src = p.type == .h || p.type == .quote || Doc.isDrawn(p.type) ? p.text : line
        let toks = tokens(src)
        if p.type == .h { return [line.slice(0, p.level + 1)] + toks }
        if p.type == .quote { return [line.slice(0, line.len - p.text.len)] + toks }
        return toks
    }

    /// Map a display offset of a rendered (non-active) line to its raw source offset (doc.js rawOffset).
    public static func rawOffset(_ p: ParsedLine, _ fOff: Int, line: String? = nil, _ opts: InlineOpts? = nil) -> Int {
        var text = p.text
        var base = p.type == .h ? p.level + 1 : p.type == .quote ? 2 : 0
        if let line {
            if p.type == .quote { base = line.len - p.text.len }
            else if p.type != .h && !Doc.isDrawn(p.type) { text = line; base = 0 }
        }
        var accF = 0, accR = 0
        for tok in tokens(text) {
            let t = tokShown(tok, opts)
            let n = t.shown.len
            if t.unit && fOff <= accF + n { return base + accR + (fOff == accF ? 0 : tok.len) }
            // The end of what a mention shows is the end of its source (MATH-56).
            if fOff <= accF + n {
                let d = fOff - accF
                if t.pre == 0 { return base + accR + d }
                return base + accR + (d == 0 ? 0 : (d == n && tok.hasPrefix("@[")) ? tok.len : min(tok.len, t.pre + d))
            }
            accF += n; accR += tok.len
        }
        return base + text.len
    }

    /// A display offset in a rendered answer line → the offset in its text (its own heading, bullet or number drawn).
    public static func replyRawOffset(_ p: ParsedLine, _ fOff: Int, _ opts: InlineOpts? = nil) -> Int {
        let q = Doc.parseLine(p.text)
        if q.type != .h && !Doc.isMarked(q.type) { return rawOffset(ParsedLine(type: .p, text: p.text), fOff, line: p.text, opts) }
        let lead = p.text.len - q.text.len
        let mark = q.type == .h ? 0 : q.type == .list ? Doc.listMark(q).len : 1
        return lead + rawOffset(ParsedLine(type: .p, text: q.text), max(0, fOff - mark), line: q.text, opts)
    }

    /// Whether an inline token draws as a link: `[title](url)`, a bare address, or bold around a link.
    public static func holdsLink(_ tok: String?) -> Bool {
        let s = tok ?? ""
        let inner = s.hasPrefix("**") && s.hasSuffix("**") && s.len > 4 ? s.slice(2, -2) : s
        return INLINE.split(inner).contains { LINK.test($0) || URL_RE.test($0) }
    }

    // MARK: drawing (inlineHtml)

    // A citation's lead-in: a colon or dash at the end of the text before it, with the space around it.
    static let CITE_LEAD = Rx(#"\s*[:–—]\s*$"#)
    static let CITE_LEAD_TOKEN = Rx(#"^(?:\*|`|\[|@\[|!\[|\$)"#)

    /// Inline markup drawn (doc.js inlineHtml) as runs. Every option may be left out, or answer "unknown": the mention is
    /// then drawn as written.
    public static func runs(_ text: String, _ opts: InlineOpts? = nil) -> [InlineRun] {
        var parts = tokens(text)
        var o = opts ?? InlineOpts()
        var folds: [CiteRunRole?]? = nil
        if parts.contains(where: { Cite.citationOf($0) != nil }) {
            // A colon or dash right before a citation is left out where the circle is drawn (2026-10-22, David).
            for k in 0..<max(0, parts.count - 1) where Cite.citationOf(parts[k + 1]) != nil && Cite.citationOf(parts[k]) == nil && !CITE_LEAD_TOKEN.test(parts[k]) {
                parts[k] = CITE_LEAD.replace(parts[k], with: " ", global: false)
            }
            folds = Cite.citationRuns(parts)
            if o.cites == nil { o.cites = Cite.citationNumbers([text]) }
        }
        let drawn = parts.map { run(of: $0, o) }
        guard let folds else { return drawn }
        var out: [InlineRun] = []
        var k = 0
        while k < drawn.count {
            if let r = folds[k], r.role == .first {
                let rest = Array(drawn[(k + 1)...r.last])
                out.append(.citeRun(first: drawn[k], more: r.more, rest: rest))
                k = r.last + 1
                continue
            }
            out.append(drawn[k]); k += 1
        }
        return out
    }

    /// One token drawn.
    public static func run(of p: String, _ opts: InlineOpts) -> InlineRun {
        if p == "\\$" { return .text("$", source: p) }
        if let m = mathOf(p) {
            if let shown = MathText.render(m.tex, display: m.display) { return .math(tex: m.tex, display: m.display, shown: shown, source: p) }
            return .mathError(p)
        }
        if p == Doc.BUILD_TOKEN { return .buildIcon(turn: opts.buildTurn) }
        // A pasted image inside a todo or a chat line reads as [Attachment n]; on a line of its own it renders as the image.
        if let a = DocRx.ATTACH.match(p) { return .attachment(label: (a[1] ?? "").isEmpty ? "Attachment" : a[1]!, id: a[2]!, source: p) }
        if p.hasPrefix("**") && p.hasSuffix("**") && p.len > 4 { return .strong(runs(p.slice(2, -2), opts), source: p) }
        if p.hasPrefix("`") && p.hasSuffix("`") && p.len > 2 { return .code(p.slice(1, -1), source: p) }
        if p.hasPrefix("*") && p.hasSuffix("*") && p.len > 2 { return .em(p.slice(1, -1), source: p) }
        if AGENT_TOKEN.test(p) { return .agent(p) }
        if let ws = WS_MENTION.match(p) { return .mention(MentionChip(kind: .workspace(id: ws[2]!), name: ws[1]!, shown: ws[1]!, icon: .workspace), source: p) }
        if let lib = LIB_MENTION.match(p) { return libRun(lib[1]!, lib[2]!, opts, source: p) }
        if FILE_MENTION.test(p) { return fileRun(p, opts) }
        if let z = ZOTERO_MENTION.match(p) { return .mention(MentionChip(kind: .zotero(ref: z[2]!), name: z[1]!, shown: z[1]!, icon: .zotero, title: "Zotero"), source: p) }
        if let made = madeMentionOf(p) { return .mention(MentionChip(kind: .made(key: made.key), name: made.name, shown: made.name), source: p) }
        if p.hasPrefix("@[") { return nameRun(p.slice(2, -1), opts, source: p) }
        if let c = Cite.citationOf(p) {
            let n = opts.cites?[Cite.citationPassage(c)] ?? 1
            return .citation(c, n: n, source: Cite.citationSource(c, opts.citeSource))
        }
        if let m = LINK.match(p) { return .link(title: m[1]!, href: m[2]!, source: p) }
        if URL_RE.test(p) { return .link(title: p, href: p, source: p) }
        return .text(p, source: p)
    }

    static func webIcon(_ opts: InlineOpts, _ name: String, _ id: String?) -> MentionIcon? {
        switch opts.webKind?(name, id) { case "website": return .website; case "git": return .git; default: return nil }
    }

    // A library mention's chip (MATH-21): its item's name now, or grey with nothing to click when the library lost it.
    static func libRun(_ name: String, _ id: String, _ opts: InlineOpts, source: String) -> InlineRun {
        if let libName = opts.libName, case .gone = libName(id) { return .gone(shown: nameShown(name), why: "No longer in the library", source: source) }
        let shown = libShown(name, id, opts.libName)
        let bin = opts.trashed?(shown, id) == true
        return .mention(MentionChip(kind: .library(id: id), name: shown, shown: shown, icon: webIcon(opts, name, id), trashed: bin, title: bin ? "In trash" : nil), source: source)
    }

    // A file mention's chip (MATH-22): the @, the file's kind glyph, its name; `folder / path` on hover.
    static func fileRun(_ tok: String, _ opts: InlineOpts) -> InlineRun {
        let f = fileMentionOf(tok)!
        let folder = opts.libName?(f.folderId) ?? .unknown
        if case .gone = folder { return .gone(shown: f.name, why: "Its folder is no longer in the library", source: tok) }
        var folderName = "folder"
        if case .name(let n) = folder, !n.isEmpty { folderName = n }
        let where_ = "\(folderName) / \(f.rel)"
        let state = opts.fileState?(f.folderId, f.rel) ?? .unknown
        let kind: String
        if case .exists(let dir) = state, dir { kind = "folder" } else { kind = fileKindOf(f.rel) }
        let gone: Bool
        if case .missing = state { gone = true } else { gone = false }
        return .mention(MentionChip(kind: .file(folderId: f.folderId, rel: f.rel), name: f.name, shown: f.name, icon: .file(kind), missing: gone, title: gone ? "Not found: \(where_)" : where_), source: tok)
    }

    // A mention by name, `@[Name]` (MATH-60): a chat's shows its word, Bart's blue, a gone chat grey; a name nothing goes by
    // grey; an address the library holds no page for still opens the page.
    static func nameRun(_ name: String, _ opts: InlineOpts, source: String) -> InlineRun {
        let chat = chatMention(name)
        if let chat, !chat.live { return .gone(shown: chat.shown, why: "This chat is gone", source: source) }
        let address = chat == nil && WebName.isAddress(name)
        if address, opts.named?(name) == false {
            return .mention(MentionChip(kind: .url(name), name: name, shown: WebName.webLabel(name), icon: .website, title: name), source: source)
        }
        if chat == nil, opts.named?(name) == false { return .gone(shown: name, why: "Not in the library", source: source) }
        let bin = chat == nil && opts.trashed?(name, nil) == true
        let icon: MentionIcon? = chat != nil ? nil : address ? (webIcon(opts, name, nil) ?? .website) : webIcon(opts, name, nil)
        return .mention(MentionChip(kind: chat != nil ? .chat : .name(name), name: name, shown: chat?.shown ?? nameShown(name), icon: icon, trashed: bin, title: bin ? "In trash" : nil), source: source)
    }

    /// Text as typed with only its math drawn (a brainstorm card's strings): everything else plain, `\$` a dollar.
    public static func textMathRuns(_ text: String?) -> [InlineRun] {
        INLINE.split(text ?? "").compactMap { tok in
            if tok.isEmpty { return nil }
            if tok == "\\$" { return .text("$", source: tok) }
            if let m = mathOf(tok) {
                if let shown = MathText.render(m.tex, display: m.display) { return .math(tex: m.tex, display: m.display, shown: shown, source: tok) }
                return .mathError(tok)
            }
            return .text(tok, source: tok)
        }
    }

    // MARK: PDF margin notes (MATH-21): text as typed, only library mentions drawn; a leading @bart a label with `agents`.

    static let LIB_SPLIT = Rx(#"(@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%/-]+)?\))"#)
    public static let NOTE_AGENT = Rx(#"^(\s*)(@bart)(?=\s|$)"#, "i")

    public static func noteParts(_ text: String?, agents: Bool = false) -> [String] {
        let s = text ?? ""
        guard agents, let lead = NOTE_AGENT.match(s) else { return LIB_SPLIT.tokens(s) }
        return ([lead[1]!, lead[2]!] + LIB_SPLIT.split(s.slice(lead.str.len))).filter { !$0.isEmpty }
    }

    /// Where in a note's text a click lands: `offset` characters into its `part`-th piece; a mention's piece is passed whole.
    public static func noteOffset(_ text: String?, _ part: Int, _ offset: Int, agents: Bool = false) -> Int {
        let parts = noteParts(text, agents: agents)
        var at = 0
        for i in 0..<min(part, parts.count) { at += parts[i].len }
        if part >= parts.count { return at }
        let p = parts[part]
        return at + (LIB_MENTION.test(p) || FILE_MENTION.test(p) ? p.len : max(0, min(p.len, offset)))
    }

    /// A margin note as shown while it is not being edited: text, each library mention a chip, a leading @bart a label.
    public static func noteRuns(_ text: String?, _ opts: InlineOpts? = nil, agents: Bool = false) -> [InlineRun] {
        let o = opts ?? InlineOpts()
        let lead = agents ? NOTE_AGENT.match(text ?? "") : nil
        let at = lead == nil ? -1 : ((lead![1] ?? "").isEmpty ? 0 : 1)
        return noteParts(text, agents: agents).enumerated().map { i, p in
            if i == at { return .agent(p) }
            if FILE_MENTION.test(p) { return fileRun(p, o) }
            if let lib = LIB_MENTION.match(p) { var oo = o; oo.trashed = nil; return libRun(lib[1]!, lib[2]!, oo, source: p) }
            return .text(p, source: p)
        }
    }
}

/// What a lookup can say about a name or an id: it cannot tell, the thing is gone, or its name now.
public enum NameNow: Equatable, Sendable { case unknown, gone, name(String) }
/// What a lookup says of a file in a library folder.
public enum FileState: Equatable, Sendable { case unknown, missing, exists(dir: Bool) }

/// inlineHtml's `opts`.
public struct InlineOpts {
    /// A library mention's name now (`.gone` when the library no longer holds it).
    public var libName: ((String) -> NameNow)?
    /// False when a mention by name names nothing; nil when it cannot tell.
    public var named: ((String) -> Bool?)?
    /// True for a note in the trash (name, id).
    public var trashed: ((String, String?) -> Bool)?
    /// 'website' or 'git' for a page or repository known by its address (name, id).
    public var webKind: ((String, String?) -> String?)?
    /// A file in a library folder: missing, or there (and whether a folder).
    public var fileState: ((String, String) -> FileState)?
    /// In an answer line, its turn's question line, which a click on the hammer builds.
    public var buildTurn: Int?
    /// The answer's citation numbers (Cite.citationNumbers).
    public var cites: [String: Int]?
    /// A citation's source's name, when known.
    public var citeSource: ((String) -> String?)?
    public var citeFocus = false
    public var citeTitle = false
    public init() {}
}

public enum MentionIcon: Equatable, Sendable { case workspace, website, git, zotero, file(String) }

public struct MentionChip: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case name(String), chat, workspace(id: String), library(id: String), file(folderId: String, rel: String)
        case zotero(ref: String), made(key: String), url(String)
    }
    public var kind: Kind
    /// What `data-mention` held: the name a click resolves.
    public var name: String
    /// The text after the @.
    public var shown: String
    public var icon: MentionIcon? = nil
    public var trashed = false
    public var missing = false
    public var title: String? = nil
    public init(kind: Kind, name: String, shown: String, icon: MentionIcon? = nil, trashed: Bool = false, missing: Bool = false, title: String? = nil) {
        self.kind = kind; self.name = name; self.shown = shown; self.icon = icon; self.trashed = trashed; self.missing = missing; self.title = title
    }
}

/// One drawn piece of a line. `source` is the token it was drawn from (its markdown), for offset mapping and copying.
public indirect enum InlineRun: Equatable {
    case text(String, source: String)
    case strong([InlineRun], source: String)
    case code(String, source: String)
    case em(String, source: String)
    /// `@bart`, `@chat`, … blue, weight 500.
    case agent(String)
    case mention(MentionChip, source: String)
    /// A mention that names nothing any more: grey, nothing to click; `why` on hover.
    case gone(shown: String, why: String, source: String)
    case link(title: String, href: String, source: String)
    case math(tex: String, display: Bool, shown: String, source: String)
    /// LaTeX that cannot be drawn: its source in the inline-code look.
    case mathError(String)
    case attachment(label: String, id: String, source: String)
    case buildIcon(turn: Int?)
    case citation(Citation, n: Int, source: String)
    /// Three or more citations side by side: the first, a "…" standing for `more`, and the rest shown on hover or click.
    case citeRun(first: InlineRun, more: Int, rest: [InlineRun])

    /// The markdown this run was drawn from.
    public var source: String {
        switch self {
        case .text(_, let s), .strong(_, let s), .code(_, let s), .em(_, let s), .mention(_, let s), .gone(_, _, let s),
             .link(_, _, let s), .math(_, _, _, let s), .attachment(_, _, let s): return s
        case .agent(let s), .mathError(let s): return s
        case .buildIcon: return Doc.BUILD_TOKEN
        case .citation(let c, _, _): return "[\(c.label)](\(c.href))"
        case .citeRun(let first, _, let rest): return first.source + rest.map { $0.source }.joined()
        }
    }

    /// The text this run shows (doc.js tokShown's `shown`; a mention's icon is no text).
    public var shown: String {
        switch self {
        case .text(let t, _), .code(let t, _), .em(let t, _), .agent(let t), .mathError(let t): return t
        case .strong(let rs, _): return rs.map { $0.shown }.joined()
        case .mention(let c, _): return "@" + c.shown
        case .gone(let s, _, _): return "@" + s
        case .link(let t, _, _): return t
        case .math(_, _, let s, _): return s
        case .attachment(let l, _, _): return "[\(l)]"
        case .buildIcon, .citation: return ""
        case .citeRun: return ""
        }
    }
}
