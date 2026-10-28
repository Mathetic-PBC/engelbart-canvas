import Foundation
import EngelbartCore

// Ports of src/main/connect/scan-child.cjs + offthread.cjs (the scanner off the main thread), and of
// src/main/onboarding/discover.cjs + assistant-projects.cjs (Import your context's two discovery agents).

/// The scanner (2026-10-13: "I often see the Mac spinner for like a second between screens"): detect, localRepos and the
/// project digest read every session file; they run off the main actor, a job over `timeoutMs` failing. Electron forked a
/// utility process for this (with a watchdog for one that never started); here a detached task on a background queue does
/// the same for the window, and the session lists are kept for a minute so one onboarding reads them once.
public final class Scanner: @unchecked Sendable {
    let timeoutMs: Double
    public init(timeoutMs: Double = 120_000) { self.timeoutMs = timeoutMs; Readers.keepLocalChats(true) }

    public func run<T: Sendable>(_ job: String, _ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await Task.detached(priority: .utility) { try work() }.value }
            group.addTask { try await Task.sleep(nanoseconds: UInt64(self.timeoutMs * 1_000_000)); throw ConnectError("failed", "The scan (\(job)) took too long") }
            let first = try await group.next()!
            group.cancelAll()
            return first
        }
    }
}

// MARK: assistant-projects.cjs

/// Recent projects from the person's ChatGPT or Claude (2026-10-16): Engelbart itself, not a model, asks the fixed question
/// in a hidden window (sendOnly the question), reads the answer from the site's own endpoint, then deletes that one chat.
public final class AssistantProjects: @unchecked Sendable {
    public static let assistants = ["ChatGPT", "Claude"]
    static let signInTimeoutMs = 20_000.0, sentWaitMs = 20_000.0, pollMs = 3000.0
    public static let askTimeoutMs = 150_000.0
    static let malformedStill = 4

    /// The site sent the window to its sign-in page.
    public static func atSignIn(_ url: String) -> Bool {
        guard let u = URL(string: url), let host = u.host else { return false }
        return JS.test(host, #"^auth[0-9]*\.openai\.com$"#) || JS.test(u.path, #"^/(?:auth/)?(?:login|logout|log-in|signin|sign-in)\b"#, options: .caseInsensitive)
    }

    /// An assistant's answer → projects | none | empty | malformed.
    public static func readAnswer(_ text: String?) -> (kind: String, projects: [ImportFlow.Project]) {
        let raw = JS.replace(JS.replace((text ?? "").trimmingCharacters(in: .whitespacesAndNewlines), #"^```(?:json)?\s*"#, "", options: .caseInsensitive), #"\s*```$"#, "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return ("empty", []) }
        if JS.test(raw, #"^["'`*_]*null["'`*_]*\.?$"#, options: .caseInsensitive) { return ("none", []) }
        var value = try? JSONValue.parse(raw)
        if value == nil {
            guard let s = raw.firstIndex(of: "{"), let e = raw.lastIndex(of: "}"), s < e, let v = try? JSONValue.parse(String(raw[s...e])) else { return ("malformed", []) }
            value = v
        }
        guard let v = value else { return ("malformed", []) }
        if v.isNull { return ("none", []) }
        guard case .object(let o) = v, let projects = o["projects"] else { return ("malformed", []) }
        if projects.isNull || projects.array?.isEmpty == true { return ("none", []) }
        if let read = ImportFlow.readProjects(v.text()) { return ("projects", read) }
        return ("malformed", [])
    }

    /// The assistant's last answer after the question in a chat, or ''.
    public static func answerIn(_ turns: [Readers.Turn], question: String) -> String {
        let opening = String(WebChats.squash(question).prefix(80))
        guard let asked = turns.firstIndex(where: { $0.role == "user" && WebChats.squash($0.text).hasPrefix(opening) }) else { return "" }
        return turns[(asked + 1)...].filter { $0.role == "assistant" }.last?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// The projects several answers named, one per title, at most `max`, none already in `existing` unless that leaves none.
    public static func mergeProjects(_ lists: [[ImportFlow.Project]], existing: [String] = [], max: Int = 5) -> [ImportFlow.Project] {
        let key = { (t: String) in JS.replace(t.lowercased(), "[^a-z0-9]+", " ").trimmingCharacters(in: .whitespaces) }
        let have = Set(existing.map(key))
        var seen = Set<String>(), ids = Set<String>(), all: [ImportFlow.Project] = [], fresh: [ImportFlow.Project] = []
        for list in lists { for p in list {
            let k = key(p.title)
            if k.isEmpty || seen.contains(k) { continue }
            seen.insert(k)
            var id = p.id
            while ids.contains(id) { id += "-2" }
            ids.insert(id)
            var row = p; row.id = id
            all.append(row)
            if !have.contains(k) { fresh.append(row) }
        } }
        return Array((fresh.isEmpty ? all : fresh).prefix(max))
    }

    let webSignIn: WebSignIn?
    let browser: AgentBrowsing?
    let log: (String, JSONValue?) -> Void
    let sleep: (Double) async -> Void
    let askTimeout: Double
    public init(webSignIn: WebSignIn?, browser: AgentBrowsing?, log: @escaping (String, JSONValue?) -> Void = { _, _ in }, sleep: @escaping (Double) async -> Void = { await waitFor($0) }, askTimeoutMs: Double = AssistantProjects.askTimeoutMs) {
        self.webSignIn = webSignIn; self.browser = browser; self.log = log; self.sleep = sleep; self.askTimeout = askTimeoutMs
    }

    struct RouteError: Error { var outcome: String; var message: String }

    func askIn(_ page: AgentPage, _ app: String, _ question: String, signal: AbortSignal?, deadline: Double) async throws -> (kind: String, projects: [ImportFlow.Project], text: String) {
        let stop = { if signal?.isAborted == true { throw RouteError(outcome: "broke", message: "Stopped.") } }
        var id: String?
        defer {
            if let id { Task { do { _ = try await WebChats.delete(page, app, id, question: question); self.log("Deleted the question from \(app)'s chats", ["app": .string(app)]) } catch { self.log("Couldn't delete the question from \(app)'s chats: \((error as? ConnectError)?.message ?? error.localizedDescription)", ["app": .string(app)]) } } }
        }
        _ = try await page.open(Texts.assistantNewChat[app]!)
        try stop()
        let signedOut = RouteError(outcome: "unavailable", message: "Not signed in to \(app) in Engelbart's browser")
        if Self.atSignIn(page.url()) { throw signedOut }
        var signed = try? await page.evaluate(Texts.assistantSignedIn[app]!)
        if signed == nil || signed!["signedIn"] == nil || signed!["signedIn"]!.isNull { await sleep(Self.pollMs); signed = try? await page.evaluate(Texts.assistantSignedIn[app]!) }
        if signed?["signedIn"] == .bool(false) || Self.atSignIn(page.url()) { throw signedOut }
        if signed?["signedIn"] != .bool(true) { throw RouteError(outcome: "broke", message: "\(app) didn't say whether you're signed in") }
        try stop()
        let box = try await page.evaluate(Texts.findComposer)
        guard let ref = box["ref"]?.string else { throw RouteError(outcome: "broke", message: "\(app)'s message box wasn't found") }
        _ = try await page.type(ref, question, submit: false, replace: false)
        let shown = try? await page.read(offset: 0, maxChars: 500)
        if let send = (shown?["elements"]?.array ?? []).first(where: { JS.test(JS.string($0["name"]), #"^send\b"#, options: .caseInsensitive) && $0["disabled"] != .bool(true) && JS.string($0["role"]).contains("button") }) {
            _ = try await page.click(JS.string(send["ref"]))
        } else { _ = try await page.press("Enter") }
        let sentBy = Time.ms() + Self.sentWaitMs
        while id == nil && Time.ms() < sentBy && signal?.isAborted != true { id = WebChats.chatIdOf(app, page.url()); if id == nil { await sleep(min(500, Self.pollMs)) } }
        if id == nil && signal?.isAborted != true {
            let recent = (try? await WebChats.list(page, app, limit: 5, sleep: sleep))?["chats"]?.array ?? []
            for chat in recent {
                if let d = chat["date"]?.string.flatMap(Time.parse), Date().timeIntervalSince(d) > 15 * 60 { continue }
                let cid = JS.string(chat["id"])
                if let read = try? await WebChats.read(page, app, cid, sleep: sleep), let first = read.turns.first(where: { $0.role == "user" }), WebChats.squash(first.text).hasPrefix(String(WebChats.squash(question).prefix(80))) { id = cid; break }
            }
        }
        try stop()
        guard let chatId = id else { throw RouteError(outcome: "broke", message: "The question wasn't sent to \(app)") }
        log("Asked \(app) about the person's projects", ["app": .string(app), "chat": .string(chatId)])
        var last: String?
        var still = 0
        while Time.ms() < deadline && signal?.isAborted != true {
            var turns: [Readers.Turn] = []
            do { turns = try await WebChats.read(page, app, chatId, sleep: sleep).turns } catch let e as ConnectError { if e.kind == "signed-out" { throw signedOut } }
            let text = Self.answerIn(turns, question: question)
            still = !text.isEmpty && text == last ? still + 1 : 0
            last = text
            if !text.isEmpty && still >= 1 {
                let answer = Self.readAnswer(text)
                if answer.kind != "malformed" || still >= Self.malformedStill { return (answer.kind, answer.projects, text) }
            }
            await sleep(Self.pollMs)
        }
        try stop()
        if let last, !last.isEmpty { let a = Self.readAnswer(last); return (a.kind, a.projects, last) }
        throw RouteError(outcome: "broke", message: "\(app) didn't answer in \(Int((askTimeout / 1000).rounded())) seconds")
    }

    func askOne(_ app: String, _ question: String, _ signal: AbortSignal?) async -> JSONValue {
        guard let web = webSignIn, let browser, Texts.assistantNewChat[app] != nil else { return ["app": .string(app), "outcome": "unavailable"] }
        let quiet = await withTaskGroup(of: WebSignIn.Quiet?.self) { g -> WebSignIn.Quiet? in
            g.addTask { await web.signInQuiet(app) }
            g.addTask { try? await Task.sleep(nanoseconds: UInt64(Self.signInTimeoutMs * 1_000_000)); return nil }
            let first = await g.next() ?? nil; g.cancelAll(); return first
        }
        if quiet?.signedIn != true { log("Not asking \(app): not signed in to it in the chosen browser", ["app": .string(app)]); return ["app": .string(app), "outcome": "unavailable"] }
        if signal?.isAborted == true { return ["app": .string(app), "outcome": "broke", "error": "Stopped."] }
        let job = AgentJob(id: "discover-projects-\(app.lowercased())-\(Int(Time.ms()))", label: "Asking \(app) about your projects", sites: ConnectSources.apps[app]?.sites ?? [], sendOnly: question)
        let page = browser.tools(job)
        defer { Task { @MainActor in browser.close(job.id) } }
        do {
            let answer = try await askIn(page, app, question, signal: signal, deadline: Time.ms() + askTimeout)
            if answer.kind == "projects" {
                let projects = answer.projects.map { p -> JSONValue in
                    var q = p
                    q.folder = !p.folder.isEmpty && Readers.exists(p.folder) ? p.folder : ""
                    if q.evidence.isEmpty { q.evidence = "From \(app)'s memory" }
                    return ["id": .string(q.id), "title": .string(q.title), "description": .string(q.description), "recent": .string(q.recent), "folder": .string(q.folder), "evidence": .string(q.evidence)]
                }
                return ["app": .string(app), "outcome": "found", "projects": .array(projects)]
            }
            if answer.kind == "none" { return ["app": .string(app), "outcome": "none"] }
            return ["app": .string(app), "outcome": "broke", "error": .string(answer.kind == "empty" ? "\(app) sent an empty answer" : "\(app) did not answer as asked"), "answer": .string(String(answer.text.prefix(300)))]
        } catch let e as RouteError {
            return ["app": .string(app), "outcome": .string(e.outcome), "error": .string(String(e.message.prefix(300)))]
        } catch {
            return ["app": .string(app), "outcome": "broke", "error": .string(String(((error as? ConnectError)?.message ?? error.localizedDescription).prefix(300)))]
        }
    }

    /// Every assistant in `apps` asked at once.
    public func ask(apps: [String] = AssistantProjects.assistants, question: String, signal: AbortSignal? = nil) async -> [JSONValue] {
        let wanted = apps.filter { Self.assistants.contains($0) }
        return await withTaskGroup(of: (Int, JSONValue).self) { g in
            for (i, app) in wanted.enumerated() { g.addTask { (i, await self.askOne(app, question, signal)) } }
            var out: [(Int, JSONValue)] = []
            for await r in g { out.append(r) }
            return out.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }
}

// MARK: discover.cjs

public enum ToolEvidence {
    public static let historyDays = 90.0
    static let usageSites: [String: [String]] = ["OneNote": ["onenote.com", "onenote.cloud.microsoft"], "Google Docs": ["docs.google.com", "drive.google.com"], "Google Meet": ["meet.google.com"],
                                                 "Gmail": ["mail.google.com"], "Gemini": ["gemini.google.com"], "Grok": ["grok.com"], "ChatGPT": ["chatgpt.com", "chat.openai.com"], "Claude": ["claude.ai"]]
    static let desktop: [String: [String]] = Scan.bundles.merging(["Overleaf": [], "Grok": []]) { a, _ in a }

    static func hostOf(_ url: String) -> String { JS.replace(URL(string: url)?.host ?? "", #"^www\."#, "") }

    static func sqliteRows(_ file: String, _ query: String) -> [[String: SQLiteReader.Value]] {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-history-\(UUID().uuidString.prefix(8))").path
        try? FileManager.default.createDirectory(atPath: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        let copy = (scratch as NSString).appendingPathComponent((file as NSString).lastPathComponent)
        guard (try? FileManager.default.copyItem(atPath: file, toPath: copy)) != nil else { return [] }
        if Readers.exists(file + "-wal") { try? FileManager.default.copyItem(atPath: file + "-wal", toPath: copy + "-wal") }
        guard let db = try? SQLiteReader(path: copy) else { return [] }
        defer { db.close() }
        return (try? db.all(query)) ?? []
    }

    /// A browser's most visited sites from its history (Chromium, Firefox, or Safari with Full Disk Access).
    public static func historySites(homeDir: String, browserId: String?, days: Double = historyDays, diskAccess: () -> Bool) -> [(host: String, visits: Double)] {
        guard let id = browserId, let browser = ImportFlow.browserById(id) else { return [] }
        var tally: [String: Double] = [:]
        let add = { (url: String, visits: Double) in let h = hostOf(url); if !h.isEmpty { tally[h, default: 0] += visits > 0 ? visits : 1 } }
        if id == "firefox" {
            let root = (homeDir as NSString).appendingPathComponent("Library/Application Support/Firefox/Profiles")
            let since = Int64((Time.ms() - days * 864e5) * 1000)
            for name in ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []).sorted().prefix(3) {
                let file = (root as NSString).appendingPathComponent("\(name)/places.sqlite")
                for r in sqliteRows(file, "SELECT url, visit_count AS visits FROM moz_places WHERE last_visit_date > \(since) ORDER BY visit_count DESC LIMIT 5000;") { add(r["url"]?.string ?? "", r["visits"]?.double ?? 0) }
            }
        } else if id == "safari" {
            if !diskAccess() { return [] }
            let since = Time.ms() / 1000 - 978_307_200 - days * 86400
            for r in sqliteRows((homeDir as NSString).appendingPathComponent("Library/Safari/History.db"), "SELECT i.url AS url, COUNT(v.id) AS visits FROM history_items i JOIN history_visits v ON v.history_item = i.id WHERE v.visit_time > \(since) GROUP BY i.id ORDER BY visits DESC LIMIT 5000;") {
                add(r["url"]?.string ?? "", r["visits"]?.double ?? 0)
            }
        } else {
            for p in Readers.browserProfiles(homeDir).filter({ $0.browser.lowercased() == browser.name.lowercased() }).prefix(4) {
                for site in (try? Readers.browserHistory(p.dir, days: days, limit: 400, by: "site")) ?? [] { add("https://\(JS.string(site["host"]))/", site["visits"]?.double ?? 0) }
            }
        }
        return tally.map { ($0.key, $0.value) }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }.prefix(400).map { $0 }
    }

    static func visitsTo(_ sites: [(host: String, visits: Double)], _ app: String) -> Double {
        let usage = usageSites[app] ?? ConnectSources.apps[app]?.sites ?? []
        return sites.filter { s in usage.contains { s.host == $0 || s.host.hasSuffix(".\($0)") } }.reduce(0) { $0 + $1.visits }
    }
    static func sharedSignIn(_ app: String) -> Bool {
        guard let own = ConnectSources.signInCookies[app]?.domain else { return false }
        return ConnectSources.signInCookieOrder.contains { $0 != app && ConnectSources.signInCookies[$0]!.domain == own }
    }

    /// What can be told without a model → { evidence, sites, history? }.
    public static func evidence(homeDir: String, browserId: String?, detected: Scan.Detected?, github: GitHubStatus?, cookies: (String) -> Bool,
                                applications: [String]? = nil, diskAccess: () -> Bool) -> JSONValue {
        let apps = applications ?? ["/Applications", (homeDir as NSString).appendingPathComponent("Applications")]
        var evidence: [String: JSONValue] = [:]
        let set = { (id: String, used: Bool, method: String, text: String) in evidence[id] = ["used": .bool(used), "method": .string(method), "evidence": .string(text)] }
        let appInstalled = { (app: String) in (desktop[app] ?? []).contains { b in apps.contains { Readers.exists(($0 as NSString).appendingPathComponent(b)) } } }
        let blocked = browserId == "safari" && !diskAccess()
        let sites = blocked ? [] : historySites(homeDir: homeDir, browserId: browserId, diskAccess: { true })
        let browserName = ImportFlow.browserById(browserId)?.name ?? "your browser"
        let localRepos = (try? detected?.localRepos.get()) ?? []
        for tool in ImportFlow.catalog {
            let id = tool.id
            if id == ImportFlow.sites { set(id, !sites.isEmpty, "local", !sites.isEmpty ? "\(browserName) history on this Mac" : blocked ? "Safari history needs Full Disk Access" : "No history found"); continue }
            if id == ImportFlow.localFolders { set(id, !localRepos.isEmpty, "local", localRepos.isEmpty ? "" : "\(localRepos.count) repositories on this Mac"); continue }
            if id == "GitHub" {
                let signed = github?.connected == true
                set(id, signed || !localRepos.isEmpty || visitsTo(sites, "GitHub") > 0 || sites.contains { $0.host == "github.com" }, signed ? "local" : "history",
                    signed ? "Signed in to Engelbart" : !localRepos.isEmpty ? "\(localRepos.count) repositories on this Mac" : "In your browser history")
                continue
            }
            let found = detected?.apps[id]
            if tool.local && found?.found == true { set(id, true, "local", found!.where.isEmpty ? "Found on this Mac" : "Found on this Mac (\(found!.where))"); continue }
            if tool.local { set(id, false, "local", ""); continue }
            let visits = visitsTo(sites, id)
            if ConnectSources.signInCookies[id] != nil && (!sharedSignIn(id) || visits > 0) && cookies(id) { set(id, true, "cookie", "Signed in in \(browserName)"); continue }
            if visits >= 3 { set(id, true, "history", "\(JS.number(visits)) visits in \(browserName) lately"); continue }
            if appInstalled(id) { set(id, true, "app", "Its app is installed"); continue }
            if found?.found == true { set(id, true, "app", found!.where.isEmpty ? "Found on this Mac" : found!.where); continue }
            set(id, false, "none", visits > 0 ? "\(JS.number(visits)) visits lately" : "")
        }
        var out: [String: JSONValue] = ["evidence": .object(evidence), "sites": .array(sites.prefix(80).map { ["host": .string($0.host), "visits": .number($0.visits)] })]
        if blocked { out["history"] = "needs-disk-access" }
        return .object(out)
    }
}

/// discover.cjs createDiscovery: recent projects and the tools used, per data root, in `.connect/discovery.json`; every
/// change sent as `engelbart:discovery`.
@MainActor
public final class Discovery {
    public struct Deps {
        public var agents: ConnectAgents
        public var models: () -> JSONValue? = { nil }
        public var store: ConnectStore
        public var homeDir: String
        public var env: [String: String] = ProcessInfo.processInfo.environment
        public var providers: Providers
        public var webSignIn: WebSignIn?
        public var importer: CookieImporter?
        public var browser: AgentBrowsing?
        public var openBridge: (@escaping ToolBridge.Call, AbortSignal?) async throws -> BridgeHandle = { call, signal in try await ToolBridge.open(call, signal: signal, maxBody: 1_000_000) }
        public var zotero: ConnectZotero = .none
        public var github: ConnectGitHub = .none
        public var connectors: Connectors?
        public var notify: (JSONValue) -> Void = { _ in }
        public var trace: Trace?
        public var access: (String) -> FolderAccess.Guard? = { _ in nil }
        public var scanner: Scanner?
        public var prefs: OnboardingPrefs
        public var assistants: AssistantProjects?
        public var keychainWaitMs = 10 * 60_000.0
        public var keychainPollMs = 1000.0
        public var diskAccess: () -> Bool = { false }
        public var now: () -> String = { Time.iso() }
        public init(agents: ConnectAgents, store: ConnectStore, homeDir: String, providers: Providers, prefs: OnboardingPrefs) {
            self.agents = agents; self.store = store; self.homeDir = homeDir; self.providers = providers; self.prefs = prefs
        }
    }

    static let file = "discovery.json"
    static let signInTimeoutMs = 20_000.0
    public var deps: Deps
    var roots: [String: (projects: JSONValue, tools: JSONValue, projectsSignal: AbortSignal?, toolsSignal: AbortSignal?)] = [:]
    lazy var askers: AssistantProjects? = deps.assistants ?? (deps.webSignIn != nil && deps.browser != nil ? AssistantProjects(webSignIn: deps.webSignIn, browser: deps.browser, log: { [weak self] t, d in Task { @MainActor in self?.say(t, d) } }) : nil)

    public init(_ deps: Deps) { self.deps = deps }

    func say(_ text: String, _ detail: JSONValue? = nil) { deps.trace?.event(kind: "discovery", text: text, detail: detail) }
    func fileOf(_ dataRoot: String) -> URL { URL(fileURLWithPath: dataRoot).appendingPathComponent(".connect/\(Self.file)") }

    func stateOf(_ dataRoot: String) -> (projects: JSONValue, tools: JSONValue, projectsSignal: AbortSignal?, toolsSignal: AbortSignal?) {
        if let st = roots[dataRoot] { return st }
        let saved = Files.readJSON(fileOf(dataRoot)) ?? .object([:])
        let settle = { (part: JSONValue?) -> JSONValue in
            guard let part, part.object != nil else { return ["status": "idle"] }
            let s = part["status"]?.string
            if s == "running" || s == "checking" { var o = part.object!; o["status"] = "stale"; return .object(o) }
            return part
        }
        let st = (settle(saved["projects"]), settle(saved["tools"]), AbortSignal?.none, AbortSignal?.none)
        roots[dataRoot] = st
        return st
    }
    func publicOf(_ dataRoot: String) -> JSONValue { let st = stateOf(dataRoot); return ["projects": st.projects, "tools": st.tools] }

    func changed(_ dataRoot: String) {
        let st = stateOf(dataRoot)
        var tools = st.tools.object ?? [:]
        tools["sites"] = nil
        try? Files.writeAtomically(JSONValue.object(["projects": st.projects, "tools": .object(tools)]).text(pretty: true), to: fileOf(dataRoot), mode: 0o600)
        deps.notify(publicOf(dataRoot))
    }

    func provider(_ asked: String?) async -> (id: String?, connect: String?) {
        let out = await deps.providers.status(fresh: true)
        let ready = { (id: String) in (out["providers"]?.array ?? []).contains { $0["id"]?.string == id && $0["installed"] == .bool(true) && $0["signedIn"] == .bool(true) } }
        if let asked, ImportFlow.providerIds.contains(asked) { return ready(asked) ? (asked, nil) : (nil, asked) }
        return (out["decision"]?["pick"]?.string, nil)
    }

    func failure(_ error: Error, _ chosen: String, _ fallback: String) -> [String: JSONValue] {
        let text = String(((error as? ConnectError)?.message ?? (error.localizedDescription.isEmpty ? fallback : error.localizedDescription)).prefix(300))
        if !ProviderFailure.needsProvider(error) { return ["error": .string(text)] }
        Task { await deps.providers.recheck(chosen) }
        return ["error": .string(text), "connect": .string(chosen)]
    }

    public func state() async -> JSONValue { publicOf(await deps.store.dataRoot()) }

    static func projectsJSON(_ list: [ImportFlow.Project]) -> JSONValue { .array(list.map { ["id": .string($0.id), "title": .string($0.title), "description": .string($0.description), "recent": .string($0.recent), "folder": .string($0.folder), "evidence": .string($0.evidence)] }) }
    static func projectsOf(_ v: JSONValue?) -> [ImportFlow.Project] { (v?.array ?? []).map { ImportFlow.Project(id: JS.string($0["id"]), title: JS.string($0["title"]), description: JS.string($0["description"]), recent: JS.string($0["recent"]), folder: JS.string($0["folder"]), evidence: JS.string($0["evidence"])) } }

    /// Recent projects, found in the background (digest → CLI agent → the assistants).
    public func startProjects(provider asked: String? = nil, again: Bool = false) async -> JSONValue {
        let dataRoot = await deps.store.dataRoot()
        var st = stateOf(dataRoot)
        let pick = await provider(asked)
        guard let chosen = pick.id else {
            if st.projects["status"]?.string != "done" || again {
                st.projects = ["status": "waiting-provider", "projects": st.projects["projects"] ?? [], "connect": pick.connect.map { .string($0) } ?? .null]
                roots[dataRoot] = st; changed(dataRoot)
            }
            return publicOf(dataRoot)
        }
        let status = st.projects["status"]?.string
        if !again && (status == "running" || (status == "done" && st.projects["provider"]?.string == chosen)) { return publicOf(dataRoot) }
        st.projectsSignal?.abort()
        let signal = AbortSignal()
        let started = deps.now()
        st.projects = ["status": "running", "provider": .string(chosen), "projects": st.projects["projects"] ?? [], "route": "local", "started": .string(started)]
        st.projectsSignal = signal
        roots[dataRoot] = st
        changed(dataRoot)
        let finish = { [weak self] (next: [String: JSONValue]) in
            guard let self, !signal.isAborted, var cur = self.roots[dataRoot] else { return }
            var o: [String: JSONValue] = ["provider": .string(chosen), "started": .string(started)]
            for (k, v) in next { o[k] = v }
            o["ended"] = .string(self.deps.now())
            cur.projects = .object(o)
            if cur.projectsSignal === signal { cur.projectsSignal = nil }
            self.roots[dataRoot] = cur
            self.changed(dataRoot)
        }
        let failed = { [weak self] (fields: [String: JSONValue]) in
            var f = fields; f["status"] = "failed"; f["projects"] = self?.roots[dataRoot]?.projects["projects"] ?? []; finish(f)
        }
        Task { @MainActor in
            let existing = await deps.store.projectNames()
            let access = deps.access(dataRoot)
            let homeDir = deps.homeDir, env = deps.env
            let digest: JSONValue
            if let scanner = deps.scanner { digest = (try? await scanner.run("projectDigest") { Digest.projectDigest(homeDir: homeDir, env: env, access: access, existing: existing) }) ?? Digest.projectDigest(homeDir: homeDir, env: env, access: access, existing: existing) }
            else { digest = Digest.projectDigest(homeDir: homeDir, env: env, access: access, existing: existing) }
            if signal.isAborted { return }
            say("Looking for recent projects with \(ImportFlow.providerNames[chosen]!)", ["folders": .number(Double(digest["folders"]?.array?.count ?? 0)), "repos": .number(Double(digest["repos"]?.array?.count ?? 0))])
            var local: (outcome: String, projects: [ImportFlow.Project], failure: [String: JSONValue]) = ("none", [], [:])
            if !Digest.digestEmpty(digest) {
                let choice = ConnectModels.choice(chosen, models: deps.models())
                let message = ["<recent_work note=\"Read on this Mac without a model, the last \(JS.number(Digest.days)) days.\">\n\(digest.text(pretty: true))\n</recent_work>",
                               "Today is \(deps.now().prefix(10)).", "Name their recent projects now, as the JSON object only."].joined(separator: "\n\n")
                do {
                    let out = try await deps.agents.turn(AgentTurnInput(choice: choice, kind: "projects", system: Texts.onboardingProjectsSystemPrompt, message: message, signal: signal,
                                                                         meta: AgentMeta(kind: "projects", label: "Recent projects", info: ["digest": digest])))
                    if signal.isAborted { return }
                    let answer = AssistantProjects.readAnswer(out.text)
                    local = answer.kind == "projects" ? ("found", answer.projects, [:]) : answer.kind == "none" ? ("none", [], [:]) : ("broke", [], ["error": "The agent did not answer as asked."])
                } catch {
                    if signal.isAborted { return }
                    local = ("broke", [], failure(error, chosen, "The agent did not answer."))
                }
            }
            if local.outcome == "found" { finish(["status": "done", "projects": Self.projectsJSON(local.projects), "from": [.string(ImportFlow.providerNames[chosen]!)]]); return }
            let asked = await askAssistants(dataRoot, signal, chosen)
            if signal.isAborted { return }
            let found = asked.filter { $0["outcome"]?.string == "found" }
            if !found.isEmpty {
                finish(["status": "done", "projects": Self.projectsJSON(AssistantProjects.mergeProjects(found.map { Self.projectsOf($0["projects"]) }, existing: existing)), "from": .array(found.map { $0["app"] ?? "" })])
                return
            }
            if local.outcome == "broke" { failed(local.failure); return }
            if let broke = asked.first(where: { $0["outcome"]?.string == "broke" }) { failed(["error": .string(broke["error"]?.string ?? "\(JS.string(broke["app"])) did not answer")]); return }
            say("No recent projects: nothing on this Mac or in their assistants names one", ["asked": .array(asked.map { [$0["app"] ?? "", $0["outcome"] ?? ""] })])
            finish(["status": "done", "projects": [], "empty": true, "reason": "no-context", "asked": .array(asked.map { ["app": $0["app"] ?? "", "outcome": $0["outcome"] ?? ""] })])
        }
        return publicOf(dataRoot)
    }

    func keychainAnswer(_ dataRoot: String, _ signal: AbortSignal) async -> String? {
        let until = Time.ms() + deps.keychainWaitMs
        var answer = deps.prefs.get()["keychain"]?.string
        while answer == nil && Time.ms() < until && !signal.isAborted {
            try? await Task.sleep(nanoseconds: UInt64(deps.keychainPollMs * 1_000_000))
            answer = deps.prefs.get()["keychain"]?.string
        }
        return answer
    }

    func askAssistants(_ dataRoot: String, _ signal: AbortSignal, _ chosen: String) async -> [JSONValue] {
        guard let askers else { return [] }
        if deps.prefs.get()["keychain"] == nil, var st = roots[dataRoot] {
            var p = st.projects.object ?? [:]; p["route"] = "assistants"; p["waiting"] = "keychain"; st.projects = .object(p); roots[dataRoot] = st; changed(dataRoot)
        }
        let answer = await keychainAnswer(dataRoot, signal)
        if signal.isAborted { return [] }
        if answer != "allowed" {
            say("Not asking ChatGPT or Claude about projects: \(answer == "declined" ? "the person kept their browser's sign-ins to their browser" : "the browser question was not answered")")
            return []
        }
        let apps = chosen == "openai" ? ["ChatGPT", "Claude"] : ["Claude", "ChatGPT"]
        if var st = roots[dataRoot] {
            var p = st.projects.object ?? [:]; p["route"] = "assistants"; p["asking"] = .array(apps.map { .string($0) }); p["waiting"] = nil; st.projects = .object(p); roots[dataRoot] = st; changed(dataRoot)
        }
        say("Asking \(apps.joined(separator: " and ")) about recent projects")
        return await askers.ask(apps: apps, question: Prompts.assistantProjectsPrompt(deps.now()), signal: signal)
    }

    static func toolsJSON(_ r: (tools: [ImportFlow.ToolAnswer], additional: [ImportFlow.ExtraTool])) -> JSONValue {
        ["tools": .array(r.tools.map { ["id": .string($0.id), "used": .bool($0.used), "evidence": .string($0.evidence), "method": .string($0.method)] }),
         "additional": .array(r.additional.map { ["name": .string($0.name), "website": .string($0.website), "used": .bool($0.used), "evidence": .string($0.evidence), "category": .string($0.category)] })]
    }

    /// Which tools the person uses: the evidence first, then (keychain allowed) the sign-ins copied, then the agent.
    public func startTools(provider asked: String? = nil, browserId: String? = nil, keychain: String? = nil, again: Bool = false) async -> JSONValue {
        let dataRoot = await deps.store.dataRoot()
        var st = stateOf(dataRoot)
        let pick = await provider(asked)
        guard let chosen = pick.id else {
            if st.tools["status"]?.string != "done" || again {
                st.tools = ["status": "waiting-provider", "results": st.tools["results"] ?? .null, "evidence": st.tools["evidence"] ?? .null, "connect": pick.connect.map { .string($0) } ?? .null]
                roots[dataRoot] = st; changed(dataRoot)
            }
            return publicOf(dataRoot)
        }
        let status = st.tools["status"]?.string
        if !again && (status == "checking" || (status == "done" && st.tools["connect"] == nil && st.tools["provider"]?.string == chosen && st.tools["browser"]?.string == browserId)) { return publicOf(dataRoot) }
        st.toolsSignal?.abort()
        let signal = AbortSignal()
        st.tools = ["status": "checking", "provider": .string(chosen), "browser": browserId.map { .string($0) } ?? .null, "results": .null, "started": .string(deps.now())]
        st.toolsSignal = signal
        roots[dataRoot] = st
        changed(dataRoot)
        let update = { [weak self] (patch: [String: JSONValue]) in
            guard let self, var cur = self.roots[dataRoot] else { return }
            var t = cur.tools.object ?? [:]; for (k, v) in patch { t[k] = v }; cur.tools = .object(t); self.roots[dataRoot] = cur
        }
        Task { @MainActor in
            let importer = deps.importer
            let holds = { (app: String) -> Bool in
                guard let importer, let browserId, let entry = ConnectSources.signInCookies[app], let source = importer.sources().first(where: { $0.id == browserId }) else { return false }
                return source.profiles.contains { p in ((try? importer.cookieNames(browser: source.id, profile: p.id, domains: [entry.domain])) ?? []).contains { $0.domain == entry.domain && entry.matches($0.name) } }
            }
            let homeDir = deps.homeDir, env = deps.env, access = deps.access(dataRoot)
            let zs = deps.zotero.status(), gs = deps.github.status()
            let connectors = deps.connectors
            var connected: [String: Bool] = [:]
            for app in Connectors.order { connected[app] = (try? connectors?.status(app).connected) == true }
            let detect = { Scan.detect(homeDir: homeDir, env: env, zotero: zs, github: gs, connectors: { connected[$0] ?? false }, access: access) }
            let detected = deps.scanner != nil ? (try? await deps.scanner!.run("detect", detect)) : detect()
            if signal.isAborted { return }
            let disk = deps.diskAccess
            let ev = ToolEvidence.evidence(homeDir: homeDir, browserId: browserId, detected: detected, github: gs, cookies: holds, diskAccess: disk)
            if signal.isAborted { return }
            var known: [String: ImportFlow.ToolFact] = [:]
            for (id, fact) in ev["evidence"]?.object ?? [:] { known[id] = ImportFlow.ToolFact(used: fact["used"] == .bool(true), evidence: JS.string(fact["evidence"]), method: JS.string(fact["method"])) }
            var patch: [String: JSONValue] = ["results": Self.toolsJSON(ImportFlow.readTools("", known: known)), "evidence": ev["evidence"] ?? .null]
            if let h = ev["history"] { patch["history"] = h }
            update(patch)
            changed(dataRoot)
            say("Tools found without a model: \(known.filter { $0.value.used }.keys.sorted().map(ConnectSources.shownName).joined(separator: ", ").nilIfEmpty ?? "none")", ev["evidence"])
            var signedIn: [String] = []
            if keychain == "allowed", let web = deps.webSignIn {
                for app in known.filter({ $0.value.method == "cookie" }).keys.sorted() {
                    if signal.isAborted { return }
                    let q = await withTaskGroup(of: WebSignIn.Quiet?.self) { g -> WebSignIn.Quiet? in
                        g.addTask { await web.signInQuiet(app) }
                        g.addTask { try? await Task.sleep(nanoseconds: UInt64(Self.signInTimeoutMs * 1_000_000)); return nil }
                        let first = await g.next() ?? nil; g.cancelAll(); return first
                    }
                    if q?.signedIn == true { signedIn.append(app) }
                }
                if !signedIn.isEmpty { say("Signed in to \(signedIn.map(ConnectSources.shownName).joined(separator: ", ")) in Engelbart's browser") }
            }
            let choice = ConnectModels.choice(chosen, models: deps.models())
            let catalog: JSONValue = .array(ImportFlow.catalog.map { ["id": .string($0.id), "name": .string($0.name), "sites": .array((ConnectSources.apps[$0.id]?.sites ?? []).map { .string($0) })] })
            let browserName = ImportFlow.browserById(browserId)?.name ?? "none"
            let message = ["<catalog note=\"The tools Engelbart can import from. Answer for every id.\">\n\(catalog.text())\n</catalog>",
                           "<evidence note=\"Found without a model. method local: read on this Mac (it stands); cookie: signed in in their browser; history: visits lately; app: its desktop app is installed.\">\n\((ev["evidence"] ?? .null).text(pretty: true))\n</evidence>",
                           "<browser>\(browserName)\(signedIn.isEmpty ? "" : "; signed in to \(signedIn.joined(separator: ", ")) in Engelbart's browser, which browser_open uses")</browser>",
                           "<top_sites note=\"Their most visited sites lately, for tools not in the catalog.\">\n\(JSONValue.array(Array((ev["sites"]?.array ?? []).prefix(80))).text())\n</top_sites>",
                           "<categories note=\"Every tool in additional goes in one of these, by id; other when none fits.\">\n\(JSONValue.array(ImportFlow.groups.map { ["id": .string($0.id), "label": .string($0.label)] }).text())\n</categories>",
                           "Say which tools they use now, as the JSON object only."].joined(separator: "\n\n")
            let job = AgentJob(id: "discover-\(Int(Time.ms()))", label: "Checking your tools", sites: Array(Set(signedIn.flatMap { ConnectSources.apps[$0]?.sites ?? [] })).sorted())
            let page = signedIn.isEmpty ? nil : deps.browser?.tools(job)
            var bridge: BridgeHandle?
            do {
                let session = ToolSession(dataRoot: dataRoot, homeDir: homeDir, dir: (dataRoot as NSString).appendingPathComponent(".connect/discovery"), downloads: (dataRoot as NSString).appendingPathComponent("imports/discovery"),
                                          readable: access.map { a in { a.readable($0) } }, days: { ToolEvidence.historyDays })
                let tools = ImportTools(session: session, store: deps.store, kind: "discover", page: page, zotero: deps.zotero, github: deps.github, env: env)
                bridge = try await deps.openBridge({ name, args in try await tools.call(name, args) }, signal)
                let out = try await deps.agents.turn(AgentTurnInput(choice: choice, kind: bridge != nil ? "discover" : "projects", system: Texts.onboardingToolsSystemPrompt, message: message, signal: signal,
                                                                    bridge: bridge?.connection, meta: AgentMeta(kind: "discover", label: job.label, jobId: job.id, jobLabel: job.label,
                                                                                                                callTool: { name, args in let v = try await tools.call(name, args); return (v as? JSONValue) ?? .null }, info: ["evidence": ev["evidence"] ?? .null])))
                if signal.isAborted { bridge?.close(); return }
                update(["status": "done", "results": Self.toolsJSON(ImportFlow.readTools(out.text, known: known)), "signedIn": .array(signedIn.map { .string($0) }), "ended": .string(deps.now())])
            } catch {
                if signal.isAborted { bridge?.close(); return }
                var p: [String: JSONValue] = ["status": "done", "results": Self.toolsJSON(ImportFlow.readTools("", known: known)), "signedIn": .array(signedIn.map { .string($0) }), "ended": .string(deps.now())]
                for (k, v) in failure(error, chosen, "The agent did not finish") { p[k] = v }
                update(p)
            }
            bridge?.close()
            if page != nil { deps.browser?.close(job.id) }
            if var cur = roots[dataRoot], cur.toolsSignal === signal { cur.toolsSignal = nil; roots[dataRoot] = cur }
            changed(dataRoot)
        }
        return publicOf(dataRoot)
    }

    public func stop() async -> JSONValue {
        let dataRoot = await deps.store.dataRoot()
        if var st = roots[dataRoot] { st.projectsSignal?.abort(); st.toolsSignal?.abort(); st.projectsSignal = nil; st.toolsSignal = nil; roots[dataRoot] = st }
        return publicOf(dataRoot)
    }

    public func reset() async -> JSONValue {
        let dataRoot = await deps.store.dataRoot()
        _ = await stop()
        roots[dataRoot] = (["status": "idle"], ["status": "idle"], nil, nil)
        changed(dataRoot)
        return publicOf(dataRoot)
    }

    public func forget(_ dataRoot: String) {
        if let st = roots[dataRoot] { st.projectsSignal?.abort(); st.toolsSignal?.abort() }
        roots[dataRoot] = nil
    }
}
