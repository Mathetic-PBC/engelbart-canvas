import AppKit
import EngelbartUI

/// A footer word on a card (face.css .postit-btn / .postit-word, Claude Design "Post-it Quick Task", 2026-09-27): plain
/// text and glyphs on the yellow, no background, #705717 that darkens to ink on hover; `strong` ones are ink always.
/// 500 12 px, the parts 5 apart (6 when strong), 22 high.
final class PostItButton: NSView {
    enum Part: Equatable {
        case icon(Icon)
        case text(String)
        /// The state word: at most 120 wide, cut with an ellipsis.
        case word(String)
        case dots
        static func == (a: Part, b: Part) -> Bool {
            switch (a, b) {
            case (.icon(let x), .icon(let y)): return x.name == y.name
            case (.text(let x), .text(let y)), (.word(let x), .word(let y)): return x == y
            case (.dots, .dots): return true
            default: return false
            }
        }
    }

    var parts: [Part] { didSet { if parts != oldValue { rebuildDots(); invalidateIntrinsicContentSize(); placeDots(); needsDisplay = true } } }
    var strong = false { didSet { needsDisplay = true } }
    var isEnabled = true { didSet { needsDisplay = true } }
    var hovering = false { didSet { needsDisplay = true } }
    var pressed = false
    var onPress: (() -> Void)?
    let label: String
    private var dots: PostItDots?

    override var isFlipped: Bool { true }

    init(parts: [Part], tooltip: String, label: String) {
        self.parts = parts
        self.label = label
        super.init(frame: .zero)
        toolTip = tooltip
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        rebuildDots()
    }
    required init?(coder: NSCoder) { fatalError() }

    static let font = Fonts.sans(12, weight: 500)
    var gap: CGFloat { strong ? 6 : 5 }
    var color: NSColor { strong || (hovering && isEnabled) ? PostItLook.ink : PostItLook.word }

    func width(of part: Part) -> CGFloat {
        switch part {
        case .icon(let icon): return icon.size
        case .text(let s): return ceil((s as NSString).size(withAttributes: [.font: Self.font]).width)
        case .word(let s): return min(120, ceil((s as NSString).size(withAttributes: [.font: Self.font]).width))
        case .dots: return 18
        }
    }

    override var intrinsicContentSize: NSSize {
        let widths = parts.map(width(of:))
        let total = widths.reduce(0, +) + gap * CGFloat(max(0, parts.count - 1))
        return NSSize(width: parts.count == 1 && parts[0].isIcon ? 22 : total, height: 22)
    }

    func rebuildDots() {
        let wants = parts.contains(.dots)
        if wants && dots == nil { let d = PostItDots(); dots = d; addSubview(d) }
        if !wants { dots?.removeFromSuperview(); dots = nil }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        placeDots()
    }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); placeDots() }

    func placeDots() {
        var x: CGFloat = 0
        for part in parts {
            let w = width(of: part)
            if part == .dots { dots?.frame = CGRect(x: x, y: (bounds.height - 6) / 2, width: w, height: 6) }
            x += w + gap
        }
        dots?.color = color
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let ink = color
        dots?.color = ink
        if parts.count == 1, case .icon(let icon) = parts[0] {
            ctx.saveGState()
            ctx.translateBy(x: (bounds.width - icon.size) / 2, y: (bounds.height - icon.size) / 2)
            icon.draw(in: ctx, side: icon.size, color: ink.cgColor)
            ctx.restoreGState()
            return
        }
        var x: CGFloat = 0
        for part in parts {
            let w = width(of: part)
            switch part {
            case .icon(let icon):
                ctx.saveGState()
                ctx.translateBy(x: x, y: (bounds.height - icon.size) / 2)
                icon.draw(in: ctx, side: icon.size, color: ink.cgColor)
                ctx.restoreGState()
            case .text(let s), .word(let s):
                let style = NSMutableParagraphStyle()
                style.lineBreakMode = .byTruncatingTail
                let attrs: [NSAttributedString.Key: Any] = [.font: Self.font, .foregroundColor: ink, .paragraphStyle: style]
                let h = ceil(Self.font.ascender - Self.font.descender)
                (s as NSString).draw(with: CGRect(x: x, y: (bounds.height - h) / 2, width: w, height: h), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
            case .dots: break
            }
            x += w + gap
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func resetCursorRects() { if isEnabled { addCursorRect(bounds, cursor: .pointingHand) } }
    override func mouseDown(with event: NSEvent) { pressed = isEnabled }
    override func mouseUp(with event: NSEvent) {
        defer { pressed = false }
        guard pressed, isEnabled, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onPress?()
    }
    /// A click (also for tests and VoiceOver).
    func press() { if isEnabled { onPress?() } }
    override func accessibilityPerformPress() -> Bool { press(); return true }
    override func accessibilityLabel() -> String? {
        if !label.isEmpty { return label }
        return parts.compactMap { if case .word(let s) = $0 { return s }; return nil }.first
    }
    override func isAccessibilityEnabled() -> Bool { isEnabled }

    /// What it says (the words of its parts).
    var words: String {
        parts.compactMap { switch $0 { case .text(let s), .word(let s): return s; default: return nil } }.joined(separator: " ")
    }
}

extension PostItButton.Part {
    var isIcon: Bool { if case .icon = self { return true }; return false }
}

/// Building's three dots (face.css .postit-dots): 4 px circles 3 apart that rise 2 px in turn, 1.1 s, ease-in-out,
/// delays 0 / .15 / .3 s, opacity .25 → 1.
final class PostItDots: NSView {
    var color: NSColor = PostItLook.word { didSet { if color != oldValue { for d in dotLayers { d.backgroundColor = color.cgColor } } } }
    private var dotLayers: [CALayer] = []
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for i in 0..<3 {
            let d = CALayer()
            d.frame = CGRect(x: CGFloat(i) * 7, y: 1, width: 4, height: 4)
            d.cornerRadius = 2
            d.backgroundColor = color.cgColor
            layer?.addSublayer(d)
            dotLayers.append(d)
            let rise = CAKeyframeAnimation(keyPath: "transform.translation.y")
            rise.values = [0, -2, 0, 0]
            rise.keyTimes = [0, 0.4, 0.8, 1]
            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [0.25, 1, 0.25, 0.25]
            fade.keyTimes = [0, 0.4, 0.8, 1]
            let group = CAAnimationGroup()
            group.animations = [rise, fade]
            group.duration = 1.1
            group.repeatCount = .infinity
            group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            group.beginTime = CACurrentMediaTime() + Double(i) * 0.15
            group.fillMode = .backwards
            d.add(group, forKey: "pdot")
        }
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
}
