import SwiftUI
import AppKit
import EngelbartCore
import EngelbartUI

/// environment-panel.css's values.
enum EnvironmentStyle {
    static let text = Color(Palette.ink)
    static let column = Color(NSColor(hex: "#737373"))
    static let note = Color(NSColor(hex: "#8a8a8a"))
    static let missing = Color(NSColor(hex: "#b34235"))
    static let border = Color(NSColor(hex: "#dedede"))
    static let borderHover = Color(NSColor(hex: "#bcbcbc"))
    static let borderFocus = Color(NSColor(hex: "#737373"))
    static let fieldText = Color(NSColor(hex: "#262626"))
    static let disabledFill = Color(Palette.gray50)
    static let disabledText = Color(NSColor(hex: "#525252"))
    static let struck = Color(Palette.gray500)
    static let buttonText = Color(NSColor(hex: "#404040"))
    static let buttonHover = Color(NSColor(hex: "#f7f7f7"))
    static let primary = Color(NSColor(hex: "#25282b"))
    static let primaryHover = Color(NSColor(hex: "#404448"))
}

/// EnvironmentPanel.jsx: a repository's saved environment values, by name (values never shown), with what the last scan
/// found. `embedded`: inside the build details (padding 22, no frame); otherwise a disclosure titled "Environment".
public struct EnvironmentPanelView: View {
    @ObservedObject var model: EnvironmentPanelModel
    let embedded: Bool
    @State private var expanded = false

    public init(model: EnvironmentPanelModel, embedded: Bool = false) { self.model = model; self.embedded = embedded }

    public var body: some View {
        Group {
            if embedded { content.padding(22) }
            else {
                DisclosureGroup(isExpanded: $expanded) { content.padding(.top, 12) } label: {
                    Text("Environment").font(Font(Fonts.sans(12, weight: 500))).foregroundColor(EnvironmentStyle.text)
                }
                .padding(14)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(Palette.bd), lineWidth: 1))
                .padding(.horizontal, 22).padding(.vertical, 18)
            }
        }
        .accessibilityLabel("Environment variables")
    }

    private func grid<A: View, B: View, C: View>(@ViewBuilder _ a: () -> A, @ViewBuilder _ b: () -> B, @ViewBuilder _ c: () -> C) -> some View {
        let a = a(), b = b(), c = c()
        return GeometryReader { geo in
            let free = max(0, geo.size.width - 56 - 28)
            HStack(alignment: .top, spacing: 14) {
                a.frame(width: free / 2.4, alignment: .leading)
                b.frame(width: free * 1.4 / 2.4, alignment: .leading)
                c.frame(width: 56, alignment: .leading)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            let disabled = model.busy || model.saved == nil
            VStack(alignment: .leading, spacing: 0) {
                grid({ columnHead("Name") }, { columnHead("Value") }, { EmptyView() }).frame(height: 13).padding(.bottom, 6).accessibilityHidden(true)
                ForEach(model.rows, id: \.name) { row in rowView(row) }
                grid({
                    EnvironmentField(placeholder: "VARIABLE_NAME", text: $model.name, secure: false, mono: true)
                        .accessibilityLabel("Environment variable name")
                }, {
                    EnvironmentField(placeholder: "Value", text: $model.value, secure: true, onSubmit: { model.add() })
                        .accessibilityLabel("New environment value")
                }, {
                    EnvironmentButton("Add", primary: true) { model.add() }.disabled(model.name.trimmed.isEmpty)
                }).frame(height: 34)
                HStack(spacing: 8) {
                    Spacer()
                    EnvironmentButton("Save") { Task { await model.save(restart: false) } }.disabled(model.changes.isEmpty)
                    EnvironmentButton(model.restartTitle) { Task { await model.save(restart: true) } }.disabled(!model.canRestart)
                }
                .padding(.top, 22 + 14)
            }
            .disabled(disabled)
            if model.saved == nil && model.error.isEmpty { message("Loading variables…") }
            if let removed = model.saved?.removed, !removed.isEmpty { message("Removed: \(removed.joined(separator: ", "))") }
            if !model.notice.isEmpty { message(model.notice) }
            if !model.error.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.error).font(Font(Fonts.sans(11))).foregroundColor(EnvironmentStyle.missing)
                    EnvironmentButton("Reload saved names") { Task { await model.reload() } }.disabled(model.busy)
                }
                .padding(.top, 12)
            }
        }
        .font(Font(Fonts.sans(12)))
        .foregroundColor(EnvironmentStyle.text)
    }

    private func columnHead(_ text: String) -> some View {
        Text(text.uppercased()).font(Font(Fonts.sans(9, weight: 500))).kerning(9 * 0.04).foregroundColor(EnvironmentStyle.column)
    }

    private func message(_ text: String) -> some View {
        Text(text).font(Font(Fonts.sans(11))).foregroundColor(EnvironmentStyle.column).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
    }

    private func rowView(_ row: EnvironmentRow) -> some View {
        let removing = model.isRemoving(row.name)
        let edited = model.isEdited(row.name)
        return VStack(alignment: .leading, spacing: 5) {
            grid({
                Text(row.name).font(Font(Fonts.mono(12))).foregroundColor(removing ? EnvironmentStyle.struck : EnvironmentStyle.disabledText)
                    .strikethrough(removing).lineLimit(1).truncationMode(.tail).help(row.name)
                    .padding(.horizontal, 9).frame(maxWidth: .infinity, minHeight: 34, maxHeight: 34, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 3).fill(EnvironmentStyle.disabledFill))
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(EnvironmentStyle.border, lineWidth: 1))
                    .accessibilityLabel("Name of \(row.name)")
            }, {
                EnvironmentField(placeholder: model.placeholder(row), text: Binding(
                    get: { (model.changes[row.name] ?? nil) ?? "" },
                    set: { model.setValue($0, for: row.name) }), secure: true)
                    .disabled(removing).accessibilityLabel("Value for \(row.name)")
            }, {
                if row.saved || edited {
                    EnvironmentButton(model.action(row), quiet: true) { model.toggle(row) }
                        .accessibilityLabel("\(removing ? "Undo removal of" : model.action(row)) \(row.name)")
                }
            }).frame(height: 34)
            Text(model.note(row)).font(Font(Fonts.sans(11))).foregroundColor(model.needsValue(row) ? EnvironmentStyle.missing : EnvironmentStyle.note)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 16)
    }
}

/// `.environment-input`: 34 high, radius 3, #dedede border (#bcbcbc on hover, #737373 focused), mono 12.
struct EnvironmentField: View {
    let placeholder: String
    @Binding var text: String
    var secure: Bool
    var mono = true
    var onSubmit: () -> Void = {}
    @State private var hovering = false
    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Group {
            if secure { SecureField("", text: $text, prompt: prompt) } else { TextField("", text: $text, prompt: prompt) }
        }
        .textFieldStyle(.plain)
        .font(Font(mono ? Fonts.mono(12) : Fonts.sans(12)))
        .foregroundColor(enabled ? EnvironmentStyle.fieldText : EnvironmentStyle.disabledText)
        .autocorrectionDisabled()
        .focused($focused)
        .onSubmit(onSubmit)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, minHeight: 34, maxHeight: 34)
        .background(RoundedRectangle(cornerRadius: 3).fill(enabled ? Color(Palette.bg) : EnvironmentStyle.disabledFill))
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(focused ? EnvironmentStyle.borderFocus : hovering && enabled ? EnvironmentStyle.borderHover : EnvironmentStyle.border, lineWidth: 1))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }

    private var prompt: Text { Text(placeholder).font(Font(Fonts.sans(12))).foregroundColor(Color(NSColor(hex: "#a3a3a3"))) }
}

/// `.environment-button` (white, #dedede border), `-primary` (#25282b), and the rows' quiet action (no border, 11 px).
struct EnvironmentButton: View {
    let title: String
    var primary = false
    var quiet = false
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    init(_ title: String, primary: Bool = false, quiet: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.primary = primary; self.quiet = quiet; self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title).font(Font(Fonts.sans(quiet ? 11 : 12))).lineLimit(1)
                .foregroundColor(primary ? .white : quiet ? EnvironmentStyle.column : EnvironmentStyle.buttonText)
                .padding(.horizontal, quiet ? 4 : 10).padding(.vertical, 6).frame(minHeight: 34)
                .background(RoundedRectangle(cornerRadius: 3).fill(fill))
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(border, lineWidth: 1))
        }
        .buttonStyle(.plain).opacity(enabled ? 1 : 0.4).onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }

    private var active: Bool { hovering && enabled }
    private var fill: Color {
        if primary { return active ? EnvironmentStyle.primaryHover : EnvironmentStyle.primary }
        if quiet { return .clear }
        return active ? EnvironmentStyle.buttonHover : Color(Palette.bg)
    }
    private var border: Color {
        if primary { return active ? EnvironmentStyle.primaryHover : EnvironmentStyle.primary }
        if quiet { return .clear }
        return active ? EnvironmentStyle.borderHover : EnvironmentStyle.border
    }
}

/// SandboxProgress's UI pieces for AppKit hosts.
public enum SandboxViews {
    @MainActor public static func bell(_ model: SandboxProgressModel) -> NSView { NSHostingView(rootView: NotificationBellView(model: model)) }
    @MainActor public static func rows(_ model: SandboxProgressModel, onClose: @escaping () -> Void = {}) -> NSView {
        NSHostingView(rootView: NotificationRowsView(model: model, onClose: onClose))
    }
    @MainActor public static func environment(_ model: EnvironmentPanelModel, embedded: Bool = false) -> NSView {
        NSHostingView(rootView: EnvironmentPanelView(model: model, embedded: embedded))
    }
}
