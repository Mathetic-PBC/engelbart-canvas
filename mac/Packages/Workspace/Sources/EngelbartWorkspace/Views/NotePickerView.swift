import AppKit
import SwiftUI
import EngelbartUI
import EngelbartDoc

/// The +'s menu beside the document's tabs (workspace/NotePicker.jsx, 2026-09-25): a search over every note in the
/// library, the caret in it from the start, and New note. Nothing is made until New note is picked. ↑/↓ move, Enter picks,
/// Esc clears first, then closes. The menu closes once the pick is done; a failure keeps it open and is reported.
@MainActor
final class NotePickerModel: ObservableObject {
    @Published var query = "" { didSet { if query != oldValue { index = 0 } } }
    @Published var index = 0
    @Published var busy = false
    let library: () -> [LibraryRow]
    let openIds: () -> [String]
    let inRail: (String) -> Bool
    let onPick: (LibraryRow) async throws -> Void
    let onNew: (String) async throws -> Void
    let onClose: () -> Void
    let onError: (Error) -> Void

    init(library: @escaping () -> [LibraryRow], openIds: @escaping () -> [String], inRail: @escaping (String) -> Bool,
         onPick: @escaping (LibraryRow) async throws -> Void, onNew: @escaping (String) async throws -> Void, onClose: @escaping () -> Void, onError: @escaping (Error) -> Void) {
        self.library = library; self.openIds = openIds; self.inRail = inRail; self.onPick = onPick; self.onNew = onNew; self.onClose = onClose; self.onError = onError
    }

    var rows: [NotePick.Row] { NotePick.rows(query: query, library: library(), openIds: openIds(), inRail: inRail) }
    var at: Int { let n = rows.count; return n > 0 ? min(index, n - 1) : -1 }

    func move(_ by: Int) { let n = rows.count; guard n > 0 else { return }; index = (at + by + n) % n }

    func pick(_ row: NotePick.Row?) {
        guard let row, !busy else { return }
        busy = true
        Task { @MainActor in
            do {
                if row.kind == .new { try await onNew(row.name) } else if let r = row.row { try await onPick(r) }
                onClose()
            } catch {
                busy = false
                onError(error)
            }
        }
    }
    func escape() { if query.isEmpty { onClose() } else { query = "" } }
}

struct NotePickerView: View {
    @ObservedObject var model: NotePickerModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(nsImage: SidebarIcons.search.image(size: 14)).foregroundColor(Color(Palette.gray900))
                TextField("Search notes", text: $model.query)
                    .textFieldStyle(.plain)
                    .font(Font(Fonts.sans(13)))
                    .foregroundColor(Color(Palette.gray900))
                    .focused($focused)
                    .disabled(model.busy)
                    .opacity(model.busy ? 0.5 : 1)
                    .driveID("note-search")
                    .onKeyPress(.downArrow) { model.move(1); return .handled }
                    .onKeyPress(.upArrow) { model.move(-1); return .handled }
                    .onKeyPress(.escape) { model.escape(); return .handled }
                    .onSubmit { let rows = model.rows; if model.at >= 0 { model.pick(rows[model.at]) } }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(model.query.isEmpty ? Palette.gray200 : Palette.gray300), lineWidth: 1))
            .padding(.bottom, 6)
            ForEach(Array(model.rows.enumerated()), id: \.element.key) { i, row in
                HStack(spacing: 10) {
                    if row.kind == .new {
                        Text("+").font(Font(Fonts.sans(16))).foregroundColor(Color(Palette.gray700)).frame(width: 16, height: 16)
                    } else {
                        Image(nsImage: KindIcons.note.image(size: 16)).foregroundColor(Color(Palette.gray500)).frame(width: 16, height: 16)
                    }
                    rowText(row).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                    if !row.tag.isEmpty {
                        Text(row.tag.uppercased()).font(Font(Fonts.sans(10, weight: 500))).tracking(1.2).foregroundColor(Color(Palette.gray500))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 6).fill(i == model.at ? Color(Palette.gray150) : Color.clear))
                .contentShape(Rectangle())
                .onHover { if $0 && model.index != i { model.index = i } }
                .onTapGesture { model.pick(row) }
                .driveID("note-pick=\(row.key)")
                .accessibilityAddTraits(.isButton)
            }
        }
        .padding(8)
        .frame(width: 320)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }

    @ViewBuilder func rowText(_ row: NotePick.Row) -> some View {
        if row.kind == .new {
            if row.name.isEmpty { Text("New note").font(Font(Fonts.sans(13))).foregroundColor(Color(Palette.gray900)) }
            else { (Text("New note ").foregroundColor(Color(Palette.gray900)) + Text("“\(row.name)”").foregroundColor(Color(Palette.gray700))).font(Font(Fonts.sans(13))) }
        } else {
            Text(row.name).font(Font(Fonts.sans(13))).foregroundColor(Color(Names.isUntitled(row.name) ? Palette.gray500 : Palette.gray900))
        }
    }
}
