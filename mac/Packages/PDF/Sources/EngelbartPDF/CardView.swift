import AppKit
import EngelbartDoc
import EngelbartUI

// A mark's card (PaperView cardBox, MATH-27; the look since 2026-10-16 and card-look.js): its note (a field being typed
// in, or text with its mentions as chips), then each answer (askSection) and each answer being written (runBox), 10px
// between them and nothing of the card itself to see: no edge, fill, grip or divider, only handwriting and answers on the
// paper. It is laid out in note px and drawn at its page's noteScale (frame = size × ns, bounds = size).

/// What a card tells the paper (PaperViewController).
@MainActor protocol CardOwner: AnyObject {
    func cardHover(_ card: CardView, inside: Bool)
    func noteChanged(_ card: CardView, _ field: NoteField)
    func noteSelectionChanged(_ card: CardView, _ field: NoteField)
    func noteFocused(_ card: CardView)
    func noteLeft(_ card: CardView, _ field: NoteField)
    /// A key in a note's field; true when the paper took it.
    func noteKey(_ card: CardView, _ field: NoteField, _ event: NSEvent) -> Bool
    /// A press on a shown note's words (not a chip): a drag past PRESS_MOVE moves the card, a click edits at `offset`.
    func notePress(_ card: CardView, _ event: NSEvent, offset: Int?)
    func openLink(_ target: PaperLink.Target)
    func askAction(_ card: CardView, askId: String, action: String, button: TextButton)
    func runAction(_ card: CardView, askId: String, action: String)
    /// A card's contents changed size by themselves (a folded run of citations opened): laid out again.
    func cardResized(_ card: CardView)
}

/// The note's handwriting (card-look.js NOTE_TYPE): Caveat 500 24px/1.2, tracking .2, ink #1f2633, padding 0 6px.
enum NoteLook {
    static let ink = NSColor(hex: "#1f2633")
    static let size: CGFloat = 24
    static let lineHeight: CGFloat = 28.8
    static var font: NSFont { Fonts.caveat(size, weight: 500) }
    static var attrs: [NSAttributedString.Key: Any] {
        let p = NSMutableParagraphStyle(); p.minimumLineHeight = lineHeight; p.maximumLineHeight = lineHeight
        p.lineBreakMode = .byWordWrapping
        return [.font: font, .foregroundColor: ink, .kern: 0.2, .paragraphStyle: p]
    }
}

/// A note's field and, not being typed in, its text (PaperView noteField / noteView): one NSTextView either way.
final class NoteField: NSTextView {
    weak var card: CardView?
    /// Shown as text (not typed in): its pieces (doc.js noteParts) so a click finds its place in the note.
    var shownParts: [(raw: String, shownLength: Int)] = []
    var shown = false
    /// A leading @bart drawn as the document's blue label (doc.js agentLabelHtml): the token's own text transparent.
    var agentRange: NSRange?

    override var acceptsFirstResponder: Bool { !shown }

    override func keyDown(with event: NSEvent) {
        if let card, let owner = card.owner, owner.noteKey(card, self, event) { return }
        super.keyDown(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok, let card { card.owner?.noteFocused(card) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok, let card { DispatchQueue.main.async { [weak self, weak card] in if let self, let card { card.owner?.noteLeft(card, self) } } }
        return ok
    }

    override func mouseDown(with event: NSEvent) {
        guard shown, let card else { super.mouseDown(with: event); return }
        let p = convert(event.locationInWindow, from: nil)
        let i = characterIndexForInsertion(at: p)
        // a chip opens what it names
        if let storage = textStorage, i < storage.length {
            let glyph = layoutManager?.glyphIndexForCharacter(at: i) ?? 0
            let r = layoutManager?.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer!) ?? .zero
            let at = (p.x >= r.minX + textContainerOrigin.x && i < storage.length) ? i : max(0, i - 1)
            if at < storage.length, let link = storage.attribute(.link, at: at, effectiveRange: nil), let target = PaperLink.target(link),
               r.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y).insetBy(dx: -2, dy: -2).contains(p) || storage.attribute(.link, at: max(0, i - 1), effectiveRange: nil) != nil {
                card.owner?.openLink(target); return
            }
        }
        card.owner?.notePress(card, event, offset: rawOffset(i))
    }

    /// Where in the note's text a click on its shown text lands (doc.js noteOffset): a chip is passed whole.
    func rawOffset(_ shownIndex: Int) -> Int? {
        var raw = 0, shownAt = 0
        for part in shownParts {
            if shownIndex <= shownAt + part.shownLength {
                let isMention = NoteText.libMentionOf(part.raw) != nil || NoteText.fileMentionOf(part.raw) != nil
                return raw + (isMention ? (part.raw as NSString).length : max(0, min((part.raw as NSString).length, shownIndex - shownAt)))
            }
            raw += (part.raw as NSString).length; shownAt += part.shownLength
        }
        return raw
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .iBeam)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let r = agentRange, let lm = layoutManager, let tc = textContainer, let storage = textStorage, r.location + r.length <= storage.length else { return }
        let glyphs = lm.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
        let rect = lm.boundingRect(forGlyphRange: glyphs, in: tc).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
        let token = (storage.string as NSString).substring(with: r)
        let font = Fonts.sans(NoteLook.size * 0.75, weight: 500)
        let size = (token as NSString).size(withAttributes: [.font: font])
        (token as NSString).draw(at: NSPoint(x: rect.minX, y: rect.midY - size.height / 2), withAttributes: [.font: font, .foregroundColor: NSColor(hex: "#0070f3")])
    }
}

/// A small text button (card-look.js cardCss: 13px #8f8f8f, hover #f2f2f2 wash and #171717, radius 5, padding 2px 6px).
final class TextButton: NSView {
    var title: String { didSet { needsDisplay = true; invalidateIntrinsicContentSize() } }
    let action: String
    var onPress: ((TextButton) -> Void)?
    var font = Fonts.sans(13)
    var color = NSColor(hex: "#8f8f8f")
    var hoverColor = NSColor(hex: "#171717")
    private(set) var hovering = false { didSet { needsDisplay = true } }

    init(_ title: String, action: String, onPress: ((TextButton) -> Void)? = nil) {
        self.title = title; self.action = action; self.onPress = onPress
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize {
        let s = (title as NSString).size(withAttributes: [.font: font])
        return NSSize(width: ceil(s.width) + 12, height: ceil(13 * 1.4) + 4)
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) { if bounds.contains(convert(event.locationInWindow, from: nil)) { onPress?(self) } }
    override func draw(_ dirtyRect: NSRect) {
        if hovering {
            NSColor(hex: "#f2f2f2").setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        }
        let s = (title as NSString).size(withAttributes: [.font: font])
        (title as NSString).draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2), withAttributes: [.font: font, .foregroundColor: hovering ? hoverColor : color])
    }
}

/// The spinner beside what Bart is doing (card-look.js SPINNER: 10px, 1.5px #c9d9f2 ring, #0070f3 top, .8 s a turn).
final class Spinner: NSView {
    private let ring = CAShapeLayer(), arc = CAShapeLayer()
    override init(frame: NSRect) {
        super.init(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
        wantsLayer = true
        let path = CGPath(ellipseIn: CGRect(x: 0.75, y: 0.75, width: 8.5, height: 8.5), transform: nil)
        ring.path = path; ring.fillColor = nil; ring.strokeColor = NSColor(hex: "#c9d9f2").cgColor; ring.lineWidth = 1.5
        arc.path = path; arc.fillColor = nil; arc.strokeColor = NSColor(hex: "#0070f3").cgColor; arc.lineWidth = 1.5
        arc.strokeStart = 0.125; arc.strokeEnd = 0.375
        arc.frame = CGRect(x: 0, y: 0, width: 10, height: 10); ring.frame = arc.frame
        layer?.addSublayer(ring); layer?.addSublayer(arc)
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0; spin.toValue = -2 * Double.pi; spin.duration = 0.8; spin.repeatCount = .infinity
        arc.add(spin, forKey: "spin")
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// A label that is just text (no field chrome).
func makeLabel(_ text: String, font: NSFont, color: NSColor, lines: Int = 1) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.font = font; l.textColor = color
    l.lineBreakMode = lines == 1 ? .byTruncatingTail : .byWordWrapping
    l.maximumNumberOfLines = lines
    l.cell?.truncatesLastVisibleLine = true
    return l
}

/// A non-editable, selectable text: an answer, or the answer being written.
final class AnswerText: NSTextView {
    weak var card: CardView?
    /// What it shows, with its folded citation runs open or not.
    var render: ((Bool) -> NSAttributedString)? { didSet { refresh() } }
    private(set) var expanded = false
    private var tip: CiteTipView?
    private var tipClose: DispatchWorkItem?

    func refresh() { if let render { textStorage?.setAttributedString(render(expanded)) } }

    /// A folded run's "…" opened (a click, or the pointer on it): every run of the answer shows its circles.
    func expand() {
        guard !expanded else { return }
        expanded = true
        refresh()
        if let card { card.owner?.cardResized(card) }
    }

    override func clicked(onLink link: Any, at charIndex: Int) {
        guard let target = PaperLink.target(link) else { return }
        if case .more = target { expand(); return }
        hideTip()
        card?.owner?.openLink(target)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for a in trackingAreas where a.owner === self && a.userInfo?["cite"] != nil { removeTrackingArea(a) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: ["cite": true]))
    }

    /// The character under a window point, when it is a citation circle or a "…": its index.
    func circleIndex(at windowPoint: NSPoint) -> Int? {
        guard let lm = layoutManager, let tc = textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let p = convert(windowPoint, from: nil)
        let q = NSPoint(x: p.x - textContainerOrigin.x, y: p.y - textContainerOrigin.y)
        var fraction: CGFloat = 0
        let g = lm.glyphIndex(for: q, in: tc, fractionOfDistanceThroughGlyph: &fraction)
        guard lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc).contains(q) else { return nil }
        let i = lm.characterIndexForGlyph(at: g)
        guard i < storage.length, storage.attribute(.attachment, at: i, effectiveRange: nil) != nil else { return nil }
        return i
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        guard let i = circleIndex(at: event.locationInWindow), let storage = textStorage else { leaveCircle(); return }
        if let link = storage.attribute(.link, at: i, effectiveRange: nil), case .more? = PaperLink.target(link) { expand(); return }
        if let info = storage.attribute(.citeCard, at: i, effectiveRange: nil) as? CiteCardInfo { showTip(info.card, at: i) }
    }
    override func mouseExited(with event: NSEvent) { super.mouseExited(with: event); leaveCircle() }
    override func scrollWheel(with event: NSEvent) { hideTip(); super.scrollWheel(with: event) }
    override func viewWillMove(toWindow newWindow: NSWindow?) { if newWindow == nil { hideTip() }; super.viewWillMove(toWindow: newWindow) }

    /// The citation's card under its circle, or above it with no room under (cite.js citationTip), inside the window.
    func showTip(_ card: Cite.Card, at i: Int) {
        tipClose?.cancel(); tipClose = nil
        guard let window, let content = window.contentView, let lm = layoutManager, let tc = textContainer else { return }
        let glyphs = lm.glyphRange(forCharacterRange: NSRange(location: i, length: 1), actualCharacterRange: nil)
        let r = lm.boundingRect(forGlyphRange: glyphs, in: tc).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
        let inContent = content.convert(convert(r, to: nil), from: nil)
        let v = tip ?? CiteTipView()
        v.onHover = { [weak self] inside in if inside { self?.tipClose?.cancel(); self?.tipClose = nil } else { self?.leaveCircle() } }
        v.card = card
        let size = v.preferredSize
        let vw = content.bounds.width, vh = content.bounds.height
        let x = max(8, min(inContent.midX - size.width / 2, vw - size.width - 8))
        let flipped = content.isFlipped
        let lowY = flipped ? inContent.maxY : inContent.minY, highY = flipped ? inContent.minY : inContent.maxY
        // "under" the circle: further down the window
        let under = flipped ? lowY + 6 : lowY - 6 - size.height
        let over = flipped ? highY - 6 - size.height : highY + 6
        let roomUnder = flipped ? under + size.height <= vh - 8 : under >= 8
        let roomOver = flipped ? over >= 8 : over + size.height <= vh - 8
        let y = !roomUnder && roomOver ? over : under
        v.frame = NSRect(x: x, y: y, width: size.width, height: size.height)
        if v.superview !== content { content.addSubview(v, positioned: .above, relativeTo: nil) }
        tip = v
    }

    /// The pointer left the circle: the card goes after CARD_GRACE unless the pointer reaches it.
    func leaveCircle() {
        guard tip != nil, tipClose == nil else { return }
        let w = DispatchWorkItem { [weak self] in self?.hideTip() }
        tipClose = w
        DispatchQueue.main.asyncAfter(deadline: .now() + Cite.CARD_GRACE, execute: w)
    }

    func hideTip() { tipClose?.cancel(); tipClose = nil; tip?.removeFromSuperview(); tip = nil }

    /// The card shown now (tests).
    var shownTip: CiteTipView? { tip }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        // the Sources' rule (cite.js: margin-top 8, padding-top 8, 1px #eaeaea)
        guard let storage = textStorage, let lm = layoutManager, let tc = textContainer else { return }
        storage.enumerateAttribute(.sourcesRule, in: NSRange(location: 0, length: storage.length)) { v, range, _ in
            guard v != nil else { return }
            let g = lm.glyphRange(forCharacterRange: NSRange(location: range.location, length: 1), actualCharacterRange: nil)
            let r = lm.lineFragmentRect(forGlyphAt: g.location, effectiveRange: nil).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
            NSColor(hex: "#eaeaea").setFill()
            NSRect(x: 0, y: r.minY + 2, width: bounds.width, height: 1).fill()
            _ = tc
        }
    }
}

func makeTextView<T: NSTextView>(_ type: T.Type, editable: Bool) -> T {
    let storage = NSTextStorage()
    let lm = NSLayoutManager()
    storage.addLayoutManager(lm)
    let tc = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
    tc.widthTracksTextView = false
    tc.lineFragmentPadding = 0
    lm.addTextContainer(tc)
    let tv = T(frame: .zero, textContainer: tc)
    tv.isEditable = editable
    tv.isSelectable = true
    tv.drawsBackground = false
    tv.isRichText = !editable
    tv.isVerticallyResizable = false
    tv.isHorizontallyResizable = false
    tv.textContainerInset = .zero
    tv.focusRingType = .none
    tv.isAutomaticQuoteSubstitutionEnabled = false
    tv.isAutomaticDashSubstitutionEnabled = false
    tv.isAutomaticTextReplacementEnabled = false
    tv.isAutomaticSpellingCorrectionEnabled = false
    tv.isContinuousSpellCheckingEnabled = false // spellcheck off, as the note's textarea
    tv.isGrammarCheckingEnabled = false
    tv.allowsUndo = true
    tv.linkTextAttributes = [:] // links keep the colours they were drawn with
    if #available(macOS 15.0, *) { tv.writingToolsBehavior = .none } // a margin note is handwriting, as the textarea was
    return tv
}

/// Height of a text view's text laid out `width` wide.
func textHeight(_ tv: NSTextView, width: CGFloat) -> CGFloat {
    guard let tc = tv.textContainer, let lm = tv.layoutManager else { return 0 }
    tc.size = NSSize(width: max(1, width), height: .greatestFiniteMagnitude)
    lm.ensureLayout(for: tc)
    return ceil(lm.usedRect(for: tc).height)
}

final class CardView: NSView {
    let markId: String
    var page: Int
    weak var owner: CardOwner?
    private(set) var note: NoteField?
    private var noteHolder = NSView()
    private(set) var askViews: [(id: String, view: AskSectionView)] = []
    private(set) var runViews: [(id: String, view: RunBoxView)] = []
    /// It keeps its whole width (typingIn).
    var typing = false
    /// Its laid-out size, note px.
    private(set) var size = NSSize.zero
    /// The selection card's ground (white) while it stands where that card was.
    var ground: NSColor? { didSet { needsDisplay = true } }

    init(markId: String, page: Int) {
        self.markId = markId; self.page = page
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = false
        noteHolder.wantsLayer = true
        addSubview(noteHolder)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        if let ground { ground.setFill(); bounds.fill() }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { owner?.cardHover(self, inside: true) }
    override func mouseExited(with event: NSEvent) { owner?.cardHover(self, inside: false) }
    // A press on the card is not a press on the page: no new note, the pending selection stays.
    override func mouseDown(with event: NSEvent) {}

    struct Content {
        var mark: Mark
        var asks: [AskEntry]
        var runs: [PendingAsk]
        var editing: Bool
        var showsNotes: Bool
        var asksFrom: Bool
        var names: AnswerFormat.Names
        var maxBody: CGFloat
        var canContinue: Bool
        var canCopy: Bool
        var openLogs: Set<String>
    }

    /// The card's contents made (renderMarks draws a page's cards anew; a running box is filled in place: fillRun).
    func configure(_ c: Content) {
        let m = c.mark
        let fieldMode = m.note != nil && (c.editing || (m.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !c.showsNotes)
        typing = (m.note != nil && fieldMode) || !c.asks.isEmpty || !c.runs.isEmpty
        if let text = m.note {
            let field = note ?? makeTextView(NoteField.self, editable: true)
            field.card = self
            field.delegate = self
            field.textContainerInset = NSSize(width: 6, height: 0)
            field.typingAttributes = NoteLook.attrs
            if note == nil { noteHolder.addSubview(field); note = field }
            if fieldMode {
                field.shown = false
                field.isEditable = true; field.isSelectable = true
                field.isRichText = false
                // through the storage: `string =` also moves the selection, which loaded the writing tools (150 ms, once)
                if field.string != text { field.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: NoteLook.attrs)) }
                field.textStorage?.setAttributes(NoteLook.attrs, range: NSRange(location: 0, length: field.textStorage?.length ?? 0))
                inkNote(field, asksFrom: c.asksFrom)
            } else {
                field.shown = true
                field.isEditable = false; field.isSelectable = false
                field.textStorage?.setAttributedString(shownNote(text, c))
            }
        } else if let field = note { field.removeFromSuperview(); note = nil }

        for (_, v) in askViews { v.removeFromSuperview() }
        askViews = c.asks.map { a in
            let v = AskSectionView(ask: a, card: self, asked: Canvas.askedByNote(a.question, m.note) ? "" : (a.question ?? ""), names: c.names, maxBody: c.maxBody, canContinue: c.canContinue, canCopy: c.canCopy)
            addSubview(v)
            return (a.id, v)
        }
        let keep = Set(c.runs.map(\.askId))
        for (id, v) in runViews where !keep.contains(id) { v.removeFromSuperview() }
        runViews = c.runs.map { p in
            let v = runViews.first { $0.id == p.askId }?.view ?? RunBoxView(askId: p.askId, card: self)
            if v.superview == nil { addSubview(v) }
            v.fill(p, asked: Canvas.askedByNote(p.question, m.note) ? "" : p.question, open: c.openLogs.contains(p.askId), maxBody: c.maxBody, names: c.names)
            return (p.askId, v)
        }
    }

    /// A running ask filled in place (fillRun): its Stop and steps buttons stay the same views.
    func fillRun(_ p: PendingAsk, note: String?, open: Bool, maxBody: CGFloat, names: AnswerFormat.Names) {
        runViews.first { $0.id == p.askId }?.view.fill(p, asked: Canvas.askedByNote(p.question, note) ? "" : p.question, open: open, maxBody: maxBody, names: names)
    }

    /// The note shown as text: its pieces, library mentions as chips, a leading @bart as the label.
    private func shownNote(_ text: String, _ c: Content) -> NSAttributedString {
        let out = NSMutableAttributedString()
        var parts: [(String, Int)] = []
        let lead = c.asksFrom ? NoteText.agentToken(text) : nil
        var agentAt: NSRange?
        for p in NoteText.noteParts(text, agents: c.asksFrom) {
            let piece: NSAttributedString
            if let f = NoteText.fileMentionOf(p) { piece = AnswerFormat.fileChip(f, base: NoteLook.attrs, names: c.names) }
            else if let l = NoteText.libMentionOf(p) { piece = AnswerFormat.libChip(l, base: NoteLook.attrs, names: c.names) }
            else {
                if lead != nil, agentAt == nil, p.lowercased() == "@bart" { agentAt = NSRange(location: out.length, length: (p as NSString).length) }
                piece = NSAttributedString(string: p, attributes: NoteLook.attrs)
            }
            parts.append((p, piece.length))
            out.append(piece)
        }
        note?.shownParts = parts.map { (raw: $0.0, shownLength: $0.1) }
        if let r = agentAt { out.addAttribute(.foregroundColor, value: NSColor.clear, range: r) }
        note?.agentRange = agentAt
        // a chip keeps the handwriting's size but is drawn in its own weight, as libHtml's spans inherit the note's font
        out.enumerateAttribute(.link, in: NSRange(location: 0, length: out.length)) { v, r, _ in if v != nil { out.addAttribute(.font, value: NoteLook.font, range: r) } }
        return out
    }

    /// A note's field given its @bart label (noteInkHtml): the token transparent, the label drawn over it.
    func inkNote(_ field: NoteField, asksFrom: Bool) {
        guard let storage = field.textStorage else { return }
        storage.removeAttribute(.foregroundColor, range: NSRange(location: 0, length: storage.length))
        storage.addAttribute(.foregroundColor, value: NoteLook.ink, range: NSRange(location: 0, length: storage.length))
        field.agentRange = nil
        if asksFrom, let r = NoteText.agentToken(field.string) {
            storage.addAttribute(.foregroundColor, value: NSColor.clear, range: r)
            field.agentRange = r
        }
        field.insertionPointColor = NoteLook.ink
        field.needsDisplay = true
    }

    /// Lays the card out `w` note px wide → its size (a typing card is w wide; another as wide as what it holds).
    @discardableResult
    func layoutCard(w: CGFloat) -> NSSize {
        var width = w
        if !typing, let field = note {
            // max-content: the note's text on one line, up to w
            let natural = naturalWidth(field)
            width = min(w, natural)
        }
        var y: CGFloat = 0
        var n = 0
        if let field = note {
            let h = max(NoteLook.lineHeight, textHeight(field, width: width - 12))
            noteHolder.frame = NSRect(x: 0, y: 0, width: width, height: h + 4) // padding-bottom 4px
            field.frame = NSRect(x: 0, y: 0, width: width, height: h)
            y = h + 4; n += 1
        } else { noteHolder.frame = .zero }
        for (_, v) in askViews {
            if n > 0 { y += 10 }
            let h = v.layoutSection(width: width)
            v.frame = NSRect(x: 0, y: y, width: width, height: h)
            y += h; n += 1
        }
        for (_, v) in runViews {
            if n > 0 { y += 10 }
            let h = v.layoutSection(width: width)
            v.frame = NSRect(x: 0, y: y, width: width, height: h)
            y += h; n += 1
        }
        size = NSSize(width: width, height: y)
        return size
    }

    private func naturalWidth(_ field: NoteField) -> CGFloat {
        // max-content: the note's longest line as set, its padding (0 6px) each side
        guard let s = field.textStorage, s.length > 0 else { return 12 }
        return ceil(s.boundingRect(with: NSSize(width: 100_000, height: 100_000), options: [.usesLineFragmentOrigin]).width) + 12 + 1
    }

    /// Placed on its sheet: `origin` in the canvas, drawn at `scale` (ns × inv).
    func place(origin: NSPoint, scale: CGFloat) {
        let frame = NSRect(x: origin.x, y: origin.y, width: size.width * scale, height: size.height * scale)
        if self.frame != frame { self.frame = frame }
        if bounds.size != size { setBoundsSize(size) }
    }
}

extension CardView: NSTextViewDelegate {
    func textDidChange(_ notification: Notification) {
        guard let field = notification.object as? NoteField else { return }
        owner?.noteChanged(self, field)
    }
    func textViewDidChangeSelection(_ notification: Notification) {
        guard let field = notification.object as? NoteField else { return }
        owner?.noteSelectionChanged(self, field)
    }
}

/// An answer in its card (PaperView askSection): the question in grey when it is not what the note asks now, the answer
/// (scrolling inside past 40% of the pane), then Continue in project, Copy, Delete, Collapse; collapsed, "Bart ›".
final class AskSectionView: NSView {
    let ask: AskEntry
    private(set) var buttons: [TextButton] = []
    private(set) var question: NSTextField?
    private(set) var body: AnswerText?
    private(set) var scroll: NSScrollView?
    private let maxBody: CGFloat

    init(ask: AskEntry, card: CardView, asked: String, names: AnswerFormat.Names, maxBody: CGFloat, canContinue: Bool, canCopy: Bool) {
        self.ask = ask; self.maxBody = maxBody
        super.init(frame: .zero)
        let act: (TextButton) -> Void = { [weak card] b in if let card { card.owner?.askAction(card, askId: ask.id, action: b.action, button: b) } }
        if ask.collapsed == true {
            let b = TextButton("Bart ›", action: "expand", onPress: act)
            b.font = Fonts.sans(13, weight: 500); b.color = NSColor(hex: "#171717")
            b.toolTip = ask.question ?? ""
            buttons = [b]; addSubview(b)
            return
        }
        if !asked.isEmpty {
            let q = makeLabel(asked, font: Fonts.sans(15), color: NSColor(hex: "#8f8f8f"))
            q.toolTip = asked
            question = q; addSubview(q)
        }
        let tv = makeTextView(AnswerText.self, editable: false)
        tv.card = card
        tv.render = { AnswerFormat.answer(ask.answer ?? "", names: names, expanded: $0) }
        let sv = NSScrollView()
        sv.drawsBackground = false; sv.hasVerticalScroller = true; sv.autohidesScrollers = true; sv.borderType = .noBorder
        sv.documentView = tv
        body = tv; scroll = sv; addSubview(sv)
        if canContinue { buttons.append(TextButton("Continue in project", action: "continue", onPress: act)) }
        if canCopy { buttons.append(TextButton("Copy", action: "copy", onPress: act)) }
        buttons.append(TextButton("Delete", action: "delete", onPress: act))
        buttons.append(TextButton("Collapse", action: "collapse", onPress: act))
        for b in buttons { addSubview(b) }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    func layoutSection(width: CGFloat) -> CGFloat {
        if ask.collapsed == true, let b = buttons.first {
            let s = b.intrinsicContentSize
            b.frame = NSRect(x: 0, y: 2, width: s.width, height: s.height)
            return s.height + 4
        }
        var y: CGFloat = 0
        if let q = question {
            q.frame = NSRect(x: 6, y: 0, width: max(1, width - 12), height: 23)
            y = 23 + 6
        }
        if let tv = body, let sv = scroll {
            let h = textHeight(tv, width: width - 12)
            let shown = min(h, maxBody)
            tv.frame = NSRect(x: 0, y: 0, width: width - 12, height: h)
            sv.frame = NSRect(x: 6, y: y, width: width - 12, height: shown)
            sv.hasVerticalScroller = h > shown
            y += shown + 2
        }
        // the buttons, wrapping: padding 2px 0 4px, gap 2
        var x: CGFloat = 0, rowH: CGFloat = 0
        y += 2
        for b in buttons {
            let s = b.intrinsicContentSize
            if x > 0 && x + s.width > width { x = 0; y += rowH + 2; rowH = 0 }
            b.frame = NSRect(x: x, y: y, width: s.width, height: s.height)
            x += s.width + 2; rowH = max(rowH, s.height)
        }
        return y + rowH + 4
    }
}

/// An answer being written (PaperView runBox/fillRun): what Bart is doing with a spinner and Stop, "▸ n steps", the
/// answer as it comes; a failure says why, with × to close it.
final class RunBoxView: NSView {
    let askId: String
    private weak var card: CardView?
    let spinner = Spinner()
    let label = makeLabel("", font: Fonts.sans(15), color: NSColor(hex: "#4d4d4d"))
    let failedLabel = makeLabel("Bart · No answer", font: Fonts.sans(15, weight: 500), color: NSColor(hex: "#171717"))
    lazy var stop = TextButton("Stop", action: "stop") { [weak self] _ in self?.press("stop") }
    lazy var close = TextButton("×", action: "dismiss") { [weak self] _ in self?.press("dismiss") }
    let question = makeLabel("", font: Fonts.sans(15), color: NSColor(hex: "#8f8f8f"))
    let error = makeLabel("", font: Fonts.sans(15), color: NSColor(hex: "#c4372d"), lines: 0)
    lazy var steps = TextButton("", action: "log") { [weak self] _ in self?.press("log") }
    let log = NSTextField(wrappingLabelWithString: "")
    let body = makeTextView(AnswerText.self, editable: false)
    let bodyScroll = NSScrollView()
    private(set) var failed = false
    private(set) var hasLog = false, open = false, hasBody = false
    private var maxBody: CGFloat = 200

    init(askId: String, card: CardView) {
        self.askId = askId; self.card = card
        super.init(frame: .zero)
        close.setAccessibilityLabel("Close")
        log.font = Fonts.sans(13); log.textColor = NSColor(hex: "#8f8f8f")
        body.card = card
        bodyScroll.drawsBackground = false; bodyScroll.hasVerticalScroller = true; bodyScroll.autohidesScrollers = true
        bodyScroll.documentView = body
        for v in [spinner, label, failedLabel, stop, close, question, error, steps, log, bodyScroll] as [NSView] { addSubview(v) }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func mouseDown(with event: NSEvent) {}

    private func press(_ action: String) { if let card { card.owner?.runAction(card, askId: askId, action: action) } }

    func fill(_ p: PendingAsk, asked: String, open: Bool, maxBody: CGFloat, names: AnswerFormat.Names) {
        self.maxBody = maxBody
        failed = p.error != nil
        let label = Canvas.runningLabel(p)
        if self.label.stringValue != label { self.label.stringValue = label }
        question.stringValue = asked; question.toolTip = asked; question.isHidden = asked.isEmpty
        error.stringValue = failed ? ((p.error ?? "").isEmpty ? "The run failed." : p.error!) : ""
        error.isHidden = !failed
        hasLog = !p.log.isEmpty; self.open = open
        steps.title = "\(open ? "▾" : "▸") \(p.log.count) \(p.log.count == 1 ? "step" : "steps")"
        steps.setAccessibilityExpanded(open)
        steps.isHidden = !hasLog
        log.stringValue = open ? p.log.joined(separator: "\n") : ""
        log.isHidden = !(open && hasLog)
        let lines = !failed && p.activity == "Writing" ? p.lines : []
        hasBody = !lines.isEmpty
        let atEnd = bodyScroll.isHidden || bodyScroll.contentView.bounds.maxY >= body.frame.height - 4
        body.textStorage?.setAttributedString(AnswerFormat.answer(AnswerFormat.streaming(lines.joined(separator: "\n")), names: names, color: NSColor(hex: "#8f8f8f")))
        bodyScroll.isHidden = !hasBody
        spinner.isHidden = failed; self.label.isHidden = failed; stop.isHidden = failed
        failedLabel.isHidden = !failed; close.isHidden = !failed
        if hasBody && atEnd { DispatchQueue.main.async { [weak self] in guard let self else { return }; self.body.scrollToEndOfDocument(nil) } }
    }

    func layoutSection(width: CGFloat) -> CGFloat {
        var y: CGFloat = 0
        // head: padding 0 0 4px 6px, gap 8
        let headH: CGFloat = 23
        if failed {
            let cs = close.intrinsicContentSize
            failedLabel.frame = NSRect(x: 6, y: 0, width: max(1, width - 6 - cs.width - 8), height: headH)
            close.frame = NSRect(x: width - cs.width, y: 0, width: cs.width, height: cs.height)
        } else {
            spinner.frame = NSRect(x: 6, y: (headH - 10) / 2, width: 10, height: 10)
            let ss = stop.intrinsicContentSize
            label.frame = NSRect(x: 24, y: 0, width: max(1, width - 24 - ss.width - 8), height: headH)
            stop.frame = NSRect(x: width - ss.width, y: (headH - ss.height) / 2, width: ss.width, height: ss.height)
        }
        y = headH + 4
        if !question.isHidden { question.frame = NSRect(x: 6, y: y, width: max(1, width - 12), height: 23); y += 23 + 6 }
        if !error.isHidden {
            let h = error.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width - 12, height: 10_000)).height ?? 23
            error.frame = NSRect(x: 6, y: y, width: width - 12, height: h); y += h + 8
        }
        if hasLog {
            let s = steps.intrinsicContentSize
            steps.frame = NSRect(x: 0, y: y, width: s.width, height: s.height); y += s.height + 4
        }
        if !log.isHidden {
            let h = log.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width - 12, height: 10_000)).height ?? 0
            log.frame = NSRect(x: 6, y: y, width: width - 12, height: h); y += h + 6
        }
        if hasBody {
            let h = textHeight(body, width: width - 12)
            body.frame = NSRect(x: 0, y: 0, width: width - 12, height: h)
            let shown = min(h, maxBody)
            bodyScroll.frame = NSRect(x: 6, y: y, width: width - 12, height: shown); y += shown + 8
        }
        return y
    }
}

/// The move handle at a card's lower right (PaperView MOVE_ICON, Hudson's four arrows): 15 × 15 screen px whatever the
/// card's scale, #8f8f8f (#171717 hovered), shown while the pointer is on the card.
final class MoveHandle: NSView {
    weak var card: CardView?
    var onPress: ((NSEvent) -> Void)?
    private(set) var hovering = false { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect, .cursorUpdate], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; if let card { card.owner?.cardHover(card, inside: true) } }
    override func mouseExited(with event: NSEvent) { hovering = false; if let card { card.owner?.cardHover(card, inside: false) } }
    override func cursorUpdate(with event: NSEvent) { NSCursor.openHand.set() }
    override func mouseDown(with event: NSEvent) { onPress?(event) }
    override func draw(_ dirtyRect: NSRect) {
        // MOVE_ICON's path, 16-unit viewBox drawn 13px in the middle of 15
        let p = NSBezierPath()
        let pts: [(CGFloat, CGFloat)] = [(8, 0.5), (10.6, 3.4), (8.9, 3.4), (8.9, 7.1), (12.6, 7.1), (12.6, 5.4), (15.5, 8), (12.6, 10.6), (12.6, 8.9), (8.9, 8.9), (8.9, 12.6), (10.6, 12.6), (8, 15.5), (5.4, 12.6), (7.1, 12.6), (7.1, 8.9), (3.4, 8.9), (3.4, 10.6), (0.5, 8), (3.4, 5.4), (3.4, 7.1), (7.1, 7.1), (7.1, 3.4), (5.4, 3.4)]
        let k: CGFloat = 13 / 16, o: CGFloat = 1
        for (i, pt) in pts.enumerated() {
            let q = NSPoint(x: o + pt.0 * k, y: o + pt.1 * k)
            if i == 0 { p.move(to: q) } else { p.line(to: q) }
        }
        p.close()
        (hovering ? NSColor(hex: "#171717") : NSColor(hex: "#8f8f8f")).setFill()
        p.fill()
    }
}
