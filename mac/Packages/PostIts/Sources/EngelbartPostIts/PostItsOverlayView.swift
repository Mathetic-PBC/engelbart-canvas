import AppKit

/// The layer the cards live in (Electron: the window's content view, where each card was a WebContentsView above the
/// page). It fills the window's content, above the workspace and below every floating panel (those are child windows),
/// so a panel opened over a card covers it natively. Presses anywhere off the cards fall through to the workspace.
public final class PostItsOverlayView: NSView {
    weak var controller: PostItsController?
    public override var isFlipped: Bool { true }

    public override init(frame: NSRect) {
        super.init(frame: frame)
        DriveTag.mark(self, "post-its")
    }
    required init?(coder: NSCoder) { fatalError() }

    public override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }
        let local = convert(point, from: superview)
        for card in subviews.reversed() where !card.isHidden {
            if let hit = card.hitTest(local) { return hit }
        }
        return nil
    }

    public override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize != frame.size
        super.setFrameSize(newSize)
        if changed { controller?.layout() } // index.cjs: win.on('resize') → postItViews.layout()
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        controller?.windowChanged()
    }

    public override func accessibilityRole() -> NSAccessibility.Role? { .group }
    public override func accessibilityIdentifier() -> String { "post-its" }
}
