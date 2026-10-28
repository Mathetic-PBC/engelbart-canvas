import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// src/renderer/workspace/GithubPane.jsx (the + menu's GitHub view, 2026-09-22) and GithubRepos.jsx (Connect's and
// onboarding's picker, 2026-09-28): signing in in the default browser, then the repositories the App can read with a
// search, the organizations it is missing (MATH-111) and the App's install page. The list is read again whenever the app
// comes back to the front (an install on GitHub may have added some).

@MainActor
public final class GithubPaneModel: ObservableObject {
    @Published public private(set) var status: GithubStatus?
    @Published public private(set) var starting = false
    @Published public var problem = ""
    /// nil while it loads.
    @Published public private(set) var list: GithubRepoList?
    @Published public var query = ""
    @Published public var index = 0

    let channels: GithubChannels
    private var token: EventHub.Token?
    private var active: NSObjectProtocol?
    private var started = false
    private let hub: EventHub

    public init(channels: GithubChannels, hub: EventHub = .shared) {
        self.channels = channels
        self.hub = hub
        status = channels.status()
        token = hub.on("engelbart:github") { [weak self] _ in MainActor.assumeIsolated { self?.statusChanged() } }
        active = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.status?.connected == true { self?.load() } }
        }
        if status?.connected == true { load() }
    }

    deinit {
        if let token { hub.off(token) }
        if let active { NotificationCenter.default.removeObserver(active) }
    }

    private func statusChanged() {
        let was = status?.connected ?? false
        status = channels.status()
        if status?.connected == true && !was { load() }
        if status?.connected != true { list = nil }
    }

    public var connected: Bool { status?.connected ?? false }
    public var pending: GithubPending? { connected ? nil : status?.pending }
    public var error: String { !problem.isEmpty ? problem : (status?.error ?? "") }

    /// Opening the view signed out is asking to sign in: it starts once, at once (GithubPane.jsx only).
    public func startOnce() {
        guard !started, let status else { return }
        started = true
        if !status.connected && status.pending == nil && status.configured { connect() }
    }

    public func connect() {
        starting = true
        problem = ""
        Task { @MainActor in
            do { status = try await channels.connect() } catch { problem = error.localizedDescription }
            starting = false
        }
    }

    public func cancel() { do { status = try channels.cancel() } catch { problem = error.localizedDescription } }
    public func signOut() { do { status = try channels.disconnect() } catch { problem = error.localizedDescription } }

    public func open(_ which: String, page: String? = nil) {
        Task { @MainActor in do { try await channels.open(which, page: page) } catch { problem = error.localizedDescription } }
    }

    public func load() {
        Task { @MainActor in
            do { list = try await channels.repos(); problem = "" } catch { list = GithubRepoList(repos: [], accounts: [], missingOrgs: []); problem = error.localizedDescription }
        }
    }

    /// The App's repositories that match, then one typed or pasted in by its name or address.
    public func rows(library: [GithubLibraryRow], inRail: (String) -> Bool) -> [GithubRow] {
        guard connected, let list else { return [] }
        let listed = GithubModel.rows(repos: list.repos, query: query, library: library, inRail: inRail)
        if let typed = GithubModel.typedRepo(query: query, rows: listed, library: library, inRail: inRail) { return listed + [typed] }
        return listed
    }
}

/// The + menu's GitHub view. `onPick` adds or links the row picked; `onBack` returns to the menu.
public struct GithubPaneView: View {
    @ObservedObject var model: GithubPaneModel
    let library: [GithubLibraryRow]
    let inRail: (String) -> Bool
    let busy: Bool
    let onBack: () -> Void
    let onPick: (GithubRow) -> Void
    @FocusState private var fieldFocused: Bool

    public init(model: GithubPaneModel, library: [GithubLibraryRow], inRail: @escaping (String) -> Bool, busy: Bool, onBack: @escaping () -> Void, onPick: @escaping (GithubRow) -> Void) {
        self.model = model; self.library = library; self.inRail = inRail; self.busy = busy; self.onBack = onBack; self.onPick = onPick
    }

    public var body: some View {
        let rows = model.rows(library: library, inRail: inRail)
        let at = rows.isEmpty ? -1 : min(model.index, rows.count - 1)
        VStack(alignment: .leading, spacing: 0) {
            head
            if let status = model.status {
                if !status.configured {
                    Text(model.problem.isEmpty ? "GitHub is not set up: put the GitHub App’s client id in ~/.engelbart/config.json (github.clientId)." : model.problem)
                        .textStyle(paneText(12)).foregroundStyle(Color(Palette.del)).fixedSize(horizontal: false, vertical: true)
                } else if !model.connected {
                    signIn
                } else {
                    repos(rows, at: at)
                }
            }
        }
        .onAppear { model.startOnce() }
        .onChange(of: model.connected) { _, on in if on { DispatchQueue.main.async { fieldFocused = true } } }
        .accessibilityIdentifier("github-pane=\(model.connected ? "repos" : model.pending != nil ? "code" : "signed-out")")
    }

    private var head: some View {
        HStack(spacing: 8) {
            Button(action: onBack) { Text("‹").textStyle(TextStyle(16, lineHeight: 1)).foregroundStyle(Color(Palette.fnt)).frame(width: 18) }
                .buttonStyle(.plain).hover(.ink).accessibilityLabel("Back").accessibilityIdentifier("github-back")
            IconView(KindIcons.gh, size: 14).frame(width: 16, height: 16).foregroundStyle(Color(Palette.ink))
            Text(model.connected ? model.status!.login : "GitHub").textStyle(paneText(13, 500)).foregroundStyle(Color(Palette.ink)).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if model.connected {
                Button("Sign out") { model.signOut() }.buttonStyle(.plain).textStyle(paneText(12)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                    .accessibilityIdentifier("github-signout")
            }
        }
        .padding(.bottom, 10)
    }

    @ViewBuilder private var signIn: some View {
        if let pending = model.pending {
            VStack(alignment: .leading, spacing: 8) {
                Text("Finish signing in with GitHub in your browser. Engelbart will return automatically.").textStyle(paneText(12)).foregroundStyle(Color(Palette.ink))
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("github-waiting")
                if let code = pending.userCode {
                    HStack(spacing: 6) {
                        Text(code).font(Fonts.swiftUIMono(12)).textSelection(.enabled)
                        Button("Copy code") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string) }.buttonStyle(.plain).textStyle(paneText(12))
                    }
                }
                HStack(spacing: 14) {
                    Button("Open browser again") { model.open("device") }.buttonStyle(.plain).textStyle(paneText(12, 500)).foregroundStyle(Color(Palette.ink))
                        .accessibilityIdentifier("github-window")
                    Button("Cancel") { model.cancel() }.buttonStyle(.plain).textStyle(paneText(12)).foregroundStyle(Color(Palette.fnt)).accessibilityIdentifier("github-cancel")
                }
            }
        } else {
            Button { model.connect() } label: {
                HStack(spacing: 8) { IconView(KindIcons.gh, size: 14).frame(width: 16, height: 16); Text("Sign in with GitHub") }
                    .textStyle(paneText(12.5, 500)).foregroundStyle(Color(Palette.onAcc))
                    .frame(maxWidth: .infinity).padding(.vertical, 9).padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.ink)))
            }
            .buttonStyle(.plain).hover(.dim).disabled(model.starting).opacity(model.starting ? 0.6 : 1).accessibilityIdentifier("github-signin")
        }
        if !model.error.isEmpty {
            Text(model.error).textStyle(paneText(12)).foregroundStyle(Color(Palette.del)).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("github-error")
        }
    }

    @ViewBuilder private func repos(_ rows: [GithubRow], at: Int) -> some View {
        HStack(spacing: 8) {
            IconView(IntegrationIcons.search, size: 14).foregroundStyle(Color(Palette.ink))
            TextField("Search or paste a repo", text: $model.query)
                .textFieldStyle(.plain).textStyle(paneText(13)).focused($fieldFocused).disabled(busy).opacity(busy ? 0.5 : 1)
                .onChange(of: model.query) { _, _ in model.index = 0 }
                .onKeyPress(.downArrow) { if !rows.isEmpty { model.index = (at + 1) % rows.count }; return .handled }
                .onKeyPress(.upArrow) { if !rows.isEmpty { model.index = (at - 1 + rows.count) % rows.count }; return .handled }
                .onKeyPress(.return) { if at >= 0 && !busy { onPick(rows[at]) }; return .handled }
                .onKeyPress(.escape) { onBack(); return .handled }
                .accessibilityIdentifier("github-search")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.tint)))
        .hoverBorder(radius: 6, rest: Palette.bd, focused: fieldFocused)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if model.list == nil { Text("…").textStyle(paneText(13)).foregroundStyle(Color(Palette.fnt)).padding(.vertical, 8).padding(.horizontal, 10) }
                ForEach(Array(rows.enumerated()), id: \.offset) { i, entry in
                    Button { if !busy { onPick(entry) } } label: {
                        HStack(spacing: 8) {
                            IconView(KindIcons.gh, size: 13).frame(width: 16, height: 16).foregroundStyle(Color(Palette.mut))
                            HStack(spacing: 6) {
                                (Text("\(entry.repo.owner)/").foregroundStyle(Color(Palette.fnt)) + Text(String(entry.repo.fullName.dropFirst(entry.repo.owner.count + 1))).foregroundStyle(Color(Palette.ink)))
                                    .textStyle(paneText(13)).lineLimit(1).truncationMode(.tail)
                                // The lock right after the name (2026-10-12), as in the picker.
                                if entry.repo.isPrivate { IconView(IntegrationIcons.lock, size: 11).foregroundStyle(Color(Palette.fnt)).accessibilityLabel("Private") }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            if entry.typed && !entry.here { Text("Add").textStyle(paneText(12)).foregroundStyle(Color(Palette.fnt)) }
                            if entry.here { Text("HERE").textStyle(TextStyle(9, weight: 500, lineHeight: 1, tracking: 1.2)).foregroundStyle(Color(Palette.fnt)) }
                        }
                        .padding(.vertical, 7).padding(.horizontal, 10)
                        .background(RoundedRectangle(cornerRadius: 6).fill(i == at ? Color(Palette.hov) : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(busy)
                    .onHover { if $0 && model.index != i { model.index = i } }
                    .help(entry.repo.description.isEmpty ? entry.repo.fullName : entry.repo.description)
                    .accessibilityIdentifier("github-repo=\(entry.repo.fullName)")
                }
            }
        }
        .frame(maxHeight: 340).padding(.horizontal, -4).padding(.top, 6)
        if let status = model.status, !status.installUrl.isEmpty {
            Button { model.open("install") } label: {
                HStack(spacing: 10) {
                    Text("+").textStyle(TextStyle(13, weight: 500, lineHeight: 1)).frame(width: 16)
                    Text("Choose repositories in browser…").textStyle(paneText(13))
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 7).padding(.horizontal, 8).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Color(Palette.fnt)).hover(.inkWash).padding(.top, 4).accessibilityIdentifier("github-install")
            if let missing = model.list?.missingOrgs, !missing.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(missing, id: \.login) { org in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            HStack(spacing: 8) {
                                Text(org.login).textStyle(paneText(13)).foregroundStyle(Color(Palette.ink))
                                if !org.repos.isEmpty { Text(GithubModel.reposOnMac(org.repos.count)).textStyle(paneText(12)).foregroundStyle(Color(Palette.fnt)) }
                            }
                            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                            Button("Add on GitHub") { model.open("install", page: org.installUrl) }.buttonStyle(.plain).textStyle(paneText(12, 500)).foregroundStyle(Color(Palette.ink)).hover(.ink)
                                .accessibilityIdentifier("github-add-org=\(org.login)")
                        }
                        .padding(.vertical, 5).padding(.horizontal, 8)
                    }
                    Text("An organization’s owner has to approve it.").textStyle(paneText(11.5)).foregroundStyle(Color(Palette.fnt)).padding(.horizontal, 8)
                }
                .padding(.top, 2).accessibilityIdentifier("github-missing")
            }
        }
        if model.status?.installHint == true {
            Text("On GitHub, pick each organization you work in and its repositories.").textStyle(paneText(12)).foregroundStyle(Color(Palette.mut)).padding(.top, 6)
                .accessibilityIdentifier("github-install-hint")
        }
        if !model.error.isEmpty { Text(model.error).textStyle(paneText(12)).foregroundStyle(Color(Palette.del)).padding(.top, 6) }
        if model.status?.persisted == false {
            Text("Signed in until Engelbart quits: no keychain.").textStyle(paneText(11.5)).foregroundStyle(Color(Palette.fnt)).padding(.top, 6)
        }
    }
}

/// GithubRepos.jsx: the picker of Connect and onboarding, a box per repository. `held(repo)` says whether one is ticked,
/// `onToggle(repo)` ticks or unticks it, `busyId` the one being added or removed. Fills its parent's height.
public struct GithubReposView: View {
    @ObservedObject var model: GithubPaneModel
    let held: (GithubRepo) -> Bool
    let onToggle: (GithubRepo) -> Void
    let busyId: String?
    @State private var query = ""

    public init(model: GithubPaneModel, held: @escaping (GithubRepo) -> Bool, onToggle: @escaping (GithubRepo) -> Void, busyId: String?) {
        self.model = model; self.held = held; self.onToggle = onToggle; self.busyId = busyId
    }

    public var body: some View {
        Group {
            if let status = model.status {
                if !status.configured {
                    Text(model.problem.isEmpty ? "GitHub is not set up in this build." : model.problem).textStyle(TextStyle(13, lineHeight: 1.6)).foregroundStyle(Color(Palette.del))
                        .multilineTextAlignment(.center).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if !model.connected && (model.pending != nil || model.starting) {
                    VStack(spacing: 14) {
                        ThinkingDots(label: "waiting for GitHub")
                        if model.pending != nil {
                            HStack(spacing: 14) {
                                Button("Open browser again") { model.open("device") }.buttonStyle(.plain).textStyle(TextStyle(12.5, lineHeight: 1)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                                Button("Cancel") { model.cancel() }.buttonStyle(.plain).textStyle(TextStyle(12.5, lineHeight: 1)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                                    .accessibilityIdentifier("github-cancel")
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity).rise(0.22).accessibilityIdentifier("github-pane=code")
                } else if !model.connected {
                    VStack(spacing: 14) {
                        Text("Sign in to choose which repositories Engelbart can read.").textStyle(TextStyle(13.5, lineHeight: 1.6)).foregroundStyle(Color(Palette.mut))
                            .multilineTextAlignment(.center).frame(maxWidth: 300)
                        EButton(.filled, action: { model.connect() }) { Text("Sign in with GitHub") }.accessibilityIdentifier("github-signin")
                        if !model.error.isEmpty { Text(model.error).textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.del)) }
                    }
                    .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).rise(0.22).accessibilityIdentifier("github-pane=signed-out")
                } else {
                    picker
                }
            } else {
                Color.clear
            }
        }
    }

    private var picker: some View {
        let rows = GithubModel.filter(model.list?.repos ?? [], query: query)
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconView(SettingsIcons.search, size: 14).foregroundStyle(Color(Palette.fnt))
                TextField("search repositories…", text: $query).textFieldStyle(.plain).textStyle(TextStyle(13.5, lineHeight: 1.4)).accessibilityIdentifier("github-search")
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white)).hoverBorder(radius: 8, rest: Palette.bd)
            .padding(.top, 10).padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.list == nil { Text("…").font(Fonts.swiftUISans(13).italic()).foregroundStyle(Color(Palette.fnt)).padding(10) }
                    ForEach(rows, id: \.fullName) { repo in RepoRow(repo: repo, on: held(repo), busy: busyId != nil && busyId == repo.id, onToggle: onToggle) }
                    if model.list != nil && rows.isEmpty { Text("no repositories match…").font(Fonts.swiftUISans(13).italic()).foregroundStyle(Color(Palette.fnt)).padding(10) }
                    if let status = model.status, !status.installUrl.isEmpty, let missing = model.list?.missingOrgs, !missing.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(missing, id: \.login) { org in
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    HStack(spacing: 8) {
                                        Text(org.login).textStyle(TextStyle(13.5, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                                        if !org.repos.isEmpty { Text(GithubModel.reposOnMac(org.repos.count)).textStyle(TextStyle(12.5, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)) }
                                    }
                                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                    Button("Add on GitHub") { model.open("install", page: org.installUrl) }.buttonStyle(.plain).textStyle(TextStyle(12.5, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                                }
                                .padding(.vertical, 7).padding(.horizontal, 10)
                            }
                            Text("An organization’s owner has to approve it.").textStyle(TextStyle(12, lineHeight: 1.5)).foregroundStyle(Color(Palette.fnt)).padding(.horizontal, 10)
                        }
                        .padding(.top, 6)
                    }
                    if model.status?.installHint == true {
                        Text("On GitHub, pick each organization you work in and its repositories.").textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.mut)).padding(.vertical, 6).padding(.horizontal, 10)
                    }
                    if !model.error.isEmpty { Text(model.error).textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.del)).padding(.vertical, 6).padding(.horizontal, 10) }
                }
                .padding(.bottom, 4)
            }
            .padding(.horizontal, -10)
        }
        .rise(0.22)
        .accessibilityIdentifier("github-pane=repos")
    }
}

/// One repository of the picker: a box on the right, empty until picked (2026-10-12), the private lock right after the name.
public struct RepoRow: View {
    let repo: GithubRepo
    let on: Bool
    let busy: Bool
    let onToggle: (GithubRepo) -> Void

    public init(repo: GithubRepo, on: Bool, busy: Bool, onToggle: @escaping (GithubRepo) -> Void) {
        self.repo = repo; self.on = on; self.busy = busy; self.onToggle = onToggle
    }

    public var body: some View {
        Button { onToggle(repo) } label: {
            HStack(spacing: 10) {
                IconView(KindIcons.gh, size: 14).frame(width: 14, height: 14).foregroundStyle(Color(Palette.fnt))
                HStack(spacing: 6) {
                    (Text("\(repo.owner)/").foregroundStyle(Color(Palette.fnt)) + Text(String(repo.fullName.dropFirst(repo.owner.count + 1))).foregroundStyle(Color(Palette.ink)))
                        .textStyle(TextStyle(13.5, lineHeight: 1.4)).lineLimit(1).truncationMode(.tail)
                    if repo.isPrivate { IconView(IntegrationIcons.lock, size: 12).foregroundStyle(Color(Palette.fnt)).opacity(0.8).accessibilityLabel("private") }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ZStack {
                    RoundedRectangle(cornerRadius: 4).fill(on ? Color(Palette.ink) : Color.white)
                    if !on { RoundedRectangle(cornerRadius: 4).strokeBorder(Color(Palette.bd2), lineWidth: 1.5) }
                    if on { Text("✓").textStyle(TextStyle(10, weight: 600, lineHeight: 1)).foregroundStyle(Color.white) }
                }
                .frame(width: 16, height: 16)
                .accessibilityIdentifier("github-repo-box=\(on ? "on" : "off")")
            }
            .padding(.vertical, 7).padding(.horizontal, 10).contentShape(Rectangle())
        }
        .buttonStyle(.plain).hover(.inkWash).disabled(busy)
        .help(repo.description.isEmpty ? repo.fullName : repo.description)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("github-repo=\(repo.fullName)")
    }
}
