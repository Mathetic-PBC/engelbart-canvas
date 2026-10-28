import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// Colors as the JSX writes them (all are Palette tokens: #171717 ink, #4d4d4d mut, #8f8f8f fnt, #eaeaea bd, #c9c9c9 bd2,
// #f2f2f2 hov, #0070f3 acc, #e70022 del).
extension Color {
    static let bInk = Color(Palette.ink), bMut = Color(Palette.mut), bFnt = Color(Palette.fnt), bBd = Color(Palette.bd), bBd2 = Color(Palette.bd2)
    static let bHov = Color(Palette.hov), bAcc = Color(Palette.acc), bDel = Color(Palette.del), bPanel2 = Color(Palette.panel2)
    // Review's diff colors (BuildReview.jsx lineStyle): GitHub's greens and reds, kept as written.
    static let bAddInk = Color(NSColor(hex: "#1a7f37")), bAddBg = Color(NSColor(hex: "#f0fbf2")), bDelInk = Color(NSColor(hex: "#cf222e")), bDelBg = Color(NSColor(hex: "#fff5f5"))
    static let bHunk = Color(NSColor(hex: "#0761d1"))
}

/// The workspace's Build panel (BuildPanel.jsx): 420 wide, padding 14/16/12, radius 12, hairline #eaeaea, shadow
/// 0 12 32 rgba(0,0,0,.08); it opens above the Build button with no backdrop (the host places it, B2/B29).
public struct BuildPanelView: View {
    @ObservedObject var model: BuildPanelModel
    let library: [PanelLibraryItem]
    let onClose: () -> Void
    @State private var query = ""
    @State private var highlighted = 0

    public init(model: BuildPanelModel, library: [PanelLibraryItem], onClose: @escaping () -> Void) {
        self.model = model; self.library = library; self.onClose = onClose
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Build").font(Font(Fonts.sans(15, weight: 600))).foregroundColor(.bInk)
                Text(model.title).font(Font(Fonts.sans(15))).foregroundColor(.bMut).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Button { if !model.busy { onClose() } } label: { Text("×").font(Font(Fonts.sans(18))).foregroundColor(.bFnt) }
                    .buttonStyle(.plain).accessibilityLabel("Close")
            }
            HStack(spacing: 8) {
                Text("Repository").font(Font(Fonts.sans(13))).foregroundColor(.bFnt)
                Button { model.lookup = model.lookup == "target" ? nil : "target"; query = ""; highlighted = 0 } label: {
                    HStack(spacing: 7) {
                        Text(model.current?["name"]?.string ?? "…").font(Font(Fonts.sans(13))).foregroundColor(.bInk).lineLimit(1)
                        if let current = model.current {
                            Text(BuildTarget.tag(current).uppercased()).font(Font(Fonts.sans(10, weight: 500))).tracking(1.2).foregroundColor(.bFnt)
                        }
                        Text("⌄").font(Font(Fonts.sans(12))).foregroundColor(.bFnt).offset(y: -3)
                    }
                    .padding(.vertical, 3).padding(.leading, 6).padding(.trailing, 8)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(model.lookup == "target" ? Color.bBd2 : Color.bBd, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(model.targets == nil)
                .help(model.current.flatMap { $0["folder"]?.string ?? $0["url"]?.string } ?? "")
            }
            if model.lookup == "target" { lookupList(targetRows: true) }
            Button { model.lookup = model.lookup == "library" ? nil : "library"; query = ""; highlighted = 0 } label: {
                HStack(spacing: 9) {
                    ZStack { Circle().stroke(lineWidth: 1.3).frame(width: 15, height: 15); Text("+").font(Font(Fonts.sans(13))) }.frame(width: 18, height: 18)
                    Text("Add from library").font(Font(Fonts.sans(14)))
                }
                .foregroundColor(model.lookup == "library" ? .bInk : .bFnt)
                .padding(.vertical, 5).padding(.leading, 6).padding(.trailing, 10)
                .background(RoundedRectangle(cornerRadius: 6).fill(model.lookup == "library" ? Color.bHov : .clear))
            }
            .buttonStyle(.plain).padding(.leading, -6)
            if model.lookup == "library" { lookupList(targetRows: false) }
            if !model.attached.isEmpty {
                FlowRow(spacing: 6) {
                    ForEach(model.attached) { item in
                        HStack(spacing: 6) {
                            Text(item.name).font(Font(Fonts.sans(13))).foregroundColor(.bInk).lineLimit(1)
                            Button { model.remove(item.id) } label: { Text("×").font(Font(Fonts.sans(14))).foregroundColor(.bFnt) }
                                .buttonStyle(.plain).accessibilityLabel("Leave \(item.name) out")
                        }
                        .padding(.vertical, 3).padding(.leading, 8).padding(.trailing, 6)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.bBd, lineWidth: 1))
                    }
                }
            }
            if let line = model.line {
                Text(line.text).font(Font(Fonts.sans(12.5))).foregroundColor(line.alarming ? .bDel : .bFnt)
            }
            HStack(spacing: 10) {
                Toggle(isOn: $model.clear) { Text("Automatically clear workspace").font(Font(Fonts.sans(13))).foregroundColor(.bMut) }
                    .toggleStyle(.checkbox)
                Spacer(minLength: 0)
                // The model chip with the send inside it, as on an @bart line.
                HStack(spacing: 8) {
                    Menu {
                        if let choices = model.choices {
                            ForEach(choices.providers, id: \.key) { entry in
                                Section(entry.provider.name) {
                                    ForEach(entry.provider.models, id: \.key) { m in
                                        Menu(m.model.name) {
                                            ForEach(entry.provider.efforts, id: \.self) { effort in
                                                Button(EffortLabels.label(effort)) { model.pickModel(provider: entry.key, model: m.key, effort: effort) }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } label: {
                        Text(model.chipText).font(Font(Fonts.sans(13))).foregroundColor(.bMut)
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                    Button { Task { await model.send() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold))
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(model.ready ? Color.bAcc : Color.bBd))
                            .foregroundColor(model.ready ? .white : .bFnt)
                    }
                    .buttonStyle(.plain).disabled(!model.ready).accessibilityLabel("Send")
                    .keyboardShortcut(.return, modifiers: .command)
                }
                .padding(.vertical, 2).padding(.leading, 12).padding(.trailing, 2)
                .overlay(Capsule().stroke(model.pickerOpen ? Color.bBd2 : Color.bBd, lineWidth: 1))
            }
            .frame(minHeight: 32)
        }
        .padding(.top, 14).padding(.horizontal, 16).padding(.bottom, 12)
        .frame(width: 420, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.bBd, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.08), radius: 16, y: 12)
        .onExitCommand { if model.lookup != nil { model.lookup = nil } else if !model.busy { onClose() } }
        .task { await model.load() }
    }

    /// The search that comes up over a button (Lookup): a field with the caret in it, its rows; ↑/↓ move, Enter picks,
    /// Esc clears then closes; the highlighted repository row offers Make default.
    @ViewBuilder func lookupList(targetRows: Bool) -> some View {
        let libraryRows = library.filter { item in
            !model.attached.contains { $0.id == item.id } && (query.isEmpty || query.lowercased().split(separator: " ").allSatisfy { item.name.lowercased().contains($0) })
        }
        let rows = targetRows ? model.targetRows(query) : []
        let count = targetRows ? rows.count : libraryRows.count
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .bold)).foregroundColor(.bInk)
                TextField(targetRows ? "Search repositories" : "Search the library", text: $query)
                    .textFieldStyle(.plain).font(Font(Fonts.sans(13)))
                    .onSubmit { pick(targetRows: targetRows, rows: rows, libraryRows: libraryRows) }
                    .onExitCommand { if !query.isEmpty { query = ""; highlighted = 0 } else { model.lookup = nil } }
                    .onKeyPress(.downArrow) { if count > 0 { highlighted = (highlighted + 1) % count }; return .handled }
                    .onKeyPress(.upArrow) { if count > 0 { highlighted = (highlighted - 1 + count) % count }; return .handled }
                    .onChange(of: query) { _, _ in highlighted = 0 }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(query.isEmpty ? Color.bBd : Color.bBd2, lineWidth: 1))
            ForEach(0..<count, id: \.self) { i in
                HStack(spacing: 10) {
                    Text(targetRows ? rows[i].name : libraryRows[i].name).font(Font(Fonts.sans(13))).foregroundColor(.bInk).lineLimit(1)
                    Spacer(minLength: 0)
                    if targetRows {
                        Text(rows[i].tag.uppercased()).font(Font(Fonts.sans(10, weight: 500))).tracking(1.2).foregroundColor(.bFnt)
                        if rows[i].canMakeDefault && i == min(highlighted, count - 1) {
                            Button("Make default") { let item = rows[i].item; Task { await model.makeDefault(item) } }.buttonStyle(.plain)
                                .font(Font(Fonts.sans(13))).foregroundColor(.bMut)
                        }
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 6).fill(i == min(highlighted, count - 1) ? Color.bHov : .clear))
                .contentShape(Rectangle())
                .onHover { if $0 { highlighted = i } }
                .onTapGesture { highlighted = i; pick(targetRows: targetRows, rows: rows, libraryRows: libraryRows) }
            }
        }
        .padding(8)
        .frame(width: 320, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.bBd2, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.06), radius: 16, y: 12)
    }

    func pick(targetRows: Bool, rows: [(key: String, item: JSONValue, name: String, tag: String, canMakeDefault: Bool)], libraryRows: [PanelLibraryItem]) {
        if targetRows { if rows.indices.contains(highlighted) { let item = rows[highlighted].item; Task { await model.pickTarget(item) } } }
        else if libraryRows.indices.contains(highlighted) { model.attach(libraryRows[highlighted]) }
    }
}

/// Chips that wrap onto the next line.
struct FlowRow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > width && x > 0 { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing; row = max(row, size.height)
        }
        return CGSize(width: width, height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing; row = max(row, size.height)
        }
    }
}
