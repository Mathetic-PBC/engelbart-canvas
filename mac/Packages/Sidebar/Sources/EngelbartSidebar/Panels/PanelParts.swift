import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// The pieces every panel beside the sidebar is made of (SidebarPanels.jsx PanelHead, Group, Empty, PanelRow, RowAction,
// SearchField, Scroll, PanelFoot, FootButton, FitCrumb, Count, Pill), in SwiftUI inside UI's FloatingPanel.

func sans(_ size: CGFloat, _ weight: Int = 400) -> Font { Fonts.swiftUISans(size, weight: weight) }
extension Color { init(hex: String) { self.init(NSColor(hex: hex)) } }

/// An icon in the colour around it.
struct SBIcon: View {
    let icon: Icon
    var size: CGFloat
    var stroke: CGFloat? = nil
    init(_ icon: Icon, size: CGFloat = 18, stroke: CGFloat? = nil) { self.icon = icon; self.size = size; self.stroke = stroke }
    var body: some View { IconView(stroked(icon, stroke), size: size).frame(width: size, height: size) }
}

/// A library row's kind glyph (ui/Icons.jsx KindGlyph): its kind key's icon in a `box`.
struct RowGlyph: View {
    let key: String
    var box: CGFloat = 16
    var color = Palette.gray700
    var body: some View { KindGlyph(key, box: box, color: color) }
}

struct PanelHead<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    var note: String? = nil
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(sans(13, 600)).foregroundStyle(Color(Palette.ink)).lineLimit(1)
            if let count, count > 0 { Text("\(count)").font(sans(12)).foregroundStyle(Color(Palette.fnt)) }
            if let note { Text(note).font(sans(12)).foregroundStyle(Color(Palette.fnt)).lineLimit(1) }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(EdgeInsets(top: 12, leading: 14, bottom: 6, trailing: 14))
    }
}
extension PanelHead where Trailing == EmptyView {
    init(title: String, count: Int? = nil, note: String? = nil) { self.init(title: title, count: count, note: note) { EmptyView() } }
}

struct PanelGroup<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(sans(12, 500)).foregroundStyle(Color(Palette.fnt)).padding(EdgeInsets(top: 10, leading: 10, bottom: 4, trailing: 10))
            content()
        }
    }
}

struct EmptyNote: View {
    let text: String
    var body: some View {
        Text(text).font(sans(12.5)).foregroundStyle(Color(Palette.fnt)).lineSpacing(12.5 * 0.55 - 4)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 6, leading: 14, bottom: 14, trailing: 14))
            .driveID("sb-empty")
    }
}

struct ErrorLine: View {
    let text: String
    var body: some View {
        Text(text).font(sans(12)).foregroundStyle(Color(Palette.del)).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(EdgeInsets(top: 4, leading: 10, bottom: 4, trailing: 10))
    }
}

/// A row of a panel: its icon, its name over a line of what it is, and what its hover offers on the right.
struct PanelRow<Icon: View, Actions: View>: View {
    var icon: Icon
    let title: String
    var meta: String? = nil
    var active = false
    var faint = false
    var actionsShown = false
    var onClick: () -> Void
    var onHover: (Bool) -> Void = { _ in }
    @ViewBuilder var actions: () -> Actions
    @State private var hovered = false
    var body: some View {
        HStack(spacing: 10) {
            icon.frame(width: 16).foregroundStyle(Color(Palette.gray700))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(sans(13.5, active ? 500 : 400)).foregroundStyle(Color(faint ? Palette.fnt : Palette.ink)).lineLimit(1).truncationMode(.tail)
                if let meta { Text(meta).font(sans(12)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).truncationMode(.tail) }
            }
            Spacer(minLength: 0)
            HStack(spacing: 2) { actions() }.opacity(hovered || actionsShown ? 1 : 0)
        }
        .padding(meta != nil ? EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 8) : EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 8))
        .frame(minHeight: meta != nil ? 42 : 32)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: active ? "#efefef" : hovered ? "#f3f3f3" : "#ffffff").opacity(active || hovered ? 1 : 0)))
        .contentShape(Rectangle())
        .onHover { hovered = $0; onHover($0) }
        .onTapGesture(perform: onClick)
        .animation(.easeOut(duration: 0.12), value: hovered)
    }
}

/// A small icon button on a row's right (shown on the row's hover unless `shown`).
struct RowActionButton<Content: View>: View {
    let label: String
    var shown = true
    var size: CGFloat = 22
    let action: () -> Void
    @ViewBuilder var content: () -> Content
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            content().frame(width: size, height: size)
                .foregroundStyle(Color(hovered ? Palette.ink : Palette.fnt))
                .background(RoundedRectangle(cornerRadius: 5).fill(Color(hex: "#e3e3e3").opacity(hovered ? 1 : 0)))
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .onHover { hovered = $0 }
    }
}

/// The count of a project (a bare number, grey and breathing while something runs) or Agents' pill.
struct CountBadge: View {
    let summary: AgentSummary?
    var pill = false
    @State private var dim = false
    var body: some View {
        if let s = summary, s.total > 0 {
            let running = s.running > 0
            Text(SidebarModel.countLabel(s.total)).font(sans(12).monospacedDigit())
                .foregroundStyle(Color(running ? (pill ? Palette.gray700 : Palette.fnt) : Palette.ink))
                .frame(minWidth: pill ? 22 : 12, minHeight: pill ? 22 : 16)
                .background(pill && !running ? RoundedRectangle(cornerRadius: 4).fill(Color(Palette.gray200)) : nil)
                .overlay(pill && running ? RoundedRectangle(cornerRadius: 4).strokeBorder(Color(dim ? Palette.gray200 : Palette.gray500), lineWidth: 1) : nil)
                .opacity(!pill && running && dim ? 0.4 : 1)
                .help("\(s.ready) to look at, \(s.running) running")
                .onAppear { if running { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true } } }
        }
    }
}

/// A path that does not fit loses its front, a level at a time, to "./" (FitCrumb).
struct FitCrumb: View {
    let parts: [String]
    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(0..<max(1, parts.count), id: \.self) { dropped in
                Text(SidebarModel.crumbFrom(parts, dropped)).font(sans(12)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).fixedSize()
            }
            Text(SidebarModel.crumbFrom(parts, max(0, parts.count - 1))).font(sans(12)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
    }
}

struct FootButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder var label: () -> Label
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) { label() }.font(sans(12.5)).foregroundStyle(Color(hovered ? Palette.ink : Palette.gray700))
                .padding(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.gray150).opacity(hovered ? 1 : 0)))
        }.buttonStyle(.plain).onHover { hovered = $0 }
    }
}

/// The keys a panel's field hands to its panel.
public enum FieldKey { case up, down, enter, tab, shiftTab, escape }

/// A panel's text field: it has the keyboard as soon as it shows; ↑ ↓ Enter Tab Escape go to `onKey` first (true: used).
struct PanelTextField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var font: NSFont = Fonts.sans(13.5)
    var autoFocus = true
    var readOnly = false
    var id: String? = nil
    var onKey: (FieldKey) -> Bool = { _ in false }
    var onChange: (String) -> Void = { _ in }
    /// Replaces each typed character before it lands (RenameField / NameDialog: / and \ become -).
    var sanitize: ((String) -> String)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> FocusingTextField {
        let field = FocusingTextField()
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = font
        field.textColor = Palette.ink
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.foregroundColor: Palette.fnt, .font: font])
        field.delegate = context.coordinator
        field.focusOnAppear = autoFocus
        field.stringValue = text
        if let id { field.setAccessibilityIdentifier(id) }
        return field
    }
    func updateNSView(_ field: FocusingTextField, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text { field.stringValue = text }
        field.isEditable = !readOnly
        field.alphaValue = readOnly ? 0.5 : 1
    }
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: PanelTextField
        init(_ parent: PanelTextField) { self.parent = parent }
        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            if let editor = field.currentEditor() as? NSTextView { editor.isContinuousSpellCheckingEnabled = false; editor.isAutomaticSpellingCorrectionEnabled = false }
            var value = field.stringValue
            if let clean = parent.sanitize { let c = clean(value); if c != value { value = c; field.stringValue = c } }
            parent.text = value
            parent.onChange(value)
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.moveUp(_:)): return parent.onKey(.up)
            case #selector(NSResponder.moveDown(_:)): return parent.onKey(.down)
            case #selector(NSResponder.insertNewline(_:)): return parent.onKey(.enter)
            case #selector(NSResponder.insertTab(_:)): return parent.onKey(.tab)
            case #selector(NSResponder.insertBacktab(_:)): return parent.onKey(.shiftTab)
            case #selector(NSResponder.cancelOperation(_:)): return parent.onKey(.escape)
            default: return false
            }
        }
    }
}

/// A panel's search field: a 14 search icon, the field, × to clear; #eaeaea, #c9c9c9 once something is typed.
struct SearchFieldView: View {
    @Binding var text: String
    var placeholder = "Search"
    var autoFocus = true
    var onKey: (FieldKey) -> Bool = { _ in false }
    var onChange: (String) -> Void = { _ in }
    var body: some View {
        HStack(spacing: 8) {
            SBIcon(SidebarIcons.search, size: 14).foregroundStyle(Color(Palette.fnt))
            PanelTextField(text: $text, placeholder: placeholder, autoFocus: autoFocus, onKey: onKey, onChange: onChange).frame(height: 18)
            if !text.isEmpty {
                Button { text = ""; onChange("") } label: { Text("×").font(sans(13)).foregroundStyle(Color(Palette.bd2)) }
                    .buttonStyle(.plain).accessibilityLabel("Clear")
            }
        }
        .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(text.isEmpty ? Palette.bd : Palette.bd2), lineWidth: 1))
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white))
        .padding(EdgeInsets(top: 4, leading: 10, bottom: 6, trailing: 10))
    }
}

/// A source's icon (SidebarIcons SourceIcon).
struct SourceGlyph: View {
    let row: LibraryRow?
    var size: CGFloat = 16
    var body: some View { SBIcon(SidebarIcons.source(SidebarModel.sourceIcon(row)), size: size) }
}

/// The kind key KindGlyph draws for a row or a found thing (model/kind.js kindKey).
func glyphKey(_ row: LibraryRow?) -> String { Kind.kindKey(row?.lib) }
func glyphKey(_ found: Library.Found?) -> String { found.map { Kind.kindKey($0.lib) } ?? "file" }

/// A right click on a SwiftUI row, handed over as the event (the app's own context menu opens at it, as onContextMenu
/// did); left clicks pass through to the row.
struct RightClick: NSViewRepresentable {
    let action: (NSEvent) -> Void
    func makeNSView(context: Context) -> Catcher { let v = Catcher(); v.action = action; return v }
    func updateNSView(_ v: Catcher, context: Context) { v.action = action }
    final class Catcher: NSView {
        var action: ((NSEvent) -> Void)?
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let type = NSApp.currentEvent?.type, type == .rightMouseDown || type == .rightMouseUp else { return nil }
            return super.hitTest(point)
        }
        override func rightMouseDown(with event: NSEvent) { action?(event) }
    }
}
