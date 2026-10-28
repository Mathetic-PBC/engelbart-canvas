import AppKit
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// The sidebar's pieces drawn in AppKit (Rail.jsx Row, MoreRow, SectionHead, AddButton, Chevron, RowAction, Count, Pill;
// styles.css .sb-*). Every value is the CSS's (1 px = 1 pt). Each piece draws itself in draw(_:), so a bitmap of the
// sidebar (cacheDisplay) shows exactly what the screen shows; hover is a tracking area (`.sb-row:hover`), and what CSS
// showed only on a row's hover (`.sb-add`, `.sb-act`, `.sb-chev.sb-on-hover`, `.sb-folder-add`) is a child whose
// `revealOnHover` follows its row.

/// The sidebar's colours (styles.css; the tokens where Palette has them).
enum SB {
    static let bg = Palette.gray50                    // #fafafa
    static let hover = NSColor(hex: "#efefef")        // .sb-row:hover
    static let active = NSColor(hex: "#e6e6e6")       // .sb-row[data-active]
    static let activeHover = NSColor(hex: "#e0e0e0")
    static let headOpen = NSColor(hex: "#ececec")     // .sb-project:hover, .sb-icon:hover
    static let addHover = NSColor(hex: "#e3e3e3")     // .sb-add:hover, .sb-act:hover
    static let chevHover = NSColor(hex: "#e0e0e0")
    static let chev = NSColor(hex: "#9b9b9b")
    static let icon = NSColor(hex: "#5c5c5c")
    static let text = NSColor(hex: "#262626")
    static let faint = NSColor(hex: "#9b9b9b")
    static let empty = NSColor(hex: "#a3a3a3")
    static let guide = NSColor(hex: "#dcdcdc")
    static let flash = Palette.blue100                // @keyframes added: #e6f0fd
    static let dropRing = Palette.gray300             // #c9c9c9
    static let footDrag = NSColor(hex: "#f0f0f0")
    static let footOver = NSColor(hex: "#e6e6e6")
    static let footRing = NSColor(hex: "#dedede")
    static let LINE: CGFloat = 30
    static let ICON: CGFloat = 18
    static let rowSize: CGFloat = 14.5, indentSize: CGFloat = 13.5, headSize: CGFloat = 13
}

/// An icon with the stroke a JSX call gave it (`<ChevronDown stroke={2.4} />`).
func stroked(_ icon: Icon, _ stroke: CGFloat?) -> Icon { var i = icon; if let stroke { i.strokeWidth = stroke }; return i }

/// Draws `icon` into `rect` (a flipped view's coordinates), rotated 180° when `flipped`.
func drawIcon(_ icon: Icon, in rect: CGRect, color: NSColor, rotated: Bool = false) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.minY)
    if rotated { ctx.translateBy(x: rect.width, y: rect.height); ctx.rotate(by: .pi) }
    icon.draw(in: ctx, side: rect.width, color: color.cgColor)
    ctx.restoreGState()
}

/// One line of text, vertically centred in `rect`, cut with an ellipsis.
@discardableResult
func drawText(_ text: String, in rect: CGRect, font: NSFont, color: NSColor, align: NSTextAlignment = .left, tabular: Bool = false) -> CGFloat {
    let para = NSMutableParagraphStyle()
    para.lineBreakMode = .byTruncatingTail
    para.alignment = align
    var f = font
    if tabular { f = NSFont(descriptor: font.fontDescriptor.addingAttributes([.featureSettings: [[NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType, NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector]]]), size: font.pointSize) ?? font }
    let attrs: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: color, .paragraphStyle: para]
    let s = NSAttributedString(string: text, attributes: attrs)
    let h = ceil(f.ascender - f.descender + f.leading)
    let r = CGRect(x: rect.minX, y: rect.midY - h / 2, width: rect.width, height: h)
    s.draw(with: r, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    return min(rect.width, ceil(s.size().width))
}

func textWidth(_ text: String, font: NSFont) -> CGFloat { ceil(NSAttributedString(string: text, attributes: [.font: font]).size().width) }

/// A flipped view that draws a rounded fill.
class SBView: NSView {
    override var isFlipped: Bool { true }
    /// Shown only while the row it is in is hovered (or renaming).
    var revealOnHover = false
    /// A named piece is an accessibility element, so the app's drive scripts find it by its identifier (the Electron
    /// data-* attribute) when no `driveID` marker names it (mac/Engelbart/API.md).
    override func isAccessibilityElement() -> Bool { !(accessibilityIdentifier().isEmpty) }
    func fill(_ rect: CGRect, _ color: NSColor, radius: CGFloat) {
        color.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
    }
}

/// A small button that draws an icon (the +, a chevron, a row's minus, the gear, New note, the trash).
final class SBIconButton: SBView {
    var icon: Icon
    var iconSize: CGFloat
    var color: NSColor
    var hoverColor: NSColor
    var hoverFill: NSColor?
    var radius: CGFloat
    var rotated = false
    var enabled = true { didSet { needsDisplay = true } }
    /// Held "pressed" look (aria-expanded): the hover fill without the hover.
    var on = false { didSet { needsDisplay = true } }
    var action: ((SBIconButton) -> Void)?
    /// The sidebar's own tooltip for this button (`onTip`), shown and hidden by the controller.
    var onHoverChange: ((SBIconButton, Bool) -> Void)?
    private(set) var hovered = false
    private var area: NSTrackingArea?

    init(icon: Icon, size: CGFloat, box: CGSize, color: NSColor, hoverColor: NSColor, hoverFill: NSColor?, radius: CGFloat, label: String, id: String? = nil) {
        self.icon = icon; self.iconSize = size; self.color = color; self.hoverColor = hoverColor; self.hoverFill = hoverFill; self.radius = radius
        super.init(frame: CGRect(origin: .zero, size: box))
        setAccessibilityRole(.button)
        setAccessibilityLabel(label)
        if let id { setAccessibilityIdentifier(id) }
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let a = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(a); area = a
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true; onHoverChange?(self, true) }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true; onHoverChange?(self, false) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { /* the row under it never sees the press (stopPropagation) */ }
    override func mouseUp(with event: NSEvent) {
        guard enabled, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onHoverChange?(self, false)
        action?(self)
    }
    override func rightMouseDown(with event: NSEvent) {}
    override func accessibilityPerformPress() -> Bool { if enabled { action?(self) }; return true }

    override func draw(_ dirtyRect: NSRect) {
        if (hovered && enabled) || on, let hoverFill { fill(bounds, hoverFill, radius: radius) }
        let side = iconSize
        let r = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        drawIcon(icon, in: r, color: ((hovered && enabled) || on ? hoverColor : color).withAlphaComponent(enabled ? 1 : 0.4), rotated: rotated)
    }
}

/// `.sb-count` (a project's: a bare number) and `.sb-pill` (Agents': a number in a rounded square).
final class SBCountView: SBView {
    var summary: AgentSummary { didSet { restyle() } }
    let pill: Bool
    init(summary: AgentSummary, pill: Bool) {
        self.summary = summary; self.pill = pill
        super.init(frame: .zero)
        wantsLayer = true
        restyle()
    }
    required init?(coder: NSCoder) { fatalError() }
    var label: String { SidebarModel.countLabel(summary.total) }
    var running: Bool { summary.running > 0 }
    static let font = Fonts.sans(12)
    var fitting: CGSize {
        let w = textWidth(label, font: Self.font)
        return pill ? CGSize(width: max(22, w + 8), height: 22) : CGSize(width: max(12, w), height: 16)
    }

    func restyle() {
        let words = "\(summary.ready) to look at, \(summary.running) running"
        toolTip = words
        setAccessibilityLabel(words)
        setAccessibilityRole(.staticText)
        isHidden = summary.total == 0
        layer?.removeAllAnimations()
        // styles.css: running counts breathe (opacity 1 ↔ .4) and the running pill's outline breathes (#8f8f8f ↔ #eaeaea),
        // 1.8 s, ease-in-out; none with reduced motion.
        if running && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let a = CABasicAnimation(keyPath: pill ? "borderColor" : "opacity")
            if pill {
                layer?.borderWidth = 1; layer?.cornerRadius = 4
                a.fromValue = Palette.gray500.cgColor; a.toValue = Palette.gray200.cgColor
            } else { a.fromValue = 1; a.toValue = 0.4 }
            a.duration = 0.9; a.autoreverses = true; a.repeatCount = .infinity
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer?.add(a, forKey: "sb-breathe")
        } else {
            layer?.borderWidth = 0
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard summary.total > 0 else { return }
        if pill {
            if running {
                // the outline (its colour breathes in the layer; drawn here at rest for a still picture)
                let r = bounds.insetBy(dx: 0.5, dy: 0.5)
                Palette.gray300.setStroke()
                let path = NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4); path.lineWidth = 1; path.stroke()
            } else {
                fill(bounds, Palette.gray200, radius: 4)
            }
            drawText(label, in: bounds, font: Self.font, color: running ? Palette.gray700 : Palette.ink, align: .center, tabular: true)
        } else {
            drawText(label, in: bounds, font: Self.font, color: running ? Palette.fnt : Palette.ink, align: .center, tabular: true)
        }
    }
}

/// A line of the sidebar (Rail.jsx Row / MoreRow / SectionHead): icon, name, then what it shows at the right.
final class SBRowView: SBView, NSDraggingSource {
    enum Style { case row, more, section, plain }
    struct Look {
        var style: Style = .row
        var icon: Icon? = nil
        var iconSize: CGFloat = 18
        var label: String = ""
        var indent = false
        var active = false
        var holds = false
        var faint = false
        var flash = false
        /// The label's size (default: 14.5, indented 13.5; a section's 13).
        var size: CGFloat? = nil
        /// The label's colour when not the row's own (the +Note row's grey).
        var color: NSColor? = nil
        var padLeft: CGFloat? = nil
        /// A section's chevron after its name: open (down) or folded (up).
        var sectionOpen: Bool? = nil
        /// No hover fill (a section head, the foot while dragging).
        var noHover = false
    }

    var look: Look { didSet { needsDisplay = true; setAccessibilityLabel(look.label); if look.flash && !oldValue.flash { startFlash() } } }
    /// Right-hand pieces, laid out right to left with `gap` between them.
    var accessories: [NSView] = [] { didSet { oldValue.forEach { $0.removeFromSuperview() }; accessories.forEach(addSubview); needsLayout = true; updateReveal() } }
    var accessoryGap: CGFloat = 5
    var onClick: ((NSEvent) -> Void)?
    var onDoubleClick: ((NSEvent) -> Void)?
    var onContextMenu: ((NSEvent) -> Void)?
    var onHover: ((SBRowView, Bool, NSEvent?) -> Void)?
    /// A library row to drag into a document (2026-10-17).
    var dragRow: LibraryRow?
    /// The name being typed in place of the label.
    var renameField: NSView? { didSet { oldValue?.removeFromSuperview(); if let f = renameField { addSubview(f) }; needsLayout = true; needsDisplay = true; updateReveal() } }
    private(set) var hovered = false { didSet { if hovered != oldValue { needsDisplay = true; updateReveal() } } }
    private var area: NSTrackingArea?
    private var pressAt: NSPoint?
    private var flashStart: Date?
    private var flashTimer: Timer?
    var flashDuration: TimeInterval = 1.6
    /// Create new's folder with a plus on its corner (FolderPlusIcon: "+", 16px, on the sidebar's grey, right −3 bottom −2).
    var iconPlus = false { didSet { needsDisplay = true } }
    /// A project row's level (data-level), 0 for others.
    var level = 0
    /// aria-expanded: an open folder or project.
    var expanded: Bool? { didSet { if let expanded { setAccessibilityExpanded(expanded) } } }

    init(look: Look, id: String? = nil) {
        self.look = look
        super.init(frame: CGRect(x: 0, y: 0, width: 100, height: SB.LINE))
        if let id { setAccessibilityIdentifier(id); identifier = NSUserInterfaceItemIdentifier(id) }
        setAccessibilityRole(.button)
        setAccessibilityLabel(look.label)
        if look.flash { startFlash() }
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let a = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(a); area = a
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; onHover?(self, true, event) }
    override func mouseMoved(with event: NSEvent) { onHover?(self, true, event) }
    override func mouseExited(with event: NSEvent) { hovered = false; onHover?(self, false, event) }
    /// Sets the hover from where the pointer is now (after the sidebar was rebuilt under it).
    func syncHover() {
        guard let window, window.isVisible else { hovered = false; return }
        hovered = bounds.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil))
    }
    func setHovered(_ on: Bool) { hovered = on }

    func updateReveal() {
        let show = hovered || renameField != nil
        for view in accessories { reveal(view, show) }
    }
    private func reveal(_ view: NSView, _ show: Bool) {
        if let v = view as? SBView, v.revealOnHover { v.isHidden = !show }
        for sub in view.subviews { reveal(sub, show) }
    }

    // MARK: presses (a press does not move the keyboard here: Rail.jsx keepFocus)

    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { pressAt = event.locationInWindow }
    override func mouseDragged(with event: NSEvent) {
        guard let start = pressAt, let row = dragRow, renameField == nil else { return }
        let p = event.locationInWindow
        guard hypot(p.x - start.x, p.y - start.y) > 3 else { return }
        pressAt = nil
        let item = NSDraggingItem(pasteboardWriter: SidebarDrag.pasteboardItem([row]))
        item.setDraggingFrame(bounds, contents: snapshot())
        beginDraggingSession(with: [item], event: event, source: self)
    }
    override func mouseUp(with event: NSEvent) {
        defer { pressAt = nil }
        guard pressAt != nil, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick?(event)
        if event.clickCount == 2 { onDoubleClick?(event) }
    }
    override func rightMouseDown(with event: NSEvent) { onContextMenu?(event) }
    override func accessibilityPerformPress() -> Bool {
        if let event = NSEvent.mouseEvent(with: .leftMouseUp, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window?.windowNumber ?? 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0) { onClick?(event) }
        return true
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }

    private func snapshot() -> NSImage {
        let image = NSImage(size: bounds.size)
        if let rep = bitmapImageRepForCachingDisplay(in: bounds) { cacheDisplay(in: bounds, to: rep); image.addRepresentation(rep) }
        return image
    }

    // MARK: the flash (@keyframes added: #e6f0fd → transparent, 1600 ms ease-out)

    private func startFlash() {
        flashStart = Date()
        flashTimer?.invalidate()
        flashTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self, let start = self.flashStart else { timer.invalidate(); return }
                if Date().timeIntervalSince(start) >= self.flashDuration { self.flashStart = nil; timer.invalidate() }
                self.needsDisplay = true
            }
        }
    }
    /// How much of the flash is left (1 → 0, ease-out).
    var flashLeft: CGFloat {
        guard let start = flashStart else { return 0 }
        let t = min(1, Date().timeIntervalSince(start) / flashDuration)
        return CGFloat(1 - (1 - pow(1 - t, 2)))
    }

    // MARK: layout and drawing

    var padLeft: CGFloat { look.padLeft ?? (look.indent ? 10 : 8) }
    var padRight: CGFloat { 6 }
    var textFont: NSFont {
        let size = look.size ?? (look.style == .section ? SB.headSize : look.indent ? SB.indentSize : SB.rowSize)
        let strong = look.active || look.holds
        return Fonts.sans(size, weight: look.style == .section ? 500 : strong ? 500 : 400)
    }
    var textColor: NSColor {
        if let c = look.color { return c }
        switch look.style {
        case .more: return hovered ? Palette.gray700 : Palette.fnt
        case .section: return hovered ? Palette.gray700 : Palette.fnt
        default: break
        }
        if look.faint { return SB.faint }
        if look.active || look.holds { return Palette.ink }
        return look.indent ? Palette.gray700 : SB.text
    }
    /// Where the label starts.
    var labelX: CGFloat { padLeft + (!look.indent && look.icon != nil && look.style == .row ? SB.ICON + 10 : 0) + (look.style == .more ? 0 : 0) }
    /// The right edge of the label's room.
    var accessoriesMinX: CGFloat { accessories.filter { !$0.isHidden || ($0 as? SBView)?.revealOnHover == true }.map(\.frame.minX).min() ?? bounds.width - padRight }

    override func layout() {
        super.layout()
        var x = bounds.width - padRight
        for view in accessories.reversed() {
            let size = view.frame.size
            x -= size.width
            view.frame = CGRect(x: x, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
            x -= accessoryGap
        }
        if let field = renameField {
            let left = labelX
            field.frame = CGRect(x: left, y: (bounds.height - 20) / 2, width: max(20, accessoriesMinX - 6 - left), height: 20)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        // the fill: hover #efefef, active #e6e6e6 (hover #e0e0e0); the flash over it
        if look.style == .row || look.style == .more {
            if look.active { fill(bounds, hovered ? SB.activeHover : SB.active, radius: 6) }
            else if hovered && !look.noHover && look.style == .row { fill(bounds, SB.hover, radius: 6) }
            let left = flashLeft
            if left > 0 { fill(bounds, SB.flash.withAlphaComponent(left), radius: 6) }
        }
        if let icon = look.icon, !look.indent, look.style == .row {
            let box = CGRect(x: padLeft, y: (bounds.height - SB.ICON) / 2, width: SB.ICON, height: SB.ICON)
            let side = look.iconSize
            drawIcon(icon, in: CGRect(x: box.midX - side / 2, y: box.midY - side / 2, width: side, height: side), color: look.active ? Palette.ink : SB.icon)
            if iconPlus {
                let font = Fonts.sans(16)
                let w = textWidth("+", font: font)
                let r = CGRect(x: box.maxX + 3 - w, y: box.maxY + 2 - 12, width: w, height: 12)
                SB.bg.setFill(); r.fill()
                drawText("+", in: r, font: font, color: SB.icon, align: .center)
            }
        }
        guard renameField == nil else { return }
        let font = textFont
        let room = accessoriesMinX - 6 - labelX
        switch look.style {
        case .more:
            let dots = "..."
            let w = drawText(dots, in: CGRect(x: labelX, y: 0, width: 30, height: bounds.height), font: font, color: textColor)
            drawText("More", in: CGRect(x: labelX + w + 4, y: 0, width: max(0, room - w - 4), height: bounds.height), font: font, color: textColor)
        case .section:
            let w = drawText(look.label, in: CGRect(x: labelX, y: 0, width: max(0, room - 18), height: bounds.height), font: font, color: textColor)
            if let open = look.sectionOpen {
                let side: CGFloat = 13
                drawIcon(stroked(SidebarIcons.chevronDown, 2.4), in: CGRect(x: labelX + w + 5, y: (bounds.height - side) / 2, width: side, height: side),
                         color: hovered ? Palette.gray700 : SB.chev, rotated: !open)
            }
        default:
            drawText(look.label, in: CGRect(x: labelX, y: 0, width: max(0, room), height: bounds.height), font: font, color: textColor)
        }
    }

    /// The label as drawn (tests read it).
    override func accessibilityValue() -> Any? { look.label }
}

/// What a drag of sidebar rows carries (model/mention.js writeLibDrag): their ids and names under LIB_DRAG_TYPE, and their
/// mentions as plain text for anywhere else they are let go.
public enum SidebarDrag {
    /// mention.js's LIB_DRAG_TYPE, as the Editor's drop reads it.
    public static let type = NSPasteboard.PasteboardType(Mention.LIB_DRAG_TYPE)
    /// The same rows under a uniform type identifier: a MIME-style type ("application/x-engelbart-lib") does not survive
    /// NSPasteboard (a cloud run found the data gone), so the rows also travel under this one (API.md, Needs: Doc/Editor).
    public static let uti = NSPasteboard.PasteboardType("com.mathetic.engelbart.lib-rows")

    public static func pasteboardItem(_ rows: [LibraryRow]) -> NSPasteboardItem {
        let item = NSPasteboardItem()
        let list = rows.filter { !$0.id.isEmpty }.map { row -> [String: Any] in
            ["id": row.id, "name": row.name, "type": row.type, "url": row.url ?? NSNull(), "path": row.path ?? NSNull(), "folder_path": row.folderPath ?? NSNull()]
        }
        if let data = try? JSONSerialization.data(withJSONObject: list) { item.setData(data, forType: uti); item.setData(data, forType: type) }
        item.setString(rows.map { Mention.rowMention($0.lib) }.joined(separator: " "), forType: .string)
        return item
    }

    /// Whether a drag carries sidebar rows (they are refused on the sidebar itself).
    public static func carriesRows(_ pasteboard: NSPasteboard) -> Bool { (pasteboard.types ?? []).contains { $0 == type || $0 == uti } }
    /// The rows a drop of the sidebar's carries ([] when none).
    public static func rows(_ pasteboard: NSPasteboard) -> [[String: Any]] {
        guard let data = pasteboard.data(forType: uti) ?? pasteboard.data(forType: type) else { return [] }
        return (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
    }
}

/// A plain text line (No projects yet, the library's size, ⌘J).
final class SBLabel: SBView {
    var text: String { didSet { needsDisplay = true } }
    var font: NSFont
    var color: NSColor
    var hoverFill: NSColor?
    var tabular = false
    var action: (() -> Void)?
    var onHoverChange: ((SBLabel, Bool) -> Void)?
    private var hovered = false
    private var area: NSTrackingArea?
    init(_ text: String, font: NSFont, color: NSColor, id: String? = nil) {
        self.text = text; self.font = font; self.color = color
        super.init(frame: .zero)
        if let id { setAccessibilityIdentifier(id) }
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(text)
    }
    required init?(coder: NSCoder) { fatalError() }
    func sizeToText(padX: CGFloat = 0, height: CGFloat = 16) { frame.size = CGSize(width: textWidth(text, font: font) + 2 * padX, height: height) }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard action != nil || onHoverChange != nil else { return }
        if let area { removeTrackingArea(area) }
        let a = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(a); area = a
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true; onHoverChange?(self, true) }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true; onHoverChange?(self, false) }
    override func mouseDown(with event: NSEvent) { if action == nil { super.mouseDown(with: event) } }
    override func mouseUp(with event: NSEvent) { if let action, bounds.contains(convert(event.locationInWindow, from: nil)) { onHoverChange?(self, false); action() } }
    override func draw(_ dirtyRect: NSRect) {
        if hovered, let hoverFill { fill(bounds, hoverFill, radius: 4) }
        drawText(text, in: bounds, font: font, color: color, align: .center, tabular: tabular)
    }
}
