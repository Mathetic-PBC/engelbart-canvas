import AppKit
import Combine
import SwiftUI
import EngelbartUI
import EngelbartDoc

/// The document tabs over the middle canvas (workspace/DocTabs.jsx, drawn as the Stage's tabs: ui/FluidTab.jsx). Workspace
/// first, bold, its icon before its name, no ×; every other tab closes. A note tab drags as a browser tab does: it follows
/// the pointer along the strip, its neighbours slide out of the way as its leading edge passes their middle, and it
/// settles into the gap on release. Workspace stays first and nothing moves past it.
final class DocTabsView: NSView {
    static let slide: TimeInterval = 0.16
    static let threshold: CGFloat = 4 // px of travel before a press becomes a drag

    var onSelect: (String) -> Void = { _ in }
    var onClose: (String) -> Void = { _ in }
    var onMove: (String, String) -> Void = { _, _ in }

    private(set) var tabs: [DocTab] = []
    private(set) var active = WorkspaceTabs.ws
    private var wsName = ""
    private(set) var views: [String: DocTabView] = [:]
    /// Where each tab sat at the last layout (FLIP).
    private var slots: [String: CGRect] = [:]
    private var drag: (id: String, startX: CGFloat, x: CGFloat, moved: Bool)?
    let card = TabCardTimer()
    private var cardPanel: FloatingPanel?
    private var cardSub: AnyCancellable?

    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        cardSub = card.$card.sink { [weak self] c in DispatchQueue.main.async { MainActor.assumeIsolated { self?.showCard(c) } } }
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The tabs as the screen has them (the project page's titled with the project's name).
    func update(tabs next: [DocTab], active: String, wsName: String) {
        let changed = next != tabs || active != self.active || wsName != self.wsName
        guard changed else { return }
        tabs = next; self.active = active; self.wsName = wsName
        for id in views.keys where !next.contains(where: { $0.id == id }) { views[id]?.removeFromSuperview(); views[id] = nil }
        for (i, tab) in next.enumerated() {
            let v = views[tab.id] ?? { let v = DocTabView(strip: self, id: tab.id); addSubview(v); views[tab.id] = v; return v }()
            v.title = tab.id == WorkspaceTabs.ws ? Names.wsLabel(wsName) : tab.title
            v.toolTip = tab.id == WorkspaceTabs.ws && !wsName.isEmpty ? wsName : nil
            v.on = tab.id == active
            v.sep = tab.id != active && i + 1 < next.count && next[i + 1].id != active
            v.untitled = tab.id != WorkspaceTabs.ws && Names.isUntitled(tab.title)
        }
        needsLayout = true
        needsDisplay = true
    }

    // MARK: widths

    /// What the tabs would take with room for all: each as long as its title, 44 to 220.
    var naturalWidth: CGFloat { tabs.map { views[$0.id]?.naturalWidth ?? FluidTabMetrics.min }.reduce(0, +) }

    /// CSS flex-shrink 1 on each tab's natural width, never below 44.
    static func shrink(_ natural: [CGFloat], into room: CGFloat) -> [CGFloat] {
        var widths = natural
        var frozen = natural.map { $0 <= FluidTabMetrics.min }
        for _ in 0..<natural.count + 1 {
            let over = widths.reduce(0, +) - room
            guard over > 0.5 else { break }
            let basis = zip(natural, frozen).filter { !$0.1 }.map(\.0).reduce(0, +)
            guard basis > 0 else { break }
            var again = false
            for i in widths.indices where !frozen[i] {
                let w = widths[i] - over * natural[i] / basis
                if w <= FluidTabMetrics.min { widths[i] = FluidTabMetrics.min; frozen[i] = true; again = true } else { widths[i] = w }
            }
            if !again { break }
        }
        return widths.map { $0.rounded() }
    }

    override func layout() {
        super.layout()
        let widths = Self.shrink(tabs.map { views[$0.id]?.naturalWidth ?? FluidTabMetrics.min }, into: bounds.width)
        var x: CGFloat = 0
        var next: [String: CGRect] = [:]
        for (i, tab) in tabs.enumerated() {
            let rect = CGRect(x: x, y: bounds.height - FluidTabMetrics.height, width: widths[i], height: FluidTabMetrics.height)
            next[tab.id] = rect
            x += widths[i]
        }
        let old = slots
        slots = next
        for tab in tabs {
            guard let v = views[tab.id], let rect = next[tab.id] else { continue }
            if let d = drag, d.id == tab.id {
                // its slot moved under it: the start is rebased so it stays under the pointer
                if let before = old[tab.id], before.minX != rect.minX { drag?.startX += rect.minX - before.minX }
                v.frame = rect
                if d.moved { place() }
                continue
            }
            if let before = old[tab.id], before.minX != rect.minX, drag?.moved == true {
                // every other tab that changed slot slides there from where it was
                v.frame = before
                NSAnimationContext.runAnimationGroup { ctx in ctx.duration = Self.slide; ctx.timingFunction = Look.ease; v.animator().frame = rect }
            } else { v.frame = rect }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        // The tab in front: white, its top corners rounded 10, its feet flaring onto the page (FluidTab's radial gradients).
        guard let v = views[active], v.superview === self else { return }
        let r = v.frame
        NSColor.white.setFill()
        FillView.rounded(r, (10, 10, 0, 0)).fill()
        for (left, cx) in [(r.minX - 10, r.minX - 10), (r.maxX, r.maxX + 10)] {
            let foot = NSBezierPath(rect: CGRect(x: left, y: r.maxY - 10, width: 10, height: 10))
            foot.append(NSBezierPath(ovalIn: CGRect(x: cx - 10, y: r.maxY - 20, width: 20, height: 20)))
            foot.windingRule = .evenOdd
            NSGraphicsContext.current?.saveGraphicsState()
            NSBezierPath(rect: CGRect(x: left, y: r.maxY - 10, width: 10, height: 10)).addClip()
            foot.fill()
            NSGraphicsContext.current?.restoreGraphicsState()
        }
    }

    // MARK: dragging (DocTabs.jsx onPointerDown/Move/End)

    func pressed(_ id: String, at x: CGFloat) {
        card.hide()
        if id != WorkspaceTabs.ws { drag = (id, x, x, false) }
        onSelect(id)
    }

    func dragged(to x: CGFloat) {
        guard var d = drag else { return }
        d.x = x
        if !d.moved {
            if abs(d.x - d.startX) < Self.threshold { drag = d; return }
            d.moved = true
            views[d.id]?.lifted = true
        }
        drag = d
        guard let el = views[d.id], let dx = place() else { return }
        // A neighbour gives way once the dragged tab's leading edge passes its middle.
        let left = el.frame.minX + dx, right = left + el.frame.width
        guard let index = tabs.firstIndex(where: { $0.id == d.id }) else { return }
        let next = index + 1 < tabs.count ? views[tabs[index + 1].id] : nil
        let prev = index > 0 && tabs[index - 1].id != WorkspaceTabs.ws ? views[tabs[index - 1].id] : nil // nothing moves past Workspace
        if let next, right > next.frame.minX + next.frame.width / 2 { onMove(d.id, tabs[index + 1].id) }
        else if let prev, left < prev.frame.minX + prev.frame.width / 2 { onMove(d.id, tabs[index - 1].id) }
    }

    /// The dragged tab under the pointer, between the end of Workspace (+2) and the end of the last tab → its offset.
    @discardableResult
    func place() -> CGFloat? {
        guard let d = drag, let el = views[d.id], let slot = slots[d.id] else { return nil }
        let ws = views[WorkspaceTabs.ws].map { $0.frame.maxX + 2 } ?? 0
        let last = tabs.last.flatMap { slots[$0.id] } ?? slot
        let minX = ws - slot.minX
        let maxX = last.maxX - slot.width - slot.minX
        let dx = max(minX, min(max(minX, maxX), d.x - d.startX))
        el.setFrameOrigin(NSPoint(x: slot.minX + dx, y: slot.minY))
        needsDisplay = true
        return dx
    }

    func released() {
        guard let d = drag else { return }
        drag = nil
        guard let el = views[d.id], let slot = slots[d.id] else { return }
        el.lifted = false
        if d.moved { NSAnimationContext.runAnimationGroup { ctx in ctx.duration = Self.slide; ctx.timingFunction = Look.ease; el.animator().frame = slot } }
        else { el.frame = slot }
    }
    var dragging: String? { drag?.moved == true ? drag?.id : nil }

    // MARK: the card (FluidTab useTabCard)

    func hover(_ id: String, entered: Bool) {
        guard let v = views[id] else { return }
        if entered {
            guard !v.on, id != WorkspaceTabs.ws, drag == nil else { return }
            card.enter(id: id, rect: v.convert(v.bounds, to: nil), windowWidth: window?.frame.width ?? 1200)
        } else { card.leave() }
    }

    private func showCard(_ c: TabCardTimer.Card?) {
        cardPanel?.close(); cardPanel = nil
        guard let c, let window, let tab = tabs.first(where: { $0.id == c.id }), let v = views[c.id] else { return }
        let panel = FloatingPanel()
        let anchor = FloatingPanel.anchorRect(of: v)
        panel.show(in: window, anchor: anchor, options: .passive(side: .below, gap: 6, width: TabCardTimer.width)) {
            TabCardView(title: tab.title, detail: tab.id == WorkspaceTabs.project ? "Project page" : "Note")
        }
        cardPanel = panel
    }
    var cardShown: Bool { cardPanel?.isOpen ?? false }
}

/// One tab (FluidTab): white and running into the page in front (the strip draws that), boxless behind with a hover wash
/// (#e6e6e6) and a hairline between two neither of which is in front.
final class DocTabView: NSView {
    weak var strip: DocTabsView?
    let id: String
    var title = "" { didSet { if title != oldValue { needsDisplay = true; setAccessibilityLabel(title) } } }
    var on = false { didSet { if on != oldValue { needsDisplay = true; closeButton?.color = Look.fnt } } }
    var sep = false { didSet { if sep != oldValue { needsDisplay = true } } }
    var lifted = false { didSet { needsDisplay = true } }
    var untitled = false { didSet { needsDisplay = true } }
    var hovering = false { didSet { needsDisplay = true } }
    var closeButton: FlatButton?
    var tracking: NSTrackingArea?
    var isWs: Bool { id == WorkspaceTabs.ws }
    var isProject: Bool { id == WorkspaceTabs.project }

    init(strip: DocTabsView, id: String) {
        self.strip = strip; self.id = id
        super.init(frame: .zero)
        setAccessibilityIdentifier("doc-tab=\(id)")
        setAccessibilityRole(.radioButton)
        if !isWs {
            let x = FlatButton(.text("×", font: Fonts.sans(14)), color: Look.fnt, hoverColor: Look.ink, hoverFill: Look.xHover, radius: 10, id: "doc-tab-close=\(id)", tip: "Close") { [weak self] in
                guard let self else { return }
                self.strip?.onClose(self.id)
            }
            addSubview(x)
            closeButton = x
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var titleFont: NSFont { Fonts.sans(12.5, weight: isWs ? 600 : 400) }
    var hasIcon: Bool { isWs || isProject }
    /// As long as its title (and icon and ×), 44 to 220.
    var naturalWidth: CGFloat {
        let text = ceil((title as NSString).size(withAttributes: [.font: titleFont]).width)
        let icon: CGFloat = hasIcon ? 14 + 8 : 0
        let close: CGFloat = isWs ? 0 : 8 + 20
        let pad: CGFloat = on ? 12 + 6 : 2 + 10 + 4 + 2
        return min(FluidTabMetrics.max, max(FluidTabMetrics.min, text + icon + close + pad))
    }
    /// Where the content sits: in front padding 0 6 0 12; behind margin 0 2 4 and padding 0 4 0 10.
    var content: CGRect { on ? CGRect(x: 12, y: 0, width: bounds.width - 18, height: bounds.height) : CGRect(x: 12, y: 0, width: bounds.width - 18, height: bounds.height - 4) }

    override func layout() {
        super.layout()
        let c = content
        closeButton?.frame = CGRect(x: c.maxX - 20, y: (c.midY - 10).rounded(), width: 20, height: 20)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; strip?.hover(id, entered: true) }
    override func mouseExited(with event: NSEvent) { hovering = false; strip?.hover(id, entered: false) }
    override func mouseDown(with event: NSEvent) { strip?.pressed(id, at: event.locationInWindow.x) }
    override func mouseDragged(with event: NSEvent) { strip?.dragged(to: event.locationInWindow.x) }
    override func mouseUp(with event: NSEvent) { strip?.released() }
    override func accessibilityPerformPress() -> Bool { strip?.onSelect(id); return true }

    override func draw(_ dirtyRect: NSRect) {
        if !on && (hovering || lifted) {
            (lifted ? Look.tabHover : Look.tabHover).setFill()
            NSBezierPath(roundedRect: CGRect(x: 2, y: 0, width: bounds.width - 4, height: bounds.height - 4), xRadius: 8, yRadius: 8).fill()
        }
        if sep { Look.bd2.setFill(); CGRect(x: bounds.width - 1, y: 9, width: 1, height: 16).fill() }
        let c = content
        var x = c.minX
        if hasIcon, let ctx = NSGraphicsContext.current?.cgContext {
            ctx.saveGState()
            ctx.translateBy(x: x, y: (c.midY - 7).rounded())
            (isWs ? KindIcons.workspace : SidebarIcons.project).draw(in: ctx, side: 14, color: (on ? Look.mut : Look.fnt).cgColor)
            ctx.restoreGState()
            x += 14 + 8
        }
        let color = untitled ? Look.fnt : (on || isWs) ? Look.ink : Look.mut
        let attrs: [NSAttributedString.Key: Any] = [.font: titleFont, .foregroundColor: color]
        let size = (title as NSString).size(withAttributes: attrs)
        let room = c.maxX - x - (isWs ? 0 : 28)
        let at = NSPoint(x: x, y: (c.midY - size.height / 2).rounded())
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.clip(to: CGRect(x: x, y: 0, width: max(0, room), height: bounds.height))
        if size.width > room + 1 {
            // A name fades out at the tab's end only when the tab is too short for it (FluidTab TabTitle).
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            (title as NSString).draw(at: at, withAttributes: attrs)
            let fade = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [NSColor.black.withAlphaComponent(0).cgColor, NSColor.black.cgColor] as CFArray, locations: [0, 1])!
            ctx.setBlendMode(.destinationOut)
            ctx.drawLinearGradient(fade, start: CGPoint(x: x + room - FluidTabMetrics.fade, y: 0), end: CGPoint(x: x + room, y: 0), options: [.drawsAfterEndLocation])
            ctx.endTransparencyLayer()
        } else {
            (title as NSString).draw(at: at, withAttributes: attrs)
        }
        ctx.restoreGState()
    }
}
