import AppKit
import SwiftUI

/// A key taken before the window's responders see it (a capture-phase `keydown` listener, as Settings and the panels
/// use for Escape): `handler` returns whether it used the key. Only while its view's window is key.
public struct KeyMonitor: NSViewRepresentable {
    let keyCode: UInt16
    let handler: () -> Bool
    public init(keyCode: UInt16, handler: @escaping () -> Bool) { self.keyCode = keyCode; self.handler = handler }

    public final class Coordinator {
        var monitor: Any?
        var handler: () -> Bool = { false }
        weak var view: NSView?
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }

    public func makeCoordinator() -> Coordinator { Coordinator() }

    public func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let c = context.coordinator
        c.view = view
        c.handler = handler
        let code = keyCode
        c.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak c] event in
            guard let c, event.keyCode == code, let window = c.view?.window, window.isKeyWindow || event.window === window else { return event }
            return c.handler() ? nil : event
        }
        return view
    }

    public func updateNSView(_ nsView: NSView, context: Context) { context.coordinator.handler = handler }

    public static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let m = coordinator.monitor { NSEvent.removeMonitor(m); coordinator.monitor = nil }
    }
}
