import Foundation
import EngelbartCore

/// The Build calls the windows make (ipc.cjs build-* handlers, preload.cjs build*), with the same validation: ids and
/// field lengths checked, a target only ever names a repository (a path never comes from a window), and the events
/// (engelbart:build, -progress, -diff, -run) posted by the manager through its `notify`.
public final class BuildService: @unchecked Sendable {
    public let manager: BuildManager
    /// `readModels(place)`: the choices in force for a Build panel ('build') or a post-it's Build ('quick'), starting on
    /// what was last picked there (Bart's models file).
    let readModels: @Sendable (String) -> BuildChoices
    /// `rememberModelChoice(place, choice)` (Bart's model-choices.json).
    let rememberChoice: @Sendable (String, [String: String]) -> Void

    public init(manager: BuildManager, readModels: @escaping @Sendable (String) -> BuildChoices = { _ in .defaults },
                rememberChoice: @escaping @Sendable (String, [String: String]) -> Void = { _, _ in }) {
        self.manager = manager; self.readModels = readModels; self.rememberChoice = rememberChoice
    }

    static func buildId(_ value: String) throws -> String {
        guard TaskStore.isId(value) else { throw BuildError("build id is invalid") }
        return value
    }

    static func str(_ value: String?, _ name: String, _ max: Int) throws -> String {
        guard let value, !value.isEmpty, value.count <= max else { throw BuildError("\(name) is invalid") }
        return value
    }

    static func optStr(_ value: String?, _ name: String, _ max: Int) throws -> String? {
        guard let value, !value.isEmpty else { return nil }
        if value.count > max { throw BuildError("\(name) is invalid") }
        return value
    }

    /// The repository a Build works in: the window names it (the default repo, the project folder, a library row).
    static func target(_ value: JSONValue?) throws -> JSONValue? {
        guard let value, !value.isNull else { return nil }
        guard let kind = value["kind"]?.string, ["default", "project", "library"].contains(kind) else {
            throw BuildError("target must name the default repo, the project folder or a library row")
        }
        return kind == "library" ? ["kind": "library", "id": .string(try str(value["id"]?.string, "library id", 64))] : ["kind": .string(kind)]
    }

    // build-models: what a Build panel ('build', the default) or a post-it's Build ('quick') offers.
    public func buildModels(_ place: String = "build") -> JSONValue { readModels(place == "quick" ? "quick" : "build").json }
    // remember-model-choice: the model and effort just picked, kept as where the next one starts.
    public func rememberModelChoice(_ place: String, provider: String, model: String, effort: String) throws {
        guard place == "build" || place == "quick" else { throw BuildError("place must be build or quick") }
        rememberChoice(place, ["provider": try BuildService.str(provider, "provider", 24), "model": try BuildService.str(model, "model", 24), "effort": try BuildService.str(effort, "effort", 24)])
    }

    public func buildTargets(_ projectId: String) async throws -> [JSONValue] { try await manager.targets(try BuildService.str(projectId, "project id", 64)) }
    public func buildSetDefault(_ projectId: String, _ target: JSONValue?) async throws -> [JSONValue] { try await manager.setDefault(try BuildService.str(projectId, "project id", 64), try BuildService.target(target)) }
    public func buildPreflight(_ projectId: String, _ target: JSONValue?) async throws -> JSONValue { try await manager.preflight(try BuildService.str(projectId, "project id", 64), try BuildService.target(target)) }
    public func buildInit(_ projectId: String, _ target: JSONValue?) async throws -> JSONValue { try await manager.initRepository(try BuildService.str(projectId, "project id", 64), try BuildService.target(target)) }
    public func buildClone(_ projectId: String, _ target: JSONValue?) async throws -> JSONValue { try await manager.cloneRepository(try BuildService.str(projectId, "project id", 64), try BuildService.target(target)) }

    /// build-start: the fields as ipc.cjs takes them from a window.
    public func buildStart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue {
        let v = input.object ?? [:]
        var start = BuildStart()
        start.kind = v["kind"]?.string == "quick" ? "quick" : "build"
        start.workspaceId = try BuildService.optStr(v["workspaceId"]?.string, "workspace id", 64)
        start.postItId = try BuildService.optStr(v["postItId"]?.string, "post-it id", 64)
        start.text = try BuildService.optStr(v["text"]?.string, "text", 200_000)
        start.fromLine = v["fromLine"].map(isTruthy) ?? false
        start.routedFrom = try BuildService.optStr(v["routedFrom"]?.string, "route id", 80)
        start.place = v["place"]?.object != nil ? v["place"] : nil
        start.provider = try BuildService.optStr(v["provider"]?.string, "provider", 24)
        start.model = try BuildService.optStr(v["model"]?.string, "model", 24)
        start.effort = try BuildService.optStr(v["effort"]?.string, "effort", 24)
        start.attach = try (v["attach"]?.array ?? []).prefix(50).map { try BuildService.str($0.string, "library id", 64) }
        start.target = try BuildService.target(v["target"])
        return try await manager.start(try BuildService.str(projectId, "project id", 64), start)
    }

    public func buildList(_ projectId: String) async throws -> [JSONValue] { try await manager.list(try BuildService.str(projectId, "project id", 64)) }
    public func buildGet(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.get(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }

    /// build-reply: `{ interrupt, images: [{ n, id }] }` (≤50 images, the reply ≤100,000 characters).
    public func buildReply(_ projectId: String, _ id: String, _ text: String, interrupt: Bool = false, images: [PastedImage] = []) async throws -> JSONValue {
        guard text.count <= 100_000 else { throw BuildError("reply is invalid") }
        return try await manager.reply(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id), text, interrupt: interrupt, images: Array(images.prefix(50)))
    }

    @discardableResult
    public func buildStop(_ projectId: String, _ id: String) async throws -> Bool { await manager.stop(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    public func buildResume(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.resume(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    public func buildReview(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.review(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    public func buildAccept(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.accept(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    public func buildFix(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.fix(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    public func buildDiscard(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.discard(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    /// build-run-show: a runnable it got running shown again (a UI's Stage tab, a terminal program's session).
    public func buildRunShow(_ projectId: String, _ id: String, _ name: String) async throws -> Bool {
        try await manager.showRunnable(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id), try BuildService.str(name, "runnable name", 64))
    }
    public func buildRunStop(_ projectId: String, _ id: String) async throws -> JSONValue { try await manager.stopRunning(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id)) }
    /// build-run-stop-runnable: an accepted Build's runnable (`name`), or all of them (nil).
    public func buildRunStopRunnable(_ projectId: String, _ id: String, _ name: String?) async throws -> JSONValue {
        try await manager.stopRunnable(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id), name == nil ? nil : try BuildService.str(name, "runnable name", 64))
    }
    /// build-promote: a quick task becomes a Build of `workspaceId`, on `choice` ({ provider, model, effort }) when given.
    public func buildPromote(_ projectId: String, _ id: String, _ workspaceId: String, choice: JSONValue? = nil) async throws -> JSONValue {
        let picked = try choice?.object.map { (provider: try BuildService.optStr($0["provider"]?.string, "provider", 24), model: try BuildService.optStr($0["model"]?.string, "model", 24), effort: try BuildService.optStr($0["effort"]?.string, "effort", 24)) }
        return try await manager.promote(try BuildService.str(projectId, "project id", 64), try BuildService.buildId(id), workspaceId: try BuildService.str(workspaceId, "workspace id", 64), picked: picked)
    }

    /// Clear (B21) keeps the lines of Builds still open: the predicate archive.clearWorkspace takes (ipc.cjs keepOpenBuilds).
    public func keepOpenBuilds(_ projectId: String) async -> @Sendable (String) -> Bool {
        let open = (try? await manager.openIds(projectId)) ?? []
        return { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            guard t.range(of: "^build> ([a-z0-9]{6,32})$", options: .regularExpression) != nil else { return false }
            return open.contains(String(t.dropFirst("build> ".count)))
        }
    }
}

/// The manager as the app makes it (index.cjs): the real runner, or the fake one for scripted runs; the run step unless
/// ENGELBART_RUN_STEP=off, with the fake agent for ENGELBART_BUILD_FAKE=1 or ENGELBART_RUN_FAKE=1.
public enum BuildSetup {
    public static func runner(environment: [String: String] = ProcessInfo.processInfo.environment, runDirectory: String, tools: BuildTools?) -> BuildRunner {
        if environment["ENGELBART_BUILD_FAKE"] == "1" {
            return FakeRunner(delayMs: Double(environment["ENGELBART_BUILD_FAKE_MS"] ?? "").flatMap { $0 > 0 ? $0 : nil } ?? 900) // _MS: how long a fake turn takes
        }
        return CLIRunner(runDirectory: runDirectory, tools: tools) // Codex in the person's own CODEX_HOME (2026-10-07)
    }

    public static func runStep(environment: [String: String] = ProcessInfo.processInfo.environment, tools: BuildTools?,
                               openTerminal: (@Sendable (String, String) -> JSONValue)?, closeTerminal: (@Sendable (String) async -> Void)?,
                               terminalSnapshot: (@Sendable (String) -> JSONValue?)?, runLog: BuildRunLog?) -> RunStep? {
        if environment["ENGELBART_RUN_STEP"] == "off" { return nil }
        let fake = environment["ENGELBART_BUILD_FAKE"] == "1" || environment["ENGELBART_RUN_FAKE"] == "1"
        let processes = RunProcesses(extraEnvironment: { tools?.environment() ?? [:] })
        let fakePrepare: RunStep.Prepare = { LocalClaude.Auth(file: "fake", env: [:]) }
        let realPrepare: RunStep.Prepare = { try await LocalClaude.prepare() }
        let realAgent: RunStep.Agent = { try await LocalClaude.run($0) }
        return RunStep(processes: processes, prepareClaude: fake ? fakePrepare : realPrepare, runAgent: fake ? FakeRunAgent.make() : realAgent,
                       openTerminal: openTerminal, closeTerminal: closeTerminal, terminalSnapshot: terminalSnapshot, tools: tools, runLog: runLog)
    }
}
