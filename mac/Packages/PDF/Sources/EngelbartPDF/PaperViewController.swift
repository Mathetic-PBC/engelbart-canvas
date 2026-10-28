import AppKit
import PDFKit
import EngelbartCore
import EngelbartUI

// The Paper (src/renderer/pdf/PaperView.jsx): a PDF drawn page by page on one white surface, every page as wide as the
// others and meeting with no gap, rule or edge; rough.js zigzag highlights and Caveat notes on it; 100% = fit width; a
// pinch zooms as one transform and lays the pages out when it settles; a bar at the foot says the page and the zoom.
// Embeddable in the Stage and in a workspace: everything it looks up is its own (two on one pdf never draw into each
// other; they write last-wins). Its decisions are recorded in PaperView.jsx's header, quoted where they apply.

@MainActor
public final class PaperViewController: NSViewController {
    public weak var host: PaperHost?

    /// The title block over the pages (600 15px/1.4 #171717, padded 14px 20px 0, a 1px #eaeaea rule under it); nil: none.
    public var paperTitle: String? { didSet { if isViewLoaded { buildTitle() } } }

    // MARK: views
    let paperArea = NSView()
    let scrollView = PaperScrollView()
    let clip = CenteringClipView()
    let canvas = PaperCanvas()
    let statusLabel = makeLabel("", font: Fonts.sans(12), color: NSColor(hex: "#8f8f8f"))
    let bar = PaperBar()
    let toast = RemovedToast()
    var selCardView: SelectionCardView?
    let menuView = MentionMenuView()
    private var titleView: NSView?
    var handle = MoveHandle()

    // MARK: the document
    var data: Data?
    var doc: PDFDocument?
    var chars: PageChars?
    var renderer: PageRenderer?
    var reader: TextReader?
    var geoms: [PageGeometry] = []          // [n − 1]
    var gen = 0                             // document generation

    // MARK: layout (PaperView resetGeometry)
    var zoom = 1.0                          // committed zoom (fraction of fit width)
    var live: Double?                       // zoom while a pinch is under way
    var renderedZoom = 1.0
    var css = 1.0                           // the pinch's scale now
    var pinching: (ox: Double, oy: Double)?
    var pinchTimer: Timer?
    var sheets: [SheetView] = []            // [n − 1]
    var tops: [Double] = []
    var pageHs: [Double] = []
    var pageW = 0.0, sheetW = 0.0, G = 0.0
    var pdfW = 0.0, pdfH = 0.0
    var viewX = 0.0
    var resizeWork: DispatchWorkItem?
    var drawWork: DispatchWorkItem?
    var laidOut = false
    var note = "" { didSet { statusLabel.stringValue = note; statusLabel.isHidden = note.isEmpty; syncChrome() } }

    // MARK: text
    var texts: [Int: PageText] = [:]
    var norm: [Int: (text: String, map: [Int])] = [:] // the page's text with its line breaks as \n, and where each came from
    var cols: [Int: (l: Double, r: Double)] = [:]
    var textsAt = -1
    var textWaiters: [Int: [(PageText?) -> Void]] = [:]

    // MARK: drawing loop
    var pumpScheduled = false
    var renderingPage = 0
    var renderToken = 0

    // MARK: ink
    var marks = PaperMarks()
    var dirty = false
    var saveTimer: Timer?
    var cards: [Int: [String: CardView]] = [:]
    var drawnSpecs: [Int: [CardLayout.Spec]] = [:]
    var places: [String: CardLayout.Place] = [:]
    var editing: String?
    var redrawing = 0
    var focusId: String?
    var painted: String?
    var hovered: String?
    var pendingSel: (parts: [Marks.Part], text: String)?
    var selCard: String?                    // the mark typed from the selection's card
    var liveSel: [Int: [PRect]] = [:]
    var down: (x: Double, y: Double, closed: Bool, button: Int)?
    var selecting: (page: Int, point: CGPoint)?
    var dragSel = false
    var downHere = false
    var press: (x: Double, y: Double, markId: String, page: Int, at: Int?)?
    var drag: Drag?
    var undos: [Undo] = []
    var removed: (batch: String, label: String)?
    var removedTimer: Timer?
    var openLogs = Set<String>()
    var libDrawn = ""
    public var pendingAsks: [PendingAsk] = [] { didSet { syncPending(oldValue) } }

    // MARK: mentions
    var mention: (markId: String, page: Int, query: String, start: Int)?
    var mentionIdx = 0
    var browse: (at: String, folderId: String, folderName: String, rel: String, listing: FolderListing?)?

    // MARK: find and sections
    var findQuery = ""
    var findAt = -1
    var findSpots: [FindSpot] = []
    var section: (text: String, to: String, spot: FindSpot)?
    let gate = TargetGate()
    var target: (find: String?, to: String?, page: Int?)
    var initialSection: (find: String, to: String)?
    var restoreView: PaperViewState?

    struct Drag { var markId: String; var page: Int; var grabX: Double; var grabY: Double; var x0: Double; var y0: Double; var at: NSPoint; var moved: Bool; var left: Double; var top: Double; var w: Double; var tick: Timer? }
    enum Undo { case ask(page: Int, markId: String, askId: String); case mark(page: Int, mark: Mark, index: Int, batch: String) }

    public init() {
        target = (nil, nil, nil)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    public override func loadView() {
        Fonts.register()
        let root = FlippedView()
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.white.cgColor
        view = root
        paperArea.wantsLayer = true
        root.addSubview(paperArea)
        scrollView.contentView = clip
        scrollView.documentView = canvas
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .white
        scrollView.borderType = .noBorder
        scrollView.allowsMagnification = false
        scrollView.minMagnification = PaperZoom.ZOOM_MIN / PaperZoom.ZOOM_MAX
        scrollView.maxMagnification = PaperZoom.ZOOM_MAX / PaperZoom.ZOOM_MIN
        scrollView.owner = self
        canvas.owner = self
        paperArea.addSubview(scrollView)
        statusLabel.alignment = .center
        statusLabel.isHidden = true
        paperArea.addSubview(statusLabel)
        bar.onStep = { [weak self] d in self?.zoomStepBy(d) }
        bar.onPct = { [weak self] in self?.togglePct() }
        paperArea.addSubview(bar)
        toast.onUndo = { [weak self] in if let b = self?.removed?.batch { _ = self?.undoRemoval(b) } }
        toast.isHidden = true
        paperArea.addSubview(toast)
        menuView.isHidden = true
        menuView.onPick = { [weak self] r in self?.pickMention(r) }
        menuView.onHover = { [weak self] i in self?.mentionIdx = i; self?.menuView.index = i }
        paperArea.addSubview(menuView)
        handle.isHidden = true
        handle.frame = NSRect(x: 0, y: 0, width: 15, height: 15)
        canvas.cardsLayer.addSubview(handle)
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: clip)
        clip.postsBoundsChangedNotifications = true
        buildTitle()
        syncChrome()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    final class FlippedView: NSView { override var isFlipped: Bool { true } }

    private func buildTitle() {
        titleView?.removeFromSuperview(); titleView = nil
        if let t = paperTitle, !t.isEmpty {
            let v = FlippedView()
            let l = makeLabel(t, font: Fonts.sans(15, weight: 600), color: NSColor(hex: "#171717"), lines: 0)
            v.addSubview(l)
            view.addSubview(v)
            titleView = v
        }
        view.needsLayout = true
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        let b = view.bounds
        var top: CGFloat = 0
        if let tv = titleView, let l = tv.subviews.first as? NSTextField {
            let h = l.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: b.width - 40, height: 1000)).height ?? 21
            tv.frame = NSRect(x: 0, y: 0, width: b.width, height: 14 + h)
            l.frame = NSRect(x: 20, y: 14, width: b.width - 40, height: h)
            top = 14 + h + 12 // gap 12, then the pages under a 1px rule
            tv.wantsLayer = true
        }
        paperArea.frame = NSRect(x: 0, y: top, width: b.width, height: max(0, b.height - top))
        if titleView != nil {
            paperArea.layer?.borderWidth = 0
            let rule = paperArea.layer?.sublayers?.first { $0.name == "title-rule" } ?? {
                let l = CALayer(); l.name = "title-rule"; l.backgroundColor = NSColor(hex: "#eaeaea").cgColor; l.zPosition = 10; paperArea.layer?.addSublayer(l); return l
            }()
            rule.frame = CGRect(x: 0, y: paperArea.bounds.height - 1, width: paperArea.bounds.width, height: 1)
        } else { paperArea.layer?.sublayers?.first { $0.name == "title-rule" }?.removeFromSuperlayer() }
        let ruleH: CGFloat = titleView != nil ? 1 : 0
        let a = paperArea.bounds
        scrollView.frame = NSRect(x: 0, y: ruleH, width: a.width, height: a.height - ruleH)
        statusLabel.frame = NSRect(x: 0, y: a.height - 14 - 18, width: a.width, height: 18)
        layoutChrome()
        onResize()
    }

    /// The bar, the toast, the menu: placed in the pane (paperArea is not flipped: y up).
    func layoutChrome() {
        let a = paperArea.bounds
        let bs = bar.preferredSize
        bar.frame = NSRect(x: (a.width - bs.width) / 2, y: 16, width: bs.width, height: bs.height)
        let ts = toast.preferredSize
        toast.frame = NSRect(x: (a.width - ts.width) / 2, y: 60, width: ts.width, height: ts.height)
    }

    func syncChrome() {
        bar.isHidden = !(note.isEmpty && !sheets.isEmpty)
        bar.set(page: currentPage(), pages: sheets.count, pct: pct())
        layoutChrome()
    }

    // MARK: - opening a paper

    /// Opens a paper: its bytes, its ink (nil: asked of the host), where it was read to, and a link's passage to show
    /// (`target`, the start of the section after it `targetTo`, the page it names `targetPage`) or a section to show
    /// when there is no target. Another paper's unsaved ink is saved first.
    public func load(data: Data?, marks: PaperMarks? = nil, view state: PaperViewState? = nil, target: String? = nil, targetTo: String? = nil,
                     targetPage: Int? = nil, initialSection: (find: String, to: String)? = nil) {
        _ = view
        flushSave()
        teardown()
        gen += 1
        self.marks = marks ?? host?.paperReadAnnotations() ?? PaperMarks()
        dirty = false
        self.target = (target, targetTo, targetPage)
        self.initialSection = initialSection
        let first = target != nil ? (target, targetTo) : (initialSection?.find, initialSection?.to)
        gate.set(PaperFind.targetKey(first.0, first.1))
        restoreView = target == nil && initialSection == nil ? state : nil
        undos = []
        hideRemoved()
        guard let data, !data.isEmpty else { note = "No paper to open."; return }
        note = "Opening the paper…"
        guard let doc = PDFDocument(data: data), doc.pageCount > 0 else {
            note = "Could not open the paper — The file is not a readable pdf"
            return
        }
        self.data = data
        self.doc = doc
        chars = PageChars(doc: doc)
        renderer = PageRenderer(data: data)
        let reader = TextReader(data: data)
        let myGen = gen
        reader.onPage = { [weak self] n, text in
            guard let self, self.gen == myGen else { return }
            self.readText(n, text)
        }
        self.reader = reader
        Self.warmNoteFace()
        geoms = (0..<doc.pageCount).map { PageGeometry(page: doc.page(at: $0)!) }
        note = ""
        if let v = restoreView, v.zoom > 0 { zoom = clamp(v.zoom, PaperZoom.ZOOM_MIN, PaperZoom.ZOOM_MAX) }
        layoutPaper()
    }

    /// The note's handwriting decoded and its glyphs loaded on a background queue (CoreText is thread-safe), so the first
    /// card drawn does not pay for it on the main thread (the stall probe's slowest page held it ~70 ms).
    nonisolated static func warmNoteFace() {
        DispatchQueue.global(qos: .userInitiated).async {
            for name in ["Caveat-Medium", "Caveat-Regular"] {
                let font = CTFontCreateWithName(name as CFString, 24, nil)
                let s = NSAttributedString(string: "The quick brown fox jumps over the lazy dog 0123456789 @bart?!", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
                _ = CTLineGetTypographicBounds(CTLineCreateWithAttributedString(s), nil, nil, nil)
            }
        }
    }

    /// Ink that arrived after the bytes: adopted while nothing was edited here.
    public func setMarks(_ next: PaperMarks) {
        guard !dirty else { return }
        marks = next
        renderAllMarks()
    }

    /// The paper's ink as it is now (what would be saved).
    public var currentMarks: PaperMarks { Canvas.kept(marks) }

    /// The view closes: where it was read to is told, the ink saved, the document let go.
    public func close() {
        if laidOut, let host {
            let h = canvas.bounds.height
            host.paperView(PaperViewState(zoom: live ?? zoom, at: h > 0 ? Double(clip.bounds.minY / h) : 0, left: Double(clip.bounds.minX)))
        }
        flushSave()
        teardown()
        gen += 1
    }

    func teardown() {
        endPinch(drop: true)
        reader?.cancel(); reader = nil
        renderer = nil
        doc = nil; chars = nil; data = nil
        for s in sheets { s.removeFromSuperview() }
        for (_, list) in cards { for (_, c) in list { c.removeFromSuperview() } }
        cards = [:]; drawnSpecs = [:]; places = [:]
        sheets = []; tops = []; pageHs = []; geoms = []
        texts = [:]; norm = [:]; cols = [:]; textsAt = -1; textWaiters = [:]
        laidOut = false
        zoom = 1; renderedZoom = 1; live = nil; css = 1
        pendingSel = nil; selCard = nil; closeSelCard(); liveSel = [:]
        editing = nil; focusId = nil; painted = nil; hovered = nil
        closeMention()
        stopFind(); section = nil
        gate.drawing()
        handle.isHidden = true
        syncChrome()
    }

    // MARK: - layout

    /// The sheets, made once a document (PaperView layout), laid out at the zoom now.
    func layoutPaper() { PaperTrace.measure("layoutPaper") { layoutPaperBody() } }
    func layoutPaperBody() {
        guard doc != nil, scrollView.bounds.width >= 40 else { return }
        for n in 1...geoms.count {
            let s = SheetView(page: n)
            canvas.addSheet(s)
            sheets.append(s)
        }
        laidOut = true
        applyGeometry(clamp(zoom, PaperZoom.ZOOM_MIN, PaperZoom.ZOOM_MAX))
        let W = Double(clip.bounds.width)
        scrollTo(x: max(0, (sheetW - W) / 2), y: 0)
        if let v = restoreView {
            scrollTo(x: v.left, y: v.at * Double(canvas.bounds.height))
            restoreView = nil
        }
        if target.find != nil, let p = target.page { toPage(p) }
        syncChrome()
        readOrder()
        pump()
    }

    /// Every sheet at zoom z: sizes only (PaperView applyGeometry). Every page as wide as the others (columnGeometry).
    func applyGeometry(_ z: Double) {
        let W = Double(clip.bounds.width)
        let col = PaperDraw.columnGeometry(W, z)
        pageW = col.pageW; sheetW = col.S; G = col.G
        var top = 0.0
        tops = []; pageHs = []
        for g in geoms {
            tops.append(top)
            let h = g.height * pageW / g.width
            pageHs.append(h)
            top += h
        }
        zoom = z; renderedZoom = z; css = 1
        pdfW = W; pdfH = Double(clip.bounds.height)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        canvas.frame = NSRect(x: 0, y: 0, width: sheetW, height: max(top, 1))
        for (i, s) in sheets.enumerated() {
            s.frame = NSRect(x: 0, y: tops[i], width: sheetW, height: pageHs[i])
            s.place(sheetW: sheetW, G: G, pageW: pageW, pageH: pageHs[i])
        }
        CATransaction.commit()
        if !findSpots.isEmpty || section != nil { paintTints() }
    }

    func scrollTo(x: Double, y: Double) {
        clip.scroll(to: NSPoint(x: x, y: y))
        scrollView.reflectScrolledClipView(clip)
        viewX = Double(clip.bounds.minX)
    }

    var scrollTop: Double { Double(clip.bounds.minY) }
    var scrollLeft: Double { Double(clip.bounds.minX) }
    var visibleH: Double { Double(clip.bounds.height) }

    func pct() -> Int { Int(jsRound((live ?? zoom) * 100)) }

    /// The pages the view shows: first, last, current (the one at the view's middle).
    func viewRange() -> (first: Int, last: Int, current: Int)? {
        guard !tops.isEmpty else { return nil }
        let b = clip.bounds
        return (PaperZoom.pageAt(tops, Double(b.minY)), PaperZoom.pageAt(tops, Double(b.maxY)), PaperZoom.pageAt(tops, Double(b.midY)))
    }

    func currentPage() -> Int { tops.isEmpty ? 0 : PaperZoom.pageAt(tops, Double(clip.bounds.midY)) }

    /// The view at the top of page n.
    public func toPage(_ n: Int) {
        guard !tops.isEmpty else { return }
        let i = min(max(1, n), tops.count) - 1
        scrollTo(x: scrollLeft, y: tops[i])
        syncChrome()
    }

    @objc func scrolled() { PaperTrace.measure("scrolled") { scrolledBody() } }
    func scrolledBody() {
        if mention != nil { closeMention() }
        if Double(clip.bounds.minX) != viewX && live == nil { viewX = Double(clip.bounds.minX); arrangeNear() }
        placeSelCard(); placeTypedCard()
        syncChrome()
        readOrder()
        pump()
    }

    // MARK: - zoom

    /// Zoom to a percent of fit width, about the middle of the view.
    public func zoomTo(_ percent: Double) {
        guard laidOut else { return }
        endPinch(drop: true)
        let b = clip.bounds
        rezoom(percent / 100, ox: Double(b.midX), oy: Double(b.midY))
    }
    public func zoomStepBy(_ dir: Int) { if let next = PaperZoom.zoomStep(Double(pct()), dir) { zoomTo(Double(next)) } }
    /// The percentage goes back to 100%.
    public func togglePct() { if pct() != 100 { zoomTo(100) } }
    /// The zoom now (1 = 100%).
    public var currentZoom: Double { live ?? zoom }

    /// Laid out at zoom z, the point (ox, oy) of the layout before kept where it is in the pane (settleView).
    func rezoom(_ z: Double, ox: Double, oy: Double, paneX: Double? = nil, paneY: Double? = nil, draw: Bool = true) {
        guard laidOut else { return }
        closeMention()
        let top = paneY.map { oy - $0 } ?? scrollTop, left = paneX.map { ox - $0 } ?? scrollLeft
        let from = PaperDraw.Layout(tops: tops, pageW: pageW, S: sheetW)
        let oldW = pageW
        applyGeometry(clamp(z, PaperZoom.ZOOM_MIN, PaperZoom.ZOOM_MAX))
        let at = PaperDraw.settleView(W: pdfW, ox: ox, oy: oy, top: top, left: left, from: from, to: PaperDraw.Layout(tops: tops, pageW: pageW, S: sheetW))
        scrollTo(x: at.left, y: at.top)
        arrangeNear()
        // A pending selection is kept in px of the layout it was made in: carried over.
        if var p = pendingSel {
            p.parts = p.parts.map { Marks.scalePart($0, from: $0.u != 0 ? $0.u : oldW, to: pageW) }
            pendingSel = p
            showPending()
        }
        for s in sheets { s.drawn = false; s.failed = false }
        syncChrome()
        if draw { pump() }
    }

    /// A trackpad pinch (magnify events) or ⌃ / ⌘ scroll: the paper scaled as one, laid out 180 ms after the last event.
    func pinch(_ wheel: PaperZoom.Wheel, pointerY: Double) {
        guard laidOut else { return }
        let from = live ?? zoom
        let to = PaperZoom.wheelZoom(from, wheel)
        if to != from {
            if pinching == nil {
                let b = clip.bounds
                pinching = (Double(b.midX), Double(b.minY) + clamp(pointerY, 0, Double(b.height)))
            }
            closeMention()
            live = to
            css = to / renderedZoom
            if let p = pinching { scrollView.setMagnification(CGFloat(css), centeredAt: NSPoint(x: p.ox, y: p.oy)) }
            cardsInverse(css)
            syncChrome()
        }
        pinchTimer?.invalidate()
        pinchTimer = Timer.scheduledTimer(withTimeInterval: PaperZoom.PINCH_SETTLE, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.endPinch() }
        }
    }

    /// The pinch settled: laid out at its zoom. `drop`: nothing laid out (another paper).
    func endPinch(drop: Bool = false) {
        pinchTimer?.invalidate(); pinchTimer = nil
        let p = pinching, z = live
        pinching = nil; live = nil
        guard p != nil || scrollView.magnification != 1 else { return }
        let b = clip.bounds, mag = Double(scrollView.magnification)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        if !drop, let p, let z {
            // where the pinch's point is on the pane now (the clip view may have kept the paper's top at the pane's top)
            let paneX = (p.ox - Double(b.minX)) * mag, paneY = (p.oy - Double(b.minY)) * mag
            scrollView.magnification = 1
            css = 1
            rezoom(z, ox: p.ox, oy: p.oy, paneX: paneX, paneY: paneY)
            cardsInverse(1)
        } else {
            scrollView.magnification = 1
            css = 1
            cardsInverse(1)
        }
        CATransaction.commit()
    }

    /// The pane resized: 100% is still the page as wide as the pane, so the sheets take the new width at once (the top of
    /// the view kept) and are drawn for it once the resize has settled (150 ms; 200 before the first layout).
    func onResize() {
        let W = Double(clip.bounds.width)
        pdfH = Double(clip.bounds.height)
        guard doc != nil else { return }
        if !laidOut {
            resizeWork?.cancel()
            let w = DispatchWorkItem { [weak self] in self?.layoutPaper() }
            resizeWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: w)
            return
        }
        if W == pdfW || W < 40 { return }
        endPinch(drop: true)
        rezoom(zoom, ox: scrollLeft + Double(clip.bounds.width) / 2, oy: scrollTop, draw: false)
        drawWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.pump() }
        drawWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: w)
    }

    // MARK: - drawing pages (MATH-71)

    /// The next turn of the drawing loop, after this one (a page a turn: input and painting go between).
    func pump() {
        guard !pumpScheduled else { return }
        pumpScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pumpScheduled = false
            self.pumpStep()
        }
    }

    func pumpStep() { PaperTrace.measure("pumpStep") { pumpStepBody() } }
    func pumpStepBody() {
        guard laidOut, pinching == nil, let r = viewRange() else { return }
        let N = sheets.count
        // drawings far from the view given back; ink drawn only near it
        for (i, s) in sheets.enumerated() {
            let far = PaperDraw.tooFar(i + 1, r.first, r.last)
            if s.image != nil && far { s.dropDrawing() }
            s.inkLayer.active = !far
        }
        // a drawing under way of a page gone far is stopped (drawn again when it comes back)
        if renderingPage > 0, PaperDraw.tooFar(renderingPage, r.first, r.last, keep: PaperDraw.DRAW_AHEAD) { renderer?.cancel(renderToken) }
        var more = false
        // the drawings: the pages in view first, then DRAW_AHEAD each side
        if renderingPage == 0 {
            if let n = PaperDraw.nearOrder(r.first, r.last, r.current, N).first(where: { !sheets[$0 - 1].drawn && !sheets[$0 - 1].failed }) {
                drawPage(n)
            } else if let n = PaperDraw.allOrder(r.first, r.last, r.current, N).first(where: { thumbDue($0, r) }) {
                drawThumb(n)
            }
        }
        // the marks and cards of the pages nearest the view first, as many as fit in a slice of the turn (Electron drew a
        // page a turn: drawPages awaits nextTick between pages); the rest on the next turns. At least one a turn.
        let deadline = PaperTrace.now() + 0.012
        var did = 0
        for n in PaperDraw.allOrder(r.first, r.last, r.current, N) {
            let s = sheets[n - 1]
            let marksDue = s.marksW != pdfW, cardsDue = s.cards > 0 && s.cardsAt != cardKey()
            guard marksDue || cardsDue else { continue }
            if did > 0 && PaperTrace.now() > deadline { more = true; break }
            if marksDue { renderMarks(n) } else { arrange([n]) }
            did += 1
        }
        if !findSpots.isEmpty || section != nil { paintTints() }
        if more { pump() }
    }

    func thumbDue(_ n: Int, _ r: (first: Int, last: Int, current: Int)) -> Bool {
        let s = sheets[n - 1]
        return s.thumb == nil && !s.thumbFailed && !PaperDraw.tooFar(n, r.first, r.last, keep: PaperZoom.THUMB_AHEAD)
    }

    func drawPage(_ n: Int) {
        guard let renderer else { return }
        let s = sheets[n - 1], h = pageHs[n - 1]
        let px = Int((pageW * PaperZoom.canvasScale(pageW, h)).rounded(.down))
        let myGen = gen, myZoom = renderedZoom, myW = pdfW
        renderingPage = n
        renderToken = renderer.render(page: n, pixelWidth: px) { [weak self] image in
            guard let self, self.gen == myGen else { return }
            self.renderingPage = 0
            if self.renderedZoom == myZoom, self.pdfW == myW, n <= self.sheets.count {
                PaperTrace.measure("drawn \(n)") {
                    if let image {
                        s.image = image; s.drawn = true
                        // its small drawing scaled down off the main thread
                        if s.thumb == nil {
                            DispatchQueue.global(qos: .utility).async {
                                let t = Self.scaledDown(image)
                                DispatchQueue.main.async { if s.thumb == nil { s.thumb = t } }
                            }
                        }
                    } else { s.failed = true }
                }
            }
            self.pump()
        }
    }

    func drawThumb(_ n: Int) {
        guard let renderer else { return }
        let s = sheets[n - 1], myGen = gen
        renderingPage = n
        renderToken = renderer.render(page: n, pixelWidth: Int(PaperZoom.THUMB_W)) { [weak self] image in
            guard let self, self.gen == myGen else { return }
            self.renderingPage = 0
            if let image { if s.thumb == nil { s.thumb = image } } else { s.thumbFailed = true }
            self.pump()
        }
    }

    /// A page's small drawing made from its drawing: THUMB_W px wide.
    nonisolated static func scaledDown(_ image: CGImage) -> CGImage? {
        let w = Int(PaperZoom.THUMB_W), h = max(1, Int((Double(image.height) * PaperZoom.THUMB_W / Double(image.width)).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    // MARK: - text

    /// Every page's text, nearest the view first (find and passages search all of it).
    func readOrder() {
        guard let r = viewRange() else { return }
        reader?.want(PaperDraw.allOrder(r.first, r.last, r.current, sheets.count).filter { texts[$0] == nil })
    }

    func readText(_ n: Int, _ t: PageText) { PaperTrace.measure("readText \(n)") { readTextBody(n, t) } }
    func readTextBody(_ n: Int, _ t: PageText) {
        texts[n] = t
        norm[n] = t.normalized
        let lines = t.lines.filter { $0.chars >= 3 }
        if let col = Canvas.textColumn(lines.map(\.box.x), lines.map { $0.box.x + $0.box.w }) { cols[n] = col }
        // The page's notes go by its printed text (its column, the room beside it), which only now is known: laid out
        // again; drawn again only when a typed note without a width is measured against that text (cardWidth).
        if !marks[n].isEmpty, n <= sheets.count {
            if marks[n].contains(where: { $0.rects.isEmpty && $0.pos != nil && !(($0.w ?? 0) > 0) }) { sheets[n - 1].marksW = nil } else { sheets[n - 1].cardsAt = "" }
        }
        // a note of the page before can lie over this one (pageOver): laid out again now its text is known
        if n >= 2, cols[n] != nil, sheets[n - 2].cards > 0 { arrange([n - 1]) }
        for w in textWaiters.removeValue(forKey: n) ?? [] { w(t) }
        textsDone()
        pump()
    }


    /// A stretch of a page's normalized text → PDFKit's character range.
    func pdfRange(_ page: Int, _ from: Int, _ to: Int?) -> NSRange? {
        guard let n = norm[page] else { return nil }
        let a = n.map[min(from, n.map.count - 1)], b = n.map[min(to ?? (n.map.count - 1), n.map.count - 1)]
        return b > a ? NSRange(location: a, length: b - a) : nil
    }

    func pageTextsRead() -> [(page: Int, text: String)] { norm.keys.sorted().map { ($0, norm[$0]!.text) } }

    /// The first time every page has its text: a search and a passage found again, over all of it.
    func textsDone() {
        guard textsAt != gen, texts.count == sheets.count, !sheets.isEmpty else {
            if let p = target.page, texts[p] != nil { targetOn(p) }
            return
        }
        textsAt = gen
        if !findQuery.isEmpty { report(find(findQuery, step: 0, scroll: false)) }
        if let s = section { section?.spot = sectionStart(s.text).spot ?? s.spot; paintTints() }
        if let p = target.page { targetOn(p) }
        if let key = gate.drawn() { applyTarget(key) }
    }

    /// Page n's text, now or when it is read (within 2 s: '' after that, as pageTextAround).
    func withText(_ n: Int, _ done: @escaping (PageText?) -> Void) {
        if let t = texts[n] { done(t); return }
        textWaiters[n, default: []].append(done)
        reader?.want([n] + PaperDraw.allOrder(n, n, n, sheets.count).filter { texts[$0] == nil && $0 != n })
        let myGen = gen
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.gen == myGen, var list = self.textWaiters[n], !list.isEmpty else { return }
            self.textWaiters[n] = nil
            let late = list; list = []
            for w in late { w(nil) }
        }
    }

    // MARK: - find (the Stage's ⌘F)

    /// `step` 0: a new query starts at the first match in view or below (the same query keeps its place); ±1 the
    /// next / previous, wrapping; '' stops. `fromStart`: counted from page 1. → (matches, active from 1).
    @discardableResult
    public func find(_ query: String, step: Int = 0, scroll: Bool = true, fromStart: Bool = false) -> (matches: Int, active: Int) {
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { stopFind(); return (0, 0) }
        let fresh = query != findQuery
        findQuery = query
        findSpots = PaperFind.matchSpots(query, pages: pageTextsRead())
        let plan = PaperFind.nextFind(fresh: fresh, step: step, count: findSpots.count, at: findAt, fromStart: fromStart, firstInView: { self.firstInView() })
        findAt = plan.at
        paintTints()
        if scroll && plan.scroll, findAt >= 0 { scrollToSpot(findSpots[findAt]) }
        return (findSpots.count, findAt + 1)
    }

    public func stopFind() {
        findQuery = ""; findAt = -1; findSpots = []
        paintTints()
    }

    func report(_ r: (matches: Int, active: Int)) { host?.paperFound(matches: r.matches, active: r.active) }

    func spotRects(_ s: FindSpot) -> [PRect] {
        guard let range = pdfRange(s.page, s.from, s.to), s.page <= geoms.count, let chars else { return [] }
        return Marks.mergeLineRects(chars.rects(page: s.page, range: range, geometry: geoms[s.page - 1]))
    }

    func firstInView() -> Int {
        let top = scrollTop
        for (i, s) in findSpots.enumerated() where s.page <= tops.count {
            if tops[s.page - 1] + pageHs[s.page - 1] < top { continue }
            if let b = spotRects(s).last, tops[s.page - 1] + (b.y + b.h) * pageW >= top { return i }
            if tops[s.page - 1] >= top { return i }
        }
        return 0
    }

    /// A match out of view is brought a third of the way down (and across) the pane.
    func scrollToSpot(_ s: FindSpot) {
        guard let first = spotRects(s).first, s.page <= tops.count else { return }
        let b = clip.bounds
        let top = tops[s.page - 1] + first.y * pageW, bottom = top + first.h * pageW
        let left = G + first.x * pageW, right = left + first.w * pageW
        var x = Double(b.minX), y = Double(b.minY)
        if top < y + 24 || bottom > Double(b.maxY) - 24 { y += top - y - Double(b.height) / 3 }
        if left < x || right > x + Double(b.width) { x += left - x - Double(b.width) / 3 }
        scrollTo(x: max(0, x), y: max(0, y))
    }

    /// Find's tints and the section's, on the pages near the view (and the active match's).
    func paintTints() { PaperTrace.measure("paintTints") { paintTintsBody() } }
    func paintTintsBody() {
        guard !sheets.isEmpty else { return }
        let r = viewRange() ?? (1, 1, 1)
        var tints: [Int: SheetTints] = [:]
        func near(_ p: Int) -> Bool { !PaperDraw.tooFar(p, r.first, r.last, keep: PaperDraw.DRAW_AHEAD) }
        for (i, s) in findSpots.enumerated() where near(s.page) || i == findAt {
            let rects = spotRects(s)
            if i == findAt { tints[s.page, default: SheetTints()].active += rects } else { tints[s.page, default: SheetTints()].matches += rects }
        }
        if let sec = section {
            let spans = (sec.to.isEmpty ? nil : PaperFind.sectionSpans(sec.spot, PaperFind.matchSpots(sec.to, pages: pageTextsRead()))) ?? [sec.spot]
            for sp in spans where near(sp.page) { tints[sp.page, default: SheetTints()].section += spotRects(sp) }
        }
        for (i, s) in sheets.enumerated() {
            let t = tints[i + 1] ?? SheetTints()
            if t.section.isEmpty && t.matches.isEmpty && t.active.isEmpty && s.tintLayer.tints.section.isEmpty && s.tintLayer.tints.matches.isEmpty && s.tintLayer.tints.active.isEmpty { continue }
            s.tintLayer.tints = t
        }
    }

    // MARK: - sections (a link's passage)

    /// Where a section starts: its words' first match from page 1.
    func sectionStart(_ text: String) -> (spot: FindSpot?, matches: Int) {
        let spots = PaperFind.matchSpots(text, pages: pageTextsRead())
        return (spots.first, spots.count)
    }

    /// A section: its start words found from page 1 and scrolled to, and tinted to just before `to`. Nothing matching
    /// clears it and leaves the scroll.
    @discardableResult
    public func showSection(_ find: String, to: String = "") -> (matches: Int, active: Int) {
        if find.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { clearSection(); return (0, 0) }
        let s = sectionStart(find)
        guard let spot = s.spot else { clearSection(); return (0, 0) }
        section = (find, to, spot)
        paintTints()
        scrollToSpot(spot)
        return (s.matches, 1)
    }

    public func clearSection() { section = nil; paintTints() }

    /// A link's passage to show (the Stage's pendingFind): once its pages have their text; told through paperTarget.
    public func setTarget(_ find: String?, to: String? = nil, page: Int? = nil) {
        target = (find, to, page)
        if let text = gate.set(PaperFind.targetKey(find, to)) { applyTarget(text) }
        else if find != nil, let page {
            toPage(page)
            if texts[page] != nil { targetOn(page) }
            pump()
        }
    }

    func targetOn(_ n: Int) {
        guard let p = target.page, n == p, let key = gate.peek() else { return }
        let words = String(key.split(separator: "\n", omittingEmptySubsequences: false).first ?? "")
        guard PaperFind.matchSpots(words, pages: norm[n].map { [(n, $0.text)] } ?? []).first != nil else { return }
        gate.claim()
        applyTarget(key)
    }

    func applyTarget(_ key: String) {
        let parts = key.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let text = parts[0], to = parts.count > 1 ? parts[1] : ""
        let r = showSection(text, to: to)
        host?.paperTarget(text, matches: r.matches, active: r.active)
    }

    func clamp(_ v: Double, _ a: Double, _ b: Double) -> Double { max(a, min(b, v)) }
}

extension PaperViewController: PaperCanvasOwner {
    func canvasZoomWheel(_ e: NSEvent) -> Bool {
        let dy = e.hasPreciseScrollingDeltas ? -Double(e.scrollingDeltaY) : -Double(e.scrollingDeltaY) * 40 / 16
        let p = clip.convert(e.locationInWindow, from: nil)
        pinch(PaperZoom.Wheel(deltaY: dy, lines: !e.hasPreciseScrollingDeltas), pointerY: Double(p.y - clip.bounds.minY))
        return true
    }
    func canvasMagnify(_ e: NSEvent) {
        let p = clip.convert(e.locationInWindow, from: nil)
        pinch(PaperZoom.pinchWheel(magnification: Double(e.magnification)), pointerY: Double(p.y - clip.bounds.minY) * Double(scrollView.magnification))
        if e.phase == .ended || e.phase == .cancelled { /* settles by its timer, as the wheel events do */ }
    }
}
