import AppKit
import EngelbartUI

/// A workspace window (index.cjs openWindow): full-size content under a hidden, inset title bar, the traffic lights at
/// {18, 20} so they sit centred on the 54px header (2026-09-23), white, at least 900 × 560.
public final class EngelbartWindow: NSWindow, WindowHandle {
    /// trafficLightPosition: the close button's left edge and top, from the window's top left.
    public static let trafficLights = CGPoint(x: 18, y: 20)
    /// The header the lights are centred on.
    public static let headerHeight: CGFloat = TitleBarMetrics.header

    public private(set) var isDestroyed = false
    /// The bounds it had last while neither full screen nor zoomed (what is saved: Electron's getNormalBounds).
    private var normalFrame: NSRect = .zero
    public var onFullScreenChange: ((Bool) -> Void)?

    public init(frame: NSRect) {
        super.init(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "Engelbart"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = false
        backgroundColor = .white
        minSize = NSSize(width: WindowGeometry.minSize.width, height: WindowGeometry.minSize.height)
        contentMinSize = minSize
        collectionBehavior.insert(.fullScreenPrimary)
        isReleasedWhenClosed = false
        tabbingMode = .disallowed
        normalFrame = frame
        let center = NotificationCenter.default
        for name in [NSWindow.didResizeNotification, NSWindow.didMoveNotification] {
            center.addObserver(self, selector: #selector(framesChanged), name: name, object: self)
        }
        center.addObserver(self, selector: #selector(enteredFullScreen), name: NSWindow.didEnterFullScreenNotification, object: self)
        center.addObserver(self, selector: #selector(leftFullScreen), name: NSWindow.didExitFullScreenNotification, object: self)
        center.addObserver(self, selector: #selector(placeLights), name: NSWindow.didBecomeKeyNotification, object: self)
        center.addObserver(self, selector: #selector(placeLights), name: NSWindow.didResignKeyNotification, object: self)
        placeLights()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    public var isFullScreen: Bool { styleMask.contains(.fullScreen) }
    public var isFocused: Bool { isKeyWindow }

    public var normalBounds: CGRect {
        let mainHeight = NSScreen.screens.first?.frame.height ?? frame.maxY
        return WindowGeometry.yDown(normalFrame, mainHeight: mainHeight)
    }

    @objc private func framesChanged() {
        if !isFullScreen && !isZoomed { normalFrame = frame }
        placeLights()
    }

    @objc private func enteredFullScreen() { onFullScreenChange?(true) }
    @objc private func leftFullScreen() { placeLights(); onFullScreenChange?(false) }

    public override func close() {
        super.close()
        isDestroyed = true
    }

    public override func layoutIfNeeded() {
        super.layoutIfNeeded()
        placeLights()
    }

    /// The traffic lights at {18, 20}: the title bar's container grows to hold them (20 above, 20 below), and the buttons
    /// keep their own spacing. In full screen AppKit owns them.
    @objc public func placeLights() {
        guard !isFullScreen, let close = standardWindowButton(.closeButton), let mini = standardWindowButton(.miniaturizeButton),
              let zoom = standardWindowButton(.zoomButton), let titlebar = close.superview, let container = titlebar.superview else { return }
        let p = Self.trafficLights
        let h = close.frame.height
        let height = p.y + h + p.y
        var frame = container.frame
        if abs(frame.height - height) > 0.5 || abs(frame.maxY - (container.superview?.bounds.height ?? frame.maxY)) > 0.5 {
            frame.size.height = height
            frame.origin.y = (container.superview?.bounds.height ?? self.frame.height) - height
            container.frame = frame
        }
        let gap = mini.frame.minX - close.frame.minX
        let y = titlebar.isFlipped ? p.y : titlebar.bounds.height - p.y - h
        for (index, button) in [close, mini, zoom].enumerated() {
            let origin = NSPoint(x: p.x + CGFloat(index) * gap, y: y)
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
        }
    }
}
