import EngelbartCore
import XCTest
@testable import EngelbartTools

// test/tools.test.cjs: the manager over a real config.json in a temp root, with a pretend machine.
@MainActor
final class ManagerTests: XCTestCase {
    final class Seen: @unchecked Sendable { var list: [ToolsSnapshot] = [] }
    struct Harness { let tools: ToolsManager; let fake: FakeTools; let config: ConfigFile; let seen: Seen }

    func managerFor(_ spec: String, detect: ((FakeTools) -> ToolsManager.Detect)? = nil, actions: ToolActions? = nil, signOut: ((FakeTools) -> SignOutRunner)? = nil,
                    now: (() -> Date)? = nil, installAtLaunch: [String] = [], config: ConfigFile = ConfigFile()) -> Harness {
        let fake = FakeTools(spec, delay: 0, sleep: { _ in })
        let seen = Seen()
        let tools = ToolsManager(storage: config.storage, detect: detect?(fake) ?? { await fake.detect($0) }, actions: actions ?? fake, signIn: fake.signInStarter,
                                 signOut: signOut?(fake) ?? fake.signOutRunner, installAtLaunch: installAtLaunch, now: now ?? { Date() },
                                 onChange: { seen.list.append($0) })
        return Harness(tools: tools, fake: fake, config: config, seen: seen)
    }

    func testTheLaunchCheckWritesWhatItSawIntoConfigJSON() async {
        let h = managerFor(#"{"git":"missing","claude":"2.1.300","codex":"0.155.1 signed-out"}"#)
        XCTAssertEqual(h.config.tools["git"].installed, false, "false until a check says otherwise")
        await h.tools.start()
        let written = h.config.tools
        XCTAssertEqual([written["git"].installed ? "true" : "false", written["git"].status], ["false", "missing"])
        XCTAssertEqual(written["claude"].installed, true)
        XCTAssertEqual([written["claude"].version, written["claude"].requires, written["claude"].status], ["2.1.300", ">=2.1.278", "ready"])
        XCTAssertEqual(written["codex"].status, "signed-out")
        XCTAssertEqual(written["codex"].signedIn, false)
        XCTAssertNotNil(written["claude"].checkedAt)
        XCTAssertEqual(h.tools.usableAgents(), ["claude"])
        XCTAssertTrue(h.tools.snapshot().checked)
        let raw = h.config.config!["tools"]!
        XCTAssertEqual(raw["git"]?["installed"], false, "the booleans Hudson asked for")
        XCTAssertEqual(raw["claude"]?["installed"], true)
    }

    func testAnOutdatedAgentIsUpdatedAtLaunchUnlessPinnedSkippedOrAsked() async {
        let allowed = managerFor(#"{"codex":"0.150.0"}"#)
        await allowed.tools.start()
        XCTAssertEqual([allowed.config.tools["codex"].version, allowed.config.tools["codex"].status], ["0.155.0", "ready"])

        for (key, value, why) in [("pin", JSONValue.string("0.150.0"), "pinned"), ("skip", JSONValue.bool(true), "skipped")] {
            let config = ConfigFile()
            var tools = config.config!["tools"]!.object!
            var codex = tools["codex"]!.object!
            codex[key] = value
            tools["codex"] = .object(codex)
            config.writeTools(.object(tools))
            let held = managerFor(#"{"codex":"0.150.0"}"#, config: config)
            await held.tools.start()
            XCTAssertEqual(held.config.tools["codex"].version, "0.150.0", why)
            XCTAssertEqual(held.tools.snapshot().tools["codex"]?.autoUpdate, false, why)
        }

        let config = ConfigFile()
        var off = config.config!["tools"]!.object!
        off["updates"] = "ask"
        config.writeTools(.object(off))
        let asked = managerFor(#"{"codex":"0.150.0"}"#, config: config)
        await asked.tools.start()
        XCTAssertEqual(asked.config.tools["codex"].version, "0.150.0", "tools.updates = ask")
    }

    final class FailingUpdate: ToolActions, @unchecked Sendable {
        let base: FakeTools
        init(_ base: FakeTools) { self.base = base }
        func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult { await base.installGit(onPhase: onPhase) }
        func installAgent(_ name: String) async -> ActionResult { await base.installAgent(name) }
        func updateAgent(_ name: String, _ file: String?) async -> ActionResult { ActionResult(ok: false, error: "The installer could not be reached: no internet connection.", kind: "network") }
        func updateGit(_ source: String?) async -> ActionResult { await base.updateGit(source) }
    }

    func testAnUpdateThatFailsIsRetriedOnlyAfterADay() async {
        var clock = Time.parse("2026-09-23T12:00:00Z")!
        let fake = FakeTools(#"{"claude":"2.1.200"}"#, delay: 0, sleep: { _ in })
        let config = ConfigFile()
        let tools = ToolsManager(storage: config.storage, detect: { await fake.detect($0) }, actions: FailingUpdate(fake), now: { clock })
        await tools.start()
        let record = config.tools["claude"]
        XCTAssertEqual(record.status, "outdated")
        XCTAssertEqual(record.failedUpdate?.from, "2.1.200")
        XCTAssertTrue(record.error?.contains("no internet") == true)
        XCTAssertFalse(tools.canAutoUpdate("claude"))
        clock = clock.addingTimeInterval(25 * 60 * 60)
        XCTAssertTrue(tools.canAutoUpdate("claude"))
    }

    func testAnInstallIsVerifiedAFailureKeepsItsReasonSkipIsRemembered() async {
        let h = managerFor(#"{"git":"missing","claude":"missing","codex":"missing","failInstall":["codex"]}"#)
        await h.tools.start()
        let out = await h.tools.install(["git", "claude", "codex", "vim"])
        XCTAssertEqual([out["git"]?.ok, out["claude"]?.ok, out["codex"]?.ok], [true, true, false])
        XCTAssertNil(out["vim"])
        XCTAssertEqual(out["codex"]?.kind, "network")
        let written = h.config.tools
        XCTAssertEqual(written["git"].installed, true)
        XCTAssertEqual(written["git"].status, "ready")
        XCTAssertEqual(written["claude"].status, "signed-out", "a fresh Claude Code is installed and not yet signed in: the install worked, signing in is next")
        XCTAssertEqual(written["codex"].status, "missing")
        XCTAssertTrue(written["codex"].error?.contains("no internet connection") == true)
        h.tools.skip(["codex"])
        XCTAssertTrue(h.config.tools["codex"].skip)
        h.tools.askAgain("codex")
        XCTAssertFalse(h.config.tools["codex"].skip)
        h.tools.setUpdates("ask")
        XCTAssertEqual(h.config.tools.updates, "ask")
        h.tools.setUpdates("whatever")
        XCTAssertEqual(h.config.tools.updates, "auto")
    }

    func testAnInstallClearsSkipAndGitReportsApplesPhase() async {
        let fake = FakeTools(#"{"git":"missing"}"#, delay: 0.1)
        let seen = Seen()
        let config = ConfigFile()
        let h = Harness(tools: ToolsManager(storage: config.storage, detect: { await fake.detect($0) }, actions: fake, onChange: { seen.list.append($0) }), fake: fake, config: config, seen: seen)
        await h.tools.start()
        h.tools.skip(["git"])
        await h.tools.install(["git"])
        XCTAssertEqual(rowOf(ToolSnapshot(record: h.tools.current["git"], busy: Busy(action: "install", phase: "Waiting for Apple’s installer"))).state, "Waiting for Apple’s installer")
        XCTAssertFalse(h.config.tools["git"].skip)
        await eventually { h.seen.list.contains { $0.tools["git"]?.busy?.phase == "Waiting for Apple’s installer" } }
    }

    func testTheSkipAndPinWrittenByHandAreNeverOverwrittenByACheck() async {
        let h = managerFor(#"{"git":"missing"}"#)
        await h.tools.start()
        var byHand = h.config.config!["tools"]!.object!
        var git = byHand["git"]!.object!; git["skip"] = true; byHand["git"] = .object(git)
        var claude = byHand["claude"]!.object!; claude["pin"] = "2.1.278"; byHand["claude"] = .object(claude)
        h.config.writeTools(.object(byHand))
        await h.tools.check()
        XCTAssertEqual(h.config.tools["git"].skip, true)
        XCTAssertEqual(h.config.tools["claude"].pin, "2.1.278")
    }

    final class BreakingUpdate: ToolActions, @unchecked Sendable {
        let launcher: String, versions: String
        init(_ launcher: String, _ versions: String) { self.launcher = launcher; self.versions = versions }
        func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult { .done }
        func installAgent(_ name: String) async -> ActionResult { .done }
        func updateAgent(_ name: String, _ file: String?) async -> ActionResult {
            try? FileManager.default.removeItem(atPath: launcher)
            try? FileManager.default.createSymbolicLink(atPath: launcher, withDestinationPath: "\(versions)/2.1.300")
            return .done
        }
        func updateGit(_ source: String?) async -> ActionResult { .done }
    }

    func testAnUpdateThatLeavesTheLauncherBrokenIsPutBack() async {
        let home = temp()
        let versions = "\(home)/.local/share/claude/versions"
        write("\(versions)/2.1.200", "old")
        write("\(versions)/2.1.300", "broken")
        mkdirs("\(home)/.local/bin")
        let launcher = "\(home)/.local/bin/claude"
        try! FileManager.default.createSymbolicLink(atPath: launcher, withDestinationPath: "\(versions)/2.1.200")
        let config = ConfigFile()
        // what `claude --version` says follows the launcher: the new version file does not run
        let detect: ToolsManager.Detect = { only in
            let target = (try? FileManager.default.destinationOfSymbolicLink(atPath: launcher)) ?? ""
            let claude = target.hasSuffix("2.1.300")
                ? observed("claude", Found(file: launcher, onPath: true, source: "native", ran: false, error: "Claude Code did not start: exit status 1"))
                : observed("claude", Found(file: launcher, onPath: true, source: "native", ran: true, version: "2.1.200", signedIn: true))
            return DetectResult(tools: only.contains("claude") ? ["claude": claude] : [:])
        }
        let tools = ToolsManager(storage: config.storage, detect: detect, actions: BreakingUpdate(launcher, versions), rollbackOptions: RollbackOptions(home: home, env: [:]))
        await tools.check(["claude"])
        let out = await tools.update("claude")
        XCTAssertFalse(out.ok)
        XCTAssertTrue(out.error?.contains("broke Claude Code, so 2.1.200 was put back") == true, out.error ?? "")
        XCTAssertEqual(try? String(contentsOfFile: launcher, encoding: .utf8), "old")
        XCTAssertEqual(config.tools["claude"].version, "2.1.200")
        XCTAssertEqual(config.tools["claude"].failedUpdate?.from, "2.1.200")
    }

    func testAnUpdateWithNoCopyToGoBackToSaysSo() async {
        let config = ConfigFile()
        final class Box: @unchecked Sendable { var broken = false }
        let box = Box()
        let detect: ToolsManager.Detect = { _ in
            DetectResult(tools: ["codex": box.broken
                ? observed("codex", Found(file: "/opt/homebrew/bin/codex", onPath: true, source: "homebrew", ran: false, error: "Codex did not start: exit status 1"))
                : observed("codex", Found(file: "/opt/homebrew/bin/codex", onPath: true, source: "homebrew", ran: true, version: "0.150.0", signedIn: true))])
        }
        final class Breaks: ToolActions, @unchecked Sendable {
            let box: Box
            init(_ box: Box) { self.box = box }
            func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult { .done }
            func installAgent(_ name: String) async -> ActionResult { .done }
            func updateAgent(_ name: String, _ file: String?) async -> ActionResult { box.broken = true; return .done }
            func updateGit(_ source: String?) async -> ActionResult { .done }
        }
        let tools = ToolsManager(storage: config.storage, detect: detect, actions: Breaks(box))
        await tools.check(["codex"])
        let out = await tools.update("codex")
        XCTAssertEqual(out.error, "Codex did not start: exit status 1 A homebrew install keeps no earlier copy to go back to.")
        let missing = await ToolsManager(storage: ConfigFile().storage, detect: { _ in DetectResult(tools: [:]) }, actions: Breaks(box)).update("codex")
        XCTAssertEqual(missing.error, "Codex is not installed.")
    }

    func testAnUpdateThatStillDoesNotMeetTheMinimumIsKept() async {
        let fake = FakeTools(#"{"codex":"0.150.0"}"#, delay: 0, sleep: { _ in })
        final class Stays: ToolActions, @unchecked Sendable {
            func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult { .done }
            func installAgent(_ name: String) async -> ActionResult { .done }
            func updateAgent(_ name: String, _ file: String?) async -> ActionResult { .done }
            func updateGit(_ source: String?) async -> ActionResult { .done }
        }
        let config = ConfigFile()
        let tools = ToolsManager(storage: config.storage, detect: { await fake.detect($0) }, actions: Stays())
        await tools.check()
        let out = await tools.update("codex")
        XCTAssertEqual(out.error, "Codex updated to 0.150.0 that still does not meet 0.155.0.")
        XCTAssertEqual(config.tools["codex"].status, "outdated")
    }

    func testSignInWaitsForTheCLIShowsItsPageAndChecksAgain() async {
        let h = managerFor(#"{"claude":"2.1.300 signed-out"}"#)
        await h.tools.start()
        await h.tools.signIn("claude")
        XCTAssertTrue(h.seen.list.contains { $0.tools["claude"]?.busy?.action == "sign-in" })
        XCTAssertEqual(h.config.tools["claude"].signedIn, true)
        XCTAssertEqual(h.config.tools["claude"].status, "ready")
    }

    func testSignInPassesItsPageOnAndCancelSaysWhy() async {
        let h = managerFor(#"{"claude":"2.1.300 signed-out","signInNever":["claude"]}"#)
        await h.tools.start()
        let pressed = Task { await h.tools.signIn("claude") }
        await eventually { h.tools.snapshot().tools["claude"]?.busy?.url == "https://example.invalid/claude/sign-in" }
        XCTAssertEqual(rowOf(h.tools.snapshot().tools["claude"]!).page, "https://example.invalid/claude/sign-in")
        XCTAssertTrue(h.tools.cancelSignIn("claude"))
        _ = await pressed.value
        XCTAssertFalse(h.tools.cancelSignIn("claude"), "none running")
        XCTAssertEqual(h.config.tools["claude"].error, "Not signed in: Cancelled.")
        XCTAssertNil(h.tools.snapshot().tools["claude"]?.busy)
    }

    func testTheSignInLimitEndsIt() async {
        let fake = FakeTools(#"{"claude":"2.1.300 signed-out","signInNever":["claude"]}"#, delay: 0, sleep: { _ in })
        let tools = ToolsManager(storage: .memory(), detect: { await fake.detect($0) }, actions: fake, signIn: fake.signInStarter, signInLimit: 0.2)
        await tools.check()
        await tools.signIn("claude")
        XCTAssertEqual(tools.current["claude"].status, "signed-out")
        XCTAssertEqual(tools.current["claude"].error, "Not signed in: Cancelled.")
    }

    final class Calls: @unchecked Sendable { let l = NSLock(); var list: [[String]] = []; func add(_ c: [String]) { l.lock(); list.append(c); l.unlock() }; var all: [[String]] { l.lock(); defer { l.unlock() }; return list } }

    func testSignOutRunsTheCLIsLogoutThenChecksThatTool() async {
        let calls = Calls()
        let h = managerFor(#"{"claude":"2.1.300","codex":"0.155.1"}"#,
                           detect: { fake in { only in calls.add(["check"] + only); return await fake.detect(only) } },
                           signOut: { fake in { name, file in calls.add(["logout", name, file]); return await fake.signOutRunner(name, file) } })
        await h.tools.start()
        XCTAssertEqual(h.config.tools["claude"].status, "ready")
        XCTAssertEqual(h.config.tools["claude"].account, "researcher@example.com")
        XCTAssertEqual(h.tools.snapshot().tools["claude"]?.account, "researcher@example.com", "who is signed in, through the record to the rows")
        calls.list = []
        h.seen.list = []
        let out = await h.tools.signOut("claude")
        XCTAssertEqual(out, ActionResult(ok: true, error: nil))
        XCTAssertEqual(calls.all, [["logout", "claude", "/Users/fake/.local/bin/claude"], ["check", "claude"]], "the logout first, then a check of that tool only")
        XCTAssertEqual(h.seen.list.first?.tools["claude"]?.busy?.action, "sign-out", "the rows say it is signing out while the CLI runs")
        XCTAssertEqual(h.config.tools["claude"].signedIn, false)
        XCTAssertEqual(h.config.tools["claude"].status, "signed-out")
        XCTAssertNil(h.config.tools["claude"].account)
        XCTAssertEqual(h.config.tools["codex"].status, "ready", "Codex is left signed in")
        XCTAssertNil(h.tools.snapshot().tools["claude"]?.busy)
    }

    func testASignOutTheCLIRefusesSaysWhyAndNoneStartsWhileSigningIn() async {
        let refused = managerFor(#"{"codex":"0.155.1"}"#, signOut: { _ in { _, _ in SignInExit(code: 1, output: "Error: could not remove auth.json") } })
        await refused.tools.start()
        let r = await refused.tools.signOut("codex")
        XCTAssertEqual(r, ActionResult(ok: false, error: "Could not sign out of Codex: Error: could not remove auth.json"))
        XCTAssertEqual(refused.config.tools["codex"].status, "ready", "still signed in, as the check found")
        let silent = managerFor(#"{"claude":"2.1.300"}"#, signOut: { _ in { _, _ in SignInExit(code: 0, output: "") } })
        await silent.tools.start()
        let s = await silent.tools.signOut("claude")
        XCTAssertEqual(s, ActionResult(ok: false, error: "Claude Code still says it is signed in."))

        let calls = Calls()
        let h = managerFor(#"{"git":"2.50.1","claude":"2.1.300 signed-out","codex":"missing","signInNever":["claude"]}"#,
                           signOut: { _ in { name, _ in calls.add([name]); return SignInExit(code: 0, output: "") } })
        await h.tools.start()
        let git = await h.tools.signOut("git")
        XCTAssertEqual(git, ActionResult(ok: false, error: nil))
        let codex = await h.tools.signOut("codex")
        XCTAssertEqual(codex, ActionResult(ok: false, error: nil), "not installed: nothing to run")
        let signing = Task { await h.tools.signIn("claude") }
        await eventually { h.tools.snapshot().tools["claude"]?.busy?.action == "sign-in" }
        let during = await h.tools.signOut("claude")
        XCTAssertEqual(during, ActionResult(ok: false, error: nil), "not in the middle of a sign-in")
        h.tools.cancelSignIn("claude")
        _ = await signing.value
        XCTAssertEqual(calls.all, [])
    }

    final class Overlap: ToolActions, @unchecked Sendable {
        let l = NSLock()
        var running = 0
        var overlapped = false
        func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult { .done }
        func installAgent(_ name: String) async -> ActionResult { .done }
        func updateAgent(_ name: String, _ file: String?) async -> ActionResult { l.lock(); if running > 0 { overlapped = true }; l.unlock(); return .done }
        func updateGit(_ source: String?) async -> ActionResult { .done }
    }

    func testRunsAndUpdatesOfTheSameProgramNeverOverlap() async {
        let actions = Overlap()
        let h = managerFor(#"{"codex":"0.150.0"}"#, actions: actions)
        await h.tools.check()
        let release = Once<Void>()
        let started = Once<Void>()
        let run = Task.detached { await h.tools.use("codex") { actions.l.lock(); actions.running += 1; actions.l.unlock(); started.resolve(()); await release.wait(); actions.l.lock(); actions.running -= 1; actions.l.unlock() } }
        await started.wait()
        let update = Task { await h.tools.update("codex") }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(h.tools.snapshot().tools["codex"]?.busy, nil, "the update has not started: it waits for the run")
        release.resolve(())
        _ = await run.value
        _ = await update.value
        XCTAssertFalse(actions.overlapped)
    }

    func testTheTerminalsMenuKeepsItsShapeAndAProgramOffPathRunsByFullPath() async {
        let h = managerFor(#"{"claude":"2.1.300","codex":"missing"}"#)
        await h.tools.start()
        let menu = await h.tools.providers(shellPath: "/bin/zsh")
        XCTAssertEqual(menu.map { "\($0.id):\($0.available)" }, ["shell:true", "claude:true", "codex:false"])
        XCTAssertEqual(menu[0].path, "/bin/zsh")
        XCTAssertEqual(menu[1].authenticated, true)
        XCTAssertNil(h.tools.binaryFor("claude"), "on PATH: its name is enough")
    }

    func testWhileEngelbartsOwnGitStandsInEverythingItStartsIsGivenItsFolder() async {
        let h = managerFor(#"{"git":"bundled"}"#)
        XCTAssertEqual(h.tools.environment(), [:], "nothing before a check")
        await h.tools.start()
        XCTAssertEqual(h.config.tools["git"].source, "bundled")
        XCTAssertEqual(h.config.tools["git"].status, "ready")
        XCTAssertEqual(h.tools.environment(), [:], "the launcher named by the record is not on this disk (the app moved): nothing, until the next check")
        let launcher = "\(temp())/engelbart-bin/git"
        write(launcher, "#!/bin/sh\n", mode: 0o755)
        let config = h.config
        let byDisk = ToolsManager(storage: config.storage, detect: { _ in
            var git = observed("git", Found(file: launcher, onPath: false, source: "bundled", ran: true, version: "2.53.0"))
            git["checkedAt"] = .string(Time.iso())
            return DetectResult(tools: ["git": git])
        }, actions: FakeTools(nil, delay: 0))
        await byDisk.check(["git"])
        XCTAssertEqual(byDisk.environment(), ["ENGELBART_GIT_BIN": (launcher as NSString).deletingLastPathComponent])
        let own = managerFor(#"{"git":"2.50.1"}"#)
        await own.tools.start()
        XCTAssertEqual(own.tools.environment(), [:], "the person's own Git: PATH is left as it is")
    }

    func testAnAgentInstalledWherePathMissesItHandsItsFolderToEverything() async {
        let home = temp()
        let launcher = "\(home)/.local/bin/claude"
        write(launcher, "#!/bin/sh\n", mode: 0o755)
        let tools = ToolsManager(storage: ConfigFile().storage, detect: { _ in
            var claude = observed("claude", Found(file: launcher, onPath: false, source: "native", ran: true, version: "2.1.300", signedIn: false))
            claude["checkedAt"] = .string(Time.iso())
            return DetectResult(tools: ["claude": claude])
        }, actions: FakeTools(nil, delay: 0))
        await tools.check(["claude"])
        XCTAssertEqual(tools.environment(), ["ENGELBART_AGENT_PATH": (launcher as NSString).deletingLastPathComponent, "ENGELBART_CLAUDE_BIN": launcher],
                       "and its full path, which the terminal's Claude Code item runs (2026-09-30)")
        XCTAssertEqual(tools.binaryFor("claude"), launcher)
    }

    func testOnAMacWithNeitherAgentClaudeCodeIsInstalledAtLaunch() async {
        let fresh = managerFor(#"{"claude":"missing","codex":"missing"}"#, installAtLaunch: ["claude"])
        await fresh.tools.start()
        await eventually { fresh.tools.snapshot().tools["claude"]?.status == "signed-out" }
        let written = fresh.config.tools
        XCTAssertEqual([written["claude"].installed, written["codex"].installed], [true, false], "Claude Code installed, waiting for its sign-in; Codex left to the person")
        XCTAssertTrue(fresh.seen.list.contains { $0.checked && $0.tools["claude"]?.busy?.action == "install" }, "the dialog saw it installing")

        let config = ConfigFile()
        var t = config.config!["tools"]!.object!
        t["claude"] = ["skip": true]
        config.writeTools(.object(t))
        let skipped = managerFor(#"{"claude":"missing","codex":"missing"}"#, installAtLaunch: ["claude"], config: config)
        await skipped.tools.start()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(skipped.config.tools["claude"].installed, false, "skipped")

        let hasCodex = managerFor(#"{"claude":"missing","codex":"0.155.1"}"#, installAtLaunch: ["claude"])
        await hasCodex.tools.start()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(hasCodex.config.tools["claude"].installed, false, "an agent is already there")

        let notAsked = managerFor(#"{"claude":"missing","codex":"missing"}"#)
        await notAsked.tools.start()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(notAsked.config.tools["claude"].installed, false, "only when asked for (ToolsSetup does)")

        final class Refuses: ToolActions, @unchecked Sendable {
            func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult { XCTFail("must not install"); return .done }
            func installAgent(_ name: String) async -> ActionResult { XCTFail("must not install"); return .done }
            func updateAgent(_ name: String, _ file: String?) async -> ActionResult { .done }
            func updateGit(_ source: String?) async -> ActionResult { .done }
        }
        let blind = ToolsManager(storage: ConfigFile().storage, detect: { only in
            DetectResult(tools: Dictionary(uniqueKeysWithValues: only.map { ($0, observed($0)) }), aliases: [], lookupError: "The login shell (/bin/zsh) did not answer.")
        }, actions: Refuses(), installAtLaunch: ["claude"])
        await blind.start()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(blind.snapshot().tools["claude"]?.busy, "the shell did not answer: missing may only mean unseen")
    }

    func testConnectInstallsChecksAndSignsInFromOnePressAndAPressWhileRunningJoins() async {
        let h = managerFor(#"{"claude":"missing","codex":"missing"}"#)
        await h.tools.start()
        async let first = h.tools.connect("claude")
        async let second = h.tools.connect("claude")
        let (a, b) = await (first, second)
        XCTAssertEqual(a.tools["claude"]?.status, "ready")
        XCTAssertEqual(b.tools["claude"]?.status, "ready")
        XCTAssertEqual(h.config.tools["claude"].signedIn, true)
        XCTAssertEqual(h.seen.list.filter { $0.tools["claude"]?.busy?.action == "install" }.count, 1, "never twice")
        let outdated = managerFor(#"{"codex":"0.150.0 signed-out","claude":"missing"}"#)
        await outdated.tools.check()
        let done = await outdated.tools.connect("codex")
        XCTAssertEqual(done.tools["codex"]?.version, "0.155.0")
        XCTAssertEqual(done.tools["codex"]?.status, "ready")
        let failing = managerFor(#"{"codex":"missing","failInstall":["codex"]}"#)
        await failing.tools.check()
        let stopped = await failing.tools.connect("codex")
        XCTAssertEqual(stopped.tools["codex"]?.status, "missing")
        let git = await failing.tools.connect("git")
        XCTAssertEqual(git.tools["git"]?.status, "ready", "connect is for agents only")
    }

    func testEnsureLooksForAProgramWhoseFileIsGoneAndRefreshesAStaleCheck() async {
        let calls = Calls()
        var clock = Date()
        let fake = FakeTools(#"{"claude":"2.1.300"}"#, delay: 0, sleep: { _ in })
        let tools = ToolsManager(storage: .memory(), detect: { only in calls.add(only); return await fake.detect(only) }, actions: fake, now: { clock },
                                 fileExists: { _ in true })
        await tools.ensure("claude")
        XCTAssertEqual(calls.all, [], "nothing before the first check")
        await tools.check()
        calls.list = []
        await tools.ensure("claude")
        XCTAssertEqual(calls.all, [], "fresh")
        clock = clock.addingTimeInterval(11 * 60)
        await tools.ensure("claude")
        await eventually { calls.all == [["claude"]] }
        let gone = ToolsManager(storage: .memory(), detect: { only in calls.add(only); return await fake.detect(only) }, actions: fake, fileExists: { _ in false })
        await gone.check()
        calls.list = []
        await gone.ensure("codex")
        XCTAssertEqual(calls.all, [["codex"]], "its file is gone: looked for now")
    }

    func testACheckThatThrowsSaysSoAndAToolBusyIsLeftOut() async {
        struct Boom: LocalizedError { var errorDescription: String? { "the shell exploded" } }
        let tools = ToolsManager(storage: .memory(), detect: { _ in throw Boom() }, actions: FakeTools(nil, delay: 0))
        await tools.check(["codex"])
        XCTAssertEqual(tools.current["codex"].error, "The check failed: the shell exploded")
        XCTAssertFalse(tools.checked, "only a full check counts")
    }

    func testAPretendMachineNeverTouchesConfigJSON() async {
        let config = ConfigFile()
        let before = try! String(contentsOfFile: config.file, encoding: .utf8)
        let fake = FakeTools(#"{"git":"missing"}"#, delay: 0, sleep: { _ in })
        let tools = ToolsManager(storage: .memory(), detect: { await fake.detect($0) }, actions: fake)
        await tools.start()
        tools.skip(["git"])
        XCTAssertTrue(tools.current["git"].skip, "kept in memory")
        XCTAssertEqual(try! String(contentsOfFile: config.file, encoding: .utf8), before)
    }
}
