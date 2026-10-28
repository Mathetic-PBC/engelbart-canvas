import AppKit
import SwiftUI

// Title bar (styles.css, 2026-09-23): the window has no native one (a hidden, inset title bar over full-size content), so
// the header rows drag the window and their controls do not; menus and dialogs over it do not either (Electron's
// `data-overlay`; here floating panels are windows of their own). On macOS the first column starts after the traffic
// lights until the window goes full screen (`.title-lead`, 84px). The header is 54 tall, the traffic lights centred on it.

public enum TitleBarMetrics {
    /// The header row's height (46 → 54 on 2026-09-23).
    public static let header: CGFloat = 54
    /// `.title-lead`'s left padding: clears the traffic lights.
    public static let lead: CGFloat = 84
}

/// The window's state the screens lay out by: whether it is full screen. The app puts one in every window's environment.
public final class WindowChrome: ObservableObject {
    @Published public var fullScreen = false
    public init() {}

    /// `.title-lead`'s left padding: 84 clears the traffic lights; full screen has none to clear.
    public static func leadPadding(fullScreen: Bool) -> CGFloat { fullScreen ? 0 : TitleBarMetrics.lead }
}

/// What a double click on a header row does, as System Settings says (Desktop & Dock ▸ "Double-click a window's title bar
/// to"): zoom (the default, "Maximize" / "Fill"), minimize, or nothing.
public enum TitleBarDoubleClick: Equatable {
    case zoom, minimize, none
    public static func action(_ defaults: UserDefaults = .standard) -> TitleBarDoubleClick {
        switch defaults.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": return .minimize
        case "None": return .none
        case nil: return defaults.bool(forKey: "AppleMiniaturizeOnDoubleClick") ? .minimize : .zoom // older systems' bool
        default: return .zoom
        }
    }
}

/// An NSView that moves its window when pressed and dragged (a header row's empty space).
public final class WindowDragView: NSView {
    public override var mouseDownCanMoveWindow: Bool { true }
    public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    public override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch TitleBarDoubleClick.action() {
            case .zoom: window.zoom(nil)
            case .minimize: window.miniaturize(nil)
            case .none: break
            }
            return
        }
        window.performDrag(with: event)
    }
}

struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowDragView { WindowDragView() }
    func updateNSView(_ nsView: WindowDragView, context: Context) {}
}

struct TitleLeadModifier: ViewModifier {
    @EnvironmentObject var chrome: WindowChrome
    func body(content: Content) -> some View {
        content.padding(.leading, WindowChrome.leadPadding(fullScreen: chrome.fullScreen))
    }
}

public extension View {
    /// `.title-bar`: this row drags the window (its buttons and fields keep their presses, since they take them first).
    func titleBar() -> some View { background(WindowDragArea()) }

    /// `.title-lead`: the row's first column starts after the traffic lights unless the window is full screen. Needs the
    /// window's WindowChrome in the environment (the app provides it).
    func titleLead() -> some View { modifier(TitleLeadModifier()) }
}
