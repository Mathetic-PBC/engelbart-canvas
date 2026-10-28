import AppKit
import Combine
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// Library (SidebarPanels.jsx LibraryPanel; Sidebar brainstorming: "a modal … search, recent and current-context items,
// Open full Library"): the search has the keyboard; before anything is typed, what was worked on last; the chips (All ·
// Notes · Papers · Repos · Web · Files) narrow it. A press opens a row; its + brings it into this project; an address or a
// path typed is added. Hovering one peeks at it. "Open full library" goes to the all-projects screen. As a picker
// (beside the add picker, 2026-10-13) a press adds the row to where + was pressed, and what is there is left out.

/// The Library panel's state, apart from its drawing (tests drive it).
@MainActor
final class LibraryPanelModel: ObservableObject {
    struct Picking { var has: (String) -> Bool; var onPick: (LibraryRow) async throws -> Void }

    @Published var query = "" { didSet { if query != oldValue { idx = 0; problem = ""; lookup.typed(typed) } } }
    @Published var idx = 0
    @Published var problem = ""
    @Published var busy = false
    /// Which chip is on: kept while the panel is open, All each time it opens (or the walkthrough's chip).
    @Published var picked: String
    @Published var library: [LibraryRow]
    var inRail: (String) -> Bool
    let picking: Picking?
    let lookup: LookupModel
    let bodies = BodiesModel()
    var onOpen: (LibraryRow) -> Void = { _ in }
    var onLink: (LibraryRow) async throws -> Void = { _ in }
    var onAddInput: (String) async throws -> Void = { _ in }
    var onClose: () -> Void = {}
    private var bag: [Any] = []

    init(chip: String = "all", library: [LibraryRow], inRail: @escaping (String) -> Bool, picking: Picking? = nil, lookup: LookupModel) {
        self.picked = chip; self.library = library; self.inRail = inRail; self.picking = picking; self.lookup = lookup
        bag.append(lookup.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
        bag.append(bodies.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
    }

    var typed: String { query.trimmed }
    var counts: [String: Int] { Kind.libraryCounts(library.map(\.lib)) }
    /// The chip shown on: a chip emptied meanwhile is All.
    var chip: String { (counts[picked] ?? 0) > 0 ? picked : "all" }
    var chipNoun: String { Kind.LIBRARY_CHIPS.first { $0.id == chip }?.noun ?? "" }
    /// The chips shown: All, and the kinds with something under them.
    var chips: [Kind.Chip] { Kind.LIBRARY_CHIPS.filter { $0.id == "all" || (counts[$0.id] ?? 0) > 0 } }
    var listed: [LibraryRow] { picking.map { p in library.filter { !p.has($0.id) } } ?? library }
    var answer: Library.Lookup? { lookup.answer(typed) }
    var rows: [SearchResult] { RailModel.libraryPanelRows(query: typed, library: listed, chip: chip, inRail: inRail, found: answer, bodies: bodies.bodies) }
    var at: Int { rows.isEmpty ? -1 : min(idx, rows.count - 1) }
    var heading: String { chipNoun.isEmpty ? "Recent" : "Recent \(chipNoun)" }
    var empty: String {
        if !chipNoun.isEmpty { return typed.isEmpty ? "No \(chipNoun) in the library" : "No \(chipNoun) match" }
        return typed.isEmpty ? "The library is empty. Add a source to start it." : "Nothing in the library by that name."
    }
    var error: String { !problem.isEmpty ? problem : (answer?.error ?? "") }

    /// A press on the chip that is on goes back to All.
    func pickChip(_ id: String) { picked = id == chip ? "all" : id; idx = 0 }

    func run(_ work: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true; problem = ""
        Task { @MainActor in
            do { try await work() } catch { self.problem = AddRun.message(error) }
            self.busy = false
        }
    }
    func pick(_ result: SearchResult?) {
        guard let result else { return }
        if result.kind == .fresh { let input = typed; run { try await self.onAddInput(input); self.query = "" } }
        else if let picking, let row = result.row { run { try await picking.onPick(row) } }
        else if let row = result.row { onClose(); onOpen(row) }
    }
    func key(_ key: FieldKey) -> Bool {
        let n = rows.count
        switch key {
        case .down: if n > 0 { idx = (at + 1) % n }; return true
        case .up: if n > 0 { idx = (at - 1 + n) % n }; return true
        case .enter: if at >= 0 { pick(rows[at]) }; return true
        default: return false
        }
    }
}

struct LibraryPanelView: View {
    @ObservedObject var model: LibraryPanelModel
    let peek: PeekController?
    var onOpenFull: () -> Void
    @State private var chipsFocused: String? = nil
    var body: some View {
        VStack(spacing: 0) {
            PanelHead(title: "Library", count: model.counts["all"]) {
                if model.picking != nil {
                    RowActionButton(label: "Close library", action: model.onClose) { SBIcon(SidebarIcons.close, size: 14) }.driveID("close-picker-library")
                }
            }
            SearchFieldView(text: $model.query, placeholder: "Search the library, or paste a link", onKey: { key in
                if key == .tab { chipsFocused = model.chip; return true }
                return model.key(key)
            })
            if (model.counts["all"] ?? 0) > 0 { LibraryChips(model: model, focused: $chipsFocused) }
            if model.typed.isEmpty {
                Text(model.heading).font(sans(12, 500)).foregroundStyle(Color(Palette.fnt)).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: 2, leading: 14, bottom: 2, trailing: 14)).driveID("library-heading")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    let rows = model.rows
                    ForEach(Array(rows.enumerated()), id: \.element.key) { i, result in
                        let row = result.row
                        let here = row.map { model.inRail($0.id) } ?? false
                        PanelRow(icon: RowGlyph(key: row != nil ? glyphKey(row) : glyphKey(result.found)), title: result.name, active: i == model.at && !model.typed.isEmpty,
                                 actionsShown: result.kind == .fresh || here,
                                 onClick: { model.pick(result) },
                                 onHover: { inside in
                                     if inside { if model.idx != i { model.idx = i }; if let row, let peek { PeekAnchor.open(peek, row: row) } } else { peek?.close() }
                                 }) {
                            if result.kind == .fresh { Text("Add").font(sans(12)).foregroundStyle(Color(Palette.fnt)) }
                            else if model.picking != nil { EmptyView() }
                            else if here { Text("In this project").font(sans(11.5)).foregroundStyle(Color(Palette.fnt)).padding(.horizontal, 4) }
                            else if let row { RowActionButton(label: "Add to this project", action: { model.run { try await model.onLink(row) } }) { SBIcon(SidebarIcons.plus, size: 14) } }
                        }
                        .driveID("library-result=\(result.key)")
                    }
                    if rows.isEmpty { EmptyNote(text: model.empty) }
                    if !model.error.isEmpty { ErrorLine(text: model.error) }
                }.padding(EdgeInsets(top: 2, leading: 4, bottom: 6, trailing: 4))
            }
            if model.picking == nil {
                HStack { FootButton(action: { model.onClose(); onOpenFull() }) { SBIcon(SidebarIcons.library, size: 14); Text("Open full library") }.driveID("sb-open-library"); Spacer() }
                    .padding(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
            }
        }
        .driveID("sb-panel=library")
    }
}

/// The chips (LibraryChips): one on at a time; counts only when every count fits the row; ← → move, Space/Enter pick.
struct LibraryChips: View {
    @ObservedObject var model: LibraryPanelModel
    @Binding var focused: String?
    var body: some View {
        ViewThatFits(in: .horizontal) {
            chipRow(withCounts: true)
            chipRow(withCounts: false)
        }
        .padding(EdgeInsets(top: 0, leading: 10, bottom: 6, trailing: 10))
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .driveID("library-chips")
    }
    func chipRow(withCounts: Bool) -> some View {
        HStack(spacing: 4) {
            ForEach(model.chips, id: \.id) { chip in
                let on = chip.id == model.chip
                Button { model.pickChip(chip.id); focused = nil } label: {
                    HStack(spacing: 4) {
                        Text(chip.label).font(sans(12, on ? 500 : 400)).foregroundStyle(Color(on ? Palette.ink : Palette.gray700))
                        if withCounts { Text("\(model.counts[chip.id] ?? 0)").font(sans(12)).foregroundStyle(Color(Palette.fnt)) }
                    }
                    .padding(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: on ? "#efefef" : "#ffffff").opacity(on ? 1 : 0)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(hex: on ? "#efefef" : "#eaeaea"), lineWidth: 1))
                    .overlay(focused == chip.id ? RoundedRectangle(cornerRadius: 6).strokeBorder(Color(Palette.accBg), lineWidth: 2) : nil)
                    .fixedSize()
                }
                .buttonStyle(.plain)
                .driveID("library-chip=\(chip.id)")
            }
        }
        .background(ChipKeys(focused: $focused, chips: model.chips.map(\.id), pick: { model.pickChip($0) }))
    }
}

/// ← → move along the chips, Space or Enter picks, while they have the keyboard (Tab from the search).
private struct ChipKeys: NSViewRepresentable {
    @Binding var focused: String?
    let chips: [String]
    let pick: (String) -> Void
    func makeNSView(context: Context) -> KeyView { let v = KeyView(); v.owner = self; return v }
    func updateNSView(_ v: KeyView, context: Context) {
        v.owner = self
        if focused != nil, v.window?.firstResponder !== v { v.window?.makeFirstResponder(v) }
    }
    final class KeyView: NSView {
        var owner: ChipKeys?
        override var acceptsFirstResponder: Bool { owner?.focused != nil }
        override func keyDown(with event: NSEvent) {
            guard let owner, let on = owner.focused, let at = owner.chips.firstIndex(of: on) else { super.keyDown(with: event); return }
            switch event.keyCode {
            case 124: owner.focused = owner.chips[(at + 1) % owner.chips.count]
            case 123: owner.focused = owner.chips[(at - 1 + owner.chips.count) % owner.chips.count]
            case 49, 36: owner.pick(on); owner.focused = nil
            default: super.keyDown(with: event)
            }
        }
    }
}

/// Opens a peek for a SwiftUI row at the pointer: the row's rect is read from the event (the hovered view's place).
@MainActor
enum PeekAnchor {
    static func open(_ peek: PeekController, row: LibraryRow) {
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }), let parent = window.parent ?? Optional(window),
              let content = parent.contentView else { return }
        // The panel the row is in is the key window; its right edge is where the peek starts.
        let mouse = NSEvent.mouseLocation
        let inParent = parent.convertPoint(fromScreen: mouse)
        let y = content.isFlipped ? inParent.y : content.bounds.height - inParent.y
        let panelFrame = window === parent ? content.frame : window.frame
        let edgeScreen = CGPoint(x: panelFrame.maxX - (window === parent ? 0 : 40), y: panelFrame.minY)
        let edge = parent.convertPoint(fromScreen: edgeScreen).x
        peek.open(row, rect: CGRect(x: inParent.x - 100, y: y - 16, width: 200, height: 32), edge: edge, in: parent)
    }
}
