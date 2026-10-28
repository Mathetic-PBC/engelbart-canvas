import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// The top-level project's menu (SidebarPanels.jsx ProjectMenu: Linear's workspace menu), the right-click menu
// (ContextMenu), the clock's list (RecentPages.jsx) and the tooltip faces. Kept as the code at 9413a56 has them: the
// project menu's and the context menu's 1px #efefef rules (ledger row 153).

/// A row of a menu: 32 high, gap 10, padding 0 10, 13.5 (`item`).
struct MenuRow<Content: View>: View {
    var on = false
    var height: CGFloat = 32
    let action: () -> Void
    var onHover: (Bool) -> Void = { _ in }
    @ViewBuilder var content: () -> Content
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) { content() }.font(sans(13.5)).foregroundStyle(Color(Palette.ink))
                .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.gray150).opacity(on || hovered ? 1 : 0)))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).onHover { hovered = $0; onHover($0) }
    }
}

struct MenuRule: View { var body: some View { Rectangle().fill(Color(hex: "#efefef")).frame(height: 1).padding(EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6)) } }

/// Under the name: Switch project ›, Rename, Project page ↗, Keyboard shortcuts.
struct ProjectMenuView: View {
    let switchOpen: Bool
    var onSwitchHover: (Bool) -> Void
    var onSwitch: () -> Void
    var onOtherHover: () -> Void
    var onRename: () -> Void
    var onProjectPage: () -> Void
    var onShortcuts: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            MenuRow(on: switchOpen, action: onSwitch, onHover: { if $0 { onSwitchHover(true) } }) {
                Text("Switch project"); Spacer(minLength: 0); SBIcon(SidebarIcons.chevronRight, size: 13).foregroundStyle(Color(Palette.fnt))
            }.driveID("sb-switch-project")
            MenuRow(action: onRename, onHover: { if $0 { onOtherHover() } }) { Text("Rename"); Spacer(minLength: 0) }.driveID("sb-rename-project")
            MenuRow(action: onProjectPage, onHover: { if $0 { onOtherHover() } }) {
                Text("Project page"); Spacer(minLength: 0); SBIcon(SidebarIcons.arrowOut, size: 14).foregroundStyle(Color(Palette.fnt))
            }.driveID("sb-project-page")
            MenuRule()
            MenuRow(action: onShortcuts, onHover: { if $0 { onOtherHover() } }) {
                Text("Keyboard shortcuts"); Spacer(minLength: 0); Text("⌃1–9 · ⌘J").font(sans(12).monospacedDigit()).foregroundStyle(Color(Palette.fnt))
            }.driveID("sb-shortcuts")
        }
        .padding(5)
        .driveID("sb-panel=project")
    }
}

/// The list beside Switch project: every top-level project with its count and this one ticked; New project; All projects.
struct SwitchListView: View {
    let list: [PublicProject]?
    let currentId: String
    let counts: [String: AgentSummary]
    var onPick: (String) -> Void
    var onNewProject: () -> Void
    var onAllProjects: () -> Void
    var onHover: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    if list == nil { Text("Loading…").font(sans(13)).foregroundStyle(Color(Palette.fnt)).padding(EdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 10)) }
                    ForEach(list ?? [], id: \.id) { candidate in
                        MenuRow(action: { onPick(candidate.id) }) {
                            SBIcon(SidebarIcons.project, size: 15).foregroundStyle(Color(Palette.gray700))
                            Text(candidate.name).fontWeight(candidate.id == currentId ? .medium : .regular).lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 0)
                            CountBadge(summary: counts[candidate.id])
                            ZStack { if candidate.id == currentId { SBIcon(SidebarIcons.check, size: 14).foregroundStyle(Color(Palette.ink)) } }.frame(width: 18)
                        }.driveID("sb-project=\(candidate.id)")
                    }
                }
            }.frame(maxHeight: 360)
            MenuRule()
            MenuRow(action: onNewProject) { SBIcon(SidebarIcons.plus, size: 15).foregroundStyle(Color(Palette.gray700)); Text("New project") }.driveID("sb-new-project")
            MenuRow(action: onAllProjects) { SBIcon(SidebarIcons.library, size: 15).foregroundStyle(Color(Palette.gray700)); Text("All projects and library") }.driveID("sb-all-projects")
        }
        .padding(5)
        .onHover { if $0 { onHover() } }
        .driveID("sb-panel=switch")
    }
}

/// A right click's menu: `items` of { label, icon, danger, disabled + title, separator }.
public struct MenuItemSpec {
    public var label: String
    public var icon: Icon?
    public var danger = false
    public var disabled = false
    public var title: String?
    public var separator = false
    public var action: () -> Void = {}
    public static var separatorItem: MenuItemSpec { MenuItemSpec(label: "", icon: nil, separator: true) }
    public init(label: String, icon: Icon?, danger: Bool = false, disabled: Bool = false, title: String? = nil, separator: Bool = false, action: @escaping () -> Void = {}) {
        self.label = label; self.icon = icon; self.danger = danger; self.disabled = disabled; self.title = title; self.separator = separator; self.action = action
    }
}

struct ContextMenuView: View {
    let items: [MenuItemSpec]
    var onPick: (MenuItemSpec) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                if item.separator { MenuRule() }
                else {
                    MenuRow(height: 30, action: { if !item.disabled { onPick(item) } }) {
                        if let icon = item.icon { SBIcon(icon, size: 14).foregroundStyle(Color(item.danger ? Palette.del : Palette.gray700)).frame(width: 15) }
                        Text(item.label).font(sans(13)).foregroundStyle(Color(item.danger ? Palette.del : Palette.ink))
                        Spacer(minLength: 0)
                    }
                    .opacity(item.disabled ? 0.4 : 1)
                    .help(item.title ?? "")
                    .driveID("menu-item=\(item.label)")
                }
            }
        }
        .padding(5)
        .frame(minWidth: 190)
        .driveID("sb-context-menu")
    }
}

/// The clock's list (RecentPages.jsx): the top-level project's page first, then the projects with their path and count,
/// and the notes opened last.
struct RecentPagesView: View {
    let pages: [RecentPage]
    let project: SidebarProject
    let tree: TreeIndex
    let notes: [String: String]
    let counts: [String: AgentSummary]
    var onOpen: (RecentPage) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Recent pages").font(sans(13.5, 500)).foregroundStyle(Color(Palette.ink)).padding(EdgeInsets(top: 12, leading: 14, bottom: 6, trailing: 14))
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(pages, id: \.self) { page in row(page) }
                }.padding(EdgeInsets(top: 0, leading: 6, bottom: 8, trailing: 6))
            }
        }.driveID("sb-panel=recent")
    }
    @ViewBuilder func row(_ page: RecentPage) -> some View {
        let at = page.kind == "project" ? tree[page.id] : nil
        let name = page.kind == "top" ? project.name : page.kind == "note" ? (notes[page.id] ?? "") : (at?.node.name ?? "")
        let crumb = at.map { [project.name] + $0.path.dropLast().compactMap { tree[$0]?.node.name } } ?? []
        let icon = page.kind == "top" ? SidebarIcons.project : page.kind == "note" ? SidebarIcons.note : SidebarIcons.workspace
        MenuRow(height: 34, action: { onOpen(page) }) {
            SBIcon(icon, size: 17).foregroundStyle(Color(Palette.gray700)).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(sans(14)).lineLimit(1).truncationMode(.tail)
                if !crumb.isEmpty { FitCrumb(parts: crumb) }
            }
            Spacer(minLength: 0)
            if at != nil { CountBadge(summary: counts[page.id]) }
        }
        .frame(minHeight: 34)
        .driveID("recent-page=\(page.kind):\(page.id)")
    }
}
