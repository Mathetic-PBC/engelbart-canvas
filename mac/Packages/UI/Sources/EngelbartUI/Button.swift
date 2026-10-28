import SwiftUI

// Port of the design system's Button (ui/Button.jsx, components/actions/Button.jsx), plus the two buttons App.jsx draws
// by hand that every screen reuses: the blue one (DirectoryGate's "Choose folder…") and the ghost link ("All projects").

/// A button's box: a capsule for the caps pills (radius 999), else radius 8.
public struct ButtonShape: InsettableShape {
    public var pill: Bool
    var inset: CGFloat = 0
    public init(pill: Bool) { self.pill = pill }
    public func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: inset, dy: inset)
        // Circular, as CSS border-radius is (a continuous capsule draws flattened ends).
        return pill ? Capsule(style: .circular).path(in: r) : RoundedRectangle(cornerRadius: max(0, Radius.sm - inset), style: .circular).path(in: r)
    }
    public func inset(by amount: CGFloat) -> ButtonShape { var s = self; s.inset += amount; return s }
}

public enum ButtonVariant: Sendable {
    /// White box, bd border; hover hov fill and bd2 border.
    case outline
    /// Ink fill, onAcc text; hover opacity .86.
    case filled
    /// Accent text, no box; hover accHov.
    case link
    /// Accent fill, white text, no border (App.jsx DirectoryGate).
    case blue
    /// Faint text, no box; hover ink (`.hov-ink` on a bare button).
    case ghost
}

public enum ButtonSize: Sendable { case lg, sm }

/// The look, as a ButtonStyle, for wrapping any SwiftUI Button.
public struct EngelbartButtonStyle: ButtonStyle {
    public var variant: ButtonVariant
    public var size: ButtonSize
    public var caps: Bool
    public var go: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isFocused) private var focused

    public init(_ variant: ButtonVariant = .outline, size: ButtonSize = .lg, caps: Bool = false, go: Bool = false) {
        self.variant = variant; self.size = size; self.caps = caps; self.go = go
    }

    public func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, variant: variant, size: size, caps: caps, go: go, enabled: enabled, focused: focused)
    }

    struct Face: View {
        let configuration: Configuration
        let variant: ButtonVariant
        let size: ButtonSize
        let caps: Bool
        let go: Bool
        let enabled: Bool
        let focused: Bool
        @State private var hov = false

        var lg: Bool { size == .lg }
        var bordered: Bool { variant == .outline || variant == .filled || (caps && variant != .link) }
        var fontSize: CGFloat { caps ? (lg ? 10 : 9) : (lg ? 13 : 12.5) }
        var padding: EdgeInsets {
            if variant == .link || variant == .ghost { return EdgeInsets() }
            if variant == .blue { return EdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18) }
            let (v, h): (CGFloat, CGFloat) = caps ? (lg ? (9, 18) : (7, 15)) : (lg ? (11, 16) : (8, 12))
            // The CSS border sits outside the padding; strokeBorder draws inside, so one more point each side.
            let b: CGFloat = bordered ? 1 : 0
            return EdgeInsets(top: v + b, leading: h + b, bottom: v + b, trailing: h + b)
        }
        var radius: CGFloat { caps ? Radius.pill : Radius.sm }
        /// A pill is a capsule (a 999-radius rounded rectangle draws ragged ends).
        var shape: ButtonShape { ButtonShape(pill: caps) }

        var textColor: NSColor {
            switch variant {
            case .link: return !enabled ? Palette.fnt : hov ? Palette.accHov : Palette.acc
            case .ghost: return hov && enabled ? Palette.ink : Palette.fnt
            case .blue: return Palette.onAcc
            case .filled: return enabled ? Palette.onAcc : Palette.fnt
            case .outline: return enabled ? Palette.ink : Palette.fnt
            }
        }
        var fill: NSColor? {
            switch variant {
            case .link, .ghost: return nil
            case .blue: return Palette.acc
            case .filled: return enabled ? Palette.ink : Palette.hov
            case .outline: return !enabled ? Palette.hov : hov ? Palette.hov : Palette.panel
            }
        }
        var border: NSColor? {
            guard bordered else { return nil }
            switch variant {
            case .filled: return enabled ? Palette.ink : Palette.bd
            default: return !enabled ? Palette.bd : hov ? Palette.bd2 : Palette.bd
            }
        }

        var body: some View {
            HStack(spacing: caps ? 7 : 6) {
                configuration.label
                if go {
                    Text("›").font(Fonts.swiftUISans(caps ? (lg ? 12 : 10) : 14)).tracking(0)
                }
            }
            .font(Fonts.swiftUISans(fontSize, weight: 500))
            .tracking(caps ? (lg ? 1.4 : 1.5) : 0)
            .textCase(caps ? .uppercase : nil)
            .lineLimit(1)
            .frame(minHeight: variant == .blue ? 20 : fontSize) // line-height 1 (the blue one's min height is 40 overall)
            .padding(padding)
            .foregroundStyle(Color(textColor))
            .background(fill.map { shape.fill(Color($0)) })
            .overlay(border.map { shape.strokeBorder(Color($0), lineWidth: 1) })
            .opacity(variant == .filled && enabled && hov ? Motion.hoverOpacity : 1)
            .focusRing(focused && variant != .link && variant != .ghost, radius: radius)
            .contentShape(Rectangle())
            .onHover { hov = $0 }
            .animation(.easeOut(duration: Motion.fast), value: hov)
        }
    }
}

/// `<Button variant size caps go disabled title onClick>`.
public struct EButton<Label: View>: View {
    let variant: ButtonVariant
    let size: ButtonSize
    let caps: Bool
    let go: Bool
    let title: String?
    let action: () -> Void
    let label: Label

    public init(_ variant: ButtonVariant = .outline, size: ButtonSize = .lg, caps: Bool = false, go: Bool = false,
                title: String? = nil, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.variant = variant; self.size = size; self.caps = caps; self.go = go; self.title = title; self.action = action; self.label = label()
    }

    public var body: some View {
        let button = Button(action: action) { label }
            .buttonStyle(EngelbartButtonStyle(variant, size: size, caps: caps, go: go))
        if let title { button.help(title) } else { button }
    }
}

public extension EButton where Label == Text {
    init(_ text: String, _ variant: ButtonVariant = .outline, size: ButtonSize = .lg, caps: Bool = false, go: Bool = false,
         title: String? = nil, action: @escaping () -> Void) {
        self.init(variant, size: size, caps: caps, go: go, title: title, action: action) { Text(text) }
    }
}
