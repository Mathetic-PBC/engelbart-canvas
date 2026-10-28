import XCTest
import EngelbartCore
@testable import EngelbartConnect

// Port of test/import-flow.test.cjs (and the connect-sources facts other tests lean on).
final class ImportFlowTests: XCTestCase {
    private func p(_ id: String, installed: Bool = true, signedIn: Bool = true, subscription: String? = nil, since: Double? = nil) -> ImportFlow.ProviderFacts {
        .init(id: id, installed: installed, signedIn: signedIn, subscription: subscription, since: since)
    }

    func testBothSubscribedAlwaysAsks() {
        let both = [p("anthropic", subscription: "max"), p("openai", subscription: "pro")]
        XCTAssertEqual(ImportFlow.chooseProvider(both), .init(pick: nil, ask: true, choices: ["anthropic", "openai"], setup: false, suggested: nil))
        XCTAssertEqual(ImportFlow.chooseProvider(both, remembered: "openai").suggested, "openai")
        XCTAssertNil(ImportFlow.chooseProvider(both, remembered: "nobody").suggested)
    }

    func testOneSubscribed() {
        let out = ImportFlow.chooseProvider([p("anthropic", since: 1), p("openai", subscription: "plus", since: 9)])
        XCTAssertEqual(out.pick, "openai"); XCTAssertFalse(out.ask)
    }

    func testNeitherSubscribedOldest() {
        XCTAssertEqual(ImportFlow.chooseProvider([p("anthropic", since: 500), p("openai", since: 100)]).pick, "openai")
        XCTAssertEqual(ImportFlow.chooseProvider([p("anthropic", since: 100), p("openai", since: nil)]).pick, "anthropic")
    }

    func testNotReadyDoesNotCount() {
        XCTAssertEqual(ImportFlow.chooseProvider([p("anthropic", signedIn: false, subscription: "max"), p("openai")]).pick, "openai")
        XCTAssertTrue(ImportFlow.chooseProvider([p("anthropic", installed: false), p("openai", signedIn: false)]).setup)
        XCTAssertTrue(ImportFlow.chooseProvider([]).setup)
    }

    func testBrowsers() {
        XCTAssertEqual(ImportFlow.orderBrowsers(["opera", "safari", "chrome"], defaultId: "opera"), ["opera", "safari", "chrome"])
        XCTAssertEqual(ImportFlow.orderBrowsers(["opera", "chrome"], defaultId: "safari"), ["chrome", "opera"])
        XCTAssertEqual(ImportFlow.browserIdOfName("Google Chrome"), "chrome")
        XCTAssertEqual(ImportFlow.browserIdOfName("Safari"), "safari")
        XCTAssertEqual(ImportFlow.browserIdOfName("Arc"), "arc")
        XCTAssertEqual(ImportFlow.browserIdOfName("Comet"), "comet")
        XCTAssertEqual(ImportFlow.browserIdOfName("Chromium"), "chromium")
        XCTAssertNil(ImportFlow.browserIdOfName("Something else"))
    }

    func testCatalog() {
        XCTAssertEqual(Set(ImportFlow.catalogIds).count, ImportFlow.catalogIds.count)
        XCTAssertTrue(ImportFlow.catalogIds.contains("GitHub"))
        XCTAssertTrue(ImportFlow.catalogIds.contains(ImportFlow.localFolders))
        XCTAssertTrue(ImportFlow.catalogIds.contains(ImportFlow.sites))
        XCTAssertEqual(ImportFlow.catalogTool("Google Docs")?.name, "Google Drive")
        XCTAssertEqual(ImportFlow.catalogTool("Obsidian")?.local, true)
        XCTAssertEqual(ImportFlow.catalogTool("Notion")?.local, false)
    }

    func testReadProjects() {
        let reply = "```json\n{\"projects\":[{\"title\":\"Engelbart context import\",\"description\":\"Designing onboarding\",\"recent\":\"Today\",\"folder\":\"/Users/x/engelbart\"},{\"title\":\"Engelbart context import\"},{\"title\":\"\"},{\"title\":\"" + String(repeating: "x", count: 200) + "\"},{\"title\":\"A\"},{\"title\":\"B\"},{\"title\":\"C\"}]}\n```"
        let out = ImportFlow.readProjects(reply)!
        XCTAssertEqual(out.count, 5)
        XCTAssertEqual(Set(out.map(\.id)).count, 5)
        XCTAssertEqual(out[1].id, "engelbart-context-import-2")
        XCTAssertEqual(out[0].folder, "/Users/x/engelbart")
        XCTAssertLessThanOrEqual(out[2].title.count, 80)
        XCTAssertTrue(out[2].title.hasSuffix("…"))
        XCTAssertNil(ImportFlow.readProjects("no json here"))
        XCTAssertNil(ImportFlow.readProjects("{\"projects\":[]}"))
    }

    func testReadTools() {
        let known: [String: ImportFlow.ToolFact] = ["Obsidian": .init(used: true, evidence: "a vault", method: "local"), "Notion": .init(used: true, evidence: "signed in", method: "cookie")]
        let out = ImportFlow.readTools(#"{"tools":[{"id":"Obsidian","used":false},{"id":"Notion","used":false,"evidence":"no pages"},{"id":"Bogus","used":true}],"additional":[{"name":"Linear","website":"https://linear.app","used":true},{"name":"notion"},{"name":"Figma","website":"javascript:alert(1)"}]}"#, known: known)
        XCTAssertEqual(out.tools.count, ImportFlow.catalogIds.count)
        XCTAssertEqual(out.tools.first { $0.id == "Obsidian" }?.used, true)
        XCTAssertEqual(out.tools.first { $0.id == "Obsidian" }?.method, "local")
        XCTAssertEqual(out.tools.first { $0.id == "Notion" }?.used, false)
        XCTAssertEqual(out.tools.first { $0.id == "Notion" }?.evidence, "no pages")
        XCTAssertEqual(out.additional.map(\.name), ["Figma"])
        XCTAssertEqual(out.tools.first { $0.id == "Linear" }?.used, true)
        XCTAssertEqual(out.additional[0].website, "")
        let fallback = ImportFlow.readTools("garbage", known: known)
        XCTAssertEqual(fallback.tools.first { $0.id == "Notion" }?.used, true)
        XCTAssertEqual(fallback.tools.first { $0.id == "Notion" }?.method, "cookie")
        XCTAssertEqual(fallback.tools.first { $0.id == "Zotero" }?.method, "none")
    }

    func testScopes() {
        XCTAssertEqual(ImportFlow.scopeKind("Obsidian"), "folders")
        XCTAssertEqual(ImportFlow.scopeKind("Gmail"), "email")
        XCTAssertEqual(ImportFlow.scopeKind("Overleaf"), "drafts")
        XCTAssertEqual(ImportFlow.scopeKind("Claude"), "chats")
        var scope = ImportFlow.emptyScope("Gmail")
        XCTAssertFalse(ImportFlow.scopeReady(scope))
        scope.people.append("lee@example.edu")
        XCTAssertTrue(ImportFlow.scopeReady(scope))
        var folders = ImportFlow.emptyScope(ImportFlow.localFolders)
        folders.note = "my papers"
        XCTAssertFalse(ImportFlow.scopeReady(folders))
        XCTAssertEqual(ImportFlow.scopeOptions("Overleaf", projects: [.init(id: "a", title: "Study")]).count, 2)
        XCTAssertEqual(ImportFlow.scopeOptions("GitHub", projects: [.init(id: "a", title: "My Study!")]).first?.label, "my-study")
    }

    func testPlan() {
        let projects = [ImportFlow.Project(id: "a", title: "Requirements study", description: "How novices describe requirements")]
        let auto = ImportFlow.importPlan(app: "Google Docs", mode: "auto", projects: projects, roles: ["Researcher"], work: "CS education")
        XCTAssertTrue(auto.contains("only what pertains to these projects"))
        XCTAssertTrue(auto.hasPrefix("Bring in from Google Drive only"))
        XCTAssertTrue(auto.contains("Requirements study: How novices"))
        XCTAssertTrue(auto.contains("Never install a plugin"))
        XCTAssertTrue(ImportFlow.importPlan(app: "Notion", mode: "auto", projects: projects).contains("through Notion's own tools (its connector)"))
        let manual = ImportFlow.importPlan(app: "Gmail", mode: "manual", projects: projects, scope: .init(kind: "email", people: ["lee@example.edu"]))
        XCTAssertTrue(manual.contains("read only email with these people: lee@example.edu"))
        XCTAssertFalse(manual.contains("Never install"))
        let plan = ImportFlow.importPlan(app: "Google Docs", projects: [.init(id: "s", title: "Study", description: "A study")], browser: "Chrome")
        XCTAssertTrue(plan.contains("in the person's own Chrome"))
        XCTAssertFalse(ImportFlow.importPlan(app: "Google Docs", projects: [.init(id: "s", title: "Study")]).contains("own Chrome"))
        XCTAssertTrue(ImportFlow.isWebApp("Google Docs")); XCTAssertFalse(ImportFlow.isWebApp("Obsidian"))
        let scoped = ImportFlow.importPlan(app: "Notion", mode: "auto", projects: [.init(id: "a", title: "Requirements study"), .init(id: "b", title: "Memex")],
                                           scope: .init(kind: "documents", note: "Only the pages about the Memex", projects: ["Memex"]))
        XCTAssertTrue(scoped.contains("For this source, only these of the projects: Memex."))
        XCTAssertTrue(scoped.contains("In their words, what to bring in from it: Only the pages about the Memex"))
    }

    func testPausedAndOther() {
        XCTAssertFalse(ImportFlow.groups.contains { $0.id == "email" })
        XCTAssertFalse(ImportFlow.catalogIds.contains("Gmail"))
        XCTAssertNil(ImportFlow.groupOfApp("Gmail"))
        let other = ImportFlow.groups.last!
        XCTAssertEqual(other, SourceGroup(id: "other", label: "Other", apps: ["Linear"]))
        XCTAssertEqual(ImportFlow.groups.first { $0.id == "code" }?.apps, ["GitHub", ImportFlow.localFolders])
    }

    func testExtraToolCategories() {
        let reply = #"{"tools":[],"additional":[{"name":"Asana","website":"https://asana.com","used":true,"category":"code"},{"name":"Figma","used":true,"category":"design"},{"name":"Readwise","used":true,"category":"Notes"},{"name":"Google Calendar","used":true,"category":"other"},{"name":"Calendly","used":true},{"name":"Cal.com","used":true},{"name":"Outlook","used":true,"category":"email"},{"name":"Superhuman Mail","used":true},{"name":"Fantastical","used":true}]}"#
        let out = ImportFlow.readTools(reply)
        XCTAssertEqual(out.additional.map { [$0.name, $0.category] }, [["Asana", "code"], ["Figma", "other"], ["Readwise", "notes"]])
    }

    func testConnectSources() {
        XCTAssertEqual(ConnectSources.shownName("Google Docs"), "Google Drive")
        XCTAssertEqual(ConnectSources.sharesSignIn("Gmail"), ["Gmail", "Google Docs", "Google Meet", "Gemini"])
        XCTAssertEqual(ConnectSources.sharesSignIn("Claude"), ["Claude"])
        XCTAssertTrue(ConnectSources.signsInThroughBrowser("Gemini"))
        XCTAssertFalse(ConnectSources.signsInThroughBrowser("ChatGPT"))
        XCTAssertEqual(ConnectSources.signInGroup("Overleaf"), "overleaf.com ^overleaf_session")
        XCTAssertEqual(ConnectSources.signInGroup("Zotero"), "Zotero")
        XCTAssertEqual(ConnectSources.sourceOfApp("GitHub"), "code")
        XCTAssertEqual(ConnectSources.categoryOfApp("Claude"), "chat")
        XCTAssertNil(ConnectSources.categoryOfApp("Linear"))
        XCTAssertEqual(ConnectSources.recallApps(["ChatGPT", "Obsidian", "Gemini"]), ["ChatGPT", "Gemini"])
        XCTAssertEqual(ConnectSources.cleanDays(182), 182); XCTAssertNil(ConnectSources.cleanDays(30))
        XCTAssertEqual(ConnectSources.periodName(nil), "all time"); XCTAssertEqual(ConnectSources.periodName(365), "the past year")
        XCTAssertTrue(ConnectSources.itemSources.contains("engelbart")); XCTAssertFalse(ConnectSources.itemSources.contains("GitHub"))
        XCTAssertEqual(Set(ConnectSources.itemSources).count, ConnectSources.itemSources.count)
        XCTAssertTrue(ConnectSources.signInCookies["Claude"]!.matches("sessionKey"))
        XCTAssertFalse(ConnectSources.signInCookies["Claude"]!.matches("sessionKey2"))
        XCTAssertEqual(ImportFlow.clip("  a\n\n b  ", 10), "a b")
        XCTAssertEqual(ImportFlow.slug("  "), "project")
    }
}
