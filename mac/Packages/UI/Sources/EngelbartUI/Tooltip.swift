import AppKit
import SwiftUI

// Tooltips in the app's own look (styles.css .sb-tip, 2026-10-13: "it should use our native tooltip UI"), shown after the
// sidebar's beat (350 ms, Rail.jsx HOVER_OPEN) and gone at once; placed as SidebarPanels.jsx `Tip` places them: 28 in from
// the element's left (kept 8 inside the window, 240 wide at most), 5 under it, or above it (45 over its top) when there is
// no room under.

public enum TooltipTiming {
    public static let open: TimeInterval = 0.35
    public static let width: CGFloat = 240

    /// `Tip`'s spot for an element's rect `at` in a window of `view` size (y down).
    public static func spot(for at: CGRect, view: CGSize) -> CGPoint {
        let left = max(8, min(at.minX + 28, view.width - width - 8))
        let top = at.maxY + 48 <= view.height ? at.maxY + 5 : max(8, at.minY - 45)
        return CGPoint(x: left, y: top)
    }
}

/// The tooltip's face: white, 1px #eaeaea, radius 6, shadow 0 4 16 rgba(0,0,0,.08), padding 9×10, 12/1.4 #4d4d4d, one line.
/// `key`: a key cap after the words (a project's ⌃1); `shortcut`: grey words after them.
public struct TooltipFace: View {
    let text: String
    let key: String?
    let shortcut: String?
    public init(_ text: String, key: String? = nil, shortcut: String? = nil) { self.text = text; self.key = key; self.shortcut = shortcut }
    public var body: some View {
        HStack(spacing: 8) {
            Text(text).textStyle(TextStyle(12, lineHeight: 1.4)).foregroundStyle(Color(Palette.mut)).lineLimit(1)
            if let key {
                Text(key)
                    .font(Fonts.swiftUISans(12)).foregroundStyle(Color(Palette.ink))
                    .padding(.horizontal, 4)
                    .frame(minWidth: 28, minHeight: 24)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color(Palette.gray50)))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(Palette.bd), lineWidth: 1))
            }
            if let shortcut {
                Text(shortcut).font(Fonts.swiftUISans(12).monospacedDigit()).foregroundStyle(Color(Palette.fnt)).lineLimit(1)
            }
        }
        .fixedSize()
        .padding(EdgeInsets(top: 9, leading: 10, bottom: 9, trailing: 10))
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(Palette.bd), lineWidth: 1))
        .compositingGroup().shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }
}

struct TooltipModifier: ViewModifier {
    let text: String
    let key: String?
    let shortcut: String?
    @State private var view: NSView?
    @State private var timer: DispatchWorkItem?
    @State private var panel: FloatingPanel?

    func body(content: Content) -> some View {
        content
            .background(AnchorReader { v in if view !== v { view = v } })
            .onHover { inside in inside ? arm() : hide() }
            .onDisappear { hide() }
    }

    private func arm() {
        timer?.cancel()
        let work = DispatchWorkItem { show() }
        timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + TooltipTiming.open, execute: work)
    }

    private func show() {
        guard let view, let window = view.window, let content = window.contentView else { return }
        let at = FloatingPanel.anchorRect(of: view)
        let spot = TooltipTiming.spot(for: at, view: content.bounds.size)
        let p = panel ?? FloatingPanel()
        panel = p
        // Anchored at a zero-height rect at the spot, gap 0, so place() keeps it there; 12 of room round the face for its
        // shadow (the panel's scroll view clips), taken back off the spot.
        let room: CGFloat = 12
        p.show(in: window, anchor: CGRect(x: spot.x - room, y: spot.y - room, width: 0, height: 0),
               options: FloatingOptions(gap: 0, card: false, rise: 0.12, takesKey: false, passive: true, dismissible: false)) {
            TooltipFace(text, key: key, shortcut: shortcut).padding(room)
        }
    }

    private func hide() {
        timer?.cancel(); timer = nil
        panel?.close()
    }
}

public extension View {
    /// The app's tooltip after 350 ms under the pointer (`.sb-tip`), in place of the system's.
    func tip(_ text: String, key: String? = nil, shortcut: String? = nil) -> some View {
        modifier(TooltipModifier(text: text, key: key, shortcut: shortcut))
    }
}
