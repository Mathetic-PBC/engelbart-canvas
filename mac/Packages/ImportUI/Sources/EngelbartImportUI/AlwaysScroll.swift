import AppKit
import SwiftUI

// The picker's list (2026-10-23, round4-css .picker-scroll): it scrolls in a box of its own under the title, with a
// scrollbar that is always drawn (macOS hid its own overlay bar until a scroll began, so nothing said there was more):
// 10 wide, its track #f2f2f2 radius 5, its thumb #c2c2c2 (#999 under the pointer) inset 2, 12 of room left of it.

/// A legacy (always shown) scroller drawn as the CSS's webkit scrollbar.
final class PickerScroller: NSScroller {
    var hot = false
    override class var isCompatibleWithOverlayScrollers: Bool { false }
    override class func scrollerWidth(for controlSize: NSControl.ControlSize, scrollerStyle: NSScroller.Style) -> CGFloat { 10 }
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {
        NSColor(hex: "#f2f2f2").setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
    }
    override func drawKnob() {
        let knob = rect(for: .knob).insetBy(dx: 2, dy: 2)
        guard knob.height > 0 else { return }
        (hot ? NSColor(hex: "#999999") : NSColor(hex: "#c2c2c2")).setFill()
        NSBezierPath(roundedRect: knob, xRadius: 3, yRadius: 3).fill()
    }
    override func draw(_ dirtyRect: NSRect) {
        drawKnobSlot(in: bounds, highlight: false)
        drawKnob()
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hot = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hot = false; needsDisplay = true }
}

final class FlippedClip: NSClipView { override var isFlipped: Bool { true } }

/// An NSScrollView around SwiftUI content whose vertical scroller is always shown (PickerScroller).
public struct AlwaysScroll<Content: View>: NSViewRepresentable {
    let content: Content
    let id: String
    public init(id: String = "picker-scroll", @ViewBuilder content: () -> Content) { self.id = id; self.content = content() }

    public func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.identifier = NSUserInterfaceItemIdentifier(id)
        scroll.setAccessibilityIdentifier(id)
        scroll.contentView = FlippedClip()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = false
        scroll.scrollerStyle = .legacy
        scroll.verticalScroller = PickerScroller()
        scroll.verticalScroller?.scrollerStyle = .legacy
        let host = NSHostingView(rootView: AnyView(content))
        host.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = host
        let clip = scroll.contentView
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            host.topAnchor.constraint(equalTo: clip.topAnchor),
            host.widthAnchor.constraint(equalTo: clip.widthAnchor),
        ])
        return scroll
    }

    public func updateNSView(_ scroll: NSScrollView, context: Context) {
        (scroll.documentView as? NSHostingView<AnyView>)?.rootView = AnyView(content)
        scroll.scrollerStyle = .legacy
    }
}
