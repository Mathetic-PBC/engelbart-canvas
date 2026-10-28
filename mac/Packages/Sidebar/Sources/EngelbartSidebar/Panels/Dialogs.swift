import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// What opens in the middle of the window over a faint veil (SidebarPanels.jsx Centered): Search, Keyboard shortcuts, a new
// project's name and a new folder's. A child panel covering the window: the veil rgba(23,23,23,.12), the card at 14% of
// the height, width min(w, window − 32), radius 12, 1px #e2e2e2, shadow 0 16 48 rgba(0,0,0,.16); Escape or a press on the
// veil closes it.

@MainActor
final class CenteredDialog {
    private let panel: KeyPanel
    private let host: NSHostingView<AnyView>
    private weak var parent: NSWindow?
    private var monitor: Any?
    private(set) var isOpen = false
    var onClose: (() -> Void)?
    /// Presses on the veil close it unless this says no (a name dialog while it is creating).
    var canClose: () -> Bool = { true }

    final class KeyPanel: NSPanel {
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { false }
    }

    init() {
        panel = KeyPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false; panel.animationBehavior = .none
        host = NSHostingView(rootView: AnyView(EmptyView()))
        panel.contentView = host
    }

    func show<V: View>(in window: NSWindow, width: CGFloat, top: CGFloat = 0.14, label: String, _ card: V) {
        parent = window
        guard let content = window.contentView else { return }
        let size = content.bounds.size
        let w = min(width, size.width - 32)
        host.rootView = AnyView(
            ZStack(alignment: .top) {
                Color(red: 23 / 255, green: 23 / 255, blue: 23 / 255).opacity(0.12)
                    .contentShape(Rectangle())
                    .onTapGesture { [weak self] in if self?.canClose() ?? true { self?.close() } }
                card
                    .frame(width: w)
                    .frame(maxHeight: size.height * 0.72)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: "#e2e2e2"), lineWidth: 1))
                    .compositingGroup().shadow(color: .black.opacity(0.16), radius: 24, x: 0, y: 16)
                    .padding(.top, size.height * top)
                    .accessibilityLabel(label)
            }
            .frame(width: size.width, height: size.height)
        )
        panel.setFrame(FloatingPanel.screenRect(CGRect(origin: .zero, size: size), in: content), display: true)
        if !isOpen {
            isOpen = true
            window.addChildWindow(panel, ordered: .above)
            panel.makeKey()
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.isOpen, event.keyCode == 53, event.window === self.panel else { return event }
                if self.canClose() { self.close() }
                return nil
            }
        }
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        let done = onClose
        onClose = nil
        done?()
    }
    var window: NSWindow { panel }
}

/// A name for something new (2026-10-13: "when creating it should always be Create project within {PARENT NAME}"):
/// `title` over a field, Cancel and `action`; Create waits for a name; Enter makes it.
@MainActor
final class NameDialogModel: ObservableObject {
    @Published var name = ""
    @Published var busy = false
    @Published var problem = ""
    let title: String
    let placeholder: String
    let action: String
    let onCreate: (String) async throws -> Void
    var onClose: () -> Void = {}
    init(title: String, placeholder: String, action: String, onCreate: @escaping (String) async throws -> Void) {
        self.title = title; self.placeholder = placeholder; self.action = action; self.onCreate = onCreate
    }
    var given: String { name.trimmed }
    /// / and \ become - (they would make a folder on disk).
    static func clean(_ s: String) -> String { s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-") }
    func create() {
        guard !busy, !given.isEmpty else { return }
        busy = true; problem = ""
        let value = given
        Task { @MainActor in
            do { try await self.onCreate(value); self.onClose() } catch { self.problem = AddRun.message(error); self.busy = false }
        }
    }
}

struct NameDialogView: View {
    @ObservedObject var model: NameDialogModel
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(model.title).font(sans(15, 500)).foregroundStyle(Color(Palette.ink))
            PanelTextField(text: $model.name, placeholder: model.placeholder, font: Fonts.sans(14), id: "name-field",
                           onKey: { key in if key == .enter { model.create(); return true }; return false }, onChange: { _ in model.problem = "" },
                           sanitize: NameDialogModel.clean)
                .padding(.horizontal, 10).frame(height: 36)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(model.given.isEmpty ? Palette.bd : Palette.bd2), lineWidth: 1))
                .padding(.top, 14)
            if !model.problem.isEmpty { Text(model.problem).font(sans(12)).foregroundStyle(Color(Palette.del)).padding(.top, 6) }
            HStack(spacing: 8) {
                Spacer()
                Button(action: model.onClose) {
                    Text("Cancel").font(sans(13, 500)).foregroundStyle(Color(Palette.ink)).padding(.horizontal, 12).frame(height: 30)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white)).overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(hex: "#e4e4e4"), lineWidth: 1))
                }.buttonStyle(.plain).disabled(model.busy)
                Button(action: model.create) {
                    Text(model.busy ? "Creating…" : model.action).font(sans(13, 500)).foregroundStyle(Color.white).padding(.horizontal, 12).frame(height: 30)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color(Palette.ink)))
                        .opacity(model.busy || model.given.isEmpty ? 0.35 : 1)
                }.buttonStyle(.plain).disabled(model.busy || model.given.isEmpty).driveID("name-create")
            }.padding(.top, 16)
        }
        .padding(EdgeInsets(top: 18, leading: 18, bottom: 16, trailing: 18))
        .driveID("sb-name-dialog")
    }
}

/// Keyboard shortcuts (the project menu's last row): ⌘J, Ctrl+1–9 for this top-level project's level-2 projects, ⌘\.
/// 2026-10-14, Hudson: no subtext and no horizontal dividing lines here; the groups are set apart by space alone.
struct ShortcutsDialogView: View {
    let roots: [ProjectNode]
    let railHidden: Bool
    var onNext: () -> Void
    var onGo: (String) -> Void
    var onToggleRail: () -> Void
    var onClose: () -> Void
    var body: some View {
        let ids = SidebarModel.shortcutProjects(roots)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Keyboard shortcuts").font(sans(13, 600)).foregroundStyle(Color(Palette.ink))
                Spacer()
                RowActionButton(label: "Close", size: 28, action: onClose) { SBIcon(SidebarIcons.close, size: 14) }
            }.padding(EdgeInsets(top: 0, leading: 14, bottom: 6, trailing: 8))
            ShortcutRow(label: "Next agent needing attention", key: "⌘J", action: onNext)
            if !ids.isEmpty {
                Text("Projects").font(sans(12, 500)).foregroundStyle(Color(Palette.fnt)).padding(EdgeInsets(top: 14, leading: 14, bottom: 4, trailing: 14))
                ForEach(Array(ids.enumerated()), id: \.element) { i, id in
                    ShortcutRow(label: roots.first { $0.id == id }?.name ?? "", key: "Ctrl+\(i + 1)") { onGo(id) }.driveID("shortcut-project=\(id)")
                }
            }
            Color.clear.frame(height: 10)
            ShortcutRow(label: "\(railHidden ? "Show" : "Hide") sidebar", key: "⌘\\", action: onToggleRail)
        }
        .padding(EdgeInsets(top: 14, leading: 6, bottom: 14, trailing: 6))
        .driveID("sb-shortcuts-dialog")
    }
}

struct ShortcutRow: View {
    let label: String
    let key: String
    let action: () -> Void
    var body: some View {
        MenuRow(height: 38, action: action) {
            Text(label).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 20)
            Text(key).font(sans(12).monospacedDigit()).foregroundStyle(Color(Palette.fnt))
        }
    }
}

/// Search (the fixed row under Library): the projects here, this project's sources, and the library, as words are typed;
/// an address or a path can be added. ↑↓ and Enter, or a press: a project goes there, a source opens; a library row's +
/// brings it into this project.
@MainActor
final class SearchDialogModel: ObservableObject {
    struct Item: Equatable { enum Kind { case workspace, source, library, fresh }; var kind: Kind; var key: String; var workspace: FlatProject?; var result: SearchResult? }
    struct Section: Equatable { var title: String; var items: [Item] }
    static let MAX_EACH = 6

    @Published var q = "" { didSet { if q != oldValue { idx = 0; problem = ""; lookup.typed(typed) } } }
    @Published var idx = 0
    @Published var problem = ""
    let workspaces: [FlatProject]
    let rows: [LibraryRow]
    let library: [LibraryRow]
    let inRail: (String) -> Bool
    let lookup: LookupModel
    let bodies = BodiesModel()
    var onGoWorkspace: (String) -> Void = { _ in }
    var onOpen: (LibraryRow) -> Void = { _ in }
    var onLink: (LibraryRow) -> Void = { _ in }
    var onAddInput: (String) async throws -> Void = { _ in }
    var onClose: () -> Void = {}
    private var bag: [Any] = []

    init(workspaces: [FlatProject], rows: [LibraryRow], library: [LibraryRow], inRail: @escaping (String) -> Bool, lookup: LookupModel) {
        self.workspaces = workspaces; self.rows = rows; self.library = library; self.inRail = inRail; self.lookup = lookup
        bag.append(lookup.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
        bag.append(bodies.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
    }
    var typed: String { q.trimmed }
    var answer: Library.Lookup? { lookup.answer(typed) }
    var sections: [Section] {
        guard !typed.isEmpty else { return [] }
        var out: [Section] = []
        let spaces = NavModel.findWorkspaces(workspaces, typed).prefix(Self.MAX_EACH).map { Item(kind: .workspace, key: "ws:\($0.id)", workspace: $0) }
        if !spaces.isEmpty { out.append(Section(title: "Projects", items: Array(spaces))) }
        let here = RailModel.searchRows(query: typed, library: rows, inRail: { _ in true }, bodies: bodies.bodies).prefix(Self.MAX_EACH).map { Item(kind: .source, key: "here:\($0.key)", result: $0) }
        if !here.isEmpty { out.append(Section(title: "In this project", items: Array(here))) }
        let held = Set(rows.map(\.id))
        let lib = RailModel.searchRows(query: typed, library: library.filter { !held.contains($0.id) }, inRail: inRail, found: answer, bodies: bodies.bodies)
            .prefix(Self.MAX_EACH).map { Item(kind: $0.kind == .fresh ? .fresh : .library, key: "lib:\($0.key)", result: $0) }
        if !lib.isEmpty { out.append(Section(title: "Library", items: Array(lib))) }
        return out
    }
    var flat: [Item] { sections.flatMap(\.items) }
    var at: Int { let n = flat.count; return n == 0 ? -1 : min(idx, n - 1) }
    var error: String { !problem.isEmpty ? problem : (answer?.error ?? "") }

    func activate(_ item: Item?) {
        guard let item else { return }
        switch item.kind {
        case .workspace: onClose(); if let id = item.workspace?.id { onGoWorkspace(id) }
        case .fresh:
            let input = typed
            Task { @MainActor in do { try await self.onAddInput(input); self.onClose() } catch { self.problem = AddRun.message(error) } }
        default: onClose(); if let row = item.result?.row { onOpen(row) }
        }
    }
    func key(_ key: FieldKey) -> Bool {
        let n = flat.count
        switch key {
        case .down: if n > 0 { idx = (at + 1) % n }; return true
        case .up: if n > 0 { idx = (at - 1 + n) % n }; return true
        case .enter: if at >= 0 { activate(flat[at]) }; return true
        default: return false
        }
    }
}

struct SearchDialogView: View {
    @ObservedObject var model: SearchDialogModel
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                SBIcon(SidebarIcons.search, size: 16).foregroundStyle(Color(Palette.fnt))
                PanelTextField(text: $model.q, placeholder: "Search projects, sources and the library", font: Fonts.sans(15), id: "sb-search-input", onKey: model.key)
            }.padding(.horizontal, 16).frame(height: 52)
            if !model.typed.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        let flat = model.flat
                        ForEach(model.sections, id: \.title) { section in
                            PanelGroup(title: section.title) {
                                ForEach(section.items, id: \.key) { item in
                                    let i = flat.firstIndex(of: item) ?? -1
                                    row(item, active: i == model.at).onHover { if $0 { model.idx = i } }.driveID("search-result=\(item.key)")
                                }
                            }
                        }
                        if flat.isEmpty { EmptyNote(text: "Nothing matches “\(model.typed)”.") }
                        if !model.error.isEmpty { ErrorLine(text: model.error).padding(.horizontal, 4) }
                    }.padding(EdgeInsets(top: 4, leading: 6, bottom: 8, trailing: 6))
                }
            }
        }.driveID("sb-search-dialog")
    }

    @ViewBuilder func row(_ item: SearchDialogModel.Item, active: Bool) -> some View {
        if item.kind == .workspace, let ws = item.workspace {
            PanelRow(icon: SBIcon(SidebarIcons.workspace, size: 15), title: ws.name, meta: ws.above.isEmpty ? nil : ws.above.joined(separator: " / "), active: active, onClick: { model.activate(item) }) { EmptyView() }
        } else if let result = item.result {
            let row = result.row
            PanelRow(icon: RowGlyph(key: row != nil ? glyphKey(row) : glyphKey(result.found)), title: item.kind == .fresh ? "Add \(result.name)" : result.name, active: active,
                     actionsShown: active, onClick: { model.activate(item) }) {
                if item.kind == .library, let row, !model.inRail(row.id) {
                    RowActionButton(label: "Add to this project", action: { model.onClose(); model.onLink(row) }) { SBIcon(SidebarIcons.plus, size: 14) }
                }
            }
        }
    }
}
