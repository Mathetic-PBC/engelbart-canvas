import XCTest
import EngelbartCore
import EngelbartConnect
@testable import EngelbartImportUI

// Import your context driven end to end through its model, with the standalone page's mock of main (FakeImportAPI):
// the provider, the browser's sign-ins (Allow, profiles, Safari), the questions, the picker, both ways of importing.

@MainActor
func until(_ what: String = "", timeout: Double = 3, file: StaticString = #filePath, line: UInt = #line, _ check: @MainActor () -> Bool) async {
    let end = Date().addingTimeInterval(timeout)
    while !check() {
        if Date() > end { XCTFail("timed out waiting for \(what)", file: file, line: line); return }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

@MainActor
final class ImportFlowModelTests: XCTestCase {
    var defaults: UserDefaults!
    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "importui-\(UUID().uuidString)")
    }

    func model(_ api: FakeImportAPI, mode: ImportFlowMode = .new, into: String? = nil, done: ((JSONValue, JSONValue?) -> Void)? = nil, close: ((JSONValue?) -> Void)? = nil) async -> ImportFlowModel {
        let m = ImportFlowModel(api: api, mode: mode, into: into, workspaceId: into == nil ? nil : "w1", intoProject: into == nil ? nil : ("Memex", "The history"), defaults: defaults,
                                onDone: { made, session in done?(made, session) }, onClose: { session in close?(session) })
        await m.start()
        return m
    }

    func testNewUserAllTheWayToTheRun() async {
        let api = FakeImportAPI(scenario: "both", browsers: ["arc", "firefox"])
        var made: JSONValue?, session: JSONValue?
        let m = await model(api, done: { made = $0; session = $1 })
        XCTAssertEqual(m.state.screen, "intro")
        XCTAssertEqual(m.state.browserChoice, "arc")
        await m.importContext()
        XCTAssertEqual(m.state.dialog, "provider-choice", "both subscribed: always asked")
        XCTAssertEqual(m.providerChoices, ["anthropic", "openai"])
        await m.chooseProvider("openai")
        XCTAssertTrue(api.calls.contains("rememberProvider openai"))
        XCTAssertEqual(m.state.provider, "openai")
        await until("the projects asked for") { api.calls.contains { $0.hasPrefix("discoverProjects openai") } }
        XCTAssertEqual(m.state.dialog, "keychain", "the browser's sign-ins, asked before the questions")
        XCTAssertEqual(m.browserNow, "Arc")
        await m.keychainAllow()
        XCTAssertTrue(api.calls.contains("keychain allowed"))
        XCTAssertEqual(m.state.screen, "roles")
        XCTAssertNil(m.state.dialog)
        await until("the tool agent") { api.calls.contains("discoverTools openai arc allowed ") }

        m.rolesContinue()
        XCTAssertEqual(m.state.screen, "roles", "Continue waits for a role")
        m.toggleRole("Researcher")
        m.rolesContinue()
        XCTAssertEqual(m.state.screen, "work")
        m.workNext()
        XCTAssertEqual(m.state.screen, "work", "not optional")
        m.setWork("Understanding the Memex")
        m.workNext()
        XCTAssertEqual(m.state.screen, "projects")
        XCTAssertEqual(m.discoveryLine?.text, "Finding recent projects in the background…")
        api.settleProjects()
        await until("the projects") { m.projects.count == 4 }
        XCTAssertEqual(m.discoveryLine?.text, "Recent projects found")
        m.projectsContinue()
        XCTAssertEqual(m.state.screen, "projects", "Continue waits for a project")
        m.toggleProject("engelbart")
        m.toggleProject("requirements")
        m.projectsContinue()
        XCTAssertEqual(m.state.screen, "picker")

        api.settleTools()
        await until("the found tools ticked") { m.isPicked("Obsidian") }
        XCTAssertTrue(m.isPicked("custom:linear"), "an extra the agents found in use, ticked in a new user's onboarding")
        XCTAssertEqual(m.state.added.first?.group, "other")
        XCTAssertFalse(m.isPicked("Grok"))

        await m.chooseMethod()
        XCTAssertEqual(m.state.dialog, "import-method")
        m.inBackground()
        XCTAssertEqual(m.state.dialog, "agents-consent")
        XCTAssertTrue(m.agentsConsentText.hasPrefix("Engelbart will use Codex and your signed-in Arc to find"))
        XCTAssertTrue(m.agentsConsentText.hasSuffix("may be sent to OpenAI for processing."))
        await m.understood()
        XCTAssertEqual(m.state.dialog, "first-project", "more than one project picked: which opens")
        XCTAssertEqual(m.state.firstChoice, "engelbart")
        m.state.firstChoice = "requirements"
        await m.firstProjectContinue()
        XCTAssertEqual(m.state.dialog, "organize")
        await m.connectDesktop()
        XCTAssertEqual(m.state.folderAnswers, ["Desktop": "allowed", "Documents": "allowed", "Downloads": "denied"])
        await m.organizeContinue()
        await until("the run") { made != nil }
        XCTAssertTrue(api.calls.contains("browserAgentsAnswer allowed"), "I understand also allowed the browser agents")
        let choices = api.lastChoices!
        XCTAssertEqual(choices["provider"], "openai")
        XCTAssertEqual(choices["keychain"], true)
        XCTAssertEqual(choices["browser"], "arc")
        XCTAssertEqual(choices["days"], 365)
        XCTAssertNil(choices["projectId"])
        XCTAssertEqual(J.arr(choices["direct"]?["projects"]).map { J.str($0["id"]) }, ["requirements", "engelbart"], "the one to start with first")
        XCTAssertEqual(choices["direct"]?["mode"], "auto")
        XCTAssertEqual(choices["direct"]?["work"], "Understanding the Memex")
        XCTAssertTrue(J.strs(choices["direct"]?["apps"]).contains("Obsidian"))
        XCTAssertEqual(J.arr(choices["direct"]?["additional"]).map { J.str($0["name"]) }, ["Linear"])
        XCTAssertEqual(api.projectsMade.map { J.str($0["name"]) }, ["Programming requirements study", "Engelbart context import"], "a project for each pick")
        XCTAssertEqual(api.projectsMade.map { J.str($0["folder"]) }, ["new", "existing"], "one with a folder the agents found is made in place")
        XCTAssertEqual(api.projectsMade[1]["directory"], "~/engelbart-canvas")
        XCTAssertEqual(api.projectsMade[0]["connect"], "sample-session")
        XCTAssertEqual(api.projectsMade[0]["onboarding"], true)
        XCTAssertEqual(J.str(made?["project"]?["name"]), "Programming requirements study")
        XCTAssertEqual(session?["id"], "sample-session")
        XCTAssertEqual(api.savedFlow, .null, "the flow is forgotten once the run started")
    }

    func testFromAProjectMethodFirstThenManualIsTheLibrarian() async {
        let api = FakeImportAPI(scenario: "claude", browsers: ["chrome"], disk: true)
        var closed: JSONValue??
        let m = await model(api, mode: .modal, into: "p1", close: { closed = .some($0) })
        XCTAssertEqual(m.state.screen, "picker")
        XCTAssertEqual(m.state.dialog, "import-method", "how to import comes first")
        XCTAssertEqual(m.chosen.map(\.title), ["Memex"])
        XCTAssertTrue(m.state.picks.isEmpty, "nothing preselected")
        await m.manually()
        XCTAssertEqual(m.state.mode, "manual")
        XCTAssertNil(m.state.dialog)
        api.settleTools()
        await until("the tools merged") { !m.state.added.isEmpty }
        XCTAssertTrue(m.state.picks.isEmpty, "from a project nothing is ticked by the tool agent")
        m.pickSource("Obsidian")
        await m.chooseMethod()
        await until("the librarian") { closed != nil }
        let choices = api.lastChoices!
        XCTAssertEqual(choices["librarian"], true)
        XCTAssertEqual(choices["projectId"], "p1")
        XCTAssertEqual(choices["workspaceId"], "w1")
        XCTAssertEqual(choices["provider"], "anthropic", "one subscribed: that one, no question")
        XCTAssertEqual(choices["keychain"], false, "the browser question was never answered here: macOS is never asked")
        XCTAssertEqual(closed??["id"], "sample-session")
    }

    func testMethodBackAtTheFirstQuestionClosesImportContext() async {
        let api = FakeImportAPI()
        var closed = false
        let m = await model(api, mode: .modal, into: "p1", close: { _ in closed = true })
        await m.methodBack()
        XCTAssertTrue(closed)
        XCTAssertTrue(api.calls.contains("saveFlow null"))
    }

    func testSavedFlowComesBackOnItsStep() async {
        let api = FakeImportAPI()
        var saved = FlowState()
        saved.screen = "work"; saved.dialog = "keychain-confirm"; saved.roles = ["Writer"]; saved.period = nil
        saved.groupScopes = ["notes": GroupScope(note: "x")]
        api.savedFlow = saved.json
        let m = await model(api)
        XCTAssertEqual(m.state.screen, "work")
        XCTAssertEqual(m.state.dialog, "keychain", "a dialog taken out opens on what took its place")
        XCTAssertEqual(m.state.roles, ["Writer"])
        XCTAssertNil(m.state.period, "all time kept")
        XCTAssertEqual(m.state.groupScopes, [:])
        var old = saved; old.v = 3
        api.savedFlow = old.json
        let fresh = await model(api)
        XCTAssertEqual(fresh.state.screen, "intro", "a flow saved by an older version starts over")
        let modal = await model(api, mode: .modal, into: "p")
        XCTAssertEqual(modal.state.screen, "picker", "in a project the picker comes fresh every time")
        m.toggleRole("Founder")
        await until("saved 300 ms after a change") { J.strs(api.savedFlow["roles"]) == ["Writer", "Founder"] }
    }

    func testSafariAsksForFullDiskAccessThenGoesOn() async {
        let api = FakeImportAPI(scenario: "claude", browsers: ["safari", "chrome"])
        let m = await model(api)
        m.safariPollNanos = 10_000_000
        await m.importContext()
        XCTAssertEqual(m.state.dialog, "safari")
        await m.grantDisk()
        XCTAssertTrue(api.calls.contains("openDiskAccess"))
        XCTAssertTrue(m.state.diskWaiting)
        api.diskGranted = true
        await until("on once granted") { m.state.screen == "roles" }
        XCTAssertTrue(api.calls.contains("keychain allowed"))
    }

    func testAnotherBrowserAndItsProfiles() async {
        let api = FakeImportAPI(scenario: "claude", browsers: ["safari", "chrome"])
        let m = await model(api)
        await m.importContext()
        XCTAssertEqual(m.state.dialog, "safari")
        m.state.dialog = "keychain-browser"; m.state.browserFrom = "safari"; m.state.browserChoice = "chrome"
        await m.useBrowser()
        XCTAssertEqual(m.state.dialog, "keychain", "another browser is asked about afresh")
        await m.keychainAllow()
        XCTAssertEqual(m.state.dialog, "browser-profile", "Chrome has two profiles here")
        XCTAssertEqual(OnboardingHelpers.profilesOf(m.browsers).count, 2)
        m.state.profileChoice = "Profile 1"
        await m.chooseProfile()
        XCTAssertTrue(api.calls.contains("chooseBrowserProfile chrome Profile 1"))
        XCTAssertEqual(m.state.screen, "roles")
    }

    func testDeclineAndNoBrowser() async {
        let api = FakeImportAPI(scenario: "claude", browsers: [])
        let m = await model(api)
        await m.importContext()
        XCTAssertEqual(m.state.screen, "roles", "no browser to ask about: on at once")
        await until("the decline saved") { api.calls.contains("keychain declined") }
        let other = FakeImportAPI(scenario: "claude", browsers: ["chrome"])
        let n = await model(other)
        await n.importContext()
        await n.keychainDecline()
        XCTAssertEqual(n.state.screen, "roles")
        await until("tools on declined") { other.calls.contains("discoverTools anthropic chrome declined ") }
    }

    func testTheAgentPopupGoesOnByItself() async {
        let api = FakeImportAPI(scenario: "none", browsers: [])
        let m = await model(api)
        await m.importContext()
        XCTAssertEqual(m.state.dialog, "tools-setup")
        let popup = m.agentSetup!
        XCTAssertNil(popup.choice)
        XCTAssertTrue(popup.plan.primary.disabled)
        popup.choose("claude")
        await until("installed") { api.calls.contains("toolsInstall claude") }
        api.finishInstall("claude")
        await until("its sign-in offered") { popup.plan.primary.label == "Connect to Claude" }
        popup.primary()
        await until("sign-in") { api.calls.contains("toolsSignIn claude") }
        api.finishSignIn("claude")
        await until("on with what it was opened for") { m.state.screen == "roles" }
        XCTAssertEqual(m.state.provider, "anthropic")
        XCTAssertNil(m.agentSetup)
    }

    func testAppleNotesAskedOnceAndRemembered() async {
        let api = FakeImportAPI(scenario: "claude", browsers: [], disk: true)
        let m = await model(api, mode: .modal, into: "p1")
        await m.manually()
        m.pickSource("Apple Notes")
        await m.chooseMethod()
        XCTAssertEqual(m.state.dialog, "notes-permission")
        await m.notesAnswer(false)
        XCTAssertFalse(m.isPicked("Apple Notes"), "Don't allow takes it out")
        m.pickSource("Apple Notes")
        await m.chooseMethod()
        await m.notesAnswer(true)
        XCTAssertEqual(defaults.string(forKey: ImportFlowModel.notesKey), "1")
        let again = ImportFlowModel(api: api, mode: .modal, into: "p2", defaults: defaults)
        XCTAssertTrue(again.state.notesConsent)
    }

    func testOrganizeSkipAndFoldersReady() async {
        let api = FakeImportAPI(scenario: "claude", browsers: [])
        let m = await model(api, mode: .modal, into: "p1")
        XCTAssertFalse(m.foldersReady())
        await m.manually()
        m.pickSource("Obsidian")
        await m.chooseMethod()
        XCTAssertEqual(m.state.dialog, "organize")
        m.scrimPressed()
        XCTAssertEqual(m.state.dialog, "organize", "it needs an answer")
        await m.organizeSkip()
        XCTAssertTrue(m.state.organized)
        await until("the run started") { api.lastChoices != nil }
        let asked = FakeImportAPI(disk: true)
        let n = await model(asked)
        XCTAssertTrue(n.foldersReady(), "asked before: not again")
    }

    func testBrowserAgentsAskedAndConfirmed() async {
        let api = FakeImportAPI(scenario: "claude", browsers: [], disk: true)
        let m = await model(api, mode: .modal, into: "p1")
        await m.manually()
        m.state.mode = "auto"; m.state.methodFirst = false
        m.pickSource("ChatGPT")
        m.state.provider = "anthropic"
        await m.runGate()
        await until("asked") { m.state.dialog == "browser-agents" }
        XCTAssertEqual(m.state.agentsBrowser, "Chrome")
        XCTAssertEqual(m.state.agentsApps, ["ChatGPT"])
        await m.browserAgentsAnswer("declined")
        XCTAssertEqual(m.state.dialog, "browser-agents-confirm", "Don't allow asks again")
        await m.browserAgentsAnswer("declined")
        XCTAssertTrue(api.calls.contains("browserAgentsAnswer declined"))
        await until("the run") { api.lastChoices != nil }
    }

    func testPickerRowsScopesAndTools() async {
        let api = FakeImportAPI()
        let m = await model(api)
        let recommended = ImportFlowState.recommended
        XCTAssertEqual(recommended, ["Claude", "ChatGPT", "Obsidian", "Notion", "Zotero"])
        for id in recommended { XCTAssertTrue(ImportFlow.groups.contains { $0.apps.contains(id) }, id) }
        m.pickSource("Obsidian")
        XCTAssertTrue(m.isPicked("Obsidian"), "one pick for both rows")
        let sites = ImportFlow.groups.first { $0.id == "sites" }!
        XCTAssertEqual(m.keysOf(sites), [ImportFlow.sites, "links:Obsidian"])
        XCTAssertEqual(m.nameOf("links:Obsidian"), "Saved websites from Obsidian")
        XCTAssertEqual(m.spokenOf("links:Obsidian"), "websites saved in Obsidian")
        m.pickSource("links:Obsidian")
        m.toggleSpecify("Obsidian", "recommended")
        XCTAssertTrue(m.specifyOpen("Obsidian", "recommended"))
        XCTAssertFalse(m.specifyOpen("Obsidian", "home"), "the panel opens under the row it was opened from")
        m.pickSource("Notion")
        XCTAssertNil(m.state.scopeOpen, "ticking closes any Specify context")
        m.setScope("Obsidian") { $0.note = "Only the Memex notes" }
        m.setScope("links:Obsidian") { $0.note = "the essays" }
        m.state.groupScopes["notes"] = GroupScope(note: "For my thesis", people: [])
        m.pickSource("Obsidian")
        XCTAssertFalse(m.isPicked("links:Obsidian"), "a notes app unticked takes its saved websites with it")
        m.pickSource("Obsidian"); m.pickSource("links:Obsidian")
        m.state.customProjects = [FlowProject(id: "a", title: "Requirements study"), FlowProject(id: "b", title: "Memex")]
        m.state.picked = ["a", "b"]
        m.toggleSourceProject("Obsidian", "a")
        XCTAssertEqual(m.scopeOf("Obsidian").only, ["b"])
        m.toggleSourceProject("Obsidian", "b")
        XCTAssertEqual(m.scopeOf("Obsidian").only, ["b"], "a source is for one project at least")
        XCTAssertFalse(m.sourceProjectOn("Obsidian", "a"))
        let choices = ImportFlowState.runChoices(m.state, m.discovery)
        let obsidian = choices.scopes["Obsidian"]!
        XCTAssertEqual(obsidian["note"], .string("For my thesis. Only the Memex notes. \(ImportFlowState.linksNote) For those links: the essays."))
        XCTAssertEqual(obsidian["projects"], ["Memex"])
        XCTAssertEqual(obsidian["kind"], "folders")
        m.toggleSourceProject("Obsidian", "a")
        XCTAssertNil(m.scopeOf("Obsidian").only, "every one again: nil")

        m.sender["Gmail"] = " ada@x.edu "
        m.addPerson("Gmail")
        XCTAssertEqual(m.scopeOf("Gmail").people, ["ada@x.edu"])
        XCTAssertEqual(m.scopeOf("Gmail").kind, "email")
        await m.chooseFiles("Zoom")
        XCTAssertEqual(m.scopeOf("Zoom").folders.map(\.name), ["Engelbart notes.md"])
        await m.chooseFiles("Zoom")
        XCTAssertEqual(m.scopeOf("Zoom").folders.count, 1, "a file chosen once")
        await m.chooseFiles("Obsidian")
        XCTAssertEqual(m.state.dialog, "obsidian-picker")

        m.openAddTool()
        m.catalogQuery = "gro"
        XCTAssertEqual(m.catalogMatches.map(\.id), ["Grok"])
        m.draft.tool = "Vercel"; m.draft.website = "vercel.com"
        m.addTool()
        XCTAssertEqual(m.error, "Use a website beginning with https://")
        m.draft.website = "https://vercel.com"
        m.addTool()
        XCTAssertTrue(m.isPicked("custom:vercel"))
        XCTAssertEqual(m.state.added.last, AddedTool(id: "custom:vercel", name: "Vercel", website: "https://vercel.com", source: "user", group: "other"))
        XCTAssertEqual(m.keysOf(ImportFlow.groups.first { $0.id == "other" }!), ["Linear", "custom:vercel"])
        m.openAddTool(); m.draft.tool = "perplexity"
        m.addTool()
        XCTAssertTrue(m.isPicked("Perplexity"), "a known name picks the catalog's")
        XCTAssertEqual(m.state.open, ["chats"])
    }

    func testMergeToolsLeavesWhatThePersonTouched() {
        var s = FlowState()
        s.picks = ["Grok"]; s.touched = ["Grok", "Notion"]
        let results: JSONValue = ["tools": [["id": "Grok", "used": false], ["id": "Notion", "used": true, "evidence": "x"], ["id": "Obsidian", "used": true, "evidence": "x"], ["id": "Zoom", "used": true]],
                                  "additional": [["name": "Figma", "category": "design", "used": true, "evidence": "e"], ["name": "Vercel", "category": "code", "used": false]]]
        let out = ImportFlowState.mergeTools(s, results: results, tick: true)
        XCTAssertEqual(out.picks, ["Grok", "Obsidian", "custom:figma"])
        XCTAssertEqual(out.added.map(\.group), ["other", "code"])
        XCTAssertEqual(ImportFlowState.mergeTools(s, results: results, tick: false).picks, ["Grok"])
    }

    func testDiscoveryLine() {
        func line(_ projects: JSONValue, _ providers: JSONValue? = nil, _ provider: String? = "anthropic") -> ImportFlowState.DiscoveryLine? {
            ImportFlowState.discoveryLine(["projects": projects], providers: providers, provider: provider)
        }
        XCTAssertNil(line(["status": "idle"], nil, nil))
        XCTAssertEqual(line(["status": "idle"])?.text, "Recent projects weren’t looked for.")
        XCTAssertEqual(line(["status": "idle"])?.tryAgain, true)
        XCTAssertEqual(line(["status": "done", "empty": true])?.text, "No recent projects found. Add your own below.")
        XCTAssertEqual(line(["status": "running", "asking": ["Claude", "ChatGPT"]])?.text, "Asking Claude and ChatGPT about your projects…")
        let failed = line(["status": "failed", "connect": "openai"], ["providers": [["id": "openai", "installed": true, "signedIn": true]]])!
        XCTAssertEqual(failed.text, "Couldn’t reach Codex.")
        XCTAssertEqual(failed.connect, "Connect Codex")
        XCTAssertTrue(failed.refused)
        XCTAssertFalse(failed.tryAgain)
        XCTAssertEqual(line(["status": "failed"])?.text, "Couldn’t find recent projects. Add your own below.")
        XCTAssertEqual(line(["status": "waiting-provider"])?.connect, "Connect Claude Code or Codex")
        XCTAssertEqual(line(["status": "waiting-provider"])?.text, "Waiting for your AI provider…")
    }

    func testStartFromScratchAndAddProject() async {
        let api = FakeImportAPI()
        var made: JSONValue?
        let m = await model(api, done: { made = $0; _ = $1 })
        m.state.dialog = "scratch-confirm"
        m.scrimPressed()
        XCTAssertNil(m.state.dialog)
        m.state.scratchName = "  "
        await m.startFromScratch()
        XCTAssertNil(made, "a name first")
        m.state.scratchName = "Memex"; m.state.scratchDesc = " notes "
        await m.startFromScratch()
        XCTAssertEqual(api.projectsMade.last?["description"], "notes")
        XCTAssertEqual(J.str(made?["project"]?["name"]), "Memex")
        m.openAddProject()
        m.draft.title = String(repeating: "t", count: 100)
        m.addProject(now: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(m.state.customProjects.last?.title.count, 80)
        XCTAssertEqual(m.state.picked.last, "user-project:1000")
        var closed = false
        let modal = await model(api, mode: .modal, into: "p", close: { _ in closed = true })
        await modal.startFromScratch()
        XCTAssertTrue(closed, "over a project nothing is imported and the modal closes")
    }

    func testSupportedLogosEachOnce() {
        let supported = ImportFlowState.supported
        XCTAssertEqual(supported.prefix(8).map(\.name), ["Zotero", "Overleaf", "Obsidian", "Google Drive", "ChatGPT", "Claude", "Codex", "GitHub"])
        XCTAssertEqual(Set(supported.map(\.file)).count, supported.count)
        XCTAssertFalse(supported.contains { $0.name == "Claude Code" }, "Claude Code has Claude's logo")
        for one in supported { XCTAssertNotNil(Logos.image(file: one.file), one.file) }
        for id in Logos.browserIds { XCTAssertNotNil(Logos.browser(id), id) }
    }

    func testFlowStateRoundTrip() throws {
        var s = FlowState()
        s.period = nil; s.scopes = ["Obsidian": SourceScope(kind: "folders")]; s.refused = RefusedMark(provider: "openai", since: "x")
        let back = FlowState(saved: s.json)
        XCTAssertEqual(back, s)
        XCTAssertEqual(FlowState(saved: ["screen": "picker", "work": 7]).screen, "picker", "a field in another shape keeps fresh()'s value")
        XCTAssertEqual(FlowState(saved: ["screen": "picker"]).period, 365)
    }
}
