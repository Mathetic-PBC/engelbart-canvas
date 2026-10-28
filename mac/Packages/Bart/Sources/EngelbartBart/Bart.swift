import Foundation
import EngelbartCore

// ask.cjs createBart — the @bart service: one turn of Chat (`bart`), Brainstorm, Discover or Create, run on the Claude
// Code or Codex CLI, hidden, on the person's subscription. Claude Code: --restricted with Read, Grep, Glob, WebSearch and
// WebFetch, its file tools confined to the project's code directory and the Engelbart data folder (--add-dir); Codex: the
// read-only sandbox with web search on. Both run in a private folder, so their sessions never show up among the person's
// own. While a turn runs, the CLI's events are read as they arrive (Activity) and sent on as progress; the answer itself
// is the CLI's final result. @discover's search turns get the paper tools (`--mcp papers`, served by this app's own
// executable: Claude Code by --mcp-config, Codex by its home's config.toml). @create writes in a draft folder alone
// (Claude Code: Write/Edit rules on its path with --permission-mode dontAsk; Codex: a workspace-write sandbox rooted there,
// no network), and what it wrote is kept with the project and saved into the library (Create).
// ENGELBART_BART_FAKE=1 runs the fake agents (AskFake.swift): no model, streamed like a real run, "hard" moves up a step.

/// One ask, as ipc.cjs ask-bart hands it over (validated: AskInput).
public struct AskRequest: Sendable {
    public var askId: String
    public var ref: DocRef
    public var workspaceId: String
    public var text: String
    public var turns: [Turn]
    /// Regenerate's selector: overrules the line's flags for this run without rewriting the line.
    public var choice: (model: String, effort: String)?
    public var agent: String
    public var highlight: HighlightInput?
    public var stage: StageInput?
    public var live: LivePage?
    public var overleaf: OverleafTabs?
    public var routed: Routed?
    public var place: OJ?
    public var steer: Steer?
    public init(askId: String, ref: DocRef, workspaceId: String, text: String, turns: [Turn] = [], choice: (model: String, effort: String)? = nil, agent: String = "bart",
                highlight: HighlightInput? = nil, stage: StageInput? = nil, live: LivePage? = nil, overleaf: OverleafTabs? = nil, routed: Routed? = nil, place: OJ? = nil, steer: Steer? = nil) {
        self.askId = askId; self.ref = ref; self.workspaceId = workspaceId; self.text = text; self.turns = turns; self.choice = choice; self.agent = agent
        self.highlight = highlight; self.stage = stage; self.live = live; self.overleaf = overleaf; self.routed = routed; self.place = place; self.steer = steer
    }
}

/// What an ask answers: the lines for the document, what produced them, and what it hands back.
public struct AskAnswer: Sendable {
    public var lines: [String]
    public var meta: ReplyMeta
    /// A Brainstorm conversation's topic, for its title line.
    public var topic: String?
    /// The direction Discover settled on: the window opens a research box on it.
    public var research: String?
    /// 'result' when the Welcome walkthrough's result is written: the window asks @discover on it.
    public var welcome: String?
}

/// A one-shot gate: waiters resume once it opens.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if open { lock.unlock(); c.resume(); return }
            waiters.append(c); lock.unlock()
        }
    }
    func release() { lock.lock(); open = true; let w = waiters; waiters = []; lock.unlock(); w.forEach { $0.resume() } }
}

public final class Bart: @unchecked Sendable {
    public struct Config {
        /// The list in force for 'bart' (ModelSettings.modelsInForce), read again for every run.
        public var readModels: @Sendable () -> ModelsList
        public var environment: [String: String] = ProcessInfo.processInfo.environment
        /// <userData>/bart-runs; the private Codex homes beside it.
        public var runDirectory: String
        public var codexHome: String
        public var brainstormCodexHome: String
        public var discoverCodexHome: String
        public var createCodexHome: String
        public var routerCodexHome: String
        public var makingCodexHome: String
        public var codexAuthFile: String? = nil
        public var threads = Threads()
        public var brainstormThreads = Threads(idle: AskPlan.brainstormIdle)
        public var discoverThreads = Threads(idle: AskPlan.discoverIdle)
        public var tools: BartTools? = nil
        /// A question asked with a model or effort picked by hand: kept as where the next one starts (Choices).
        public var onPicked: @Sendable (Choice) -> Void = { _ in }
        public var runLog: RunLog? = nil
        /// What @create keeps goes in the library through this (nil: kept with the project, not saved).
        public var createdLibrary: CreatedLibrary? = nil
        /// The paper tools' server, as either CLI is told to start it: this executable `--mcp papers`.
        public var papersCommand: String = MCPLaunch.executable
        public var papersArgs: [String] = MCPLaunch.arguments(PapersMCP.name)
        /// The CLI process (tests); nil runs the real one.
        public var runner: AgentRunner? = nil
        /// ENGELBART_BART_FAKE=1: the fake agents.
        public var fake = false
        public var fakeDelayMs: Double = 1200

        /// The app's layout: everything under `userData` (~/Library/Application Support/Engelbart Swift), the threads kept
        /// in bart-threads.json, brainstorm-threads.json and discover-threads.json there (index.cjs).
        public static func app(userData: String, readModels: @escaping @Sendable () -> ModelsList, environment: [String: String] = ProcessInfo.processInfo.environment) -> Config {
            func at(_ name: String) -> String { (userData as NSString).appendingPathComponent(name) }
            let codexHome = at("codex-home-bart")
            return Config(readModels: readModels, environment: environment, runDirectory: at("bart-runs"), codexHome: codexHome,
                          brainstormCodexHome: at("codex-home-brainstorm"), discoverCodexHome: at("codex-home-discover"), createCodexHome: at("codex-home-create"),
                          routerCodexHome: "\(codexHome)-router", makingCodexHome: "\(codexHome)-making",
                          threads: Threads(file: URL(fileURLWithPath: at("bart-threads.json"))),
                          brainstormThreads: Threads(idle: AskPlan.brainstormIdle, file: URL(fileURLWithPath: at("brainstorm-threads.json"))),
                          discoverThreads: Threads(idle: AskPlan.discoverIdle, file: URL(fileURLWithPath: at("discover-threads.json"))),
                          fake: environment["ENGELBART_BART_FAKE"] == "1")
        }

        public init(readModels: @escaping @Sendable () -> ModelsList, environment: [String: String] = ProcessInfo.processInfo.environment, runDirectory: String, codexHome: String,
                    brainstormCodexHome: String, discoverCodexHome: String, createCodexHome: String, routerCodexHome: String, makingCodexHome: String,
                    threads: Threads = Threads(), brainstormThreads: Threads = Threads(idle: AskPlan.brainstormIdle), discoverThreads: Threads = Threads(idle: AskPlan.discoverIdle), fake: Bool = false) {
            self.readModels = readModels; self.environment = environment; self.runDirectory = runDirectory; self.codexHome = codexHome
            self.brainstormCodexHome = brainstormCodexHome; self.discoverCodexHome = discoverCodexHome; self.createCodexHome = createCodexHome
            self.routerCodexHome = routerCodexHome; self.makingCodexHome = makingCodexHome
            self.threads = threads; self.brainstormThreads = brainstormThreads; self.discoverThreads = discoverThreads; self.fake = fake
        }
    }

    public let config: Config
    public let router: Router
    let lock = NSLock()
    var running: [String: AgentShell.Stopper] = [:]
    var settling: [String: Gate] = [:]
    var paused: [String: (provider: String, session: String, timer: DispatchWorkItem)] = [:]

    public init(_ config: Config) {
        self.config = config
        let readModels = config.readModels
        router = config.fake ? .fake(runLog: config.runLog)
            : .live(readModels: { readModels() }, environment: config.environment, runDirectory: config.runDirectory, codexHome: config.routerCodexHome,
                    codexAuthFile: config.codexAuthFile, tools: config.tools, runLog: config.runLog, runner: config.runner)
    }

    var log: RunLog? { config.runLog }

    func threadsFor(_ agent: String) -> Threads? {
        switch agent { case "bart": return config.threads; case "brainstorm": return config.brainstormThreads; case "discover": return config.discoverThreads; default: return nil }
    }

    /// A pick handed on to be kept; keeping it never stands in a question's way.
    func remember(_ step: Step) { config.onPicked(Choice(provider: step.provider, model: step.key, effort: step.effort)) }

    /// Whether an @brainstorm turn is the Welcome walkthrough's: asked in its workspace's own document while it shows.
    static func welcomeHere(_ store: BartStore, _ projectId: String, _ agent: String, _ ref: DocRef, _ workspaceId: String) -> Bool {
        guard agent == "brainstorm", ref.kind == "workspace", !workspaceId.isEmpty, let state = store.gettingStarted(projectId: projectId) else { return false }
        return !state.hidden && state.workspaceId == workspaceId
    }

    /// The Welcome walkthrough's result, or its stage card, with no model run, with the foot an answer has.
    static func resultReply(_ plan: TurnPlan) -> AskAnswer {
        let meta = ReplyMeta(provider: plan.provider, level: .init(name: "", effort: "", model: ""), trail: [], ms: 0, pinned: false)
        return AskAnswer(lines: Reply.replyLines(plan.written, meta, model: false, agent: "brainstorm"), meta: meta, topic: nil, research: nil,
                         welcome: plan.welcome && plan.stage == "result" ? "result" : nil)
    }

    /// The question as it is sent (2026-10-02): an image pasted into it as the path of its file.
    static func withImagePaths(_ store: BartStore, _ projectId: String, _ question: String) async -> String {
        guard question.contains("](img:") else { return question }
        return await store.imagePaths(projectId: projectId, text: question)
    }

    // MARK: running and stopping

    func register(_ askId: String) -> (AgentShell.Stopper, Gate) {
        let stopper = AgentShell.Stopper(), gate = Gate()
        lock.lock(); running[askId] = stopper; settling[askId] = gate; lock.unlock()
        return (stopper, gate)
    }

    func unregister(_ askId: String, _ gate: Gate) {
        lock.lock(); running[askId] = nil; settling[askId] = nil; lock.unlock()
        gate.release()
    }

    /// A search stopped by a reply sent under it: its session kept for the run that goes on (10 minutes).
    func pause(_ askId: String, provider: String, session: String) {
        let timer = DispatchWorkItem { [weak self] in self?.lock.lock(); self?.paused[askId] = nil; self?.lock.unlock() }
        lock.lock(); paused[askId]?.timer.cancel(); paused[askId] = (provider, session, timer); lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + AskPlan.steerKeep, execute: timer)
    }

    /// The session of search `after`, which is stopped first if it still runs, once its run has ended.
    func pausedFor(_ after: String, provider: String) async -> Threads.Entry? {
        let (stopper, gate) = lock.withLock { (running[after], settling[after]) }
        stopper?.stop()
        await gate?.wait()
        let entry = lock.withLock { () -> (provider: String, session: String, timer: DispatchWorkItem)? in let e = paused[after]; e?.timer.cancel(); paused[after] = nil; return e }
        guard let entry, entry.provider == provider else { return nil }
        return Threads.Entry(provider: entry.provider, session: entry.session, at: 0)
    }

    /// Stop: the run with that id stops; → whether one was running.
    @discardableResult
    public func stop(_ askId: String) -> Bool {
        lock.lock(); let s = running[askId]; lock.unlock()
        s?.stop()
        return s != nil
    }

    public func stopAll() { lock.lock(); let all = Array(running.values); lock.unlock(); all.forEach { $0.stop() } }

    /// Bart, the router.
    public func route(_ r: RouteRequest) async -> RouteResult { await router.route(r) }
    public func routeHanded(_ id: String, to: String) { router.handed(id, to: to) }

    // MARK: the CLI turns

    struct TurnOptions {
        var system: String, cwd: String, dirs: [String], stem: String
        var stopper: AgentShell.Stopper
        var short: (String?) -> String
        var onUpdate: (ActivityUpdate?) -> Void
        var onRaw: (JSONValue) -> Void
        var resume: String?
        var allowed = AskPlan.claudeTools
        var rules: String? = nil
        var home: String
        var web = true
        var mcp = false
        var write = false
        var timeout = AskPlan.stepTimeout
        var logId: String
    }

    struct CLI { var turn: (Step, String, String?) async throws -> (text: String, session: String?); var done: () -> Void }

    var papersServer: (command: String, args: [String], env: [(String, String)]) {
        // An OpenAlex key in the environment (2026-10-15) goes with it: a larger daily allowance.
        let key = config.environment["OPENALEX_API_KEY"].flatMap { $0.isEmpty ? nil : $0 }
        return (config.papersCommand, config.papersArgs, key.map { [("OPENALEX_API_KEY", $0)] } ?? [])
    }

    func reader(_ o: TurnOptions, parse: @escaping (JSONValue) -> ActivityUpdate?) -> (String) -> Void {
        let log = self.log
        return { line in
            guard let event = Activity.event(fromLine: line) else { return }
            log?.event(o.logId, event)
            o.onRaw(event)
            o.onUpdate(parse(event))
        }
    }

    // Every flag is a literal, every value arrives through the environment: nothing is quoted by hand.
    func claudeTurns(_ o: TurnOptions) throws -> CLI {
        let promptFile = "\(o.stem).system.md", mcpFile = "\(o.stem).mcp.json"
        try writePrivate(promptFile, o.system)
        if o.mcp {
            let p = papersServer
            let json: OJ = ["mcpServers": ["papers": ["command": .string(p.command), "args": .array(p.args.map { .string($0) }), "env": .object(p.env.map { ($0.0, .string($0.1)) })]]]
            try writePrivate(mcpFile, json.stringify())
        }
        let id = o.resume ?? IDs.new()
        let grants = o.dirs.indices.map { "--add-dir \"$ENGELBART_BART_DIR\($0)\"" }.joined(separator: " ")
        let shell = AgentShell.resolveShell(config.environment)
        return CLI(turn: { [self] level, message, session in
            try writePrivate("\(o.stem).input.txt", message)
            // --tools names the built-in tools; the paper tools are allowed by their server's prefix.
            let servers = o.mcp ? " --mcp-config \"$ENGELBART_BART_MCP\"" : "", granted = o.mcp ? "\(o.allowed),\(AskPlan.paperTools)" : o.allowed
            let permitted = o.rules != nil ? "--allowedTools \"$ENGELBART_BART_RULES\" --permission-mode dontAsk" : "--allowedTools \"\(granted)\""
            let command = "exec \(AgentShell.program("claude", config.tools)) -p --output-format stream-json --verbose --include-partial-messages \(session != nil ? "--resume" : "--session-id") \"$ENGELBART_BART_SESSION\" --restricted --setting-sources \"\" --strict-mcp-config\(servers) --tools \"\(o.allowed)\" \(permitted) \(grants) --model \"$ENGELBART_BART_MODEL\" --effort \(level.effort) --system-prompt-file \"$ENGELBART_BART_PROMPT\" < \"$ENGELBART_BART_INPUT\""
            var extra = AgentShell.programEnv("claude", config.tools)
            extra["ENGELBART_BART_SESSION"] = id; extra["ENGELBART_BART_MODEL"] = level.model; extra["ENGELBART_BART_PROMPT"] = promptFile; extra["ENGELBART_BART_INPUT"] = "\(o.stem).input.txt"
            if let rules = o.rules { extra["ENGELBART_BART_RULES"] = rules }
            if o.mcp { extra["ENGELBART_BART_MCP"] = mcpFile }
            for (n, dir) in o.dirs.enumerated() { extra["ENGELBART_BART_DIR\(n)"] = dir }
            let env = AgentShell.childEnvironment(config.environment, tools: config.tools, extra)
            let read = Activity.claudeReader(o.short) // a Write named and counted as it comes (2026-10-15)
            let (stdout, failure) = await AgentShell.execute(shell: shell, command: command, cwd: o.cwd, env: env, timeout: o.timeout, stopper: o.stopper,
                                                            onLine: reader(o, parse: read), runner: config.runner)
            if o.stopper.isStopped { throw BartError.stopped }
            guard let result = lastResultLine(stdout) else {
                throw BartError("unavailable", failure?.isNotFound == true ? "Claude Code was not found on the login shell PATH." : "Claude Code did not return a result\(failure.map { " (\($0.firstLine))" } ?? "").")
            }
            guard result["is_error"]?.bool != true, let text = result["result"]?.string, !text.jsTrim.isEmpty else {
                let why = (result["result"].flatMap(Activity.textOf)).flatMap { $0.isEmpty ? nil : $0 } ?? result["subtype"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "The model returned no text."
                throw BartError("failed", why.jsSlice(0, 300))
            }
            return (text, id)
        }, done: { removeFile(promptFile); removeFile(mcpFile) })
    }

    func codexTurns(_ o: TurnOptions) throws -> CLI {
        guard prepareCodexHome(codexHome: o.home, source: codexAuthSource(config.environment, config.codexAuthFile), instructions: o.system) else {
            throw BartError("unavailable", "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.")
        }
        let p = papersServer
        AskPlan.writeCodexConfig(o.home, servers: o.mcp ? [("papers", p.command, p.args, p.env)] : [])
        let outFile = "\(o.stem).out.txt"
        let shell = AgentShell.resolveShell(config.environment)
        return CLI(turn: { [self] level, message, session in
            try writePrivate("\(o.stem).input.txt", message)
            removeFile(outFile)
            // -C is `exec`'s, before its subcommand: `exec resume` takes none of its own.
            let sandbox = o.write ? AskPlan.createCodex.map { "-c '\($0)'" }.joined(separator: " ") : "-c 'sandbox_mode=\"read-only\"'"
            let at = o.write ? "-C \"$ENGELBART_BART_CWD\" " : ""
            let shared = "--skip-git-repo-check -m \"$ENGELBART_BART_MODEL\" -c 'model_reasoning_effort=\"\(level.effort)\"' \(sandbox) -c 'tools.web_search=\(o.web)' -c project_doc_max_bytes=0 --json -o \"$ENGELBART_BART_OUTPUT\" - < \"$ENGELBART_BART_INPUT\""
            let program = AgentShell.program("codex", config.tools)
            let command = session != nil ? "exec \(program) exec \(at)resume \"$ENGELBART_BART_SESSION\" \(shared)" : "exec \(program) exec --color never \(at)\(shared)"
            var extra = AgentShell.programEnv("codex", config.tools)
            extra["CODEX_HOME"] = o.home; extra["ENGELBART_BART_SESSION"] = session ?? ""; extra["ENGELBART_BART_MODEL"] = level.model
            extra["ENGELBART_BART_OUTPUT"] = outFile; extra["ENGELBART_BART_INPUT"] = "\(o.stem).input.txt"
            if o.write { extra["ENGELBART_BART_CWD"] = o.cwd }
            let env = AgentShell.childEnvironment(config.environment, tools: config.tools, extra)
            let short = o.short
            let (stdout, failure) = await AgentShell.execute(shell: shell, command: command, cwd: o.cwd, env: env, timeout: o.timeout, stopper: o.stopper,
                                                            onLine: reader(o) { Activity.codexUpdate($0, short) }, runner: config.runner)
            if o.stopper.isStopped { throw BartError.stopped }
            let text = (try? String(contentsOfFile: outFile, encoding: .utf8)) ?? ""
            var thread = session
            for line in JSRegex("\\r?\\n").split(stdout) where thread == nil && line.hasPrefix("{") {
                if let e = try? JSONValue.parse(line), e["type"]?.string == "thread.started", let t = e["thread_id"]?.string, AskPlan.uuidRE.test(t) { thread = t }
            }
            if text.jsTrim.isEmpty {
                if failure?.isNotFound == true { throw BartError("unavailable", "Codex was not found on the login shell PATH.") }
                let reason = JSRegex("\\r?\\n").split(stdout).reversed().first { JSRegex("\"type\":\"(error|turn\\.failed)\"|^ERROR").test($0) && !$0.contains("resuming with") }
                    ?? failure?.firstLine ?? "Codex returned no message."
                throw BartError("failed", reason.jsSlice(0, 300))
            }
            return (text, thread)
        }, done: { removeFile(outFile) })
    }

    // MARK: ask

    /// One turn → its answer. Progress goes to `onProgress` as it comes; a run stopped throws BartError.stopped, one that
    /// failed throws its BartError (ipc.cjs then writes failureLines).
    public func ask(store: BartStore, projectId: String, _ q: AskRequest, onProgress: @escaping @Sendable (BartProgress) -> Void = { _ in }) async throws -> AskAnswer {
        if config.fake { return try await fakeAsk(store: store, projectId: projectId, q, onProgress: onProgress) }
        let models = config.readModels()
        let agent = q.agent, bart = agent == "bart", create = agent == "create"
        // The context first: @brainstorm's path is read against the library it shows.
        let context = try await Context.build(store: store, projectId: projectId, ref: q.ref, workspaceId: q.workspaceId, askId: q.askId, agent: agent,
                                              highlight: q.highlight, stage: q.stage, live: q.live, overleaf: q.overleaf)
        let plan = AskPlan.turnPlan(agent: agent, text: q.text, turns: q.turns, choice: q.choice, welcome: Bart.welcomeHere(store, projectId, agent, q.ref, q.workspaceId), models: models)
        if plan.question.isEmpty && (bart || create) { throw BartError("failed", create ? "There is nothing on the line to make." : "There is no question on the line.") }
        if plan.pinned && bart { remember(plan.steps[0]) }
        let threads = threadsFor(agent)
        // A reply sent while its search ran (`steer`), or a level picked on its box: that run stops, and this one goes on
        // in its session; a session that cannot be had is a search of the direction as it now reads.
        let steered = agent == "discover" && plan.search && q.steer != nil ? await pausedFor(q.steer!.after, provider: plan.provider) : nil
        let held = steered ?? (!plan.prior.isEmpty && threads != nil && !AskPlan.switched(plan.prior, agent) ? threads!.take(AskPlan.threadKey(projectId, q.ref, plan.prior), provider: plan.provider) : nil)
        let system = AskPlan.loadSystemPrompt(store.dataRoot, agent: plan.welcome ? "welcome" : agent)
        let logId = q.askId.isEmpty ? IDs.new() : q.askId
        let started = Time.ms()
        log?.start(AskPlan.runRecord(id: logId, agent: agent, provider: plan.provider, projectId: projectId, question: q.text, system: system, context: context,
                                     shown: plan.shown, extra: plan.extra, mode: plan.mode, pinned: plan.pinned, routed: q.routed, place: q.place, reply: plan.prior.count))
        if let corrected = q.routed?.corrected { Route.markCorrected(log, id: q.routed?.id, projectId: projectId, text: q.text, agent: corrected) }
        do {
            let result = try await answer(store: store, projectId: projectId, q: q, plan: plan, context: context, held: held, steered: steered, threads: threads, system: system, logId: logId, models: models, onProgress: onProgress)
            log?.finish(logId, status: "done", written: result.lines, ms: Time.ms() - started)
            return result
        } catch {
            log?.finish(logId, status: (error as? BartError)?.kind == "stopped" ? "stopped" : "failed", error: (error as? BartError)?.message ?? error.localizedDescription, ms: Time.ms() - started)
            throw error
        }
    }

    func answer(store: BartStore, projectId: String, q: AskRequest, plan: TurnPlan, context: BartContext, held: Threads.Entry?, steered: Threads.Entry?, threads: Threads?,
                system: String, logId: String, models: ModelsList, onProgress: @escaping @Sendable (BartProgress) -> Void) async throws -> AskAnswer {
        let agent = plan.agent, bart = agent == "bart", create = agent == "create"
        // The Welcome walkthrough's stage card, or its result: written here, no model runs.
        if plan.written != nil { return Bart.resultReply(plan) }
        let sent = await Bart.withImagePaths(store, projectId, plan.asked)
        let cwd = (config.runDirectory as NSString).appendingPathComponent(projectId)
        try FileManager.default.createDirectory(atPath: cwd, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let stem = (cwd as NSString).appendingPathComponent("ask-\(IDs.new())")
        let (stopper, gate) = register(q.askId)
        let feed = Feed { onProgress($0) }
        // @create's line (making.cjs): what it is making, shown above its row a second or two in, while the run works.
        let makingTask: Task<String, Never>? = create ? Task { [config] in
            let quick = QuickRun(environment: config.environment, runDirectory: (config.runDirectory as NSString).appendingPathComponent("making"), codexHome: config.makingCodexHome,
                                 codexAuthFile: config.codexAuthFile, tools: config.tools, timeout: Making.timeout, prefix: "making", runner: config.runner)
            let said = await Making.making(request: plan.question, documents: context.documents, provider: plan.provider, models: models, quickRun: quick)
            if !said.line.isEmpty && !stopper.isStopped { onProgress(.making(said.line)) }
            return said.line
        } : nil
        // @discover's steps told as its trace (Trace, 2026-10-15).
        let trace = agent == "discover" ? Trace(entries: context.entries) : nil
        // The session a search runs in, as its events name it, kept if it is stopped (pausedFor); Chat's tool calls.
        final class Seen: @unchecked Sendable { var session: String?; var events: [JSONValue] = []; let lock = NSLock() }
        let seen = Seen(); seen.session = held?.session
        let traced: (JSONValue) -> Void = { event in
            seen.lock.lock()
            if bart && !ToolCalls.of(event).isEmpty { seen.events.append(event) }
            let named = event["session_id"]?.string ?? (event["type"]?.string == "thread.started" ? event["thread_id"]?.string : nil)
            if let n = named, AskPlan.uuidRE.test(n) { seen.session = n }
            seen.lock.unlock()
            if let story = trace?.take(event) { onProgress(.trace(story)) }
        }
        // @create's working directory is its draft folder, made empty, the one place it writes; deleted however the run ends.
        let draft = create ? try Create.openDraft(store.dataRoot, logId) : nil
        defer {
            feed.end()
            unregister(q.askId, gate)
            Create.dropDraft(draft)
            removeFile("\(stem).input.txt")
        }
        let cliName = Models.toolOf[plan.provider] ?? plan.provider
        let once: @Sendable (String?) async throws -> (text: String, level: Step, trail: [ReplyMeta.Moved], session: String?, ms: Double) = { [self] session in
            var o = TurnOptions(system: system, cwd: draft ?? cwd, dirs: context.dirs, stem: stem, stopper: stopper, short: Activity.pathLabeller(context.dirs),
                                onUpdate: { feed.take($0) }, onRaw: traced, resume: session, home: config.codexHome, logId: logId)
            switch agent {
            case "brainstorm": o.allowed = AskPlan.brainstormTools; o.home = config.brainstormCodexHome; o.web = false
            case "discover":
                o.home = config.discoverCodexHome
                // A turn settling what to research only talks (2026-10-15): files only, no paper tools, no web.
                if plan.search { o.mcp = true; o.timeout = plan.mode == "deep" ? AskPlan.deepDiscoverTimeout : AskPlan.discoverTimeout }
                else { o.allowed = AskPlan.brainstormTools; o.web = false }
            case "create":
                o.allowed = AskPlan.createTools; o.rules = draft.map(AskPlan.createRules); o.home = config.createCodexHome; o.write = true; o.timeout = Create.timeout
            default: break
            }
            let cli = try (plan.provider == "anthropic" ? claudeTurns(o) : codexTurns(o))
            defer { cli.done() }
            let going = steered != nil && session == steered?.session // on in the stopped search's session, told what was added
            let first = AskPlan.firstMessage(context: context, prior: plan.shown,
                                             question: going ? AskPlan.steerMessage(q.steer!.words, mode: q.steer!.level ? plan.mode : nil) : sent,
                                             resumed: session != nil, extra: going ? "" : plan.extra, routed: q.routed, agent: agent, topic: agent == "brainstorm" ? context.topic : nil)
            return try await AskPlan.climb(steps: plan.steps, pinned: plan.pinned, first: first, session: session, onProgress: onProgress, quiet: AskPlan.quiet.contains(agent)) { level, message, s in
                feed.reset()
                log?.step(logId, model: level.model, name: level.name, effort: level.effort, input: message)
                let out = try await cli.turn(level, message, s)
                let t = out.text.jsTrim
                log?.output(logId, raw: out.text, escalated: t.jsLength < 500 && AskPlan.escalateRE.test(t))
                return out
            }
        }
        // While it runs, the CLI is not installed or updated under it (the tool lock); a CLI that was not found is looked for again.
        let guarded: @Sendable (String?) async throws -> (text: String, level: Step, trail: [ReplyMeta.Moved], session: String?, ms: Double) = { [config] session in
            guard let tools = config.tools else { return try await once(session) }
            do { return try await tools.use(cliName) { try await once(session) } }
            catch {
                if (error as? BartError)?.kind == "unavailable" { Task { await tools.check([cliName]) } }
                throw error
            }
        }
        if let tools = config.tools { try await tools.ensure(cliName) }
        var out: (text: String, level: Step, trail: [ReplyMeta.Moved], session: String?, ms: Double)
        // A session that will not resume (its file is gone, the CLI changed) is not the person's problem: start again.
        do { out = try await guarded(held?.session) } catch {
            let kind = (error as? BartError)?.kind
            if kind == "stopped" && plan.search, let s = seen.session { pause(q.askId, provider: plan.provider, session: s) }
            if held == nil || kind == "stopped" { throw error }
            out = try await guarded(nil)
        }
        var meta = ReplyMeta(provider: plan.provider, level: .init(name: out.level.name, effort: out.level.effort, model: out.level.model),
                             trail: out.trail, ms: out.ms, pinned: plan.pinned, routed: q.routed)
        // @create's files kept with the project, each answered with a line the editor draws as its row; stopped, it keeps none.
        if create && stopper.isStopped { throw BartError.stopped }
        var made: Kept? = nil
        if create, let draft {
            let k = try Create.keepCreated(projectDir: context.project.dir, askId: logId, draft: draft)
            made = k
            meta.created = k.files.map { CreatedRow(name: $0.name, type: $0.type, path: $0.rel) }
            log?.amend(logId, [("created", .array(meta.created!.map { ["name": .string($0.name), "type": .string($0.type), "path": .string($0.path)] })), ("skipped", .array(k.skipped.map { .string($0) }))])
            if let library = config.createdLibrary { await Create.saveAllCreated(projectDir: context.project.dir, projectId: projectId, workspaceId: q.workspaceId, askId: logId, files: k.files, library: library) }
        }
        let named = AskPlan.taken(agent, plan, out.text)
        let body: String
        if let made {
            let line = await makingTask?.value ?? ""
            body = Create.createdBody(Create.createdSentence(made.files.isEmpty ? "" : Making.createdLine(line.isEmpty ? Create.requestSentence(plan.question) : line), out.text, plan.question), made, logId)
        } else if plan.welcome {
            body = Card.cardBody(AskPlan.welcomeReply(out.text, stage: plan.stage)).body
        } else {
            let events = seen.lock.withLock { seen.events }
            body = await citedBody(store: store, agent: agent, routed: q.routed, body: AskPlan.replyBody(agent, named.text), projectId: projectId, workspaceId: q.workspaceId,
                                   prior: plan.prior, question: q.text, logId: logId, context: context, events: events)
        }
        // Kept under what the document will say once this answer is in it: the next follow-up is found by that.
        if let s = out.session, let threads {
            threads.keep(AskPlan.threadKey(projectId, q.ref, plan.prior + [AskPlan.cleanTurn(Turn(question: q.text, answer: Reply.answerText(body)))]),
                         provider: plan.provider, session: s, projectId: projectId, workspaceId: q.workspaceId)
        }
        return AskAnswer(lines: Reply.replyLines(body, meta, model: !AskPlan.quiet.contains(agent), agent: agent), meta: meta, topic: named.topic, research: named.research, welcome: nil)
    }

    /// Chat's answer with its citations checked (2026-10-21, Cite): each against what it cites, before the answer is
    /// written and before its thread is kept. Should the library not be read, every citation is taken out.
    func citedBody(store: BartStore, agent: String, routed: Routed?, body: String, projectId: String, workspaceId: String, prior: [Turn], question: String,
                   logId: String, context: BartContext?, events: [JSONValue]) async -> String {
        guard AskPlan.citesChecked(agent, routed) else { return body }
        var o = Cite.Options()
        o.dataRoot = store.dataRoot
        o.workspaceId = workspaceId
        o.currentThread = prior.map { ($0.question, $0.answer) } + [(question, "")]
        if let project = try? store.findProject(projectId: projectId) {
            o.projectDir = project.dir
            o.workspaces = store.flattenWorkspaces(projectDir: project.dir).map { ($0, $0.dir(in: project.dir)) }
        }
        var checked: (body: String, kept: [CiteKept], dropped: [CiteDropped])
        if let library = try? await store.libraryDb.list() {
            o.library = library
            // What it read (2026-10-22): a whole source it cites must be among it; a page read by its address is kept first.
            let opened = context.map { readWhileAnswering($0, events) }
            if let opened { await SourceText.keepPageTexts(db: store.libraryDb, rows: library, opened: opened) }
            o.opened = opened
            let db = store.libraryDb
            o.readRowText = { row in (try? await db.texts(for: [row.id], max: SourceText.maxTextChars))?[row.id] }
            // A note on a highlight is citable (2026-10-23), on whichever copy of a paper added twice it was drawn.
            let files = SourceText.inkFiles(store: store, rows: library)
            o.readInk = { row in SourceText.readInk(files, row) }
            checked = await Cite.checkCitations(body, o)
        } else {
            o.readText = { _ in nil }
            checked = await Cite.checkCitations(body, o)
        }
        if !checked.kept.isEmpty || !checked.dropped.isEmpty {
            log?.amend(logId, [("citations", ["kept": .array(checked.kept.map { $0.json }), "dropped": .array(checked.dropped.map { $0.json })])])
        }
        return checked.body
    }

    /// What Chat read while it answered: the files and pages its tools opened, a kept text as its source, and the notes
    /// the documents mention, which its context held whole.
    func readWhileAnswering(_ context: BartContext, _ events: [JSONValue]) -> Set<String> {
        let entries = context.entries
        var texts: [String: String] = [:]
        for e in entries { if let t = e.text, let w = e.path ?? e.url { texts[t] = w } }
        return SourceText.openedBy(events, known: entries.compactMap { $0.path }, texts: texts, full: entries.filter { $0.mentioned && $0.type == "md" }.compactMap { $0.path })
    }

    // MARK: streams

    /// The same ask as an async stream of progress and a task for its answer: what the editor and the workspace consume.
    /// Each progress also goes out on EventHub as `engelbart:bart-progress` ({ askId, ...progress }) when `hub` is given.
    public func askStream(store: BartStore, projectId: String, _ q: AskRequest, hub: EventHub? = nil) -> (progress: AsyncStream<BartProgress>, answer: Task<AskAnswer, Error>) {
        let (stream, continuation) = AsyncStream<BartProgress>.makeStream()
        let task = Task { [self] in
            defer { continuation.finish() }
            return try await ask(store: store, projectId: projectId, q) { p in
                continuation.yield(p)
                hub?.post(BartEvents.progress, p.payload(askId: q.askId))
            }
        }
        return (stream, task)
    }
}
