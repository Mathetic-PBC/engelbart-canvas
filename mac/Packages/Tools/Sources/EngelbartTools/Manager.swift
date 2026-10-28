import EngelbartCore
import Foundation

// Git, Claude Code and Codex for the whole app (src/main/tools/manager.cjs, 2026-09-23; design:
// docs/superpowers/specs/2026-09-23-tools-and-defaults-design.md). It checks what is there at launch and when asked, keeps
// config.json's `tools` true to what the last check saw, and runs every install, update and sign-in:
//
//   check      detect → observed fields; the person's `skip` and `pin` are read from the file each time, so an edit by
//              hand is never overwritten.
//   maintain   after the launch check: a tool below its minimum is updated when `tools.updates` is auto, it is not pinned
//              or skipped, its own updater is on, and the same update has not failed in the last day. Everything else
//              waits for the person.
//   first      after the launch check on a Mac with neither agent (a first launch, 2026-09-28): the agents named in
//              `installAtLaunch` are installed without being asked for, unless skipped. The setup dialog shows them
//              installing; signing in is still the person's.
//   install    one at a time, each holding its tool's lock alone (Lock.swift), then found again: an installer that says it
//              finished is not believed until the program answers.
//   update     the same, and a launcher left broken by the update is pointed back at the version that worked
//              (Install.swift rollback), when the install keeps one.
//   sign-out   the CLI's own logout (2026-10-03, Connections), then a check of that tool, so its record says signed out.
//   use        what a run of a program (an @bart turn, a summary) holds while it runs.
//   environment  what everything Engelbart starts is given: the folder of Engelbart's own Git while it stands in for a
//              missing one (BundledGit.swift), which the terminal puts first on PATH, and the folders of Claude Code and
//              Codex when the login shell's PATH misses them (a new account: their installers put them in ~/.local/bin,
//              which a fresh .zshrc does not add), which it puts last.
//
// What changes is sent on as a snapshot (`onChange`), which the setup dialog draws. The manager lives on the main actor
// (the Electron main process's one thread); `use`, `environment` and `binaryFor` can be called from anywhere.

public let STALE: TimeInterval = 10 * 60
public let RETRY_UPDATE: TimeInterval = 24 * 60 * 60
public let SIGN_IN_LIMIT: TimeInterval = 10 * 60
let OBSERVED = ["installed", "version", "status", "signedIn", "account", "path", "onPath", "source", "untested", "updaterOff", "checkedAt", "error", "note"]
let WORKS: Set<String> = ["ready", "signed-out"]

func pick(_ found: Fields) -> Fields { found.filter { OBSERVED.contains($0.key) } }

private func merged(_ a: Fields, _ b: Fields) -> Fields { a.merging(b) { _, new in new } }

/// What the terminal's menu lists (src/main/terminal/provider-discovery.cjs's old shape).
public struct ToolProvider: Equatable, Sendable {
    public var id: String
    public var name: String
    public var available: Bool
    public var path: String?
    public var authenticated: Bool?
    public var checkedAt: String?
    public var isShell: Bool { id == "shell" }
}

/// How the manager reaches config.json, which the Store owns: `read` → config.json's `tools` (nil when missing or
/// unreadable); `write(tools)` → the `tools` actually written (nil when the file was not written: it does not parse, or a
/// pretend machine keeps its records in memory).
public struct ToolsStorage: Sendable {
    public var read: @Sendable () -> JSONValue?
    public var write: @Sendable (JSONValue) -> JSONValue?
    public init(read: @escaping @Sendable () -> JSONValue?, write: @escaping @Sendable (JSONValue) -> JSONValue?) { self.read = read; self.write = write }

    /// Records in memory only (ENGELBART_TOOLS_FAKE): config.json keeps what the real machine has.
    public static func memory() -> ToolsStorage {
        final class Box: @unchecked Sendable { var value: JSONValue = [:]; let lock = NSLock() }
        let box = Box()
        return ToolsStorage(read: { box.lock.lock(); defer { box.lock.unlock() }; return box.value },
                            write: { value in box.lock.lock(); box.value = value; box.lock.unlock(); return nil })
    }
}

/// A thread-safe copy of the records, for the calls that come from anywhere (environment, binaryFor).
final class RecordsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ToolsRecord
    init(_ value: ToolsRecord) { self.value = value }
    func get() -> ToolsRecord { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: ToolsRecord) { lock.lock(); value = v; lock.unlock() }
}

@MainActor
public final class ToolsManager {
    public typealias Detect = ([String]) async throws -> DetectResult

    let storage: ToolsStorage
    let detect: Detect
    let actions: ToolActions
    let signInStarter: SignInStarter?
    let signOutRunner: SignOutRunner?
    let rollbackOptions: RollbackOptions
    let installAtLaunch: [String]
    let now: () -> Date
    let signInLimit: TimeInterval
    let platform: String
    let fileExists: @Sendable (String) -> Bool
    public var onChange: (ToolsSnapshot) -> Void

    // What the checks saw (starting from what the last launch wrote), and what is happening now.
    var seen: [String: Fields] = [:]
    var busy: [String: Busy] = [:]
    nonisolated let locks: [String: ToolLock]
    let installer = ToolLock()
    var signIns: [String: SignInRun] = [:]
    var records: ToolsRecord
    nonisolated let shared: RecordsBox
    var aliases: [String] = [] // names the login shell defines as an alias or function: the terminal can run them
    public private(set) var checked = false
    var lookupError: String? // the last full check could not ask the login shell, so `missing` may only mean unseen
    var launch: Task<ToolsSnapshot, Never>?
    var connecting: [String: Task<ToolsSnapshot, Never>] = [:]

    public init(storage: ToolsStorage, detect: @escaping Detect, actions: ToolActions, signIn: SignInStarter? = nil, signOut: SignOutRunner? = nil,
                rollbackOptions: RollbackOptions = RollbackOptions(), installAtLaunch: [String] = [], now: @escaping () -> Date = { Date() },
                signInLimit: TimeInterval = SIGN_IN_LIMIT, platform: String = "darwin",
                fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                onChange: @escaping (ToolsSnapshot) -> Void = { _ in }) {
        self.storage = storage
        self.detect = detect
        self.actions = actions
        self.signInStarter = signIn
        self.signOutRunner = signOut
        self.rollbackOptions = rollbackOptions
        self.installAtLaunch = installAtLaunch
        self.now = now
        self.signInLimit = signInLimit
        self.platform = platform
        self.fileExists = fileExists
        self.onChange = onChange
        let last = normalizeTools(storage.read())
        for name in TOOL_NAMES { seen[name] = last[name].fields }
        records = last
        shared = RecordsBox(last)
        var locks: [String: ToolLock] = [:]
        for name in TOOL_NAMES { locks[name] = ToolLock() }
        self.locks = locks
    }

    func disk() -> ToolsRecord { normalizeTools(storage.read()) }

    /// The person's choices an action makes; everything else of theirs is re-read from disk.
    struct Choices { var updates: String?; var skip: [String: Bool] = [:] }

    func persist(_ choices: Choices = Choices()) {
        let onDisk = disk()
        var next: Fields = ["updates": .string(choices.updates ?? onDisk.updates)]
        for name in TOOL_NAMES {
            var fields = merged(onDisk[name].fields, pick(seen[name] ?? [:]))
            fields["failedUpdate"] = seen[name]?["failedUpdate"].flatMap { $0.isNull ? nil : $0 } ?? .null
            fields["skip"] = .bool(choices.skip[name] ?? onDisk[name].skip)
            fields["pin"] = onDisk[name].pin.map(JSONValue.string) ?? .null
            next[name] = .object(fields)
        }
        let written = storage.write(.object(next))
        records = normalizeTools(written ?? .object(next))
        shared.set(records)
    }

    public func canAutoUpdate(_ name: String) -> Bool { canAutoUpdate(name, records[name]) }

    func canAutoUpdate(_ name: String, _ record: ToolRecord) -> Bool {
        if name == "git" || !(record.status == "outdated" || record.status == "incompatible") { return false }
        if records.updates != "auto" || record.pin != nil || record.skip || record.updaterOff || record.path == nil { return false }
        guard let failed = record.failedUpdate else { return true }
        let at = Time.parse(failed.at) ?? .distantPast
        return !(failed.from == record.version && now().timeIntervalSince(at) < RETRY_UPDATE)
    }

    public func snapshot() -> ToolsSnapshot {
        var tools: [String: ToolSnapshot] = [:]
        for name in TOOL_NAMES { tools[name] = ToolSnapshot(record: records[name], busy: busy[name], autoUpdate: canAutoUpdate(name)) }
        return ToolsSnapshot(checked: checked, platform: platform, updates: records.updates, tools: tools)
    }

    func emit() { onChange(snapshot()) }

    private func found(_ names: [String]) async -> DetectResult {
        do { return try await detect(names) } catch {
            var tools: [String: Fields] = [:]
            for name in names { tools[name] = ["error": .string("The check failed: \(error.localizedDescription)")] }
            return DetectResult(tools: tools)
        }
    }

    @discardableResult
    public func check(_ only: [String] = TOOL_NAMES) async -> ToolsSnapshot {
        let names = only.filter { busy[$0] == nil }
        if names.isEmpty { return snapshot() }
        for name in names { busy[name] = Busy(action: "check") }
        emit()
        let result = await found(names)
        for name in names {
            if busy[name]?.action == "check" { busy[name] = nil }
            if let f = result.tools[name] { seen[name] = merged(seen[name] ?? [:], pick(f)) }
        }
        if let found = result.aliases { aliases = aliases.filter { !names.contains($0) } + found.filter { names.contains($0) } }
        if TOOL_NAMES.allSatisfy({ names.contains($0) }) { checked = true; lookupError = result.lookupError }
        persist()
        emit()
        return snapshot()
    }

    private func detectOne(_ name: String) async -> Fields { (await found([name])).tools[name] ?? [:] }

    @discardableResult
    public func update(_ name: String, auto: Bool = false) async -> ActionResult {
        let label = Requirements[name].name
        if !records[name].installed { return ActionResult(ok: false, error: "\(label) is not installed.") }
        if auto && !canAutoUpdate(name) { return ActionResult(ok: false, error: nil) }
        guard let lock = locks[name] else { return ActionResult(ok: false) }
        // Installs one at a time, each holding its tool's lock alone (taken and released in line, not through closures, so
        // the body stays plain main-actor code).
        await installer.acquireExclusive()
        await lock.acquireExclusive()
        let out = await updateHeld(name)
        lock.releaseExclusive()
        installer.releaseExclusive()
        return out
    }

    private func updateHeld(_ name: String) async -> ActionResult {
                let label = Requirements[name].name
                let before = records[name]
                busy[name] = Busy(action: "update")
                seen[name] = merged(seen[name] ?? [:], ["status": "updating", "error": .null])
                persist()
                emit()
                let mark = before.source == "native" || before.source == "standalone" ? markRollback(name, rollbackOptions) : nil
                let result = name == "git" ? await actions.updateGit(before.source) : await actions.updateAgent(name, before.path)
                var found = await detectOne(name)
                var restored = false
                let status = { (f: Fields) in f["status"]?.string ?? "" }
                if !WORKS.contains(status(found)) && (status(found) == "failed" || status(found) == "missing") && mark != nil && rollback(mark) {
                    // The update left a launcher that does not run: the version that worked is put back.
                    restored = true
                    found = await detectOne(name)
                }
                let ok = WORKS.contains(status(found))
                var error: String?
                if !ok {
                    if restored {
                        error = "The update broke \(label), so \(before.version ?? "the earlier version") was put back.\(result.error.map { " \($0)" } ?? "")"
                    } else if !result.ok {
                        error = result.error
                    } else if status(found) == "outdated" || status(found) == "incompatible" {
                        error = "\(label) updated to \(found["version"]?.string ?? "a version") that still does not meet \(Requirements[name].minimum)."
                    } else {
                        error = found["error"]?.string ?? "\(label) did not answer after the update."
                    }
                    if !restored && mark == nil && (status(found) == "failed" || status(found) == "missing"),
                       let source = before.source, source != "native" && source != "standalone" {
                        error = (error ?? "") + " A \(source) install keeps no earlier copy to go back to."
                    }
                }
                // A failed update is not retried automatically for a day from the same version (canAutoUpdate).
                var next = merged(seen[name] ?? [:], pick(found))
                next["error"] = ok ? (found["error"] ?? .null) : (error.map(JSONValue.string) ?? .null)
                next["failedUpdate"] = ok || before.version == nil ? .null : ["from": .string(before.version!), "at": .string(Time.iso(now()))]
                seen[name] = next
                busy[name] = nil
                persist()
                emit()
                return ActionResult(ok: ok, error: error)
    }

    func maintain() async {
        for name in TOOL_NAMES where canAutoUpdate(name) { await update(name, auto: true) }
    }

    /// The launch check, once: then the first launch's installs and the automatic updates.
    @discardableResult
    public func start() async -> ToolsSnapshot {
        if launch == nil {
            launch = Task { @MainActor in
                await self.check()
                self.installFirst()
                await self.maintain()
                return self.snapshot()
            }
        }
        return await launch!.value
    }

    /// Neither agent on this Mac: the ones named in `installAtLaunch` are installed now, in the background.
    func installFirst() {
        if lookupError != nil || AGENTS.contains(where: { records[$0].installed }) { return }
        let names = installAtLaunch.filter { isAgent($0) && records[$0].status == "missing" && !records[$0].skip && busy[$0] == nil }
        if !names.isEmpty { Task { @MainActor in _ = await self.install(names) } }
    }

    func installOne(_ name: String) async -> ActionResult {
        if records[name].installed && WORKS.contains(records[name].status) { return ActionResult(ok: true, error: nil) }
        guard let lock = locks[name] else { return ActionResult(ok: false) }
        await installer.acquireExclusive()
        await lock.acquireExclusive()
        let out = await installHeld(name)
        lock.releaseExclusive()
        installer.releaseExclusive()
        return out
    }

    private func installHeld(_ name: String) async -> ActionResult {
                // Installed while this waited its turn (2026-10-14: Install pressed while the launch's background install ran
                // installed Claude Code a second time).
                if records[name].installed && WORKS.contains(records[name].status) { return ActionResult(ok: true, error: nil) }
                let label = Requirements[name].name
                busy[name] = Busy(action: "install")
                seen[name] = merged(seen[name] ?? [:], ["status": "installing", "error": .null])
                persist(Choices(skip: [name: false]))
                emit()
                let result: ActionResult
                if name == "git" {
                    result = await actions.installGit { [weak self] phase in
                        Task { @MainActor in
                            guard let self, self.busy[name] != nil else { return }
                            self.busy[name]?.phase = phase
                            self.emit()
                        }
                    }
                } else {
                    result = await actions.installAgent(name)
                }
                let found = await detectOne(name)
                let status = found["status"]?.string ?? ""
                let ok = WORKS.contains(status)
                var error: String?
                if !ok {
                    if !result.ok { error = result.error }
                    else if status == "outdated" || status == "incompatible" {
                        error = "\(label) \(found["version"]?.string ?? "") was installed but is older than \(Requirements[name].minimum).".replacingOccurrences(of: "  ", with: " ")
                    } else {
                        error = found["error"]?.string ?? "\(label) was installed but could not be found."
                    }
                }
                var next = merged(seen[name] ?? [:], pick(found))
                next["error"] = ok ? (found["error"] ?? .null) : (error.map(JSONValue.string) ?? .null)
                seen[name] = next
                busy[name] = nil
                persist()
                emit()
                return ActionResult(ok: ok, error: error, kind: result.kind)
    }

    /// Installs the named tools one after another.
    @discardableResult
    public func install(_ names: [String]) async -> [String: ActionResult] {
        var out: [String: ActionResult] = [:]
        for name in names where TOOL_NAMES.contains(name) { out[name] = await installOne(name) }
        return out
    }

    /// The CLI's own sign-in in a hidden terminal; it opens the browser. Returns when it ends (or after ten minutes).
    @discardableResult
    public func signIn(_ name: String) async -> ToolsSnapshot {
        guard isAgent(name), let starter = signInStarter, let path = records[name].path else { return snapshot() }
        if signIns[name] != nil { return snapshot() }
        busy[name] = Busy(action: "sign-in")
        emit()
        let run = starter(name, path) { [weak self] url in
            Task { @MainActor in
                guard let self, self.busy[name] != nil else { return }
                self.busy[name]?.url = url
                self.emit()
            }
        }
        signIns[name] = run
        let limit = DispatchWorkItem { run.kill() }
        DispatchQueue.main.asyncAfter(deadline: .now() + signInLimit, execute: limit)
        let exit = await run.wait()
        limit.cancel()
        signIns[name] = nil
        busy[name] = nil
        await check([name])
        if records[name].signedIn != true && !exit.output.isEmpty {
            seen[name] = merged(seen[name] ?? [:], ["error": .string("Not signed in: \(exit.output)".prefixChars(300))])
            persist()
            emit()
        }
        return snapshot()
    }

    /// Connect Claude Code or Codex (2026-10-14, onboarding's "Connect"): whatever it still needs, in order, from one press —
    /// installed (or waited for, when the launch's install is running), updated when too old, checked when its sign-in is
    /// unknown, then signed in. A press while one is under way joins it.
    @discardableResult
    public func connect(_ name: String) async -> ToolsSnapshot {
        guard isAgent(name) else { return snapshot() }
        if let running = connecting[name] { return await running.value }
        let run = Task { @MainActor () -> ToolsSnapshot in
            var record = self.records[name]
            if !record.installed || ["missing", "failed", "installing"].contains(record.status) {
                if !(await self.installOne(name)).ok { return self.snapshot() }
            } else if (record.status == "outdated" || record.status == "incompatible") && record.pin == nil {
                if !(await self.update(name)).ok { return self.snapshot() }
            }
            record = self.records[name]
            // Checked first: one signed in since the last check (in a terminal, in Settings) needs no browser sign-in.
            if record.signedIn != true && self.busy[name] == nil { await self.check([name]); record = self.records[name] }
            if record.installed && record.signedIn != true && (record.status == "signed-out" || record.status == "ready") { await self.signIn(name) }
            return self.snapshot()
        }
        connecting[name] = run
        let out = await run.value
        connecting[name] = nil
        return out
    }

    @discardableResult
    public func cancelSignIn(_ name: String) -> Bool {
        guard let run = signIns[name] else { return false }
        run.kill()
        return true
    }

    /// Every sign-in still waiting in the browser ended, for a quit: its terminal is outside the session manager (a PTY
    /// exiting while Node shut down aborted the Electron app, 2026-10-16). Returns once each has exited, or after
    /// `timeout`. → how many there were.
    @discardableResult
    public func stopSignIns(timeout: TimeInterval = 3) async -> Int {
        let runs = Array(signIns.values)
        runs.forEach { $0.kill() }
        if runs.isEmpty { return 0 }
        let all = Once<Void>()
        Task.detached { for run in runs { _ = await run.wait() }; all.resolve(()) }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { all.resolve(()) }
        await all.wait()
        return runs.count
    }

    /// The CLI's own logout, then a check of that tool: the record (and every row) says Not signed in once the CLI does.
    /// Not while it signs in or anything else runs for it.
    @discardableResult
    public func signOut(_ name: String) async -> ActionResult {
        guard isAgent(name), let runner = signOutRunner, let path = records[name].path else { return ActionResult(ok: false, error: nil) }
        if busy[name] != nil || signIns[name] != nil { return ActionResult(ok: false, error: nil) }
        busy[name] = Busy(action: "sign-out")
        emit()
        let exit = await runner(name, path)
        busy[name] = nil
        await check([name])
        if records[name].signedIn != true { return ActionResult(ok: true, error: nil) }
        let label = Requirements[name].name
        let error = exit.output.isEmpty ? "\(label) still says it is signed in." : "Could not sign out of \(label): \(exit.output)"
        return ActionResult(ok: false, error: error.prefixChars(300))
    }

    /// The person's Skip (remembered per tool) and Ask again.
    @discardableResult
    public func skip(_ names: [String]) -> ToolsSnapshot {
        var choices = Choices()
        for name in names where TOOL_NAMES.contains(name) { choices.skip[name] = true }
        persist(choices)
        emit()
        return snapshot()
    }

    @discardableResult
    public func askAgain(_ name: String) -> ToolsSnapshot {
        persist(Choices(skip: [name: false]))
        emit()
        return snapshot()
    }

    @discardableResult
    public func setUpdates(_ value: String) -> ToolsSnapshot {
        persist(Choices(updates: value == "ask" ? "ask" : "auto"))
        emit()
        return snapshot()
    }

    /// Before a run: a program whose file is gone is looked for now; a check over ten minutes old is redone in the background.
    public func ensure(_ name: String) async {
        let record = records[name]
        if !checked || busy[name] != nil { return }
        if let path = record.path, !fileExists(path) { await check([name]); return }
        let age = record.checkedAt.flatMap(Time.parse).map { now().timeIntervalSince($0) } ?? .infinity
        if age > STALE { Task { @MainActor in await self.check([name]) } }
    }

    /// What a run holds while it runs: an install or update of the same program waits for it, and it for them.
    public nonisolated func use<T>(_ name: String, _ fn: () async throws -> T) async rethrows -> T {
        guard let lock = locks[name] else { return try await fn() }
        return try await lock.shared(fn)
    }

    /// The agents that can run a question right now, or nil before the first check has finished.
    public func usableAgents() -> [String]? {
        if !checked { return nil }
        return AGENTS.filter { records[$0].installed && records[$0].status == "ready" }
    }

    /// What every program Engelbart starts gets besides its own environment: ENGELBART_GIT_BIN while Engelbart's own Git
    /// stands in, and ENGELBART_AGENT_PATH (folders, joined by ":") while an agent is installed where PATH does not reach.
    /// ENGELBART_CLAUDE_BIN / ENGELBART_CODEX_BIN: the full path of one whose name runs another copy, or nothing
    /// (2026-09-30): the terminal's Claude Code and Codex items run it by that.
    public nonisolated func environment() -> [String: String] {
        let records = shared.get()
        var out: [String: String] = [:]
        let git = records["git"]
        // A path that is gone: the app moved (or the program was removed) since the last check; the next one finds it.
        if git.source == "bundled" && git.status == "ready", let path = git.path, fileExists(path) {
            out["ENGELBART_GIT_BIN"] = (path as NSString).deletingLastPathComponent
        }
        var folders: [String] = []
        for name in AGENTS {
            guard let file = ToolsManager.binaryFor(name, records), fileExists(file) else { continue }
            let folder = (file as NSString).deletingLastPathComponent
            if !folders.contains(folder) { folders.append(folder) }
            out["ENGELBART_\(name.uppercased())_BIN"] = file
        }
        if !folders.isEmpty { out["ENGELBART_AGENT_PATH"] = folders.joined(separator: ":") }
        return out
    }

    /// The full path to run a program by, when its name does not run it (PATH misses it, or reaches another copy first).
    public nonisolated func binaryFor(_ name: String) -> String? { ToolsManager.binaryFor(name, shared.get()) }

    nonisolated static func binaryFor(_ name: String, _ records: ToolsRecord) -> String? {
        let record = records[name]
        return record.onPath == false ? record.path : nil
    }

    /// The terminal's Claude Code / Codex menu, in the shape it has always had.
    public func providers(shellPath: String) async -> [ToolProvider] {
        if !checked, let launch { _ = await launch.value }
        var out = [ToolProvider(id: "shell", name: "Shell", available: true, path: shellPath, authenticated: nil, checkedAt: nil)]
        for name in AGENTS {
            let record = records[name]
            let runs = record.installed && record.status != "failed"
            let alias = !runs && aliases.contains(name)
            out.append(ToolProvider(id: name, name: Requirements[name].name, available: runs || alias,
                                    path: runs ? record.path : alias ? "shell alias/function" : nil, authenticated: record.signedIn, checkedAt: record.checkedAt))
        }
        return out
    }

    /// The record as last written (tests, Connections).
    public var current: ToolsRecord { records }
}
