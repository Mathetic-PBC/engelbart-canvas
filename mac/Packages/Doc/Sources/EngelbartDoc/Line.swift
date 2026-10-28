import Foundation

// Pure document model for the Obsidian-style editor (src/renderer/model/doc.js). One markdown string per document; the
// caret's line shows its source, every other line renders. Comments keep the Electron source's decisions.

public enum DocRx {
    // A checkbox line: `- [ ] text` (2026-09-20), typed as `- []` or `- [ ]`. `@Task` is gone (2026-09-29). A bare `- text`
    // is a bullet: lists are their own kind of line, nested two spaces at a time. `1. text` and `1) text` (2026-10-05) are
    // the same kind of row, numbered: the number is kept as typed and Enter writes the next one.
    public static let TODO = Rx(#"^( *)- \[([ xX]?)\](?: (.*))?$"#)
    public static let LIST = Rx(#"^( *)(?:[-*]|(\d{1,9})([.)])) (.*)$"#)
    public static let HEAD = Rx(#"^(#{1,3}) (.*)$"#)
    public static let IMG = Rx(#"^!\[([^\]]*)\]\((img:[\w-]+|https?:[^)\s]+|data:image[^)\s]+)\)$"#)
    // `@bart` is the router (2026-10-12); `@chat` asks the question-answering agent ('bart' inside the app); `@brainstorm`,
    // `@discover`, `@create`, and `@orient` (an older name for @brainstorm, 2026-10-05).
    public static let BART = Rx(#"^@(bart|chat|brainstorm|orient|discover|create)(?:\s(.*))?$"#, "i")
    // An answer under an @bart line, one prefix per line (main/bart/reply.cjs writes them): pending while the run works.
    public static let PENDING = Rx(#"^bart~> ?([\w-]*)$"#)
    // A Build (2026-09-25): the line holds its id alone; the editor draws the card from its record.
    public static let BUILD = Rx(#"^build> ([0-9a-f]{10})$"#)
    public static let DRAFT = Rx(#"^bart\?> ?(.*)$"#)
    public static let REPLY = Rx(#"^bart(\+?)> ?(.*)$"#)
    // A conversation's title (2026-10-12): `bart# ` above the question that starts a thread; `bart#+ ` collapsed.
    public static let TITLE = Rx(#"^bart#(\+?) ?(.*)$"#)
    static let TITLE_META = Rx(#"^\[(chat|brainstorm|discover|create)( build)?(?: (\d{4}-\d\d-\d\dT[\d:.]+Z?))?\](?: |$)"#)
    // The closing line of an answer: which model said it and how long it took. Drawn as the card's foot.
    public static let ATTRIBUTION = Rx(#"^\*[^*]+\*$"#)
    public static let QUOTE = Rx(#"^> ?(.*)$"#)
    public static let ATTACH = Rx(#"^!\[([^\]\n]*)\]\(img:([\w-]+)\)$"#)
    // A fenced code block (2026-09-22): three or more backticks or tildes with an optional language; only a closed fence
    // makes a block.
    public static let FENCE = Rx(#"^( {0,3})(`{3,}|~{3,})([^`]*)$"#)
    static let CLOSE = Rx(#"^ {0,3}(`{3,}|~{3,})[ \t]*$"#)
}

public enum Agent: String, Sendable { case bart, router, brainstorm, discover, create, orient }

public enum LineType: String, Sendable { case p, h, todo, list, quote, img, bart, build, pending, title, reply, fence, code }

/// Which part of a code block inside an answer a reply line is.
public enum CodeRole: String, Sendable { case open, body, close }

/// A closed fenced code block: line indexes into the document, `fence` as typed (indent included).
public struct CodeBlock: Equatable, Sendable {
    public var open: Int
    public var close: Int
    public var lang: String
    public var fence: String
    public init(open: Int, close: Int, lang: String, fence: String) { self.open = open; self.close = close; self.lang = lang; self.fence = fence }
}

/// One line read: parseLine's object in doc.js. Fields not used by a type keep their defaults.
public struct ParsedLine: Equatable, Sendable {
    public var type: LineType
    public var text: String
    public var depth: Int = 0
    public var done: Bool = false
    public var num: Int? = nil
    public var delim: String? = nil
    public var level: Int = 0
    public var src: String = ""
    public var id: String = ""
    /// For `bart` lines: nil is `@chat` (agent 'bart'); `router` is `@bart`. For titles: the agent kept in brackets.
    public var agent: String? = nil
    public var folded: Bool = false
    // title meta
    public var at: String? = nil
    public var build: Bool = false
    // code
    public var open: Bool = false
    public var lang: String = ""
    public var block: CodeBlock? = nil
    public var code: CodeRole? = nil

    public init(type: LineType, text: String) { self.type = type; self.text = text }
}

/// `titleMeta(rest)` → { text, agent, at, build }: agent 'bart' | 'brainstorm' | 'discover' | 'create' or nil.
public struct TitleMeta: Equatable, Sendable {
    public var text: String
    public var agent: String?
    public var at: String?
    public var build: Bool
    public init(text: String, agent: String? = nil, at: String? = nil, build: Bool = false) { self.text = text; self.agent = agent; self.at = at; self.build = build }
}

public enum Doc {
    public static let UNSET_TOPIC = "New conversation"
    public static let BUILD_TOKEN = "[[build]]"
    public static let RESEARCH_FLAG = "--research"
    public static let REFINE_FLAG = "--refine"

    public static func buildLine(_ id: String) -> String { "build> \(id)" }

    public static func titleMeta(_ rest: String?) -> TitleMeta {
        let s = rest ?? ""
        guard let m = DocRx.TITLE_META.match(s) else { return TitleMeta(text: s) }
        return TitleMeta(text: s.slice(m.str.len), agent: m[1] == "chat" ? "bart" : m[1], at: (m[3]?.isEmpty ?? true) ? nil : m[3], build: m[2] != nil)
    }

    /// A title line: its text, collapsed or not, and `meta` kept in brackets.
    public static func titleLine(_ text: String, folded: Bool, meta: TitleMeta? = nil) -> String {
        var tag = ""
        if let meta, let a = meta.agent, !a.isEmpty {
            let agent = a == "bart" ? "chat" : a
            tag = "[\(agent)\(meta.build ? " build" : "")\(meta.at.map { " \($0)" } ?? "")] "
        }
        return "bart#\(folded ? "+" : "") \(tag)\(text)"
    }

    static func depthOf(_ indent: String) -> Int { min(8, indent.len / 2) }

    public static func parseLine(_ l: String) -> ParsedLine {
        if let m = DocRx.BART.match(l) {
            let agent = (m[1] ?? "").lowercased()
            var p = ParsedLine(type: .bart, text: m[2] ?? "")
            if agent != "chat" { p.agent = agent == "bart" ? "router" : agent }
            return p
        }
        if let m = DocRx.BUILD.match(l) { var p = ParsedLine(type: .build, text: ""); p.id = m[1]!; return p }
        if let m = DocRx.PENDING.match(l) { var p = ParsedLine(type: .pending, text: ""); p.id = m[1] ?? ""; return p }
        if let m = DocRx.TITLE.match(l) {
            let meta = titleMeta(m[2])
            var p = ParsedLine(type: .title, text: meta.text)
            p.agent = meta.agent; p.at = meta.at; p.build = meta.build; p.folded = m[1] == "+"
            return p
        }
        if let m = DocRx.DRAFT.match(l) { return ParsedLine(type: .reply, text: m[1] ?? "") }
        if let m = DocRx.REPLY.match(l) { var p = ParsedLine(type: .reply, text: m[2] ?? ""); p.folded = m[1] == "+"; return p }
        if let m = DocRx.QUOTE.match(l) { return ParsedLine(type: .quote, text: m[1] ?? "") }
        if let m = DocRx.IMG.match(l) { var p = ParsedLine(type: .img, text: m[1] ?? ""); p.src = m[2] ?? ""; return p }
        if let m = DocRx.TODO.match(l) {
            var p = ParsedLine(type: .todo, text: m[3] ?? "")
            p.depth = depthOf(m[1] ?? ""); let mark = m[2] ?? ""; p.done = !mark.isEmpty && mark != " "
            return p
        }
        if let m = DocRx.LIST.match(l) {
            var p = ParsedLine(type: .list, text: m[4] ?? "")
            p.depth = depthOf(m[1] ?? "")
            if let n = m[2], !n.isEmpty { p.num = Int(n); p.delim = m[3] }
            return p
        }
        if let m = DocRx.HEAD.match(l) { var p = ParsedLine(type: .h, text: m[2] ?? ""); p.level = (m[1] ?? "").len; return p }
        return ParsedLine(type: .p, text: l)
    }

    /// The closed code blocks of a document, in order.
    public static func codeBlocks(_ lines: [String]) -> [CodeBlock] {
        var out: [CodeBlock] = []
        var i = 0
        while i < lines.count {
            defer { i += 1 }
            guard let m = DocRx.FENCE.match(lines[i]) else { continue }
            let mark = m[2]!
            var j = i + 1
            while j < lines.count {
                if let c = DocRx.CLOSE.match(lines[j]), let cm = c[1], cm.first == mark.first, cm.len >= mark.len {
                    let lang = (m[3] ?? "").trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
                    out.append(CodeBlock(open: i, close: j, lang: lang, fence: (m[1] ?? "") + mark))
                    i = j
                    break
                }
                j += 1
            }
        }
        return out
    }

    /// Every line of a document read in place: parseLine's reading, except that the lines of a code block are `fence` and
    /// `code`; an answer's own code blocks stay `reply` and carry `code`. A title without a question under it is text.
    public static func parseLines(_ lines: [String]) -> [ParsedLine] {
        var ps = lines.map { parseLine($0) }
        for block in codeBlocks(lines) {
            var o = ParsedLine(type: .fence, text: lines[block.open]); o.open = true; o.lang = block.lang; o.block = block
            ps[block.open] = o
            if block.open + 1 < block.close {
                for i in (block.open + 1)..<block.close { var c = ParsedLine(type: .code, text: lines[i]); c.lang = block.lang; c.block = block; ps[i] = c }
            }
            var c = ParsedLine(type: .fence, text: lines[block.close]); c.open = false; c.lang = block.lang; c.block = block
            ps[block.close] = c
        }
        var i = 0
        while i < ps.count {
            if ps[i].type != .reply { i += 1; continue }
            var j = i
            while j + 1 < ps.count && ps[j + 1].type == .reply { j += 1 }
            for found in codeBlocks(ps[i...j].map { $0.text }) {
                let block = CodeBlock(open: i + found.open, close: i + found.close, lang: found.lang, fence: found.fence)
                for k in block.open...block.close {
                    ps[k].code = k == block.open ? .open : k == block.close ? .close : .body
                    ps[k].open = k == block.open
                    ps[k].lang = block.lang
                    ps[k].block = block
                }
            }
            i = j + 1
        }
        for i in ps.indices where ps[i].type == .title && (i + 1 >= ps.count || ps[i + 1].type != .bart) {
            ps[i] = ParsedLine(type: .p, text: lines[i])
        }
        return ps
    }

    public static func isFence(_ p: ParsedLine?) -> Bool { guard let p else { return false }; return p.type == .fence || p.code == .open || p.code == .close }
    public static func isCode(_ p: ParsedLine?) -> Bool { guard let p else { return false }; return p.type == .code || p.code == .body }

    /// What an opening fence shows while the caret is elsewhere: the language, or nothing.
    public static func fenceShown(_ p: ParsedLine) -> String {
        guard p.open, let block = p.block else { return "" }
        return p.text.slice(block.fence.len).trimStart
    }

    /// Lines that stand under an @bart question.
    public static func isAnswer(_ type: LineType) -> Bool { type == .quote || type == .reply || type == .pending }

    public static func todoLine(_ depth: Int, _ done: Bool, _ text: String) -> String { "  ".repeated(depth) + "- [\(done ? "x" : " ")] \(text)" }
    /// A bullet, or with `num` (and `delim`) a numbered row.
    public static func listLine(_ depth: Int, _ text: String, _ num: Int? = nil, _ delim: String? = ".") -> String {
        "  ".repeated(depth) + (num.map { "\($0)\(delim ?? ".")" } ?? "-") + " " + text
    }
    /// What a list row draws in front of its text: `•`, or its number as typed.
    public static func listMark(_ p: ParsedLine) -> String { p.num.map { "\($0)\(p.delim ?? ".")" } ?? "\u{2022}" }
    // No trimming: a space typed at the end of an answer line has to survive the round trip.
    public static func replyLine(_ text: String, _ folded: Bool) -> String { "bart\(folded ? "+" : "")> \(text)" }

    /// Rows of a list: a checkbox or a bullet. They nest, Enter continues them, an empty one steps out.
    public static func isMarked(_ type: LineType) -> Bool { type == .todo || type == .list }
    /// Lines whose prefix is drawn, not typed.
    public static func isDrawn(_ type: LineType) -> Bool { isMarked(type) || type == .reply }
    /// The text the caret moves through on a line.
    public static func lineText(_ p: ParsedLine, _ line: String) -> String { isDrawn(p.type) ? p.text : line }
    /// That line again with different text, keeping its kind.
    public static func sameLine(_ p: ParsedLine, _ text: String) -> String {
        switch p.type {
        case .todo: return todoLine(p.depth, p.done, text)
        case .list: return listLine(p.depth, text, p.num, p.delim)
        case .reply: return replyLine(text, p.folded)
        default: return text
        }
    }
    /// How a line the person just typed is stored: `- []` and `* x` become the line they make.
    public static func canonicalLine(_ l: String) -> String { let p = parseLine(l); return isMarked(p.type) ? sameLine(p, p.text) : l }

    /// A marker typed into a row that already draws one: the row takes that marker. nil when nothing was typed but text.
    public static func retypedRow(_ p: ParsedLine, _ txt: String) -> (line: String, ate: Int)? {
        if let task = Rx(#"^- \[([ xX]?)\](?: |$)"#).match(txt) {
            let mark = (task[1] ?? "").isEmpty ? " " : task[1]!
            return (todoLine(p.depth, mark != " ", txt.slice(task.str.len)), task.str.len)
        }
        if let bullet = Rx(#"^[-*] "#).match(txt) { return (listLine(p.depth, txt.slice(bullet.str.len)), bullet.str.len) }
        if let n = Rx(#"^(\d{1,9})([.)]) "#).match(txt) { return (listLine(p.depth, txt.slice(n.str.len), Int(n[1]!), n[2]), n.str.len) }
        return nil
    }

    /// `text` with ask `askId`'s pending line replaced by `lines`; nil when the pending line is gone.
    public static func placeAnswer(_ text: String, _ askId: String, _ lines: [String]) -> String? {
        var all = text.jsSplit("\n")
        guard let at = all.firstIndex(of: "bart~> \(askId)") else { return nil }
        all.replaceSubrange(at...at, with: lines)
        return all.joined(separator: "\n")
    }

    /// Text pasted into a question line, as one line (2026-10-02).
    public static func flattenPaste(_ text: String?) -> String { Rx(#"\s*[\r\n]\s*"#).replace(text ?? "", with: " ").trimmed }

    /// Text split into lines as the editor holds them.
    public static func lines(_ text: String) -> [String] { text.jsSplit("\n") }
}
