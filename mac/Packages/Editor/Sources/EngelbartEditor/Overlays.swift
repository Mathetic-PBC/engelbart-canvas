import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartUI

// The controls DocEditor drew as HTML inside the text (CARD_CSS): an answer's foot, a question's chip and send, the
// Collapse corner, a run's row, a collapsed conversation's row, a folded turn's row, a reply field, a code block's Copy.
// They are views over the text view, placed on their line's rect after each layout.

/// An icon button (.bart-ic): 28×28, radius 6, #4d4d4d; hovered #f2f2f2 and ink (Delete red); its name under it.
final class IconButton: NSButton {
    var paths: [String]
    var danger = false
    var size: CGFloat = 16
    var color = Look.mid
    private var hover = false
    private var area: NSTrackingArea?
    var onClick: () -> Void = {}
    init(_ paths: [String], tip: String, size: CGFloat = 16, box: CGFloat = 28) {
        self.paths = paths; self.size = size
        super.init(frame: NSRect(x: 0, y: 0, width: box, height: box))
        isBordered = false; title = ""; toolTip = tip; setAccessibilityLabel(tip)
        target = self; action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func fire() { onClick() }
    override var acceptsFirstResponder: Bool { false }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area!)
    }
    override func mouseEntered(with event: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = false; needsDisplay = true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: isEnabled ? .pointingHand : .arrow) }
    override func draw(_ dirtyRect: NSRect) {
        if hover && isEnabled { NSColor(hex: "#f2f2f2").setFill(); NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
        let c = !isEnabled ? color.withAlphaComponent(0.4) : hover ? (danger ? Palette.del : Look.ink) : color
        let img = Glyphs.image(paths, size: size, color: c)
        img.draw(in: NSRect(x: (bounds.width - size) / 2, y: (bounds.height - size) / 2, width: size, height: size))
    }
}

/// A text button (.bart-text): 12px/500 grey, ink on hover.
final class TextButton: NSButton {
    var onClick: () -> Void = {}
    var color = Look.grey
    private var hover = false
    private var area: NSTrackingArea?
    init(_ label: String, size: CGFloat = 12, weight: Int = 500, color: NSColor = Look.grey) {
        self.color = color
        super.init(frame: .zero)
        isBordered = false
        self.font = Fonts.sans(size, weight: weight)
        title = label
        target = self; action = #selector(fire)
        sizeToFit(); frame.size.width += 4
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func fire() { onClick() }
    override var acceptsFirstResponder: Bool { false }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area!)
    }
    override func mouseEntered(with event: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = false; needsDisplay = true }
    override func draw(_ dirtyRect: NSRect) {
        let a: [NSAttributedString.Key: Any] = [.font: font ?? Fonts.sans(12), .foregroundColor: hover ? Look.ink : color]
        let s = (title as NSString).size(withAttributes: a)
        (title as NSString).draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2), withAttributes: a)
    }
}

/// A round send (boxSend): 28px, blue with a white arrow once there is something to send, grey until then.
final class SendButton: NSButton {
    var ready = false { didSet { needsDisplay = true } }
    var onClick: () -> Void = {}
    var side: CGFloat
    init(side: CGFloat = 28) {
        self.side = side
        super.init(frame: NSRect(x: 0, y: 0, width: side, height: side))
        isBordered = false; title = ""; toolTip = "Send"; setAccessibilityLabel("Send")
        target = self; action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func fire() { if ready { onClick() } }
    override var acceptsFirstResponder: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        (ready ? Look.blue : NSColor(hex: "#ececec")).setFill()
        NSBezierPath(ovalIn: bounds).fill()
        let s: CGFloat = side * 0.5
        Glyphs.image(Glyphs.send, size: s, color: ready ? .white : NSColor(hex: "#a3a3a3"), width: 2.2).draw(in: NSRect(x: (bounds.width - s) / 2, y: (bounds.height - s) / 2, width: s, height: s))
    }
}

/// A flipped container so frames read top-down, as the CSS laid them out.
class FlippedView: NSView { override var isFlipped: Bool { true } }

/// An answer's foot (footHtml): Copy and Regenerate on the left, Delete on the right; "Copied" for 1.4 s.
final class FootView: FlippedView {
    let copy = IconButton(Glyphs.copy, tip: "Copy")
    let regen = IconButton(Glyphs.regenerate, tip: "Regenerate")
    let delete = IconButton(Glyphs.trash, tip: "Delete")
    init(busy: Bool) {
        super.init(frame: .zero)
        delete.danger = true
        regen.isEnabled = !busy
        regen.toolTip = busy ? "Regenerate once it answers" : "Regenerate"
        [copy, regen, delete].forEach(addSubview)
    }
    required init?(coder: NSCoder) { fatalError() }
    func copied() {
        copy.toolTip = "Copied"; copy.color = Look.grey; copy.needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in self?.copy.toolTip = "Copy"; self?.copy.color = Look.mid; self?.copy.needsDisplay = true }
    }
    /// Words after Copy and Regenerate: a live card's Skip and Wrap up, a guide's Save all (n).
    var extras: [TextButton] = []
    func add(_ b: TextButton) { extras.append(b); addSubview(b) }
    override func layout() {
        super.layout()
        copy.frame.origin = NSPoint(x: 10, y: 12)
        regen.frame.origin = NSPoint(x: 40, y: 12)
        var x: CGFloat = 70 + 6
        for b in extras { b.frame.origin = NSPoint(x: x, y: 12 + (28 - b.frame.height) / 2); x += b.frame.width + 6 }
        delete.frame.origin = NSPoint(x: bounds.width - 38, y: 12)
    }
}

/// An unasked question's chip and send (lineHtml's `chip`): the model and effort as plain words with a chevron, then the
/// round send; hovering the words opens the selector.
final class ChipView: FlippedView {
    let send = SendButton()
    let label: String?
    var onPick: (NSView) -> Void = { _ in }
    var open = false
    private var area: NSTrackingArea?
    init(label: String?, ready: Bool) {
        self.label = label
        super.init(frame: .zero)
        send.ready = ready
        addSubview(send)
    }
    required init?(coder: NSCoder) { fatalError() }
    var labelWidth: CGFloat { label.map { ($0 as NSString).size(withAttributes: [.font: Fonts.sans(13)]).width + 20 } ?? 0 }
    var wanted: CGSize { CGSize(width: labelWidth + (label == nil ? 0 : 10) + 28, height: 28) }
    override func layout() { super.layout(); send.frame.origin = NSPoint(x: bounds.width - 28, y: 0) }
    override func draw(_ dirtyRect: NSRect) {
        guard let label else { return }
        let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(13), .foregroundColor: Look.mid]
        let s = (label as NSString).size(withAttributes: a)
        (label as NSString).draw(at: NSPoint(x: 0, y: (28 - s.height) / 2), withAttributes: a)
        Glyphs.image(open ? Glyphs.chevronUp : Glyphs.chevronDown, size: 12, color: Look.grey, width: 2).draw(in: NSRect(x: s.width + 4, y: 8, width: 12, height: 12))
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: NSRect(x: 0, y: 0, width: labelWidth, height: 28), options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self)
        addTrackingArea(area!)
    }
    override func mouseEntered(with event: NSEvent) { if label != nil { onPick(self) } }
    override func mouseDown(with event: NSEvent) { if label != nil && convert(event.locationInWindow, from: nil).x < labelWidth { onPick(self) } }
}

/// A run at work (lineHtml's pending row): its answer so far in a box that follows the newest line, what it is doing
/// (a wave through the words), its steps behind a count, and Stop (or Hide when no run answers to it).
final class PendingView: FlippedView {
    let stream = NSScrollView()
    let streamText = NSTextView()
    var label: NSHostingView<AnyView>
    let stop: TextButton
    var steps: TextButton? = nil
    var logText: NSTextField? = nil
    var follow = true
    var heldTop: CGFloat? = nil
    /// The box scrolled: its top, and how far it is from its bottom.
    var onScrolled: (CGFloat, CGFloat) -> Void = { _, _ in }
    @objc func streamMoved() {
        let top = stream.contentView.bounds.minY, h = stream.documentView?.frame.height ?? 0
        onScrolled(top, h - stream.contentSize.height - top)
    }
    init(progress: AskProgress?, waitLeft: Int?, logOpen: Bool) {
        let doing: String
        if let w = waitLeft { doing = "Searching in \(w) s" }
        else if let p = progress {
            let act = p.agent == "create" ? Rx(#" · \d+ KB$"#).replace(p.activity, with: "") : p.activity
            doing = (act.isEmpty ? (p.movedUp ? "Thinking harder" : "Thinking") : act) + (p.name.isEmpty ? "" : " · \(p.name) \(p.effort)")
        } else { doing = "No answer came back: the run was interrupted." }
        label = NSHostingView(rootView: progress != nil || waitLeft != nil ? AnyView(WaveText(doing, font: Fonts.swiftUISans(13))) : AnyView(Text(doing).font(Fonts.swiftUISans(13)).foregroundColor(Color(Look.grey))))
        stop = TextButton(waitLeft != nil ? "Cancel" : progress != nil ? "Stop" : "Hide")
        super.init(frame: .zero)
        if let p = progress, !p.log.isEmpty {
            let b = TextButton("\(p.log.count) \(p.log.count == 1 ? "step" : "steps") \(logOpen ? "⌃" : "⌄")", weight: 400)
            steps = b; addSubview(b)
            if logOpen {
                let t = NSTextField(wrappingLabelWithString: p.log.joined(separator: "\n"))
                t.font = Fonts.sans(12); t.textColor = Look.grey
                logText = t; addSubview(t)
            }
        }
        let shown = PendingView.streamed(progress)
        if !shown.string.isEmpty {
            streamText.isEditable = false; streamText.drawsBackground = false
            streamText.textStorage?.setAttributedString(shown)
            streamText.textContainerInset = .zero
            stream.documentView = streamText
            stream.drawsBackground = false; stream.hasVerticalScroller = true; stream.autohidesScrollers = true
            addSubview(stream)
        }
        addSubview(label); addSubview(stop)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The answer so far: grey, 14px, its citations and a link still being written left out; a card's JSON never shown;
    /// Brainstorm's topic tag and Discover's research line left out.
    static func streamed(_ p: AskProgress?) -> NSAttributedString {
        guard let p else { return NSAttributedString() }
        var told = p.lines
        if p.agent == "brainstorm" { told = told.filter { !Rx(#"^\s*<(?:t(?:o(?:p(?:i(?:c(?:>.*)?)?)?)?)?)?\s*$"#).test($0) } }
        if p.agent == "discover" { told = told.filter { !Rx(#"^\s*<(?:r(?:e(?:s(?:e(?:a(?:r(?:c(?:h(?:>.*)?)?)?)?)?)?)?)?)?\s*$"#).test($0) } }
        if (p.agent == "discover" || p.agent == "brainstorm") && Rx(#"^\s*(\{|```)"#).test(told.joined(separator: "\n")) { told = [] }
        let out = NSMutableAttributedString()
        let blocks = Doc.codeBlocks(told)
        var role: [Int: String] = [:]
        for b in blocks { role[b.open] = "fence"; role[b.close] = "fence"; if b.open + 1 < b.close { for k in (b.open + 1)..<b.close { role[k] = "code" } } }
        for (n, t) in told.enumerated() {
            if role[n] == "fence" { continue }
            let text = role[n] == "code" ? t : Cite.streamingText(t)
            out.append(NSAttributedString(string: (out.length > 0 ? "\n" : "") + text, attributes: [.font: role[n] == "code" ? Fonts.mono(13) : Fonts.sans(14), .foregroundColor: Look.grey]))
        }
        return out
    }

    func wantedHeight(width: CGFloat, cap: CGFloat) -> CGFloat {
        var h: CGFloat = 12
        if stream.superview != nil {
            streamText.textContainer?.containerSize = NSSize(width: width - 32, height: .greatestFiniteMagnitude)
            streamText.layoutManager?.ensureLayout(for: streamText.textContainer!)
            let used = streamText.layoutManager?.usedRect(for: streamText.textContainer!).height ?? 0
            h += min(cap, used) + 10
        }
        if let logText { logText.preferredMaxLayoutWidth = width - 48; h += logText.intrinsicContentSize.height + 8 }
        return h + 20 + 12
    }
    override func layout() {
        super.layout()
        var y: CGFloat = 12
        if stream.superview != nil {
            let cap = bounds.height - 12 - 20 - 12 - (logText.map { $0.intrinsicContentSize.height + 8 } ?? 0) - 10
            stream.frame = NSRect(x: 16, y: y, width: bounds.width - 32, height: max(0, cap))
            streamText.frame.size.width = stream.contentSize.width
            if follow { streamText.scrollToEndOfDocument(nil) } else if let t = heldTop { stream.contentView.scroll(to: NSPoint(x: 0, y: t)) }
            if stream.contentView.postsBoundsChangedNotifications == false {
                stream.contentView.postsBoundsChangedNotifications = true
                NotificationCenter.default.addObserver(self, selector: #selector(streamMoved), name: NSView.boundsDidChangeNotification, object: stream.contentView)
            }
            y += max(0, cap) + 10
        }
        if let logText { logText.frame = NSRect(x: 32, y: y, width: bounds.width - 48, height: logText.intrinsicContentSize.height); y += logText.frame.height + 8 }
        let stopW = stop.frame.width
        stop.frame = NSRect(x: bounds.width - 16 - stopW, y: y, width: stopW, height: 20)
        var right = stop.frame.minX - 10
        if let steps { steps.frame = NSRect(x: right - steps.frame.width, y: y, width: steps.frame.width, height: 20); right = steps.frame.minX - 10 }
        label.frame = NSRect(x: 16, y: y, width: max(0, right - 16), height: 20)
    }
}

/// A collapsed conversation's row (titleHtml): the Agents pointer and the title in the link's blue at 15px, when it was
/// asked on the right; at work, grey and no time. A click expands it; an ⌥-click renames it in place.
final class TitleRowView: FlippedView {
    let title: String, when: String, running: Bool
    var onExpand: () -> Void = {}
    var onRename: (String) -> Void = { _ in }
    var field: NSTextField?
    private var hover = false
    private var area: NSTrackingArea?
    init(title: String, when: String, running: Bool) {
        self.title = title; self.when = when; self.running = running
        super.init(frame: .zero)
        toolTip = "⌥-click to rename"
        setAccessibilityRole(.button); setAccessibilityLabel("Expand \(title)")
    }
    required init?(coder: NSCoder) { fatalError() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area!)
    }
    override func mouseEntered(with event: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = false; needsDisplay = true }
    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.option) { startRename(); return }
        onExpand()
    }
    func startRename() {
        let f = NSTextField(string: title)
        f.isBordered = false; f.drawsBackground = false; f.focusRingType = .none
        f.font = Fonts.sans(15); f.textColor = Look.ink
        f.frame = NSRect(x: 31, y: 11, width: bounds.width - 40, height: 20)
        f.target = self; f.action = #selector(commit)
        addSubview(f); field = f
        window?.makeFirstResponder(f)
        f.currentEditor()?.selectAll(nil)
    }
    @objc func commit() { if let f = field { onRename(f.stringValue) } }
    override func cancelOperation(_ sender: Any?) { field?.removeFromSuperview(); field = nil }
    override func draw(_ dirtyRect: NSRect) {
        guard field == nil else { return }
        let color = running ? Look.grey : Look.blue
        Glyphs.image(Glyphs.pointer, size: 15, color: color, width: 1.75).draw(in: NSRect(x: 0, y: 13.5, width: 15, height: 15))
        var a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(15), .foregroundColor: running ? Look.grey : Look.blue]
        if hover && !running { a[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        let whenA: [NSAttributedString.Key: Any] = [.font: Fonts.sans(12), .foregroundColor: Look.grey]
        let whenW = !running && !when.isEmpty ? (when as NSString).size(withAttributes: whenA).width : 0
        let maxW = bounds.width - 23 - whenW - 12
        let t = NSAttributedString(string: title, attributes: a)
        t.draw(with: NSRect(x: 23, y: 11, width: maxW, height: 21), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        if whenW > 0 { (when as NSString).draw(at: NSPoint(x: bounds.width - whenW, y: 14), withAttributes: whenA) }
    }
}

/// A turn folded to one row (foldedHtml): a chevron, its question on one line cut with an ellipsis, grey 14px; a click expands it.
final class FoldedRowView: FlippedView {
    let shown: String, top: Bool
    var onExpand: () -> Void = {}
    init(shown: String, top: Bool) { self.shown = shown; self.top = top; super.init(frame: .zero); setAccessibilityLabel("Expand") }
    required init?(coder: NSCoder) { fatalError() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseDown(with event: NSEvent) { onExpand() }
    override func draw(_ dirtyRect: NSRect) {
        let y: CGFloat = top ? 14 : 0
        Glyphs.image(Glyphs.chevronRight, size: 14, color: NSColor(hex: "#a3a3a3"), width: 1.75).draw(in: NSRect(x: 16, y: y + 3.5, width: 14, height: 14))
        NSAttributedString(string: shown, attributes: [.font: Fonts.sans(14), .foregroundColor: NSColor(hex: "#7a7a7a")])
            .draw(with: NSRect(x: 36, y: y, width: bounds.width - 52, height: 21), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

/// A research box's head and status (researchHtml, boxStatusHtml): "Research · <level>", the state in words and its one action.
final class ResearchView: FlippedView {
    let state: String, level: String
    let action: TextButton?
    init(state: String, level: String, canAct: Bool) {
        self.state = state; self.level = level
        action = !canAct || state == "running" ? nil : TextButton(state == "ready" ? "Start research" : state == "finished" ? "Run again" : "Restart", size: 12.5, color: state == "finished" ? Look.mid : Look.blue)
        super.init(frame: .zero)
        if let action { addSubview(action) }
    }
    required init?(coder: NSCoder) { fatalError() }
    static func said(_ state: String) -> String {
        ["ready": "Not started", "stopped": "Stopped", "interrupted": "Interrupted: the app closed before it finished", "failed": "Interrupted: the run failed", "finished": "Finished", "running": ""][state] ?? state
    }
    override func layout() { super.layout(); if let a = action { a.frame = NSRect(x: bounds.width - 30 - a.frame.width, y: 44, width: a.frame.width, height: 26) } }
    override func draw(_ dirtyRect: NSRect) {
        let box = NSRect(x: 16, y: 10, width: bounds.width - 32, height: bounds.height - 20)
        let path = NSBezierPath(roundedRect: box, xRadius: 10, yRadius: 10)
        NSColor.white.setFill(); path.fill(); NSColor(hex: "#ebebeb").setStroke(); path.lineWidth = 1; path.stroke()
        Glyphs.image(Glyphs.search, size: 14, color: Look.grey, width: 2).draw(in: NSRect(x: 30, y: 21, width: 14, height: 14))
        let head = NSMutableAttributedString(string: "Research", attributes: [.font: Fonts.sans(13, weight: 500), .foregroundColor: Look.mid])
        if !level.isEmpty { head.append(NSAttributedString(string: " · \(level)", attributes: [.font: Fonts.sans(13), .foregroundColor: Look.grey])) }
        head.draw(at: NSPoint(x: 52, y: 18))
        let status = ResearchView.said(state)
        if !status.isEmpty { (status as NSString).draw(at: NSPoint(x: 30, y: 48), withAttributes: [.font: Fonts.sans(13), .foregroundColor: Look.grey]) }
    }
}

/// The reply field under a conversation's last turn (followHtml/fieldBox): the blue lead, a field one line tall that grows
/// as it wraps, and the round send bottom-right. What is typed lives in the editor (followText), never in the document.
final class ReplyFieldView: FlippedView, NSTextViewDelegate {
    let lead: String
    var from = -1
    let field = ReplyTextView()
    let send = SendButton()
    var onSend: () -> Void = {}
    var onText: (String) -> Void = { _ in }
    var onHeight: (CGFloat) -> Void = { _ in }
    var onKey: (NSEvent) -> Bool = { _ in false }
    init(lead: String, text: String) {
        self.lead = lead
        super.init(frame: .zero)
        field.isRichText = false; field.drawsBackground = false; field.font = Fonts.sans(16); field.textColor = Look.ink
        field.textContainerInset = .zero; field.textContainer?.lineFragmentPadding = 0
        field.isVerticallyResizable = true; field.isHorizontallyResizable = false
        field.string = text; field.delegate = self
        field.placeholder = "Respond…"
        field.keyHook = { [weak self] e in self?.onKey(e) ?? false }
        send.ready = !text.trimmed.isEmpty
        send.onClick = { [weak self] in self?.onSend() }
        addSubview(field); addSubview(send)
    }
    required init?(coder: NSCoder) { fatalError() }
    static func height(for text: String, width: CGFloat) -> CGFloat {
        let w = max(40, width - 16 - 10 - 52 - 8 - 36)
        let h = (text.isEmpty ? "x" : text as NSString).boundingRect(with: NSSize(width: w, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, attributes: [.font: Fonts.sans(16)]).height
        return max(24, ceil(h)) + 4 + 10 + 4
    }
    func textDidChange(_ notification: Notification) {
        // One line of the document: a pasted line break becomes a space.
        if field.string.contains("\n") || field.string.contains("\r") {
            let sel = field.selectedRange()
            field.string = field.string.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
            field.setSelectedRange(sel)
        }
        send.ready = !field.string.trimmed.isEmpty
        onText(field.string)
        onHeight(ReplyFieldView.height(for: field.string, width: bounds.width))
    }
    override func layout() {
        super.layout()
        let leadW = (lead as NSString).size(withAttributes: [.font: Fonts.sans(16, weight: 500)]).width
        field.frame = NSRect(x: 16 + leadW + 8, y: 6, width: max(40, bounds.width - 16 - leadW - 8 - 10 - 36), height: bounds.height - 6 - 14)
        send.frame.origin = NSPoint(x: bounds.width - 10 - 28, y: bounds.height - 10 - 28)
    }
    override func draw(_ dirtyRect: NSRect) {
        (lead as NSString).draw(at: NSPoint(x: 16, y: 6), withAttributes: [.font: Fonts.sans(16, weight: 500), .foregroundColor: Look.blue])
    }
}

/// The reply field's text view: Enter sends, Shift+Enter adds nothing, Escape leaves it; the @ menu's keys come first.
final class ReplyTextView: NSTextView {
    var placeholder = ""
    var keyHook: (NSEvent) -> Bool = { _ in false }
    override func keyDown(with event: NSEvent) { if keyHook(event) { return }; super.keyDown(with: event) }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty { (placeholder as NSString).draw(at: .zero, withAttributes: [.font: Fonts.sans(14.5), .foregroundColor: Look.grey]) }
    }
}

/// An answer's Show more / Show less (moreHtml, applyClips): inside its rule, 13px/500 #4d4d4d with a chevron; cut, a
/// 56px fade from the card's grey over the last rows shown.
final class MoreView: FlippedView {
    let open: Bool
    let button: TextButton
    init(open: Bool) {
        self.open = open
        button = TextButton(open ? "Show less ⌃" : "Show more ⌄", size: 13, weight: 500, color: Look.mid)
        super.init(frame: .zero)
        button.setAccessibilityLabel(open ? "Show less" : "Show more")
        addSubview(button)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() { super.layout(); button.frame = NSRect(x: 30, y: 2, width: button.frame.width, height: 22) }
    override func draw(_ dirtyRect: NSRect) { Look.rule.setFill(); NSRect(x: 16, y: 0, width: 2, height: bounds.height).fill() }
}

/// The fade over a cut answer's last rows shown (rgba(250,250,250,0) → #fafafa, 56px).
final class FadeView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSGradient(starting: Look.card.withAlphaComponent(0), ending: Look.card)?.draw(in: bounds, angle: isFlipped ? 90 : -90)
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// An answer's sources (citationSourcesHtml): "Sources" (11px/500 #8f8f8f), then a row a source: the circles of the
/// numbers quoting it, each a link to its passage, and its name, a link to the first.
final class SourcesView: FlippedView {
    let sources: [Cite.Source]
    var onOpen: (String) -> Void = { _ in }
    init(sources: [Cite.Source]) { self.sources = sources; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    static func height(count: Int) -> CGFloat { 12 + 20 + CGFloat(count) * 22 + 2 }
    func rects() -> [(rect: NSRect, href: String)] {
        var out: [(NSRect, String)] = []
        for (k, s) in sources.enumerated() {
            let y = 12 + 20 + CGFloat(k) * 22
            var x: CGFloat = 32
            for p in s.passages { let img = Glyphs.citeCircle(String(p.n), counter: p.counter); out.append((NSRect(x: x, y: y + 3, width: img.size.width, height: 16), p.href)); x += img.size.width + 1 }
            let w = (s.name as NSString).size(withAttributes: [.font: Fonts.sans(12.5)]).width
            out.append((NSRect(x: x + 5, y: y, width: min(w, bounds.width - x - 21), height: 22), s.href))
        }
        return out
    }
    override func draw(_ dirtyRect: NSRect) {
        Look.rule.setFill(); NSRect(x: 16, y: 0, width: 2, height: bounds.height).fill()
        ("Sources" as NSString).draw(at: NSPoint(x: 32, y: 12), withAttributes: [.font: Fonts.sans(11, weight: 500), .foregroundColor: Look.grey, .kern: 0.2])
        var k = 0
        let rs = rects()
        for s in sources {
            for p in s.passages { Glyphs.citeCircle(String(p.n), counter: p.counter).draw(in: rs[k].rect); k += 1 }
            (s.name as NSString).draw(with: rs[k].rect.offsetBy(dx: 0, dy: 3), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: Fonts.sans(12.5), .foregroundColor: Look.mid])
            k += 1
        }
    }
    override func resetCursorRects() { for r in rects() { addCursorRect(r.rect, cursor: .pointingHand) } }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let hit = rects().first(where: { $0.rect.contains(p) }) { onOpen(hit.href) }
    }
}

/// A label under a chip (CARD_CSS [data-waiting]::after): 12px #4d4d4d on white, 1px #eaeaea, radius 6.
final class ChipNoteView: NSView {
    let text: String
    init(text: String) { self.text = text; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    var wanted: CGSize { let s = (text as NSString).size(withAttributes: [.font: Fonts.sans(12)]); return CGSize(width: s.width + 16, height: s.height + 10) }
    override func draw(_ dirtyRect: NSRect) {
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        NSColor.white.setFill(); p.fill(); NSColor(hex: "#eaeaea").setStroke(); p.lineWidth = 1; p.stroke()
        (text as NSString).draw(at: NSPoint(x: 8, y: 5), withAttributes: [.font: Fonts.sans(12), .foregroundColor: Look.mid])
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
