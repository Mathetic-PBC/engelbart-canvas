import AppKit
import EngelbartUI

/// The workspace's header (Workspace.jsx `<header className="title-bar">`, 2026-10-13: "align all the text at the top
/// and reduce some of the vertical spacing"): one line through the window's lights, 44 high on #fafafa, in three columns:
/// over the sidebar the lights, its toggle and the clock (right-aligned; after the lights when folded); the document's
/// tabs, the + and full screen; Stage · Terminal over the right pane. The empty parts drag the window.
final class HeaderView: TitleDragView {
    let lead = FlippedView()
    let toggle: FlatButton
    var clock: NSView? { didSet { oldValue?.removeFromSuperview(); if let clock { lead.addSubview(clock) }; needsLayout = true } }
    let strip = FlippedView()
    let tabs = DocTabsView()
    let plus: FlatButton
    let full: FlatButton
    let modes = FlippedView()
    let stageMode: FlatButton
    let terminalMode: FlatButton

    var onToggle: () -> Void = {}
    var onPlus: () -> Void = {}
    var onFull: () -> Void = {}
    var onMode: (String) -> Void = { _ in }

    // what the screen says
    var railShown = true
    var railWidth: CGFloat = 300
    var paneWidth: CGFloat = 600
    var stageFull = false
    var docFull = false
    var fullScreenWindow = false
    var controlsRoom: CGFloat = 0
    var hasTopic = true { didSet { plus.isHidden = !hasTopic; full.isHidden = !hasTopic } }
    var mode = "stage" { didSet { stageMode.pressedOn = mode == "stage"; terminalMode.pressedOn = mode == "terminal"; styleModes() } }

    override init(frame: NSRect) {
        toggle = FlatButton(.icon(SidebarIcons.panelClose, size: 18), color: Look.iconIdle, hoverColor: Look.ink, hoverFill: Look.iconHover, radius: 6, id: "sidebar-toggle", tip: "Hide the sidebar (⌘\\)")
        plus = FlatButton(.text("+", font: Fonts.sans(18)), color: Look.mut, hoverColor: Look.ink, hoverFill: Look.tabHover, radius: 14, id: "note-plus", tip: "Open a note or make one")
        full = FlatButton(.icon(KindIcons.expand, size: 16), color: Look.mut, hoverColor: Look.ink, hoverFill: Look.wash2, radius: 6, id: "doc-full=0", tip: "Full screen")
        stageMode = FlatButton(.text("Stage", font: Fonts.sans(13, weight: 600)), color: Look.ink, id: "right-mode=stage")
        terminalMode = FlatButton(.text("Terminal", font: Fonts.sans(13)), color: Look.mut, hoverColor: Look.ink, id: "right-mode=terminal")
        super.init(frame: frame)
        fill = Look.ground
        setAccessibilityIdentifier("workspace-header")
        lead.setAccessibilityIdentifier("title-lead")
        toggle.action = { [weak self] in self?.onToggle() }
        plus.action = { [weak self] in self?.onPlus() }
        full.action = { [weak self] in self?.onFull() }
        stageMode.action = { [weak self] in self?.onMode("stage") }
        terminalMode.action = { [weak self] in self?.onMode("terminal") }
        stageMode.setAccessibilityLabel("Stage"); terminalMode.setAccessibilityLabel("Terminal")
        lead.addSubview(toggle)
        strip.setAccessibilityIdentifier("doc-strip")
        strip.addSubview(tabs)
        strip.addSubview(plus)
        strip.addSubview(full)
        modes.addSubview(stageMode)
        modes.addSubview(terminalMode)
        for v in [lead, strip, modes] { addSubview(v) }
        mode = "stage"
    }
    required init?(coder: NSCoder) { fatalError() }

    func styleModes() {
        for (b, id) in [(stageMode, "stage"), (terminalMode, "terminal")] {
            let on = mode == id
            b.face = .text(id == "stage" ? "Stage" : "Terminal", font: Fonts.sans(13, weight: on ? 600 : 400))
            b.color = on ? Look.ink : Look.mut
            b.padding = NSEdgeInsets(top: 0, left: 0, bottom: 2, right: 0)
            b.needsDisplay = true
        }
        needsLayout = true
        needsDisplay = true
    }

    /// The lead's left padding: 84 clears the traffic lights (`.title-lead`), none in full screen.
    var leadPadding: CGFloat { fullScreenWindow ? 14 : TitleBarMetrics.lead }

    override func layout() {
        super.layout()
        let h = bounds.height
        // over the sidebar: its width (auto when folded); padding 13 8|12 0 84
        let iconTop = WorkspaceLayout.titleLine - 14
        let clockW: CGFloat = clock == nil ? 0 : 28
        let natural = leadPadding + 28 + (clock == nil ? 0 : 2 + clockW) + (railShown ? 8 : 12)
        let leadW = railShown ? railWidth : natural
        lead.frame = CGRect(x: 0, y: 0, width: leadW, height: h)
        if railShown {
            // justify flex-end: the toggle and the clock at the sidebar's right edge
            var x = leadW - 8 - clockW
            clock?.frame = CGRect(x: x, y: iconTop, width: clockW, height: 28)
            x -= (clock == nil ? 0 : 2) + 28
            toggle.frame = CGRect(x: x, y: iconTop, width: 28, height: 28)
        } else {
            toggle.frame = CGRect(x: leadPadding, y: iconTop, width: 28, height: 28)
            clock?.frame = CGRect(x: leadPadding + 30, y: iconTop, width: clockW, height: 28)
        }
        toggle.face = .icon(railShown ? SidebarIcons.panelClose : SidebarIcons.panelOpen, size: 18)
        toggle.toolTip = "\(railShown ? "Hide" : "Show") the sidebar (⌘\\)"
        toggle.setAccessibilityLabel(railShown ? "Hide the sidebar" : "Show the sidebar")
        toggle.setAccessibilityIdentifier("sidebar-toggle=\(railShown ? "shown" : "hidden")")

        // the right switcher: the right pane's width (none in the document's full screen)
        let rightW = docFull ? 0 : paneWidth
        modes.isHidden = docFull
        modes.frame = CGRect(x: bounds.width - rightW, y: 0, width: rightW, height: h)
        var mx: CGFloat = 20
        for b in [stageMode, terminalMode] {
            let s = b.intrinsicContentSize
            b.frame = CGRect(x: mx, y: (WorkspaceLayout.titleLine - 10.5).rounded(.down), width: s.width, height: s.height)
            mx += s.width + 16
        }

        // the document strip, between them (hidden in the right pane's full screen)
        let stripX = leadW + 1
        let stripRight = docFull ? bounds.width : bounds.width - rightW - 1
        strip.isHidden = stageFull
        strip.frame = CGRect(x: stripX, y: 0, width: max(0, stripRight - stripX), height: h)
        let left: CGFloat = railShown ? 22 : 10
        let right: CGFloat = docFull ? controlsRoom + 8 : 8
        let fullX = strip.bounds.width - right - 28
        full.frame = CGRect(x: fullX, y: h - 3 - 28, width: 28, height: 28)
        full.face = .icon(docFull ? KindIcons.collapse : KindIcons.expand, size: 16)
        full.toolTip = docFull ? "Exit full screen (Esc)" : "Full screen"
        full.setAccessibilityLabel(docFull ? "Exit full screen" : "Full screen")
        full.setAccessibilityIdentifier("doc-full=\(docFull ? "1" : "0")")
        let plusW: CGFloat = hasTopic ? 6 + 28 : 0
        let room = max(0, fullX - left - plusW - (hasTopic ? 4 : 0))
        let tabsW = min(tabs.naturalWidth, room)
        tabs.frame = CGRect(x: left, y: 0, width: tabsW, height: h)
        plus.frame = CGRect(x: left + tabsW + 6, y: h - 3 - 28, width: 28, height: 28)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        // Stage · Terminal: the one shown underlined 2px ink
        let on = mode == "stage" ? stageMode : terminalMode
        guard !modes.isHidden else { return }
        let r = modes.convert(on.frame, to: self)
        Look.ink.setFill()
        CGRect(x: r.minX, y: r.maxY - 2, width: r.width, height: 2).fill()
    }
}

/// A pane's edge (Workspace.jsx Separator): 1px (transparent beside the sidebar, #eaeaea before the right pane) with 6px to
/// grab either side; a drag moves it, a double click puts its default back.
final class SeparatorView: NSView {
    var color: NSColor?
    var onDrag: (CGFloat) -> Void = { _ in }
    var onDown: () -> Void = {}
    var onReset: () -> Void = {}
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    init(id: String) { super.init(frame: .zero); setAccessibilityIdentifier(id) }
    required init?(coder: NSCoder) { fatalError() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
    override func draw(_ dirtyRect: NSRect) {
        guard let color else { return }
        color.setFill()
        CGRect(x: (bounds.width - 1) / 2, y: 0, width: 1, height: bounds.height).fill()
    }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onReset(); return }
        onDown()
    }
    override func mouseDragged(with event: NSEvent) { onDrag(event.locationInWindow.x) }
}
