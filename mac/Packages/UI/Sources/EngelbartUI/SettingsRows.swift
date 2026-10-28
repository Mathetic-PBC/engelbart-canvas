import SwiftUI

// A settings page's groups and rows (ui/SettingsRows.jsx), shared by its pages: Models' here, Connections' in the
// Integrations package (MATH-64). Laid out as Linear's are: a heading, then a white card of rows split by inset hairlines.
// The card stands out past the page's left edge by its own padding, so a row's words line up under the title and heading.
// (The hairlines are the code's at 9413a56; Hudson's "no horizontal dividers" note is about lists, dialogs and menus.)

public enum SettingsMetrics {
    public static let pad: CGFloat = 16
    public static let rowMinHeight: CGFloat = 52
}

/// A group: its heading (500 14px, 28 above and 10 below) with an optional note beside it, and the card of rows.
public struct SettingsGroup<Note: View, Rows: View>: View {
    let title: String
    let note: Note
    let rows: Rows

    public init(_ title: String, @ViewBuilder note: () -> Note, @ViewBuilder rows: () -> Rows) {
        self.title = title; self.note = note(); self.rows = rows()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).textStyle(TextStyle(14, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                note
            }
            .padding(.top, 28).padding(.bottom, 10)
            _VariadicView.Tree(HairlineLayout()) { rows }
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(Palette.settingsLine), lineWidth: 1))
                .compositingGroup().shadow(color: .black.opacity(0x08 / 255.0), radius: 1, x: 0, y: 1)
                .padding(.horizontal, -SettingsMetrics.pad)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

public extension SettingsGroup where Note == EmptyView {
    init(_ title: String, @ViewBuilder rows: () -> Rows) { self.init(title, note: { EmptyView() }, rows: rows) }
}

/// Puts a 1px #efefef hairline, inset 16 each side, between consecutive rows.
struct HairlineLayout: _VariadicView_MultiViewRoot {
    func body(children: _VariadicView.Children) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(children.enumerated()), id: \.offset) { index, child in
                if index > 0 {
                    Rectangle().fill(Color(Palette.settingsHairline)).frame(height: 1).padding(.horizontal, SettingsMetrics.pad)
                }
                child
            }
        }
    }
}

/// A row: an optional icon (18, #4d4d4d) before its label (500 13.5) and an optional line on what it is for (12.5 grey),
/// an optional detail under that, and its control on the right.
public struct SettingsRow<Detail: View, Control: View>: View {
    let icon: Icon?
    let label: String
    let hint: String?
    let detail: Detail
    let control: Control

    public init(_ label: String, icon: Icon? = nil, hint: String? = nil, @ViewBuilder detail: () -> Detail, @ViewBuilder control: () -> Control) {
        self.label = label; self.icon = icon; self.hint = hint; self.detail = detail(); self.control = control()
    }

    public var body: some View {
        HStack(spacing: 10) {
            if let icon {
                IconView(icon, size: 18).foregroundStyle(Color(Palette.mut)).padding(.trailing, 2)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(label).textStyle(TextStyle(13.5, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                if let hint { Text(hint).textStyle(TextStyle(12.5, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)) }
                detail
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control
        }
        .padding(.vertical, 10).padding(.horizontal, SettingsMetrics.pad)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
    }
}

public extension SettingsRow where Detail == EmptyView {
    init(_ label: String, icon: Icon? = nil, hint: String? = nil, @ViewBuilder control: () -> Control) {
        self.init(label, icon: icon, hint: hint, detail: { EmptyView() }, control: control)
    }
}

/// A row's button (Reveal, Connect, Sign in…): 30 tall, 1px #e4e4e4, radius 7, white, a hairline shadow, 500 13px.
public struct SettingsButtonStyle: ButtonStyle {
    let color: NSColor
    public init(color: NSColor = Palette.ink) { self.color = color }
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Fonts.swiftUISans(13, weight: 500))
            .foregroundStyle(Color(color))
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color.white))
            .compositingGroup().shadow(color: .black.opacity(0x0a / 255.0), radius: 0.5, x: 0, y: 1)
            .hoverBorder(radius: 7, rest: Palette.fieldBorder)
            .contentShape(Rectangle())
            .fixedSize()
    }
}

/// A compact select with the app's chevron (`Choice` in Settings.jsx): 30 tall, padding 0 26 0 10, 1px #e4e4e4, radius 7,
/// white, 13px; a fixed width lines a column of them up; disabled .45.
public struct SettingsChoice: View {
    public struct Option: Hashable { public let value: String; public let label: String; public init(value: String, label: String) { self.value = value; self.label = label } }
    let label: String
    let value: String
    let options: [Option]
    let width: CGFloat?
    let onChange: (String) -> Void
    @Environment(\.isEnabled) private var enabled

    public init(_ label: String, value: String, options: [Option], width: CGFloat? = nil, onChange: @escaping (String) -> Void) {
        self.label = label; self.value = value; self.options = options; self.width = width; self.onChange = onChange
    }

    public var body: some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button { onChange(option.value) } label: {
                    if option.value == value { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                }
            }
        } label: {
            HStack(spacing: 0) {
                Text(options.first { $0.value == value }?.label ?? value)
                    .font(Fonts.swiftUISans(13)).foregroundStyle(Color(Palette.ink)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, 10).padding(.trailing, 26)
            .frame(width: width, height: 30)
            .overlay(alignment: .trailing) {
                IconView(SettingsIcons.selectChevron).foregroundStyle(Color(Palette.fnt)).padding(.trailing, 8)
            }
            .background(RoundedRectangle(cornerRadius: 7).fill(Color.white))
            .compositingGroup().shadow(color: .black.opacity(0x0a / 255.0), radius: 0.5, x: 0, y: 1)
            .hoverBorder(radius: 7, rest: Palette.fieldBorder)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .opacity(enabled ? 1 : 0.45)
        .accessibilityLabel(label)
    }
}
