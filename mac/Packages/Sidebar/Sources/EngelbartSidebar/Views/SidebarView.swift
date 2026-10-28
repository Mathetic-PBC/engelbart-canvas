import AppKit
import EngelbartDoc
import EngelbartUI

// The aside (Rail.jsx): a column `width` wide, padding 0 8, on #fafafa: the head (36), the scrolling middle (fixed rows,
// Projects, Sources; no scroll bar: scrollbarWidth none), and the foot (margin 6 0 10). Hidden, it is not drawn and keeps
// everything as it is.

final class SidebarRootView: NSView {
    override var isFlipped: Bool { true }
    override func isAccessibilityElement() -> Bool { true }
    let head = HeadView()
    let scroll = NSScrollView()
    let list = SidebarListView()
    let foot = FootView()
    /// Files, pictures or links dropped on Sources (the controller decides).
    var onDrop: ((NSDraggingInfo) -> Bool)?
    var onDragOver: ((NSDraggingInfo?) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("sidebar")
        setAccessibilityRole(.group)
        setAccessibilityLabel("Sidebar")
        addSubview(head)
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        scroll.documentView = list
        scroll.contentView.postsBoundsChangedNotifications = true
        addSubview(scroll)
        addSubview(foot)
        // Anywhere on the sidebar a sidebar row is refused; on Sources, files and links are taken.
        registerForDraggedTypes([SidebarDrag.type, SidebarDrag.uti, .fileURL, .URL, .html, .string, .png, .tiff])
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        SB.bg.setFill()
        bounds.fill()
    }

    static let headHeight: CGFloat = 36
    static let footHeight: CGFloat = SB.LINE + 6 + 10

    override func layout() {
        super.layout()
        let w = bounds.width
        head.frame = CGRect(x: 8, y: 0, width: max(0, w - 16), height: Self.headHeight)
        foot.frame = CGRect(x: 8, y: bounds.height - 10 - SB.LINE, width: max(0, w - 16), height: SB.LINE)
        scroll.frame = CGRect(x: 8, y: Self.headHeight, width: max(0, w - 16), height: max(0, bounds.height - Self.headHeight - Self.footHeight))
        list.frame.size.width = scroll.frame.width
        list.minHeight = scroll.frame.height
        list.needsLayout = true
    }

    // MARK: drops (MATH-19)

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { dragOperation(sender) }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { dragOperation(sender) }
    override func draggingExited(_ sender: NSDraggingInfo?) { onDragOver?(nil) }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        onDragOver?(nil)
        guard dragOperation(sender) != [] else { return false }
        return onDrop?(sender) ?? false
    }
    func dragOperation(_ sender: NSDraggingInfo) -> NSDragOperation {
        if SidebarDrag.carriesRows(sender.draggingPasteboard) { onDragOver?(nil); return [] }
        let p = list.convert(sender.draggingLocation, from: nil)
        guard p.y >= list.sourcesTop, onDrop != nil else { onDragOver?(nil); return [] }
        onDragOver?(sender)
        return .copy
    }
}

/// The scrolling middle: rows placed by the controller; it draws the guide lines and the drop ring.
final class SidebarListView: NSView {
    override var isFlipped: Bool { true }
    /// Guide lines (1px #dcdcdc), in this view's coordinates.
    var guides: [CGRect] = [] { didSet { needsDisplay = true } }
    /// Where Sources starts (drops are taken below it).
    var sourcesTop: CGFloat = .greatestFiniteMagnitude
    /// While files are over Sources: a 2px #c9c9c9 inset ring round it (radius 8).
    var dropping = false { didSet { needsDisplay = true } }
    var contentHeight: CGFloat = 0
    var minHeight: CGFloat = 0
    override func layout() {
        super.layout()
        let h = max(contentHeight, minHeight)
        if frame.height != h { frame.size.height = h }
    }
    override func draw(_ dirtyRect: NSRect) {
        SB.guide.setFill()
        for g in guides { g.fill() }
        if dropping {
            let r = CGRect(x: 0, y: sourcesTop, width: bounds.width, height: max(0, bounds.height - sourcesTop)).insetBy(dx: 1, dy: 1)
            SB.dropRing.setStroke()
            let path = NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8); path.lineWidth = 2; path.stroke()
        }
    }
}

/// The head: the top-level project's name (or its rename field), then Settings and New note.
final class HeadView: NSView {
    override var isFlipped: Bool { true }
    let project = HeadButton()
    let settings = SBIconButton(icon: SidebarIcons.gear, size: 18, box: CGSize(width: 28, height: 28), color: SB.icon, hoverColor: Palette.ink, hoverFill: SB.headOpen, radius: 6, label: "Settings", id: "sb-settings")
    let newNote = SBIconButton(icon: SidebarIcons.compose, size: 18, box: CGSize(width: 28, height: 28), color: SB.icon, hoverColor: Palette.ink, hoverFill: SB.headOpen, radius: 6, label: "New note", id: "sb-new-note")
    /// The rename box (white, 1px #c9c9c9, radius 6) holding the field, while the name is renamed.
    var renameBox: NSView? { didSet { oldValue?.removeFromSuperview(); if let b = renameBox { addSubview(b) }; project.isHidden = renameBox != nil; needsLayout = true } }
    override init(frame: NSRect) {
        super.init(frame: frame)
        settings.toolTip = "Settings"; newNote.toolTip = "New note"
        addSubview(project); addSubview(settings); addSubview(newNote)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        let y = (bounds.height - 28) / 2
        newNote.frame.origin = CGPoint(x: bounds.width - 28, y: y)
        settings.frame.origin = CGPoint(x: bounds.width - 28 - 2 - 28, y: y)
        let room = settings.frame.minX - 4 - 2
        if let box = renameBox {
            box.frame = CGRect(x: 0, y: (bounds.height - 30) / 2, width: max(40, room), height: 30)
        } else {
            project.frame = CGRect(x: 0, y: (bounds.height - 30) / 2, width: min(project.fittingWidth, max(40, room)), height: 30)
        }
    }
}

/// The project's name and its chevron (which never turns), in a 30-high button (padding 0 8, radius 6, gap 6).
final class HeadButton: SBView {
    var name = "" { didSet { needsDisplay = true; toolTip = name; setAccessibilityLabel(name); superview?.needsLayout = true } }
    var on = false { didSet { needsDisplay = true } }
    var action: ((HeadButton) -> Void)?
    private var hovered = false
    private var area: NSTrackingArea?
    static let font = Fonts.sans(15, weight: 600)
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("sb-trigger=project")
        setAccessibilityRole(.popUpButton)
    }
    required init?(coder: NSCoder) { fatalError() }
    var fittingWidth: CGFloat { 8 + textWidth(name, font: Self.font) + 6 + 14 + 8 }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let a = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(a); area = a
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) { if bounds.contains(convert(event.locationInWindow, from: nil)) { action?(self) } }
    override func accessibilityPerformPress() -> Bool { action?(self); return true }
    override func draw(_ dirtyRect: NSRect) {
        if on || hovered { fill(bounds, SB.headOpen, radius: 6) }
        let chevron: CGFloat = 14
        let textRoom = bounds.width - 8 - 6 - chevron - 8
        let w = drawText(name, in: CGRect(x: 8, y: 0, width: max(0, textRoom), height: bounds.height), font: Self.font, color: Palette.ink)
        drawIcon(stroked(SidebarIcons.chevronDown, 2.4), in: CGRect(x: 8 + w + 6, y: (bounds.height - chevron) / 2, width: chevron, height: chevron), color: SB.chev)
    }
}

/// The foot: the stickies' switch and, while it holds something, the trash; while a sticky is dragged, the drop target.
final class FootView: NSView {
    override var isFlipped: Bool { true }
    override func isAccessibilityElement() -> Bool { true }
    var dragging: StickyDrag? = nil { didSet { needsDisplay = true; needsLayout = true; toggle.isHidden = dragging?.active == true; trash.isHidden = dragging?.active == true || !trashShown } }
    var trashShown = false { didSet { trash.isHidden = !trashShown || dragging?.active == true; needsLayout = true } }
    let toggle = SBRowView(look: SBRowView.Look(), id: "toggle-post-its")
    let trash = SBIconButton(icon: SidebarIcons.trash, size: 16, box: CGSize(width: 22, height: 22), color: Palette.fnt, hoverColor: Palette.ink, hoverFill: SB.addHover, radius: 5, label: "Trash", id: "sb-trash")
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("sb-foot")
        trash.toolTip = "Trash"
        addSubview(toggle); addSubview(trash)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        let trashW: CGFloat = trash.isHidden ? 0 : 22 + 2
        toggle.frame = CGRect(x: 0, y: 0, width: bounds.width - trashW, height: bounds.height)
        trash.frame.origin = CGPoint(x: bounds.width - 22, y: (bounds.height - 22) / 2)
    }
    override func draw(_ dirtyRect: NSRect) {
        guard let drag = dragging, drag.active else { return }
        let path = NSBezierPath(roundedRect: bounds, xRadius: 7, yRadius: 7)
        (drag.over ? SB.footOver : SB.footDrag).setFill(); path.fill()
        let inner = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6.5, yRadius: 6.5)
        SB.footRing.setStroke(); inner.lineWidth = 1; inner.stroke()
        drawIcon(SidebarIcons.trash, in: CGRect(x: 8, y: (bounds.height - 18) / 2, width: 18, height: 18), color: Palette.gray700)
        drawText("Drop here to throw it away", in: CGRect(x: 8 + 18 + 10, y: 0, width: bounds.width - 44, height: bounds.height), font: Fonts.sans(14.5), color: Palette.gray700)
    }
}

/// A name typed in place (RenameField): Enter or leaving it keeps it, Escape keeps the old one; / and \ become -.
final class RenameField: NSTextField, NSTextFieldDelegate {
    let initial: String
    var onDone: ((String?) -> Void)?
    private var finished = false
    init(initial: String, font: NSFont) {
        self.initial = initial
        super.init(frame: .zero)
        stringValue = initial
        self.font = font
        textColor = Palette.ink
        isBordered = false; drawsBackground = false; focusRingType = .none
        cell?.isScrollable = true; cell?.wraps = false
        delegate = self
        setAccessibilityIdentifier("rename")
    }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window === window, !self.finished else { return }
            if window.makeFirstResponder(self) { self.currentEditor()?.selectAll(nil) }
        }
    }
    func finish(_ keep: Bool) {
        guard !finished else { return }
        finished = true
        let next = stringValue.trimmed
        onDone?(keep && !next.isEmpty && next != initial ? next : nil)
    }
    func controlTextDidChange(_ obj: Notification) {
        let clean = NameDialogModel.clean(stringValue)
        if clean != stringValue { stringValue = clean }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) { finish(true); return true }
        if selector == #selector(NSResponder.cancelOperation(_:)) { finish(false); return true }
        return false
    }
    func controlTextDidEndEditing(_ obj: Notification) { finish(true) }
}
