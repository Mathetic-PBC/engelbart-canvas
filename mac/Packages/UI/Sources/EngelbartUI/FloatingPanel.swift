import AppKit
import SwiftUI

// A floating panel (usePlaced.js + model/place.js + the sidebar's Floating/useDismiss, workspace/SidebarPanels.jsx): a
// menu, a picker or a card hung from what opened it, placed by `Placement.place` inside the window (below → above → the
// larger side, cut and scrolling), measured before it shows and again whenever its content changes. Where it (and any list
// in it) was scrolled to survives re-measuring (MATH-55, 2026-10-08), since the scroll view is never rebuilt.
//
// It is a borderless child NSPanel over the window, so it sits above every native view (the Stage's WKWebView, PDFKit,
// the terminal) the way the DOM's fixed layer did, moves with the window, and never drags it (`data-overlay`). It can
// become key, so a field inside takes focus the moment it shows (Electron's could not in the panel's first frame); the
// window behind stays the main window, so its traffic lights stay lit.
//
// Layers (SidebarPanels.jsx): panels open in order; Escape belongs to the newest; a press anywhere but inside the panel,
// inside a panel opened after it, or on `ignore` (what opened it, which toggles) closes it.

public struct FloatingOptions {
    public var side: PlaceSide = .below
    public var gap: CGFloat = 6
    public var align: PlaceAlign = .start
    /// The tallest it may be even with room to spare.
    public var cap: CGFloat? = nil
    /// Its width; nil = the content's own.
    public var width: CGFloat? = nil
    /// Draw the standard card (white, 1px #e6e6e6, radius 10, the sidebar's two-layer shadow). Off: the content draws itself.
    public var card: Bool = true
    public var radius: CGFloat = 10
    /// The entrance (`rise 140ms`).
    public var rise: TimeInterval = 0.14
    /// Takes the keyboard when shown (menus with a field). Off for tooltips and cards.
    public var takesKey: Bool = true
    /// Clicks pass through (tooltips, tab cards: `pointer-events:none`).
    public var passive: Bool = false
    /// Closes on Escape and on a press outside.
    public var dismissible: Bool = true
    /// A rect (window content coordinates, y down) whose presses do not close it: what opened it.
    public var ignore: CGRect? = nil

    public init(side: PlaceSide = .below, gap: CGFloat = 6, align: PlaceAlign = .start, cap: CGFloat? = nil, width: CGFloat? = nil,
                card: Bool = true, radius: CGFloat = 10, rise: TimeInterval = 0.14, takesKey: Bool = true, passive: Bool = false,
                dismissible: Bool = true, ignore: CGRect? = nil) {
        self.side = side; self.gap = gap; self.align = align; self.cap = cap; self.width = width; self.card = card; self.radius = radius
        self.rise = rise; self.takesKey = takesKey; self.passive = passive; self.dismissible = dismissible; self.ignore = ignore
    }

    /// A tooltip or a hover card: no key, no clicks, no dismissal of its own.
    public static func passive(side: PlaceSide = .below, gap: CGFloat = 6, width: CGFloat? = nil, card: Bool = false, rise: TimeInterval = 0.12) -> FloatingOptions {
        FloatingOptions(side: side, gap: gap, width: width, card: card, rise: rise, takesKey: false, passive: true, dismissible: false)
    }
}

/// The card's shadow, as the CSS writes it: 0 12px 32px rgba(0,0,0,.08), 0 2px 6px rgba(0,0,0,.04).
public struct PanelCard: ViewModifier {
    let radius: CGFloat
    public init(radius: CGFloat = 10) { self.radius = radius }
    public func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius).fill(Color.white))
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Color(Palette.tabHover), lineWidth: 1))
            .compositingGroup().shadow(color: .black.opacity(0.08), radius: 16, x: 0, y: 12)
            .shadow(color: .black.opacity(0.04), radius: 3, x: 0, y: 2)
    }
}

final class FloatingNSPanel: NSPanel {
    var allowsKey = true
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
}

/// Flipped container so the scroll view's document starts at its top.
public class FlippedView: NSView { public override var isFlipped: Bool { true } }

@MainActor
public final class FloatingPanel: NSObject {
    /// Open panels, oldest first: Escape is the last one's.
    public private(set) static var stack: [FloatingPanel] = []
    /// Room left round the card for its shadow.
    static let margin: CGFloat = 40

    private let panel: FloatingNSPanel
    private let scroll = NSScrollView()
    private let document = FlippedView()
    private var host: NSHostingView<AnyView>
    private weak var parent: NSWindow?
    private var anchor: CGRect = .zero
    private var options = FloatingOptions()
    private var monitors: [Any] = []
    private var parentObservers: [NSObjectProtocol] = []
    private var content: AnyView = AnyView(EmptyView())
    public var onClose: (() -> Void)?
    public private(set) var isOpen = false
    /// The last placement, in the window's content coordinates (y down): what the tests and callers read.
    public private(set) var spot: PlaceSpot? = nil
    public private(set) var cardSize: CGSize = .zero

    public override init() {
        panel = FloatingNSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        host = NSHostingView(rootView: AnyView(EmptyView()))
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.scrollerStyle = .overlay
        scroll.documentView = document
        document.addSubview(host)
    }

    /// Shows `content` hung from `anchor` (a rect in `window`'s content view, y down).
    public func show<Content: View>(in window: NSWindow, anchor: CGRect, options: FloatingOptions = FloatingOptions(), @ViewBuilder content: () -> Content) {
        self.parent = window
        self.anchor = anchor
        self.options = options
        self.content = AnyView(content())
        panel.allowsKey = options.takesKey
        panel.ignoresMouseEvents = options.passive
        rebuildHost()
        relayout()
        if !isOpen {
            isOpen = true
            if !options.passive { Self.stack.append(self) }
            window.addChildWindow(panel, ordered: .above)
            if options.takesKey { panel.makeKey() } else { panel.orderFront(nil) }
            install()
            if options.rise > 0 {
                panel.alphaValue = 0
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = options.rise
                    ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.25, 0.1, 0.25, 1)
                    panel.animator().alphaValue = 1
                }
            }
        }
    }

    /// New content (it changed size, a row was hovered): measured and placed again; the scroll position stays.
    public func update<Content: View>(@ViewBuilder content: () -> Content) {
        self.content = AnyView(content())
        host.rootView = wrapped()
        relayout()
    }

    /// The anchor moved (the window resized, the row scrolled).
    public func move(anchor: CGRect) { self.anchor = anchor; relayout() }

    public func close() {
        guard isOpen else { return }
        isOpen = false
        Self.stack.removeAll { $0 === self }
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        for o in parentObservers { NotificationCenter.default.removeObserver(o) }
        parentObservers = []
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        let done = onClose
        onClose = nil
        done?()
    }

    /// The panel's window, for focus checks and tests.
    public var window: NSWindow { panel }

    private func wrapped() -> AnyView {
        var view = AnyView(content)
        if let width = options.width { view = AnyView(view.frame(width: width, alignment: .topLeading)) }
        return view
    }

    private func rebuildHost() {
        host.rootView = wrapped()
    }

    /// Measures the content with no height limit, places it, and sizes the panel; the scroll offset is kept.
    public func relayout() {
        guard let parent, let contentView = parent.contentView else { return }
        let natural = host.fittingSize
        let width = options.width ?? natural.width
        let want = options.cap.map { min(natural.height, $0) } ?? natural.height
        let view = contentView.bounds.size
        let spot = Placement.place(PlaceAnchor(anchor), size: CGSize(width: width, height: want), view: view,
                                   gap: options.gap, align: options.align, side: options.side)
        let height = spot.maxHeight ?? want
        let fixed = PlaceSpot(left: spot.left, top: spot.top, maxHeight: spot.maxHeight ?? (want < natural.height ? want : nil))
        self.spot = fixed
        self.cardSize = CGSize(width: width, height: height)

        // The document holds the whole content; the scroll view shows `height` of it.
        let savedOrigin = scroll.contentView.bounds.origin
        host.frame = CGRect(x: 0, y: 0, width: width, height: natural.height)
        document.frame = CGRect(x: 0, y: 0, width: width, height: natural.height)
        scroll.hasVerticalScroller = height < natural.height

        let m = Self.margin
        let cardRect = CGRect(x: spot.left, y: fixed.top, width: width, height: height)
        let screen = Self.screenRect(cardRect.insetBy(dx: -m, dy: -m), in: contentView)
        panel.setFrame(screen, display: false)
        chrome.layout(size: CGSize(width: width, height: height), margin: m, card: options.card, radius: options.radius)
        if panel.contentView !== chrome { panel.contentView = chrome; chrome.card.addSubview(scroll) }
        scroll.frame = chrome.card.bounds
        if savedOrigin.y > 0 {
            let maxY = max(0, natural.height - height)
            scroll.contentView.scroll(to: CGPoint(x: 0, y: min(savedOrigin.y, maxY)))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
    }

    private let chrome = PanelChrome()

    /// A y-down rect in `view`'s coordinates → screen coordinates.
    public static func screenRect(_ rect: CGRect, in view: NSView) -> CGRect {
        let local = view.isFlipped ? rect : CGRect(x: rect.minX, y: view.bounds.height - rect.maxY, width: rect.width, height: rect.height)
        let inWindow = view.convert(local, to: nil)
        return view.window?.convertToScreen(inWindow) ?? inWindow
    }

    /// `view`'s bounds in its window's content view, y down: what to pass as `anchor`.
    public static func anchorRect(of view: NSView) -> CGRect {
        guard let content = view.window?.contentView else { return view.bounds }
        let inContent = content.convert(view.bounds, from: view)
        return content.isFlipped ? inContent : CGRect(x: inContent.minX, y: content.bounds.height - inContent.maxY, width: inContent.width, height: inContent.height)
    }

    private func install() {
        guard options.dismissible else { return }
        let key = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.keyCode == 53, Self.stack.last === self else { return event }
            self.close()
            return nil // used: the workspace's own Escape never sees it
        }
        let press = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            guard let self, self.isOpen else { return event }
            if event.window === self.panel { return event }
            // Inside a panel opened after this one: that press is the newer panel's.
            if let mine = Self.stack.firstIndex(where: { $0 === self }),
               Self.stack[(mine + 1)...].contains(where: { $0.panel === event.window }) { return event }
            if let ignore = self.options.ignore, let parent = self.parent, event.window === parent, let content = parent.contentView {
                let p = content.convert(event.locationInWindow, from: nil)
                let yDown = content.isFlipped ? p : CGPoint(x: p.x, y: content.bounds.height - p.y)
                if ignore.contains(yDown) { return event }
            }
            self.close()
            return event
        }
        monitors = [key as Any, press as Any].compactMap { $0 }
        if let parent {
            parentObservers.append(NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: parent, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            })
        }
    }
}

/// The card in AppKit: an outer view carrying the wide soft shadow (0 12 32 rgba(0,0,0,.08)), the card carrying the near
/// one (0 2 6 rgba(0,0,0,.04)), white, radius 10, a 1px #e6e6e6 border drawn over its content.
final class PanelChrome: FlippedView {
    let outer = FlippedView()
    let card = FlippedView()
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        outer.wantsLayer = true
        card.wantsLayer = true
        addSubview(outer)
        outer.addSubview(card)
    }
    required init?(coder: NSCoder) { fatalError() }

    func layout(size: CGSize, margin: CGFloat, card drawn: Bool, radius: CGFloat) {
        frame = CGRect(x: 0, y: 0, width: size.width + 2 * margin, height: size.height + 2 * margin)
        outer.frame = CGRect(x: margin, y: margin, width: size.width, height: size.height)
        card.frame = outer.bounds
        guard let o = outer.layer, let c = card.layer else { return }
        c.cornerRadius = drawn ? radius : 0
        c.masksToBounds = drawn
        c.backgroundColor = drawn ? NSColor.white.cgColor : NSColor.clear.cgColor
        c.borderWidth = drawn ? 1 : 0
        c.borderColor = Palette.tabHover.cgColor
        o.cornerRadius = drawn ? radius : 0
        o.backgroundColor = drawn ? NSColor.white.cgColor : NSColor.clear.cgColor
        o.shadowColor = NSColor.black.cgColor
        o.shadowOpacity = drawn ? 0.08 : 0
        o.shadowRadius = 16
        o.shadowOffset = CGSize(width: 0, height: 12) // flipped layer space: down
        c.shadowOpacity = 0
        // The near shadow: a sublayer of the outer view, behind the card.
        if drawn, o.sublayers?.contains(where: { $0.name == "near" }) != true {
            let near = CALayer()
            near.name = "near"
            near.shadowColor = NSColor.black.cgColor
            near.shadowOpacity = 0.04
            near.shadowRadius = 3
            near.shadowOffset = CGSize(width: 0, height: 2)
            near.backgroundColor = NSColor.white.cgColor
            o.insertSublayer(near, at: 0)
        }
        if let near = o.sublayers?.first(where: { $0.name == "near" }) {
            near.frame = o.bounds
            near.cornerRadius = radius
            near.isHidden = !drawn
        }
    }
}

// MARK: - SwiftUI

/// Reads the NSView a SwiftUI view is drawn in, for anchoring panels.
public struct AnchorReader: NSViewRepresentable {
    let onView: (NSView) -> Void
    public init(_ onView: @escaping (NSView) -> Void) { self.onView = onView }
    public func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { onView(view) }
        return view
    }
    public func updateNSView(_ nsView: NSView, context: Context) { DispatchQueue.main.async { onView(nsView) } }
}

/// The modifier's panel and anchor view, in a box that is stable across renders (a @State optional set from a callback
/// was not: two panels opened, and Escape closed only one).
@MainActor final class PanelHolder {
    var panel: FloatingPanel?
    weak var anchor: NSView?
}

struct FloatingPanelModifier<PanelContent: View>: ViewModifier {
    @Binding var isPresented: Bool
    let options: FloatingOptions
    let panelContent: () -> PanelContent
    @State private var holder = PanelHolder()

    func body(content: Content) -> some View {
        content
            .background(AnchorReader { view in
                holder.anchor = view
                sync()
            })
            .onChange(of: isPresented) { _, _ in sync() }
            .onDisappear { holder.panel?.close() }
    }

    private func sync() {
        guard let view = holder.anchor, let window = view.window else { return }
        if isPresented {
            let panel = holder.panel ?? FloatingPanel()
            holder.panel = panel
            var opts = options
            let rect = FloatingPanel.anchorRect(of: view)
            if opts.ignore == nil { opts.ignore = rect }
            panel.onClose = { if isPresented { isPresented = false } }
            if panel.isOpen { panel.update(content: panelContent); panel.move(anchor: rect) }
            else { panel.show(in: window, anchor: rect, options: opts, content: panelContent) }
        } else {
            holder.panel?.onClose = nil
            holder.panel?.close()
        }
    }
}

public extension View {
    /// A floating panel hung from this view while `isPresented`.
    func floatingPanel<Content: View>(isPresented: Binding<Bool>, options: FloatingOptions = FloatingOptions(),
                                      @ViewBuilder content: @escaping () -> Content) -> some View {
        modifier(FloatingPanelModifier(isPresented: isPresented, options: options, panelContent: content))
    }
}
