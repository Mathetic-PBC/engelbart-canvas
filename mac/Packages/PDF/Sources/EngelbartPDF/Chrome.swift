import AppKit
import EngelbartDoc
import EngelbartUI

// What floats over the paper (PaperView render): the page-and-zoom bar, the "Highlight removed · Undo" toast, the empty
// card under a pending selection, and a note's @ menu. Values are PaperView's styles (BAR, BAR_STEP, BAR_PCT, TOAST,
// TOAST_UNDO, openSelCard).

/// "n of m | − pct +" (Stage design): 16 from the foot, 34 high, white, 1px #eaeaea, radius 8, 12.5px tabular #4d4d4d.
final class PaperBar: NSView {
    var onStep: ((Int) -> Void)?
    var onPct: (() -> Void)?
    private var page = 0, pages = 0, pct = 100
    private let minus = BarButton("−", font: Fonts.sans(14), color: NSColor(hex: "#4d4d4d"), width: 26)
    private let plus = BarButton("+", font: Fonts.sans(14), color: NSColor(hex: "#4d4d4d"), width: 26)
    private let percent = BarButton("100%", font: Fonts.sans(12.5, weight: 500).withTabularDigits, color: NSColor(hex: "#171717"), width: 48)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.borderColor = NSColor(hex: "#eaeaea").cgColor
        layer?.borderWidth = 1
        layer?.cornerRadius = 8
        toolTip = "pinch, or ⌘ or ⌃ scroll, to zoom"
        minus.setAccessibilityLabel("Zoom out"); plus.setAccessibilityLabel("Zoom in")
        percent.toolTip = "100% = fit width"
        minus.onPress = { [weak self] in self?.onStep?(-1) }
        plus.onPress = { [weak self] in self?.onStep?(1) }
        percent.onPress = { [weak self] in self?.onPct?() }
        for b in [minus, percent, plus] { addSubview(b) }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    // A press on the bar keeps the keyboard where it was (onMouseDown preventDefault).
    override var acceptsFirstResponder: Bool { false }
    override func mouseDown(with event: NSEvent) {}

    private var numFont: NSFont { Fonts.sans(12.5).withTabularDigits }

    func set(page: Int, pages: Int, pct: Int) {
        guard page != self.page || pages != self.pages || pct != self.pct else { return }
        self.page = page; self.pages = pages; self.pct = pct
        percent.title = "\(pct)%"
        needsLayout = true; needsDisplay = true
    }

    /// Its width: "n" at least as wide as the page count's digits, " of m", the separator, − pct +.
    var preferredSize: NSSize {
        let digits = String(repeating: "0", count: String(pages).count)
        let nW = max(width(String(page)), width(digits))
        let ofW = width("of \(pages)")
        let pctW = max(48, percent.intrinsicContentSize.width)
        return NSSize(width: 12 + nW + 4 + ofW + 4 + 6 + 1 + 6 + 26 + 2 + pctW + 2 + 26 + 4, height: 34)
    }
    private func width(_ s: String) -> CGFloat { ceil((s as NSString).size(withAttributes: [.font: numFont]).width) }

    override func layout() {
        super.layout()
        let digits = String(repeating: "0", count: String(pages).count)
        var x = 12 + max(width(String(page)), width(digits)) + 4 + width("of \(pages)") + 4 + 6 + 1 + 6
        minus.frame = NSRect(x: x, y: 4, width: 26, height: 26); x += 26 + 2
        let pw = max(48, percent.intrinsicContentSize.width)
        percent.frame = NSRect(x: x, y: 4, width: pw, height: 26); x += pw + 2
        plus.frame = NSRect(x: x, y: 4, width: 26, height: 26)
    }

    override func draw(_ dirtyRect: NSRect) {
        let digits = String(repeating: "0", count: String(pages).count)
        let nW = max(width(String(page)), width(digits))
        let n = String(page), nw = width(n)
        let mid = bounds.height / 2
        let h = (n as NSString).size(withAttributes: [.font: numFont]).height
        (n as NSString).draw(at: NSPoint(x: 12 + nW - nw, y: mid - h / 2), withAttributes: [.font: numFont, .foregroundColor: NSColor(hex: "#171717")])
        ("of \(pages)" as NSString).draw(at: NSPoint(x: 12 + nW + 4, y: mid - h / 2), withAttributes: [.font: numFont, .foregroundColor: NSColor(hex: "#8f8f8f")])
        NSColor(hex: "#eaeaea").setFill()
        NSRect(x: 12 + nW + 4 + width("of \(pages)") + 4 + 6, y: mid - 8, width: 1, height: 16).fill()
    }
}

/// A bar button: no edge, radius 6, a hover wash.
final class BarButton: NSView {
    var title: String { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    let font: NSFont, color: NSColor, minWidth: CGFloat
    private var hovering = false { didSet { needsDisplay = true } }
    init(_ title: String, font: NSFont, color: NSColor, width: CGFloat) {
        self.title = title; self.font = font; self.color = color; self.minWidth = width
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var acceptsFirstResponder: Bool { false }
    override var intrinsicContentSize: NSSize { NSSize(width: max(minWidth, ceil((title as NSString).size(withAttributes: [.font: font]).width) + 12), height: 26) }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) { if bounds.contains(convert(event.locationInWindow, from: nil)) { onPress?() } }
    override func draw(_ dirtyRect: NSRect) {
        if hovering { Palette.hov.setFill(); NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
        let s = (title as NSString).size(withAttributes: [.font: font])
        (title as NSString).draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2), withAttributes: [.font: font, .foregroundColor: color])
    }
}

/// "Highlight removed · Undo" (TOAST): 60 from the foot, 30 high, #171717, radius 8, white 12.5px, shadow 0 2 8 .12.
final class RemovedToast: NSView {
    var onUndo: (() -> Void)?
    private let label = makeLabel("", font: Fonts.sans(12.5), color: .white)
    private let dot = makeLabel("·", font: Fonts.sans(12.5), color: NSColor(hex: "#8f8f8f"))
    private let undo = BarButton("Undo", font: Fonts.sans(12.5, weight: 500), color: .white, width: 0)
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(hex: "#171717").cgColor
        layer?.cornerRadius = 8
        shadow = NSShadow()
        layer?.shadowColor = NSColor.black.cgColor; layer?.shadowOpacity = 0.12; layer?.shadowRadius = 4; layer?.shadowOffset = CGSize(width: 0, height: -2)
        undo.onPress = { [weak self] in self?.onUndo?() }
        setAccessibilityRole(.staticText)
        for v in [label, dot, undo] as [NSView] { addSubview(v) }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func mouseDown(with event: NSEvent) {}
    var text: String { get { label.stringValue } set { label.stringValue = newValue; needsLayout = true } }
    var preferredSize: NSSize { NSSize(width: 12 + label.intrinsicContentSize.width + 4 + dot.intrinsicContentSize.width + 4 + undo.intrinsicContentSize.width + 4, height: 30) }
    override func layout() {
        super.layout()
        let lw = label.intrinsicContentSize.width, dw = dot.intrinsicContentSize.width
        label.frame = NSRect(x: 12, y: (30 - 16) / 2, width: lw, height: 16)
        dot.frame = NSRect(x: 12 + lw + 4, y: (30 - 16) / 2, width: dw, height: 16)
        let uw = undo.intrinsicContentSize.width
        undo.frame = NSRect(x: 12 + lw + 4 + dw + 4, y: 4, width: uw, height: 22)
    }
}

/// The empty card under a pending selection (2026-10-18, openSelCard): on the paper's white, a blinking caret and
/// "Write a note or ask @bart" in the note's handwriting, drawn at the page's note scale. A press on it keeps the
/// selection and the keyboard where they are.
final class SelectionCardView: NSView {
    static let placeholder = "Write a note or ask @bart"
    var page = 1
    var cardWidth: CGFloat = 240
    private var caretOn = true
    private var timer: Timer?
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        timer = Timer.scheduledTimer(withTimeInterval: 0.53, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.caretOn.toggle(); self?.needsDisplay = true }
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit { timer?.invalidate() }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { false }
    override func mouseDown(with event: NSEvent) {}
    override func resetCursorRects() { addCursorRect(bounds, cursor: .iBeam) }
    /// Its size in note px: as wide as it is given, one line of handwriting and 4px under it.
    var noteSize: NSSize { NSSize(width: cardWidth, height: NoteLook.lineHeight + 4) }
    override func draw(_ dirtyRect: NSRect) {
        let k = bounds.width / max(1, cardWidth)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState(); ctx.scaleBy(x: k, y: k)
        let font = NoteLook.font
        let lineTop: CGFloat = 0, h = NoteLook.lineHeight
        // the caret: 1.5px wide, 1.05em high, 1px before the words, steps(1) blink
        if caretOn {
            NoteLook.ink.setFill()
            NSRect(x: 6, y: lineTop + (h - 1.05 * font.pointSize) / 2 + 2, width: 1.5, height: 1.05 * font.pointSize).fill()
        }
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(hex: "#b5b5b5"), .kern: 0.2]
        let s = (Self.placeholder as NSString).size(withAttributes: attrs)
        let avail = cardWidth - 6 - 2.5 - 6
        var text = Self.placeholder
        if s.width > avail { while !text.isEmpty && ((text + "…") as NSString).size(withAttributes: attrs).width > avail { text.removeLast() }; text += "…" }
        (text as NSString).draw(at: NSPoint(x: 6 + 2.5, y: lineTop + (h - s.height) / 2), withAttributes: attrs)
        ctx.restoreGState()
    }
}

/// A note's @ menu, the workspace's MentionMenu as a note opens it (src/renderer/workspace/MentionMenu.jsx): 400 px
/// (the pane less 16 at most), padding 4, white, 1px #eaeaea, radius 8, no shadow; rows at least 32 high, padding 0 10,
/// gap 10, radius 6, the keyboard's row #f2f2f2 (never a row that only says something); an 18 px glyph #4d4d4d; the name
/// 14px/1.4 #171717 (a note row #8f8f8f), cut in the middle so its end shows (rail.js nameParts); a folder's ›; the back
/// row's ← and its path (12px #8f8f8f, its start cut); at most 420 high, then it scrolls; it rises in over 160 ms.
final class MentionMenuView: NSView {
    var rows: [MentionRow] = [] { didSet { needsDisplay = true; if rows.map(\.key) != oldValue.map(\.key) { scrollTop = 0 } } }
    var index = 0 { didSet { keepInView(); needsDisplay = true } }
    var onPick: ((MentionRow) -> Void)?
    var onHover: ((Int) -> Void)?
    static let rowH: CGFloat = 32, width: CGFloat = 400, cap: CGFloat = 420, pad: CGFloat = 4
    private var scrollTop: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.cornerRadius = 8
        layer?.borderWidth = 1; layer?.borderColor = NSColor(hex: "#eaeaea").cgColor
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { false }

    func preferredSize(maxWidth: CGFloat) -> NSSize {
        NSSize(width: min(Self.width, maxWidth), height: min(Self.cap, CGFloat(rows.count) * Self.rowH + 2 * Self.pad))
    }
    var preferredSize: NSSize { preferredSize(maxWidth: Self.width) }

    /// Shown: it rises 6 px and fades in (`rise 160ms`).
    func rise() {
        guard let layer else { return }
        let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0; fade.toValue = 1
        let up = CABasicAnimation(keyPath: "transform.translation.y"); up.fromValue = -6; up.toValue = 0
        let g = CAAnimationGroup(); g.animations = [fade, up]; g.duration = 0.16
        g.timingFunction = CAMediaTimingFunction(controlPoints: 0.25, 0.1, 0.25, 1)
        layer.add(g, forKey: "rise")
    }

    private func keepInView() {
        let top = CGFloat(index) * Self.rowH, h = bounds.height - 2 * Self.pad
        if top < scrollTop { scrollTop = top }
        if top + Self.rowH > scrollTop + h { scrollTop = top + Self.rowH - h }
    }

    /// A long name cut in two (rail.js nameParts): its start, cut with "…" when room runs out, and its end always shown.
    static func nameParts(_ name: String) -> (head: String, tail: String) {
        let s = name as NSString
        if s.length <= 24 { return (name, "") }
        let ext = name.range(of: #"\.[A-Za-z0-9]{1,8}$"#, options: .regularExpression).map { (name[$0] as NSString).length } ?? 0
        let keep = min(ext + 10, s.length / 2)
        return (s.substring(to: s.length - keep), s.substring(from: s.length - keep))
    }

    /// The row's frame in the menu.
    func rowRect(_ i: Int) -> NSRect { NSRect(x: Self.pad, y: Self.pad + CGFloat(i) * Self.rowH - scrollTop, width: bounds.width - 2 * Self.pad, height: Self.rowH) }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.current?.cgContext.clip(to: bounds.insetBy(dx: 0, dy: Self.pad - 0.5))
        for (i, row) in rows.enumerated() {
            let r = rowRect(i)
            if r.maxY < 0 || r.minY > bounds.height { continue }
            if i == index && row.kind != .note { NSColor(hex: "#f2f2f2").setFill(); NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).fill() }
            var x = r.minX + 10
            drawGlyph(row, in: NSRect(x: x, y: r.midY - 9, width: 18, height: 18))
            x += 18 + 10
            var right = r.maxX - 10
            let grey = NSColor(hex: "#8f8f8f")
            if (row.kind == .item && row.browsable) || (row.kind == .entry && row.dir) {
                let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(15), .foregroundColor: grey]
                ("›" as NSString).draw(in: NSRect(x: right - 16 + 4, y: r.midY - 10, width: 16, height: 20), withAttributes: a)
                right -= 16 + 10
            }
            if !row.hint.isEmpty && (row.kind == .back || row.zotero) {
                let font = Fonts.sans(12)
                let w = min(ceil((row.hint as NSString).size(withAttributes: [.font: font]).width), (right - x) * (row.kind == .back ? 0.6 : 0.4))
                let p = NSMutableParagraphStyle(); p.lineBreakMode = row.kind == .back ? .byTruncatingHead : .byTruncatingTail
                (row.hint as NSString).draw(in: NSRect(x: right - w, y: r.midY - 8.5, width: w, height: 17), withAttributes: [.font: font, .foregroundColor: grey, .paragraphStyle: p])
                right -= w + 10
            }
            let font = Fonts.sans(14)
            let color = row.kind == .note ? grey : NSColor(hex: "#171717")
            let (head, tail) = row.kind == .note ? (row.name, "") : Self.nameParts(row.name)
            let tailW = tail.isEmpty ? 0 : ceil((tail as NSString).size(withAttributes: [.font: font]).width)
            let p = NSMutableParagraphStyle(); p.lineBreakMode = .byTruncatingTail
            let headW = min(ceil((head as NSString).size(withAttributes: [.font: font]).width) + 1, max(0, right - x - tailW))
            (head as NSString).draw(in: NSRect(x: x, y: r.midY - 10, width: headW, height: 20), withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: p])
            if !tail.isEmpty { (tail as NSString).draw(at: NSPoint(x: x + headW, y: r.midY - 10), withAttributes: [.font: font, .foregroundColor: color]) }
        }
    }

    /// The row's glyph (MentionMenu Glyph): ← back, nothing for a note, a folder, the file's kind, Bart's chat, the item's kind.
    private func drawGlyph(_ row: MentionRow, in box: NSRect) {
        let color = NSColor(hex: "#4d4d4d")
        if row.kind == .back {
            let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(14), .foregroundColor: color]
            let s = ("←" as NSString).size(withAttributes: a)
            ("←" as NSString).draw(at: NSPoint(x: box.midX - s.width / 2, y: box.midY - s.height / 2), withAttributes: a)
            return
        }
        if row.kind == .note { return }
        let key: String
        if row.kind == .self || (row.kind == .entry && row.dir) || (row.kind == .item && row.browsable) { key = "folder" }
        else if row.kind == .verb { key = "chat" }
        else { key = row.type ?? (row.kind == .entry ? "pdf" : "file") }
        let k = KindIcons.kind(key)
        let side = KindIcons.glyphSize(key)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.translateBy(x: box.midX - side / 2, y: box.midY - side / 2)
        k.icon.draw(in: ctx, side: side, color: color.cgColor)
        ctx.restoreGState()
    }

    private func rowAt(_ e: NSEvent) -> Int? {
        let p = convert(e.locationInWindow, from: nil)
        let i = Int(((p.y - Self.pad + scrollTop) / Self.rowH).rounded(.down))
        return i >= 0 && i < rows.count ? i : nil
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    // moved onto, not appeared under: the keyboard's row stays put
    override func mouseMoved(with event: NSEvent) { if let i = rowAt(event), i != index { onHover?(i) } }
    override func mouseDown(with event: NSEvent) { if let i = rowAt(event), rows[i].kind != .note { onPick?(rows[i]) } }
    override func resetCursorRects() { for (i, r) in rows.enumerated() where r.kind != .note { addCursorRect(rowRect(i), cursor: .pointingHand) } }
    override func scrollWheel(with event: NSEvent) {
        let most = max(0, CGFloat(rows.count) * Self.rowH - (bounds.height - 2 * Self.pad))
        scrollTop = max(0, min(most, scrollTop - event.scrollingDeltaY))
        needsDisplay = true
    }
}

/// A citation's card (cite.js citationTip, CITE_CARD_STYLE and citationCardHtml): 280 wide, padding 12 14 10, white,
/// 1px #e3e3e3, radius 10, shadow 0 8 24 rgba(0,0,0,.08); the quote 13.5px/1.55 #171717 in curly quotes, then a 1px
/// #eaeaea rule (10 above, 9 under) and a line 11.5px #8f8f8f: a document glyph, "lead · ", where (600 #4d4d4d),
/// " · when", " · cuts against this". The pointer may go from the circle onto it.
final class CiteTipView: NSView {
    var card: Cite.Card? { didSet { needsLayout = true; needsDisplay = true } }
    var onHover: ((Bool) -> Void)?
    static let width: CGFloat = 280

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.cornerRadius = 10
        layer?.borderWidth = 1; layer?.borderColor = NSColor(hex: "#e3e3e3").cgColor
        layer?.shadowColor = NSColor.black.cgColor; layer?.shadowOpacity = 0.08; layer?.shadowRadius = 12; layer?.shadowOffset = CGSize(width: 0, height: -8)
        layer?.masksToBounds = false
        setAccessibilityRole(.popover)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }

    var quoteText: NSAttributedString? {
        guard let q = card?.quote, !q.isEmpty else { return nil }
        let p = NSMutableParagraphStyle(); p.minimumLineHeight = 13.5 * 1.55; p.maximumLineHeight = 13.5 * 1.55
        return NSAttributedString(string: "“\(q)”", attributes: [.font: Fonts.sans(13.5), .foregroundColor: NSColor(hex: "#171717"), .paragraphStyle: p])
    }
    var footText: NSAttributedString {
        let grey = NSColor(hex: "#8f8f8f"), f = Fonts.sans(11.5)
        let out = NSMutableAttributedString()
        guard let c = card else { return out }
        if !c.lead.isEmpty { out.append(NSAttributedString(string: "\(c.lead) · ", attributes: [.font: f, .foregroundColor: grey])) }
        out.append(NSAttributedString(string: c.where_, attributes: [.font: Fonts.sans(11.5, weight: 600), .foregroundColor: NSColor(hex: "#4d4d4d")]))
        if !c.when.isEmpty { out.append(NSAttributedString(string: " · \(c.when)", attributes: [.font: f, .foregroundColor: grey])) }
        if c.counter { out.append(NSAttributedString(string: " · cuts against this", attributes: [.font: f, .foregroundColor: grey])) }
        let p = NSMutableParagraphStyle(); p.lineBreakMode = .byTruncatingTail
        out.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: out.length))
        return out
    }
    private var quoteHeight: CGFloat {
        guard let q = quoteText else { return 0 }
        return ceil(q.boundingRect(with: NSSize(width: Self.width - 28, height: 10_000), options: [.usesLineFragmentOrigin]).height)
    }
    var preferredSize: NSSize {
        let foot: CGFloat = ceil(11.5 * 1.4)
        let q = quoteHeight
        return NSSize(width: Self.width, height: 12 + (q > 0 ? q + 10 + 1 + 9 : 0) + foot + 10)
    }
    override func draw(_ dirtyRect: NSRect) {
        var y: CGFloat = 12
        let q = quoteHeight
        if let quote = quoteText {
            quote.draw(with: NSRect(x: 14, y: y, width: Self.width - 28, height: q), options: [.usesLineFragmentOrigin])
            y += q + 10
            NSColor(hex: "#eaeaea").setFill(); NSRect(x: 14, y: y, width: Self.width - 28, height: 1).fill()
            y += 1 + 9
        }
        // DOC_ICON: a page with its corner folded and three lines, 12 px, stroke 2 on a 24 grid
        if let ctx = NSGraphicsContext.current?.cgContext {
            ctx.saveGState(); ctx.translateBy(x: 14, y: y + 2); ctx.scaleBy(x: 0.5, y: 0.5)
            ctx.setStrokeColor(NSColor(hex: "#8f8f8f").cgColor); ctx.setLineWidth(2); ctx.setLineCap(.round); ctx.setLineJoin(.round)
            let page = CGMutablePath()
            page.move(to: CGPoint(x: 15, y: 2)); page.addLine(to: CGPoint(x: 6, y: 2)); page.addQuadCurve(to: CGPoint(x: 4, y: 4), control: CGPoint(x: 4, y: 2))
            page.addLine(to: CGPoint(x: 4, y: 20)); page.addQuadCurve(to: CGPoint(x: 6, y: 22), control: CGPoint(x: 4, y: 22))
            page.addLine(to: CGPoint(x: 18, y: 22)); page.addQuadCurve(to: CGPoint(x: 20, y: 20), control: CGPoint(x: 20, y: 22)); page.addLine(to: CGPoint(x: 20, y: 7)); page.closeSubpath()
            for (a, b) in [((14.0, 2.0), (14.0, 6.0)), ((14.0, 6.0), (20.0, 6.0)), ((16.0, 13.0), (8.0, 13.0)), ((16.0, 17.0), (8.0, 17.0)), ((10.0, 9.0), (8.0, 9.0))] {
                page.move(to: CGPoint(x: a.0, y: a.1)); page.addLine(to: CGPoint(x: b.0, y: b.1))
            }
            ctx.addPath(page); ctx.strokePath(); ctx.restoreGState()
        }
        footText.draw(with: NSRect(x: 14 + 12 + 6, y: y, width: Self.width - 28 - 18, height: ceil(11.5 * 1.4)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

extension NSFont {
    /// font-variant-numeric: tabular-nums
    var withTabularDigits: NSFont {
        let d = fontDescriptor.addingAttributes([.featureSettings: [[NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType, NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector]]])
        return NSFont(descriptor: d, size: pointSize) ?? self
    }
}
