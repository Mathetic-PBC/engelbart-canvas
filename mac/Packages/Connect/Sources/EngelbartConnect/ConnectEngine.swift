import Foundation
import AppKit
import WebKit
import EngelbartCore

// The whole of Connect and Import your context, wired as src/main/index.cjs wires them, with the calls the window makes
// (src/main/ipc.cjs connect-* and import-*, src/preload.cjs) as methods and the events it listens to posted on
// EventHub.shared under the Electron channel names: engelbart:connect (a session's snapshot), engelbart:discovery,
// engelbart:connectors, engelbart:project-changed. The import/onboarding screens (a later package) call these.
//
// Test hooks kept: ENGELBART_CONNECT_FAKE / ENGELBART_BART_FAKE (fake agents, ENGELBART_CONNECT_FAKE_MS), ENGELBART_CONNECT_FAKE_CLI
// with the tools fake's state, ENGELBART_CONNECT_FAKE_REFUSE, ENGELBART_CONNECT_FAKE_NEEDS, ENGELBART_PROVIDERS_FAKE,
// ENGELBART_BROWSER_AGENTS, ENGELBART_DISK_ACCESS, ENGELBART_ONBOARDING_BROWSERS, ENGELBART_CONNECT_OFFER=off,
// ENGELBART_CONNECT_APPLICATIONS, ENGELBART_HEADLESS.
@MainActor
public final class ConnectEngine {
    /// What the app hands the engine (the Store, Tools, Terminal, Stage and Integrations adapters).
    public struct Host {
        public var store: ConnectStore
        public var homeDir: String
        public var env: [String: String] = ProcessInfo.processInfo.environment
        /// Where Electron's userData things go (connect-runs, codex homes): ~/Library/Application Support/Engelbart Swift.
        public var appSupportDir: String
        public var tools: ConnectToolManager?
        public var toolRecords: () -> [String: Providers.ToolRecord] = { [:] }
        /// The tools fake's pretend CLIs (ENGELBART_TOOLS_FAKE), for ENGELBART_CONNECT_FAKE_CLI.
        public var toolsFakeState: ((String) -> (present: Bool, broken: Bool, signedIn: Bool?))?
        public var terminal: AgentTerminal?
        public var models: () -> JSONValue? = { nil }
        /// The providers whose CLI can run now (index.cjs connectReady).
        public var ready: () -> [String] = { ConnectModels.providers }
        public var zotero: ConnectZotero = .none
        public var github: ConnectGitHub = .none
        public var importer: CookieImporter?
        public var parentWindow: () -> NSWindow? = { nil }
        public var post: (String, JSONValue) -> Void = { EventHub.shared.post($0, $1) }
        public init(store: ConnectStore, homeDir: String, appSupportDir: String) { self.store = store; self.homeDir = homeDir; self.appSupportDir = appSupportDir }
    }

    public let host: Host
    public let trace: Trace
    public let connectors: Connectors
    public let browser: AgentBrowserWindows
    public let appleNotes: AppleNotes
    public let prefs: OnboardingPrefs
    public let browsers: Browsers
    public let webSignIn: WebSignIn
    public let signInWindow: SignInWindow
    public let browserAgents: BrowserAgents
    public let connect: Connect
    public let providers: Providers
    public let diskAccess: DiskAccess
    public let discovery: Discovery
    public let scanner: Scanner
    public let traceWindow: TraceWindow
    let jar: WKCookieJar
    var dataRoot = ""
    var diskGranted = false

    public init(_ host: Host) {
        self.host = host
        let env = host.env
        let store = host.store
        let box = Box("")
        dataRootBox = box
        jar = WKCookieJar()
        prefs = OnboardingPrefs(dataRoot: { box.get() })
        trace = Trace(dataRoot: { box.get() })
        traceWindow = TraceWindow(trace: trace, traceDir: { URL(fileURLWithPath: box.get()).appendingPathComponent(".connect/trace") })
        let connectFake = env["ENGELBART_CONNECT_FAKE"] == "1" || env["ENGELBART_BART_FAKE"] == "1"
        let cliFake = connectFake && host.toolsFakeState != nil && env["ENGELBART_CONNECT_FAKE_CLI"] == "1"
        let prefs = self.prefs
        // A page Engelbart opens for the person to act on (a connector's consent): in the browser chosen for sign-ins.
        let openChosen: @Sendable (String) async throws -> Void = { url in
            if let id = prefs.get()["browser"]?.string, let b = ImportFlow.browserById(id) { _ = try await ProcessRunner.check("/usr/bin/open", ["-b", b.bundle, url]) }
            else { _ = try await ProcessRunner.check("/usr/bin/open", [url]) }
        }
        let post = host.post
        connectors = Connectors(file: { URL(fileURLWithPath: box.get()).appendingPathComponent("connectors.json") }, crypt: KeychainCrypt(service: "Engelbart Swift connectors"),
                                openExternal: openChosen, onChange: { status in Task { @MainActor in post("engelbart:connectors", status.json) } },
                                own: OwnConnectors(homeDir: host.homeDir, env: env.merging(host.tools?.environment() ?? [:]) { _, b in b }))
        appleNotes = AppleNotes()
        browser = AgentBrowserWindows()
        diskAccess = DiskAccess(homeDir: host.homeDir)
        let disk = diskAccess
        var webRef: WebSignIn?
        browsers = Browsers(prefs: prefs, profilesOf: { webRef?.profilesOf($0) ?? [] }, unlock: { await webRef?.unlockBrowser($0) ?? ["keychain": "allowed"] }, diskAccess: { disk.status()["granted"] == .bool(true) })
        let browsersRef = browsers
        let trace = self.trace
        webSignIn = WebSignIn(importer: host.importer, jar: jar, defaultBrowser: { browsersRef.preferredName().nilIfEmpty ?? Browsers.macDefault() }, openExternal: openChosen,
                              openIn: { id, url in guard let b = ImportFlow.browserById(id) else { throw ConnectError("failed", "No way to open \(id)") }; _ = try await ProcessRunner.check("/usr/bin/open", ["-b", b.bundle, url]) },
                              openInProfile: { id, profile, url in guard let b = ImportFlow.browserById(id) else { throw ConnectError("failed", "No way to open \(id)") }; _ = try await ProcessRunner.check("/usr/bin/open", WebSignIn.profileOpenArgs(bundle: b.bundle, profileId: profile, url: url)) },
                              picks: SigninProfiles(dataRoot: { URL(fileURLWithPath: box.get()) }),
                              chosen: { let p = prefs.get(); return WebSignIn.Chosen(browser: p["browser"]?.string, profile: p["profile"]?.string, keychain: p["keychain"]?.string) },
                              log: { text, detail in if detail?["kind"]?.string == "signin-check" { trace.event(kind: "signin-check", text: text, detail: detail) } })
        webRef = webSignIn
        let web = webSignIn
        signInWindow = SignInWindow(jar: jar, parent: host.parentWindow, signedIn: { await web.signedIn($0) })
        browserAgents = BrowserAgents(homeDir: host.homeDir, env: env, prefs: prefs, fake: env["ENGELBART_BROWSER_AGENTS"] ?? (connectFake ? "none" : ""))
        let delay = Double(env["ENGELBART_CONNECT_FAKE_MS"] ?? "") ?? 700
        let base: ConnectAgents = connectFake
            ? (cliFake ? (CliGatedAgents(FakeAgents(delayMs: delay, env: env), state: host.toolsFakeState!, refuse: (env["ENGELBART_CONNECT_FAKE_REFUSE"] ?? "").components(separatedBy: ",").filter { !$0.isEmpty }) as ConnectAgents) : (FakeAgents(delayMs: delay, env: env) as ConnectAgents))
            : CLIAgents(environment: env, runDirectory: (host.appSupportDir as NSString).appendingPathComponent("connect-runs"), interviewHome: (host.appSupportDir as NSString).appendingPathComponent("codex-home-connect"),
                        importHome: (host.appSupportDir as NSString).appendingPathComponent("codex-home-connect-import"), tools: host.tools, terminal: host.terminal)
        let agents = trace.wrap(base)
        let ready: () -> [String] = connectFake && !cliFake ? { ConnectModels.providers } : host.ready
        providers = Providers(records: host.toolRecords, prefs: prefs, homeDir: host.homeDir, env: env, fake: env["ENGELBART_PROVIDERS_FAKE"] ?? (connectFake && !cliFake ? "both" : ""),
                              check: host.tools.map { t in { await t.check($0) } })
        scanner = Scanner()
        var deps = ConnectDeps(agents: agents, store: store, homeDir: host.homeDir)
        deps.env = env; deps.models = host.models; deps.ready = ready; deps.zotero = host.zotero; deps.github = host.github
        deps.notify = { post("engelbart:connect", $0) }
        deps.placed = { post("engelbart:project-changed", ["projectId": .string($0)]) }
        deps.browser = browser; deps.connectors = connectors; deps.appleNotes = appleNotes; deps.webSignIn = webSignIn; deps.signInWindow = signInWindow
        deps.trace = trace; deps.browserAgents = browserAgents
        deps.openBrowserApp = { id in
            let args: [String]? = ImportFlow.browserById(id).map { ["-b", $0.bundle] } ?? (id == "vivaldi" ? ["-a", "Vivaldi"] : nil)
            guard let args else { throw ConnectError("failed", "Unknown browser") }
            _ = try await ProcessRunner.check("/usr/bin/open", args, timeout: 10)
        }
        let tools = host.tools
        deps.providerCheck = { provider in Task { await tools?.check([provider == "openai" ? "codex" : "claude"]) } }
        connect = Connect(deps)
        var dd = Discovery.Deps(agents: agents, store: store, homeDir: host.homeDir, providers: providers, prefs: prefs)
        dd.env = env; dd.models = host.models; dd.webSignIn = webSignIn; dd.importer = host.importer; dd.browser = browser; dd.zotero = host.zotero; dd.github = host.github
        dd.connectors = connectors; dd.notify = { post("engelbart:discovery", $0) }; dd.trace = trace; dd.scanner = scanner
        dd.diskAccess = { disk.status()["granted"] == .bool(true) }
        discovery = Discovery(dd)
        let connectRef = connect
        browser.log = { jobId, text in connectRef.logJob(jobId, text) }
        browser.onClosed = { jobId in connectRef.windowClosed(jobId) }
        trace.notify = { [weak traceWindow] entry in Task { @MainActor in traceWindow?.send(entry) } }
        dd.access = { [weak self] root in self?.accessGuard(root) }
        discovery.deps.access = dd.access
    }

    let dataRootBox: Box<String>

    /// The data root open now: read before every call (the store may switch library, or test mode).
    func refresh() async -> String {
        let root = await host.store.dataRoot()
        if root != dataRootBox.get() {
            dataRootBox.set(root)
            // Already allowed to read every folder macOS guards: the folders count as allowed for the guard too.
            if diskAccess.status()["granted"] == .bool(true) {
                diskGranted = true
                FolderAccess.writeAnswers(dataRoot: URL(fileURLWithPath: root), Dictionary(uniqueKeysWithValues: FolderAccess.protectedFolders(homeDir: host.homeDir).map { ($0.id, "allowed") }))
            }
        }
        return root
    }

    func accessGuard(_ root: String) -> FolderAccess.Guard {
        diskGranted ? FolderAccess.guardFor(homeDir: host.homeDir, answers: Dictionary(uniqueKeysWithValues: FolderAccess.protectedFolders(homeDir: host.homeDir).map { ($0.id, "allowed") }))
                    : FolderAccess.guardFor(homeDir: host.homeDir, dataRoot: URL(fileURLWithPath: root))
    }

    static func check(_ value: String?, _ what: String, _ max: Int) throws -> String {
        guard let v = value, !v.isEmpty, v.count <= max else { throw ConnectError("failed", "\(what) is invalid") }
        return v
    }

    // MARK: connect-*

    /// connect-detect: which apps are here (read off the main actor) → { platform, apps, sites, github, localRepos }.
    public func detect() async -> JSONValue {
        let root = await refresh()
        let guardian = accessGuard(root)
        let signedIn = await connectSignedIn()
        var connected: [String: Bool] = [:]
        for app in Connectors.order { connected[app] = (try? connectors.status(app).connected) == true }
        let apps = host.env["ENGELBART_CONNECT_APPLICATIONS"].map { $0.components(separatedBy: ":").filter { !$0.isEmpty } }
        let homeDir = host.homeDir, env = host.env, zs = host.zotero.status(), gs = host.github.status()
        let found = (try? await scanner.run("detect") { Scan.detect(homeDir: homeDir, env: env, zotero: zs, github: gs, signedIn: signedIn, connectors: { connected[$0] ?? false }, applications: apps, access: guardian) })
        var o = found?.json.object ?? [:]
        o["platform"] = "darwin"
        return .object(o)
    }

    /// The apps Engelbart's store holds a sign-in cookie for.
    public func connectSignedIn() async -> [String] {
        var out: [String] = []
        for name in ConnectSources.signInCookieOrder where ConnectSources.apps[name] != nil { if await webSignIn.signedIn(name) { out.append(name) } }
        return out
    }

    public func providersList() -> [JSONValue] { connect.providers() }
    public func start(_ input: JSONValue) async throws -> JSONValue { _ = await refresh(); guard input.object != nil else { throw ConnectError("failed", "choices is invalid") }; return try await connect.start(input) }
    public func answer(_ id: String, _ input: JSONValue) throws -> JSONValue { try connect.answer(try Self.check(id, "import id", 64), input) }
    public func grant(_ id: String, _ input: JSONValue) throws -> JSONValue { try connect.grant(try Self.check(id, "import id", 64), input) }
    public func authorize(_ id: String, app: String, kind: String, path: String? = nil) async throws -> JSONValue {
        var o: [String: JSONValue] = ["app": .string(try Self.check(app, "app", 64)), "kind": .string(try Self.check(kind, "kind", 16))]
        if let path { o["path"] = .string(String(path.prefix(4096))) }
        return try await connect.authorize(try Self.check(id, "import id", 64), .object(o))
    }
    public func cancelSignIn(_ id: String, _ app: String) throws -> Bool { try connect.cancelSignIn(id, app) }
    public func signInNote(_ app: String, route: String? = nil) async -> JSONValue { await connect.signInNote(app, route: route == "browser" ? "browser" : "") }
    public func signInPick(_ app: String, browser: String, profile: String) -> Bool { connect.signInPick(app, browser: browser, profile: profile) }
    public func signInBrowser(_ app: String) async -> JSONValue { await connect.signInBrowser(app) }
    public func signInUnlock(_ app: String) async -> JSONValue { await connect.signInUnlock(app) }
    public func signInAnotherAccount(_ app: String) async -> JSONValue { await connect.signInAnotherAccount(app) }
    public func signInBrowserCancel(_ app: String? = nil) -> Bool { connect.signInBrowserCancel(app ?? "") }
    public func signInCheck(_ app: String, retry: Bool = false) async -> JSONValue { await connect.signInCheck(app, retry: retry) }
    public func signInWindowOpen(_ app: String) async -> JSONValue { await connect.signInWindowOpen(app) }
    public func signInWindowClose() -> Bool { connect.signInWindowClose() }

    public func foldersNeeded(_ choices: JSONValue) async -> [JSONValue] {
        let root = await refresh()
        return FolderAccess.needed(choices, homeDir: host.homeDir, dataRoot: URL(fileURLWithPath: root)).map { ["id": .string($0.id), "name": .string($0.name)] }
    }
    public func foldersAsked() async -> [String: String] { FolderAccess.readAnswers(dataRoot: URL(fileURLWithPath: await refresh())) }
    public func foldersAsk(_ ids: [String]) async throws -> [String: String] {
        guard ids.count <= 40, ids.allSatisfy({ $0.count < 400 }) else { throw ConnectError("failed", "ids must be a list of folder ids") }
        return await FolderAccess.ask(ids, homeDir: host.homeDir, dataRoot: URL(fileURLWithPath: await refresh()))
    }

    public func need(_ id: String, _ needId: String, _ action: String) async throws -> JSONValue { try await connect.need(try Self.check(id, "import id", 64), try Self.check(needId, "request id", 64), try Self.check(action, "action", 8)) }
    public func importNow(_ id: String) throws -> JSONValue { try connect.importNow(id) }
    public func stop(_ id: String) throws -> JSONValue { try connect.stop(id) }
    public func unblock(_ id: String, provider: String? = nil) throws -> JSONValue { try connect.unblock(id, provider: provider == "anthropic" || provider == "openai" ? provider : nil) }
    public func stopJob(_ id: String, _ jobId: String) throws -> JSONValue { try connect.stopJob(id, jobId) }
    public func setProvider(_ id: String, _ provider: String) throws -> JSONValue { try connect.setProvider(id, provider) }
    public func retryMemory(_ id: String) throws -> JSONValue { try connect.retryMemory(id) }
    public func minimize(_ id: String, _ value: Bool) throws -> JSONValue { try connect.setMinimized(id, value) }
    public func dismiss(_ id: String) throws -> Bool { try connect.dismiss(id) }
    public func state(_ id: String) throws -> JSONValue { try connect.state(id) }
    /// connect-list: a session that was still going when Engelbart closed goes on now (resume), before the list is read.
    public func list() async -> [JSONValue] { let root = await refresh(); await connect.resume(dataRoot: root); return connect.list(dataRoot: root) }
    public func notesPermission() async -> JSONValue { let p = await appleNotes.permission(); return ["allowed": .bool(p.allowed), "error": .string(p.error), "refused": .bool(p.refused)] }
    public func connectorsList() async -> [JSONValue] { _ = await refresh(); return connectors.list().map(\.json) }
    public func connectorSignIn(_ app: String) async throws -> JSONValue { _ = await refresh(); return try await connectors.signIn(app).json }
    public func connectorCancel(_ app: String) -> Bool { connectors.cancel(app); return true }

    /// connect-offer: the one-time popup for someone with projects, until it has been seen once in this data root.
    public func offer() async -> JSONValue {
        if host.env["ENGELBART_CONNECT_OFFER"] == "off" { return ["show": false] }
        let file = URL(fileURLWithPath: await refresh()).appendingPathComponent(".connect/offer.json")
        guard let v = Files.readJSON(file) else { return ["show": true] }
        return ["show": .bool(!JS.truthy(v["seen"]))]
    }
    @discardableResult
    public func offerSeen(_ how: String?) async -> Bool {
        let file = URL(fileURLWithPath: await refresh()).appendingPathComponent(".connect/offer.json")
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? Files.writeAtomically(JSONValue.object(["seen": true, "how": .string(how == "started" ? "started" : "dismissed"), "at": .string(Time.iso())]).text(), to: file, mode: 0o600)
        return true
    }

    /// connect-memory: whether there is a MEMORY.md in this data root.
    public func memoryInfo() async -> JSONValue {
        let file = Memory.path(URL(fileURLWithPath: await refresh()))
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path) else { return ["exists": false, "path": .string(file.path)] }
        return ["exists": true, "path": .string(file.path), "updated": .string(Time.iso((attrs[.modificationDate] as? Date) ?? Date())), "bytes": .number(Double((attrs[.size] as? Int) ?? 0))]
    }

    // MARK: import-*

    public func importProviders(fresh: Bool = false) async -> JSONValue { _ = await refresh(); return await providers.status(fresh: fresh) }
    public func importProviderRemember(_ provider: String) async throws -> JSONValue {
        guard provider == "anthropic" || provider == "openai" else { throw ConnectError("failed", "provider is invalid") }
        _ = await refresh(); return try await providers.remember(provider)
    }
    public func importBrowsers() async -> JSONValue { _ = await refresh(); return await browsers.list() }
    public func importBrowserChoose(_ id: String) async throws -> JSONValue { _ = await refresh(); return try await browsers.choose(id) }
    public func importBrowserProfile(_ browserId: String, _ profileId: String) async throws -> JSONValue { _ = await refresh(); return try await browsers.chooseProfile(browserId, profileId) }
    public func importKeychain(_ answer: String) async throws -> JSONValue { _ = await refresh(); return try await browsers.setKeychain(answer) }
    public func importBrowserAgents(provider: String? = nil, browserId: String? = nil) async -> JSONValue { _ = await refresh(); return browserAgents.status(provider: provider, browserId: browserId).json }
    public func importBrowserAgentsAnswer(_ answer: String?) async throws -> JSONValue { _ = await refresh(); return try browserAgents.consent(answer).map { .string($0) } ?? .null }
    public func importDiscovery() async -> JSONValue { _ = await refresh(); return await discovery.state() }
    public func importDiscoverProjects(provider: String? = nil, again: Bool = false) async -> JSONValue { _ = await refresh(); return await discovery.startProjects(provider: provider, again: again) }
    public func importDiscoverTools(provider: String? = nil, browserId: String? = nil, keychain: String? = nil, again: Bool = false) async -> JSONValue {
        _ = await refresh(); return await discovery.startTools(provider: provider, browserId: browserId, keychain: keychain == "allowed" || keychain == "declined" ? keychain : nil, again: again)
    }
    public func importDiscoveryStop() async -> JSONValue { await discovery.stop() }
    public func importDiscoveryReset() async -> JSONValue { await discovery.reset() }
    public func importDiskAccess() -> JSONValue { diskAccess.status() }
    public func importOpenDiskAccess() async -> JSONValue { await diskAccess.openSettings() }
    public func importFlow() async -> JSONValue { _ = await refresh(); return prefs.get()["flow"] ?? .null }
    public func importFlowSave(_ flow: JSONValue?) async throws -> Bool {
        _ = await refresh()
        if let flow, !flow.isNull { guard flow.object != nil else { throw ConnectError("failed", "flow is invalid") }; _ = try prefs.set(["flow": flow]) } else { _ = try prefs.set(["flow": .null]) }
        return true
    }
    public func importTraceOpen() -> Bool { traceWindow.open() }
    public func importObsidianTree() async -> JSONValue { let home = host.homeDir; return (try? await scanner.run("obsidianTree") { ObsidianTree.tree(homeDir: home) }) ?? ["vaults": [], "truncated": false] }

    // MARK: lifecycle

    /// will-quit: every session still going saved, its agents ended.
    public func suspendAll() { connect.suspendAll() }
    /// Test mode's reset: what is kept outside the data root forgotten too.
    public func afterTestReset(dataRoot: String) { webSignIn.forget(); connect.forget(dataRoot: dataRoot); discovery.forget(dataRoot) }
    public func attachProject(id: String, projectId: String, workspaceId: String? = nil) async -> Int { await connect.attachProject(dataRoot: await refresh(), id: id, projectId: projectId, workspaceId: workspaceId) }
}

