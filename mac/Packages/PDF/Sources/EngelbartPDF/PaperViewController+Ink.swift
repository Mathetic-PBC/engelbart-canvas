import AppKit
import PDFKit
import EngelbartCore
import EngelbartUI

// Engelbart's ink on the paper (PaperView.jsx): selections → a pending highlight → a note typed in the margin, Enter for a
// bare highlight, a click on the page for a note there; cards and their answers; removing and ⌘Z; ⌘C; @ mentions;
// @bart from a highlight's note.

extension PaperViewController {
    // MARK: - persistence

    func scheduleSave() {
        dirty = true
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.saveTimer = nil; self?.emit() }
        }
    }

    func flushSave() {
        guard saveTimer != nil else { return }
        saveTimer?.invalidate(); saveTimer = nil
        emit()
    }

    func emit() {
        let kept = Canvas.kept(marks)
        do { host?.paperMarksChanged(kept, json: try AnnotationJSON.encode(kept)) } catch { host?.paperError(error.localizedDescription) }
    }

    // MARK: - geometry helpers

    /// A point of the canvas → its page and the point in that page's sheet (x the sheet's, y from the sheet's top).
    func sheetPoint(_ p: NSPoint) -> (page: Int, x: Double, y: Double)? {
        guard !tops.isEmpty else { return nil }
        let n = PaperZoom.pageAt(tops, Double(p.y))
        return (n, Double(p.x), Double(p.y) - tops[n - 1])
    }

    /// The page under y px of page n's sheet (PaperView pageOver).
    func pageOver(_ n: Int, _ y: Double) -> Int {
        let abs = (n - 1 < tops.count ? tops[n - 1] : 0) + y
        var q = n
        while q < tops.count && tops[q] <= abs { q += 1 }
        while q > 1 && tops[q - 1] > abs { q -= 1 }
        return q
    }

    func boxScale(_ page: Int = 1) -> Double { Canvas.noteScale(pageW) }
    func cardKey() -> String { "\(renderedZoom)|\(pdfW)|\(Int(jsRound(viewX)))" }
    func showsNotes() -> Bool { host?.paperOpensMentions ?? false }
    func asksFrom(_ m: Mark?) -> Bool { (host?.paperCanAsk ?? false) && (m?.isHighlight ?? false) }
    /// 40% of the pane's height, note px (at least 140).
    func boxMaxHeight() -> CGFloat { CGFloat(jsRound(max(140, (pdfH > 0 ? pdfH : 600) * 0.4) / boxScale())) }
    /// The widest a card may be, to be seen whole: the pane less 16 each side.
    func paneFit() -> Double { pdfW > 0 ? max(140, pdfW - 32) / boxScale() : .infinity }

    func names() -> AnswerFormat.Names {
        AnswerFormat.Names(lib: { [weak self] id in self?.libName(id) ?? nil }, source: { [weak self] a in self?.host?.paperCitationSource(a) },
                           fileState: { [weak self] f, r in self?.host?.paperFileState(folderId: f, rel: r) })
    }

    /// A mentioned item's name now: .some(nil) gone, nil unknown.
    func libName(_ id: String) -> String?? { host?.paperLibraryName(id) ?? nil }

    // MARK: - drawing marks (renderMarks)

    /// Every page's marks drawn again: near the view now, the rest as the loop comes to them.
    func renderAllMarks() {
        libDrawn = libKey()
        let r = viewRange()
        for n in sheets.indices.map({ $0 + 1 }) {
            if let r, PaperDraw.tooFar(n, r.first, r.last, keep: PaperDraw.DRAW_AHEAD) { sheets[n - 1].marksW = nil } else { renderMarks(n) }
        }
        pump()
    }

    /// Page n's highlights (bands → rough zigzags in desk px) and cards (one a mark with a note, an answer or a run).
    func renderMarks(_ n: Int) { PaperTrace.measure("renderMarks \(n)") { renderMarksBody(n) } }
    func renderMarksBody(_ n: Int) {
        guard n >= 1, n <= sheets.count else { return }
        let s = sheets[n - 1]
        s.marksW = pdfW
        let P = pdfW > 0 ? pdfW : 1 // desk px: the pane's width (the highlight layer's viewBox)
        let list = marks[n]
        var ink = s.inkLayer.ink
        ink.deskW = P
        ink.zigzags = PaperTrace.measure("zigzags \(n)") { Marks.mergeLineRects(list.flatMap { Marks.bandRects($0.rects) }).map { b in
            let ops = Rough.zigzagRectangle(b.x * P, b.y * P + b.h * P * 0.12, b.w * P, b.h * P * 0.76, .highlight(seed: Marks.boxSeed(page: n, b)))
            return Rough.strokes(ops)
        } }
        s.inkLayer.ink = ink
        // cards
        let running = pendingAsks.filter { $0.page == n && !$0.askId.isEmpty }
        var keep: [String: CardView] = [:]
        var specs: [CardLayout.Spec] = []
        let existing = cards[n] ?? [:]
        redrawing += 1
        defer { redrawing -= 1 }
        for m in list {
            let asks = Canvas.shownAsks(m), runs = running.filter { $0.markId == m.id }
            if m.note == nil && asks.isEmpty && runs.isEmpty { continue }
            let card = existing[m.id] ?? PaperTrace.measure("new card \(n)") { CardView(markId: m.id, page: n) }
            card.owner = self; card.page = n
            if card.superview == nil { canvas.cardsLayer.addSubview(card, positioned: .below, relativeTo: handle) }
            PaperTrace.measure("configure \(n)") { card.configure(CardView.Content(mark: m, asks: asks, runs: runs, editing: editing == m.id, showsNotes: showsNotes(), asksFrom: asksFrom(m),
                                            names: names(), maxBody: boxMaxHeight(), canContinue: host?.paperCanContinue ?? false, canCopy: true, openLogs: openLogs)) }
            let sel = selCard == m.id
            card.ground = sel ? .white : nil
            let side = m.side == "left" ? "left" : "right"
            specs.append(CardLayout.Spec(id: m.id, markY: m.y, pos: m.pos, how: sel || m.pos == nil ? side : "pos", sel: sel, fixed: m.pos != nil && !sel,
                                         want: min(cardWidth(m, n), paneFit()), typing: card.typing))
            keep[m.id] = card
        }
        for (id, c) in existing where keep[id] == nil { c.removeFromSuperview() }
        cards[n] = keep
        drawnSpecs[n] = specs
        s.cards = specs.count
        arrange([n])
        showPending()
        paintFocus(focusId ?? hovered)
        if let open = mention, open.page == n { if noteField(open.markId)?.window?.firstResponder !== noteField(open.markId) { closeMention() } else { placeMenu() } }
    }

    /// The width a card would be, note px: a typed note's `w`; a free note without one measured against the text beside it
    /// now; a highlight's NOTE_W.
    func cardWidth(_ m: Mark, _ page: Int) -> Double {
        if let w = m.w, w > 0 { return w }
        if let pos = m.pos, m.rects.isEmpty {
            let at = Canvas.placeOf(pos, G, pageW > 0 ? pageW : 1)
            return Canvas.freeNoteWidth(at.left, textAfter(page, at.left, at.top + Canvas.POS_DY, 29), .infinity, boxScale(page))
        }
        return Canvas.NOTE_W
    }

    /// The left edge (sheet px) of the nearest printed text right of x on the band y … y + h; ∞ with none.
    func textAfter(_ n: Int, _ x: Double, _ y: Double, _ h: Double) -> Double {
        guard let t = texts[n] else { return .infinity }
        var best = Double.infinity
        for (b, _) in t.lines {
            let l = G + b.x * pageW
            if (b.y + b.h) * pageW < y || b.y * pageW > y + h { continue }
            if l > x && l < best { best = l }
        }
        return best
    }

    // MARK: - placing cards (arrangePages)

    func arrangeNear() {
        guard let r = viewRange() else { return }
        let pages = (max(1, r.first - PaperDraw.DRAW_AHEAD)...min(sheets.count, r.last + PaperDraw.DRAW_AHEAD)).filter { sheets[$0 - 1].cards > 0 && sheets[$0 - 1].marksW == pdfW }
        if !pages.isEmpty { arrange(pages) }
    }

    func arrange(_ pageList: [Int]) { PaperTrace.measure("arrange \(pageList)") { arrangeBody(pageList) } }
    func arrangeBody(_ pageList: [Int]) {
        guard laidOut else { return }
        let key = cardKey()
        var input: [CardLayout.Page] = []
        for n in pageList where n >= 1 && n <= sheets.count {
            sheets[n - 1].cardsAt = key
            guard let specs = drawnSpecs[n], !specs.isEmpty else { continue }
            input.append(CardLayout.Page(page: n, G: G, pageW: pageW, pageH: pageHs[n - 1], column: cols[n], specs: specs))
        }
        guard !input.isEmpty else { placeSelCard(); return }
        var keepShown = Set<String>()
        if let e = editing { keepShown.insert(e) }
        if let d = drag { keepShown.insert(d.markId) }
        let dragged = drag.flatMap { $0.moved ? CardLayout.Dragged(id: $0.markId, left: $0.left, top: $0.top, w: $0.w) : nil }
        let out = CardLayout.arrange(input, view: .init(x0: viewX, W: pdfW > 0 ? pdfW : Double(clip.bounds.width)), dragged: dragged, keepShown: keepShown,
            measure: { [weak self] id, w in
                guard let self, let c = self.cardView(id) else { return (w, 0) }
                let s = PaperTrace.measure("layoutCard \(c.page)") { c.layoutCard(w: CGFloat(w)) }
                return (Double(s.width), Double(s.height))
            },
            pageOver: { [weak self] p, y in self?.pageOver(p, y) ?? p },
            columnOf: { [weak self] q in self?.cols[q] },
            typedPlace: { [weak self] id, w, h in self?.typedPlace(id, w, h) })
        for (id, p) in out {
            places[id] = p
            guard let c = cardView(id) else { continue }
            c.isHidden = p.hidden
            c.place(origin: NSPoint(x: p.left, y: tops[c.page - 1] + p.top), scale: CGFloat(p.ns * inverse(p.ns)))
        }
        placeHandle()
        placeSelCard()
    }

    /// While a pinch scales the paper by c, a card is held at NOTE_FLOOR (--inv); 1 otherwise.
    func inverse(_ ns: Double) -> Double { css == 1 ? 1 : max(ns * css, Canvas.NOTE_FLOOR) / (ns * css) }

    func cardsInverse(_ c: Double) {
        for (_, list) in cards { for (id, card) in list { if let p = places[id] { card.place(origin: card.frame.origin, scale: CGFloat(p.ns * inverse(p.ns))) } } }
        placeHandle()
    }

    func cardView(_ id: String) -> CardView? {
        for (_, list) in cards { if let c = list[id] { return c } }
        return nil
    }

    func noteField(_ id: String) -> NoteField? { cardView(id)?.note }

    /// The move handle under the hovered card's lower right (shown while the pointer is on the card, not while dragging).
    func placeHandle() {
        guard let id = hovered, drag == nil, let c = cardView(id), !c.isHidden else { handle.isHidden = true; return }
        handle.card = c
        handle.frame = NSRect(x: c.frame.maxX - 15, y: c.frame.maxY, width: 15, height: 15)
        handle.isHidden = false
        handle.onPress = { [weak self] e in
            guard let self else { return }
            if let f = c.note, self.view.window?.firstResponder === f { self.view.window?.makeFirstResponder(self.canvas) }
            guard e.type == .leftMouseDown, let window = self.view.window, self.startDrag(c, at: e) else { return }
            self.downHere = true
            self.trackDrag(window)
        }
    }

    // MARK: - the mark in focus (MATH-15)

    func paintFocus(_ id: String?) {
        painted = id
        for (i, s) in sheets.enumerated() {
            let list = id.flatMap { mid in marks[i + 1].first { $0.id == mid } }
            let bands = list.map { Marks.bandRects($0.rects) } ?? []
            if bands.isEmpty && s.inkLayer.ink.focus.isEmpty { continue }
            s.inkLayer.ink.focus = bands
        }
    }

    func focusMark(_ id: String?) { focusId = id; paintFocus(focusId ?? hovered) }

    /// The mark under a point of page n's sheet: the last drawn wins; its bands ± 2 px.
    func markAt(_ n: Int, _ x: Double, _ y: Double) -> Mark? {
        let u = pageW
        for m in marks[n].reversed() where !m.rects.isEmpty {
            if Marks.bandRects(m.rects).contains(where: { x >= G + $0.x * u - 2 && x <= G + ($0.x + $0.w) * u + 2 && y >= $0.y * u - 2 && y <= ($0.y + $0.h) * u + 2 }) { return m }
        }
        return nil
    }

    // MARK: - pressing on the paper

    func canvasMouseMoved(_ e: NSEvent) {}

    func canvasMouseDown(_ e: NSEvent) {
        let p = canvas.convert(e.locationInWindow, from: nil)
        downHere = true
        let typing = editing != nil && (view.window?.firstResponder as? NoteField) != nil
        down = (Double(p.x), Double(p.y), typing || pendingSel != nil || focusId != nil, e.type == .leftMouseDown ? 0 : 2)
        clearPending()
        view.window?.makeFirstResponder(canvas) // a note being typed in loses the keyboard (leaveNote)
        selecting = nil; dragSel = false; liveSel = [:]
        if e.type == .leftMouseDown, let sp = sheetPoint(p) { selecting = (sp.page, CGPoint(x: sp.x, y: sp.y)) }
    }

    func canvasMouseDragged(_ e: NSEvent) {
        guard let start = selecting, let d = down else { return }
        let p = canvas.convert(e.locationInWindow, from: nil)
        if !dragSel && hypot(Double(p.x) - d.x, Double(p.y) - d.y) < 3 { return }
        dragSel = true
        canvas.autoscroll(with: e)
        guard let sel = selection(from: start, to: p) else { liveSel = [:]; showLive(); return }
        liveSel = Dictionary(uniqueKeysWithValues: partsOf(sel, text: "").map { ($0.page, $0.rects.map { $0.scaled(1 / pageW) }) })
        showLive()
    }

    func canvasMouseUp(_ e: NSEvent) {
        let p = canvas.convert(e.locationInWindow, from: nil)
        defer { selecting = nil; dragSel = false }
        if dragSel, let start = selecting {
            liveSel = [:]; showLive()
            guard let raw = selection(from: start, to: p), let sel = snapWords(raw) else { clearPending(); return }
            let text = (sel.string ?? "")
            let parts = partsOf(sel, text: text)
            if parts.isEmpty { return }
            pendingSel = (parts, text)
            showPending()
            openSelCard()
            return
        }
        guard let d = down, hypot(Double(p.x) - d.x, Double(p.y) - d.y) < Canvas.PRESS_MOVE, let sp = sheetPoint(p) else { return }
        // A click on a highlight shows which note is its; a click anywhere else puts that away. Typing anywhere: a click
        // that put nothing away, on anything but the printed words, writes a note there.
        if let hit = markAt(sp.page, sp.x, sp.y) { focusMark(hit.id); return }
        if focusId != nil { focusMark(nil) }
        if d.closed || d.button != 0 { return }
        if let chars, sp.page <= geoms.count, chars.onText(page: sp.page, at: CGPoint(x: (sp.x - G) / pageW, y: sp.y / pageW), geometry: geoms[sp.page - 1]) { return }
        writeAt(sp.page, sp.x, sp.y)
    }

    // MARK: - selections (PDFKit)

    /// A sheet point → the page-space point of its page (clamped to the page: a drag past a line or in a margin).
    func pdfPoint(_ page: Int, _ x: Double, _ y: Double) -> CGPoint {
        let g = geoms[page - 1]
        let ux = min(max(0, (x - G) / pageW), 1), uy = min(max(0, y / pageW), g.height / g.width)
        return g.pagePoint(CGPoint(x: ux, y: uy))
    }

    func selection(from start: (page: Int, point: CGPoint), to p: NSPoint) -> PDFSelection? {
        guard let doc, let end = sheetPoint(p) else { return nil }
        var a = (start.page, pdfPoint(start.page, Double(start.point.x), Double(start.point.y)))
        var b = (end.page, pdfPoint(end.page, end.x, end.y))
        if b.0 < a.0 || (b.0 == a.0 && (start.point.y > CGFloat(end.y) + 0.5 || (abs(start.point.y - CGFloat(end.y)) <= 0.5 && start.point.x > CGFloat(end.x)))) { swap(&a, &b) }
        guard let pa = doc.page(at: a.0 - 1), let pb = doc.page(at: b.0 - 1) else { return nil }
        let sel = doc.selection(from: pa, at: a.1, to: pb, at: b.1)
        guard let sel, !(sel.string ?? "").isEmpty else { return nil }
        return sel
    }

    /// The selection widened to whole words at both ends (marks.js wordBounds), each end in its own page's text.
    func snapWords(_ sel: PDFSelection) -> PDFSelection? {
        guard let doc else { return sel }
        let pages = sel.pages.compactMap { p -> (Int, PDFPage)? in let i = doc.index(for: p); return i == NSNotFound ? nil : (i + 1, p) }.sorted { $0.0 < $1.0 }
        guard let first = pages.first, let last = pages.last else { return nil }
        func ranges(_ p: PDFPage) -> [NSRange] { (0..<sel.numberOfTextRanges(on: p)).map { sel.range(at: $0, on: p) }.filter { $0.location != NSNotFound } }
        guard let r0 = ranges(first.1).min(by: { $0.location < $1.location }), let r1 = ranges(last.1).max(by: { NSMaxRange($0) < NSMaxRange($1) }) else { return sel }
        let s0 = (first.1.string ?? ""), s1 = (last.1.string ?? "")
        let a = Marks.wordBounds(s0, from: r0.location, to: r0.location).from
        let b = Marks.wordBounds(s1, from: NSMaxRange(r1), to: NSMaxRange(r1)).to
        guard b > 0 else { return sel }
        return doc.selection(from: first.1, atCharacterIndex: a, to: last.1, atCharacterIndex: b - 1) ?? sel
    }

    /// A selection's parts, a page each (marks.js selectionParts): its characters' boxes in the layout's px.
    func partsOf(_ sel: PDFSelection, text: String) -> [Marks.Part] {
        guard let doc, let chars else { return [] }
        var pieces: [Marks.Piece] = []
        let pages = sel.pages
        for page in pages {
            let i = doc.index(for: page)
            guard i != NSNotFound else { continue }
            let n = i + 1, g = geoms[i]
            var rects: [PRect] = [], partText = ""
            for k in 0..<sel.numberOfTextRanges(on: page) {
                let r = sel.range(at: k, on: page)
                guard r.location != NSNotFound, r.length > 0 else { continue }
                rects += chars.rects(page: n, range: r, geometry: g).map { $0.scaled(pageW) }.filter { $0.w > 1 && $0.h > 1 }
                partText += ((page.string ?? "") as NSString).substring(with: NSRange(location: r.location, length: min(r.length, ((page.string ?? "") as NSString).length - r.location)))
            }
            pieces.append(Marks.Piece(page: n, rects: rects, width: pageW, text: pages.count > 1 ? partText.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") : text, u: pageW))
        }
        return Marks.selectionParts(pieces)
    }

    func showLive() {
        for (i, s) in sheets.enumerated() {
            let l = liveSel[i + 1] ?? []
            if l.isEmpty && s.inkLayer.ink.live.isEmpty { continue }
            s.inkLayer.ink.live = l
        }
    }

    /// The pending selection drawn as its bands on its pages, until a note is typed or it is put away.
    func showPending() {
        var by: [Int: [PRect]] = [:]
        for part in pendingSel?.parts ?? [] { by[part.page, default: []] += part.rects.map { $0.scaled(1 / (part.u != 0 ? part.u : pageW)) } }
        for (i, s) in sheets.enumerated() {
            let l = by[i + 1] ?? []
            if l.isEmpty && s.inkLayer.ink.pending.isEmpty { continue }
            s.inkLayer.ink.pending = l
        }
        placeSelCard()
    }

    func clearPending() { pendingSel = nil; showPending(); closeSelCard() }

    // MARK: - the selection's card (2026-10-18)

    /// Where a selection is in the canvas: its last line and all of it.
    func selectionGeom(_ parts: [(page: Int, rects: [PRect], u: Double)]) -> (line: CGRect, all: CGRect, page: Int)? {
        var boxes: [[CGRect]] = []
        for part in parts where part.page <= tops.count && !part.rects.isEmpty {
            let f = pageW / (part.u != 0 ? part.u : 1)
            boxes.append(part.rects.map { CGRect(x: G + $0.x * f, y: tops[part.page - 1] + $0.y * f, width: $0.w * f, height: $0.h * f) })
        }
        guard let last = boxes.last else { return nil }
        let all = boxes.flatMap { $0 }
        let low = last.max { $0.maxY < $1.maxY }!
        let line = last.filter { $0.minY < low.maxY && $0.maxY > low.minY }
        func span(_ l: [CGRect]) -> CGRect { l.dropFirst().reduce(l[0]) { $0.union($1) } }
        return (span(line), span(all), parts.last!.page)
    }

    /// What shows of the pane, in the canvas, EDGE_PAD from its sides and clear of the bar.
    func selectionPane() -> CGRect {
        let b = clip.bounds, pad = CGFloat(Canvas.EDGE_PAD)
        let barRoom: CGFloat = !sheets.isEmpty && note.isEmpty ? 58 : pad
        return CGRect(x: b.minX + pad, y: b.minY + pad, width: max(0, b.width - 2 * pad), height: max(0, b.height - pad - barRoom))
    }

    func openSelCard() {
        closeSelCard()
        guard let p = pendingSel, let last = p.parts.last else { return }
        let v = SelectionCardView()
        v.page = last.page
        v.cardWidth = CGFloat(min(Canvas.NOTE_W, paneFit()))
        v.isHidden = true
        paperArea.addSubview(v, positioned: .below, relativeTo: bar)
        selCardView = v
        placeSelCard()
    }

    func closeSelCard() { selCardView?.removeFromSuperview(); selCardView = nil }

    /// The empty card where the pending selection is now; put away with the selection once that shows nowhere.
    func placeSelCard() {
        guard let v = selCardView else { return }
        guard let p = pendingSel else { closeSelCard(); return }
        let ns = CGFloat(boxScale(v.page))
        let size = NSSize(width: v.noteSize.width * ns, height: v.noteSize.height * ns)
        guard let geom = selectionGeom(p.parts.map { ($0.page, $0.rects, $0.u) }),
              let at = Canvas.selectionCardPlace(line: geom.line, all: geom.all, pane: selectionPane(), size: size) else {
            clearPending(); return
        }
        let o = paperArea.convert(NSPoint(x: at.minX, y: at.minY), from: canvas)
        v.frame = NSRect(x: o.x, y: o.y - size.height, width: size.width, height: size.height)
        v.isHidden = false
        v.needsDisplay = true
    }

    /// The card typed from the selection's card, where that card was (sheet px), while its selection shows.
    func typedPlace(_ id: String, _ w: Double, _ h: Double) -> (left: Double, top: Double)? {
        guard selCard == id, let found = marks.find(id) else { return nil }
        let parts: [(page: Int, rects: [PRect], u: Double)]
        if let g = found.mark.group {
            parts = marks.pages.keys.sorted().flatMap { pg in marks[pg].filter { $0.group == g }.map { (pg, $0.rects, 1.0) } }
        } else { parts = [(found.page, found.mark.rects, 1.0)] }
        guard let geom = selectionGeom(parts.map { ($0.page, $0.rects, $0.u) }),
              let at = Canvas.selectionCardPlace(line: geom.line, all: geom.all, pane: selectionPane(), size: CGSize(width: w, height: h)) else { return nil }
        return (Double(at.minX), Double(at.minY) - tops[found.page - 1])
    }

    func placeTypedCard() { if let id = selCard, let page = marks.find(id)?.page { arrange([page]) } }

    // MARK: - marks from a selection, and notes typed anywhere

    static func markId(_ prefix: String = "m") -> String {
        let chars = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return prefix + String(Int(Time.ms())) + String((0..<4).map { _ in chars[Int.random(in: 0..<36)] })
    }

    /// A selection's marks (partMarks + placeHighlight on each page) → the mark holding its first part.
    @discardableResult
    func addMark(_ parts: [Marks.Part], note: String?) -> Mark? {
        var first: Mark?
        for (page, mark) in Marks.partMarks(parts, note: note, newId: { Self.markId($0) }, widthOf: { [pageW] _ in pageW }) {
            let placed = Marks.placeHighlight(marks[page], mark)
            marks[page] = placed.list
            if first == nil { first = placed.mark; if note != nil { editing = placed.mark.id } }
            renderMarks(page)
        }
        scheduleSave()
        return first
    }

    /// A note at (x, y) of page n's sheet with the caret in it (writeAt): as wide as the room to its right.
    @discardableResult
    func writeAt(_ n: Int, _ xIn: Double, _ yIn: Double) -> Mark? {
        guard n <= sheets.count else { return nil }
        if sheets[n - 1].marksW != pdfW { renderMarks(n) }
        clearPending()
        let left = scrollLeft, right = left + pdfW - Canvas.EDGE_PAD
        let x = max(left + Canvas.EDGE_PAD, min(xIn, right - Canvas.FREE_MIN * boxScale(n)))
        let y = clamp(yIn, 0, pageHs[n - 1])
        let u = pageW > 0 ? pageW : 1
        var m = Mark(id: Self.markId(), rects: [], side: nil, y: y / u, note: "", text: "", pos: PPoint(x: (x - G) / u, y: y / u))
        m.w = Canvas.freeNoteWidth(x, textAfter(n, x, y - Canvas.POS_DY, 29), scrollLeft + pdfW, boxScale(n))
        editing = m.id
        marks[n] = marks[n] + [m]
        renderMarks(n)
        // not saved while it is empty: the first thing typed saves it, left empty it goes
        if let f = noteField(m.id) { view.window?.makeFirstResponder(f) }
        DispatchQueue.main.async { [weak self] in self?.revealCard(m.id) }
        return m
    }

    /// A card scrolled into the pane by as little as will do (REVEAL_PAD 16); `seen`: only when some of it shows.
    func revealCard(_ id: String, seen: Bool = false) {
        guard let c = cardView(id), !c.isHidden else { return }
        let r = c.frame, v = clip.bounds, pad: CGFloat = 16
        if seen && !r.intersects(v) { return }
        func along(_ lo: CGFloat, _ hi: CGFloat, _ vLo: CGFloat, _ vHi: CGFloat) -> CGFloat {
            hi - lo > vHi - vLo - 2 * pad || lo < vLo + pad ? lo - vLo - pad : hi > vHi - pad ? hi - vHi + pad : 0
        }
        let dx = along(r.minX, r.maxX, v.minX, v.maxX), dy = along(r.minY, r.maxY, v.minY, v.maxY)
        if dx != 0 || dy != 0 { scrollTo(x: max(0, Double(v.minX + dx)), y: max(0, Double(v.minY + dy))) }
    }

    // MARK: - keys

    func canvasKeyDown(_ e: NSEvent) -> Bool {
        if pendingSelKey(e) { return true }
        if markKey(e) { return true }
        return false
    }

    func canvasKeyEquivalent(_ e: NSEvent) -> Bool {
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key = (e.charactersIgnoringModifiers ?? "").lowercased()
        guard (flags.contains(.command) || flags.contains(.control)), !flags.contains(.shift), !flags.contains(.option) else { return false }
        if key == "z" { return undoKey() }
        if key == "c" { return copyKey() }
        return false
    }

    /// A pending selection's keys: Escape drops it, Enter keeps a bare highlight, a character keeps it with that
    /// character as its note and the note gets the keyboard at once.
    func pendingSelKey(_ e: NSEvent) -> Bool {
        guard let p = pendingSel else { return false }
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if e.keyCode == 53 { clearPending(); return true } // Escape
        if e.keyCode == 36 || e.keyCode == 76 { addMark(p.parts, note: nil); clearPending(); return true } // Enter
        guard let ch = e.characters, (ch as NSString).length == 1, !flags.contains(.command), !flags.contains(.control), !flags.contains(.option),
              let scalar = ch.unicodeScalars.first, !CharacterSet.controlCharacters.contains(scalar), scalar.value < 0xF700 || scalar.value > 0xF8FF else { return false }
        let card = selCardView != nil
        let m = addMark(p.parts, note: ch)
        clearPending()
        if card, let m { selCard = m.id; if let found = marks.find(m.id) { renderMarks(found.page) } }
        if let m, let f = noteField(m.id) {
            view.window?.makeFirstResponder(f)
            f.setSelectedRange(NSRange(location: (f.string as NSString).length, length: 0))
        }
        if let m { DispatchQueue.main.async { [weak self] in self?.revealCard(m.id) } }
        return true
    }

    /// Backspace / Delete with a mark in focus, after a press in this pane: the mark goes (removeMark).
    func markKey(_ e: NSEvent) -> Bool {
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard let id = focusId, downHere, e.keyCode == 51 || e.keyCode == 117, !flags.contains(.command), !flags.contains(.control), !flags.contains(.option),
              let found = marks.find(id) else { return false }
        return removeMark(found.page, found.mark)
    }

    func undoKey() -> Bool {
        guard !undos.isEmpty, downHere else { return false }
        return undo()
    }

    /// ⌘C with nothing else selected: the pending selection's text, else the focused mark's passage.
    func copyKey() -> Bool {
        let found = pendingSel == nil && downHere ? focusId.flatMap { marks.find($0) } : nil
        let text = pendingSel?.text ?? found.map { Marks.passageOf(marks, $0.mark) } ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        copy(text)
        return true
    }

    func copy(_ text: String) {
        if host?.paperCanCopy == true { host?.paperCopy(text) } else {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        }
    }

    // MARK: - removing and undo (MATH-66)

    /// Mark m of page n taken away with every part of its group; its running asks stopped first; the toast says so.
    @discardableResult
    func removeMark(_ page: Int, _ m: Mark) -> Bool {
        var parts: [(page: Int, mark: Mark)] = []
        if let g = m.group { for p in marks.pages.keys.sorted() { for x in marks[p] where x.group == g { parts.append((p, x)) } } }
        else if marks[page].contains(where: { $0.id == m.id }) { parts.append((page, m)) }
        guard !parts.isEmpty else { return false }
        let ids = Set(parts.map(\.mark.id))
        for p in pendingAsks where ids.contains(p.markId) && p.error == nil { host?.paperStopAsk(p.askId) }
        let batch = Self.markId("r")
        var pages = Set<Int>()
        for (n, mark) in parts {
            guard let index = marks[n].firstIndex(where: { $0.id == mark.id }) else { continue }
            let kept = marks[n][index]
            marks[n].remove(at: index)
            undos.append(.mark(page: n, mark: kept, index: index, batch: batch))
            pages.insert(n)
        }
        if let e = editing, ids.contains(e) { editing = nil }
        if let open = mention, ids.contains(open.markId) { closeMention() }
        focusId = nil
        if let h = hovered, ids.contains(h) { hovered = nil }
        view.window?.makeFirstResponder(canvas)
        for n in pages { renderMarks(n) }
        paintFocus(nil)
        scheduleSave()
        let first = parts.first { $0.mark.note != nil } ?? parts[0]
        showRemoved(batch, first.mark.rects.isEmpty ? "Note removed" : "Highlight removed")
        return true
    }

    /// The last thing taken that is still to be had comes back.
    func undo() -> Bool {
        while let last = undos.last {
            switch last {
            case .mark(_, _, _, let batch): if undoRemoval(batch) { return true }
            case .ask(let page, let markId, let askId):
                undos.removeLast()
                if restoreAsk(page, markId, askId) { return true }
            }
        }
        return false
    }

    func restoreAsk(_ page: Int, _ markId: String, _ askId: String) -> Bool {
        guard let i = marks[page].firstIndex(where: { $0.id == markId }), let k = marks[page][i].asks?.firstIndex(where: { $0.id == askId && $0.deleted == true }) else { return false }
        marks.pages[page]![i].asks![k].deleted = nil
        renderMarks(page)
        scheduleSave()
        return true
    }

    /// Every part of `batch` put back at its index, the last taken first.
    @discardableResult
    func undoRemoval(_ batch: String) -> Bool {
        let parts = undos.compactMap { u -> (Int, Mark, Int)? in if case .mark(let p, let m, let i, let b) = u, b == batch { return (p, m, i) }; return nil }
        guard !parts.isEmpty else { return false }
        undos.removeAll { if case .mark(_, _, _, let b) = $0 { return b == batch }; return false }
        var pages = Set<Int>()
        for (page, mark, index) in parts.reversed() {
            if marks[page].contains(where: { $0.id == mark.id }) { continue }
            var list = marks[page]
            list.insert(mark, at: max(0, min(index, list.count)))
            marks[page] = list
            pages.insert(page)
        }
        if removed?.batch == batch { hideRemoved() }
        guard !pages.isEmpty else { return false }
        for n in pages { renderMarks(n) }
        scheduleSave()
        return true
    }

    func showRemoved(_ batch: String, _ label: String) {
        removedTimer?.invalidate()
        removed = (batch, label)
        toast.text = label
        toast.isHidden = false
        layoutChrome()
        removedTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.removedTimer = nil; self?.removed = nil; self?.toast.isHidden = true }
        }
    }

    func hideRemoved() {
        removedTimer?.invalidate(); removedTimer = nil
        removed = nil
        toast.isHidden = true
    }

    // MARK: - answers on a highlight

    /// A finished answer (the Stage's landAnswer, or main telling every window): joins its mark once, drawn, saved.
    @discardableResult
    public func addAsk(page: Int, markId: String, entry: AskEntry) -> Bool {
        guard let i = marks[page].firstIndex(where: { $0.id == markId }) else { return false }
        if (marks[page][i].asks ?? []).contains(where: { $0.id == entry.id }) { return true }
        marks.pages[page]![i].asks = (marks[page][i].asks ?? []) + [entry]
        renderMarks(page)
        revealCard(markId, seen: true)
        scheduleSave()
        return true
    }

    /// What Bart is doing changed: a box already there is filled in place; one that came or went draws its page again.
    func syncPending(_ before: [PendingAsk]) {
        guard laidOut else { return }
        let pages = Set((before + pendingAsks).map(\.page))
        let had = Set(before.map(\.askId))
        func ids(_ list: [PendingAsk], _ page: Int) -> String { list.filter { $0.page == page }.map { "\($0.markId)/\($0.askId)" }.joined(separator: ",") }
        for page in pages where page >= 1 && page <= sheets.count {
            if ids(before, page) != ids(pendingAsks, page) {
                renderMarks(page)
                for p in pendingAsks where p.page == page && !had.contains(p.askId) { revealCard(p.markId, seen: true) }
                continue
            }
            var filled = false
            for p in pendingAsks where p.page == page {
                if let c = cardView(p.markId) {
                    c.fillRun(p, note: marks.find(p.markId)?.mark.note, open: openLogs.contains(p.askId), maxBody: boxMaxHeight(), names: names())
                    filled = true
                }
            }
            if filled { arrange([page]) }
        }
    }
}

// MARK: - cards

extension PaperViewController: CardOwner {
    func cardHover(_ card: CardView, inside: Bool) {
        if inside { hovered = card.markId; paintFocus(card.markId) } else if hovered == card.markId { hovered = nil; paintFocus(focusId) }
        placeHandle()
    }

    func noteFocused(_ card: CardView) {
        editing = card.markId
        if let m = marks.find(card.markId)?.mark, m.isHighlight { focusMark(m.id) }
    }

    func noteChanged(_ card: CardView, _ field: NoteField) {
        let text = field.string
        marks.update(card.markId) { $0.note = text }
        card.inkNote(field, asksFrom: asksFrom(marks.find(card.markId)?.mark))
        arrange([card.page])
        scheduleSave()
        noteMention(field, card.markId, card.page)
    }

    func noteSelectionChanged(_ card: CardView, _ field: NoteField) {
        if let open = mention, open.markId == card.markId { noteMention(field, card.markId, card.page) }
    }

    /// The keyboard left a note's field (leaveNote): empty, the note goes (a highlight keeps its mark); written, it shows
    /// as text. A field taken out to be drawn again was not left.
    func noteLeft(_ card: CardView, _ field: NoteField) {
        guard redrawing == 0, card.superview != nil, let found = marks.find(card.markId) else { return }
        if view.window?.firstResponder === field { return }
        if let open = mention, open.markId == card.markId { closeMention() }
        let page = found.page
        if field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if selCard == card.markId { selCard = nil }
            if editing == card.markId { editing = nil }
            if found.mark.isHighlight { marks.update(card.markId) { $0.note = nil } } else { marks[page].remove(at: found.index) }
            renderMarks(page)
            scheduleSave()
            return
        }
        if editing == card.markId { editing = nil }
        let moved = selCard == card.markId
        if moved { selCard = nil }
        if showsNotes() { DispatchQueue.main.async { [weak self] in if self?.editing != card.markId { self?.renderMarks(page) } } }
        else if moved { renderMarks(page) }
    }

    /// Keys in a note's field: the menu's first while it is open, then Enter on a highlight's @bart note asks, then
    /// Escape leaves the note. None reaches the page.
    func noteKey(_ card: CardView, _ field: NoteField, _ e: NSEvent) -> Bool {
        let items = mention?.markId == card.markId ? mentionList() : []
        let composing = field.hasMarkedText()
        if !items.isEmpty, let open = mention {
            let sel = field.selectedRange()
            if e.keyCode == 51, open.query.isEmpty, sel.length == 0, sel.location == open.start + 1, browse != nil { leaveFolder(); return true }
            if e.keyCode == 125 { mentionIdx = (mentionIdx + 1) % items.count; menuView.index = mentionIdx; return true }
            if e.keyCode == 126 { mentionIdx = (mentionIdx - 1 + items.count) % items.count; menuView.index = mentionIdx; return true }
            if (e.keyCode == 36 || e.keyCode == 76 || e.keyCode == 48) && !composing { pickMention(items[min(mentionIdx, items.count - 1)]); return true }
            if e.keyCode == 53 { closeMention(); return true }
        }
        if (e.keyCode == 36 || e.keyCode == 76), !e.modifierFlags.contains(.shift), !composing, let m = marks.find(card.markId)?.mark, asksFrom(m) {
            if let question = Canvas.noteQuestion(field.string) {
                if !question.isEmpty { askFrom(field, card.markId, question) }
                return true
            }
        }
        if e.keyCode == 53 { view.window?.makeFirstResponder(canvas); return true }
        return false
    }

    /// A press on a shown note: moved PRESS_MOVE it drags the card; let go before, the caret goes where it was pressed.
    func notePress(_ card: CardView, _ e: NSEvent, offset: Int?) {
        guard e.type == .leftMouseDown, let window = view.window else { return }
        let start = e.locationInWindow
        downHere = true
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { editNote(card.markId, at: offset); return }
            if hypot(next.locationInWindow.x - start.x, next.locationInWindow.y - start.y) >= Canvas.PRESS_MOVE {
                if startDrag(card, at: e) { dragTo(next.locationInWindow); trackDrag(window) }
                return
            }
        }
    }

    /// The note's field in place of its text, with the keyboard and the caret at `at` (the end when nil).
    func editNote(_ id: String, at: Int?) {
        if let f = view.window?.firstResponder as? NoteField, f.card?.markId != id { view.window?.makeFirstResponder(canvas) }
        guard let found = marks.find(id) else { return }
        editing = id
        renderMarks(found.page)
        guard let f = noteField(id) else { return }
        view.window?.makeFirstResponder(f)
        let len = (f.string as NSString).length
        f.setSelectedRange(NSRange(location: max(0, min(at ?? len, len)), length: 0))
    }

    func openLink(_ target: PaperLink.Target) {
        switch target {
        case .lib(let id): host?.paperOpenMention(id)
        case .file(let folder, let rel, let name): host?.paperOpenFile(folderId: folder, rel: rel, name: name)
        case .href(let h): host?.paperOpenLink(h)
        case .more: break // a folded run's "…" opens in its own text (AnswerText)
        }
    }

    func askAction(_ card: CardView, askId: String, action: String, button: TextButton) {
        guard let found = marks.find(card.markId), let k = found.mark.asks?.firstIndex(where: { $0.id == askId }) else { return }
        let a = found.mark.asks![k], page = found.page
        func say(_ words: String, _ back: String) {
            button.title = words
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak button] in button?.title = back }
        }
        switch action {
        case "copy": copy(a.answer ?? ""); say("Copied", "Copy"); return
        case "continue":
            host?.paperContinue(PaperContinue(markId: card.markId, page: page, quote: Marks.passageOf(marks, found.mark), question: a.question ?? "", answer: a.answer ?? "", foot: a.meta?.object?["foot"]?.string ?? ""))
            say("Added", "Continue in project"); return
        case "delete":
            marks.pages[page]![found.index].asks![k].deleted = true
            undos.append(.ask(page: page, markId: card.markId, askId: askId))
            downHere = true
        case "collapse": marks.pages[page]![found.index].asks![k].collapsed = true
        case "expand": marks.pages[page]![found.index].asks![k].collapsed = false
        default: return
        }
        renderMarks(page)
        scheduleSave()
    }

    func cardResized(_ card: CardView) { arrange([card.page]) }

    func runAction(_ card: CardView, askId: String, action: String) {
        switch action {
        case "stop": host?.paperStopAsk(askId)
        case "dismiss": host?.paperDismissAsk(askId)
        case "log":
            if openLogs.contains(askId) { openLogs.remove(askId) } else { openLogs.insert(askId) }
            if let p = pendingAsks.first(where: { $0.askId == askId }) {
                card.fillRun(p, note: marks.find(card.markId)?.mark.note, open: openLogs.contains(askId), maxBody: boxMaxHeight(), names: names())
                arrange([card.page])
            }
        default: break
        }
    }

    /// Bart asked from a highlight's note: the passage, the note, the question, the page's text around it, the turns.
    func askFrom(_ field: NoteField, _ id: String, _ question: String) {
        marks.update(id) { $0.note = field.string }
        flushSave()
        closeMention()
        guard let found = marks.find(id) else { return }
        let m = found.mark, page = found.page
        let quote = Marks.passageOf(marks, m), turns = Canvas.turnsOf(m)
        if editing == id { editing = nil }
        view.window?.makeFirstResponder(canvas)
        let at = page <= pageHs.count && pageHs[page - 1] > 0 ? m.y * pageW / pageHs[page - 1] : nil
        withText(page) { [weak self] t in
            guard let self else { return }
            let text = t?.normalized.text ?? ""
            let pageText = t == nil ? "" : Marks.pageWindow(text, m.text, at: at)
            self.host?.paperAsk(PaperAsk(markId: id, page: page, quote: quote, note: m.note ?? "", question: question, turns: turns, pageText: pageText))
        }
    }

    // MARK: - moving a card

    func startDrag(_ card: CardView, at e: NSEvent) -> Bool {
        guard drag == nil, let p = places[card.markId] else { return false }
        focusMark(card.markId)
        closeMention()
        let at = canvas.convert(e.locationInWindow, from: nil)
        drag = Drag(markId: card.markId, page: card.page, grabX: Double(at.x - card.frame.minX), grabY: Double(at.y - card.frame.minY), x0: Double(at.x), y0: Double(at.y),
                    at: at, moved: false, left: p.left, top: p.top, w: p.w, tick: nil)
        return true
    }

    /// The card under the pointer, kept on the paper: not above the first page, not past the sheet's sides.
    func dragTo(_ windowPoint: NSPoint) {
        guard var d = drag, d.page <= tops.count else { return }
        d.at = canvas.convert(windowPoint, from: nil)
        if !d.moved {
            if hypot(Double(d.at.x) - d.x0, Double(d.at.y) - d.y0) < 3 { drag = d; return }
            d.moved = true
            // out of the spacing: it stays where it is put
            if let i = drawnSpecs[d.page]?.firstIndex(where: { $0.id == d.markId }) { drawnSpecs[d.page]![i].fixed = true; drawnSpecs[d.page]![i].how = "pos"; drawnSpecs[d.page]![i].sel = false }
            handle.isHidden = true
        }
        let width = places[d.markId]?.width ?? 0
        d.left = clamp(Double(d.at.x) - d.grabX, 0, max(0, sheetW - width))
        d.top = max(-tops[d.page - 1], Double(d.at.y) - tops[d.page - 1] - d.grabY)
        drag = d
        arrange([d.page])
    }

    /// The drag followed until the button is up; near the pane's top or foot (28 px) the view scrolls 14 px a frame.
    func trackDrag(_ window: NSWindow) {
        NSCursor.closedHand.push()
        defer { NSCursor.pop() }
        var last = window.mouseLocationOutsideOfEventStream
        while true {
            guard let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp, .periodic], until: Date(timeIntervalSinceNow: 1.0 / 60), inMode: .eventTracking, dequeue: true) else {
                edgeScroll(last); continue
            }
            if e.type == .leftMouseUp { endDrag(); return }
            if e.type == .leftMouseDragged { last = e.locationInWindow; dragTo(last) }
            edgeScroll(last)
        }
    }

    func edgeScroll(_ windowPoint: NSPoint) {
        let p = scrollView.convert(windowPoint, from: nil), b = scrollView.bounds, edge: CGFloat = 28, speed: CGFloat = 14
        let dx: CGFloat = p.x < b.minX + edge ? -speed : p.x > b.maxX - edge ? speed : 0
        // scrollView is not flipped: y up
        let dy: CGFloat = p.y > b.maxY - edge ? -speed : p.y < b.minY + edge ? speed : 0
        guard dx != 0 || dy != 0 else { return }
        let o = clip.bounds.origin
        scrollTo(x: max(0, min(Double(canvas.bounds.width - clip.bounds.width), Double(o.x + dx))), y: max(0, min(Double(canvas.bounds.height - clip.bounds.height), Double(o.y + dy))))
        if clip.bounds.origin != o { dragTo(windowPoint) }
    }

    /// Let go: the card keeps its place in page units (`pos`) and the width it was moved at.
    func endDrag(cancel: Bool = false) {
        guard let d = drag else { return }
        drag = nil
        guard d.moved, !cancel else { arrange([d.page]); return }
        let pos = Canvas.posOf(d.left, d.top, G, pageW > 0 ? pageW : 1)
        marks.update(d.markId) { m in
            m.pos = pos
            if !((m.w ?? 0) > 0) { m.w = jsRound(d.w) }
        }
        if selCard == d.markId { selCard = nil }
        renderMarks(d.page)
        scheduleSave()
    }
}
