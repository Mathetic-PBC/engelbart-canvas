import AppKit
import EngelbartUI

// Small AppKit pieces the screen is drawn with: a flipped view with a fill, a label, an icon button (`.sb-icon`, the +,
// the full-screen button), a text button (FOOT_BUTTON with `.hov-ink`). Values are the CSS's, 1 px = 1 pt.

/// A flipped view that fills itself (and optionally rounds its corners and draws a ring).
public class FillView: NSView {
    public var fill: NSColor? { didSet { needsDisplay = true } }
    public var corners: (tl: CGFloat, tr: CGFloat, br: CGFloat, bl: CGFloat) = (0, 0, 0, 0) { didSet { needsDisplay = true } }
    public var ring: NSColor? { didSet { needsDisplay = true } }
    public override var isFlipped: Bool { true }
    public override func draw(_ dirtyRect: NSRect) {
        guard let fill else { return }
        let path = Self.rounded(bounds, corners)
        fill.setFill()
        path.fill()
        if let ring { ring.setStroke(); path.lineWidth = 1; path.stroke() }
    }
    static func rounded(_ r: NSRect, _ c: (tl: CGFloat, tr: CGFloat, br: CGFloat, bl: CGFloat)) -> NSBezierPath {
        let p = NSBezierPath()
        p.move(to: NSPoint(x: r.minX + c.tl, y: r.minY))
        p.line(to: NSPoint(x: r.maxX - c.tr, y: r.minY))
        if c.tr > 0 { p.appendArc(withCenter: NSPoint(x: r.maxX - c.tr, y: r.minY + c.tr), radius: c.tr, startAngle: 270, endAngle: 360) }
        p.line(to: NSPoint(x: r.maxX, y: r.maxY - c.br))
        if c.br > 0 { p.appendArc(withCenter: NSPoint(x: r.maxX - c.br, y: r.maxY - c.br), radius: c.br, startAngle: 0, endAngle: 90) }
        p.line(to: NSPoint(x: r.minX + c.bl, y: r.maxY))
        if c.bl > 0 { p.appendArc(withCenter: NSPoint(x: r.minX + c.bl, y: r.maxY - c.bl), radius: c.bl, startAngle: 90, endAngle: 180) }
        p.line(to: NSPoint(x: r.minX, y: r.minY + c.tl))
        if c.tl > 0 { p.appendArc(withCenter: NSPoint(x: r.minX + c.tl, y: r.minY + c.tl), radius: c.tl, startAngle: 180, endAngle: 270) }
        p.close()
        return p
    }
}

enum Look {
    static let ink = Palette.gray900
    static let mut = Palette.gray700
    static let fnt = Palette.gray500
    static let line = Palette.gray200 // #eaeaea
    static let bd2 = Palette.gray300 // #c9c9c9
    static let ground = Palette.gray50 // #fafafa
    static let tabHover = NSColor(hex: "#e6e6e6")
    static let xHover = NSColor(hex: "#e3e3e3")
    static let iconIdle = NSColor(hex: "#5c5c5c")
    static let iconHover = NSColor(hex: "#ececec")
    static let wash2 = Palette.gray200
    static let rowOn = Palette.gray150 // #f2f2f2
    static let red = Palette.red600
    /// cubic-bezier(.25,.1,.25,1), the app's ease.
    static let ease = CAMediaTimingFunction(controlPoints: 0.25, 0.1, 0.25, 1)
}

/// A one-line label (no editing, no background).
func makeLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.font = font
    l.textColor = color
    l.lineBreakMode = .byClipping
    l.maximumNumberOfLines = 1
    l.cell?.truncatesLastVisibleLine = false
    return l
}

/// A button drawn as the CSS draws it: a hover wash or a hover ink, an icon or a word. Presses call `action`.
public final class FlatButton: NSView {
    public enum Face { case icon(Icon, size: CGFloat), text(String, font: NSFont) }
    var face: Face { didSet { needsDisplay = true; invalidateIntrinsicContentSize() } }
    var color: NSColor { didSet { needsDisplay = true } }
    var hoverColor: NSColor?
    var hoverFill: NSColor?
    var radius: CGFloat
    var pressedOn = false { didSet { needsDisplay = true } }
    var onFill: NSColor?
    var action: (() -> Void)?
    var hovering = false { didSet { needsDisplay = true } }
    var tracking: NSTrackingArea?
    var padding = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

    init(_ face: Face, color: NSColor, hoverColor: NSColor? = nil, hoverFill: NSColor? = nil, radius: CGFloat = 6, id: String? = nil, tip: String? = nil, action: (() -> Void)? = nil) {
        self.face = face; self.color = color; self.hoverColor = hoverColor; self.hoverFill = hoverFill; self.radius = radius; self.action = action
        super.init(frame: .zero)
        if let id { setAccessibilityIdentifier(id) }
        if let tip { toolTip = tip }
        setAccessibilityRole(.button)
        if case .text(let s, _) = face { setAccessibilityLabel(s) }
    }
    required init?(coder: NSCoder) { fatalError() }
    public override var isFlipped: Bool { true }
    public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    public override var mouseDownCanMoveWindow: Bool { false }
    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
    }
    public override func mouseEntered(with event: NSEvent) { hovering = true }
    public override func mouseExited(with event: NSEvent) { hovering = false }
    public override func mouseDown(with event: NSEvent) {}
    public override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { action?() }
    }
    public override func accessibilityPerformPress() -> Bool { action?(); return true }
    var text: String? { if case .text(let s, _) = face { return s }; return nil }
    public override var intrinsicContentSize: NSSize {
        switch face {
        case .icon(_, let size): return NSSize(width: size, height: size)
        case .text(let s, let font):
            let w = (s as NSString).size(withAttributes: [.font: font]).width
            return NSSize(width: ceil(w) + padding.left + padding.right, height: ceil(font.ascender - font.descender + font.leading) + padding.top + padding.bottom)
        }
    }
    public override func draw(_ dirtyRect: NSRect) {
        if (hovering || pressedOn), let fill = pressedOn ? (onFill ?? hoverFill) : hoverFill {
            fill.setFill(); NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        }
        let c = (hovering || pressedOn) ? (hoverColor ?? color) : color
        switch face {
        case .icon(let icon, let size):
            guard let ctx = NSGraphicsContext.current?.cgContext else { return }
            ctx.saveGState()
            ctx.translateBy(x: ((bounds.width - size) / 2).rounded(), y: ((bounds.height - size) / 2).rounded())
            icon.draw(in: ctx, side: size, color: c.cgColor)
            ctx.restoreGState()
        case .text(let s, let font):
            let size = (s as NSString).size(withAttributes: [.font: font])
            let y = ((bounds.height - size.height) / 2)
            (s as NSString).draw(at: NSPoint(x: padding.left, y: y), withAttributes: [.font: font, .foregroundColor: c])
        }
    }
}

/// The header drags the window; its buttons do not (`.title-bar` + `[data-no-drag]`). A double click does what System
/// Settings says (zoom or minimize).
class TitleDragView: FillView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            switch TitleBarDoubleClick.action() {
            case .minimize: window?.performMiniaturize(nil)
            case .zoom: window?.performZoom(nil)
            case .none: break
            }
            return
        }
        window?.performDrag(with: event)
    }
}
