import CoreGraphics
import Foundation

/// SVG path data (`d`) → CGPath, so the renderer's inline icons (Icons.jsx, SidebarIcons.jsx, Settings.jsx) are drawn from
/// their exact path strings rather than redrawn by eye. Supports every path command (M L H V C S Q T A Z, absolute and
/// relative), compact number forms (`.5.5`, `-1-2`, `1e-3`) and arc flags written without separators (`0 011`).
public enum SVGPath {
    public static func parse(_ d: String) -> CGPath {
        let path = CGMutablePath()
        var scanner = Tokens(d)
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint? = nil // for S/T reflection
        var lastCommand: Character = " "
        var command: Character = " "
        while true {
            scanner.skipSeparators()
            guard let ch = scanner.peek() else { break }
            if ch.isLetter {
                command = ch
                scanner.advance()
            } else if command == " " {
                break // numbers before any command: malformed, stop
            }
            let rel = command.isLowercase
            let base = rel ? current : .zero
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: base.x + x, y: base.y + y) }
            switch command.uppercased().first! {
            case "M":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = pt(x, y); start = current
                path.move(to: current)
                lastControl = nil
                // Further pairs after a moveto are implicit linetos.
                command = rel ? "l" : "L"
                lastCommand = "M"
                continue
            case "L":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = pt(x, y); path.addLine(to: current); lastControl = nil
            case "H":
                guard let x = scanner.number() else { return path }
                current = CGPoint(x: (rel ? current.x : 0) + x, y: current.y); path.addLine(to: current); lastControl = nil
            case "V":
                guard let y = scanner.number() else { return path }
                current = CGPoint(x: current.x, y: (rel ? current.y : 0) + y); path.addLine(to: current); lastControl = nil
            case "C":
                guard let x1 = scanner.number(), let y1 = scanner.number(), let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let c1 = pt(x1, y1), c2 = pt(x2, y2), end = pt(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2; current = end
            case "S":
                guard let x2 = scanner.number(), let y2 = scanner.number(), let x = scanner.number(), let y = scanner.number() else { return path }
                let c1: CGPoint
                if let lc = lastControl, "CcSs".contains(lastCommand) { c1 = CGPoint(x: 2 * current.x - lc.x, y: 2 * current.y - lc.y) } else { c1 = current }
                let c2 = pt(x2, y2), end = pt(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2; current = end
            case "Q":
                guard let x1 = scanner.number(), let y1 = scanner.number(), let x = scanner.number(), let y = scanner.number() else { return path }
                let c = pt(x1, y1), end = pt(x, y)
                path.addQuadCurve(to: end, control: c)
                lastControl = c; current = end
            case "T":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                let c: CGPoint
                if let lc = lastControl, "QqTt".contains(lastCommand) { c = CGPoint(x: 2 * current.x - lc.x, y: 2 * current.y - lc.y) } else { c = current }
                let end = pt(x, y)
                path.addQuadCurve(to: end, control: c)
                lastControl = c; current = end
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(), let rotation = scanner.number(),
                      let large = scanner.flag(), let sweep = scanner.flag(), let x = scanner.number(), let y = scanner.number() else { return path }
                let end = pt(x, y)
                addArc(path, from: current, to: end, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = end; lastControl = nil
            case "Z":
                path.closeSubpath(); current = start; lastControl = nil
                lastCommand = command
                command = " "
                continue
            default:
                return path
            }
            lastCommand = command
        }
        return path
    }

    /// Endpoint-parameterized elliptical arc (SVG 1.1 F.6.5) as cubic Béziers.
    static func addArc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat,
                       rotation: CGFloat, large: Bool, sweep: Bool) {
        if p0 == p1 { return }
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 { let s = sqrt(lambda); rx *= s; ry *= s }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var coef = den == 0 ? 0 : sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cxp = coef * (rx * y1p / ry)
        let cyp = coef * (-ry * x1p / rx)
        let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            var a = acos(max(-1, min(1, dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let t = 4.0 / 3.0 * tan(step / 4)
        var a = theta1
        func point(_ angle: CGFloat) -> CGPoint {
            let x = rx * cos(angle), y = ry * sin(angle)
            return CGPoint(x: cosPhi * x - sinPhi * y + cx, y: sinPhi * x + cosPhi * y + cy)
        }
        func derivative(_ angle: CGFloat) -> CGPoint {
            let x = -rx * sin(angle), y = ry * cos(angle)
            return CGPoint(x: cosPhi * x - sinPhi * y, y: sinPhi * x + cosPhi * y)
        }
        for i in 0..<segments {
            let b = a + step
            let pA = point(a), pB = i == segments - 1 ? p1 : point(b)
            let dA = derivative(a), dB = derivative(b)
            path.addCurve(to: pB, control1: CGPoint(x: pA.x + t * dA.x, y: pA.y + t * dA.y),
                          control2: CGPoint(x: pB.x - t * dB.x, y: pB.y - t * dB.y))
            a = b
        }
    }

    struct Tokens {
        let chars: [Character]
        var i = 0
        init(_ s: String) { chars = Array(s) }
        func peek() -> Character? { i < chars.count ? chars[i] : nil }
        mutating func advance() { i += 1 }
        mutating func skipSeparators() {
            while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" || chars[i] == "\r" { i += 1 }
        }
        mutating func flag() -> Bool? {
            skipSeparators()
            guard i < chars.count else { return nil }
            let c = chars[i]
            guard c == "0" || c == "1" else { return nil }
            i += 1
            return c == "1"
        }
        mutating func number() -> CGFloat? {
            skipSeparators()
            guard i < chars.count else { return nil }
            var s = ""
            if chars[i] == "-" || chars[i] == "+" { s.append(chars[i]); i += 1 }
            var dot = false, digits = false
            while i < chars.count {
                let c = chars[i]
                if c.isNumber { s.append(c); digits = true; i += 1 }
                else if c == "." && !dot { dot = true; s.append(c); i += 1 }
                else if (c == "e" || c == "E") && digits {
                    s.append(c); i += 1
                    if i < chars.count, chars[i] == "-" || chars[i] == "+" { s.append(chars[i]); i += 1 }
                    while i < chars.count, chars[i].isNumber { s.append(chars[i]); i += 1 }
                    break
                } else { break }
            }
            guard digits, let v = Double(s) else { return nil }
            return CGFloat(v)
        }
    }
}
