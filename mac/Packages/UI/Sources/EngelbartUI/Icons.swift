import AppKit
import SwiftUI

// The renderer's inline SVG icons, from their own path data:
//   ui/Icons.jsx         the kind glyphs (a 16-unit grid, 1.5 stroke) the design defines (Goal Canvas.dc.html 395–402)
//   ui/SidebarIcons.jsx  the sidebar's (a 24-unit grid, 2 stroke, 18px; most are Lucide's, ISC)
//   ui/Settings.jsx      the Settings window's (Lucide cpu, blocks, circled plus, flask at 16px 1.75; the gear 17px 2)
//   Phosphor "shapes" (bold, MIT)  the only Phosphor icon the renderer imports (DocEditor.jsx:60-61); its notice is in
//                                  Resources/Icons/phosphor-LICENSE.txt
// Every icon is drawn in the colour around it (`currentColor`): SwiftUI's `IconView` fills and strokes with the
// foreground style, and `Icon.image(size:)` is a template NSImage for AppKit.

public struct IconShape: Sendable {
    public enum Geometry: Sendable {
        case path(String)
        case rect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, rx: CGFloat)
        case circle(cx: CGFloat, cy: CGFloat, r: CGFloat)
        case line(x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat)
    }
    public var geometry: Geometry
    public var fill = false
    public var stroke = true
    public var dash: [CGFloat]? = nil
    /// Rotation in degrees about a point (SVG `rotate(a cx cy)`), or a translation (`translate(x y)`).
    public var rotate: (degrees: CGFloat, cx: CGFloat, cy: CGFloat)? = nil
    public var translate: CGSize? = nil

    public init(_ geometry: Geometry, fill: Bool = false, stroke: Bool = true, dash: [CGFloat]? = nil,
                rotate: (degrees: CGFloat, cx: CGFloat, cy: CGFloat)? = nil, translate: CGSize? = nil) {
        self.geometry = geometry; self.fill = fill; self.stroke = stroke; self.dash = dash; self.rotate = rotate; self.translate = translate
    }

    public var cgPath: CGPath {
        let base: CGPath
        switch geometry {
        case .path(let d): base = SVGPath.parse(d)
        case let .rect(x, y, w, h, rx):
            let r = min(rx, w / 2, h / 2)
            base = r > 0 ? CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
                : CGPath(rect: CGRect(x: x, y: y, width: w, height: h), transform: nil)
        case let .circle(cx, cy, r): base = CGPath(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r), transform: nil)
        case let .line(x1, y1, x2, y2):
            let p = CGMutablePath(); p.move(to: CGPoint(x: x1, y: y1)); p.addLine(to: CGPoint(x: x2, y: y2)); base = p
        }
        var t = CGAffineTransform.identity
        if let translate { t = t.translatedBy(x: translate.width, y: translate.height) }
        if let rotate {
            t = t.translatedBy(x: rotate.cx, y: rotate.cy).rotated(by: rotate.degrees * .pi / 180).translatedBy(x: -rotate.cx, y: -rotate.cy)
        }
        if t.isIdentity { return base }
        return base.copy(using: &t) ?? base
    }
}

/// One icon: its grid (viewBox side), how it is stroked, the size it is drawn at unless told, and its shapes.
public struct Icon: Sendable {
    public var name: String
    public var grid: CGFloat
    public var strokeWidth: CGFloat
    public var roundCaps: Bool
    public var roundJoins: Bool
    public var size: CGFloat
    public var shapes: [IconShape]
    /// Circles cut out of everything drawn before the `after` shapes (the Inbox's dot: SVG mask).
    public var cutouts: [(cx: CGFloat, cy: CGFloat, r: CGFloat)]
    public var after: [IconShape]

    public init(_ name: String, grid: CGFloat, stroke: CGFloat, roundCaps: Bool = true, roundJoins: Bool = true, size: CGFloat,
                _ shapes: [IconShape], cutouts: [(cx: CGFloat, cy: CGFloat, r: CGFloat)] = [], after: [IconShape] = []) {
        self.name = name; self.grid = grid; self.strokeWidth = stroke; self.roundCaps = roundCaps; self.roundJoins = roundJoins
        self.size = size; self.shapes = shapes; self.cutouts = cutouts; self.after = after
    }

    /// Draws the icon into `context`, whose user space is `side` points square (y down), in `color`.
    public func draw(in context: CGContext, side: CGFloat, color: CGColor) {
        context.saveGState()
        let scale = side / grid
        context.scaleBy(x: scale, y: scale)
        context.setLineWidth(strokeWidth)
        context.setLineCap(roundCaps ? .round : .butt)
        context.setLineJoin(roundJoins ? .round : .miter)
        context.setFillColor(color)
        context.setStrokeColor(color)
        if !cutouts.isEmpty {
            let clip = CGMutablePath()
            clip.addRect(CGRect(x: 0, y: 0, width: grid, height: grid))
            for c in cutouts { clip.addEllipse(in: CGRect(x: c.cx - c.r, y: c.cy - c.r, width: 2 * c.r, height: 2 * c.r)) }
            context.saveGState()
            context.addPath(clip)
            context.clip(using: .evenOdd)
            for shape in shapes { paint(shape, context) }
            context.restoreGState()
        } else {
            for shape in shapes { paint(shape, context) }
        }
        for shape in after { paint(shape, context) }
        context.restoreGState()
    }

    private func paint(_ shape: IconShape, _ context: CGContext) {
        let path = shape.cgPath
        if shape.fill { context.addPath(path); context.fillPath() }
        if shape.stroke && strokeWidth > 0 {
            context.saveGState()
            if let dash = shape.dash { context.setLineDash(phase: 0, lengths: dash) }
            context.addPath(path); context.strokePath()
            context.restoreGState()
        }
    }

    /// A template NSImage (black, tinted by AppKit) at `size` points, the icon's own size when nil.
    public func image(size: CGFloat? = nil) -> NSImage {
        let side = size ?? self.size
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            self.draw(in: ctx, side: rect.width, color: NSColor.black.cgColor)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = name
        return image
    }

    /// The icon as a SwiftUI path in a `side`-point square (fill and stroke combined), for shapes and hit areas.
    public func swiftUIPath(side: CGFloat) -> Path {
        let t = CGAffineTransform(scaleX: side / grid, y: side / grid)
        let all = CGMutablePath()
        for s in shapes + after { all.addPath(s.cgPath, transform: t) }
        return Path(all)
    }
}

/// An icon drawn in the current foreground style.
public struct IconView: View {
    let icon: Icon
    let size: CGFloat
    public init(_ icon: Icon, size: CGFloat? = nil) { self.icon = icon; self.size = size ?? icon.size }

    public var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / icon.grid
            let style = StrokeStyle(lineWidth: icon.strokeWidth * scale, lineCap: icon.roundCaps ? .round : .butt,
                                    lineJoin: icon.roundJoins ? .round : .miter)
            let t = CGAffineTransform(scaleX: scale, y: scale)
            func paint(_ shape: IconShape, _ ctx: inout GraphicsContext) {
                let path = Path(shape.cgPath).applying(t)
                if shape.fill { ctx.fill(path, with: .foreground) }
                if shape.stroke && icon.strokeWidth > 0 {
                    var s = style
                    if let dash = shape.dash { s.dash = dash.map { $0 * scale } }
                    ctx.stroke(path, with: .foreground, style: s)
                }
            }
            if !icon.cutouts.isEmpty {
                var clipped = context
                var clip = Path(CGRect(origin: .zero, size: canvasSize))
                for c in icon.cutouts {
                    clip.addEllipse(in: CGRect(x: (c.cx - c.r) * scale, y: (c.cy - c.r) * scale, width: 2 * c.r * scale, height: 2 * c.r * scale))
                }
                clipped.clip(to: clip, style: FillStyle(eoFill: true))
                for shape in icon.shapes { paint(shape, &clipped) }
            } else {
                var ctx = context
                for shape in icon.shapes { paint(shape, &ctx) }
            }
            var ctx = context
            for shape in icon.after { paint(shape, &ctx) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - The catalog

private func p(_ d: String) -> IconShape { IconShape(.path(d)) }
private func fp(_ d: String) -> IconShape { IconShape(.path(d), fill: true, stroke: false) }
private func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ rx: CGFloat = 0) -> IconShape { IconShape(.rect(x: x, y: y, width: w, height: h, rx: rx)) }
private func c(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> IconShape { IconShape(.circle(cx: cx, cy: cy, r: r)) }

/// The kind glyphs of `ui/Icons.jsx` (16-unit grid).
public enum KindIcons {
    private static func k(_ name: String, size: CGFloat = 12, stroke: CGFloat = 1.5, caps: Bool = true, _ shapes: [IconShape]) -> Icon {
        Icon(name, grid: 16, stroke: stroke, roundCaps: caps, roundJoins: true, size: size, shapes)
    }
    public static let gh = Icon("GitHub", grid: 16, stroke: 0, size: 12, [fp("M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z")])
    // PDF and FOLDER join round but keep butt caps (the JSX sets no strokeLinecap).
    public static let pdf = k("pdf", caps: false, [p("M3.5 1.5h6l3 3v10h-9z"), p("M9.5 1.5v3h3")])
    public static let layers = k("data file", [p("M8 2.5 14 5.5 8 8.5 2 5.5z"), p("M2 8.5l6 3 6-3"), p("M2 11.5l6 3 6-3")])
    public static let folder = k("folder", caps: false, [p("M1.5 4a1 1 0 0 1 1-1h3.3l1.5 1.8h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z")])
    public static let code = k("code", [p("M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5")])
    public static let workspace = k("project", caps: false, [r(1.5, 1.5, 4.5, 4.5, 1), r(8, 1.5, 6.5, 4.5, 1), r(1.5, 8, 6.5, 6.5, 1), r(10, 8, 4.5, 4.5, 1)])
    private static let sheet = [p("M5 1.5h4.5L13 5v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"), p("M9.5 1.5v2A1.5 1.5 0 0 0 11 5h2")]
    /// A sheet with its corner turned down and three lines (Hudson's drawing, 2026-09-21).
    public static let note = k("note", size: 15, sheet + [p("M5.5 7.75h5M5.5 10h5M5.5 12.25h5")])
    /// The sheet without its lines: a markdown file that is not a note.
    public static let file = k("file", size: 15, sheet)
    /// The sheet with a W: a Word document.
    public static let doc = k("docx", size: 15, sheet + [p("M5.25 7.75 6.4 12 8 9l1.6 3 1.15-4.25")])
    /// The sheet with code brackets: an html page on disk.
    public static let html = k("html", size: 15, sheet + [p("M6.75 8.25 5.25 10l1.5 1.75M9.25 8.25l1.5 1.75-1.5 1.75")])
    public static let search = k("search", size: 16, stroke: 2.5, [c(6.75, 6.75, 4.5), p("M10.25 10.25 14 14")])
    /// Bart: two speech bubbles, one answering the other.
    public static let chat = k("chat", [p("M3 2.5h6.5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6.5L4 11.5v-2H3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z"), p("M12.5 5.5h.5a2 2 0 0 1 2 2v2.5a2 2 0 0 1-2 2h-.5v2l-2.5-2H7.5")])
    /// A website with no favicon of its own: the generic globe.
    public static let globe = k("link", size: 14, [p("M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z"), p("M1.75 8h12.5"), p("M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.55 8 14.25"), p("M8 1.75C6.2 3.45 5.3 5.55 5.3 8s.9 4.55 2.7 6.25")])
    public static let image = k("image", [r(1.5, 2.5, 13, 11, 1.2), c(5.5, 6, 1.25), p("M14.5 10.5 11 7l-4.5 4.5L4.5 9.5 1.5 12.5")])
    /// A task: a clipboard with a check on it.
    public static let task = k("task", [p("M5.75 3H5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-.75"), p("M6.75 1.75h2.5a1 1 0 0 1 1 1v.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-.5a1 1 0 0 1 1-1z"), p("M6.25 9.25l1.25 1.25 2.5-2.5")])
    /// Full screen: arrows out to take the middle, arrows in to give it back (the Stage's and the document's).
    public static let expand = Icon("Expand", grid: 16, stroke: 1.7, size: 16, [p("M9.3 2.5h4.2v4.2M13.5 2.5L9 7M6.7 13.5H2.5V9.3M2.5 13.5L7 9")])
    public static let collapse = Icon("Collapse", grid: 16, stroke: 1.7, size: 16, [p("M13.5 2.5L9.5 6.5M9.5 3.3v3.2h3.2M2.5 13.5l4-4M6.5 12.7V9.5H3.3")])

    /// Kind → glyph and the kind's name (`KIND` in Icons.jsx), keyed by `kindKey(row)` (model/kind.js, the Stage's).
    public struct Kind: Sendable { public let icon: Icon; public let label: String; public let fixed: Bool }
    public static let kinds: [String: Kind] = [
        "note": Kind(icon: note, label: "note", fixed: false),
        "md": Kind(icon: file, label: "md", fixed: false),
        "docx": Kind(icon: doc, label: "docx", fixed: false),
        "pdf": Kind(icon: pdf, label: "pdf", fixed: false),
        "git": Kind(icon: gh, label: "git repo", fixed: false),
        "folder": Kind(icon: folder, label: "folder", fixed: false),
        "website": Kind(icon: globe, label: "link", fixed: false),
        "html": Kind(icon: html, label: "html", fixed: false),
        "data": Kind(icon: layers, label: "data file", fixed: false),
        "chat": Kind(icon: chat, label: "chat", fixed: true),
        "task": Kind(icon: task, label: "task", fixed: true),
        "workspace": Kind(icon: workspace, label: "project", fixed: true), // what were workspaces are projects (2026-10-13)
        "image": Kind(icon: image, label: "image", fixed: false),
    ]
    /// A type `kinds` does not know is some file: a plain sheet, never a note's or a folder's.
    public static let anyFile = Kind(icon: file, label: "file", fixed: false)

    /// The size a kind is drawn at in its box: a note (and every sheet) 15, a globe 14, the rest 12.
    public static func glyphSize(_ key: String) -> CGFloat {
        guard kinds[key] != nil else { return 15 } // an unknown kind is drawn as a sheet, at the sheet's size
        return ["note": 15, "md": 15, "docx": 15, "html": 15, "website": 14][key] ?? 12
    }

    /// `kindOf(item)`: the glyph, and the words beside it (a library row's type then tags, from the caller's `label`).
    public static func kind(_ key: String, label: String? = nil) -> Kind {
        let k = kinds[key] ?? anyFile
        if k.fixed || label == nil { return k }
        return Kind(icon: k.icon, label: label!, fixed: false)
    }
}

/// A kind's glyph centred in a `box` (16, or 18 in a list), drawn at its kind's size (`KindGlyph` in Icons.jsx).
public struct KindGlyph: View {
    let key: String
    let box: CGFloat
    let color: NSColor
    public init(_ key: String, box: CGFloat = 16, color: NSColor = Palette.ink) { self.key = key; self.box = box; self.color = color }
    public var body: some View {
        IconView(KindIcons.kind(key).icon, size: KindIcons.glyphSize(key))
            .foregroundStyle(Color(color))
            .frame(width: box, height: box)
    }
}

/// The sidebar's icons (`ui/SidebarIcons.jsx`, 24-unit grid, 2 stroke, 18px).
public enum SidebarIcons {
    private static func s(_ name: String, stroke: CGFloat = 2, size: CGFloat = 18, _ shapes: [IconShape]) -> Icon {
        Icon(name, grid: 24, stroke: stroke, size: size, shapes)
    }
    private static let tray = [p("M22 12h-6l-2 3h-4l-2-3H2"), p("M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z")]
    public static let inbox = s("Inbox", tray)
    /// With a dot on its corner when something is new, the tray cut away round it.
    public static let inboxDot = Icon("Inbox", grid: 24, stroke: 2, size: 18, tray, cutouts: [(20, 4, 5.2)],
                                      after: [IconShape(.circle(cx: 20, cy: 4, r: 3.2), fill: true, stroke: false)])
    /// Also the editor's collapsed agent conversation row (AGENTS_PATH).
    public static let agentsPath = "M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"
    public static let agents = s("Agents", [p(agentsPath)])
    public static let connections = s("Connections", [r(14, 3, 7, 7, 1), p("M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3")])
    /// Three filled books with 0.7 corners; the middle one starts 2 units lower, the third leans (2026-10-14).
    public static let library = Icon("Library", grid: 24, stroke: 0, size: 18, [
        IconShape(.rect(x: 3.6, y: 2.6, width: 2.8, height: 18.8, rx: 0.7), fill: true, stroke: false),
        IconShape(.rect(x: 9.6, y: 4.6, width: 2.8, height: 16.8, rx: 0.7), fill: true, stroke: false),
        IconShape(.rect(x: 16.35, y: 3.4, width: 2.8, height: 18.2, rx: 0.7), fill: true, stroke: false, rotate: (-13.13, 17.75, 12.5)),
    ])
    public static let add = s("Add", [c(12, 12, 10), p("M8 12h8"), p("M12 8v8")])
    public static let project = s("Project", [p("M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"), p("M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"), p("M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17")])
    /// "B · small on bottom": a tall pane on the left, a square over a short one on the right.
    public static let workspace = s("Workspace", [r(3.5, 3, 6.5, 18, 2.5), r(14, 3, 6.5, 10.5, 2.5), r(14, 16.5, 6.5, 4.5, 2.25)])
    public static let search = s("Search", [c(11, 11, 7.5), p("m21 21-4.5-4.5")])
    public static let chevronDown = s("Chevron down", [p("m6 9 6 6 6-6")])
    public static let chevronRight = s("Chevron right", [p("m9 18 6-6-6-6")])
    public static let link = s("Link", [p("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"), p("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71")])
    public static let note = s("Note", [p("M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"), p("M14 2v4a2 2 0 0 0 2 2h4"), p("M9 13.5h6"), p("M9 17.5h6")])
    public static let file = s("File", [p("M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"), p("M14 2v4a2 2 0 0 0 2 2h4")])
    public static let folder = s("Folder", [p("m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2")])
    static let starPath = "M11.53 2.3a.53.53 0 0 1 .94 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.17.76a.53.53 0 0 1 .29.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.91l5.17-.75a2.12 2.12 0 0 0 1.6-1.16z"
    public static let star = s("Star", [p(starPath)])
    public static let starFilled = s("Star", [IconShape(.path(starPath), fill: true, stroke: true)])
    public static let code = s("Code", [p("m18 16 4-4-4-4"), p("m6 8-4 4 4 4"), p("m14.5 4-5 16")])
    /// Eight square teeth round a ring, a hole in the middle (the picture's gear).
    public static let gear = s("Gear", [p("M10.25 4.5V1.95h3.5V4.5A7.7 7.7 0 0 1 16.06 5.46l1.81-1.8 2.47 2.47-1.8 1.81A7.7 7.7 0 0 1 19.5 10.25h2.55v3.5H19.5a7.7 7.7 0 0 1-.96 2.31l1.8 1.81-2.47 2.47-1.81-1.8a7.7 7.7 0 0 1-2.31.96v2.55h-3.5V19.5a7.7 7.7 0 0 1-2.31-.96l-1.81 1.8-2.47-2.47 1.8-1.81a7.7 7.7 0 0 1-.96-2.31H1.95v-3.5H4.5a7.7 7.7 0 0 1 .96-2.31l-1.8-1.81 2.47-2.47 1.81 1.8a7.7 7.7 0 0 1 2.31-.96z"), c(12, 12, 3)])
    public static let panelClose = s("Close sidebar", [r(3, 3, 18, 18, 2), p("M9 3v18"), p("m16 15-3-3 3-3")])
    public static let panelOpen = s("Open sidebar", [r(3, 3, 18, 18, 2), p("M9 3v18"), p("m14 9 3 3-3 3")])
    public static let plus = s("Plus", [p("M5 12h14"), p("M12 5v14")])
    public static let paperclip = s("Paperclip", [p("m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48")])
    public static let check = s("Check", [p("M20 6 9 17l-5-5")])
    public static let close = s("Close", [p("M18 6 6 18"), p("m6 6 12 12")])
    public static let minusCircle = s("Remove", [c(12, 12, 9.5), p("M8 12h8")])
    public static let trash = s("Trash", [p("M3 6h18"), p("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"), p("M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"), p("M10 11v6"), p("M14 11v6")])
    public static let archive = s("Archive", [r(2, 3, 20, 5, 1), p("M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"), p("M10 12h4")])
    public static let chat = s("Chat", [p("M7.9 20A9 9 0 1 0 4 16.1L2 22z")])
    public static let pencil = s("Pencil", [p("M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"), p("m15 5 4 4")])
    public static let external = s("Open", [p("M15 3h6v6"), p("M10 14 21 3"), p("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")])
    /// The sticky: a square with its lower right corner turned up; drawn dotted while the stickies are hidden.
    public static func sticky(hidden: Bool = false) -> Icon {
        let dash: [CGFloat]? = hidden ? [2.6, 2.4] : nil
        return s(hidden ? "Show stickies" : "Hide stickies", [IconShape(.path("M13 20.5 20.5 13"), dash: dash),
                                                               IconShape(.path("M13 20.5V14a1 1 0 0 1 1-1h6.5V5.5a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"), dash: dash)])
    }
    /// The "More" mark: three filled dots, 16px.
    public static let dots = Icon("More", grid: 24, stroke: 0, size: 16, [IconShape(.circle(cx: 5, cy: 12, r: 1.7), fill: true, stroke: false),
                                                                        IconShape(.circle(cx: 12, cy: 12, r: 1.7), fill: true, stroke: false),
                                                                        IconShape(.circle(cx: 19, cy: 12, r: 1.7), fill: true, stroke: false)])
    public static let compose = s("New note", [p("M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"), IconShape(.path("M10 14l-1 4 4-1 9-9a2.12 2.12 0 0 0-3-3z"), translate: CGSize(width: 0, height: -2))])
    public static let clock = s("Recent", [c(12, 12, 9.5), p("M12 7v5l3 2")])
    public static let image = s("Image", [r(3, 3, 18, 18, 2), c(9, 9, 2), p("m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21")])
    public static let globe = s("Web page", [c(12, 12, 10), p("M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"), p("M2 12h20")])
    public static let paper = s("Paper", [p("M12 7v14"), p("M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z")])
    public static let git = s("Repository", [IconShape(.line(x1: 6, y1: 3, x2: 6, y2: 15)), c(18, 6, 3), c(6, 18, 3), p("M18 9a9 9 0 0 1-9 9")])
    public static let arrowOut = s("Project page", [p("M7 7h10v10"), p("M7 17 17 7")])

    /// A source's icon by its kind (model/sidebar.js sourceIcon).
    public static func source(_ kind: String) -> Icon {
        ["note": note, "file": file, "image": image, "html": code, "website": globe, "folder": folder, "pdf": paper, "git": git][kind] ?? file
    }
}

/// A folder with a plus on its corner (Create new): the plus sits on the sidebar's grey so it cuts the folder's line.
public struct FolderPlusIcon: View {
    let size: CGFloat
    public init(size: CGFloat = 18) { self.size = size }
    public var body: some View {
        IconView(SidebarIcons.folder, size: size)
            .overlay(alignment: .bottomTrailing) {
                Text("+").font(.system(size: 16)).frame(height: 12).background(Color(Palette.gray50)).offset(x: 3, y: 2)
            }
    }
}

/// The Settings window's icons (`ui/Settings.jsx`): Lucide paths at 16px with a 1.75 stroke; the gear 17px with 2.
public enum SettingsIcons {
    private static func s(_ name: String, size: CGFloat = 16, stroke: CGFloat = 1.75, _ shapes: [IconShape]) -> Icon {
        Icon(name, grid: 24, stroke: stroke, size: size, shapes)
    }
    /// Lucide "cpu" (the model; "sparkles" until 2026-10-07, too busy at this size).
    public static let model = s("Models", [r(4, 4, 16, 16, 2), r(8, 8, 8, 8, 1), p("M12 2v2M12 20v2M17 2v2M17 20v2M7 2v2M7 20v2M2 12h2M2 17h2M2 7h2M20 12h2M20 17h2M20 7h2")])
    /// Connections' four blocks (the sidebar's Connections icon until 2026-10-13).
    public static let blocks = s("Connections", [r(14, 3, 7, 7, 1), p("M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3")])
    /// Import context's circled plus (the sidebar's Add sources icon).
    public static let add = s("Import context", [c(12, 12, 10), p("M8 12h8"), p("M12 8v8")])
    public static let flask = s("Test data", [p("M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"), p("M8.5 2h7"), p("M7 16h10")])
    /// Lucide "settings", drawn as the bell beside it is (17px, a 2px stroke).
    public static let gear = s("Settings", size: 17, stroke: 2, [p("M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"), c(12, 12, 3)])
    /// Lucide "search", 14px, in the column's search field.
    public static let search = s("Search", size: 14, [p("m21 21-4.34-4.34"), c(11, 11, 8)])
    /// The select's chevron (10-unit grid, 1.4 stroke).
    public static let selectChevron = Icon("Choose", grid: 10, stroke: 1.4, size: 10, [p("M2.5 4 5 6.5 7.5 4")])
}

/// Phosphor icons (MIT; notice in Resources/Icons/phosphor-LICENSE.txt). Only "shapes" (bold) is used: the editor's
/// add-a-shape button at 20px (DocEditor.jsx:470).
public enum PhosphorIcons {
    public static let shapesBold = Icon("Shapes", grid: 256, stroke: 0, size: 20, [fp("M71.49,60.55a12,12,0,0,0-23,0l-36,120A12,12,0,0,0,24,196H96a12,12,0,0,0,11.49-15.45ZM40.13,172,60,105.76,79.87,172ZM212,74a54,54,0,1,0-54,54A54.06,54.06,0,0,0,212,74Zm-84,0a30,30,0,1,1,30,30A30,30,0,0,1,128,74Zm96,70H136a12,12,0,0,0-12,12v52a12,12,0,0,0,12,12h88a12,12,0,0,0,12-12V156A12,12,0,0,0,224,144Zm-12,52H148V168h64Z")])
}

/// `.glyph16` / `.glyph14` (styles.css): a fixed square that centres an icon or a character.
public struct GlyphBox<Content: View>: View {
    let side: CGFloat
    let content: Content
    public init(_ side: CGFloat = 16, @ViewBuilder content: () -> Content) { self.side = side; self.content = content() }
    public var body: some View {
        content.font(Fonts.swiftUISans(side == 16 ? 14 : 12.5, weight: 500)).frame(width: side, height: side)
    }
}
