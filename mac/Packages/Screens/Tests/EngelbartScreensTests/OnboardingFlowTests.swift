import EngelbartCore
import EngelbartStore
import EngelbartTools
import XCTest
@testable import EngelbartScreens

// Ports of test/onboarding.test.cjs (the order and gates) and test/onboarding-beta-screens.test.cjs (S2, S3, S9–S12).

typealias Flow = OnboardingFlow

func place(_ step: String, _ sub: Int = 0, detour: Bool = false) -> OnboardingPlace { OnboardingPlace(step: step, sub: sub, detour: detour) }

/// The steps a walk visits from `from` until 'open' ("create.1" for a second part).
func walk(_ mode: OnboardingMode, _ from: OnboardingPlace, _ options: FlowOptions = FlowOptions()) -> [String] {
    var out: [String] = []
    var at = from
    for _ in 0..<20 where at.step != "open" {
        at = Flow.forward(mode, at, options)
        out.append(at.sub > 0 ? "\(at.step).\(at.sub)" : at.step)
    }
    return out
}

/// A tool check's snapshot: each tool 'ready' unless told.
func snap(_ states: [String: (status: String, mutate: (inout ToolSnapshot) -> Void)] = [:], checked: Bool = true) -> ToolsSnapshot {
    var tools: [String: ToolSnapshot] = [:]
    for id in ["git", "claude", "codex"] {
        let status = states[id]?.status ?? "ready"
        var record = ToolRecord(blank: id)
        record.status = status
        record.installed = status != "missing"
        record.signedIn = status == "ready" ? true : nil
        var tool = ToolSnapshot(record: record)
        states[id]?.mutate(&tool)
        tools[id] = tool
    }
    return ToolsSnapshot(checked: checked, tools: tools)
}
func s(_ status: String, _ mutate: @escaping (inout ToolSnapshot) -> Void = { _ in }) -> (status: String, mutate: (inout ToolSnapshot) -> Void) { (status, mutate) }

/// providers.cjs's status.
func prov(_ who: [String: AgentProviders.Entry] = [:]) -> AgentProviders {
    AgentProviders(providers: ["anthropic", "openai"].map { who[$0] ?? AgentProviders.Entry(id: $0) })
}
func SUB(_ id: String, plan: String = "max") -> AgentProviders.Entry { .init(id: id, signedIn: true, subscription: plan, subscribed: true) }
func FREE(_ id: String) -> AgentProviders.Entry { .init(id: id, signedIn: true, subscription: nil, subscribed: false) }
func OUT(_ id: String) -> AgentProviders.Entry { .init(id: id, signedIn: false, subscription: nil, subscribed: false) }

final class OnboardingFlowTests: XCTestCase {
    func testTheOrder() {
        // 2026-10-09: no folder part, and no Project context screen for a new user.
        XCTAssertEqual(Flow.SUBS["create"], ["name", "desc"])
        // 2026-10-10: Create before Connect; 'open' (the project made) after the last screen.
        XCTAssertEqual(Flow.FLOWS[.new], ["welcome", "tools", "create", "connect", "import", "instructions"])
        XCTAssertEqual(Flow.flowOf(.new), ["welcome", "tools", "create", "import", "instructions"])
        XCTAssertEqual(Flow.flowOf(.new, FlowOptions(connect: true)), ["welcome", "tools", "create", "connect"])
        XCTAssertFalse(Flow.flowOf(.new, FlowOptions(connect: true)).contains("intro"), "the intro screen (2026-10-11) was deleted")
        XCTAssertEqual(walk(.new, place("welcome")), ["tools", "create", "create.1", "import", "import.1", "import.2", "instructions", "open"])
        XCTAssertEqual(walk(.new, place("welcome"), FlowOptions(connect: true)), ["tools", "create", "create.1", "connect", "open"], "Connect last: its Continue makes the project")
        XCTAssertEqual(walk(.existing, place("create")), ["create.1", "context", "open"], "+ Project keeps its context screen")
        XCTAssertEqual(Flow.forward(.existing, place("import", 2, detour: true)), place("context"))
        XCTAssertEqual(Flow.pagerOf(.new, "tools"), PagerPosition(count: 5, index: 1))
        XCTAssertEqual(Flow.pagerOf(.new, "create"), PagerPosition(count: 5, index: 2))
        XCTAssertEqual(Flow.pagerOf(.new, "instructions"), PagerPosition(count: 5, index: 4))
        XCTAssertEqual(Flow.pagerOf(.new, "connect", FlowOptions(connect: true)), PagerPosition(count: 4, index: 3))
        XCTAssertNil(Flow.pagerOf(.new, "context"))
        XCTAssertEqual(Flow.pagerOf(.existing, "context"), PagerPosition(count: 2, index: 1))
        XCTAssertNil(Flow.pagerOf(.existing, "import"))
    }

    func testTheGuidedSetupInsideAProject() {
        XCTAssertEqual(Flow.flowOf(.guided), ["welcome", "tools", "import", "instructions"])
        XCTAssertEqual(Flow.flowOf(.guided, FlowOptions(connect: true)), ["welcome", "tools", "connect"])
        XCTAssertFalse(Flow.flowOf(.guided, FlowOptions(tools: false, connect: true)).contains("create"))
        XCTAssertEqual(walk(.guided, place("welcome")), ["tools", "import", "import.1", "import.2", "instructions", "open"])
        XCTAssertEqual(walk(.guided, place("welcome"), FlowOptions(connect: true)), ["tools", "connect", "open"])
        XCTAssertEqual(walk(.guided, place("welcome"), FlowOptions(tools: false, connect: true)), ["connect", "open"])
        XCTAssertEqual(Flow.pagerOf(.guided, "connect", FlowOptions(tools: false, connect: true)), PagerPosition(count: 2, index: 1), "\"2 of 2\"")
        XCTAssertEqual(Flow.forward(.guided, place("tools"), FlowOptions(connect: false)), place("import"), "Connect dropped: its screens come back")
        XCTAssertEqual(Flow.pagerOf(.guided, "welcome", FlowOptions(connect: true)), PagerPosition(count: 3, index: 0))
        XCTAssertEqual(Flow.pagerOf(.guided, "connect", FlowOptions(connect: true)), PagerPosition(count: Flow.pagerOf(.new, "connect", FlowOptions(connect: true))!.count - 1, index: 2))
        XCTAssertEqual(Flow.pagerOf(.guided, "instructions"), PagerPosition(count: 4, index: 3))
        XCTAssertNil(Flow.pagerOf(.guided, "create"))
        XCTAssertTrue(Flow.isFresh(.guided)); XCTAssertTrue(Flow.isFresh(.new)); XCTAssertFalse(Flow.isFresh(.existing))
    }

    func testNothingToInstall() {
        XCTAssertEqual(Flow.forward(.new, place("welcome"), FlowOptions(tools: false)), place("create"))
        XCTAssertEqual(Flow.forward(.new, place("tools"), FlowOptions(tools: false)), place("create"))
        XCTAssertEqual(Flow.forward(.new, place("create", 1), FlowOptions(tools: false, connect: false)), place("import"), "Connect dropped: its screens come back after Create")
        XCTAssertEqual(Flow.pagerOf(.new, "instructions", FlowOptions(tools: false)), PagerPosition(count: 4, index: 3))
        XCTAssertNil(Flow.pagerOf(.new, "tools", FlowOptions(tools: false)))
    }

    func testOneContinue() {
        // One Continue (no Next, 2026-09-28): live once the part holds something, and Skip while it is empty.
        XCTAssertEqual(Flow.importButtons(0, 0), .init(showSkip: true, continueDisabled: true))
        XCTAssertEqual(Flow.importButtons(0, 0, signedIn: true), .init(showSkip: true, continueDisabled: false), "GitHub connected, nothing ticked")
        XCTAssertEqual(Flow.importButtons(1, 0, signedIn: true), .init(showSkip: true, continueDisabled: true), "only the GitHub part")
        XCTAssertEqual(Flow.importButtons(0, 2), .init(showSkip: false, continueDisabled: false))
        XCTAssertEqual(Flow.importButtons(2, 1), .init(showSkip: false, continueDisabled: false))
        let keep = Flow.Buttons(showSkip: false, continueDisabled: false, label: "Continue")
        XCTAssertEqual(Flow.createButtons(0, name: " ", desc: ""), .init(showSkip: false, continueDisabled: true))
        XCTAssertEqual(Flow.createButtons(0, name: "x", desc: ""), keep)
        XCTAssertEqual(Flow.createButtons(1, name: "x", desc: ""), .init(showSkip: true, continueDisabled: true))
        XCTAssertEqual(Flow.createButtons(1, name: "x", desc: "why"), keep, "+ Project goes on to context")
        XCTAssertEqual(Flow.createButtons(0, name: "x", desc: "", folder: "new").continueDisabled, false)
        XCTAssertEqual(Flow.createButtons(0, name: "x", desc: "", folder: "existing", folderPath: " ").continueDisabled, true)
        XCTAssertEqual(Flow.createButtons(0, name: "x", desc: "", folder: "existing", folderPath: "~/code").continueDisabled, false)
    }

    func testTheEnd() {
        func ends(_ mode: OnboardingMode, _ options: FlowOptions) -> [Flow.End?] {
            var out: [Flow.End?] = []
            var at = place("welcome")
            for _ in 0..<20 where at.step != "open" { at = Flow.forward(mode, at, options); out.append(Flow.endOf(mode, at)) }
            return out
        }
        XCTAssertEqual(ends(.new, FlowOptions(connect: true)), [nil, nil, nil, nil, .project], "nothing is made on Create")
        XCTAssertEqual(ends(.new, FlowOptions()).compactMap { $0 }, [.project])
        XCTAssertEqual(ends(.new, FlowOptions()).last!, .project, "after Custom instructions")
        XCTAssertEqual(ends(.guided, FlowOptions(connect: true)), [nil, nil, .welcome])
        XCTAssertNil(Flow.endOf(.existing, place("open")), "+ Project opens from its context screen")
        XCTAssertEqual(Flow.projectInput(name: " Teachable agents ", desc: " Debugging with LLMs ", ids: ["3"], connectId: "c1"),
                       .init(name: "Teachable agents", description: "Debugging with LLMs", folder: "new", directory: "", context: ["3"], connect: "c1", onboarding: true))
        XCTAssertEqual(Flow.projectInput(name: "x", desc: "", folder: "existing", folderPath: "~/code", ids: []),
                       .init(name: "x", description: "", folder: "existing", directory: "~/code", context: [], connect: nil, onboarding: true), "no session: no connect")
        XCTAssertFalse(Flow.projectInput(name: "x", desc: "", mode: .existing).onboarding, "+ Project is not an onboarding")
        let start = Flow.projectInput(name: "x", desc: "d", folder: "existing", folderPath: "/tmp/x", ids: ["a"]).start
        XCTAssertEqual([start.name, start.description, start.folder, start.directory], ["x", "d", "existing", "/tmp/x"])
        XCTAssertEqual(start.context, ["a"])
    }

    func testRowsAndWords() {
        XCTAssertEqual(Flow.rowWhy(LibraryRow(id: "1", name: "b", type: "website", url: "https://github.com/a/b", tags: ["git"])), "git repo · github.com")
        XCTAssertEqual(Flow.rowWhy(LibraryRow(id: "2", name: "x", type: "pdf", path: "/x.pdf", tags: ["paper"])), "paper")
        XCTAssertEqual(Flow.rowWhy(LibraryRow(id: "3", name: "x", type: "website", url: "https://www.arxiv.org/abs/1")), "website · arxiv.org")
        XCTAssertEqual(Flow.rowWhy(LibraryRow(id: "4", name: "x", type: "pdf", url: "file:///x.pdf")), "pdf")
        XCTAssertEqual(Flow.contextRows([LibraryRow(id: "1", name: "n", type: "md", tags: ["note"]), LibraryRow(id: "2", name: "i", type: "image"),
                                         LibraryRow(id: "3", name: "p", type: "pdf")]).map(\.id), ["3"])
        XCTAssertTrue(Flow.PROFILE_PROMPT.hasPrefix("I want to export a research profile of me"))
        XCTAssertTrue(Flow.PROFILE_PROMPT.hasSuffix("Output the final profile inside a single code block so I can copy it cleanly."))
        XCTAssertTrue(Flow.PROFILE_PROMPT.contains("\n\nRules:\n- Be specific."))
        XCTAssertEqual(Flow.TOOL_WHY["git"], "Keeps the history of your code. Build needs it.")
    }

    // test/onboarding.test.cjs: the tools screen: undecided until the first check, then only when something is to be installed.
    func testToolsWanted() {
        func t(_ status: String, busy: Busy? = nil) -> (status: String, mutate: (inout ToolSnapshot) -> Void) { (status, { $0.busy = busy }) }
        XCTAssertNil(Flow.toolsWanted(nil))
        XCTAssertNil(Flow.toolsWanted(snap(["git": t("missing"), "claude": t("missing"), "codex": t("missing")], checked: false)))
        XCTAssertEqual(Flow.toolsWanted(snap(["git": t("missing"), "claude": t("missing"), "codex": t("missing")])), true, "a new Mac")
        XCTAssertEqual(Flow.toolsWanted(snap(["git": t("missing"), "claude": t("ready"), "codex": t("missing")])), true, "Git alone")
        XCTAssertEqual(Flow.toolsWanted(snap(["git": t("ready"), "claude": t("missing"), "codex": t("missing")])), true, "no agent")
        XCTAssertEqual(Flow.toolsWanted(snap(["git": t("ready"), "claude": t("missing"), "codex": t("ready")])), false, "one agent is enough")
        XCTAssertEqual(Flow.toolsWanted(snap(["git": t("ready"), "claude": t("signed-out"), "codex": t("missing")])), false, "signing in waits for the dialog")
        XCTAssertEqual(Flow.toolsWanted(snap(["git": t("missing", busy: Busy(action: "install")), "claude": t("ready"), "codex": t("ready")])), false, "already installing")
        XCTAssertEqual(Flow.toolsWanted(snap(["claude": t("signed-out"), "codex": t("missing")]), connect: true), true, "with Connect: until an agent is ready")
        XCTAssertTrue(Flow.agentWorks(snap(["claude": s("outdated", { $0.autoUpdate = true })]).tools["claude"]))
        XCTAssertTrue(Flow.agentWorks(snap(["claude": s("updating")]).tools["claude"]))
        XCTAssertFalse(Flow.agentWorks(snap(["claude": s("outdated")]).tools["claude"]))
        let step = Flow.toolsStep(snap(["git": s("missing"), "claude": s("missing"), "codex": s("missing")]), connect: true)
        XCTAssertEqual([step.label], ["Install all"]); XCTAssertEqual(step.install, ["git", "claude", "codex"]); XCTAssertTrue(step.stay)
        let waiting = Flow.toolsStep(snap(["claude": s("signed-out"), "codex": s("missing")]), connect: true)
        XCTAssertEqual(waiting.install, [], "an agent installed and waiting for its sign-in: its Sign in is the step")
        XCTAssertTrue(waiting.disabled)
    }

    // MARK: onboarding-beta-screens.test.cjs

    func testS3OneQualifyingGoesOn() {
        XCTAssertNil(Flow.agentGate(snap(checked: false), prov()), "no answer before the tool check")
        XCTAssertNil(Flow.agentGate(snap(), nil), "nor before the providers")
        let one = Flow.agentGate(snap(["codex": s("missing")]), prov(["anthropic": SUB("anthropic")]))!
        XCTAssertTrue(one.go); XCTAssertEqual(one.update, [])
        let both = Flow.agentGate(snap(["claude": s("outdated"), "codex": s("outdated")]), prov(["anthropic": SUB("anthropic"), "openai": SUB("openai", plan: "plus")]))!
        XCTAssertEqual(both.go, true); XCTAssertEqual(both.update, ["claude", "codex"], "both qualify: both update")
        XCTAssertEqual(Flow.agentGate(snap(["claude": s("outdated", { $0.autoUpdate = true })]), prov(["anthropic": SUB("anthropic")]))!.update, [], "one the manager updates on its own is left to it")
        XCTAssertEqual(Flow.agentGate(snap(["claude": s("outdated", { $0.busy = Busy(action: "update") })]), prov(["anthropic": SUB("anthropic")]))!.update, [], "nor one already updating")
        XCTAssertEqual(Flow.agentGate(snap(["claude": s("outdated", { $0.record.pin = "2.1.278" })]), prov(["anthropic": SUB("anthropic")]))!.update, [], "nor a pinned one")
    }

    func testS3NeitherQualifyingAsks() {
        XCTAssertEqual(Flow.agentGate(snap(), prov(["anthropic": FREE("anthropic"), "openai": OUT("openai")]))!.go, false)
        XCTAssertEqual(Flow.agentGate(snap(["claude": s("missing"), "codex": s("missing")]), prov())!.go, false)
        // An older main without `subscribed`: signed in with a plan named.
        XCTAssertEqual(Flow.agentGate(snap(), AgentProviders(providers: [.init(id: "anthropic", signedIn: true, subscription: "pro")]))!.go, true)
        XCTAssertEqual(Flow.agentGate(snap(["git": s("missing")]), prov())!.git, true, "Git missing is installed in the background")
        XCTAssertEqual(Flow.agentGate(snap(["git": s("ready", { $0.source = "bundled" })]), prov())!.git, false, "Engelbart’s own Git stands in")
    }

    func testS3ThePopupForEachChoice() {
        let missing = Flow.agentChoice(snap(["claude": s("missing"), "codex": s("missing")]), prov(), "both")
        XCTAssertEqual(missing.install, ["claude", "codex"]); XCTAssertEqual(missing.primary.label, "Connecting…"); XCTAssertTrue(missing.primary.disabled)
        XCTAssertEqual(Flow.agentChoice(snap(["codex": s("outdated")]), prov(), "codex").update, ["codex"])
        let signedOut = snap(["claude": s("signed-out", { $0.signedIn = false }), "codex": s("signed-out", { $0.signedIn = false })])
        XCTAssertEqual(Flow.agentChoice(signedOut, prov(), "claude").primary.label, "Connect to Claude")
        XCTAssertEqual(Flow.agentChoice(signedOut, prov(), "codex").primary.label, "Connect to ChatGPT")
        let bothOut = Flow.agentChoice(signedOut, prov(), "both")
        XCTAssertEqual(bothOut.primary.label, "Connect to Claude and ChatGPT"); XCTAssertEqual(bothOut.primary.action, "sign-in"); XCTAssertEqual(bothOut.primary.ids, ["claude", "codex"])
        XCTAssertEqual(Flow.agentChoice(snap(), prov(["anthropic": FREE("anthropic")]), "claude").primary.label, "Connect to Claude", "signed in without a subscription: its sign-in again")
        XCTAssertEqual(Flow.agentChoice(snap(), prov(["anthropic": SUB("anthropic")]), "claude", refused: "claude").primary.action, "sign-in", "turned the agents away while signed in")
        XCTAssertTrue(Flow.agentChoice(snap(["codex": s("missing", { $0.busy = Busy(action: "install") })]), prov(["anthropic": SUB("anthropic")]), "both").done, "one runs: the flow goes on")
        let signing = Flow.agentChoice(snap(["claude": s("signed-out", { $0.busy = Busy(action: "sign-in", url: "https://claude.ai/x") })]), prov(), "claude")
        XCTAssertEqual(signing.primary.action, "open"); XCTAssertEqual(signing.primary.url, "https://claude.ai/x")
        let failed = Flow.agentChoice(snap(["codex": s("missing", { $0.error = "The installer could not be reached: no internet connection. More." })]), prov(), "codex")
        XCTAssertEqual(failed.primary.label, "Try again"); XCTAssertEqual(failed.problem, "The installer could not be reached: no internet connection.")
        XCTAssertTrue(Flow.agentChoice(snap(), prov(), nil).primary.disabled, "nothing chosen yet")
        XCTAssertEqual(Flow.agentChoice(snap(["claude": s("signed-out", { $0.busy = Busy(action: "sign-in") })]), prov(), "claude").primary.label, "Finish signing in…")
    }

    func testS3NoVersionAnywhere() {
        for choice in ["claude", "codex", "both"] {
            for state in [snap(["claude": s("outdated", { $0.version = "2.1.1" }), "codex": s("missing")]), snap(["claude": s("signed-out")])] {
                let out = Flow.agentChoice(state, prov(), choice)
                XCTAssertNil("\(out.primary.label) \(out.problem)".range(of: "\\d+\\.\\d+\\.\\d+", options: .regularExpression))
            }
        }
        XCTAssertEqual(Flow.connectLabel(["codex", "claude"]), "Connect to Claude and ChatGPT")
        XCTAssertEqual(Flow.choiceIds("both"), ["claude", "codex"]); XCTAssertEqual(Flow.choiceIds("x"), [])
        XCTAssertEqual(Flow.cliOfProvider("openai"), "codex"); XCTAssertEqual(Flow.providerOfCli("claude"), "anthropic")
    }

    func testS3PagerOnlyScreensThatDrawIt() {
        XCTAssertNil(Flow.shownPager(.new, "welcome", FlowOptions(tools: false, connect: true)), "Welcome is the only one in a new user’s flow")
        XCTAssertEqual(Flow.shownPager(.guided, "welcome", FlowOptions(tools: false, connect: true)), PagerPosition(count: 2, index: 0))
        XCTAssertEqual(Flow.shownPager(.guided, "connect", FlowOptions(tools: false, connect: true)), PagerPosition(count: 2, index: 1))
        XCTAssertEqual(Flow.shownPager(.new, "create", FlowOptions(tools: false, connect: false)), PagerPosition(count: 4, index: 1), "Connect dropped: Create and its screens")
        XCTAssertEqual(Flow.shownPager(.existing, "context", FlowOptions(tools: false)), PagerPosition(count: 2, index: 1))
    }

    func testS9ToS12BrowserSignIns() throws {
        let chrome: JSONValue = ["id": "chrome", "name": "Google Chrome", "keychain": true, "profiles": []]
        XCTAssertEqual(Flow.keychainStep(nil), .wait, "still looking for the browsers: wait, then ask")
        XCTAssertEqual(Flow.keychainStep(["browsers": [], "keychain": nil]), .go("declined"), "no browser: nothing to ask")
        XCTAssertEqual(Flow.keychainStep(["browsers": [chrome], "chosenId": "chrome", "keychain": nil]), .ask)
        XCTAssertEqual(Flow.keychainStep(["browsers": [chrome], "chosenId": "chrome", "keychain": "allowed"]), .go("allowed"))
        XCTAssertEqual(Flow.keychainStep(["browsers": [chrome], "chosenId": "chrome", "keychain": "refused"]), .go("declined"))
        let safari: JSONValue = ["id": "safari", "name": "Safari", "keychain": false, "profiles": []]
        XCTAssertEqual(Flow.keychainStep(["browsers": [safari, chrome], "chosenId": "safari", "keychain": nil, "safari": ["diskAccess": false]]), .safari)
        XCTAssertEqual(Flow.keychainStep(["browsers": [safari], "chosenId": "safari", "keychain": nil]), .safari, "unknown disk access: asked for")
        XCTAssertEqual(Flow.keychainStep(["browsers": [safari], "chosenId": "safari", "keychain": nil, "safari": ["diskAccess": true]]), .ask, "granted: Safari like any other")
        let two: JSONValue = ["id": "chrome", "name": "Google Chrome", "keychain": true, "profiles": [["id": "Default", "name": "Hudson", "email": "h@x"], ["id": "Profile 1", "name": "Work"]]]
        XCTAssertEqual(Flow.afterAllow(["browsers": [two], "chosenId": "chrome"]), "profile")
        XCTAssertEqual(Flow.afterAllow(["browsers": [two], "chosenId": "chrome", "chosenProfile": "Profile 1"]), "macos", "chosen once")
        XCTAssertEqual(Flow.afterAllow(["browsers": [two], "chosenId": "chrome", "chosenProfile": "Gone"]), "profile")
        XCTAssertEqual(Flow.afterAllow(["browsers": [chrome], "chosenId": "chrome"]), "macos")
        XCTAssertEqual(Flow.runKeychain(nil), false, "unanswered: false")
        XCTAssertEqual(Flow.runKeychain(["keychain": "declined"]), false)
        XCTAssertEqual(Flow.runKeychain(["keychain": "allowed"]), true)
        XCTAssertEqual(Flow.profilesOf(["browsers": [two], "chosenId": "chrome"]).count, 2)
    }

    func testToolsSnapshotFromJSON() throws {
        let json: JSONValue = ["checked": true, "platform": "darwin", "updates": "auto", "tools": [
            "git": ["installed": true, "status": "ready", "skip": false],
            "claude": ["installed": true, "status": "outdated", "autoUpdate": true, "busy": ["action": "update"]],
            "codex": ["installed": false, "status": "missing", "error": "no network", "pin": "0.160.0"],
        ]]
        let snapshot = try XCTUnwrap(ToolsSnapshot(json: json))
        XCTAssertTrue(snapshot.checked)
        XCTAssertEqual(snapshot.tools["claude"]?.busy?.action, "update")
        XCTAssertEqual(snapshot.tools["claude"]?.autoUpdate, true)
        XCTAssertEqual(snapshot.tools["codex"]?.error, "no network")
        XCTAssertEqual(snapshot.tools["codex"]?.record.pin, "0.160.0")
        XCTAssertNil(ToolsSnapshot(json: ["checked": true]))
        let providers = try XCTUnwrap(AgentProviders(json: ["providers": [["id": "anthropic", "installed": true, "signedIn": true, "subscription": "max", "subscribed": true]], "decision": nil]))
        XCTAssertEqual(providers.providers.first?.subscribed, true)
        XCTAssertNil(AgentProviders(json: ["providers": "nope"]))
    }
}
