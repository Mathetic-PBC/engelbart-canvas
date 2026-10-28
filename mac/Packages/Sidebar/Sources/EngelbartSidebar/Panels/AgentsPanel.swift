import AppKit
import SwiftUI
import EngelbartUI
import EngelbartDoc

// Agents, with what was the Inbox (SidebarPanels.jsx AgentsPanel; 2026-10-13 "Combine inbox and Agents into just
// Agents"; 2026-10-16 no "Earlier", rows go after 3 days or a day after a click; 2026-10-17 what runs comes first): what
// runs, what failed, what needs you, and what finished, newest first in each, the repositories' builds among them. A row
// says where it is and how long ago; a black dot while it waits to be looked at, its name in the wave while it runs; a
// press goes to it, its × (on hover, upper right; none on a Build still running) puts it away. "Next agent needing
// attention" is ⌘J's.

enum AgentsPanelModel {
    static let GROUPS: [(title: String, states: [String])] = [("Running", ["running"]), ("Failed", ["failed"]), ("Needs you", ["needs"]), ("Finished", ["unseen", "done"])]

    static func groups(_ entries: [AgentEntry]) -> [(title: String, list: [AgentEntry])] {
        GROUPS.map { group in (group.title, entries.filter { group.states.contains($0.state) }) }.filter { !$0.list.isEmpty }
    }
    /// Something finished and not looked at yet: "Mark all as seen" shows.
    static func unseen(_ entries: [AgentEntry]) -> Bool { entries.contains { $0.state == "unseen" && !$0.viewed } }
    static func canDismiss(_ entry: AgentEntry, dismissable: Bool) -> Bool { dismissable && !SidebarModel.buildInProgress(entry) }
    /// A row's black dot: waiting to be looked at.
    static func waiting(_ entry: AgentEntry) -> Bool { entry.state != "running" && entry.state != "done" && !entry.viewed }

    /// Where a row is: a project's path, "A sticky", a repository build's state, or what a Connect note did.
    static func crumb(_ entry: AgentEntry, crumbOf: (String) -> [String]) -> [String] {
        if entry.kind == "repo" {
            let status = entry.run?["status"]?.string
            if status == "starting" { return ["Building…"] }
            let sandbox = sandboxStatus(entry)
            if status == "failed" { return [["Build failed", failureReason(entry)].filter { !$0.isEmpty }.joined(separator: " · ")] }
            return [["Build finished", sandbox].filter { !$0.isEmpty }.joined(separator: " · ")]
        }
        if let node = entry.node { return crumbOf(node) }
        if entry.kind == "quick" { return ["A sticky"] }
        return (entry.did ?? "").isEmpty ? [] : [entry.did!]
    }

    // model/sandbox-notifications.js sandboxStatus / failureReason, the parts a row says.
    static func sandboxStatus(_ entry: AgentEntry) -> String {
        guard entry.run?["status"]?.string == "ready" else { return "" }
        switch entry.sandbox?.string { case "asleep": return "Asleep"; case "running": return "Running"; default: return "" }
    }
    /// Why a build failed, in a few words for the bell.
    static func failureReason(_ entry: AgentEntry) -> String {
        guard entry.run?["status"]?.string == "failed" else { return "" }
        let error = entry.run?["error"]?.string ?? ""
        func has(_ pattern: String) -> Bool { Rx(pattern, "i").test(error) }
        if has(#"^Setup stopped|Setup was interrupted"#) { return "Setup stopped" }
        if has(#"Claude Code is not installed|Update Claude Code"#) { return "Claude Code not installed" }
        if has(#"not signed in to a Claude subscription"#) { return "Claude Code not signed in" }
        if has(#"^Desktop apps are not supported yet"#) { return "Desktop apps not supported yet" }
        if has(#"web preview|preview is not reachable|public preview"#) { return "No web preview found" }
        return "Setup failed"
    }

    static func icon(_ kind: String) -> Icon {
        switch kind {
        case "connect": return SidebarIcons.library
        case "repo": return SidebarIcons.git
        case "bart", "brainstorm", "discover": return SidebarIcons.chat
        default: return SidebarIcons.agents
        }
    }
}

struct AgentsPanelView: View {
    let entries: [AgentEntry]
    let crumbOf: (String) -> [String]
    let dismissable: Bool
    var onGo: (AgentEntry, CGRect?) -> Void
    var onDismiss: (AgentEntry) -> Void
    var onNext: () -> Void
    var onSeenAll: () -> Void
    /// Refreshed every 30 s so "4m" moves on.
    @State private var now = JSTime.now()
    let tick = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            PanelHead(title: "Agents") {
                if AgentsPanelModel.unseen(entries) {
                    Button(action: onSeenAll) {
                        Text("Mark all as seen").font(sans(12, 500)).foregroundStyle(Color(Palette.ink)).padding(.horizontal, 10).frame(height: 26)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Color.white))
                            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(hex: "#e4e4e4"), lineWidth: 1))
                            .shadow(color: .black.opacity(0.04), radius: 0.5, x: 0, y: 1)
                    }.buttonStyle(.plain).driveID("agents-seen-all")
                }
            }
            let groups = AgentsPanelModel.groups(entries)
            if groups.isEmpty {
                EmptyNote(text: "Nothing yet. When an agent finishes or asks you something, it shows here.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(groups, id: \.title) { group in
                            PanelGroup(title: group.title) { ForEach(group.list, id: \.id) { entry in AgentRow(entry: entry, crumb: AgentsPanelModel.crumb(entry, crumbOf: crumbOf), now: now, canDismiss: AgentsPanelModel.canDismiss(entry, dismissable: dismissable), onGo: onGo, onDismiss: onDismiss) } }
                        }
                    }.padding(EdgeInsets(top: 4, leading: 6, bottom: 8, trailing: 6))
                }.frame(maxHeight: .infinity)
            }
            NextAgentButton(action: onNext)
        }
        .onReceive(tick) { _ in now = JSTime.now() }
        .driveID("sb-panel=agents")
    }
}

struct NextAgentButton: View {
    let action: () -> Void
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 20) {
                Text("Next agent needing attention").font(sans(13.5)).foregroundStyle(Color(Palette.ink))
                Spacer(minLength: 0)
                Text("⌘J").font(sans(12).monospacedDigit()).foregroundStyle(Color(Palette.fnt))
            }
            .padding(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14)).frame(minHeight: 38)
            .background(Color(Palette.gray150).opacity(hovered ? 1 : 0))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).onHover { hovered = $0 }.driveID("agents-next")
    }
}

struct AgentRow: View {
    let entry: AgentEntry
    let crumb: [String]
    let now: Double
    let canDismiss: Bool
    var onGo: (AgentEntry, CGRect?) -> Void
    var onDismiss: (AgentEntry) -> Void
    @State private var hovered = false
    var body: some View {
        let running = entry.state == "running"
        let waiting = AgentsPanelModel.waiting(entry)
        HStack(spacing: 10) {
            SBIcon(AgentsPanelModel.icon(entry.kind), size: 15).foregroundStyle(Color(Palette.gray700)).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                if running { WaveText(entry.title, font: sans(14)).lineLimit(1) }
                else { Text(entry.title).font(sans(14)).foregroundStyle(Color(Palette.ink)).lineLimit(1).truncationMode(.tail) }
                if !crumb.isEmpty { FitCrumb(parts: crumb) }
            }
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Text(SidebarModel.since(entry.at, now: now)).font(sans(12)).foregroundStyle(Color(Palette.fnt))
                Circle().fill(waiting ? Color(Palette.ink) : Color.clear).frame(width: 7, height: 7).driveID(waiting ? "agent-dot=\(entry.id)" : "agent-nodot")
            }
        }
        .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
        .frame(minHeight: 34)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: "#f3f3f3").opacity(hovered ? 1 : 0)))
        .overlay(alignment: .topTrailing) {
            if canDismiss && hovered {
                RowActionButton(label: "Remove \(entry.title)", size: 16, action: { onDismiss(entry) }) { SBIcon(SidebarIcons.close, size: 11) }
                    .padding(1).driveID("agent-dismiss=\(entry.id)")
            }
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .background(GeometryReader { geo in Color.clear.preference(key: RowRectKey.self, value: geo.frame(in: .global)) })
        .onTapGesture { onGo(entry, nil) }
        .driveID("agent-entry=\(entry.id)")
    }
}

struct RowRectKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}
