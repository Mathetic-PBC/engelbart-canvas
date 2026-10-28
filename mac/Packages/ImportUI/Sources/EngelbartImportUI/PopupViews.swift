import AppKit
import SwiftUI
import EngelbartCore
import EngelbartConnect
import EngelbartUI

// The popups an Import your context run puts over the workspace, drawn as the flow's dialogs (a white card, one line
// under the title at most, no dividers): the agent popup (AgentSetup.jsx), a step for the person (NeedPopup.jsx),
// Connect Claude Code / Codex (ProviderPopup.jsx) and Imports in progress (ImportStatus.jsx). Each scrim covers the
// window (the Stage's page and the post-its step aside for it: the app puts these above native views).

// MARK: the agent popup

/// The popup's contents (inside Import your context's modal, or AgentSetupPopup over Welcome).
public struct AgentSetupBody: View {
    @ObservedObject var model: AgentSetupModel
    public init(model: AgentSetupModel) { self.model = model }
    public var body: some View {
        let plan = model.plan
        VStack(alignment: .leading, spacing: 0) {
            IXTitle("Use Claude Code, Codex, or both?")
            VStack(spacing: 7) {
                ForEach(AgentSetupModel.choices, id: \.id) { one in
                    let on = model.choice == one.id
                    Button(action: { model.choose(one.id) }) {
                        HStack(spacing: 12) {
                            HStack(spacing: -7) {
                                ForEach(one.logos, id: \.self) { logo in
                                    LogoImage(file: Logos.providerFiles[logo], size: 24).clipShape(RoundedRectangle(cornerRadius: 6))
                                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white).padding(one.logos.count > 1 ? -2 : 0))
                                }
                            }
                            .frame(minWidth: 41, alignment: .leading)
                            Text(one.name).font(IX.font(15, 400)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
                            if model.readyRow(one.id) { Glyph(IXGlyph.check, size: 15).foregroundStyle(IX.ink) }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 9).frame(minHeight: 54)
                        .background(RoundedRectangle(cornerRadius: 10).fill(on ? IX.wash : Color.white))
                        .chosen(on)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).driveID("agent-choice=\(one.id)")
                }
            }
            .padding(.top, 16)
            if !model.line.isEmpty { Text(model.line).font(IX.font(12.5, 400)).foregroundStyle(IX.red).padding(.top, 10).driveID("agent-line") }
            HStack(spacing: 14) {
                IXButton("Skip", .link, id: "agent-skip") { model.onSkip() }
                Spacer()
                IXButton(plan.primary.label, small: true, disabled: plan.primary.disabled, id: "agent-primary=\(plan.primary.action ?? "")") { model.primary() }
            }
            .padding(.top, 22)
        }
        .driveID("agent-setup=\(model.choice ?? "")")
    }
}

/// The agent popup over a screen that is not Import your context (Welcome): its own scrim; Escape is Skip.
public struct AgentSetupPopup: View {
    @ObservedObject var model: AgentSetupModel
    public init(model: AgentSetupModel) { self.model = model }
    public var body: some View {
        Scrim(color: IX.scrim) { IXModal(width: 440) { AgentSetupBody(model: model) } }
            .background(KeyMonitor(keyCode: 53) { model.onSkip(); return true })
            .driveID("agent-popup")
    }
}

// MARK: a step for the person

/// `need` the step (connect/session.cjs publicNeed); `onOpen` its primary action; `onDone` once opened ("I'm signed in",
/// Done); `onSkip` a permission turned down; `onLater` (Skip) leaves the app out. Skip is never disabled.
public struct NeedPopupView: View {
    let need: JSONValue
    let onOpen: () -> Void
    let onDone: () -> Void
    let onSkip: () -> Void
    let onLater: () -> Void
    public init(need: JSONValue, onOpen: @escaping () -> Void, onDone: @escaping () -> Void, onSkip: @escaping () -> Void, onLater: @escaping () -> Void) {
        self.need = need; self.onOpen = onOpen; self.onDone = onDone; self.onSkip = onSkip; self.onLater = onLater
    }
    public var body: some View {
        let words = NeedPopupModel.needCopy(need)
        let id = J.str(need["id"])
        Scrim(onPress: onLater) {
            IXModal(width: 420) {
                IXTitle(words.title)
                if !words.text.isEmpty { IXPara(words.text) }
                if !J.str(need["error"]).isEmpty { Text(J.str(need["error"])).font(IX.font(12.5, 400)).foregroundStyle(IX.red).padding(.top, 10).driveID("need-error") }
                IXFoot {
                    IXButton(words.secondary, .link, id: "need-later=\(id)") { J.str(need["kind"]) == "permission" ? onSkip() : onLater() }
                    IXButton(words.primary, small: true, disabled: words.waiting, id: "need-primary=\(id)") { NeedPopupModel.finishing(need) ? onDone() : onOpen() }
                }
            }
        }
        .background(KeyMonitor(keyCode: 53) { onLater(); return true })
        .driveID("need-popup=\(id)")
    }
}

// MARK: Connect Claude Code / Codex

/// A run blocked on its provider (2026-10-14): Connect installs, checks and signs in; once signed in the run goes on by
/// itself (onContinue). `tools` the tool check's snapshot; Escape and the scrim are Skip.
@MainActor
public final class ProviderPopupState: ObservableObject {
    @Published public var tools: JSONValue?
    @Published public var error = ""
    @Published public private(set) var pressed = false
    public let session: JSONValue
    var changed = false
    var tried = false
    let onConnect: (String) async throws -> Void
    let onSignIn: (String) async throws -> Void
    let onOpenPage: (String) -> Void
    let onContinue: (String) async throws -> Void
    public let onLater: () -> Void

    public init(session: JSONValue, tools: JSONValue?, onConnect: @escaping (String) async throws -> Void, onSignIn: @escaping (String) async throws -> Void,
                onOpenPage: @escaping (String) -> Void, onContinue: @escaping (String) async throws -> Void, onLater: @escaping () -> Void) {
        self.session = session; self.tools = tools; self.onConnect = onConnect; self.onSignIn = onSignIn; self.onOpenPage = onOpenPage; self.onContinue = onContinue; self.onLater = onLater
        update(tools: tools)
    }
    public var provider: String { J.str(session["blocked"]?["provider"]) == "openai" ? "openai" : "anthropic" }
    public var other: String { provider == "anthropic" ? "openai" : "anthropic" }
    var tool: JSONValue? { tools?["tools"]?[ProviderPopupModel.cli[provider]!] }
    public var otherReady: Bool { ProviderPopupModel.cliReady(tools?["tools"]?[ProviderPopupModel.cli[other]!]) }
    public var words: ProviderCopy { ProviderPopupModel.providerCopy(provider, tool, why: J.str(session["blocked"]?["error"]), changed: changed) }
    public var line: String { error.isEmpty ? words.line : error }
    public var lineIsError: Bool { !error.isEmpty || (words.problem && (pressed || words.state == "refused")) }

    /// The newest tool check: ready only counts once it was seen otherwise; then the run goes on by itself, once.
    public func update(tools: JSONValue?) {
        self.tools = tools
        let busy = tool?["busy"].flatMap(J.present)
        if !ProviderPopupModel.cliReady(tool) || J.str(busy?["action"]) == "sign-in" { changed = true }
        if words.state == "ready" && !tried {
            tried = true
            let provider = self.provider
            Task { do { try await onContinue(provider) } catch { self.tried = false; self.error = tidyError(error) } }
        }
    }
    public func primary() {
        error = ""
        if words.state == "signing-in", let url = tool?["busy"]?["url"]?.string { onOpenPage(url); return }
        pressed = true
        let cli = ProviderPopupModel.cli[provider]!
        let refused = words.state == "refused"
        Task { do { if refused { try await onSignIn(cli) } else { try await onConnect(cli) } } catch { self.error = tidyError(error) } }
    }
    public func useOther() { let other = self.other; Task { do { try await onContinue(other) } catch { self.error = tidyError(error) } } }
}

public struct ProviderPopupView: View {
    @ObservedObject var model: ProviderPopupState
    public init(model: ProviderPopupState) { self.model = model }
    public var body: some View {
        let words = model.words
        let name = ProviderPopupModel.name[model.provider]!
        Scrim(onPress: model.onLater) {
            IXModal(width: 420) {
                IXTitle("Connect \(name)")
                if !model.line.isEmpty {
                    Text(model.line).font(IX.font(model.lineIsError ? 12.5 : 15, 400)).foregroundStyle(model.lineIsError ? IX.red : IX.para)
                        .padding(.top, model.lineIsError ? 10 : 16).driveID("provider-line")
                }
                IXFoot {
                    if model.otherReady { IXButton("Use \(ProviderPopupModel.name[model.other]!)", .link, id: "provider-other=\(model.other)") { model.useOther() } }
                    IXButton("Skip", .link, id: "provider-later") { model.onLater() }
                    IXButton(words.primary, small: true, disabled: words.waiting, id: "provider-connect=\(model.provider)") { model.primary() }
                }
            }
        }
        .background(KeyMonitor(keyCode: 53) { model.onLater(); return true })
        .driveID("provider-popup=\(model.provider)")
    }
}

// MARK: Imports in progress

/// `session` the run's snapshot; `onClose` puts it away; `onNeed(need)` a row's "Needs you" (the step's popup again);
/// `onStop` Stop all, once confirmed; `onDone` Open library once everything has ended.
public struct ImportStatusView: View {
    let session: JSONValue
    let onClose: () -> Void
    let onNeed: (JSONValue) -> Void
    let onStop: () -> Void
    let onDone: () -> Void
    @State private var confirmStop: Bool
    public init(session: JSONValue, previewStop: Bool = false, onClose: @escaping () -> Void, onNeed: @escaping (JSONValue) -> Void, onStop: @escaping () -> Void, onDone: @escaping () -> Void) {
        self.session = session; self.onClose = onClose; self.onNeed = onNeed; self.onStop = onStop; self.onDone = onDone
        _confirmStop = State(initialValue: previewStop)
    }

    public var body: some View {
        let ended = ImportStatusModel.ended(session)
        ZStack {
            Scrim(onPress: onClose) {
                IXModal(width: ended == nil ? 568 : 540, padding: ended == nil ? 30 : 26) {
                    HStack(alignment: .top, spacing: 14) {
                        IXTitle(ended?.title ?? "Imports in progress")
                        Spacer()
                        Button(action: onClose) { Text("×").font(IX.font(22, 400)).foregroundStyle(IX.mute) }.buttonStyle(.plain).help("Close import status").driveID("import-status-x")
                    }
                    if let ended {
                        IXPara(ended.body)
                        if !ended.rows.isEmpty {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(ended.rows, id: \.key) { row in
                                    HStack(spacing: 12) {
                                        if row.key == "web" { Glyph(IXGlyph.web, size: 20) } else if row.key == "folder" { Glyph(IXGlyph.folder, size: 20) } else { LogoImage(file: row.key, size: 20) }
                                        Text(row.name).font(IX.font(14.5, 400)).foregroundStyle(IX.ink)
                                    }
                                    .frame(minHeight: 36).driveID("imported=\(row.name)")
                                }
                            }
                            .padding(.top, 10).padding(.bottom, 2)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(ImportStatusModel.rows(session), id: \.id) { row in
                                HStack(spacing: 12) {
                                    if let app = row.apps.first { if let file = Logos.toolFile(app) { LogoImage(file: file, size: 18) } else { Glyph(IXGlyph.folder, size: 18) } } else { Glyph(IXGlyph.web, size: 18) }
                                    Text(row.name).font(IX.font(14.5, 600)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
                                    if let needId = row.needId, let need = J.arr(session["needs"]).first(where: { J.str($0["id"]) == needId }) {
                                        Button(action: { onNeed(need) }) { Text("Needs you").font(IX.font(12, 400)).underline().foregroundStyle(IX.ink) }.buttonStyle(.plain).driveID("need-open=\(needId)")
                                    } else {
                                        Text(row.state).font(IX.font(12, 400)).foregroundStyle(IX.ink)
                                    }
                                }
                                .frame(minHeight: 44).padding(.vertical, 0)
                                .help(row.error ?? "")
                                .driveID("background-job=\(row.id)")
                            }
                        }
                        .padding(.top, 14)
                    }
                    IXFoot {
                        if ended == nil { IXButton("Stop all", .link, id: "import-stop-all") { confirmStop = true }; Spacer() }
                        IXButton(ended == nil ? "Continue in Engelbart" : "Open library", id: "import-status-close") { ended == nil ? onClose() : onDone() }
                    }
                }
            }
            if confirmStop && ended == nil {
                Scrim(onPress: { confirmStop = false }) {
                    IXModal {
                        IXTitle("Are you sure?")
                        IXPara("Every import stops now. What came in stays in your library; the rest is not brought in.")
                        IXFoot {
                            IXButton("Stop all", .link, id: "import-stop-confirm") { confirmStop = false; onStop() }
                            IXButton("Keep importing", small: true, id: "import-keep") { confirmStop = false }
                        }
                    }
                }
                .driveID("stop-confirm")
            }
        }
        .background(KeyMonitor(keyCode: 53) { if confirmStop { confirmStop = false } else { onClose() }; return true })
        .driveID("import-status=\(J.str(session["id"]))")
    }
}
