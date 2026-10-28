import AppKit
import Combine
import SwiftUI
import EngelbartDoc
import EngelbartIntegrations
import EngelbartStore
import EngelbartUI

// What + on Sources adds (SidebarPanels.jsx AddPicker; 2026-10-13 the mockup's add picker; its latest, Hudson 2026-10-15,
// desktop engelbart-sidebar-mockup.html): a search over the library, its first five that are not there yet, More (the
// whole library beside it, with its chips), then "Upload URL or path" always open (several pasted at once: parseSources),
// what was added so far listed under it, Add from GitHub and "Upload or add files" (the file picker). It stays open while
// things are added; it hides by itself a beat after the pointer leaves it, the library beside it and the + it came from
// (2026-10-13: "if I move my cursor outside the obvious area … it should auto hide"), except while it is adding, while
// GitHub's sign-in or list is in it, or while a link or a path is typed in it (b640639). No line between the library and
// the rest (2026-10-14: "I never want horizontal dividing lines"): a gap.

@MainActor
final class AddPickerModel: ObservableObject {
    static let SHOWN = 5
    struct Added: Equatable { var key: String; var name: String; var row: LibraryRow? }
    enum View { case menu, github }

    @Published var q = "" { didSet { if q != oldValue { idx = 0 } } }
    @Published var idx = 0
    @Published var value = "" { didSet { if value != oldValue { run.error = "" } } }
    @Published var added: [Added] = []
    @Published var view: View = .menu
    @Published var sideOpen = false
    let run = AddRun()
    @Published var library: [LibraryRow]
    let intoName: String
    var has: (String) -> Bool
    var onPick: (LibraryRow) async throws -> Void = { _ in }
    var onAddInput: (String) async throws -> LibraryRow = { _ in throw StoreError("Not wired") }
    var onPickRepo: (GithubRow) async throws -> Void = { _ in }
    var pickPaths: () async -> [String] = { [] }
    /// Focus the link field (after a commit, or Enter on a typed link in the search).
    @Published var focusField = 0
    private var bag: [AnyCancellable] = []

    init(intoName: String, library: [LibraryRow], has: @escaping (String) -> Bool) {
        self.intoName = intoName; self.library = library; self.has = has
        bag.append(run.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
    }

    var busy: Bool { run.busy }
    var typed: String { q.trimmed }
    /// It does not hide by itself while adding, in GitHub, or with a link typed.
    var stays: Bool { busy || view == .github || !value.trimmed.isEmpty }
    var candidates: [LibraryRow] { library.filter { !has($0.id) && $0.type != "image" } }
    var results: [SearchResult] {
        if typed.isEmpty {
            return candidates.enumerated().sorted { a, b in
                let ea = JSTime.ms(a.element.lastEdited.isEmpty ? a.element.created : a.element.lastEdited), eb = JSTime.ms(b.element.lastEdited.isEmpty ? b.element.created : b.element.lastEdited)
                return ea != eb ? ea > eb : a.offset < b.offset
            }.map { SearchResult(kind: .item, key: $0.element.id, name: $0.element.name, tag: "", row: $0.element) }
        }
        return RailModel.searchRows(query: typed, library: candidates, inRail: { _ in false }).filter { $0.kind == .item }
    }
    var shown: [SearchResult] { Array(results.prefix(Self.SHOWN)) }
    var at: Int { shown.isEmpty ? -1 : min(idx, shown.count - 1) }
    var parsed: [ParsedSource] { RailModel.parseSources(value) }
    var good: [ParsedSource] { parsed.filter(\.ok) }
    var addLabel: String { good.count > 1 ? "Add sources" : "Add source" }

    func remember(_ row: LibraryRow?, _ text: String = "") {
        let key = row?.id ?? text
        guard !key.isEmpty, !added.contains(where: { $0.key == key }) else { return }
        added.append(Added(key: key, name: row?.name ?? text, row: row))
    }
    func pick(_ row: LibraryRow?) {
        guard let row, !busy else { return }
        run.run { try await self.onPick(row); self.remember(row); return [] }
    }
    /// Each link or path typed or pasted is added in turn; what could not be stays in the field, saying why.
    func commit() {
        let parsed = self.parsed
        guard !good.isEmpty, !busy else { return }
        run.run {
            var left: [String] = [], problems: [String] = []
            @MainActor func add(_ one: ParsedSource) async {
                guard one.ok else { left.append(one.text); problems.append(one.why ?? ""); return }
                do { self.remember(try await self.onAddInput(one.text), one.text) } catch {
                    // A path with spaces that is not one: its words, one by one.
                    if let split = one.split { for piece in split { await add(piece) }; return }
                    left.append(one.text); problems.append(AddRun.message(error))
                }
            }
            for one in parsed { await add(one) }
            self.value = left.joined(separator: " ")
            self.focusField += 1
            return problems
        }
    }
    /// Upload or add files: the file picker, every file and folder chosen added as a typed path is.
    func chooseFiles() {
        guard !busy else { return }
        run.run {
            var problems: [String] = []
            for file in await self.pickPaths() {
                do { self.remember(try await self.onAddInput(file), file) } catch { problems.append(AddRun.message(error)) }
            }
            return problems
        }
    }
    func pickRepo(_ entry: GithubRow) {
        guard !busy else { return }
        run.run { try await self.onPickRepo(entry); return [] }
    }
    func searchKey(_ key: FieldKey) -> Bool {
        let n = shown.count
        switch key {
        case .down: if n > 0 { idx = (at + 1) % n }; return true
        case .up: if n > 0 { idx = (at - 1 + n) % n }; return true
        case .enter:
            if at >= 0 { pick(shown[at].row) } else if RailModel.looksAddable(typed) { value = typed; focusField += 1 }
            return true
        default: return false
        }
    }

    /// Whether a pointer at `point` is "a little outside" everything that keeps the picker (12 pt round each box).
    static func inside(_ point: CGPoint, boxes: [CGRect], margin: CGFloat = 12) -> Bool {
        boxes.contains { $0.insetBy(dx: -margin, dy: -margin).contains(point) }
    }
}

struct AddPickerView: View {
    @ObservedObject var model: AddPickerModel
    let github: GithubPaneModel?
    let inRail: (String) -> Bool
    let peek: PeekController?
    var onMore: () -> Void
    @State private var fieldTick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.view == .github, let github {
                GithubPaneView(model: github, library: model.library.map { GithubLibraryRow(id: $0.id, githubId: $0.githubId, url: $0.url) }, inRail: inRail, busy: model.busy,
                               onBack: { model.view = .menu; model.run.error = "" }, onPick: { model.pickRepo($0) })
                if !model.run.error.isEmpty { Text(model.run.error).font(sans(12)).foregroundStyle(Color(Palette.del)).padding(EdgeInsets(top: 6, leading: 2, bottom: 0, trailing: 2)) }
            } else {
                menu
            }
        }
        .padding(8)
        .driveID("sb-panel=add")
    }

    var menu: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                SBIcon(SidebarIcons.search, size: 14, stroke: 2.4).foregroundStyle(Color(Palette.ink))
                PanelTextField(text: $model.q, placeholder: "Search library", font: Fonts.sans(14), id: "add-search", onKey: model.searchKey)
            }
            .padding(.horizontal, 10).frame(height: 32)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(model.q.isEmpty ? Palette.bd : Palette.bd2), lineWidth: 1))
            .padding(.bottom, 6)
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(model.shown.enumerated()), id: \.element.key) { i, result in
                    PickerItem(selected: i == model.at && !model.typed.isEmpty, disabled: model.busy, action: { model.pick(result.row) },
                               onHover: { inside in
                                   if inside { if model.idx != i { model.idx = i }; if let row = result.row, let peek { PeekAnchor.open(peek, row: row) } } else { peek?.close() }
                               }) {
                        SourceGlyph(row: result.row).foregroundStyle(Color(Palette.gray700))
                        Text(result.name).lineLimit(1).truncationMode(.tail)
                    }.driveID("add-result=\(result.key)")
                }
                if model.shown.isEmpty {
                    Text("Nothing matches").font(sans(13)).foregroundStyle(Color(SB.empty)).frame(height: 30).padding(.leading, 10)
                }
                if model.results.count > AddPickerModel.SHOWN {
                    MoreButton(on: model.sideOpen, action: onMore).driveID("add-more")
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    SBIcon(SidebarIcons.plus, size: 14, stroke: 2.4).foregroundStyle(Color(Palette.ink))
                    LinkField(text: $model.value, focusTick: model.focusField, readOnly: model.busy, onEnter: model.commit)
                }
                .padding(.horizontal, 10).frame(height: 32)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(!model.run.error.isEmpty && !model.value.isEmpty ? Palette.del : model.value.isEmpty ? Palette.bd : Palette.bd2), lineWidth: 1))
                if !model.run.error.isEmpty {
                    Text(model.run.error).font(sans(12)).foregroundStyle(Color(Palette.del)).fixedSize(horizontal: false, vertical: true)
                        .padding(EdgeInsets(top: 6, leading: 2, bottom: 2, trailing: 2)).driveID("add-error")
                }
                if !model.good.isEmpty {
                    Button(action: model.commit) {
                        Text(model.addLabel).font(sans(13, 500)).foregroundStyle(Color(Palette.ink)).padding(.horizontal, 12).frame(height: 30)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Color.white))
                            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(hex: "#e4e4e4"), lineWidth: 1))
                            .shadow(color: .black.opacity(0.04), radius: 0.5, x: 0, y: 1)
                    }.buttonStyle(.plain).disabled(model.busy).padding(.top, 6).driveID("add-link")
                }
            }
            .padding(EdgeInsets(top: 10, leading: 0, bottom: 4, trailing: 0))
            if !model.added.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(model.added, id: \.key) { one in
                        HStack(spacing: 10) {
                            if let row = one.row { SourceGlyph(row: row).foregroundStyle(Color(Palette.fnt)) } else { SBIcon(SidebarIcons.globe, size: 16).foregroundStyle(Color(Palette.fnt)) }
                            Text(one.name).font(sans(13.5)).foregroundStyle(Color(Palette.ink)).lineLimit(1).truncationMode(.tail)
                        }.padding(.horizontal, 10).frame(height: 32).driveID("add-added-row=\(one.key)")
                    }
                }.padding(.bottom, 4).driveID("add-added")
            }
            if github != nil {
                PickerItem(selected: false, disabled: model.busy, action: { model.run.error = ""; model.view = .github; model.sideOpen = false }) {
                    KindGlyph("git", box: 16, color: Palette.gray700)
                    Text("Add from GitHub")
                }.driveID("add-github")
            }
            PickerItem(selected: false, disabled: model.busy, action: model.chooseFiles) {
                SBIcon(SidebarIcons.paperclip, size: 16).foregroundStyle(Color(Palette.gray700))
                Text("Upload or add files")
            }.driveID("add-files")
        }
    }
}

/// A row of the picker (`mi`: 32 high, gap 10, padding 0 10, 13.5).
struct PickerItem<Content: View>: View {
    let selected: Bool
    var disabled = false
    let action: () -> Void
    var onHover: (Bool) -> Void = { _ in }
    @ViewBuilder var content: () -> Content
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) { content() }.font(sans(13.5)).foregroundStyle(Color(Palette.ink))
                .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.gray150).opacity(selected || hovered ? 1 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled)
        .onHover { hovered = $0; onHover($0) }
    }
}

/// "... More" (grey, #e6e6e6 while the library beside it is open).
struct MoreButton: View {
    let on: Bool
    let action: () -> Void
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) { Text("..."); Text("More") }.font(sans(14)).foregroundStyle(Color(hovered ? Palette.gray700 : Palette.fnt))
                .padding(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 6)).frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: "#e6e6e6").opacity(on ? 1 : 0)))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).onHover { hovered = $0 }
    }
}

/// "Upload URL or path": Enter adds what is typed; it takes the keyboard again when `focusTick` changes.
struct LinkField: NSViewRepresentable {
    @Binding var text: String
    let focusTick: Int
    var readOnly = false
    let onEnter: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = Fonts.sans(14); field.textColor = Palette.ink
        field.cell?.isScrollable = true; field.cell?.wraps = false
        field.placeholderAttributedString = NSAttributedString(string: "Upload URL or path", attributes: [.foregroundColor: Palette.fnt, .font: Fonts.sans(14)])
        field.delegate = context.coordinator
        field.setAccessibilityIdentifier("add-value")
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text { field.stringValue = text }
        field.isEditable = !readOnly
        if context.coordinator.tick != focusTick { context.coordinator.tick = focusTick; DispatchQueue.main.async { field.window?.makeFirstResponder(field) } }
    }
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: LinkField
        var tick = 0
        init(_ parent: LinkField) { self.parent = parent; tick = parent.focusTick }
        func controlTextDidChange(_ obj: Notification) { if let f = obj.object as? NSTextField { parent.text = f.stringValue } }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.insertNewline(_:)) { parent.onEnter(); return true }
            return false
        }
    }
}
