import AppKit
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

/// A note's @ menu (the workspace's MentionMenu, as a note opens it): library items, Bart at the start of a highlight's
/// note, a library folder's levels; ↑ ↓ move, Enter or Tab picks, a click picks.
final class MentionMenuView: NSView {
    var rows: [MentionRow] = [] { didSet { needsLayout = true; needsDisplay = true } }
    var index = 0 { didSet { needsDisplay = true } }
    var onPick: ((MentionRow) -> Void)?
    var onHover: ((Int) -> Void)?
    static let rowH: CGFloat = 30, width: CGFloat = 280, maxRows = 8
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.cornerRadius = 10
        layer?.borderWidth = 1; layer?.borderColor = NSColor(hex: "#eaeaea").cgColor
        layer?.shadowColor = NSColor.black.cgColor; layer?.shadowOpacity = 0.08; layer?.shadowRadius = 12; layer?.shadowOffset = CGSize(width: 0, height: -8)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { false }
    var preferredSize: NSSize { NSSize(width: Self.width, height: CGFloat(min(rows.count, Self.maxRows)) * Self.rowH + 8) }
    private var scrollTop = 0
    override func draw(_ dirtyRect: NSRect) {
        if index < scrollTop { scrollTop = index }
        if index >= scrollTop + Self.maxRows { scrollTop = index - Self.maxRows + 1 }
        for (k, i) in (scrollTop..<min(rows.count, scrollTop + Self.maxRows)).enumerated() {
            let r = NSRect(x: 4, y: 4 + CGFloat(k) * Self.rowH, width: bounds.width - 8, height: Self.rowH)
            let row = rows[i]
            if i == index && row.kind != .note { NSColor(hex: "#f2f2f2").setFill(); NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).fill() }
            let name = row.kind == .back ? "‹ \(row.name)" : row.kind == .item || row.kind == .verb ? "@\(row.name)" : row.name
            let color = row.kind == .note ? NSColor(hex: "#8f8f8f") : row.kind == .verb ? NSColor(hex: "#0070f3") : NSColor(hex: "#171717")
            let font = Fonts.sans(13, weight: row.kind == .verb ? 500 : 400)
            let p = NSMutableParagraphStyle(); p.lineBreakMode = .byTruncatingMiddle
            let hintW: CGFloat = row.hint.isEmpty ? 0 : min(110, ceil((row.hint as NSString).size(withAttributes: [.font: Fonts.sans(12)]).width))
            (name as NSString).draw(in: NSRect(x: r.minX + 10, y: r.minY + 7, width: r.width - 20 - hintW - (hintW > 0 ? 8 : 0), height: 17), withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: p])
            if hintW > 0 {
                let hp = NSMutableParagraphStyle(); hp.lineBreakMode = .byTruncatingHead; hp.alignment = .right
                (row.hint as NSString).draw(in: NSRect(x: r.maxX - 10 - hintW, y: r.minY + 8, width: hintW, height: 16), withAttributes: [.font: Fonts.sans(12), .foregroundColor: NSColor(hex: "#8f8f8f"), .paragraphStyle: hp])
            }
        }
    }
    private func rowAt(_ e: NSEvent) -> Int? {
        let p = convert(e.locationInWindow, from: nil)
        let i = scrollTop + Int((p.y - 4) / Self.rowH)
        return i >= 0 && i < rows.count ? i : nil
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseMoved(with event: NSEvent) { if let i = rowAt(event), i != index { onHover?(i) } }
    override func mouseDown(with event: NSEvent) { if let i = rowAt(event) { onPick?(rows[i]) } }
    override func scrollWheel(with event: NSEvent) {
        scrollTop = max(0, min(max(0, rows.count - Self.maxRows), scrollTop - Int(event.scrollingDeltaY / 10)))
        needsDisplay = true
    }
}

extension NSFont {
    /// font-variant-numeric: tabular-nums
    var withTabularDigits: NSFont {
        let d = fontDescriptor.addingAttributes([.featureSettings: [[NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType, NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector]]])
        return NSFont(descriptor: d, size: pointSize) ?? self
    }
}
