import AppKit

// The paper's scrolling surface (PaperView's host div and its inner wrapper): an NSScrollView whose document is the
// column of sheets, with the cards' layer above every sheet. A pinch is the scroll view's magnification (a bounds scale
// the compositor draws, as the CSS transform was); the clip view keeps a narrower paper in the middle across and at the
// top (pinchTransform: no white band above page 1 while a pinch zooms out).

@MainActor protocol PaperCanvasOwner: AnyObject {
    func canvasMouseDown(_ e: NSEvent)
    func canvasMouseDragged(_ e: NSEvent)
    func canvasMouseUp(_ e: NSEvent)
    func canvasKeyDown(_ e: NSEvent) -> Bool
    func canvasKeyEquivalent(_ e: NSEvent) -> Bool
    func canvasMouseMoved(_ e: NSEvent)
    /// A trackpad pinch (magnification) or ⌘ / ⌃ + scroll: true when it zoomed.
    func canvasZoomWheel(_ e: NSEvent) -> Bool
    func canvasMagnify(_ e: NSEvent)
}

final class CenteringClipView: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var r = super.constrainBoundsRect(proposedBounds)
        guard let doc = documentView else { return r }
        if doc.frame.width < r.width { r.origin.x = (doc.frame.width - r.width) / 2 }
        if doc.frame.height < r.height { r.origin.y = 0 }
        return r
    }
}

final class PaperScrollView: NSScrollView {
    weak var owner: PaperCanvasOwner?
    override func scrollWheel(with event: NSEvent) {
        // ⌃ scroll and ⌘ scroll zoom (paper-zoom.js wheelZooms); a trackpad pinch comes as magnify events.
        if event.modifierFlags.contains(.control) || event.modifierFlags.contains(.command), let owner, owner.canvasZoomWheel(event) { return }
        super.scrollWheel(with: event)
    }
    override func magnify(with event: NSEvent) { owner?.canvasMagnify(event) }
    override func smartMagnify(with event: NSEvent) {}
}

/// The document view: sheets top to bottom, then the cards' layer.
final class PaperCanvas: NSView {
    weak var owner: PaperCanvasOwner?
    /// Cards and their move handles, above every sheet.
    let cardsLayer = CardsLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        cardsLayer.frame = bounds
        cardsLayer.autoresizingMask = [.width, .height]
        addSubview(cardsLayer)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The cards' layer kept above the sheets added after it.
    func addSheet(_ s: SheetView) { addSubview(s, positioned: .below, relativeTo: cardsLayer) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect, .cursorUpdate], owner: self))
    }
    override func cursorUpdate(with event: NSEvent) { NSCursor.iBeam.set() } // [data-pdf] [data-page] { cursor: text }
    override func mouseMoved(with event: NSEvent) { owner?.canvasMouseMoved(event) }
    override func mouseDown(with event: NSEvent) { owner?.canvasMouseDown(event) }
    override func mouseDragged(with event: NSEvent) { owner?.canvasMouseDragged(event) }
    override func mouseUp(with event: NSEvent) { owner?.canvasMouseUp(event) }
    override func rightMouseDown(with event: NSEvent) { owner?.canvasMouseDown(event) }
    override func rightMouseUp(with event: NSEvent) { owner?.canvasMouseUp(event) }
    override func keyDown(with event: NSEvent) {
        if let owner, owner.canvasKeyDown(event) { return }
        // Space is never the paper's: it scrolls the pane, as the page's default did (⇧Space back up).
        if event.charactersIgnoringModifiers == " " {
            if event.modifierFlags.contains(.shift) { scrollPageUp(nil) } else { scrollPageDown(nil) }
            return
        }
        interpretKeyEvents([event])
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, let owner, owner.canvasKeyEquivalent(event) { return true }
        return super.performKeyEquivalent(with: event)
    }
    override func moveUp(_ sender: Any?) { scrollBy(dy: -40) }
    override func moveDown(_ sender: Any?) { scrollBy(dy: 40) }
    override func scrollPageUp(_ sender: Any?) { scrollBy(dy: -(enclosingScrollView?.contentView.bounds.height ?? 400) * 0.875) }
    override func scrollPageDown(_ sender: Any?) { scrollBy(dy: (enclosingScrollView?.contentView.bounds.height ?? 400) * 0.875) }
    override func pageUp(_ sender: Any?) { scrollPageUp(sender) }
    override func pageDown(_ sender: Any?) { scrollPageDown(sender) }
    override func scrollToBeginningOfDocument(_ sender: Any?) { scroll(NSPoint(x: visibleRect.minX, y: 0)) }
    override func scrollToEndOfDocument(_ sender: Any?) { scroll(NSPoint(x: visibleRect.minX, y: bounds.height)) }
    private func scrollBy(dy: CGFloat) {
        guard let clip = enclosingScrollView?.contentView else { return }
        var o = clip.bounds.origin
        o.y = max(0, min(bounds.height - clip.bounds.height, o.y + dy))
        clip.scroll(to: o); enclosingScrollView?.reflectScrolledClipView(clip)
    }
}

/// Holds the cards; a press anywhere but on a card goes through to the paper.
final class CardsLayer: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let v = super.hitTest(point)
        return v === self ? nil : v
    }
}
