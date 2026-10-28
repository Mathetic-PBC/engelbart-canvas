import Foundation
import EngelbartCore
import EngelbartConnect

// main, without main (src/renderer/import/standalone.jsx createMockApi, 2026-10-13): timers in place of agents, nothing
// read or sent. The standalone page's mock was how the flow was shown without the app; here it drives the screens in
// the tests and in a preview. Every call is logged (`calls`); the connect-* answers can be scripted (`answer`).

@MainActor
public final class FakeImportAPI: ImportAPI {
    public let events = EventHub()
    /// "call arg…" for each call, in order.
    public var calls: [String] = []
    /// Seconds before a fake agent answers (0: answered when the test calls `settle…`).
    public var delay: Double

    // The standalone page's config.
    public var scenario: String
    public var browserIds: [String]
    /// 'allowed' (the CLI lets its agents use the browser), 'ask', 'none'.
    public var agents: String
    /// Desktop, Documents and Downloads asked about before.
    public var disk: Bool
    public var sampleProjects: [JSONValue]
    public var sampleTools: JSONValue

    public static let scenarios: [String: [(installed: Bool, signedIn: Bool, plan: String?)]] = [
        "both": [(true, true, "max"), (true, true, "plus")],
        "claude": [(true, true, "max"), (true, true, nil)],
        "codex": [(true, true, nil), (true, true, "plus")],
        "none": [(false, false, nil), (false, false, nil)],
        "signed-out": [(true, false, nil), (true, false, nil)],
    ]
    public static let projects: [JSONValue] = [
        ["id": "engelbart", "title": "Engelbart context import", "description": "Designing how agents bring project context into a local library.", "recent": "Today", "folder": "~/engelbart-canvas", "evidence": "64 Claude Code sessions in ~/engelbart-canvas"],
        ["id": "requirements", "title": "Programming requirements study", "description": "Studying how novice programmers describe and test requirements.", "recent": "Yesterday", "evidence": "12 Codex sessions, 9 Obsidian notes"],
        ["id": "reading", "title": "Learning sciences reading guide", "description": "Organizing research on learning, agency and programming.", "recent": "This week", "evidence": "Zotero collection \"Learning sciences\""],
        ["id": "launch", "title": "Engelbart launch", "description": "Preparing onboarding, outreach and the first user sessions.", "recent": "This week", "evidence": "8 Claude chats"],
    ]
    static let usedTools = ["Obsidian", "Codex", "Claude Code", "Cursor", "PDFs on this Mac", "__sites", "Notion", "Google Docs", "Claude", "ChatGPT", "Zotero", "Overleaf", "GitHub", "Granola", "Gmail"]
    public static var tools: JSONValue {
        ["tools": .array(ImportFlow.catalog.map { tool in
            ["id": .string(tool.id), "used": .bool(usedTools.contains(tool.id)), "evidence": .string(tool.local ? "Found on this Mac" : "Signed in"), "method": .string(tool.local ? "local" : "browser")]
        }), "additional": [["name": "Linear", "website": "https://linear.app", "used": true, "evidence": "41 visits this month"]]]
    }

    // What main would hold.
    public var remembered: String?
    public var savedFlow: JSONValue = .null
    public var disc: JSONValue = ["projects": ["status": "idle"], "tools": ["status": "idle"]]
    public var keychainAnswer: String?
    public var browserChosen: String?
    public var profileChosen: String?
    public var diskGranted = false
    public var agentsAnswer: String?
    public var cli: [String: (state: String, busy: JSONValue?, plan: String?)] = [:]
    public var lastChoices: JSONValue?
    public var projectsMade: [JSONValue] = []

    // Connect your library's main.
    public var sessions: [String: JSONValue] = [:]
    public var found: JSONValue = ["apps": ["Obsidian": ["found": true], "Claude Code": ["found": true], "Codex": ["found": true], "Cursor": ["found": true], "PDFs on this Mac": ["found": true]],
                                   "sites": ["found": true], "github": ["found": false], "localRepos": []]
    public var providerList: [JSONValue] = [["provider": "anthropic", "name": "Claude Code", "ready": true, "modelName": "Sonnet", "effort": "high"],
                                            ["provider": "openai", "name": "Codex", "ready": true, "modelName": "GPT-5", "effort": "high"]]
    public var libraryRows: [JSONValue] = []
    public var connectorsAnswer: [JSONValue] = []
    /// Scripted answers by call name ("signInCheck", "signInNote", "signInWindow", "signInBrowser", "signInUnlock",
    /// "connectorSignIn", "notesPermission", "foldersNeeded", "engelbartSignIn"): (arg) → answer.
    public var answer: [String: (String) async -> JSONValue] = [:]
    public var pickedDirectory: String? = "/Users/you/Documents/Papers"
    public var pickedFiles: [(path: String, name: String)] = [("/Users/you/Documents/Engelbart notes.md", "Engelbart notes.md")]
    public var failNext: String?

    public init(scenario: String = "both", browsers: [String] = ["arc", "chrome", "safari", "firefox"], agents: String = "ask", disk: Bool = false, delay: Double = 0) {
        self.scenario = scenario; self.browserIds = browsers; self.agents = agents; self.disk = disk; self.delay = delay
        self.sampleProjects = Self.projects
        self.sampleTools = Self.tools
        let start = Self.scenarios[scenario] ?? Self.scenarios["both"]!
        for (i, id) in ["claude", "codex"].enumerated() {
            let one = start[i]
            cli[id] = (!one.installed ? "missing" : one.signedIn ? "ready" : "signed-out", nil, one.plan)
        }
    }

    func log(_ name: String, _ args: String...) { calls.append(([name] + args).joined(separator: " ")) }
    func check(_ name: String) throws { if failNext == name { failNext = nil; throw ConnectError("failed", "\(name) failed") } }
    func later(_ fn: @escaping @MainActor () -> Void) {
        if delay <= 0 { return }
        let ns = UInt64(delay * 1_000_000_000)
        Task { @MainActor in try? await Task.sleep(nanoseconds: ns); fn() }
    }

    // MARK: providers and the tool check

    public func providerEntries() -> [JSONValue] {
        ["claude", "codex"].map { id in
            let one = cli[id]!
            let signedIn = one.state == "ready"
            return ["id": .string(id == "claude" ? "anthropic" : "openai"), "installed": .bool(one.state != "missing"), "signedIn": .bool(signedIn),
                    "subscription": signedIn ? (one.plan.map(JSONValue.string) ?? .null) : .null, "subscribed": .bool(signedIn && one.plan != nil)]
        }
    }
    /// shared/import-flow.cjs chooseProvider's rule: both subscribed is always asked (the one picked before suggested).
    func decide(_ list: [JSONValue]) -> JSONValue {
        let ready = list.filter { J.truthy($0["installed"]) && J.truthy($0["signedIn"]) }
        if ready.isEmpty { return ["pick": nil, "ask": false, "choices": [], "setup": true] }
        let paid = ready.filter { J.truthy($0["subscription"]) }
        if paid.count >= 2 {
            let suggested: JSONValue = remembered.flatMap { r in paid.contains { J.str($0["id"]) == r } ? .string(r) : nil } ?? .null
            return ["pick": nil, "ask": true, "choices": .array(paid.map { $0["id"]! }), "setup": false, "suggested": suggested]
        }
        if paid.count == 1 { return ["pick": paid[0]["id"]!, "ask": false, "choices": [paid[0]["id"]!], "setup": false] }
        return ["pick": ready[0]["id"]!, "ask": false, "choices": [ready[0]["id"]!], "setup": false]
    }
    public func snapTools() -> JSONValue {
        var tools: [String: JSONValue] = ["git": ["id": "git", "status": "ready", "installed": true, "busy": nil]]
        for id in ["claude", "codex"] {
            let one = cli[id]!
            let installing = J.str(one.busy?["action"]) == "install"
            tools[id] = ["id": .string(id), "name": .string(id == "claude" ? "Claude Code" : "Codex"), "installed": .bool(one.state != "missing"), "status": .string(installing ? "installing" : one.state),
                         "signedIn": .bool(one.state == "ready"), "busy": one.busy ?? .null, "error": nil, "checkedAt": .string(one.state)]
        }
        return ["checked": true, "platform": "darwin", "tools": .object(tools)]
    }
    func emitTools() { events.post("engelbart:tools", snapTools()) }
    /// A CLI installed (as the fake's install finishing): not signed in.
    public func finishInstall(_ id: String) { cli[id]?.busy = nil; cli[id]?.state = "signed-out"; emitTools() }
    /// A CLI's sign-in finished in the browser: ready, with a plan.
    public func finishSignIn(_ id: String) { cli[id]?.busy = nil; cli[id]?.state = "ready"; if cli[id]?.plan == nil { cli[id]?.plan = id == "claude" ? "max" : "plus" }; emitTools() }
    func install(_ id: String) {
        guard let one = cli[id], one.state == "missing", one.busy == nil else { return }
        cli[id]?.busy = ["action": "install"]; emitTools()
        later { self.finishInstall(id) }
    }
    func signIn(_ id: String) {
        cli[id]?.busy = ["action": "sign-in", "url": .string("https://example.invalid/\(id)/sign-in")]; emitTools()
        later { self.finishSignIn(id) }
    }

    public func providers(fresh: Bool) async throws -> JSONValue {
        log("providers", fresh ? "fresh" : "")
        try check("providers")
        let list = providerEntries()
        return ["providers": .array(list), "decision": decide(list), "remembered": remembered.map(JSONValue.string) ?? .null]
    }
    public func rememberProvider(_ id: String) async throws { log("rememberProvider", id); remembered = id }
    public func tools() async throws -> JSONValue { log("tools"); return snapTools() }
    public func toolsInstall(_ ids: [String]) async throws { log("toolsInstall", ids.joined(separator: ",")); ids.forEach(install) }
    public func toolsUpdate(_ id: String) async throws { log("toolsUpdate", id) }
    public func toolsSignIn(_ id: String) async throws { log("toolsSignIn", id); if cli[id] != nil && cli[id]!.state != "missing" { signIn(id) } }
    public func toolsConnect(_ id: String) async throws {
        log("toolsConnect", id)
        guard let one = cli[id] else { return }
        if one.state == "missing" { install(id) } else if one.state != "ready" { signIn(id) }
    }
    public func toolsCancelSignIn(_ id: String) async throws { log("toolsCancelSignIn", id) }
    public func toolsCheck() async throws { log("toolsCheck") }

    // MARK: the browsers

    public static let profiles: [String: [JSONValue]] = ["chrome": [["id": "Default", "name": "Hudson", "email": "hudson@example.com"], ["id": "Profile 1", "name": "Research", "email": "lab@example.edu"]]]
    public func browsersOut() -> JSONValue {
        let ids = browserIds.filter { id in ImportFlow.browsers.contains { $0.id == id } }
        let chosen = browserChosen.flatMap { ids.contains($0) ? $0 : nil } ?? ids.first
        return ["browsers": .array(ids.map { id in
            let b = ImportFlow.browsers.first { $0.id == id }!
            return ["id": .string(id), "name": .string(b.name), "keychain": .bool(b.keychain), "isDefault": .bool(id == ids.first), "profiles": .array(Self.profiles[id] ?? [])]
        }), "defaultId": ids.first.map(JSONValue.string) ?? .null, "chosenId": chosen.map(JSONValue.string) ?? .null,
                "chosenProfile": profileChosen.map(JSONValue.string) ?? .null, "keychain": keychainAnswer.map(JSONValue.string) ?? .null,
                "safari": ["diskAccess": .bool(diskGranted)]]
    }
    public func browsers() async throws -> JSONValue { log("browsers"); try check("browsers"); return browsersOut() }
    public func chooseBrowser(_ id: String) async throws -> JSONValue { log("chooseBrowser", id); browserChosen = id; profileChosen = nil; keychainAnswer = nil; return browsersOut() }
    public func chooseBrowserProfile(_ browserId: String, _ profileId: String) async throws -> JSONValue { log("chooseBrowserProfile", browserId, profileId); profileChosen = profileId; return browsersOut() }
    public func keychain(_ answer: String) async throws -> JSONValue { log("keychain", answer); keychainAnswer = answer; return ["keychain": .string(answer)] }
    public func openDiskAccess() async throws { log("openDiskAccess"); later { self.diskGranted = true } }
    public func diskAccess() async throws -> JSONValue { log("diskAccess"); return ["platform": "darwin", "granted": .bool(diskGranted)] }
    public func browserAgents(provider: String?, browserId: String?) async throws -> JSONValue {
        log("browserAgents", provider ?? "", browserId ?? "")
        let available = agents != "none", byCli = agents == "allowed"
        return ["available": .bool(available), "browser": available ? ["id": "chrome", "name": "Chrome"] : nil, "allowedByCli": .bool(byCli),
                "consent": agentsAnswer.map(JSONValue.string) ?? .null, "ask": .bool(available && !byCli && agentsAnswer == nil)]
    }
    public func browserAgentsAnswer(_ answer: String) async throws { log("browserAgentsAnswer", answer); agentsAnswer = answer }

    // MARK: discovery

    public func discovery() async throws -> JSONValue { log("discovery"); return disc }
    public func discoverProjects(provider: String?, again: Bool) async throws -> JSONValue {
        log("discoverProjects", provider ?? "", again ? "again" : "")
        if !again && ["running", "done"].contains(J.str(disc["projects"]?["status"])) { return disc }
        disc = disc.with("projects", ["status": "running", "provider": provider.map(JSONValue.string) ?? .null, "projects": []])
        later { self.settleProjects() }
        return disc
    }
    /// The project agent answers: the sample projects (or `projects`), or `status` failed/done-empty.
    public func settleProjects(_ projects: [JSONValue]? = nil, status: String = "done", extra: [String: JSONValue] = [:]) {
        var value: [String: JSONValue] = ["status": .string(status), "projects": .array(Array((projects ?? sampleProjects).prefix(5)))]
        for (k, v) in extra { value[k] = v }
        disc = disc.with("projects", .object(value))
        events.post("engelbart:discovery", disc)
    }
    public func discoverTools(provider: String?, browserId: String?, keychain: String?, again: Bool) async throws -> JSONValue {
        log("discoverTools", provider ?? "", browserId ?? "", keychain ?? "", again ? "again" : "")
        if !again && ["checking", "done"].contains(J.str(disc["tools"]?["status"])) { return disc }
        disc = disc.with("tools", ["status": "checking", "provider": provider.map(JSONValue.string) ?? .null, "results": ["tools": [], "additional": []]])
        later { self.settleTools() }
        return disc
    }
    /// The tool agent answers with the sample tools (or `results`).
    public func settleTools(_ results: JSONValue? = nil) {
        disc = disc.with("tools", ["status": "done", "results": results ?? sampleTools])
        events.post("engelbart:discovery", disc)
    }

    // MARK: the flow, folders, the rest of import-api.js

    public func flow() async throws -> JSONValue { log("flow"); return savedFlow }
    public func saveFlow(_ flow: JSONValue?) async throws { savedFlow = flow ?? .null; log("saveFlow", flow == nil || flow == .null ? "null" : J.str(flow?["screen"])) }
    public func foldersAsked() async throws -> [String: String] { log("foldersAsked"); return disk ? ["Desktop": "allowed", "Documents": "allowed", "Downloads": "allowed"] : [:] }
    public func foldersAsk(_ ids: [String]) async throws -> [String: String] {
        log("foldersAsk", ids.joined(separator: ","))
        return Dictionary(uniqueKeysWithValues: ids.map { ($0, $0 == "Downloads" ? "denied" : "allowed") })
    }
    public func foldersNeeded(_ choices: JSONValue) async throws -> [JSONValue] {
        log("foldersNeeded")
        if let a = answer["foldersNeeded"] { return (await a("")).array ?? [] }
        return []
    }
    public func notesPermission() async throws -> JSONValue {
        log("notesPermission")
        if let a = answer["notesPermission"] { return await a("") }
        return ["allowed": true]
    }
    public func detect() async throws -> JSONValue { log("detect"); try check("detect"); return found }
    public func obsidianTree() async throws -> JSONValue {
        log("obsidianTree")
        let v = "/Users/you/Documents/Research vault"
        func note(_ dir: String, _ name: String) -> JSONValue { ["name": .string(name), "path": .string("\(dir)/\(name).md"), "dir": false] }
        return ["truncated": false, "vaults": [["name": "Research vault", "path": .string(v), "tree": [
            ["name": "Memex", "path": .string("\(v)/Memex"), "dir": true, "children": [note("\(v)/Memex", "As We May Think"), note("\(v)/Memex", "Trails and associative indexing")]],
            ["name": "Meetings", "path": .string("\(v)/Meetings"), "dir": true, "children": [note("\(v)/Meetings", "2026-10-02 Advisor")]],
            note(v, "Engelbart Canvas"), note(v, "Reading list"),
        ]]]]
    }
    static let signedOut = ["ChatGPT"]
    /// A run's status as the workspace shows it, from what was chosen (standalone.jsx sampleSession).
    public static func sampleSession(_ choices: JSONValue?, browser: String = "Chrome") -> JSONValue {
        let direct = choices?["direct"]
        var apps = J.strs(direct?["apps"])
        if apps.isEmpty { apps = ["Obsidian", "Google Docs", "Granola", "ChatGPT"] }
        func name(_ app: String) -> String { ImportFlow.catalogTool(app)?.name ?? app }
        let jobs: [JSONValue] = apps.filter { !signedOut.contains($0) }.prefix(8).enumerated().map { index, app in
            ["id": .string("job-\(index)"), "kind": "import", "label": .string(name(app)), "apps": [.string(app)], "status": "running", "notes": 0, "items": 0]
        }
        let needs: [JSONValue] = apps.filter { signedOut.contains($0) }.map { app in
            ["id": .string("need-\(app)"), "app": .string(app), "kind": "signin", "reason": .string("Sign in to \(name(app))"), "browser": .string(browser), "opened": false, "busy": false]
        }
        return ["id": "sample-session", "direct": direct == nil ? nil : ["mode": direct?["mode"] ?? "auto"], "librarian": .bool(J.truthy(choices?["librarian"])),
                "jobs": .array(jobs), "needs": .array(needs), "chat": [], "memory": ["status": "waiting"], "projectId": choices?["projectId"] ?? .null]
    }
    public func connectStart(_ choices: JSONValue) async throws -> JSONValue {
        log("connectStart")
        try check("connectStart")
        lastChoices = choices
        let session = Self.sampleSession(choices)
        sessions[J.str(session["id"])] = session
        return session
    }
    public func startProject(_ input: JSONValue) async throws -> JSONValue {
        log("startProject", J.str(input["name"]), J.str(input["folder"]))
        try check("startProject")
        projectsMade.append(input)
        return ["project": ["id": .string("project-\(J.str(input["name"]))"), "name": input["name"] ?? ""], "workspaceId": "welcome"]
    }
    public func openTrace() async throws { log("openTrace") }
    public func openExternal(_ url: String) async throws { log("openExternal", url) }
    public func reveal(_ path: String) async throws { log("reveal", path) }
    public func pickDirectory() async -> String? { log("pickDirectory"); return pickedDirectory }
    public func pickFiles() async -> [(path: String, name: String)] { log("pickFiles"); return pickedFiles }

    // MARK: Connect your library's session

    /// A session main announces (engelbart:connect) and keeps.
    public func announce(_ session: JSONValue) {
        sessions[J.str(session["id"])] = session
        events.post("engelbart:connect", session)
    }
    func session(_ id: String) throws -> JSONValue {
        guard let s = sessions[id] else { throw ConnectError("failed", "That import is not running.") }
        return s
    }
    func update(_ id: String, _ change: (inout [String: JSONValue]) -> Void) throws -> JSONValue {
        var object = try session(id).object ?? [:]
        change(&object)
        let next = JSONValue.object(object)
        sessions[id] = next
        return next
    }
    public func connectProviders() async throws -> [JSONValue] { log("connectProviders"); return providerList }
    public func connectList() async throws -> [JSONValue] { log("connectList"); return Array(sessions.values) }
    public func connectState(_ id: String) async throws -> JSONValue { log("connectState", id); return try session(id) }
    public func connectAnswer(_ id: String, _ input: JSONValue) async throws -> JSONValue {
        log("connectAnswer", id, input.text())
        return try update(id) { s in
            var chat = J.arr(s["chat"])
            let text = J.truthy(input["skipped"]) ? "Skip" : J.strs(input["picked"]).isEmpty ? J.str(input["text"]) : J.strs(input["picked"]).joined(separator: ", ")
            chat.append(["role": "user", "text": .string(text)])
            s["chat"] = .array(chat)
            s["thinking"] = true
        }
    }
    public func connectGrant(_ id: String, apps: [String]) async throws -> JSONValue {
        log("connectGrant", id, apps.joined(separator: ","))
        return try update(id) { s in
            s["chat"] = .array(J.arr(s["chat"]).map { entry in
                guard let grant = entry["grant"] else { return entry }
                let ids = J.arr(grant["rows"]).map { J.str($0["id"]) }
                return entry.with("grant", grant.with("answered", ["allowed": .array(apps.map(JSONValue.string)), "skipped": .array(ids.filter { !apps.contains($0) }.map(JSONValue.string))]))
            })
        }
    }
    public func connectAuthorize(_ id: String, app: String, kind: String, path: String?) async throws -> JSONValue { log("connectAuthorize", id, app, kind, path ?? ""); return try session(id) }
    public func connectCancelSignIn(_ id: String, _ app: String) async throws { log("connectCancelSignIn", id, app) }
    public func connectNeed(_ id: String, _ needId: String, _ action: String) async throws -> JSONValue {
        log("connectNeed", id, needId, action)
        return try update(id) { s in
            if action == "skip" || action == "done" { s["needs"] = .array(J.arr(s["needs"]).filter { J.str($0["id"]) != needId }) }
            else { s["needs"] = .array(J.arr(s["needs"]).map { J.str($0["id"]) == needId ? $0.with("opened", true) : $0 }) }
        }
    }
    public func connectImport(_ id: String) async throws -> JSONValue { log("connectImport", id); return try update(id) { $0["finished"] = true } }
    public func connectStop(_ id: String) async throws -> JSONValue { log("connectStop", id); return try update(id) { $0["stopped"] = true } }
    public func connectUnblock(_ id: String, provider: String?) async throws -> JSONValue { log("connectUnblock", id, provider ?? ""); return try update(id) { $0["blocked"] = nil } }
    public func connectStopJob(_ id: String, _ jobId: String) async throws -> JSONValue {
        log("connectStopJob", id, jobId)
        return try update(id) { s in s["jobs"] = .array(J.arr(s["jobs"]).map { J.str($0["id"]) == jobId ? $0.with("status", "stopped") : $0 }) }
    }
    public func connectProvider(_ id: String, _ provider: String) async throws -> JSONValue { log("connectProvider", id, provider); return try update(id) { $0["provider"] = .string(provider) } }
    public func connectRetryMemory(_ id: String) async throws -> JSONValue { log("connectRetryMemory", id); return try update(id) { $0["memory"] = ["status": "writing"] } }
    public func connectMinimize(_ id: String, _ value: Bool) async throws { log("connectMinimize", id, value ? "true" : "false") }
    public func connectDismiss(_ id: String) async throws { log("connectDismiss", id); _ = try? update(id) { $0["dismissed"] = true } }
    public func connectOfferSeen(_ how: String) async throws { log("connectOfferSeen", how) }
    public func connectConnectors() async throws -> [JSONValue] { log("connectConnectors"); return connectorsAnswer }
    public func connectConnectorSignIn(_ app: String) async throws -> JSONValue {
        log("connectConnectorSignIn", app)
        if let a = answer["connectorSignIn"] { return await a(app) }
        return ["app": .string(app), "connected": true]
    }
    public func connectConnectorCancel(_ app: String) async throws { log("connectConnectorCancel", app) }
    public func connectSignInCheck(_ app: String, retry: Bool) async throws -> JSONValue {
        log("connectSignInCheck", app, retry ? "retry" : "")
        if let a = answer["signInCheck"] { return await a(app) }
        return ["status": "signed-in", "browser": "Chrome"]
    }
    public func connectSignInNote(_ app: String, route: String?) async throws -> JSONValue {
        log("connectSignInNote", app, route ?? "")
        if let a = answer["signInNote"] { return await a(app) }
        return ["note": "", "browser": "Chrome"]
    }
    public func connectSignInPick(_ app: String, browser: String, profile: String) async throws { log("connectSignInPick", app, browser, profile) }
    public func connectSignInUnlock(_ app: String) async throws -> JSONValue {
        log("connectSignInUnlock", app)
        if let a = answer["signInUnlock"] { return await a(app) }
        return ["status": "allowed", "browser": "Chrome"]
    }
    public func connectSignInAnotherAccount(_ app: String) async throws { log("connectSignInAnotherAccount", app) }
    public func connectSignInBrowser(_ app: String) async throws -> JSONValue {
        log("connectSignInBrowser", app)
        if let a = answer["signInBrowser"] { return await a(app) }
        return ["status": "signed-in", "browser": "Chrome"]
    }
    public func connectSignInBrowserCancel(_ app: String?) async throws { log("connectSignInBrowserCancel", app ?? "") }
    public func connectSignInWindow(_ app: String) async throws -> JSONValue {
        log("connectSignInWindow", app)
        if let a = answer["signInWindow"] { return await a(app) }
        return ["status": "signed-in"]
    }
    public func connectSignInWindowClose() async throws { log("connectSignInWindowClose") }

    public func library() async throws -> [JSONValue] { log("library"); return libraryRows }
    public func addLibraryItem(_ input: String) async throws -> JSONValue {
        log("addLibraryItem", input)
        let row: JSONValue = ["id": .string("row-\(libraryRows.count + 1)"), "name": .string((input as NSString).lastPathComponent), "url": .string(input)]
        libraryRows.append(row)
        return row
    }
    public func discardLibraryItem(_ id: String) async throws -> Bool { log("discardLibraryItem", id); libraryRows.removeAll { J.str($0["id"]) == id }; return true }
    public func githubRepos() async throws -> JSONValue { log("githubRepos"); return ["repos": [["id": "1", "fullName": "me/site", "url": "https://github.com/me/site"]]] }
    public func engelbartSignIn(_ app: String) async throws -> Bool {
        log("engelbartSignIn", app)
        if let a = answer["engelbartSignIn"] { return J.truthy(await a(app)) }
        return true
    }
}
