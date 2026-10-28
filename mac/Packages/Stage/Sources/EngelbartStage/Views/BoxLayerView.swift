import AppKit
import EngelbartUI

// The drawing layer for boxes (MATH-70; src/main/browser/box-layer-preload.cjs), native: laid over a page only while a box
// is being drawn. A drag draws the box (done, in the view's points); a click that does not drag (under MIN) is a click
// (the page is asked which box's edge it is on); Esc cancels; ⌥ let go cancels unless a drag is under way, which finishes
// on mouse up. It looks like macOS's ⌘⇧4 (2026-10-17, David: smaller and lighter): the system cursor hidden, a 21-point
// crosshair of white 1pt lines over a 1pt half-black halo round a small faint circle; the readout is two numbers stacked
// on a small dark pill (11pt, 500), the pointer's screen place before the press and the rectangle's size while dragging,
// in points; the rectangle a 1pt white edge with its halo outside and a 6% grey tint.

final class BoxLayerView: NSView {
    var onDone: ((CGRect) -> Void)?
    var onClick: ((CGPoint) -> Void)?
    var onCancel: (() -> Void)?

    private var from: CGPoint?
    private var rect: CGRect?
    private var pointer: CGPoint?
    private var screenPoint: CGPoint?
    private var mode = "button"
    private var altGone = false
    private var tracking: NSTrackingArea?
    private var cursorHidden = false

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func start(mode: String) {
        self.mode = mode == "alt" ? "alt" : "button"
        from = nil; rect = nil; altGone = false
        // where the pointer is as the layer comes up, so the numbers show before it moves
        if let window {
            let p = convert(window.mouseLocationOutsideOfEventStream, from: nil)
            if bounds.contains(p) { pointer = p; screenPoint = NSEvent.mouseLocation; hideCursor() } else { pointer = nil }
        }
        needsDisplay = true
    }

    func stop() { from = nil; rect = nil; pointer = nil; showCursor(); needsDisplay = true }

    /// ⌥ let go: the layer goes, unless a box is being drawn, which is finished when the mouse is let go.
    func altUp() { if from != nil { altGone = true } else { finish { self.onCancel?() } } }

    private func finish(_ then: () -> Void) { pointer = nil; showCursor(); from = nil; rect = nil; altGone = false; needsDisplay = true; then() }

    private func hideCursor() { if !cursorHidden { NSCursor.hide(); cursorHidden = true } }
    private func showCursor() { if cursorHidden { NSCursor.unhide(); cursorHidden = false } }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    private func track(_ event: NSEvent) { pointer = convert(event.locationInWindow, from: nil); screenPoint = NSEvent.mouseLocation; hideCursor() }

    override func mouseDown(with event: NSEvent) {
        track(event)
        from = pointer
        rect = CGRect(origin: pointer ?? .zero, size: .zero)
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        track(event)
        if let from, let p = pointer {
            let x = max(0, min(p.x, bounds.width)), y = max(0, min(p.y, bounds.height))
            rect = CGRect(x: min(from.x, x), y: min(from.y, y), width: abs(x - from.x), height: abs(y - from.y))
        }
        needsDisplay = true
    }

    override func mouseMoved(with event: NSEvent) { track(event); needsDisplay = true }
    override func mouseExited(with event: NSEvent) { if from == nil { pointer = nil; showCursor(); needsDisplay = true } }

    override func mouseUp(with event: NSEvent) {
        guard let from else { return }
        let drawn = rect ?? .zero
        if drawn.width >= BoxLayerLook.min && drawn.height >= BoxLayerLook.min { finish { onDone?(drawn) } } else { finish { onClick?(from) } }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { finish { onCancel?() }; return } // Esc
        super.keyDown(with: event)
    }

    override func flagsChanged(with event: NSEvent) {
        if mode == "alt" && !event.modifierFlags.contains(.option) { altUp() }
        super.flagsChanged(with: event)
    }

    override func resignFirstResponder() -> Bool {
        if from != nil { from = nil; rect = nil; needsDisplay = true }
        return super.resignFirstResponder()
    }

    static let line = NSColor.white
    static let halo = NSColor(white: 0, alpha: 0.5)
    static let tint = NSColor(white: 128 / 255, alpha: 0.06)

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill(); dirtyRect.fill()
        if let rect, rect.width > 0 || rect.height > 0 {
            BoxLayerView.tint.setFill(); rect.fill()
            BoxLayerView.halo.setStroke()
            let outer = NSBezierPath(rect: rect.insetBy(dx: -0.5, dy: -0.5)); outer.lineWidth = 1; outer.stroke()
            BoxLayerView.line.setStroke()
            let inner = NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5)); inner.lineWidth = 1; inner.stroke()
        }
        guard let p = pointer else { return }
        let c = CGPoint(x: p.x.rounded(), y: p.y.rounded())
        let half = BoxLayerLook.cross / 2
        NSColor(white: 128 / 255, alpha: 0.22).setFill()
        NSBezierPath(ovalIn: CGRect(x: c.x - BoxLayerLook.circle / 2 + 0.5, y: c.y - BoxLayerLook.circle / 2 + 0.5, width: BoxLayerLook.circle - 1, height: BoxLayerLook.circle - 1)).fill()
        for (color, width) in [(BoxLayerView.halo, CGFloat(3)), (BoxLayerView.line, CGFloat(1))] {
            let path = NSBezierPath()
            path.move(to: CGPoint(x: c.x - half, y: c.y + 0.5)); path.line(to: CGPoint(x: c.x + half + 1, y: c.y + 0.5))
            path.move(to: CGPoint(x: c.x + 0.5, y: c.y - half)); path.line(to: CGPoint(x: c.x + 0.5, y: c.y + half + 1))
            path.lineWidth = width; color.setStroke(); path.stroke()
        }
        let screen = screenPoint ?? .zero
        let screenY = (NSScreen.screens.first?.frame.maxY ?? 0) - screen.y // the readout counts from the top, as the screen's points
        let numbers = BoxLayerLook.readout(dragging: (rect?.width ?? 0) > 0 || (rect?.height ?? 0) > 0, screenX: screen.x, screenY: screenY, w: rect?.width ?? 0, h: rect?.height ?? 0)
        let text = NSAttributedString(string: numbers.joined(separator: "\n"), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.white,
            .paragraphStyle: { let p = NSMutableParagraphStyle(); p.lineHeightMultiple = 1.0; p.minimumLineHeight = 13.2; p.maximumLineHeight = 13.2; return p }(),
        ])
        let size = text.size()
        let pill = CGSize(width: size.width + 10, height: size.height + 4)
        let at = BoxLayerLook.readoutAt(x: c.x, y: c.y, size: pill, view: bounds.size)
        NSColor(white: 0, alpha: 0.72).setFill()
        NSBezierPath(roundedRect: CGRect(origin: at, size: pill), xRadius: 4, yRadius: 4).fill()
        text.draw(at: CGPoint(x: at.x + 5, y: at.y + 2))
    }
}
