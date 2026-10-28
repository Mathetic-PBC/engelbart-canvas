import Foundation
import EngelbartCore

// Port of src/main/connect/session.cjs (Connect your library, 2026-10-07; in every library since 2026-10-08; Import your
// context's direct runs 2026-10-13; the beta's grant, recovery and connector steps 2026-10-16). The person picks what
// should come into their library; a librarian agent talks with them in one chat and hands each source to an import agent
// as soon as it is settled (or, for Import your context, one import a tool, no librarian). Surveys, recalls, imports and
// MEMORY.md run in a priority queue, six at a time; an agent that meets a sign-in, a code or a permission hands it to the
// person ("Needs you") and waits; a sign-in lost on the way is brought back quietly, then with one card. A session still
// going when Engelbart quits is saved and picked up again. What it writes is only in the data root it started in:
// <dataRoot>/.connect/<id>/ (session.json, memories/, steps/, notes/), <dataRoot>/imports/<id>/, assets/md/, MEMORY.md.
//
// Main-actor isolated, as the Electron code ran on one event loop: every state change happens on the main actor, an
// agent's turn and its tool calls hop to it.

/// The agents' browser windows as the session uses them (AgentBrowserWindows).
@MainActor public protocol AgentBrowsing: AnyObject {
    nonisolated func tools(_ job: AgentJob) -> AgentPage
    func show(_ jobId: String, title: String) -> Bool
    func hide(_ jobId: String)
    func close(_ jobId: String)
    func closeAll()
    func has(_ jobId: String) -> Bool
}
extension AgentBrowserWindows: AgentBrowsing {}

/// Engelbart's own sign-in window (SignInWindow).
@MainActor public protocol SignInWindowing: AnyObject {
    func open(_ app: String) async -> String
    func openSite(name: String, url: String, domains: [String]) async -> String
    func close()
}
extension SignInWindow: SignInWindowing {}

/// The tool bridge as the session opens it (ToolBridge.open; tests pass their own).
public protocol BridgeHandle: AnyObject, Sendable { var connection: ToolBridge.Connection { get }; func close() }
extension ToolBridge: BridgeHandle {}

public struct ConnectDeps {
    public var agents: ConnectAgents
    public var models: () -> JSONValue? = { nil }
    public var ready: () -> [String] = { ConnectModels.providers }
    public var store: ConnectStore
    public var homeDir: String
    public var env: [String: String] = ProcessInfo.processInfo.environment
    public var zotero: ConnectZotero = .none
    public var github: ConnectGitHub = .none
    public var notify: (JSONValue) -> Void = { _ in }
    public var placed: (String) -> Void = { _ in }
    public var openBridge: (@escaping ToolBridge.Call, AbortSignal?) async throws -> BridgeHandle = { call, signal in try await ToolBridge.open(call, signal: signal, maxBody: 1_000_000) }
    public var browser: AgentBrowsing?
    public var connectors: Connectors?
    public var appleNotes: AppleNotes?
    public var webSignIn: WebSignIn?
    public var signInWindow: SignInWindowing?
    public var trace: Trace?
    public var browserAgents: BrowserAgents?
    public var openBrowserApp: ((String) async throws -> Void)?
    public var providerCheck: ((String) -> Void)?
    public var now: () -> String = { Time.iso() }
    // test hooks (session.cjs deps.*)
    public var maxRunning: Int?
    public var signInCheckMs: Double?
    public var stepPollMs: Double?
    public var recoverWaitsMs: [Double]?
    public var allowedAll = false
    public init(agents: ConnectAgents, store: ConnectStore, homeDir: String) { self.agents = agents; self.store = store; self.homeDir = homeDir }
}

/// One job of a session (survey, recall, import, memory, redact).
public final class ConnectJob {
    public let id: String
    public var key: String
    public var kind: String
    public var priority: Int
    public var seq: Int
    public var source: String
    public var apps: [String]
    public var label: String
    public var plan: String
    public var extra: (sites: [String], tool: ExtraTool?)?
    public var status = "queued"
    public var skipped = false
    public var notes = 0
    public var items = 0
    public var titles: [String] = []
    public var activity = ""
    public var summary = ""
    public var error = ""
    public var started: String?
    public var ended: String?
    public var find = false
    public var route: String?
    var controller: AbortSignal?
    var connectors: [String] = []
    var rerun = false
    var asked: (app: String, id: String)?
    init(id: String = IDs.new(), key: String, kind: String, seq: Int, source: String, apps: [String], label: String, plan: String) {
        self.id = id; self.key = key; self.kind = kind; self.priority = ConnectSession.priority[kind] ?? 2; self.seq = seq; self.source = source; self.apps = apps; self.label = label; self.plan = plan
    }
    var publicJSON: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "kind": .string(kind), "source": .string(source), "label": .string(label), "apps": .array(apps.map { .string($0) }),
                                      "status": .string(status), "skipped": .bool(skipped), "notes": .number(Double(notes)), "items": .number(Double(items)), "activity": .string(activity),
                                      "summary": .string(summary), "error": .string(error), "started": started.map { .string($0) } ?? .null, "ended": ended.map { .string($0) } ?? .null]
        if let route { o["route"] = .string(route) }
        return .object(o)
    }
}

/// A step an agent handed the person ("Needs you").
public final class ConnectNeed {
    public let id = IDs.new()
    public var app: String
    public var kind: String
    public var reason: String
    public var jobs: [String] = []
    var waiters: [String: (JSONValue) -> Void] = [:]
    public var opened = false
    public var busy = false
    public var error = ""
    public var note = ""
    public var closed = false
    public var at: String
    public var browser: String?
    public var own: String?
    public var ownId: String?
    public var code = ""
    public var held = false
    public var keep = false
    public var `where`: String?
    var recovery: String?
    var tries = 0
    var doneNote: String?
    var outcome: String?
    var watch: Task<Void, Never>?
    var cancel: (() -> Void)?
    var settled: [(String) -> Void] = []
    var settledWith: String?
    init(app: String, kind: String, reason: String, at: String) { self.app = app; self.kind = kind; self.reason = reason; self.at = at }
    func settle(_ how: String) { guard settledWith == nil else { return }; settledWith = how; let s = settled; settled = []; s.forEach { $0(how) } }
    func onSettled(_ f: @escaping (String) -> Void) { if let s = settledWith { f(s) } else { settled.append(f) } }
}

/// A chat entry (role, text, ask, authorize, notice, grant, opener, at).
public final class ChatEntry { public var value: [String: JSONValue]; init(_ v: [String: JSONValue]) { value = v } }

public final class ConnectSession {
    static let priority = ["survey": 0, "recall": 1, "import": 2, "memory": 3, "redact": 4]
    public let id: String
    public var mode: String
    let dataRoot: String
    let dir: String
    let downloads: String
    let created: String
    public var choices: Choices
    var choice: AgentChoice
    var redactChoice: AgentChoice?
    var picked: (folders: [String: String], exports: [String: String]) = ([:], [:])
    var chat: [ChatEntry] = []
    var thinking = true
    var activity = "Looking at what you picked…"
    var done = false, finished = false, minimized = false, dismissed = false, stopped = false, suspended = false
    var error = ""
    var jobs: [ConnectJob] = []
    var seq = 0
    var needs: [ConnectNeed] = []
    var log: [JSONValue] = []
    var controllers: [AbortSignal] = []
    var interviewSession: String?
    var interviewController: AbortSignal?
    var found: [String: [String: JSONValue]] = [:]
    var foundError: String?
    var newFound: [String: [String: JSONValue]]?
    var toldImports = ""
    var projectId: String?
    var projectDir: String?
    var workspaceId: String?
    var waitingForSurvey = false
    var surveyNews: [String] = []
    var recalls: [String: String] = [:]
    var memory: [String: JSONValue]
    var memoryQueued = false
    var memoryDraft: String?
    var skipped = Set<String>()
    var skippedSources = Set<String>()
    var held: [String: (source: String, recall: Bool, consent: Bool)] = [:]
    var heldOrder: [String] = []
    var fallback = Set<String>()
    var connected = Set<String>()
    var rows: [String] = []
    var inProject = Set<String>()
    var inWorkspace = Set<String>()
    var allowed = Set<String>()
    var approved: [String: Set<String>] = [:]
    var gmailThreads = 0
    var manual = false
    var blocked: (provider: String, error: String, at: String?)?
    var leftOut: [(app: String, why: String)] = []
    var dirs: [String] = []
    var nudges = 0
    var grantWaiters: [CheckedContinuation<Void, Never>] = []
    var signInsAgain: [String: (checking: Task<Bool, Never>?, checkedAt: Double, stood: Set<String>)] = [:]
    var recoveries: [String: Recovery] = [:]
    var placing: Task<Void, Never>?
    let fakeState = FakeInterviewState()

    final class Recovery {
        let key: String, name: String, app: String?, tool: ExtraTool?
        var phase = "quiet"
        var told = Set<String>()
        var carded = false
        var need: ConnectNeed?
        var quiet: Task<Void, Never>?
        init(key: String, name: String, app: String?, tool: ExtraTool?) { self.key = key; self.name = name; self.app = app; self.tool = tool }
    }

    init(id: String, mode: String, dataRoot: String, created: String, choices: Choices, choice: AgentChoice) {
        self.id = id; self.mode = mode; self.dataRoot = dataRoot; self.created = created; self.choices = choices; self.choice = choice
        dir = (dataRoot as NSString).appendingPathComponent(".connect/\(id)")
        downloads = (dataRoot as NSString).appendingPathComponent("imports/\(id)")
        memory = ["status": "waiting", "path": .string(Memory.path(URL(fileURLWithPath: dataRoot)).path), "error": ""]
    }

    func holdSet(_ app: String, source: String, recall: Bool = false, consent: Bool = false) {
        if held[app] == nil { heldOrder.append(app) }
        held[app] = (source, recall, consent)
    }
    func unhold(_ app: String) { held[app] = nil; heldOrder.removeAll { $0 == app } }
    func leave(_ app: String, _ why: String) { if !leftOut.contains(where: { $0.app == app }) { leftOut.append((app, why)) } }
    func put(_ source: String, _ app: String, _ entry: JSONValue, news: Bool = false) {
        found[source, default: [:]][app] = entry
        if news { newFound = newFound ?? [:]; newFound![source, default: [:]][app] = entry }
    }
    var foundJSON: JSONValue {
        if let foundError { return ["error": .string(foundError)] }
        return .object(found.mapValues { .object($0) })
    }
}

@MainActor
public final class Connect {
    static let maxRunning = 6, maxJobs = 40, maxLog = 400, shownLog = 150
    static let needWaitMs = 170_000.0
    static let signInAgainSharedMs = 30_000.0
    static let signInCheckMs = 10_000.0
    static let recoverWaitsMs: [Double] = [0, 8000, 20000]
    static let signinHere = "signin-here"
    static let idRE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    static let signinKinds: Set<String> = ["signin", "password", "code", "2fa", "captcha"]
    static let signinApps: Set<String> = ["Zotero", "GitHub"]
    static let stepPollMs = 1000.0
    static let work: Set<String> = ["survey", "recall", "import"]
    static let ended: Set<String> = ["done", "failed", "stopped"]
    static let findApps: Set<String> = ["Obsidian", "Zoom", ConnectSources.localPDFs]
    static let resumeDays = 7.0

    public var deps: ConnectDeps
    var sessions: [String: ConnectSession] = [:]
    var signInDenied = SetBox()
    var signInChecked: [String: JSONValue] = [:]
    var signInChecking: [String: Task<JSONValue, Never>] = [:]
    var browserWaits: [String: (signal: AbortSignal, task: Task<JSONValue, Never>)] = [:]
    var resumed = Set<String>()
    var pendingEmit: [String: ConnectSession] = [:]
    var emitScheduled = false

    public init(_ deps: ConnectDeps) { self.deps = deps }

    var homeDir: String { deps.homeDir }
    var env: [String: String] { deps.env }
    func now() -> String { deps.now() }
    static func asksFirst(_ app: String) -> Bool { [.web, .connector].contains(ConnectSources.apps[app]?.reach) }
    static func folderName(_ app: String) -> String { app == ConnectSources.localPDFs ? "folders of PDFs" : "\(ConnectSources.shownName(app)) folder" }
    func traced(kind: String, sessionId: String? = nil, jobId: String? = nil, text: String, detail: JSONValue? = nil) { deps.trace?.event(kind: kind, sessionId: sessionId, jobId: jobId, text: text, detail: detail) }
    func readyNow() -> [String] { deps.ready().filter { ConnectModels.providers.contains($0) } }
    func choiceFor(_ provider: String) -> AgentChoice { ConnectModels.choice(provider, models: deps.models()) }

    // MARK: snapshot, persistence, events

    func chosenBrowser() -> String { deps.webSignIn?.browserName() ?? "" }
    func opensIn(_ app: String) -> String { deps.webSignIn?.opensIn(app) ?? "" }

    func publicNeed(_ need: ConnectNeed) -> JSONValue {
        let browser = need.browser ?? need.own ?? (Self.signinKinds.contains(need.kind) ? opensIn(need.app).nilIfEmpty : nil) ?? chosenBrowser()
        var o: [String: JSONValue] = ["id": .string(need.id), "app": .string(need.app), "kind": .string(need.kind), "reason": .string(need.reason), "jobs": .number(Double(need.jobs.count)),
                                      "jobIds": .array(need.jobs.map { .string($0) }), "opened": .bool(need.opened), "busy": .bool(need.busy), "browser": .string(browser),
                                      "error": .string(need.error), "note": .string(need.note), "at": .string(need.at)]
        if need.own != nil { o["own"] = true }
        if !need.code.isEmpty { o["code"] = .string(need.code) }
        if need.kind == Self.signinHere { o["where"] = .string(need.where ?? "here") }
        return .object(o)
    }

    public func snapshot(_ s: ConnectSession) -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(s.id), "mode": .string(s.mode), "chat": .array(s.chat.map { .object($0.value) }), "thinking": .bool(s.thinking), "activity": .string(s.activity),
            "waiting": .bool(s.waitingForSurvey), "done": .bool(s.done), "error": .string(s.error), "finished": .bool(s.finished), "stopped": .bool(s.stopped),
            "minimized": .bool(s.minimized), "dismissed": .bool(s.dismissed),
            "jobs": .array(s.jobs.filter { $0.kind != "redact" }.map(\.publicJSON)), "needs": .array(s.needs.filter { !$0.closed }.map(publicNeed)),
            "log": .array(Array(s.log.suffix(Self.shownLog))), "provider": .string(s.choice.provider),
            "choice": ["provider": .string(s.choice.provider), "name": .string(ConnectModels.providerNames[s.choice.provider] ?? ""), "modelName": .string(s.choice.modelName), "effort": .string(s.choice.effort)],
            "permissions": s.choices.permissions.json, "projectId": s.projectId.map { .string($0) } ?? .null, "workspaceId": s.workspaceId.map { .string($0) } ?? .null,
            "staged": .number(Double(s.projectId != nil ? 0 : Notes.stagedCount(URL(fileURLWithPath: s.dir)))), "memory": .object(s.memory), "created": .string(s.created),
            "counts": ["notes": .number(Double(s.jobs.reduce(0) { $0 + $1.notes })), "items": .number(Double(s.jobs.reduce(0) { $0 + $1.items }))],
            "placed": ["project": .number(Double(s.inProject.count)), "workspace": .number(Double(s.inWorkspace.count))],
            "leftOut": .array(s.leftOut.map { ["app": .string($0.app), "why": .string($0.why)] }),
            "blocked": s.blocked.map { ["provider": .string($0.provider), "name": .string(ConnectModels.providerNames[$0.provider] ?? ""), "error": .string($0.error), "at": $0.at.map { .string($0) } ?? .null] } ?? .null,
            "direct": s.choices.direct.map { ["mode": .string($0.mode), "projects": .array($0.projects.map { .string($0.title) })] } ?? .null,
            "manual": .bool(s.manual), "holding": .number(Double(s.held.count)),
        ]
        o["leftOut"] = o["leftOut"]
        return .object(o)
    }

    func save(_ s: ConnectSession, force: Bool = false) {
        if s.suspended && !force { return }
        var o = snapshot(s).object ?? [:]
        o["log"] = .array(s.log)
        o["choices"] = s.choices.json
        o["picked"] = ["folders": .object(s.picked.folders.mapValues { .string($0) }), "exports": .object(s.picked.exports.mapValues { .string($0) })]
        o["found"] = s.foundJSON
        o["interviewSession"] = s.interviewSession.map { .string($0) } ?? .null
        o["skipped"] = .array(s.skipped.sorted().map { .string($0) })
        o["skippedSources"] = .array(s.skippedSources.sorted().map { .string($0) })
        o["suspended"] = .bool(s.suspended)
        o["allowed"] = .array(s.allowed.sorted().map { .string($0) })
        o["approved"] = .object(s.approved.mapValues { .array($0.sorted().map { .string($0) }) })
        o["gmailThreads"] = .number(Double(s.gmailThreads))
        o["fallback"] = .array(s.fallback.sorted().map { .string($0) })
        o["connected"] = .array(s.connected.sorted().map { .string($0) })
        o["rows"] = .array(s.rows.map { .string($0) })
        o["inProject"] = .array(s.inProject.sorted().map { .string($0) })
        o["inWorkspace"] = .array(s.inWorkspace.sorted().map { .string($0) })
        o["workspaceId"] = s.workspaceId.map { .string($0) } ?? .null
        o["jobs"] = .array(s.jobs.map { job in
            var j = job.publicJSON.object ?? [:]
            j["key"] = .string(job.key); j["plan"] = .string(job.plan); j["titles"] = .array(job.titles.map { .string($0) })
            if job.find { j["find"] = true }
            if let extra = job.extra, !extra.sites.isEmpty {
                var e: [String: JSONValue] = ["sites": .array(extra.sites.map { .string($0) })]
                if let tool = extra.tool { e["tool"] = ["name": .string(tool.name), "website": .string(tool.website), "sites": .array(tool.sites.map { .string($0) })] }
                j["extra"] = .object(e)
            }
            return .object(j)
        })
        try? FileManager.default.createDirectory(atPath: s.dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? Files.writeAtomically(JSONValue.object(o).text(pretty: true), to: URL(fileURLWithPath: s.dir).appendingPathComponent("session.json"), mode: 0o600)
    }

    func emit(_ s: ConnectSession, soon: Bool = false) {
        if s.suspended { return }
        if !soon { pendingEmit[s.id] = nil; save(s); deps.notify(snapshot(s)); return }
        pendingEmit[s.id] = s
        if emitScheduled { return }
        emitScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            emitScheduled = false
            let held = pendingEmit
            pendingEmit = [:]
            for (_, s) in held { deps.notify(snapshot(s)) }
        }
    }

    func logAction(_ s: ConnectSession, _ job: ConnectJob?, _ text: String, who: String? = nil) {
        s.log.append(["at": .string(now()), "job": job.map { .string($0.id) } ?? .null, "who": .string(who ?? job?.label ?? "Engelbart"), "text": .string(SessionText.line(text, 200))])
        if s.log.count > Self.maxLog { s.log.removeFirst(s.log.count - Self.maxLog) }
        emit(s, soon: true)
    }

    func get(_ id: String) throws -> ConnectSession {
        guard JS.test(id, Self.idRE, options: .caseInsensitive), let s = sessions[id] else { throw ConnectError("failed", "That import is no longer open") }
        return s
    }

    // MARK: what may be read

    func accessOf(_ s: ConnectSession) -> FolderAccess.Guard {
        let on = { (app: String) in s.choices.sources.values.contains { $0.on && $0.apps.contains(app) } }
        var places: [String] = []
        if on("Obsidian") || s.choices.sources["sites"]?.on == true { places += Readers.obsidianVaults(homeDir).map(\.path) }
        if on("Zoom") { places.append((homeDir as NSString).appendingPathComponent("Documents/Zoom")) }
        return FolderAccess.guardFor(homeDir: homeDir, dataRoot: URL(fileURLWithPath: s.dataRoot), picked: s.choices.picked + places)
    }

    func dirsOf(_ s: ConnectSession) -> [String] {
        var dirs: [String] = []
        let access = accessOf(s)
        let grant = { (dir: String?) in if let dir, Readers.exists(dir) { let r = FolderAccess.resolve(dir); if !dirs.contains(r) { dirs.append(r) } } }
        let add = { (dir: String?) in if let dir, access.readable(dir) { grant(dir) } }
        if s.choices.computer { grant(homeDir) }
        for id in ConnectSources.sourceIds {
            guard let choice = s.choices.sources[id], choice.on else { continue }
            choice.folders.forEach { add($0) }
            for app in choice.apps {
                if app == "Obsidian" { Readers.obsidianVaults(homeDir).forEach { add($0.path) } }
                if app == "Claude Code" { add((homeDir as NSString).appendingPathComponent(".claude/projects")) }
                if app == "Codex" { add(Readers.codexRoot(homeDir, env)) }
                if app == "Zoom" { add((homeDir as NSString).appendingPathComponent("Documents/Zoom")) }
                if app == "Zotero" { add((homeDir as NSString).appendingPathComponent("Zotero/storage")); add(deps.zotero.root()) }
            }
            if id == "sites" { Readers.obsidianVaults(homeDir).prefix(2).forEach { add($0.path) } }
        }
        for file in Array(s.picked.folders.values) + Array(s.picked.exports.values) { add(Readers.isDir(file) ? file : (file as NSString).deletingLastPathComponent) }
        grant(s.downloads)
        let list = dirs.sorted { $0.count < $1.count }
        return list.enumerated().filter { i, d in !list.prefix(i).contains { d.hasPrefix($0 + "/") } }.map(\.element)
    }

    func libraryCounts() async -> JSONValue {
        let rows = await deps.store.rows()
        let has = { (tag: String) in rows.filter { $0.tags.contains(tag) }.count }
        return ["items": .number(Double(rows.count)), "notes": .number(Double(has("note"))), "papers": .number(Double(has("paper"))), "repositories": .number(Double(has("git"))),
                "websites": .number(Double(rows.filter { $0.type == "website" && $0.tags.isEmpty }.count))]
    }

    func instructionsText(_ dataRoot: String) -> String { ((try? String(contentsOfFile: (dataRoot as NSString).appendingPathComponent("instructions.md"), encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    /// A line Engelbart says in the chat about the run, never the chat's last word for an open question (2026-10-16).
    func notice(_ s: ConnectSession, _ text: String) { s.chat.append(ChatEntry(["role": "agent", "notice": true, "text": .string(text), "ask": .null, "authorize": .null, "at": .string(now())])) }

    func lastSaid(_ s: ConnectSession) -> ChatEntry? {
        s.chat.reversed().first { $0.value["role"]?.string == "agent" && !JS.truthy($0.value["notice"]) && !JS.truthy($0.value["grant"]) && !JS.truthy($0.value["opener"]) }
    }

    func conversationText(_ s: ConnectSession) -> String {
        s.chat.filter { !JS.truthy($0.value["opener"]) }.map { e -> String in
            let v = e.value
            if let g = v["grant"], JS.truthy(g) {
                let names = (g["rows"]?.array ?? []).map { JS.string($0["name"]) }
                var line = "engelbart: asked the person to allow \(SessionText.listed(names))"
                if let a = g["answered"], JS.truthy(a) {
                    let allowed = (a["allowed"]?.array ?? []).map { JS.string($0) }, skipped = (a["skipped"]?.array ?? []).map { JS.string($0) }
                    line += "; they allowed \(allowed.isEmpty ? "none" : SessionText.listed(allowed))\(skipped.isEmpty ? "" : " and left out \(SessionText.listed(skipped))")"
                } else { line += "; not answered yet" }
                return line
            }
            if JS.truthy(v["notice"]) { return "engelbart: \(JS.string(v["text"]))" }
            var line = "\(v["role"]?.string == "agent" ? "librarian" : "person"): \(JS.string(v["text"]))"
            if let ask = v["ask"], JS.truthy(ask) {
                let opts = (ask["options"]?.array ?? []).map { JS.string($0["label"]) }
                line += "\n  (asked, \(JS.string(ask["kind"])): \(JS.string(ask["title"]))\(opts.isEmpty ? "" : " — \(opts.joined(separator: " | "))"))"
            }
            if let au = v["authorize"], JS.truthy(au) { line += "\n  (offered the button: \(JS.string(au["label"])))" }
            return line
        }.joined(separator: "\n")
    }

    func importsText(_ s: ConnectSession) -> String {
        let work = s.jobs.filter { $0.kind == "import" || $0.kind == "survey" }
        if work.isEmpty { return "" }
        return JSONValue.array(work.map { j in
            var o: [String: JSONValue] = ["kind": .string(j.kind), "label": .string(j.label), "source": .string(j.source), "apps": .array(j.apps.map { .string($0) }), "status": .string(j.status),
                                          "notesAdded": .number(Double(j.notes)), "itemsAdded": .number(Double(j.items))]
            if !j.summary.isEmpty && j.kind == "import" { o["said"] = .string(j.summary) }
            if !j.error.isEmpty { o["error"] = .string(j.error) }
            return .object(o)
        }).text()
    }

    func engelbartBlock(_ s: ConnectSession) -> String {
        let p = s.choices.permissions
        return "<engelbart>\nA person is connecting their library to Engelbart. Their library is at \(s.dataRoot). What comes in is saved in their library: notes, chats and documents as Markdown files in \((s.dataRoot as NSString).appendingPathComponent("assets/md")), papers, files and links as library items.\nPermissions they gave: read files anywhere in their home folder: \(p.files ? "yes" : "no, only the folders of the sources they picked"); use their accounts in Engelbart's background browser: \(p.browser ? "yes" : "no (web apps are left out)"); ask their AI assistants what they remember: \(p.recall ? "yes" : "no").\n</engelbart>"
    }

    static func sitesOf(_ apps: [String]) -> [String] { var out: [String] = []; for s in apps.flatMap({ ConnectSources.apps[$0]?.sites ?? [] }) where !out.contains(s) { out.append(s) }; return out }

    func browserBlock(_ s: ConnectSession, _ job: ConnectJob, _ apps: [String]) -> String {
        let agentsOf = s.choice.provider == "openai" ? "Codex's Chrome plugin" : "Claude in Chrome"
        var sites = Self.sitesOf(apps)
        for site in job.extra?.sites ?? [] where !sites.contains(site) { sites.append(site) }
        return "<browser note=\"The person's own browser, where they are signed in. You work in it through \(agentsOf).\">\n\(JSONValue.object(["browser": .string(s.choices.browserAgents?.browserName ?? ""), "sites": .array(sites.map { .string($0) })]).text())\n</browser>"
    }

    func surveying(_ s: ConnectSession) -> Bool { s.jobs.contains { $0.kind == "survey" && !Self.ended.contains($0.status) } || !s.held.isEmpty }

    // MARK: the librarian

    func firstMessage(_ s: ConnectSession, _ message: String, again: Bool = false) async -> String {
        let custom = instructionsText(s.dataRoot)
        var choicesJSON = (s.choices.json["sources"]?.object ?? [:])
        choicesJSON["customInstructionsForThisImport"] = s.choices.custom.isEmpty ? .null : .string(s.choices.custom)
        choicesJSON["permissions"] = s.choices.permissions.json
        choicesJSON["period"] = .string(ConnectSources.periodName(s.choices.days))
        choicesJSON["days"] = s.choices.days.map { .number(Double($0)) } ?? .null
        let parts = [engelbartBlock(s), SessionText.projectBlock(s.choices),
                     "<choices>\n\(JSONValue.object(choicesJSON).text(pretty: true))\n</choices>",
                     "<found>\n\(s.foundJSON.text(pretty: true))\n</found>",
                     "<library>\(await libraryCounts().text())</library>",
                     custom.isEmpty ? "" : "<custom_instructions>\n\(custom)\n</custom_instructions>",
                     again && !s.chat.isEmpty ? "<conversation note=\"What was said so far; your earlier replies are summarised as what you asked.\">\n\(conversationText(s))\n</conversation>" : "",
                     again && !s.jobs.isEmpty ? "<imports>\(importsText(s))</imports>" : "",
                     "<message>\(message)</message>"]
        s.newFound = nil
        return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    func laterMessage(_ s: ConnectSession, _ message: String) -> String {
        var parts: [String] = []
        let imports = importsText(s)
        if !imports.isEmpty && imports != s.toldImports { parts.append("<imports>\(imports)</imports>"); s.toldImports = imports }
        if let news = s.newFound { parts.append("<found note=\"What changed since your last turn.\">\n\(JSONValue.object(news.mapValues { .object($0) }).text(pretty: true))\n</found>"); s.newFound = nil }
        parts.append("<message>\(message)</message>")
        return parts.joined(separator: "\n\n")
    }

    func meta(_ s: ConnectSession, kind: String, job: ConnectJob? = nil, message: String? = nil, callTool: ((String, JSONValue) async throws -> JSONValue)? = nil) -> AgentMeta {
        var info: [String: JSONValue] = ["choices": s.choices.json, "found": s.foundJSON, "homeDir": .string(homeDir), "picked": .object(s.picked.folders.mapValues { .string($0) })]
        if let message { info["message"] = .string(message) }
        if let job { info["job"] = ["source": .string(job.source), "apps": .array(job.apps.map { .string($0) }), "label": .string(job.label), "find": .bool(job.find)] }
        if let b = s.choices.browserAgents { info["browserName"] = .string(b.browserName) }
        return AgentMeta(kind: kind, label: job?.label, sessionId: s.id, jobId: job?.id, jobLabel: job?.label, callTool: callTool, info: info, fakeState: s.fakeState)
    }

    /// A librarian turn started without waiting for it (Electron's un-awaited `interviewTurn(s, …)`): `thinking` is set
    /// at once, as the JS function did before its first await, so an answer sent meanwhile is told to wait.
    func turnSoon(_ s: ConnectSession, _ message: String) {
        guard beginTurn(s) else { return }
        Task { await interviewTurn(s, message, begun: true) }
    }

    func beginTurn(_ s: ConnectSession) -> Bool {
        if s.stopped || s.suspended { return false }
        s.thinking = true; s.activity = ""; s.error = ""; s.waitingForSurvey = false; s.surveyNews = []
        emit(s)
        return true
    }

    /// One librarian turn: what the person did → its reply applied.
    func interviewTurn(_ s: ConnectSession, _ message: String, begun: Bool = false) async {
        if !begun && !beginTurn(s) { return }
        if begun && (s.stopped || s.suspended) { s.thinking = false; emit(s); return }
        let controller = AbortSignal()
        s.interviewController = controller
        let onUpdate: (AgentUpdate) -> Void = { [weak self] u in
            guard let a = u.activity else { return }
            Task { @MainActor in guard let self, a != s.activity else { return }; s.activity = a; self.emit(s, soon: true) }
        }
        let system = SessionText.promptOf(s.dataRoot, "connect-system-prompt.md", Texts.interviewSystemPrompt)
        let base = { (msg: String, session: String?) in
            AgentTurnInput(choice: s.choice, kind: "interview", system: system, message: msg, session: session, dirs: s.dirs, signal: controller, onUpdate: onUpdate, meta: self.meta(s, kind: "interview", message: message))
        }
        do {
            var out: AgentTurnOutput
            if let session = s.interviewSession {
                do { out = try await deps.agents.turn(base(laterMessage(s, message), session)) }
                catch let e as ConnectError where e.kind == "stopped" { throw e }
                catch { out = try await deps.agents.turn(base(await firstMessage(s, message, again: true), nil)) }
            } else {
                out = try await deps.agents.turn(base(await firstMessage(s, message, again: s.chat.count > 1), nil))
            }
            s.interviewSession = out.session
            s.toldImports = importsText(s)
            apply(s, SessionText.readReply(out.text, choices: s.choices))
        } catch {
            if (error as? ConnectError)?.kind != "stopped" { s.error = (error as? ConnectError)?.message ?? (error.localizedDescription.isEmpty ? "The librarian did not answer." : error.localizedDescription) }
        }
        if s.interviewController === controller { s.interviewController = nil }
        s.thinking = false
        s.activity = ""
        emit(s)
        if !s.stopped && !s.suspended && !s.finished && s.waitingForSurvey {
            if !s.surveyNews.isEmpty { wake(s) }
            else if !surveying(s) { s.nudges += 1; if s.nudges <= 2 { turnSoon(s, "Every survey has reported already: what they found is in <found>. Go on.") } }
        }
    }

    func apply(_ s: ConnectSession, _ reply: JSONValue) {
        let dispatches = reply["dispatch"]?.array ?? []
        let say = JS.string(reply["say"])
        s.chat.append(ChatEntry(["role": "agent", "text": .string(!say.isEmpty ? say : (!(reply["ask"]?.isNull ?? true) ? "" : !dispatches.isEmpty ? "Starting that now." : "…")),
                                 "ask": reply["ask"] ?? .null, "authorize": reply["authorize"] ?? .null, "at": .string(now())]))
        for d in dispatches { dispatch(s, kind: "import", source: JS.string(d["source"]), apps: (d["apps"]?.array ?? []).compactMap(\.string), label: JS.string(d["label"]), plan: JS.string(d["plan"])) }
        if reply["done"] == .bool(true) && !surveying(s) { s.done = true }
        let asked = !(reply["ask"]?.isNull ?? true), auth = !(reply["authorize"]?.isNull ?? true)
        s.waitingForSurvey = !s.done && !asked && !auth && (reply["waiting"] == .bool(true) || (reply["done"] == .bool(true) && surveying(s)))
        maybeMemory(s)
    }

    /// The librarian woken by what a survey found, when it said it was waiting for one.
    func wake(_ s: ConnectSession) {
        if s.thinking || s.stopped || s.suspended || s.finished { return }
        var apps: [String] = []
        for a in s.surveyNews where !apps.contains(a) { apps.append(a) }
        s.surveyNews = []
        if apps.isEmpty { return }
        turnSoon(s, apps.map { SessionText.messageOf(["survey": .string($0)]) }.joined(separator: "; "))
    }

    // MARK: the priority queue

    func mayReach(_ s: ConnectSession, _ app: String) -> Bool { s.choices.direct != nil || !Self.asksFirst(app) || s.allowed.contains(app) }
    func pickedHere(_ s: ConnectSession, _ app: String) -> Bool { s.choices.sources.values.contains { $0.on && $0.apps.contains(app) } || (s.choices.direct?.apps.contains(app) ?? false) }

    /// A job queued: started when a place is free, the most urgent kind first. The same kind, source and apps go once.
    @discardableResult
    func dispatch(_ s: ConnectSession, kind: String = "import", source: String, apps given: [String] = [], label: String, plan: String = "", extra: (sites: [String], tool: ExtraTool?)? = nil,
                  find: Bool = false, route: String? = nil, again: Bool = false, keyExtra: String = "") -> ConnectJob? {
        if kind == "import" && s.skippedSources.contains(source) { return nil }
        let apps = (kind == "import" && !given.isEmpty ? given.filter { !s.skipped.contains($0) } : given).filter { mayReach(s, $0) }
        if !given.isEmpty && apps.isEmpty { return nil }
        let key = "\(find ? "find" : kind):\(source):\(apps.sorted().joined(separator: ","))\(again ? ":again" : "")\(keyExtra.isEmpty ? "" : ":\(keyExtra)")"
        if s.jobs.contains(where: { $0.key == key }) || s.jobs.count >= Self.maxJobs { return nil }
        if !apps.isEmpty && apps.allSatisfy({ s.skipped.contains($0) }) { return nil }
        if kind == "import" && !apps.isEmpty && s.jobs.contains(where: { $0.kind == "import" && $0.source == source && $0.apps.isEmpty }) { return nil }
        s.seq += 1
        let job = ConnectJob(key: key, kind: kind, seq: s.seq, source: source, apps: apps, label: label, plan: plan)
        job.extra = extra
        job.find = find
        if route == "browser" && kind == "import" { job.route = route }
        s.jobs.append(job)
        traced(kind: "dispatch", sessionId: s.id, jobId: job.id, text: "Queued \(kind)\(find ? " (folder search)" : "")\(job.route != nil ? " (in \(s.choices.browserAgents?.browserName ?? ""))" : ""): \(label)",
               detail: ["kind": .string(kind), "source": .string(source), "apps": .array(apps.map { .string($0) }), "label": .string(label), "priority": .number(Double(job.priority)), "plan": .string(plan)])
        logAction(s, job, find ? "Will look for your \(Self.folderName(apps.first ?? ""))" : kind == "survey" ? "Will look through \(apps.map(ConnectSources.shownName).joined(separator: ", "))"
                  : kind == "recall" ? "Will ask \(apps.map(ConnectSources.shownName).joined(separator: ", ")) what it remembers" : "Queued")
        pump(s)
        return job
    }

    func pump(_ s: ConnectSession) {
        if s.stopped || s.suspended || s.blocked != nil { return }
        while true {
            let running = s.jobs.filter { $0.status == "running" || $0.status == "waiting" }.count
            if running >= (deps.maxRunning ?? Self.maxRunning) { break }
            guard let next = s.jobs.filter({ $0.status == "queued" }).min(by: { $0.priority != $1.priority ? $0.priority < $1.priority : $0.seq < $1.seq }) else { break }
            next.status = "running" // taken now; runJob says so too
            Task { await runJob(s, next) }
        }
    }

    func appsOfJob(_ s: ConnectSession, _ job: ConnectJob) -> [String] {
        (job.apps.isEmpty ? (s.choices.sources[job.source]?.apps ?? []) : job.apps).filter { job.apps.contains($0) || mayReach(s, $0) }
    }

    func jobMessage(_ s: ConnectSession, _ job: ConnectJob) -> String {
        let custom = instructionsText(s.dataRoot)
        let choice = s.choices.sources[job.source]
        let apps = job.apps.isEmpty ? (choice?.apps ?? []) : job.apps
        let found = s.found[job.source] ?? [:]
        let period = SessionText.periodBlock(s.choices)
        let skills = Skills.skillsFor(source: job.source, apps: apps, dataRoot: URL(fileURLWithPath: s.dataRoot))
        if job.kind == "survey" && job.find { return findMessage(s, job) }
        if job.kind == "survey" {
            return [engelbartBlock(s), SessionText.projectBlock(s.choices), period, "<source>\(job.source)</source>", "<app>\(apps.first ?? "")</app>", skills,
                    "<found>\n\((found[apps.first ?? ""] ?? .object([:])).text(pretty: true))\n</found>", "Look at what they have in \(apps.first ?? "") now, and report."].filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
        if job.kind == "recall" {
            return [engelbartBlock(s), "<app>\(apps.first ?? "")</app>", skills, "<prompt>\n\(Texts.recallPrompt)\n</prompt>", "Ask \(apps.first ?? "") now, and save its answer with save_memory."].joined(separator: "\n\n")
        }
        let source: JSONValue = ["source": .string(job.source), "apps": .array(apps.map { .string($0) }), "label": .string(job.label), "foldersPicked": .array((choice?.folders ?? []).map { .string($0) }),
                                 "repositoriesPicked": .array((choice?.repos ?? []).map { .string($0) }), "foldersChosen": .object(s.picked.folders.mapValues { .string($0) }), "downloadsGoTo": .string(s.downloads)]
        let browserRoute = job.route == "browser" && s.choices.browserAgents != nil
        return [engelbartBlock(s), SessionText.projectBlock(s.choices), "<source>\(source.text())</source>", period, "<plan>\n\(job.plan)\n</plan>",
                "<chat>\n\(Names.clipMiddle(conversationText(s), 30000))\n</chat>", "<found>\n\(Names.clipMiddle(JSONValue.object(found).text(pretty: true), 40000))\n</found>", skills,
                s.choices.custom.isEmpty ? "" : "<import_instructions note=\"What the person typed on the choose screen for this import.\">\n\(s.choices.custom)\n</import_instructions>",
                custom.isEmpty ? "" : "<custom_instructions>\n\(custom)\n</custom_instructions>",
                browserRoute ? browserBlock(s, job, apps) : "",
                browserRoute ? "<note>The skills above name Engelbart's own browser tools (browser_*, import_google_files, gmail_*, web_chats). You do not have them: follow the same steps in your own tabs, read each item's text and bring it in with add_note. Gmail: at most 50 threads, only about the projects.</note>" : "",
                "Do the import now."].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// A search for an app's folder the scan did not find where it usually is (MATH-117).
    func findMessage(_ s: ConnectSession, _ job: ConnectJob) -> String {
        let app = job.apps.first ?? ""
        let access = accessOf(s)
        let shown = { (d: String) in Readers.shownPath(self.homeDir, d) }
        let allowed = access.allowed.map { "\($0.name) (\(shown($0.path)))" }
        let allowedTop = Set(access.allowed.map(\.id))
        let skipped = ["Desktop", "Documents", "Downloads", "Library", "Pictures", "Music", "Movies"].filter { !allowedTop.contains($0) }
        let insideLibrary = access.allowed.filter { $0.id.hasPrefix("Library/") }.map { shown($0.path) }
        let tops = (Readers.entries(homeDir) ?? []).filter { $0.isDir && !$0.name.hasPrefix(".") && !skipped.contains($0.name) }.map { "~/\($0.name)" }.sorted().prefix(60)
        let lookIn = Array(tops) + insideLibrary
        let usual = [Readers.exists((homeDir as NSString).appendingPathComponent("Dropbox")) ? "~/Dropbox" : ""].filter { !$0.isEmpty } + allowed
        let what: String
        switch app {
        case "Zoom": what = "Find their folder of Zoom recordings. Zoom keeps each meeting in a folder named by its date and topic (\"2026-03-04 10.00.00 Lab meeting\"), holding its transcript (a .vtt or .txt file), audio and video. People move that folder, or point Zoom's recording setting elsewhere\(usual.isEmpty ? "" : ": look under \(usual.joined(separator: ", ")) first"). \"folder\" is the folder that holds the meeting folders. When there is none on this Mac, say so in \"notes\": the cloud recordings at zoom.us/recording are what an import agent reads instead."
        case "Obsidian": what = "Find their Obsidian vault: a folder holding a .obsidian folder (Glob for **/.obsidian inside each folder you may look in, one at a time). When there are several, \"folder\" is the one they most likely work in: the most notes, changed most recently."
        case ConnectSources.localPDFs: what = "Find the folders that hold their PDFs, papers mostly: use folder_overview and list_pdfs on the folders Glob finds them in. \"folders\" lists them, the most PDFs first, at most 6."
        default: what = "Find their \(ConnectSources.shownName(app)) folder."
        }
        let reply = app == ConnectSources.localPDFs ? "\"folders\": [\"<absolute path>\", ...] (empty when you found none)" : "\"folder\": \"<absolute path, or null when you found none>\""
        return [engelbartBlock(s), SessionText.projectBlock(s.choices), "<source>\(job.source)</source>", "<app>\(app)</app>",
                "Engelbart did not find \(app == ConnectSources.localPDFs ? "any folder of PDFs" : "their \(ConnectSources.shownName(app)) folder") where it usually is. \(what)",
                "Look with Glob, Grep and Read, inside their home folder (\(homeDir)) only. Never look in \(skipped.map { "~/\($0)" }.joined(separator: ", "))\(insideLibrary.isEmpty ? "" : " (\(insideLibrary.joined(separator: " and ")) aside)"): macOS has not let Engelbart read \(skipped.count > 1 ? "them" : "it"), and looking there makes it stop the person with a prompt. Skip hidden folders too (a vault's .obsidian aside). Never Glob from the home folder itself (a pattern like \(homeDir)/**/x walks into the folders to skip): Glob inside each folder you may look in instead.",
                "<folders_allowed note=\"Protected folders macOS let Engelbart read\">\(allowed.isEmpty ? "none" : allowed.joined(separator: ", "))</folders_allowed>",
                "<look_in note=\"The folders of their home folder you may look in\">\(lookIn.isEmpty ? "none" : lookIn.joined(separator: ", "))</look_in>",
                "Spend a few minutes at most. Never call needs_you to ask them for a folder: when you find nothing, say so, and they are offered a button to choose one.",
                "Reply with the survey's JSON object, with two more fields: \(reply), and \"searched\": \"<where you looked, in a few words>\"."].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    func systemOf(_ s: ConnectSession, _ kind: String) -> String {
        switch kind {
        case "browse": return Prompts.browseSystemPrompt(s.choice.provider, base: SessionText.promptOf(s.dataRoot, "connect-browse-system-prompt.md", Texts.browseSystemPrompt))
        case "survey": return Texts.surveySystemPrompt
        case "recall": return Texts.recallSystemPrompt
        case "memory": return Texts.memorySystemPrompt
        case "redact": return Texts.redactSystemPrompt
        default: return SessionText.promptOf(s.dataRoot, "connect-import-system-prompt.md", Texts.importSystemPrompt)
        }
    }

    func runJob(_ s: ConnectSession, _ job: ConnectJob) async {
        job.status = "running"
        job.started = now()
        logAction(s, job, job.kind == "memory" ? "Writing MEMORY.md" : job.kind == "redact" ? "Taking any secrets out of MEMORY.md" : "Started")
        emit(s)
        let controller = AbortSignal()
        s.controllers.append(controller)
        job.controller = controller
        let bridged = Self.work.contains(job.kind)
        let browse = job.route == "browser" ? s.choices.browserAgents : nil
        let turnKind = browse != nil ? "browse" : job.kind
        let covered = appsOfJob(s, job)
        var sites = Self.sitesOf(covered)
        for site in job.extra?.sites ?? [] where !sites.contains(site) { sites.append(site) }
        let page = bridged && browse == nil && s.choices.permissions.browser && !sites.isEmpty ? deps.browser?.tools(AgentJob(id: job.id, label: job.label, sites: sites, sendOnly: job.kind == "recall" ? Texts.recallPrompt : nil)) : nil
        let extraSites = job.extra?.sites ?? []
        let approvals = s.choices.direct == nil
        let toolNames = bridged && browse == nil ? Tools.toolNamesFor(turnKind, apps: covered, extraSites: extraSites, page: page != nil, approvals: approvals) : nil
        let browseSites = Tools.browseSitesFor(turnKind, apps: covered, extraSites: extraSites, approvals: approvals)
        // The tools run off the main thread (the bridge's queue, the agent's task): what they read of the session is read
        // on the main thread (onMain), never assumed to be there.
        let session = ToolSession(dataRoot: s.dataRoot, homeDir: homeDir, dir: s.dir, downloads: s.downloads, readable: { [weak self] dir in onMain { self?.accessOf(s).readable(dir) ?? false } },
                                  apps: covered, group: job.source, browseSites: browseSites,
                                  approvedFor: { app in onMain { approvals && Tools.approvalApps.contains(app) ? (s.approved[app] ?? []) : nil } },
                                  exports: { onMain { s.picked.exports } }, folders: { onMain { s.picked.folders } },
                                  days: { onMain { s.choices.days.map(Double.init) } }, gmailThreads: { onMain { s.gmailThreads } },
                                  setGmailThreads: { [weak self] n in Task { @MainActor in s.gmailThreads = max(0, n); self?.save(s) } })
        var callTool: ((String, JSONValue) async throws -> Any)?
        if bridged {
            let tools = ImportTools(session: session, store: deps.store, kind: turnKind, page: page,
                                    needs: ToolNeeds(ask: { [weak self] kind, reason in await self?.askPerson(s, job, kind: kind, reason: reason) ?? ["status": "skipped"] },
                                                     wait: { [weak self] in await self?.waitAgain(s, job) ?? ["status": "done"] }),
                                    recall: { [weak self] app, text in await self?.keepRecall(s, app, text) },
                                    asked: { app, id in Task { @MainActor in job.asked = (app, id) } }, question: Texts.recallPrompt,
                                    appleNotes: deps.appleNotes, zotero: deps.zotero, github: deps.github, env: env, only: toolNames,
                                    added: { [weak self] kind, n, title in Task { @MainActor in
                                        if kind == "notes" { job.notes += n } else { job.items += n }
                                        if let title, job.titles.count < 80 { job.titles.append(String(title.prefix(120))) }
                                        self?.emit(s, soon: true)
                                    } },
                                    kept: { [weak self] row in Task { @MainActor in self?.keepRow(s, row) } },
                                    log: { [weak self] text in Task { @MainActor in self?.logAction(s, job, text) } })
            callTool = { name, args in try await tools.call(name, args) }
        }
        var bridge: BridgeHandle?
        var held = false
        defer { }
        do {
            let onUpdate: (AgentUpdate) -> Void = { [weak self] u in Task { @MainActor in
                guard let self else { return }
                if let r = u.retry { self.logAction(s, job, "Trying again (\(r.attempt) of \(r.of)): \(r.reason)") }
                if let a = u.activity, a != job.activity { job.activity = a; self.emit(s, soon: true) }
            } }
            if let browse { logAction(s, job, "In \(browse.browserName), in a tab of its own") }
            var connectorsNow: [ConnectorServer] = []
            if bridged && browse == nil, let connectors = deps.connectors { connectorsNow = await connectors.serversForRun(covered, provider: s.choice.provider) }
            job.connectors = connectorsNow.map(\.app)
            if bridged, let callTool { bridge = try await deps.openBridge(callTool, controller) }
            let choice = job.kind == "redact" ? (s.redactChoice ?? s.choice) : s.choice
            let dirs: [String] = job.kind == "memory" ? [s.dir, (s.dataRoot as NSString).appendingPathComponent("assets/md"), s.projectDir].compactMap { $0 }.filter(Readers.exists) : job.kind == "redact" ? [] : s.dirs
            let message = job.kind == "memory" ? memoryMessage(s) : job.kind == "redact" ? "<memory_md>\n\(s.memoryDraft ?? "")\n</memory_md>" : jobMessage(s, job)
            let browseOptions = browse.map { (steps: (s.dir as NSString).appendingPathComponent("steps/\(job.id)"), enable: $0.enable, browser: $0.browserName) }
            let toolCall: ((String, JSONValue) async throws -> JSONValue)? = callTool.map { call in { name, args in let v = try await call(name, args); return (v as? JSONValue) ?? ((v as? MCPContent).map { ["content": $0.content] } ?? .null) } }
            let out = try await deps.agents.turn(AgentTurnInput(choice: choice, kind: turnKind, system: systemOf(s, turnKind), message: message, session: nil, dirs: dirs, signal: controller,
                                                                onUpdate: onUpdate, bridge: bridge?.connection, connectors: browse != nil ? [] : connectorsNow, browse: browseOptions, toolNames: toolNames,
                                                                meta: meta(s, kind: turnKind, job: job, callTool: toolCall)))
            if job.kind == "survey" { await surveyed(s, job, out.text) }
            else if job.kind == "memory" { try drafted(s, out.text) }
            else if job.kind == "redact" { try finishMemory(s, out.text) }
            job.summary = job.kind == "memory" || job.kind == "redact" ? "" : SessionText.line(job.kind == "survey" ? (SessionText.readSurvey(out.text)["summary"]?.string?.nilIfEmpty ?? out.text) : out.text, 500)
            job.status = "done"
            logAction(s, job, job.kind == "import" ? "Finished: \(job.summary)" : job.kind == "survey" ? "\(job.find ? "Looked for it" : "Looked"): \(job.summary)"
                      : job.kind == "recall" ? (s.recalls[job.apps.first ?? ""] != nil ? "Kept what it remembers" : "Finished: \(job.summary)") : "Finished")
        } catch {
            held = !s.stopped && ProviderFailure.needsProvider(error) && holdForProvider(s, job, (job.kind == "redact" ? (s.redactChoice ?? s.choice) : s.choice).provider, error)
            if !held {
                let stoppedNow = (error as? ConnectError)?.kind == "stopped" || controller.isAborted
                job.status = stoppedNow ? "stopped" : "failed"
                job.error = job.status == "failed" ? SessionText.line((error as? ConnectError)?.message ?? error.localizedDescription.nilIfEmpty ?? "The import failed", 300) : ""
                logAction(s, job, job.status == "stopped" ? "Stopped" : "Failed: \(job.error)")
                if job.kind == "survey" { await surveyed(s, job, nil, error: job.error.isEmpty ? "stopped" : job.error) }
                if job.kind == "memory" || job.kind == "redact" { s.memory["status"] = .string(job.status == "stopped" ? "stopped" : "failed"); s.memory["error"] = .string(job.error) }
            }
        }
        s.controllers.removeAll { $0 === controller }
        job.controller = nil
        bridge?.close()
        deps.browser?.close(job.id)
        releaseNeeds(s, job)
        job.activity = ""
        job.ended = held ? nil : now()
        if !held { rerunJob(s, job) }
        emit(s)
        pump(s)
        maybeMemory(s)
    }

    /// An import whose connector was signed in while its agent ran: run once more, with the connection.
    func rerunJob(_ s: ConnectSession, _ job: ConnectJob) {
        guard job.rerun, job.kind == "import", !s.stopped, job.status != "stopped" else { return }
        job.rerun = false
        if job.apps.contains(where: { s.skipped.contains($0) }) { return }
        if let next = dispatch(s, kind: "import", source: job.source, apps: job.apps, label: job.label, plan: job.plan, extra: job.extra, route: job.route, again: true) {
            logAction(s, next, "Again, now that \(job.apps.map(ConnectSources.shownName).joined(separator: ", ")) \(job.apps.count == 1 ? "is" : "are") connected")
        }
    }

    /// A job failed as one its provider's CLI needs the person for: queued again, the run waiting (direct runs only).
    func holdForProvider(_ s: ConnectSession, _ job: ConnectJob, _ provider: String, _ error: Error) -> Bool {
        guard s.choices.direct != nil, ConnectModels.providers.contains(provider) else { return false }
        job.status = "queued"; job.error = ""; job.started = nil
        let name = ConnectModels.providerNames[provider] ?? provider
        if s.blocked == nil {
            s.blocked = (provider, SessionText.line((error as? ConnectError)?.message ?? error.localizedDescription, 200), now())
            logAction(s, nil, "Waiting for \(name): \(s.blocked!.error)")
            deps.providerCheck?(provider)
        } else { logAction(s, job, "Waiting for \(name)") }
        return true
    }

    /// The run's provider connected (or the other picked instead): what waited runs now.
    @discardableResult
    public func unblock(_ id: String, provider: String? = nil) throws -> JSONValue {
        let s = try get(id)
        guard let blocked = s.blocked else { return snapshot(s) }
        let want = provider.flatMap { ConnectModels.providers.contains($0) ? $0 : nil } ?? blocked.provider
        let name = ConnectModels.providerNames[want] ?? want
        if !readyNow().contains(want) { throw ConnectError("failed", "\(name) is not connected yet") }
        if want != s.choice.provider { s.choice = choiceFor(want); logAction(s, nil, "Switched to \(name) (\(s.choice.modelName) · \(s.choice.effort))", who: "You") }
        if let r = s.redactChoice, r.provider != want { s.redactChoice = nil }
        s.blocked = nil
        logAction(s, nil, "\(name) connected: going on")
        emit(s); pump(s); maybeMemory(s)
        return snapshot(s)
    }

    // MARK: surveys

    func surveyed(_ s: ConnectSession, _ job: ConnectJob, _ text: String?, error: String = "") async {
        if job.find { await lookedFor(s, job, text, error: error); return }
        let app = job.apps.first ?? ""
        let report: JSONValue = text.map { SessionText.readSurvey($0) } ?? ["error": .string(error.isEmpty ? "The survey did not finish" : error)]
        var entry = s.found[job.source]?[app]?.object ?? [:]
        entry["survey"] = report
        s.put(job.source, app, .object(entry), news: true)
        s.surveyNews.append(app)
        if s.waitingForSurvey && !s.thinking { wake(s) }
    }

    /// The search for an app's folder ended (MATH-117).
    func lookedFor(_ s: ConnectSession, _ job: ConnectJob, _ text: String?, error: String) async {
        let app = job.apps.first ?? "", source = job.source
        if text == nil && (s.suspended || s.stopped) { return }
        var report = text.map { SessionText.readSurvey($0, homeDir: homeDir) } ?? ["folders": [], "searched": .null, "notes": .null, "error": .string(error.isEmpty ? "The search did not finish" : error)]
        let access = accessOf(s)
        let folders = (report["folders"]?.array ?? []).compactMap(\.string).filter { access.readable($0) }
        if var o = report.object { o["folders"] = .array(folders.map { .string($0) }); report = .object(o) }
        let reach = ConnectSources.apps[app]?.reach.rawValue ?? "local"
        let missing = {
            let searched = report["searched"]?.string ?? report["notes"]?.string ?? (report["error"]?.string.map { "the search failed: \($0)" } ?? "their home folder")
            var e: [String: JSONValue] = ["reach": .string(reach), "needs": "folder", "searched": .string(searched)]
            if app == "Zoom" { e["cloud"] = "Cloud recordings can be read at zoom.us in Engelbart's browser." }
            s.put(source, app, .object(e), news: true)
        }
        if let folder = folders.first {
            s.picked.folders[app] = folder
            if app == ConnectSources.localPDFs, var choice = s.choices.sources[source], folders.count > 1 {
                for f in folders.dropFirst() where !choice.folders.contains(f) { choice.folders.append(f) }
                choice.folders = Array(choice.folders.prefix(12)); s.choices.sources[source] = choice
            }
            logAction(s, job, "Found your \(Self.folderName(app)) at \(folders.prefix(3).map { Readers.shownPath(homeDir, $0) }.joined(separator: ", "))")
            s.put(source, app, ["reach": .string(reach)], news: true)
            await rescan(s, [source])
        } else { missing() }
        s.dirs = dirsOf(s)
        s.surveyNews.append(app)
        save(s)
        if s.waitingForSurvey && !s.thinking { wake(s) }
    }

    /// An app on this Mac whose folder the scan did not find, looked for by an agent (MATH-117).
    func lookForFolders(_ s: ConnectSession) {
        if !s.choices.computer || s.stopped || s.suspended || s.finished { return }
        for (source, apps) in s.found {
            guard let choice = s.choices.sources[source], choice.on else { continue }
            for (app, value) in apps.sorted(by: { $0.key < $1.key }) {
                guard value["needs"]?.string == "folder", Self.findApps.contains(app), choice.apps.contains(app), !s.skipped.contains(app), s.picked.folders[app] == nil else { continue }
                if s.jobs.contains(where: { $0.find && $0.apps.contains(app) }) { continue }
                let entry: JSONValue = ["reach": .string(value["reach"]?.string ?? "local"), "survey": "running", "looking": "for its folder"]
                s.put(source, app, entry)
                guard dispatch(s, kind: "survey", source: source, apps: [app], label: "Looking for your \(Self.folderName(app))", find: true) != nil else { s.put(source, app, value); continue }
                s.newFound = s.newFound ?? [:]; s.newFound![source, default: [:]][app] = entry
            }
        }
    }
}

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

public enum Prompts {
    /// A browser agent's system prompt for `provider`: `base` and how it reaches the browser.
    public static func browseSystemPrompt(_ provider: String, base: String = Texts.browseSystemPrompt) -> String { "\(base)\n\n\(provider == "openai" ? Texts.browseCodex : Texts.browseClaude)" }
    /// onboarding/prompts.cjs assistantProjectsPrompt(today).
    public static func assistantProjectsPrompt(_ today: String) -> String { Texts.assistantProjectsPromptTemplate.replacingOccurrences(of: "__TODAY__", with: String(today.prefix(10))) }
}
