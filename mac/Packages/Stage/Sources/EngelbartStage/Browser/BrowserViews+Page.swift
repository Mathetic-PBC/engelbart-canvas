import AppKit
import EngelbartDoc
import WebKit
import EngelbartCore

// What a page's script says and asks (views.cjs listenToPage), highlights (MATH-54), boxes (MATH-70), the drawing layer,
// the selected box's or a selection's card (2026-10-18), the right-click menu and the keys a page cannot keep.

struct Layer {
    var view: BoxLayerView?
    var tab: String?
    var mode: String?
}

struct Card {
    var view: BoxCardView?
    var tab: String?
    var markId: String?
    /// 'box' or 'selection'
    var mode: String?
    /// The selection's token it is for.
    var offer: String?
    var pageText = ""
    /// The mark it was for before, whose note may still come.
    var last: (tab: String, markId: String, url: String)?
    var height: CGFloat = 0
    var width: CGFloat = 0
    /// Each box's card size, kept (the last 200), so a card is placed at its own size the next time.
    var sizes: [(String, CGSize)] = []
    var running: [JSONValue] = []
    var note: (markId: String, text: String)?
    var saving: Task<Void, Never>?
    var shown: JSONValue?
}

extension BrowserViews: WKScriptMessageHandlerWithReply {
    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        // Only a tab's main frame (the page script's); a popup is no tab and gets nothing.
        guard message.frameInfo.isMainFrame, let tab = tabOf(message.webView), let body = message.body as? [String: Any], let channel = body["channel"] as? String else {
            replyHandler(nil, "Not a page in the Stage"); return
        }
        let value = JSONValue(any: body["value"])
        switch channel {
        case PageChannels.marks:
            let url = tab.webView.url?.absoluteString ?? ""
            guard let pageMarks, BrowserRules.fileablePage(url) else { replyHandler([], nil); return }
            Task { @MainActor in
                let list = (try? await pageMarks.list(url)) ?? []
                replyHandler(JSONValue.array(BrowserRules.marksForPage(list)).any, nil)
            }
            return
        case PageChannels.boxResize:
            guard let got = BrowserRules.boxResizeInput(value) else { replyHandler(nil, nil); return }
            Task { @MainActor in
                let box = await self.resizeBox(tab, got)
                replyHandler(box.map { JSONValue.object(["box": $0]).any }, nil)
            }
            return
        case PageChannels.quote:
            if let wait = tab.quoteWait, value["nonce"]?.string == wait.nonce { wait.resolve(BrowserRules.quoteInput(value["quote"])) }
        case PageChannels.section:
            if let nonce = value["nonce"]?.string, let wait = tab.sectionWaits[nonce] { wait(value["shown"]?.bool == true) }
        case PageChannels.selection:
            if let nonce = value["nonce"]?.string, let wait = tab.selectionWaits[nonce] { wait(BrowserRules.selectionInput(value)) }
        case PageChannels.box:
            if let wait = tab.boxWait, value["nonce"]?.string == wait.nonce { wait.resolve(BrowserRules.boxReplyInput(value)) }
        case PageChannels.boxes:
            if let report = BrowserRules.boxReportInput(value) { drawBoxes(tab, report) }
        case PageChannels.editing:
            tab.editing = value.bool == true
        case PageChannels.boxView:
            tab.boxView = BrowserRules.boxViewInput(value)
            if !tab.webView.isHidden || card.tab == tab.id { placeCard(tab.id) }
        case PageChannels.frame:
            if let nonce = value.string, let wait = tab.frameWaits[nonce] { wait() }
        case PageChannels.cursor:
            let v = value.string ?? ""
            setCursor(tab, Boxes.cursorValues.contains(v) ? v : "")
        case PageChannels.selectionCard:
            selectionCard(tab, value)
        case PageChannels.context:
            tab.context = (value["linkURL"]?.string ?? "", value["selectionText"]?.string ?? "", value["isEditable"]?.bool == true)
        default: break
        }
        replyHandler(nil, nil)
    }

    /// A new document has none of the boxes' rule, nothing selected and no field with the keyboard yet (did-navigate).
    func pageNavigated(_ tab: PageTab) {
        tab.boxes = nil; tab.boxCss = ""; tab.editing = false; tab.boxView = BrowserRules.BoxView(id: nil); tab.boxHide = nil; tab.offer = nil
        tab.cursor = ""
        if layer.tab == tab.id { endBox(focusPage: false) }
        if card.tab == tab.id { hideCard() }
    }

    /// A page that changed its own address: the boxes of the address it is at now (views.cjs did-navigate-in-page).
    func sameDocument(_ tab: PageTab, _ url: String) {
        guard let pageMarks, BrowserRules.fileablePage(url) else { return }
        Task { @MainActor in
            let list = (try? await pageMarks.list(url)) ?? []
            if tab.webView.url?.absoluteString == url { tab.sendPage(PageChannels.boxSet, .array(BrowserRules.marksForPage(list).filter { $0["box"] != nil })) }
        }
    }

    // ------------------------------------------------------------------------------------- highlights (MATH-54 b2)

    /// Highlight is offered for a selection, in a tab, on a page whose ink is kept.
    func canHighlight(_ tab: PageTab) -> Bool {
        let chosen = JSStr.trim(tab.context.selection)
        return pageMarks != nil && !tab.context.editable && !chosen.isEmpty && chosen.utf16.count <= BrowserRules.maxExact && BrowserRules.fileablePage(tab.webView.url?.absoluteString)
    }

    /// The tab's page is asked for the selection's quote, saved as a web mark, and told to tint it.
    @discardableResult
    public func highlightSelection(_ id: String) async -> Bool {
        guard let tab = entries[id], let pageMarks else { return false }
        let url = tab.webView.url?.absoluteString ?? ""
        guard BrowserRules.fileablePage(url) else { return false }
        let nonce = nextId("quote")
        let quote: BrowserRules.Quote? = await tab.wait(BrowserRules.quoteTimeout, fallback: nil) { done in
            tab.quoteWait = (nonce, { done($0) })
            tab.sendPage(PageChannels.quote, .string(nonce))
        } cleanup: { if tab.quoteWait?.nonce == nonce { tab.quoteWait = nil } }
        // the page went elsewhere meanwhile: its selection is not this page's
        guard let quote, entries[id] === tab, tab.webView.url?.absoluteString == url else { return false }
        let markId = newId()
        let mark: JSONValue = ["id": .string(markId), "quote": quote.json, "note": .null, "at": .string(Time.iso())]
        let saved = (try? await pageMarks.add(url, mark, crop: nil)) ?? false
        if saved { tab.sendPage(PageChannels.add, ["nonce": .string(nonce), "mark": ["id": .string(markId), "quote": quote.json]]) }
        return saved
    }

    // ---------------------------------------------------------------------------------------------- boxes (MATH-70)

    /// The page's boxes drawn by one adopted rule, replaced as they move.
    func drawBoxes(_ tab: PageTab, _ report: BrowserRules.BoxReport) {
        tab.boxes = report
        let resizing = report.resizing
        let rect = resizing.flatMap { z in report.rects.first { $0.id == z.id } }
        let rects = tab.boxHide.map { hide in report.rects.filter { $0.id != hide } } ?? report.rects
        var css = Boxes.boxesCss(rects, selected: report.selected, size: report.size, resizing: resizing?.id, notes: tab.boxHide != nil ? [] : report.notes)
        if let z = resizing, let rect { css += Boxes.readoutCss(x: z.x, y: z.y, w: rect.w, h: rect.h, zoom: Double(tab.webView.pageZoom), viewport: z.viewport) }
        if css == tab.boxCss { return }
        tab.boxCss = css
        if css.isEmpty { tab.callPage("window.__engelbartPage && window.__engelbartPage.uncss('boxes')") }
        else { tab.callPage("window.__engelbartPage && window.__engelbartPage.css('boxes', css)", ["css": css]) }
    }

    func selectedBox(_ tab: PageTab) -> String? {
        guard let b = tab.boxes, let s = b.selected, b.rects.contains(where: { $0.id == s }) else { return nil }
        return s
    }

    /// Whether tab `id` can be boxed now: in front, showing a page whose ink is kept, loaded.
    public func canBox(_ id: String) -> Bool {
        guard pageMarks != nil, let tab = entries[id], !tab.webView.isHidden, tab.error == nil else { return false }
        return BrowserRules.fileablePage(tab.webView.url?.absoluteString)
    }

    /// The drawing layer over tab `id` (`mode` 'button', the Stage's Box; 'alt', ⌥ held in the page), with the keyboard.
    @discardableResult
    public func startBox(_ id: String, mode: String = "button") -> Bool {
        guard canBox(id), let tab = entries[id], let container else { return false }
        if let other = layer.tab, other != id { endBox(focusPage: false) }
        hideCardView() // under the layer it could not be used; it comes back with the layer gone
        let view = layer.view ?? BoxLayerView()
        layer.view = view
        view.onDone = { [weak self] rect in guard let self, let t = self.layer.tab else { return }; self.endBox(focusPage: true); Task { @MainActor in _ = await self.makeBox(t, rect) } }
        view.onClick = { [weak self] point in
            guard let self, let t = self.layer.tab, let entry = self.entries[t] else { return }
            self.endBox(focusPage: true)
            let zoom = entry.webView.pageZoom
            entry.sendPage(PageChannels.boxHit, ["x": .number(Double(point.x / zoom)), "y": .number(Double(point.y / zoom))])
        }
        view.onCancel = { [weak self] in self?.endBox(focusPage: true) }
        container.addSubview(view, positioned: .above, relativeTo: nil) // on top
        view.frame = tab.webView.frame
        view.isHidden = false
        layer.tab = id
        layer.mode = mode
        view.start(mode: mode)
        container.window?.makeFirstResponder(view)
        send(.boxing(id: id, on: true))
        return true
    }

    /// The drawing layer gone; with `focusPage`, the page under it has the keyboard again.
    @discardableResult
    public func endBox(focusPage: Bool = true) -> Bool {
        guard let id = layer.tab else { return false }
        layer.tab = nil
        layer.mode = nil
        layer.view?.isHidden = true
        layer.view?.stop()
        let tab = entries[id]
        if focusPage, let tab { tab.webView.window?.makeFirstResponder(tab.webView) }
        send(.boxing(id: id, on: false))
        if let tab, !tab.webView.isHidden { placeCard(id) }
        return true
    }

    /// A box drawn over tab `id` at `rect` (the view's points): the page says what it is kept by and the text under it, its
    /// picture is taken, and it is saved as a mark and drawn, selected. → whether it was saved.
    @discardableResult
    func makeBox(_ id: String, _ rect: CGRect) async -> Bool {
        guard let tab = entries[id], let pageMarks, rect.width > 0, rect.height > 0 else { return false }
        let url = tab.webView.url?.absoluteString ?? ""
        guard BrowserRules.fileablePage(url) else { return false }
        let zoom = tab.webView.pageZoom
        let nonce = nextId("box")
        async let crop = tab.snapshot(rect)
        let got: BrowserRules.BoxReply? = await tab.wait(BrowserRules.boxTimeout, fallback: nil) { done in
            tab.boxWait = (nonce, { done($0) })
            tab.sendPage(PageChannels.box, ["nonce": .string(nonce), "rect": BrowserRules.Rect(x: Double(rect.minX / zoom), y: Double(rect.minY / zoom), w: Double(rect.width / zoom), h: Double(rect.height / zoom)).json])
        } cleanup: { if tab.boxWait?.nonce == nonce { tab.boxWait = nil } }
        let picture = await crop
        guard let got, entries[id] === tab, tab.webView.url?.absoluteString == url else { return false }
        let markId = newId()
        let mark: JSONValue = ["id": .string(markId), "box": got.box, "crop": picture != nil ? .string(Boxes.cropName(markId)) : .null, "text": .string(got.text), "note": .null, "at": .string(Time.iso())]
        let saved = (try? await pageMarks.add(url, mark, crop: picture)) ?? false
        if saved { tab.sendPage(PageChannels.boxAdd, ["id": .string(markId), "box": got.box, "select": true]) } // a box just drawn is selected
        return saved
    }

    /// Tab's page painted at least once since now (its script's two frames), or 150 ms gone by.
    func pageFrame(_ tab: PageTab) async {
        let nonce = nextId("frame")
        _ = await tab.wait(BrowserRules.frameTimeout, fallback: ()) { done in
            tab.frameWaits[nonce] = { done(()) }
            tab.sendPage(PageChannels.frame, .string(nonce))
        } cleanup: { tab.frameWaits[nonce] = nil }
    }

    /// Box resized on the page: its picture taken without its own lines, the mark updated under a new picture's name.
    func resizeBox(_ tab: PageTab, _ got: BrowserRules.BoxResize) async -> JSONValue? {
        guard let pageMarks else { return nil }
        let url = tab.webView.url?.absoluteString ?? ""
        guard BrowserRules.fileablePage(url) else { return nil }
        let zoom = Double(tab.webView.pageZoom)
        tab.boxHide = got.id
        if let b = tab.boxes { drawBoxes(tab, b) }
        await pageFrame(tab)
        let crop = await tab.snapshot(CGRect(x: got.rect.x * zoom, y: got.rect.y * zoom, width: got.rect.w * zoom, height: got.rect.h * zoom))
        if tab.boxHide == got.id { tab.boxHide = nil }
        if let b = tab.boxes { tab.boxCss = ""; drawBoxes(tab, b) }
        guard entries[tab.id] === tab, tab.webView.url?.absoluteString == url else { return nil }
        guard let mark = try? await pageMarks.update(url, got.id, ["box": got.box, "text": .string(got.text)], crop: crop), Boxes.isBox(mark) else { return nil }
        if card.tab == tab.id && card.markId == got.id { refreshCard() }
        return mark["box"]
    }

    /// The cursor over the page: a handle's (an adopted rule over everything), or the page's own ('').
    func setCursor(_ tab: PageTab, _ value: String) {
        guard tab.cursor != value else { return }
        tab.cursor = value
        if value.isEmpty { tab.callPage("window.__engelbartPage && window.__engelbartPage.uncss('cursor')") }
        else { tab.callPage("window.__engelbartPage && window.__engelbartPage.css('cursor', css)", ["css": Boxes.cursorCss(value)]) }
    }

    /// The box selected on tab `id` taken out of its ink, picture and all, and kept for Undo.
    @discardableResult
    func removeBox(_ id: String, _ markId: String) async -> Bool {
        guard let tab = entries[id], let pageMarks else { return false }
        let url = tab.webView.url?.absoluteString ?? ""
        guard let removed = try? await pageMarks.remove(url, markId) else { return false }
        tab.removed = (url, removed)
        tab.sendPage(PageChannels.boxRemove, .string(markId))
        send(.boxRemoved(id: id, markId: markId))
        return true
    }

    /// The box last removed on tab `id` put back where it was, with its picture.
    @discardableResult
    public func undoBox(_ id: String) async -> Bool {
        guard let tab = entries[id], let removed = tab.removed, let pageMarks else { return false }
        tab.removed = nil
        let back = (try? await pageMarks.restore(removed.url, removed.removed)) ?? false
        let mark = removed.removed["mark"]
        if back, tab.webView.url?.absoluteString == removed.url, let markId = mark?["id"]?.string { tab.sendPage(PageChannels.boxAdd, ["id": .string(markId), "box": mark?["box"] ?? .null]) }
        send(.boxRestored(id: id, markId: mark?["id"]?.string ?? ""))
        return back
    }

    // ---------------------------------------------------------------------------- the selected box's or selection's card

    func cardView() -> BoxCardView {
        if let view = card.view { return view }
        let view = BoxCardView()
        view.onNote = { [weak self] text in self?.saveCardNote(text) }
        view.onSave = { [weak self] text in Task { @MainActor in await self?.saveSelectionCard(text) } }
        view.onCancel = { [weak self] in guard let self, let t = self.card.tab, let entry = self.entries[t], self.card.mode == "selection" else { return }; self.closeOffer(entry) }
        view.onAsk = { [weak self] q in Task { @MainActor in await self?.cardAsk(q) } }
        view.onStop = { [weak self] askId in self?.send(.boxStop(askId: askId)) }
        view.onRemove = { [weak self] in
            guard let self, let t = self.card.tab, let m = self.card.markId else { return }
            Task { @MainActor in if self.card.mode == "selection" { _ = await self.removeHighlight(t, m) } else { _ = await self.removeBox(t, m) } }
        }
        view.onSize = { [weak self] size in
            guard let self else { return }
            self.card.height = max(BrowserRules.cardMinH, min(BrowserRules.cardMaxH, size.height.rounded(.up)))
            let widest = self.card.mode == "selection" ? CGFloat(SelectionCard.SEL_CARD_W + 2 * SelectionCard.CARD_SHADE.side) : BrowserRules.cardW
            self.card.width = size.width > 0 ? min(widest, size.width.rounded(.up)) : 0
            if let m = self.card.markId, self.card.mode == "box" {
                self.card.sizes.removeAll { $0.0 == m }
                self.card.sizes.append((m, CGSize(width: self.card.width, height: self.card.height)))
                if self.card.sizes.count > 200 { self.card.sizes.removeFirst() }
            }
            if let t = self.card.tab { self.placeCard(t) }
        }
        // Esc in the card gives the keyboard back to the page, the box still selected; a selection's card it closes
        view.onEscape = { [weak self] in
            guard let self, let t = self.card.tab, let entry = self.entries[t] else { return }
            if self.card.mode == "selection" { self.closeOffer(entry) }
            entry.webView.window?.makeFirstResponder(entry.webView)
        }
        view.isHidden = true
        card.view = view
        return view
    }

    func sendCard(_ state: JSONValue) {
        guard let view = card.view else { return }
        if state["typed"] == nil { card.shown = state }
        view.apply(state)
    }

    /// The card given its mark as kept now ({ id, note, asks }) and what the Stage has running from it.
    func refreshCard() {
        guard let tab = card.tab.flatMap({ entries[$0] }), let markId = card.markId, let pageMarks else { return }
        let tabId = tab.id
        Task { @MainActor in
            let list = (try? await pageMarks.list(tab.webView.url?.absoluteString ?? "")) ?? []
            guard card.tab == tabId, card.markId == markId else { return }
            let m = list.first { $0["id"]?.string == markId }
            let mark: JSONValue = m.map { ["id": .string(markId), "note": .string($0["note"]?.string ?? ""), "asks": .array(BrowserRules.cardAsks($0["asks"]?.array ?? []))] } ?? ["id": .string(markId), "note": "", "asks": []]
            sendCard(["mode": .string(card.mode ?? "box"), "offer": card.offer.map(JSONValue.string) ?? .null, "mark": mark, "running": .array(card.running.filter { $0["markId"]?.string == markId })])
            // a highlight's symbol shows once it has a note or an answer
            if let m, card.mode == "selection", !Boxes.isBox(m) { tab.sendPage(PageChannels.noted, ["id": .string(markId), "on": .bool(BrowserRules.isNoted(m))]) }
        }
    }

    /// Chained saves: one after another, as Electron's `card.saving` promise chain.
    func chain(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = card.saving
        let next = Task { @MainActor in await previous?.value; await work() }
        card.saving = next
        return next
    }

    /// The card's note saved on its mark; one that comes once the card has gone is the mark's it was showing.
    func saveCardNote(_ text: String) {
        let at: (tab: String, markId: String, url: String?)? = card.markId.map { (card.tab ?? "", $0, nil) } ?? card.last.map { ($0.tab, $0.markId, $0.url) }
        guard let at, let tab = entries[at.tab], let pageMarks else { return }
        if card.markId != nil { card.note = (at.markId, text) }
        let url = at.url ?? tab.webView.url?.absoluteString ?? ""
        _ = chain { _ = try? await pageMarks.update(url, at.markId, ["note": .string(text)], crop: nil) }
    }

    func rememberCard() {
        if let t = card.tab, let m = card.markId, let tab = entries[t] { card.last = (t, m, tab.webView.url?.absoluteString ?? "") }
    }

    /// A selection's card as the page says it: offered, moved, or taken back.
    func selectionCard(_ tab: PageTab, _ value: JSONValue) {
        guard let got = BrowserRules.selectionCardInput(value) else { return }
        guard let token = got.token else { dropOffer(tab); return }
        if got.quote != nil || got.markId != nil {
            // a page whose ink is not kept, a field with the keyboard, a box being drawn or selected: no card
            if pageMarks == nil || tab.editing || !BrowserRules.fileablePage(tab.webView.url?.absoluteString) || layer.tab == tab.id || selectedBox(tab) != nil { dropOffer(tab); return }
            if card.tab == tab.id && card.mode == "selection" { hideCard() }
            tab.offer = got
        } else if var offer = tab.offer, offer.token == token {
            offer.line = got.line; offer.rect = got.rect; offer.viewport = got.viewport
            tab.offer = offer
        } else { return }
        if !tab.webView.isHidden { placeCard(tab.id) }
    }

    /// The offered selection kept as a highlight with `text` for its note; the same passage kept already is that mark.
    func keepSelection(_ tab: PageTab, _ text: String, clear: Bool) async -> String? {
        guard let offer = tab.offer, let quote = offer.quote, let pageMarks, card.tab == tab.id, card.mode == "selection", card.offer == offer.token, card.markId == nil else { return nil }
        let url = tab.webView.url?.absoluteString ?? ""
        guard BrowserRules.fileablePage(url) else { return nil }
        let markId = newId()
        let note: JSONValue = text.isEmpty ? .null : .string(text)
        let mark: JSONValue = ["id": .string(markId), "quote": quote.json, "note": note, "at": .string(Time.iso())]
        card.markId = markId // a second Save meanwhile keeps nothing more
        card.note = text.isEmpty ? nil : (markId, text)
        card.pageText = offer.pageText
        var kept: String?
        await chain {
            let list = (try? await pageMarks.list(url)) ?? []
            if let twin = list.first(where: { !Boxes.isBox($0) && BrowserRules.sameQuote(BrowserRules.quoteInput($0["quote"]), quote) }), let twinId = twin["id"]?.string {
                kept = (try? await pageMarks.update(url, twinId, ["note": note], crop: nil)) != nil ? twinId : nil
            } else {
                kept = ((try? await pageMarks.add(url, mark, crop: nil)) ?? false) ? markId : nil
            }
        }.value
        let still = card.tab == tab.id && card.markId == markId
        guard let kept else { if still { card.markId = nil; card.note = nil }; return nil }
        if still { card.markId = kept; if card.note != nil { card.note?.markId = kept } }
        if tab.webView.url?.absoluteString == url {
            var payload: [String: JSONValue] = ["nonce": .string(offer.token ?? ""), "mark": ["id": .string(kept), "quote": quote.json, "noted": .bool(!JSStr.trim(text).isEmpty)]]
            if clear { payload["clear"] = true }
            tab.sendPage(PageChannels.add, .object(payload))
        }
        if still && !clear { refreshCard() }
        return kept
    }

    /// Save in a selection's or a highlight's card: the note kept, the card closed; an @bart note asked, the card stays.
    func saveSelectionCard(_ text: String) async {
        guard let id = card.tab, let tab = entries[id], let offer = tab.offer, card.offer == offer.token else { return }
        let question = BrowserRules.bartQuestion(text)
        var markId = card.markId
        if markId == nil {
            if JSStr.trim(text).isEmpty { return }
            markId = await keepSelection(tab, text, clear: question == nil)
            if markId == nil { return }
        } else if let m = markId {
            card.note = (m, text)
            saveHighlightNote(tab, m, text)
        }
        guard card.tab == id, card.markId == markId else { return }
        if let question { await cardAsk(question); return }
        closeOffer(tab)
    }

    /// A kept highlight's note saved, and its page told whether its symbol shows.
    func saveHighlightNote(_ tab: PageTab, _ markId: String, _ text: String) {
        guard let pageMarks else { return }
        let url = tab.webView.url?.absoluteString ?? ""
        _ = chain {
            if let m = try? await pageMarks.update(url, markId, ["note": .string(text)], crop: nil), tab.webView.url?.absoluteString == url {
                tab.sendPage(PageChannels.noted, ["id": .string(markId), "on": .bool(BrowserRules.isNoted(m))])
            }
        }
    }

    /// The card closed by the card (Save, Cancel, Esc): the page is told, so the passage can be offered again.
    func closeOffer(_ tab: PageTab) {
        let token = tab.offer?.token ?? (card.tab == tab.id && card.mode == "selection" ? card.offer : nil)
        tab.offer = nil
        if card.tab == tab.id && card.mode == "selection" { hideCard() }
        if let token { tab.sendPage(PageChannels.cardGone, .string(token)) }
    }
    func dropOffer(_ tab: PageTab) { closeOffer(tab) }

    /// A highlight removed from its card: out of the page's ink, its tint and symbol gone, its card closed.
    func removeHighlight(_ id: String, _ markId: String) async -> Bool {
        guard let tab = entries[id], let pageMarks else { return false }
        let url = tab.webView.url?.absoluteString ?? ""
        await card.saving?.value
        guard (try? await pageMarks.remove(url, markId)) != nil else { return false }
        tab.sendPage(PageChannels.unmark, .string(markId))
        if card.tab == id && card.markId == markId && entries[id] === tab { closeOffer(tab) }
        return true
    }

    /// @bart from the card: the Stage asks it as from a highlight, with the mark's answers so far.
    func cardAsk(_ question: String) async {
        guard let id = card.tab, let markId = card.markId, let tab = entries[id], let pageMarks else { return }
        let url = tab.webView.url?.absoluteString ?? ""
        await card.saving?.value
        let list = (try? await pageMarks.list(url)) ?? []
        guard let m = list.first(where: { $0["id"]?.string == markId }) else { return }
        let box = Boxes.isBox(m)
        guard box || m["quote"]?["exact"]?.string != nil, card.tab == id else { return }
        let note = card.note?.markId == markId ? card.note!.text : (m["note"]?.string ?? "")
        let turns = BrowserRules.cardAsks(m["asks"]?.array ?? []).suffix(40).map { JSONValue.object(["question": $0["question"] ?? "", "answer": $0["answer"] ?? ""]) }
        var payload: [String: JSONValue] = ["tab": .string(id), "markId": .string(markId), "url": .string(url), "title": .string(tab.webView.title ?? ""), "question": .string(question), "note": .string(note), "turns": .array(Array(turns))]
        if !box { payload["quote"] = m["quote"]?["exact"] ?? ""; payload["pageText"] = .string(card.pageText) }
        send(.boxAsk(.object(payload)))
    }

    /// What the Stage has running from boxes' cards: the card shows its own box's, and reads its mark again.
    public func setBoxAsks(_ list: [JSONValue]) {
        card.running = BrowserRules.boxAsksInput(list)
        if card.markId != nil { refreshCard() }
    }

    /// The card out of sight, the box it is for kept: it comes back where the box is.
    func hideCardView() {
        guard let view = card.view, !view.isHidden else { return }
        let had = view.hasKeyboard
        view.isHidden = true
        if had, let t = card.tab, let tab = entries[t] { tab.webView.window?.makeFirstResponder(tab.webView) }
    }

    /// The card gone: no box is selected on a tab in front (nor a selection offered).
    func hideCard() {
        rememberCard()
        hideCardView()
        card.tab = nil; card.markId = nil; card.note = nil; card.mode = nil; card.offer = nil
    }

    /// The card beside the box selected on tab `id`, when that tab is in front and the box in view; else out of sight.
    func placeCard(_ id: String) {
        guard let tab = entries[id] else { if card.tab == id { hideCard() }; return }
        let sel = tab.boxView.id != nil ? tab.boxView : nil
        if sel != nil && tab.offer != nil { dropOffer(tab) } // a box selected: its card, not the selection's
        if sel == nil, tab.offer != nil { placeSelectionCard(tab); return }
        guard let sel, let selId = sel.id, let r = sel.rect, !tab.webView.isHidden, pageMarks != nil, let container else { if card.tab == id { hideCard() }; return }
        if layer.tab == id { hideCardView(); return }
        let view = cardView()
        if card.tab != id || card.markId != selId || card.mode != "box" {
            rememberCard(); hideCardView()
            card.tab = id; card.markId = selId; card.mode = "box"; card.offer = nil; card.note = nil
            let kept = card.sizes.first { $0.0 == selId }?.1
            card.height = kept?.height ?? 0; card.width = kept?.width ?? 0
            view.prepare(mode: "box")
            refreshCard()
        }
        if BrowserRules.cardHideWhileScrolling && sel.scrolling { hideCardView(); return }
        let zoom = tab.webView.pageZoom, page = tab.webView.frame
        let box = CGRect(x: page.minX + CGFloat(r.x) * zoom, y: page.minY + CGFloat(r.y) * zoom, width: CGFloat(r.w) * zoom, height: CGFloat(r.h) * zoom)
        guard let at = Boxes.cardPlace(box: box, page: page, size: CGSize(width: card.width > 0 ? card.width : BrowserRules.cardW, height: card.height > 0 ? card.height : BrowserRules.cardMinH)) else { hideCardView(); return }
        if view.superview !== container { container.addSubview(view, positioned: .above, relativeTo: nil) }
        view.frame = at
        if view.isHidden { container.addSubview(view, positioned: .above, relativeTo: nil); view.isHidden = false }
    }

    /// The card for the selection offered on the tab (2026-10-18), or a highlight's own: under its last line, else above.
    func placeSelectionCard(_ tab: PageTab) {
        guard let offer = tab.offer, let container else { return }
        if tab.webView.isHidden || pageMarks == nil { if card.tab == tab.id { hideCardView() }; return }
        if layer.tab == tab.id { dropOffer(tab); return }
        let view = cardView()
        if card.tab != tab.id || card.mode != "selection" || card.offer != offer.token {
            rememberCard(); hideCardView()
            card.tab = tab.id; card.mode = "selection"; card.offer = offer.token; card.markId = offer.markId; card.note = nil; card.pageText = offer.pageText; card.height = 0; card.width = 0
            view.prepare(mode: "selection")
            sendCard(["mode": "selection", "offer": .string(offer.token ?? ""), "mark": .null, "running": []])
            if card.markId != nil { refreshCard() }
        }
        let zoom = tab.webView.pageZoom, page = tab.webView.frame
        func inWindow(_ r: BrowserRules.Rect?) -> CGRect? { r.map { CGRect(x: page.minX + CGFloat($0.x) * zoom, y: page.minY + CGFloat($0.y) * zoom, width: CGFloat($0.w) * zoom, height: CGFloat($0.h) * zoom) } }
        let shade = (top: CGFloat(SelectionCard.CARD_SHADE.top), side: CGFloat(SelectionCard.CARD_SHADE.side), bottom: CGFloat(SelectionCard.CARD_SHADE.bottom))
        let full = CGSize(width: card.width > 0 ? card.width : CGFloat(SelectionCard.SEL_CARD_W) + 2 * shade.side, height: card.height > 0 ? card.height : 96 + shade.top + shade.bottom)
        let size = CGSize(width: max(1, full.width - 2 * shade.side), height: max(1, full.height - shade.top - shade.bottom))
        guard let at = SelectionCard.shadedPlace(line: inWindow(offer.line), all: inWindow(offer.rect), pane: page, size: size) else {
            if card.markId != nil { hideCardView() } else { dropOffer(tab) }
            return
        }
        if view.superview !== container { container.addSubview(view, positioned: .above, relativeTo: nil) }
        view.frame = at
        if view.isHidden { container.addSubview(view, positioned: .above, relativeTo: nil); view.isHidden = false }
    }
}

// --------------------------------------------------------------------------------------------------- the keys

extension BrowserViews: StageWebViewKeys {
    func pageShortcut(_ view: StageWebView, key: String, shift: Bool) -> Bool {
        guard let id = view.tabId, entries[id] != nil else { return false }
        switch key {
        case "r": command(id, "reload")
        case "l": window?.makeFirstResponder(nil); send(.focusAddress)
        case "[": command(id, "back")
        case "]": command(id, "forward")
        case "j": send(.nextWorkspace) // the workspace's ⌘J, which a page in front would otherwise swallow
        case "t" where !shift: window?.makeFirstResponder(nil); send(.shortcut(name: "new-tab", tab: id))
        case "w" where !shift: send(.shortcut(name: "close-tab", tab: id)) // ⇧⌘W is the window's
        case "1", "2", "3", "4", "5", "6", "7", "8", "9": if shift { return false }; send(.shortcut(name: "tab-\(key)", tab: id))
        case "z" where !shift:
            // ⌘Z puts back the box last removed (boxKey)
            guard let tab = entries[id], tab.removed != nil, !tab.editing else { return false }
            Task { @MainActor in _ = await undoBox(id) }
        default: return false
        }
        return true
    }

    func pageAlt(_ view: StageWebView, down: Bool, repeat: Bool) {
        guard let id = view.tabId, let tab = entries[id] else { return }
        if down {
            if !`repeat` && !tab.editing && canBox(id) { startBox(id, mode: "alt") }
        } else if layer.tab == id && layer.mode == "alt" {
            layer.view?.altUp()
        }
    }

    func pageKey(_ view: StageWebView, event: NSEvent) -> Bool {
        guard let id = view.tabId, let tab = entries[id] else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let command = flags.contains(.command)
        // boxes (boxKey): with a box selected, Backspace or Delete removes it and Esc lets it go
        if !tab.editing, let selected = selectedBox(tab) {
            if (event.keyCode == 51 || event.keyCode == 117) && !command && !flags.contains(.option) && !flags.contains(.shift) {
                Task { @MainActor in _ = await removeBox(id, selected) }
                return true
            }
            if event.keyCode == 53 { tab.sendPage(PageChannels.boxSelect, .null); return true }
        }
        // a selection's card showing: a printable key goes into its note, Esc closes it; the rest stay the page's
        if let offer = tab.offer, card.tab == id, card.mode == "selection", card.offer == offer.token, let cardView = card.view, !cardView.isHidden {
            if event.keyCode == 53 && !command && !flags.contains(.control) && !flags.contains(.option) { closeOffer(tab); return true }
            if command || flags.contains(.control) || flags.contains(.option) { return false }
            guard let typed = event.characters, typed.count == 1, let scalar = typed.unicodeScalars.first, !CharacterSet.controlCharacters.contains(scalar), scalar.value < 0xF700 else { return false }
            var state = card.shown ?? ["mode": "selection", "offer": .string(card.offer ?? ""), "mark": .null, "running": []]
            if case .object(var o) = state { o["typed"] = .string(typed); state = .object(o) }
            sendCard(state)
            return true
        }
        return false
    }

    func pageFocused(_ view: StageWebView) { send(.focused(id: view.tabId)) }

    /// The right-click menu (views.cjs contextMenu): Open Link in New Tab, Copy Link; cut/copy/paste/select all in a
    /// field; Highlight above Copy with a selection on a page whose ink is kept; Back, Forward, Reload; Inspect Element.
    func pageMenu(_ view: StageWebView, menu: NSMenu) {
        guard let id = view.tabId, let tab = entries[id] else { return }
        let inspect = menu.items.first { $0.identifier?.rawValue == "WKMenuItemIdentifierInspectElement" }
        let copyLink = menu.items.first { $0.identifier?.rawValue == "WKMenuItemIdentifierCopyLink" }
        let copy = menu.items.first { $0.identifier?.rawValue == "WKMenuItemIdentifierCopy" }
        let editing = menu.items.filter { ["WKMenuItemIdentifierCut", "WKMenuItemIdentifierCopy", "WKMenuItemIdentifierPaste"].contains($0.identifier?.rawValue ?? "") }
        menu.removeAllItems()
        let link = tab.context.link
        if !link.isEmpty && allowed(link, from: view.url?.absoluteString) {
            menu.addItem(MenuAction.item("Open Link in New Tab") { [weak self] in self?.send(.openLinkInNewTab(url: link, from: id)) })
        }
        if !link.isEmpty {
            if let copyLink { menu.addItem(copyLink) } else { menu.addItem(MenuAction.item("Copy Link") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(link, forType: .string) }) }
            menu.addItem(.separator())
        }
        if tab.context.editable {
            for item in editing { menu.addItem(item) }
            menu.addItem(MenuAction.item("Select All") { view.selectAll(nil) })
            menu.addItem(.separator())
        } else if !JSStr.trim(tab.context.selection).isEmpty {
            if canHighlight(tab) { menu.addItem(MenuAction.item("Highlight") { [weak self] in Task { @MainActor in _ = await self?.highlightSelection(id) } }) }
            if let copy { menu.addItem(copy) }
            menu.addItem(.separator())
        }
        let back = MenuAction.item("Back") { view.goBack() }; back.isEnabled = view.canGoBack
        let forward = MenuAction.item("Forward") { view.goForward() }; forward.isEnabled = view.canGoForward
        menu.autoenablesItems = false
        menu.addItem(back); menu.addItem(forward)
        menu.addItem(MenuAction.item("Reload") { [weak self] in self?.command(id, "reload") })
        menu.addItem(.separator())
        if let inspect { menu.addItem(inspect) }
        tab.context = ("", "", false)
    }
}

/// A menu item whose action is a closure.
final class MenuAction: NSObject {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
    @objc func fire() { run() }
    static func item(_ title: String, _ run: @escaping () -> Void) -> NSMenuItem {
        let target = MenuAction(run)
        let item = NSMenuItem(title: title, action: #selector(fire), keyEquivalent: "")
        item.target = target
        item.representedObject = target // kept alive with the item
        return item
    }
}
