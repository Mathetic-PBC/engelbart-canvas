import AppKit
import SwiftUI
import EngelbartCore
import EngelbartConnect
import EngelbartUI

// Connect your library's screen (src/renderer/screens/ConnectLibrary.jsx): the choose screen (sources by group, the
// consent, the Refine chip or "Bring these in"), the chat with the librarian (its cards), and the working view; the
// modals over them (Keychain, folders, the sign-in gate). Inline styles as the JSX has them (1 CSS px = 1 pt).
// Identifiers: `data-connect-app="Obsidian"` → `connect-app=Obsidian`, etc.

/// The screen with its own model, started when it appears and stopped when it goes.
public struct ConnectLibraryHost: View {
    @StateObject var model: ConnectLibraryModel
    public init(api: ImportAPI, context: ConnectLibraryContext, openSessions: OpenSessions? = nil) {
        _model = StateObject(wrappedValue: ConnectLibraryModel(api: api, context: context, openSessions: openSessions))
    }
    public var body: some View {
        ConnectLibraryView(model: model)
            .task { await model.start() }
            .onDisappear { model.stop() }
    }
}

private let labelColor: [String: String] = ["muted": "#c9c9c9", "busy": "#a35200", "error": "#e70022", "": "#8f8f8f"]
private let ease = Animation.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.14)

public struct ConnectLibraryView: View {
    @ObservedObject var model: ConnectLibraryModel
    public init(model: ConnectLibraryModel) { self.model = model }

    var popup: Bool { model.popup }
    var wide: Bool { model.view != "choose" }

    public var body: some View {
        ZStack {
            content
            modals
        }
        .driveID("connect-library=\(model.view)")
    }

    @ViewBuilder var content: some View {
        let inner = VStack(spacing: 0) {
            switch model.view {
            case "choose" where model.picks != nil: chooseView
            case "chat" where model.session != nil: chatView
            case "working" where model.session != nil: if popup { workingPopup } else { workingPage }
            default: Color.clear.frame(minHeight: 200).driveID("connect-library=loading")
            }
        }
        if popup {
            inner.frame(width: wide ? 640 : 560).frame(maxHeight: wide ? 700 : 760)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(IX.line2, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .shadow(color: Color.black.opacity(0x1f / 255), radius: 20, x: 0, y: 12)
                .rise(0.16)
        } else {
            inner.frame(maxWidth: 1080).background(Color.white)
        }
    }

    // MARK: pieces

    func header(_ title: String, back: Bool = false, lead: AnyView? = nil) -> some View {
        HStack(spacing: 8) {
            if back { iconButton(SVG.back, "Back", id: "connect-back") { Task { await model.back() } } }
            if let lead { lead }
            Text(title).font(IX.font(15, 500)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
            if model.session != nil && (model.done || J.truthy(model.session?["finished"])) { iconButton(SVG.minus, "Run in the background", id: "connect-minimize") { model.putAway() } }
            if popup { iconButton(SVG.close, model.session != nil ? "Close: it goes on in the background" : "Not now", id: "connect-close") { model.close() } }
        }
        .padding(back ? EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12) : EdgeInsets(top: 16, leading: 20, bottom: 10, trailing: 14))
    }

    func iconButton(_ svg: String, _ tip: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Glyph(svg, size: 16, width: 1.5).foregroundStyle(IX.body).frame(width: 28, height: 28).contentShape(Rectangle()) }
            .buttonStyle(.plain).hover(.wash, radius: 6).help(tip).driveID(id)
    }

    // MARK: the choose screen

    var chooseView: some View {
        Group {
            if popup {
                VStack(spacing: 0) {
                    header("What should go in your library?")
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            sourcesList
                            if !model.ready { agentCard }
                            permissionsBox
                        }
                        .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 16)
                    }
                    HStack(spacing: 12) {
                        if !model.error.isEmpty { Text(model.error).font(IX.font(12.5, 400)).foregroundStyle(IX.red).frame(maxWidth: .infinity, alignment: .leading).driveID("connect-error") }
                        Spacer(minLength: 0)
                        ProviderChip(model: model, lead: "Refine with", provider: model.provider, sendOn: model.anyOn && model.provider != nil, sendLabel: "Refine") { Task { await model.bringIn() } }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 12)
                }
            } else {
                let go = model.anyOn && model.provider != nil
                VStack(spacing: 0) {
                    Text("What should go in your library?").font(IX.font(28, 500)).tracking(-0.4).foregroundStyle(IX.ink).padding(.top, 40).padding(.bottom, 22)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            sourcesList
                            consentCard.padding(.top, 10).driveID("connect-consent-at=after-code")
                            if !model.ready { agentCard.padding(.top, 18) }
                        }
                        .padding(.horizontal, 8).padding(.bottom, 16)
                    }
                    .driveID("connect-sources-box")
                    if !model.error.isEmpty { Text(model.error).font(IX.font(12.5, 400)).foregroundStyle(IX.red).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10).padding(.horizontal, 8).driveID("connect-error") }
                    Foot(pager: model.context.pager) {
                        Button(action: { model.context.onSkip() }) { Text("Skip for now").font(IX.font(13, 500)).foregroundStyle(IX.mute).padding(.vertical, 10) }.buttonStyle(.plain).driveID("onboarding-skip")
                    } button: {
                        FootButton(title: "Bring these in", caret: true, quiet: false) { if go { Task { await model.bringIn() } } }.opacity(go ? 1 : 0.4).driveID("connect-bring")
                    }
                }
                .frame(maxWidth: 600)
            }
        }
    }

    var sourcesList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("Sources").font(IX.font(12.5, 400)).foregroundStyle(IX.mute)
                Text("▾").font(IX.font(9, 400)).foregroundStyle(IX.mute)
                Spacer()
                HStack(spacing: 4) { Text("From").font(IX.font(12.5, 400)).foregroundStyle(IX.mute); PeriodPick(days: $model.days) }.padding(.trailing, 8)
                TextLink(model.allOn ? "Clear" : "Select all", id: "connect-all") { model.toggleAll(!model.allOn) }
            }
            .frame(height: 28).padding(.horizontal, 8)
            ForEach(ConnectModel.sources, id: \.id) { source in group(source) }
        }
        .padding(.horizontal, -8)
    }

    func group(_ source: SourceGroup) -> some View {
        let state = ConnectModel.groupState(model.picks, source.id)
        let open = model.picks?.open[source.id] ?? false
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button(action: { model.expand(source.id) }) {
                    HStack(spacing: 8) {
                        Glyph(SVG.caretRight, size: 12, width: 2).foregroundStyle(IX.mute).rotationEffect(.degrees(open ? 90 : 0)).frame(width: 12)
                        Text(source.label).font(IX.font(13.5, 400)).foregroundStyle(IX.ink)
                        Spacer()
                    }
                    .frame(maxHeight: .infinity).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Box(on: state == "all", some: state == "some").onTapGesture { model.toggleGroup(source.id) }.driveID("connect-group-box=\(source.id)")
            }
            .padding(.leading, 4).padding(.trailing, 8).frame(height: 34)
            .hover(.wash, radius: 6)
            .driveID("connect-source=\(source.id)")
            if open {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(source.apps, id: \.self) { app in
                        AppRow(model: model, id: source.id, app: app)
                    }
                    if source.id == "sites" {
                        let sites = model.found?["sites"]
                        AppRow(model: model, id: "sites", app: ConnectModel.browserRow, icon: SVG.globe,
                               label: J.truthy(sites?["found"]) ? RowLabel(text: J.str(sites?["where"]), tone: "") : RowLabel(text: "Not found", tone: "muted"))
                    }
                    if source.id == "papers" {
                        if let dir = model.folders["papers"]?.first { FolderRow(path: dir) { model.folders["papers"] = [] } }
                        else { AddRow(label: "Select a folder of papers…", hint: "optional", id: "papers-folder") { Task { await model.pickPapers() } } }
                    }
                    if source.id == "code" { codeRows }
                }
                .padding(.leading, 26).padding(.top, 1).padding(.bottom, 6)
                .overlay(alignment: .topLeading) { Rectangle().fill(IX.line).frame(width: 1).padding(.top, 2).padding(.bottom, 8).offset(x: 33) }
            }
        }
    }

    @ViewBuilder var codeRows: some View {
        ExpandRow(name: "GitHub", on: ConnectModel.ticked(model.picks, "code", "GitHub"), some: false, open: model.openRows["GitHub"] ?? false, label: model.githubLabel, icon: nil,
                  onOpen: { model.openRows["GitHub", default: false].toggle() }, onToggle: { Task { await model.githubToggle() } })
        if model.openRows["GitHub"] ?? false {
            githubList.frame(height: 320).padding(.leading, 34).padding(.trailing, 8).padding(.top, 2).padding(.bottom, 6).driveID("connect-github")
        }
        let repos = model.localRepos
        ExpandRow(name: ConnectModel.localRepos, on: model.reposAll > 0 && model.reposOn == model.reposAll, some: model.reposOn > 0 && model.reposOn < model.reposAll,
                  open: model.openRows[ConnectModel.localRepos] ?? false,
                  label: repos.isEmpty ? RowLabel(text: "Not found", tone: "muted") : RowLabel(text: "\(repos.count) on this Mac", tone: ""), icon: SVG.folder,
                  onOpen: { model.openRows[ConnectModel.localRepos, default: false].toggle() }, onToggle: { Task { await model.toggleLocal() } })
        if model.openRows[ConnectModel.localRepos] ?? false {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(repos, id: \.self) { repo in
                    let path = J.str(repo["path"])
                    let sessions = J.int(repo["sessions"])
                    AppRow(model: model, id: "code", app: J.str(repo["name"]), icon: SVG.folder, label: RowLabel(text: "", tone: ""),
                           tip: "\(J.str(repo["shown"])) · \(sessions) session\(sessions == 1 ? "" : "s")\(J.truthy(repo["checked"]) ? "" : " · checked when you continue")",
                           data: "repo:\(path)", on: model.picks?.local[path] ?? false) { model.toggleLocalRepo(path) }
                }
                ForEach(model.extraRepos, id: \.self) { dir in FolderRow(path: dir) { model.dropRepo(dir) } }
                AddRow(label: "Select a folder…", hint: "a repository", id: "code-folder") { Task { await model.pickRepo() } }
            }
            .padding(.leading, 16).driveID("connect-local-repos")
        }
    }

    @ViewBuilder var githubList: some View {
        if let slot = model.context.githubRepos {
            slot({ model.heldRepo($0) != nil }, { repo in Task { await model.toggleRepo(repo) } }, model.busyRepo)
        } else {
            GithubFallbackList(model: model)
        }
    }

    var reassure: some View {
        (Text("Saved only on your Mac. \(model.targetName) reads them through your account, and Mathetic never sees them. ").foregroundColor(IX.mute))
            .font(IX.font(12.5, 400))
    }

    var leavesText: some View {
        let company = J.str(model.current?["provider"]) == "openai" ? "OpenAI" : "Anthropic"
        return Text("What the agents read is sent to \(company) through your own \(model.targetName) account, the way any \(model.targetName) session is, to be turned into notes. The notes, and everything Engelbart keeps, stay in ~/.engelbart on this Mac. Nothing goes to Mathetic.")
            .font(IX.font(12.5, 400)).foregroundStyle(IX.mute).fixedSize(horizontal: false, vertical: true).driveID("connect-leaves-text")
    }

    var leavesButton: some View {
        Button(action: { model.leaves.toggle() }) { Text("What leaves my Mac?").font(IX.font(12.5, 500)).foregroundStyle(IX.ink) }.buttonStyle(.plain).driveID("connect-leaves")
    }

    /// The popup's consent: one checkbox (MATH-114), where everything is kept under it, in one #fafafa card.
    var permissionsBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.reads.isEmpty {
                HStack(alignment: .top, spacing: 10) {
                    Box(on: model.consent).padding(.top, 2.5)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Use my \(model.targetName) subscription to read these").font(IX.font(13.5, 500)).foregroundStyle(IX.ink)
                        HStack(alignment: .firstTextBaseline, spacing: 0) { reassure; leavesButton }
                    }
                }
                .contentShape(Rectangle()).onTapGesture { model.toggleConsent() }
                .driveID("connect-permission=consent")
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 0) { reassure; leavesButton }
            }
            if model.leaves { leavesText.padding(.leading, model.reads.isEmpty ? 0 : 24) }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 10).fill(IX.wash))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
        .driveID("connect-permissions")
    }

    /// Onboarding's page: the agent's logo, "Read with your [Claude Code ⌄] subscription", what that means, a switch.
    var consentCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                LogoImage(file: Logos.toolFile(J.str(model.current?["provider"]) == "openai" ? "Codex" : "Claude Code"), size: 16)
                    .frame(width: 32, height: 32).overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 0) {
                        Text("Read with your ").font(IX.font(13.5, 500)).foregroundStyle(IX.ink)
                        ProviderPick(model: model, up: true)
                        Text(" subscription").font(IX.font(13.5, 500)).foregroundStyle(IX.ink)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text("Uses the plan you already have, so there's no API key to set up. Saved only on your Mac, and Mathetic never receives it. ").font(IX.font(12.5, 400)).foregroundStyle(IX.mute)
                        leavesButton
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Toggle2(on: model.consent)
            }
            .contentShape(Rectangle()).onTapGesture { model.toggleConsent() }
            .driveID("connect-permission=consent")
            if model.leaves { leavesText.padding(.leading, 44) }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
        .driveID("connect-permissions")
    }

    /// Claude Code and Codex, when neither can run yet: install or sign in here.
    var agentCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let tools = model.toolSnap?["tools"] {
                Text("Sign in to Claude Code or Codex first").font(IX.font(13, 500)).foregroundStyle(IX.ink)
                Text("The agents that bring your library in run on one of them, with your own subscription.").font(IX.font(12.5, 400)).foregroundStyle(IX.body)
                ForEach(["claude", "codex"].filter { tools[$0] != nil }, id: \.self) { id in
                    let row = OnboardingHelpers.rowOf(tools[id]!)
                    HStack(spacing: 10) {
                        Text(row.name).font(IX.font(13, 400)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
                        Text(row.state).font(Fonts.swiftUIMono(12)).foregroundStyle(row.tone == "ok" ? IX.ink : IX.mute)
                        if let action = row.action {
                            Button(action: { Task { await model.toolAction(row) } }) {
                                Text(["install": "Install", "update": "Update", "sign-in": "Sign in", "retry": "Try again", "cancel": "Cancel"][action] ?? action)
                                    .font(IX.font(12.5, 500)).foregroundStyle(IX.ink).padding(.horizontal, 10).frame(height: 30)
                                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
                            }
                            .buttonStyle(.plain).driveID("tool-action=\(action)")
                        }
                    }
                    .padding(.vertical, 6).driveID("tool-row=\(id)")
                }
            } else {
                Text("Checking Claude Code and Codex…").font(IX.font(12.5, 400)).italic().foregroundStyle(IX.mute)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 10).fill(IX.wash))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
        .driveID("connect-agent-setup")
    }

    // MARK: the modals

    @ViewBuilder var modals: some View {
        if model.view == "choose" {
            if let panel = model.folderShown {
                FolderAccessModal(panel: panel, onContinue: { Task { await model.allowFolders() } }, onNotNow: { Task { await model.declineFolders() } })
            } else if let outcome = model.keychainOutcome {
                KeychainModal(panel: nil, outcome: outcome, chosen: nil, onContinue: {}, onNotNow: { model.keychainRun = nil }, onClose: { model.keychainRun = nil }, onChoose: { _ in })
            } else if let panel = model.asking {
                KeychainModal(panel: panel, outcome: nil, chosen: panel.chosen, onContinue: { Task { await model.allowSignIns(panel.browser) } },
                              onNotNow: { model.declineSignIns(panel.browser) }, onClose: { model.declineSignIns(panel.browser) }, onChoose: { model.profileChoice[panel.browser] = $0 })
            } else if let gate = model.gateView {
                SignInGateModal(gate: gate, signing: model.gate == "signing", waiting: model.inBrowser ?? "", canSignIn: model.gateCanSignIn,
                                onSignIn: { Task { await model.gateSignIn() } }, onLeave: { model.gateLeave() }, onClose: { model.gateClose() })
            }
        }
    }

    // MARK: the chat

    var chatView: some View {
        let session = model.session!
        let chat = model.chat
        return VStack(spacing: 0) {
            // A run opened over a workspace by its id (a manual import from Import your context) has no choose screen of its own.
            header("Refine with \(model.targetName)", back: model.context.onBack != nil || !(popup && model.context.sessionId != nil))
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !model.spoke && !J.truthy(session["error"]) && model.error.isEmpty && !chat.contains(where: { J.truthy($0["grant"]) }) { Starting(compact: false) }
                        ForEach(Array(chat.enumerated()), id: \.offset) { i, item in chatItem(i, item).id(i) }
                        NeedsCard(needs: model.needs, onOpen: { need in Task { await model.openNeed(need) } }, onSkip: { need in Task { await model.needSkip(need) } })
                        if model.spoke && !ConnectModel.chatStatus(session).isEmpty {
                            WaveText(ConnectModel.chatStatus(session), font: IX.font(13, 400)).driveID("connect-waiting")
                        }
                        let failure = J.str(session["error"]).isEmpty ? model.error : J.str(session["error"])
                        if !failure.isEmpty {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(failure + (!J.str(session["error"]).isEmpty && popup ? " Reply to try again." : "")).font(IX.font(12.5, 400)).foregroundStyle(IX.red)
                                if !J.str(session["error"]).isEmpty && !popup { TextLink("Try again", id: "connect-retry") { Task { await model.tryAgain() } } }
                            }
                            .driveID("connect-error")
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.vertical, 18).padding(.horizontal, popup ? 20 : 24)
                    .frame(maxWidth: popup ? .infinity : 760)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: chatKey) { _, _ in
                    // The chat follows its newest message from its top: to the end when it fits and has been answered, else
                    // to where the librarian's newest message begins.
                    let answered = chat.isEmpty || J.str(chat.last?["role"]) != "agent"
                    let newest = chat.lastIndex { J.str($0["role"]) == "agent" && !J.truthy($0["opener"]) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) {
                        withAnimation(nil) { if let newest, !answered { reader.scrollTo(newest, anchor: .top) } else { reader.scrollTo("end", anchor: .bottom) } }
                    }
                }
            }
            .driveID("connect-chat")
            if popup { replyBox } else {
                Foot(pager: model.context.pager) { FootStatus(session: session) } button: {
                    FootButton(title: "Finish in background", caret: false, quiet: !model.done) { Task { await model.finishInBackground() } }.driveID("connect-import")
                }
                .padding(.horizontal, 24).padding(.bottom, 4)
            }
        }
    }

    var chatKey: String { "\(model.chat.count)|\(J.truthy(model.session?["thinking"]))|\(model.view)|\(model.needs.count)" }

    @ViewBuilder func chatItem(_ i: Int, _ item: JSONValue) -> some View {
        if J.truthy(item["opener"]) { EmptyView() }
        else if let grant = item["grant"], J.truthy(grant) {
            VStack(alignment: .leading, spacing: 16) {
                GrantCard(grant: grant, live: !J.truthy(grant["answered"]) && !J.truthy(model.session?["finished"]) && !J.truthy(model.session?["stopped"])) { apps in await model.grantApps(apps) }
                if !model.spoke && !J.truthy(model.session?["error"]) && model.error.isEmpty { Starting(compact: true) }
            }
        } else if J.truthy(item["notice"]) {
            Text(J.str(item["text"])).font(IX.font(13, 400)).foregroundStyle(IX.mute).driveID("connect-notice")
        } else if J.str(item["role"]) != "agent" {
            HStack {
                Spacer(minLength: 0)
                Text(J.str(item["text"])).font(IX.font(14.5, 400)).foregroundStyle(IX.ink).lineSpacing(14.5 * 0.6 - 5)
                    .padding(.horizontal, 12).padding(.vertical, 8).background(RoundedRectangle(cornerRadius: 12).fill(hex("#f2f2f2")))
                    .frame(maxWidth: 520, alignment: .trailing)
            }
            .driveID("connect-user")
        } else {
            let live = model.live(i)
            VStack(alignment: .leading, spacing: 10) {
                if !J.str(item["text"]).isEmpty { Text(J.str(item["text"])).font(IX.font(14.5, 400)).foregroundStyle(IX.ink).lineSpacing(14.5 * 0.7 - 5).fixedSize(horizontal: false, vertical: true) }
                if let ask = item["ask"], J.truthy(ask) {
                    if live { askCard(ask, live: true) } else { AnsweredAsk(title: J.str(ask["title"])) { askCard(ask, live: false) } }
                }
                if let authorize = item["authorize"], J.truthy(authorize), live || i == model.last {
                    AuthorizeCard(authorize: authorize, live: live, busy: model.authorizing && live,
                                  onUse: { Task { await model.useAuthorize(authorize) } }, onSkip: { Task { await model.reply(["skipped": true]) } }, onCancel: { model.cancelAuthorize(authorize) })
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .driveID("connect-agent")
        }
    }

    @ViewBuilder func askCard(_ ask: JSONValue, live: Bool) -> some View {
        if J.str(ask["kind"]) == "repos" {
            ReposCard(model: model, ask: ask, live: live)
        } else {
            QuestionCard(ask: ask, live: live) { input in Task { await model.reply(input) } }
        }
    }

    var replyBox: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                TextField("Reply…", text: $model.draft, axis: .vertical).textFieldStyle(.plain).font(IX.font(15, 400)).foregroundStyle(IX.ink).lineLimit(1...6)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        Task { await model.sendDraft() }; return .handled
                    }
                    .driveID("connect-draft")
                ProviderChip(model: model, lead: "", provider: J.str(model.session?["provider"]).isEmpty ? model.provider : J.str(model.session?["provider"]),
                             sendOn: !model.draft.trimmingCharacters(in: .whitespaces).isEmpty && !J.truthy(model.session?["thinking"]), sendLabel: "Send") { Task { await model.sendDraft() } }
                    .padding(.top, -3)
            }
            .padding(.leading, 16).padding(.trailing, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 10).fill(IX.wash)).padding(.top, 8)
            HStack(spacing: 12) {
                Group { if model.chat.contains(where: { !J.truthy($0["opener"]) }) { WorkLineView(session: model.session!) } }.frame(maxWidth: .infinity, alignment: .leading)
                // "the import button should be in bottom right and should not be highlighted until the agent returns all questions have been asked"
                Button(action: { Task { await model.importNow() } }) {
                    HStack(spacing: 7) { Glyph(SVG.download, size: 14, width: 1.8); Text("Import") }
                        .font(IX.font(13, 500)).foregroundStyle(model.done ? Color.white : IX.mute)
                        .padding(.leading, 14).padding(.trailing, 16).frame(height: 34)
                        .background(RoundedRectangle(cornerRadius: 8).fill(model.done ? IX.blue : Color.white))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(model.done ? IX.blue : IX.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help(model.done ? "Bring in everything picked" : "The librarian still has questions; Import now uses sensible defaults for the rest")
                .driveID("connect-import")
            }
            .padding(.top, 10)
        }
        .padding(.horizontal, 16).padding(.bottom, 12)
    }

    // MARK: working

    var workingPage: some View {
        let session = model.session!
        let stopped = J.truthy(session["stopped"])
        let shown = ConnectModel.runningFirst(model.jobs.filter { J.str($0["kind"]) == "import" || !ConnectModel.statusOf($0).done })
        let line = ConnectModel.memoryLine(session["memory"])
        let saved = J.str(session["memory"]?["status"]) == "saved"
        return VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(stopped ? "Stopped" : model.going ? "Bringing everything in" : "Your library is connected").font(IX.font(22, 600)).tracking(-0.3).foregroundStyle(IX.ink)
                    Text(stopped ? "Everything was stopped. What came in stays in your library." : "Keeps going in the background. Your inbox says when it needs you or is done.").font(IX.font(13, 400)).foregroundStyle(IX.mute)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if model.going { TextLink("Stop all", size: 13, id: "connect-stop-all") { Task { await model.stopAll() } }.padding(.top, 4) }
            }
            .padding(.top, 40).padding(.horizontal, 12).padding(.bottom, 18)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.needs, id: \.self) { need in NeedCard(need: need, onOpen: { Task { await model.openNeed(need) } }, onSkip: { Task { await model.needSkip(need) } }) }
                    VStack(spacing: 0) {
                        ForEach(Array(shown.enumerated()), id: \.offset) { i, job in
                            if i > 0 { Rectangle().fill(hex("#f0f0f0")).frame(height: 1).padding(.horizontal, 12) }
                            PageJob(job: job) { Task { await model.stopJob(job) } }
                        }
                        if shown.isEmpty { Text("Nothing could be reached: sign in or allow it in the chat first.").font(IX.font(13, 400)).italic().foregroundStyle(IX.mute).padding(11).frame(maxWidth: .infinity, alignment: .leading) }
                    }
                    HStack(spacing: 12) {
                        Glyph(SVG.file, size: 14).foregroundStyle(IX.mute).frame(width: 16)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Summary of your library").font(IX.font(13.5, 500)).foregroundStyle(IX.ink)
                            Text(saved ? "Saved as MEMORY.md" : "Written once everything’s in").font(IX.font(12, 400)).foregroundStyle(IX.mute)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(line.done || (session["memory"] != nil && J.str(session["memory"]?["status"]) != "waiting" && J.truthy(session["memory"])) ? line.text : "Waiting")
                            .font(IX.font(12.5, 400)).foregroundStyle(line.failed ? IX.red : IX.mute)
                        if saved { TextLink("Show", id: "connect-memory-reveal") { model.revealMemory() } }
                        if J.str(session["memory"]?["status"]) == "failed" { TextLink("Try again", id: "connect-memory-retry") { Task { await model.retryMemory() } } }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(hex("#dcdcdc"), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
                    .driveID("connect-memory=\(J.str(session["memory"]?["status"]))")
                    if !model.error.isEmpty { Text(model.error).font(IX.font(12.5, 400)).foregroundStyle(IX.red).driveID("connect-error") }
                }
                .padding(.bottom, 16)
            }
            Foot(pager: model.context.pager) { EmptyView() } button: { FootButton(title: "Continue", caret: true, quiet: false) { model.putAway() }.driveID("connect-done") }
        }
        .frame(maxWidth: 600)
        .driveID("connect-progress")
    }

    var workingPopup: some View {
        let session = model.session!
        let stopped = J.truthy(session["stopped"])
        let line = ConnectModel.memoryLine(session["memory"])
        let busy = model.running > 0 || (J.truthy(session["memory"]) && !line.done) || !model.needs.isEmpty
        return VStack(spacing: 0) {
            header(stopped ? "Stopped" : model.going ? "Bringing everything in" : "Your library is connected",
                   lead: AnyView(Circle().fill(IX.ink).frame(width: 22, height: 22).overlay(Glyph(SVG.check, size: 12, width: 2.5).foregroundStyle(Color.white))))
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(stopped ? "Everything was stopped. What came in stays in your library." : "This keeps going in the background, and your Inbox says when it needs you or is done.").font(IX.font(12.5, 400)).foregroundStyle(IX.mute)
                    if !ConnectModel.placedLine(session).isEmpty { Text(ConnectModel.placedLine(session)).font(IX.font(12.5, 400)).foregroundStyle(IX.body).driveID("connect-placed") }
                    ForEach(model.needs, id: \.self) { need in NeedCard(need: need, onOpen: { Task { await model.openNeed(need) } }, onSkip: { Task { await model.needSkip(need) } }) }
                    VStack(spacing: 0) {
                        ForEach(Array(ConnectModel.runningFirst(model.jobs).enumerated()), id: \.offset) { _, job in JobRow(job: job) { Task { await model.stopJob(job) } } }
                        if model.jobs.isEmpty { Text("Nothing could be reached: sign in or allow it in the chat first.").font(IX.font(13, 400)).italic().foregroundStyle(IX.mute).padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading) }
                        HStack(spacing: 10) {
                            Glyph(SVG.file, size: 14).foregroundStyle(IX.mute).frame(width: 14)
                            Text("MEMORY.md").font(IX.font(13.5, 400)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
                            Text(line.text).font(IX.font(12.5, 400)).foregroundStyle(line.failed ? IX.red : line.done ? IX.ink : IX.mute)
                            if J.str(session["memory"]?["status"]) == "saved" { TextLink("Show", id: "connect-memory-reveal") { model.revealMemory() } }
                            if J.str(session["memory"]?["status"]) == "failed" { TextLink("Try again", id: "connect-memory-retry") { Task { await model.retryMemory() } } }
                        }
                        .padding(.vertical, 9).driveID("connect-memory=\(J.str(session["memory"]?["status"]))")
                    }
                    if !model.error.isEmpty { Text(model.error).font(IX.font(12.5, 400)).foregroundStyle(IX.red).driveID("connect-error") }
                }
                .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 16)
            }
            .driveID("connect-progress")
            HStack(spacing: 12) {
                if !stopped && (model.running > 0 || (J.truthy(session["memory"]) && !line.done)) {
                    Button(action: { Task { await model.stopAll() } }) {
                        Text("Stop all").font(IX.font(12.5, 500)).foregroundStyle(IX.ink).padding(.horizontal, 10).frame(height: 30)
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain).driveID("connect-stop-all")
                }
                Spacer()
                // "Run in background" while anything runs; once everything has ended, Done (2026-10-13).
                Button(action: { model.putAway() }) {
                    Text(busy ? "Run in background" : "Done").font(IX.font(13, 500)).foregroundStyle(Color.white).padding(.horizontal, 16).frame(height: 34)
                        .background(RoundedRectangle(cornerRadius: 8).fill(IX.ink))
                }
                .buttonStyle(.plain).driveID("connect-done")
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
        }
    }
}

// MARK: small pieces (ConnectLibrary.jsx)

enum SVG {
    static let caretRight = #"<path d="m9 18 6-6-6-6"/>"#
    static let caretDown = #"<path d="m6 9 6 6 6-6"/>"#
    static let plus = #"<path d="M5 12h14"/><path d="M12 5v14"/>"#
    static let folder = #"<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>"#
    static let arrowUp = #"<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>"#
    static let back = #"<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>"#
    static let download = #"<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>"#
    static let check = #"<path d="M20 6 9 17l-5-5"/>"#
    static let minus = #"<path d="M5 12h14"/>"#
    static let close = #"<path d="M18 6 6 18"/><path d="m6 6 12 12"/>"#
    static let file = #"<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13h4"/><path d="M10 17h4"/>"#
    static let globe = #"<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>"#
    static let key = #"<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>"#
    static let alert = #"<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>"#
}

/// A quiet text button (.bart-text: 12/500 #8f8f8f, ink on hover).
struct TextLink: View {
    let title: String
    var size: CGFloat = 12
    let id: String
    let action: () -> Void
    @State private var hovering = false
    init(_ title: String, size: CGFloat = 12, id: String, action: @escaping () -> Void) { self.title = title; self.size = size; self.id = id; self.action = action }
    var body: some View {
        Button(action: action) { Text(title).font(IX.font(size, 500)).foregroundStyle(hovering ? IX.ink : IX.mute).padding(.vertical, 4).padding(.horizontal, 2) }
            .buttonStyle(.plain).onHover { hovering = $0 }.driveID(id)
    }
}

/// A tick: on (ink, ✓), off (1.5 #c9c9c9, #e3e3e3 dimmed), or `some`: the unticked box with a short grey bar (MATH-143).
struct Box: View {
    let on: Bool
    var some = false
    var size: CGFloat = 14
    var dim = false
    var body: some View {
        let full = on && !some
        ZStack {
            RoundedRectangle(cornerRadius: 4).fill(full ? IX.ink : Color.white)
            if !full { RoundedRectangle(cornerRadius: 4).strokeBorder(dim ? hex("#e3e3e3") : IX.line2, lineWidth: 1.5) }
            if some { Capsule().fill(IX.mute).frame(width: size / 2, height: size * 1.5 / 14).driveID("connect-box-mixed") }
            else if full { Text("✓").font(IX.font(9, 600)).foregroundStyle(Color.white) }
        }
        .frame(width: size, height: size)
        .accessibilityValue(some ? "mixed" : on ? "true" : "false")
    }
}

/// An on/off switch (2026-10-11, David's mockup): 32 × 18, the knob 14.
struct Toggle2: View {
    let on: Bool
    var body: some View {
        ZStack(alignment: on ? .trailing : .leading) {
            Capsule().fill(on ? IX.ink : hex("#d9d9d9")).frame(width: 32, height: 18)
            Circle().fill(Color.white).frame(width: 14, height: 14).shadow(color: .black.opacity(0.2), radius: 1, y: 1).padding(2)
        }
        .animation(ease, value: on)
    }
}

/// A row's name and, only when the person has to do something, one grey line under it; the links after it.
struct RowText: View {
    let name: String
    let on: Bool
    let sub: String
    let label: RowLabel
    let dim: Bool
    let tip: String
    var onRetry: (() -> Void)?
    var onAnother: (() -> Void)?
    var onHere: (() -> Void)?
    var body: some View {
        let tone = label.text.isEmpty ? "" : label.tone
        let shown = !label.text.isEmpty && !tone.isEmpty ? label.text : ""
        let line = [shown, sub].filter { !$0.isEmpty }.joined(separator: " · ")
        let color = dim ? "#c9c9c9" : tone == "busy" || tone == "error" ? labelColor[tone]! : "#8f8f8f"
        VStack(alignment: .leading, spacing: 3) {
            Text(name).font(IX.font(13, 400)).foregroundStyle(dim ? IX.mute : on ? IX.ink : IX.body).lineLimit(1).truncationMode(.tail)
            if !line.isEmpty {
                HStack(spacing: 0) {
                    Text(line).font(IX.font(11.5, 400)).foregroundStyle(hex(color)).fixedSize(horizontal: false, vertical: true).driveID("connect-row-label=\(shown.isEmpty ? "" : tone)")
                    if label.retry, let onRetry { link(" · ", "Try again", onRetry) }
                    if label.another, let onAnother { link(" · ", "Use another account", onAnother) }
                    if label.here, let onHere { link(" · ", "Sign in here instead", onHere) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .help([label.text, sub, tip].filter { !$0.isEmpty }.joined(separator: " · "))
    }
    func link(_ sep: String, _ title: String, _ action: @escaping () -> Void) -> some View {
        HStack(spacing: 0) {
            Text(sep).font(IX.font(11.5, 400)).foregroundStyle(hex(labelColor[""]!))
            Button(action: action) { Text(title).font(IX.font(11.5, 400)).underline().foregroundStyle(IX.ink) }.buttonStyle(.plain).driveID("connect-link=\(title)")
        }
    }
}

/// A source's app row: logo (dimmed when Not found), name, Sign in when no browser could sign it in, and its tick.
struct AppRow: View {
    @ObservedObject var model: ConnectLibraryModel
    let id: String
    let app: String
    var icon: String? = nil
    var label: RowLabel? = nil
    var tip: String? = nil
    var data: String? = nil
    var on: Bool? = nil
    var toggle: (() -> Void)? = nil
    var body: some View {
        let label = self.label ?? model.label(app, id)
        let dim = label.text == "Not found"
        let on = self.on ?? ConnectModel.ticked(model.picks, id, app)
        let name = data == nil ? ConnectSources.shownName(app) : app
        Button(action: { if let toggle { toggle() } else if app == ConnectModel.browserRow { model.setRow("sites", app, !on) } else { Task { await model.toggleApp(id, app) } } }) {
            HStack(spacing: 10) {
                Group {
                    if let icon { Glyph(icon, size: 14, width: 1.5).foregroundStyle(IX.body) }
                    else if let file = Logos.toolFile(app) { LogoImage(file: file, size: 14) }
                    else if app == ConnectModel.localPDFs { Glyph(SVG.folder, size: 14, width: 1.5).foregroundStyle(IX.body) }
                    else { Color.clear.frame(width: 14, height: 14) }
                }
                .opacity(dim ? 0.45 : 1).padding(.horizontal, 1)
                RowText(name: name, on: on, sub: ConnectModel.rowSub(app), label: label, dim: dim, tip: tip ?? ConnectModel.rowTip(app),
                        onRetry: { Task { await model.retrySignIn(id, app) } }, onAnother: { model.anotherAccount(app) }, onHere: { Task { await model.hereInstead(id, app) } })
                if label.signIn {
                    Button(action: { Task { _ = await model.signInHere(id, app) } }) { Text("Sign in").font(IX.font(12, 400)).underline().foregroundStyle(IX.mute) }
                        .buttonStyle(.plain).driveID("connect-signin=\(app)")
                }
                Box(on: on, dim: dim)
            }
            .padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 5).frame(minHeight: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hover(.wash, radius: 6)
        .driveID("connect-app=\(data ?? app)")
    }
}

/// A row that opens to more rows (Code's GitHub and Local repos): its caret opens it, the rest ticks it.
struct ExpandRow: View {
    let name: String
    let on: Bool
    let some: Bool
    let open: Bool
    let label: RowLabel
    let icon: String?
    let onOpen: () -> Void
    let onToggle: () -> Void
    var body: some View {
        let dim = label.text == "Not found"
        HStack(spacing: 10) {
            Button(action: onOpen) { Glyph(SVG.caretRight, size: 12, width: 2).foregroundStyle(IX.mute).rotationEffect(.degrees(open ? 90 : 0)).frame(width: 12) }
                .buttonStyle(.plain).help(open ? "Close \(ConnectSources.shownName(name))" : "Open \(ConnectSources.shownName(name))").driveID("connect-row-open=\(name)")
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    Group { if let icon { Glyph(icon, size: 14, width: 1.5).foregroundStyle(IX.body) } else { LogoImage(file: Logos.toolFile(name), size: 14) } }.opacity(dim ? 0.45 : 1)
                    RowText(name: ConnectSources.shownName(name), on: on || some, sub: "", label: label, dim: dim, tip: "")
                    Box(on: on, some: some, dim: dim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 4).padding(.trailing, 8).padding(.vertical, 5).frame(minHeight: 30)
        .hover(.wash, radius: 6)
        .driveID("connect-app=\(name)")
    }
}

struct FolderRow: View {
    let path: String
    let onRemove: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Glyph(SVG.folder, size: 14, width: 1.5).foregroundStyle(IX.ink)
            Text(ConnectLibraryModel.shown(path)).font(Fonts.swiftUIMono(12)).foregroundStyle(IX.ink).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onRemove) { Text("×").font(IX.font(14, 400)).foregroundStyle(IX.mute) }.buttonStyle(.plain).help("Remove folder").driveID("connect-folder-remove")
        }
        .frame(height: 30).padding(.leading, 18).padding(.trailing, 8)
    }
}

struct AddRow: View {
    let label: String
    let hint: String
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Glyph(SVG.plus, size: 14, width: 1.5)
                Text(label).font(IX.font(13, 400)).frame(maxWidth: .infinity, alignment: .leading)
                if !hint.isEmpty { Text(hint).font(IX.font(12, 400)).foregroundStyle(IX.line2) }
            }
            .foregroundStyle(IX.mute).padding(.leading, 18).padding(.trailing, 8).frame(minHeight: 30).contentShape(Rectangle())
        }
        .buttonStyle(.plain).hover(.wash, radius: 6).driveID("connect-add=\(id)")
    }
}

/// "Refine with Claude Code ⌄ · Sonnet High | ↑": only the provider is chosen (2026-10-07: "do not even allow me to
/// change model or effort, only provider"). With a lead, the filled pill that starts the run; without, the chat's chip.
struct ProviderChip: View {
    @ObservedObject var model: ConnectLibraryModel
    let lead: String
    let provider: String?
    let sendOn: Bool
    let sendLabel: String
    let onSend: () -> Void
    @State private var open = false
    var body: some View {
        let current = (model.providers ?? []).first { J.str($0["provider"]) == provider } ?? (lead.isEmpty ? model.session?["choice"] : nil)
        let usable = (model.providers ?? []).filter { J.truthy($0["ready"]) }
        let primary = !lead.isEmpty
        let lit = primary && sendOn
        let quiet = primary ? Color.white.opacity(0.62) : IX.mute
        HStack(spacing: 6) {
            if primary { Text(lead).font(IX.font(13.5, 400)).foregroundStyle(quiet) }
            Text(current.map { J.str($0["name"]) } ?? "No agent").font(IX.font(primary ? 13.5 : 13, primary ? 500 : 400)).foregroundStyle(primary ? Color.white : IX.ink)
                .driveID("connect-provider=\(provider ?? "")")
            if let current { Text("\(J.str(current["modelName"])) · \(Self.effort(J.str(current["effort"])))").font(IX.font(13, 400)).foregroundStyle(quiet) }
            if usable.count > 1 { Glyph(SVG.caretDown, size: 12, width: 2).foregroundStyle(quiet) }
            Rectangle().fill(primary ? Color.white.opacity(0.2) : IX.line).frame(width: 1, height: primary ? 16 : 14).padding(.leading, primary ? 4 : 2).padding(.trailing, primary ? 3 : 2)
            Button(action: onSend) {
                Glyph(SVG.arrowUp, size: 13, width: 2.2).foregroundStyle(primary || sendOn ? Color.white : IX.mute)
                    .frame(width: primary ? 28 : 24, height: primary ? 28 : 24)
                    .background(Circle().fill(primary ? IX.blue : sendOn ? IX.blue : hex("#f2f2f2")))
            }
            .buttonStyle(.plain).help(sendLabel).driveID("connect-send")
        }
        .padding(.leading, primary ? 15 : 12).padding(.trailing, primary ? 5 : 6).padding(.vertical, 5)
        .background(Capsule().fill(primary ? hex("#2b2b2b") : Color.white))
        .overlay(Capsule().strokeBorder(primary ? hex("#2b2b2b") : IX.line, lineWidth: 1))
        .opacity(primary && !lit ? 0.45 : 1)
        .shadow(color: .black.opacity(lit ? 0.10 : 0), radius: 4, y: 2)
        .contentShape(Capsule())
        .onTapGesture { open.toggle() }
        .popover(isPresented: $open, arrowEdge: .top) { ProviderMenu(model: model, provider: provider) { open = false } }
        .help("Choose Claude Code or Codex")
        .driveID("connect-chip")
    }
    static func effort(_ e: String) -> String { e == "xhigh" ? "Extra high" : e.prefix(1).uppercased() + e.dropFirst() }
}

/// Claude Code or Codex, each with its pinned model and effort; one not signed in is greyed.
struct ProviderMenu: View {
    @ObservedObject var model: ConnectLibraryModel
    let provider: String?
    let done: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.providers ?? [], id: \.self) { entry in
                let ready = J.truthy(entry["ready"])
                Button(action: { done(); Task { await model.pickProvider(J.str(entry["provider"])) } }) {
                    HStack(spacing: 8) {
                        Group { if J.str(entry["provider"]) == provider { Glyph(SVG.check, size: 12, width: 2.5).foregroundStyle(IX.blue) } else { Color.clear } }.frame(width: 12)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(J.str(entry["name"])).font(IX.font(13, 400)).foregroundStyle(ready ? IX.ink : IX.mute)
                            Text(ready ? "\(J.str(entry["modelName"])) · \(J.str(entry["effort"]))" : "not signed in").font(IX.font(11.5, 400)).foregroundStyle(IX.mute)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!ready).hover(.wash, radius: 6).driveID("connect-provider-option=\(J.str(entry["provider"]))")
            }
            Text("Every agent here runs on this model and effort.").font(IX.font(11.5, 400)).foregroundStyle(IX.mute).padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 4)
        }
        .padding(4).frame(width: 250)
        .driveID("connect-providers")
    }
}

/// The agent inside the consent line (2026-10-09): a quiet box that opens the same menu (above with `up`).
struct ProviderPick: View {
    @ObservedObject var model: ConnectLibraryModel
    var up = false
    @State private var open = false
    var body: some View {
        let usable = (model.providers ?? []).filter { J.truthy($0["ready"]) }
        let current = (model.providers ?? []).first { J.str($0["provider"]) == model.provider }
        Button(action: { open.toggle() }) {
            HStack(spacing: 4) {
                Text(current.map { J.str($0["name"]) } ?? "Claude Code").foregroundStyle(IX.ink)
                if usable.count > 1 { Glyph(SVG.caretDown, size: 12, width: 2).foregroundStyle(IX.mute) }
            }
            .font(IX.font(13.5, 500)).padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(IX.line, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(usable.count < 2)
        .popover(isPresented: $open, arrowEdge: up ? .top : .bottom) { ProviderMenu(model: model, provider: model.provider) { open = false } }
        .help("Choose Claude Code or Codex")
        .driveID("connect-pick-provider=\(model.provider ?? "")")
    }
}

/// "From [the past year ⌄]": the past 6 months, the past year or all time.
struct PeriodPick: View {
    @Binding var days: Int?
    @State private var open = false
    var body: some View {
        Button(action: { open.toggle() }) {
            HStack(spacing: 4) { Text(ConnectSources.periodName(days)).foregroundStyle(IX.ink); Glyph(SVG.caretDown, size: 12, width: 2).foregroundStyle(IX.mute) }
                .font(IX.font(12.5, 400)).padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 1)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(IX.line, lineWidth: 1))
        }
        .buttonStyle(.plain).help("How far back to look")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(ConnectSources.periods, id: \.label) { period in
                    Button(action: { open = false; days = period.days }) {
                        HStack(spacing: 8) {
                            Group { if period.days == days { Glyph(SVG.check, size: 12, width: 2.5).foregroundStyle(IX.blue) } else { Color.clear } }.frame(width: 12)
                            Text(period.label).font(IX.font(13, 400)).foregroundStyle(IX.ink)
                            Spacer()
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).hover(.wash, radius: 6).driveID("connect-period-option=\(period.days.map(String.init) ?? "all")")
                }
            }
            .padding(4).frame(width: 180)
        }
        .driveID("connect-period=\(days.map(String.init) ?? "all")")
    }
}

/// The modal before macOS asks for a browser's sign-ins, and after Continue how it went (2026-10-11).
struct KeychainModal: View {
    let panel: SignInPanel?
    let outcome: KeychainOutcome?
    let chosen: Int?
    let onContinue: () -> Void
    let onNotNow: () -> Void
    let onClose: () -> Void
    let onChoose: (Int) -> Void
    static let tones: [String: (String, String)] = ["ask": ("#f2f2f2", "#171717"), "busy": ("#f2f2f2", "#171717"), "ok": ("#e8f6ee", "#1f9d55"), "warn": ("#fff4e0", "#a35200"), "refused": ("#fff4e0", "#a35200")]
    var phase: String { outcome.map { $0.done ? "done" : "waiting" } ?? "ask" }
    var body: some View {
        let tone = Self.tones[phase == "ask" ? "ask" : outcome!.tone] ?? Self.tones["busy"]!
        let title = phase == "ask" ? panel!.title : outcome!.title
        Scrim(color: IX.veilDark) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack { Circle().fill(hex(tone.0)); Glyph(phase == "done" && outcome!.tone == "ok" ? SVG.check : SVG.key, size: 18, width: phase == "done" && outcome!.tone == "ok" ? 2.4 : 1.8).foregroundStyle(hex(tone.1)) }
                    .frame(width: 36, height: 36)
                Text(title).font(IX.font(16, 600)).foregroundStyle(IX.ink).fixedSize(horizontal: false, vertical: true)
                if phase == "ask", let lead = panel?.lead, !lead.isEmpty { Text(lead).font(IX.font(13.5, 600)).foregroundStyle(IX.ink).driveID("connect-keychain-lead") }
                ForEach(phase == "ask" ? panel!.body : outcome!.lines, id: \.self) { Text($0).font(IX.font(13, 400)).foregroundStyle(IX.body).fixedSize(horizontal: false, vertical: true) }
                if phase == "ask", let profiles = panel?.profiles, profiles.count > 1 {
                    VStack(spacing: 6) {
                        ForEach(Array(profiles.enumerated()), id: \.offset) { index, profile in
                            let on = index == chosen
                            Button(action: { onChoose(index) }) {
                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(profiles.contains { $0.browser != profile.browser } ? "\(profile.browser) · \(profile.name)" : profile.name).font(IX.font(13.5, 400))
                                        if !profile.email.isEmpty { Text(profile.email).font(IX.font(12, 400)).foregroundStyle(IX.mute).lineLimit(1) }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    Text(on ? "✓" : "").foregroundStyle(on ? IX.ink : IX.line2)
                                }
                                .foregroundStyle(IX.ink).padding(.horizontal, 12).padding(.vertical, 9)
                                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? IX.ink : IX.line, lineWidth: 1))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).driveID("connect-signin-profile=\(profile.profileId)")
                        }
                    }
                }
                HStack(spacing: 16) {
                    switch phase {
                    case "ask":
                        Spacer()
                        TextLink("Not now", size: 13, id: "connect-signin-not-now", action: onNotNow)
                        darkButton("Continue", id: "connect-signin-continue", action: onContinue)
                    case "waiting":
                        Dots()
                        Spacer()
                        TextLink("Hide", size: 13, id: "connect-keychain-hide", action: onClose).help("Close this; the row still says how it goes")
                    default:
                        Spacer()
                        darkButton("Done", id: "connect-keychain-done", action: onClose)
                    }
                }
                .padding(.top, 8)
            }
            .padding(EdgeInsets(top: 22, leading: 22, bottom: 18, trailing: 22))
            .frame(width: 420)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
            .shadow(color: .black.opacity(0x29 / 255), radius: 24, y: 16)
        }
        .background(KeyMonitor(keyCode: 53) { phase == "ask" ? onNotNow() : onClose(); return true })
        .driveID("connect-keychain=\(phase)")
    }
}

func darkButton(_ title: String, id: String, height: CGFloat? = nil, size: CGFloat = 13, weight: Int = 500, disabled: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        Text(title).font(IX.font(size, weight)).foregroundStyle(Color.white).padding(.horizontal, height == nil ? 16 : 17).padding(.vertical, height == nil ? 9 : 0)
            .frame(height: height).background(RoundedRectangle(cornerRadius: 8).fill(IX.ink))
    }
    .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.5 : 1).driveID(id)
}

/// Three dots in a row, pulsing (the Keychain modal and the gate while they wait).
struct Dots: View {
    var body: some View {
        HStack(spacing: 3) { ForEach(0..<3, id: \.self) { i in Circle().fill(IX.body).frame(width: 5, height: 5).pulse(period: 1.1, delay: Double(i) * 0.14) } }
    }
}

/// Before macOS asks to let Engelbart read its protected folders (MATH-110, David's mockup).
struct FolderAccessModal: View {
    let panel: FolderPanel
    let onContinue: () -> Void
    let onNotNow: () -> Void
    var body: some View {
        Scrim(color: IX.veilDark) {
            VStack(alignment: .leading, spacing: 0) {
                Text(panel.title).font(IX.font(19, 600)).tracking(-0.2).foregroundStyle(IX.ink)
                Text(panel.lead).font(IX.font(16, 400)).tracking(-0.25).foregroundStyle(hex("#6b6f76")).padding(.top, 19).fixedSize(horizontal: false, vertical: true).driveID("connect-folders-lead")
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(panel.names, id: \.self) { name in
                        HStack(spacing: 12) {
                            FolderTile(cloud: name.range(of: "drive", options: .caseInsensitive) != nil || name.range(of: #"^(Dropbox|OneDrive|Box)"#, options: .regularExpression) != nil)
                            Text(name).font(IX.font(15, 500)).foregroundStyle(IX.ink).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.leading, 13).padding(.trailing, 12).frame(height: 36)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
                        .driveID("connect-folders-name=\(name)")
                    }
                }
                .padding(.top, 17)
                (Text(panel.note).font(IX.font(15, 600)).foregroundColor(IX.ink) + Text(" \(panel.ask)").font(IX.font(15, 400)).foregroundColor(IX.body))
                    .padding(.top, 18).help(panel.tip).driveID("connect-folders-tip")
                HStack(spacing: 22) {
                    Spacer()
                    TextLink("Not now", size: 15, id: "connect-folders-not-now", action: onNotNow)
                    darkButton("Ask macOS", id: "connect-folders-continue", height: 37, size: 15, weight: 600, action: onContinue)
                }
                .padding(.top, 22)
            }
            .padding(EdgeInsets(top: 23, leading: 26, bottom: 26, trailing: 26))
            .frame(width: 490)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
            .shadow(color: .black.opacity(0x29 / 255), radius: 24, y: 16)
        }
        .background(KeyMonitor(keyCode: 53) { onNotNow(); return true })
        .driveID("connect-folders=ask")
    }
}

/// A Finder-blue folder, or a cloud for iCloud Drive and the drives.
struct FolderTile: View {
    let cloud: Bool
    var body: some View {
        let d = cloud ? "M4 10.5a3.5 3.5 0 0 1-.5-6.96A4.5 4.5 0 0 1 12 4.1a3.2 3.2 0 0 1-.3 6.4z" : "M1.5 0.5h3.6l1.4 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"
        let shape = SVGShape(markup: "<path d=\"\(d)\"/>", grid: cloud ? 15 : 14)
        ZStack { shape.fill(hex("#70a8f5")); shape.stroke(hex("#5395ea"), lineWidth: 0.8) }.frame(width: cloud ? 15 : 14, height: cloud ? 15 : 14)
    }
}

/// Bring these in with ticked web apps no browser could sign in (2026-10-11): one modal, grouped by sign-in.
struct SignInGateModal: View {
    let gate: SignInGate
    let signing: Bool
    let waiting: String
    let canSignIn: Bool
    let onSignIn: () -> Void
    let onLeave: () -> Void
    let onClose: () -> Void
    var body: some View {
        Scrim(color: IX.veilDark) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack { Circle().fill(hex("#f2f2f2")); Glyph(SVG.key, size: 18, width: 1.8).foregroundStyle(IX.ink) }.frame(width: 36, height: 36)
                Text(gate.title).font(IX.font(16, 600)).foregroundStyle(IX.ink)
                ForEach(gate.lines, id: \.self) { Text($0).font(IX.font(13, 400)).foregroundStyle(IX.body) }
                if waiting.isEmpty { Text(signing ? "Finish signing in in the window that opened." : gate.body).font(IX.font(13, 400)).foregroundStyle(IX.body).fixedSize(horizontal: false, vertical: true).driveID("connect-signin-gate-body") }
                else { Text(waiting).font(IX.font(13, 600)).foregroundStyle(IX.ink).driveID("connect-signin-waiting") }
                HStack(spacing: 16) {
                    if signing || !waiting.isEmpty { Dots() }
                    Spacer()
                    TextLink("Leave \(gate.groups.flatMap { $0 }.count == 1 ? "it" : "them") out", size: 13, id: "connect-signin-leave", action: onLeave)
                    if canSignIn || signing { darkButton(signing ? (waiting.isEmpty ? "Signing in…" : "Waiting…") : "Sign in", id: "connect-signin-go", disabled: signing, action: onSignIn) }
                }
                .padding(.top, 8)
            }
            .padding(EdgeInsets(top: 22, leading: 22, bottom: 18, trailing: 22))
            .frame(width: 420)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
            .shadow(color: .black.opacity(0x29 / 255), radius: 24, y: 16)
        }
        .background(KeyMonitor(keyCode: 53) { onClose(); return true })
        .driveID("connect-signin-gate=\(signing ? "signing" : "ask")")
    }
}

/// A question already answered, folded to "✓ title"; a click opens the card as answered, a double click folds it.
struct AnsweredAsk<Card: View>: View {
    let title: String
    let card: Card
    @State private var open = false
    init(title: String, @ViewBuilder card: () -> Card) { self.title = title; self.card = card() }
    var body: some View {
        if open { card.onTapGesture(count: 2) { open = false }.driveID("connect-answered=open") }
        else {
            Button(action: { open = true }) {
                HStack(spacing: 8) {
                    Glyph(SVG.check, size: 12, width: 2.5).foregroundStyle(IX.mute)
                    Text(title).font(IX.font(13, 400)).foregroundStyle(IX.body).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1)).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Show the question").driveID("connect-answered")
        }
    }
}

/// The card's Skip and Submit row (pinned under the card's last option).
struct CardActions<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View { HStack(spacing: 8) { content }.padding(.top, 12).driveID("connect-card-actions") }
}

func submitButton(_ title: String, disabled: Bool, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        Text(title).font(IX.font(13, 500)).foregroundStyle(disabled ? IX.mute : Color.white).padding(.horizontal, 14).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(disabled ? IX.line : IX.blue))
    }
    .buttonStyle(.plain).disabled(disabled).driveID(id)
}

/// The librarian's question as a card (2026-10-12): one option per line, nothing ticked to start, the why after the label.
struct QuestionCard: View {
    let ask: JSONValue
    let live: Bool
    let onAnswer: (JSONValue) -> Void
    @State private var picks: [String] = []
    @State private var note = ""
    var body: some View {
        let kind = J.str(ask["kind"])
        let many = kind == "multi"
        let open = kind == "open"
        let options = J.arr(ask["options"])
        VStack(alignment: .leading, spacing: 0) {
            Text(J.str(ask["title"])).font(IX.font(15, 600)).foregroundStyle(IX.ink)
            if many { Text("Select all that apply.").font(IX.font(13, 400)).foregroundStyle(IX.mute).padding(.top, 6) }
            if !open && !options.isEmpty {
                VStack(spacing: 4) {
                    ForEach(options, id: \.self) { option in
                        let label = J.str(option["label"])
                        let on = picks.contains(label)
                        Button(action: { if live { picks = QuestionCardLogic.pick(picks, label, many: many) } }) {
                            HStack(alignment: .top, spacing: 10) {
                                ZStack {
                                    (many ? AnyShape(RoundedRectangle(cornerRadius: 4)) : AnyShape(Circle())).fill(on ? IX.blue : Color.white)
                                    (many ? AnyShape(RoundedRectangle(cornerRadius: 4)) : AnyShape(Circle())).stroke(on ? IX.blue : IX.line2, lineWidth: 1.5)
                                    if on { (many ? AnyShape(RoundedRectangle(cornerRadius: 2)) : AnyShape(Circle())).fill(Color.white).padding(2.5); (many ? AnyShape(RoundedRectangle(cornerRadius: 1.5)) : AnyShape(Circle())).fill(IX.blue).padding(3.5) }
                                }
                                .frame(width: 14, height: 14).padding(.top, 3)
                                FlowRow(spacing: 8) {
                                    Text(label).font(IX.font(14, 400)).foregroundStyle(live ? IX.ink : IX.mute)
                                    if !J.str(option["why"]).isEmpty { Text(J.str(option["why"])).font(IX.font(12.5, 400)).foregroundStyle(IX.mute).driveID("connect-option-why") }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? IX.ink : IX.line, lineWidth: on ? 1.5 : 1))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!live)
                        .simultaneousGesture(TapGesture(count: 2).onEnded { if !many && live, let input = QuestionCardLogic.submit(kind: kind, picks: [label], note: note) { onAnswer(input) } })
                        .driveID("connect-option=\(label)")
                    }
                }
                .padding(.top, 12)
            }
            if live {
                if open {
                    GrowingField(ask["placeholder"]?.string ?? "In a sentence or two…", text: $note, id: "connect-card-field") { submit() }.padding(.top, 12)
                } else {
                    TextField("Or say it in your own words…", text: $note).textFieldStyle(.plain).font(IX.font(14, 400))
                        .padding(.horizontal, 10).padding(.vertical, 8).overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
                        .onSubmit(submit).padding(.top, 10).driveID("connect-card-field")
                }
                CardActions {
                    TextLink("Skip", id: "connect-skip") { onAnswer(["skipped": true]) }
                    Spacer()
                    submitButton("Submit", disabled: !QuestionCardLogic.ready(kind: kind, picks: picks, note: note), id: "connect-submit", action: submit)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
        .driveID("connect-card=\(live ? "live" : "answered")")
    }
    func submit() { if live, let input = QuestionCardLogic.submit(kind: J.str(ask["kind"]), picks: picks, note: note) { onAnswer(input) } }
}

/// The librarian's first message (2026-10-16): every app unticked, a circle at the right; Select all beside Grant access.
struct GrantCard: View {
    let grant: JSONValue
    let live: Bool
    let onGrant: ([String]) async -> Void
    @State private var picks: [String] = []
    @State private var busy = false
    var body: some View {
        let rows = J.arr(grant["rows"])
        let ids = rows.map { J.str($0["id"]) }
        if let said = GrantLogic.answered(grant) {
            HStack(spacing: 8) { Glyph(SVG.check, size: 12, width: 2.5).foregroundStyle(IX.mute); Text(said).font(IX.font(13, 400)).foregroundStyle(IX.mute) }.driveID("connect-grant=answered")
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Text("Allow Engelbart to access the following apps:").font(IX.font(15, 600)).foregroundStyle(IX.ink)
                VStack(spacing: 4) {
                    ForEach(rows, id: \.self) { row in
                        let id = J.str(row["id"])
                        let on = picks.contains(id)
                        Button(action: { picks = on ? picks.filter { $0 != id } : picks + [id] }) {
                            HStack(spacing: 12) {
                                Group { if let file = Logos.toolFile(id) { LogoImage(file: file, size: 14) } else { Glyph(SVG.globe, size: 14, width: 1.5).foregroundStyle(IX.mute) } }.frame(width: 18)
                                Text(J.str(row["name"])).font(IX.font(14.5, 400)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
                                ZStack {
                                    Circle().fill(on ? IX.blue : Color.white)
                                    Circle().strokeBorder(on ? IX.blue : IX.line2, lineWidth: 1.5)
                                    if on { Glyph(SVG.check, size: 12, width: 2.5).foregroundStyle(Color.white) }
                                }
                                .frame(width: 20, height: 20)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 8).fill(on ? IX.wash : Color.white))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? IX.ink : Color.clear, lineWidth: 1.5))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!live || busy).driveID("connect-grant-app=\(id)")
                    }
                }
                .padding(.top, 10)
                if live {
                    CardActions {
                        Spacer()
                        TextLink(GrantLogic.allLabel(ids: ids, picks: picks), id: "connect-grant-all") { picks = GrantLogic.all(ids: ids, picks: picks) }.disabled(busy)
                        submitButton("Grant access", disabled: picks.isEmpty || busy, id: "connect-grant-go") {
                            busy = true
                            Task { await onGrant(picks); busy = false }
                        }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
            .rise(0.26)
            .driveID("connect-grant=\(live ? "live" : "closed")")
        }
    }
}

/// The librarian asking which GitHub repositories: the GitHub list, Skip, "N selected", Submit (owner/name).
struct ReposCard: View {
    @ObservedObject var model: ConnectLibraryModel
    let ask: JSONValue
    let live: Bool
    @State private var picks: [String] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(J.str(ask["title"])).font(IX.font(15, 600)).foregroundStyle(IX.ink)
            if live {
                Group {
                    if let slot = model.context.githubRepos {
                        slot({ picks.contains(J.str($0["fullName"])) }, { repo in let name = J.str(repo["fullName"]); picks = picks.contains(name) ? picks.filter { $0 != name } : picks + [name] }, "")
                    } else {
                        GithubFallbackList(model: model, held: { picks.contains(J.str($0["fullName"])) }) { repo in let name = J.str(repo["fullName"]); picks = picks.contains(name) ? picks.filter { $0 != name } : picks + [name] }
                    }
                }
                .frame(height: 340).padding(.top, 10).driveID("connect-repos")
                CardActions {
                    TextLink("Skip", id: "connect-skip") { Task { await model.reply(["skipped": true]) } }
                    Spacer()
                    if !picks.isEmpty { Text("\(picks.count) selected").font(IX.font(12.5, 400)).foregroundStyle(IX.mute) }
                    submitButton("Submit", disabled: picks.isEmpty, id: "connect-submit") { Task { await model.reply(["picked": .array(picks.map(JSONValue.string))]) } }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
        .driveID("connect-card-kind=repos")
    }
}

/// When the app gives no GitHub list (Integrations' GithubReposView): the repositories githubRepos answers, ticked.
struct GithubFallbackList: View {
    @ObservedObject var model: ConnectLibraryModel
    var held: ((JSONValue) -> Bool)? = nil
    var toggle: ((JSONValue) -> Void)? = nil
    @State private var repos: [JSONValue]?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                if repos == nil { Text("Reading your repositories…").font(IX.font(12.5, 400)).foregroundStyle(IX.mute).padding(8) }
                ForEach(repos ?? [], id: \.self) { repo in
                    let on = held?(repo) ?? (model.heldRepo(repo) != nil)
                    Button(action: { if let toggle { toggle(repo) } else { Task { await model.toggleRepo(repo) } } }) {
                        HStack(spacing: 10) { Text(J.str(repo["fullName"])).font(IX.font(13, 400)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading); Box(on: on) }
                            .padding(.horizontal, 8).frame(minHeight: 30).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).hover(.wash, radius: 6).driveID("github-repo=\(J.str(repo["fullName"]))")
                }
            }
        }
        .task { repos = J.arr((try? await model.api.githubRepos())?["repos"]) }
    }
}

/// A button the librarian offers: sign in, ask macOS, choose a folder.
struct AuthorizeCard: View {
    let authorize: JSONValue
    let live: Bool
    let busy: Bool
    let onUse: () -> Void
    let onSkip: () -> Void
    let onCancel: () -> Void
    var body: some View {
        let app = J.str(authorize["app"]), kind = J.str(authorize["kind"])
        HStack(spacing: 10) {
            Button(action: onUse) {
                HStack(spacing: 7) {
                    if let file = Logos.toolFile(app) { LogoImage(file: file, size: 14).colorInvert().brightness(1) }
                    Text(busy ? (kind == "connector" ? "Finish signing in to \(ConnectSources.shownName(app)) in your browser…" : "Waiting…") : J.str(authorize["label"]))
                }
                .font(IX.font(12.5, 500)).foregroundStyle(Color.white).padding(.horizontal, 12).frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 8).fill(IX.ink))
            }
            .buttonStyle(.plain).disabled(!live || busy).opacity(!live || busy ? 0.5 : 1).driveID("connect-button=\(kind)")
            if live && busy && kind == "connector" { TextLink("Cancel", id: "connect-authorize-cancel", action: onCancel) }
            if live && !busy { TextLink("Skip", id: "connect-skip", action: onSkip) }
        }
        .driveID("connect-authorize=\(kind)")
    }
}

/// The steps the agents handed the person, in the chat as one card: a row an app, Skip and its one button.
struct NeedsCard: View {
    let needs: [JSONValue]
    let onOpen: (JSONValue) -> Void
    let onSkip: (JSONValue) -> Void
    var body: some View {
        if !needs.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(needs, id: \.self) { need in
                    let view = ConnectModel.needView(need)
                    let kind = J.str(need["kind"])
                    let busy = J.truthy(need["busy"])
                    let under = busy && !J.str(need["browser"]).isEmpty && kind != "signin-here" ? ConnectModel.waitingIn(ConnectModel.signInName(J.str(need["app"])), J.str(need["browser"])) : ""
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 10) {
                            Group { if let file = Logos.toolFile(J.str(need["app"])) { LogoImage(file: file, size: 14) } else { Glyph(SVG.alert, size: 14, width: 1.8).foregroundStyle(IX.mute) } }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(kind == "signin-here" ? view.title : ConnectSources.shownName(J.str(need["app"]))).font(IX.font(13.5, 500)).foregroundStyle(IX.ink).help(view.title)
                                if !under.isEmpty { Text(under).font(IX.font(12, 400)).foregroundStyle(IX.mute).lineLimit(1) }
                                if !J.str(need["note"]).isEmpty && J.str(need["error"]).isEmpty { Text(J.str(need["note"])).font(IX.font(12, 400)).foregroundStyle(IX.mute).driveID("connect-need-note") }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            TextLink("Skip", id: "connect-need-skip") { onSkip(need) }
                            needButton(busy ? "Waiting…" : view.action, disabled: busy) { onOpen(need) }
                        }
                        if !J.str(need["error"]).isEmpty { Text(J.str(need["error"])).font(IX.font(12, 400)).foregroundStyle(IX.red).padding(.leading, 24) }
                    }
                    .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 10)
                    .driveID("connect-need=\(kind)")
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
            .frame(maxWidth: .infinity, alignment: .leading)
            .rise(0.2)
            .driveID("connect-needs")
        }
    }
}

func needButton(_ title: String, disabled: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        Text(title).font(IX.font(12.5, 500)).foregroundStyle(Color.white).padding(.horizontal, 12).frame(height: 30).background(RoundedRectangle(cornerRadius: 8).fill(IX.ink))
    }
    .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.5 : 1).driveID("connect-need-open")
}

/// A step in the working view: an amber card.
struct NeedCard: View {
    let need: JSONValue
    let onOpen: () -> Void
    let onSkip: () -> Void
    var body: some View {
        let view = ConnectModel.needView(need)
        let busy = J.truthy(need["busy"])
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Group { if let file = Logos.toolFile(J.str(need["app"])) { LogoImage(file: file, size: 14) } else { Glyph(SVG.alert, size: 14, width: 1.8).foregroundStyle(IX.amber) } }
                VStack(alignment: .leading, spacing: 1) {
                    Text(view.title).font(IX.font(13.5, 500)).foregroundStyle(IX.ink)
                    if !J.str(need["reason"]).isEmpty && J.str(need["reason"]) != view.title { Text(J.str(need["reason"])).font(IX.font(12, 400)).foregroundStyle(IX.mute).lineLimit(1) }
                    if busy && !J.str(need["browser"]).isEmpty { Text(ConnectModel.waitingIn(ConnectModel.signInName(J.str(need["app"])), J.str(need["browser"]))).font(IX.font(12, 400)).foregroundStyle(IX.mute).driveID("connect-need-wait") }
                    else if !J.str(need["note"]).isEmpty && J.str(need["error"]).isEmpty { Text(J.str(need["note"])).font(IX.font(12, 400)).foregroundStyle(IX.mute).driveID("connect-need-note") }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                TextLink("Skip", id: "connect-need-skip", action: onSkip)
                needButton(busy ? "Waiting…" : view.action, disabled: busy, action: onOpen)
            }
            if !J.str(need["error"]).isEmpty { Text(J.str(need["error"])).font(IX.font(12, 400)).foregroundStyle(IX.red) }
        }
        .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(hex("#fffaf0")))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(hex("#f5c26b"), lineWidth: 1))
        .driveID("connect-need=\(J.str(need["kind"]))")
    }
}

/// One import in the popup's progress list: its label, status, Stop; its error when it failed.
struct JobRow: View {
    let job: JSONValue
    let onStop: () -> Void
    var body: some View {
        let status = ConnectModel.statusOf(job)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                Group { if let file = J.strs(job["apps"]).first.flatMap(Logos.toolFile) { LogoImage(file: file, size: 14) } else { Color.clear.frame(width: 14, height: 14) } }
                Text(J.str(job["label"])).font(IX.font(13.5, 400)).foregroundStyle(status.done ? IX.body : IX.ink).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Text(status.text).font(IX.font(12.5, 400)).foregroundStyle(status.failed ? IX.red : status.waiting ? IX.amber : status.done ? IX.ink : IX.mute)
                if !status.done { TextLink("Stop", id: "connect-stop-job=\(J.str(job["id"]))", action: onStop) }
            }
            if !J.str(job["error"]).isEmpty { Text(J.str(job["error"])).font(IX.font(12, 400)).foregroundStyle(IX.red).padding(.leading, 24) }
        }
        .padding(.vertical, 9)
        .driveID("connect-job=\(J.str(job["status"]))")
    }
}

/// A row of onboarding's "Bringing everything in": Stop shows on the row under the pointer while it works.
struct PageJob: View {
    let job: JSONValue
    let onStop: () -> Void
    @State private var hover = false
    var body: some View {
        let row = ConnectModel.workRow(job)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                Group {
                    if let file = J.strs(job["apps"]).first.flatMap(Logos.toolFile) { LogoImage(file: file, size: 14) }
                    else { Glyph(J.str(job["source"]) == "sites" ? SVG.globe : SVG.folder, size: 14, width: 1.5).foregroundStyle(IX.mute) }
                }.frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(IX.font(13.5, 500)).foregroundStyle(IX.ink).lineLimit(1).driveID("connect-job-title")
                    if !row.sub.isEmpty { Text(row.sub).font(IX.font(12, 400)).foregroundStyle(IX.mute).lineLimit(1) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(row.status.text).font(IX.font(12.5, 400)).monospacedDigit()
                    .foregroundStyle(row.status.failed ? IX.red : row.status.waiting ? IX.amber : row.status.going ? IX.ink : IX.mute).driveID("connect-job-status")
                if !row.status.done { TextLink("Stop", size: 12.5, id: "connect-stop-job=\(J.str(job["id"]))", action: onStop).opacity(hover ? 1 : 0) }
            }
            if !J.str(job["error"]).isEmpty { Text(J.str(job["error"])).font(IX.font(12, 400)).foregroundStyle(IX.red).padding(.leading, 28) }
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        .background(RoundedRectangle(cornerRadius: 8).fill(hover ? hex("#f5f5f5") : Color.clear))
        .onHover { hover = $0 }
        .driveID("connect-job=\(J.str(job["status"]))")
    }
}

/// Under the chat, one line: what the librarian does, then the subagents at work, one at a time, every 2.6 s the next.
struct WorkLineView: View {
    let session: JSONValue
    @State private var tick = 0
    var body: some View {
        let busy = ConnectModel.workJobs(J.arr(session["jobs"])).filter { ["running", "waiting"].contains(J.str($0["status"])) }.count
        if let view = ConnectModel.workLine(session, tick: tick) {
            HStack(spacing: 8) {
                if !view.lead.isEmpty { WaveText(view.lead, font: IX.font(12.5, 400)).lineLimit(1).driveID("connect-thinking") }
                if !view.lead.isEmpty && view.agent != nil { Text("·").foregroundStyle(IX.line2) }
                if let agent = view.agent {
                    HStack(spacing: 6) {
                        Text(agent.label).foregroundStyle(IX.body)
                        Text(agent.doing).foregroundStyle(agent.waiting ? IX.amber : IX.mute).lineLimit(1).truncationMode(.tail)
                        if !agent.place.isEmpty { Text(agent.place).foregroundStyle(IX.line2).monospacedDigit() }
                    }
                    .id(agent.id).transition(.opacity).driveID("connect-subagent=\(agent.id)")
                }
            }
            .font(IX.font(12.5, 400)).frame(height: 24).padding(.horizontal, 4)
            .onReceive(Timer.publish(every: 2.6, on: .main, in: .common).autoconnect()) { _ in if busy >= 2 { tick += 1 } }
            .driveID("connect-workline")
        }
    }
}

/// The foot of onboarding's page: something at the left, the pager, the one button.
struct Foot<Left: View, Button_: View>: View {
    let pager: AnyView?
    let left: Left
    let button: Button_
    init(pager: AnyView?, @ViewBuilder left: () -> Left, @ViewBuilder button: () -> Button_) { self.pager = pager; self.left = left(); self.button = button() }
    var body: some View {
        HStack(spacing: 16) {
            left.frame(maxWidth: .infinity, alignment: .leading)
            if let pager { pager }
            button
        }
        .padding(.top, 14)
        .driveID("connect-foot")
    }
}

/// The page's main button (FOOT_BUTTON): 36 tall, ink, a caret after its words; quiet (white, #eaeaea, #4d4d4d) while
/// the librarian still has questions (importFootStyle).
struct FootButton: View {
    let title: String
    let caret: Bool
    let quiet: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                if caret { Glyph(SVG.caretRight, size: 12, width: 2) }
            }
            .font(IX.font(13.5, 500)).foregroundStyle(quiet ? IX.body : Color.white)
            .padding(.leading, 16).padding(.trailing, caret ? 14 : 16).frame(height: 36)
            .background(RoundedRectangle(cornerRadius: 8).fill(quiet ? Color.white : IX.ink))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(quiet ? IX.line : IX.ink, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// "Bringing in Zotero papers and AI chats · Google Drive needs you", moving while work goes on.
struct FootStatus: View {
    let session: JSONValue
    var body: some View {
        let text = ConnectModel.footLine(session)
        let going = ConnectModel.workJobs(J.arr(session["jobs"])).contains { !ConnectModel.statusOf($0).done }
        if !text.isEmpty {
            Group { if going { WaveText(text, font: IX.font(12.5, 400)) } else { Text(text).font(IX.font(12.5, 400)).foregroundStyle(IX.mute) } }
                .lineLimit(1).driveID("connect-foot-status")
        }
    }
}

/// Until the librarian says something: "Getting to know your library", moving (2026-10-16: no dots).
struct Starting: View {
    let compact: Bool
    var body: some View {
        Group {
            if compact { WaveText("Getting to know your library", font: IX.font(14, 400)) }
            else { WaveText("Getting to know your library", font: IX.font(16, 500)).frame(maxWidth: .infinity, minHeight: 240).padding(.bottom, 40) }
        }
        .rise(0.26)
        .driveID("connect-starting")
    }
}
