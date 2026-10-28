import AppKit
import SwiftUI
import EngelbartCore

// Choose files under Obsidian (src/renderer/import/ObsidianPicker.jsx, 2026-10-14: "clicking choose files on obsidian
// should open a picker like the obsidian sidebar … there is no way for me to find the obsidian files easily"): the vaults
// Obsidian knows, drawn like its file explorer (folders first with a chevron, notes without .md, faint indent guides, a
// grey row on hover and when chosen), with a box on each row. A folder chosen brings in everything under it.

public struct ObsidianNode: Equatable, Sendable {
    public var name: String
    public var path: String
    public var dir: Bool
    public var children: [ObsidianNode]
    public init(json: JSONValue) {
        name = J.str(json["name"]); path = J.str(json["path"]); dir = J.truthy(json["dir"])
        children = J.arr(json["children"]).map(ObsidianNode.init(json:))
    }
    public init(name: String, path: String, dir: Bool, children: [ObsidianNode] = []) { self.name = name; self.path = path; self.dir = dir; self.children = children }
}

@MainActor
public final class ObsidianPickerModel: ObservableObject {
    @Published public private(set) var vaults: [ObsidianNode]?
    @Published public private(set) var error = ""
    @Published public private(set) var open = Set<String>()
    /// The paths chosen, in the order chosen.
    @Published public private(set) var picked: [ScopeFile] = []
    @Published public var query = ""
    let api: ImportAPI

    public init(api: ImportAPI, chosen: [String]) {
        self.api = api
        picked = chosen.map { ScopeFile(path: $0, name: ($0 as NSString).lastPathComponent, file: $0.range(of: #"\.[a-z0-9]+$"#, options: [.regularExpression, .caseInsensitive]) != nil) }
    }

    public func load() async {
        do {
            let out = try await api.obsidianTree()
            vaults = J.arr(out["vaults"]).map { vault in ObsidianNode(name: J.str(vault["name"]), path: J.str(vault["path"]), dir: true, children: J.arr(vault["tree"]).map(ObsidianNode.init(json:))) }
            // The vaults open, their folders closed, as Obsidian opens.
            open = Set(vaults!.map(\.path))
        } catch { self.error = tidyError(error) }
    }

    public func toggleOpen(_ path: String) { if open.contains(path) { open.remove(path) } else { open.insert(path) } }
    public func isPicked(_ path: String) -> Bool { picked.contains { $0.path == path } }
    /// A path is chosen when it or a folder above it is.
    public func covered(_ path: String) -> Bool { picked.contains { path == $0.path || path.hasPrefix($0.path + "/") } }
    public func togglePick(_ node: ObsidianNode) {
        if isPicked(node.path) { picked.removeAll { $0.path == node.path }; return }
        // A folder chosen holds what was chosen inside it.
        picked.removeAll { $0.path.hasPrefix(node.path + "/") }
        picked.append(ScopeFile(path: node.path, name: node.dir ? node.name : (node.path as NSString).lastPathComponent, file: !node.dir))
    }
    /// A row clicked: a folder opens or closes (in the tree), anything else is chosen.
    public func press(_ node: ObsidianNode, inSearch: Bool) { if node.dir && !inSearch { toggleOpen(node.path) } else { togglePick(node) } }

    public struct Row: Identifiable, Equatable { public var node: ObsidianNode; public var depth: Int; public var trail: [String]?; public var id: String { node.path + (trail == nil ? "" : "?") } }

    /// Every node whose name matches, with the folders above it (a flat list for the search).
    static func matches(_ tree: [ObsidianNode], _ query: String, _ trail: [String] = []) -> [(ObsidianNode, [String])] {
        var out: [(ObsidianNode, [String])] = []
        for node in tree {
            if node.name.lowercased().contains(query) { out.append((node, trail)) }
            if node.dir { out += matches(node.children, query, trail + [node.name]) }
        }
        return out
    }

    /// The rows drawn now: the tree with its open folders, or (searching) the vault rows and their matches (≤200).
    public var rows: [Row] {
        guard let vaults else { return [] }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var out: [Row] = []
        func walk(_ node: ObsidianNode, _ depth: Int) {
            out.append(Row(node: node, depth: depth, trail: nil))
            if node.dir && open.contains(node.path) { node.children.forEach { walk($0, depth + 1) } }
        }
        for vault in vaults {
            if vaults.count > 1 || q.isEmpty {
                if q.isEmpty { walk(vault, 0) } else { out.append(Row(node: vault, depth: 0, trail: nil)) }
            }
            if !q.isEmpty && (vaults.count > 1 ? open.contains(vault.path) : true) {
                out += Self.matches(vault.children, q).prefix(200).map { Row(node: $0.0, depth: 1, trail: $0.1) }
            }
        }
        return out
    }
    public var count: String { picked.isEmpty ? "" : "\(picked.count) chosen" }
}

struct ObsidianPickerView: View {
    @StateObject var model: ObsidianPickerModel
    let onChoose: ([ScopeFile]) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                IXTitle("Choose from Obsidian")
                Spacer()
                Button(action: onCancel) { Text("×").font(IX.font(22, 400)).foregroundStyle(IX.mute) }.buttonStyle(.plain).driveID("obsidian-close")
            }
            HStack(spacing: 8) {
                Glyph(IXGlyph.search, size: 14).foregroundStyle(IX.mute)
                TextField("Search files", text: $model.query).textFieldStyle(.plain).font(IX.font(13, 400)).padding(.vertical, 8)
            }
            .padding(.horizontal, 10)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
            .padding(.top, 14).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.vaults == nil && model.error.isEmpty { empty("Reading your vaults…") }
                    if !model.error.isEmpty { empty(model.error) }
                    if model.vaults?.isEmpty == true { empty("Obsidian has no vaults on this Mac.") }
                    ForEach(model.rows) { row in rowView(row) }
                }
            }
            .frame(minHeight: 120, maxHeight: 380)
            HStack(spacing: 20) {
                Text(model.count).font(IX.font(12, 400)).foregroundStyle(IX.mute)
                Spacer()
                IXButton("Cancel", .link, action: onCancel)
                IXButton("Add", small: true, disabled: model.picked.isEmpty, id: "obsidian-add") { onChoose(model.picked) }
            }
            .padding(.top, 14)
        }
        .task { await model.load() }
        .driveID("obsidian-picker")
    }

    func empty(_ text: String) -> some View { Text(text).font(IX.font(13, 400)).foregroundStyle(IX.mute).padding(.vertical, 24).padding(.horizontal, 8) }

    func rowView(_ row: ObsidianPickerModel.Row) -> some View {
        let node = row.node
        let on = model.isPicked(node.path)
        let inside = !on && model.covered(node.path)
        let vaultRow = row.depth == 0
        return RowView(depth: row.depth, guides: row.trail == nil, highlighted: on || inside) { hovering in
            Group {
                if node.dir { Glyph(IXGlyph.chevron, size: 11, width: 2).rotationEffect(.degrees(model.open.contains(node.path) && row.trail == nil ? 90 : 0)).foregroundStyle(hex("#a3a3a3")) }
                else { Color.clear }
            }.frame(width: 14, height: 14)
            HStack(spacing: 8) {
                Text(node.dir ? node.name : node.name.replacingOccurrences(of: #"\.md$"#, with: "", options: .regularExpression))
                    .font(IX.font(13.5, vaultRow ? 600 : 400)).foregroundStyle(hex("#262626")).lineLimit(1).truncationMode(.tail)
                if let trail = row.trail, !trail.isEmpty { Text(trail.joined(separator: " / ")).font(IX.font(11.5, 400)).foregroundStyle(IX.mute).lineLimit(1) }
            }
            Spacer(minLength: 0)
            Button(action: { model.togglePick(node) }) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4).fill(on || inside ? IX.blue : Color.white)
                    RoundedRectangle(cornerRadius: 4).strokeBorder(on || inside ? IX.blue : IX.line2, lineWidth: 1.5)
                    if on || inside { CheckMark().stroke(Color.white, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)).frame(width: 11, height: 11) }
                }.frame(width: 16, height: 16)
            }
            .buttonStyle(.plain).disabled(inside).opacity(hovering || on || inside ? 1 : 0).driveID("obsidian-box=\(node.path)")
        } onPress: { model.press(node, inSearch: row.trail != nil) }
        .driveID("obsidian-path=\(node.path)")
    }
}

/// One explorer row: 28 tall, indented 17 a level with its guides, grey under the pointer and when chosen; the box shows
/// on hover or when ticked.
private struct RowView<Content: View>: View {
    let depth: Int
    let guides: Bool
    let highlighted: Bool
    let content: (Bool) -> Content
    let onPress: () -> Void
    @State private var hovering = false
    init(depth: Int, guides: Bool, highlighted: Bool, @ViewBuilder content: @escaping (Bool) -> Content, onPress: @escaping () -> Void) {
        self.depth = depth; self.guides = guides; self.highlighted = highlighted; self.content = content; self.onPress = onPress
    }
    var body: some View {
        HStack(spacing: 4) { content(hovering) }
            .padding(.leading, CGFloat(8 + depth * 17)).padding(.trailing, 6)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 5).fill(highlighted ? hex("#ececec") : hovering ? hex("#f2f2f2") : Color.clear))
            .overlay(alignment: .leading) {
                if guides && depth > 0 {
                    ZStack(alignment: .leading) { ForEach(0..<depth, id: \.self) { i in Rectangle().fill(hex("#ececec")).frame(width: 1).offset(x: CGFloat(15 + i * 17)) } }
                }
            }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture(perform: onPress)
    }
}
