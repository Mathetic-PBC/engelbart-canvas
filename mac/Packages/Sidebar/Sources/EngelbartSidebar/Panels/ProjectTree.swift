import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// Projects as a tree in a panel (SidebarPanels.jsx ProjectTree, the mockup's treeRows): the section's More (every project
// here), a level's More (its siblings) and the card a folded project shows on hover. A level-2 project has its icon; each
// row has its count and, unless `expandAll`, a chevron that folds it. `guideLevel`: the level whose children get the
// guide line; `contextRoot`: the project the card is about, in bold. `q`: what the panel's search holds; a row shows
// when it or something in it matches. A project's archived versions (one per Clear) are under it, after its projects
// (2026-10-16), where `onOpenVersion` is given.

struct TreeOptions {
    var tree: TreeIndex
    var counts: [String: AgentSummary]
    var hereId: String?
    var folded: Set<String> = []
    var expandAll = false
    var guideLevel: Int? = nil
    var contextRoot: String? = nil
    var q = ""
    var showVersions = false
}

enum ProjectTreeModel {
    static func archives(_ node: ProjectNode, _ o: TreeOptions) -> [ArchivedVersion] { o.showVersions ? SidebarModel.versionsOf(node) : [] }
    static func versionMatches(_ v: ArchivedVersion, _ q: String) -> Bool { q.isEmpty || v.title.lowercased().contains(q) }
    static func matches(_ id: String, _ o: TreeOptions) -> Bool {
        guard let n = o.tree[id]?.node else { return false }
        return o.q.isEmpty || n.name.lowercased().contains(o.q) || archives(n, o).contains { versionMatches($0, o.q) } || n.children.contains { matches($0.id, o) }
    }
    /// The rows a tree draws, flat, in order: (id, depth, isVersion) for tests and drawing.
    static func lines(_ ids: [String], depth: Int = 0, _ o: TreeOptions) -> [(id: String, depth: Int, version: ArchivedVersion?)] {
        var out: [(id: String, depth: Int, version: ArchivedVersion?)] = []
        for id in ids where o.tree.has(id) && matches(id, o) {
            let n = o.tree[id]!.node
            out.append((id, depth, nil))
            let versions = archives(n, o).filter { o.q.isEmpty || n.name.lowercased().contains(o.q) || versionMatches($0, o.q) }
            let under = n.children.count + versions.count
            let isFolded = !o.expandAll && o.q.isEmpty && o.folded.contains(id)
            if under > 0 && !isFolded {
                out += lines(n.children.map(\.id), depth: depth + 1, o)
                out += versions.map { (id, depth + 1, $0) }
            }
        }
        return out
    }
    /// The deepest level with children under `id` (the flyout's guide line).
    static func deepest(_ at: TreeEntry) -> Int? {
        var deepest: Int? = nil
        func walk(_ node: ProjectNode, _ level: Int) { for child in node.children { if !child.children.isEmpty { deepest = max(deepest ?? 0, level + 1) }; walk(child, level + 1) } }
        walk(at.node, at.level)
        return deepest
    }
}

struct ProjectTreeView: View {
    let ids: [String]
    var depth = 0
    let o: TreeOptions
    var onFold: ((String) -> Void)? = nil
    var onGo: (String) -> Void
    var onMenu: ((String, NSEvent?) -> Void)? = nil
    var onOpenVersion: ((ArchivedVersion) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(ids.filter { o.tree.has($0) && ProjectTreeModel.matches($0, o) }, id: \.self) { id in node(id) }
        }
    }

    @ViewBuilder func node(_ id: String) -> some View {
        let at = o.tree[id]!
        let n = at.node
        let versions = ProjectTreeModel.archives(n, o).filter { o.q.isEmpty || n.name.lowercased().contains(o.q) || ProjectTreeModel.versionMatches($0, o.q) }
        let under = n.children.count + versions.count
        let isFolded = !o.expandAll && o.q.isEmpty && o.folded.contains(id)
        let here = id == o.hereId
        let inHere = o.hereId.flatMap { o.tree[$0]?.path.contains(id) } ?? false
        TreeRow(id: id, level: at.level, depth: depth, name: n.name, count: o.counts[id], strong: id == o.contextRoot || here, here: here,
                chevron: !o.expandAll && under > 0 ? (open: !isFolded, onHover: at.level > 1 && !inHere) : nil, context: id == o.contextRoot,
                onGo: { onGo(id) }, onFold: { onFold?(id) }, onMenu: onMenu.map { menu in { menu(id, $0) } })
        if under > 0 && !isFolded {
            ZStack(alignment: .topLeading) {
                if at.level == o.guideLevel { Rectangle().fill(Color(hex: "#e3e3e3")).frame(width: 1).padding(.vertical, 2).padding(.leading, 9).frame(maxHeight: .infinity, alignment: .leading) }
                VStack(alignment: .leading, spacing: 0) {
                    ProjectTreeView(ids: n.children.map(\.id), depth: depth + 1, o: o, onFold: onFold, onGo: onGo, onMenu: onMenu, onOpenVersion: onOpenVersion)
                    ForEach(versions, id: \.file) { version in VersionRow(version: version) { onOpenVersion?(version) } }
                }
                .padding(.leading, depth > 0 ? 18 : 22)
            }
            .driveID("sb-fly-kids=\(id)")
        }
    }
}

struct TreeRow: View {
    let id: String
    let level: Int
    let depth: Int
    let name: String
    let count: AgentSummary?
    let strong: Bool
    let here: Bool
    let chevron: (open: Bool, onHover: Bool)?
    let context: Bool
    var onGo: () -> Void
    var onFold: () -> Void
    var onMenu: ((NSEvent?) -> Void)?
    @State private var hovered = false
    var body: some View {
        HStack(spacing: 8) {
            if level == 2 { SBIcon(SidebarIcons.workspace, size: 18).foregroundStyle(Color(SB.icon)).frame(width: 18, height: 18) }
            else if depth == 0 { SBIcon(SidebarIcons.workspace, size: 15).foregroundStyle(Color(Palette.gray700)).frame(width: 16) }
            Text(name).font(sans(depth > 0 ? 13.5 : 14, strong ? 500 : 400))
                .foregroundStyle(Color(Names.isUntitled(name) ? Palette.fnt : depth > 0 ? Palette.gray700 : Palette.ink)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                CountBadge(summary: count).frame(width: 22)
                if let chevron {
                    Button(action: onFold) {
                        SBIcon(SidebarIcons.chevronDown, size: 13, stroke: 2.4).rotationEffect(.degrees(chevron.open ? 0 : 180))
                            .foregroundStyle(Color(SB.chev)).frame(width: 18, height: 18)
                    }
                    .buttonStyle(.plain)
                    .opacity(chevron.onHover && !hovered ? 0 : 1)
                    .accessibilityLabel("\(chevron.open ? "Fold" : "Open") \(name)")
                    .driveID("tree-fold=\(id)")
                    .frame(width: 18)
                } else if !(chevron == nil && level == 0) { Color.clear.frame(width: 18) }
            }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 30)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: here ? "#ececec" : "#f3f3f3").opacity(here || hovered ? 1 : 0)))
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .onTapGesture(perform: onGo)
        .overlay(onMenu.map { menu in RightClick { menu($0) } })
        .driveID("tree-project=\(id)")
    }
}

struct VersionRow: View {
    let version: ArchivedVersion
    let action: () -> Void
    @State private var hovered = false
    var body: some View {
        HStack(spacing: 8) {
            SBIcon(SidebarIcons.archive, size: 14).foregroundStyle(Color(Palette.fnt)).frame(width: 16)
            Text(version.title).font(sans(13.5)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).frame(minHeight: 30)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: "#f3f3f3").opacity(hovered ? 1 : 0)))
        .contentShape(Rectangle()).onHover { hovered = $0 }.onTapGesture(perform: action)
        .help(version.clearedAt.map { "Cleared \(SidebarModel.sinceWords($0))" } ?? "")
        .driveID("sb-version=\(version.file)")
    }
}

/// Every project here (Projects' More): a search, the tree with every level-2 folded but the one you are in, each row's
/// count, a + that makes one at the top; each project's archived versions under it.
@MainActor
final class ProjectsPanelModel: ObservableObject {
    @Published var q = ""
    @Published var folded: Set<String>
    let roots: [ProjectNode]
    let tree: TreeIndex
    init(roots: [ProjectNode], tree: TreeIndex, hereId: String?) {
        self.roots = roots; self.tree = tree
        let branch = hereId.flatMap { tree[$0]?.path.first }
        folded = Set(roots.filter { $0.id != branch && (!$0.children.isEmpty || !$0.archives.isEmpty) }.map(\.id))
    }
    func flip(_ id: String) { if folded.contains(id) { folded.remove(id) } else { folded.insert(id) } }
    var needle: String { q.trimmed.lowercased() }
    var nothing: Bool { !needle.isEmpty && !tree.values.contains { $0.node.name.lowercased().contains(needle) || SidebarModel.versionsOf($0.node).contains { $0.title.lowercased().contains(needle) } } }
}

struct ProjectsPanelView: View {
    @ObservedObject var model: ProjectsPanelModel
    let counts: [String: AgentSummary]
    let hereId: String?
    var onGo: (String) -> Void
    var onNew: () -> Void
    var onMenu: (String, NSEvent?) -> Void
    var onOpenVersion: (ArchivedVersion) -> Void
    var body: some View {
        VStack(spacing: 0) {
            PanelHead(title: "Projects", count: model.tree.count) {
                RowActionButton(label: "Create project", action: onNew) { SBIcon(SidebarIcons.plus, size: 15) }.driveID("sb-panel-new")
            }
            SearchFieldView(text: $model.q, placeholder: "Find a project")
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ProjectTreeView(ids: model.roots.map(\.id), o: TreeOptions(tree: model.tree, counts: counts, hereId: hereId, folded: model.folded, q: model.needle, showVersions: true),
                                    onFold: model.flip, onGo: onGo, onMenu: onMenu, onOpenVersion: onOpenVersion)
                    if model.nothing { EmptyNote(text: "No project by that name.") }
                }.padding(EdgeInsets(top: 4, leading: 6, bottom: 8, trailing: 6))
            }
        }.driveID("sb-panel=projects")
    }
}

/// A level's More: every sibling there and what is in each, open, each foldable; nothing above them.
struct SiblingsPanelView: View {
    let ids: [String]
    let tree: TreeIndex
    let counts: [String: AgentSummary]
    let hereId: String?
    var onGo: (String) -> Void
    var onMenu: (String, NSEvent?) -> Void
    var onOpenVersion: ((ArchivedVersion) -> Void)?
    @State private var folded: Set<String> = []
    var body: some View {
        ScrollView {
            ProjectTreeView(ids: ids, depth: 1, o: TreeOptions(tree: tree, counts: counts, hereId: hereId, folded: folded, showVersions: onOpenVersion != nil),
                            onFold: { id in if folded.contains(id) { folded.remove(id) } else { folded.insert(id) } }, onGo: onGo, onMenu: onMenu, onOpenVersion: onOpenVersion)
                .padding(EdgeInsets(top: 6, leading: 6, bottom: 8, trailing: 6))
        }.driveID("sb-panel=siblings")
    }
}

/// What a folded project holds, beside the sidebar while the pointer rests on its row (2026-10-13): the project, then
/// everything in it, open, with no chevrons; a guide line only beside the deepest group, none when there are only children.
struct ProjectFlyoutView: View {
    let id: String
    let tree: TreeIndex
    let counts: [String: AgentSummary]
    let hereId: String?
    var onGo: (String) -> Void
    var body: some View {
        let guide = tree[id].flatMap(ProjectTreeModel.deepest)
        ScrollView {
            ProjectTreeView(ids: [id], o: TreeOptions(tree: tree, counts: counts, hereId: hereId, expandAll: true, guideLevel: guide, contextRoot: id), onGo: onGo).padding(5)
        }
        .frame(width: 270)
        .frame(maxHeight: 440)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(Palette.tabHover), lineWidth: 1))
        .compositingGroup().shadow(color: .black.opacity(0.08), radius: 16, x: 0, y: 12).shadow(color: .black.opacity(0.04), radius: 3, x: 0, y: 2)
        .driveID("sb-flyout=\(id)")
    }
}

/// A folder of Sources whole (its More): every source in it, the one open marked; a press opens it, its minus takes it
/// out of the folder (the library keeps it). Long folders get a search.
struct SourcesPanelView: View {
    let title: String
    let rows: [LibraryRow]
    let activeId: String?
    let removeLabel: String
    let peek: PeekController?
    var onOpen: (LibraryRow) -> Void
    var onRemove: ((LibraryRow) -> Void)?
    @State private var q = ""
    var body: some View {
        let needle = q.trimmed.lowercased()
        let listed = needle.isEmpty ? rows : rows.filter { "\($0.name) \($0.url ?? "")".lowercased().contains(needle) }
        VStack(spacing: 0) {
            PanelHead(title: title, count: rows.count)
            if rows.count > 8 { SearchFieldView(text: $q, placeholder: "Find in \(title)") }
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(listed, id: \.id) { row in
                        PanelRow(icon: SourceGlyph(row: row), title: row.name, active: row.id == activeId, faint: Names.isUntitled(row.name),
                                 onClick: { peek?.drop(); onOpen(row) },
                                 onHover: { inside in if inside { if let peek { PeekAnchor.open(peek, row: row) } } else { peek?.close() } }) {
                            if let onRemove { RowActionButton(label: removeLabel, action: { onRemove(row) }) { SBIcon(SidebarIcons.minusCircle, size: 14) } }
                        }.driveID("sb-source-all=\(row.id)")
                    }
                    if listed.isEmpty { EmptyNote(text: needle.isEmpty ? "Nothing here yet." : "Nothing by that name.") }
                }.padding(EdgeInsets(top: 2, leading: 4, bottom: 6, trailing: 4))
            }
        }.driveID("sb-panel=sources")
    }
}
