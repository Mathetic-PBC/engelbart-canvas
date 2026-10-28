import Foundation
import EngelbartDoc
import EngelbartCore

// context/summarizer.cjs — one bounded model invocation: a note's text (and its current summary, when it has one) in, a
// catalog blurb out. The sweep decides when; this decides how. Two providers, switched in config.json (`summarizer`,
// read again for every call): openai (`codex exec`, its system prompt the AGENTS.md of a private CODEX_HOME) and
// anthropic (`claude -p --system-prompt-file`, settings, hooks, MCP servers, tools and CLAUDE.md all off). Both held to
// the subscription. One fresh process per note; the note travels in a 0600 temp file, never on a command line.

public struct SummaryError: Error, LocalizedError, Equatable {
    /// 'unavailable' (no CLI / not logged in) | 'too-long' | 'failed'
    public let kind: String
    public let message: String
    public init(_ kind: String, _ message: String) { self.kind = kind; self.message = message }
    public var errorDescription: String? { message }
}

/// config.json's `summarizer` block, normalized (store/home.cjs normalizeSummarizer).
public struct SummarizerSettings: Equatable, Sendable {
    public var provider: String
    public var openai: Rung
    public var anthropic: Rung
    public static let defaults = SummarizerSettings(provider: "openai", openai: Rung(model: "gpt-6-luna", effort: "high"), anthropic: Rung(model: "claude-opus-5-5", effort: "high"))
    static let aliases = ["openai": "openai", "codex": "openai", "anthropic": "anthropic", "claude": "anthropic"]
    static let efforts = ["low", "medium", "high", "xhigh", "max"]

    public static func normalize(_ value: JSONValue?) -> SummarizerSettings {
        let input = value?.object ?? [:]
        func step(_ name: String, _ fallback: Rung) -> Rung {
            let given = input[name]?.object ?? [:]
            let model = given["model"]?.string.flatMap { Models.modelIdRE.test($0) ? $0 : nil } ?? fallback.model
            let effort = given["effort"]?.string.flatMap { efforts.contains($0) ? $0 : nil } ?? fallback.effort
            return Rung(model: model, effort: effort)
        }
        return SummarizerSettings(provider: aliases[(input["provider"]?.string ?? "").lowercased()] ?? defaults.provider,
                                  openai: step("openai", defaults.openai), anthropic: step("anthropic", defaults.anthropic))
    }
    public subscript(provider: String) -> Rung { provider == "anthropic" ? anthropic : openai }
}

public struct SummaryResult: Sendable {
    public var summary: String
    /// { provider, model, effort, durationMs, costUsd, usage }
    public var meta: OJ
}

public typealias Summarize = @Sendable (_ name: String, _ text: String, _ currentSummary: String?, _ systemPrompt: String, _ stopper: AgentShell.Stopper) async throws -> SummaryResult

public enum Summarizer {
    public static let maxSummaryChars = 999 // "less than 1000 characters"
    public static let maxInputChars = 1_500_000 // beyond this a note does not fit a request; reported, never truncated
    static let timeout: TimeInterval = 300

    /// What the model is sent. Case 1 has no current summary; case 2 attaches it.
    public static func buildRequest(name: String?, text: String, currentSummary: String?, systemPrompt: String?) -> (system: String, input: String) {
        let safe = JSRegex("[<>\"\\n\\r]", "g").replace(name.flatMap { $0.isEmpty ? nil : $0 } ?? "note", with: " ").jsSlice(0, 200)
        var input = "<file name=\"\(safe)\">\n\(text)\n</file>"
        if let c = currentSummary, !c.isEmpty { input += "\n\n<current_summary>\n\(c)\n</current_summary>" }
        return (systemPrompt.flatMap { $0.isEmpty ? nil : $0 } ?? Prompts.summary, input)
    }

    /// A blurb that fits the column: one paragraph, under 1000 characters, cut at a sentence when the model overshoots.
    public static func fitSummary(_ raw: String?) -> String {
        let text = (raw ?? "").squashedSpaces
        if text.jsLength <= maxSummaryChars { return text }
        let head = text.jsSlice(0, maxSummaryChars)
        let stop = [". ", "? ", "! "].map { (head as NSString).range(of: $0, options: .backwards).location }.filter { $0 != NSNotFound }.max() ?? -1
        return (stop > 400 ? head.jsSlice(0, stop + 1) : "\(head.jsSlice(0, maxSummaryChars - 1).jsTrimEnd)…").jsTrim
    }

    /// The system prompt in force: <dataRoot>/.context/summary-system-prompt.md when it exists, else the built-in one.
    public static func loadSystemPrompt(_ dataRoot: String) -> String {
        if let custom = try? String(contentsOfFile: ((dataRoot as NSString).appendingPathComponent(".context") as NSString).appendingPathComponent("summary-system-prompt.md"), encoding: .utf8) {
            let t = custom.jsTrim; if !t.isEmpty { return t }
        }
        return Prompts.summary
    }

    /// The summarizer the app uses. `readSettings()` returns config.json's `summarizer` block, asked again on every call.
    public static func cli(readSettings: @escaping @Sendable () -> JSONValue?, environment: [String: String] = ProcessInfo.processInfo.environment, runDirectory: String,
                           codexHome: String, codexAuthFile: String? = nil, tools: BartTools? = nil, runner: AgentRunner? = nil) -> Summarize {
        let shell = AgentShell.resolveShell(environment)
        return { name, text, currentSummary, systemPrompt, stopper in
            if text.jsLength > maxInputChars { throw SummaryError("too-long", "\(name) is \(text.jsLength) characters, more than one request can carry") }
            let settings = SummarizerSettings.normalize(readSettings())
            let step = settings[settings.provider]
            let request = buildRequest(name: name, text: text, currentSummary: currentSummary, systemPrompt: systemPrompt)
            try FileManager.default.createDirectory(atPath: runDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let stem = (runDirectory as NSString).appendingPathComponent("summary-\(IDs.new())")
            try writePrivate("\(stem).input.txt", request.input)
            defer { removeFile("\(stem).input.txt") }
            let started = Date()
            let runIt: @Sendable () async throws -> (text: String, model: String, usage: JSONValue?, costUsd: Double?) = {
                if settings.provider == "anthropic" {
                    let promptFile = "\(stem).system.md"
                    try writePrivate(promptFile, request.system)
                    defer { removeFile(promptFile) }
                    let command = "exec \(AgentShell.program("claude", tools)) -p --output-format json --no-session-persistence --setting-sources \"\" --strict-mcp-config --tools \"\" --model \"$ENGELBART_SUMMARY_MODEL\" --effort \(step.effort) --system-prompt-file \"$ENGELBART_SUMMARY_PROMPT\" < \"$ENGELBART_SUMMARY_INPUT\""
                    let env = AgentShell.childEnvironment(environment, tools: tools, AgentShell.programEnv("claude", tools).merging(["ENGELBART_SUMMARY_MODEL": step.model, "ENGELBART_SUMMARY_PROMPT": promptFile, "ENGELBART_SUMMARY_INPUT": "\(stem).input.txt"]) { $1 })
                    let (stdout, failure) = await AgentShell.execute(shell: shell, command: command, cwd: runDirectory, env: env, timeout: timeout, stopper: stopper, runner: runner)
                    guard let result = lastResultLine(stdout) else {
                        throw SummaryError("unavailable", failure?.isNotFound == true ? "Claude Code was not found on the login shell PATH" : "Claude Code did not return a result\(failure.map { " (\($0.firstLine))" } ?? "")")
                    }
                    guard result["is_error"]?.bool != true, result["subtype"]?.string == "success", let t = result["result"]?.string, !t.jsTrim.isEmpty else {
                        throw SummaryError("failed", ((result["result"].flatMap(Activity.textOf)).flatMap { $0.isEmpty ? nil : $0 } ?? result["subtype"]?.string ?? "the model returned no text").jsSlice(0, 300))
                    }
                    let used = result["modelUsage"]?.object?.keys.sorted().first ?? step.model
                    return (t, used, result["usage"], result["total_cost_usd"]?.double)
                }
                guard prepareCodexHome(codexHome: codexHome, source: codexAuthSource(environment, codexAuthFile), instructions: request.system) else {
                    throw SummaryError("unavailable", "Codex is not signed in with a ChatGPT account (run `codex login`); an API key is never used for summaries")
                }
                let outFile = "\(stem).out.txt"
                defer { removeFile(outFile) }
                let command = "exec \(AgentShell.program("codex", tools)) exec --skip-git-repo-check --ephemeral -s read-only -m \"$ENGELBART_SUMMARY_MODEL\" -c 'model_reasoning_effort=\"\(step.effort)\"' -c project_doc_max_bytes=0 --color never --json -o \"$ENGELBART_SUMMARY_OUTPUT\" - < \"$ENGELBART_SUMMARY_INPUT\""
                let env = AgentShell.childEnvironment(environment, tools: tools, AgentShell.programEnv("codex", tools).merging(["CODEX_HOME": codexHome, "ENGELBART_SUMMARY_MODEL": step.model, "ENGELBART_SUMMARY_OUTPUT": outFile, "ENGELBART_SUMMARY_INPUT": "\(stem).input.txt"]) { $1 })
                let (stdout, failure) = await AgentShell.execute(shell: shell, command: command, cwd: runDirectory, env: env, timeout: timeout, stopper: stopper, runner: runner)
                let t = (try? String(contentsOfFile: outFile, encoding: .utf8)) ?? ""
                if t.jsTrim.isEmpty {
                    if failure?.isNotFound == true { throw SummaryError("unavailable", "Codex was not found on the login shell PATH") }
                    let reason = JSRegex("\\r?\\n").split(stdout).reversed().first { JSRegex("\"type\":\"error\"|^ERROR").test($0) } ?? failure?.firstLine ?? "Codex returned no message"
                    throw SummaryError("failed", reason.jsSlice(0, 300))
                }
                return (t, step.model, lastUsage(stdout), nil)
            }
            let out = try await (tools != nil ? tools!.use(Models.toolOf[settings.provider] ?? settings.provider, runIt) : runIt())
            return SummaryResult(summary: fitSummary(out.text), meta: ["provider": .string(settings.provider), "model": .string(out.model), "effort": .string(step.effort),
                                                                     "durationMs": .number((Date().timeIntervalSince(started) * 1000).rounded()),
                                                                     "costUsd": out.costUsd.map { .number($0) } ?? .null, "usage": out.usage.map(OJ.init) ?? .null])
        }
    }

    /// Test provider (ENGELBART_SUMMARY_FAKE=1, scripted runs only): no model, a recognisable blurb.
    public static let fake: Summarize = { name, text, currentSummary, _, _ in
        SummaryResult(summary: fitSummary("FAKE SUMMARY of \(name) (\(text.jsLength) characters).\(currentSummary != nil ? " Changed: regenerated after an edit." : "")"),
                      meta: ["provider": "fake", "model": "none", "durationMs": 0, "costUsd": 0])
    }
}

// context/sweeper.cjs — the summary sweep. While the app is open it looks at the library once a minute, and again right
// after launch and after the computer wakes. A note (an md tagged `note`) is dispatched when it has not been edited for 30
// minutes and it has no summary, or its summary is older than its last edit; first it must be longer than 1000
// characters (a shorter note keeps, or returns to, a null summary). A PDF follows the same clock by its file's
// modification time: its "Abstract" section, when it prints one, is its summary with no model run; else it is summarized
// from its extracted text. Afterwards every project's .context/catalog.json is brought up to date. Before any of that,
// the text pass (MATH-29): every PDF's text kept in library_text for search, as soon as its file is there and whenever
// it changes; alone when summaries are off. Status in <dataRoot>/.context/status.json.
public final class Sweeper: @unchecked Sendable {
    public struct Options {
        public var quietMs: Double = 30 * 60_000
        public var minChars = 1000
        public var intervalMs: Double = 60_000
        public var firstDelayMs: Double = 5_000
        public var perSweep = 5
        public var textsPerSweep = Int.max
        public var summaries = true
        public init() {}
        /// ENGELBART_SUMMARIES=off, ENGELBART_SUMMARY_QUIET_MS, ENGELBART_SUMMARY_INTERVAL_MS (scripted runs only).
        public static func from(environment: [String: String]) -> Options {
            var o = Options()
            func millis(_ name: String) -> Double? { environment[name].flatMap(Double.init).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } }
            if let q = millis("ENGELBART_SUMMARY_QUIET_MS") { o.quietMs = q }
            if let i = millis("ENGELBART_SUMMARY_INTERVAL_MS") { o.intervalMs = i }
            o.summaries = environment["ENGELBART_SUMMARIES"] != "off"
            return o
        }
    }

    let getStore: @Sendable () async -> BartStore
    let summarize: Summarize
    let options: Options
    let now: @Sendable () -> Double
    let log: @Sendable (OJ) -> Void
    private let lock = NSLock()
    private var retry: [String: (attempts: Int, at: Double)] = [:]
    private var papers: [String: (modified: Double, nothing: Bool)] = [:]
    private var pausedUntil: Double = 0
    private var spentUsd: Double = 0
    private var last: OJ? = nil
    private var running: Task<OJ?, Never>? = nil
    private var reading: Task<Void, Never>? = nil
    private var inFlight: AgentShell.Stopper? = nil
    private var stopping = false
    private var timer: DispatchSourceTimer? = nil
    private var soon: DispatchWorkItem? = nil

    public init(getStore: @escaping @Sendable () async -> BartStore, summarize: @escaping Summarize, options: Options = Options(),
                now: @escaping @Sendable () -> Double = { Time.ms() }, log: @escaping @Sendable (OJ) -> Void = { _ in }) {
        self.getStore = getStore; self.summarize = summarize; self.options = options; self.now = now; self.log = log
    }

    final class Report: @unchecked Sendable {
        var at: String; var dispatched = 0, extracted = 0, texts = 0
        var summarized: [OJ] = [], abstracts: [String] = [], cleared: [String] = [], short: [String] = [], pending: [String] = [], discarded: [String] = [], missing: [String] = [], failed: [OJ] = [], catalogs: [String] = []
        init(at: String) { self.at = at }
        func json(full: Bool = true) -> [(String, OJ)] {
            func strs(_ a: [String]) -> OJ { .array(a.map { .string($0) }) }
            if !full { return [("at", .string(at)), ("texts", .number(Double(texts))), ("failed", .array(failed))] }
            return [("at", .string(at)), ("dispatched", .number(Double(dispatched))), ("extracted", .number(Double(extracted))), ("texts", .number(Double(texts))),
                    ("summarized", .array(summarized)), ("abstracts", strs(abstracts)), ("cleared", strs(cleared)), ("short", strs(short)), ("pending", strs(pending)),
                    ("discarded", strs(discarded)), ("missing", strs(missing)), ("failed", .array(failed)), ("catalogs", strs(catalogs))]
        }
    }

    static let minute: Double = 60_000
    static func mtime(_ path: String) -> Double? { ((try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 } }
    static func message(_ e: Error) -> String { String(((e as? SummaryError)?.message ?? (e as? LocalizedError)?.errorDescription ?? "\(e)").prefix(300)) }

    /// One model call for one row, under the shared limits. `stillCurrent` says whether the source changed meanwhile.
    func dispatch(_ store: BartStore, _ row: LibraryRow, _ text: String, _ report: Report, _ stillCurrent: () async -> Bool) async {
        let t = now()
        let waiting = lock.withLock { retry[row.id] }
        if (waiting.map { $0.at > t } ?? false) || lock.withLock({ pausedUntil }) > t || report.dispatched >= options.perSweep { report.pending.append(row.name); return }
        report.dispatched += 1
        let readAt = Date(timeIntervalSince1970: t / 1000)
        let stopper = AgentShell.Stopper()
        lock.withLock { inFlight = stopper }
        defer { lock.withLock { inFlight = nil } }
        do {
            let out = try await summarize(row.name, text, row.summary, Summarizer.loadSystemPrompt(store.dataRoot), stopper)
            if !(await stillCurrent()) { report.discarded.append(row.name); return }
            try await store.libraryDb.setSummary(row.id, summary: out.summary, readAt: readAt)
            lock.withLock { retry[row.id] = nil; if let c = out.meta["costUsd"]?.double { spentUsd += c } }
            report.summarized.append(OJ.object([("name", .string(row.name)), ("updated", .bool(row.summary != nil))] + (out.meta.pairs ?? [])))
        } catch {
            let kind = (error as? SummaryError)?.kind ?? (error as? BartError)?.kind ?? "failed"
            if kind == "unavailable" { lock.withLock { pausedUntil = now() + 10 * Sweeper.minute } }
            let attempts = (waiting?.attempts ?? 0) + 1
            let minutes = min(8 * 60, kind == "too-long" ? 24 * 60 : 5 * pow(2, Double(attempts - 1)))
            lock.withLock { retry[row.id] = (attempts, now() + minutes * Sweeper.minute) }
            report.failed.append(["name": .string(row.name), "kind": .string(kind), "message": .string(Sweeper.message(error))])
        }
    }

    func considerNote(_ store: BartStore, _ row: LibraryRow, _ report: Report) async {
        guard let path = row.path, let text = try? String(contentsOfFile: path, encoding: .utf8) else { report.missing.append(row.name); return }
        if text.jsLength != row.charCount { try? await store.libraryDb.setCharCount(row.id, text.jsLength) }
        if text.jsLength <= options.minChars {
            if row.summary != nil { try? await store.libraryDb.setSummary(row.id, summary: nil, readAt: nil); report.cleared.append(row.name) } else { report.short.append(row.name) }
            return
        }
        await dispatch(store, row, text, report) {
            guard let fresh = (try? await store.libraryDb.get(row.id)) ?? nil else { return false }
            return fresh.lastEdited == row.lastEdited
        }
    }

    // A PDF is "edited" when its file changes. If it prints an Abstract, that text is the summary and no model runs.
    func considerPaper(_ store: BartStore, _ row: LibraryRow, _ report: Report) async {
        guard let path = row.path, JSRegex("\\.pdf$", "i").test(path) else { return }
        guard let modified = Sweeper.mtime(path) else { report.missing.append(row.name); return }
        if now() - modified < options.quietMs { return } // changed within the last 30 minutes
        if row.summary != nil, let edited = row.summaryEdited.flatMap(Time.parse), edited.timeIntervalSince1970 * 1000 >= modified { return }
        if let known = lock.withLock({ papers[row.id] }), known.modified == modified && known.nothing { return }
        if report.extracted >= options.perSweep { report.pending.append(row.name); return }
        report.extracted += 1
        let readAt = Date(timeIntervalSince1970: now() / 1000)
        let abstract: String?
        do { abstract = try PdfText.extractAbstract(path) } catch {
            report.failed.append(["name": .string(row.name), "kind": "unreadable", "message": .string(Sweeper.message(error))])
            lock.withLock { papers[row.id] = (modified, true) }
            return
        }
        if let abstract {
            try? await store.libraryDb.setSummary(row.id, summary: abstract, readAt: readAt)
            report.abstracts.append(row.name)
            return
        }
        let text = (try? PdfText.extractText(path)) ?? ""
        if text.jsLength <= options.minChars { // scanned, or nearly empty: nothing to summarize
            if row.summary != nil { try? await store.libraryDb.setSummary(row.id, summary: nil, readAt: nil); report.cleared.append(row.name) }
            lock.withLock { papers[row.id] = (modified, true) }
            return
        }
        await dispatch(store, row, text, report) { Sweeper.mtime(path) == modified }
    }

    /// A PDF's text, read when its file is new or has changed since it was last read.
    func considerText(_ store: BartStore, _ row: LibraryRow, _ stamps: [String: Double], _ report: Report) async {
        guard !lock.withLock({ stopping }), let path = row.path, JSRegex("\\.pdf$", "i").test(path), let modified = Sweeper.mtime(path) else { return }
        if stamps[row.id] == modified { return } // read since it last changed
        if report.texts >= options.textsPerSweep { return }
        report.texts += 1
        let text = (try? PdfText.extractText(path)) ?? ""
        do { try await store.libraryDb.setText(row.id, text: text, modified: modified) }
        catch { report.failed.append(["name": .string(row.name), "kind": "text", "message": .string(Sweeper.message(error))]) }
    }

    /// One text pass at a time, whether a sweep runs it or a beat does while a sweep waits on a summary.
    func readTexts(_ store: BartStore, _ report: Report) async {
        let task: Task<Void, Never> = lock.withLock {
            if let r = reading { return r }
            let t = Task { [self] in
                let stamps = (try? await store.libraryDb.textStamps()) ?? [:]
                for row in (try? await store.libraryDb.papersWithFiles()) ?? [] { await considerText(store, row, stamps, report) }
                lock.withLock { reading = nil }
            }
            reading = t
            return t
        }
        await task.value
    }

    func sweepOnce() async -> OJ {
        let store = await getStore()
        let report = Report(at: Time.iso(Date(timeIntervalSince1970: now() / 1000)))
        await readTexts(store, report)
        if options.summaries {
            for row in (try? await store.libraryDb.uncountedNotes()) ?? [] {
                if let p = row.path, let t = try? String(contentsOfFile: p, encoding: .utf8) { try? await store.libraryDb.setCharCount(row.id, t.jsLength) }
            }
            store.recountWorkspaces()
            for row in (try? await store.libraryDb.summaryCandidates(before: Date(timeIntervalSince1970: (now() - options.quietMs) / 1000), minChars: options.minChars)) ?? [] { await considerNote(store, row, report) }
            for row in (try? await store.libraryDb.papersWithFiles()) ?? [] { await considerPaper(store, row, report) }
            let rows = (try? await store.libraryDb.list()) ?? []
            var projects: [(ProjectRecord, [WorkspaceRecord], [String: String?])] = []
            for p in store.projects() {
                let ws = store.flattenWorkspaces(projectDir: p.dir)
                projects.append((p, ws, await store.notesMadeIn(projectDir: p.dir, workspaces: ws)))
            }
            report.catalogs = Catalog.writeCatalogs(projects: projects.map { (project: $0.0, workspaces: $0.1, madeIn: $0.2) }, rows: rows, now: Date(timeIntervalSince1970: now() / 1000))
        }
        let interesting = report.texts > 0 || !report.summarized.isEmpty || !report.abstracts.isEmpty || !report.cleared.isEmpty || !report.failed.isEmpty || !report.discarded.isEmpty || !report.catalogs.isEmpty
        if interesting || lock.withLock({ last == nil }) {
            let paused = lock.withLock { pausedUntil }, spent = lock.withLock { spentUsd }
            let status = OJ.object(report.json() + [("providerPausedUntil", paused > now() ? .string(Time.iso(Date(timeIntervalSince1970: paused / 1000))) : .null),
                                                    ("spentUsdThisRun", .number((spent * 10000).rounded() / 10000))])
            lock.withLock { last = status }
            try? writeJSONFile(URL(fileURLWithPath: ((store.dataRoot as NSString).appendingPathComponent(".context") as NSString).appendingPathComponent("status.json")), status)
            log(status)
        }
        return .object(report.json())
    }

    /// One sweep; a second asked while one runs gets that one.
    @discardableResult
    public func sweep() async -> OJ? {
        let task: Task<OJ?, Never> = lock.withLock {
            if let r = running { return r }
            let t = Task<OJ?, Never> { [self] in
                let out = await sweepOnce()
                lock.withLock { running = nil }
                return out
            }
            running = t
            return t
        }
        return await task.value
    }

    /// A beat (the minute, launch, wake, a PDF just added). A sweep still under way may be waiting on a summary: the text
    /// pass then runs by itself rather than after it.
    func beat() {
        if lock.withLock({ running != nil }) {
            Task { [self] in
                let report = Report(at: Time.iso(Date(timeIntervalSince1970: now() / 1000)))
                await readTexts(await getStore(), report)
                if report.texts > 0 || !report.failed.isEmpty { log(.object(report.json(full: false))) }
            }
        } else { Task { await sweep() } }
    }

    public func start() {
        lock.lock(); defer { lock.unlock() }
        if timer != nil { return }
        stopping = false
        let first = DispatchWorkItem { [weak self] in self?.lock.withLock { self?.soon = nil }; self?.beat() }
        soon = first
        DispatchQueue.global().asyncAfter(deadline: .now() + options.firstDelayMs / 1000, execute: first)
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now() + options.intervalMs / 1000, repeating: options.intervalMs / 1000)
        t.setEventHandler { [weak self] in self?.beat() }
        t.resume()
        timer = t
    }

    /// A beat soon (a pdf added, the computer woke): 1.5 s by default.
    public func sweepSoon(delayMs: Double = 1500) {
        let work = DispatchWorkItem { [weak self] in self?.lock.withLock { self?.soon = nil }; self?.beat() }
        lock.withLock { soon?.cancel(); soon = work }
        DispatchQueue.global().asyncAfter(deadline: .now() + delayMs / 1000, execute: work)
    }

    /// No further PDF is read (the one being read finishes); a summary under way is stopped.
    public func stop() async {
        let (r, t, f) = lock.withLock { () -> (Task<OJ?, Never>?, Task<Void, Never>?, AgentShell.Stopper?) in
            stopping = true
            timer?.cancel(); timer = nil; soon?.cancel(); soon = nil
            return (running, reading, inFlight)
        }
        f?.stop()
        _ = await r?.value
        await t?.value
    }

    public func status() -> OJ? { lock.withLock { last } }
}
