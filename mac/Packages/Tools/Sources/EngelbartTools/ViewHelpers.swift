import AppKit
import EngelbartUI
import SwiftUI

// Small view pieces the two Tools views need. They lean only on EngelbartUI's tokens (Palette, Fonts, Motion), which
// existed when this package was written; EngelbartUI's own hover/animation/key helpers were still being built then, so
// these stay private here (API.md says how to swap them).

/// Two colours ToolSetup.jsx writes literally that the tokens do not have: the warn tone (#a35200) and the check (#1a7f37).
enum ToolColors {
    static let warn = NSColor(hex: "#a35200")
    static let check = NSColor(hex: "#1a7f37")
    /// The setup dialog's backdrop: rgba(255,255,255,.35).
    static let backdrop = NSColor(white: 1, alpha: 0.35)
    /// box-shadow: 0 12px 40px #0000001f.
    static let shadow = NSColor(white: 0, alpha: 0x1f / 255.0)
}

/// `.hov-ink` (text turns ink) and `.hov-wash` (#f2f2f2 fill), with the CSS's 120 ms.
struct ToolsHover: ViewModifier {
    enum Kind { case ink, wash }
    let kind: Kind
    let rest: NSColor
    let radius: CGFloat
    @State private var on = false

    func body(content: Content) -> some View {
        content
            .foregroundStyle(Color(kind == .ink && on ? Palette.ink : rest))
            .background(RoundedRectangle(cornerRadius: radius).fill(Color(kind == .wash && on ? Palette.hov : .clear)))
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .onHover { on = $0 }
            .animation(.easeOut(duration: Motion.fast), value: on)
    }
}

extension View {
    func toolsHover(_ kind: ToolsHover.Kind, rest: NSColor, radius: CGFloat = 0) -> some View { modifier(ToolsHover(kind: kind, rest: rest, radius: radius)) }

    /// `@keyframes rise` over `duration`, ease cubic-bezier(.25,.1,.25,1).
    func toolsRise(_ duration: TimeInterval) -> some View { modifier(ToolsRise(duration: duration)) }
}

struct ToolsRise: ViewModifier {
    /// Drawn as it ends up (offscreen pictures in the tests, where onAppear never runs).
    nonisolated(unsafe) static var still = false
    let duration: TimeInterval
    @State private var shown = ToolsRise.still
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).offset(y: shown ? 0 : 6)
            .onAppear { withAnimation(.timingCurve(0.25, 0.1, 0.25, 1, duration: duration)) { shown = true } }
    }
}

/// `github-wait` on the busy dot: opacity .25 ↔ 1, ease-in-out, here over 1.4 s as ToolSetup.jsx's Pulse sets it.
struct PulseDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduce
    var body: some View {
        TimelineView(.animation(paused: reduce)) { context in
            let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
            let half = t < 0.5 ? t * 2 : (1 - t) * 2
            let eased = half < 0.5 ? 2 * half * half : 1 - pow(-2 * half + 2, 2) / 2
            Circle().fill(Color(Palette.fnt)).frame(width: 6, height: 6).opacity(reduce ? 1 : 0.25 + 0.75 * eased)
        }
    }
}

/// The check in a ready row (12×12, stroke #1a7f37 1.6, round caps): M2.5 6.2 5 8.6l4.5-5.2.
struct CheckMark: View {
    var body: some View {
        Path { p in
            p.move(to: CGPoint(x: 2.5, y: 6.2))
            p.addLine(to: CGPoint(x: 5, y: 8.6))
            p.addLine(to: CGPoint(x: 9.5, y: 3.4))
        }
        .stroke(Color(ToolColors.check), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        .frame(width: 12, height: 12)
    }
}

/// A key taken before anything else sees it (ToolSetup.jsx's capture-phase Escape), while its window is key.
struct ToolsKeyTrap: NSViewRepresentable {
    let keyCode: UInt16
    let handler: () -> Void

    final class Coordinator {
        var monitor: Any?
        var handler: () -> Void = {}
        weak var view: NSView?
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let c = context.coordinator
        c.view = view
        c.handler = handler
        let code = keyCode
        c.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak c] event in
            guard let c, event.keyCode == code, let window = c.view?.window, event.window === window else { return event }
            c.handler()
            return nil
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) { context.coordinator.handler = handler }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let m = coordinator.monitor { NSEvent.removeMonitor(m); coordinator.monitor = nil }
    }
}

/// The Dock icon's progress bar (Electron's win.setProgressBar): 0…1 a bar, more than 1 indeterminate, below 0 none.
@MainActor
public enum DockProgress {
    final class Tile: NSView {
        var value: Double = 0
        override func draw(_ dirtyRect: NSRect) {
            NSApp.applicationIconImage?.draw(in: bounds)
            let bar = NSRect(x: bounds.width * 0.1, y: bounds.height * 0.08, width: bounds.width * 0.8, height: bounds.height * 0.08)
            let track = NSBezierPath(roundedRect: bar, xRadius: bar.height / 2, yRadius: bar.height / 2)
            Palette.bd.setFill(); track.fill()
            let shown = value > 1 ? 0.33 : max(0, min(1, value))
            let fill = NSRect(x: bar.minX, y: bar.minY, width: bar.width * shown, height: bar.height)
            Palette.acc.setFill()
            NSBezierPath(roundedRect: fill, xRadius: bar.height / 2, yRadius: bar.height / 2).fill()
        }
    }

    public static func set(_ value: Double) {
        let tile = NSApp.dockTile
        if value < 0 { tile.contentView = nil; tile.display(); return }
        let view = (tile.contentView as? Tile) ?? Tile(frame: NSRect(origin: .zero, size: tile.size))
        view.value = value
        tile.contentView = view
        tile.display()
    }
}
