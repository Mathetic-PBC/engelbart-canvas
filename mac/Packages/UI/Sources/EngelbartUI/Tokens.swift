import AppKit
import CoreText
import SwiftUI

// Design tokens, copied from src/renderer/tokens/*.css and styles.css. 1 CSS px = 1 pt. Light scheme only, as the
// Electron app ships (the dark values exist in colors.css but nothing turns them on).
// The UI agent owns this package and extends it; other packages read from it and never hard-code a color or a font.

public extension NSColor {
    /// `#rrggbb` or `#rrggbbaa`.
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let hasAlpha = s.count == 8
        let r = CGFloat((v >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = CGFloat((v >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = CGFloat((v >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? CGFloat(v & 0xff) / 255 : 1
        self.init(srgbRed: r, green: g, blue: b, alpha: a)
    }
}

public enum Palette {
    // base scale
    public static let gray0 = NSColor(hex: "#ffffff")
    public static let gray50 = NSColor(hex: "#fafafa")
    public static let gray100 = NSColor(hex: "#f5f5f5")
    public static let gray150 = NSColor(hex: "#f2f2f2")
    public static let gray200 = NSColor(hex: "#eaeaea")
    public static let gray250 = NSColor(hex: "#e2e2e2")
    public static let gray300 = NSColor(hex: "#c9c9c9")
    public static let gray500 = NSColor(hex: "#8f8f8f")
    public static let gray700 = NSColor(hex: "#4d4d4d")
    public static let gray900 = NSColor(hex: "#171717")
    public static let red600 = NSColor(hex: "#e70022")
    public static let blue600 = NSColor(hex: "#0070f3")
    public static let blue700 = NSColor(hex: "#0761d1")
    public static let blue100 = NSColor(hex: "#e6f0fd")
    public static let blue400 = NSColor(hex: "#3291ff")

    // semantic (light)
    public static let bg = gray0            // page
    public static let panel = gray0         // cards, popovers
    public static let panel2 = gray50       // rail, sunken areas, headers
    public static let tint = gray50         // field fill
    public static let hov = gray150         // hover wash
    public static let ink = gray900         // primary text, filled controls
    public static let mut = gray700         // secondary text
    public static let fnt = gray500         // faint text, labels, placeholders
    public static let bd = gray200          // default border
    public static let bd2 = gray300         // hover border, idle marks
    public static let lineSoft = gray100
    public static let acc = blue600         // the one accent
    public static let accHov = blue700
    public static let accBg = NSColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.18) // focus ring
    public static let accHovBg = blue100
    public static let onAcc = gray0
    public static let del = red600          // destructive hover, errors
    /// `.ring` hover/focus outline on the all-projects screen: 0 0 0 3px rgba(0,0,0,.07).
    public static let ring = NSColor(white: 0, alpha: 0.07)
    /// Pending/flash highlight used by the Agent Viewer's "show line" (#fff1b8).
    public static let flash = NSColor(hex: "#fff1b8")
}

public extension Color {
    init(_ ns: NSColor) { self.init(nsColor: ns) }
}

public enum Radius {
    public static let xs: CGFloat = 6, sm: CGFloat = 8, md: CGFloat = 10, lg: CGFloat = 12, pill: CGFloat = 999
}

public enum Space {
    public static let s1: CGFloat = 3, s2: CGFloat = 6, s3: CGFloat = 9, s4: CGFloat = 12, s5: CGFloat = 14
    public static let s6: CGFloat = 18, s7: CGFloat = 22, s8: CGFloat = 32, s9: CGFloat = 40
}

public enum Motion {
    public static let fast: TimeInterval = 0.12, med: TimeInterval = 0.14, rise: TimeInterval = 0.26, slow: TimeInterval = 0.3
    public static let hoverOpacity: CGFloat = 0.86, disabledOpacity: CGFloat = 0.4
}

/// Fonts. `--font-sans` is system-ui (SF Pro on a Mac); `--font-mono` is Source Code Pro; post-its and paper notes use
/// Caveat; Geist is bundled for the places the renderer used it. Call `Fonts.register()` once at launch.
public enum Fonts {
    private static var registered = false

    public static func register() {
        guard !registered else { return }
        registered = true
        guard let dir = ResourceBundle.ui.url(forResource: "Fonts", withExtension: nil, subdirectory: "Resources")
            ?? ResourceBundle.ui.resourceURL?.appendingPathComponent("Resources/Fonts") else { return }
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in files where ["woff2", "woff", "ttf", "otf"].contains(file.pathExtension) {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }

    /// System sans at a CSS weight (400 regular, 500 medium, 600 semibold, 700 bold).
    public static func sans(_ size: CGFloat, weight: Int = 400) -> NSFont {
        NSFont.systemFont(ofSize: size, weight: nsWeight(weight))
    }

    /// Source Code Pro. The @fontsource subsets name their family "Source Code Pro ExtraLight" whatever the weight, so
    /// faces are picked by PostScript name (…-Regular 400, -Medium 500, -SemiBold 600; italics alongside).
    public static func mono(_ size: CGFloat, weight: Int = 400, italic: Bool = false) -> NSFont {
        register()
        let face = weight >= 600 ? "SemiBold" : weight >= 500 ? "Medium" : "Regular"
        let name = italic ? (face == "Regular" ? "SourceCodeProExtraLight-Italic" : "SourceCodeProExtraLight-\(face)Italic")
            : "SourceCodeProExtraLight-\(face)"
        return NSFont(name: name, size: size) ?? NSFont.monospacedSystemFont(ofSize: size, weight: nsWeight(weight))
    }

    public static func caveat(_ size: CGFloat, weight: Int = 400) -> NSFont {
        register()
        let name = weight >= 700 ? "Caveat-Bold" : weight >= 600 ? "Caveat-SemiBold" : weight >= 500 ? "Caveat-Medium" : "Caveat-Regular"
        return NSFont(name: name, size: size) ?? NSFont(name: "Caveat", size: size) ?? sans(size, weight: weight)
    }

    public static func geist(_ size: CGFloat, weight: Int = 400) -> NSFont {
        register()
        let names = [400: "Geist-Regular", 500: "Geist-Medium", 600: "Geist-SemiBold", 700: "Geist-Bold"]
        return NSFont(name: names[weight] ?? "Geist-Regular", size: size) ?? sans(size, weight: weight)
    }

    public static func nsWeight(_ css: Int) -> NSFont.Weight {
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

/// Bundled images from design/assets (trash, sticky note, Mathetic mark, copy-papers, welcome field, app icon).
public enum Images {
    public static func named(_ name: String) -> NSImage? {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        for e in ext.isEmpty ? ["png", "svg"] : [ext] {
            if let url = ResourceBundle.ui.url(forResource: base, withExtension: e, subdirectory: "Resources/Images")
                ?? ResourceBundle.ui.resourceURL?.appendingPathComponent("Resources/Images/\(base).\(e)"),
               let image = NSImage(contentsOf: url) { return image }
        }
        return nil
    }
}
