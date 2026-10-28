import Foundation
import EngelbartCore

/// What the manager is made with (manager.cjs createBuilds' options). The app builds one for the data root in force.
public struct BuildConfiguration: @unchecked Sendable {
    public var host: BuildHost
    public var git: BuildGit
    public var runner: BuildRunner
    /// The Build panel's choices in force (`readModels('build')`).
    public var readModels: @Sendable () -> BuildChoices
    public var notify: BuildNotify
    public var tools: BuildTools?
    public var gitReady: @Sendable () -> Bool
    public var runShell: BuildShell
    /// Replaces the APFS clone of node_modules (tests).
    public var copyTree: (@Sendable (String, String) async throws -> Void)?
    /// The GitHub sign-in's token, for cloning a private library repository.
    public var githubToken: @Sendable () async -> String?
    /// A library row was made or given a folder here (the sidebar reads the library again).
    public var libraryChanged: @Sendable () -> Void
    public var runStep: RunStep?
    /// Where a turn keeps the library's files aside.
    public var keepDir: String
    public var limits: [String: Int]
    public var turnTime: [String: TimeInterval]
    public var autoFixes: Int
    /// After the agent does something, the card's diff is read again this long after.
    public var diffDelay: TimeInterval
    public var runLog: BuildRunLog?
    public var now: @Sendable () -> Date

    public static let defaultLimits = ["build": 3, "quick": 1]
    /// A turn past this is stopped (its work saved); Resume goes on.
    public static let defaultTurnTime: [String: TimeInterval] = ["build": 180 * 60, "quick": 20 * 60]

    public init(host: BuildHost, git: BuildGit = BuildGit(), runner: BuildRunner, readModels: @escaping @Sendable () -> BuildChoices = { .defaults },
                notify: @escaping BuildNotify = { EventHub.shared.post($0, $1) }, tools: BuildTools? = nil, gitReady: @escaping @Sendable () -> Bool = { true },
                runShell: BuildShell? = nil, copyTree: (@Sendable (String, String) async throws -> Void)? = nil,
                githubToken: @escaping @Sendable () async -> String? = { nil }, libraryChanged: @escaping @Sendable () -> Void = {},
                runStep: RunStep? = nil, keepDir: String = (NSTemporaryDirectory() as NSString).appendingPathComponent("engelbart-build-keep"),
                limits: [String: Int] = BuildConfiguration.defaultLimits, turnTime: [String: TimeInterval] = BuildConfiguration.defaultTurnTime,
                autoFixes: Int = 2, diffDelay: TimeInterval = 0.7, runLog: BuildRunLog? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.host = host; self.git = git; self.runner = runner; self.readModels = readModels; self.notify = notify; self.tools = tools
        self.gitReady = gitReady
        let toolsEnv: @Sendable () -> [String: String] = { [tools] in tools?.environment() ?? [:] }
        self.runShell = runShell ?? CheckShell.make(toolsEnvironment: toolsEnv)
        self.copyTree = copyTree; self.githubToken = githubToken; self.libraryChanged = libraryChanged; self.runStep = runStep
        self.keepDir = keepDir; self.limits = limits; self.turnTime = turnTime; self.autoFixes = autoFixes; self.diffDelay = diffDelay
        self.runLog = runLog; self.now = now
    }
}

/// Build's lifecycle (manager.cjs, 2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md). One
/// manager for the app, holding what runs now; everything that must outlive the app is in the task records (TaskStore).
///   start      the repository cloned first when it is not on this Mac, the record, the frozen context, then in the
///              background the worktree, its setup, the first turn
///   turn       a slot (three for Builds, one of its own for quick tasks), the agent under its CLI's tool lock, a
///              checkpoint commit, the ending read (NEEDS YOU / ESCALATE / done), a reply that waited sent next. Around
///              the agent: the library's files kept aside and Engelbart's tools opened for it; after it, what it deleted
///              of the library put back and the worktree back on its branch, each said on the card
///   reply      the next turn in the same session; while a turn runs it waits, or (`interrupt`) the turn is cut short
///   run step   after a turn that ends in review (a Build, never a quick task): what the repository can run is found,
///              started and checked, and runs in the background until Review opens it
///   review     the diff from where the Build started, as the worktree stands, the run steps' changes apart
///   accept     leftovers committed, everything squashed into one commit, replayed onto the person's current branch, the
///              checks, a fast-forward of their folder; a conflict or failed checks go to the agent by themselves, and
///              Accept runs again when its turn is done (at most `autoFixes` times for one press)
///   discard    stopped, worktree and branch removed
///   recovery   a record left working when the app closed is `interrupted`; Resume continues its session
///   trash      its project deleted: its turns stopped, `stopped` for Resume once restored; purged, its copy removed
/// Git writes that touch the shared repository's worktrees (add, remove) and Accept run one at a time per repository.
public actor BuildManager {
    static let clones = "repos"
    static let quitWait: TimeInterval = 20
    static let maxAttach = 50
    static let cardPatch = 400_000
    static let uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

    let config: BuildConfiguration
    var host: BuildHost { config.host }
    var git: BuildGit { config.git }

    final class Live: @unchecked Sendable {
        let signal = CancelSignal()
        var stopping: String?
        var done = false
        var waiters: [CheckedContinuation<Void, Never>] = []
    }

    var live: [String: Live] = [:]
    var active: [String: Int] = ["build": 0, "quick": 0]
    var waiting: [String: [SlotWaiter]] = ["build": [], "quick": []]
    var chains: [String: Task<Void, Never>] = [:]
    var stepping: [String: Task<Void, Never>] = [:]
    var reconciled = Set<String>()
    var keptCopies: [String: String] = [:] // id → projectId: accepted Builds whose copy stays while what they run is up
    var sweeps: [UUID: Task<Void, Never>] = [:]
    /// Builds of a project going into the trash: nothing of theirs starts by itself until the person acts on one again.
    var halted = Set<String>()
    var quitting = false

    public init(_ config: BuildConfiguration) { self.config = config }

    // MARK: helpers

    static func isUUID(_ s: String?) -> Bool { s.map { $0.range(of: uuidPattern, options: [.regularExpression, .caseInsensitive]) != nil } ?? false }

    func now() -> Date { config.now() }
    func say(_ role: String, _ text: String, _ images: [JSONValue]? = nil) -> JSONValue { TaskStore.message(role, text, at: now(), images: images) }

    func emit(_ task: TaskRecord) { config.notify("engelbart:build", TaskStore.publicTask(task)) }
    func navChanged() { config.notify("engelbart:nav", [:]) }
    func logged(_ work: (BuildRunLog) -> Void) { if let log = config.runLog { work(log) } } // never in a Build's way

    func projectOf(_ projectId: String) throws -> BuildProject { try host.project(projectId) }

    func read(_ projectId: String, _ id: String) throws -> TaskRecord {
        guard let task = TaskStore.readTask(try projectOf(projectId), id) else { throw BuildError("Unknown Build") }
        return task
    }

    /// Read, change, write, announce — with no wait between the read and the write.
    @discardableResult
    func save(_ projectId: String, _ id: String, _ change: (TaskRecord) -> TaskRecord) throws -> TaskRecord {
        let project = try projectOf(projectId)
        guard let held = TaskStore.readTask(project, id) else { throw BuildError("Unknown Build") }
        let next = try TaskStore.writeTask(project, held.merging(change(held)), now: now())
        emit(next)
        return next
    }

    @discardableResult
    func save(_ projectId: String, _ id: String, _ change: TaskRecord) throws -> TaskRecord { try save(projectId, id) { _ in change } }

    /// One git writer per repository (or key) at a time: worktree add and remove, and Accept.
    func serial<T: Sendable>(_ key: String, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let before = chains[key]
        let task = Task<T, Error> {
            await before?.value
            return try await work()
        }
        chains[key] = Task { _ = try? await task.value }
        return try await task.value
    }

    final class SlotWaiter: @unchecked Sendable {
        let continuation: CheckedContinuation<Bool, Never>
        init(_ c: CheckedContinuation<Bool, Never>) { continuation = c }
    }

    /// A turn's slot; it waits (queued) while the pool is full. → false when stopped while waiting.
    func slot(_ pool: String, _ signal: CancelSignal) async -> Bool {
        if active[pool, default: 0] < config.limits[pool, default: 1] { active[pool, default: 0] += 1; return true }
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let entry = SlotWaiter(c)
            waiting[pool, default: []].append(entry)
            signal.onAbort { Task { await self.leaveQueue(pool, entry) } }
        }
    }

    func leaveQueue(_ pool: String, _ entry: SlotWaiter) {
        if let at = waiting[pool]?.firstIndex(where: { $0 === entry }) {
            waiting[pool]?.remove(at: at)
            entry.continuation.resume(returning: false)
        }
    }

    func release(_ pool: String) {
        active[pool, default: 1] -= 1
        if var queue = waiting[pool], !queue.isEmpty {
            let next = queue.removeFirst()
            waiting[pool] = queue
            active[pool, default: 0] += 1
            next.continuation.resume(returning: true)
        }
    }

    func track(_ change: () -> Void) { change(); navChanged() } // bookkeeping never stands in a Build's way

    func waitDone(_ entry: Live) async {
        if entry.done { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in entry.waiters.append(c) }
    }

    func settle(_ entry: Live) {
        entry.done = true
        let w = entry.waiters
        entry.waiters = []
        w.forEach { $0.resume() }
    }

    // MARK: diffs

    /// The Build's diff as its worktree stands, sent to its card. Never fails a turn.
    func sendDiff(_ projectId: String, _ task: TaskRecord, running: Bool) async {
        guard let worktree = task.str("worktree"), let base = task.str("baseSha") else { return }
        guard let d = try? await git.workingDiff(worktree, base, maxPatch: BuildManager.cardPatch) else { return }
        var payload = d.json
        payload["projectId"] = .string(projectId); payload["id"] = task["id"]; payload["running"] = .bool(running)
        config.notify("engelbart:build-diff", .object(payload))
    }

    // MARK: lists

    public func list(_ projectId: String) throws -> [JSONValue] {
        reconcile()
        return TaskStore.listTasks(try projectOf(projectId)).map { task in
            var p = TaskStore.publicTask(task).object ?? [:]
            p["working"] = .bool(live[task.str("id") ?? ""] != nil)
            return .object(p)
        }
    }

    public func get(_ projectId: String, _ id: String) throws -> JSONValue {
        reconcile()
        var p = TaskStore.publicTask(try read(projectId, id)).object ?? [:]
        p["working"] = .bool(live[id] != nil)
        return .object(p)
    }

    /// The Builds of a project that are not closed: Clear keeps their lines in the blank document.
    public func openIds(_ projectId: String) throws -> Set<String> {
        Set(TaskStore.listTasks(try projectOf(projectId)).filter { !TaskStore.final.contains($0.str("status") ?? "") }.compactMap { $0.str("id") })
    }

    public func running() -> [String] { Array(live.keys) }
    public func isStepping(_ id: String) -> Bool { stepping[id] != nil }
    public func sweeping() async { for task in sweeps.values { await task.value } }
}
