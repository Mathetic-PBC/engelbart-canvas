import SwiftUI

// The hover variants the DC runtime expressed as style-hover="…" and styles.css keeps as classes (styles.css:31-44,
// 64-81). Each is a modifier with the class's name, so a screen reads like its JSX: `.hover(.wash)` for
// `className="hov-wash"`. Transitions are the CSS's 120 ms.

public enum HoverKind: Sendable {
    /// `.hov-ink`: text turns ink.
    case ink
    /// `.hov-wash`: #f2f2f2 fill.
    case wash
    /// `.hov-ink-wash`: both.
    case inkWash
    /// `.hov-wash2`: #eaeaea fill (a row on a grey card).
    case wash2
    /// `.hov-ink-wash2`.
    case inkWash2
    /// `.hov-del`: text turns red.
    case del
    /// `.hov-dim`: opacity .86.
    case dim
    /// `.hov-tab`: #e6e6e6 fill.
    case tab
    /// `.hov-x`: #e3e3e3 fill and ink text (a round ×).
    case closeX
    /// `.hov-outline`: ink text, bd border.
    case outline
    /// `.hov-save`: bd2 border, #eaeaea fill.
    case save
}

struct HoverModifier: ViewModifier {
    let kind: HoverKind
    let shape: AnyShape
    @State private var on = false

    func body(content: Content) -> some View {
        content
            .foregroundStyle(foreground)
            .background(fill.map { shape.fill(Color($0)) })
            .overlay(stroke.map { shape.stroke(Color($0), lineWidth: 1) })
            .opacity(kind == .dim && on ? Motion.hoverOpacity : 1)
            .contentShape(shape)
            .onHover { on = $0 }
            .animation(.easeOut(duration: Motion.fast), value: on)
    }

    private var foreground: AnyShapeStyle {
        guard on else { return AnyShapeStyle(.foreground) }
        switch kind {
        case .ink, .inkWash, .inkWash2, .closeX, .outline: return AnyShapeStyle(Color(Palette.ink))
        case .del: return AnyShapeStyle(Color(Palette.del))
        default: return AnyShapeStyle(.foreground)
        }
    }

    private var fill: NSColor? {
        guard on else { return nil }
        switch kind {
        case .wash, .inkWash: return Palette.hov
        case .wash2, .inkWash2, .save: return Palette.wash2
        case .tab: return Palette.tabHover
        case .closeX: return Palette.tabCloseHover
        default: return nil
        }
    }

    private var stroke: NSColor? {
        guard on else { return nil }
        switch kind {
        case .outline: return Palette.bd
        case .save: return Palette.bd2
        default: return nil
        }
    }
}

/// `.hov-bd2` / `.focus-bd2`: a 1px border that is bd at rest and bd2 under the pointer (or while focused inside).
struct BorderHoverModifier: ViewModifier {
    let radius: CGFloat
    let rest: NSColor
    let focused: Bool
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Color(on || focused ? Palette.bd2 : rest), lineWidth: 1))
            .onHover { on = $0 }
            .animation(.easeOut(duration: Motion.fast), value: on)
    }
}

/// `.ring`: one soft grey ring, 0 0 0 3px rgba(0,0,0,.07), on hover, focus-within or when on.
struct RingModifier: ViewModifier {
    let radius: CGFloat
    let active: Bool
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius + 3).fill(Color(Palette.ring)).padding(-3).opacity(on || active ? 1 : 0))
            .onHover { on = $0 }
            .animation(.easeOut(duration: Motion.fast), value: on || active)
    }
}

public extension View {
    /// One of styles.css's hover classes, washing `shape` (a rounded rectangle of `radius` by default).
    func hover(_ kind: HoverKind, radius: CGFloat = Radius.xs) -> some View {
        modifier(HoverModifier(kind: kind, shape: AnyShape(RoundedRectangle(cornerRadius: radius))))
    }
    func hover<S: Shape>(_ kind: HoverKind, shape: S) -> some View {
        modifier(HoverModifier(kind: kind, shape: AnyShape(shape)))
    }
    /// `.hov-bd2` (and `.focus-bd2` when `focused`): bd border turning bd2.
    func hoverBorder(radius: CGFloat = Radius.sm, rest: NSColor = Palette.bd, focused: Bool = false) -> some View {
        modifier(BorderHoverModifier(radius: radius, rest: rest, focused: focused))
    }
    /// `.ring` (all-projects screen): the soft grey ring on hover, focus or `active`.
    func ring(radius: CGFloat = Radius.lg, active: Bool = false) -> some View {
        modifier(RingModifier(radius: radius, active: active))
    }
    /// A 3px rgba(0,112,243,.18) focus ring (`button:focus-visible`, `--focus-ring`).
    func focusRing(_ shown: Bool, radius: CGFloat = Radius.sm) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius + 3).stroke(Color(Palette.accBg), lineWidth: 3).padding(-1.5).opacity(shown ? 1 : 0))
    }
}
