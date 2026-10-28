import CoreGraphics
import Foundation

// rough.js 4.6.6, the parts Engelbart's highlights use (node_modules/roughjs/bin/{math,renderer,generator}.js,
// fillers/{hachure,zigzag}-filler.js, scan-line-hachure.js, hachure-fill), ported with the same seeded randomness and in
// the same order of draws, so a highlight saved in Electron is drawn with the very same strokes here. PaperView draws
// `rc.rectangle(x, y + h·0.12, w, h·0.76, { fill, fillStyle: 'zigzag', fillWeight: 1.3, hachureGap: 2.4,
// hachureAngle: -4, stroke: 'none', roughness: 0.9, seed })` a band.

public enum Rough {
    public struct Options {
        public var maxRandomnessOffset = 2.0
        public var roughness = 1.0
        public var bowing = 1.0
        public var strokeWidth = 1.0
        public var fillWeight = -1.0
        public var hachureAngle = -41.0
        public var hachureGap = -1.0
        public var seed = 0
        public var disableMultiStroke = false
        public var disableMultiStrokeFill = false
        public var preserveVertices = false
        public init() {}

        /// The highlight's options (PaperView renderMarks).
        public static func highlight(seed: Int) -> Options {
            var o = Options()
            o.fillWeight = 1.3; o.hachureGap = 2.4; o.hachureAngle = -4; o.roughness = 0.9; o.seed = seed
            return o
        }
    }

    public enum Op: Equatable {
        case move(Double, Double)
        case bcurveTo(Double, Double, Double, Double, Double, Double)
        case lineTo(Double, Double)
    }

    /// math.js Random: Park–Miller with Math.imul(48271, seed); seed 0 is Math.random().
    final class Random {
        var seed: Int32
        init(_ seed: Int) { self.seed = Int32(truncatingIfNeeded: seed) }
        func next() -> Double {
            if seed != 0 {
                seed = seed &* 48271 // Math.imul: 32-bit wrap-around product
                return Double(Int32(0x7fffffff) & seed) / 2147483648.0
            }
            return Double.random(in: 0..<1)
        }
    }

    /// The options object of one drawing, with its randomizer (renderer.js `random(ops)` makes it on first use).
    final class Context {
        let o: Options
        lazy var randomizer = Random(o.seed)
        init(_ o: Options) { self.o = o }
        func random() -> Double { randomizer.next() }
        func offset(_ min: Double, _ max: Double, _ gain: Double = 1) -> Double { o.roughness * gain * (random() * (max - min) + min) }
        func offsetOpt(_ x: Double, _ gain: Double = 1) -> Double { offset(-x, x, gain) }
    }

    static func line(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ c: Context, move: Bool, overlay: Bool) -> [Op] {
        let o = c.o
        let lengthSq = pow(x1 - x2, 2) + pow(y1 - y2, 2)
        let length = lengthSq.squareRoot()
        let gain: Double = length < 200 ? 1 : length > 500 ? 0.4 : -0.0016668 * length + 1.233334
        var offset = o.maxRandomnessOffset
        if offset * offset * 100 > lengthSq { offset = length / 10 }
        let halfOffset = offset / 2
        let divergePoint = 0.2 + c.random() * 0.2
        var midDispX = o.bowing * o.maxRandomnessOffset * (y2 - y1) / 200
        var midDispY = o.bowing * o.maxRandomnessOffset * (x1 - x2) / 200
        midDispX = c.offsetOpt(midDispX, gain)
        midDispY = c.offsetOpt(midDispY, gain)
        let half = { c.offsetOpt(halfOffset, gain) }
        let full = { c.offsetOpt(offset, gain) }
        var ops: [Op] = []
        if move {
            if overlay {
                let a = o.preserveVertices ? 0 : half(), b = o.preserveVertices ? 0 : half()
                ops.append(.move(x1 + a, y1 + b))
            } else {
                let a = o.preserveVertices ? 0 : c.offsetOpt(offset, gain), b = o.preserveVertices ? 0 : c.offsetOpt(offset, gain)
                ops.append(.move(x1 + a, y1 + b))
            }
        }
        let r = overlay ? half : full
        let p1 = midDispX + x1 + (x2 - x1) * divergePoint + r()
        let p2 = midDispY + y1 + (y2 - y1) * divergePoint + r()
        let p3 = midDispX + x1 + 2 * (x2 - x1) * divergePoint + r()
        let p4 = midDispY + y1 + 2 * (y2 - y1) * divergePoint + r()
        let p5 = x2 + (o.preserveVertices ? 0 : r())
        let p6 = y2 + (o.preserveVertices ? 0 : r())
        ops.append(.bcurveTo(p1, p2, p3, p4, p5, p6))
        return ops
    }

    static func doubleLine(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ c: Context, filling: Bool = false) -> [Op] {
        let single = filling ? c.o.disableMultiStrokeFill : c.o.disableMultiStroke
        let o1 = line(x1, y1, x2, y2, c, move: true, overlay: false)
        if single { return o1 }
        return o1 + line(x1, y1, x2, y2, c, move: true, overlay: true)
    }

    static func linearPath(_ points: [[Double]], close: Bool, _ c: Context) -> [Op] {
        let n = points.count
        if n > 2 {
            var ops: [Op] = []
            for i in 0..<(n - 1) { ops += doubleLine(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], c) }
            if close { ops += doubleLine(points[n - 1][0], points[n - 1][1], points[0][0], points[0][1], c) }
            return ops
        } else if n == 2 {
            return doubleLine(points[0][0], points[0][1], points[1][0], points[1][1], c)
        }
        return []
    }

    /* ------------------------------------------------------------------------------------------------ hachure-fill */

    static func rotate(_ points: inout [[Double]], _ degrees: Double) {
        let a = Double.pi / 180 * degrees, cs = cos(a), sn = sin(a)
        for i in points.indices {
            let x = points[i][0], y = points[i][1]
            points[i][0] = x * cs - y * sn
            points[i][1] = x * sn + y * cs
        }
    }

    struct Edge { var ymin: Double; var ymax: Double; var x: Double; var islope: Double }

    static func straightHachureLines(_ polygons: [[[Double]]], _ gapIn: Double, _ step: Double) -> [[[Double]]] {
        var vertexArray: [[[Double]]] = []
        for polygon in polygons {
            var v = polygon
            if let f = v.first, let l = v.last, !(f[0] == l[0] && f[1] == l[1]) { v.append([f[0], f[1]]) }
            if v.count > 2 { vertexArray.append(v) }
        }
        var lines: [[[Double]]] = []
        let gap = max(gapIn, 0.1)
        var edges: [Edge] = []
        for v in vertexArray {
            for i in 0..<(v.count - 1) {
                let p1 = v[i], p2 = v[i + 1]
                if p1[1] != p2[1] {
                    let ymin = min(p1[1], p2[1])
                    edges.append(Edge(ymin: ymin, ymax: max(p1[1], p2[1]), x: ymin == p1[1] ? p1[0] : p2[0], islope: (p2[0] - p1[0]) / (p2[1] - p1[1])))
                }
            }
        }
        edges = jsSort(edges) { e1, e2 in
            if e1.ymin < e2.ymin { return -1 }
            if e1.ymin > e2.ymin { return 1 }
            if e1.x < e2.x { return -1 }
            if e1.x > e2.x { return 1 }
            if e1.ymax == e2.ymax { return 0 }
            return (e1.ymax - e2.ymax) / abs(e1.ymax - e2.ymax)
        }
        if edges.isEmpty { return lines }
        var active: [(s: Double, edge: Edge)] = []
        var y = edges[0].ymin
        var iteration = 0.0
        while !active.isEmpty || !edges.isEmpty {
            if !edges.isEmpty {
                var ix = -1
                for i in edges.indices { if edges[i].ymin > y { break }; ix = i }
                let removed = Array(edges[0...max(0, ix)].prefix(ix + 1))
                edges.removeFirst(ix + 1)
                for e in removed { active.append((y, e)) }
            }
            active = active.filter { $0.edge.ymax > y }
            active = jsSort(active) { a, b in a.edge.x == b.edge.x ? 0 : (a.edge.x - b.edge.x) / abs(a.edge.x - b.edge.x) }
            if step != 1 || iteration.truncatingRemainder(dividingBy: gap) == 0 {
                if active.count > 1 {
                    var i = 0
                    while i < active.count {
                        let next = i + 1
                        if next >= active.count { break }
                        lines.append([[jsRound(active[i].edge.x), y], [jsRound(active[next].edge.x), y]])
                        i += 2
                    }
                }
            }
            y += step
            for i in active.indices { active[i].edge.x += step * active[i].edge.islope }
            iteration += 1
        }
        return lines
    }

    /// hachure-fill's hachureLines: polygons rotated by `angle`, scanned, the lines rotated back.
    static func hachureLines(_ polygonsIn: [[[Double]]], _ gap: Double, _ angle: Double, _ step: Double) -> [[[Double]]] {
        var polygons = polygonsIn
        if angle != 0 { for i in polygons.indices { rotate(&polygons[i], angle) } }
        var lines = straightHachureLines(polygons, max(gap, 0.1), step)
        if angle != 0 {
            for i in lines.indices { rotate(&lines[i], -angle) }
        }
        return lines
    }

    /// scan-line-hachure.js polygonHachureLines.
    static func polygonHachureLines(_ polygons: [[[Double]]], _ c: Context, gapOverride: Double? = nil) -> [[[Double]]] {
        let o = c.o
        let angle = o.hachureAngle + 90
        var gap = gapOverride ?? o.hachureGap
        if gap < 0 { gap = o.strokeWidth * 4 }
        gap = jsRound(max(gap, 0.1))
        var skipOffset = 1.0
        if o.roughness >= 1 {
            // `(o.randomizer?.next() || Math.random()) > 0.7`: the randomizer exists once a line has been drawn
            if c.random() > 0.7 { skipOffset = gap }
        }
        return hachureLines(polygons, gap, angle, skipOffset == 0 ? 1 : skipOffset)
    }

    /// The zigzag filler: each hachure line becomes a V of two lines meeting at its far end.
    static func zigzagFill(_ polygons: [[[Double]]], _ c: Context) -> [Op] {
        let o = c.o
        var gap = o.hachureGap
        if gap < 0 { gap = o.strokeWidth * 4 }
        gap = max(gap, 0.1)
        let lines = polygonHachureLines(polygons, c, gapOverride: gap)
        let a = Double.pi / 180 * o.hachureAngle
        let dgx = gap * 0.5 * cos(a), dgy = gap * 0.5 * sin(a)
        var zig: [[[Double]]] = []
        for l in lines {
            let p1 = l[0], p2 = l[1]
            if (pow(p1[0] - p2[0], 2) + pow(p1[1] - p2[1], 2)).squareRoot() != 0 {
                zig.append([[p1[0] - dgx, p1[1] + dgy], p2])
                zig.append([[p1[0] + dgx, p1[1] - dgy], p2])
            }
        }
        var ops: [Op] = []
        for l in zig { ops += doubleLine(l[0][0], l[0][1], l[1][0], l[1][1], c, filling: true) }
        return ops
    }

    /// generator.js rectangle with a zigzag fill and no stroke → the fill's ops. The outline is still computed first, as
    /// rough.js does, because it draws from the same random sequence.
    public static func zigzagRectangle(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ o: Options) -> [Op] {
        let c = Context(o)
        let points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        _ = linearPath(points, close: true, c) // the outline, not drawn (stroke: 'none')
        return zigzagFill([points], c)
    }

    /// The ops as a path (opsToPath).
    public static func path(_ ops: [Op], transform: CGAffineTransform = .identity) -> CGPath {
        let p = CGMutablePath()
        for op in ops {
            switch op {
            case .move(let x, let y): p.move(to: CGPoint(x: x, y: y), transform: transform)
            case .lineTo(let x, let y): p.addLine(to: CGPoint(x: x, y: y), transform: transform)
            case .bcurveTo(let a, let b, let c, let d, let e, let f):
                p.addCurve(to: CGPoint(x: e, y: f), control1: CGPoint(x: a, y: b), control2: CGPoint(x: c, y: d), transform: transform)
            }
        }
        return p
    }

    /// The ops as one path a stroke (each `move` starts one), for drawing them one by one.
    public static func strokes(_ ops: [Op]) -> [CGPath] {
        var out: [CGPath] = [], cur: [Op] = []
        for op in ops {
            if case .move = op, !cur.isEmpty { out.append(path(cur)); cur = [] }
            cur.append(op)
        }
        if !cur.isEmpty { out.append(path(cur)) }
        return out
    }

    /// The SVG path data rough.js writes (opsToPath), for tests against the JS output.
    public static func svgPath(_ ops: [Op]) -> String {
        var s = ""
        for op in ops {
            switch op {
            case .move(let x, let y): s += "M\(JSNumber.string(x)) \(JSNumber.string(y)) "
            case .lineTo(let x, let y): s += "L\(JSNumber.string(x)) \(JSNumber.string(y)) "
            case .bcurveTo(let a, let b, let c, let d, let e, let f):
                s += "C\(JSNumber.string(a)) \(JSNumber.string(b)), \(JSNumber.string(c)) \(JSNumber.string(d)), \(JSNumber.string(e)) \(JSNumber.string(f)) "
            }
        }
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// Array.prototype.sort with a numeric comparator: V8's TimSort is stable, so equal elements keep their order.
    static func jsSort<T>(_ list: [T], _ cmp: (T, T) -> Double) -> [T] {
        list.enumerated().sorted { a, b in
            let c = cmp(a.element, b.element)
            if c.isNaN || c == 0 { return a.offset < b.offset }
            return c < 0
        }.map(\.element)
    }
}
