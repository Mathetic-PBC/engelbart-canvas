import AppKit
import EngelbartUI

// Wider resize edges (ui/WindowEdges.jsx + main/window-edges.cjs, 2026-09-23): macOS gives a hidden-title-bar window only
// a thin band at its frame, and the Stage's native page view would take the rest, so strips lie along the left, right
// and bottom edges over everything. A press takes the pointer; every move after it re-reads the cursor in screen
// coordinates, so the window moving under the pointer never skews the arithmetic. The top edge is the title bar's: it
// drags the window and keeps macOS's own band for resizing. No strips in full screen.

public enum EdgeStrips {
    public static let edge: CGFloat = 6
    public static let corner: CGFloat = 14

    /// Each strip's rect in a content view of `size` (y down), as WindowEdges.jsx lays them out.
    public static func rects(in size: CGSize) -> [(WindowGeometry.Edge, CGRect)] {
        let w = size.width, h = size.height, e = edge, c = corner, top = EngelbartWindow.headerHeight
        return [
            (.left, CGRect(x: 0, y: top, width: e, height: max(0, h - top - c))),
            (.right, CGRect(x: w - e, y: top, width: e, height: max(0, h - top - c))),
            (.bottom, CGRect(x: c, y: h - e, width: max(0, w - 2 * c), height: e)),
            (.bottomLeft, CGRect(x: 0, y: h - c, width: c, height: c)),
            (.bottomRight, CGRect(x: w - c, y: h - c, width: c, height: c)),
        ]
    }
}

final class EdgeStripView: NSView {
    let edge: WindowGeometry.Edge
    private var start: CGRect?
    private var from: CGPoint = .zero

    init(edge: WindowGeometry.Edge) {
        self.edge = edge
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var cursor: NSCursor {
        switch edge {
        case .left, .right: return .resizeLeftRight
        case .bottom: return .resizeUpDown
        case .bottomLeft, .bottomRight:
            if #available(macOS 15.0, *) {
                return NSCursor.frameResize(position: edge == .bottomLeft ? .bottomLeft : .bottomRight, directions: .all)
            }
            return .crosshair
        }
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }

    private var mainHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    override func mouseDown(with event: NSEvent) {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        start = WindowGeometry.yDown(window.frame, mainHeight: mainHeight)
        from = NSEvent.mouseLocation
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let start else { return }
        let now = NSEvent.mouseLocation
        let next = WindowGeometry.resizedBounds(start, edge: edge, dx: now.x - from.x, dy: -(now.y - from.y),
                                                min: CGSize(width: window.minSize.width, height: window.minSize.height))
        window.setFrame(WindowGeometry.yUp(next, mainHeight: mainHeight), display: true)
    }

    override func mouseUp(with event: NSEvent) { start = nil }
}

/// The window's content: the root view, with the strips over it.
public final class WindowContentView: NSView {
    let root: NSView
    private var strips: [EdgeStripView] = []
    public var stripsHidden = false { didSet { strips.forEach { $0.isHidden = stripsHidden }; needsLayout = true } }

    public init(root: NSView) {
        self.root = root
        super.init(frame: .zero)
        addSubview(root)
        for edge in WindowGeometry.Edge.allCases {
            let strip = EdgeStripView(edge: edge)
            strips.append(strip)
            addSubview(strip)
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    public override var isFlipped: Bool { true }

    public override func layout() {
        super.layout()
        root.frame = bounds
        let rects = Dictionary(uniqueKeysWithValues: EdgeStrips.rects(in: bounds.size).map { ($0.0, $0.1) })
        for strip in strips {
            strip.frame = rects[strip.edge] ?? .zero
            window?.invalidateCursorRects(for: strip)
        }
    }

    /// Keeps the strips on top when a screen adds native views of its own.
    public override func didAddSubview(_ subview: NSView) {
        super.didAddSubview(subview)
        if !(subview is EdgeStripView), subview !== root { strips.forEach { addSubview($0, positioned: .above, relativeTo: nil) } }
    }
}
