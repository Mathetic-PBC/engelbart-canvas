import Foundation

// Drawing a pdf's pages, their pure parts (src/renderer/model/paper-draw.js, MATH-71 and the annotations round): which
// pages to draw next and which drawings to give back, the column at a zoom, and where the view goes after one.

public enum PaperDraw {
    /// Pages within this many of the view are drawn before they are reached.
    public static let DRAW_AHEAD = 2
    /// Pages within this many of the view keep their drawing; further off it is given back.
    public static let KEEP_DRAWN = 5

    /// The pages in view, from `current` outward, then `ahead` pages each side, the one below first.
    public static func nearOrder(_ first: Int, _ last: Int, _ current: Int, _ N: Int, ahead: Int = DRAW_AHEAD) -> [Int] {
        if N <= 0 { return [] }
        let f = max(1, min(N, first > 0 ? first : 1))
        let l = max(f, min(N, last > 0 ? last : f))
        let c = max(f, min(l, current > 0 ? current : f))
        var out = [c]
        var d = 1
        while c + d <= l || c - d >= f {
            if c + d <= l { out.append(c + d) }
            if c - d >= f { out.append(c - d) }
            d += 1
        }
        if ahead > 0 {
            for d in 1...ahead {
                if l + d <= N { out.append(l + d) }
                if f - d >= 1 { out.append(f - d) }
            }
        }
        return out
    }

    /// Every page 1…N, nearest the view first.
    public static func allOrder(_ first: Int, _ last: Int, _ current: Int, _ N: Int) -> [Int] { nearOrder(first, last, current, N, ahead: N) }

    /// Whether page n, with first…last in view, is too far off to keep its drawing.
    public static func tooFar(_ n: Int, _ first: Int, _ last: Int, keep: Int = KEEP_DRAWN) -> Bool { n < first - keep || n > last + keep }

    /// The column at zoom z in a pane W wide: every page pageW wide on a sheet S wide, starting G from its left.
    public static func columnGeometry(_ W: Double, _ z: Double) -> (pageW: Double, S: Double, G: Double) {
        let pageW = max(1, jsRound(W * z)), S = max(W, pageW)
        return (pageW, S, (S - pageW) / 2)
    }

    static func sheetIndex(_ tops: [Double], _ y: Double) -> Int {
        var lo = 0, hi = tops.count - 1
        if hi < 0 { return 0 }
        while lo < hi { let mid = (lo + hi + 1) >> 1; if tops[mid] <= y { lo = mid } else { hi = mid - 1 } }
        return lo
    }

    public struct Layout { public var tops: [Double]; public var pageW: Double; public var S: Double
        public init(tops: [Double], pageW: Double, S: Double) { self.tops = tops; self.pageW = pageW; self.S = S }
    }

    /// Where the view goes once a zoom is laid out: the point (ox, oy) of the old layout stays under the same point of
    /// the pane (paper-draw.js settleView).
    public static func settleView(W: Double, ox: Double, oy: Double, top: Double, left: Double, from: Layout, to: Layout) -> (top: Double, left: Double) {
        let n = sheetIndex(from.tops, oy)
        let fw = from.pageW != 0 ? from.pageW : 1
        let fy = (oy - (n < from.tops.count ? from.tops[n] : 0)) / fw
        let y = (n < to.tops.count ? to.tops[n] : 0) + fy * to.pageW, s = to.pageW / fw
        let x = to.S / 2 + (ox - from.S / 2) * s
        return (max(0, y - (oy - top)), max(0, min(max(0, to.S - W), x - (ox - left))))
    }
}
