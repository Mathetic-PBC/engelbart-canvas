import AppKit
import EngelbartDoc
import EngelbartUI

// The document drawn (DocEditor.jsx lineHtml and everything it calls), as one attributed string for an NSTextView: one
// paragraph a source line, so line i of the document is paragraph i of the text view. The caret's line shows its source
// (tokens the caret touches open), every other line its drawing. What HTML drew as boxes is drawn by DocLayoutManager from
// the attributes below (cards, rules, checkboxes, bullets, pills, icons); what was a control (a button row, a chip, a
// reply field, a running row, a Build's card) is an overlay view the editor places on the line's rect (`decos`).

extension NSAttributedString.Key {
    /// CardPaint: the grey card a line is drawn on, its rule, its corners.
    public static let edCard = NSAttributedString.Key("engelbart.card")
    /// MarkPaint: a row's checkbox, bullet or number, drawn in its indent.
    public static let edMark = NSAttributedString.Key("engelbart.mark")
    /// The line is in the document, not on the page (zero height).
    public static let edHidden = NSAttributedString.Key("engelbart.hidden")
    /// PillPaint: inline code's or an attachment chip's rounded box.
    public static let edPill = NSAttributedString.Key("engelbart.pill")
    /// MentionIcon drawn in the kern after an `@`.
    public static let edIcon = NSAttributedString.Key("engelbart.icon")
    /// EditorAction: what a click on these characters does.
    public static let edAction = NSAttributedString.Key("engelbart.action")
    /// The source line a paragraph draws.
    public static let edLine = NSAttributedString.Key("engelbart.line")
}

/// What a click on drawn characters does.
public enum EditorAction: Equatable {
    case link(String)
    case mention(MentionChip)
    case citation(Citation)
    case citeMore
    case attachment(String)
    case build(Int)
    case toggle(Int)
}
final class ActionBox: NSObject { let action: EditorAction; init(_ a: EditorAction) { action = a } }

final class CardPaint: NSObject {
    var fill: NSColor
    var top: Bool
    var bottom: Bool
    var ruleX: CGFloat?
    var ruleColor: NSColor
    var ruleWidth: CGFloat
    var ruleTop: CGFloat
    var ruleBottom: CGFloat
    var marginBottom: CGFloat
    var border: NSColor?
    var radius: CGFloat
    init(fill: NSColor = Palette.panel2, top: Bool = false, bottom: Bool = false, ruleX: CGFloat? = nil, ruleColor: NSColor = NSColor(hex: "#d6d6d6"), ruleWidth: CGFloat = 2, ruleTop: CGFloat = 0, ruleBottom: CGFloat = 0, marginBottom: CGFloat = 0, border: NSColor? = nil, radius: CGFloat = 10) {
        self.fill = fill; self.top = top; self.bottom = bottom; self.ruleX = ruleX; self.ruleColor = ruleColor; self.ruleWidth = ruleWidth
        self.ruleTop = ruleTop; self.ruleBottom = ruleBottom; self.marginBottom = marginBottom; self.border = border; self.radius = radius
    }
}
final class MarkPaint: NSObject {
    enum Kind { case checkbox(Bool), bullet, number(String) }
    var kind: Kind
    var x: CGFloat
    var width: CGFloat
    init(_ kind: Kind, x: CGFloat, width: CGFloat) { self.kind = kind; self.x = x; self.width = width }
}
final class PillPaint: NSObject {
    var fill: NSColor; var border: NSColor?
    init(fill: NSColor, border: NSColor? = nil) { self.fill = fill; self.border = border }
}
final class IconPaint: NSObject {
    let icon: MentionIcon; let size: CGFloat
    init(_ icon: MentionIcon, size: CGFloat) { self.icon = icon; self.size = size }
}

/// A control drawn over a line (an overlay the editor places): what it is and how much room it takes.
public enum Deco: Equatable {
    /// A todo's box (a click toggles it).
    case checkbox(done: Bool)
    /// An unasked question's chip (model and effort, or a Discover level) and its round send.
    case chip(label: String?, ready: Bool)
    /// An answered question's Collapse in its corner.
    case corner(q: Int, whole: Bool, label: String)
    /// A turn's foot: Copy, Regenerate, Delete.
    case foot(q: Int, busy: Bool, plain: Bool)
    /// A run at work: what it is doing, its answer so far, Stop.
    case pending(id: String)
    /// A collapsed conversation's row: its title, when it was asked.
    case titleRow(title: String, when: String, running: Bool)
    /// A turn folded to one row.
    case foldedRow(q: Int, shown: String)
    /// A Build's card (the host's view).
    case build(id: String)
    /// A code block's Copy.
    case copyCode
    /// The conversation's reply field under its last turn.
    case replyField(from: Int, lead: String)
    /// A research box's head and status.
    case research(state: String, label: String)
}

public struct Decoration: Equatable {
    public var line: Int
    public var deco: Deco
    /// Whole: the overlay is the line's row; else it sits under the line's text, in its paragraph spacing.
    public var whole: Bool
    public var height: CGFloat
}

public struct Rendered {
    public var text: NSAttributedString
    public var maps: [LineMap]
    public var decos: [Decoration]
}

/// What the renderer asks the outside while it draws.
public struct RenderContext {
    public var opts = InlineOpts()
    /// A pasted picture's file (img:<id>), or nil while it is unknown.
    public var image: (String) -> NSImage? = { _ in nil }
    /// A picture on the web, once loaded.
    public var webImage: (String) -> NSImage? = { _ in nil }
    public var canReply = false
    public var hasRouter = false
    /// The caret's range on the active line (lineText offsets), for which tokens open.
    public var reveal: (Int, Int) = (-1, -1)
    /// The caret was put there by the mouse: an answer's links stay drawn.
    public var byMouse = false
    /// Widths and heights of rows the editor measures (a pending row's, a Build card's, a reply field's).
    public var rowHeight: (Deco) -> CGFloat = { _ in 44 }
    /// The width the column has for text.
    public var columnWidth: CGFloat = 620
    /// Lines whose mention is open beside (MATH-23): marked blue-grey.
    public var beside: (MentionChip) -> Bool = { _ in false }
    public init() {}
}

public enum Look {
    public static let body: CGFloat = 17
    public static let lineHeight: CGFloat = 1.6
    public static let ink = NSColor(hex: "#171717")
    public static let answerInk = NSColor(hex: "#262626")
    public static let grey = NSColor(hex: "#8f8f8f")
    public static let mid = NSColor(hex: "#4d4d4d")
    public static let faint = NSColor(hex: "#b5b5b5")
    public static let blue = NSColor(hex: "#0070f3")
    public static let card = NSColor(hex: "#fafafa")
    public static let flash = NSColor(hex: "#fff1b8")
    public static let rule = NSColor(hex: "#d6d6d6")
    public static let quoteRule = NSColor(hex: "#dcdcdc")
    public static let codeFill = NSColor(hex: "#f2f2f2")
    /// The page's column: 65ch at most of the document's type (DocEditor DOC_COLUMN).
    public static func column(for width: CGFloat) -> CGFloat {
        let ch = ("0" as NSString).size(withAttributes: [.font: Fonts.sans(body)]).width
        let padding = min(max(12, width * 0.04), 40) * 2
        let inner = width - padding
        return max(120, min(65 * ch, inner - 2 * min(max(0, inner * 0.03), 24)))
    }
    static func math(_ size: CGFloat) -> NSFont {
        NSFont(name: "STIXTwoMath-Regular", size: size) ?? NSFont(name: "Times New Roman Italic", size: size * 1.05) ?? NSFont.systemFont(ofSize: size)
    }
}

final class Renderer {
    let core: EditorCore
    let ctx: RenderContext
    let at: [Int: LineAt]
    let out = NSMutableAttributedString()
    var maps: [LineMap] = []
    var decos: [Decoration] = []

    init(core: EditorCore, ctx: RenderContext) {
        self.core = core; self.ctx = ctx
        at = core.layout(canReply: ctx.canReply)
    }

    static func render(_ core: EditorCore, _ ctx: RenderContext) -> Rendered {
        let r = Renderer(core: core, ctx: ctx)
        r.run()
        return Rendered(text: r.out, maps: r.maps, decos: r.decos)
    }

    // MARK: paragraphs

    static func para(size: CGFloat, height: CGFloat = 1.6, before: CGFloat = 0, after: CGFloat = 0, head: CGFloat = 0, first: CGFloat? = nil, tail: CGFloat = 0, minHeight: CGFloat? = nil, align: NSTextAlignment = .natural) -> NSMutableParagraphStyle {
        let p = NSMutableParagraphStyle()
        let lh = (size * height).rounded()
        p.minimumLineHeight = max(lh, minHeight ?? 0)
        p.maximumLineHeight = max(lh, minHeight ?? 0)
        p.paragraphSpacingBefore = before
        p.paragraphSpacing = after
        p.headIndent = head
        p.firstLineHeadIndent = first ?? head
        p.tailIndent = tail == 0 ? 0 : -tail
        p.alignment = align
        p.lineBreakMode = .byWordWrapping
        return p
    }
    static func baseline(_ font: NSFont, _ lineHeight: CGFloat) -> CGFloat {
        max(0, (lineHeight - (font.ascender - font.descender)) / 2)
    }

    func attrs(_ font: NSFont, _ color: NSColor, _ para: NSParagraphStyle, line: Int) -> [NSAttributedString.Key: Any] {
        [.font: font, .foregroundColor: color, .paragraphStyle: para, .edLine: line, .baselineOffset: Renderer.baseline(font, para.minimumLineHeight)]
    }

    /// Append one line's paragraph (its text, its newline unless it is the last line), recording its map.
    func emit(_ i: Int, _ body: NSAttributedString, segs: [Seg], base: Int = 0, para: NSParagraphStyle, extra: [NSAttributedString.Key: Any] = [:], widget: Bool = false, fenceEnd: Int? = nil, last: Bool) {
        let start = out.length
        let line = NSMutableAttributedString(attributedString: body)
        if line.length > 0 {
            line.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: line.length))
            line.addAttribute(.edLine, value: i, range: NSRange(location: 0, length: line.length))
            for (k, v) in extra { line.addAttribute(k, value: v, range: NSRange(location: 0, length: line.length)) }
        }
        out.append(line)
        let range = NSRange(location: start, length: line.length)
        if !last {
            var nl: [NSAttributedString.Key: Any] = [.paragraphStyle: para, .edLine: i, .font: Fonts.sans(Look.body)]
            for (k, v) in extra { nl[k] = v }
            if line.length > 0, let f = line.attribute(.font, at: line.length - 1, effectiveRange: nil) { nl[.font] = f }
            out.append(NSAttributedString(string: "\n", attributes: nl))
        } else if line.length == 0 {
            // The last line empty: TextKit draws it in the extra line fragment, typed with these.
            out.append(NSAttributedString(string: "", attributes: [.paragraphStyle: para]))
        }
        maps.append(LineMap(line: i, range: range, segs: segs, base: base, widget: widget, fenceEnd: fenceEnd))
    }

    /// Room under line `i`'s text for a control drawn there (a reply field, a foot): its paragraph spacing grows, and with
    /// `closes` its card ends under the control.
    func reserve(_ i: Int, _ height: CGFloat, closes: Bool) {
        guard let map = maps.last, map.line == i else { return }
        let len = map.range.length + (NSMaxRange(map.range) < out.length ? 1 : 0)
        guard len > 0 else { return }
        let range = NSRange(location: map.range.location, length: len)
        let old = (out.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle) ?? NSParagraphStyle.default
        let p = old.mutableCopy() as! NSMutableParagraphStyle
        p.paragraphSpacing += height + (closes ? 8 : 0)
        out.addAttribute(.paragraphStyle, value: p, range: range)
        if closes, let card = out.attribute(.edCard, at: range.location, effectiveRange: nil) as? CardPaint {
            card.bottom = true; card.marginBottom = 8
        }
    }

    func hidden(_ i: Int, last: Bool) {
        let p = Renderer.para(size: 1, height: 1)
        p.minimumLineHeight = 0.01; p.maximumLineHeight = 0.01
        emit(i, NSAttributedString(string: ""), segs: [], para: p, extra: [.edHidden: true], widget: true, last: last)
    }

    func widget(_ i: Int, _ deco: Deco, height: CGFloat, card: CardPaint? = nil, last: Bool) {
        let p = Renderer.para(size: 1, height: 1, minHeight: height)
        var extra: [NSAttributedString.Key: Any] = [:]
        if let card { extra[.edCard] = card }
        emit(i, NSAttributedString(string: ""), segs: [], para: p, extra: extra, widget: true, last: last)
        decos.append(Decoration(line: i, deco: deco, whole: true, height: height))
    }

    // MARK: the run

    func run() {
        let ls = core.lines, ps = core.parsed(ls)
        let active = core.activeLine
        for (i, line) in ls.enumerated() {
            let last = i == ls.count - 1
            let p = ps[i], where_ = at[i]
            let locked = core.lockedAt(ls, i)
            let isActive = active == i && !locked
            if let w = where_ {
                if w.role == .hidden { hidden(i, last: last); continue }
                if w.role == .title {
                    if !w.collapsed { hidden(i, last: last); continue }
                    let thread = core.threads(ls).first { $0.titleLine == i }
                    let title = p.text.trimmed
                    let shown = !title.isEmpty ? title : thread.flatMap { $0.turns.first }.map { Route.questionLine(Doc.turnText(ls, $0).question, max: 60) } ?? "Chat"
                    widget(i, .titleRow(title: shown, when: thread.map { Doc.whenShown($0.at) } ?? "", running: w.running), height: 42 + 8, last: last)
                    continue
                }
            }
            switch p.type {
            case .build: widget(i, .build(id: p.id), height: ctx.rowHeight(.build(id: p.id)), last: last)
            case .code, .fence:
                if p.code != nil { answerCode(i, line, p, where_, last: last) } else { code(i, line, p, isActive, last: last) }
            case .todo, .list: row(i, line, p, isActive, last: last)
            case .h: heading(i, line, p, isActive, ls: ls, last: last)
            case .bart: question(i, line, p, isActive && !locked, where_, last: last)
            case .pending: pending(i, p, where_, last: last)
            case .reply: reply(i, line, p, where_, ls: ls, last: last)
            case .quote: quote(i, line, p, isActive, ls: ls, last: last)
            case .img: image(i, line, p, last: last)
            case .title: paragraph(i, line, p, isActive, last: last)
            case .p: paragraph(i, line, p, isActive, last: last)
            }
            if let w = where_, w.fieldAfter, let thread = core.threads(ls).first(where: { $0.from == w.threadFrom }) {
                let lead = ctx.hasRouter ? "@bart" : "@\(Doc.tokenOf(Doc.answeredBy(thread)))"
                let deco = Deco.replyField(from: thread.from, lead: lead)
                let h = ctx.rowHeight(deco)
                decos.append(Decoration(line: i, deco: deco, whole: false, height: h))
                reserve(i, h, closes: true)
            }
            if let w = where_, w.footAfter, !w.foldedTurn {
                let deco = Deco.foot(q: w.turnQ, busy: w.running, plain: EditorCore.oneModel(w.agent))
                decos.append(Decoration(line: i, deco: deco, whole: false, height: 50))
                reserve(i, 50, closes: !w.fieldAfter)
            }
        }
    }

    // MARK: inline drawing

    struct InlineLook {
        var size: CGFloat = Look.body
        var color: NSColor = Look.ink
        var weight = 400
        var boldInk: NSColor? = nil
    }

    /// The drawn runs of a token list, each recorded as a piece of the line's map.
    func drawRuns(_ runs: [InlineRun], look: InlineLook, into s: NSMutableAttributedString, segs: inout [Seg]) {
        for r in runs { drawRun(r, look: look, into: s, segs: &segs) }
    }

    func font(_ look: InlineLook, weight: Int? = nil, italic: Bool = false) -> NSFont {
        let f = Fonts.sans(look.size, weight: weight ?? look.weight)
        return italic ? NSFontManager.shared.convert(f, toHaveTrait: .italicFontMask) : f
    }

    func drawRun(_ r: InlineRun, look: InlineLook, into s: NSMutableAttributedString, segs: inout [Seg]) {
        let start = s.length
        func add(_ text: String, _ a: [NSAttributedString.Key: Any]) { s.append(NSAttributedString(string: text, attributes: a)) }
        let base: [NSAttributedString.Key: Any] = [.font: font(look), .foregroundColor: look.color]
        let t = Inline.tokShown(r.source, ctx.opts)
        switch r {
        case .text(let text, _):
            add(text, base)
            segs.append(Seg(dLen: text.len, src: r.source, open: t.pre == 0, unit: t.unit, pre: t.pre))
            return
        case .strong(let inner, _):
            var l = look; l.weight = 600; if let ink = look.boldInk { l.color = ink }
            var innerSegs: [Seg] = []
            drawRuns(inner, look: l, into: s, segs: &innerSegs)
            segs.append(Seg(dLen: s.length - start, src: r.source, open: false, pre: 2))
            return
        case .code(let text, _):
            add(text, [.font: Fonts.mono(look.size * 0.92), .foregroundColor: look.color, .edPill: PillPaint(fill: Look.codeFill)])
        case .em(let text, _):
            add(text, [.font: font(look, italic: true), .foregroundColor: look.color])
        case .agent(let text):
            add(text, [.font: Fonts.sans(look.size, weight: 500), .foregroundColor: Look.blue])
            segs.append(Seg(dLen: text.len, src: r.source, open: true))
            return
        case .mention(let chip, _):
            let grey = chip.trashed || chip.missing
            var a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(look.size, weight: 500), .foregroundColor: grey ? Look.grey : Look.blue,
                                                    .underlineStyle: NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDot.rawValue,
                                                    .underlineColor: NSColor(hex: grey ? "#d9d9d9" : "#c9c9c9"), .edAction: ActionBox(.mention(chip)), .cursor: NSCursor.pointingHand]
            if chip.missing { a[.strikethroughStyle] = NSUnderlineStyle.single.rawValue; a[.strikethroughColor] = NSColor(hex: "#c9c9c9") }
            if ctx.beside(chip) { a[.backgroundColor] = NSColor(hex: "#e8f0fe") }
            if let title = chip.title { a[.toolTip] = title }
            var at = a
            if let icon = chip.icon { at[.kern] = look.size * 1.1; at[.edIcon] = IconPaint(icon, size: look.size) }
            add("@", at)
            add(chip.shown, a)
        case .gone(let shown, let why, _):
            add("@" + shown, [.font: font(look), .foregroundColor: Look.grey, .toolTip: why])
        case .link(let title, let href, _):
            add(title, [.font: font(look), .foregroundColor: Look.blue, .underlineStyle: NSUnderlineStyle.single.rawValue, .edAction: ActionBox(.link(href)), .cursor: NSCursor.pointingHand])
        case .math(_, let display, let shown, _):
            var a: [NSAttributedString.Key: Any] = [.font: Look.math(look.size * (display ? 1.2 : 1.05)), .foregroundColor: look.color]
            if display { let p = NSMutableParagraphStyle(); p.alignment = .center; a[.paragraphStyle] = p }
            add(shown, a)
        case .mathError(let src):
            add(src, [.font: Fonts.mono(look.size * 0.92), .foregroundColor: look.color, .edPill: PillPaint(fill: Look.codeFill)])
        case .attachment(let label, let id, _):
            add("[\(label)]", [.font: Fonts.mono(look.size * 0.86), .foregroundColor: Look.mid, .edPill: PillPaint(fill: Look.codeFill, border: NSColor(hex: "#eaeaea")), .edAction: ActionBox(.attachment(id))])
        case .buildIcon(let turn):
            let a = NSTextAttachment()
            a.image = Glyphs.image(Glyphs.hammer, size: 14, color: Look.mid)
            a.bounds = CGRect(x: 0, y: -2, width: 14, height: 14)
            let str = NSMutableAttributedString(attachment: a)
            if let turn { str.addAttributes([.edAction: ActionBox(.build(turn)), .cursor: NSCursor.pointingHand, .toolTip: "Build"], range: NSRange(location: 0, length: str.length)) }
            s.append(str)
        case .citation(let c, let n, _):
            let a = NSTextAttachment()
            a.image = Glyphs.citeCircle(String(n), counter: c.counter)
            a.bounds = CGRect(x: 0, y: -3, width: a.image!.size.width, height: 16)
            let str = NSMutableAttributedString(attachment: a)
            str.addAttributes([.edAction: ActionBox(.citation(c)), .cursor: NSCursor.pointingHand], range: NSRange(location: 0, length: str.length))
            s.append(str)
        case .citeRun(let first, let more, let rest):
            drawRun(first, look: look, into: s, segs: &segs)
            // The "…" circle stands for the rest until the run is opened (a click on it opens every circle).
            let a = NSTextAttachment()
            a.image = Glyphs.citeCircle("…", counter: false, faint: true)
            a.bounds = CGRect(x: 0, y: -3, width: a.image!.size.width, height: 16)
            let str = NSMutableAttributedString(attachment: a)
            str.addAttributes([.edAction: ActionBox(.citeMore), .toolTip: "\(more) more"], range: NSRange(location: 0, length: str.length))
            s.append(str)
            segs.append(Seg(dLen: str.length, src: "", open: false, unit: true))
            var restSegs: [Seg] = []
            drawRuns(rest, look: look, into: s, segs: &restSegs)
            segs.append(contentsOf: restSegs)
            return
        }
        segs.append(Seg(dLen: s.length - start, src: r.source, open: t.pre == 0 && !t.unit, unit: t.unit || r.isUnitDrawing, pre: t.pre))
    }

    /// The active line's tokens: open ones as typed, closed ones drawn (DocEditor activeHtml/openIdx).
    func activeTokens(_ tokens: [String], look: InlineLook, flags: Set<Int> = [], marker: NSColor? = nil, shut: Bool = false, into s: NSMutableAttributedString, segs: inout [Seg]) {
        let (a, b) = ctx.reveal
        var acc = 0
        for (k, tok) in tokens.enumerated() {
            let end = acc + tok.len
            let t = Inline.tokShown(tok, ctx.opts)
            let pre = t.pre > 0 && !DocRx.ATTACH.test(tok)
            let touched = tok.hasPrefix("@[") ? a < end && b > acc : a <= end && b >= acc
            let open = !pre || (touched && !(shut && (Inline.holdsLink(tok) || tok == Doc.BUILD_TOKEN)))
            acc = end
            if marker != nil && k == 0 {
                s.append(NSAttributedString(string: tok, attributes: [.font: font(look), .foregroundColor: marker!]))
                segs.append(.text(tok)); continue
            }
            if flags.contains(k) {
                s.append(NSAttributedString(string: tok, attributes: [.font: font(look, weight: 500), .foregroundColor: look.color]))
                segs.append(.text(tok)); continue
            }
            if open && !Inline.AGENT_TOKEN.test(tok) {
                s.append(NSAttributedString(string: tok, attributes: [.font: font(look), .foregroundColor: look.color]))
                segs.append(.text(tok)); continue
            }
            let before = s.length
            var inner: [Seg] = []
            drawRuns(Inline.runs(tok, ctx.opts), look: look, into: s, segs: &inner)
            let dl = s.length - before
            segs.append(Seg(dLen: dl, src: tok, open: Inline.AGENT_TOKEN.test(tok), unit: t.unit || inner.contains { $0.unit }, pre: t.pre))
        }
    }

    // MARK: kinds of line

    func paragraph(_ i: Int, _ line: String, _ p: ParsedLine, _ active: Bool, last: Bool) {
        let look = InlineLook()
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        if active { activeTokens(Inline.tokensOf(p, line), look: look, into: s, segs: &segs) }
        else { drawRuns(Inline.runs(line, ctx.opts), look: look, into: s, segs: &segs) }
        apply(s, look)
        let para = Renderer.para(size: Look.body, before: 4, after: 4)
        emit(i, s, segs: segs, para: para, last: last)
    }

    func apply(_ s: NSMutableAttributedString, _ look: InlineLook) {
        let lh = (look.size * Look.lineHeight).rounded()
        s.enumerateAttribute(.font, in: NSRange(location: 0, length: s.length)) { v, r, _ in
            if let f = v as? NSFont, s.attribute(.attachment, at: r.location, effectiveRange: nil) == nil { s.addAttribute(.baselineOffset, value: Renderer.baseline(f, lh), range: r) }
        }
    }

    func heading(_ i: Int, _ line: String, _ p: ParsedLine, _ active: Bool, ls: [String], last: Bool) {
        let size: CGFloat = [26, 22, 18][max(0, min(2, p.level - 1))]
        var look = InlineLook(); look.size = size; look.weight = 500
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        var base = 0
        if active { activeTokens(Inline.tokensOf(p, line), look: look, into: s, segs: &segs) }
        else { base = p.level + 1; drawRuns(Inline.runs(p.text, ctx.opts), look: look, into: s, segs: &segs) }
        s.addAttribute(.kern, value: -0.3, range: NSRange(location: 0, length: s.length))
        apply(s, look)
        // Right under a card it has room above its text to click in (gapAt).
        let underCard = i > 0 && (at[i - 1].map { $0.closes || $0.role == .foot } ?? false)
        emit(i, s, segs: segs, base: base, para: Renderer.para(size: size, before: underCard ? 12 : 4, after: 4), last: last)
    }

    func row(_ i: Int, _ line: String, _ p: ParsedLine, _ active: Bool, last: Bool) {
        var look = InlineLook()
        if p.type == .todo && p.done { look.color = Look.grey }
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        if active { activeTokens(Inline.tokensOf(p, line), look: look, into: s, segs: &segs) }
        else { drawRuns(Inline.runs(p.text, ctx.opts), look: look, into: s, segs: &segs) }
        if p.type == .todo && p.done { s.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: s.length)) }
        apply(s, look)
        let indent = CGFloat(p.depth) * 24
        let markW: CGFloat = p.type == .todo ? 16 : max(14, (Doc.listMark(p) as NSString).size(withAttributes: [.font: Fonts.sans(Look.body)]).width)
        let para = Renderer.para(size: Look.body, before: 4, after: 4, head: indent + markW + 10)
        let mark: MarkPaint.Kind = p.type == .todo ? .checkbox(p.done) : p.num != nil ? .number(Doc.listMark(p)) : .bullet
        emit(i, s, segs: segs, para: para, extra: [.edMark: MarkPaint(mark, x: indent, width: markW)], last: last)
    }

    func quote(_ i: Int, _ line: String, _ p: ParsedLine, _ active: Bool, ls: [String], last: Bool) {
        var look = InlineLook(); look.size = 16; look.color = Look.mid
        let up = i > 0 && Doc.parseLine(ls[i - 1]).type == .quote, down = i + 1 < ls.count && Doc.parseLine(ls[i + 1]).type == .quote
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        var base = 0
        if active { activeTokens(Inline.tokensOf(p, line), look: look, marker: Look.faint, into: s, segs: &segs) }
        else { base = line.len - p.text.len; drawRuns(Inline.runs(p.text, ctx.opts), look: look, into: s, segs: &segs) }
        apply(s, look)
        let para = Renderer.para(size: 16, before: up ? 2 : 10, after: down ? 2 : 14, head: 16 + 2 + 12, tail: 16)
        let card = CardPaint(top: !up, bottom: !down, ruleX: 16, ruleColor: Look.quoteRule, ruleTop: up ? 0 : 8, ruleBottom: down ? 0 : 12)
        emit(i, s, segs: segs, base: base, para: para, extra: [.edCard: card], last: last)
    }

    func image(_ i: Int, _ line: String, _ p: ParsedLine, last: Bool) {
        let parts = EditorText.imgParts(p.text)
        let img: NSImage? = p.src.hasPrefix("img:") ? ctx.image(String(p.src.dropFirst(4))) : ctx.webImage(p.src)
        let s = NSMutableAttributedString()
        if let img {
            let a = NSTextAttachment()
            a.image = img
            let maxW = min(ctx.columnWidth, parts.width > 0 ? CGFloat(parts.width) : ctx.columnWidth)
            var w = img.size.width, h = img.size.height
            if parts.width > 0 { h = h * maxW / max(1, w); w = maxW }
            else { let k = min(1, maxW / max(1, w), 520 / max(1, h)); w *= k; h *= k }
            a.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            s.append(NSAttributedString(attachment: a))
            s.addAttributes([.toolTip: parts.name, .edAction: ActionBox(.attachment(p.src))], range: NSRange(location: 0, length: s.length))
        } else {
            s.append(NSAttributedString(string: "\(parts.name.isEmpty ? "image" : parts.name)…", attributes: [.font: Fonts.sans(12.5), .foregroundColor: Look.grey]))
        }
        // The picture is the line's one closed token: the caret stands before it (0) or after it (the line's length).
        let seg = Seg(dLen: s.length, src: line, open: false, unit: true)
        emit(i, s, segs: [seg], para: Renderer.para(size: Look.body, before: 10, after: 10), last: last)
    }

    func code(_ i: Int, _ line: String, _ p: ParsedLine, _ active: Bool, last: Bool) {
        let mono = Fonts.mono(14)
        let card = CardPaint(top: p.type == .fence && p.open, bottom: p.type == .fence && !p.open, marginBottom: p.type == .fence && !p.open ? 14 : 0)
        // A ```math block is the equation, drawn, while the caret is outside it.
        if let block = p.block, p.lang == "math", !(core.activeLine.map { $0 >= block.open && $0 <= block.close } ?? false) {
            let ls = core.lines
            let tex = ls[(block.open + 1)..<block.close].joined(separator: "\n")
            if let drawn = MathText.render(tex, display: true), !tex.trimmed.isEmpty {
                if p.type == .fence && p.open {
                    let s = NSMutableAttributedString(string: drawn, attributes: [.font: Look.math(20), .foregroundColor: Look.ink])
                    emit(i, s, segs: [Seg(dLen: s.length, src: p.text, open: false, unit: true)], para: Renderer.para(size: 20, height: 1.5, before: 4, after: 4, head: 16, tail: 40, align: .center), fenceEnd: p.text.len, last: last)
                    decos.append(Decoration(line: i, deco: .copyCode, whole: false, height: 0))
                } else { hidden(i, last: last) }
                return
            }
        }
        if p.type == .code {
            let s = NSMutableAttributedString()
            for r in Doc.highlightRuns(line, p.lang) {
                let color = Doc.CODE_COLORS[r.look].map { NSColor(hex: $0) } ?? Look.ink
                var f = mono
                if r.look == .note { f = Fonts.mono(14, italic: true) }
                s.append(NSAttributedString(string: r.text, attributes: [.font: f, .foregroundColor: color]))
            }
            s.addAttribute(.baselineOffset, value: Renderer.baseline(mono, (14 * 1.7).rounded()), range: NSRange(location: 0, length: s.length))
            emit(i, s, segs: [.text(line)], para: Renderer.para(size: 14, height: 1.7, head: 16, tail: 16), extra: [.edCard: card], last: last)
            return
        }
        if active {
            let s = NSMutableAttributedString(string: line, attributes: [.font: mono, .foregroundColor: Look.grey])
            emit(i, s, segs: [.text(line)], para: Renderer.para(size: 14, height: 1.7, before: p.open ? 10 : 0, after: p.open ? 0 : 8, head: 16, tail: 40), extra: [.edCard: card], last: last)
        } else if p.open {
            let shown = Doc.fenceShown(p)
            let s = NSMutableAttributedString(string: shown, attributes: [.font: Fonts.sans(12), .foregroundColor: Look.grey])
            emit(i, s, segs: [.text(shown)], para: Renderer.para(size: 12, height: 1.6, before: 10, after: 2, head: 16, tail: 40, minHeight: 30), extra: [.edCard: card], fenceEnd: p.text.len, last: last)
        } else {
            emit(i, NSAttributedString(string: ""), segs: [], para: Renderer.para(size: 8, height: 1, after: 4), extra: [.edCard: card], fenceEnd: p.text.len, last: last)
        }
        if p.open { decos.append(Decoration(line: i, deco: .copyCode, whole: false, height: 0)) }
    }

    // MARK: conversations

    func question(_ i: Int, _ line: String, _ p: ParsedLine, _ active: Bool, _ w: LineAt?, last: Bool) {
        if let w, w.bare && w.role == .question && !w.box {
            let shown = Route.questionLine(p.text, max: 300)
            widget(i, .foldedRow(q: i, shown: shown.isEmpty ? EditorCore.leadOf(line, Doc.agentOf(p)) : shown), height: (w.top ? 14 : 0) + 21 + (w.closes ? 10 : 6),
                   card: CardPaint(top: w.top, bottom: w.closes, marginBottom: w.closes ? 8 : 0), last: last)
            return
        }
        if let w, w.box {
            let label = core.discoverLabel(i)
            widget(i, .research(state: w.boxState ?? "ready", label: label), height: ctx.rowHeight(.research(state: w.boxState ?? "ready", label: label)),
                   card: CardPaint(top: i == w.threadFrom, bottom: w.closes, marginBottom: w.closes ? 8 : 0), last: last)
            return
        }
        let models = core.models
        let agent = Doc.agentOf(p)
        // A recognised flag is its own token, a little bolder (bartTokens).
        let base = line.len - p.text.len
        var tokens: [String] = [], flags = Set<Int>()
        var atFlag = 0
        let spans: [[Int]] = agent == "discover" ? Question.discoverSpans(p.text, models) : (models != nil && agent != "brainstorm") ? Question.readFlags(p.text, models!).spans : []
        for sp in spans {
            tokens += Inline.tokens(line.slice(atFlag, base + sp[0]))
            flags.insert(tokens.count); tokens.append(line.slice(base + sp[0], base + sp[1])); atFlag = base + sp[1]
        }
        tokens += Inline.tokens(line.slice(atFlag))
        let asked = w?.answered ?? false
        let sent = asked || w?.pending != nil
        let editing = core.editing?.q == i
        var look = InlineLook(); look.size = 16
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        if active || editing { activeTokens(tokens, look: look, flags: flags, into: s, segs: &segs) }
        else if sent {
            // A question sent says `@bart`, its flags not drawn (2026-10-16, David); the line keeps them.
            var spaced = false
            for (k, tok) in tokens.enumerated() where !flags.contains(k) {
                let t = k == 0 && Inline.AGENT_TOKEN.test(tok) ? "@bart" : spaced ? tok.trimStart : tok
                if !t.isEmpty { spaced = Rx(#"\s$"#).test(t) }
                var inner: [Seg] = []
                let before = s.length
                drawRuns(Inline.runs(t, ctx.opts), look: look, into: s, segs: &inner)
                segs.append(Seg(dLen: s.length - before, src: tok, open: false, pre: 0))
            }
            for k in flags.sorted() { _ = k }
        } else {
            for (k, tok) in tokens.enumerated() {
                if flags.contains(k) { s.append(NSAttributedString(string: tok, attributes: [.font: Fonts.sans(16, weight: 500), .foregroundColor: Look.ink])); segs.append(.text(tok)); continue }
                var inner: [Seg] = []
                let before = s.length
                drawRuns(Inline.runs(tok, ctx.opts), look: look, into: s, segs: &inner)
                segs.append(Seg(dLen: s.length - before, src: tok, open: inner.allSatisfy { $0.open }, pre: Inline.tokShown(tok, ctx.opts).pre))
            }
        }
        apply(s, look)
        let chipped = !asked || editing
        if chipped {
            // Not asked yet (or being edited): the message box, its chip and round send bottom-right.
            let read = models.flatMap { m in (!EditorCore.oneModel(agent) || agent == "router") ? Question.readQuestion(p.text, m) : nil }
            let ready = (EditorCore.oneModel(agent) && agent != "router") || !(read?.question ?? p.text).trimmed.isEmpty
            var label: String? = nil
            if let read, let step = read.steps.first { label = "\(step.name) \(Question.EFFORT_LABELS[step.effort] ?? step.effort)" }
            else if models != nil && agent == "discover" { label = core.discoverLabel(i) }
            let chipW: CGFloat = label.map { ($0 as NSString).size(withAttributes: [.font: Fonts.sans(13)]).width + 30 + 38 } ?? 38
            let para = Renderer.para(size: 16, before: (w?.top ?? true) ? 9 : 17, after: 17, head: 16, tail: 10 + chipW)
            let card = CardPaint(top: true, bottom: true, marginBottom: 8)
            emit(i, s, segs: segs, para: para, extra: [.edCard: card], last: last)
            decos.append(Decoration(line: i, deco: .chip(label: label, ready: ready), whole: false, height: 0))
            return
        }
        let w = w!
        let top = w.top, closes = w.closes
        let para = Renderer.para(size: 16, before: top ? 14 : w.afterBare ? 0 : 14, after: closes ? 10 : 0, head: 16, tail: 16 + 34)
        emit(i, s, segs: segs, para: para, extra: [.edCard: CardPaint(top: top, bottom: closes, marginBottom: closes ? 8 : 0)], last: last)
        let firstOpen = core.threads().first { $0.from == w.threadFrom }.flatMap { $0.turns.first { !$0.folded } }?.q == w.turnQ
        if (w.answered && w.pending == nil && !w.foldedTurn) || (firstOpen && w.pending != nil && w.titleLine >= 0) {
            if let thread = core.threads().first(where: { $0.from == w.threadFrom }), let turn = thread.turns.first(where: { $0.q == w.turnQ }), core.editing?.q != i, w.build == nil || (top && w.titleLine >= 0) {
                let label = core.collapsesThread(thread, turn) ? "Collapse conversation" : "Collapse"
                decos.append(Decoration(line: i, deco: .corner(q: w.turnQ, whole: w.build != nil, label: label), whole: false, height: 0))
            }
        }
    }

    func pending(_ i: Int, _ p: ParsedLine, _ w: LineAt?, last: Bool) {
        if let w, w.box, ["interrupted", "stopped", "failed"].contains(w.boxState ?? "") { hidden(i, last: last); return }
        let deco = Deco.pending(id: p.id)
        let closes = w?.closes ?? true
        widget(i, deco, height: ctx.rowHeight(deco), card: CardPaint(top: w == nil, bottom: closes, marginBottom: closes ? 8 : 0), last: last)
    }

    func reply(_ i: Int, _ line: String, _ p: ParsedLine, _ w: LineAt?, ls: [String], last: Bool) {
        // A folded turn's foot and lines are in the document, not on the page; so is the gap before the foot.
        if let w, w.role == .foot && w.answered && w.pending == nil && w.foldedTurn && !w.box { hidden(i, last: last); return }
        if let w, w.role == .foot {
            let deco = Deco.foot(q: w.turnQ, busy: w.running, plain: EditorCore.oneModel(w.agent))
            widget(i, deco, height: 12 + 28 + (w.closes ? 10 : 6), card: CardPaint(top: false, bottom: w.closes, marginBottom: w.closes ? 8 : 0), last: last)
            return
        }
        if p.folded || (w?.gap ?? false) { hidden(i, last: last); return }
        let first = w?.first ?? (i == 0 || Doc.parseLine(ls[i - 1]).type != .reply)
        let closes = w?.closes ?? (i + 1 >= ls.count || Doc.parseLine(ls[i + 1]).type != .reply)
        let lastBody = w?.lastBody ?? closes
        var look = InlineLook(); look.size = 16; look.color = Look.answerInk; look.boldInk = Look.ink
        var opts = ctx.opts
        if let w, !w.running, ctx.canReply { opts.buildTurn = w.turnQ }
        // The answer's citation numbers, so a circle has the same number on every line of it (citesOf).
        if let w, let found = core.findTurn(ls, w.turnQ) {
            let answer = Doc.turnText(ls, found.turn).answer
            if answer.contains("cite=") { opts.cites = Cite.citationNumbers([answer]) }
        }
        let q = Doc.parseLine(p.text)
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        var base = 0
        var head: CGFloat = 32, before: CGFloat = first ? 14 : 0
        var size: CGFloat = 16
        var extra: [NSAttributedString.Key: Any] = [:]
        let r = Renderer(core: core, ctx: { var c = ctx; c.opts = opts; return c }())
        if q.type == .h {
            size = [18, 17, 16][max(0, min(2, q.level - 1))]
            look.size = size; look.weight = 600; look.color = Look.ink
            base = p.text.len - q.text.len
            r.drawRuns(Inline.runs(q.text, opts), look: look, into: s, segs: &segs)
            before += 8
        } else if Doc.isMarked(q.type) {
            base = p.text.len - q.text.len
            r.drawRuns(Inline.runs(q.text, opts), look: look, into: s, segs: &segs)
            let indent = 32 + CGFloat(q.depth) * 18
            head = indent + 28
            extra[.edMark] = MarkPaint(q.type == .todo ? .bullet : q.num != nil ? .number(Doc.listMark(q)) : .bullet, x: indent, width: 24)
            before += 4
        } else {
            r.drawRuns(Inline.runs(p.text, opts), look: look, into: s, segs: &segs)
        }
        apply(s, look)
        // The answer under a question being edited (2026-10-03): its contents faded to .45.
        if let w, core.editing?.q == w.turnQ {
            s.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: s.length)) { v, r, _ in
                if let c = v as? NSColor { s.addAttribute(.foregroundColor, value: c.withAlphaComponent(0.45), range: r) }
            }
        }
        let para = Renderer.para(size: size, height: 1.65, before: before, after: (closes ? 10 : 0) + (Doc.isMarked(q.type) ? 4 : 0), head: head, tail: 16, minHeight: p.text.isEmpty ? 22 : nil)
        extra[.edCard] = CardPaint(top: w == nil && first, bottom: closes, ruleX: 16, ruleColor: Look.rule, ruleTop: first ? 12 : 0, ruleBottom: lastBody ? 0 : 0, marginBottom: closes ? 8 : 0)
        emit(i, s, segs: segs, base: base, para: para, extra: extra, last: last)
    }

    func answerCode(_ i: Int, _ line: String, _ p: ParsedLine, _ w: LineAt?, last: Bool) {
        let mono = Fonts.mono(14)
        let first = w?.first ?? false, closes = w?.closes ?? false
        let s = NSMutableAttributedString()
        var segs: [Seg] = []
        var para = Renderer.para(size: 14, height: 1.7, before: first ? 12 : 0, after: closes ? 10 : 0, head: 32 + 12, tail: 28)
        var fenceEnd: Int? = nil
        if p.code == .body {
            for r in Doc.highlightRuns(p.text, p.lang) {
                s.append(NSAttributedString(string: r.text, attributes: [.font: mono, .foregroundColor: Doc.CODE_COLORS[r.look].map { NSColor(hex: $0) } ?? Look.ink]))
            }
            segs = [.text(p.text)]
        } else if p.code == .open {
            let shown = Doc.fenceShown(p)
            s.append(NSAttributedString(string: shown, attributes: [.font: Fonts.sans(12), .foregroundColor: Look.grey]))
            segs = [.text(shown)]; fenceEnd = p.text.len
            para = Renderer.para(size: 12, height: 1.6, before: (first ? 12 : 0) + 8, after: 2, head: 32 + 12, tail: 28 + 32, minHeight: 28)
            decos.append(Decoration(line: i, deco: .copyCode, whole: false, height: 0))
        } else {
            fenceEnd = p.text.len
            para = Renderer.para(size: 8, height: 1, after: (closes ? 10 : 0) + 8, head: 32 + 12, tail: 28)
        }
        emit(i, s, segs: segs, para: para, extra: [.edCard: CardPaint(top: false, bottom: closes, ruleX: 16, ruleColor: Look.rule, marginBottom: closes ? 8 : 0)], fenceEnd: fenceEnd, last: last)
    }
}

extension InlineRun {
    /// Drawn as an attachment of its own (one character): a citation, the hammer.
    var isUnitDrawing: Bool { if case .citation = self { return true }; if case .buildIcon = self { return true }; return false }
}
