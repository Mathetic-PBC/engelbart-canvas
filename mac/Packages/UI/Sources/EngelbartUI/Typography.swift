import AppKit
import SwiftUI

// The rest of the tokens: tokens/typography.css's scale, tokens/effects.css's widths and rings, tokens/spacing.css's
// paddings and widths, and the one-off greys styles.css and the components use (each named for where it is used, so a
// screen never writes a hex of its own).

public extension Palette {
    static let line = gray200
    static let dtxt = gray900          // draft/notes text
    /// The wave's floor and its red pair (wave.css).
    static let waveFloor = NSColor(hex: "#a8a8a8")
    static let waveRedFloor = NSColor(hex: "#e0a39b")
    static let waveRedBand = NSColor(hex: "#b42318")
    /// `.hov-wash2`, `.sb-pill.ready`: a row on a grey card, one grey darker (#eaeaea is gray200).
    static let wash2 = gray200
    /// Settings: the open page in the column, the gear's hover, the dialog's surfaces.
    static let navOn = NSColor(hex: "#e8e8e8")
    static let gearHover = NSColor(hex: "#ededed")
    static let navIdleIcon = NSColor(hex: "#6f6f6f")
    static let settingsPanel = NSColor(hex: "#fcfcfc")
    static let settingsBorder = NSColor(hex: "#d4d4d4")
    static let settingsLine = NSColor(hex: "#ebebeb")
    static let settingsHairline = NSColor(hex: "#efefef")
    static let fieldBorder = NSColor(hex: "#e4e4e4")
    /// Tabs (FluidTab, the Stage): a tab behind under the pointer or lifted; the × under the pointer.
    static let tabHover = NSColor(hex: "#e6e6e6")
    static let tabCloseHover = NSColor(hex: "#e3e3e3")
    /// The sidebar's rows (styles.css .sb-row): hover, current, current hovered; the icon buttons' idle and hover.
    static let rowHover = NSColor(hex: "#efefef")
    static let rowActive = NSColor(hex: "#e6e6e6")
    static let rowActiveHover = NSColor(hex: "#e0e0e0")
    static let iconIdle = NSColor(hex: "#5c5c5c")
    static let iconHover = NSColor(hex: "#ececec")
    /// The focus outline of the gear (#777) and the sidebar's inset focus ring (rgba(0,112,243,.28)).
    static let gearFocus = NSColor(hex: "#777777")
    static let focusInset = NSColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.28)
    /// Veils behind dialogs: the app's (rgba(23,23,23,.18)) and the DirectoryGate's (rgba(255,255,255,.35)).
    static let veil = NSColor(srgbRed: 23 / 255, green: 23 / 255, blue: 23 / 255, alpha: 0.18)
    static let veilLight = NSColor(white: 1, alpha: 0.35)
}

public enum Border {
    public static let width: CGFloat = 1, mark: CGFloat = 1.5, now: CGFloat = 2
}

/// tokens/spacing.css: paddings (vertical, horizontal) and fixed widths.
public enum Pad {
    public static let field = EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)
    public static let fieldSmall = EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12)
    public static let button = EdgeInsets(top: 7, leading: 15, bottom: 7, trailing: 15)
    public static let buttonLarge = EdgeInsets(top: 9, leading: 18, bottom: 9, trailing: 18)
    public static let seed = EdgeInsets(top: 5, leading: 11, bottom: 5, trailing: 11)
    public static let option = EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12)
    public static let optionLarge = EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)
    public static let cardBody = EdgeInsets(top: 14, leading: 18, bottom: 16, trailing: 18)
}

public enum Widths {
    public static let rail: CGFloat = 340, wizardBody: CGFloat = 600, column: CGFloat = 820, inspector: CGFloat = 300
}

public extension Motion {
    /// --ease-rise: cubic-bezier(0.25, 0.1, 0.25, 1).
    static let easeRise = Animation.timingCurve(0.25, 0.1, 0.25, 1, duration: rise)
    static func ease(_ seconds: TimeInterval) -> Animation { .timingCurve(0.25, 0.1, 0.25, 1, duration: seconds) }
    static let pulseIdle: CGFloat = 0.18
}

/// One CSS `font:` shorthand: size, weight, line height (a multiple of the size), tracking, family, and uppercase for the
/// micro-caps.
public struct TextStyle: Sendable, Equatable {
    public enum Family: Sendable { case sans, mono }
    public var size: CGFloat
    public var weight: Int
    public var lineHeight: CGFloat
    public var tracking: CGFloat
    public var family: Family
    public var uppercase: Bool

    public init(_ size: CGFloat, weight: Int = 400, lineHeight: CGFloat = 1.5, tracking: CGFloat = 0, family: Family = .sans, uppercase: Bool = false) {
        self.size = size; self.weight = weight; self.lineHeight = lineHeight; self.tracking = tracking; self.family = family; self.uppercase = uppercase
    }

    public var nsFont: NSFont { family == .mono ? Fonts.mono(size, weight: weight) : Fonts.sans(size, weight: weight) }
    public var font: Font { Font(nsFont) }
    /// Extra space between lines so lines sit `lineHeight × size` apart, as CSS has them.
    public var lineSpacing: CGFloat {
        let f = nsFont
        let natural = f.ascender - f.descender + f.leading
        return max(0, size * lineHeight - natural)
    }

    // tokens/typography.css
    public static let microcap = TextStyle(9, weight: 500, lineHeight: 1, tracking: 1.6, uppercase: true)
    public static let microcapLarge = TextStyle(10, weight: 500, lineHeight: 1, tracking: 1.6, uppercase: true)
    public static let microcapButton = TextStyle(9, weight: 500, lineHeight: 1, tracking: 1.5, uppercase: true)
    public static let microcapButtonLarge = TextStyle(10, weight: 500, lineHeight: 1, tracking: 1.4, uppercase: true)
    public static let button = TextStyle(13, weight: 500, lineHeight: 1)
    public static let row = TextStyle(14, lineHeight: 1.4)
    public static let meta = TextStyle(12, lineHeight: 1.4)
    public static let stopTitle = TextStyle(17, weight: 500, lineHeight: 1.3)
    public static let t11 = TextStyle(11, lineHeight: 1.6)
    public static let t11_5 = TextStyle(11.5, lineHeight: 1.6)
    public static let t12 = TextStyle(12, lineHeight: 1.7)
    public static let t12_5 = TextStyle(12.5, lineHeight: 1.7)
    public static let t13 = TextStyle(13, lineHeight: 1.75)
    public static let t14 = TextStyle(14, lineHeight: 1.6)
    public static let prose = TextStyle(12.5, lineHeight: 1.8)
    public static let cardTitle = TextStyle(14.5, weight: 500, lineHeight: 1.5)
    public static let question = TextStyle(19, weight: 500, lineHeight: 1.4, tracking: -0.2)
    public static let goalTitle = TextStyle(22, weight: 500, lineHeight: 1.35, tracking: -0.3)
    public static let wizardTitle = TextStyle(26, weight: 500, lineHeight: 1.3, tracking: -0.4)
    public static let hero = TextStyle(34, weight: 500, lineHeight: 1, tracking: -0.4)
    public static let brand = TextStyle(17, weight: 500, lineHeight: 1, tracking: -0.2)
    public static let mono = TextStyle(12, lineHeight: 1.6, family: .mono)
    public static let monoNotes = TextStyle(12, lineHeight: 1.7, family: .mono)
    /// styles.css body: 14.5px/1.5 system sans.
    public static let body = TextStyle(14.5, lineHeight: 1.5)
}

public extension View {
    /// Applies a CSS font shorthand: font, tracking, line spacing, uppercase.
    func textStyle(_ style: TextStyle) -> some View {
        self.font(style.font)
            .tracking(style.tracking)
            .lineSpacing(style.lineSpacing)
            .textCase(style.uppercase ? .uppercase : nil)
    }
}

public extension Fonts {
    /// System sans as a SwiftUI font at a CSS weight.
    static func swiftUISans(_ size: CGFloat, weight: Int = 400) -> Font { .system(size: size, weight: swiftUIWeight(weight)) }
    static func swiftUIMono(_ size: CGFloat, weight: Int = 400, italic: Bool = false) -> Font { Font(mono(size, weight: weight, italic: italic)) }

    static func swiftUIWeight(_ css: Int) -> Font.Weight {
        switch css {
        case ..<250: return .thin
        case ..<350: return .light
        case ..<450: return .regular
        case ..<550: return .medium
        case ..<650: return .semibold
        case ..<750: return .bold
        default: return .heavy
        }
    }
}
