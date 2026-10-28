import CryptoKit
import Foundation
import EngelbartCore

// src/main/agent-map/benchmark.cjs (2026-10-13; David's runs and agents 2026-10-14): the Agent Viewer's Benchmark tab.
// Every question one agent answered in the notes (Chat, Brainstorm, Discover or Create, by the name its closing line
// starts with), the answer the note keeps (old) beside the same question asked again through that agent's own path under
// its prompt as it is now (new), and a note the person writes on each. The questions are read from every .md under each
// project's folder (its notes and its workspaces' workspace.md, not trash, archives, assets or builds) with the editor's
// own reading of a document (Doc's threads: the app provides it), each turn whose answer ends with its `*Chat · …*`
// closing line, with the turns of its thread before it. Nothing here writes to a note, the library or a document.
// A replay is asked through the agent's own path (Bart's ask, read-only tools), on the model and effort the old closing
// line names; it is sent the document cut off at the question line, or the message the run log recorded for the same
// question. New answers and notes are kept in <userData>/chat-benchmark.json: { runs: [{ id, name, at, entries }],
// current, agent }, by note path and question, each answer with the hash of the prompt it was made under. Only the newest
// run is asked into; an earlier one keeps its answers and notes. A file from before runs is its "Run 1".

/// One turn of a thread as the editor reads it (doc.js threads + turnText).
public struct BenchmarkTurn: Sendable, Equatable {
    public var question: String
    public var answer: String
    /// The closing line's text (`*Chat · Opus · high · 41 s*`), nil when the turn has none.
    public var foot: String?
    /// The question's line index in the document.
    public var q: Int
    public var agent: String?
    public init(question: String, answer: String, foot: String?, q: Int, agent: String? = nil) {
        self.question = question; self.answer = answer; self.foot = foot; self.q = q; self.agent = agent
    }
}

/// One question found: its answer kept, the turns before it, its closing line, the document's lines.
public struct BenchmarkEntry: Sendable, Equatable {
    public var key: String = ""
    public var question: String
    public var old: String
    public var turns: [BenchmarkTurn]
    public var foot: String
    public var q: Int
    public var lines: [String]
}

public struct BenchmarkGroup: Sendable, Equatable {
    public var rel: String
    public var name: String
    public var projectId: String
    public var workspaceId: String?
    public var ref: JSONValue?
    public var title: String
    public var kind: String
    public var agent: String
    public var entries: [BenchmarkEntry]
}

/// A replay to ask (benchmark.cjs's job).
public struct BenchmarkJob: Sendable {
    public var projectId: String
    public var workspaceId: String
    public var ref: JSONValue
    public var agent: String
    public var question: String
    public var turns: [BenchmarkTurn]
    public var foot: String
    public var message: String
}

/// What the benchmark needs from the rest of the app: the projects and notes (Store), the editor's reading of a
/// document (Doc), the agents (Bart).
public protocol BenchmarkSource: AnyObject {
    /// AGENT_NAMES of bart/reply.cjs, in the tab's order: [("bart","Chat"), ("brainstorm","Brainstorm"), …].
    var agentNames: [(id: String, name: String)] { get }
    var dataRoot: String { get }
    /// Every project: its id, name and folder.
    func projects() -> [(id: String, name: String, dir: String)]
    /// A project's workspaces (projects.flattenWorkspaces): id, path under the project, the library ids in its context.
    func workspaces(projectDir: String) -> [(id: String, path: String, context: [String])]
    /// The library's rows that are files: id and path.
    func libraryRows() async -> [(id: String, path: String)]
    /// projects.notesMadeIn: note row id → the workspace it was made in.
    func notesMadeIn(projectDir: String) async -> [String: String]
    /// Every thread of a document, its turns in order (doc.js parseLines + threads + turnText).
    func threads(_ lines: [String]) -> [[BenchmarkTurn]]
    /// loadSystemPrompt(dataRoot, agent).
    func systemPrompt(agent: String) -> String
    /// messageFor: the message a replay is sent before its <level> (Bart's buildContext, expandMentions…).
    func message(group: BenchmarkGroup, entry: BenchmarkEntry) async throws -> String
    /// The agent asked through its own path, the first message replaced by `job.message` → the answer without its
    /// closing line. Cancelled when the replay is stopped.
    func ask(_ job: BenchmarkJob) async throws -> String
}

public enum BenchmarkText {
    /// How many replays run at once.
    public static let atOnce = 3
    public static let mark = "benchmark"
    static let skip: Set<String> = ["assets", "builds"]

    public static func hashOf(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description }
    public static func keyOf(_ rel: String, _ question: String) -> String { "\(rel)\n\(question)" }

    /// Every .md under a project's folder, sorted, outside dot folders, top-level assets and builds, and *.pglite.
    public static func markdownFiles(_ dir: String, depth: Int = 0) -> [String] {
        if depth > 32 { return [] }
        var out: [String] = []
        for name in FileOps.list(dir).sorted(by: { $0.localizedCompare($1) == .orderedAscending }) {
            if name.hasPrefix(".") { continue }
            let full = join(dir, name)
            if FileOps.isDirectory(full) {
                if !(depth == 0 && skip.contains(name)) && !name.hasSuffix(".pglite") { out += markdownFiles(full, depth: depth + 1) }
            } else if name.hasSuffix(".md") { out.append(full) }
        }
        return out
    }

    /// The model and effort a closing line names (`*Chat · Opus · high · 41 s*` → (Opus, high)), or nil.
    public static func footChoice(_ foot: String?) -> (name: String, effort: String)? {
        let inner = re("^\\*|\\*$").replace(foot ?? "", with: "")
        let parts = inner.components(separatedBy: " · ")
        if parts.count < 3 || re("^\\d").test(parts[1]) { return nil }
        return (parts[1].trimmingCharacters(in: .whitespaces), parts[2].trimmingCharacters(in: .whitespaces))
    }

    /// An answer without the closing lines left at its end.
    public static func withoutFeet(_ answer: String) -> String {
        var lines = answer.components(separatedBy: "\n")
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty || re("^\\*[^*]+\\*$").test(last.trimmingCharacters(in: .whitespaces)) { lines.removeLast() }
        return lines.joined(separator: "\n")
    }

    static func footRE(_ name: String) -> NSRegularExpression { re("^\\*\(NSRegularExpression.escapedPattern(for: name))(?: · [^*]*)?\\*$") }

    /// One agent's questions in one document: each turn whose answer closes with its line.
    public static func questionsIn(_ text: String, threads: [[BenchmarkTurn]], agentName: String) -> [BenchmarkEntry] {
        let lines = text.components(separatedBy: "\n")
        let foot = footRE(agentName)
        var out: [BenchmarkEntry] = []
        for thread in threads {
            var earlier: [BenchmarkTurn] = []
            for turn in thread {
                if let f = turn.foot, foot.test(f) {
                    out.append(BenchmarkEntry(question: turn.question, old: withoutFeet(turn.answer), turns: earlier, foot: f, q: turn.q, lines: lines))
                }
                earlier.append(turn)
            }
        }
        return out
    }

    /// The message a recorded run of this question was first sent, everything before its <level>; nil when none.
    public static func recordedMessage(_ runLog: AgentRunLog?, question: String, agent: String = "bart") -> String? {
        guard let runLog, let found = runLog.list().first(where: { $0["agent"]?.string == agent && ($0["question"]?.stringish ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == question }),
              let id = found["id"]?.string, let run = runLog.get(id) else { return nil }
        let input = run["steps"]?[0]?["input"]?.stringish ?? ""
        guard let range = input.range(of: "\n\n<level>"), range.lowerBound > input.startIndex, input.contains("<context_json>") else { return nil }
        return String(input[..<range.lowerBound])
    }

    /// The { model, effort } choice the old closing line names, when the models know it. `models`: per provider,
    /// its models (key → name) and efforts.
    public static func choiceOf(_ foot: String?, models: [(models: [(key: String, name: String)], efforts: [String])]) -> (model: String, effort: String?)? {
        guard let named = footChoice(foot) else { return nil }
        for provider in models {
            for model in provider.models where model.name == named.name {
                return (model.key, provider.efforts.contains(named.effort) ? named.effort : nil)
            }
        }
        return nil
    }

    /// Every question one agent answered in the notes of every project, by note, in document order.
    public static func collectQuestions(_ src: BenchmarkSource, agent: String) async -> [BenchmarkGroup] {
        let name = src.agentNames.first { $0.id == agent }?.name ?? "Chat"
        let said = re("^bart\\+?> \\*\(NSRegularExpression.escapedPattern(for: name))", .anchorsMatchLines)
        let rows = await src.libraryRows()
        let records = src.projects()
        var groups: [BenchmarkGroup] = []
        for project in records {
            let workspaces = src.workspaces(projectDir: project.dir)
            var madeIn: [String: String] = [:]
            for file in markdownFiles(project.dir) {
                guard let text = FileOps.read(file), said.test(text) else { continue }
                let found = questionsIn(text, threads: src.threads(text.components(separatedBy: "\n")), agentName: name)
                if found.isEmpty { continue }
                let inProject = relative(file, to: project.dir), rel = relative(file, to: src.dataRoot)
                var workspaceId: String?, ref: JSONValue?, label: String
                let isWorkspace = (file as NSString).lastPathComponent == "workspace.md"
                if isWorkspace {
                    let at = (inProject as NSString).deletingLastPathComponent
                    workspaceId = workspaces.first { $0.path == at }?.id
                    ref = workspaceId.map { ["kind": "workspace", "workspaceId": .string($0)] }
                    label = at
                } else {
                    let row = rows.first { ($0.path as NSString).standardizingPath == file }
                    if row != nil && madeIn.isEmpty { madeIn = await src.notesMadeIn(projectDir: project.dir) }
                    let home = row.flatMap { madeIn[$0.id] }
                    let workspace = workspaces.first { $0.id == home } ?? workspaces.first { w in w.context.contains(row?.id ?? "\u{0}") } ?? workspaces.first
                    workspaceId = workspace?.id
                    ref = row.map { ["kind": "note", "id": .string($0.id)] } ?? workspaceId.map { ["kind": "workspace", "workspaceId": .string($0)] }
                    label = inProject.hasSuffix(".md") ? String(inProject.dropLast(3)) : inProject
                }
                var seen: [String: Int] = [:]
                let entries = found.map { entry -> BenchmarkEntry in
                    let base = agent == "bart" ? keyOf(rel, entry.question) : "\(agent)\n\(keyOf(rel, entry.question))"
                    let n = (seen[base] ?? 0) + 1
                    seen[base] = n
                    var e = entry
                    e.key = n > 1 ? "\(base)\n\(n)" : base
                    return e
                }
                let title = isWorkspace ? ((file as NSString).deletingLastPathComponent as NSString).lastPathComponent : ((file as NSString).lastPathComponent as NSString).deletingPathExtension
                groups.append(BenchmarkGroup(rel: rel, name: records.count > 1 ? "\(project.name) / \(label)" : label, projectId: project.id, workspaceId: workspaceId,
                                             ref: ref, title: title, kind: isWorkspace ? "workspace" : "note", agent: agent, entries: entries))
            }
        }
        return groups
    }

    static func relative(_ path: String, to base: String) -> String {
        let b = (base as NSString).standardizingPath, p = (path as NSString).standardizingPath
        return p.hasPrefix(b + "/") ? String(p.dropFirst(b.count + 1)) : p
    }
}

/// The benchmark itself (createChatBenchmark): runs, answers, notes, replays `atOnce` at a time; each change told to
/// subscribers ({ run, key, new, running }; the app posts it as `engelbart:chat-benchmark`).
@MainActor
public final class ChatBenchmark {
    let file: String
    let source: BenchmarkSource
    let runLog: AgentRunLog?
    let now: () -> String
    let atOnce: Int
    private var kept: JSONValue?
    private var groups: [BenchmarkGroup]?
    private var running: [String: Task<Void, Never>] = [:]
    private var listeners: [UUID: (JSONValue) -> Void] = [:]
    private var queue: [String] = []
    private var workers = 0

    public init(file: String, source: BenchmarkSource, runLog: AgentRunLog? = nil, now: @escaping () -> String = { Time.iso() }, atOnce: Int = BenchmarkText.atOnce) {
        self.file = file; self.source = source; self.runLog = runLog; self.now = now; self.atOnce = atOnce
    }

    var agentIds: [String] { source.agentNames.map(\.id) }
    func agentOf(_ value: String?) -> String { value.flatMap { agentIds.contains($0) ? $0 : nil } ?? "bart" }

    static func freshRun(_ n: Int, _ at: String) -> JSONValue { ["id": .string("run-\(n)"), "name": .string("Run \(n)"), "at": .string(at), "entries": .object([:])] }

    /// The file as runs; one from before runs is its Run 1, dated by its first answer.
    func load() -> JSONValue {
        if let kept { return kept }
        let value = FileOps.readJSON(file)
        var out: JSONValue
        if let runs = value?["runs"]?.array, !runs.isEmpty { out = value! }
        else if let entries = value?["entries"]?.object, !entries.isEmpty {
            let dates = entries.values.compactMap { $0["at"]?.string }.sorted()
            out = ["runs": [Self.freshRun(1, dates.first ?? now()).with("entries", .object(entries))], "current": "run-1"]
        } else { out = ["runs": [Self.freshRun(1, now())], "current": "run-1"] }
        let runs = out["runs"]?.array ?? []
        if !runs.contains(where: { $0["id"] == out["current"] }) { out = out.with("current", runs.last?["id"] ?? "run-1") }
        out = out.with("agent", .string(agentOf(out["agent"]?.string)))
        kept = out
        return out
    }

    func save() {
        let text = JSONText.stringify(load(), indent: 1)
        FileOps.mkdir((file as NSString).deletingLastPathComponent)
        try? FileOps.write(text, to: file, mode: 0o600)
    }

    func runs() -> [JSONValue] { load()["runs"]?.array ?? [] }
    func runOf(_ id: String) -> JSONValue? { runs().first { $0["id"]?.string == id } }
    func latestId() -> String { runs().last?["id"]?.string ?? "run-1" }
    var current: String { load()["current"]?.string ?? "run-1" }
    func which(_ id: String?) -> String { id ?? current }
    func held(_ id: String, _ key: String) -> JSONValue { runOf(id)?["entries"]?[key] ?? .object([:]) }

    func setEntry(_ id: String, _ key: String, _ value: JSONValue) {
        var all = runs()
        guard let i = all.firstIndex(where: { $0["id"]?.string == id }) else { return }
        var entries = all[i]["entries"]?.object ?? [:]
        entries[key] = value
        all[i] = all[i].with("entries", .object(entries))
        kept = load().with("runs", .array(all))
    }

    static func slot(_ id: String, _ key: String) -> String { JSONText.stringify([.string(id), .string(key)]) }

    func shownNew(_ id: String, _ key: String) -> JSONValue {
        if running[Self.slot(id, key)] != nil { return ["running": true] }
        let entry = held(id, key)
        if let answer = entry["answer"]?.string { return ["answer": .string(answer)] }
        if let error = entry["error"]?.string { return ["error": .string(error)] }
        return .object([:])
    }

    func changed(_ id: String, _ key: String) {
        let change: JSONValue = ["run": .string(id), "key": .string(key), "new": shownNew(id, key), "running": .bool(!running.isEmpty)]
        for listener in listeners.values { listener(change) }
    }

    func find(_ key: String) -> (BenchmarkGroup, BenchmarkEntry)? {
        for group in groups ?? [] { if let entry = group.entries.first(where: { $0.key == key }) { return (group, entry) } }
        return nil
    }

    private func replay(_ id: String, _ key: String) async {
        let at = Self.slot(id, key)
        guard let (group, entry) = find(key), running[at] == nil, runOf(id) != nil else { return }
        let task = Task { @MainActor in
            let agent = self.agentOf(group.agent)
            do {
                guard let workspaceId = group.workspaceId, let ref = group.ref else { throw BenchmarkError(message: "This note belongs to no workspace to ask from.") }
                let system = self.source.systemPrompt(agent: agent)
                var message = BenchmarkText.recordedMessage(self.runLog, question: entry.question, agent: agent)
                if message == nil { message = try await self.source.message(group: group, entry: entry) }
                let answer = try await self.source.ask(BenchmarkJob(projectId: group.projectId, workspaceId: workspaceId, ref: ref, agent: agent, question: entry.question,
                                                                    turns: entry.turns, foot: entry.foot, message: message!))
                if Task.isCancelled { return }
                var e = self.held(id, key).object ?? [:]
                e["error"] = nil
                e["answer"] = .string(answer); e["promptHash"] = .string(BenchmarkText.hashOf(system)); e["at"] = .string(self.now())
                self.setEntry(id, key, .object(e)); self.save()
            } catch {
                if Task.isCancelled || error is CancellationError { return }
                var e = self.held(id, key).object ?? [:]
                e["answer"] = nil
                e["error"] = .string(error.localizedDescription.isEmpty ? "The run failed." : error.localizedDescription)
                e["promptHash"] = .string(BenchmarkText.hashOf(self.source.systemPrompt(agent: agent))); e["at"] = .string(self.now())
                self.setEntry(id, key, .object(e)); self.save()
            }
        }
        running[at] = task
        changed(id, key)
        await task.value
        running[at] = nil
        changed(id, key)
    }

    private func pump() {
        while workers < atOnce, !queue.isEmpty {
            let slot = queue.removeFirst()
            guard let pair = (try? JSONValue.parse(slot))?.array, pair.count == 2 else { continue }
            workers += 1
            Task { @MainActor in
                await self.replay(pair[0].stringish, pair[1].stringish)
                self.workers -= 1
                self.pump()
            }
        }
    }

    /// Every entry by note with its old answer, its new one in the run shown and its note; the runs, which is shown,
    /// whether it can be asked into; the agents and whose questions are shown. `id`/`agent`: shown from now on.
    public func list(_ id: String? = nil, agent: String? = nil) async -> JSONValue {
        if let id, runOf(id) != nil, current != id { kept = load().with("current", .string(id)); save() }
        if let agent, agentIds.contains(agent), load()["agent"]?.string != agent { kept = load().with("agent", .string(agent)); save() }
        groups = await BenchmarkText.collectQuestions(source, agent: load()["agent"]?.string ?? "bart")
        let shown = current
        return [
            "running": .bool(!running.isEmpty),
            "agents": .array(source.agentNames.map { ["id": .string($0.id), "name": .string($0.name)] }),
            "agent": load()["agent"] ?? "bart",
            "runs": .array(runs().map { ["id": $0["id"] ?? .null, "name": $0["name"] ?? .null, "at": $0["at"] ?? .null] }),
            "current": .string(shown),
            "live": .bool(shown == latestId()),
            "groups": .array((groups ?? []).map { group in
                ["name": .string(group.name), "rel": .string(group.rel), "entries": .array(group.entries.map { e in
                    ["key": .string(e.key), "question": .string(e.question), "old": .string(e.old), "new": shownNew(shown, e.key), "note": .string(held(shown, e.key)["note"]?.string ?? "")]
                })]
            }),
        ]
    }

    /// Replays every question with no new answer yet in the newest run, `atOnce` at a time. → whether anything runs
    @discardableResult
    public func run(_ id: String? = nil) async -> Bool {
        if groups == nil { _ = await list() }
        let into = which(id)
        if into != latestId() { return false }
        let waiting = Set(queue)
        for group in groups ?? [] {
            for entry in group.entries {
                let at = Self.slot(into, entry.key)
                if held(into, entry.key)["answer"]?.string == nil && running[at] == nil && !waiting.contains(at) { queue.append(at) }
            }
        }
        pump()
        await Task.yield()
        return !running.isEmpty || workers > 0
    }

    /// Replays one question again in the newest run, whatever it has.
    @discardableResult
    public func runOne(_ key: String, _ id: String? = nil) async -> Bool {
        if groups == nil { _ = await list() }
        let into = which(id)
        guard find(key) != nil, into == latestId() else { return false }
        let at = Self.slot(into, key)
        queue.removeAll { $0 == at }
        Task { @MainActor in await self.replay(into, key) }
        return true
    }

    /// A new run, empty, after the others, and shown. → its id
    public func newRun() -> String {
        let n = runs().reduce(0) { max($0, Int(($1["id"]?.stringish ?? "").replacingOccurrences(of: "run-", with: "")) ?? 0) } + 1
        kept = load().with("runs", .array(runs() + [Self.freshRun(n, now())])).with("current", .string("run-\(n)"))
        save()
        return "run-\(n)"
    }

    /// Stops every replay running and every one waiting.
    @discardableResult
    public func stop() -> Bool {
        queue = []
        for task in running.values { task.cancel() }
        return true
    }

    /// The note under an entry, in the run shown or the run named.
    @discardableResult
    public func setNote(_ key: String, _ text: String, _ id: String? = nil) -> Bool {
        guard !key.isEmpty, runOf(which(id)) != nil else { return false }
        var e = held(which(id), key).object ?? [:]
        e["note"] = .string(jsSlice(text, 100_000))
        setEntry(which(id), key, .object(e))
        save()
        return true
    }

    /// Each change: { run, key, new, running }. → unsubscribe
    @discardableResult
    public func subscribe(_ listener: @escaping (JSONValue) -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = listener
        return { [weak self] in self?.listeners[id] = nil }
    }

    /// Waits until nothing runs or waits (tests).
    public func idle() async { while !running.isEmpty || !queue.isEmpty || workers > 0 { try? await Task.sleep(nanoseconds: 5_000_000) } }
}

public struct BenchmarkError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}
