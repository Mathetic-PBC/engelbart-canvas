import EngelbartCore
import EngelbartIntegrations
import EngelbartStore
import EngelbartTools
import Foundation
import SwiftUI

// Onboarding (2026-09-28; port of src/renderer/screens/Onboarding.jsx): Claude Design "Onboarding.dc.html", Hudson's
// tweaks in design/onboarding/TWEAKS.md. mode 'new' (first launch), 'existing' (+ Project: create → context), or 'guided'
// (the guided setup started inside a project, 2026-10-10: a new user's screens without Create; after the last one `into`
// gets a Welcome workspace and opens on it). Everything is real: library rows are added as they are picked, the
// instructions are saved on Continue, and a new user's project is made past the last screen and opens on its Welcome
// workspace. Create comes before Connect (2026-10-10) so the librarian is told what the project is.

/// The CLIs and their accounts, as onboarding's Welcome asks about them (import-api.js, the tool manager).
public struct OnboardingAgents {
    /// importApi.providers(fresh): what each CLI says of its sign-in and subscription.
    public var providers: (_ fresh: Bool) async throws -> AgentProviders
    /// importApi.rememberProvider: the provider the popup's choice stands for.
    public var rememberProvider: (String) async -> Void
    /// api.toolsInstall (Git, in the background).
    public var toolsInstall: ([String]) async -> Void
    /// api.toolsUpdate (a qualifying CLI too old for Engelbart, in the background).
    public var toolsUpdate: (String) async -> Void

    public init(providers: @escaping (Bool) async throws -> AgentProviders, rememberProvider: @escaping (String) async -> Void,
                toolsInstall: @escaping ([String]) async -> Void, toolsUpdate: @escaping (String) async -> Void) {
        self.providers = providers; self.rememberProvider = rememberProvider; self.toolsInstall = toolsInstall; self.toolsUpdate = toolsUpdate
    }

    /// No CLI known: the gate waits for providers that never come (used where no agent can run).
    public static let none = OnboardingAgents(providers: { _ in AgentProviders(providers: []) }, rememberProvider: { _ in }, toolsInstall: { _ in }, toolsUpdate: { _ in })
}

/// Import your context (ImportUI's import/ImportFlow.jsx, mode 'new') across the window, in place of a new user's Create and
/// Connect your library (2026-10-13).
public struct ImportFlowRequest {
    public var platform: String
    /// It made the projects; the one to open, with the sign-in sites and its session.
    public var onDone: (Onboarded, OnboardedExtras) -> Void
    /// Import manually (From Amitav, 2026-10-15): the librarian's chat on the session the flow started.
    public var renderLibrarian: (LibrarianRequest) -> AnyView
}

public struct LibrarianRequest {
    public var sessionId: String?
    public var project: ProjectAbout?
    public var onDone: () -> Void
    public var onBack: (() -> Void)?
    public init(sessionId: String?, project: ProjectAbout?, onDone: @escaping () -> Void, onBack: (() -> Void)?) {
        self.sessionId = sessionId; self.project = project; self.onDone = onDone; self.onBack = onBack
    }
}

/// Connect your library (ImportUI's screens/ConnectLibrary.jsx, mode 'onboarding').
public struct ConnectLibraryRequest {
    public var sessionId: String?
    /// What the librarian is told the project is (never its id).
    public var project: ProjectAbout?
    /// The pager, drawn in its own foot beside its button.
    public var pager: PagerPosition?
    public var onSession: (String) -> Void
    public var onContinue: () -> Void
    public var onSkip: () -> Void
    public var onBack: (() -> Void)?
    /// A repository it added counts as one this onboarding added.
    public var onAdded: (LibraryRow) -> Void
}

/// The agent popup (ImportUI's import/AgentSetup.jsx): Claude Code, Codex or both.
public struct AgentSetupRequest {
    public var tools: ToolsSnapshot?
    public var providers: AgentProviders?
    /// 'claude' | 'codex' | 'both': one runs now.
    public var onDone: (String) -> Void
    public var onSkip: () -> Void
}

/// What the app hands onboarding (Onboarding.jsx props, plus the api calls it makes and the pieces other packages draw).
public struct OnboardingContext {
    public var mode: OnboardingMode
    /// The project the guided setup adds its Welcome workspace to.
    public var into: String?
    public var data: OnboardingData
    public var agents: OnboardingAgents
    /// 'install' | 'skip': what was answered about the tools (App.jsx onboardingTools).
    public var onTools: (String) -> Void
    /// Onboarding made this (App.jsx onboarded): open it.
    public var onDone: (Onboarded, OnboardedExtras) async -> Void
    /// "Engelbart" in the top left (nil: nowhere to go back to, a new person's first run).
    public var onBack: (() -> Void)?
    public var backTitle: String
    /// The folder picker (window.terminalAPI.pickDirectory).
    public var pickDirectory: () async -> String?
    /// api.copyText.
    public var copyText: (String) -> Bool
    /// The GitHub sign-in and repository list (Integrations); nil hides the GitHub part's picker.
    public var github: GithubPaneModel?
    /// "Bring over your sign-ins from another browser…" (Stage's ImportSigninsWindow; nil off a Mac): the sites it says to
    /// sign in to again are handed to `onOpenSite`.
    public var importSignins: ((_ onOpenSite: @escaping (String) -> Void) -> Void)?
    public var importFlow: ((ImportFlowRequest) -> AnyView)?
    public var connectLibrary: ((ConnectLibraryRequest) -> AnyView)?
    public var agentSetup: ((AgentSetupRequest) -> AnyView)?
    public var hub: EventHub
    /// "darwin" on a Mac (the sign-ins picker; ImportFlow's platform).
    public var platform: String

    public init(mode: OnboardingMode, into: String? = nil, data: OnboardingData, agents: OnboardingAgents = .none,
                onTools: @escaping (String) -> Void = { _ in }, onDone: @escaping (Onboarded, OnboardedExtras) async -> Void,
                onBack: (() -> Void)? = nil, backTitle: String = "All projects", pickDirectory: @escaping () async -> String? = { nil },
                copyText: @escaping (String) -> Bool = { text in NSPasteboard.general.clearContents(); return NSPasteboard.general.setString(text, forType: .string) },
                github: GithubPaneModel? = nil, importSignins: ((@escaping (String) -> Void) -> Void)? = nil,
                importFlow: ((ImportFlowRequest) -> AnyView)? = nil, connectLibrary: ((ConnectLibraryRequest) -> AnyView)? = nil,
                agentSetup: ((AgentSetupRequest) -> AnyView)? = nil, hub: EventHub = .shared, platform: String = "darwin") {
        self.mode = mode; self.into = into; self.data = data; self.agents = agents; self.onTools = onTools; self.onDone = onDone
        self.onBack = onBack; self.backTitle = backTitle; self.pickDirectory = pickDirectory; self.copyText = copyText; self.github = github
        self.importSignins = importSignins; self.importFlow = importFlow; self.connectLibrary = connectLibrary; self.agentSetup = agentSetup
        self.hub = hub; self.platform = platform
    }
}

/// Onboarding.jsx's state and handlers. The view draws it; tests drive it.
@MainActor
public final class OnboardingModel: ObservableObject {
    /// A row this onboarding put in the library (`fresh`: it made it).
    public struct Added: Equatable, Sendable { public var id: String; public var src: String; public var fresh: Bool }
    public enum GateState: Equatable, Sendable { case checking, ask }

    public let context: OnboardingContext
    public let flowMode: OnboardingMode
    public let fresh: Bool

    @Published public var place: OnboardingPlace
    @Published public private(set) var library: [LibraryRow] = []
    @Published public private(set) var added: [Added] = []
    /// A row being added or removed: a repository's id, 'url' or 'pdf'.
    @Published public private(set) var busy = ""
    @Published public var entry = "" { didSet { if entry != oldValue { entryErr = "" } } }
    @Published public private(set) var entryErr = ""
    /// 'claude' (Import from an AI provider) | 'own' (Write my own).
    @Published public var instrSrc: String?
    @Published public var instr = ""
    @Published public private(set) var copied = false
    @Published public var name = "" { didSet { if name != oldValue { askFreeFolder() } } }
    @Published public var desc = ""
    @Published public private(set) var folder = "new"
    @Published public private(set) var folderPath = ""
    @Published public private(set) var newPath = "~/my-project"
    @Published public var sel: [String: Bool] = [:]
    @Published public var error = ""
    @Published public private(set) var connectId: String?
    @Published public private(set) var connectDropped = false
    @Published public private(set) var intoProject: ProjectAbout?
    @Published public private(set) var gate: GateState?
    @Published public private(set) var agentProviders: AgentProviders?
    @Published public private(set) var tools: ToolsSnapshot?
    /// Bumped when the link field should take the keyboard again.
    @Published public private(set) var focusLink = 0
    /// Its "Sign in again" sites (2026-10-06): there is no Stage until the project opens, so they open on it then.
    public private(set) var stageLinks: [String] = []

    /// How long the free-folder ask waits after the name stops changing (120 ms); tests shorten it.
    public var folderDelay: TimeInterval = 0.12
    private var folderTimer: DispatchWorkItem?
    private var libraryToken: EventHub.Token?
    private var providersAsk = 0

    public init(context: OnboardingContext, tools: ToolsSnapshot? = nil) {
        self.context = context
        let mode: OnboardingMode = context.mode == .existing ? .existing : (context.mode == .guided && context.into != nil) ? .guided : .new
        flowMode = mode
        fresh = OnboardingFlow.isFresh(mode)
        place = OnboardingPlace(step: mode == .existing ? "create" : "welcome")
        self.tools = tools
    }

    deinit { if let libraryToken { context.hub.off(libraryToken) } }

    /// Reads what the screens start from: the library (again on every library-changed announcement), the saved
    /// instructions, the folder a project would get, and the guided setup's project.
    public func start() async {
        if libraryToken == nil {
            libraryToken = context.hub.on("engelbart:library-changed") { [weak self] _ in
                Task { @MainActor in _ = await self?.readLibrary() }
            }
        }
        _ = await readLibrary()
        if let text = try? await context.data.instructions(), !text.isEmpty { instr = text; instrSrc = "own" }
        askFreeFolder(now: true)
        if flowMode == .guided, let into = context.into, let about = try? await context.data.projectAbout(into) { intoProject = about }
        loadProviders()
    }

    @discardableResult
    public func readLibrary() async -> [LibraryRow] {
        guard let rows = try? await context.data.library() else { return [] }
        library = rows
        return rows
    }

    /// Connect your library needs Claude Code or Codex: skipping the agent popup without one takes it out of the guided
    /// setup's flow, and Add to your library and Custom instructions come back in its place.
    /// (Swift: a build without the import screens plugged in — ImportUI's ImportFlow for a new user, ConnectLibrary for the
    /// guided setup — counts as Connect dropped, so the screens that work without them are walked instead of a blank page.)
    public var connectMode: Bool {
        fresh && !connectDropped && (flowMode == .guided ? context.connectLibrary != nil : context.importFlow != nil)
    }
    /// The "Set up your tools" screen is gone (2026-10-16, S3): the step stays out of the flow, so the pager never counts it.
    public var flowOptions: FlowOptions { FlowOptions(tools: false, connect: connectMode) }
    public var step: String { place.step }
    public var sub: Int { place.sub }
    public var part: String? { OnboardingFlow.SUBS[place.step].flatMap { $0.indices.contains(place.sub) ? $0[place.sub] : nil } }
    var byId: [String: LibraryRow] { Dictionary(library.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }

    /// The rows this onboarding added in a part (still in the library).
    public func addedHere(_ src: String) -> [LibraryRow] {
        let index = byId
        return added.filter { $0.src == src }.compactMap { index[$0.id] }
    }

    public var pager: PagerPosition? { OnboardingFlow.shownPager(flowMode, place.step, flowOptions) }

    /// The tool check's snapshot changed (App.jsx `tools`).
    public func setTools(_ snapshot: ToolsSnapshot?) {
        tools = snapshot
        loadProviders()
        settleGate()
    }

    // MARK: - moving

    func go(_ next: OnboardingPlace) {
        place = OnboardingPlace(step: next.step, sub: next.sub, detour: next.step == place.step ? place.detour : next.detour)
        entry = ""; entryErr = ""; error = ""
    }
    /// `setPlace((now) => ({ ...now, ...next }))`: the detour stays unless the move says otherwise.
    func go(step: String, sub: Int = 0, detour: Bool? = nil) {
        place = OnboardingPlace(step: step, sub: sub, detour: detour ?? place.detour)
        entry = ""; entryErr = ""; error = ""
    }

    /// Forward from here; past a new user's last screen the project is made, past the guided setup's the Welcome workspace.
    public func goForward(_ options: FlowOptions? = nil) {
        let next = OnboardingFlow.forward(flowMode, place, options ?? flowOptions)
        switch OnboardingFlow.endOf(flowMode, next) {
        case .project:
            let index = byId
            Task { await openProject(added.filter { index[$0.id] != nil }.map(\.id)) }
        case .welcome:
            Task { await addWelcome() }
        case nil:
            go(step: next.step, sub: next.sub)
        }
    }
    public func advance() { goForward() }

    // MARK: - Welcome and the agents (S3)

    /// Welcome's Continue. Without Connect (+ Project) nothing needs an agent: on at once.
    public func welcomeNext() {
        if !connectMode { advance(); return }
        if gate == nil { gate = .checking; settleGate() }
    }

    func loadProviders() {
        guard connectMode, place.step == "welcome", let tools, tools.checked else { return }
        providersAsk += 1
        let ask = providersAsk
        let agents = context.agents
        Task { @MainActor in
            do {
                let out = try await agents.providers(true)
                if ask == self.providersAsk || self.agentProviders == nil { self.agentProviders = out }
            } catch {
                if self.agentProviders == nil { self.agentProviders = AgentProviders(providers: []) }
            }
            self.settleGate()
        }
    }

    /// The check, once Continue was pressed: Git missing → installed in the background (never asked about: it comes with
    /// the app); no CLI qualifies → the popup; else the too-old ones updated in the background and on.
    func settleGate() {
        guard gate == .checking, let out = OnboardingFlow.agentGate(tools, agentProviders) else { return }
        let agents = context.agents
        if out.git { Task { await agents.toolsInstall(["git"]) } }
        if !out.go { gate = .ask; return }
        for id in out.update { Task { await agents.toolsUpdate(id) } }
        context.onTools("skip") // nothing is asked about the tools after onboarding either: one runs
        gate = nil
        advance()
    }

    /// The popup's choice: its provider remembered, on.
    public func agentDone(_ choice: String) {
        if (choice == "claude" || choice == "codex"), let provider = OnboardingFlow.providerOfCli(choice) {
            let agents = context.agents
            Task { await agents.rememberProvider(provider) }
        }
        context.onTools("skip")
        gate = nil
        advance()
    }

    /// Skip: on to Import your context, whose Import context asks again. The guided setup's Connect can't run without
    /// one either: its old screens come back in its place.
    public func agentSkip() {
        context.onTools("skip")
        gate = nil
        if flowMode == .guided {
            connectDropped = true
            goForward(FlowOptions(tools: false, connect: false))
            return
        }
        advance()
    }

    // MARK: - Add to your library

    func take(_ row: LibraryRow, _ src: String, fresh: Bool) {
        if !added.contains(where: { $0.id == row.id }) { added.append(Added(id: row.id, src: src, fresh: fresh)) }
        sel[row.id] = true
    }

    /// A row Connect's librarian added (the GitHub part's).
    public func connectAdded(_ row: LibraryRow) { take(row, "github", fresh: true) }

    /// Something picked or pasted: added to the library now; what is already there counts as added and stays. → the
    /// refusal's words, nil when added.
    @discardableResult
    public func addOne(_ input: String, src: String) async -> String? {
        do {
            let out = try await context.data.addLibraryItem(input)
            take(out.row, src, fresh: true)
            // A GitHub repository is added even when its sandbox could not start; that is said, not refused.
            if let problem = out.sandboxError, !problem.isEmpty { error = problem }
            _ = await readLibrary()
            return nil
        } catch {
            let message = errorMessage(error)
            if let name = Self.alreadyName(message) {
                let rows = await readLibrary()
                let found = try? await context.data.lookupLibraryItem(input)
                if let row = (error as? StoreError)?.row ?? found ?? rows.first(where: { $0.name == name }) { take(row, src, fresh: false) }
            }
            _ = await readLibrary()
            return message
        }
    }

    /// "Already in the library as “X”" → X.
    static func alreadyName(_ message: String) -> String? {
        guard message.hasPrefix("Already in the library as “"), message.hasSuffix("”") else { return nil }
        return String(message.dropFirst("Already in the library as “".count).dropLast())
    }
    static func isAlready(_ message: String?) -> Bool { message?.hasPrefix("Already") ?? false }

    public func heldRepo(_ repo: GithubRepo) -> LibraryRow? {
        let rows = library.map { GithubLibraryRow(id: $0.id, githubId: $0.githubId, url: $0.url) }
        guard let held = GithubModel.heldRow(repo, library: rows) else { return nil }
        return byId[held.id]
    }

    /// Ticking a repository adds it; unticking one this onboarding made removes it from the library when nothing holds it.
    public func toggleRepo(_ repo: GithubRepo) async {
        let row = heldRepo(repo)
        busy = repo.id ?? repo.fullName
        defer { busy = "" }
        guard let row else {
            let problem = await addOne(repo.url, src: "github")
            if let problem, !Self.isAlready(problem) { error = problem }
            return
        }
        if let mine = added.first(where: { $0.id == row.id }), mine.fresh, (try? await context.data.discardLibraryItem(row.id)) == true {
            added.removeAll { $0.id == row.id }
            _ = await readLibrary()
        }
    }

    /// The paste bar's Add (or Enter): an empty bar continues when something was added.
    public func addEntry() async {
        let value = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { if !addedHere("url").isEmpty { advance() }; return }
        var address = value
        if address.range(of: "^[a-z][a-z0-9+.-]*://", options: [.regularExpression, .caseInsensitive]) == nil && !address.hasPrefix("~") && !address.hasPrefix("/") {
            address = "https://\(address)"
        }
        let host = URL(string: address)?.host ?? ""
        if address.range(of: "^https?:", options: [.regularExpression, .caseInsensitive]) != nil && !host.contains(".") && host != "localhost" {
            entryErr = "that doesn’t look like a web address"
            return
        }
        busy = "url"
        let listed = Set(addedHere("url").map(\.id))
        let found = try? await context.data.lookupLibraryItem(address)
        let problem = await addOne(address, src: "url")
        busy = ""
        // A link already in the list says so; one the library held before joins the list like any other.
        if problem == nil || Self.isAlready(problem) { entry = "" }
        if let problem {
            entryErr = Self.isAlready(problem) ? ((found.map { listed.contains($0.id) } ?? false) ? "already added" : "") : problem
        }
        focusLink += 1
    }

    public func pickPapers() async {
        let paths = await context.data.pickLibraryPaths("pdf")
        if paths.isEmpty { return }
        busy = "pdf"
        var problems: [String] = []
        for file in paths {
            if let problem = await addOne(file, src: "pdf"), !Self.isAlready(problem) { problems.append(problem) }
        }
        busy = ""
        error = problems.first ?? ""
    }

    public var githubSignedIn: Bool { place.step == "import" && part == "github" && (context.github?.status?.connected ?? false) }

    public func githubSignOut() {
        guard let github = context.github else { return }
        github.signOut()
        if !github.problem.isEmpty { error = github.problem }
    }
    public func githubInstall() {
        guard let github = context.github else { return }
        github.open("install")
        if !github.problem.isEmpty { error = github.problem }
    }

    /// The sign-ins picker; the sites it says to sign in to again open on the Stage once the project opens.
    public func importSignins() {
        context.importSignins? { [weak self] url in
            guard let self else { return }
            if !self.stageLinks.contains(url) { self.stageLinks.append(url) }
        }
    }

    // MARK: - Custom instructions

    public func chooseInstructions(_ src: String) {
        instrSrc = src
        if src == "claude" { copied = false }
    }
    public func copyPrompt() {
        if context.copyText(OnboardingFlow.PROFILE_PROMPT) { copied = true } else { error = "Could not copy the prompt" }
    }
    public func saveInstructions() async {
        do { try await context.data.setInstructions(instr); advance() } catch { self.error = errorMessage(error) }
    }

    // MARK: - Create

    /// The folder "Create a folder for me" would make, as the name is typed.
    func askFreeFolder(now: Bool = false) {
        folderTimer?.cancel()
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let data = context.data
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                if let shown = try? await data.freeFolder(typed.isEmpty ? "my-project" : typed) { self?.newPath = shown }
            }
        }
        folderTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (now ? 0 : folderDelay), execute: work)
    }

    public var createButtons: OnboardingFlow.Buttons {
        OnboardingFlow.createButtons(place.sub, name: name, desc: desc, folder: folder, folderPath: folderPath)
    }

    /// Continue (and Skip) on the create screen: the next part, then the next screen. A folder picked under the name is
    /// checked here; the project is not made here (2026-10-10).
    public func createNext() async {
        let part = self.part
        if part == "name" && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
        if part == "name" && folder == "existing" {
            do { try await context.data.checkFolder(folderPath) } catch { self.error = errorMessage(error); return }
        }
        advance()
    }

    /// "Use an existing folder…": the folder picked takes the place of the one made at ~/<name>.
    public func browseFolder() async {
        if let chosen = await context.pickDirectory(), !chosen.isEmpty { useFolder(chosen) }
    }
    public func useFolder(_ path: String) { folder = "existing"; folderPath = path; error = "" }
    public func useNewFolder() { folder = "new"; folderPath = ""; error = "" }

    // MARK: - Project context (+ Project)

    /// What this onboarding added comes first, in the order it was added; the rest of the library after it.
    public var contextRows: [LibraryRow] {
        let order = Dictionary(added.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { a, _ in a })
        return OnboardingFlow.contextRows(library).enumerated()
            .sorted { (order[$0.element.id] ?? 1_000_000 + $0.offset) < (order[$1.element.id] ?? 1_000_000 + $1.offset) }
            .map(\.element)
    }
    public func toggleAll() {
        let rows = contextRows
        let allOn = !rows.isEmpty && rows.allSatisfy { sel[$0.id] == true }
        for row in rows { sel[row.id] = !allOn }
    }
    public func toggle(_ id: String) { sel[id] = !(sel[id] ?? false) }
    /// The empty library's "Add to library": the import screen outside the flow, coming back here.
    public func addToLibraryDetour() { go(step: "import", sub: 0, detour: flowMode == .existing) }
    public func open() async { await openProject(OnboardingFlow.contextRows(library).filter { sel[$0.id] == true }.map(\.id)) }

    // MARK: - the end

    /// The project made, from + Project's context screen or past a new user's last screen. A failure goes back to the
    /// screen it was made from, saying why.
    public func openProject(_ ids: [String]) async {
        let back = OnboardingPlace(step: place.step, sub: place.sub, detour: false)
        go(step: "open", sub: 0)
        do {
            let made = try await context.data.startProject(OnboardingFlow.projectInput(name: name, desc: desc, folder: folder, folderPath: folderPath,
                                                                                         ids: ids, connectId: connectId, mode: flowMode))
            await context.onDone(made, OnboardedExtras(stageLinks: stageLinks))
        } catch {
            place = back
            self.error = errorMessage(error)
        }
    }

    /// The guided setup's end inside a project: a Welcome workspace in `into` holding what this setup added, with the
    /// walkthrough and Connect's session; nothing the project had is touched.
    public func addWelcome() async {
        let back = OnboardingPlace(step: place.step, sub: place.sub, detour: false)
        go(step: "open", sub: 0)
        do {
            let index = byId
            let made = try await context.data.welcomeWorkspace(context.into ?? "", context: added.filter { index[$0.id] != nil }.map(\.id), connect: connectId)
            await context.onDone(made, OnboardedExtras(stageLinks: stageLinks))
        } catch {
            place = back
            self.error = errorMessage(error)
        }
    }

    // MARK: - Connect your library

    public func connectSession(_ id: String) {
        connectId = id
        let data = context.data
        Task { await data.connectOfferSeen("started") }
    }
    public func connectSkip() {
        let data = context.data
        Task { await data.connectOfferSeen("dismissed") }
        advance()
    }

    /// A new user's Import your context ended with the project to open.
    public func importDone(_ made: Onboarded, _ extras: OnboardedExtras) async {
        var all = extras
        all.stageLinks = stageLinks + extras.stageLinks.filter { !stageLinks.contains($0) }
        await context.onDone(made, all)
    }

    /// Whether a new user's Create/Connect are Import your context's own page (2026-10-13).
    public var showsImportFlow: Bool { connectMode && flowMode != .guided && (place.step == "create" || place.step == "connect") }
    /// The project the librarian is told about.
    public var librarianProject: ProjectAbout? { flowMode == .guided ? intoProject : ProjectAbout(name: name, description: desc) }
    public var projectName: String { name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "your project" : name.trimmingCharacters(in: .whitespacesAndNewlines) }
}
