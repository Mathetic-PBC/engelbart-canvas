import CoreGraphics

// Where a floating panel goes (model/place.js, 2026-09-22). Every popup used to open under what it hangs from, so near the
// bottom of the window it opened off screen. Now: under it when it fits there, else above it when it fits there, else on
// whichever side has more room, cut to that room (the panel scrolls). Sideways it stays inside the window. All in the
// window's content coordinates, y down (CSS's viewport pixels).

public struct PlaceAnchor: Equatable, Sendable {
    public var left: CGFloat, right: CGFloat, top: CGFloat, bottom: CGFloat
    public init(left: CGFloat, right: CGFloat, top: CGFloat, bottom: CGFloat) { self.left = left; self.right = right; self.top = top; self.bottom = bottom }
    /// From a y-down rect.
    public init(_ rect: CGRect) { self.init(left: rect.minX, right: rect.maxX, top: rect.minY, bottom: rect.maxY) }
}

public struct PlaceSpot: Equatable, Sendable {
    public var left: CGFloat, top: CGFloat
    /// nil when the panel fits whole.
    public var maxHeight: CGFloat?
    public init(left: CGFloat, top: CGFloat, maxHeight: CGFloat?) { self.left = left; self.top = top; self.maxHeight = maxHeight }
}

public enum PlaceAlign: Sendable { case start, end }
public enum PlaceSide: Sendable { case below, right }

public enum Placement {
    /// `place(anchor, size, view, { gap, margin, align, side })`.
    public static func place(_ anchor: PlaceAnchor, size: CGSize, view: CGSize, gap: CGFloat = 6, margin: CGFloat = 8,
                             align: PlaceAlign = .start, side: PlaceSide = .below) -> PlaceSpot {
        if side == .right { return beside(anchor, size: size, view: view, gap: gap, margin: margin) }
        let below = view.height - margin - (anchor.bottom + gap)
        let above = anchor.top - gap - margin
        var top: CGFloat
        var maxHeight: CGFloat? = nil
        if size.height <= below { top = anchor.bottom + gap }
        else if size.height <= above { top = anchor.top - gap - size.height }
        else if below >= above { maxHeight = max(0, below); top = anchor.bottom + gap }
        else { maxHeight = max(0, above); top = anchor.top - gap - maxHeight! }
        let x = align == .end ? anchor.right - size.width : anchor.left
        let left = max(margin, min(x, view.width - size.width - margin))
        return PlaceSpot(left: left, top: top, maxHeight: maxHeight)
    }

    /// `placeBeside`: to the right of what it hangs from (the sidebar's panels, 2026-10-07: "a (not centered) scrollable
    /// modal next to that (to the right)"), its top at the anchor's top, moved up as far as it must to stay in the window,
    /// cut to the window's height when taller. With no room on the right it goes on the left.
    public static func beside(_ anchor: PlaceAnchor, size: CGSize, view: CGSize, gap: CGFloat = 8, margin: CGFloat = 8) -> PlaceSpot {
        let room = view.height - 2 * margin
        let maxHeight: CGFloat? = size.height > room ? max(0, room) : nil
        let height = maxHeight ?? size.height
        let top = max(margin, min(anchor.top, view.height - margin - height))
        let right = anchor.right + gap
        let left = right + size.width <= view.width - margin ? right : max(margin, anchor.left - gap - size.width)
        return PlaceSpot(left: left, top: top, maxHeight: maxHeight)
    }
}
