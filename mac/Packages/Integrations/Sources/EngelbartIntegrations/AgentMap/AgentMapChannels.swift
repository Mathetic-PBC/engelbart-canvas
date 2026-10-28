import Foundation
import EngelbartCore

// src/main/agent-map/ipc.cjs (2026-10-12): the Agent Viewer's calls. agentMap:open opens or focuses it; agentMap:runs is
// every run without its big fields; agentMap:run(id) one run whole; agentMap:asks the runs grouped one entry per ask;
// agentMap:ask(id) one entry with its records whole and the names of where it was typed; agentMap:design each agent as it
// is set up now; agentMap:export(html, name) saves a page the Viewer made, through a save panel; agentMap:reveal(target)
// brings the window with the ask's project to the front at its line; the benchmark's calls. Each change to a run is sent
// to the Viewer alone as `engelbart:agent-run` (the app posts the run log's changes); each benchmark change as
// `engelbart:chat-benchmark`. agentMap:take-reveal: the reveal a window was told of, taken once by its Workspace.

@MainActor
public final class AgentMapChannels {
    static let maxExport = 200 * 1024 * 1024

    public let runLog: AgentRunLog?
    let design: () -> JSONValue
    let saveFile: (String, String) async throws -> String?
    let reveal: (JSONValue) -> Bool
    let placeNamer: AgentPlaceNamer?
    let builtInPrompt: (JSONValue) -> String?
    public let benchmark: ChatBenchmark?
    public let window: AgentMapWindow?
    private var unsubscribe: (() -> Void)?

    /// `saveFile(text, name)`: a save panel defaulting to ~/Downloads/<name> (html filter) → the path, or nil.
    /// `reveal(target)`: the window on the ask's project (else the focused one, else a new one) to the front, told on
    /// `engelbart:agent-reveal` and keeping it for take-reveal. `benchmark` only in a developer copy.
    public init(runLog: AgentRunLog?, design: @escaping () -> JSONValue, saveFile: @escaping (String, String) async throws -> String?,
                reveal: @escaping (JSONValue) -> Bool = { _ in false }, placeNamer: AgentPlaceNamer? = nil, builtInPrompt: @escaping (JSONValue) -> String? = { _ in nil },
                benchmark: ChatBenchmark? = nil, window: AgentMapWindow? = nil, hub: EventHub = .shared) {
        self.runLog = runLog; self.design = design; self.saveFile = saveFile; self.reveal = reveal; self.placeNamer = placeNamer
        self.builtInPrompt = builtInPrompt; self.benchmark = benchmark; self.window = window
        unsubscribe = benchmark?.subscribe { change in hub.post("engelbart:chat-benchmark", change) }
    }

    @discardableResult public func open() -> Bool { window?.open() ?? false }
    public func runs() -> [JSONValue] { runLog?.list() ?? [] }
    public func run(_ id: String) -> JSONValue? { runLog?.get(id) }
    public func asks() -> [AgentAsk] { AgentAsks.group(runLog?.list() ?? []) }

    public func ask(_ id: String) async -> JSONValue? {
        guard let ask = AgentAsks.askOf(runLog, id, builtInPrompt: builtInPrompt) else { return nil }
        guard let place = ask["place"], !place.isNull, let placeNamer else { return ask }
        let names = await placeNamer.placeNames(place)
        return ask.with("names", ["project": .string(names.project), "workspace": .string(names.workspace), "note": .string(names.note), "paper": .string(names.paper)])
    }

    @discardableResult
    public func revealAsk(_ value: JSONValue?) -> Bool {
        guard let target = AgentAsks.revealTarget(value) else { return false }
        return reveal(target)
    }

    public func agentDesign() -> JSONValue { design() }

    /// A page the Viewer made, saved where the person picks: `<name>.html`, the name made safe.
    public func export(_ html: String, name: String?) async throws -> String? {
        guard html.utf8.count <= Self.maxExport else { throw BenchmarkError(message: "Nothing to export.") }
        var safe = re("[^\\w.-]+").replace(name ?? "agent-runs", with: "-")
        safe = String(safe.prefix(80))
        if safe.isEmpty { safe = "agent-runs" }
        return try await saveFile(html, "\(safe).html")
    }

    private func bench() throws -> ChatBenchmark {
        guard let benchmark else { throw BenchmarkError(message: "The benchmark is not available.") }
        return benchmark
    }

    public func benchmarkList(_ id: String? = nil, agent: String? = nil) async throws -> JSONValue { await try bench().list(id, agent: agent) }
    public func benchmarkRun(key: String? = nil, _ id: String? = nil) async throws -> Bool {
        let b = try bench()
        return key == nil ? await b.run(id) : await b.runOne(key!, id)
    }
    public func benchmarkNew() throws -> String { try bench().newRun() }
    public func benchmarkStop() throws -> Bool { try bench().stop() }
    public func benchmarkNote(_ key: String, _ text: String, _ id: String? = nil) throws -> Bool { try bench().setNote(key, text, id) }
}

/// What each window keeps of a reveal until its Workspace takes it (agentMap:take-reveal, index.cjs): once, for its project.
@MainActor
public final class AgentRevealHold {
    private var held: JSONValue?
    public init() {}
    public func keep(_ target: JSONValue) { held = target }
    public func take(projectId: String) -> JSONValue? {
        guard let held, held["place"]?["projectId"]?.string == projectId else { return nil }
        self.held = nil
        return held
    }
}
