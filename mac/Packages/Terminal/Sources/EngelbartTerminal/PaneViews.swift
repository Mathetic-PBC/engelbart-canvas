import AppKit
import EngelbartUI

// The Terminal pane's chrome, drawn as TerminalPane.jsx and ui/FluidTab.jsx draw it (1 CSS px = 1 pt). Plain AppKit
// views with manual layout in flipped coordinates; colours and fonts from EngelbartUI (TerminalTheme for the two hover
// greys Palette lacks).

// MARK: - drawing helpers

class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

enum Text {
    static func attributed(_ string: String, font: NSFont, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color])
    }

    static func width(_ string: NSAttributedString) -> CGFloat { ceil(string.size().width) }

    /// The font's own line height (what NSAttributedString draws in).
    static func naturalHeight(_ font: NSFont) -> CGFloat { ceil(font.ascender - font.descender + font.leading) }

    /// Draws `string` vertically centred in a CSS line box of `lineHeight` whose top is `top`.
    static func draw(_ string: NSAttributedString, x: CGFloat, top: CGFloat, lineHeight: CGFloat, width: CGFloat? = nil) {
        let font = string.attribute(.font, at: 0, effectiveRange: nil) as? NSFont ?? Fonts.sans(13)
        let y = top + (lineHeight - naturalHeight(font)) / 2
        let w = width ?? (Text.width(string) + 1)
        string.draw(with: NSRect(x: x, y: y, width: w, height: naturalHeight(font) + 2), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    /// Draws `string` in `rect`; when it does not fit, it fades out over its last 18 pt (FluidTab TabTitle).
    static func drawFading(_ string: NSAttributedString, in rect: NSRect, lineHeight: CGFloat) -> Bool {
        let clipped = width(string) > rect.width + 1
        guard let context = NSGraphicsContext.current?.cgContext else { return clipped }
        context.saveGState()
        context.clip(to: rect)
        if clipped {
            context.beginTransparencyLayer(auxiliaryInfo: nil)
            draw(string, x: rect.minX, top: rect.minY + (rect.height - lineHeight) / 2, lineHeight: lineHeight, width: width(string) + 1)
            let fade = min(18, rect.width)
            let colors = [NSColor.black.withAlphaComponent(0).cgColor, NSColor.black.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                context.setBlendMode(.destinationOut)
                context.clip(to: NSRect(x: rect.maxX - fade, y: rect.minY, width: fade, height: rect.height))
                context.drawLinearGradient(gradient, start: CGPoint(x: rect.maxX - fade, y: 0), end: CGPoint(x: rect.maxX, y: 0), options: [])
            }
            context.endTransparencyLayer()
        } else {
            draw(string, x: rect.minX, top: rect.minY + (rect.height - lineHeight) / 2, lineHeight: lineHeight)
        }
        context.restoreGState()
        return clipped
    }
}

/// A view that tracks the pointer and draws itself from `hovered` (the CSS `.hov-*` classes).
class HoverView: FlippedView {
    var hovered = false { didSet { if hovered != oldValue { needsDisplay = true; hoverChanged() } } }
    var pointer: NSCursor? = .pointingHand

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func resetCursorRects() { if let pointer { addCursorRect(bounds, cursor: pointer) } }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    func hoverChanged() {}
}

/// A button drawn by `paint`; `action` on a left click (mouse up inside).
final class PaneButton: HoverView {
    var action: (() -> Void)?
    var enabled = true { didSet { needsDisplay = true; window?.invalidateCursorRects(for: self) } }
    var paint: (PaneButton, NSRect) -> Void = { _, _ in }
    private var pressedInside = false

    init(tooltip: String? = nil, paint: @escaping (PaneButton, NSRect) -> Void) {
        self.paint = paint
        super.init(frame: .zero)
        toolTip = tooltip
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) { paint(self, bounds) }
    override func resetCursorRects() { if enabled { addCursorRect(bounds, cursor: .pointingHand) } }

    override func mouseDown(with event: NSEvent) { pressedInside = enabled }
    override func mouseUp(with event: NSEvent) {
        defer { pressedInside = false }
        guard pressedInside, enabled, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        action?()
    }
}

func roundedFill(_ rect: NSRect, radius: CGFloat, color: NSColor) {
    color.setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

func roundedStroke(_ rect: NSRect, radius: CGFloat, color: NSColor) {
    color.setStroke()
    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: radius - 0.5, yRadius: radius - 0.5)
    path.lineWidth = 1
    path.stroke()
}

/// ui/Icons.jsx Expand / Collapse: 16 × 16, stroke #171717 1.7, round caps and joins.
enum PaneIcons {
    static func drawExpand(in rect: NSRect) { stroke(rect, [[(9.3, 2.5), (13.5, 2.5), (13.5, 6.7)], [(13.5, 2.5), (9, 7)], [(6.7, 13.5), (2.5, 13.5), (2.5, 9.3)], [(2.5, 13.5), (7, 9)]]) }
    static func drawCollapse(in rect: NSRect) { stroke(rect, [[(13.5, 2.5), (9.5, 6.5)], [(9.5, 3.3), (9.5, 6.5), (12.7, 6.5)], [(2.5, 13.5), (6.5, 9.5)], [(6.5, 12.7), (6.5, 9.5), (3.3, 9.5)]]) }

    private static func stroke(_ rect: NSRect, _ lines: [[(CGFloat, CGFloat)]]) {
        let path = NSBezierPath()
        for line in lines {
            guard let first = line.first else { continue }
            path.move(to: NSPoint(x: rect.minX + first.0, y: rect.minY + first.1))
            for point in line.dropFirst() { path.line(to: NSPoint(x: rect.minX + point.0, y: rect.minY + point.1)) }
        }
        path.lineWidth = 1.7
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        Palette.ink.setStroke()
        path.stroke()
    }
}

// MARK: - tabs (FluidTab)

/// What a tab shows.
struct TabModel: Equatable {
    var id: String
    var title: String
    var on: Bool
    var separator: Bool
    var closeLabel: String
    var closeTooltip: String
}

final class TabView: HoverView {
    static let maxWidth: CGFloat = 220
    static let minWidth: CGFloat = 44
    static let height: CGFloat = 34

    var model: TabModel { didSet { if model != oldValue { needsDisplay = true; close.toolTip = model.closeTooltip; close.setAccessibilityLabel(model.closeLabel) } } }
    var onActivate: (() -> Void)?
    var onClose: (() -> Void)?
    var onHover: ((Bool) -> Void)?
    let close: PaneButton
    private(set) var titleClipped = false

    static let glyphFont = Fonts.mono(11)
    static let titleFont = Fonts.sans(12.5)

    init(model: TabModel) {
        self.model = model
        close = PaneButton { button, rect in
            if button.hovered && button.enabled { roundedFill(rect, radius: rect.width / 2, color: TerminalTheme.closeHover) }
            let mark = Text.attributed("×", font: Fonts.sans(14), color: button.hovered ? Palette.ink : Palette.fnt)
            Text.draw(mark, x: rect.midX - Text.width(mark) / 2, top: rect.minY, lineHeight: rect.height)
        }
        super.init(frame: .zero)
        pointer = nil
        close.toolTip = model.closeTooltip
        close.setAccessibilityLabel(model.closeLabel)
        close.action = { [weak self] in self?.onClose?() }
        addSubview(close)
        setAccessibilityRole(.radioButton)
    }

    required init?(coder: NSCoder) { fatalError() }

    var glyph: NSAttributedString { Text.attributed("›_", font: Self.glyphFont, color: model.on ? Palette.mut : Palette.fnt) }
    var title: NSAttributedString { Text.attributed(model.title, font: Self.titleFont, color: model.on ? Palette.ink : Palette.mut) }

    /// Its width with the whole title shown, within 44…220.
    var naturalWidth: CGFloat {
        let content = Text.width(glyph) + 8 + Text.width(title) + 8 + 20
        let chrome: CGFloat = model.on ? 12 + 6 : 2 + 10 + 4 + 2
        return max(Self.minWidth, min(Self.maxWidth, content + chrome))
    }

    /// The inner box: the front tab's whole height; another's inset 2 at the sides and 4 at the foot.
    var inner: NSRect { model.on ? bounds : NSRect(x: 2, y: 0, width: bounds.width - 4, height: bounds.height - 4) }

    override func layout() {
        super.layout()
        let box = inner
        close.frame = NSRect(x: box.maxX - (model.on ? 6 : 4) - 20, y: box.midY - 10, width: 20, height: 20)
    }

    override func draw(_ dirtyRect: NSRect) {
        let box = inner
        if !model.on && hovered { roundedFill(box, radius: 8, color: TerminalTheme.tabHover) }
        let left = box.minX + (model.on ? 12 : 10)
        let glyphWidth = Text.width(glyph)
        Text.draw(glyph, x: left, top: box.midY - 6, lineHeight: 12)
        let titleX = left + glyphWidth + 8
        let titleRect = NSRect(x: titleX, y: box.midY - 9, width: max(0, close.frame.minX - 8 - titleX), height: 18)
        titleClipped = Text.drawFading(title, in: titleRect, lineHeight: 12.5 * 1.3)
        if model.separator {
            Palette.bd2.setFill()
            NSRect(x: bounds.maxX - 1, y: 9, width: 1, height: 16).fill()
        }
    }

    override func mouseDown(with event: NSEvent) { onActivate?() }
    override func hoverChanged() { onHover?(hovered) }
    override func accessibilityLabel() -> String? { model.title }
    override func accessibilityValue() -> Any? { model.on }
}

/// The strip above the transcript: tabs, +, the "Terminal ⌄" menu button, the full-screen arrows.
final class TabStripView: FlippedView {
    static let height: CGFloat = 40
    var tabs: [TabView] = []
    let plus: PaneButton
    let agentButton: PaneButton
    let fullButton: PaneButton
    var agentLabel = "Terminal" { didSet { if agentLabel != oldValue { agentButton.needsDisplay = true; needsLayout = true } } }
    var menuOpen = false { didSet { agentButton.needsDisplay = true } }
    var fullScreen = false { didSet { fullButton.needsDisplay = true; fullButton.toolTip = fullScreen ? "Exit full screen" : "Full screen" } }
    var showsFull = false { didSet { fullButton.isHidden = !showsFull; needsLayout = true } }

    override init(frame: NSRect) {
        plus = PaneButton(tooltip: "New terminal (⌘T) in the project's code directory") { button, rect in
            if button.hovered { roundedFill(rect, radius: rect.width / 2, color: TerminalTheme.tabHover) }
            let mark = Text.attributed("+", font: Fonts.sans(18), color: button.hovered ? Palette.ink : Palette.mut)
            Text.draw(mark, x: rect.midX - Text.width(mark) / 2, top: rect.minY, lineHeight: rect.height)
        }
        plus.setAccessibilityLabel("New terminal")
        agentButton = PaneButton(tooltip: "Terminal, Claude Code or Codex — started in this tab's directory") { _, _ in }
        fullButton = PaneButton(tooltip: "Full screen") { _, _ in }
        super.init(frame: frame)
        agentButton.paint = { [weak self] button, rect in
            guard let self else { return }
            if self.menuOpen { roundedFill(rect, radius: 6, color: Palette.gray200) } else if button.hovered { roundedFill(rect, radius: 6, color: Palette.hov) }
            let label = Text.attributed(self.agentLabel, font: Fonts.sans(12.5, weight: 500), color: Palette.ink)
            Text.draw(label, x: 8, top: 4, lineHeight: 12.5 * 1.3)
            let chevron = Text.attributed("⌄", font: Fonts.sans(10), color: Palette.fnt)
            Text.draw(chevron, x: 8 + Text.width(label) + 6, top: 4, lineHeight: 12.5 * 1.3)
        }
        fullButton.paint = { [weak self] button, rect in
            if button.hovered { roundedFill(rect, radius: 6, color: Palette.gray200) }
            let icon = NSRect(x: rect.midX - 8, y: rect.midY - 8, width: 16, height: 16)
            if self?.fullScreen == true { PaneIcons.drawCollapse(in: icon) } else { PaneIcons.drawExpand(in: icon) }
        }
        fullButton.isHidden = true
        [plus, agentButton, fullButton].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError() }

    var agentButtonWidth: CGFloat {
        let label = Text.attributed(agentLabel, font: Fonts.sans(12.5, weight: 500), color: Palette.ink)
        let chevron = Text.attributed("⌄", font: Fonts.sans(10), color: Palette.fnt)
        return 8 + Text.width(label) + 6 + Text.width(chevron) + 8
    }

    func setTabs(_ views: [TabView]) {
        for tab in tabs where !views.contains(where: { $0 === tab }) { tab.removeFromSuperview() }
        for tab in views where tab.superview !== self { addSubview(tab, positioned: .below, relativeTo: plus) }
        tabs = views
        needsLayout = true
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        let agentW = agentButtonWidth
        let agentH = 12.5 * 1.3 + 8
        var right = width - 8
        if showsFull {
            fullButton.frame = NSRect(x: right - 28, y: 7, width: 28, height: 28)
            right -= 28 + 4
        }
        agentButton.frame = NSRect(x: right - agentW, y: (Self.height - agentH) / 2, width: agentW, height: agentH)
        // The tabs shrink together (flex 0 1 auto, by their natural widths) so + and the menu always fit.
        let available = max(0, agentButton.frame.minX - 10 - 6 - 28 - 4)
        let natural = tabs.map(\.naturalWidth)
        let total = natural.reduce(0, +)
        let scale = total > available && total > 0 ? available / total : 1
        var x: CGFloat = 10
        for (tab, w) in zip(tabs, natural) {
            let tabW = max(TabView.minWidth, floor(w * scale))
            tab.frame = NSRect(x: x, y: Self.height - TabView.height, width: tabW, height: TabView.height)
            tab.needsLayout = true
            x += tabW
        }
        plus.frame = NSRect(x: x + 6, y: 7, width: 28, height: 28)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        Palette.panel2.setFill() // #fafafa
        bounds.fill()
        // The tab in front: white, its top corners rounded 10, running into the transcript, its foot flaring out.
        guard let front = tabs.first(where: { $0.model.on }) else { return }
        let r = front.frame
        let path = NSBezierPath()
        path.move(to: NSPoint(x: r.minX, y: r.maxY))
        path.line(to: NSPoint(x: r.minX, y: r.minY + 10))
        path.appendArc(withCenter: NSPoint(x: r.minX + 10, y: r.minY + 10), radius: 10, startAngle: 180, endAngle: 270)
        path.line(to: NSPoint(x: r.maxX - 10, y: r.minY))
        path.appendArc(withCenter: NSPoint(x: r.maxX - 10, y: r.minY + 10), radius: 10, startAngle: 270, endAngle: 360)
        path.line(to: NSPoint(x: r.maxX, y: r.maxY))
        path.close()
        // Feet: a 10 × 10 square at each bottom corner with a quarter circle (radius 10, centred on its outer top corner) cut out.
        let left = NSBezierPath()
        left.move(to: NSPoint(x: r.minX - 10, y: r.maxY))
        left.appendArc(withCenter: NSPoint(x: r.minX - 10, y: r.maxY - 10), radius: 10, startAngle: 90, endAngle: 0, clockwise: true)
        left.line(to: NSPoint(x: r.minX, y: r.maxY))
        left.close()
        let right = NSBezierPath()
        right.move(to: NSPoint(x: r.maxX + 10, y: r.maxY))
        right.appendArc(withCenter: NSPoint(x: r.maxX + 10, y: r.maxY - 10), radius: 10, startAngle: 90, endAngle: 180, clockwise: false)
        right.line(to: NSPoint(x: r.maxX, y: r.maxY))
        right.close()
        Palette.gray0.setFill()
        path.fill(); left.fill(); right.fill()
    }
}

// MARK: - overlays (the menu and the tab card)

/// A borderless child window over everything in the window (the Electron overlays needed `data-overlay` to sit over the
/// Stage's native views; a child window does that natively).
final class OverlayPanel: NSPanel {
    init(content: NSView) {
        super.init(contentRect: NSRect(origin: .zero, size: content.frame.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        contentView = content
    }
    override var canBecomeKey: Bool { false }

    /// Shows the panel with its bottom-left at `origin` (window base coordinates), rising 6 pt over 160 ms as the CSS
    /// `rise` animation does.
    func show(over window: NSWindow, origin: NSPoint) {
        let screen = window.convertPoint(toScreen: origin)
        setFrameOrigin(NSPoint(x: screen.x, y: screen.y - 6))
        alphaValue = 0
        if parent == nil { window.addChildWindow(self, ordered: .above) }
        orderFront(nil)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.25, 0.1, 0.25, 1)
            animator().alphaValue = 1
            animator().setFrameOrigin(screen)
        }
    }

    func hide() {
        parent?.removeChildWindow(self)
        orderOut(nil)
    }
}

/// The card a tab shows after a moment under the pointer: its agent and its directory (FluidTab useTabCard / TabCard).
final class TabCard {
    static let cardMs = 0.65
    private var timer: DispatchWorkItem?
    private var cool: DispatchWorkItem?
    private var warm = false
    private(set) var shownId: String?
    private var panel: OverlayPanel?

    func enter(tab: NSView, id: String, content: @escaping () -> (title: String, detail: String?)) {
        timer?.cancel()
        let work = DispatchWorkItem { [weak self, weak tab] in
            guard let self, let tab, let window = tab.window else { return }
            self.warm = true
            self.show(id: id, below: tab, in: window, content: content())
        }
        timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (warm ? 0.06 : Self.cardMs), execute: work)
    }

    func leave() {
        timer?.cancel()
        hidePanel()
        cool?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.warm = false }
        cool = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    func hide() { timer?.cancel(); hidePanel() }

    private func hidePanel() { panel?.hide(); panel = nil; shownId = nil }

    private func show(id: String, below tab: NSView, in window: NSWindow, content: (title: String, detail: String?)) {
        hidePanel()
        let width: CGFloat = 260
        let titleText = Text.attributed(content.title, font: Fonts.sans(13, weight: 500), color: Palette.ink)
        let detailText = content.detail.map { Text.attributed($0, font: Fonts.sans(12), color: Palette.fnt) }
        let inner = width - 24
        let titleH = ceil(titleText.boundingRect(with: NSSize(width: inner, height: 1000), options: [.usesLineFragmentOrigin]).height)
        let detailH = detailText.map { ceil($0.boundingRect(with: NSSize(width: inner, height: 1000), options: [.usesLineFragmentOrigin]).height) } ?? 0
        let height = 10 + titleH + (detailText != nil ? 3 + detailH : 0) + 10
        let view = CardView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        view.title = titleText
        view.detail = detailText
        view.titleHeight = titleH
        let panel = OverlayPanel(content: view)
        panel.ignoresMouseEvents = true // pointer-events: none
        let rect = tab.convert(tab.bounds, to: nil) // window base coordinates: y up
        let windowWidth = window.frame.width
        let left = max(8, min(rect.minX + 4, windowWidth - width - 8))
        panel.show(over: window, origin: NSPoint(x: left, y: rect.minY - 6 - height)) // 6 below the tab
        self.panel = panel
        shownId = id
    }

    final class CardView: FlippedView {
        var title = NSAttributedString()
        var detail: NSAttributedString?
        var titleHeight: CGFloat = 0
        override func draw(_ dirtyRect: NSRect) {
            roundedFill(bounds, radius: 8, color: Palette.panel)
            roundedStroke(bounds, radius: 8, color: Palette.bd2)
            title.draw(with: NSRect(x: 12, y: 10, width: bounds.width - 24, height: titleHeight + 2), options: [.usesLineFragmentOrigin])
            detail?.draw(with: NSRect(x: 12, y: 10 + titleHeight + 3, width: bounds.width - 24, height: bounds.height), options: [.usesLineFragmentOrigin])
        }
    }
}

/// The agent menu under "Terminal ⌄": Terminal / Claude Code / Codex.
final class AgentMenu {
    struct Item { var id: String; var label: String; var available: Bool; var current: Bool; var tooltip: String }
    private var panel: OverlayPanel?
    private var monitor: Any?
    var isOpen: Bool { panel != nil }
    var onClose: (() -> Void)?

    /// `anchor`: the menu button. `ignore`: a press there does not close the menu (the button toggles it itself).
    func open(items: [Item], anchor: NSView, pick: @escaping (String) -> Void) {
        close()
        guard let window = anchor.window else { return }
        let width: CGFloat = 200
        let rowH = 7 + 13 * 1.4 + 7
        let height = 1 + 4 + rowH * CGFloat(items.count) + 4 + 1
        let content = FlippedView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        let background = MenuBackground(frame: content.bounds)
        content.addSubview(background)
        for (index, item) in items.enumerated() {
            let row = MenuRow(item: item)
            row.frame = NSRect(x: 5, y: 5 + CGFloat(index) * rowH, width: width - 10, height: rowH)
            row.onPick = { [weak self] in
                guard item.available else { return }
                self?.close()
                pick(item.id)
            }
            content.addSubview(row)
        }
        let panel = OverlayPanel(content: content)
        let button = anchor.convert(anchor.bounds, to: nil) // window base coordinates: y up
        let windowWidth = window.frame.width
        let left = max(8, min(button.maxX - width, windowWidth - width - 8))
        panel.show(over: window, origin: NSPoint(x: left, y: button.minY - 6 - height)) // right-aligned, 6 below the button
        self.panel = panel
        // Closes on a press anywhere else (but the button, which toggles it).
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self, weak anchor] event in
            guard let self, let panel = self.panel else { return event }
            if event.window === panel { return event }
            if let anchor, event.window === anchor.window, anchor.bounds.contains(anchor.convert(event.locationInWindow, from: nil)) { return event }
            self.close()
            return event
        }
    }

    func close() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        let wasOpen = panel != nil
        panel?.hide()
        panel = nil
        if wasOpen { onClose?() }
    }

    final class MenuBackground: FlippedView {
        override func draw(_ dirtyRect: NSRect) {
            roundedFill(bounds, radius: 8, color: Palette.panel)
            roundedStroke(bounds, radius: 8, color: Palette.bd)
        }
    }

    final class MenuRow: HoverView {
        let item: Item
        var onPick: (() -> Void)?
        init(item: Item) {
            self.item = item
            super.init(frame: .zero)
            pointer = item.available ? .pointingHand : nil
            toolTip = item.tooltip
            setAccessibilityRole(.menuItem)
            setAccessibilityLabel(item.label)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func draw(_ dirtyRect: NSRect) {
            if hovered && item.available { roundedFill(bounds, radius: 6, color: Palette.hov) }
            let color = item.available ? Palette.ink : Palette.bd2
            if item.current {
                let check = Text.attributed("✓", font: Fonts.sans(12), color: color)
                Text.draw(check, x: 10 + (14 - Text.width(check)) / 2, top: 7, lineHeight: 13 * 1.4)
            }
            let label = Text.attributed(item.label, font: Fonts.sans(13, weight: item.current ? 500 : 400), color: color)
            Text.draw(label, x: 10 + 14 + 10, top: 7, lineHeight: 13 * 1.4)
            if !item.available {
                let note = Text.attributed("not installed", font: Fonts.sans(10), color: Palette.bd2)
                Text.draw(note, x: bounds.width - 10 - Text.width(note), top: 7, lineHeight: 13 * 1.4)
            }
        }
        override func mouseDown(with event: NSEvent) {}
        override func mouseUp(with event: NSEvent) { if bounds.contains(convert(event.locationInWindow, from: nil)) { onPick?() } }
    }
}

// MARK: - footer

/// The "Run commands" box: mono 12.5, caret #0070f3, no spelling or substitutions (it holds shell commands).
final class RunCommandsField: NSTextField {
    var onFocus: (() -> Void)?

    init() {
        super.init(frame: .zero)
        isBordered = false
        isBezeled = false
        drawsBackground = false
        focusRingType = .none
        font = Fonts.mono(12.5)
        textColor = Palette.ink
        usesSingleLineMode = true
        cell?.wraps = false
        cell?.isScrollable = true
        lineBreakMode = .byClipping
        placeholderAttributedString = Text.attributed("Run commands", font: Fonts.mono(12.5), color: Palette.fnt)
        setAccessibilityLabel("Terminal input")
    }

    required init?(coder: NSCoder) { fatalError() }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became, let editor = currentEditor() as? NSTextView {
            editor.insertionPointColor = Palette.acc
            editor.isContinuousSpellCheckingEnabled = false
            editor.isAutomaticSpellingCorrectionEnabled = false
            editor.isAutomaticQuoteSubstitutionEnabled = false
            editor.isAutomaticDashSubstitutionEnabled = false
            editor.isAutomaticTextReplacementEnabled = false
            editor.isAutomaticLinkDetectionEnabled = false
            editor.isGrammarCheckingEnabled = false
            onFocus?()
        }
        return became
    }
}

/// The bar under the transcript: the agent chip, the directory chip, and the box (or the line that keeps its place).
final class FooterView: FlippedView {
    static let chipFont = Fonts.mono(11.5, weight: 500)
    static let cwdFont = Fonts.mono(11.5)
    static let lineHeight: CGFloat = 12.5 * 1.7

    /// box: the input; line: a line of the same height in its place; none: a conversation's footer (chips alone, 10 below);
    /// empty: no session (chips, 12 below).
    enum Bottom: Equatable { case box, line(String), none, empty }

    var agentLabel = "Terminal" { didSet { if agentLabel != oldValue { agentChip.needsDisplay = true; needsLayout = true } } }
    var cwd = "~" { didSet { if cwd != oldValue { cwdChip.needsDisplay = true; needsLayout = true } } }
    var bottom: Bottom = .box { didSet { if bottom != oldValue { applyBottom(); needsLayout = true } } }
    let agentChip = FlippedView()
    let cwdChip: PaneButton
    let field = RunCommandsField()
    let line = NSTextField(labelWithString: "")

    var preferredHeight: CGFloat {
        let chips = 1 + 3 + 11.5 * 1.4 + 3 + 1
        switch bottom {
        case .none: return 1 + 10 + chips + 10
        case .empty: return 1 + 10 + chips + 12
        default: return 1 + 10 + chips + 10 + 2 + Self.lineHeight + 2 + 12
        }
    }

    override init(frame: NSRect) {
        cwdChip = PaneButton(tooltip: "Change working directory…") { _, _ in }
        super.init(frame: frame)
        cwdChip.paint = { [weak self] button, rect in
            guard let self else { return }
            roundedFill(rect, radius: 6, color: Palette.gray0)
            roundedStroke(rect, radius: 6, color: button.hovered && button.enabled ? Palette.bd2 : Palette.bd)
            let mark = Text.attributed("▭", font: Self.cwdFont, color: Palette.fnt)
            Text.draw(mark, x: 9, top: 4, lineHeight: 11.5 * 1.4)
            let pathX = 9 + Text.width(mark) + 6
            let path = NSAttributedString(string: self.cwd, attributes: [.font: Self.cwdFont, .foregroundColor: Palette.mut,
                                                                         .paragraphStyle: { let p = NSMutableParagraphStyle(); p.lineBreakMode = .byTruncatingTail; return p }()])
            let font = Self.cwdFont
            let y = 4 + (11.5 * 1.4 - Text.naturalHeight(font)) / 2
            path.draw(with: NSRect(x: pathX, y: y, width: max(0, rect.width - pathX - 9), height: Text.naturalHeight(font)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
        cwdChip.setAccessibilityRole(.button)
        line.font = Fonts.mono(12.5)
        line.textColor = Palette.fnt
        line.lineBreakMode = .byTruncatingTail
        line.drawsBackground = false
        line.isBordered = false
        [agentChip, cwdChip, field, line].forEach(addSubview)
        applyBottom()
    }

    required init?(coder: NSCoder) { fatalError() }

    var agentChipWidth: CGFloat {
        let mark = Text.attributed("›_", font: Self.chipFont, color: Palette.fnt)
        let label = Text.attributed(agentLabel, font: Self.chipFont, color: Palette.ink)
        return 1 + 8 + Text.width(mark) + 6 + Text.width(label) + 8 + 1
    }

    var cwdChipWidth: CGFloat {
        let mark = Text.attributed("▭", font: Self.cwdFont, color: Palette.fnt)
        let path = Text.attributed(cwd, font: Self.cwdFont, color: Palette.mut)
        return 1 + 8 + Text.width(mark) + 6 + Text.width(path) + 8 + 1
    }

    private func applyBottom() {
        switch bottom {
        case .box: field.isHidden = false; line.isHidden = true
        case .line(let text): field.isHidden = true; line.isHidden = false; line.stringValue = text
        case .none, .empty: field.isHidden = true; line.isHidden = true
        }
    }

    override func layout() {
        super.layout()
        let chipH = 1 + 3 + 11.5 * 1.4 + 3 + 1
        let top: CGFloat = 1 + 10
        let agentW = agentChipWidth
        agentChip.frame = NSRect(x: 14, y: top, width: agentW, height: chipH)
        let cwdX = 14 + agentW + 6
        cwdChip.frame = NSRect(x: cwdX, y: top, width: max(0, min(cwdChipWidth, bounds.width - 14 - cwdX)), height: chipH)
        let rowTop = top + chipH + 10
        let fieldH = Text.naturalHeight(Fonts.mono(12.5)) + 2
        let rowRect = NSRect(x: 14, y: rowTop, width: max(0, bounds.width - 28), height: 2 + Self.lineHeight + 2)
        field.frame = NSRect(x: rowRect.minX - 2, y: rowRect.midY - fieldH / 2, width: rowRect.width + 2, height: fieldH)
        line.frame = NSRect(x: rowRect.minX, y: rowRect.midY - fieldH / 2, width: rowRect.width, height: fieldH)
        agentChip.needsDisplay = true
        cwdChip.needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        Palette.panel2.setFill()
        bounds.fill()
        Palette.bd.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill() // border-top: 1px solid #eaeaea (as the CSS has it)
        // The agent chip (static).
        let chip = agentChip.frame
        roundedFill(chip, radius: 6, color: Palette.gray0)
        roundedStroke(chip, radius: 6, color: Palette.bd)
        let mark = Text.attributed("›_", font: Self.chipFont, color: Palette.fnt)
        Text.draw(mark, x: chip.minX + 9, top: chip.minY + 4, lineHeight: 11.5 * 1.4)
        let label = Text.attributed(agentLabel, font: Self.chipFont, color: Palette.ink)
        Text.draw(label, x: chip.minX + 9 + Text.width(mark) + 6, top: chip.minY + 4, lineHeight: 11.5 * 1.4)
    }
}
