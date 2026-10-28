import AppKit
import EngelbartDoc
import EngelbartUI

// TextKit 1 (NSLayoutManager) draws what the HTML drew as boxes around the text: the grey cards and their left rules,
// a row's checkbox, bullet or number in its indent, inline code's pill, a mention's glyph after its @, and a line that is
// in the document but not on the page (zero height). TextKit 1 rather than 2: its delegate can give a paragraph a line
// fragment of zero height and its drawBackground sees every fragment's rect, which is how hidden lines and cards spanning
// many paragraphs are drawn reliably; TextKit 2's NSTextLayoutFragment drawing could not hide a paragraph without
// leaving its line height behind (decision recorded in API.md).

final class DocLayoutManager: NSLayoutManager, NSLayoutManagerDelegate {
    override init() { super.init(); delegate = self }
    required init?(coder: NSCoder) { super.init(coder: coder); delegate = self }

    func layoutManager(_ lm: NSLayoutManager, shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>, lineFragmentUsedRect: UnsafeMutablePointer<NSRect>, baselineOffset: UnsafeMutablePointer<CGFloat>, in textContainer: NSTextContainer, forGlyphRange glyphRange: NSRange) -> Bool {
        guard let storage = textStorage, glyphRange.length > 0 || glyphRange.location < numberOfGlyphs else { return false }
        let ci = characterIndexForGlyph(at: glyphRange.location)
        guard ci < storage.length, storage.attribute(.edHidden, at: ci, effectiveRange: nil) != nil else { return false }
        lineFragmentRect.pointee.size.height = 0
        lineFragmentUsedRect.pointee.size.height = 0
        baselineOffset.pointee = 0
        return true
    }

    func layoutManager(_ lm: NSLayoutManager, shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>, properties props: UnsafePointer<NSLayoutManager.GlyphProperty>, characterIndexes charIndexes: UnsafePointer<Int>, font aFont: NSFont, forGlyphRange glyphRange: NSRange) -> Int {
        guard let storage = textStorage else { return 0 }
        var hide = false
        let first = charIndexes[0]
        if first < storage.length, storage.attribute(.edHidden, at: first, effectiveRange: nil) != nil { hide = true }
        guard hide else { return 0 }
        var newProps = [NSLayoutManager.GlyphProperty](repeating: .null, count: glyphRange.length)
        for k in 0..<glyphRange.length { newProps[k] = props[k].union(.null) }
        setGlyphs(glyphs, properties: newProps, characterIndexes: charIndexes, font: aFont, forGlyphRange: glyphRange)
        return glyphRange.length
    }

    /// Each paragraph's line fragments: (char range of the paragraph, union of its fragment rects, first fragment's used rect).
    func paragraphs(in glyphsToShow: NSRange) -> [(chars: NSRange, rect: NSRect, firstUsed: NSRect)] {
        guard let storage = textStorage, let container = textContainers.first else { return [] }
        let text = storage.string as NSString
        var out: [(NSRange, NSRect, NSRect)] = []
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        var at = text.paragraphRange(for: NSRange(location: min(chars.location, max(0, text.length - 1)), length: 0)).location
        let end = NSMaxRange(chars)
        while at <= text.length {
            let para = text.length == 0 ? NSRange(location: 0, length: 0) : text.paragraphRange(for: NSRange(location: min(at, text.length - 1), length: 0))
            let glyphs = glyphRange(forCharacterRange: para, actualCharacterRange: nil)
            var rect = NSRect.null, firstUsed = NSRect.null
            if glyphs.length > 0 {
                enumerateLineFragments(forGlyphRange: glyphs) { r, used, _, _, _ in
                    if firstUsed.isNull { firstUsed = used }
                    rect = rect.union(r)
                }
            }
            if !rect.isNull { rect.origin.x = 0; rect.size.width = container.size.width; out.append((para, rect, firstUsed)) }
            if NSMaxRange(para) >= text.length || NSMaxRange(para) <= at || para.location > end { break }
            at = NSMaxRange(para)
        }
        // The extra line fragment of an empty last paragraph.
        if !extraLineFragmentRect.isEmpty, text.length > 0, text.character(at: text.length - 1) == 10 {
            var r = extraLineFragmentRect; r.origin.x = 0; r.size.width = container.size.width
            out.append((NSRange(location: text.length, length: 0), r, extraLineFragmentUsedRect))
        }
        return out
    }

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, storage.length > 0 else { return }
        let paras = paragraphs(in: glyphsToShow)
        // Cards: consecutive carded paragraphs merge into one card until one closes it or the next opens another.
        var run: (rect: NSRect, top: Bool, card: CardPaint)? = nil
        func flush(bottom: Bool) {
            guard let r = run else { return }
            var rect = r.rect.offsetBy(dx: origin.x, dy: origin.y)
            if bottom { rect.size.height -= r.card.marginBottom }
            fillCard(rect, top: r.top, bottom: bottom, card: r.card)
            run = nil
        }
        for p in paras {
            let loc = min(p.chars.location, storage.length - 1)
            guard let card = storage.attribute(.edCard, at: loc, effectiveRange: nil) as? CardPaint, storage.attribute(.edHidden, at: loc, effectiveRange: nil) == nil else {
                if storage.attribute(.edHidden, at: loc, effectiveRange: nil) != nil { continue }
                flush(bottom: true); continue
            }
            if card.top { flush(bottom: true) }
            if run == nil { run = (p.rect, card.top, card) } else { run!.rect = run!.rect.union(p.rect); run!.card = card }
            // The rule down the card's left, the line's own height (less the card's padding at its ends).
            if let x = card.ruleX {
                var r = p.rect.offsetBy(dx: origin.x, dy: origin.y)
                r.origin.y += card.ruleTop
                r.size.height -= card.ruleTop + card.ruleBottom + (card.bottom ? card.marginBottom + 10 : 0)
                if r.height > 0 { pendingRules.append((NSRect(x: r.minX + x, y: r.minY, width: card.ruleWidth, height: r.height), card.ruleColor)) }
            }
            if card.bottom { flush(bottom: true) }
        }
        flush(bottom: true)
        for (r, c) in pendingRules { c.setFill(); r.fill() }
        pendingRules.removeAll()
        // Marks in a row's indent: a checkbox, a bullet, a number.
        for p in paras where p.chars.length > 0 || p.chars.location < storage.length {
            let loc = min(p.chars.location, storage.length - 1)
            guard let mark = storage.attribute(.edMark, at: loc, effectiveRange: nil) as? MarkPaint, storage.attribute(.edHidden, at: loc, effectiveRange: nil) == nil else { continue }
            let used = p.firstUsed.offsetBy(dx: origin.x, dy: origin.y)
            drawMark(mark, x: origin.x + mark.x, line: used)
        }
        // Pills: inline code, attachment chips.
        storage.enumerateAttribute(.edPill, in: characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)) { v, range, _ in
            guard let pill = v as? PillPaint, let container = textContainers.first else { return }
            let g = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            enumerateEnclosingRects(forGlyphRange: g, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { r, _ in
                let box = r.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -4, dy: 2)
                let path = NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4)
                pill.fill.setFill(); path.fill()
                if let b = pill.border { b.setStroke(); path.lineWidth = 1; path.stroke() }
            }
        }
    }
    private var pendingRules: [(NSRect, NSColor)] = []

    func fillCard(_ rect: NSRect, top: Bool, bottom: Bool, card: CardPaint) {
        let r = card.radius
        let path = NSBezierPath()
        let tl = top ? r : 0, bl = bottom ? r : 0
        path.move(to: NSPoint(x: rect.minX + tl, y: rect.minY))
        path.line(to: NSPoint(x: rect.maxX - tl, y: rect.minY))
        if tl > 0 { path.appendArc(withCenter: NSPoint(x: rect.maxX - tl, y: rect.minY + tl), radius: tl, startAngle: 270, endAngle: 0) }
        path.line(to: NSPoint(x: rect.maxX, y: rect.maxY - bl))
        if bl > 0 { path.appendArc(withCenter: NSPoint(x: rect.maxX - bl, y: rect.maxY - bl), radius: bl, startAngle: 0, endAngle: 90) }
        path.line(to: NSPoint(x: rect.minX + bl, y: rect.maxY))
        if bl > 0 { path.appendArc(withCenter: NSPoint(x: rect.minX + bl, y: rect.maxY - bl), radius: bl, startAngle: 90, endAngle: 180) }
        path.line(to: NSPoint(x: rect.minX, y: rect.minY + tl))
        if tl > 0 { path.appendArc(withCenter: NSPoint(x: rect.minX + tl, y: rect.minY + tl), radius: tl, startAngle: 180, endAngle: 270) }
        path.close()
        card.fill.setFill(); path.fill()
        if let b = card.border { b.setStroke(); path.lineWidth = 1; path.stroke() }
    }

    func drawMark(_ mark: MarkPaint, x: CGFloat, line: NSRect) {
        switch mark.kind {
        case .checkbox(let done):
            // 16×16, radius 4, 1.5px #c9c9c9; checked: filled #0070f3 with a white tick.
            let box = NSRect(x: x + 0.75, y: line.midY - 8 + 0.75, width: 14.5, height: 14.5)
            let path = NSBezierPath(roundedRect: box, xRadius: 3.5, yRadius: 3.5)
            (done ? Look.blue : NSColor.white).setFill(); path.fill()
            (done ? Look.blue : NSColor(hex: "#c9c9c9")).setStroke(); path.lineWidth = 1.5; path.stroke()
            if done {
                let tick = NSBezierPath()
                let o = NSPoint(x: box.midX - 5, y: box.midY - 5)
                tick.move(to: NSPoint(x: o.x + 2.5 * 10 / 12, y: o.y + 6.4 * 10 / 12))
                tick.line(to: NSPoint(x: o.x + 5 * 10 / 12, y: o.y + 8.8 * 10 / 12))
                tick.line(to: NSPoint(x: o.x + 9.5 * 10 / 12, y: o.y + 3.4 * 10 / 12))
                tick.lineWidth = 2; tick.lineCapStyle = .round; tick.lineJoinStyle = .round
                NSColor.white.setStroke(); tick.stroke()
            }
        case .bullet:
            let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(Look.body), .foregroundColor: Look.grey]
            let s = ("\u{2022}" as NSString).size(withAttributes: a)
            ("\u{2022}" as NSString).draw(at: NSPoint(x: x + (mark.width - s.width) / 2, y: line.midY - s.height / 2), withAttributes: a)
        case .number(let n):
            let a: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: Look.body, weight: .regular), .foregroundColor: Look.grey]
            let s = (n as NSString).size(withAttributes: a)
            (n as NSString).draw(at: NSPoint(x: x + mark.width - s.width, y: line.midY - s.height / 2), withAttributes: a)
        }
    }

    override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first else { return }
        storage.enumerateAttribute(.edIcon, in: characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)) { v, range, _ in
            guard let icon = v as? IconPaint else { return }
            let g = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let r = boundingRect(forGlyphRange: g, in: container).offsetBy(dx: origin.x, dy: origin.y)
            let color = (storage.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? NSColor) ?? Look.blue
            let img = Glyphs.mentionIcon(icon.icon, size: icon.size, color: color)
            let side = icon.size * 0.8
            let baseY = r.minY + location(forGlyphAt: g.location).y
            img.draw(in: NSRect(x: r.maxX - icon.size * 1.1 + icon.size * 0.1, y: baseY - side + icon.size * 0.06, width: side, height: side))
        }
    }
}
