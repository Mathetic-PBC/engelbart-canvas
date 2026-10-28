import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// src/renderer/workspace/Connections.jsx and ConnectionActions.jsx: the GitHub and Zotero rows of Settings ▸ Connections
// (MATH-64; Claude Code and Codex rows are the Tools package's, and the page that groups them under "Accounts" is the
// Settings page's). Every page opens in the default browser (github-open), never in the Stage. Each row follows every
// change of its account while the page is open (`engelbart:github`, `engelbart:zotero`).

/// The accounts' state and what their rows' actions call (ConnectionsPage's state).
@MainActor
public final class ConnectionsModel: ObservableObject {
    @Published public private(set) var github: GithubStatus?
    @Published public private(set) var githubBusy: String?
    @Published public private(set) var githubProblem = ""
    @Published public private(set) var zotero: ZoteroStatus?
    @Published public private(set) var zoteroBusy: String?
    @Published public private(set) var zoteroProblem = ""

    let githubChannels: GithubChannels?
    let zoteroChannels: ZoteroChannels?
    let copyText: (String) -> Void
    private var tokens: [EventHub.Token] = []
    private let hub: EventHub

    public init(github: GithubChannels?, zotero: ZoteroChannels?, copyText: @escaping (String) -> Void = { text in
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    }, hub: EventHub = .shared) {
        self.githubChannels = github
        self.zoteroChannels = zotero
        self.copyText = copyText
        self.hub = hub
        self.github = github?.status() ?? .unavailable
        self.zotero = zotero?.status() ?? .unavailable
        tokens.append(hub.on("engelbart:github") { [weak self] _ in MainActor.assumeIsolated { self?.github = self?.githubChannels?.status() } })
        tokens.append(hub.on("engelbart:zotero") { [weak self] _ in MainActor.assumeIsolated { self?.zotero = self?.zoteroChannels?.status() } })
    }

    deinit { for t in tokens { hub.off(t) } }

    /// githubAction: connect / disconnect / cancel answer the status; copy puts the device code on the clipboard; manage
    /// and reopen are pages (github-open install / device) in the default browser.
    public func act(github action: String) {
        guard githubBusy == nil, let channels = githubChannels else { return }
        githubBusy = action
        githubProblem = ""
        Task { @MainActor in
            do {
                switch action {
                case "connect": github = try await channels.connect()
                case "disconnect": github = try channels.disconnect()
                case "cancel": github = try channels.cancel()
                case "copy": if let code = github?.pending?.userCode { copyText(code) }
                default: try await channels.open(action == "manage" ? "install" : "device")
                }
            } catch { githubProblem = error.localizedDescription }
            githubBusy = nil
        }
    }

    /// zoteroAction: sync / connect / cancel / disconnect, each answering the status (never the key).
    public func act(zotero action: String) {
        guard zoteroBusy == nil, let channels = zoteroChannels else { return }
        zoteroBusy = action
        zoteroProblem = ""
        Task { @MainActor in
            do {
                switch action {
                case "sync": zotero = try channels.sync()
                case "connect": zotero = try await channels.connect()
                case "cancel": zotero = try channels.cancel()
                case "disconnect": zotero = try await channels.disconnect()
                default: break
                }
            } catch { zoteroProblem = error.localizedDescription }
            zoteroBusy = nil
        }
    }
}

/// The GitHub and Zotero rows, to go in the Connections page's "Accounts" group (before Claude Code and Codex).
public struct IntegrationConnectionRows: View {
    @ObservedObject var model: ConnectionsModel
    public init(model: ConnectionsModel) { self.model = model }
    public var body: some View {
        GithubConnectionRow(status: model.github, busy: model.githubBusy, error: model.githubProblem) { model.act(github: $0) }
        ZoteroConnectionRow(status: model.zotero, busy: model.zoteroBusy, error: model.zoteroProblem) { model.act(zotero: $0) }
    }
}

/// The note under a row (12.5, grey or red), wrapping anywhere.
struct RowNote: View {
    let text: String
    var red = false
    var body: some View {
        Text(text).textStyle(paneText(12.5)).foregroundStyle(Color(red ? Palette.del : Palette.fnt)).padding(.top, 4).fixedSize(horizontal: false, vertical: true)
    }
}

/// A row as SettingsRow lays it out, with a label view (GitHub's carries its device code).
struct ConnectionRowLayout<Label: View, Hint: View, Detail: View, Control: View>: View {
    let icon: Icon
    @ViewBuilder let label: Label
    @ViewBuilder let hint: Hint
    @ViewBuilder let detail: Detail
    @ViewBuilder let control: Control
    var body: some View {
        HStack(spacing: 10) {
            IconView(icon, size: 18).foregroundStyle(Color(Palette.mut)).frame(width: 18, height: 18).padding(.trailing, 2)
            VStack(alignment: .leading, spacing: 1) {
                label.textStyle(paneText(13.5, 500)).foregroundStyle(Color(Palette.ink))
                hint.textStyle(paneText(12.5)).foregroundStyle(Color(Palette.fnt))
                detail
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control
        }
        .padding(.vertical, 10).padding(.horizontal, SettingsMetrics.pad)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
    }
}

/// Connections.jsx GithubConnection.
public struct GithubConnectionRow: View {
    let status: GithubStatus?
    let busy: String?
    let error: String
    let onAction: (String) -> Void

    public init(status: GithubStatus?, busy: String?, error: String, onAction: @escaping (String) -> Void) {
        self.status = status; self.busy = busy; self.error = error; self.onAction = onAction
    }

    /// The row's words and button, as Connections.jsx derives them (also what the tests check).
    public static func describe(_ status: GithubStatus?, busy: String?, error: String) -> (description: String, connecting: Bool, action: String, label: String, disabled: Bool, problem: String) {
        let connected = status?.connected ?? false
        let pending = !connected && status?.pending != nil
        let problem = !error.isEmpty ? error : (status?.error ?? "")
        let connecting = busy == "connect" || (pending && (problem.isEmpty || busy != nil))
        let description: String
        if status == nil { description = "Checking connection…" }
        else if connected && busy == "disconnect" { description = "Disconnecting…" }
        else if connected { description = "Connected\(status!.login.isEmpty ? "" : " · @\(status!.login)")" }
        else if pending { description = "Waiting for sign-in…" }
        else if !status!.configured { description = "Not configured" }
        else { description = "Not connected" }
        let action = pending ? "cancel" : "connect"
        let label = (status?.error.isEmpty ?? true) ? "Connect" : "Reconnect"
        let disabled = busy != nil || status == nil || (!(status!.configured) && !connected && !pending)
        return (description, connecting, action, label, disabled, problem)
    }

    public var body: some View {
        let d = Self.describe(status, busy: busy, error: error)
        let connected = status?.connected ?? false
        let pending = connected ? nil : status?.pending
        ConnectionRowLayout(icon: KindIcons.gh) {
            HStack(spacing: 6) {
                Text("GitHub")
                if let code = pending?.userCode {
                    Button { onAction("copy") } label: { Text(code).font(Fonts.swiftUIMono(11)).foregroundStyle(Color(Palette.mut)) }
                        .buttonStyle(.plain).hover(.wash).help("Copy sign-in code").disabled(busy != nil)
                        .accessibilityIdentifier("connection-action=copy")
                }
            }
        } hint: {
            if !d.connecting { Text(d.description) }
        } detail: {
            if connected && status?.persisted == false { RowNote(text: "Connected until Engelbart quits.") }
            if let status, !status.configured && !connected { RowNote(text: "GitHub sign-in isn’t configured.") }
            if !d.connecting && !d.problem.isEmpty { RowNote(text: d.problem, red: true) }
        } control: {
            if connected {
                ConnectionActionsMenu(provider: "github", label: "GitHub", busy: busy, items: (status!.installUrl.isEmpty ? [] : [("manage", "Repository access", false)]) + [("disconnect", "Disconnect", !status!.installUrl.isEmpty)], onAction: onAction)
            } else if pending != nil {
                ConnectionProgress(label: "GitHub", active: d.problem.isEmpty || busy != nil, cancelling: busy == "cancel", disabled: d.disabled,
                                   onCancel: { onAction("cancel") }, onReopen: { onAction("reopen") }, reopenDisabled: busy != nil)
            } else {
                Button(busy == d.action ? (d.action == "connect" ? "Connecting…" : "Cancelling…") : d.label) { onAction(d.action) }
                    .buttonStyle(SettingsButtonStyle()).disabled(d.disabled).opacity(d.disabled ? 0.5 : 1)
                    .accessibilityIdentifier("connection-action=\(d.action)")
            }
        }
        .accessibilityIdentifier("connection=github")
    }
}

/// Connections.jsx ZoteroConnection, with the mirror's line (zoteroSyncLine).
public struct ZoteroConnectionRow: View {
    let status: ZoteroStatus?
    let busy: String?
    let error: String
    let onAction: (String) -> Void

    public init(status: ZoteroStatus?, busy: String?, error: String, onAction: @escaping (String) -> Void) {
        self.status = status; self.busy = busy; self.error = error; self.onAction = onAction
    }

    public static func describe(_ status: ZoteroStatus?, busy: String?) -> (description: String, spinning: Bool, disabled: Bool) {
        let connected = status?.connected ?? false
        let pending = !connected && status?.pending != nil
        let description: String
        if status == nil { description = "Checking connection…" }
        else if connected && busy == "disconnect" { description = "Disconnecting…" }
        else if connected { description = "Connected\(status!.username.isEmpty ? "" : " · \(status!.username)")" }
        else if pending { description = "Finish signing in in your browser" }
        else if busy == "connect" { description = "Connecting…" }
        else if !status!.configured { description = "Not configured" }
        else { description = "Not connected" }
        return (description, pending || busy == "connect" || (connected && busy == "disconnect"), busy != nil || status == nil || (!(status!.configured) && !connected))
    }

    public var body: some View {
        let d = Self.describe(status, busy: busy)
        let connected = status?.connected ?? false
        let pending = !connected && status?.pending != nil
        let problem = !error.isEmpty ? error : (status?.error ?? "")
        let library = connected && busy != "disconnect" ? ZoteroChips.syncLine(status?.sync) : nil
        ConnectionRowLayout(icon: IntegrationIcons.zotero) {
            Text("Zotero")
        } hint: {
            HStack(spacing: 6) { if d.spinning { ConnectionSpinner() }; Text(d.description) }
        } detail: {
            if let library {
                HStack(spacing: 6) { if library.busy { ConnectionSpinner() }; Text(library.text) }
                    .textStyle(paneText(12.5)).foregroundStyle(Color(library.error ? Palette.del : Palette.fnt)).padding(.top, 4)
                    .accessibilityIdentifier("zotero-sync=\(status?.sync?.state ?? "")")
                if !library.groups.isEmpty { RowNote(text: library.groups, red: true) }
            }
            if connected && status?.persisted == false { RowNote(text: "Connected until Engelbart quits.") }
            if !pending && !problem.isEmpty { RowNote(text: problem, red: true) }
        } control: {
            if connected {
                ConnectionActionsMenu(provider: "zotero", label: "Zotero", busy: busy, items: [("sync", "Sync now", false), ("disconnect", "Disconnect", true)], onAction: onAction)
            } else if pending {
                Button(busy == "cancel" ? "Cancelling…" : "Cancel") { onAction("cancel") }
                    .buttonStyle(SettingsButtonStyle()).disabled(busy != nil).opacity(busy != nil ? 0.5 : 1)
            } else {
                Button(busy == "connect" ? "Connecting…" : "Connect") { onAction("connect") }
                    .buttonStyle(SettingsButtonStyle()).disabled(d.disabled).opacity(d.disabled ? 0.5 : 1)
            }
        }
        .accessibilityIdentifier("connection=zotero")
    }
}

/// ConnectionActions.jsx ConnectionProgress: while a sign-in waits, a spinner with Connecting… (or Cancelling…), the
/// sign-in page again (↗), and cancel (×), each 24×24.
struct ConnectionProgress: View {
    let label: String
    var active = true
    var cancelling = false
    var disabled = false
    let onCancel: () -> Void
    let onReopen: () -> Void
    var reopenDisabled = false

    var body: some View {
        HStack(spacing: 4) {
            if active {
                HStack(spacing: 6) { ConnectionSpinner(size: 12); Text(cancelling ? "Cancelling…" : "Connecting…") }
                    .textStyle(paneText(11.5)).foregroundStyle(Color(Palette.fnt)).fixedSize()
            }
            Button(action: onReopen) { IconView(IntegrationIcons.reopen, size: 12).frame(width: 24, height: 24).contentShape(Rectangle()) }
                .buttonStyle(.plain).foregroundStyle(Color(Palette.mut)).hover(.wash, radius: 5).disabled(reopenDisabled).opacity(reopenDisabled ? 0.5 : 1)
                .help("Open sign-in in your browser").accessibilityLabel("Open \(label) sign-in in your browser").accessibilityIdentifier("connection-action=reopen")
            Button(action: onCancel) { IconView(IntegrationIcons.cancel, size: 12).frame(width: 24, height: 24).contentShape(Rectangle()) }
                .buttonStyle(.plain).foregroundStyle(Color(Palette.mut)).hover(.wash, radius: 5).disabled(disabled).opacity(disabled ? 0.5 : 1)
                .help("Cancel connection").accessibilityLabel("Cancel \(label) connection").accessibilityIdentifier("connection-action=cancel")
        }
    }
}

/// ConnectionActions.jsx: a 28×28 ⋯ that opens a menu of what can be done with the account (width 184, padding 4, 1px
/// #eaeaea, radius 6, shadow 0 4 16 #0000000a), a separator before an item that asks for one, 12.5px items 7×10.
/// The menu is a floating panel: Escape closes it, a click outside closes it, arrows move between items.
struct ConnectionActionsMenu: View {
    let provider: String
    let label: String
    let busy: String?
    let items: [(action: String, label: String, separator: Bool)]
    let onAction: (String) -> Void
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            IconView(IntegrationIcons.dots, size: 16).frame(width: 28, height: 28).contentShape(Rectangle())
                .background(RoundedRectangle(cornerRadius: 5).fill(open ? Color(Palette.hov) : .clear))
        }
        .buttonStyle(.plain).foregroundStyle(Color(Palette.mut)).hover(.wash, radius: 5)
        .disabled(busy != nil).opacity(busy != nil ? 0.5 : 1)
        .accessibilityLabel("\(label) connection options").accessibilityIdentifier("\(provider)-actions")
        .floatingPanel(isPresented: $open, options: FloatingOptions(side: .below, gap: 4, align: .end, width: 184)) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    if item.separator { Rectangle().fill(Color(Palette.bd)).frame(height: 1).padding(.vertical, 4) }
                    Button { open = false; if busy == nil { onAction(item.action) } } label: {
                        Text(item.label).textStyle(paneText(12.5)).foregroundStyle(Color(Palette.ink))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 7).padding(.horizontal, 10).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).hover(.wash, radius: 5).disabled(busy != nil)
                    .accessibilityIdentifier("connection-action=\(item.action)")
                }
            }
            .padding(4)
            .frame(width: 184)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(Palette.bd), lineWidth: 1))
            .shadow(color: .black.opacity(0x0a / 255.0), radius: 8, x: 0, y: 4)
            .accessibilityIdentifier("\(provider)-actions-menu")
        }
    }
}
