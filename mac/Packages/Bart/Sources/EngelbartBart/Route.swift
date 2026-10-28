import Foundation
import EngelbartCore

// route.cjs — Bart, the router (2026-10-12). An `@bart` line is no longer a question for one agent: Bart picks @chat (the
// agent the app calls 'bart'), @brainstorm, @discover, @create or Build, the editor rewrites the line to that agent and
// asks it, and Bart steps aside. The editor tries its rules first (RouteRules); a line no rule settles comes here, and the
// default provider's fastest model (Haiku on Claude Code, Luna on Codex) is asked at low effort, with no tools and no
// session, which agent it is for. Anything that goes wrong, or a pick it is less than 0.6 sure of, goes to chat. A
// follow-up in a thread comes with `current`: it stays there unless the model is at least 0.8 sure the line wants another
// agent; a conversation with discover has its search in a research box already, so a reply is chat's unless it picks
// discover at least 0.8 sure. Every pick is a run in the Agent map's log under agent 'router'.

public struct RouteThread: Equatable, Sendable {
    public var agent: String, question: String, up: Int
    public init(agent: String, question: String, up: Int) { self.agent = agent; self.question = question; self.up = up }
}

public struct RouteRequest: Sendable {
    public var projectId: String?
    public var text: String
    public var section: String
    public var workspaceName: String
    public var threads: [RouteThread]
    public var specAbove: Bool
    public var specTitle: String
    public var current: String?
    /// The editor's own pick: only logged.
    public var rule: (agent: String, rule: String?)?
    public var place: OJ?
    public init(projectId: String? = nil, text: String, section: String = "", workspaceName: String = "", threads: [RouteThread] = [], specAbove: Bool = false,
                specTitle: String = "", current: String? = nil, rule: (agent: String, rule: String?)? = nil, place: OJ? = nil) {
        self.projectId = projectId; self.text = text; self.section = section; self.workspaceName = workspaceName; self.threads = threads
        self.specAbove = specAbove; self.specTitle = specTitle; self.current = current; self.rule = rule; self.place = place
    }
}

public struct RoutePick: Equatable, Sendable {
    public var agent: String
    public var sure: Double
    public var spec: Bool?
}

public struct RouteResult: Sendable {
    public var id: String
    public var agent: String
    public var sure: Double
    public var spec: Bool?
    public var model: (provider: String, name: String, id: String, effort: String)?
    public var ms: Double
    public var by: String
    public var rule: String?
    public var error: String?
    public var json: OJ {
        var o: [(String, OJ)] = [("id", .string(id)), ("agent", .string(agent)), ("sure", .number(sure))]
        if let spec { o.append(("spec", .bool(spec))) }
        o.append(("model", model.map { ["provider": .string($0.provider), "name": .string($0.name), "id": .string($0.id), "effort": .string($0.effort)] } ?? .null))
        o += [("ms", .number(ms)), ("by", .string(by))]
        if by == "rule" { o.append(("rule", rule.map { .string($0) } ?? .null)) }
        if let error { o.append(("error", .string(error))) }
        return .object(o)
    }
}

public enum Route {
    public static let timeout: TimeInterval = 20
    public static let sectionChars = 4000
    public static let maxThreads = 5
    static let questionChars = 80
    public static let sureEnough = 0.6
    public static let sureToSwitch = 0.8
    public static let picks = ["chat", "brainstorm", "discover", "create", "build"]

    static func clean(_ value: String?, _ max: Int) -> String { (value ?? "").squashedSpaces.jsSlice(0, max) }

    /// The section as the model sees it: agent replies left out, the last 4,000 characters.
    public static func sectionText(_ section: String?) -> String {
        let text = Strip.stripAgentReplies(section ?? "", agent: "router")
        return text.jsLength > sectionChars ? text.jsSlice(text.jsLength - sectionChars) : text
    }

    public static func threadsOf(_ threads: [RouteThread]) -> [RouteThread] {
        threads.suffix(maxThreads).map { t in
            let agent = clean(t.agent, 20)
            return RouteThread(agent: agent.isEmpty ? "chat" : agent, question: clean(t.question, questionChars), up: max(0, t.up))
        }
    }

    /// The agent a follow-up's conversation is with ('chat', 'brainstorm' or 'discover'), or nil.
    public static func currentOf(_ current: String?) -> String? {
        let agent = JSRegex("^@").replace((current ?? "").lowercased(), with: "")
        return picks.contains(agent) && agent != "build" && agent != "create" ? agent : nil
    }

    /// What the model is sent: the line, its section, the threads above, whether a spec is above, and `current`.
    public static func routeInput(text: String, section: String, workspaceName: String = "", threads: [RouteThread] = [], specAbove: Bool = false, specTitle: String = "", current: String? = nil) -> String {
        let list = threadsOf(threads), now = currentOf(current)
        let threadLines = list.isEmpty ? "(none)" : list.map { "- @\($0.agent), \($0.up) line\($0.up == 1 ? "" : "s") up: \(jsonQuote($0.question))" }.joined(separator: "\n")
        let title = clean(specTitle, questionChars)
        return [
            workspaceName.isEmpty ? "" : "<workspace>\(clean(workspaceName, 200))</workspace>",
            "<section>\n\(sectionText(section))\n</section>",
            "<threads>\n\(threadLines)\n</threads>",
            "<spec_above>\(specAbove ? (title.isEmpty ? "yes" : "yes: \(jsonQuote(title))") : "no")</spec_above>",
            now.map { "<current>\($0)</current>" } ?? "",
            "<line>\n\(text.jsTrim)\n</line>",
        ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// { agent, sure } from the model's reply, or nil when it holds no such object; a build's also has `spec`.
    public static func parseReply(_ raw: String?) -> RoutePick? {
        for m in JSRegex("\\{[^{}]*\\}", "g").matchAll(raw ?? "") {
            guard let value = OJ.parse(m.whole), value.isObject else { continue }
            let agent = JSRegex("^@").replace((value["agent"]?.string ?? Activity.textOf(value["agent"]?.jsonValue ?? .null) ?? "").lowercased(), with: "")
            let sure: Double? = {
                switch value["sure"] { case .number(let n)?: return n; case .string(let s)?: return Double(s.jsTrim.isEmpty ? "0" : s); case .bool(let b)?: return b ? 1 : 0; case .null?: return 0; default: return nil }
            }()
            if picks.contains(agent), let sure, sure.isFinite {
                return RoutePick(agent: agent, sure: max(0, min(1, sure)), spec: agent == "build" ? value["spec"] == .bool(true) : nil)
            }
        }
        return nil
    }

    /// The pick a reply comes to.
    public static func decide(_ parsed: RoutePick?, current: String? = nil) -> RoutePick {
        let now = currentOf(current)
        if now == "discover" {
            if let p = parsed, p.agent == "discover" { return p.sure >= sureToSwitch ? p : RoutePick(agent: "chat", sure: p.sure) }
            return decide(parsed)
        }
        if let now {
            if let p = parsed, p.agent != now, p.sure >= sureToSwitch { return p }
            return RoutePick(agent: now, sure: parsed?.sure ?? 0)
        }
        guard let p = parsed else { return RoutePick(agent: "chat", sure: 0) }
        return p.sure < sureEnough ? RoutePick(agent: "chat", sure: p.sure) : p
    }

    /// The model a line is routed on: the default provider's first model, at low effort (or its lowest).
    public static func routeModel(_ models: ModelsList?) -> Step? {
        guard let models else { return nil }
        let provider = models.provider == "openai" ? "openai" : "anthropic"
        guard let entry = models.providers[provider], let (key, info) = entry.models.first else { return nil }
        return Step(provider: provider, key: key, model: info.id, name: info.name.isEmpty ? key : info.name, effort: entry.efforts.contains("low") || entry.efforts.isEmpty ? "low" : entry.efforts[0])
    }

    /// The router's record, as the run log starts it.
    static func routerRecord(id: String, provider: String?, request r: RouteRequest, input: String, by: String) -> OJ {
        var o: [(String, OJ)] = [("id", .string(id)), ("agent", "router"), ("provider", provider.map { .string($0) } ?? .null), ("projectId", r.projectId.map { .string($0) } ?? .null),
                                 ("projectName", ""), ("workspaceName", .string(r.workspaceName)), ("question", .string(r.text)), ("at", .number(Time.ms())), ("status", "running"),
                                 ("system", .string(by == "rule" ? "" : Prompts.route)), ("mode", .null), ("pinned", false), ("by", .string(by))]
        if let rule = r.rule?.rule, by == "rule" { o.append(("rule", .string(rule))) }
        o += [("sectionSize", .number(Double(sectionText(r.section).jsLength))),
              ("threads", .array(threadsOf(r.threads).map { ["agent": .string($0.agent), "question": .string($0.question), "up": .number(Double($0.up))] })),
              ("specAbove", .bool(r.specAbove))]
        if by != "rule", let c = currentOf(r.current) { o.append(("current", .string(c))) }
        if let place = r.place { o.append(("place", place)) }
        o += [("context", ["input": .string(input)]), ("steps", .array([]))]
        return .object(o)
    }

    /// Marks a router record corrected: the person picked `agent` instead. By id, else the newest router record with this line.
    public static func markCorrected(_ runs: RunLog?, id: String?, projectId: String?, text: String, agent: String) {
        guard let runs, !agent.isEmpty else { return }
        let line = text.jsTrim
        let target = id ?? runs.find { r in r["agent"]?.string == "router" && r["question"]?.string == line && (projectId == nil || r["projectId"]?.string == projectId) }?["id"]?.string
        if let target { runs.amend(target, [("corrected", .string(agent))]) }
    }

    /// The router without a model (ENGELBART_BART_FAKE=1): it picks by keyword, as the model is asked to.
    public static func fakePick(_ text: String, current: String? = nil) -> RoutePick {
        let line = text.lowercased()
        if JSRegex("\\b(?:build|implement) (?:it|that|this)\\b|\\bgo ahead\\b").test(line) { return RoutePick(agent: "build", sure: 0.9, spec: true) }
        if JSRegex("\\bimplement\\b|\\bmake the\\b.*\\bdifferent\\b").test(line) { return RoutePick(agent: "build", sure: 0.9, spec: false) }
        if JSRegex("\\b(?:make|write up|draw) (?:a|an) (?:[\\w-]+ ){0,2}(?:chart|page|plot|graph)\\b|\\bcreate (?:a|an) (?!(?:[\\w-]+ )?(?:prompt|spec)\\b)").test(line) { return RoutePick(agent: "create", sure: 0.9) }
        if JSRegex("\\bpapers?\\b|\\bread\\b|\\breading\\b|prior work").test(line) { return RoutePick(agent: "discover", sure: 0.9) }
        if JSRegex("\\bthink\\b|\\bunsure\\b").test(line) { return RoutePick(agent: "brainstorm", sure: 0.9) }
        let now = currentOf(current)
        return RoutePick(agent: now == "discover" ? "chat" : now ?? "chat", sure: 0.9)
    }
}

// renderer/model/route.js — Bart in the editor: an `@bart` line picks its agent by rule first; only a line no rule
// settles is sent to the model. (routeInputs and buildTextOf read the document's threads, the Doc package's model: the
// editor computes those and passes them in a RouteRequest.)
public enum RouteRules {
    static let levelRE = JSRegex("(^|\\s)--(quick|standard|deep)(?=\\s|$)", "i")
    public static let questionChars = 80

    /// A thread's question as the router reads it: its first line as plain text, cut at a word to at most 80 characters.
    public static func questionLine(_ text: String?, max: Int = questionChars) -> String {
        var s = JSRegex("\\r?\\n").split(text ?? "").map { $0.jsTrim }.first { !$0.isEmpty } ?? ""
        s = JSRegex("@\\[([^\\]\\n]+)\\]\\([^)\\s]*\\)", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("@\\[([^\\]\\n]+)\\]", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("(^|\\s)@(?:bart|chat|brainstorm|orient|discover|create)\\b", "gi").replace(s) { $0[1] ?? "" }
        s = JSRegex("(^|\\s)--\\S+", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("!?\\[([^\\]\\n]*)\\]\\([^)\\s]*\\)", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("^\\s*(?:#{1,6}\\s+|[-*+]\\s+|\\d+[.)]\\s+|>\\s*)").replace(s, with: "")
        s = JSRegex("(\\*\\*|__|\\*|_|`)(\\S(?:.*?\\S)?)\\1", "g").replace(s) { $0[2] ?? "" }
        s = JSRegex("[*`]", "g").replace(s, with: "").squashedSpaces
        if s.jsLength <= max { return s }
        let cut = s.jsSlice(0, max + 1)
        let space = (cut as NSString).range(of: " ", options: .backwards).location
        return JSRegex("[\\s,;:–—-]+$").replace(space != NSNotFound && space > 0 ? cut.jsSlice(0, space) : s.jsSlice(0, max), with: "")
    }

    /// The agent an `@bart` line goes to by rule, or nil when the model is asked: an empty line → brainstorm; --build →
    /// build; --quick/--standard/--deep → discover; an answer to Discover's question (`asking`) → discover. A model or
    /// effort flag settles nothing (2026-10-16).
    public static func routeByRule(_ text: String?, asking: Bool = false) -> (agent: String, rule: String)? {
        let said = text ?? ""
        if said.jsTrim.isEmpty { return ("brainstorm", "empty") }
        if Question.readBuildFlag(said).build { return ("build", "--build") }
        if levelRE.test(said) { return ("discover", "level") }
        if asking { return ("discover", "answering Discover") }
        return nil
    }

    /// The agent a follow-up goes to when Bart could not pick: its conversation's, but Chat for one with Discover.
    public static func fallbackAgent(_ current: String?) -> String { current.flatMap { $0.isEmpty || $0 == "discover" ? nil : $0 } ?? "chat" }
}

/// route.cjs createRouter / createFakeRouter / routerOf.
public final class Router: @unchecked Sendable {
    public typealias Pick = (_ input: String, _ text: String, _ current: String?) async -> (parsed: RoutePick?, step: Step?, raw: String, error: String?)
    let runLog: RunLog?
    let pick: Pick
    let plain: (String) -> String

    init(runLog: RunLog?, plain: @escaping (String) -> String = { $0 }, pick: @escaping Pick) { self.runLog = runLog; self.plain = plain; self.pick = pick }

    /// The real router: the default provider's fastest model, through the CLI, with no tools and no session.
    public static func live(readModels: @escaping @Sendable () -> ModelsList?, environment: [String: String], runDirectory: String, codexHome: String,
                            codexAuthFile: String? = nil, tools: BartTools? = nil, runLog: RunLog? = nil, timeout: TimeInterval = Route.timeout, runner: AgentRunner? = nil) -> Router {
        let shell = AgentShell.resolveShell(environment)
        @Sendable func ask(_ step: Step, _ input: String) async throws -> String {
            try FileManager.default.createDirectory(atPath: runDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let stem = (runDirectory as NSString).appendingPathComponent("route-\(IDs.new())")
            try writePrivate("\(stem).input.txt", input)
            defer { removeFile("\(stem).input.txt") }
            let go: @Sendable () async throws -> String = {
                if step.provider == "openai" {
                    guard prepareCodexHome(codexHome: codexHome, source: codexAuthSource(environment, codexAuthFile), instructions: Prompts.route) else {
                        throw BartError("failed", "Codex is not signed in with a ChatGPT account")
                    }
                    let out = "\(stem).out.txt"
                    defer { removeFile(out) }
                    let command = "exec \(AgentShell.program("codex", tools)) exec --skip-git-repo-check --ephemeral -s read-only -m \"$ENGELBART_ROUTE_MODEL\" -c 'model_reasoning_effort=\"\(step.effort)\"' -c project_doc_max_bytes=0 --color never --json -o \"$ENGELBART_ROUTE_OUTPUT\" - < \"$ENGELBART_ROUTE_INPUT\""
                    let env = AgentShell.childEnvironment(environment, tools: tools, AgentShell.programEnv("codex", tools).merging(["CODEX_HOME": codexHome, "ENGELBART_ROUTE_MODEL": step.model, "ENGELBART_ROUTE_OUTPUT": out, "ENGELBART_ROUTE_INPUT": "\(stem).input.txt"]) { $1 })
                    let (_, failure) = await AgentShell.execute(shell: shell, command: command, cwd: runDirectory, env: env, timeout: timeout, runner: runner)
                    let text = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
                    if text.jsTrim.isEmpty { throw BartError("failed", failure?.firstLine ?? "Codex returned no message") }
                    return text
                }
                let prompt = "\(stem).system.md"
                try writePrivate(prompt, Prompts.route)
                defer { removeFile(prompt) }
                let command = "exec \(AgentShell.program("claude", tools)) -p --output-format json --no-session-persistence --setting-sources \"\" --strict-mcp-config --tools \"\" --model \"$ENGELBART_ROUTE_MODEL\" --effort \(step.effort) --system-prompt-file \"$ENGELBART_ROUTE_PROMPT\" < \"$ENGELBART_ROUTE_INPUT\""
                let env = AgentShell.childEnvironment(environment, tools: tools, AgentShell.programEnv("claude", tools).merging(["ENGELBART_ROUTE_MODEL": step.model, "ENGELBART_ROUTE_PROMPT": prompt, "ENGELBART_ROUTE_INPUT": "\(stem).input.txt"]) { $1 })
                let (stdout, failure) = await AgentShell.execute(shell: shell, command: command, cwd: runDirectory, env: env, timeout: timeout, runner: runner)
                let result = lastResultLine(stdout)
                guard let result, result["is_error"]?.bool != true, let text = result["result"]?.string else {
                    throw BartError("failed", result.map { ($0["result"]?.string).flatMap { $0.isEmpty ? nil : $0 } ?? $0["subtype"]?.string ?? "no text" }
                                    ?? "Claude Code returned no result\(failure.map { " (\($0.firstLine))" } ?? "")")
                }
                return text
            }
            if let tools { return try await tools.use(Models.toolOf[step.provider] ?? step.provider, go) }
            return try await go()
        }
        // The line as the model reads it: its model and effort flags left out, once the models file is read (2026-10-16).
        return Router(runLog: runLog, plain: { text in readModels().map { Question.readFlags(text, $0).rest } ?? text }) { input, _, _ in
            guard let step = Route.routeModel(readModels()) else { return (nil, nil, "", "no model to route on") }
            do { let raw = try await ask(step, input); return (Route.parseReply(raw), step, raw, nil) }
            catch { return (nil, step, "", (error as? BartError)?.message ?? error.localizedDescription) }
        }
    }

    /// The router without a model (ENGELBART_BART_FAKE=1): by keyword.
    public static func fake(runLog: RunLog? = nil) -> Router {
        Router(runLog: runLog) { _, text, current in
            let p = Route.fakePick(text, current: current)
            var raw: OJ = ["agent": .string(p.agent), "sure": .number(p.sure)]
            if let spec = p.spec { raw = raw.setting("spec", .bool(spec)) }
            return (p, Step(provider: "fake", key: "fake", model: "fake", name: "Fake", effort: "low"), raw.stringify(), nil)
        }
    }

    /// → { id, agent, sure, spec?, model, ms, by }: with `rule` (the editor's own pick) it is only logged.
    public func route(_ r: RouteRequest) async -> RouteResult {
        let id = "route-\(IDs.new())", started = Time.ms()
        if let rule = r.rule, Route.picks.contains(rule.agent) {
            runLog?.start(Route.routerRecord(id: id, provider: nil, request: r, input: "", by: "rule"))
            let out = RouteResult(id: id, agent: rule.agent, sure: 1, spec: nil, model: nil, ms: Time.ms() - started, by: "rule", rule: rule.rule)
            runLog?.amend(id, [("pick", .string(out.agent)), ("sure", 1)])
            runLog?.finish(id, status: "done", written: ["@\(out.agent)"], ms: out.ms)
            return out
        }
        let input = Route.routeInput(text: plain(r.text), section: r.section, workspaceName: r.workspaceName, threads: r.threads, specAbove: r.specAbove, specTitle: r.specTitle, current: r.current)
        runLog?.start(Route.routerRecord(id: id, provider: nil, request: r, input: input, by: "model"))
        let (parsed, step, raw, error) = await pick(input, r.text, r.current)
        if let step { runLog?.step(id, model: step.model, name: step.name, effort: step.effort, input: input); runLog?.output(id, raw: raw) }
        let d = Route.decide(parsed, current: r.current)
        // Whether the line asks for the spec above to be built (2026-10-13): only a build the model picked says so.
        let means: Bool? = d.agent == "build" ? d.spec == true : nil
        let out = RouteResult(id: id, agent: d.agent, sure: d.sure, spec: means, model: step.map { ($0.provider, $0.name, $0.model, $0.effort) }, ms: Time.ms() - started, by: "model", rule: nil, error: error)
        var patch: [(String, OJ)] = [("provider", step.map { .string($0.provider) } ?? .null), ("pick", .string(d.agent)), ("sure", .number(d.sure))]
        if let means { patch.append(("spec", .bool(means))) }
        if parsed == nil { patch.append(("unread", true)) }
        if let p = parsed, p.agent != d.agent { patch.append(("said", .string(p.agent))) }
        runLog?.amend(id, patch)
        runLog?.finish(id, status: error != nil ? "failed" : "done", written: ["@\(d.agent)"], error: error, ms: out.ms)
        return out
    }

    /// The person picked `agent` instead of the router's pick.
    public func corrected(id: String?, projectId: String?, text: String, agent: String) { Route.markCorrected(runLog, id: id, projectId: projectId, text: text, agent: agent) }

    /// Where the line went, when it was not an ask: a Build's id.
    public func handed(_ id: String, to: String) { if !id.isEmpty && !to.isEmpty { runLog?.amend(id, [("handedTo", .string(to))]) } }
}
