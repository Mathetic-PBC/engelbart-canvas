import AppKit
import EngelbartUI
import SwiftTerm

// The transcript's look, exactly as sessions.js configured xterm: the light theme, Source Code Pro at the settings' font
// size with line height 1.18, a blinking bar cursor, 10 000 lines of scrollback, contrast lifted to 4.5:1. The ANSI
// palette is the terminal's own (xterm `theme`), so it lives here rather than in EngelbartUI's Palette; everything that
// is also an app token comes from Palette.

public enum TerminalTheme {
    public static let background = Palette.gray0                 // #ffffff
    public static let foreground = Palette.gray900               // #171717
    public static let cursor = Palette.blue600                   // #0070f3
    public static let cursorAccent = Palette.gray0               // #ffffff
    public static let selectionBackground = NSColor(hex: "#dbe8fb")
    public static let selectionForeground = Palette.gray900      // #171717

    /// black red green yellow blue magenta cyan white, then the bright eight.
    public static let ansi: [String] = [
        "#171717", "#c8102e", "#1a7f37", "#9a6700", "#0070f3", "#8250df", "#0e7490", "#e2e2e2",
        "#8f8f8f", "#e70022", "#2da44e", "#bf8700", "#3291ff", "#a475f9", "#0891b2", "#ffffff",
    ]

    public static let lineHeight: CGFloat = 1.18
    public static let scrollback = 10_000
    public static let minimumContrastRatio: CGFloat = 4.5
    /// xterm's scrollSensitivity and fastScrollSensitivity (Option held).
    public static let scrollSensitivity: CGFloat = 2.5
    public static let fastScrollSensitivity: CGFloat = 10

    /// The fallback the xterm font stack named: 'Source Code Pro', Menlo, SFMono-Regular, monospace.
    public static func font(size: CGFloat) -> NSFont {
        let mono = Fonts.mono(size)
        if mono.fontName.hasPrefix("SourceCodePro") { return mono }
        return NSFont(name: "Menlo-Regular", size: size) ?? mono
    }

    static func swiftTermColor(_ hex: String) -> SwiftTerm.Color {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        let v = UInt32(s, radix: 16) ?? 0
        return SwiftTerm.Color(red8: UInt16((v >> 16) & 0xff), green8: UInt16((v >> 8) & 0xff), blue8: UInt16(v & 0xff))
    }

    static var ansiColors: [SwiftTerm.Color] { ansi.map(swiftTermColor) }

    // Pane chrome values the CSS has that Palette does not (yet): `.hov-tab` / `.hov-tab-plus` #e6e6e6, `.hov-x` #e3e3e3.
    static let tabHover = NSColor(hex: "#e6e6e6")
    static let closeHover = NSColor(hex: "#e3e3e3")
}
