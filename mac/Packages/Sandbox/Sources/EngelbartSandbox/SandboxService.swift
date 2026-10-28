import Foundation
import EngelbartCore

/// The sandbox parts of src/main/ipc.cjs and index.cjs: what the renderer (here, the app's views) may ask, by library row
/// or run id (sandbox ids, keys and paths never come from the UI), the starts that come with saving or linking a
/// repository, the data-mode change, sign-in changes and quit. Events go out on `EventHub` as
/// `engelbart:sandbox-progress` (the manager's `notify`, wired by `SandboxService.makeManager`).
public final class SandboxService: @unchecked Sendable {
    public static let progressEvent = "engelbart:sandbox-progress"
    public static let turnedOff = "Sandboxes are turned off in this copy of Engelbart"
    public static let waitForModeChange = "Wait for the data mode change to finish"

    /// nil when sandboxes are off (`ENGELBART_SANDBOXES=off`): nothing to show, and nothing starts.
    public let manager: SandboxManager?
    let context: () async throws -> SandboxContext
    private let changing = Locked(false)
    private let additions = SerialChain()

    public init(manager: SandboxManager?, context: @escaping () async throws -> SandboxContext) {
        self.manager = manager; self.context = context
    }

    /// The manager as index.cjs makes it: progress to every window (EventHub), unless `ENGELBART_SANDBOXES=off`.
    public static func makeManager(_ options: SandboxManager.Options, environment: [String: String] = ProcessInfo.processInfo.environment,
                                   hub: EventHub = .shared) -> SandboxManager? {
        if environment["ENGELBART_SANDBOXES"] == "off" { return nil }
        var o = options
        let notify = o.notify
        o.notify = { event in notify(event); hub.post(progressEvent, event) }
        return SandboxManager(o)
    }

    static func id(_ value: String?, _ what: String) throws -> String {
        guard let value, value.utf16.count <= 64 else { throw SandboxError("\(what) must be a string of at most 64 characters") }
        return value
    }

    var modeChanging: Bool { changing.value }

    func on() throws -> SandboxManager {
        guard let manager else { throw SandboxError(Self.turnedOff) }
        return manager
    }

    /// Library additions and workspace links that can start a sandbox run one at a time (ipc.cjs's `queued`).
    public func queued<T>(_ work: @escaping () async throws -> T) async throws -> T {
        if modeChanging { throw SandboxError(Self.waitForModeChange) }
        let result = Deferred<T>()
        _ = additions.enqueue { do { result.resolve(try await work()) } catch { result.reject(error) } }
        return try await result.wait()
    }

    /// A data-mode change: the queued additions finish, then every sandbox is put to sleep or stopped before the old library
    /// closes (ipc.cjs's `changing`). `before`: the app's own steps first (beforeContextChange, Connect's suspend).
    public func changeMode<T>(before: () async -> Void = {}, _ change: () async throws -> T) async throws -> T {
        if changing.with({ let was = $0; $0 = true; return was }) { throw SandboxError("Data mode is already changing") }
        defer { changing.with { $0 = false } }
        await additions.idle()
        await before()
        await manager?.close()
        return try await change()
    }

    // MARK: Channels

    /// `sandbox-runs`.
    public func runs() async throws -> [JSONValue] {
        guard let manager else { return [] }
        return try manager.list(try await context())
    }

    /// `sandbox-ensure`: every saved GitHub repository is prepared once per app session.
    public func ensure() async throws -> [JSONValue] {
        guard let manager else { return [] }
        return try await queued { [self] in
            let ctx = try await context()
            var errors: [String] = []
            for row in try ctx.db.libraryRows() where (row["tags"]?.array ?? []).contains("git") {
                do { _ = try await manager.start(ctx, row["id"]?.string ?? "", automatic: true) }
                catch { errors.append("\(row["name"]?.string ?? ""): \(message(of: error))") }
            }
            if !errors.isEmpty { throw SandboxError(errors.joined(separator: "\n")) }
            return try manager.list(ctx)
        }
    }

    /// `sandbox-start`.
    public func start(_ libraryId: String?) async throws -> SandboxRun? {
        let manager = try on()
        if modeChanging { throw SandboxError(Self.waitForModeChange) }
        return try await manager.start(try await context(), try Self.id(libraryId, "library id"))
    }

    /// `sandbox-stop` (a run id).
    public func stop(_ runId: String?) async throws -> SandboxRun? {
        try await on().stop(try await context(), try Self.id(runId, "run id"))
    }

    /// `sandbox-touch`: the Stage's ping while a preview is in front of a focused window. Answers nothing.
    public func touch(_ libraryId: String?) async throws {
        guard let manager else { return }
        let id = try Self.id(libraryId, "library id")
        if modeChanging { return }
        try await manager.touch(try await context(), id)
    }

    /// `sandbox-terminal`: the session's snapshot, the one already open if there is one.
    public func terminal(_ libraryId: String?) async throws -> JSONValue {
        let manager = try on()
        if modeChanging { throw SandboxError(Self.waitForModeChange) }
        return try await manager.terminal(try await context(), try Self.id(libraryId, "library id"))
    }

    /// `sandbox-environment`.
    public func environment(_ libraryId: String?) async throws -> EnvironmentDescription {
        try on().environment(try await context(), try Self.id(libraryId, "library id"))
    }

    /// `sandbox-save-environment`.
    public func saveEnvironment(_ libraryId: String?, _ changes: [EnvironmentChange], revision: String?) async throws -> EnvironmentDescription {
        let manager = try on()
        if modeChanging { throw SandboxError(Self.waitForModeChange) }
        return try await manager.saveEnvironment(try await context(), try Self.id(libraryId, "library id"), changes, revision: revision)
    }

    /// `sandbox-restart`.
    @discardableResult
    public func restart(_ libraryId: String?) async throws -> SandboxRun {
        let manager = try on()
        if modeChanging { throw SandboxError(Self.waitForModeChange) }
        return try await manager.restart(try await context(), try Self.id(libraryId, "library id"))
    }

    // MARK: Library hooks (ipc.cjs's `added`, `startLinked`, onboarding's untick)

    /// Whether a just-added library row is a GitHub repository whose sandbox starts with it: tagged `git`, and added from a
    /// GitHub address (a local clone or another item starts no remote work).
    public static func startsOnAdd(row: JSONValue, value: String) -> Bool {
        (row["tags"]?.array ?? []).contains("git")
            && value.trimmed.matches(#"^(?:(?:https?://)?(?:www\.)?github\.com/|git@github\.com:)"#, options: .caseInsensitive)
    }

    /// After saving a row: its sandbox starts (waiting for Claude Code's sign-in rather than failing the save); a failure to
    /// start leaves the row saved and says why (`sandbox_error`).
    public func added(_ ctx: SandboxContext, row: JSONValue, value: String) async -> JSONValue {
        guard let manager, Self.startsOnAdd(row: row, value: value), let id = row["id"]?.string else { return row }
        do { _ = try await manager.start(ctx, id, waitForClaude: true) } catch {
            var o = row.object ?? [:]
            o["sandbox_error"] = .string(message(of: error))
            return .object(o)
        }
        return row
    }

    /// A saved GitHub repository newly in a workspace is a request to use it: its sandbox starts, or the one running is
    /// reused. → the errors (`<name>: <message>` lines) for `sandbox_error`, or nil.
    public func startLinked(_ ctx: SandboxContext, before: Set<String>, context ids: [String]) async -> String? {
        guard let manager else { return nil }
        var errors: [String] = []
        for id in ids where !before.contains(id) {
            guard let row = try? ctx.db.libraryRow(id), GithubRepo.parse(row["url"]?.string) != nil else { continue }
            do { _ = try await manager.start(ctx, id, waitForClaude: true) } catch { errors.append("\(row["name"]?.string ?? ""): \(message(of: error))") }
        }
        return errors.isEmpty ? nil : errors.joined(separator: "\n")
    }

    /// Before a repository's row is deleted: its sandbox stopped and its runs forgotten (nil when sandboxes are off).
    public func release(_ ctx: SandboxContext, _ libraryId: String) async throws {
        try await manager?.release(ctx, libraryId)
    }

    // MARK: Sign-in and quit (index.cjs)

    /// GitHub connected: the key is fetched early so the first sandbox need not wait. Signed out (or expired): the key is
    /// dropped and the sandboxes started with it stop (not with a developer's own key, which is not tied to the sign-in).
    public func githubChanged(connected: Bool, key: E2BKey, developerKey: Bool) {
        if connected { Task { _ = try? await key.get() }; return }
        key.forget()
        if !developerKey, let manager { Task { await manager.signedOut() } }
    }

    /// Quit: a ready preview goes to sleep, one being set up stops. One that cannot be reached does not hold the quit.
    public func quit() async { await manager?.dispose() }
}
