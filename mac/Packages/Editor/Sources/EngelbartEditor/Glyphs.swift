import AppKit
import EngelbartDoc
import EngelbartUI

// The editor's drawings (DocEditor.jsx ICON, Lucide at the design's weight: 24-unit grid, 1.5px stroke, round caps),
// drawn from their SVG paths through EngelbartUI's SVGPath.

enum Glyphs {
    static let copy = ["M9 9h13v13H9z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"]
    static let regenerate = ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"]
    static let trash = ["M3 6h18", "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2", "M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M10 11v6", "M14 11v6"]
    static let hammer = ["m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9", "m18 15 4-4", "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"]
    static let chevronDown = ["m6 9 6 6 6-6"]
    static let chevronUp = ["m18 15-6-6-6 6"]
    static let chevronRight = ["m9 18 6-6-6-6"]
    static let send = ["M12 19V5", "m5 12 7-7 7 7"]
    static let search = ["M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z", "m21 21-4.3-4.3"]
    static let check = ["M20 6 9 17l-5-5"]
    static let pointer = [SidebarIcons.agentsPath]
    static let stepsOpen = ["m5 15.5 7-7 7 7"]
    static let stepsShut = ["m5 8.5 7 7 7-7"]

    /// Paths on a 24-unit grid drawn at `size` points in `color`.
    static func image(_ paths: [String], size: CGFloat, color: NSColor, width: CGFloat = 1.5, grid: CGFloat = 24, fill: Bool = false) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
            guard let cg = NSGraphicsContext.current?.cgContext else { return false }
            cg.scaleBy(x: size / grid, y: size / grid)
            cg.setLineWidth(width)
            cg.setLineCap(.round); cg.setLineJoin(.round)
            cg.setStrokeColor(color.cgColor); cg.setFillColor(color.cgColor)
            for d in paths { cg.addPath(SVGPath.parse(d)); if fill { cg.fillPath() } else { cg.strokePath() } }
            return true
        }
    }

    /// A citation's circle (cite.js CITE_CSS): 16px tall, at least 16 wide, #ebebeb with its number in #4d4d4d 10px/500;
    /// one that cuts against the answer hollow (white, #c9c9c9 ring); the "…" of a folded run faint.
    static func citeCircle(_ n: String, counter: Bool, faint: Bool = false) -> NSImage {
        let font = Fonts.sans(10, weight: 500)
        let tw = (n as NSString).size(withAttributes: [.font: font]).width
        let w = max(16, tw + 8) + 3
        return NSImage(size: NSSize(width: w, height: 16), flipped: true) { _ in
            let r = NSRect(x: 2, y: 0.5, width: w - 3, height: 15)
            let path = NSBezierPath(roundedRect: r, xRadius: 7.5, yRadius: 7.5)
            (faint ? NSColor(hex: "#f2f2f2") : counter ? .white : NSColor(hex: "#ebebeb")).setFill(); path.fill()
            (faint ? NSColor(hex: "#eaeaea") : counter ? NSColor(hex: "#c9c9c9") : NSColor(hex: "#ebebeb")).setStroke(); path.lineWidth = 1; path.stroke()
            let a: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: faint ? Look.grey : Look.mid]
            let sz = (n as NSString).size(withAttributes: a)
            (n as NSString).draw(at: NSPoint(x: r.midX - sz.width / 2, y: r.midY - sz.height / 2), withAttributes: a)
            return true
        }
    }

    /// A mention's glyph after its `@` (doc.js WS_ICON, file kinds, globe, GitHub mark, book), 0.8em square.
    static func mentionIcon(_ icon: MentionIcon, size: CGFloat, color: NSColor) -> NSImage {
        let side = size * 0.8
        switch icon {
        case .git: return KindIcons.gh.image(size: side).tinted(color)
        case .workspace: return svg16(["M2.5 1.5h2.5a1 1 0 0 1 1 1V5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z", "M9 1.5h4.5a1 1 0 0 1 1 1V5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z", "M2.5 8H7a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z", "M11 8h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"], side, color)
        case .website: return svg16(paths(InlineHtml.FILE_ICON_PATHS["website"]!), side, color)
        case .zotero: return svg16(paths(InlineHtml.FILE_ICON_PATHS["zotero"]!), side, color)
        case .file(let kind): return svg16(paths(InlineHtml.FILE_ICON_PATHS[kind == "file" ? "pdf" : kind] ?? InlineHtml.FILE_ICON_PATHS["pdf"]!), side, color)
        }
    }
    static func svg16(_ ds: [String], _ side: CGFloat, _ color: NSColor) -> NSImage { image(ds, size: side, color: color, width: 1.5, grid: 16) }
    /// The `d` of each <path> in an SVG body (rects and circles of the file glyphs drawn as paths).
    static func paths(_ body: String) -> [String] {
        var out = Rx(#"<path d="([^"]+)""#).matchAll(body).map { $0[1]! }
        for m in Rx(#"<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)""#).matchAll(body) {
            let x = Double(m[1]!)!, y = Double(m[2]!)!, w = Double(m[3]!)!, h = Double(m[4]!)!
            out.append("M\(x) \(y)h\(w)v\(h)h\(-w)z")
        }
        for m in Rx(#"<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)""#).matchAll(body) {
            let cx = Double(m[1]!)!, cy = Double(m[2]!)!, r = Double(m[3]!)!
            out.append("M\(cx - r) \(cy)a\(r) \(r) 0 1 0 \(2 * r) 0a\(r) \(r) 0 1 0 \(-2 * r) 0")
        }
        return out
    }
}

extension NSImage {
    /// The image's shape in one colour.
    func tinted(_ color: NSColor) -> NSImage {
        let out = NSImage(size: size, flipped: false) { r in
            self.draw(in: r)
            color.set()
            r.fill(using: .sourceAtop)
            return true
        }
        return out
    }
}
