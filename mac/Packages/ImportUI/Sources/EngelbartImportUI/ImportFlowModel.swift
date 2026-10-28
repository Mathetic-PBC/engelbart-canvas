import Foundation
import Combine
import EngelbartCore
import EngelbartConnect

// Import your context, the flow itself (src/renderer/import/ImportFlow.jsx): what each button does, in order. The
// project agent starts the moment the provider is known; the tool agent once the browser's sign-ins are answered
// (src/main/onboarding/discover.cjs). In the background, Import to Engelbart starts Connect's pipeline in its direct mode;
// manually, a librarian session from the same choices, which asks before anything comes in (From Amitav, 2026-10-15). In
// a new user's onboarding (`mode` new) a project is made for every project picked and the first opens; over a workspace
// (`mode` modal) the imports go to that project and the modal closes. Where the flow is, is saved, so onboarding opened
// again comes back to the same step.
//
// React's effects are calls here: `stateChanged` (the save, the Safari poll, the agent popup going on by itself),
// `discoveryChanged` (the tool agent's finds added to the picker) and `browsersChanged` (the sign-ins question asked
// once the browsers are known).

@MainActor
public final class ImportFlowModel: ObservableObject {
    /// The flow's state (`F`).
    @Published public var state: FlowState { didSet { if state != oldValue { stateChanged(from: oldValue) } } }
    @Published public private(set) var restored = false
    @Published public private(set) var providers: JSONValue?
    @Published public private(set) var browsers: JSONValue?
    @Published public private(set) var discovery: JSONValue?
    @Published public private(set) var disk: JSONValue?
    @Published public private(set) var asked: [String: String]?
    @Published public private(set) var toolsSnap: JSONValue?
    @Published public private(set) var found: JSONValue?
    @Published public var error = ""
    @Published public private(set) var busy = ""
    @Published public var catalogQuery = ""
    @Published public var sender: [String: String] = [:]
    @Published public var draft = Draft()
    /// Which row a source's open Specify context hangs under: a Recommended source has two rows.
    @Published public var specifyIn: (id: String, where: String)?
    /// The agent popup while it is up ('tools-setup').
    @Published public private(set) var agentSetup: AgentSetupModel?

    public struct Draft: Equatable { public var title = "", description = "", tool = "", website = ""; public init() {} }

    public let api: ImportAPI
    public let mode: ImportFlowMode
    public let into: String?
    public let workspaceId: String?
    public let platform: String
    /// A project was made (new user): `made` main's startProject answer, `session` the run's.
    public var onDone: (_ made: JSONValue, _ session: JSONValue?) async -> Void
    /// The modal closed: the run's session when one started.
    public var onClose: (_ session: JSONValue?) -> Void
    let defaults: UserDefaults
    private var tokens: [EventHub.Token] = []
    private var saveTask: Task<Void, Never>?
    private var safariTask: Task<Void, Never>?
    private var connectKey = ""
    private var afterBrowserAgents: (() -> Void)?
    private var lastResults: JSONValue?

    /// "Allow Engelbart to read Apple Notes?" answered Allow once is not asked again (2026-10-14).
    public static let notesKey = "engelbart.import.notesConsent"

    public init(api: ImportAPI, mode: ImportFlowMode = .new, into: String? = nil, workspaceId: String? = nil, intoProject: (name: String, description: String)? = nil,
                platform: String = "darwin", defaults: UserDefaults = .standard,
                onDone: @escaping (JSONValue, JSONValue?) async -> Void = { _, _ in }, onClose: @escaping (JSONValue?) -> Void = { _ in }) {
        self.api = api; self.mode = mode; self.into = into; self.workspaceId = workspaceId; self.platform = platform; self.defaults = defaults
        self.onDone = onDone; self.onClose = onClose
        var initial = FlowState()
        // Import context from inside a project (2026-10-14/16): for this project, its first question is how to import, then
        // the sources; the permissions already answered are not asked again.
        if mode == .modal, let into, !into.isEmpty {
            initial.screen = "picker"
            initial.dialog = "import-method"
            initial.methodFirst = true
            let name = intoProject?.name ?? ""
            initial.customProjects = [FlowProject(id: "project:\(into)", title: name.isEmpty ? "This project" : name, description: intoProject?.description ?? "")]
            initial.picked = ["project:\(into)"]
            initial.notesConsent = defaults.string(forKey: Self.notesKey) == "1"
        }
        state = initial
    }


    // MARK: what main knows, and its news

    /// Reads everything main knows and follows its news (the first effect).
    public func start() async {
        tokens.append(api.events.on("engelbart:discovery") { [weak self] value in Task { @MainActor in self?.setDiscovery(value) } })
        tokens.append(api.events.on("engelbart:tools") { [weak self] value in
            Task { @MainActor in
                guard let self, value["tools"] != nil else { return }
                self.setTools(value)
                if let fresh = try? await self.api.providers(fresh: true) { self.setProviders(fresh) }
            }
        })
        do {
            let saved = try await api.flow()
            // In a project the picker comes fresh every time; a new user's onboarding opens where it was.
            if J.int(saved["v"]) == ImportFlowState.flowVersion && mode == .new {
                var next = FlowState(saved: saved)
                next.groupScopes = [:]
                if let dialog = next.dialog, let gone = ImportFlowState.goneDialogs[dialog] { next.dialog = gone }
                state = next
            }
        } catch {}
        restored = true
        if let out = try? await api.providers(fresh: false) { setProviders(out) }
        do { let out = try await api.browsers(); setBrowsers(out); if state.browserChoice == nil { state.browserChoice = out["chosenId"]?.string } }
        // A detection that failed is a Mac with no browser to ask about, not an answer left missing (S11).
        catch { if browsers == nil { setBrowsers(["browsers": [], "keychain": nil, "failed": true]) } }
        if let out = try? await api.discovery() { setDiscovery(out) }
        if let out = try? await api.diskAccess() { disk = out }
        if let out = try? await api.foldersAsked() { asked = out }
        if let out = try? await api.tools() { setTools(out) }
        if let out = try? await api.detect() { found = out }
    }

    public func stop() { tokens.forEach { api.events.off($0) }; tokens = []; saveTask?.cancel(); safariTask?.cancel() }

    func say(_ failure: Error?) { error = failure.map(tidyError) ?? "" }

    func setProviders(_ value: JSONValue) { providers = value; agentSetup?.update(tools: toolsSnap, providers: providers); checkConnectOpen() }
    func setTools(_ value: JSONValue) { toolsSnap = value; agentSetup?.update(tools: toolsSnap, providers: providers); checkConnectOpen() }
    func setBrowsers(_ value: JSONValue) {
        let had = browsers != nil
        browsers = value
        // The browsers found while the dialog waited for them: asked now (or on at once, with none to ask about).
        if !had && state.dialog == "keychain" && state.keychainNext != nil { routeKeychain(value) }
    }
    func setDiscovery(_ value: JSONValue) {
        discovery = value
        let results = value["tools"]?["results"]
        guard let results, J.truthy(results), results != lastResults else { return }
        lastResults = results
        state = ImportFlowState.mergeTools(state, results: results, tick: mode == .new)
    }

    // Where the flow is, kept 300 ms after a change (with `into`, the menu closed), never before it was restored.
    func stateChanged(from old: FlowState) {
        if restored {
            saveTask?.cancel()
            let snapshot = state
            saveTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard let self, !Task.isCancelled else { return }
                var saved = snapshot
                saved.into = self.into
                try? await self.api.saveFlow(saved.json)
            }
        }
        if state.dialog != old.dialog {
            if state.dialog == "safari" { startSafariPoll() } else if old.dialog == "safari" { safariTask?.cancel() }
            if state.dialog == "tools-setup" { openAgentSetup() } else if old.dialog == "tools-setup" { agentSetup = nil }
            checkConnectOpen()
        }
    }

    /// The flow forgotten (main's importFlowSave(null)): a save still waiting is dropped, as React's timer went with the
    /// component the run or Close unmounted.
    func forgetFlow() async {
        saveTask?.cancel()
        saveTask = nil
        try? await api.saveFlow(nil)
    }

    /// The save now (tests; the app on close).
    public func flushSave() async {
        saveTask?.cancel()
        var saved = state
        saved.into = into
        try? await api.saveFlow(saved.json)
    }

    // MARK: the provider

    func checkedAt(_ provider: String) -> String? {
        let tool = toolsSnap?["tools"]?[provider == "openai" ? "codex" : "claude"]
        return tool?["checkedAt"].flatMap { $0.string ?? ($0.double.map { String($0) }) }
    }
    /// A provider whose CLI says it is signed in yet turned the agent away: not ready until it is checked again.
    func refusedNow() -> String? {
        guard let refused = state.refused else { return nil }
        return checkedAt(refused.provider) == refused.since ? refused.provider : nil
    }
    func readyIn(_ status: JSONValue?) -> [String] {
        J.arr(status?["providers"]).filter { J.truthy($0["installed"]) && J.truthy($0["signedIn"]) && J.str($0["id"]) != refusedNow() }.map { J.str($0["id"]) }
    }
    public func readyProviders() -> [String] { readyIn(providers) }

    /// The provider for `purpose`: 'start' | 'run' | 'projects' | 'tools' | 'librarian'. Asked when both are subscribed;
    /// the agent popup when none can run, or `connectFor` can't (`refused`).
    public func needProvider(_ purpose: String, connectFor: String? = nil, refused: Bool = false) async {
        if refused, let connectFor { state.refused = RefusedMark(provider: connectFor, since: checkedAt(connectFor)) }
        var status = providers
        if let fresh = try? await api.providers(fresh: true) { status = fresh; providers = fresh }
        let decision = status?["decision"]
        let ready = readyIn(status)
        if decision == nil || !J.truthy(decision) || ready.isEmpty || (connectFor != nil && !ready.contains(connectFor!)) {
            state.purpose = purpose; state.connectFor = connectFor; state.dialog = "tools-setup"
            return
        }
        if let connectFor { providerReady(connectFor, purpose); return }
        if let provider = state.provider, ready.contains(provider) { providerReady(provider, purpose); return }
        let choices = J.strs(decision?["choices"])
        if J.truthy(decision?["ask"]) && choices.allSatisfy(ready.contains) {
            state.purpose = purpose; state.providerChoice = decision?["suggested"]?.string; state.dialog = "provider-choice"
            return
        }
        let pick = J.str(decision?["pick"])
        providerReady(!pick.isEmpty && ready.contains(pick) ? pick : ready[0], purpose)
    }

    // Connected while the agent popup is open: on with what it was opened for, with no Continue to press.
    func checkConnectOpen() {
        let open = state.dialog == "tools-setup"
        let readyNow = readyProviders().joined(separator: ",")
        let wanted = state.connectFor.flatMap(checkedAt) ?? ""
        let key = "\(open)|\(readyNow)|\(wanted)"
        guard key != connectKey else { return }
        connectKey = key
        guard open, !readyNow.isEmpty else { return }
        let want = state.connectFor
        if let want, !readyNow.split(separator: ",").map(String.init).contains(want) { return }
        Task { await needProvider(state.purpose ?? "start", connectFor: want) }
    }

    /// Another CLI chosen in the popup than the one it was opened for, running: the flow goes on with that one.
    public func choseInPopup(_ choice: String?) {
        guard let want = state.connectFor, state.dialog == "tools-setup" else { return }
        let provider = choice == "both" ? nil : OnboardingHelpers.providerOfCli(choice)
        if provider == want || readyProviders().contains(want) { return }
        Task { await needProvider(state.purpose ?? "start", connectFor: provider) }
    }

    func openAgentSetup() {
        let asked = state.connectFor.flatMap(OnboardingHelpers.cliOfProvider)
        let turnedAway = refusedNow().flatMap(OnboardingHelpers.cliOfProvider)
        agentSetup = AgentSetupModel(api: api, tools: toolsSnap, providers: providers, initial: asked, refused: turnedAway,
                                     onDone: { [weak self] choice in self?.choseInPopup(choice) }, onSkip: { [weak self] in self?.state.dialog = nil })
    }

    func providerReady(_ provider: String, _ purpose: String) {
        state.provider = provider; state.connectFor = nil; state.refused = nil
        switch purpose {
        case "projects":
            // Try again (or Connect) on the recent projects: looked for again, now on a provider that can run.
            state.dialog = nil
            Task { if let out = try? await api.discoverProjects(provider: provider, again: true) { setDiscovery(out) } }
        case "tools":
            state.dialog = nil
            Task { if let out = try? await api.discoverTools(provider: provider, browserId: browsers?["chosenId"]?.string, keychain: browsers?["keychain"]?.string, again: true) { setDiscovery(out) } }
        case "start":
            // Recent projects, found in the background from now on; the popups the intro's buttons bring up stay over the intro.
            Task { if let out = try? await api.discoverProjects(provider: provider, again: false) { setDiscovery(out) } }
            keychainGate("roles")
        case "run": Task { await run(provider) }
        case "librarian": Task { await startLibrarian(provider) }
        default: state.dialog = nil
        }
    }

    /// Choosing is continuing, as the import method is (one click).
    public func chooseProvider(_ pick: String) async {
        state.providerChoice = pick
        try? await api.rememberProvider(pick)
        providerReady(pick, state.purpose ?? "start")
    }

    // MARK: the start

    /// "Import context (recommended)".
    public func importContext() async { error = ""; await needProvider("start") }

    /// The browser's sign-ins, asked once before the work questions (2026-10-16, S9–S12). It can't be skipped.
    func keychainGate(_ next: String) { state.keychainNext = next; routeKeychain(browsers) }

    func routeKeychain(_ now: JSONValue?, fresh: Bool = false) {
        let step = OnboardingHelpers.keychainStep(fresh && now != nil ? now!.with("keychain", nil) : now)
        switch step {
        case .wait: state.dialog = "keychain"
        case .go(let answer):
            // No browser whose sign-ins can be read: declined without a question, and saved as declined (2026-10-16).
            if answer == "declined" && !J.truthy(now?["keychain"]) { Task { _ = try? await api.keychain("declined") } }
            keychainDone(answer)
        case .safari: state.dialog = "safari"
        case .ask: state.dialog = "keychain"
        }
    }

    func keychainDone(_ answer: String) {
        let next = state.keychainNext ?? (state.screen == "intro" ? "roles" : nil)
        var s = state
        s.dialog = nil; s.keychainNext = nil; s.diskWaiting = false
        if let next { s.screen = next }
        state = s
        startTools(answer == "allowed" ? "allowed" : "declined")
    }

    /// Allow: the profile first when the browser has several (S10), then macOS (S12).
    public func keychainAllow() async {
        if OnboardingHelpers.afterAllow(browsers) == "profile" { state.dialog = "browser-profile"; state.profileChoice = nil; return }
        await askMacos()
    }

    // macOS's one prompt for the chosen browser's sign-ins, at once, with either way of importing (S12).
    func askMacos() async {
        busy = "keychain"
        var out: JSONValue?
        do { out = try await api.keychain("allowed") } catch { say(error) }
        busy = ""
        let said = J.str(out?["keychain"])
        let answer = said == "allowed" || said == "refused" ? said : "allowed"
        browsers = (browsers ?? ["browsers": []]).with("keychain", .string(answer))
        keychainDone(answer)
    }

    public func keychainDecline() async {
        do { _ = try await api.keychain("declined") } catch { say(error) }
        browsers = (browsers ?? ["browsers": []]).with("keychain", "declined")
        keychainDone("declined")
    }

    public func chooseProfile() async {
        guard let id = state.profileChoice, let browsers else { return }
        do { setBrowsers(try await api.chooseBrowserProfile(J.str(browsers["chosenId"]), id)) } catch { say(error); return }
        await askMacos()
    }

    // Safari (S9): Grant disk access opens System Settings ▸ Privacy & Security ▸ Full Disk Access and waits for the switch.
    public func grantDisk() async {
        state.diskWaiting = true
        do { try await api.openDiskAccess() } catch {
            do { try await api.openExternal(ImportFlowState.fullDiskAccessURL) } catch { say(error) }
        }
    }

    /// Every 1.5 s while the Safari popup is up: granted, Safari's sign-ins are used like any other browser's.
    public var safariPollNanos: UInt64 = 1_500_000_000
    func startSafariPoll() {
        safariTask?.cancel()
        safariTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                let out = try? await self.api.diskAccess()
                if Task.isCancelled { return }
                if J.truthy(out?["granted"]) {
                    self.disk = ["granted": true]
                    var now = self.browsers
                    if let fresh = try? await self.api.browsers() { now = fresh; self.setBrowsers(fresh) }
                    guard self.state.dialog == "safari" else { return }
                    let ready = (now ?? [:]).with("safari", (now?["safari"] ?? [:]).with("diskAccess", true))
                    if OnboardingHelpers.afterAllow(ready) == "profile" { self.state.dialog = "browser-profile"; self.state.profileChoice = nil; return }
                    await self.askMacos()
                    return
                }
                try? await Task.sleep(nanoseconds: self.safariPollNanos)
            }
        }
    }

    /// "Use {browser}": another browser is asked about afresh.
    public func useBrowser() async {
        guard let id = state.browserChoice else { return }
        let out: JSONValue
        do { out = try await api.chooseBrowser(id) } catch { say(error); return }
        browsers = out
        routeKeychain(out, fresh: true)
    }

    func startTools(_ answer: String?) {
        let provider = state.provider
        let browserId = browsers?["chosenId"]?.string
        let keychain = answer ?? browsers?["keychain"]?.string
        Task { if let out = try? await api.discoverTools(provider: provider, browserId: browserId, keychain: keychain, again: false) { setDiscovery(out) } }
    }

    // MARK: browser agents

    // The web apps' imports in the person's own browser (2026-10-13, second round). Asked before the run only when their
    // Claude Code or Codex does not already let its agents use the browser.
    func browserAgentsGate(_ provider: String, then: @escaping () -> Void) async {
        let web = ImportFlowState.runApps(state).filter(ImportFlow.isWebApp)
        let others = ImportFlowState.runAdded(state)
        if web.isEmpty && others.isEmpty { then(); return }
        let status = try? await api.browserAgents(provider: provider, browserId: browsers?["chosenId"]?.string)
        guard let status, J.truthy(status["ask"]) else { then(); return }
        // "Import context using background agents" said they use the signed-in browser, and the person said I understand.
        if state.agentsConsent { do { try await api.browserAgentsAnswer("allowed") } catch { say(error) }; then(); return }
        afterBrowserAgents = then
        let browserName = J.str(status["browser"]?["name"])
        state.agentsBrowser = browserName.isEmpty ? "your browser" : browserName
        state.agentsApps = Array((web.map(ConnectSources.shownName) + others.map(\.name)).prefix(6))
        state.dialog = "browser-agents"
    }

    /// Don't allow asks again ("Are you sure?"); the answer goes to main and the run goes on.
    public func browserAgentsAnswer(_ answer: String) async {
        if answer == "declined" && state.dialog == "browser-agents" { state.dialog = "browser-agents-confirm"; return }
        do { try await api.browserAgentsAnswer(answer) } catch { say(error) }
        let go = afterBrowserAgents
        afterBrowserAgents = nil
        state.dialog = nil
        go?()
    }

    // MARK: the run

    var atFirstQuestion: Bool { state.methodFirst && state.mode == nil && state.dialog == "import-method" }

    /// Import to Engelbart.
    public func chooseMethod() async {
        guard (!ImportFlowState.runApps(state).isEmpty || !ImportFlowState.runAdded(state).isEmpty) && !state.picked.isEmpty else { return }
        if state.methodFirst && state.mode == "auto" { state.dialog = "agents-consent"; return }
        if state.methodFirst && state.mode == "manual" { await manually(); return }
        state.dialog = "import-method"
    }
    /// "Import in the background with agents".
    public func inBackground() { if atFirstQuestion { state.mode = "auto"; state.dialog = nil; return }; state.mode = "auto"; state.dialog = "agents-consent" }
    /// "I understand".
    public func understood() async { state.mode = "auto"; state.agentsConsent = true; state.dialog = nil; await runGate() }
    /// "Import manually with fine-grained permissions".
    public func manually() async {
        if atFirstQuestion { state.mode = "manual"; state.dialog = nil; return }
        state.mode = "manual"; state.dialog = nil
        await runGate()
    }
    /// The import-method question's Back: at the first question (opened from a project) it closes Import context.
    public func methodBack() async {
        if atFirstQuestion { await forgetFlow(); onClose(nil); return }
        state.dialog = nil
    }

    /// What comes before an import starts, either way: which project opens first, Apple Notes' permission, Allow Engelbart
    /// to organize your research (the folders macOS guards, asked once); then the run, or the librarian.
    public func runGate() async {
        let apps = ImportFlowState.runApps(state)
        guard (!apps.isEmpty || !ImportFlowState.runAdded(state).isEmpty) && !state.picked.isEmpty else { return }
        // Which project opens (2026-10-14, "Right now I think it opens a random project"): asked when more than one was picked.
        if mode == .new && state.picked.count > 1 && !state.picked.contains(state.firstProject ?? "") {
            state.dialog = "first-project"; state.firstChoice = state.picked[0]; return
        }
        if apps.contains("Apple Notes") && !state.notesConsent && defaults.string(forKey: Self.notesKey) != "1" { state.dialog = "notes-permission"; return }
        if platform == "darwin" && !foldersReady() { state.dialog = "organize"; return }
        if state.mode == "manual" {
            if state.provider == nil { await needProvider("librarian"); return }
            await startLibrarian(nil); return
        }
        if state.provider == nil { await needProvider("run"); return }
        await run(nil)
    }

    /// The run, once the person said whether agents may use their browser (when that is theirs to say).
    func run(_ providerNow: String?) async {
        guard let provider = providerNow ?? state.provider else { await needProvider("run"); return }
        await browserAgentsGate(provider) { [weak self] in Task { await self?.startRun(provider) } }
    }

    /// A project for every project picked; the first (the one to start with) holds session `sessionId` and opens.
    func openProjects(_ sessionId: String, _ projects: [JSONValue]) async throws {
        var first: JSONValue?
        for (index, project) in projects.enumerated() {
            var input: [String: JSONValue] = ["name": project["title"] ?? "", "description": project["description"] ?? "", "folder": "new", "directory": "", "context": [], "onboarding": .bool(index == 0)]
            if index == 0 { input["connect"] = .string(sessionId) }
            var made: JSONValue?
            let folder = J.str(project["folder"])
            if !folder.isEmpty {
                var existing = input; existing["folder"] = "existing"; existing["directory"] = .string(folder)
                made = try? await api.startProject(.object(existing))
            }
            if made == nil { made = try await api.startProject(.object(input)) }
            if first == nil { first = made }
        }
        if first == nil {
            first = try await api.startProject(["name": "My research", "description": "", "folder": "new", "directory": "", "context": [], "onboarding": true, "connect": .string(sessionId)])
        }
        await onDone(first!, ["id": .string(sessionId)])
    }

    func startRun(_ providerNow: String?) async {
        guard let provider = providerNow ?? state.provider else { await needProvider("run"); return }
        let choices = ImportFlowState.runChoices(state, discovery)
        // No "Starting your imports" popup (2026-10-14: one popup at most between here and the project): the button says it.
        state.dialog = nil
        busy = "run"
        error = ""
        defer { busy = "" }
        do {
            if choices.apps.contains("Apple Notes") { _ = try? await api.notesPermission() }
            let session = try await api.connectStart(ImportFlowState.startInput(state, provider: provider, choices: choices, browsers: browsers, mode: mode, into: into, workspaceId: workspaceId))
            await forgetFlow()
            if mode == .modal { onClose(session); return }
            try await openProjects(J.str(session["id"]), choices.projects)
            state.dialog = nil
        } catch {
            say(error)
            state.dialog = nil
        }
    }

    // Import manually with fine-grained permissions (From Amitav, 2026-10-15): the same choices start a librarian session,
    // whose chat asks before anything comes in. In a new user's onboarding the chat is this flow's last screen and the
    // projects are made when it is put away; over a project, the chat opens over the workspace (the app).
    func startLibrarian(_ providerNow: String?) async {
        guard let provider = providerNow ?? state.provider else { await needProvider("librarian"); return }
        let choices = ImportFlowState.runChoices(state, discovery)
        state.dialog = nil
        busy = "run"
        error = ""
        defer { busy = "" }
        do {
            if choices.apps.contains("Apple Notes") { _ = try? await api.notesPermission() }
            let session = try await api.connectStart(ImportFlowState.startInput(state, provider: provider, choices: choices, browsers: browsers, mode: mode, into: into, workspaceId: workspaceId, librarian: true))
            if mode == .modal { await forgetFlow(); onClose(session); return }
            state.screen = "librarian"; state.librarian = J.str(session["id"]); state.dialog = nil
        } catch {
            say(error)
            state.dialog = nil
        }
    }

    /// The librarian's chat put away (it goes on in the background): the projects are made and the first opens.
    public func librarianDone() async {
        guard let id = state.librarian, busy != "project" else { return }
        busy = "project"
        defer { busy = "" }
        do {
            await forgetFlow()
            try await openProjects(id, ImportFlowState.runChoices(state, discovery).projects)
        } catch { say(error) }
    }

    /// The librarian's Back: the picker again, the session stopped and dismissed by the chat.
    public func librarianBack() { state.screen = "picker"; state.librarian = nil; state.mode = nil; state.dialog = nil }

    /// The projects the librarian is told about: their titles and descriptions.
    public var librarianProject: (name: String, description: String) {
        let chosen = ImportFlowState.selectedProjects(state, discovery)
        return (chosen.map(\.title).joined(separator: ", "), chosen.map { "\($0.title)\($0.description.isEmpty ? "" : ": \($0.description)")" }.joined(separator: "\n"))
    }

    /// Start from scratch: over a project nothing is imported and the modal closes; a new user names a project.
    public func startFromScratch() async {
        if mode == .modal { await forgetFlow(); onClose(nil); return }
        let name = state.scratchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        busy = "project"
        defer { busy = "" }
        do {
            let made = try await api.startProject(["name": .string(name), "description": .string(state.scratchDesc.trimmingCharacters(in: .whitespacesAndNewlines)), "folder": "new", "directory": "", "context": [], "onboarding": true])
            await forgetFlow()
            await onDone(made, nil)
        } catch { say(error) }
    }

    /// The intro's × and the picker's Cancel over a project: the flow forgotten and the modal closed.
    public func close() async { await forgetFlow(); onClose(nil) }

    // MARK: the folders macOS guards

    // Allow Engelbart to organize your research (2026-10-15, Hudson: no Full Disk Access): asked once, unless they were
    // asked before (folders.json) or may be read already.
    public func foldersReady() -> Bool {
        state.organized || state.folderAnswers != nil || J.truthy(disk?["granted"]) || ImportFlowState.desktopFolders.allSatisfy { asked?[$0] != nil }
    }
    /// "Connect desktop": one macOS prompt each for Desktop, Documents and Downloads.
    public func connectDesktop() async {
        busy = "folders"
        var answers: [String: String] = [:]
        do { answers = try await api.foldersAsk(ImportFlowState.desktopFolders) } catch { say(error) }
        busy = ""
        asked = (asked ?? [:]).merging(answers) { $1 }
        state.folderAnswers = answers
    }
    /// Skip (2026-10-16, S13: "they should be able to deny"): on without asking macOS; what needs them is left out quietly.
    public func organizeSkip() async { state.organized = true; state.dialog = nil; await runGate() }
    public func organizeContinue() async { state.organized = true; state.dialog = nil; await runGate() }

    /// Apple Notes' question: Don't allow takes it out of the run; Allow is remembered.
    public func notesAnswer(_ allow: Bool) async {
        if allow { defaults.set("1", forKey: Self.notesKey); state.notesConsent = true } else { state.picks.removeAll { $0 == "Apple Notes" } }
        state.dialog = nil
        await runGate()
    }

    /// "Which project do you want to start with?" Continue.
    public func firstProjectContinue() async {
        guard let pick = state.firstChoice ?? state.picked.first else { return }
        state.firstProject = pick; state.dialog = nil
        await runGate()
    }

    // MARK: screens and picks

    public func back() {
        switch state.screen {
        case "roles": state.screen = "intro"; state.dialog = nil
        case "work": state.screen = "roles"
        case "projects": state.screen = "work"
        default: state.screen = "projects"
        }
    }
    public func toggleRole(_ name: String) { state.roles = state.roles.contains(name) ? state.roles.filter { $0 != name } : state.roles + [name] }
    public func rolesContinue() { if !state.roles.isEmpty { state.screen = "work" } }
    public func setWork(_ text: String) { state.work = String(text.prefix(2000)) }
    /// Not optional (2026-10-13: "Dont make this optional"); Enter continues.
    public func workNext() { if !state.work.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { state.screen = "projects" } }
    public func toggleProject(_ id: String) { state.picked = state.picked.contains(id) ? state.picked.filter { $0 != id } : state.picked + [id] }
    public func projectsContinue() { if !state.picked.isEmpty { state.screen = "picker"; state.dialog = nil } }
    public func openAddProject() { draft = Draft(); state.dialog = "work-add-project" }
    /// Add a project: its title (≤80) and description (≤500); added picked.
    public func addProject(now: Date = Date()) {
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        let id = "user-project:\(Int(now.timeIntervalSince1970 * 1000))"
        state.customProjects.append(FlowProject(id: id, title: String(title.prefix(80)), description: String(draft.description.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))))
        state.picked.append(id)
        state.dialog = nil
    }

    public var projects: [FlowProject] { ImportFlowState.allProjects(state, discovery) }
    public var chosen: [FlowProject] { ImportFlowState.selectedProjects(state, discovery) }
    public var projectStatus: String { discovery?["projects"].map { J.str($0["status"]) }.flatMap { $0.isEmpty ? nil : $0 } ?? "idle" }
    public var toolStatus: String { discovery?["tools"].map { J.str($0["status"]) }.flatMap { $0.isEmpty ? nil : $0 } ?? "idle" }
    public var discoveryLine: ImportFlowState.DiscoveryLine? { ImportFlowState.discoveryLine(discovery, providers: providers, provider: state.provider) }
    /// The discovery line's Connect / Try again.
    public func discoveryConnect() async {
        guard let line = discoveryLine else { return }
        await needProvider("projects", connectFor: line.connectProvider, refused: line.refused)
    }
    public func discoveryAgain() async { await needProvider("projects") }

    public func pickSource(_ id: String) { state = ImportFlowState.pickSource(state, id) }
    public func isPicked(_ id: String) -> Bool { state.picks.contains(id) }
    public func keysOf(_ group: SourceGroup) -> [String] { ImportFlowState.keysOf(group, state) }
    public func nameOf(_ id: String) -> String { ImportFlowState.toolName(id, added: state.added) }
    public func spokenOf(_ id: String) -> String { ImportFlowState.spokenName(id, added: state.added) }
    public func scopeOf(_ id: String) -> SourceScope { state.scopes[id] ?? ImportFlowState.emptyScope(id) }
    public func setScope(_ id: String, _ change: (inout SourceScope) -> Void) {
        var scope = scopeOf(id)
        change(&scope)
        state.scopes[id] = scope
    }
    /// Whether the Specify context of `id` is open under the row in `where` ('recommended' | 'home').
    public func specifyOpen(_ id: String, _ where_: String) -> Bool {
        guard state.picks.contains(id), state.scopeOpen == id else { return false }
        return (specifyIn?.id == id ? specifyIn!.where : "home") == where_
    }
    public func toggleSpecify(_ id: String, _ where_: String) {
        if specifyOpen(id, where_) { state.scopeOpen = nil } else { specifyIn = (id, where_); state.scopeOpen = id }
    }
    /// A project chip of a source's Specify context toggled (every one picked on until narrowed; never none).
    public func toggleSourceProject(_ id: String, _ project: String) {
        let every = chosen.map(\.id)
        guard let next = ImportFlowState.toggleOnly(scopeOf(id), project: project, every: every) else { return }
        setScope(id) { $0.only = next }
    }
    public func sourceProjectOn(_ id: String, _ project: String) -> Bool {
        let every = chosen.map(\.id)
        let only = scopeOf(id).only.map { $0.filter(every.contains) }
        return only == nil || only!.isEmpty || only!.contains(project)
    }
    public func addPerson(_ id: String) {
        let person = (sender[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !person.isEmpty { setScope(id) { if !$0.people.contains(person) { $0.people.append(person) } } }
        sender[id] = ""
    }
    /// Choose files (2026-10-14: "choose folder and choose files should just be the same thing"); Obsidian's opens its own.
    public func chooseFiles(_ id: String) async {
        if id == "Obsidian" { state.dialog = "obsidian-picker"; state.pickerFor = id; return }
        let files = await api.pickFiles()
        if !files.isEmpty { addFolders(id, files.map { ScopeFile(path: $0.path, name: $0.name) }) }
    }
    public func addFolders(_ id: String, _ chosen: [ScopeFile]) {
        setScope(id) { scope in for file in chosen where !scope.folders.contains(where: { $0.path == file.path }) { scope.folders.append(file) } }
    }
    /// A tool from "+ Add a tool": ticked, as the person's own choice.
    public func pickTool(_ id: String) {
        if !state.picks.contains(id) { state.picks.append(id) }
        if !state.touched.contains(id) { state.touched.append(id) }
        state.open = [ImportFlowState.groupOfId(id, state)]
        state.dialog = nil
    }
    public func openAddTool() { catalogQuery = ""; draft = Draft(); state.dialog = "work-add-tool" }
    /// The supported tools the search shows: not ticked, matching.
    public var catalogMatches: [ImportFlow.CatalogTool] {
        ImportFlow.catalog.filter { !state.picks.contains($0.id) && (catalogQuery.isEmpty || $0.name.lowercased().contains(catalogQuery.lowercased())) }
    }
    /// "Add tool": a known name picks the catalog tool; else a tool of the person's own, in Other, ticked.
    public func addTool() {
        let name = String(draft.tool.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        let website = draft.website.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        if !website.isEmpty && website.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) == nil { error = "Use a website beginning with https://"; return }
        error = ""
        if let known = ImportFlow.catalog.first(where: { $0.name.lowercased() == name.lowercased() }) { pickTool(known.id); return }
        let id = "custom:\(name.lowercased())"
        if !state.added.contains(where: { $0.id == id }) { state.added.append(AddedTool(id: id, name: name, website: website, source: "user", group: "other")) }
        pickTool(id)
    }
    public func pickerBack() async { if mode == .modal { await close() } else { state.screen = "projects"; state.dialog = nil } }

    /// A press on the scrim beside a dialog: closes it unless it needs an answer.
    public func scrimPressed() { if let d = state.dialog, !ImportFlowState.unskippable.contains(d) { state.dialog = nil } }

    /// The browser named as the profile popup says it: "Select your Chrome profile" (not "Google Chrome").
    public static func browserName(_ id: String?) -> String { ImportFlow.browsers.first { $0.id == id }?.name ?? "your browser" }
    public var browserNow: String { browsers == nil ? "your browser" : Self.browserName(browsers?["chosenId"]?.string) }

    /// The agents' consent dialog's words (the provider chosen, else the one Engelbart would pick).
    public var agentsConsentText: String {
        let runs = state.provider ?? providers?["decision"]?["pick"]?.string
        let cli = runs == "openai" ? "Codex" : runs == "anthropic" ? "Claude Code" : "Claude Code or Codex"
        let company = runs == "openai" ? "OpenAI" : runs == "anthropic" ? "Anthropic" : "Anthropic or OpenAI"
        let browser = OnboardingHelpers.runKeychain(browsers) && browsers?["chosenId"]?.string != nil ? Self.browserName(browsers?["chosenId"]?.string) : "browser"
        return "Engelbart will use \(cli) and your signed-in \(browser) to find and import context from the sources you selected. Agents run in the background, and imported files are saved locally on your device. Content the agents read may be sent to \(company) for processing."
    }

    /// The provider choice's options: the decision's when it asks, else the ready ones.
    public var providerChoices: [String] {
        let decision = providers?["decision"]
        return J.truthy(decision?["ask"]) ? J.strs(decision?["choices"]) : readyProviders()
    }
}
