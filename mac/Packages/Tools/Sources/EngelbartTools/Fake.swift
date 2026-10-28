import EngelbartCore
import Foundation

// Scripted runs only (ENGELBART_TOOLS_FAKE; src/main/tools/fake.cjs): a pretend machine, so the setup dialog can be driven
// without touching real installs. The spec names each tool's state:
//   {"git":"missing","claude":"2.1.300","codex":"0.150.0 signed-out"}
// "missing", "broken", or a version optionally followed by " signed-out"; for git also "bundled" (the Git that came with
// Engelbart, standing in). Installing takes `delay` and gives the tool its minimum version; updating does the same;
// signing in takes `delay` too; signing out is quick. `failInstall` names tools whose install fails with a network error.
// A signed-in agent is signed in as FAKE_ACCOUNT. 2026-10-14 (onboarding's connect edge cases): " unknown" after a version
// is a CLI whose sign-in check does not answer (signedIn nil, as `auth status` timing out); " no-plan" one signed in
// without a subscription; `signInNever` names agents whose sign-in waits in the browser until it is cancelled;
// `authStatusJSON` answers `claude auth status --json` for this machine (onboarding's providers).

public let FAKE_ACCOUNT = "researcher@example.com"

public struct FakeTool: Equatable, Sendable {
    public var present = false
    public var broken = false
    public var bundled = false
    public var version: String?
    /// nil: its sign-in check does not answer.
    public var signedIn: Bool?
    public var plan: String?
}

public struct FakeSpec: Sendable {
    public var state: [String: FakeTool]
    public var failInstall: [String]
    public var signInNever: [String]
}

public func parseFakeSpec(_ value: String?) -> FakeSpec {
    let input = (value.flatMap { try? JSONValue.parse($0) })?.object ?? [:]
    var state: [String: FakeTool] = [:]
    for name in TOOL_NAMES {
        let given = input[name]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? (name == "git" ? "2.50.1" : Requirements[name].minimum)
        let text = given.trimmingCharacters(in: .whitespacesAndNewlines)
        var tool = FakeTool()
        if text == "missing" { tool.present = false }
        else if text == "bundled" && name == "git" { tool = FakeTool(present: true, bundled: true, version: "2.53.0") }
        else if text == "broken" { tool = FakeTool(present: true, broken: true) }
        else {
            let parts = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            let flag = parts.count > 1 ? parts[1] : nil
            tool = FakeTool(present: true, version: parts.first, signedIn: flag == "unknown" ? nil : flag != "signed-out",
                            plan: flag == "no-plan" ? nil : name == "codex" ? "plus" : "max")
        }
        state[name] = tool
    }
    let list = { (key: String) in (input[key]?.array ?? []).compactMap { $0.string } }
    return FakeSpec(state: state, failInstall: list("failInstall"), signInNever: list("signInNever"))
}

public final class FakeTools: ToolActions, @unchecked Sendable {
    private let spec: String?
    private let lock = NSLock()
    private var _state: [String: FakeTool]
    let failInstall: [String]
    let signInNever: [String]
    let delay: TimeInterval
    let sleep: @Sendable (TimeInterval) async -> Void
    let now: @Sendable () -> Date

    public init(_ spec: String?, delay: TimeInterval = 2.5,
                sleep: @escaping @Sendable (TimeInterval) async -> Void = pause,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.spec = spec
        let parsed = parseFakeSpec(spec)
        _state = parsed.state
        failInstall = parsed.failInstall
        signInNever = parsed.signInNever
        self.delay = delay
        self.sleep = sleep
        self.now = now
    }

    public var state: [String: FakeTool] { lock.lock(); defer { lock.unlock() }; return _state }

    func set(_ name: String, _ change: (inout FakeTool) -> Void) {
        lock.lock(); var tool = _state[name] ?? FakeTool(); change(&tool); _state[name] = tool; lock.unlock()
    }

    /// The pretend machine as it started (test mode's reset, 2026-10-15: its installs stayed, so setup never showed again).
    public func reset() {
        let fresh = parseFakeSpec(spec).state
        lock.lock(); _state = fresh; lock.unlock()
    }

    func fakePath(_ name: String) -> String {
        if name == "git" { return state["git"]?.bundled == true ? "/Users/fake/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git" : "/usr/bin/git" }
        return "/Users/fake/.local/bin/\(name)"
    }

    public func detect(_ only: [String] = TOOL_NAMES) async -> DetectResult {
        await sleep(min(0.4, delay))
        var out: [String: Fields] = [:]
        for name in only {
            let tool = state[name] ?? FakeTool()
            var found: Fields
            if !tool.present { found = observed(name) }
            else if tool.broken {
                found = observed(name, Found(file: fakePath(name), onPath: true, source: "other", ran: false, error: "\(Requirements[name].name) did not start: exit status 1"))
            } else {
                found = observed(name, Found(file: fakePath(name), onPath: !tool.bundled, source: name == "git" ? (tool.bundled ? "bundled" : "apple") : "native",
                                             ran: true, version: tool.version, signedIn: name == "git" ? nil : tool.signedIn, account: FAKE_ACCOUNT))
            }
            found["checkedAt"] = .string(Time.iso(now()))
            out[name] = found
        }
        return DetectResult(tools: out)
    }

    // MARK: actions

    public func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult {
        onPhase("Waiting for Apple’s installer")
        await sleep(delay)
        if failInstall.contains("git") { return ActionResult(ok: false, error: "Apple’s installer was closed before it finished.", kind: "cancelled") }
        set("git") { $0 = FakeTool(present: true, version: "2.50.1") }
        return .done
    }

    public func installAgent(_ name: String) async -> ActionResult {
        await sleep(delay)
        if failInstall.contains(name) {
            return ActionResult(ok: false, error: "The installer could not be reached: no internet connection (curl: (6) Could not resolve host: claude.ai).", kind: "network")
        }
        set(name) { $0 = FakeTool(present: true, version: Requirements[name].minimum, signedIn: false, plan: name == "codex" ? "plus" : "max") }
        return .done
    }

    public func updateAgent(_ name: String, _ file: String?) async -> ActionResult {
        await sleep(delay)
        set(name) { $0.present = true; $0.broken = false; $0.version = Requirements[name].minimum }
        return .done
    }

    public func updateGit(_ source: String?) async -> ActionResult {
        ActionResult(ok: false, error: "Apple’s Git is updated by macOS: System Settings › General › Software Update.", kind: "other")
    }

    // MARK: sign-in

    final class Run: SignInRun, @unchecked Sendable {
        let done = Once<SignInExit>()
        var timers: [DispatchWorkItem] = []
        func wait() async -> SignInExit { await done.wait() }
        func kill() { timers.forEach { $0.cancel() }; done.resolve(SignInExit(code: 130, output: "Cancelled.")) }
    }

    public var signInStarter: SignInStarter {
        return { [self] name, _, onUrl in
            let run = Run()
            let url = DispatchWorkItem { onUrl("https://example.invalid/\(name)/sign-in") }
            run.timers.append(url)
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.2, execute: url)
            if !signInNever.contains(name) {
                let complete = DispatchWorkItem { [self] in
                    set(name) { $0.signedIn = true }
                    run.done.resolve(SignInExit(code: 0, output: ""))
                }
                run.timers.append(complete)
                DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: complete)
            }
            return run
        }
    }

    public var signOutRunner: SignOutRunner {
        return { [self] name, _ in
            await sleep(min(0.4, delay))
            set(name) { $0.signedIn = false }
            return SignInExit(code: 0, output: "")
        }
    }

    /// `claude auth status --json` as this machine's Claude Code says it: nil when it is not there or broken (not found),
    /// `.timedOut` when its sign-in check does not answer.
    public enum AuthStatus: Equatable { case notFound, timedOut, json(String) }

    public func authStatusJSON(_ args: [String]) async -> AuthStatus {
        try? await Task.sleep(nanoseconds: 20_000_000)
        let tool = state["claude"] ?? FakeTool()
        if !tool.present || tool.broken || args.first != "auth" { return .notFound }
        guard let signedIn = tool.signedIn else { return .timedOut }
        let value: JSONValue = signedIn
            ? ["loggedIn": true, "authMethod": "claude.ai", "email": .string(FAKE_ACCOUNT), "subscriptionType": tool.plan.map(JSONValue.string) ?? .null]
            : ["loggedIn": false, "authMethod": "none"]
        return .json(value.text())
    }
}
