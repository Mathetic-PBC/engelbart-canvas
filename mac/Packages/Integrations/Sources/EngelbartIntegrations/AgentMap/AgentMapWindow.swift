import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// src/main/agent-map/window.cjs (2026-10-12; it was the Agent map): a window for developers only, one per app, showing every
// ask as it happens and how each agent is set up. Opened only in a copy with test mode (`available`), whether the mode is
// on or off; open() focuses it when it is already open. closeUnlessAvailable() closes it once it is not available (after
// set-test-mode). It is no workspace window.

@MainActor
public final class AgentMapWindow: NSObject, NSWindowDelegate {
    public static let title = "Agent Viewer"
    let available: () -> Bool
    let makeContent: () -> NSView
    private var window: NSWindow?

    /// `makeContent()`: the Viewer's view (AgentMapView over an AgentMapModel), made when the window opens.
    public init(available: @escaping () -> Bool, makeContent: @escaping () -> NSView) {
        self.available = available
        self.makeContent = makeContent
    }

    public var isOpen: Bool { window != nil }

    /// → whether it is open now.
    @discardableResult
    public func open() -> Bool {
        guard available() else { return false }
        if let window { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return true }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = Self.title
        w.minSize = NSSize(width: 720, height: 420)
        w.backgroundColor = .white
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = makeContent()
        w.center()
        w.makeKeyAndOrderFront(nil)
        window = w
        return true
    }

    public func close() {
        window?.close()
        window = nil
    }

    /// Closes the Viewer when it is no longer available. → whether it is open now.
    @discardableResult
    public func closeUnlessAvailable() -> Bool {
        if !available() { close() }
        return isOpen
    }

    /// The window, for a save panel's sheet.
    public var nsWindow: NSWindow? { window }

    public func windowWillClose(_ notification: Notification) { window = nil }
}

/// The Agents button (src/renderer/ui/AgentsButton.jsx): beside the Test pill in a copy with test mode, when
/// AGENTS_BUTTON_SHOWN (false in 0.1.25: App.jsx keeps it hidden). Caps, small, outline; opens the Viewer.
public enum AgentsButton {
    /// App.jsx's AGENTS_BUTTON_SHOWN.
    public static let shown = false
    public static func available(testModeAvailable: Bool) -> Bool { testModeAvailable }
    public static let help = "Agent Viewer: every ask, from your line to what each agent was sent and wrote, live"
}

public struct AgentsButtonView: View {
    let available: Bool
    let onOpen: () -> Void
    public init(available: Bool, onOpen: @escaping () -> Void) { self.available = available; self.onOpen = onOpen }
    public var body: some View {
        if AgentsButton.shown && available {
            Button(action: onOpen) {
                Text("AGENTS").font(Font(Fonts.sans(10.5, weight: 500))).kerning(0.6).foregroundColor(Color(Palette.ink))
                    .padding(.horizontal, 8).frame(height: 22)
                    .overlay(RoundedRectangle(cornerRadius: Radius.xs).stroke(Color(Palette.bd), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .help(AgentsButton.help)
        }
    }
}
