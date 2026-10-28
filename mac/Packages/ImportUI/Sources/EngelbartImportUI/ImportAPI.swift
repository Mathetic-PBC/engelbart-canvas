import AppKit
import EngelbartCore
import EngelbartConnect

// Everything the screens of this package ask of main: src/renderer/import/import-api.js (Import your context) and the
// connect-* / library / tools / GitHub / Zotero calls of screens/ConnectLibrary.jsx and ui/ConnectDock.jsx, as one
// protocol. The app passes `EngineImportAPI` (ConnectEngine + its own closures); the tests pass `FakeImportAPI` (the
// standalone page's mock of main, src/renderer/import/standalone.jsx createMockApi). Answers are main's JSON snapshots
// (the renderer's shapes); failures throw, and the screens show `tidyError`.

@MainActor
public protocol ImportAPI: AnyObject {
    /// Where the API's announcements arrive (EventHub, Electron channel names): engelbart:connect, engelbart:discovery,
    /// engelbart:connectors, engelbart:tools, engelbart:library-changed.
    var events: EventHub { get }

    // Import your context (import-api.js)
    func flow() async throws -> JSONValue
    func saveFlow(_ flow: JSONValue?) async throws
    func providers(fresh: Bool) async throws -> JSONValue
    func rememberProvider(_ id: String) async throws
    func browsers() async throws -> JSONValue
    func chooseBrowser(_ id: String) async throws -> JSONValue
    func chooseBrowserProfile(_ browserId: String, _ profileId: String) async throws -> JSONValue
    func keychain(_ answer: String) async throws -> JSONValue
    func browserAgents(provider: String?, browserId: String?) async throws -> JSONValue
    func browserAgentsAnswer(_ answer: String) async throws
    func discovery() async throws -> JSONValue
    func discoverProjects(provider: String?, again: Bool) async throws -> JSONValue
    func discoverTools(provider: String?, browserId: String?, keychain: String?, again: Bool) async throws -> JSONValue
    func diskAccess() async throws -> JSONValue
    func openDiskAccess() async throws
    func foldersAsk(_ ids: [String]) async throws -> [String: String]
    func foldersAsked() async throws -> [String: String]
    func foldersNeeded(_ choices: JSONValue) async throws -> [JSONValue]
    func notesPermission() async throws -> JSONValue
    func detect() async throws -> JSONValue
    func obsidianTree() async throws -> JSONValue
    func connectStart(_ choices: JSONValue) async throws -> JSONValue
    func startProject(_ input: JSONValue) async throws -> JSONValue
    func openTrace() async throws

    // The tool check (Tools): its snapshot and its actions
    func tools() async throws -> JSONValue
    func toolsInstall(_ ids: [String]) async throws
    func toolsUpdate(_ id: String) async throws
    func toolsSignIn(_ id: String) async throws
    func toolsConnect(_ id: String) async throws
    func toolsCancelSignIn(_ id: String) async throws
    func toolsCheck() async throws

    // The Mac
    func openExternal(_ url: String) async throws
    func reveal(_ path: String) async throws
    func pickDirectory() async -> String?
    /// Files and folders, several at once (the sidebar's Choose from disk…).
    func pickFiles() async -> [(path: String, name: String)]

    // Connect your library's session
    func connectProviders() async throws -> [JSONValue]
    func connectList() async throws -> [JSONValue]
    func connectState(_ id: String) async throws -> JSONValue
    func connectAnswer(_ id: String, _ input: JSONValue) async throws -> JSONValue
    func connectGrant(_ id: String, apps: [String]) async throws -> JSONValue
    func connectAuthorize(_ id: String, app: String, kind: String, path: String?) async throws -> JSONValue
    func connectCancelSignIn(_ id: String, _ app: String) async throws
    func connectNeed(_ id: String, _ needId: String, _ action: String) async throws -> JSONValue
    func connectImport(_ id: String) async throws -> JSONValue
    func connectStop(_ id: String) async throws -> JSONValue
    func connectUnblock(_ id: String, provider: String?) async throws -> JSONValue
    func connectStopJob(_ id: String, _ jobId: String) async throws -> JSONValue
    func connectProvider(_ id: String, _ provider: String) async throws -> JSONValue
    func connectRetryMemory(_ id: String) async throws -> JSONValue
    func connectMinimize(_ id: String, _ value: Bool) async throws
    func connectDismiss(_ id: String) async throws
    func connectOfferSeen(_ how: String) async throws
    // The choose screen's sign-ins
    func connectConnectors() async throws -> [JSONValue]
    func connectConnectorSignIn(_ app: String) async throws -> JSONValue
    func connectConnectorCancel(_ app: String) async throws
    func connectSignInCheck(_ app: String, retry: Bool) async throws -> JSONValue
    func connectSignInNote(_ app: String, route: String?) async throws -> JSONValue
    func connectSignInPick(_ app: String, browser: String, profile: String) async throws
    func connectSignInUnlock(_ app: String) async throws -> JSONValue
    func connectSignInAnotherAccount(_ app: String) async throws
    func connectSignInBrowser(_ app: String) async throws -> JSONValue
    func connectSignInBrowserCancel(_ app: String?) async throws
    func connectSignInWindow(_ app: String) async throws -> JSONValue
    func connectSignInWindowClose() async throws

    // The library and Engelbart's own sign-ins
    func library() async throws -> [JSONValue]
    func addLibraryItem(_ input: String) async throws -> JSONValue
    func discardLibraryItem(_ id: String) async throws -> Bool
    func githubRepos() async throws -> JSONValue
    /// Zotero's or GitHub's own sign-in started and waited for (ConnectLibrary.jsx engelbartSignIn): true once connected,
    /// false when it stopped waiting. Zotero is synced after.
    func engelbartSignIn(_ app: String) async throws -> Bool
}

/// The calls the app makes for this package that Connect does not own: the tool check, projects, the library, GitHub
/// and Zotero, the Mac. Every closure has a harmless default so a partly wired app still runs.
public struct ImportAppHooks {
    public var tools: () async -> JSONValue = { ["checked": false, "tools": [:]] }
    public var toolsAction: (_ action: String, _ ids: [String]) async throws -> Void = { _, _ in }
    public var startProject: (JSONValue) async throws -> JSONValue = { _ in throw ConnectError("failed", "Projects are not wired") }
    public var library: () async -> [JSONValue] = { [] }
    public var addLibraryItem: (String) async throws -> JSONValue = { _ in throw ConnectError("failed", "The library is not wired") }
    public var discardLibraryItem: (String) async throws -> Bool = { _ in false }
    public var githubRepos: () async throws -> JSONValue = { ["repos": []] }
    public var engelbartSignIn: (String) async throws -> Bool = { _ in false }
    public var openExternal: (String) async throws -> Void = { url in if let u = URL(string: url) { NSWorkspace.shared.open(u) } }
    public var reveal: (String) async throws -> Void = { path in NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    public var pickDirectory: () async -> String? = { await ImportAppHooks.openPanel(directories: true, many: false).first }
    public var pickPaths: () async -> [String] = { await ImportAppHooks.openPanel(directories: true, many: true) }
    public init() {}

    /// NSOpenPanel (ENGELBART_PICK_PATHS, a ':'-separated list, answers instead, as Electron's test hook).
    @MainActor public static func openPanel(directories: Bool, many: Bool) async -> [String] {
        if let fake = ProcessInfo.processInfo.environment["ENGELBART_PICK_PATHS"] { return fake.split(separator: ":").map(String.init) }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = directories
        panel.canChooseFiles = many
        panel.allowsMultipleSelection = many
        return panel.runModal() == .OK ? panel.urls.map(\.path) : []
    }
}

/// The app's ImportAPI: every connect-* / import-* call goes to `ConnectEngine` (Connect's API.md), the rest to `hooks`.
@MainActor
public final class EngineImportAPI: ImportAPI {
    public let engine: ConnectEngine
    public var hooks: ImportAppHooks
    public let events: EventHub
    public init(engine: ConnectEngine, hooks: ImportAppHooks, events: EventHub = .shared) { self.engine = engine; self.hooks = hooks; self.events = events }

    public func flow() async throws -> JSONValue { await engine.importFlow() }
    public func saveFlow(_ flow: JSONValue?) async throws { _ = try await engine.importFlowSave(flow) }
    public func providers(fresh: Bool) async throws -> JSONValue { await engine.importProviders(fresh: fresh) }
    public func rememberProvider(_ id: String) async throws { _ = try await engine.importProviderRemember(id) }
    public func browsers() async throws -> JSONValue { await engine.importBrowsers() }
    public func chooseBrowser(_ id: String) async throws -> JSONValue { try await engine.importBrowserChoose(id) }
    public func chooseBrowserProfile(_ browserId: String, _ profileId: String) async throws -> JSONValue { try await engine.importBrowserProfile(browserId, profileId) }
    public func keychain(_ answer: String) async throws -> JSONValue { try await engine.importKeychain(answer) }
    public func browserAgents(provider: String?, browserId: String?) async throws -> JSONValue { await engine.importBrowserAgents(provider: provider, browserId: browserId) }
    public func browserAgentsAnswer(_ answer: String) async throws { _ = try await engine.importBrowserAgentsAnswer(answer) }
    public func discovery() async throws -> JSONValue { await engine.importDiscovery() }
    public func discoverProjects(provider: String?, again: Bool) async throws -> JSONValue { await engine.importDiscoverProjects(provider: provider, again: again) }
    public func discoverTools(provider: String?, browserId: String?, keychain: String?, again: Bool) async throws -> JSONValue {
        await engine.importDiscoverTools(provider: provider, browserId: browserId, keychain: keychain, again: again)
    }
    public func diskAccess() async throws -> JSONValue { engine.importDiskAccess() }
    public func openDiskAccess() async throws { _ = await engine.importOpenDiskAccess() }
    public func foldersAsk(_ ids: [String]) async throws -> [String: String] { try await engine.foldersAsk(ids) }
    public func foldersAsked() async throws -> [String: String] { await engine.foldersAsked() }
    public func foldersNeeded(_ choices: JSONValue) async throws -> [JSONValue] { await engine.foldersNeeded(choices) }
    public func notesPermission() async throws -> JSONValue { await engine.notesPermission() }
    public func detect() async throws -> JSONValue { await engine.detect() }
    public func obsidianTree() async throws -> JSONValue { await engine.importObsidianTree() }
    public func connectStart(_ choices: JSONValue) async throws -> JSONValue { try await engine.start(choices) }
    public func startProject(_ input: JSONValue) async throws -> JSONValue { try await hooks.startProject(input) }
    public func openTrace() async throws { _ = engine.importTraceOpen() }

    public func tools() async throws -> JSONValue { await hooks.tools() }
    public func toolsInstall(_ ids: [String]) async throws { try await hooks.toolsAction("install", ids) }
    public func toolsUpdate(_ id: String) async throws { try await hooks.toolsAction("update", [id]) }
    public func toolsSignIn(_ id: String) async throws { try await hooks.toolsAction("sign-in", [id]) }
    public func toolsConnect(_ id: String) async throws { try await hooks.toolsAction("connect", [id]) }
    public func toolsCancelSignIn(_ id: String) async throws { try await hooks.toolsAction("cancel-sign-in", [id]) }
    public func toolsCheck() async throws { try await hooks.toolsAction("check", []) }

    public func openExternal(_ url: String) async throws { try await hooks.openExternal(url) }
    public func reveal(_ path: String) async throws { try await hooks.reveal(path) }
    public func pickDirectory() async -> String? { await hooks.pickDirectory() }
    public func pickFiles() async -> [(path: String, name: String)] {
        await hooks.pickPaths().map { ($0, ($0 as NSString).lastPathComponent.isEmpty ? $0 : ($0 as NSString).lastPathComponent) }
    }

    public func connectProviders() async throws -> [JSONValue] { engine.providersList() }
    public func connectList() async throws -> [JSONValue] { await engine.list() }
    public func connectState(_ id: String) async throws -> JSONValue { try engine.state(id) }
    public func connectAnswer(_ id: String, _ input: JSONValue) async throws -> JSONValue { try engine.answer(id, input) }
    public func connectGrant(_ id: String, apps: [String]) async throws -> JSONValue { try engine.grant(id, ["apps": .array(apps.map(JSONValue.string))]) }
    public func connectAuthorize(_ id: String, app: String, kind: String, path: String?) async throws -> JSONValue { try await engine.authorize(id, app: app, kind: kind, path: path) }
    public func connectCancelSignIn(_ id: String, _ app: String) async throws { _ = try engine.cancelSignIn(id, app) }
    public func connectNeed(_ id: String, _ needId: String, _ action: String) async throws -> JSONValue { try await engine.need(id, needId, action) }
    public func connectImport(_ id: String) async throws -> JSONValue { try engine.importNow(id) }
    public func connectStop(_ id: String) async throws -> JSONValue { try engine.stop(id) }
    public func connectUnblock(_ id: String, provider: String?) async throws -> JSONValue { try engine.unblock(id, provider: provider) }
    public func connectStopJob(_ id: String, _ jobId: String) async throws -> JSONValue { try engine.stopJob(id, jobId) }
    public func connectProvider(_ id: String, _ provider: String) async throws -> JSONValue { try engine.setProvider(id, provider) }
    public func connectRetryMemory(_ id: String) async throws -> JSONValue { try engine.retryMemory(id) }
    public func connectMinimize(_ id: String, _ value: Bool) async throws { _ = try engine.minimize(id, value) }
    public func connectDismiss(_ id: String) async throws { _ = try engine.dismiss(id) }
    public func connectOfferSeen(_ how: String) async throws { _ = await engine.offerSeen(how) }
    public func connectConnectors() async throws -> [JSONValue] { await engine.connectorsList() }
    public func connectConnectorSignIn(_ app: String) async throws -> JSONValue { try await engine.connectorSignIn(app) }
    public func connectConnectorCancel(_ app: String) async throws { _ = engine.connectorCancel(app) }
    public func connectSignInCheck(_ app: String, retry: Bool) async throws -> JSONValue { await engine.signInCheck(app, retry: retry) }
    public func connectSignInNote(_ app: String, route: String?) async throws -> JSONValue { await engine.signInNote(app, route: route) }
    public func connectSignInPick(_ app: String, browser: String, profile: String) async throws { _ = engine.signInPick(app, browser: browser, profile: profile) }
    public func connectSignInUnlock(_ app: String) async throws -> JSONValue { await engine.signInUnlock(app) }
    public func connectSignInAnotherAccount(_ app: String) async throws { _ = await engine.signInAnotherAccount(app) }
    public func connectSignInBrowser(_ app: String) async throws -> JSONValue { await engine.signInBrowser(app) }
    public func connectSignInBrowserCancel(_ app: String?) async throws { _ = engine.signInBrowserCancel(app) }
    public func connectSignInWindow(_ app: String) async throws -> JSONValue { await engine.signInWindowOpen(app) }
    public func connectSignInWindowClose() async throws { _ = engine.signInWindowClose() }

    public func library() async throws -> [JSONValue] { await hooks.library() }
    public func addLibraryItem(_ input: String) async throws -> JSONValue { try await hooks.addLibraryItem(input) }
    public func discardLibraryItem(_ id: String) async throws -> Bool { try await hooks.discardLibraryItem(id) }
    public func githubRepos() async throws -> JSONValue { try await hooks.githubRepos() }
    public func engelbartSignIn(_ app: String) async throws -> Bool { try await hooks.engelbartSignIn(app) }
}
