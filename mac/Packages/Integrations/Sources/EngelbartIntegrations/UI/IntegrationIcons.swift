import AppKit
import SwiftUI
import EngelbartUI

// The few glyphs of the GitHub and Zotero panes and the Connections rows that are their own (drawn from the renderer's
// SVG path data): Zotero's Z, the private lock, the connection spinner, the reopen and cancel glyphs.

public enum IntegrationIcons {
    static func p(_ d: String) -> IconShape { IconShape(.path(d)) }
    /// Connections.jsx ZoteroIcon: viewBox 16, stroke 1.6.
    public static let zotero = Icon("Zotero", grid: 16, stroke: 1.6, size: 12, [p("M3.5 3h9l-9 10h9")])
    /// GithubPane.jsx / GithubRepos.jsx LOCK: viewBox 16, stroke 1.6.
    public static let lock = Icon("Private", grid: 16, stroke: 1.6, size: 11, [IconShape(.rect(x: 3, y: 7, width: 10, height: 7.5, rx: 1.5)), p("M5.5 7V5a2.5 2.5 0 0 1 5 0v2")])
    /// The connection spinner: an open circle (`M14 8a6 6 0 1 1-6-6`), turning every .9 s.
    public static let spinner = Icon("Working", grid: 16, stroke: 1.5, size: 11, [p("M14 8a6 6 0 1 1-6-6")])
    /// ConnectionProgress's reopen (↗ out of a box) and cancel (×).
    public static let reopen = Icon("Open", grid: 16, stroke: 1.5, size: 12, [p("M9 2h5v5M14 2 7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3")])
    public static let cancel = Icon("Cancel", grid: 16, stroke: 1.5, size: 12, [p("m4 4 8 8M12 4l-8 8")])
    /// ConnectionActions' ⋯: three dots r 1.2 at 3, 8, 13.
    public static let dots = Icon("Options", grid: 16, stroke: 0, size: 16, [
        IconShape(.circle(cx: 3, cy: 8, r: 1.2), fill: true, stroke: false), IconShape(.circle(cx: 8, cy: 8, r: 1.2), fill: true, stroke: false),
        IconShape(.circle(cx: 13, cy: 8, r: 1.2), fill: true, stroke: false)])
    /// GithubPane.jsx's search field glyph: viewBox 24, stroke 2.6.
    public static let search = Icon("Search", grid: 24, stroke: 2.6, size: 14, [IconShape(.circle(cx: 10, cy: 10, r: 6.5)), IconShape(.line(x1: 15, y1: 15, x2: 21, y2: 21))])
}

/// The connection spinner (`.connection-spinner`: .9 s linear, still with reduced motion).
struct ConnectionSpinner: View {
    var size: CGFloat = 11
    @State private var turn = false
    @Environment(\.accessibilityReduceMotion) private var reduce
    var body: some View {
        IconView(IntegrationIcons.spinner, size: size)
            .rotationEffect(.degrees(turn ? 360 : 0))
            .onAppear { if !reduce { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turn = true } } }
    }
}

/// `text(size, color, weight)` of the panes: system sans at 1.4 line height.
func paneText(_ size: CGFloat, _ weight: Int = 400) -> TextStyle { TextStyle(size, weight: weight, lineHeight: 1.4) }
