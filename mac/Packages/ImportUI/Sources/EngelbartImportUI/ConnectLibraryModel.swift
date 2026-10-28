import Foundation
import Combine
import SwiftUI
import EngelbartCore
import EngelbartConnect

// Connect your library (2026-10-07; src/renderer/screens/ConnectLibrary.jsx): the window's state and what each control
// does. Choose: what should go in the library, by source and app, ticked where main found the app; ticking is the
// consent (a connector's sign-in, macOS's Apple Notes prompt, a folder for a local app that was not found, a web app's
// sign-in checked and, when no browser holds it, opened by itself in the sign-in chain). Refine: one continuous chat
// with the librarian (src/main/connect), its questions as cards. Working: every import and MEMORY.md, with Stop.
//
// `mode` onboarding (a page of the window: `onContinue` moves on, the work going on in the background) or popup
// (`onClose` puts it away). React's effects are didSet hooks here: `picksChanged` (the browser wait ended for a group no
// longer ticked; the folders asked about when PDFs or a repository is ticked), `gateCheck` (the run starts once nothing
// is left to sign in).

/// How the screen is told to behave and what it reports (ConnectLibrary's props).
public struct ConnectLibraryContext {
    public enum Mode: String, Sendable { case onboarding, popup }
    public var mode: Mode
    /// A session to show again (the dock's).
    public var sessionId: String?
    /// The project an existing user's notes go into, and the workspace open there (what comes in joins it too).
    public var projectId: String?
    public var workspaceId: String?
    /// What the librarian is told the project is (onboarding sends it without an id).
    public var project: (name: String, description: String)?
    public var onSession: (String) -> Void = { _ in }
    public var onContinue: () -> Void = {}
    public var onClose: () -> Void = {}
    public var onSkip: () -> Void = {}
    public var onAdded: (JSONValue) -> Void = { _ in }
    /// The chat's back arrow for a session Import your context started: the session stops and that flow's tools screen
    /// comes back, not this window's choose screen.
    public var onBack: (() -> Void)?
    /// Onboarding's GitHub repository list (Integrations' GithubReposView: `held`, `toggle`, the repo being added), for
    /// Code's GitHub row and the librarian's "which repositories" card. Without it a plain list from githubRepos is drawn.
    public var githubRepos: ((_ held: @escaping (JSONValue) -> Bool, _ toggle: @escaping (JSONValue) -> Void, _ busyId: String) -> AnyView)?
    /// The pager under onboarding's page (its dots and "2 of 3"), when the host draws one.
    public var pager: AnyView?
    public init(mode: Mode, sessionId: String? = nil, projectId: String? = nil, workspaceId: String? = nil, project: (name: String, description: String)? = nil) {
        self.mode = mode; self.sessionId = sessionId; self.projectId = projectId; self.workspaceId = workspaceId; self.project = project
    }
}

@MainActor
public final class ConnectLibraryModel: ObservableObject {
    public let api: ImportAPI
    public var context: ConnectLibraryContext
    public var popup: Bool { context.mode == .popup }
    public var page: Bool { !popup }

    @Published public private(set) var view: String
    @Published public private(set) var found: JSONValue?
    @Published public var picks: Picks? { didSet { if picks != oldValue { picksChanged(oldValue) } } }
    @Published public var folders: [String: [String]] = ["papers": [], "code": []]
    /// "Use my … subscription to read these": files and the browser.
    @Published public private(set) var consent = true
    @Published public var days: Int? = ConnectSources.defaultPeriodDays
    @Published public var appFolders: [String: String] = [:]
    @Published public var extraRepos: [String] = []
    @Published public var repoCount: Int?
    @Published public var openRows: [String: Bool] = [:]
    @Published public var leaves = false
    @Published public var notesState = ""
    @Published public var connectorStatus: [String: JSONValue] = [:]
    @Published public var signIns: [String: SignIn] = [:] { didSet { if signIns != oldValue { gateCheck() } } }
    @Published public var waitingYes: [String: [YesRow]] = [:]
    @Published public var profileChoice: [String: Int] = [:]
    @Published public var keychainRun: (browser: String, rows: [SourceApp])?
    @Published public var gate: String? { didSet { if gate != oldValue { gateCheck() } } }
    @Published public var folderAsk: (folders: [GuardedFolder], papers: Bool, then: String?)?
    @Published public var folderRun: (folders: [GuardedFolder], asking: Bool, answers: [String: String]?)?
    var foldersDeclined = false
    @Published public private(set) var providers: [JSONValue]?
    @Published public private(set) var provider: String?
    @Published public private(set) var toolSnap: JSONValue?
    @Published public private(set) var session: JSONValue? { didSet { if J.str(session?["id"]) != J.str(oldValue?["id"]) { markShown(J.str(oldValue?["id"]), J.str(session?["id"])) } } }
    @Published public var draft = ""
    @Published public var error = ""
    @Published public private(set) var authorizing = false
    @Published public private(set) var library: [JSONValue] = []
    @Published public private(set) var busyRepo = ""
    var addedRepos = Set<String>()
    var idRef: String?
    private var tokens: [EventHub.Token] = []
    private var lastFolderKey: String??
    private var lastWindow: (id: Int, group: [String])?
    private var modalAnswer: (group: [String], resolve: CheckedContinuation<String, Never>)?
    private lazy var chain = SignInWindows(
        pick: { [unowned self] rows in ConnectModel.signInChain(rows, signIns: self.signIns, state: self.picks, consent: self.consent) },
        open: { [unowned self] row in
            await Task.yield()
            let out = await self.signInHere(row.id, row.app, chained: true)
            await Task.yield()
            return out
        })
    /// Sessions this window shows (the dock leaves them alone).
    let openSessions: OpenSessions

    public init(api: ImportAPI, context: ConnectLibraryContext, openSessions: OpenSessions? = nil) {
        self.api = api; self.context = context; self.openSessions = openSessions ?? .shared
        view = context.sessionId == nil ? "choose" : "loading"
        idRef = context.sessionId
    }

    func fail(_ failure: Error) { error = tidyError(failure) }

    // MARK: opening

    public func start() async {
        tokens.append(api.events.on("engelbart:connect") { [weak self] snapshot in Task { @MainActor in if let self, J.str(snapshot["id"]) == self.idRef, !J.str(snapshot["id"]).isEmpty { self.session = snapshot } } })
        tokens.append(api.events.on("engelbart:connectors") { [weak self] status in Task { @MainActor in if let app = status["app"]?.string { self?.connectorStatus[app] = status } } })
        tokens.append(api.events.on("engelbart:library-changed") { [weak self] _ in Task { @MainActor in await self?.readLibrary() } })
        tokens.append(api.events.on("engelbart:tools") { [weak self] snapshot in Task { @MainActor in if snapshot["tools"] != nil { self?.toolSnap = snapshot; await self?.readProviders() } } })
        if let snap = try? await api.tools() { toolSnap = snap }
        await readProviders()
        await readLibrary()
        if let id = context.sessionId {
            do { show(try await api.connectState(id)) } catch { fail(error); view = "choose" }
        } else if !popup {
            // Onboarding again after Engelbart closed in the middle of it: the session that picked up where it was is shown.
            if let list = try? await api.connectList(), let going = ConnectModel.resumable(list) { show(going); context.onSession(J.str(going["id"])) } else { await choose() }
        } else {
            await choose()
        }
    }

    public func stop() {
        tokens.forEach { api.events.off($0) }; tokens = []
        if let id = session?["id"]?.string { openSessions.mark(id, false) }
    }

    func show(_ snapshot: JSONValue) {
        idRef = J.str(snapshot["id"])
        session = snapshot
        view = J.truthy(snapshot["finished"]) ? "working" : "chat"
        let id = J.str(snapshot["id"])
        Task { try? await api.connectMinimize(id, false) }
    }

    func choose() async {
        do {
            let value = try await api.detect()
            found = value
            picks = ConnectModel.initialPicks(value)
            if J.truthy(value["github"]?["found"]) { await countRepos() }
        } catch { fail(error); picks = ConnectModel.initialPicks(nil) }
        if let list = try? await api.connectConnectors() {
            for entry in list { if let app = entry["app"]?.string { connectorStatus[app] = entry } }
        }
    }

    func markShown(_ old: String, _ new: String) {
        if !old.isEmpty { openSessions.mark(old, false) }
        if !new.isEmpty { openSessions.mark(new, true) }
    }

    func readLibrary() async { if let rows = try? await api.library() { library = rows } }
    func readProviders() async {
        guard let list = try? await api.connectProviders() else { return }
        providers = list
        let ready = list.filter { J.truthy($0["ready"]) }
        if !(provider != nil && ready.contains { J.str($0["provider"]) == provider }) { provider = ready.first.map { J.str($0["provider"]) } }
    }
    func countRepos() async { if let value = try? await api.githubRepos() { repoCount = J.arr(value["repos"]).count } }

    /// The index of the chat's last turn (the librarian's or the person's): not the opening line, a notice or the grant.
    public nonisolated static func lastTurn(_ chat: [JSONValue]) -> Int {
        for i in stride(from: chat.count - 1, through: 0, by: -1) {
            let item = chat[i]
            if !J.truthy(item["opener"]) && !J.truthy(item["notice"]) && !J.truthy(item["grant"]) { return i }
        }
        return -1
    }

    // MARK: the choose screen

    public var localRepos: [JSONValue] { J.arr(found?["localRepos"]) }
    func repoPaths() -> [String] { localRepos.map { J.str($0["path"]) } + extraRepos }
    public func setRow(_ id: String, _ row: String, _ on: Bool) { if let p = picks { picks = ConnectModel.tickRow(p, id, row, on, repos: repoPaths()) } }
    public func toggleGroup(_ id: String) { guard let p = picks else { return }; let next = ConnectModel.tickGroup(p, id, found); picks = next; Task { await checkTicked(ConnectModel.newlyTickedWeb(p, next)) } }
    public func toggleAll(_ on: Bool) { guard let p = picks else { return }; let next = ConnectModel.tickAll(p, found, on); picks = next; Task { await checkTicked(ConnectModel.newlyTickedWeb(p, next)) } }
    public func expand(_ id: String) { picks?.open[id] = !(picks?.open[id] ?? false) }
    public var allOn: Bool { ConnectModel.allPicked(picks, found) }
    public var anyOn: Bool { picks.map { p in ConnectModel.sources.contains { p.picks[$0.id] == true } } ?? false }

    /// A row ticked or unticked: ticking is the consent (MATH-114).
    public func toggleApp(_ id: String, _ app: String) async {
        let on = ConnectModel.ticked(picks, id, app)
        let spec = ConnectSources.appOf(app)
        let seen = found?["apps"]?[app]
        error = ""
        if on {
            setRow(id, app, false)
            if spec?.reach == .connector && J.truthy(connectorStatus[app]?["pending"]) { try? await api.connectConnectorCancel(app) }
            return
        }
        if spec?.reach == .local && !J.truthy(seen?["found"]) && appFolders[app] == nil {
            guard let chosen = await api.pickDirectory() else { return }
            appFolders[app] = chosen
            setRow(id, app, true)
            return
        }
        setRow(id, app, true)
        switch spec?.reach {
        case .connector? where !J.truthy(connectorStatus[app]?["connected"]): if !(await connectorSignIn(app)) { setRow(id, app, false) }
        case .automation? where notesState != "allowed": if !(await allowNotes()) { setRow(id, app, false) }
        case .signin? where !J.truthy(seen?["found"]):
            var done = false
            do { done = try await api.engelbartSignIn(app) } catch { fail(error) }
            if done { found = (found ?? [:]).with("apps", (found?["apps"] ?? [:]).with(app, (seen ?? [:]).with("found", true).with("where", "signed in"))) } else { setRow(id, app, false) }
        case .web?: await checkTicked([SourceApp(id: id, app: app)])
        default: break
        }
    }

    /// A web app's sign-in checked when ticked (2026-10-10); `open`: a row just ticked that no browser signs in gets its
    /// sign-in opened by itself, in the chain.
    func checkSignIn(_ row: SourceApp, retry: Bool = false, open: Bool = false) async {
        signIns[row.app] = SignIn(status: "checking")
        do {
            let out = try await api.connectSignInCheck(row.app, retry: retry)
            guard let answer = SignIn(json: out) else { signIns[row.app] = nil; return }
            signIns[row.app] = answer
            if ConnectModel.opensSignIn(answer.status, fresh: open, consent: consent, still: ConnectModel.ticked(picks, row.id, row.app)) { Task { await chain.turnedDown([row]) } }
        } catch { signIns[row.app] = nil }
    }

    /// The modal comes first when macOS will be asked, or when more than one profile holds the sign-in.
    static func asksFirst(_ said: JSONValue) -> Bool {
        let browser = J.str(said["browser"])
        return (!J.str(said["note"]).isEmpty && !browser.isEmpty) || (!browser.isEmpty && J.arr(said["profiles"]).count > 1)
    }
    static func yesInput(_ row: SourceApp, _ said: JSONValue, route: String? = nil) -> YesInput {
        YesInput(id: row.id, app: row.app, browser: J.str(said["browser"]), note: said["note"]?.string, profiles: J.arr(said["profiles"]).map(SignInProfile.init(json:)), route: route)
    }

    func checkTicked(_ ticks: [SourceApp]) async {
        // One signed in already, or whose sign-in is open already, is not checked again.
        let rows = ticks.filter { !["signed-in", "signing", "browser"].contains(signIns[$0.app]?.status ?? "") }
        if ConnectModel.signInsToCheck(consent, rows).isEmpty { return }
        var said: [(SourceApp, JSONValue)] = []
        for row in rows { said.append((row, (try? await api.connectSignInNote(row.app, route: nil)) ?? ["note": ""])) }
        if !consent { return } // turned off meanwhile: no panel, no check
        let ask = said.filter { Self.asksFirst($0.1) }
        if !ask.isEmpty { waitingYes = ConnectModel.waitForYes(waitingYes, ask.map { Self.yesInput($0.0, $0.1) }) }
        for (row, out) in said where !Self.asksFirst(out) { Task { await checkSignIn(row, open: true) } }
    }

    /// The Keychain modal's Continue: one macOS prompt for the browser; the apps waiting on it are checked; Google's rows
    /// asked for from Sign in go on to its sign-in in the person's browser.
    public func allowSignIns(_ browser: String) async {
        let waiting = waitingYes[browser] ?? []
        let panel = ConnectModel.signInPanel(picks, browser, waiting, profileChoice[browser] ?? 0)
        waitingYes[browser] = nil
        profileChoice[browser] = nil
        guard let panel else { answerChain(waiting.map(\.row), "dropped"); return }
        let pick = panel.chosen >= 0 ? panel.profiles[panel.chosen] : nil
        if let pick {
            for row in panel.rows where row.profiles.contains(where: { $0.browserId == pick.browserId && $0.profileId == pick.profileId }) {
                try? await api.connectSignInPick(row.app, browser: pick.browserId, profile: pick.profileId)
            }
        }
        let checked = panel.rows.filter { $0.route != "browser" }.map(\.row)
        let viaBrowser = panel.rows.filter { $0.route == "browser" }.map(\.row)
        let from = pick?.browser ?? browser
        if !panel.lead.isEmpty && !(checked.isEmpty && viaBrowser.isEmpty) { keychainRun = (from, checked + viaBrowser) }
        for row in checked { Task { await checkSignIn(row, open: true) } }
        if viaBrowser.isEmpty { return }
        if !panel.lead.isEmpty {
            let first = viaBrowser[0]
            let group = ConnectSources.sharesSignIn(first.app)
            var next = signIns
            for other in group { let now = next[other]; next[other] = SignIn(status: "checking", was: now != nil && now!.status != "checking" ? now : now?.was) }
            signIns = next
            let out = (try? await api.connectSignInUnlock(first.app)) ?? ["status": "allowed", "browser": ""]
            if J.str(out["status"]) == "refused" {
                var refused = signIns
                for other in group { refused[other] = SignIn(status: "refused", browser: J.str(out["browser"]).isEmpty ? from : J.str(out["browser"])) }
                signIns = refused
                Task { await chain.turnedDown(viaBrowser) }
                answerChain(viaBrowser, "declined")
                return
            }
            // Allowed: the modal leaves these rows to the row's own waiting line.
            if let run = keychainRun {
                let rows = run.rows.filter { r in !viaBrowser.contains { $0.app == r.app } }
                keychainRun = rows.isEmpty ? nil : (run.browser, rows)
            }
        }
        for row in viaBrowser { Task { _ = await browserSignIn(row.id, row.app, opens: "", chained: true) } }
        answerChain(viaBrowser, "browser")
    }

    /// Use another account (2026-10-12): Google's add-an-account page in the browser the sign-in is waited for in.
    public func anotherAccount(_ app: String) { Task { try? await api.connectSignInAnotherAccount(app) } }

    /// Not now: the apps stay ticked, each row offering Sign in in Engelbart's own window.
    public func declineSignIns(_ browser: String) {
        let rows = (waitingYes[browser] ?? []).map(\.row)
        waitingYes[browser] = nil
        profileChoice[browser] = nil
        var next = signIns
        for row in rows { for other in ConnectSources.sharesSignIn(row.app) where next[other]?.status != "signed-in" { next[other] = SignIn(status: "declined") } }
        signIns = next
        Task { await chain.turnedDown(rows) }
        answerChain(rows, "declined")
    }

    func answerChain(_ rows: [SourceApp], _ out: String) {
        guard let wait = modalAnswer, rows.contains(where: { wait.group.contains($0.app) }) else { return }
        modalAnswer = nil
        wait.resolve.resume(returning: out)
    }

    /// Try again: ticked again, and checked again only with the consent on; Google having turned the window away, the window.
    public func retrySignIn(_ id: String, _ app: String) async {
        if signIns[app]?.status == "rejected" { _ = await signInWindowHere(id, app); return }
        setRow(id, app, true)
        let rows = ConnectModel.signInsToCheck(consent, [SourceApp(id: id, app: app)])
        if let was = signIns[app], !rows.isEmpty, was.status == "refused", !was.browser.isEmpty { keychainRun = (was.browser, rows) }
        for row in rows { await checkSignIn(row, retry: true) }
    }

    /// Sign in: Google's on the Mac waits in the person's browser (until they turn its sign-ins down); every other is
    /// Engelbart's own window.
    public func signInHere(_ id: String, _ app: String, chained: Bool = false) async -> String {
        ConnectModel.signsInViaBrowser(app, signIns[app], platform: found?["platform"]?.string) ? await signInInBrowser(id, app, chained: chained) : await signInWindowHere(id, app)
    }

    /// Engelbart's sign-in window → 'signed-in' | 'rejected' | 'replaced' | 'closed' (the person's no: the group unticked).
    public func signInWindowHere(_ id: String, _ app: String) async -> String {
        let now = signIns[app]
        let before = now != nil && !["signing", "browser"].contains(now!.status) ? now : now?.was
        signIns[app] = SignIn(status: "signing", was: before)
        setRow(id, app, true)
        // Another open() for the same sign-in shares the window (and its answer); another app's replaces it.
        if !(lastWindow?.group.contains(app) ?? false) { windowCount += 1; lastWindow = (windowCount, ConnectSources.sharesSignIn(app)) }
        let ours = lastWindow?.id
        let out = try? await api.connectSignInWindow(app)
        let status = J.str(out?["status"])
        if status == "signed-in" {
            var next = signIns
            for other in ConnectSources.sharesSignIn(app) { next[other] = SignIn(status: "signed-in") }
            signIns = next
            return "signed-in"
        }
        if status == "rejected" {
            var next = signIns
            for other in ConnectSources.sharesSignIn(app) where next[other]?.status != "signed-in" { next[other] = SignIn(status: "rejected") }
            signIns = next
            return "rejected"
        }
        if lastWindow?.id != ours {
            if let back = ConnectModel.afterSignInWindowClosed(signIns[app]?.was) { signIns[app] = back } else { signIns[app] = nil }
            return "replaced"
        }
        picks = ConnectModel.signInWindowClosed(picks, app).state
        signIns = ConnectModel.signInWindowClosed(nil, app, signIns).signIns
        return "closed"
    }
    private var windowCount = 0

    /// "Sign in here instead": the browser wait ends, and Engelbart's window opens.
    public func hereInstead(_ id: String, _ app: String) async {
        var next = signIns
        for other in ConnectSources.sharesSignIn(app) where other != app && next[other]?.status == "browser" { next[other] = next[other]?.was }
        signIns = next
        try? await api.connectSignInBrowserCancel(app)
        _ = await signInWindowHere(id, app)
    }

    /// Google's Sign in: its page in the person's browser, copied once made there; the modal first when macOS will be asked.
    func signInInBrowser(_ id: String, _ app: String, chained: Bool) async -> String {
        let said = (try? await api.connectSignInNote(app, route: "browser")) ?? [:]
        let opens = J.str(said["opens"])
        if opens.isEmpty { return await signInWindowHere(id, app) }
        if Self.asksFirst(said) {
            setRow(id, app, true)
            if chained {
                return await withCheckedContinuation { c in
                    modalAnswer = (ConnectSources.sharesSignIn(app), c)
                    waitingYes = ConnectModel.waitForYes(waitingYes, [Self.yesInput(SourceApp(id: id, app: app), said, route: "browser")])
                }
            }
            waitingYes = ConnectModel.waitForYes(waitingYes, [Self.yesInput(SourceApp(id: id, app: app), said, route: "browser")])
            return "asked"
        }
        if !chained { return await browserSignIn(id, app, opens: opens, chained: false) }
        Task { _ = await browserSignIn(id, app, opens: opens, chained: true) }
        return "browser"
    }

    /// Every ticked Google row waits on the one sign-in, and turns ✓ with it.
    func browserSignIn(_ id: String, _ app: String, opens: String, chained: Bool) async -> String {
        let group = ConnectSources.sharesSignIn(app)
        var opensIn = opens
        if opensIn.isEmpty { opensIn = J.str((try? await api.connectSignInNote(app, route: "browser"))?["opens"]) }
        setRow(id, app, true)
        var next = signIns
        for other in group { let now = next[other]; next[other] = SignIn(status: "browser", browser: opensIn, was: now != nil && now!.status != "browser" ? now : now?.was) }
        signIns = next
        let out = try? await api.connectSignInBrowser(app)
        let status = J.str(out?["status"])
        func back() {
            var n = signIns
            for other in group where n[other]?.status == "browser" { n[other] = n[other]?.was }
            signIns = n
        }
        if status == "signed-in" {
            var n = signIns
            for other in group { n[other] = SignIn(status: "signed-in", browser: J.str(out?["browser"]), profile: out?["profile"]?.string) }
            signIns = n
            return "signed-in"
        }
        if status == "refused" {
            var n = signIns
            for other in group { n[other] = SignIn(status: "refused", browser: J.str(out?["browser"])) }
            signIns = n
            if chained { Task { await chain.turnedDown([SourceApp(id: id, app: app)]) } }
            return "refused"
        }
        if status == "no-browser" { back(); return await signInWindowHere(id, app) }
        back()
        return "closed"
    }

    func groupRows(_ app: String) -> [SourceApp] {
        ConnectModel.sources.flatMap { source in source.apps.filter { ConnectSources.sharesSignIn(app).contains($0) }.map { SourceApp(id: source.id, app: $0) } }
    }

    // The browser wait ends once no row of its sign-in is ticked; so does the chain's wait on a modal for a group no longer
    // ticked. And the folders macOS guards are asked about when PDFs (with the consent) or a repository is ticked.
    func picksChanged(_ old: Picks?) {
        guard let picks else { return }
        for (app, s) in signIns where s.status == "browser" {
            if !groupRows(app).contains(where: { ConnectModel.ticked(picks, $0.id, $0.app) }) { Task { try? await api.connectSignInBrowserCancel(app) } }
        }
        if let wait = modalAnswer, !groupRows(wait.group[0]).contains(where: { ConnectModel.ticked(picks, $0.id, $0.app) }) { answerChain(groupRows(wait.group[0]), "dropped") }
        folderKeyChanged()
        gateCheck()
    }

    func folderKey() -> String? {
        guard let picks else { return nil }
        return "\(ConnectModel.ticked(picks, "papers", ConnectModel.localPDFs) && consent)|\(ConnectModel.localPicked(picks).joined(separator: ","))"
    }
    func folderKeyChanged() {
        guard let key = folderKey(), view == "choose" else { return }
        guard let last = lastFolderKey else { lastFolderKey = .some(key); return }
        if last == key { return }
        lastFolderKey = .some(key)
        if folderAsk == nil && !(folderRun?.asking ?? false) { Task { _ = await askFolders(picks, then: nil) } }
    }

    /// The consent turned off: no sign-in is checked, and the panels waiting for a yes go (2026-10-11 review).
    public func toggleConsent() {
        consent.toggle()
        waitingYes = ConnectModel.waitingWhile(consent, waitingYes)
        if !consent, let wait = modalAnswer { answerChain(groupRows(wait.group[0]), "dropped") }
        folderKeyChanged()
    }

    public func pickPapers() async {
        guard let chosen = await api.pickDirectory() else { return }
        folders["papers"] = [chosen]
        setRow("papers", ConnectModel.localPDFs, true)
    }
    public func pickRepo() async {
        guard let chosen = await api.pickDirectory() else { return }
        if !localRepos.contains(where: { J.str($0["path"]) == chosen }) && !extraRepos.contains(chosen) { extraRepos.append(chosen) }
        if let p = picks { picks = ConnectModel.tickRepo(p, chosen, true) }
        openRows[ConnectModel.localRepos] = true
    }
    public func dropRepo(_ dir: String) {
        extraRepos.removeAll { $0 == dir }
        guard var p = picks else { return }
        p.local.remove(dir)
        picks = ConnectModel.tickRepo(p, dir, false)
        picks?.local.remove(dir)
    }
    public func toggleLocalRepo(_ path: String) { if let p = picks { picks = ConnectModel.tickRepo(p, path, !p.local[path]) } }

    // GitHub's repositories, as onboarding's step adds them: ticked is in the library now, unticked goes again if this added it.
    public func heldRepo(_ repo: JSONValue) -> JSONValue? {
        let url = J.str(repo["url"]), full = J.str(repo["fullName"]).lowercased()
        return library.first { row in J.str(row["url"]) == url || J.str(row["name"]).lowercased() == full || J.str(row["path"]).lowercased().hasSuffix(full) }
    }
    public func toggleRepo(_ repo: JSONValue) async {
        busyRepo = J.str(repo["id"])
        defer { busyRepo = "" }
        if let row = heldRepo(repo) {
            let id = J.str(row["id"])
            if addedRepos.contains(id), (try? await api.discardLibraryItem(id)) == true { addedRepos.remove(id) }
        } else {
            do { let added = try await api.addLibraryItem(J.str(repo["url"])); addedRepos.insert(J.str(added["id"])); context.onAdded(added) }
            catch { let said = tidyError(error); if !said.hasPrefix("Already") { self.error = said } }
            setRow("code", "GitHub", true)
        }
        await readLibrary()
    }
    func reposTicked() -> [String] { library.filter { addedRepos.contains(J.str($0["id"])) }.map { J.str($0["name"]) } }

    func allowNotes() async -> Bool {
        notesState = "asking"
        let out: JSONValue
        do { out = try await api.notesPermission() } catch { out = ["allowed": false, "error": .string(tidyError(error))] }
        let why = J.str(out["error"]).isEmpty ? "macOS did not allow it" : J.str(out["error"])
        notesState = J.truthy(out["allowed"]) ? "allowed" : why
        if !J.truthy(out["allowed"]) { error = "Apple Notes: \(why)" }
        return J.truthy(out["allowed"])
    }
    func connectorSignIn(_ app: String) async -> Bool {
        connectorStatus[app] = (connectorStatus[app] ?? [:]).with("pending", true)
        do {
            let status = try await api.connectConnectorSignIn(app)
            connectorStatus[app] = status
            return J.truthy(status["connected"])
        } catch {
            connectorStatus[app] = (connectorStatus[app] ?? [:]).with("pending", false)
            fail(error)
            return false
        }
    }

    // MARK: the choices, the folders and the start

    func chosenOf(_ state: Picks) -> [String: [String]] {
        var chosen: [String: [String]] = ["papers": folders["papers"] ?? [], "code": ConnectModel.localPicked(state)]
        for source in ConnectModel.sources {
            for app in source.apps where appFolders[app] != nil && ConnectModel.ticked(state, source.id, app) && app != ConnectModel.localPDFs {
                chosen[source.id, default: []].append(appFolders[app]!)
            }
        }
        if !ConnectModel.ticked(state, "papers", ConnectModel.localPDFs) { chosen["papers"] = [] }
        else if let own = appFolders[ConnectModel.localPDFs], !(chosen["papers"] ?? []).contains(own) { chosen["papers", default: []].append(own) }
        return chosen
    }
    func pickedDirs() -> [String] { (folders["papers"] ?? []) + Array(appFolders.values) + extraRepos }
    public func choicesFor(_ state: Picks) -> JSONValue {
        let permissions = ConnectModel.permissionsOf(state, consent: consent, notes: notesState == "allowed")
        return ConnectModel.choicesOf(picks: state.picks, apps: state.apps, folders: chosenOf(state), repos: reposTicked(), picked: pickedDirs(),
                                      permissions: ["files": permissions.files, "browser": permissions.browser, "recall": permissions.recall, "notes": permissions.notes],
                                      provider: provider, projectId: context.projectId, workspaceId: context.workspaceId, project: context.project, days: days)
    }

    /// MATH-110: the protected folders a run with these picks would read and macOS was never asked about: one modal says
    /// so first. Not now, once, holds for this screen. → shown or not.
    func askFolders(_ state: Picks?, then: String?) async -> Bool {
        guard let state, !foldersDeclined else { return false }
        let list = (try? await api.foldersNeeded(choicesFor(state))) ?? []
        if list.isEmpty || foldersDeclined { return false }
        folderAsk = (list.map { GuardedFolder(id: J.str($0["id"]), name: J.str($0["name"])) }, ConnectModel.ticked(state, "papers", ConnectModel.localPDFs) && consent, then)
        return true
    }
    /// "Ask macOS": each folder read in turn, so macOS asks about them one after another; the PDFs row says how it went.
    public func allowFolders() async {
        guard let asked = folderAsk else { return }
        folderAsk = nil
        folderRun = (asked.folders, true, nil)
        var answers: [String: String] = [:]
        do { answers = try await api.foldersAsk(asked.folders.map(\.id)) } catch { fail(error) }
        folderRun = (asked.folders, false, answers)
        if asked.then == "start" { await bringIn(foldersDone: true) }
    }
    /// Not now: the row stays ticked; the run reads only the PDF folders macOS does not guard.
    public func declineFolders() async {
        let asked = folderAsk
        foldersDeclined = true
        folderAsk = nil
        if asked?.then == "start" { await bringIn(foldersDone: true) }
    }

    /// Bring these in / Refine: ticked web apps not signed in get one modal first (2026-10-11).
    public func bringIn(foldersDone: Bool = false) async {
        guard anyOn else { error = "Pick at least one source."; return }
        guard provider != nil else { error = "Sign in to Claude Code or Codex first."; return }
        if !foldersDone && !(folderRun?.asking ?? false), await askFolders(picks, then: "start") { return }
        if !ConnectModel.unsignedWeb(picks, signIns, found, consent).isEmpty { gate = "ask"; return }
        await launch()
    }
    func gateNext() -> SourceApp? { ConnectModel.unsignedWeb(picks, signIns, found, consent).first { signIns[$0.app]?.status != "browser" } }
    public var gateView: SignInGate? {
        guard let gate, gate != "leave" else { return nil }
        return ConnectModel.signInGate(ConnectModel.unsignedWeb(picks, signIns, found, consent), signIns, platform: found?["platform"]?.string)
    }
    public var gateCanSignIn: Bool { (gateView?.canSignIn ?? false) && gateNext() != nil }
    /// The gate's Sign in: the first app still not signed in and not waited for in the browser.
    public func gateSignIn() async {
        guard let first = gateNext() else { return }
        gate = "signing"
        _ = await signInHere(first.id, first.app)
        if gate == "signing" { gate = "ask" }
    }
    /// Leave them out: unticked, then the run starts.
    public func gateLeave() {
        Task { try? await api.connectSignInWindowClose() }
        let rows = ConnectModel.unsignedWeb(picks, signIns, found, consent)
        if let p = picks { picks = rows.reduce(p) { ConnectModel.tickRow($0, $1.id, $1.app, false) } }
        gate = "leave"
    }
    public func gateClose() { Task { try? await api.connectSignInWindowClose() }; gate = nil }
    private var launching = false
    func gateCheck() {
        guard let g = gate, g != "signing" else { return }
        if g == "leave" || ConnectModel.unsignedWeb(picks, signIns, found, consent).isEmpty {
            gate = nil
            Task { await launch() }
        }
    }

    func launch() async {
        guard !launching else { return }
        guard anyOn, let picks else { error = "Pick at least one source."; return }
        guard provider != nil else { error = "Sign in to Claude Code or Codex first."; return }
        error = ""
        launching = true
        defer { launching = false }
        do {
            let snapshot = try await api.connectStart(choicesFor(picks))
            idRef = J.str(snapshot["id"])
            session = snapshot
            context.onSession(J.str(snapshot["id"]))
            leaveChoose()
            view = "chat"
        } catch { fail(error) }
    }

    /// The sign-in window goes with the choose screen, and so does a wait in the person's browser.
    func leaveChoose() {
        Task { try? await api.connectSignInWindowClose(); try? await api.connectSignInBrowserCancel(nil) }
    }

    // MARK: the chat

    public func reply(_ input: JSONValue) async {
        guard let session, !J.truthy(session["thinking"]) else { return }
        error = ""
        do { self.session = try await api.connectAnswer(J.str(session["id"]), input); draft = "" } catch { fail(error) }
    }
    public func sendDraft() async { let text = draft.trimmingCharacters(in: .whitespacesAndNewlines); if !text.isEmpty { await reply(["text": .string(text)]) } }
    public func useAuthorize(_ authorize: JSONValue) async {
        guard let id = session?["id"]?.string else { return }
        error = ""
        authorizing = true
        defer { authorizing = false }
        let app = J.str(authorize["app"]), kind = J.str(authorize["kind"])
        do {
            if kind == "signin" {
                guard try await api.engelbartSignIn(app) else { return }
                session = try await api.connectAuthorize(id, app: app, kind: "signin", path: nil)
            } else if kind == "folder" {
                guard let chosen = await api.pickDirectory() else { return }
                session = try await api.connectAuthorize(id, app: app, kind: "folder", path: chosen)
            } else {
                session = try await api.connectAuthorize(id, app: app, kind: kind, path: nil)
            }
        } catch { fail(error) }
    }
    public func cancelAuthorize(_ authorize: JSONValue) { guard let id = session?["id"]?.string else { return }; Task { try? await api.connectCancelSignIn(id, J.str(authorize["app"])) } }
    public func openNeed(_ need: JSONValue) async {
        guard let id = session?["id"]?.string else { return }
        error = ""
        let app = J.str(need["app"])
        do {
            if app == "Zotero" || app == "GitHub" {
                if try await api.engelbartSignIn(app) { session = try await api.connectNeed(id, J.str(need["id"]), "done") }
                return
            }
            session = try await api.connectNeed(id, J.str(need["id"]), "open")
        } catch { fail(error) }
    }
    public func needSkip(_ need: JSONValue) async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectNeed(id, J.str(need["id"]), "skip") } catch { fail(error) }
    }
    /// "Grant access" on the librarian's first message (2026-10-16): the apps ticked are allowed, the rest left out.
    public func grantApps(_ apps: [String]) async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectGrant(id, apps: apps) } catch { fail(error) }
    }
    public func pickProvider(_ next: String) async {
        provider = next
        if let id = session?["id"]?.string { do { session = try await api.connectProvider(id, next) } catch { fail(error) } }
    }
    public func importNow() async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectImport(id); view = "working" } catch { fail(error) }
    }
    /// "Finish in background" on the onboarding page (2026-10-16): Import, then straight on to the project.
    public func finishInBackground() async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectImport(id); putAway() } catch { fail(error) }
    }
    /// The back arrow: Import your context's manual run stops, is dismissed and returns; else this window's choose screen.
    public func back() async {
        if let onBack = context.onBack {
            if let id = session?["id"]?.string { _ = try? await api.connectStop(id); try? await api.connectDismiss(id) }
            onBack()
            return
        }
        if let id = session?["id"]?.string { _ = try? await api.connectStop(id) }
        idRef = nil
        session = nil
        view = "choose"
        lastFolderKey = nil
        if picks == nil { await choose() }
    }
    /// Put away: the work goes on in the background, the dock showing it. Onboarding moves on.
    public func putAway() {
        if let id = session?["id"]?.string { Task { try? await api.connectMinimize(id, true) } }
        if popup { context.onClose() } else { context.onContinue() }
    }
    /// The popup's ×: put away, or Not now before anything began.
    public func close() { if session != nil { putAway() } else { context.onSkip() } }
    public func stopJob(_ job: JSONValue) async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectStopJob(id, J.str(job["id"])) } catch { fail(error) }
    }
    public func stopAll() async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectStop(id) } catch { fail(error) }
    }
    public func retryMemory() async {
        guard let id = session?["id"]?.string else { return }
        do { session = try await api.connectRetryMemory(id) } catch { fail(error) }
    }
    public func revealMemory() { let path = J.str(session?["memory"]?["path"]); Task { try? await api.reveal(path) } }
    /// The chat's Try again (the page).
    public func tryAgain() async { await reply(["text": "Try again."]) }
    /// The agent card's buttons (tools): Install, Update, Sign in, Cancel, Try again.
    public func toolAction(_ row: OnboardingHelpers.ToolRowView) async {
        error = ""
        do {
            switch row.action {
            case "install": try await api.toolsInstall([row.id])
            case "sign-in": try await api.toolsSignIn(row.id)
            case "cancel": try await api.toolsCancelSignIn(row.id)
            case "update": try await api.toolsUpdate(row.id)
            default: try await api.toolsCheck()
            }
        } catch { fail(error) }
    }

    // MARK: what the views read

    public var current: JSONValue? {
        let want = session?["provider"]?.string ?? provider
        return providers?.first { J.str($0["provider"]) == want }
    }
    public var targetName: String { current.map { J.str($0["name"]) } ?? "Claude Code" }
    /// Unknown until the list comes: no flash of "sign in first".
    public var ready: Bool { providers == nil || providers!.contains { J.truthy($0["ready"]) } }
    public var jobs: [JSONValue] { ConnectModel.workJobs(J.arr(session?["jobs"])) }
    public var needs: [JSONValue] { J.arr(session?["needs"]).filter { J.str($0["kind"]) != "consent" } }
    public var chat: [JSONValue] { J.arr(session?["chat"]) }
    public var last: Int { Self.lastTurn(chat) }
    public var spoke: Bool { chat.contains { !J.truthy($0["opener"]) && !J.truthy($0["grant"]) && !J.truthy($0["notice"]) } }
    public var running: Int { jobs.filter { !ConnectModel.statusOf($0).done }.count }
    public var done: Bool { J.truthy(session?["done"]) }
    /// Whether the chat's card at `index` may still be answered: the librarian's last word, not thinking, finished or stopped.
    public func live(_ index: Int) -> Bool {
        index == last && !J.truthy(session?["thinking"]) && !J.truthy(session?["finished"]) && !J.truthy(session?["stopped"])
    }
    /// Work still going (the working views' titles and Stop all).
    public var going: Bool { !J.truthy(session?["stopped"]) && (running > 0 || (session?["memory"] != nil && J.truthy(session?["memory"]) && !ConnectModel.memoryLine(session?["memory"]).done)) }
    /// The row label the choose screen shows for an app (folders, sign-ins, the PDFs' folder access).
    public func label(_ app: String, _ id: String = "") -> RowLabel {
        if app == ConnectModel.localPDFs, let run = folderRun, ConnectModel.ticked(picks, "papers", ConnectModel.localPDFs),
           let access = ConnectModel.folderAccessLabel(asking: run.asking, answers: run.answers, folders: run.folders) { return access }
        let keychainApps = keychainRun?.rows.flatMap { ConnectSources.sharesSignIn($0.app) } ?? []
        let folder = appFolders[app].map(Self.shown) ?? (app == ConnectModel.localPDFs && !(folders["papers"] ?? []).isEmpty ? Self.shown(folders["papers"]![0]) : "")
        return ConnectModel.rowLabel(app, found: found, connectors: connectorStatus, notes: notesState, folder: folder,
                                     signIn: id.isEmpty ? nil : ConnectModel.shownSignIn(picks, id, app, signIns), keychain: keychainApps.contains(app))
    }
    public var githubLabel: RowLabel {
        let github = found?["github"]
        guard J.truthy(github?["found"]) else { return RowLabel(text: ConnectModel.needsSignIn, tone: "muted") }
        let place = J.str(github?["where"]).isEmpty ? "signed in" : J.str(github?["where"])
        return RowLabel(text: "\(place)\(repoCount.map { " · \($0) repo\($0 == 1 ? "" : "s")" } ?? "")", tone: "")
    }
    /// The Keychain modal asking now (one browser at a time).
    public var asking: SignInPanel? {
        let shown = ConnectModel.waitingWhile(consent, waitingYes)
        return shown.keys.sorted().compactMap { ConnectModel.signInPanel(picks, $0, shown[$0]!, profileChoice[$0] ?? 0) }.first
    }
    public var keychainOutcome: KeychainOutcome? { keychainRun.map { ConnectModel.keychainOutcome($0.browser, $0.rows, signIns) } }
    public var folderShown: FolderPanel? { folderAsk.flatMap { ConnectModel.folderPanel($0.folders, papers: $0.papers) } }
    /// The browser a Google sign-in is waited for in (the gate's waiting line).
    public var inBrowser: String? { signIns.first { $0.value.status == "browser" }.map { ConnectModel.waitingIn(ConnectModel.signInName($0.key), $0.value.browser) } }
    public var reads: [String] { ConnectModel.consentFor(picks) }

    /// A path as the person reads it: ~ for the home folder.
    public static func shown(_ dir: String) -> String { dir.replacingOccurrences(of: #"^/Users/[^/]+"#, with: "~", options: .regularExpression) }

    /// The GitHub repository toggle the view's list sends.
    public func githubToggle() async {
        if ConnectModel.ticked(picks, "code", "GitHub") { setRow("code", "GitHub", false); return }
        setRow("code", "GitHub", true)
        if J.truthy(found?["github"]?["found"]) { return }
        error = ""
        var done = false
        do { done = try await api.engelbartSignIn("GitHub") } catch { fail(error) }
        if !done { setRow("code", "GitHub", false); return }
        found = (found ?? [:]).with("github", ["found": true, "where": "signed in"])
        await countRepos()
    }
    public func toggleLocal() async {
        let on = ConnectModel.localPicked(picks).count, all = repoPaths().count
        if on > 0 { setRow("code", ConnectModel.localRepos, false) }
        else if all > 0 { if let p = picks { picks = ConnectModel.tickRow(p, "code", ConnectModel.localRepos, true, repos: repoPaths()) } }
        else { await pickRepo() }
    }
    public var reposOn: Int { ConnectModel.localPicked(picks).count }
    public var reposAll: Int { repoPaths().count }
}

// MARK: the question card's and the grant's rules (ConnectLibrary.jsx QuestionCard, GrantCard)

public enum QuestionCardLogic {
    /// A tick: a "multi" toggles the option, a "single" holds one at most (pressed again, none).
    public static func pick(_ picks: [String], _ label: String, many: Bool) -> [String] {
        many ? (picks.contains(label) ? picks.filter { $0 != label } : picks + [label]) : (picks.contains(label) ? [] : [label])
    }
    /// Submit waits for a tick or the person's own words (an open question: words).
    public static func ready(kind: String, picks: [String], note: String) -> Bool {
        let words = !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return kind == "open" ? words : !picks.isEmpty || words
    }
    /// What Submit sends, or nil.
    public static func submit(kind: String, picks: [String], note: String) -> JSONValue? {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if kind == "open" { return text.isEmpty ? nil : ["text": .string(text)] }
        if !picks.isEmpty { var out: JSONValue = ["picked": .array(picks.map(JSONValue.string))]; if !text.isEmpty { out = out.with("text", .string(text)) }; return out }
        return text.isEmpty ? nil : ["text": .string(text)]
    }
}

public enum GrantLogic {
    /// "Select all" until every app is ticked, then "Deselect all".
    public static func allLabel(ids: [String], picks: [String]) -> String { !ids.isEmpty && ids.allSatisfy(picks.contains) ? "Deselect all" : "Select all" }
    public static func all(ids: [String], picks: [String]) -> [String] { allLabel(ids: ids, picks: picks) == "Deselect all" ? [] : ids }
    /// Answered, the card folds to one line of what was allowed.
    public static func answered(_ grant: JSONValue) -> String? {
        guard let answered = grant["answered"], J.truthy(answered) else { return nil }
        let allowed = J.strs(answered["allowed"])
        return allowed.isEmpty ? "Allowed none of them" : "Allowed \(listed(allowed))"
    }
}
