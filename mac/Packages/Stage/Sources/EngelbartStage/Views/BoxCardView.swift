import AppKit
import EngelbartCore
import EngelbartUI

// The card beside a selected box, and a selection's or a highlight's card (src/renderer/box-card/BoxCard.jsx), native: one
// per window, placed by BrowserViews. It looks as the pdf's card does (src/renderer/pdf/card-look.js, 2026-10-17): the
// Caveat note in its ink, the answers' type and inks, room rather than a rule between the note and each answer. The box's
// note is saved as it is typed (300 ms after the last key, and on leaving); Enter in a note that starts with @bart asks
// (Shift+Enter is a new line). A selection's card (2026-10-18, David's picture) is a white card SEL_CARD_W wide with a
// soft shadow, the note in the app's sans; nothing is kept until Save (or ⌘Enter); Cancel or Esc closes it unsaved; a
// highlight's own card has its note and Remove. Keys typed here are the card's: Backspace never removes the box.

enum CardLook {
    static let noteInk = NSColor(hex: "#1f2633")
    static let answerInk = Palette.ink
    static let questionInk = Palette.fnt
    static let errorInk = NSColor(hex: "#c4372d")
    static let placeholderInk = NSColor(hex: "#b5b5b5")
    static let selectionPlaceholder = NSColor(hex: "#9a9a9a")
    static let answerGap: CGFloat = 10
    static let askW: CGFloat = 320
    static let minW: CGFloat = 140
    static let noteRoom: CGFloat = 12 + 2 + 6
    static let answerMax: CGFloat = 320
    static let placeholder = "Write a note or ask @bart"
    static let noteSaveSeconds: TimeInterval = 0.3
    static func noteFont() -> NSFont { Fonts.caveat(24, weight: 500) }
    static func answerFont() -> NSFont { Fonts.sans(15) }

    /// The card's width: ASK_W once it has answers or one is coming, else as wide as the note's longest line and its room.
    static func noteWidth(_ noteW: CGFloat, answered: Bool) -> CGFloat {
        answered ? askW : min(askW, max(minW, noteW.rounded(.up) + noteRoom))
    }

    /// What a note asks Bart (canvas.js noteQuestion): the words after a leading @bart ('' for none yet), or nil.
    static func noteQuestion(_ note: String) -> String? {
        guard let m = SRx(#"^\s*@bart(?=\s|$)([\s\S]*)$"#, "i").match(note) else { return nil }
        return JSStr.trim(m[1] ?? "")
    }
    /// Whether an answer's question is what the note asks now (then it is not shown over the answer).
    static func askedByNote(_ question: String, _ note: String) -> Bool {
        let squash = { (s: String) in JSStr.trim(SRx(#"\s+"#).replace(s, with: " ")) }
        let q = squash(question)
        if q.isEmpty { return true }
        return q == squash(noteQuestion(note) ?? note)
    }
    /// "Bart · Reading …", "Bart · Moving up to Opus high", "Bart · Thinking".
    static func runningLabel(_ run: JSONValue) -> String {
        if let a = run["activity"]?.string, !a.isEmpty { return "Bart · \(a)" }
        if run["movedUp"]?.bool == true, let name = run["name"]?.string, !name.isEmpty {
            return "Bart · Moving up to \([name, run["effort"]?.string ?? ""].filter { !$0.isEmpty }.joined(separator: " "))"
        }
        return "Bart · Thinking"
    }

    /// An answer as the pdf's box draws it: a paragraph a line; bold, italic, code and links; a list's or a heading's mark
    /// taken off (a bullet for an item, bold for a heading). Chat's citation circles are drawn as their links.
    static func answer(_ text: String, ink: NSColor = answerInk) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let para = NSMutableParagraphStyle(); para.lineHeightMultiple = 1.55 / 1.2; para.paragraphSpacing = 6
        let lines = text.components(separatedBy: "\n").map(JSStr.trim).filter { !$0.isEmpty }
        for (i, line) in lines.enumerated() {
            var body = line, bold = false
            if let m = SRx(#"^[-*] (.*)$"#).match(line) { body = "• " + (m[1] ?? "") }
            else if let m = SRx(#"^#{1,6} (.*)$"#).match(line) { body = m[1] ?? ""; bold = true }
            for run in StageMarkdown.runs(body) {
                var font = answerFont()
                if run.bold || bold { font = Fonts.sans(15, weight: 600) }
                if run.italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
                if run.code { font = Fonts.mono(13.2) }
                var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .paragraphStyle: para]
                if let href = run.href, let url = URL(string: href) { attrs[.link] = url; attrs[.foregroundColor] = Palette.acc; attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                out.append(NSAttributedString(string: run.text, attributes: attrs))
            }
            if i < lines.count - 1 { out.append(NSAttributedString(string: "\n", attributes: [.font: answerFont(), .paragraphStyle: para])) }
        }
        return out
    }
}

/// A text view whose Return, ⌘Return and Esc the card decides.
final class CardTextView: NSTextView {
    var onKey: ((NSEvent) -> Bool)?
    var placeholder = ""
    var placeholderColor = CardLook.placeholderInk
    override func keyDown(with event: NSEvent) { if onKey?(event) == true { return }; super.keyDown(with: event) }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty, let font {
            NSAttributedString(string: placeholder, attributes: [.font: font, .foregroundColor: placeholderColor]).draw(at: NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height))
        }
    }
}

final class BoxCardView: NSView, NSTextViewDelegate {
    var onNote: ((String) -> Void)?
    var onSave: ((String) -> Void)?
    var onCancel: (() -> Void)?
    var onAsk: ((String) -> Void)?
    var onStop: ((String) -> Void)?
    var onRemove: (() -> Void)?
    var onSize: ((CGSize) -> Void)?
    var onEscape: (() -> Void)?

    private(set) var mode = "box"
    private let field = CardTextView()
    private let stack = NSStackView()
    private let answers = NSStackView()
    private let card = NSView()
    private let trash = NSButton()
    private let saveButton = NSButton()
    private let cancelButton = NSButton()
    private let removeButton = NSButton()
    private var shownMark: String?
    private var offer: String?
    private var saved = ""
    private var kept = false
    private var unsaved: String?
    private let saver = Debouncer(delay: CardLook.noteSaveSeconds)

    override var isFlipped: Bool { true }

    var hasKeyboard: Bool { window?.firstResponder === field }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        card.wantsLayer = true
        addSubview(card)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        answers.orientation = .vertical
        answers.alignment = .leading
        answers.spacing = CardLook.answerGap
        card.addSubview(stack)
        field.delegate = self
        field.drawsBackground = false
        field.isRichText = false
        field.isVerticallyResizable = true
        field.textContainerInset = NSSize(width: 0, height: 0)
        field.textContainer?.widthTracksTextView = true
        field.placeholder = CardLook.placeholder
        field.onKey = { [weak self] event in self?.key(event) ?? false }
        trash.image = NSImage(systemSymbolName: "trash", accessibilityDescription: "Remove box")
        trash.isBordered = false
        trash.contentTintColor = Palette.fnt
        trash.toolTip = "Remove box"
        trash.target = self; trash.action = #selector(remove)
        for (button, title) in [(saveButton, "Save"), (cancelButton, "Cancel"), (removeButton, "Remove")] {
            button.title = title; button.isBordered = false; button.target = self
        }
        saveButton.action = #selector(save); cancelButton.action = #selector(cancel); removeButton.action = #selector(remove)
        saveButton.toolTip = "Save (⌘↩)"
        saveButton.wantsLayer = true
        saveButton.layer?.backgroundColor = Palette.acc.cgColor
        saveButton.layer?.cornerRadius = 15
        saveButton.attributedTitle = NSAttributedString(string: "Save", attributes: [.font: Fonts.sans(14, weight: 500), .foregroundColor: NSColor.white])
        cancelButton.attributedTitle = NSAttributedString(string: "Cancel", attributes: [.font: Fonts.sans(14), .foregroundColor: NSColor(hex: "#6b6b6b")])
        removeButton.attributedTitle = NSAttributedString(string: "Remove", attributes: [.font: Fonts.sans(13), .foregroundColor: Palette.fnt])
        prepare(mode: "box")
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The card for a box or for a selection: its look.
    func prepare(mode: String) {
        flush()
        self.mode = mode
        shownMark = nil; offer = nil; saved = ""; kept = false
        field.string = ""
        if mode == "selection" {
            field.font = Fonts.sans(15)
            field.textColor = CardLook.noteInk
            field.placeholderColor = CardLook.selectionPlaceholder
            card.layer?.backgroundColor = NSColor.white.cgColor
            card.layer?.cornerRadius = 12
            card.layer?.borderWidth = 1
            card.layer?.borderColor = NSColor(hex: "#ececec").cgColor
            card.shadow = { let s = NSShadow(); s.shadowColor = NSColor(white: 0, alpha: 0.12); s.shadowBlurRadius = 24; s.shadowOffset = NSSize(width: 0, height: -6); return s }()
        } else {
            field.font = CardLook.noteFont()
            field.textColor = CardLook.noteInk
            field.placeholderColor = CardLook.placeholderInk
            card.layer?.backgroundColor = NSColor.white.cgColor // the card's ground over a page (CARD_GROUND), nothing else
            card.layer?.cornerRadius = 0
            card.layer?.borderWidth = 0
            card.shadow = nil
        }
        rebuild(mark: nil, running: [])
    }

    /// Main's state: { mode, offer, mark: { id, note, asks }, running, typed? }.
    func apply(_ state: JSONValue) {
        let mark = state["mark"].flatMap { $0.object != nil ? $0 : nil }
        if mode == "selection" {
            let token = state["offer"]?.string
            if token != offer {
                offer = token
                saved = mark?["note"]?.string ?? ""
                field.string = saved
                kept = mark != nil
                focusField()
            } else if let mark {
                let dirty = field.string != saved
                saved = mark["note"]?.string ?? ""
                kept = true
                if !dirty { field.string = saved }
            }
            if let typed = state["typed"]?.string { field.string += typed; focusField(); layoutCard(); return }
        } else if let mark {
            let id = mark["id"]?.string
            if id != shownMark { flush(); shownMark = id; field.string = mark["note"]?.string ?? "" }
            else if !hasKeyboard && unsaved == nil { field.string = mark["note"]?.string ?? "" }
            if state["typed"] != nil { focusField() }
        }
        tintBart()
        rebuild(mark: mark, running: state["running"]?.array ?? [])
    }

    private func focusField() {
        window?.makeFirstResponder(field)
        field.setSelectedRange(NSRange(location: (field.string as NSString).length, length: 0))
    }

    /// A leading @bart drawn in the document's blue.
    private func tintBart() {
        guard let storage = field.textStorage else { return }
        let all = NSRange(location: 0, length: storage.length)
        storage.addAttribute(.foregroundColor, value: CardLook.noteInk, range: all)
        if let m = SRx(#"^\s*@bart(?=\s|$)"#, "i").match(field.string) { storage.addAttribute(.foregroundColor, value: Palette.acc, range: m.range) }
    }

    private var asks: [JSONValue] = []
    private var running: [JSONValue] = []

    private func rebuild(mark: JSONValue?, running: [JSONValue]) {
        asks = mark?["asks"]?.array ?? []
        self.running = running
        for v in answers.arrangedSubviews { answers.removeArrangedSubview(v); v.removeFromSuperview() }
        let note = field.string
        for ask in asks { answers.addArrangedSubview(answerView(question: ask["question"]?.string ?? "", body: ask["answer"]?.string ?? "", note: note, running: nil)) }
        for run in running { answers.addArrangedSubview(answerView(question: run["question"]?.string ?? "", body: (run["lines"]?.array ?? []).compactMap(\.string).joined(separator: "\n"), note: note, running: run)) }
        layoutCard()
    }

    private func label(_ text: String, font: NSFont, color: NSColor, lines: Int = 1) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = font; l.textColor = color; l.maximumNumberOfLines = lines; l.lineBreakMode = .byTruncatingTail
        return l
    }

    private func answerView(question: String, body: String, note: String, running: JSONValue?) -> NSView {
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 4
        if let running {
            let failed = running["error"] != nil && running["error"] != .null
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 8
            row.addArrangedSubview(label(failed ? "Bart · No answer" : CardLook.runningLabel(running), font: Fonts.sans(15, weight: failed ? 500 : 400), color: failed ? CardLook.answerInk : CardLook.questionInk))
            let stop = NSButton(title: failed ? "×" : "Stop", target: self, action: #selector(stopRun(_:)))
            stop.isBordered = false; stop.identifier = NSUserInterfaceItemIdentifier(running["askId"]?.string ?? "")
            stop.attributedTitle = NSAttributedString(string: failed ? "×" : "Stop", attributes: [.font: Fonts.sans(13), .foregroundColor: Palette.fnt])
            row.addArrangedSubview(stop)
            box.addArrangedSubview(row)
            if !CardLook.askedByNote(question, note) { box.addArrangedSubview(label(question, font: CardLook.answerFont(), color: CardLook.questionInk)) }
            if failed { box.addArrangedSubview(label(running["error"]?.string ?? "The run failed.", font: CardLook.answerFont(), color: CardLook.errorInk, lines: 0)) }
            if !failed, running["activity"]?.string == "Writing", !body.isEmpty { box.addArrangedSubview(textBody(CardLook.answer(body, ink: CardLook.questionInk))) }
            return box
        }
        if !CardLook.askedByNote(question, note) { box.addArrangedSubview(label(question, font: CardLook.answerFont(), color: CardLook.questionInk)) }
        box.addArrangedSubview(textBody(CardLook.answer(body)))
        return box
    }

    private func textBody(_ text: NSAttributedString) -> NSView {
        let view = NSTextView()
        view.isEditable = false; view.isSelectable = true; view.drawsBackground = false
        view.textStorage?.setAttributedString(text)
        view.textContainerInset = NSSize(width: 6, height: 0)
        let width = contentWidth()
        view.frame = NSRect(x: 0, y: 0, width: width, height: 10)
        view.textContainer?.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        view.layoutManager?.ensureLayout(for: view.textContainer!)
        let height = min(CardLook.answerMax, (view.layoutManager?.usedRect(for: view.textContainer!).height ?? 20) + 2)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        scroll.drawsBackground = false; scroll.hasVerticalScroller = height >= CardLook.answerMax; scroll.documentView = view
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.widthAnchor.constraint(equalToConstant: width).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: height).isActive = true
        return scroll
    }

    private func contentWidth() -> CGFloat {
        mode == "selection" ? SelectionCardPlace.cardWidth - 36 : CardLook.noteWidth(noteWidthNow(), answered: !asks.isEmpty || !running.isEmpty) - 12
    }

    private func noteWidthNow() -> CGFloat {
        let text = field.string.isEmpty ? CardLook.placeholder : field.string
        return text.components(separatedBy: "\n").map { NSAttributedString(string: $0, attributes: [.font: CardLook.noteFont()]).size().width }.max() ?? 0
    }

    /// Lays the card out and tells main its size (the view's own, shadow room included).
    func layoutCard() {
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        if mode == "selection" {
            let shade = SelectionCardPlace.shade
            let w = SelectionCardPlace.cardWidth
            let inner = w - 36
            let fieldHeight = fit(width: inner)
            field.frame = NSRect(x: 0, y: 0, width: inner, height: fieldHeight)
            stack.addArrangedSubview(field)
            if !asks.isEmpty || !running.isEmpty { stack.addArrangedSubview(answers) }
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 14
            if kept { row.addArrangedSubview(removeButton) }
            let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal); row.addArrangedSubview(spacer)
            row.addArrangedSubview(cancelButton); row.addArrangedSubview(saveButton)
            saveButton.isEnabled = canSave
            saveButton.alphaValue = canSave ? 1 : 0.4
            row.translatesAutoresizingMaskIntoConstraints = false
            row.widthAnchor.constraint(equalToConstant: inner).isActive = true
            stack.addArrangedSubview(row)
            stack.setCustomSpacing(14, after: stack.arrangedSubviews[stack.arrangedSubviews.count - 2])
            stack.frame = NSRect(x: 18, y: 16, width: inner, height: 10)
            stack.layoutSubtreeIfNeeded()
            let height = stack.fittingSize.height + 16 + 14
            card.frame = NSRect(x: shade.side, y: shade.top, width: w, height: height)
            stack.frame = NSRect(x: 18, y: 16, width: inner, height: stack.fittingSize.height)
            onSize?(CGSize(width: w + 2 * shade.side, height: height + shade.top + shade.bottom))
        } else {
            let width = CardLook.noteWidth(noteWidthNow(), answered: !asks.isEmpty || !running.isEmpty)
            trash.frame = NSRect(x: width - 21, y: 1, width: 18, height: 18)
            if trash.superview !== card { card.addSubview(trash) }
            let fieldHeight = fit(width: width - 12)
            field.frame = NSRect(x: 0, y: 0, width: width - 12, height: fieldHeight)
            stack.addArrangedSubview(field)
            if !asks.isEmpty || !running.isEmpty { stack.setCustomSpacing(CardLook.answerGap + 4, after: field); stack.addArrangedSubview(answers) }
            stack.frame = NSRect(x: 6, y: 12, width: width - 12, height: 10)
            stack.layoutSubtreeIfNeeded()
            let height = 12 + stack.fittingSize.height + 4
            stack.frame = NSRect(x: 6, y: 12, width: width - 12, height: stack.fittingSize.height)
            card.frame = NSRect(x: 8, y: 8, width: width, height: height)
            onSize?(CGSize(width: width + 16, height: height + 16))
        }
    }

    /// The field as tall as its lines at the width it has now.
    private func fit(width: CGFloat) -> CGFloat {
        field.textContainer?.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        guard let manager = field.layoutManager, let container = field.textContainer else { return 24 }
        manager.ensureLayout(for: container)
        let lineHeight = (field.font?.pointSize ?? 15) * (mode == "selection" ? 1.5 : 1.2)
        let used = manager.usedRect(for: container).height
        let field = self.field
        let constraint = field.constraints.first { $0.firstAttribute == .height } ?? { let c = field.heightAnchor.constraint(equalToConstant: 0); c.isActive = true; return c }()
        let height = max(lineHeight, used.rounded(.up))
        constraint.constant = height
        let widthConstraint = field.constraints.first { $0.firstAttribute == .width } ?? { let c = field.widthAnchor.constraint(equalToConstant: 0); c.isActive = true; return c }()
        widthConstraint.constant = width
        return height
    }

    private var canSave: Bool { !JSStr.trim(field.string).isEmpty || (kept && !JSStr.trim(saved).isEmpty) }

    func textDidChange(_ notification: Notification) {
        tintBart()
        if mode == "box" {
            unsaved = field.string
            saver.call { [weak self] in self?.flush() }
        }
        layoutCard()
    }

    func textDidEndEditing(_ notification: Notification) { flush() }

    /// The note typed so far, saved now.
    func flush() {
        saver.cancel()
        if let text = unsaved { unsaved = nil; onNote?(text) }
    }

    private func key(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 53 { flush(); onEscape?(); return true }
        let enter = event.keyCode == 36 || event.keyCode == 76
        guard enter, !field.hasMarkedText() else { return false }
        if mode == "selection" {
            if flags.contains(.command) || flags.contains(.control) { save(); return true }
            return false // Enter is a new line
        }
        if flags.contains(.shift) { return false }
        guard let question = CardLook.noteQuestion(field.string) else { return false }
        if question.isEmpty { return true }
        flush()
        onAsk?(question)
        return true
    }

    @objc private func save() { guard canSave else { return }; saved = field.string; onSave?(field.string) }
    @objc private func cancel() { onCancel?() }
    @objc private func remove() { onRemove?() }
    @objc private func stopRun(_ sender: NSButton) { onStop?(sender.identifier?.rawValue ?? "") }
}
