import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartUI

// The views of @brainstorm's and @discover's cards, @create's rows and peek, an @discover guide's bookmark and Send to
// Discover (DocEditor.jsx cardHtml, CARD_CSS .dv-* / .bs-*, madeHtml, createPendingHtml, MadePeek, paperSaveHtml,
// sendDiscoverHtml). They draw what EditorCore says; every press goes back through the editor to the core or the host.

/// Text with its `$…$` formulas as MathText draws them (textMathHtml).
enum CardText {
    static let MATH = Rx(#"\$\$([^$]+)\$\$|\$([^$\n]+)\$"#)
    static func shown(_ text: String) -> String {
        var out = "", at = 0
        for m in MATH.matchAll(text) {
            out += text.slice(at, m.index)
            let display = m[1] != nil, tex = m[1] ?? m[2] ?? ""
            out += MathText.render(tex, display: display) ?? m[0]!
            at = m.index + m[0]!.len
        }
        return out + text.slice(at)
    }
    static func attr(_ text: String, size: CGFloat = 16, weight: Int = 400, color: NSColor = Look.answerInk, italic: Bool = false, lineHeight: CGFloat = 1.65) -> NSMutableAttributedString {
        let p = NSMutableParagraphStyle()
        p.minimumLineHeight = (size * lineHeight).rounded(); p.maximumLineHeight = p.minimumLineHeight
        p.lineBreakMode = .byWordWrapping
        var font = Fonts.sans(size, weight: weight)
        if italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
        return NSMutableAttributedString(string: shown(text), attributes: [.font: font, .foregroundColor: color, .paragraphStyle: p,
                                                                          .baselineOffset: Renderer.baseline(font, p.minimumLineHeight)])
    }
    static func height(_ s: NSAttributedString, width: CGFloat) -> CGFloat {
        guard s.length > 0 else { return 0 }
        return ceil(s.boundingRect(with: NSSize(width: max(10, width), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).height)
    }
}

/// Draws an attributed string in its bounds, wrapping (a card's text: its map, what it says, its question).
final class TextBlock: FlippedView {
    var text: NSAttributedString { didSet { needsDisplay = true } }
    init(_ text: NSAttributedString) { self.text = text; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) { text.draw(with: bounds, options: [.usesLineFragmentOrigin, .usesFontLeading]) }
}

/// One row of a card: David's boxed row (.dv-opt: white, bordered, a check that turns blue) or a list row (.bs-row: a
/// bullet or ✓ in the mark's column, the label blue on hover or picked).
final class CardOptionView: NSButton {
    let boxed: Bool
    let label: NSAttributedString
    let why: NSAttributedString?
    var on: Bool { didSet { needsDisplay = true } }
    var repicking = false { didSet { needsDisplay = true } }
    var live: Bool
    var onClick: () -> Void = {}
    private var hover = false
    private var area: NSTrackingArea?
    init(boxed: Bool, label: String, why: String?, on: Bool, live: Bool, enabled: Bool) {
        self.boxed = boxed; self.on = on; self.live = live
        if boxed {
            self.label = CardText.attr(label, size: 15, color: Look.ink, lineHeight: 1.4)
            self.why = why.map { CardText.attr($0, size: 13, color: Look.grey, lineHeight: 1.4) }
        } else {
            let s = CardText.attr(label)
            if let why { s.append(CardText.attr(" · \(why)", color: Look.grey)) }
            self.label = s; self.why = nil
        }
        super.init(frame: .zero)
        isBordered = false; title = ""; isEnabled = enabled
        target = self; action = #selector(fire)
        setAccessibilityRole(.checkBox); setAccessibilityLabel(label)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func fire() { onClick() }
    override var acceptsFirstResponder: Bool { false }
    override var isFlipped: Bool { true }
    override func updateTrackingAreas() {
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area!)
    }
    override func mouseEntered(with event: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = false; needsDisplay = true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: isEnabled ? .pointingHand : boxed ? .arrow : .iBeam) }

    static func height(boxed: Bool, label: String, why: String?, width: CGFloat) -> CGFloat {
        if boxed {
            let w = width - 28 - 14 - 12
            var h = CardText.height(CardText.attr(label, size: 15, lineHeight: 1.4), width: w)
            if let why { h += 2 + CardText.height(CardText.attr(why, size: 13, lineHeight: 1.4), width: w) }
            return h + 20 + 2
        }
        let s = CardText.attr(label); if let why { s.append(CardText.attr(" · \(why)")) }
        return CardText.height(s, width: width - 28) + 4
    }
    override func draw(_ dirtyRect: NSRect) {
        if boxed {
            let r = bounds.insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: r, xRadius: 10, yRadius: 10)
            NSColor.white.setFill(); path.fill()
            if repicking { path.setLineDash([4, 3], count: 2, phase: 0); Look.blue.setStroke() }
            else { NSColor(hex: hover && isEnabled && !on ? "#c4c4c4" : "#e3e3e3").setStroke() }
            path.lineWidth = 1; path.stroke()
            let checkColor = on || repicking ? Look.blue : NSColor(hex: hover && isEnabled ? "#a3a3a3" : "#d4d4d4")
            Glyphs.image(Glyphs.check, size: 14, color: checkColor, width: 2.25 * 24 / 14 / 1.7).draw(in: NSRect(x: 14, y: 10 + 3.5, width: 14, height: 14))
            let w = bounds.width - 28 - 14 - 12
            let lh = CardText.height(label, width: w)
            label.draw(with: NSRect(x: 14 + 14 + 12, y: 10, width: w, height: lh), options: [.usesLineFragmentOrigin, .usesFontLeading])
            if let why { why.draw(with: NSRect(x: 14 + 14 + 12, y: 10 + lh + 2, width: w, height: bounds.height - lh - 22), options: [.usesLineFragmentOrigin, .usesFontLeading]) }
            return
        }
        let blue = on || (hover && isEnabled)
        let markColor = on ? (live ? Look.blue : Look.mid) : Look.grey
        let mark = NSAttributedString(string: on ? "✓" : "•", attributes: [.font: Fonts.sans(16), .foregroundColor: markColor])
        mark.draw(at: NSPoint(x: 6, y: 2 + 3))
        let s = NSMutableAttributedString(attributedString: label)
        if blue {
            let color = on && !live ? Look.ink : Look.blue
            let whyStart = (label.string as NSString).range(of: " · ").location
            s.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: whyStart == NSNotFound ? s.length : whyStart))
        }
        s.draw(with: NSRect(x: 28, y: 2, width: bounds.width - 28, height: bounds.height - 4), options: [.usesLineFragmentOrigin, .usesFontLeading])
    }
}

/// A bordered button with words (.dv-submit, .dv-cancel, .dv-restart, .made-btn).
final class BoxButton: NSButton {
    var fill: NSColor, ink: NSColor, border: NSColor?
    var icon: [String]?
    var onClick: () -> Void = {}
    let words: String
    let size: CGFloat, weight: Int
    init(_ words: String, fill: NSColor, ink: NSColor, border: NSColor? = nil, icon: [String]? = nil, size: CGFloat = 13, weight: Int = 400) {
        self.words = words; self.fill = fill; self.ink = ink; self.border = border; self.icon = icon; self.size = size; self.weight = weight
        super.init(frame: .zero)
        isBordered = false; title = ""; target = self; action = #selector(fire)
        setAccessibilityLabel(words)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func fire() { onClick() }
    override var acceptsFirstResponder: Bool { false }
    override var isFlipped: Bool { true }
    var wantedWidth: CGFloat { (words as NSString).size(withAttributes: [.font: Fonts.sans(size, weight: weight)]).width + (icon == nil ? 0 : 15 + 6) + 22 }
    override func resetCursorRects() { addCursorRect(bounds, cursor: isEnabled ? .pointingHand : .arrow) }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7)
        fill.setFill(); path.fill()
        if let border { border.setStroke(); path.lineWidth = 1; path.stroke() }
        let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(size, weight: weight), .foregroundColor: isEnabled ? ink : ink.withAlphaComponent(0.5)]
        let sz = (words as NSString).size(withAttributes: a)
        var x = (bounds.width - sz.width - (icon == nil ? 0 : 21)) / 2
        if let icon { Glyphs.image(icon, size: 15, color: isEnabled ? ink : ink.withAlphaComponent(0.5)).draw(in: NSRect(x: x, y: (bounds.height - 15) / 2, width: 15, height: 15)); x += 21 }
        (words as NSString).draw(at: NSPoint(x: x, y: (bounds.height - sz.height) / 2), withAttributes: a)
    }
}

/// One card (cardHtml): map sections, what it says, its question, its subtitle, its rows; a boxed live card's own field
/// and Submit; an answered boxed card's repick confirm.
final class CardView: FlippedView, NSTextViewDelegate {
    struct Model {
        var card: JSONValue
        var agent: String
        var live: Bool
        var boxed: Bool
        var again: Bool
        var picks: [String]
        var asking: Int?
        var typed: String
        var closes: Bool
    }
    let model: Model
    var onPick: (Int) -> Void = { _ in }
    var onRepick: (Int) -> Void = { _ in }
    var onRepickGo: (Int) -> Void = { _ in }
    var onRepickNo: () -> Void = {}
    var onSubmit: () -> Void = {}
    var onText: (String) -> Void = { _ in }
    var onKey: (NSEvent) -> Bool = { _ in false }
    var field: ReplyTextView?
    var submit: BoxButton?
    private var options: [CardOptionView] = []
    private var blocks: [TextBlock] = []
    private var confirm: (text: TextBlock, cancel: BoxButton, go: BoxButton)?

    static let MAP_LABELS = ["settled": "What you've settled", "open": "What's still open", "untouched": "Not yet looked at"]

    init(_ m: Model) {
        model = m
        super.init(frame: .zero)
        let asked = Card.questionOf(m.card)
        for text in CardView.texts(m) { let b = TextBlock(text); blocks.append(b); addSubview(b) }
        if let asked, Card.isChoice(asked.type) {
            for (n, o) in asked.options.enumerated() {
                let label = o["label"]?.string ?? "", why = o["why"]?.string
                let on = m.picks.contains(label)
                let enabled = m.live || (m.boxed && m.again && !on)
                let v = CardOptionView(boxed: m.boxed, label: label, why: why, on: on, live: m.live, enabled: enabled)
                v.repicking = m.asking == n
                if m.live { v.onClick = { [weak self] in self?.onPick(n) } }
                else if enabled { v.onClick = { [weak self] in self?.onRepick(n) }; v.toolTip = "Pick this instead: the conversation starts again from it" }
                options.append(v); addSubview(v)
            }
            if m.boxed, let n = m.asking, n < asked.labels.count {
                let t = NSMutableAttributedString(attributedString: CardText.attr("Pick ", size: 14, color: NSColor(hex: "#525252"), lineHeight: 1.45))
                t.append(CardText.attr(asked.labels[n], size: 14, weight: 500, color: Look.ink, lineHeight: 1.45))
                t.append(CardText.attr(" instead? Everything after this will be asked again from that pick.", size: 14, color: NSColor(hex: "#525252"), lineHeight: 1.45))
                let cancel = BoxButton("Cancel", fill: .white, ink: Look.answerInk, border: NSColor(hex: "#e3e3e3"), size: 13.5, weight: 500)
                let go = BoxButton("Restart from here", fill: Look.blue, ink: .white, size: 13.5, weight: 500)
                cancel.onClick = { [weak self] in self?.onRepickNo() }
                go.onClick = { [weak self] in self?.onRepickGo(n) }
                let tb = TextBlock(t)
                confirm = (tb, cancel, go)
                [tb, cancel, go].forEach(addSubview)
            }
        }
        if m.boxed && m.live, let asked {
            let f = ReplyTextView()
            f.isRichText = false; f.drawsBackground = false; f.font = Fonts.sans(15); f.textColor = Look.ink
            f.textContainerInset = .zero; f.textContainer?.lineFragmentPadding = 0
            f.string = m.typed; f.delegate = self
            f.placeholder = m.agent == "brainstorm" && asked.id == "versions" ? "Or rewrite it yourself…" : "Or say it in your own words…"
            f.keyHook = { [weak self] e in self?.onKey(e) ?? false }
            f.setAccessibilityLabel("Answer")
            let ready = !m.picks.isEmpty
            let s = BoxButton("Submit", fill: ready ? Look.blue : NSColor(hex: "#f2f2f2"), ink: ready ? .white : Look.grey, size: 14, weight: 500)
            s.onClick = { [weak self] in self?.onSubmit() }
            field = f; submit = s
            addSubview(f); addSubview(s)
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The card's words before its rows: map sections, what it says, its question, its subtitle.
    static func texts(_ m: Model) -> [NSAttributedString] {
        var out: [NSAttributedString] = []
        if let map = m.card["map"] {
            for group in Card.mapGroups {
                guard let items = map[group]?.array, !items.isEmpty else { continue }
                let s = CardText.attr(MAP_LABELS[group] ?? group, weight: 600, color: Look.ink)
                for item in items {
                    s.append(CardText.attr("\n•  ", color: Look.grey))
                    s.append(CardText.attr(item["text"]?.string ?? ""))
                    if let from = item["from"]?.string, !from.isEmpty { s.append(CardText.attr(" · \(from)", color: Look.grey)) }
                }
                out.append(s)
            }
        }
        if let say = m.card["say"]?.string, !say.isEmpty { out.append(CardText.attr(say)) }
        guard let asked = Card.questionOf(m.card) else { return out }
        out.append(CardText.attr(asked.title, color: Look.ink))
        let sub = (m.agent == "brainstorm" ? nil : asked.subtitle).flatMap { $0.isEmpty ? nil : $0 } ?? (asked.type == "select_all" ? "Pick any, then press Enter." : nil)
        if let sub { out.append(CardText.attr(sub, size: 14, color: Look.grey)) }
        return out
    }

    static let left: CGFloat = 32, right: CGFloat = 16, gap: CGFloat = 10

    /// Its frames at `width`, and its height.
    func place(width: CGFloat) -> CGFloat {
        let w = width - CardView.left - CardView.right
        var y: CGFloat = 12 + 2
        var firstPart = true
        func next(_ h: CGFloat) -> CGFloat { if !firstPart { y += CardView.gap }; firstPart = false; let top = y; y += h; return top }
        for b in blocks { let h = CardText.height(b.text, width: w); b.frame = NSRect(x: CardView.left, y: next(h), width: w, height: h) }
        if !options.isEmpty {
            let asked = Card.questionOf(model.card)!
            var top = next(0)
            for (n, v) in options.enumerated() {
                let o = asked.options[n]
                let h = CardOptionView.height(boxed: model.boxed, label: o["label"]?.string ?? "", why: o["why"]?.string, width: w)
                v.frame = NSRect(x: CardView.left, y: top, width: w, height: h)
                top += h + (model.boxed && n < options.count - 1 ? 8 : 0)
            }
            y = top
        }
        if let c = confirm {
            let bw = c.cancel.wantedWidth + 8 + c.go.wantedWidth
            let tw = w - 28 - 12 - bw
            let wraps = tw < 220
            let th = CardText.height(c.text.text, width: wraps ? w - 28 : tw)
            let top = next(0)
            let inner = wraps ? th + 8 + 30 : max(th, 30)
            c.text.frame = NSRect(x: CardView.left + 14, y: top + 10, width: wraps ? w - 28 : tw, height: th)
            let by = wraps ? top + 10 + th + 8 : top + 10 + (inner - 30) / 2
            c.go.frame = NSRect(x: CardView.left + w - 14 - c.go.wantedWidth, y: by, width: c.go.wantedWidth, height: 30)
            c.cancel.frame = NSRect(x: c.go.frame.minX - 8 - c.cancel.wantedWidth, y: by, width: c.cancel.wantedWidth, height: 30)
            confirmBox = NSRect(x: CardView.left, y: top, width: w, height: inner + 20)
            y = top + inner + 20
        }
        if let f = field, let s = submit {
            let sw = s.words.size(font: Fonts.sans(14, weight: 500)) + 32
            let fw = w - 8 - sw - 24 - 2
            let fh = max(24, CardText.height(CardText.attr(f.string.isEmpty ? "x" : f.string, size: 15, lineHeight: 1.6), width: fw))
            let top = next(0)
            let boxH = max(34, fh + 8 + 2)
            fieldBox = NSRect(x: CardView.left, y: top, width: w - 8 - sw, height: boxH)
            f.frame = NSRect(x: CardView.left + 13, y: top + (boxH - fh) / 2, width: fw, height: fh)
            s.frame = NSRect(x: CardView.left + w - sw, y: top, width: sw, height: boxH)
            y = top + boxH
        }
        return y + 2 + (model.closes ? 10 : 0)
    }
    private var confirmBox: NSRect?
    private var fieldBox: NSRect?
    static func height(_ m: Model, width: CGFloat) -> CGFloat { CardView(m).place(width: width) }
    override func layout() { super.layout(); _ = place(width: bounds.width) }
    override func draw(_ dirtyRect: NSRect) {
        for box in [confirmBox, fieldBox].compactMap({ $0 }) {
            let p = NSBezierPath(roundedRect: box.insetBy(dx: 0.5, dy: 0.5), xRadius: box == confirmBox ? 10 : 8, yRadius: box == confirmBox ? 10 : 8)
            NSColor.white.setFill(); p.fill()
            NSColor(hex: box == fieldBox && window?.firstResponder === field ? "#c4c4c4" : "#e3e3e3").setStroke(); p.lineWidth = 1; p.stroke()
        }
    }
    func textDidChange(_ notification: Notification) {
        guard let f = field else { return }
        if f.string.contains("\n") || f.string.contains("\r") {
            let sel = f.selectedRange()
            f.string = f.string.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
            f.setSelectedRange(sel)
        }
        onText(f.string)
    }
}

extension String {
    func size(font: NSFont) -> CGFloat { (self as NSString).size(withAttributes: [.font: font]).width }
}

/// A made file's row (madeHtml): the shapes icon, its name in blue (a press opens it in the Stage; resting on it peeks),
/// Save or Saved, and a chevron that opens its frame inline: the picture or the text, Save, Open in Stage, the chevron up.
final class MadeRowView: FlippedView {
    let key: String, name: String
    let file: MadeFile?
    let open: Bool
    let inCard: Bool
    let first: Bool
    var onOpen: () -> Void = {}
    var onSave: () -> Void = {}
    var onExpand: () -> Void = {}
    var onPeek: (Bool, NSView) -> Void = { _, _ in }
    let nameButton: NSButton
    let save: BoxButton?
    let stage: BoxButton?
    let chevron: IconButton
    private var body: NSView?
    private var area: NSTrackingArea?
    static let frameMax: CGFloat = 640

    init(key: String, name: String, file: MadeFile?, open: Bool, first: Bool, inCard: Bool = true) {
        self.key = key; self.name = name; self.file = file; self.open = open; self.first = first; self.inCard = inCard
        nameButton = NSButton(title: name, target: nil, action: nil)
        if let file, file.saved == nil {
            let b = BoxButton(file.saving ? "Saving…" : "Save", fill: .white, ink: Look.answerInk, border: NSColor(hex: "#e3e3e3"), icon: MadeRowView.folderPlus)
            b.isEnabled = file.error == nil && !file.missing && !file.saving
            b.toolTip = "Save to your library (Assets)"
            save = b
        } else { save = nil }
        stage = open ? BoxButton("Open in Stage", fill: .white, ink: Look.answerInk, border: NSColor(hex: "#e3e3e3"), icon: MadeRowView.stageIcon) : nil
        chevron = IconButton(open ? Glyphs.chevronUp : Glyphs.chevronDown, tip: open ? "Fold" : "Open here")
        super.init(frame: .zero)
        nameButton.isBordered = false
        nameButton.attributedTitle = NSAttributedString(string: name, attributes: [.font: Fonts.sans(open ? 14 : 15.5), .foregroundColor: open ? Look.answerInk : Look.blue])
        nameButton.lineBreakMode = .byTruncatingTail
        nameButton.target = self; nameButton.action = #selector(openIt)
        save?.onClick = { [weak self] in self?.onSave() }
        stage?.onClick = { [weak self] in self?.onOpen() }
        chevron.onClick = { [weak self] in self?.onExpand() }
        [nameButton, chevron].forEach(addSubview)
        if let save { addSubview(save) }
        if let stage { addSubview(stage) }
        if open { let b = MadeRowView.bodyView(file, name: name); body = b; addSubview(b) }
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func openIt() { onOpen() }

    static let folderPlus = ["M12 10v6", "M9 13h6", "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]
    static let stageIcon = ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M15 3v18"]

    /// What the frame or the peek shows (madeBodyHtml): the picture, the text, a table's text, or why there is none.
    static func bodyView(_ file: MadeFile?, name: String) -> NSView {
        let say = { (t: String) -> NSView in let tb = TextBlock(CardText.attr(t, size: 13, color: Look.grey, lineHeight: 1.5)); return tb }
        guard let file else { return say("Loading…") }
        if file.missing { return say("This file is no longer there.") }
        if let e = file.error { return say(e) }
        if let image = file.image { let v = NSImageView(image: image); v.imageScaling = .scaleProportionallyUpOrDown; v.setAccessibilityLabel(name); return v }
        if file.type == "html" { return say("No picture of this page: open it in the Stage.") }
        if let text = file.text {
            let mono = file.type != "md"
            let s = NSMutableAttributedString(string: text.slice(0, 20000), attributes: [.font: mono ? Fonts.mono(12.5) : Fonts.sans(14), .foregroundColor: Look.answerInk])
            return TextBlock(s)
        }
        return say("Open it in the Stage to see it.")
    }
    /// The frame's body height at `width`.
    static func bodyHeight(_ file: MadeFile?, width: CGFloat) -> CGFloat {
        guard let file, !file.missing, file.error == nil else { return 24 + 20 + 24 }
        if let image = file.image, image.size.width > 0 { return min(frameMax, ceil(width * image.size.height / image.size.width)) }
        if let text = file.text, file.type != "html" {
            let s = NSAttributedString(string: text.slice(0, 20000), attributes: [.font: file.type == "md" ? Fonts.sans(14) : Fonts.mono(12.5)])
            return min(frameMax, CardText.height(s, width: width - 36) + 28)
        }
        return 24 + 20 + 24
    }
    static func height(file: MadeFile?, open: Bool, width: CGFloat) -> CGFloat {
        open ? bodyHeight(file, width: width - 32 - 16 - 2) + 1 + 44 + 2 : 48
    }
    override func updateTrackingAreas() {
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area!)
    }
    override func mouseMoved(with event: NSEvent) {}
    override func mouseEntered(with event: NSEvent) {}
    override func mouseExited(with event: NSEvent) { onPeek(false, nameButton) }
    var peekRect: NSRect { NSRect(x: 32, y: rowTop, width: nameButton.frame.maxX - 32, height: 48) }
    private var rowTop: CGFloat { first ? 12 : 2 }

    override func layout() {
        super.layout()
        let x0: CGFloat = 32, x1 = bounds.width - 16
        if open, let body {
            let h = MadeRowView.height(file: file, open: true, width: bounds.width) - 44 - 2 - 1
            frameRect = NSRect(x: x0, y: rowTop, width: x1 - x0, height: h + 1 + 44 + 1)
            body.frame = NSRect(x: x0 + 1, y: rowTop + 1, width: x1 - x0 - 2, height: h)
            if body is TextBlock { body.frame = body.frame.insetBy(dx: 18, dy: 14) }
            let barY = rowTop + 1 + h + 1
            chevron.frame.origin = NSPoint(x: x1 - 8 - 28, y: barY + 8)
            if let stage { stage.frame = NSRect(x: chevron.frame.minX - 8 - stage.wantedWidth, y: barY + 8, width: stage.wantedWidth, height: 28) }
            var right = stage?.frame.minX ?? chevron.frame.minX
            if let save { save.frame = NSRect(x: right - 8 - save.wantedWidth, y: barY + 8, width: save.wantedWidth, height: 28); right = save.frame.minX }
            nameButton.frame = NSRect(x: x0 + 14 + 15 + 8, y: barY + 10, width: max(20, right - 8 - (x0 + 14 + 15 + 8)), height: 22)
            return
        }
        frameRect = nil
        chevron.frame.origin = NSPoint(x: x1 + 6 - 28, y: rowTop + 10)
        var right = chevron.frame.minX - 2
        if let save { save.frame = NSRect(x: right - save.wantedWidth, y: rowTop + 10, width: save.wantedWidth, height: 28); right = save.frame.minX }
        else if file?.saved != nil { right -= savedWidth }
        let nameW = min(name.size(font: Fonts.sans(15.5)) + 6, right - 12 - (x0 + 28))
        nameButton.frame = NSRect(x: x0 + 28, y: rowTop + 13, width: max(20, nameW), height: 22)
    }
    private var frameRect: NSRect?
    private var savedWidth: CGFloat { "Saved".size(font: Fonts.sans(13)) + 14 + 5 + 8 }
    override func draw(_ dirtyRect: NSRect) {
        if let r = frameRect {
            let p = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
            NSColor.white.setFill(); p.fill()
            let barY = r.maxY - 45
            NSGraphicsContext.saveGraphicsState(); p.addClip()
            NSColor(hex: "#fafafa").setFill(); NSRect(x: r.minX, y: barY, width: r.width, height: 45).fill()
            NSColor(hex: "#e3e3e3").setFill(); NSRect(x: r.minX, y: barY, width: r.width, height: 1).fill()
            NSGraphicsContext.restoreGraphicsState()
            NSColor(hex: "#e3e3e3").setStroke(); p.lineWidth = 1; p.stroke()
            let noun = CreateWords.madeNoun(name, text: file?.text)
            Glyphs.image(MadeRowView.glyph(noun), size: 15, color: Look.grey).draw(in: NSRect(x: r.minX + 14, y: barY + 15, width: 15, height: 15))
        } else {
            PhosphorIcons.shapesBold.image(size: 20).tinted(NSColor(hex: "#525252")).draw(in: NSRect(x: 32, y: rowTop + 14, width: 20, height: 20))
        }
        if !open, file?.saved != nil {
            let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(13), .foregroundColor: Look.grey]
            let x = chevron.frame.minX - 2 - savedWidth + 6
            Glyphs.image(Glyphs.check, size: 14, color: Look.grey, width: 2).draw(in: NSRect(x: x, y: rowTop + 17, width: 14, height: 14))
            ("Saved" as NSString).draw(at: NSPoint(x: x + 19, y: rowTop + 16), withAttributes: a)
        }
    }
    override func resetCursorRects() { addCursorRect(nameButton.frame, cursor: .pointingHand) }
    static func glyph(_ noun: String) -> [String] {
        switch noun {
        case "Script": return ["m16 18 6-6-6-6", "m8 6-6 6 6 6"]
        case "Dataset", "Data", "Spreadsheet": return ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 9h18", "M3 15h18", "M9 3v18"]
        case "Image", "Diagram": return ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0z", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"]
        default: return ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"]
        }
    }
    /// Save or Saved, by the file as the window has read it (madeSaveHtml): none while it is still being read.
    var saveLabel: String? { guard let file else { return nil }; return file.saved != nil ? "Saved" : file.saving ? "Saving…" : "Save" }
}

/// A made file's peek (MadePeek): 280 wide, its body 168 tall, "Click to open in the Stage" under it.
final class MadePeekView: FlippedView {
    init(name: String, file: MadeFile?) {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 168 + 28))
        wantsLayer = true
        layer?.cornerRadius = 8; layer?.borderWidth = 1; layer?.borderColor = NSColor(hex: "#c9c9c9").cgColor
        layer?.backgroundColor = NSColor.white.cgColor; layer?.masksToBounds = true
        let body = MadeRowView.bodyView(file, name: name)
        body.frame = body is TextBlock ? NSRect(x: 14, y: 12, width: 252, height: 168 - 24) : NSRect(x: 0, y: 0, width: 280, height: 168)
        addSubview(body)
        let foot = TextBlock(NSAttributedString(string: "Click to open in the Stage", attributes: [.font: Fonts.sans(11.5), .foregroundColor: Look.grey]))
        foot.frame = NSRect(x: 10, y: 168 + 6, width: 260, height: 16)
        addSubview(foot)
        setAccessibilityLabel(name)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(hex: "#fafafa").setFill(); NSRect(x: 0, y: 168, width: bounds.width, height: 28).fill()
        NSColor(hex: "#eaeaea").setFill(); NSRect(x: 0, y: 168, width: bounds.width, height: 1).fill()
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// A Create run at work (createPendingHtml): what it said it is making ("Creating a diagram of …"), then the row: what it
/// is doing, m:ss since it was asked, Stop; an interrupted run's row names it, with Hide.
final class CreatingView: FlippedView {
    let sentence: TextBlock?
    let doing: NSTextField
    let label: NSTextField?
    let clock: NSTextField?
    let button: TextButton
    let at: Date?
    let top: CGFloat
    private var timer: Timer?
    struct Words { var sentence: String?; var label: String; var doing: String; var running: Bool }

    static func words(ask: AskProgress?, request: String) -> Words {
        let writing = ask?.log.reversed().compactMap { Rx(#"^Writing (.+)$"#).match($0)?[1] }.first
        let said = ask?.making ?? ""
        let label = CreateWords.makingLabel(said, request, writing)
        let kind = label == "Create" ? nil : Rx(#"^Creating (?:an? )?"#).replace(label, with: "")
        let doing = ask.map { CreateWords.createDoing($0.activity, kind: kind, wrote: writing != nil || Rx(#"^Writing \S"#).test($0.activity)) } ?? "No answer came back: the run was interrupted."
        let sentence: String? = !said.trimmed.isEmpty ? CreateWords.creatingLine(said) : writing != nil ? "\(label == "Create" ? "Creating" : label)…" : nil
        return Words(sentence: sentence, label: label, doing: doing, running: ask != nil)
    }
    init(_ w: Words, at: Date?, top: CGFloat) {
        self.at = at; self.top = top
        sentence = w.sentence.map { TextBlock(CardText.attr($0, color: Look.answerInk)) }
        doing = NSTextField(labelWithString: w.doing)
        doing.font = Fonts.sans(w.sentence != nil ? 15.5 : 13); doing.textColor = w.sentence != nil ? NSColor(hex: "#525252") : Look.grey
        doing.lineBreakMode = .byTruncatingTail
        label = w.sentence == nil ? { let l = NSTextField(labelWithString: w.label); l.font = Fonts.sans(15.5); l.textColor = Look.answerInk; return l }() : nil
        clock = w.running ? { let c = NSTextField(labelWithString: EditorText.clockOf(at ?? Date())); c.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular); c.textColor = Look.grey; return c }() : nil
        button = TextButton(w.running ? "Stop" : "Hide", size: 13)
        super.init(frame: .zero)
        [sentence, doing, label, clock, button].compactMap { $0 as NSView? }.forEach(addSubview)
    }
    required init?(coder: NSCoder) { fatalError() }
    static func height(_ w: Words, width: CGFloat, top: CGFloat, closes: Bool) -> CGFloat {
        let s = w.sentence.map { CardText.height(CardText.attr($0), width: width - 32 - 16) + 6 } ?? 0
        return top + s + 48 + 10
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate(); timer = nil
        guard window != nil, let clock, let at else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak clock] _ in clock?.stringValue = EditorText.clockOf(at) }
    }
    override func layout() {
        super.layout()
        let x0: CGFloat = 32, x1 = bounds.width - 16
        var y = top
        if let sentence { let h = CardText.height(sentence.text, width: x1 - x0); sentence.frame = NSRect(x: x0, y: y, width: x1 - x0, height: h); y += h + 6 }
        let mid = y + 24
        button.frame.origin = NSPoint(x: x1 - button.frame.width, y: mid - button.frame.height / 2)
        var right = button.frame.minX - 8
        if let clock { clock.sizeToFit(); clock.frame.origin = NSPoint(x: right - clock.frame.width, y: mid - clock.frame.height / 2); right = clock.frame.minX - 8 }
        var x = x0
        if let label { label.sizeToFit(); label.frame.origin = NSPoint(x: x, y: mid - label.frame.height / 2); x = label.frame.maxX + 12 }
        doing.sizeToFit()
        doing.frame = NSRect(x: x, y: mid - doing.frame.height / 2, width: max(10, min(doing.frame.width, right - x)), height: doing.frame.height)
    }
}

/// An @discover guide's bookmark (paperSaveHtml): an outline (none), an outline with + (lib), or filled (here).
final class PaperMarkButton: NSButton {
    static let bookmark = "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
    static let words = ["none": "Save to library and this project", "lib": "Add to this project (already in the library)", "here": "Saved in this project"]
    static let unsaveWords = "Remove from this project (it stays in the library)"
    let mark: String
    let busy: Bool
    var onClick: () -> Void = {}
    private var hover = false
    private var area: NSTrackingArea?
    init(state: String, busy: Bool, canUnsave: Bool, canSave: Bool) {
        self.mark = state; self.busy = busy
        super.init(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        isBordered = false; title = ""; target = self; action = #selector(fire)
        isEnabled = !busy && (state == "here" ? canUnsave : canSave)
        let w = state == "here" && canUnsave ? PaperMarkButton.unsaveWords : PaperMarkButton.words[state] ?? ""
        toolTip = w; setAccessibilityLabel(w)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func fire() { onClick() }
    override var acceptsFirstResponder: Bool { false }
    override func updateTrackingAreas() {
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area!)
    }
    override func mouseEntered(with event: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = false; needsDisplay = true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: isEnabled ? .pointingHand : .arrow) }
    override func draw(_ dirtyRect: NSRect) {
        if hover && isEnabled { NSColor(hex: "#f2f2f2").setFill(); NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
        let color = (mark == "here" || (hover && isEnabled)) ? Look.mid : NSColor(hex: "#c9c9c9")
        let c = busy ? color.withAlphaComponent(0.5) : color
        let r = NSRect(x: 4, y: 4, width: 16, height: 16)
        if mark == "here" { Glyphs.image([PaperMarkButton.bookmark], size: 16, color: c, fill: true).draw(in: r) }
        Glyphs.image([PaperMarkButton.bookmark] + (mark == "lib" ? ["M12 7v6", "M9 10h6"] : []), size: 16, color: c).draw(in: r)
    }
}

/// Send to Discover (sendDiscoverHtml): a small button until opened, then the blue "@discover", a field one line tall
/// that grows as it wraps, and a round send.
final class SendDiscoverView: FlippedView, NSTextViewDelegate {
    let open: Bool
    let button: TextButton?
    let field: ReplyTextView?
    let send: SendButton?
    var onOpen: () -> Void = {}
    var onSend: () -> Void = {}
    var onText: (String) -> Void = { _ in }
    var onKey: (NSEvent) -> Bool = { _ in false }
    static let arrow = ["M7 17 17 7", "M8 7h9v9"]
    init(open: Bool, text: String) {
        self.open = open
        if open {
            let f = ReplyTextView()
            f.isRichText = false; f.drawsBackground = false; f.font = Fonts.sans(16); f.textColor = Look.ink
            f.textContainerInset = .zero; f.textContainer?.lineFragmentPadding = 0
            f.string = text; f.placeholder = "What do you want prior work on?"
            f.setAccessibilityLabel("Send to Discover")
            field = f; send = SendButton(side: 24); button = nil
            send?.ready = !text.trimmed.isEmpty
        } else {
            let b = TextButton("↗ Send to Discover", size: 13)
            button = b; field = nil; send = nil
        }
        super.init(frame: .zero)
        if let field { field.delegate = self; field.keyHook = { [weak self] e in self?.onKey(e) ?? false }; addSubview(field) }
        if let send { send.onClick = { [weak self] in self?.onSend() }; addSubview(send) }
        if let button { button.onClick = { [weak self] in self?.onOpen() }; addSubview(button) }
    }
    required init?(coder: NSCoder) { fatalError() }
    static func height(open: Bool, text: String, width: CGFloat) -> CGFloat {
        guard open else { return 24 + 10 }
        let lead = "@discover".size(font: Fonts.sans(16, weight: 500))
        let w = max(40, width - 12 - lead - 10 - 10 - 24 - 12)
        let h = CardText.height(NSAttributedString(string: text.isEmpty ? "x" : text, attributes: [.font: Fonts.sans(16)]), width: w)
        return max(24, h) + 10
    }
    func textDidChange(_ notification: Notification) {
        guard let field else { return }
        if field.string.contains("\n") { field.string = field.string.replacingOccurrences(of: "\n", with: " ") }
        send?.ready = !field.string.trimmed.isEmpty
        onText(field.string)
    }
    override func layout() {
        super.layout()
        if let button { button.frame.origin = NSPoint(x: 12, y: 0); return }
        let lead = "@discover".size(font: Fonts.sans(16, weight: 500))
        field?.frame = NSRect(x: 12 + lead + 10, y: 0, width: max(40, bounds.width - 12 - lead - 10 - 10 - 24 - 12), height: bounds.height - 10)
        send?.frame.origin = NSPoint(x: bounds.width - 12 - 24, y: 0)
    }
    override func draw(_ dirtyRect: NSRect) {
        guard open else { return }
        ("@discover" as NSString).draw(at: NSPoint(x: 12, y: 0), withAttributes: [.font: Fonts.sans(16, weight: 500), .foregroundColor: Look.blue])
    }
}
