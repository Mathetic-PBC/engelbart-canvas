import EngelbartCore
import EngelbartIntegrations
import EngelbartStore
import EngelbartTools
import SwiftUI
import XCTest
@testable import EngelbartScreens

// Onboarding.jsx's state machine (OnboardingModel), driven with a fake api: each flow walked to its end.

@MainActor
final class OnboardingModelTests: XCTestCase {
    var data = FakeData()
    var done: [(Onboarded, OnboardedExtras)] = []
    var toolsAnswers: [String] = []
    var installs: [[String]] = []
    var updates: [String] = []
    var remembered: [String] = []
    var providers = AgentProviders(providers: [])
    var hub = EventHub()

    func make(_ mode: OnboardingMode, into: String? = nil, importFlow: Bool = false, connect: Bool = false, pick: String? = nil) -> OnboardingModel {
        let agents = OnboardingAgents(providers: { _ in self.providers }, rememberProvider: { self.remembered.append($0) },
                                      toolsInstall: { self.installs.append($0) }, toolsUpdate: { self.updates.append($0) })
        let context = OnboardingContext(
            mode: mode, into: into, data: data, agents: agents, onTools: { self.toolsAnswers.append($0) },
            onDone: { made, extras in self.done.append((made, extras)) }, onBack: {}, pickDirectory: { pick },
            copyText: { _ in true },
            importSignins: { open in open("https://scholar.google.com"); open("https://scholar.google.com"); open("https://x.org") },
            importFlow: importFlow ? { _ in AnyView(EmptyView()) } : nil,
            connectLibrary: connect ? { _ in AnyView(EmptyView()) } : nil,
            agentSetup: { _ in AnyView(EmptyView()) }, hub: hub)
        let model = OnboardingModel(context: context)
        model.folderDelay = 0.01
        return model
    }

    func testModes() {
        XCTAssertEqual(make(.existing).place.step, "create", "+ Project starts on Create")
        XCTAssertEqual(make(.new).place.step, "welcome")
        XCTAssertEqual(make(.guided).flowMode, .new, "the guided setup without a project is a new user's")
        XCTAssertEqual(make(.guided, into: "p1").flowMode, .guided)
        XCTAssertFalse(make(.new).connectMode, "without Import your context plugged in, the screens that work without it")
        XCTAssertTrue(make(.new, importFlow: true).connectMode)
        XCTAssertTrue(make(.guided, into: "p1", connect: true).connectMode)
        XCTAssertFalse(make(.existing, importFlow: true, connect: true).connectMode, "+ Project never has Connect")
    }

    func testStartReadsLibraryInstructionsFolderAndTheGuidedProject() async {
        data.rows = [row("a", "Paper")]
        data.saved = "I study help-seeking."
        let model = make(.guided, into: "p1", connect: true)
        await model.start()
        XCTAssertEqual(model.library.map(\.id), ["a"])
        XCTAssertEqual(model.instr, "I study help-seeking."); XCTAssertEqual(model.instrSrc, "own")
        XCTAssertEqual(model.intoProject, ProjectAbout(name: "Thesis", description: "on help-seeking"), "the librarian is told the project, never its id")
        XCTAssertEqual(model.librarianProject, model.intoProject)
        await until { model.newPath == "~/my-project" }
        model.name = "Teachable Agents"
        await until { model.newPath == "~/teachable-agents" }
        XCTAssertEqual(model.newPath, "~/teachable-agents")
        data.rows.append(row("b", "Site", type: "website"))
        hub.post("engelbart:library-changed")
        await until { model.library.count == 2 }
        XCTAssertEqual(model.library.count, 2, "read again on every library-changed announcement")
    }

    func testPlusProjectCreateThenContextThenOpen() async {
        data.rows = [row("a", "Paper", tags: ["paper"]), row("n", "Note", type: "md", tags: ["note"]), row("w", "Site", type: "website", url: "https://memex.org")]
        let model = make(.existing, pick: "/Users/h/code")
        await model.start()
        XCTAssertEqual(model.pager, PagerPosition(count: 2, index: 0))
        await model.createNext()
        XCTAssertEqual(model.place.step, "create", "an empty name goes nowhere")
        model.name = "Spec study"
        await model.browseFolder()
        XCTAssertEqual(model.folder, "existing"); XCTAssertEqual(model.folderPath, "/Users/h/code")
        data.folderProblem = "Nothing is at /Users/h/code"
        await model.createNext()
        XCTAssertEqual(model.error, "Nothing is at /Users/h/code"); XCTAssertEqual(model.part, "name", "the folder is checked first, staying")
        model.useNewFolder()
        XCTAssertEqual(model.error, ""); XCTAssertEqual(model.folder, "new")
        await model.createNext()
        XCTAssertEqual(model.part, "desc")
        XCTAssertTrue(model.createButtons.showSkip)
        await model.createNext() // Skip on an empty description
        XCTAssertEqual(model.place.step, "context")
        XCTAssertEqual(model.contextRows.map(\.id), ["a", "w"], "no notes")
        model.toggleAll()
        XCTAssertEqual(model.sel, ["a": true, "w": true])
        model.toggleAll()
        XCTAssertEqual(model.sel, ["a": false, "w": false])
        model.toggle("w")
        await model.open()
        XCTAssertEqual(data.started.first?.context, ["w"])
        XCTAssertEqual(data.started.first?.name, "Spec study")
        XCTAssertFalse(data.started.first!.onboarding, "+ Project is not an onboarding")
        XCTAssertEqual(done.first?.0.projectId, "p-new")
        XCTAssertEqual(done.first.map { $0.0.landingTab?.title }, "Welcome!", "+ Project lands with its Welcome! note open")
    }

    func testTheEmptyLibraryDetourComesBackToContext() async {
        let model = make(.existing)
        await model.start()
        model.name = "x"
        await model.createNext(); await model.createNext()
        XCTAssertEqual(model.place.step, "context")
        model.addToLibraryDetour()
        XCTAssertEqual(model.place, OnboardingPlace(step: "import", sub: 0, detour: true))
        XCTAssertNil(model.pager, "no pager on a detour")
        model.advance(); model.advance(); model.advance()
        XCTAssertEqual(model.place.step, "context", "the end of the import screen returns to context")
    }

    func testANewUsersFlowWithoutImportYourContextEndsInTheProject() async {
        let model = make(.new)
        await model.start()
        XCTAssertEqual(model.pager, PagerPosition(count: 4, index: 0), "welcome, create, import, instructions")
        model.welcomeNext()
        XCTAssertEqual(model.place.step, "create", "without Connect, on at once")
        model.name = "Teachable agents"; model.desc = "Debugging with LLMs"
        await model.createNext(); await model.createNext()
        XCTAssertEqual(model.place, OnboardingPlace(step: "import", sub: 0))
        XCTAssertTrue(data.started.isEmpty, "Create makes no project (2026-10-10)")
        // GitHub: skipped. Websites: one added, one refused, one already in the list.
        model.advance()
        XCTAssertEqual(model.part, "url")
        model.entry = "memex"
        await model.addEntry()
        XCTAssertEqual(model.entryErr, "that doesn’t look like a web address")
        model.entry = "memex.org"
        await model.addEntry()
        XCTAssertEqual(data.calls.last, "add https://memex.org", "a bare address gets https://")
        XCTAssertEqual(model.entry, ""); XCTAssertEqual(model.addedHere("url").count, 1)
        data.refuse["https://memex.org"] = "Already in the library as “memex.org”"
        model.entry = "https://memex.org"
        await model.addEntry()
        XCTAssertEqual(model.entryErr, "already added", "a link already in the list says so")
        XCTAssertEqual(model.entry, "")
        model.entry = "localhost:3000"
        await model.addEntry()
        XCTAssertEqual(data.calls.last, "add https://localhost:3000", "localhost needs no dot")
        model.entry = ""
        await model.addEntry() // empty Enter with something added: on
        XCTAssertEqual(model.part, "pdf")
        data.picked = ["/Users/h/a.pdf", "/Users/h/b.pdf"]
        data.refuse["/Users/h/b.pdf"] = "Only files inside your home directory can be added"
        await model.pickPapers()
        XCTAssertEqual(model.error, "Only files inside your home directory can be added", "the first refusal (not Already) shown")
        XCTAssertEqual(model.addedHere("pdf").count, 1)
        model.advance()
        XCTAssertEqual(model.place.step, "instructions")
        model.chooseInstructions("claude"); model.copyPrompt()
        XCTAssertTrue(model.copied)
        model.instr = "Be blunt."
        await model.saveInstructions()
        await until { !self.done.isEmpty }
        XCTAssertEqual(data.saved, "Be blunt.")
        let input = data.started.first
        XCTAssertEqual(input?.name, "Teachable agents"); XCTAssertEqual(input?.description, "Debugging with LLMs")
        XCTAssertEqual(input?.onboarding, true)
        XCTAssertEqual(Set(input?.context ?? []), Set(model.added.map(\.id)), "what this onboarding added goes into its workspace")
        XCTAssertNil(done.first?.0.landingTab, "a new user's lands on the Welcome page, not the note")
    }

    func testANewUsersWelcomeAsksForAnAgentAndGoesOnWithOne() async {
        let model = make(.new, importFlow: true)
        await model.start()
        model.setTools(snap(["git": s("missing")]))
        model.welcomeNext()
        XCTAssertEqual(model.gate, .checking)
        XCTAssertEqual(model.place.step, "welcome")
        await until { model.gate == .ask }
        XCTAssertEqual(model.gate, .ask, "no CLI qualifies: the popup")
        XCTAssertEqual(installs, [["git"]], "Git missing is installed in the background, never asked about")
        model.agentDone("claude")
        await settle()
        XCTAssertEqual(remembered, ["anthropic"]); XCTAssertEqual(toolsAnswers, ["skip"])
        XCTAssertNil(model.gate)
        XCTAssertEqual(model.place.step, "create")
        XCTAssertTrue(model.showsImportFlow, "a new user's Create is Import your context's page")
        let extras = OnboardedExtras(stageLinks: ["https://x.org", "https://y.org"], session: "s1")
        model.importSignins()
        await model.importDone(Onboarded(projectId: "p", workspaceId: "w", gettingStarted: true), extras)
        XCTAssertEqual(done.first?.1.stageLinks, ["https://scholar.google.com", "https://x.org", "https://y.org"], "each site once")
        XCTAssertEqual(done.first?.1.session, "s1")
    }

    func testAQualifyingCliGoesStraightOnAndIsUpdated() async {
        providers = prov(["anthropic": SUB("anthropic")])
        let model = make(.new, importFlow: true)
        await model.start()
        model.welcomeNext()
        XCTAssertEqual(model.gate, .checking, "waits for the tool check")
        model.setTools(snap(["claude": s("outdated")]))
        await until { model.place.step != "welcome" }
        XCTAssertEqual(model.place.step, "create")
        XCTAssertEqual(updates, ["claude"]); XCTAssertEqual(toolsAnswers, ["skip"])
    }

    func testTheGuidedSetupSkippingTheAgentDropsConnectAndEndsInAWelcomeWorkspace() async {
        let model = make(.guided, into: "p1", connect: true)
        await model.start()
        XCTAssertEqual(model.pager, PagerPosition(count: 2, index: 0))
        model.setTools(snap(["claude": s("missing"), "codex": s("missing")]))
        model.welcomeNext()
        await until { model.gate == .ask }
        model.agentSkip()
        XCTAssertTrue(model.connectDropped)
        XCTAssertFalse(model.connectMode)
        XCTAssertEqual(model.place.step, "import", "Connect dropped: its old screens come back")
        XCTAssertEqual(model.pager, PagerPosition(count: 3, index: 1))
        model.advance(); model.advance(); model.advance()
        XCTAssertEqual(model.place.step, "instructions")
        model.advance() // Skip
        await until { !self.done.isEmpty }
        XCTAssertEqual(data.welcomed.first?.0, "p1")
        XCTAssertEqual(done.first?.0.workspaceId, "w-welcome")
        XCTAssertTrue(data.started.isEmpty, "no project is made")
    }

    func testTheGuidedSetupsConnectYourLibrary() async {
        providers = prov(["openai": SUB("openai")])
        let model = make(.guided, into: "p1", connect: true)
        await model.start()
        model.setTools(snap())
        model.welcomeNext()
        await until { model.place.step == "connect" }
        XCTAssertEqual(model.place.step, "connect")
        XCTAssertEqual(model.pager, PagerPosition(count: 2, index: 1))
        model.connectSession("s9")
        model.connectAdded(row("r", "a/b", type: "website", tags: ["git"]))
        data.rows.append(row("r", "a/b", type: "website", tags: ["git"]))
        _ = await model.readLibrary()
        model.advance()
        await until { !self.done.isEmpty }
        XCTAssertEqual(data.offers, ["started"])
        XCTAssertEqual(data.welcomed.first?.1, ["r"], "a repository Connect added is in its context")
        XCTAssertEqual(data.welcomed.first?.2, "s9", "with Connect's session")
    }

    func testAFailureGoesBackWithTheError() async {
        data.startProblem = "A project named x exists"
        let model = make(.existing)
        await model.start()
        model.name = "x"
        await model.createNext(); await model.createNext()
        await model.open()
        XCTAssertEqual(model.place.step, "context")
        XCTAssertEqual(model.error, "A project named x exists")
        XCTAssertTrue(done.isEmpty)
    }

    func testRepositoriesTickAndUntick() async {
        let model = make(.new)
        await model.start()
        let repo = GithubRepo(id: "42", fullName: "a/b", url: "https://github.com/a/b", owner: "a", isPrivate: false)
        XCTAssertNil(model.heldRepo(repo))
        await model.toggleRepo(repo)
        XCTAssertEqual(data.calls.last, "add https://github.com/a/b")
        XCTAssertNotNil(model.heldRepo(repo), "ticked")
        XCTAssertEqual(model.addedHere("github").count, 1)
        await model.toggleRepo(repo)
        XCTAssertTrue(data.calls.last!.hasPrefix("discard"), "unticking one it made removes it")
        XCTAssertNil(model.heldRepo(repo)); XCTAssertTrue(model.added.isEmpty)
        // One the library held before: ticked, not counted as made here; unticking leaves it.
        data.rows.append(row("old", "a/c", type: "website", url: "https://github.com/a/c", githubId: "43"))
        _ = await model.readLibrary()
        let held = GithubRepo(id: "43", fullName: "a/c", url: "https://github.com/a/c", owner: "a", isPrivate: false)
        XCTAssertEqual(model.heldRepo(held)?.id, "old")
        let before = data.calls.count
        await model.toggleRepo(held)
        XCTAssertEqual(data.calls.count, before, "a row it did not make is never removed")
        // Already in the library: taken, not fresh.
        data.refuse["https://github.com/a/c"] = "Already in the library as “a/c”"
        let problem = await model.addOne("https://github.com/a/c", src: "github")
        XCTAssertEqual(problem, "Already in the library as “a/c”")
        XCTAssertEqual(model.added.last, OnboardingModel.Added(id: "old", src: "github", fresh: false))
        // A sandbox that could not start is said, not refused.
        data.sandboxError = "The sandbox could not start"
        _ = await model.addOne("https://github.com/a/d", src: "github")
        XCTAssertEqual(model.error, "The sandbox could not start")
    }
}
