import AppKit
import QuartzCore

// One page's sheet (PaperView layout: wrap → canvas, small drawing, highlight svg, text layer, notes): its drawing and
// its small drawing as images stretched to the page, its ink in a layer that multiplies with the page (pdf.js's
// highlights do: a band darkens the paper, never the ink), and find's tints over it. The sheet is the column's width;
// the page sits G from its left. Cards are not here: they lie above every sheet (PaperCanvas).

/// What the ink layer draws, in desk px (the pane's width when the page's marks were last drawn: PaperView renderMarks'
/// viewBox), scaled to the page now.
struct SheetInk {
    /// Every mark's bands as rough.js zigzags (rgba(0,112,243,.16), 1.3 wide): a band's strokes, one path a stroke.
    var zigzags: [[CGPath]] = []
    /// The mark in focus or pointed at: deeper bands (rgba(0,112,243,.14), rx 2), page units.
    var focus: [PRect] = []
    /// A pending or live selection's bands (rgba(0,112,243,.22)), page units.
    var pending: [PRect] = []
    var live: [PRect] = []
    /// The desk width the zigzags were made at.
    var deskW: Double = 1
}

/// Find's tints on a page, page units (CSS custom highlights over the text layer).
struct SheetTints {
    var section: [PRect] = []
    var matches: [PRect] = []
    var active: [PRect] = []
}

final class InkLayer: CALayer {
    var ink = SheetInk() { didSet { if active { setNeedsDisplay() } } }
    /// Drawn only near the view (Chromium rasterizes an SVG only where it shows; a layer here is drawn wherever it is, so
    /// a page far off keeps its ink as paths and no bitmap: a 144-page paper's highlights all stroked at once held the
    /// main thread for seconds).
    var active = false {
        didSet {
            guard active != oldValue else { return }
            if active { setNeedsDisplay() } else { contents = nil }
        }
    }
    /// The page's width now (px).
    var pageW: Double = 1 { didSet { if pageW != oldValue { setNeedsDisplay() } } }

    override init() { super.init(); commonInit() }
    override init(layer: Any) { super.init(layer: layer); commonInit() }
    required init?(coder: NSCoder) { fatalError() }
    private func commonInit() {
        isGeometryFlipped = true
        needsDisplayOnBoundsChange = true
        compositingFilter = "multiplyBlendMode"
        actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
    }

    override func display() { if active { super.display() } }

    override func draw(in ctx: CGContext) {
        guard active else { return }
        let k = pageW / max(1, ink.deskW)
        ctx.saveGState()
        ctx.scaleBy(x: k, y: k)
        // A band is one SVG path stroked at .16: its strokes overlap without darkening. Stroking hundreds of crossing
        // curves as one path makes CoreGraphics resolve every crossing (seconds a page); so each stroke is drawn opaque
        // on its own into a transparency layer, and the band is laid down once at .16: the same pixels.
        ctx.setStrokeColor(CGColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 1))
        ctx.setLineWidth(1.3)
        for band in ink.zigzags {
            let box = band.reduce(CGRect.null) { $0.union($1.boundingBoxOfPath) }.insetBy(dx: -2, dy: -2)
            ctx.saveGState()
            ctx.setAlpha(0.16)
            ctx.beginTransparencyLayer(in: box, auxiliaryInfo: nil)
            for p in band { ctx.addPath(p); ctx.strokePath() }
            ctx.endTransparencyLayer()
            ctx.restoreGState()
        }
        ctx.restoreGState()
        let u = pageW
        if !ink.focus.isEmpty {
            ctx.setFillColor(CGColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.14))
            for b in ink.focus {
                let r = CGRect(x: b.x * u, y: b.y * u + b.h * u * 0.12, width: b.w * u, height: b.h * u * 0.76)
                ctx.addPath(CGPath(roundedRect: r, cornerWidth: min(2, r.width / 2), cornerHeight: min(2, r.height / 2), transform: nil))
                ctx.fillPath()
            }
        }
        ctx.setFillColor(CGColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.22))
        for b in ink.pending + ink.live { ctx.fill(CGRect(x: b.x * u, y: b.y * u, width: b.w * u, height: b.h * u)) }
    }
}

final class TintLayer: CALayer {
    var tints = SheetTints() { didSet { setNeedsDisplay() } }
    var pageW: Double = 1 { didSet { if pageW != oldValue { setNeedsDisplay() } } }
    override init() { super.init(); isGeometryFlipped = true; needsDisplayOnBoundsChange = true; actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()] }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(in ctx: CGContext) {
        let u = pageW
        func fill(_ list: [PRect], _ c: CGColor) { ctx.setFillColor(c); for b in list { ctx.fill(CGRect(x: b.x * u, y: b.y * u, width: b.w * u, height: b.h * u)) } }
        fill(tints.section, CGColor(srgbRed: 1, green: 196 / 255, blue: 0, alpha: 0.13))
        fill(tints.matches, CGColor(srgbRed: 1, green: 196 / 255, blue: 0, alpha: 0.35))
        fill(tints.active, CGColor(srgbRed: 1, green: 140 / 255, blue: 0, alpha: 0.6))
    }
}

final class SheetView: NSView {
    let page: Int
    private let thumbLayer = CALayer()
    private let imageLayer = CALayer()
    let inkLayer = InkLayer()
    let tintLayer = TintLayer()
    /// Where the page sits on the sheet and its size, px.
    private(set) var pageRect = CGRect.zero

    var image: CGImage? { didSet { imageLayer.contents = image; imageLayer.isHidden = image == nil } }
    var thumb: CGImage? { didSet { thumbLayer.contents = thumb } }

    // What the drawing loop keeps of the page (PaperView's sheet state).
    var drawn = false
    var failed = false
    var drawing: Int? = nil       // the render token under way
    var drawingWidth = 0
    var thumbFailed = false
    var thumbDrawing = false
    var marksW: Double? = nil      // the pane width its marks were last drawn for
    var cardsAt = ""               // the zoom, pane and sideways scroll its cards were laid out for
    var cards = 0

    init(page: Int) {
        self.page = page
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = false
        let quiet: [String: CAAction] = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull()]
        for l in [thumbLayer, imageLayer] as [CALayer] {
            l.contentsGravity = .resize
            l.actions = quiet
            l.magnificationFilter = .linear
        }
        imageLayer.isHidden = true
        layer?.addSublayer(thumbLayer)
        layer?.addSublayer(imageLayer)
        layer?.addSublayer(inkLayer)
        layer?.addSublayer(tintLayer)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // the canvas handles every press on the paper

    /// The sheet `sheetW` wide and its page at (G, 0) pageW × pageH.
    func place(sheetW: Double, G: Double, pageW: Double, pageH: Double) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        pageRect = CGRect(x: G, y: 0, width: pageW, height: pageH)
        for l in [thumbLayer, imageLayer, inkLayer, tintLayer] as [CALayer] { l.frame = pageRect }
        inkLayer.pageW = pageW; tintLayer.pageW = pageW
        if let scale = window?.backingScaleFactor { inkLayer.contentsScale = scale; tintLayer.contentsScale = scale }
        CATransaction.commit()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let scale = window?.backingScaleFactor { inkLayer.contentsScale = scale; tintLayer.contentsScale = scale; inkLayer.setNeedsDisplay(); tintLayer.setNeedsDisplay() }
    }

    /// The drawing given back (memory goes at once); its small drawing shows until it is drawn again.
    func dropDrawing() { image = nil; drawn = false; failed = false }
}
