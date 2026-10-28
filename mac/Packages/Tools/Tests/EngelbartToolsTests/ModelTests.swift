import EngelbartCore
import XCTest
@testable import EngelbartTools

// test/tools-model.test.cjs: the setup dialog's rows; App.jsx's gating; fake.cjs's pretend machine.
@MainActor
final class ModelTests: XCTestCase {
    struct S {
        var status = "ready"
        var installed: Bool?
        var version: String??
        var skip = false
        var busy: Busy?
        var autoUpdate = false
        var source: String?
        var error: String?
        var note: String?
        var signedIn: Bool?
        var account: String?
        var untested = false
    }

    /// A snapshot as the manager sends it: `states` gives each tool's status fields.
    func snapshot(_ states: [String: S], checked: Bool = true) -> ToolsSnapshot {
        var tools: [String: ToolSnapshot] = [:]
        for id in TOOL_NAMES {
            let given = states[id] ?? S()
            var record = ToolRecord(blank: id)
            record.status = given.status
            record.installed = given.installed ?? (given.status != "missing")
            record.version = given.version ?? (given.status == "missing" ? nil : Requirements[id].minimum)
            record.skip = given.skip
            record.source = given.source
            record.error = given.error
            record.note = given.note
            record.signedIn = given.signedIn
            record.account = given.account
            record.untested = given.untested
            tools[id] = ToolSnapshot(record: record, busy: given.busy, autoUpdate: given.autoUpdate)
        }
        return ToolsSnapshot(checked: checked, tools: tools)
    }

    func testNoDialogWhenEverythingIsReadyOrBeforeTheFirstCheck() {
        XCTAssertEqual(launchRows(snapshot([:])), [])
        XCTAssertEqual(launchRows(snapshot(["git": S(status: "missing")], checked: false)), [])
        XCTAssertEqual(launchRows(nil), [])
    }

    func testGitMissingAndNeitherAgentInstalledAreAskedAbout() {
        XCTAssertEqual(launchRows(snapshot(["git": S(status: "missing")])), ["git"])
        XCTAssertEqual(launchRows(snapshot(["claude": S(status: "missing"), "codex": S(status: "missing")])), ["claude", "codex"], "Claude Code, Codex, or both")
        XCTAssertEqual(launchRows(snapshot(["claude": S(status: "missing")])), [], "one agent is enough")
        XCTAssertEqual(launchRows(snapshot(["git": S(status: "missing", skip: true), "claude": S(status: "missing", skip: true), "codex": S(status: "missing", skip: true)])), [])
        XCTAssertEqual(launchRows(snapshot(["git": S(status: "failed", error: "Xcode's license has not been accepted")])), ["git"], "a Git that cannot run is asked about too")
    }

    func testAgentsInstalledButUnableToRunAreAskedAboutAndOneNotSignedInAlwaysIs() {
        XCTAssertEqual(launchRows(snapshot(["claude": S(status: "signed-out"), "codex": S(status: "missing")])), ["claude"])
        XCTAssertEqual(launchRows(snapshot(["claude": S(status: "signed-out")])), ["claude"], "Codex could run a question, but Claude Code still asks to sign in")
        XCTAssertEqual(launchRows(snapshot(["claude": S(status: "signed-out", skip: true)])), [], "unless skipped")
        let installing = snapshot(["claude": S(status: "installing", installed: false, busy: Busy(action: "install")), "codex": S(status: "missing")])
        let installed = snapshot(["claude": S(status: "signed-out"), "codex": S(status: "missing")])
        XCTAssertEqual(installedSignedOut(installing, installed), ["claude"], "an install that ends without a sign-in asks for one")
        XCTAssertEqual(installedSignedOut(installing, snapshot(["codex": S(status: "missing")])), [], "one signed in already asks nothing")
        XCTAssertEqual(installedSignedOut(nil, installed), [])
        XCTAssertEqual(launchRows(snapshot(["codex": S(status: "outdated", version: "0.150.0")])), ["codex"], "an update waiting for the person")
        XCTAssertEqual(launchRows(snapshot(["codex": S(status: "outdated", version: "0.150.0", autoUpdate: true)])), [], "an update that happens by itself asks nothing")
        XCTAssertEqual(launchRows(snapshot(["claude": S(status: "failed"), "codex": S(status: "signed-out")])), ["claude", "codex"], "installed, none ready")
    }

    func testRowsSayWhatAToolIsDoingInAFewWordsWithOneButton() {
        let tools = snapshot(["git": S(status: "missing"), "claude": S(status: "outdated", version: "2.1.200", error: "The installer could not be reached: no internet connection."), "codex": S(status: "signed-out")]).tools
        XCTAssertEqual([rowOf(tools["git"]!).state, rowOf(tools["git"]!).action], ["Not installed", "install"])
        var bundled = tools["git"]!; bundled.status = "ready"; bundled.version = "2.53.0"; bundled.source = "bundled"
        XCTAssertEqual([rowOf(bundled).state, rowOf(bundled).tone], ["2.53.0 · built in", "ok"], "the Git that came with Engelbart")
        XCTAssertEqual([rowOf(tools["claude"]!).state, rowOf(tools["claude"]!).action, rowOf(tools["claude"]!).detail], ["2.1.200 · needs 2.1.278", "update", "The installer could not be reached: no internet connection."])
        XCTAssertEqual([rowOf(tools["codex"]!).state, rowOf(tools["codex"]!).action, rowOf(tools["codex"]!).tone], ["Not signed in", "sign-in", "warn"])
        var phase = tools["git"]!; phase.busy = Busy(action: "install", phase: "Waiting for Apple’s installer")
        XCTAssertEqual(rowOf(phase).state, "Waiting for Apple’s installer")
        var plainInstall = tools["git"]!; plainInstall.busy = Busy(action: "install")
        XCTAssertEqual(rowOf(plainInstall).state, "Installing…")
        var connecting = tools["claude"]!; connecting.busy = Busy(action: "install")
        XCTAssertEqual([rowOf(connecting).state, rowOf(connecting).tone], ["Connecting…", "busy"], "an agent connects, never installs (2026-10-14)")
        var signing = tools["codex"]!; signing.busy = Busy(action: "sign-in", url: "https://auth.openai.com/x")
        XCTAssertEqual([rowOf(signing).state, rowOf(signing).action, rowOf(signing).page], ["Finish signing in in your browser", "cancel", "https://auth.openai.com/x"])
        var leaving = tools["codex"]!; leaving.status = "ready"; leaving.busy = Busy(action: "sign-out")
        XCTAssertEqual([rowOf(leaving).state, rowOf(leaving).tone], ["Signing out…", "busy"], "Connections' Sign out (2026-10-03)")
        XCTAssertNil(rowOf(leaving).action)
        var updating = tools["codex"]!; updating.busy = Busy(action: "update")
        XCTAssertEqual(rowOf(updating).state, "Updating…")
        var apple = tools["git"]!; apple.status = "outdated"; apple.version = "2.20.0"; apple.source = "apple"
        XCTAssertNil(rowOf(apple).action, "Apple’s Git is updated by macOS")
        var brew = apple; brew.source = "homebrew"
        XCTAssertEqual(rowOf(brew).action, "update")
        var untested = tools["claude"]!; untested.status = "ready"; untested.version = "3.0.1"; untested.untested = true
        XCTAssertEqual(rowOf(untested).state, "3.0.1 · untested")
        var ready = tools["claude"]!; ready.status = "ready"
        XCTAssertEqual(rowOf(ready).tone, "ok")
        var skipped = tools["git"]!; skipped.skip = true
        XCTAssertEqual(rowOf(skipped).state, "Skipped")
        var incompatible = tools["codex"]!; incompatible.status = "incompatible"; incompatible.version = "0.156.1"
        XCTAssertEqual(rowOf(incompatible).state, "0.156.1 · does not work with Engelbart")
        var unknown = tools["codex"]!; unknown.status = "unknown"
        XCTAssertEqual(rowOf(unknown).state, "Connecting…")
        var unknownGit = tools["git"]!; unknownGit.status = "checking"
        XCTAssertEqual(rowOf(unknownGit).state, "Checking…")
        var noVersion = tools["codex"]!; noVersion.status = "ready"; noVersion.version = nil; noVersion.error = "Could not read the version"
        XCTAssertEqual([rowOf(noVersion).state, rowOf(noVersion).detail, rowOf(noVersion).detailTone], ["Installed", "Could not read the version", "error"])
        XCTAssertEqual(ACTION_LABEL, ["install": "Install", "update": "Update", "sign-in": "Sign in", "retry": "Try again", "cancel": "Cancel"])
    }

    func testARowNamesTheAccountOnlyWhenSignedIn() {
        let ready = rowOf(snapshot(["claude": S(status: "ready", signedIn: true, account: "someone@example.com")]).tools["claude"]!)
        XCTAssertEqual([ready.account, ready.state], ["someone@example.com", Requirements.claude.minimum], "the state is still the version, for the setup dialog")
        XCTAssertNil(rowOf(snapshot(["codex": S(status: "ready", signedIn: true)]).tools["codex"]!).account, "none found")
        XCTAssertNil(rowOf(snapshot(["codex": S(status: "signed-out", signedIn: false, account: "someone@example.com")]).tools["codex"]!).account)
        XCTAssertNil(rowOf(snapshot([:]).tools["git"]!).account)
    }

    func testSkipWarnsOnlyWhenEngelbartWillBeRestricted() {
        let both = snapshot(["git": S(status: "missing"), "claude": S(status: "missing"), "codex": S(status: "missing")])
        XCTAssertEqual(skipWarnings(both, ["git", "claude", "codex"]), ["Without Git, Engelbart can’t build or keep your code’s history.", "Without Claude Code or Codex, @bart and summaries can’t run."])
        XCTAssertEqual(skipWarnings(snapshot(["codex": S(status: "missing")]), ["codex"]), [], "Claude Code still runs questions")
    }

    func testInstallAllAndDone() {
        let tools = snapshot(["git": S(status: "missing"), "claude": S(status: "missing"), "codex": S(status: "signed-out")])
        XCTAssertEqual(installable(tools, ["git", "claude", "codex"]), ["git", "claude"])
        XCTAssertFalse(allDone(tools, ["git"]))
        XCTAssertTrue(allDone(snapshot([:]), ["git", "claude"]))
        XCTAssertFalse(allDone(snapshot(["claude": S(status: "signed-out")]), ["claude"]), "installed but not signed in is not done")
        XCTAssertFalse(allDone(snapshot([:]), []))
        XCTAssertTrue(needsAction(tools["git"]))
        XCTAssertFalse(needsAction(snapshot([:])["git"]))
        XCTAssertFalse(needsAction(snapshot(["git": S(status: "missing", busy: Busy(action: "install"))])["git"]))
    }

    func testAReadyRowShowsItsNoteInAmberAFailedRowItsMessageInRed() {
        let note = "An older Claude Code comes first on your PATH, so typing claude in a terminal runs it; Engelbart uses a newer one. To remove the older one: brew uninstall --cask claude-code. It is at /opt/homebrew/bin/claude."
        let ready = rowOf(snapshot(["claude": S(status: "ready", note: note)]).tools["claude"]!)
        XCTAssertEqual([ready.tone, ready.detail, ready.detailTone], ["ok", note, "warn"])
        XCTAssertNil(ready.action)
        XCTAssertNil(rowOf(snapshot([:]).tools["claude"]!).detail, "no note, no line")
        let failed = rowOf(snapshot(["claude": S(status: "failed", error: "Your login shell (/bin/zsh) never runs Engelbart's commands")]).tools["claude"]!)
        XCTAssertEqual([failed.state, failed.detailTone, failed.action], ["Not working", "error", "retry"])
    }

    // MARK: App.jsx's gating

    func testTheLaunchChecksFirstAnswerOpensTheDialogOnceAndOnlyWhenSomethingNeedsThePerson() {
        let gate = SetupGate()
        gate.take(snapshot(["git": S(status: "missing")], checked: false))
        XCTAssertNil(gate.request, "before the first check")
        gate.take(snapshot(["git": S(status: "missing")]))
        XCTAssertEqual(gate.request, SetupGate.Request(mode: .launch, ids: ["git"]))
        gate.close()
        gate.take(snapshot(["git": S(status: "missing")]))
        XCTAssertNil(gate.request, "once per launch")
        gate.openAll()
        XCTAssertEqual(gate.request, SetupGate.Request(mode: .all, ids: TOOL_ORDER), "Set Up Tools…")

        let quiet = SetupGate()
        quiet.take(snapshot([:]))
        XCTAssertNil(quiet.request)
    }

    func testAnInstallThatEndsSignedOutAsksForTheSignIn() {
        let gate = SetupGate()
        gate.take(snapshot(["claude": S(status: "ready"), "codex": S(status: "ready")]))
        XCTAssertNil(gate.request)
        gate.take(snapshot(["claude": S(status: "installing", installed: false, busy: Busy(action: "install")), "codex": S(status: "ready")]))
        gate.take(snapshot(["claude": S(status: "signed-out"), "codex": S(status: "ready")]))
        XCTAssertEqual(gate.request, SetupGate.Request(mode: .launch, ids: ["claude"]))
    }

    func testOnboardingHoldsTheDialogBackAndItsInstallAllAsksWhatIsLeftAfter() {
        let gate = SetupGate()
        gate.onboardingNew = true
        gate.take(snapshot(["claude": S(status: "missing"), "codex": S(status: "missing")]))
        XCTAssertNil(gate.request, "held while onboarding is on screen")
        gate.onboardingTools("install")
        gate.take(snapshot(["claude": S(status: "installing", installed: false, busy: Busy(action: "install")), "codex": S(status: "missing", skip: true)]))
        gate.onboardingNew = false
        XCTAssertNil(gate.request, "waits until no row is busy")
        gate.take(snapshot(["claude": S(status: "signed-out"), "codex": S(status: "missing", skip: true)]))
        XCTAssertEqual(gate.request, SetupGate.Request(mode: .launch, ids: ["claude"]), "only what is left: the sign-in")

        let skipped = SetupGate()
        skipped.onboardingNew = true
        skipped.take(snapshot(["claude": S(status: "missing"), "codex": S(status: "missing")]))
        skipped.onboardingTools("skip")
        skipped.onboardingNew = false
        XCTAssertNil(skipped.request, "Skip for now asks nothing more until the next launch")
    }

    // MARK: fake.cjs

    func testThePretendMachine() async {
        let spec = parseFakeSpec(#"{"git":"bundled","claude":"2.1.300 unknown","codex":"0.150.0 no-plan","failInstall":["codex"],"signInNever":["claude"]}"#)
        XCTAssertEqual(spec.state["git"], FakeTool(present: true, bundled: true, version: "2.53.0"))
        XCTAssertEqual(spec.state["claude"]?.signedIn, nil)
        XCTAssertEqual(spec.state["codex"]?.signedIn, true)
        XCTAssertNil(spec.state["codex"]?.plan)
        XCTAssertEqual(spec.failInstall, ["codex"])
        XCTAssertEqual(spec.signInNever, ["claude"])
        let defaults = parseFakeSpec("not json")
        XCTAssertEqual([defaults.state["git"]?.version, defaults.state["claude"]?.version, defaults.state["codex"]?.version], ["2.50.1", "2.1.278", "0.155.0"])

        let fake = FakeTools(#"{"git":"bundled","claude":"broken","codex":"missing"}"#, delay: 0, sleep: { _ in })
        let found = await fake.detect()
        XCTAssertEqual(found.tools["git"]?["path"], "/Users/fake/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git")
        XCTAssertEqual([found.tools["git"]?["source"], found.tools["git"]?["onPath"]], ["bundled", false])
        XCTAssertEqual([found.tools["claude"]?["status"], found.tools["claude"]?["error"]], ["failed", "Claude Code did not start: exit status 1"])
        XCTAssertEqual(status(found.tools["codex"]), "missing")
        XCTAssertNil(found.aliases, "the pretend machine says nothing of aliases")
        let failed = await FakeTools(#"{"git":"missing","failInstall":["git"]}"#, delay: 0, sleep: { _ in }).installGit { _ in }
        XCTAssertEqual(failed, ActionResult(ok: false, error: "Apple’s installer was closed before it finished.", kind: "cancelled"))
        _ = await fake.updateAgent("claude", nil)
        XCTAssertEqual(fake.state["claude"], FakeTool(present: true, broken: false, version: "2.1.278"))
        fake.reset()
        XCTAssertEqual(fake.state["claude"]?.broken, true, "back to the first state")

        let auth = FakeTools(#"{"claude":"2.1.300"}"#, delay: 0)
        let json = await auth.authStatusJSON(["auth", "status", "--json"])
        XCTAssertEqual(json, .json(#"{"authMethod":"claude.ai","email":"researcher@example.com","loggedIn":true,"subscriptionType":"max"}"#))
        let unknown = await FakeTools(#"{"claude":"2.1.300 unknown"}"#, delay: 0).authStatusJSON(["auth"])
        XCTAssertEqual(unknown, .timedOut)
        let gone = await FakeTools(#"{"claude":"missing"}"#, delay: 0).authStatusJSON(["auth"])
        XCTAssertEqual(gone, .notFound)
    }
}
