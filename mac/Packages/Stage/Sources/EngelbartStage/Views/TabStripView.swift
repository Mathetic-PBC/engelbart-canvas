import AppKit
import EngelbartUI

// The Stage's tab strip (Stage.jsx, Chrome's, 2026-10-18): 40 tall on the header's grey (#fafafa). The tab in front is
// white with 10pt top corners curving into the address row below; the rest have no box, a grey wash under the pointer,
// and thin dividers between them. Each tab's width comes from the room the strip has (StageModel.tabWidth): 220 while
// there is room, an equal share when not, 36 at least, and the strip scrolls past that (sideways wheel, fades at the
// scrolled edges, the tab in front scrolled into sight). Below 90 a tab drops its title (tabLook). A tab closed by mouse
// leaves the others as wide as they were until the pointer leaves the strip. Middle click closes; right click offers
// Close tab, Close other tabs, Close tabs to the right. A card with the title and the site or path shows after 650 ms on
// a tab (60 ms while moving along the strip). + makes a tab (dim at 15); the full-screen arrows sit at the right.

struct StripTab: Equatable {
    var id: String
    var title: String
    var place: String
    var glyph: String
    var blank: Bool
}

final class TabStripView: FlippedView {
    var onSelect: ((String) -> Void)?
    var onClose: ((String) -> Void)?
    var onNew: (() -> Void)?
    var onFull: (() -> Void)?
    var onMenu: ((String, NSPoint) -> Void)?

    var tabs: [StripTab] = [] { didSet { if tabs.count > oldValue.count { frozen = nil }; rebuild() } }
    var activeId: String? { didSet { rebuild(); scrollFrontIntoSight() } }
    var full = false { didSet { fullButton.image = (full ? KindIcons.collapse : KindIcons.expand).image(size: 16); fullButton.toolTip = full ? "Exit full screen" : "Full screen" } }
    var showsFull = false { didSet { needsLayout = true } }

    private let scroll = NSScrollView()
    private let row = FlippedView()
    private let plus = TextButton("+", size: 18, color: Palette.mut, radius: 14)
    private let fullButton = NSButton()
    private var frozen: CGFloat?
    private var tracking: NSTrackingArea?
    private var cells: [TabCell] = []
    private let card = FlippedView()
    private let cardTitle = makeLabel("", size: 13, weight: 500, lines: 0)
    private let cardPlace = makeLabel("", size: 12, color: Palette.fnt, lines: 0)
    private var hoverTimer: Timer?
    private var warm = false
    private var warmTimer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        fill = Palette.panel2
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false; scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .none; scroll.verticalScrollElasticity = .none
        scroll.documentView = row
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        addSubview(scroll)
        plus.onClick = { [weak self] in self?.onNew?() }
        plus.toolTip = "⌘T"
        addSubview(plus)
        fullButton.isBordered = false
        fullButton.image = KindIcons.expand.image(size: 16)
        fullButton.contentTintColor = Palette.ink
        fullButton.target = self; fullButton.action = #selector(fullPressed)
        addSubview(fullButton)
        card.fill = Palette.panel
        card.layer?.cornerRadius = 8; card.layer?.borderWidth = 1; card.layer?.borderColor = Palette.bd2.cgColor
        card.addSubview(cardTitle); card.addSubview(cardPlace)
        card.isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    @objc private func fullPressed() { hideCard(); onFull?() }

    /// The px the strip has for tabs: its width less its padding (10 + 8), the + (28, 6 each side), the full-screen (28).
    var room: CGFloat { bounds.width - 18 - 40 - (showsFull ? 28 : 0) }
    var tabWidth: CGFloat { frozen ?? StageModel.tabWidth(room: room, count: tabs.count) }

    func freeze() { frozen = tabWidth }

    private func rebuild() {
        for c in cells { c.removeFromSuperview() }
        cells = tabs.enumerated().map { i, tab in
            let on = tab.id == activeId
            let next = i + 1 < tabs.count ? tabs[i + 1].id : nil
            let cell = TabCell(tab: tab, on: on, separator: !on && next != nil && next != activeId)
            cell.onSelect = { [weak self] in self?.onSelect?(tab.id) }
            cell.onClose = { [weak self] in self?.freeze(); self?.onClose?(tab.id) }
            cell.onMenu = { [weak self] p in self?.hideCard(); self?.onMenu?(tab.id, p) }
            cell.onHover = { [weak self] inside, cell in self?.hover(inside ? cell : nil) }
            row.addSubview(cell)
            return cell
        }
        let addFull = tabs.count >= StageModel.maxTabs
        plus.isEnabled = !addFull
        plus.alphaValue = addFull ? 0.4 : 1
        plus.toolTip = addFull ? "15 tabs is the most — close one first" : "⌘T"
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let w = tabWidth
        for (i, cell) in cells.enumerated() {
            cell.frame = NSRect(x: 10 + CGFloat(i) * w, y: 6, width: w, height: 34)
            cell.look = StageModel.tabLook(width: w, active: cell.on)
            cell.crowded = w < StageModel.tabIconSideW
            cell.needsLayout = true
        }
        let content = CGFloat(cells.count) * w + 20
        row.frame = NSRect(x: 0, y: 0, width: content, height: 40)
        let tabsRoom = max(0, min(content, bounds.width - 8 - 40 - (showsFull ? 28 : 0)))
        scroll.frame = NSRect(x: 0, y: 0, width: tabsRoom, height: 40)
        plus.frame = NSRect(x: tabsRoom + 6, y: 8, width: 28, height: 28)
        fullButton.isHidden = !showsFull
        fullButton.frame = NSRect(x: bounds.width - 8 - 28, y: 8, width: 28, height: 28)
        fades()
    }

    private func scrollFrontIntoSight() {
        guard let i = tabs.firstIndex(where: { $0.id == activeId }) else { return }
        layoutSubtreeIfNeeded()
        let w = tabWidth, margin: CGFloat = 28
        let left = 10 + CGFloat(i) * w, clip = scroll.contentView.bounds
        var x = clip.minX
        if left - margin < clip.minX { x = left - margin } else if left + w + margin > clip.maxX { x = left + w + margin - clip.width }
        x = max(0, min(x, row.frame.width - clip.width))
        if x != clip.minX { scroll.contentView.scroll(to: NSPoint(x: x, y: 0)); scroll.reflectScrolledClipView(scroll.contentView) }
    }

    /// A mouse wheel scrolls the tabs sideways; a trackpad's sideways swipe and shift+wheel already do.
    override func scrollWheel(with event: NSEvent) {
        guard row.frame.width > scroll.frame.width else { return }
        let delta = abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX) && !event.modifierFlags.contains(.shift) ? event.scrollingDeltaY : event.scrollingDeltaX
        let clip = scroll.contentView.bounds
        let x = max(0, min(clip.minX - delta, row.frame.width - clip.width))
        scroll.contentView.scroll(to: NSPoint(x: x, y: 0)); scroll.reflectScrolledClipView(scroll.contentView)
    }

    @objc private func scrolled() { fades(); hideCard() }

    /// Tabs scrolled out of sight fade at that edge (28).
    private func fades() {
        let clip = scroll.contentView.bounds
        let left = clip.minX > 1, right = clip.maxX < row.frame.width - 1
        guard left || right else { scroll.layer?.mask = nil; return }
        scroll.wantsLayer = true
        let mask = CAGradientLayer()
        mask.frame = scroll.bounds
        mask.startPoint = CGPoint(x: 0, y: 0.5); mask.endPoint = CGPoint(x: 1, y: 0.5)
        let f = 28 / max(1, scroll.bounds.width)
        mask.colors = [left ? NSColor.clear.cgColor : NSColor.black.cgColor, NSColor.black.cgColor, NSColor.black.cgColor, right ? NSColor.clear.cgColor : NSColor.black.cgColor]
        mask.locations = [0, NSNumber(value: Double(f)), NSNumber(value: Double(1 - f)), 1]
        scroll.layer?.mask = mask
    }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
        super.updateTrackingAreas()
    }
    /// The pointer leaving the strip lays the tabs out again (a close by mouse froze their width).
    override func mouseExited(with event: NSEvent) { if frozen != nil { frozen = nil; needsLayout = true } }

    // ------------------------------------------------------------------------------------------------ hover card

    private func hover(_ cell: TabCell?) {
        hoverTimer?.invalidate()
        guard let cell, !cell.on || cell.look != .full else {
            hideCard()
            warmTimer?.invalidate()
            warmTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.warm = false } }
            return
        }
        hoverTimer = Timer.scheduledTimer(withTimeInterval: warm ? 0.06 : 0.65, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.warm = true; self?.showCard(cell) }
        }
    }

    private func showCard(_ cell: TabCell) {
        guard let host = superview else { return }
        let width = max(160, min(260, bounds.width - 16))
        let r = cell.convert(cell.bounds, to: self)
        let left = max(8, min(r.minX + 4, bounds.width - 8 - width))
        cardTitle.stringValue = cell.tab.title
        cardPlace.stringValue = cell.tab.place
        cardTitle.preferredMaxLayoutWidth = width - 24; cardPlace.preferredMaxLayoutWidth = width - 24
        let th = cardTitle.intrinsicContentSize.height, ph = cell.tab.place.isEmpty ? 0 : cardPlace.intrinsicContentSize.height
        cardTitle.frame = NSRect(x: 12, y: 10, width: width - 24, height: th)
        cardPlace.frame = NSRect(x: 12, y: 10 + th + 3, width: width - 24, height: ph)
        let origin = host.convert(NSPoint(x: left, y: bounds.height + 6), from: self)
        card.frame = NSRect(x: origin.x, y: host.isFlipped ? origin.y : origin.y - (th + ph + 23), width: width, height: th + ph + 23)
        if card.superview !== host { host.addSubview(card, positioned: .above, relativeTo: nil) }
        card.isHidden = false
    }

    func hideCard() { hoverTimer?.invalidate(); card.isHidden = true }
}

/// One tab in the strip.
final class TabCell: FlippedView {
    let tab: StripTab
    let on: Bool
    let separator: Bool
    var look: StageModel.TabLook = .full
    var crowded = false
    var onSelect: (() -> Void)?
    var onClose: (() -> Void)?
    var onMenu: ((NSPoint) -> Void)?
    var onHover: ((Bool, TabCell) -> Void)?
    private let glyph = NSImageView()
    private let title = makeLabel("", size: 12.5)
    private let close = TextButton("×", size: 14, color: Palette.fnt, radius: 10)
    private var inside = false
    private var tracking: NSTrackingArea?

    init(tab: StripTab, on: Bool, separator: Bool) {
        self.tab = tab; self.on = on; self.separator = separator
        super.init(frame: .zero)
        wantsLayer = true
        glyph.image = KindIcons.kind(tab.glyph).icon.image(size: KindIcons.glyphSize(tab.glyph))
        glyph.contentTintColor = on ? Palette.mut : Palette.fnt
        title.stringValue = tab.title
        title.textColor = tab.blank ? Palette.fnt : on ? Palette.ink : Palette.mut
        close.toolTip = "⌘W"
        close.setAccessibilityLabel("Close tab")
        close.onClick = { [weak self] in self?.onClose?() }
        for v in [glyph, title, close] { addSubview(v) }
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let h = bounds.height, w = bounds.width
        let narrow = look != .full
        title.isHidden = narrow
        glyph.isHidden = look == .x || (look == .icon && crowded && inside)
        close.isHidden = look == .icon && !inside
        switch look {
        case .full:
            let inset: CGFloat = on ? 12 : 12
            glyph.frame = NSRect(x: inset, y: (h - 16) / 2 - (on ? 0 : 2), width: 16, height: 16)
            close.frame = NSRect(x: w - 26 - (on ? 0 : 2), y: (h - 20) / 2 - (on ? 0 : 2), width: 20, height: 20)
            title.frame = NSRect(x: glyph.frame.maxX + 8, y: (h - 17) / 2 - (on ? 0 : 2), width: max(0, close.frame.minX - glyph.frame.maxX - 8), height: 17)
            fadeTitle()
        case .iconX:
            glyph.frame = NSRect(x: w / 2 - 20, y: (h - 16) / 2, width: 16, height: 16)
            close.frame = NSRect(x: w / 2, y: (h - 20) / 2, width: 20, height: 20)
        case .x:
            close.frame = NSRect(x: w - 26, y: (h - 20) / 2, width: 20, height: 20)
        case .icon:
            // the × at the tab's right edge under the pointer, the icon moved left beside it (2026-10-23)
            let shift = inside ? min(0, 14 - (w - 4) / 2) : 0
            glyph.frame = NSRect(x: (w - 16) / 2 + shift, y: (h - 16) / 2 - 2, width: 16, height: 16)
            close.frame = NSRect(x: w - 2 - 3 - 20, y: (h - 20) / 2 - 2, width: 20, height: 20)
        }
        needsDisplay = true
    }

    /// The title fades out over its last 22 points.
    private func fadeTitle() {
        title.wantsLayer = true
        let mask = CAGradientLayer()
        mask.frame = title.bounds
        mask.startPoint = CGPoint(x: 0, y: 0.5); mask.endPoint = CGPoint(x: 1, y: 0.5)
        mask.colors = [NSColor.black.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
        let stop = max(0, (title.bounds.width - 22) / max(1, title.bounds.width))
        mask.locations = [0, NSNumber(value: Double(stop)), 1]
        title.layer?.mask = mask
    }

    override func draw(_ dirtyRect: NSRect) {
        if on {
            let body = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height + 10), xRadius: 10, yRadius: 10)
            NSColor.white.setFill(); body.fill()
            // the curves into the address row at each foot
            for (x, flip) in [(-10.0, false), (bounds.width, true)] {
                let p = NSBezierPath()
                let corner = NSRect(x: x, y: bounds.height - 10, width: 10, height: 10)
                p.move(to: NSPoint(x: flip ? corner.minX : corner.maxX, y: corner.minY))
                p.appendArc(withCenter: NSPoint(x: flip ? corner.maxX : corner.minX, y: corner.minY), radius: 10, startAngle: flip ? 180 : 0, endAngle: 90, clockwise: !flip)
                p.line(to: NSPoint(x: flip ? corner.minX : corner.maxX, y: corner.maxY))
                p.close()
                NSColor.white.setFill(); p.fill()
            }
        } else if inside {
            Palette.hov.setFill()
            NSBezierPath(roundedRect: NSRect(x: 2, y: 0, width: bounds.width - 4, height: bounds.height - 4), xRadius: 8, yRadius: 8).fill()
        }
        if separator { Palette.bd2.setFill(); NSRect(x: bounds.width - 1, y: 9, width: 1, height: 16).fill() }
    }

    override var wantsDefaultClipping: Bool { false }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { inside = true; needsLayout = true; onHover?(true, self) }
    override func mouseExited(with event: NSEvent) { inside = false; needsLayout = true; onHover?(false, self) }
    override func mouseDown(with event: NSEvent) { onSelect?() }
    override func otherMouseDown(with event: NSEvent) { }
    override func otherMouseUp(with event: NSEvent) { if event.buttonNumber == 2 { onClose?() } }
    override func rightMouseDown(with event: NSEvent) { onMenu?(convert(event.locationInWindow, from: nil)) }
}
