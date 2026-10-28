import AppKit
import EngelbartCore
import EngelbartDoc

// The editor's side of cards, recaps, results, a guide's bookmarks and @create's rows: their state (what a live card has
// ticked lives in the core; what is asked, open, saving or peeked lives here), their heights, their overlays, and every
// press, which goes to the core or to the host (DocEditorHost: paperState/savePaper/unsavePaper, madeFile/saveMade/
// madeNeeded, openMade, stop).

/// The view's own state for these rows.
final class CardsState {
    /// An answered boxed card's row asked about (askRepick): its question's line and the row.
    var repick: (q: Int, n: Int)?
    /// Send to Discover fields opened, and what is typed in them, by target (`t<from>`).
    var discoverOpen = Set<String>()
    var discoverText: [String: String] = [:]
    /// Made files whose frame is open inline (madeOpen).
    var madeOpen = Set<String>()
    /// Papers being saved or taken off, by address → the state they were in when clicked; a guide's Save all at work.
    var saving: [String: String] = [:]
    var savingAll = Set<Int>()
    /// The made peek (350 ms after resting on a name).
    var peek: MadePeekView?
    var peekTimer: Timer?
    var peekKey: String?
    /// Made keys already asked of the host.
    var asked = Set<String>()
}

extension DocEditorView {
    static let PEEK_MS = 0.35

    func cardModel(_ q: Int, closes: Bool) -> CardView.Model? {
        guard let e = core.cardsOf().byQ[q] else { return nil }
        let picks = e.live ? core.cardPicks[q] ?? [] : e.answer?.picks ?? []
        let boxed = core.boxedCard(e), again = core.repickable(e)
        let asking = again && cards.repick?.q == q ? cards.repick?.n : nil
        return CardView.Model(card: e.card, agent: e.agent, live: e.live, boxed: boxed, again: again, picks: picks, asking: asking, typed: core.followText[e.thread.from] ?? "", closes: closes)
    }

    func createWords(_ id: String, q: Int) -> CreatingView.Words {
        let ls = core.lines
        let request = q < ls.count ? Rx(#"^(?:--\S+\s+)*"#).replace(Doc.parseLine(ls[q]).text, with: "") : ""
        return CreatingView.words(ask: core.asks[id], request: request)
    }

    /// The heights of these rows at `width` (measure).
    func cardsMeasure(_ deco: Deco, width: CGFloat) -> CGFloat? {
        switch deco {
        case .card(let q):
            guard let m = cardModel(q, closes: false) else { return 44 }
            return CardView.height(m, width: width)
        case .made(let key, _):
            return MadeRowView.height(file: host?.docEditor(self, madeFile: key), open: cards.madeOpen.contains(key), width: width)
        case .creating(let id, let q):
            return CreatingView.height(createWords(id, q: q), width: width, top: 12, closes: true)
        case .sendDiscover(let from):
            let target = "t\(from)", text = cards.discoverText[target] ?? ""
            return SendDiscoverView.height(open: cards.discoverOpen.contains(target) || !text.trimmed.isEmpty, text: text, width: width)
        default: return nil
        }
    }

    /// The overlay for one of these rows, and its frame; nil for any other decoration.
    func cardsOverlay(_ d: Decoration, rect: NSRect, spacing: CGFloat?) -> (NSView, NSRect)? {
        switch d.deco {
        case .card(let q):
            let closes = (layoutManager.textStorage?.attribute(.edCard, at: rendered.maps[d.line].range.location, effectiveRange: nil) as? CardPaint)?.bottom ?? false
            guard let m = cardModel(q, closes: closes), let e = core.cardsOf().byQ[q] else { return nil }
            let v = CardView(m)
            v.from = e.thread.from
            v.field?.pasteHook = { [weak self, weak v] pb in guard let self, let f = v?.field else { return false }; return self.fieldPaste(pb, field: f, from: e.thread.from) }
            v.onPick = { [weak self] n in self?.core.pickCard(q, n); self?.redraw(keepSelection: true) }
            v.onRepick = { [weak self] n in self?.cards.repick = (q, n); self?.redraw(keepSelection: true) }
            v.onRepickNo = { [weak self] in self?.cards.repick = nil; self?.redraw(keepSelection: true) }
            v.onRepickGo = { [weak self] n in guard let self else { return }; self.cards.repick = nil; self.core.repickCard(q, n); self.redraw() }
            v.onSubmit = { [weak self] in self?.core.sendCard(q); self?.redraw() }
            v.onText = { [weak self, weak v] t in
                guard let self else { return }
                self.core.followText[e.thread.from] = t
                if let v, let f = v.field { self.fieldMention(from: e.thread.from, field: f) }
                if let v, abs(v.place(width: v.bounds.width) - v.bounds.height) > 1 { self.redraw(keepSelection: true) }
            }
            v.onKey = { [weak self] ev in
                guard let self else { return false }
                if self.mention?.field == e.thread.from {
                    if ev.keyCode == 125 { return self.mentionKey("ArrowDown", shift: false) }
                    if ev.keyCode == 126 { return self.mentionKey("ArrowUp", shift: false) }
                    if ev.keyCode == 36 || ev.keyCode == 48 { return self.mentionKey("Enter", shift: false) }
                    if ev.keyCode == 53 { return self.mentionKey("Escape", shift: false) }
                }
                if ev.keyCode == 36 { if !ev.modifierFlags.contains(.shift) { self.core.sendCard(q); self.redraw() }; return true }
                if ev.keyCode == 53 { self.window?.makeFirstResponder(nil); return true }
                return false
            }
            return (v, rect)
        case .made(let key, let name):
            let file = host?.docEditor(self, madeFile: key)
            let at = core.layout(canReply: core.hooks.ask != nil)[d.line]
            let v = MadeRowView(key: key, name: name, file: file, open: cards.madeOpen.contains(key), first: at?.first ?? false)
            v.onOpen = { [weak self] in guard let self else { return }; self.unpeekMade(); self.host?.docEditor(self, openMade: key) }
            v.onSave = { [weak self] in guard let self else { return }; self.unpeekMade(); self.host?.docEditor(self, saveMade: key, name: name) }
            v.onExpand = { [weak self] in
                guard let self else { return }
                self.unpeekMade()
                if self.cards.madeOpen.contains(key) { self.cards.madeOpen.remove(key) } else { self.cards.madeOpen.insert(key) }
                self.redraw(keepSelection: true)
            }
            return (v, rect)
        case .creating(let id, let q):
            let v = CreatingView(createWords(id, q: q), at: core.asks[id]?.at, top: 12)
            v.button.onClick = { [weak self] in
                guard let self else { return }
                if self.core.asks[id] != nil { self.host?.docEditor(self, stop: id) }
                else if let i = self.core.lines.firstIndex(of: "bart~> \(id)") { self.core.removeLine(i) }
                self.redraw()
            }
            return (v, rect)
        case .paperMark(let title, let address):
            let known = host?.docEditor(self, paperState: address) ?? nil
            guard let known, PaperMarkButton.words[known] != nil else { return nil }
            let held = cards.saving[address]
            let b = PaperMarkButton(state: held ?? known, busy: held != nil, canUnsave: host.map { $0.docEditorCanUnsavePaper(self) } ?? false, canSave: host != nil)
            b.onClick = { [weak self] in self?.savePaper(title: title, address: address) }
            let top = rect.minY + ((textView.textStorage?.attribute(.paragraphStyle, at: rendered.maps[d.line].range.location, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacingBefore ?? 0)
            return (b, NSRect(x: rect.maxX - 16 - 24 + 4, y: top + 1, width: 24, height: 24))
        case .sendDiscover(let from):
            let target = "t\(from)", text = cards.discoverText[target] ?? ""
            let v = SendDiscoverView(open: cards.discoverOpen.contains(target) || !text.trimmed.isEmpty, text: text)
            v.field?.pasteHook = { [weak self, weak v] pb in guard let self, let f = v?.field else { return false }; return self.fieldPaste(pb, field: f, from: nil) }
            v.onOpen = { [weak self] in
                guard let self else { return }
                self.cards.discoverOpen.insert(target); self.redraw(keepSelection: true)
                DispatchQueue.main.async { if let f = self.overlays.compactMap({ $0 as? SendDiscoverView }).first(where: { $0.field != nil })?.field { self.window?.makeFirstResponder(f) } }
            }
            v.onText = { [weak self, weak v] t in
                guard let self else { return }
                self.cards.discoverText[target] = t
                if let v, abs(SendDiscoverView.height(open: true, text: t, width: v.bounds.width) - d.height) > 1 { self.redraw(keepSelection: true) }
            }
            v.onSend = { [weak self] in self?.sendDiscover(from) }
            v.onKey = { [weak self] ev in
                guard let self else { return false }
                if ev.keyCode == 36 { if !ev.modifierFlags.contains(.shift) { self.sendDiscover(from) }; return true }
                if ev.keyCode == 53 { self.window?.makeFirstResponder(nil); return true }
                return false
            }
            return (v, NSRect(x: rect.minX, y: rect.maxY - (spacing ?? d.height) + d.below, width: rect.width, height: d.height))
        default: return nil
        }
    }

    /// Send to Discover sent: what was typed starts an @discover thread of its own after the recap (discoverLook).
    func sendDiscover(_ from: Int) {
        let target = "t\(from)"
        let typed = (cards.discoverText[target] ?? "").trimmed
        guard !typed.isEmpty else { return }
        cards.discoverText[target] = nil; cards.discoverOpen.remove(target)
        core.discoverLook(from, query: typed)
        redraw()
    }

    /// A bookmark pressed: the paper to the host's savePaper, or, here already, to unsavePaper; the document untouched.
    func savePaper(title: String, address: String) {
        guard let host, cards.saving[address] == nil, let state = host.docEditor(self, paperState: address) else { return }
        let unsave = state == "here"
        if unsave && !host.docEditorCanUnsavePaper(self) { return }
        if !unsave && state != "none" && state != "lib" { return }
        cards.saving[address] = state; redraw(keepSelection: true)
        let done: (Error?) -> Void = { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error { self.host?.docEditor(self, error: error) }
                self.cards.saving[address] = nil; self.redraw(keepSelection: true)
            }
        }
        if unsave { host.docEditor(self, unsavePaper: title, address: address, done: done) } else { host.docEditor(self, savePaper: title, address: address, done: done) }
    }

    /// Save all on a guide's foot: its papers not here yet, one after another; one that fails is told and the rest go on.
    func saveAllPapers(_ q: Int) {
        guard let host, !cards.savingAll.contains(q) else { return }
        let todo = core.unsavedPapers(q, state: { [weak self] a in guard let self else { return nil }; return host.docEditor(self, paperState: a) }).filter { cards.saving[$0.address] == nil }
        guard !todo.isEmpty else { return }
        cards.savingAll.insert(q)
        for p in todo { cards.saving[p.address] = host.docEditor(self, paperState: p.address) ?? "none" }
        redraw(keepSelection: true)
        func step(_ k: Int) {
            guard k < todo.count else { cards.savingAll.remove(q); redraw(keepSelection: true); return }
            let p = todo[k]
            host.docEditor(self, savePaper: p.title, address: p.address) { [weak self] error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if let error { self.host?.docEditor(self, error: error) }
                    self.cards.saving[p.address] = nil; self.redraw(keepSelection: true)
                    step(k + 1)
                }
            }
        }
        step(0)
    }

    /// What a foot carries for these: a live card's Skip and Wrap up, a guide's Save all (n) or Saving….
    func footExtras(_ q: Int) -> (skip: Bool, wrap: Bool, saveAll: String?) {
        let ls = core.lines
        let live = core.cardsOf(ls).byQ[q]
        let answering = live?.live ?? false
        let wrap = answering && live!.agent == "brainstorm" && live!.card["card"]?.string != "focus"
        var saveAll: String? = nil
        if let host, let found = core.findTurn(ls, q), !found.turn.folded {
            let at = core.layout(canReply: core.hooks.ask != nil)[q]
            if at?.agent == "discover" && (!(at?.box ?? false) || at?.boxState == "finished") {
                let left = core.unsavedPapers(q, state: { [weak self] a in guard let self else { return nil }; return host.docEditor(self, paperState: a) })
                if cards.savingAll.contains(q) { saveAll = "Saving…" } else if !left.isEmpty { saveAll = "Save all (\(left.count))" }
            }
        }
        return (answering, wrap, saveAll)
    }

    /// The made files the document shows that the window has not read yet are asked for (needMade).
    func needMade() {
        guard let host else { return }
        var want: [String] = [], seen = Set<String>()
        for line in core.lines {
            let p = Doc.parseLine(line)
            guard p.type == .reply, let made = Inline.madeMentionOf(p.text) else { continue }
            if host.docEditor(self, madeFile: made.key) != nil || seen.contains(made.key) || cards.asked.contains(made.key) { continue }
            seen.insert(made.key); want.append(made.key)
        }
        if !want.isEmpty { cards.asked.formUnion(want); host.docEditor(self, madeNeeded: want) }
    }

    /// The pointer over a made row's name or icon: after 350 ms its peek shows under it (peekMade); leaving hides it.
    func hoverMade(_ point: NSPoint) {
        guard let row = overlays.compactMap({ $0 as? MadeRowView }).first(where: { !$0.open && $0.frame.contains(point) }),
              row.peekRect.offsetBy(dx: row.frame.minX, dy: row.frame.minY).contains(point) else { unpeekMade(); return }
        if cards.peekKey == row.key { return }
        unpeekMade()
        cards.peekKey = row.key
        let key = row.key, name = row.name
        cards.peekTimer = Timer.scheduledTimer(withTimeInterval: DocEditorView.PEEK_MS, repeats: false) { [weak self, weak row] _ in
            guard let self, let row, row.superview != nil, !self.cards.madeOpen.contains(key) else { return }
            let v = MadePeekView(name: name, file: self.host?.docEditor(self, madeFile: key))
            let anchor = row.peekRect.offsetBy(dx: row.frame.minX, dy: row.frame.minY)
            v.frame.origin = NSPoint(x: anchor.minX, y: anchor.maxY - 6)
            self.textView.addSubview(v)
            self.cards.peek = v
        }
    }
    func unpeekMade() {
        cards.peekTimer?.invalidate(); cards.peekTimer = nil; cards.peekKey = nil
        cards.peek?.removeFromSuperview(); cards.peek = nil
    }
}
