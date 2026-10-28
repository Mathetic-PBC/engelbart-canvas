import SwiftUI

/// Port of the design system's Option (ui/Option.jsx, components/forms/Option.jsx): a selectable row that becomes a box
/// when chosen. An 11px mark (circle = one of several, rounded square = many) filled in the accent, the label, an
/// optional why. Space and Enter choose it, as a click does.
public struct OptionRow: View {
    let on: Bool
    let many: Bool
    let label: String
    let why: String?
    let boxed: Bool
    let size: ButtonSize
    let action: () -> Void
    @State private var hov = false
    @FocusState private var focused: Bool

    public init(_ label: String, on: Bool, many: Bool = false, why: String? = nil, boxed: Bool = true, size: ButtonSize = .lg,
                action: @escaping () -> Void) {
        self.label = label; self.on = on; self.many = many; self.why = why; self.boxed = boxed; self.size = size; self.action = action
    }

    var lg: Bool { size == .lg }
    var padding: EdgeInsets {
        let (v, h): (CGFloat, CGFloat) = lg ? (why != nil ? (13, 14) : (12, 14)) : (9, 12)
        return EdgeInsets(top: v + 1, leading: h + 1, bottom: v + 1, trailing: h + 1)
    }
    var labelStyle: TextStyle {
        lg ? (why != nil ? TextStyle(13.5, weight: 500, lineHeight: 1.5) : TextStyle(13, lineHeight: 1.4)) : TextStyle(12.5, lineHeight: 1.6)
    }

    public var body: some View {
        HStack(alignment: why != nil ? .top : .center, spacing: 11) {
            mark.padding(.top, why != nil ? 4 : 0)
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .textStyle(labelStyle)
                    .foregroundStyle(Color(on ? Palette.ink : Palette.mut))
                    .lineLimit(why != nil ? 1 : nil)
                    .truncationMode(.tail)
                if let why {
                    Text(why)
                        .textStyle(TextStyle(lg ? 12 : 11.5, lineHeight: 1.6))
                        .foregroundStyle(Color(Palette.fnt))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(padding)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(on ? Palette.panel : hov ? Palette.hov : .clear)))
        .overlay(border)
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .onHover { hov = $0 }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.space) { action(); return .handled }
        .onKeyPress(.return) { action(); return .handled }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .accessibilityLabel(label)
        .animation(.easeOut(duration: Motion.fast), value: hov)
    }

    private var mark: some View {
        let shape = RoundedRectangle(cornerRadius: many ? 6 : 5.5)
        return shape
            .fill(Color(on ? Palette.acc : .clear))
            .overlay(shape.strokeBorder(Color(on ? Palette.acc : Palette.bd2), lineWidth: 1.5))
            .frame(width: 11, height: 11)
    }

    /// The box: ink all round when on, bd when boxed, clear when not — but its bottom edge stays bd (Option.jsx
    /// `borderBottomColor`), so a column of unboxed options reads as rows.
    @ViewBuilder private var border: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.sm)
        if on {
            shape.strokeBorder(Color(Palette.ink), lineWidth: 1)
        } else if boxed {
            shape.strokeBorder(Color(Palette.bd), lineWidth: 1)
        } else {
            VStack { Spacer(); Rectangle().fill(Color(Palette.bd)).frame(height: 1).padding(.horizontal, Radius.sm / 2) }
        }
    }
}

/// Port of the design system's Pager (ui/Pager.jsx): 6px dots; the current one stretches to 20px ink.
public struct Pager: View {
    let count: Int
    let index: Int
    public init(count: Int = 1, index: Int = 0) { self.count = count; self.index = index }
    public var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<max(1, count), id: \.self) { i in
                Capsule()
                    .fill(Color(i == index ? Palette.ink : Palette.bd2))
                    .frame(width: i == index ? 20 : 6, height: 6)
            }
        }
        .animation(.easeOut(duration: Motion.med), value: index)
        .accessibilityHidden(true)
    }
}

/// Port of the design system's ThinkingDots (ui/ThinkingDots.jsx): a 3×3 grid of pulsing dots and a label. Each dot's
/// opacity goes .15 → 1 at 35% → .15 at 70% over 1.1 s ease-in-out, 90 ms after the one before it.
public struct ThinkingDots: View {
    let label: String?
    let size: CGFloat
    public init(label: String? = "generating", size: CGFloat = 4) { self.label = label; self.size = size }
    public var body: some View {
        HStack(spacing: 10) {
            let gap: CGFloat = size > 3 ? 2.5 : 2
            Grid(horizontalSpacing: gap, verticalSpacing: gap) {
                ForEach(0..<3, id: \.self) { row in
                    GridRow {
                        ForEach(0..<3, id: \.self) { col in
                            Circle().fill(Color(Palette.ink)).frame(width: size, height: size)
                                .modifier(PulseModifier(period: 1.1, delay: Double(row * 3 + col) * 0.09,
                                                        stops: [(0, 0.15), (0.35, 1), (0.7, 0.15), (1, 0.15)]))
                        }
                    }
                }
            }
            if let label, !label.isEmpty {
                Text(label)
                    .font(Fonts.swiftUISans(size > 3 ? 13 : 11.5))
                    .tracking(0.3)
                    .foregroundStyle(Color(Palette.fnt))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
