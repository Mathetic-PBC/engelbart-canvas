import AppKit
import EngelbartDoc
import EngelbartUI

// What hangs over the document (MentionMenu.jsx, BartPicker.jsx, Popover.jsx, FindCard.jsx/DocFind.jsx,
// ImageViewer.jsx): placed as usePlaced places them (EngelbartUI Placement: below, else above, else the larger side).

/// The @ menu: 400 wide, padding 4, white, 1px #eaeaea, radius 8; rows 32 tall, the keyboard's row #f2f2f2; at most 420 tall.
final class MentionMenuView: FlippedView {
    var items: [MenuItem] = [] { didSet { needsDisplay = true } }
    var index = 0 { didSet { needsDisplay = true; keepInView() } }
    var onPick: (MenuItem) -> Void = { _ in }
    var onHover: (Int) -> Void = { _ in }
    var offset: CGFloat = 0
    static let rowH: CGFloat = 32
    var wanted: CGSize { CGSize(width: 400, height: min(420, CGFloat(items.count) * MentionMenuView.rowH + 8)) }
    func keepInView() {
        let top = CGFloat(index) * MentionMenuView.rowH, h = bounds.height - 8
        if top < offset { offset = top } else if top + MentionMenuView.rowH > offset + h { offset = top + MentionMenuView.rowH - h }
    }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        NSColor.white.setFill(); path.fill(); NSColor(hex: "#eaeaea").setStroke(); path.lineWidth = 1; path.stroke()
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: bounds.insetBy(dx: 4, dy: 4)).addClip()
        for (k, m) in items.enumerated() {
            let r = NSRect(x: 4, y: 4 + CGFloat(k) * MentionMenuView.rowH - offset, width: bounds.width - 8, height: MentionMenuView.rowH)
            if r.maxY < 0 || r.minY > bounds.height { continue }
            if k == index && m.kind != .note { NSColor(hex: "#f2f2f2").setFill(); NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).fill() }
            glyph(m).draw(in: NSRect(x: r.minX + 10, y: r.midY - 9, width: 18, height: 18))
            let name = NSAttributedString(string: m.name, attributes: [.font: Fonts.sans(14), .foregroundColor: m.kind == .note ? Look.grey : Look.ink])
            var right = r.maxX - 10
            if m.kind == .fresh || (m.kind == .entry && m.dir) || FolderMenu.isFolderRow(m) {
                let mark = m.kind == .fresh ? "+" : "›"
                (mark as NSString).draw(at: NSPoint(x: right - 12, y: r.midY - 9), withAttributes: [.font: Fonts.sans(15), .foregroundColor: Look.grey]); right -= 20
            }
            // What a row says beside its name: a back row's path (its end kept), a Zotero item's authors and year.
            if let hint = m.hint, !hint.isEmpty, m.kind == .back || m.zotero != nil {
                let ha: [NSAttributedString.Key: Any] = [.font: Fonts.sans(12), .foregroundColor: Look.grey]
                let w = min((hint as NSString).size(withAttributes: ha).width, (right - r.minX - 38) * (m.kind == .back ? 0.6 : 0.4))
                let p = NSMutableParagraphStyle(); p.lineBreakMode = m.kind == .back ? .byTruncatingHead : .byTruncatingTail
                (hint as NSString).draw(in: NSRect(x: right - w, y: r.midY - 8, width: w, height: 16), withAttributes: ha.merging([.paragraphStyle: p]) { a, _ in a })
                right -= w + 8
            }
            // A long name is cut in its middle: its start gives way, its end and extension stay (rail.js nameParts).
            let parts = m.kind == .note ? (head: m.name, tail: "") : FolderMenu.nameParts(m.name)
            let na: [NSAttributedString.Key: Any] = [.font: Fonts.sans(14), .foregroundColor: m.kind == .note ? Look.grey : Look.ink]
            let tailW = (parts.tail as NSString).size(withAttributes: na).width
            let headR = NSRect(x: r.minX + 38, y: r.midY - 10, width: max(0, right - r.minX - 38 - tailW), height: 20)
            NSAttributedString(string: parts.head, attributes: na).draw(with: headR, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            if !parts.tail.isEmpty {
                let headW = min((parts.head as NSString).size(withAttributes: na).width, headR.width)
                (parts.tail as NSString).draw(at: NSPoint(x: headR.minX + headW, y: r.midY - 10), withAttributes: na)
            }
            _ = name
        }
        NSGraphicsContext.restoreGraphicsState()
    }
    func glyph(_ m: MenuItem) -> NSImage {
        let color = Look.mid
        switch m.kind {
        case .back: return NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in ("←" as NSString).draw(at: NSPoint(x: 3, y: 1), withAttributes: [.font: Fonts.sans(14), .foregroundColor: color]); return true }
        case .note: return NSImage(size: NSSize(width: 18, height: 18))
        case .workspace: return Glyphs.mentionIcon(.workspace, size: 22, color: color)
        case .self: return Glyphs.mentionIcon(.file("folder"), size: 22, color: color)
        case .entry: return Glyphs.mentionIcon(m.dir ? .file("folder") : .file(Inline.fileKindOf(m.name) == "file" ? "pdf" : Inline.fileKindOf(m.name)), size: 22, color: color)
        case .verb: return Glyphs.image([KindIcons.chat.name == "" ? "" : "M3 2.5h6.5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6.5L4 11.5v-2H3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z"], size: 18, color: color, grid: 16)
        default:
            let key = m.row.map { Kind.kindKey($0) } ?? "note"
            let icon: MentionIcon = key == "git" ? .git : key == "website" ? .website : key == "folder" ? .file("folder") : .file(key == "note" || key == "md" ? "md" : key == "data" ? "data" : key == "image" ? "image" : key == "html" ? "html" : "pdf")
            return Glyphs.mentionIcon(icon, size: 22, color: color)
        }
    }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let k = Int((p.y - 4 + offset) / MentionMenuView.rowH)
        if k >= 0 && k < items.count && items[k].kind != .note { onPick(items[k]) }
    }
    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let k = Int((p.y - 4 + offset) / MentionMenuView.rowH)
        if k >= 0 && k < items.count && k != index { onHover(k) }
    }
    override func scrollWheel(with event: NSEvent) {
        offset = max(0, min(CGFloat(items.count) * MentionMenuView.rowH - (bounds.height - 8), offset - event.scrollingDeltaY)); needsDisplay = true
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self))
    }
}

/// The model selector (BartPicker.jsx): models of the provider in view on the left under the provider field, efforts on
/// the right; under Regenerate a round blue button regenerates with what is marked. @discover's level menu
/// (DiscoverLevels): Quick, Standard, Deep. 332 wide, radius 12, 1px #eaeaea.
final class PickerView: FlippedView {
    enum Kind { case line, regen, follow }
    let models: QuestionModels
    var provider: String
    var current: (provider: String, model: String, effort: String)?
    let levels: Bool
    var currentLevel: String?
    var onPick: (String, String) -> Void = { _, _ in }
    var onLevel: (String) -> Void = { _ in }
    var onSend: (() -> Void)? = nil
    var onLeave: () -> Void = {}
    /// The provider field opened to its list (BartPicker ProviderField).
    var listing = false { didSet { needsDisplay = true } }
    init(models: QuestionModels, current: (provider: String, model: String, effort: String)?, levels: Bool = false, currentLevel: String? = nil) {
        self.models = models; self.current = current; self.levels = levels; self.currentLevel = currentLevel
        provider = current?.provider ?? models.provider
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    var entry: QuestionModels.Provider { models.entry(provider) ?? models.providers[0] }
    var wanted: CGSize {
        if levels { return CGSize(width: 200, height: 8 + 3 * 32 + 8) }
        let rows = max(entry.models.count + 1, entry.efforts.count + 1)
        return CGSize(width: 332, height: 8 + CGFloat(rows) * 32 + 8 + (onSend != nil ? 40 : 0))
    }
    func row(_ label: String, on: Bool, at r: NSRect) {
        (label as NSString).draw(at: NSPoint(x: r.minX + 10, y: r.midY - 8), withAttributes: [.font: Fonts.sans(13, weight: on ? 500 : 400), .foregroundColor: Look.ink])
        let m = NSRect(x: r.maxX - 24, y: r.midY - 8, width: 16, height: 16)
        if on { Look.ink.setFill(); NSBezierPath(ovalIn: m).fill(); ("✓" as NSString).draw(at: NSPoint(x: m.minX + 4, y: m.minY + 1), withAttributes: [.font: Fonts.sans(10, weight: 600), .foregroundColor: NSColor.white]) }
        else { NSColor(hex: "#c9c9c9").setStroke(); let p = NSBezierPath(ovalIn: m.insetBy(dx: 0.75, dy: 0.75)); p.lineWidth = 1.5; p.stroke() }
    }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
        NSColor.white.setFill(); path.fill(); NSColor(hex: "#eaeaea").setStroke(); path.lineWidth = 1; path.stroke()
        if levels {
            for (k, mode) in Question.MODES.enumerated() { row(["Quick", "Standard", "Deep"][k], on: currentLevel == mode, at: NSRect(x: 8, y: 8 + CGFloat(k) * 32, width: bounds.width - 16, height: 32)) }
            return
        }
        let left = NSRect(x: 8, y: 8, width: bounds.width - 136 - 17, height: 32)
        let field = NSBezierPath(roundedRect: left.insetBy(dx: 0, dy: 0), xRadius: 8, yRadius: 8)
        NSColor(hex: "#eaeaea").setStroke(); field.lineWidth = 1; field.stroke()
        (entry.name as NSString).draw(at: NSPoint(x: left.minX + 10, y: left.midY - 8), withAttributes: [.font: Fonts.sans(13, weight: 500), .foregroundColor: Look.ink])
        if models.providers.count > 1 { ((listing ? "⌃" : "⌄") as NSString).draw(at: NSPoint(x: left.maxX - 18, y: left.minY + 4), withAttributes: [.font: Fonts.sans(12), .foregroundColor: Look.grey]) }
        let here = provider == current?.provider
        for (k, m) in entry.models.enumerated() { row(m.name, on: here && m.key == current?.model, at: NSRect(x: 8, y: 44 + CGFloat(k) * 32, width: left.width, height: 32)) }
        NSColor(hex: "#eaeaea").setFill(); NSRect(x: left.maxX + 8, y: 8, width: 1, height: bounds.height - 16).fill()
        ("EFFORT" as NSString).draw(at: NSPoint(x: left.maxX + 18, y: 18), withAttributes: [.font: Fonts.sans(9, weight: 500), .foregroundColor: Look.grey, .kern: 1.6])
        for (k, e) in entry.efforts.enumerated() { row(Question.EFFORT_LABELS[e] ?? e, on: here && e == current?.effort, at: NSRect(x: left.maxX + 10, y: 44 + CGFloat(k) * 32, width: 126, height: 32)) }
        if listing {
            // The list of providers under the field, over the models, each a row with its mark.
            let box = NSRect(x: left.minX, y: left.maxY + 4, width: left.width, height: CGFloat(models.providers.count) * 32 + 8)
            let lp = NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8)
            NSColor.white.setFill(); lp.fill(); NSColor(hex: "#eaeaea").setStroke(); lp.lineWidth = 1; lp.stroke()
            for (k, pr) in models.providers.enumerated() { row(pr.name, on: pr.key == provider, at: NSRect(x: box.minX + 4, y: box.minY + 4 + CGFloat(k) * 32, width: box.width - 8, height: 32)) }
        }
        if onSend != nil {
            let b = NSRect(x: bounds.width - 40, y: bounds.height - 40, width: 28, height: 28)
            Look.blue.setFill(); NSBezierPath(ovalIn: b).fill()
            Glyphs.image(Glyphs.regenerate, size: 14, color: .white, width: 2.2).draw(in: b.insetBy(dx: 7, dy: 7))
        }
    }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if levels { let k = Int((p.y - 8) / 32); if k >= 0 && k < 3 { onLevel(Question.MODES[k]) }; return }
        let leftW = bounds.width - 136 - 17
        if p.y < 40 && p.x < leftW + 8 { if models.providers.count > 1 { listing.toggle() }; return }
        if listing {
            let k = Int((p.y - 44 - 4) / 32)
            if p.x < leftW + 8, k >= 0, k < models.providers.count { provider = models.providers[k].key }
            listing = false
            return
        }
        if let onSend, p.y > bounds.height - 44 && p.x > bounds.width - 44 { onSend(); return }
        let k = Int((p.y - 44) / 32)
        let here = provider == current?.provider
        if p.x < leftW + 8, k >= 0, k < entry.models.count {
            // A model alone keeps the effort in force when this provider offers it; else the one its ladder pairs with it.
            let model = entry.models[k].key
            let effort = here && current.map { entry.efforts.contains($0.effort) } == true ? current!.effort : (entry.ladder.first { $0.model == model }?.effort ?? entry.efforts[0])
            onPick(model, effort)
        } else if p.x > leftW + 8, k >= 0, k < entry.efforts.count {
            onPick(here ? current!.model : entry.ladder[0].model, entry.efforts[k])
        }
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseExited(with event: NSEvent) { onLeave() }
}

/// A mention's hover card (Popover.jsx): 330 wide, its kind in small caps, its name, summary and facts; a citation's
/// card (cite.js citationCardHtml): the quote, then who, where and when.
final class HoverCardView: FlippedView {
    enum Content { case item(EditorRow), citation(Cite.Card) }
    let content: Content
    init(_ c: Content) { content = c; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    var wanted: CGSize {
        switch content {
        case .item(let r): return CGSize(width: 330, height: 14 + 12 + 8 + 22 + 6 + heightOf(r.row.summary ?? "", 298, 12.5) + 20 + 18 + 14)
        case .citation(let c): return CGSize(width: 280, height: 12 + (c.quote.isEmpty ? 0 : heightOf("“\(c.quote)”", 252, 13.5) + 19) + 16 + 10)
        }
    }
    func heightOf(_ s: String, _ w: CGFloat, _ size: CGFloat) -> CGFloat {
        ceil((s as NSString).boundingRect(with: NSSize(width: w, height: 600), options: .usesLineFragmentOrigin, attributes: [.font: Fonts.sans(size)]).height)
    }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        NSColor.white.setFill(); path.fill()
        switch content {
        case .item(let r):
            NSColor(hex: "#c9c9c9").setStroke(); path.lineWidth = 1; path.stroke()
            let kind = r.row.type == "chat" ? "AGENT" : Kind.kindLabel(r.row).uppercased()
            (kind as NSString).draw(at: NSPoint(x: 16, y: 14), withAttributes: [.font: Fonts.sans(9, weight: 500), .foregroundColor: Look.grey, .kern: 1.6])
            ((r.title ?? r.row.name) as NSString).draw(with: NSRect(x: 16, y: 30, width: 298, height: 22), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: Fonts.sans(14.5, weight: 500), .foregroundColor: Look.ink])
            let sh = heightOf(r.row.summary ?? "", 298, 12.5)
            ((r.row.summary ?? "") as NSString).draw(with: NSRect(x: 16, y: 58, width: 298, height: sh), options: .usesLineFragmentOrigin, attributes: [.font: Fonts.sans(12.5), .foregroundColor: Look.mid])
            ((r.facts ?? "") as NSString).draw(at: NSPoint(x: 16, y: 58 + sh + 20), withAttributes: [.font: Fonts.sans(12), .foregroundColor: Look.grey])
        case .citation(let c):
            NSColor(hex: "#e3e3e3").setStroke(); path.lineWidth = 1; path.stroke()
            var y: CGFloat = 12
            if !c.quote.isEmpty {
                let h = heightOf("“\(c.quote)”", 252, 13.5)
                ("“\(c.quote)”" as NSString).draw(with: NSRect(x: 14, y: y, width: 252, height: h), options: .usesLineFragmentOrigin, attributes: [.font: Fonts.sans(13.5), .foregroundColor: Look.ink])
                y += h + 10
            }
            let foot = NSMutableAttributedString(string: c.lead.isEmpty ? "" : "\(c.lead) · ", attributes: [.font: Fonts.sans(11.5), .foregroundColor: Look.grey])
            foot.append(NSAttributedString(string: c.where_, attributes: [.font: Fonts.sans(11.5, weight: 600), .foregroundColor: Look.mid]))
            if !c.when.isEmpty { foot.append(NSAttributedString(string: " · \(c.when)", attributes: [.font: Fonts.sans(11.5), .foregroundColor: Look.grey])) }
            if c.counter { foot.append(NSAttributedString(string: " · cuts against this", attributes: [.font: Fonts.sans(11.5), .foregroundColor: Look.grey])) }
            foot.draw(with: NSRect(x: 34, y: y + 9, width: 232, height: 16), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
    }
}

/// ⌘F's card (FindCard.jsx): top right, at most 360 wide, 34 tall; the query, "n of m" (red "0 matches"), ↑ ↓ ×.
final class FindBarView: FlippedView, NSTextFieldDelegate {
    let field = NSTextField()
    let count = NSTextField(labelWithString: "")
    weak var editor: DocEditorView?
    var ranges: [NSRange] = []
    var at = -1
    var query = ""
    override init(frame: NSRect) {
        super.init(frame: frame)
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none; field.font = Fonts.sans(13)
        field.placeholderString = ""; field.setAccessibilityLabel("Find in this document"); field.delegate = self
        count.font = Fonts.mono(11); count.textColor = Look.grey; count.alignment = .right
        addSubview(field); addSubview(count)
        for (k, (label, tip)) in [("↑", "Previous match"), ("↓", "Next match"), ("×", "Close find")].enumerated() {
            let b = TextButton(label, size: 13, weight: 400, color: k == 2 ? Look.grey : Look.mid)
            b.toolTip = tip
            b.onClick = { [weak self] in if k == 2 { self?.close() } else { self?.step(k == 0 ? -1 : 1) } }
            b.frame = NSRect(x: 0, y: 5, width: 24, height: 24); b.tag = 100 + k
            addSubview(b)
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        for k in 0..<3 { viewWithTag(100 + k)?.frame.origin.x = bounds.width - 4 - CGFloat(3 - k) * 24 }
        count.frame = NSRect(x: bounds.width - 4 - 72 - 9 - 70, y: 10, width: 70, height: 14)
        field.frame = NSRect(x: 12, y: 8, width: count.frame.minX - 16, height: 18)
    }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        NSColor.white.setFill(); path.fill(); NSColor(hex: "#c9c9c9").setStroke(); path.lineWidth = 1; path.stroke()
        NSColor(hex: "#eaeaea").setFill(); NSRect(x: bounds.width - 4 - 72 - 5, y: 9, width: 1, height: 16).fill()
    }
    func controlTextDidChange(_ obj: Notification) { refind(keepAt: false) }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { step(NSEvent.modifierFlags.contains(.shift) ? -1 : 1); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { close(); return true }
        if sel == #selector(NSResponder.moveDown(_:)) { step(1); return true }
        if sel == #selector(NSResponder.moveUp(_:)) { step(-1); return true }
        return false
    }
    /// The matches of the query in the lines as drawn (doc-find.js segmentMatches: case ignored, never across lines).
    func refind(keepAt: Bool) {
        guard let editor else { return }
        let q = field.stringValue
        let fresh = q != query; query = q
        let text = editor.textView.string as NSString
        ranges = []
        if !q.trimmed.isEmpty {
            let segs = editor.rendered.maps.map { DocFind.Segment(text: text.substring(with: $0.range), block: $0.line) }
            for m in DocFind.segmentMatches(segs, q) {
                let a = editor.rendered.maps[m.start.seg].range.location + m.start.offset, b = editor.rendered.maps[m.end.seg].range.location + m.end.offset
                ranges.append(NSRange(location: a, length: b - a))
            }
        }
        let next = DocFind.nextFind(fresh: fresh || !keepAt, step: 0, count: ranges.count, at: at, firstInView: { [weak editor] in
            guard let editor else { return 0 }
            let top = editor.scroll.contentView.bounds.minY
            return self.ranges.firstIndex { editor.layoutManager.boundingRect(forGlyphRange: editor.layoutManager.glyphRange(forCharacterRange: $0, actualCharacterRange: nil), in: editor.textView.textContainer!).maxY + editor.textView.textContainerOrigin.y >= top } ?? 0
        })
        at = next.at
        show(scroll: next.scroll && fresh)
    }
    func step(_ dir: Int) {
        let next = DocFind.nextFind(fresh: false, step: dir, count: ranges.count, at: at)
        at = next.at
        show(scroll: next.scroll)
    }
    func show(scroll: Bool) {
        count.stringValue = query.isEmpty ? "" : ranges.isEmpty ? "0 matches" : "\(at + 1) of \(ranges.count)"
        count.textColor = !query.isEmpty && ranges.isEmpty ? Palette.del : Look.grey
        editor?.placeFindHighlights()
        if scroll, at >= 0, at < ranges.count { editor?.textView.scrollRangeToVisible(ranges[at]) }
    }
    func close() {
        guard let editor else { return }
        let r = at >= 0 && at < ranges.count ? ranges[at] : nil
        ranges = []; editor.placeFindHighlights()
        removeFromSuperview(); editor.findBar = nil
        // The keyboard back in the document, on the match in front.
        if let r {
            let a = editor.docPoint(r.location), b = editor.docPoint(NSMaxRange(r))
            if a.line == b.line { editor.placeCaret(line: a.line, a: a.offset, b: b.offset) }
        }
        editor.window?.makeFirstResponder(editor.textView)
    }
}

/// The picture viewer (ImageViewer.jsx): the picture large over the window; Escape or a click closes it, ⌘C copies it.
enum ImageViewer {
    static func show(_ image: NSImage, over window: NSWindow?) {
        guard let window, let content = window.contentView else { return }
        let v = ViewerView(image: image)
        v.frame = content.bounds; v.autoresizingMask = [.width, .height]
        content.addSubview(v)
        window.makeFirstResponder(v)
    }
    final class ViewerView: NSView {
        let image: NSImage
        init(image: NSImage) { self.image = image; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override var acceptsFirstResponder: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            NSColor(white: 0, alpha: 0.72).setFill(); bounds.fill()
            let k = min(1, (bounds.width - 80) / max(1, image.size.width), (bounds.height - 80) / max(1, image.size.height))
            let s = NSSize(width: image.size.width * k, height: image.size.height * k)
            image.draw(in: NSRect(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2, width: s.width, height: s.height))
        }
        override func mouseDown(with event: NSEvent) { removeFromSuperview() }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 53 { removeFromSuperview(); return }
            if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "c" { NSPasteboard.general.clearContents(); NSPasteboard.general.writeObjects([image]); return }
            super.keyDown(with: event)
        }
    }
}

extension DocEditorView {
    // MARK: the @ menu

    func placed(_ size: CGSize, anchor: NSRect) -> NSRect {
        let spot = Placement.place(PlaceAnchor(anchor), size: size, view: bounds.size, gap: 6, margin: 8)
        return NSRect(x: spot.left, y: spot.top, width: size.width, height: spot.maxHeight ?? size.height)
    }

    func caretRect() -> NSRect {
        let r = textView.firstRect(forCharacterRange: textView.selectedRange(), actualRange: nil)
        guard let w = window else { return .zero }
        let inWindow = w.convertFromScreen(r)
        return convert(inWindow, from: nil)
    }

    func menuRows(_ query: String, field: Bool) -> [MenuItem] {
        let q = query.lowercased()
        var rows: [MenuItem]
        if let host, let given = host.docEditor(self, mentionItems: q) { rows = given }
        else {
            rows = (host?.docEditorMentionable(self) ?? []).filter { $0.row.name.lowercased().contains(q) || ($0.title ?? "").lowercased().contains(q) }.map { r in
                r.row.type == "chat" ? MenuItem(kind: .verb, key: "verb:\(r.row.id)", name: r.title ?? r.row.name, id: r.row.id) : Mention.menuItem(r.row)
            }
        }
        // A follow-up field already asks its thread's agent: no verbs there.
        if field { rows = rows.filter { !($0.kind == .verb || ["bart", "chat", "brainstorm", "discover", "create"].contains($0.id)) } }
        return rows
    }

    func namesHold(_ query: String) -> Bool {
        let q = query.lowercased()
        let rows = host.flatMap { $0.docEditor(self, mentionItems: q) } ?? (host?.docEditorMentionable(self) ?? []).map { Mention.menuItem($0.row) }
        return rows.contains { $0.kind != .verb && $0.row?.type != "chat" && $0.name.lowercased().contains(q) }
    }

    /// After an edit: the @ menu opened, narrowed or closed by what stands before the caret (no menu inside code).
    func updateMention() {
        guard window?.firstResponder === textView, let s = docSelection(), s.collapsed, let line = core.activeLine, s.anchor.line == line else {
            if mention?.field == nil { closeMention() }; return
        }
        let ls = core.lines, p = core.parsed(ls)[line]
        if Doc.isCode(p) || Doc.isFence(p) || p.type == .img { closeMention(); return }
        let text = core.lineText(ls, line)
        if readFolderMention(text, s.anchor.offset, line: line, field: nil) { return }
        if browsingRedraw { return }
        browse = nil
        guard let found = Inline.mentionAt(text, s.anchor.offset, holds: { [weak self] q in self?.namesHold(q) ?? false }) else { closeMention(); return }
        let items = menuRows(found.query, field: false)
        let was = mention
        mention = MentionState(line: line, field: nil, query: found.query, start: found.start, caret: s.anchor.offset, index: was?.line == line && was?.query == found.query ? min(was!.index, max(0, items.count - 1)) : 0, items: items)
        showMenu()
    }

    func fieldMention(from: Int, field: NSTextView) {
        let caret = field.selectedRange().location
        mentionField = field
        if readFolderMention(field.string, caret, line: nil, field: from) { return }
        browse = nil
        guard let found = Inline.mentionAt(field.string, caret, holds: { [weak self] q in self?.namesHold(q) ?? false }) else { if mention?.field == from { closeMention() }; return }
        mention = MentionState(line: nil, field: from, query: found.query, start: found.start, caret: caret, index: 0, items: menuRows(found.query, field: true))
        mentionField = field
        showMenu()
    }

    func showMenu() {
        guard let m = mention, !m.items.isEmpty else { closeMention(keepState: true); return }
        let open = mentionMenu == nil
        if mentionMenu == nil {
            let v = MentionMenuView()
            v.onPick = { [weak self] r in self?.pickMention(r) }
            v.onHover = { [weak self] k in self?.mention?.index = k; self?.mentionMenu?.index = k }
            addSubview(v); mentionMenu = v
        }
        mentionMenu!.items = m.items; mentionMenu!.index = m.index
        positionMenu()
        if open { host?.docEditor(self, mentionMenuOpen: true) }
    }
    func positionMenu() {
        guard let mentionMenu else { return }
        var anchor = caretRect()
        if let f = mentionField, mention?.field != nil, let w = window {
            let r = f.firstRect(forCharacterRange: f.selectedRange(), actualRange: nil)
            anchor = convert(w.convertFromScreen(r), from: nil)
        }
        mentionMenu.frame = placed(mentionMenu.wanted, anchor: anchor)
    }
    func closeMention(keepState: Bool = false) {
        if mentionMenu != nil { host?.docEditor(self, mentionMenuOpen: false) }
        mentionMenu?.removeFromSuperview(); mentionMenu = nil
        if !keepState { mention = nil; mentionField = nil; browse = nil }
    }

    /// The @ menu's keys: ↓/↑ wrap, Enter or Tab picks, Escape closes it alone. → whether it took the key.
    func mentionKey(_ key: String, shift: Bool) -> Bool {
        guard var m = mention, !m.items.isEmpty, mentionMenu != nil else { return false }
        let n = max(1, m.items.count)
        switch key {
        case "ArrowDown": m.index = (m.index + 1) % n
        case "ArrowUp": m.index = (m.index - 1 + n) % n
        case "Enter", "Tab": pickMention(m.items[min(m.index, m.items.count - 1)]); return true
        case "Escape": closeMention(); return true
        default: return false
        }
        mention = m; mentionMenu?.index = m.index
        return true
    }

    func pickMention(_ rIn: MenuItem) {
        var r = rIn
        guard let m = mention, r.kind != .note else { return }
        // A library folder opens in the menu, a subfolder of it too; the back row goes up (MATH-22).
        if FolderMenu.isFolderRow(r), let row = r.row { openFolder(row, rel: ""); return }
        if r.kind == .entry && r.dir, let row = r.row, let rel = r.rel { openFolder(row, rel: rel); return }
        if r.kind == .back { leaveFolder(); return }
        if r.kind == .self && (r.rel ?? "").isEmpty, let row = r.row { r = Mention.menuItem(row) }
        closeMention()
        if let from = m.field, let field = mentionField {
            if r.kind == .verb || ["bart", "chat", "brainstorm", "discover", "create"].contains(r.id) { return }
            let ins = Mention.mentionToken(r)
            let end = min(m.caret, field.string.len), start = min(m.start, end)
            field.replaceCharacters(in: NSRange(location: start, length: end - start), with: ins)
            core.followText[from] = field.string
            if r.kind != .workspace { host?.docEditor(self, picked: r) }
            window?.makeFirstResponder(field)
            return
        }
        guard let line = m.line else { return }
        core.pickMention(line: line, start: m.start, caretAt: m.caret, row: r)
        redraw()
        window?.makeFirstResponder(textView)
    }

    // MARK: the selector

    func openPicker(line: Int, from v: NSView, kind: PickerView.Kind) {
        guard let models = core.models else { return }
        closePicker()
        let ls = core.lines
        var current: (provider: String, model: String, effort: String)? = nil
        var levels = false, level: String? = nil
        switch kind {
        case .regen: current = core.ranWith(ls, line).current
        case .follow:
            if let t = core.threads().first(where: { $0.from == line }), let step = core.followStep(ls, t).step { current = (step.provider, step.key, step.effort) }
        case .line:
            let p = Doc.parseLine(line < ls.count ? ls[line] : "")
            if Doc.agentOf(p) == "discover" { levels = true; level = core.discoverRead(ls, line).mode }
            else if let step = Question.readQuestion(p.text, models).steps.first { current = (step.provider, step.key, step.effort) }
        }
        let pv = PickerView(models: models, current: current, levels: levels, currentLevel: level)
        if kind == .regen { pv.onSend = { [weak self, weak pv] in
            guard let self else { return }
            let choice = pv?.current.map { (model: $0.model, effort: $0.effort) } ?? self.core.ranWith(self.core.lines, line).choice
            self.closePicker(); self.core.regenerate(line, choice: choice); self.redraw()
        } }
        pv.onPick = { [weak self, weak pv] model, effort in
            guard let self, let pv else { return }
            switch kind {
            case .regen: pv.current = (Question.modelOf(model, models)?.provider ?? pv.provider, model, effort); pv.needsDisplay = true
            case .follow: self.core.followChoice[line] = (model, effort); self.closePicker()
            case .line: self.core.pickModel(line: line, model: model, effort: effort); self.closePicker(); self.redraw()
            }
        }
        pv.onLevel = { [weak self] mode in self?.core.pickLevel(line: line, mode: mode, provider: nil); self?.closePicker(); self?.redraw() }
        pv.onLeave = { [weak self] in DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { if let self, let p = self.picker, !p.isMousePoint(self.convert(self.window?.mouseLocationOutsideOfEventStream ?? .zero, from: nil), in: p.frame) { self.closePicker() } } }
        let anchor = convert(v.bounds, from: v)
        let size = pv.wanted
        let spot = Placement.place(PlaceAnchor(anchor), size: size, view: bounds.size, align: kind == .regen ? .start : .end)
        pv.frame = NSRect(x: spot.left, y: spot.top, width: size.width, height: spot.maxHeight ?? size.height)
        addSubview(pv); picker = pv
    }
    func closePicker() { picker?.removeFromSuperview(); picker = nil }

    // MARK: hover cards

    func showPop(_ c: HoverCardView.Content, anchor: NSRect) {
        closePop()
        let v = HoverCardView(c)
        let size = v.wanted
        v.frame = placed(size, anchor: convert(anchor, from: textView)).offsetBy(dx: 0, dy: 2)
        addSubview(v); pop = v
    }
    func closePop() { pop?.removeFromSuperview(); pop = nil }
    func leaveHover() {
        guard pop != nil else { return }
        // A citation's card waits CARD_GRACE for the pointer to reach it.
        DispatchQueue.main.asyncAfter(deadline: .now() + Cite.CARD_GRACE) { [weak self] in
            guard let self, let p = self.pop, let w = self.window else { return }
            if !NSMouseInRect(self.convert(w.mouseLocationOutsideOfEventStream, from: nil), p.frame, true) { self.closePop() }
        }
    }
    func closePopups() { closeMention(); closePicker(); closePop() }

    // MARK: find

    /// ⌘F: the find card at the top right, its field focused.
    public func openFind() {
        if findBar == nil {
            let f = FindBarView()
            f.editor = self
            addSubview(f); findBar = f
        }
        let w = min(360, bounds.width - 28)
        findBar!.frame = NSRect(x: bounds.width - 14 - w, y: 10, width: w, height: 34)
        window?.makeFirstResponder(findBar!.field)
        findBar!.field.currentEditor()?.selectAll(nil)
        findBar!.refind(keepAt: false)
    }
    /// ⌘G / ⇧⌘G.
    public func findStep(_ dir: Int) { findBar?.step(dir) }

    func placeFindHighlights() {
        guard let storage = textView.textStorage else { return }
        let all = NSRange(location: 0, length: storage.length)
        layoutManager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: all)
        if let f = findBar {
            for (k, r) in f.ranges.enumerated() where NSMaxRange(r) <= storage.length {
                layoutManager.addTemporaryAttribute(.backgroundColor, value: NSColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: k == f.at ? 0.4 : 0.16), forCharacterRange: r)
            }
        }
        if flashLine != nil { applyFlash() }
    }
}

private var fieldKey = 0
extension DocEditorView {
    /// The reply field the @ menu was opened in.
    var mentionField: NSTextView? {
        get { objc_getAssociatedObject(self, &fieldKey) as? NSTextView }
        set { objc_setAssociatedObject(self, &fieldKey, newValue, .OBJC_ASSOCIATION_ASSIGN) }
    }
}
