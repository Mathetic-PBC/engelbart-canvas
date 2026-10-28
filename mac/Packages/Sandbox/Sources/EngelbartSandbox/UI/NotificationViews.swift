import SwiftUI
import AppKit
import EngelbartCore
import EngelbartUI

/// The CSS's own values for these views (sandbox-notifications.css, environment-panel.css), through EngelbartUI's hex
/// colors. The headings' bottom border and the actions' top border are left out: no horizontal divider lines.
enum SandboxStyle {
    static let ink = Color(Palette.ink)
    static let gray777 = Color(NSColor(hex: "#777777"))
    static let gray4d = Color(Palette.gray700)
    static let hover = Color(NSColor(hex: "#ededed"))
    static let rowHover = Color(NSColor(hex: "#f5f5f5"))
    static let dismissHover = Color(NSColor(hex: "#f3f3f3"))
    static let panelBorder = Color(NSColor(hex: "#dedede"))
    static let idleDot = Color(Palette.gray300)
    static let runningDot = Color(NSColor(hex: "#22c55e"))
    static let error = Color(NSColor(hex: "#b91c1c"))
    static let empty = Color(NSColor(hex: "#888888"))
}

/// The bell icon (lucide's bell, the JSX's two paths, on a 24-unit grid), drawn at 17 pt with stroke 2.
struct BellIcon: Shape {
    static let paths = ["M10.268 21a2 2 0 0 0 3.464 0",
                        "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326"]
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let scale = CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24)
        for d in Self.paths { p.addPath(Path(SVGPath.parse(d)), transform: scale) }
        return p
    }
}

/// One build notification: Building… → Build finished / Build failed, with Open live / Open terminal, and ×. A failed
/// build says, at most, why in a few words (its whole error is in its build details); a finished one says whether its
/// sandbox is asleep or running, so a wait to wake it is no surprise.
public struct BuildNotificationView: View {
    let notification: BuildNotificationRow
    let run: SandboxRun
    let sandbox: String?
    let repo: JSONValue?
    let busy: Bool
    let onRepository: (JSONValue) -> Void
    let onBuild: (JSONValue) -> Void
    let onOpen: (SandboxRun) -> Void
    let onTerminal: ((SandboxRun) -> Void)?
    let onClear: ([String]) -> Void

    public init(notification: BuildNotificationRow, run: SandboxRun, sandbox: String?, repo: JSONValue?, busy: Bool,
                onRepository: @escaping (JSONValue) -> Void, onBuild: @escaping (JSONValue) -> Void, onOpen: @escaping (SandboxRun) -> Void,
                onTerminal: ((SandboxRun) -> Void)?, onClear: @escaping ([String]) -> Void) {
        self.notification = notification; self.run = run; self.sandbox = sandbox; self.repo = repo; self.busy = busy
        self.onRepository = onRepository; self.onBuild = onBuild; self.onOpen = onOpen; self.onTerminal = onTerminal; self.onClear = onClear
    }

    var name: String { repo?["name"]?.string ?? "Repository" }
    var building: Bool { run["status"]?.string == "starting" }
    var failed: Bool { run["status"]?.string == "failed" }

    public var body: some View {
        let canOpen = SandboxNotifications.canOpenPreview(run)
        let canTerminal = SandboxNotifications.canOpenTerminal(run) && onTerminal != nil
        let reason = SandboxNotifications.failureReason(run)
        let status = SandboxNotifications.sandboxStatus(run, sandbox)
        HStack(spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    if let repo, repo["url"]?.string != nil {
                        HoverText(name, font: Fonts.sans(12, weight: 500), color: SandboxStyle.ink, underline: true)
                            .accessibilityLabel("Open \(name) on GitHub in Stage")
                            .onTapGesture { onRepository(repo) }
                    } else {
                        Text(name).font(Font(Fonts.sans(12, weight: 500))).foregroundColor(SandboxStyle.ink).lineLimit(1).truncationMode(.tail)
                    }
                    if !building {
                        HStack(spacing: 6) {
                            Button { if let repo { onBuild(repo) } } label: {
                                HoverText(failed ? "Build failed" : "Build finished", font: Fonts.sans(11.5), color: SandboxStyle.gray777, hoverColor: SandboxStyle.ink, underline: true)
                            }
                            .buttonStyle(.plain).disabled(repo == nil).opacity(repo == nil ? 0.5 : 1)
                            .accessibilityLabel("\(failed ? "Build failed" : "Build finished") — view build details for \(name)")
                            if !status.isEmpty {
                                HStack(spacing: 5) {
                                    // Running: a plain green dot (2026-10-06: no ring, no pulse).
                                    Circle().fill(sandbox == "running" ? SandboxStyle.runningDot : SandboxStyle.idleDot).frame(width: 6, height: 6)
                                    Text(status).font(Font(Fonts.sans(11))).foregroundColor(sandbox == "running" ? SandboxStyle.gray4d : SandboxStyle.gray777)
                                }
                                .help(sandbox == "asleep" ? "Opening it wakes it, which can take a few seconds" : "Its sandbox is awake")
                            }
                        }
                    }
                    if failed && !reason.isEmpty { Text(reason).font(Font(Fonts.sans(11))).foregroundColor(SandboxStyle.gray777) }
                    if run["status"]?.string == "ready" && SandboxNotifications.runKind(run) != "terminal" && !canOpen {
                        Text("No web preview").font(Font(Fonts.sans(11))).foregroundColor(SandboxStyle.gray777)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if building || canOpen || canTerminal {
                    HStack(spacing: 6) {
                        if building {
                            RowAction("Building…", color: SandboxStyle.gray777) { if let repo { onBuild(repo) } }
                                .disabled(repo == nil).accessibilityLabel("View build details for \(name)")
                        }
                        if canOpen {
                            RowAction("Open live", color: SandboxStyle.gray4d) { onOpen(run) }.disabled(busy).accessibilityLabel("Open live preview for \(name)")
                        }
                        if canTerminal {
                            RowAction("Open terminal", color: SandboxStyle.gray4d) { onTerminal?(run) }.disabled(busy).accessibilityLabel("Open terminal for \(name)")
                        }
                    }
                }
            }
            .padding(EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 6))
            DismissButton { onClear([notification.id]) }
                .accessibilityLabel("Clear notification for \(name)").help("Clear notification").padding(.trailing, 6)
        }
    }
}

/// Text whose color and underline follow the pointer.
struct HoverText: View {
    let text: String
    let font: NSFont
    let color: Color
    var hoverColor: Color?
    var underline = false
    @State private var hovering = false
    init(_ text: String, font: NSFont, color: Color, hoverColor: Color? = nil, underline: Bool = false) {
        self.text = text; self.font = font; self.color = color; self.hoverColor = hoverColor; self.underline = underline
    }
    var body: some View {
        Text(text).font(Font(font)).foregroundColor(hovering ? (hoverColor ?? color) : color)
            .underline(hovering && underline).lineLimit(1).truncationMode(.tail)
            .onHover { hovering = $0 }
    }
}

/// `.notification-build` / `.notification-open`: radius 4, padding 4, 11.5 px, #f5f5f5 on hover.
struct RowAction: View {
    let title: String
    let color: Color
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    init(_ title: String, color: Color, action: @escaping () -> Void) { self.title = title; self.color = color; self.action = action }
    var body: some View {
        Button(action: action) {
            Text(title).font(Font(Fonts.sans(11.5))).foregroundColor(hovering && enabled ? SandboxStyle.ink : color).lineLimit(1)
                .padding(4).background(RoundedRectangle(cornerRadius: 4).fill(hovering && enabled ? SandboxStyle.rowHover : .clear))
        }
        .buttonStyle(.plain).opacity(enabled ? 1 : 0.5).onHover { hovering = $0 }
    }
}

/// The 24×24 ×, radius 4, #777 → #171717 on #f3f3f3.
struct DismissButton: View {
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Text("×").font(Font(Fonts.sans(18))).foregroundColor(hovering ? SandboxStyle.ink : SandboxStyle.gray777)
                .frame(width: 24, height: 24).background(RoundedRectangle(cornerRadius: 4).fill(hovering ? SandboxStyle.dismissHover : .clear))
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
    }
}

/// The notification rows themselves, for a panel that holds them (the sidebar's Inbox, 2026-10-08). `onClose` shuts the
/// panel before a row's action opens something.
public struct NotificationRowsView: View {
    @ObservedObject var model: SandboxProgressModel
    let onClose: () -> Void
    public init(model: SandboxProgressModel, onClose: @escaping () -> Void = {}) { self.model = model; self.onClose = onClose }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !model.error.isEmpty {
                Text(model.error).font(Font(Fonts.sans(12))).foregroundColor(SandboxStyle.error).padding(.horizontal, 10).padding(.vertical, 8)
                    .accessibilityAddTraits(.isStaticText)
            }
            ForEach(model.rows, id: \.id) { notification in
                if let item = model.items[notification.libraryId] {
                    let use: (@escaping () -> Void) -> Void = { action in model.markRead([notification.id]); onClose(); action() }
                    BuildNotificationView(notification: notification, run: item.run, sandbox: item.sandbox, repo: model.repo(notification.libraryId),
                                          busy: model.busy[item.run["id"]?.string ?? ""] ?? false,
                                          onRepository: { row in use { model.openRepository(row) } }, onBuild: { row in use { model.openBuild(row) } },
                                          onOpen: { run in use { model.open(run) } }, onTerminal: { run in use { model.openTerminal(run) } },
                                          onClear: { model.clear($0) })
                }
            }
        }
    }
}

/// The header bell (every screen without a sidebar: the all-projects screen): a quiet 32×32 control with a badge for
/// unread notifications, and its panel (320 wide, ≤360 of rows). Opening it marks the unread read; Escape, a click
/// outside or the window losing focus closes it.
public struct NotificationBellView: View {
    @ObservedObject var model: SandboxProgressModel
    @State private var expanded = false
    @State private var hovering = false
    public init(model: SandboxProgressModel) { self.model = model }

    public var body: some View {
        let unread = model.unread
        Button { expanded.toggle() } label: {
            ZStack(alignment: .topTrailing) {
                BellIcon().stroke(SandboxStyle.ink, style: StrokeStyle(lineWidth: 2 * 17 / 24, lineCap: .round, lineJoin: .round))
                    .frame(width: 17, height: 17).frame(width: 32, height: 32)
                if unread > 0 {
                    Text(unread > 9 ? "9+" : String(unread)).font(Font(Fonts.sans(9, weight: 600))).foregroundColor(.white)
                        .padding(.horizontal, 3).frame(minWidth: 13, minHeight: 13, maxHeight: 13)
                        .background(Capsule().fill(SandboxStyle.ink)).offset(x: 2, y: 0)
                }
            }
            .background(RoundedRectangle(cornerRadius: 5).fill(hovering || expanded ? SandboxStyle.hover : .clear))
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
        .help("Notifications")
        .accessibilityLabel("Notifications\(unread > 0 ? ", \(unread) unread" : "")")
        .popover(isPresented: $expanded, arrowEdge: .bottom) { panel }
        .onChange(of: expanded) { open in if open { readAll() } }
        .onChange(of: unread) { _ in if expanded { readAll() } }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { _ in expanded = false }
    }

    private func readAll() {
        let ids = model.rows.filter { !$0.read }.map(\.id)
        if !ids.isEmpty { model.markRead(ids) }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Notifications").font(Font(Fonts.sans(12, weight: 500))).foregroundColor(SandboxStyle.ink)
                Spacer()
                HStack(spacing: 6) {
                    if !model.rows.isEmpty {
                        RowAction("Clear all", color: SandboxStyle.gray777) { model.clear(model.rows.map(\.id)) }
                    }
                    DismissButton { expanded = false }.accessibilityLabel("Close notifications")
                }
            }
            .padding(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 10))
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.rows.isEmpty && model.error.isEmpty {
                        Text("No notifications.").font(Font(Fonts.sans(12))).foregroundColor(SandboxStyle.empty).padding(.horizontal, 10).padding(.vertical, 20)
                    }
                    NotificationRowsView(model: model) { expanded = false }
                }
                .padding(4)
            }
            .frame(maxHeight: 360)
        }
        .frame(width: 320)
        .background(Color(Palette.panel))
        .onExitCommand { expanded = false }
    }
}
