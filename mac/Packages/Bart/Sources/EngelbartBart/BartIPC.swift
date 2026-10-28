import Foundation
import EngelbartDoc
import EngelbartCore

// ipc.cjs, @bart's handlers — what a window asks of @bart, its values checked as Electron's IPC checked them (the type
// checks themselves are Electron mechanics; what a check refuses or cuts is kept). The app's window code calls these with
// the payload the renderer sent (JSON) and posts what they announce on EventHub.

public struct IPCError: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ m: String) { message = m }
    public var errorDescription: String? { message }
}

public enum AskInput {
    static let maxName = 200
    static func str(_ v: JSONValue?, _ what: String, _ max: Int = maxName) throws -> String {
        guard let s = v?.string, s.jsLength <= max else { throw IPCError("\(what) must be a string of at most \(max) characters") }
        return s
    }
    static func optStr(_ v: JSONValue?, _ what: String, _ max: Int = maxName) throws -> String? { v == nil || v!.isNull ? nil : try str(v, what, max) }
    /// A string cut to its first `max` characters instead of refused for its length.
    static func cutStr(_ v: JSONValue?, _ what: String, _ max: Int) throws -> String? {
        guard let v, !v.isNull else { return nil }
        guard let s = v.string else { throw IPCError("\(what) must be a string") }
        return s.jsLength > max ? s.jsSlice(0, max) : s
    }
    static func tailStr(_ v: JSONValue?, _ what: String, _ max: Int) throws -> String? {
        guard let v, !v.isNull else { return nil }
        guard let s = v.string else { throw IPCError("\(what) must be a string") }
        return s.jsLength > max ? s.jsSlice(s.jsLength - max) : s
    }
    static func clipped(_ v: JSONValue?, _ what: String, _ max: Int) throws -> String {
        guard let s = v?.string else { throw IPCError("\(what) must be a string") }
        return Clip.clipMiddle(s, max)
    }
    static let wordRE = JSRegex("^[A-Za-z0-9_-]+$")
    static let uuidRE = JSRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")

    /// ipc.cjs docRef.
    public static func docRef(_ value: JSONValue?) throws -> DocRef {
        guard let v = value, v.object != nil else { throw IPCError("doc ref must be an object") }
        switch v["kind"]?.string {
        case "note": return DocRef(kind: "note", id: try str(v["id"], "note id", 64))
        case "workspace": return DocRef(kind: "workspace", workspaceId: try str(v["workspaceId"], "workspace id", 64))
        case "project": return DocRef(kind: "project")
        case "mark":
            let id = try str(v["id"], "mark id", 64)
            guard wordRE.test(id) else { throw IPCError("mark id is invalid") }
            let web = v["source"]?.string == "web"
            if let s = v["source"], !s.isNull, !web { throw IPCError("a highlight is on a pdf or on a web page (source \"web\")") }
            let page = v["page"]?.double
            if web { if let p = v["page"], !p.isNull { throw IPCError("a highlight on a web page has no page") } }
            else if page == nil || page! != page!.rounded() || page! < 1 || page! > 100000 { throw IPCError("page must be a page number") }
            let rowId = try optStr(v["rowId"], "library id", 64), url = try optStr(v["url"], "address", 8192)
            if (rowId == nil) == (url == nil) { throw IPCError("a highlight is on a library item (rowId) or on an address (url): one of the two") }
            return DocRef(kind: "mark", id: id, rowId: rowId, url: rowId == nil ? url : nil, page: web ? nil : Int(page!), source: web ? "web" : nil)
        default: throw IPCError("doc ref must be a note, a workspace, the project page or a highlight")
        }
    }

    static func refJSON(_ r: DocRef) -> OJ {
        var o: [(String, OJ)] = [("kind", .string(r.kind))]
        if let id = r.id { o.append(("id", .string(id))) }
        if let w = r.workspaceId { o.append(("workspaceId", .string(w))) }
        if let x = r.rowId { o.append(("rowId", .string(x))) }
        if let u = r.url { o.append(("url", .string(u))) }
        if let s = r.source { o.append(("source", .string(s))) } else if let p = r.page { o.append(("page", .number(Double(p)))) }
        return .object(o)
    }

    /// Where it was asked (the Agent Viewer): { projectId, ref, line, text }.
    public static func placeOf(_ value: JSONValue?, projectId: String, ref: DocRef?) -> OJ {
        let line = value?["line"]?.double.flatMap { $0 == $0.rounded() && $0 >= 0 && $0 < 1e7 ? OJ.number($0) : nil } ?? .null
        let text = value?["text"]?.string.map { OJ.string($0.jsSlice(0, 8000)) } ?? .null
        return ["projectId": .string(projectId), "ref": ref.map(refJSON) ?? .null, "line": line, "text": text]
    }

    /// What a question asked from a highlight carries besides its ref.
    public static func highlight(_ value: JSONValue?) throws -> HighlightInput {
        let input = value?.object != nil ? value! : .object([:])
        let quote: JSONValue? = input["quote"]?.object != nil ? input["quote"]?["exact"] : input["quote"]
        return HighlightInput(quote: try clipped(quote == nil || quote!.isNull ? "" : quote, "quote", 20000),
                              note: try str(input["note"] == nil || input["note"]!.isNull ? "" : input["note"], "note", 20000),
                              paper: try optStr(input["paper"], "paper name"),
                              pageText: try clipped(input["pageText"] == nil || input["pageText"]!.isNull ? "" : input["pageText"], "page text", 8000))
    }

    /// What is in front in the Stage: a pdf { rowId | url, page } or a web page { url, title, tab }; anything else nil.
    public static func stage(_ value: JSONValue?) throws -> StageInput? {
        guard let v = value, !v.isNull else { return nil }
        guard v.object != nil else { throw IPCError("stage must be an object") }
        let kind = try str(v["kind"] == nil || v["kind"]!.isNull ? "" : v["kind"], "stage kind", 24)
        if kind == "web" {
            let url = try str(v["url"], "address", 4096).jsTrim
            let title = try clipped(v["title"] == nil || v["title"]!.isNull ? "" : v["title"], "page title", 300).squashedSpaces
            let tab = try optStr(v["tab"], "tab id", 128)
            if let tab, !JSRegex("^[A-Za-z0-9_.-]+$").test(tab) { throw IPCError("tab id is invalid") }
            return url.isEmpty ? nil : StageInput(kind: kind, url: url, title: title, tab: tab)
        }
        guard kind == "pdf" else { return nil }
        let rowId = try optStr(v["rowId"], "library id", 64)
        if let rowId, !uuidRE.test(rowId) { throw IPCError("library id is invalid") }
        let url = try optStr(v["url"], "address", 4096)
        guard let p = v["page"]?.double, p == p.rounded(), p >= 1, p <= 100000 else { throw IPCError("page must be a page number") }
        return rowId != nil || url != nil ? StageInput(kind: kind, rowId: rowId, url: url, page: Int(p)) : nil
    }

    /// The earlier turns of an exchange, the last 40, each cut in the middle past what a turn may hold.
    public static func turns(_ value: JSONValue?) throws -> [AskTurn] {
        try (value?.array ?? []).suffix(40).map { t in
            AskTurn(question: try clipped(t["question"], "earlier question", 8000), answer: try clipped(t["answer"], "earlier answer", 40000),
                 agent: t["agent"]?.string.flatMap { AskPlan.agents.contains($0) ? $0 : nil })
        }
    }

    static let routePicks = RouteModel.picks

    /// An ask's `routed`, or nil for a line Bart did not hand over.
    public static func routed(_ value: JSONValue?) throws -> Routed? {
        guard let v = value, v.object != nil else { return nil }
        let id = try optStr(v["id"], "route id", 80)
        let corrected = v["corrected"] == nil || v["corrected"]!.isNull ? nil : try str(v["corrected"], "corrected agent", 20)
        if let corrected, !routePicks.contains(corrected) { throw IPCError("corrected must be chat, brainstorm, discover, create or build") }
        var failed: String? = nil
        if v["by"]?.string == "error" { failed = try cutStr(v["error"], "route error", 400) ?? "" }
        let build: Bool = { switch v["build"] { case .bool(let b)?: return b; case .number(let n)?: return n != 0; case .string(let s)?: return !s.isEmpty; case .array?, .object?: return true; default: return false } }()
        return Routed(id: id, build: build, corrected: corrected, failed: failed)
    }

    /// The whole ask-bart payload → the request (live and overleaf are the window's, added by the caller).
    public static func request(_ pid: JSONValue?, _ input: JSONValue?) throws -> (projectId: String, request: AskRequest) {
        let value = input?.object != nil ? input! : .object([:])
        let askId = try str(value["askId"], "ask id", 64)
        guard wordRE.test(askId) else { throw IPCError("ask id is invalid") }
        let turns = try turns(value["turns"])
        var choice: (model: String, effort: String)? = nil
        if value["choice"]?.object != nil {
            let c = (try str(value["choice"]?["model"], "model", 24), try str(value["choice"]?["effort"], "effort", 24))
            guard JSRegex("^[a-z][a-z0-9]*$").test(c.0 + c.1) else { throw IPCError("choice is invalid") }
            choice = c
        }
        let agent = value["agent"] == nil || value["agent"]!.isNull ? "bart" : (value["agent"]?.string ?? "")
        guard AskPlan.agents.contains(agent) else { throw IPCError("agent must be bart, brainstorm, discover or create") }
        let ref = try docRef(value["ref"])
        if ref.kind == "mark" && agent != "bart" { throw IPCError("a highlight asks @bart") }
        let projectId = try str(pid, "project id", 64)
        let stage = agent == "bart" ? try stage(value["stage"]) : nil
        let routed = try routed(value["routed"])
        var steer: Steer? = nil
        if agent == "discover", let s = value["steer"], s.object != nil {
            let st = Steer(after: try str(s["after"], "search id", 64), words: try str(s["words"]?.string.map { JSONValue.string($0) } ?? "", "reply", 4000).jsTrim, level: s["level"] == .bool(true))
            if !wordRE.test(st.after) || (st.words.isEmpty && !st.level) { throw IPCError("steer is invalid") }
            steer = st
        }
        let workspaceId = try str(value["workspaceId"], "workspace id", 64)
        let text = try str(value["text"], "question", 8000)
        return (projectId, AskRequest(askId: askId, ref: ref, workspaceId: workspaceId, text: text, turns: turns, choice: choice, agent: agent,
                                      highlight: ref.kind == "mark" ? try highlight(value["highlight"]) : nil, stage: stage, routed: routed,
                                      place: placeOf(value["place"], projectId: projectId, ref: ref), steer: steer))
    }

    /// route-line's payload → the router's request. Nothing is refused for its length (2026-10-12): a thread's question
    /// is cut to 400, its agent to 20, the line to 8,000, the workspace's name to 400 and the section to its last 200,000.
    public static func routeRequest(_ pid: JSONValue?, _ input: JSONValue?) throws -> RouteRequest {
        let value = input?.object != nil ? input! : .object([:])
        let threads = try (value["threads"]?.array ?? []).suffix(5).map { t -> RouteThread in
            let up = t["up"]?.double ?? Double(t["up"]?.string ?? "") ?? 0
            return RouteThread(agent: (try cutStr(t["agent"], "thread agent", 20)).flatMap { $0.isEmpty ? nil : $0 } ?? "chat",
                               question: try cutStr(t["question"], "thread question", 400) ?? "", up: Int(max(0, min(1e6, (up.isFinite ? up : 0).rounded(.down)))))
        }
        var rule: (agent: String, rule: String?)? = nil
        if let r = value["rule"], r.object != nil, let a = r["agent"]?.string, RouteModel.picks.contains(a) { rule = (a, try cutStr(r["rule"], "rule", 40).flatMap { $0.isEmpty ? nil : $0 }) }
        let projectId = try str(pid, "project id", 64)
        let ref = (try? docRef(value["ref"])) ?? nil
        guard let line = value["text"]?.string else { throw IPCError("line must be a string of at most Infinity characters") }
        let specAbove = value["specAbove"]?.bool ?? (value["specAbove"].map { !$0.isNull && $0 != .number(0) && $0 != .string("") } ?? false)
        let current = value["current"]?.string.flatMap { ["chat", "brainstorm", "discover"].contains($0) ? $0 : nil }
        return RouteRequest(projectId: projectId, text: line.jsSlice(0, 8000), section: try tailStr(value["section"], "section", 200000) ?? "",
                            workspaceName: try cutStr(value["workspaceName"], "workspace name", 400) ?? "", threads: threads, specAbove: specAbove,
                            specTitle: specAbove ? (try cutStr(value["specTitle"], "spec title", 400) ?? "") : "", current: current, rule: rule,
                            place: placeOf(value["place"], projectId: projectId, ref: ref))
    }
}

/// The handlers themselves (ipc.cjs): each takes what the window sent and answers what the renderer got.
public final class BartIPC: @unchecked Sendable {
    public let bart: Bart
    public let store: BartStore
    /// The models in force for 'bart' (index.cjs bartModels), and the data root they are kept in (homeRoot()).
    public let readModels: @Sendable () -> ModelsList
    public let home: @Sendable () -> URL
    public let only: @Sendable () -> [String]?
    public let tools: BartToolStatus?
    public let namer: ChatNamer?
    public let hub: EventHub

    /// The questions from highlights still running, as their window's box shows them (running-paper-asks).
    struct PaperAsk { var window: String; var projectId: String; var askId: String; var markId: String; var page: Int?; var rowId: String?; var url: String?; var source: String?; var question: String; var progress: [String: JSONValue] }
    private var paperAsks: [String: PaperAsk] = [:]
    private let lock = NSLock()

    public init(bart: Bart, store: BartStore, readModels: @escaping @Sendable () -> ModelsList, home: @escaping @Sendable () -> URL, only: @escaping @Sendable () -> [String]? = { nil },
                tools: BartToolStatus? = nil, namer: ChatNamer? = nil, hub: EventHub = .shared) {
        self.bart = bart; self.store = store; self.readModels = readModels; self.home = home; self.only = only; self.tools = tools; self.namer = namer; self.hub = hub
    }

    /// What the window's box shows, kept as the window keeps it (Workspace onBartProgress): a new step starts over.
    func paperProgress(_ askId: String, _ p: BartProgress) {
        lock.lock(); defer { lock.unlock() }
        guard var held = paperAsks[askId] else { return }
        var payload = p.json.object ?? [:]
        let logged = payload.removeValue(forKey: "log")?.bool == true
        for (k, v) in payload { held.progress[k] = v }
        if payload["step"] != nil { held.progress["activity"] = ""; held.progress["lines"] = .array([]) }
        if logged, let a = payload["activity"] { held.progress["log"] = .array(((held.progress["log"]?.array ?? []) + [a]).suffix(60)) }
        paperAsks[askId] = held
    }

    func paperDone(_ payload: OJ) {
        lock.withLock { _ = paperAsks.removeValue(forKey: payload["askId"]?.string ?? "") }
        hub.post(BartEvents.paperAskDone, payload.jsonValue)
    }

    /// ask-bart: the answer as draft lines for the document. A run that fails answers too (failureLines), so the question
    /// line never stays locked behind a pending line; only Stop returns nothing to place ({ stopped: true }). Progress goes
    /// to the window that asked (`onProgress`, and `engelbart:bart-progress` on the hub with `window`).
    public func askBart(window: String, pid: JSONValue?, input: JSONValue?, live: LivePage? = nil, overleaf: OverleafTabs? = nil,
                        onProgress: @escaping @Sendable (JSONValue) -> Void = { _ in }) async throws -> OJ {
        var (projectId, q) = try AskInput.request(pid, input)
        if q.stage?.kind == "web", q.stage?.tab != nil { q.live = live }
        if q.agent == "bart" { q.overleaf = overleaf }
        var started = false
        var mark: PaperAsk? = nil
        do {
            if q.ref.kind == "mark" {
                let web = q.ref.source == "web"
                let m = PaperAsk(window: window, projectId: projectId, askId: q.askId, markId: q.ref.id ?? "", page: web ? nil : q.ref.page, rowId: q.ref.rowId,
                                 url: q.ref.rowId != nil ? nil : q.ref.url, source: web ? "web" : nil, question: q.text.jsTrim, progress: [:])
                mark = m
                lock.withLock { paperAsks[q.askId] = m }
            }
            // a box (MATH-70 build 2): the picture it has now is the one this answer is about
            var crop: String? = nil
            if let m = mark, m.source == "web", let held = await store.readWebMark(rowId: m.rowId, url: m.rowId == nil ? m.url : nil, markId: m.markId),
               held["box"] != nil, let c = held["crop"]?.string { crop = c }
            // The ask is an agent of its workspace: running now, waiting for you once its answer (or failure) has landed.
            store.agentStarted(id: q.askId, kind: q.agent, projectId: projectId, workspaceId: q.workspaceId, doc: q.ref); started = true
            let askId = q.askId
            let out = try await bart.ask(store: store, projectId: projectId, q) { [self] p in
                paperProgress(askId, p)
                let payload = p.payload(askId: askId)
                onProgress(payload)
                hub.post(BartEvents.progress, payload)
            }
            if started { store.agentFinished(id: q.askId) }
            var answer = answerJSON(out)
            guard let m = mark else { return answer }
            let level = out.meta.level
            let entry = OJ(MarkAnswers.askEntry(id: q.askId, question: q.text, lines: out.lines, provider: out.meta.provider.nonEmpty, name: level.name.nonEmpty,
                                                effort: level.effort.nonEmpty, ms: out.meta.ms == 0 ? nil : out.meta.ms, at: Time.iso(), crop: crop))
            try? await store.addMarkAnswer(rowId: m.rowId, url: m.url, page: m.page, markId: m.markId, entry: entry.jsonValue)
            paperDone(markPayload(m, [("entry", entry)]))
            answer = answer.setting("entry", entry)
            return answer
        } catch {
            let stopped = (error as? BartError)?.kind == "stopped"
            if started { stopped ? store.agentStopped(id: q.askId) : store.agentFinished(id: q.askId) }
            let out: OJ = stopped ? ["stopped": true] : ["failed": true, "lines": .array(Reply.failureLines((error as? BartError)?.message ?? (error as? LocalizedError)?.errorDescription ?? "\(error)").map { .string($0) })]
            if let m = mark { paperDone(markPayload(m, out.pairs ?? [])) }
            return out
        }
    }

    func markPayload(_ m: PaperAsk, _ extra: [(String, OJ)]) -> OJ {
        var o: [(String, OJ)] = [("askId", .string(m.askId)), ("markId", .string(m.markId)), ("page", m.page.map { .number(Double($0)) } ?? .null),
                                 ("rowId", m.rowId.map { .string($0) } ?? .null), ("url", m.url.map { .string($0) } ?? .null)]
        if let s = m.source { o.append(("source", .string(s))) }
        return .object(o + extra)
    }

    public func answerJSON(_ a: AskAnswer) -> OJ {
        var meta: [(String, OJ)] = [("provider", .string(a.meta.provider)), ("level", ["name": .string(a.meta.level.name), "effort": .string(a.meta.level.effort), "model": .string(a.meta.level.model)]),
                                    ("trail", .array(a.meta.trail.map { ["name": .string($0.name), "effort": .string($0.effort), "why": .string($0.why)] })), ("ms", .number(a.meta.ms)), ("pinned", .bool(a.meta.pinned))]
        if let r = a.meta.routed {
            var ro: [(String, OJ)] = [("id", r.id.map { .string($0) } ?? .null), ("build", .bool(r.build)), ("corrected", r.corrected.map { .string($0) } ?? .null)]
            if let f = r.failed { ro.append(("failed", f.isEmpty ? true : .string(f))) }
            meta.append(("routed", .object(ro)))
        }
        if let c = a.meta.created { meta.append(("created", .array(c.map { ["name": .string($0.name), "type": .string($0.type), "path": .string($0.path)] }))) }
        var o: [(String, OJ)] = [("lines", .array(a.lines.map { .string($0) })), ("meta", .object(meta))]
        if let t = a.topic { o.append(("topic", .string(t))) }
        if let r = a.research { o.append(("research", .string(r))) }
        if let w = a.welcome { o.append(("welcome", .string(w))) }
        return .object(o)
    }

    /// running-paper-asks: the questions from highlights a window asked in this project that are still running.
    public func runningPaperAsks(window: String?, pid: JSONValue?) throws -> [OJ] {
        let projectId = try AskInput.str(pid, "project id", 64)
        return lock.withLock { paperAsks.values.filter { $0.projectId == projectId && (window == nil || $0.window == window) } }.map { held in
            var o: [(String, OJ)] = held.progress.keys.sorted().map { ($0, OJ(held.progress[$0]!)) }
            func put(_ k: String, _ v: OJ) { o.removeAll { $0.0 == k }; o.append((k, v)) }
            put("askId", .string(held.askId)); put("markId", .string(held.markId)); put("page", held.page.map { .number(Double($0)) } ?? .null)
            put("rowId", held.rowId.map { .string($0) } ?? .null); put("url", held.url.map { .string($0) } ?? .null)
            if let s = held.source { put("source", .string(s)) }
            put("question", .string(held.question)); put("agent", "bart")
            return .object(o)
        }
    }

    /// route-line.
    public func routeLine(pid: JSONValue?, input: JSONValue?) async throws -> OJ { (await bart.route(try AskInput.routeRequest(pid, input))).json }
    /// route-handed: where a routed line went when it was not an ask (`build:<id>`).
    public func routeHanded(_ id: JSONValue?, _ to: JSONValue?) throws -> Bool { bart.routeHanded(try AskInput.str(id, "route id", 80), to: try AskInput.str(to, "handed to", 80)); return true }
    /// stop-bart.
    public func stopBart(_ askId: JSONValue?) throws -> Bool { bart.stop(try AskInput.str(askId, "ask id", 64)) }

    /// name-chat: a new thread's title, asked while its question runs; the fallback answers when no model can.
    public func nameChat(_ input: JSONValue?) async throws -> OJ {
        let value = input?.object != nil ? input! : .object([:])
        let text = try AskInput.str(value["text"], "question", 8000)
        let agent = value["agent"] == nil || value["agent"]!.isNull ? "bart" : (value["agent"]?.string ?? "")
        guard AskPlan.agents.contains(agent) else { throw IPCError("agent must be bart, brainstorm, discover or create") }
        let models = readModels()
        let provider = NameChat.providerOf(text, agent: agent, models)
        if let namer { return await namer(text: text, provider: provider).json }
        let step = NameChat.namingStep(models, provider)
        return NamedChat(title: NameChat.fallbackTitle(text), provider: step.provider, model: step.model, modelName: step.name, effort: step.effort, ms: 0, named: false).json
    }

    /// bart-models: what the @bart line's selector offers and its flags are checked against; names and keys only.
    public func bartModels() -> OJ {
        let m = readModels(), full = m.json
        // { provider, providers (name, models, efforts, ladder, start?), discover: { providers: levels for the providers offered } }
        let shown = OJ.object(m.providers.pairs.map { (k, e) in
            var o: [(String, OJ)] = [("name", .string(e.name)), ("models", .object(e.models.pairs.map { ($0.0, ["id": .string($0.1.id), "name": .string($0.1.name), "use": .string($0.1.use)]) })),
                                     ("efforts", .array(e.efforts.map { .string($0) })), ("ladder", .array(e.ladder.map { ["model": .string($0.model), "effort": .string($0.effort)] }))]
            if let s = e.start { o.append(("start", ["model": .string(s.model), "effort": .string(s.effort)])) }
            return (k, .object(o))
        })
        let levels = full["discover"]?["providers"]
        let discover = OJ.object(m.providers.keys.compactMap { k in levels?[k].map { (k, $0) } })
        return ["provider": .string(m.provider), "providers": shown, "discover": ["providers": discover]]
    }

    /// remember-model-choice: the pick just made in a Build panel ('build') or a post-it's Build ('quick').
    public func rememberModelChoice(_ place: JSONValue?, _ choice: JSONValue?) throws -> OJ {
        guard let p = place?.string, p == "build" || p == "quick" else { throw IPCError("place must be build or quick") }
        let value = choice?.object != nil ? choice! : .object([:])
        let c = Choice(provider: try AskInput.str(value["provider"], "provider", 24), model: try AskInput.str(value["model"], "model", 24), effort: try AskInput.str(value["effort"], "effort", 24))
        guard let kept = Choices.remember(home: home(), place: p, c) else { return .null }
        return ["provider": .string(kept.provider), "model": .string(kept.model), "effort": .string(kept.effort)]
    }

    /// settings-models, save-settings-models and clear-model-choice; the last two announce `engelbart:models-changed`.
    public func settingsModels() -> OJ { ModelSettings.read(home: home(), only: only(), tools: tools).json }
    public func saveSettingsModels(_ patch: JSONValue?) throws -> OJ {
        let out = try ModelSettings.save(home: home(), patch: patch.map(OJ.init) ?? .null, only: only(), tools: tools)
        hub.post(BartEvents.modelsChanged, .object([:]))
        return out.json
    }
    public func clearModelChoice(_ place: JSONValue?) throws -> OJ {
        let out = try ModelSettings.forget(home: home(), place: try AskInput.str(place, "place", 24), only: only(), tools: tools)
        hub.post(BartEvents.modelsChanged, .object([:]))
        return out.json
    }

    /// created-file / created-save: a file @create made, read for its row and saved into the library.
    public func createdFile(pid: JSONValue?, askId: JSONValue?, rel: JSONValue?, library: CreatedLibrary, snapshot: ((String, String) async throws -> Data)? = nil) async throws -> OJ {
        let (projectId, id, file) = try createdArgs(pid, askId, rel)
        return try await Create.readCreated(projectDir: try store.findProject(projectId: projectId).dir, askId: id, rel: file, library: library, snapshot: snapshot)
    }
    public func createdSave(pid: JSONValue?, askId: JSONValue?, rel: JSONValue?, workspaceId: JSONValue?, library: CreatedLibrary) async throws -> LibraryRow {
        let (projectId, id, file) = try createdArgs(pid, askId, rel)
        let ws = workspaceId == nil || workspaceId!.isNull ? nil : try AskInput.str(workspaceId, "workspace id", 64)
        return try await Create.saveCreated(projectDir: try store.findProject(projectId: projectId).dir, projectId: projectId, workspaceId: ws, askId: id, rel: file, library: library)
    }
    func createdArgs(_ pid: JSONValue?, _ askId: JSONValue?, _ rel: JSONValue?) throws -> (String, String, String) {
        let id = try AskInput.str(askId, "ask id", 64)
        guard AskInput.wordRE.test(id) else { throw IPCError("ask id is invalid") }
        return (try AskInput.str(pid, "project id", 64), id, try AskInput.str(rel, "file", 1024))
    }
}
