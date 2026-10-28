import Foundation

// Zooming a pdf, its pure parts (src/renderer/model/paper-zoom.js, PaperView.jsx zoom math; spec #88–#89: 100% = fit
// width, steps 15 … 200, a pinch zooms smoothly within 15–200%).

public enum PaperZoom {
    /// 100% = page 1 as wide as the pane. Zoom is kept as a fraction (1 = 100%).
    public static let ZOOM_MIN = 0.15, ZOOM_MAX = 2.0
    public static let ZOOM_STEPS = [15, 30, 41, 67, 69, 90, 100, 110, 150, 200]
    /// A pinch settles (is laid out at its zoom) this long after its last event.
    public static let PINCH_SETTLE: TimeInterval = 0.180
    /// A page's small drawing, this many px wide, for pages within THUMB_AHEAD of the view.
    public static let THUMB_W = 180.0
    public static let THUMB_AHEAD = 12

    /// The fixed zoom (percent) that − (dir < 0) or + (dir > 0) goes to from `pct`, or nil past the ends.
    public static func zoomStep(_ pct: Double, _ dir: Int) -> Int? {
        let r = Int(jsRound(pct))
        if dir > 0 { return ZOOM_STEPS.first { $0 > r } }
        return ZOOM_STEPS.last { $0 < r }
    }

    /// 1-based page whose sheet contains y, given the sheets' ascending tops (tops[0] is page 1); 0 with none.
    public static func pageAt(_ tops: [Double], _ y: Double) -> Int {
        if tops.isEmpty { return 0 }
        var lo = 0, hi = tops.count - 1
        while lo < hi { let mid = (lo + hi + 1) >> 1; if tops[mid] <= y { lo = mid } else { hi = mid - 1 } }
        return lo + 1
    }

    /// Device pixels per point: 2×, capped so one page's drawing stays near 4 million device pixels.
    public static func canvasScale(_ w: Double, _ h: Double) -> Double { min(2, (4e6 / max(1, w * h)).squareRoot()) }

    /// A wheel event as Chromium gives it: deltaY in px (deltaMode 0) or lines (deltaMode 1).
    public struct Wheel { public var deltaY: Double; public var lines: Bool
        public init(deltaY: Double, lines: Bool = false) { self.deltaY = deltaY; self.lines = lines }
    }

    /// The zoom one wheel event goes to from `from`, within [lo, hi]: ±50 px at most an event (×1.65).
    public static func wheelZoom(_ from: Double, _ e: Wheel, _ lo: Double = ZOOM_MIN, _ hi: Double = ZOOM_MAX) -> Double {
        let dy = max(-50, min(50, e.lines ? e.deltaY * 16 : e.deltaY))
        return max(lo, min(hi, from * exp(-dy * 0.01)))
    }

    /// A trackpad pinch's magnification as Chromium hands it to the page: a ctrl+wheel whose deltaY is −100·ln(1 + m).
    public static func pinchWheel(magnification m: Double) -> Wheel { Wheel(deltaY: -100 * log(max(0.01, 1 + m))) }
}
