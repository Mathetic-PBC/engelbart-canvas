import AppKit
import EngelbartUI

// The address row (Stage.jsx): ← → ↻ (× while loading), the field (30 tall, #fafafa, the kind's glyph at its left, 13pt
// app font, no placeholder, a #c9c9c9 edge while typing) with the thing's place in the library at its right end (+ Save,
// + Workspace, ✓; a made file's Save and its crumb), "Box removed · Undo" for 5 s, the Box button, ⋮. A 1pt #eaeaea line
// under it (the code's; Hudson's no-divider rule is older than it and the code wins).

final class AddressField: NSTextField {
    var onFocus: (() -> Void)?
    override func becomeFirstResponder() -> Bool {
        let took = super.becomeFirstResponder()
        if took { onFocus?(); DispatchQueue.main.async { self.currentEditor()?.selectAll(nil) } }
        return took
    }
}

final class AddressBarView: FlippedView {
    let back = TextButton("←", size: 14, color: Palette.ink)
    let forward = TextButton("→", size: 14, color: Palette.ink)
    let reload = TextButton("↻", size: 14, color: Palette.mut)
    let box = FlippedView()
    let glyph = NSImageView()
    let field = AddressField()
    let crumb = makeLabel("", size: 13)
    let save = TextButton("", size: 12, weight: 500, color: Palette.mut, radius: 5)
    let toast = FlippedView()
    let undo = TextButton("Undo", size: 12.5, weight: 500, color: .white, radius: 5)
    let boxButton = NSButton()
    let more = TextButton("⋮", size: 16, weight: 600, color: Palette.mut)
    private let toastText = makeLabel("Box removed", size: 12.5, color: .white)
    private let toastDot = makeLabel("·", size: 12.5, color: Palette.fnt)
    private let line = FlippedView()

    var typing = false { didSet { box.layer?.borderColor = (typing ? Palette.bd2 : NSColor.clear).cgColor; needsLayout = true } }
    var showsSave = false { didSet { needsLayout = true } }
    var showsCrumb = false { didSet { needsLayout = true } }
    var showsToast = false { didSet { toast.isHidden = !showsToast; needsLayout = true } }
    var showsBox = false { didSet { boxButton.isHidden = !showsBox; needsLayout = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        fill = Palette.panel
        for b in [back, forward, reload] { b.setAccessibilityLabel(b === back ? "Back" : b === forward ? "Forward" : "Reload"); addSubview(b) }
        box.fill = Palette.panel2
        box.layer?.cornerRadius = 8; box.layer?.borderWidth = 1; box.layer?.borderColor = NSColor.clear.cgColor
        addSubview(box)
        glyph.contentTintColor = Palette.fnt
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = Fonts.sans(13); field.textColor = Palette.ink; field.alignment = .left
        field.cell?.isScrollable = true; field.cell?.wraps = false
        field.setAccessibilityLabel("Open on stage")
        crumb.isHidden = true
        for v in [glyph, crumb, field, save] { box.addSubview(v) }
        toast.fill = Palette.ink
        toast.layer?.cornerRadius = 8
        toast.isHidden = true
        for v in [toastText, toastDot, undo] { toast.addSubview(v) }
        addSubview(toast)
        boxButton.isBordered = false
        boxButton.image = Self.boxGlyph()
        boxButton.toolTip = "Box part of the page (or hold ⌥ and drag)"
        boxButton.setAccessibilityLabel("Box part of the page")
        boxButton.wantsLayer = true; boxButton.layer?.cornerRadius = 6
        boxButton.isHidden = true
        addSubview(boxButton)
        more.setAccessibilityLabel("More")
        addSubview(more)
        line.fill = Palette.bd
        addSubview(line)
    }
    required init?(coder: NSCoder) { fatalError() }

    func setBoxing(_ on: Bool) {
        boxButton.layer?.backgroundColor = (on ? Palette.hov : NSColor.clear).cgColor
        boxButton.contentTintColor = on ? Palette.acc : Palette.mut
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        var x: CGFloat = 10
        for b in [back, forward, reload] { b.frame = NSRect(x: x, y: (h - 26) / 2, width: 26, height: 26); x += 32 }
        var right = bounds.width - 10
        more.frame = NSRect(x: right - 26, y: (h - 26) / 2, width: 26, height: 26); right -= 32
        if showsBox { boxButton.frame = NSRect(x: right - 26, y: (h - 26) / 2, width: 26, height: 26); right -= 32 }
        if showsToast {
            toastText.sizeToFit(); toastDot.sizeToFit()
            let undoW = undo.intrinsicContentSize.width + 16
            let width = 10 + toastText.frame.width + 4 + toastDot.frame.width + 4 + undoW + 4
            toast.frame = NSRect(x: right - width, y: (h - 26) / 2, width: width, height: 26)
            toastText.frame.origin = NSPoint(x: 10, y: (26 - toastText.frame.height) / 2)
            toastDot.frame.origin = NSPoint(x: toastText.frame.maxX + 4, y: (26 - toastDot.frame.height) / 2)
            undo.frame = NSRect(x: toastDot.frame.maxX + 4, y: 3, width: undoW, height: 20)
            right -= width + 6
        }
        box.frame = NSRect(x: x, y: (h - 30) / 2, width: max(60, right - x), height: 30)
        let saveW = showsSave && !typing ? save.intrinsicContentSize.width + 16 : 0
        glyph.frame = NSRect(x: 10, y: 8, width: 14, height: 14)
        save.isHidden = !(showsSave && !typing)
        save.frame = NSRect(x: box.bounds.width - 3 - saveW, y: 3, width: saveW, height: 24)
        let fieldX: CGFloat = 32
        let fieldW = max(20, (saveW > 0 ? save.frame.minX - 8 : box.bounds.width - 10) - fieldX)
        crumb.isHidden = !(showsCrumb && !typing)
        crumb.frame = NSRect(x: fieldX, y: 6, width: fieldW, height: 18)
        field.frame = NSRect(x: fieldX, y: 6, width: fieldW, height: 18)
        field.alphaValue = crumb.isHidden ? 1 : 0
        line.frame = NSRect(x: 0, y: h - 1, width: bounds.width, height: 1)
    }

    /// Lucide's square-dashed-mouse-pointer (engelbart-web's Annotate control, which David liked, 2026-10-07).
    static func boxGlyph() -> NSImage {
        let image = NSImage(size: NSSize(width: 15, height: 15), flipped: true) { rect in
            let s = rect.width / 24
            let path = NSBezierPath()
            path.lineWidth = 2 * s; path.lineCapStyle = .round; path.lineJoinStyle = .round
            let t = NSAffineTransform(); t.scale(by: s)
            let shape = NSBezierPath()
            shape.move(to: NSPoint(x: 12.034, y: 12.681)); shape.line(to: NSPoint(x: 21.681, y: 16.034)); shape.line(to: NSPoint(x: 17.8, y: 17.6)); shape.line(to: NSPoint(x: 16.2, y: 21.5)); shape.close()
            for (a, b) in [((5, 3), (3, 5)), ((19, 3), (21, 5)), ((5, 21), (3, 19)), ((9, 3), (10, 3)), ((9, 21), (11, 21)), ((14, 3), (15, 3)), ((3, 9), (3, 10)), ((21, 9), (21, 11)), ((3, 14), (3, 15))] {
                shape.move(to: NSPoint(x: a.0, y: a.1)); shape.line(to: NSPoint(x: b.0, y: b.1))
            }
            shape.transform(using: t as AffineTransform)
            shape.lineWidth = 2 * s; shape.lineCapStyle = .round; shape.lineJoinStyle = .round
            NSColor.black.setStroke(); shape.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}

/// The address field's list (stageRows): this workspace's rows, the library's, a web search, a file from the computer.
final class AddressListView: FlippedView {
    var rows: [StageModel.AddressRow] = [] { didSet { rebuild() } }
    var pick = 0 { didSet { if pick != oldValue { rebuild() } } }
    var onChoose: ((StageModel.AddressRow) -> Void)?
    var onHover: ((Int) -> Void)?
    var glyphFor: ((StageModel.AddressRow) -> String)?
    private var cells: [NSView] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        fill = Palette.panel
        layer?.cornerRadius = 8; layer?.borderWidth = 1; layer?.borderColor = Palette.bd2.cgColor
        shadow = { let s = NSShadow(); s.shadowColor = NSColor(white: 0, alpha: 0.06); s.shadowBlurRadius = 32; s.shadowOffset = NSSize(width: 0, height: -12); return s }()
    }
    required init?(coder: NSCoder) { fatalError() }

    var fittingHeight: CGFloat { min(420, CGFloat(rows.count) * 34 + 12) }

    private func rebuild() {
        for c in cells { c.removeFromSuperview() }
        cells = rows.enumerated().map { i, row in
            let cell = AddressRowView(index: i, picked: i == pick)
            let name: String
            switch row {
            case .item(let r, _): name = r.name
            case .disk: name = "Choose a file from your computer…"
            case .place(let s), .search(let s): name = s
            }
            cell.label.stringValue = name
            let key = glyphFor?(row) ?? "website"
            if key == "search" { cell.glyph.image = KindIcons.search.image(size: 13) }
            else if key == "disk" { cell.glyph.image = KindIcons.folder.image(size: 12) }
            else { cell.glyph.image = KindIcons.kind(key).icon.image(size: KindIcons.glyphSize(key)) }
            cell.onClick = { [weak self] in self?.onChoose?(row) }
            cell.onHover = { [weak self] in self?.onHover?(i) }
            addSubview(cell)
            return cell
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        for (i, c) in cells.enumerated() { c.frame = NSRect(x: 6, y: 6 + CGFloat(i) * 34, width: bounds.width - 12, height: 34) }
    }

    final class AddressRowView: FlippedView {
        let glyph = NSImageView()
        let label = makeLabel("", size: 13)
        var onClick: (() -> Void)?
        var onHover: (() -> Void)?
        private var tracking: NSTrackingArea?
        init(index: Int, picked: Bool) {
            super.init(frame: .zero)
            fill = picked ? Palette.hov : .clear
            layer?.cornerRadius = 6
            glyph.contentTintColor = Palette.mut
            addSubview(glyph); addSubview(label)
        }
        required init?(coder: NSCoder) { fatalError() }
        override func layout() {
            super.layout()
            glyph.frame = NSRect(x: 10, y: (bounds.height - 16) / 2, width: 16, height: 16)
            label.frame = NSRect(x: 36, y: (bounds.height - 18) / 2, width: bounds.width - 46, height: 18)
        }
        override func updateTrackingAreas() {
            if let tracking { removeTrackingArea(tracking) }
            let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self)
            addTrackingArea(t); tracking = t
            super.updateTrackingAreas()
        }
        override func mouseMoved(with event: NSEvent) { onHover?() }
        override func mouseDown(with event: NSEvent) { onClick?() }
    }
}
