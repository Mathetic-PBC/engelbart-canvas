import EngelbartDoc
import XCTest
@testable import EngelbartBart

// Ported from test/settings.test.cjs.

final class FakeToolStatus: BartToolStatus, @unchecked Sendable {
    let usable: [String]?
    let records: [String: (Bool, String?)]
    init(usable: [String]?, records: [String: (Bool, String?)] = [:]) { self.usable = usable; self.records = records }
    func usableAgents() -> [String]? { usable }
    func record(_ tool: String) -> (installed: Bool, status: String?) { let r = records[tool] ?? (false, nil); return (r.0, r.1) }
}

final class SettingsTests: XCTestCase {
    func steps(_ m: ModelsList, _ text: String = "why?") -> [String] { Question.readQuestion(text, m).steps.map { "\($0.name) \($0.effort)" } }
    func readFile(_ root: URL, _ name: String = ModelDefaults.modelsFile) -> OJ { OJ.read(root.appendingPathComponent(name))! }
    func ladderOn(_ root: URL, _ provider: String) -> [String] {
        readFile(root)["providers"]![provider]!["ladder"]!.array!.map { "\($0["model"]!.string!) \($0["effort"]!.string!)" }
    }
    func press(_ root: URL, _ provider: String, _ key: String) {
        let cell = Intelligence.cellModels(ModelSettings.read(home: root).models, "bart", provider)
        _ = try! ModelSettings.save(home: root, patch: Intelligence.patchOf("bart", provider, Rung(model: key, effort: Intelligence.effortFor(cell, key))))
    }

    func testWithFirstStep() {
        let claude = DEFAULTS.providers["anthropic"]!, codex = DEFAULTS.providers["openai"]!
        func l(_ p: String, _ e: ProviderEntry, _ m: String, _ ef: String) -> [String] { Models.withFirstStep(p, e, Rung(model: m, effort: ef)).map { "\($0.model) \($0.effort)" } }
        XCTAssertEqual(l("anthropic", claude, "sonnet", "medium"), ["sonnet medium", "sonnet high", "opus high", "fable xhigh"])
        XCTAssertEqual(l("anthropic", claude, "sonnet", "high"), ["sonnet high", "opus high", "fable xhigh"])
        XCTAssertEqual(l("anthropic", claude, "sonnet", "max"), ["sonnet max", "opus high", "fable xhigh"])
        XCTAssertEqual(l("anthropic", claude, "opus", "high"), ["opus high", "fable xhigh"])
        XCTAssertEqual(l("anthropic", claude, "fable", "max"), ["fable max"])
        XCTAssertEqual(l("openai", codex, "luna", "ultra"), ["luna ultra", "sol medium", "sol high", "astra xhigh"])
        var one = claude; one.ladder = [Rung(model: "fable", effort: "xhigh")]
        XCTAssertEqual(l("anthropic", one, "sonnet", "xhigh"), ["sonnet xhigh", "opus high", "fable xhigh"])
        var noFable = claude; noFable.models["fable"] = nil
        XCTAssertEqual(l("anthropic", noFable, "sonnet", "high"), ["sonnet high", "opus high"])
        var two = codex; two.efforts = ["medium", "high"]
        XCTAssertEqual(l("openai", two, "luna", "high"), ["luna high", "sol medium", "sol high"])
        XCTAssertEqual(l("anthropic", claude, "haiku", "low"), ["haiku low", "sonnet high", "opus high", "fable xhigh"])
    }

    func testPressingKeepsLadderWhole() throws {
        let root = tempDir("settings")
        _ = Models.load(home: root)
        press(root, "anthropic", "fable")
        XCTAssertEqual(ladderOn(root, "anthropic"), ["fable xhigh"])
        press(root, "anthropic", "sonnet")
        XCTAssertEqual(ladderOn(root, "anthropic"), ["sonnet xhigh", "opus high", "fable xhigh"])
        XCTAssertEqual(steps(ModelSettings.modelsInForce(home: root)), ["Sonnet xhigh", "Opus high", "Fable xhigh"])
        try ModelSettings.save(home: root, patch: ["bart": ["anthropic": ["model": "sonnet", "effort": "high"]]])
        XCTAssertEqual(readFile(root)["providers"]!["anthropic"]!["ladder"], ModelDefaults.models["providers"]!["anthropic"]!["ladder"])
        press(root, "anthropic", "haiku")
        XCTAssertEqual(ladderOn(root, "anthropic"), ["haiku high", "sonnet high", "opus high", "fable xhigh"])
    }

    func testRead() {
        let root = tempDir("settings")
        Choices.remember(home: root, place: "bart", Choice(provider: "openai", model: "sol", effort: "high"))
        let tools = FakeToolStatus(usable: ["claude"], records: ["claude": (true, "ready"), "codex": (true, "signed-out")])
        let read = ModelSettings.read(home: root, only: ["anthropic"], tools: tools)
        XCTAssertEqual(read.models, Models.load(home: root))
        XCTAssertEqual(read.models.providers.keys, ["openai", "anthropic"])
        XCTAssertEqual(read.models.provider, "anthropic")
        XCTAssertEqual(read.usable, ["claude"]); XCTAssertEqual(read.offered, ["anthropic"])
        XCTAssertEqual(read.cli["openai"]!, "signed out"); XCTAssertEqual(read.cli["anthropic"]!, nil)
        XCTAssertEqual(ModelSettings.read(home: root, only: []).offered, ["openai", "anthropic"])
        XCTAssertEqual(ModelSettings.read(home: root).cli["openai"]!, nil)
        let notes = ModelSettings.cliNotes(DEFAULTS.providers, FakeToolStatus(usable: [], records: ["claude": (true, "outdated"), "codex": (false, "missing")]))
        XCTAssertEqual(notes["openai"]!, "not installed"); XCTAssertEqual(notes["anthropic"]!, "out of date")
        XCTAssertEqual(ModelSettings.cliNotes(DEFAULTS.providers, FakeToolStatus(usable: [], records: ["claude": (true, "failed")]))["anthropic"]!, "cannot run")
    }

    func testBadPicksRefused() throws {
        let root = tempDir("settings")
        _ = Models.load(home: root)
        Choices.remember(home: root, place: "bart", Choice(provider: "anthropic", model: "opus", effort: "high"))
        let fileURL = root.appendingPathComponent(ModelDefaults.modelsFile), choicesURL = root.appendingPathComponent(Choices.file)
        let file = try String(contentsOf: fileURL, encoding: .utf8), choices = try String(contentsOf: choicesURL, encoding: .utf8)
        let cases: [(OJ, String)] = [
            (.null, "settings must be an object"),
            (["theme": "dark"], "theme is not a setting"),
            (["provider": "mistral"], "provider must be one of openai, anthropic"),
            (["buildProvider": 3], "buildProvider must be one of"),
            (["bart": ["anthropic": ["model": "sol", "effort": "high"]]], "@bart on anthropic must be one of its provider's models and efforts"),
            (["bart": ["anthropic": ["model": "opus", "effort": "ultra"]]], "must be one of its provider's models and efforts"),
            (["bart": ["mistral": ["model": "opus", "effort": "high"]]], "@bart's provider must be one of"),
            (["bart": "opus"], "@bart must name providers"),
            (["brainstorm": ["openai": ["model": "luna"]]], "@brainstorm on openai"),
            (["discover": ["anthropic": ["model": "opus", "effort": "high"]]], "@discover's level must be one of quick, standard, deep"),
            (["discover": ["anthropic": "deep"]], "@discover on anthropic must name its levels"),
            (["discover": ["openai": ["deep": ["model": "astra", "effort": "max"]]]], "@discover deep on openai"),
            (["build": ["anthropic": ["model": "opus", "effort": "low"]]], "Build on anthropic"),
            (["provider": "openai", "bart": ["openai": ["model": "sol", "effort": "high"]], "brainstorm": ["anthropic": ["model": "rm -rf", "effort": "high"]]], "@brainstorm on anthropic"),
        ]
        for (patch, message) in cases {
            XCTAssertThrowsError(try ModelSettings.save(home: root, patch: patch)) { error in
                XCTAssertTrue((error as? SettingsError)?.message.contains(message) == true, "\(patch.stringify()): \(error)")
            }
            XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), file)
            XCTAssertEqual(try String(contentsOf: choicesURL, encoding: .utf8), choices)
        }
    }

    func testWritesOnlyChanges() throws {
        let root = tempDir("settings")
        _ = Models.load(home: root)
        var mine = readFile(root).setting("about", "My own notes on this file.")
        mine = ModelDefaults.at(mine, ["providers", "openai", "models", "sol"]) { $0.setting("use", "My words.") }
        mine = ModelDefaults.at(mine, ["discover"]) { $0.setting("about", "Mine too.") }
        mine = mine.setting("mySetting", ["anything": [1, 2]])
        mine = ModelDefaults.at(mine, ["build", "providers", "anthropic"]) { $0.setting("note", "kept") }
        try writeJSONFile(root.appendingPathComponent(ModelDefaults.modelsFile), mine)
        let out = try ModelSettings.save(home: root, patch: [
            "provider": "anthropic", "buildProvider": "openai",
            "bart": ["anthropic": ["model": "opus", "effort": "max"]],
            "brainstorm": ["openai": ["model": "astra", "effort": "xhigh"]],
            "discover": ["anthropic": ["standard": ["model": "fable", "effort": "high"], "deep": ["model": "opus", "effort": "max"]]],
            "build": ["openai": ["model": "luna", "effort": "medium"]],
        ])
        var expected = ModelDefaults.at(mine, ["build"]) { $0.setting("provider", "openai") }
        expected = ModelDefaults.at(expected, ["providers", "anthropic"]) { $0.setting("ladder", [["model": "opus", "effort": "max"], ["model": "fable", "effort": "xhigh"]]) }
        expected = ModelDefaults.at(expected, ["brainstorm", "providers"]) { $0.setting("openai", ["model": "astra", "effort": "xhigh"]) }
        expected = ModelDefaults.at(expected, ["discover", "providers", "anthropic"]) { $0.setting("standard", ["model": "fable", "effort": "high"]) }
        expected = ModelDefaults.at(expected, ["build", "providers", "openai"]) { $0.setting("default", ["model": "luna", "effort": "medium"]) }
        let now = readFile(root)
        XCTAssertEqual(now, expected)
        XCTAssertEqual(now.keys, mine.keys)
        XCTAssertEqual(out.models, ModelSettings.read(home: root).models)
        XCTAssertEqual(Models.load(home: root), out.models)
        let before = try String(contentsOf: root.appendingPathComponent(ModelDefaults.modelsFile), encoding: .utf8)
        try ModelSettings.save(home: root, patch: ["bart": ["anthropic": ["model": "opus", "effort": "max"]], "brainstorm": ["anthropic": ["model": "sonnet", "effort": "high"]]])
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent(ModelDefaults.modelsFile), encoding: .utf8), before)
    }

    func testOldShapeSaves() throws {
        let root = tempDir("settings")
        var old = ModelDefaults.models.removing("brainstorm")
        old = ModelDefaults.at(old, ["discover", "providers"]) { $0.setting("openai", ["model": "sol", "effort": "xhigh"]) }
        old = ModelDefaults.at(old, ["providers", "openai"]) { $0.setting("ladder", [["model": "gone", "effort": "high"]]) }
        try writeJSONFile(root.appendingPathComponent(".defaults").appendingPathComponent(ModelDefaults.modelsFile), ModelDefaults.models)
        try writeJSONFile(root.appendingPathComponent(ModelDefaults.modelsFile), old)
        let read = ModelSettings.read(home: root)
        XCTAssertEqual(read.models.brainstorm!.providers["anthropic"], Rung(model: "sonnet", effort: "high"))
        XCTAssertEqual(read.models.discover!.providers["openai"]!["standard"], Rung(model: "sol", effort: "xhigh"))
        XCTAssertEqual(read.models.providers["openai"]!.ladder, DEFAULTS.providers["openai"]!.ladder)
        try ModelSettings.save(home: root, patch: ["brainstorm": ["anthropic": ["model": "opus", "effort": "high"]], "discover": ["openai": ["quick": ["model": "luna", "effort": "medium"]]], "bart": ["openai": ["model": "luna", "effort": "high"]]])
        let now = readFile(root)
        XCTAssertEqual(now["brainstorm"], ["providers": ["anthropic": ["model": "opus", "effort": "high"]]])
        XCTAssertEqual(now["discover"]!["providers"]!["openai"], ["quick": ["model": "luna", "effort": "medium"], "standard": ["model": "sol", "effort": "xhigh"], "deep": ["model": "astra", "effort": "ultra"]])
        XCTAssertEqual(now["providers"]!["openai"]!["ladder"]!.array!.count, 4)
    }

    func testBrokenFile() throws {
        let root = tempDir("settings")
        XCTAssertNil(ModelSettings.read(home: root).fileError)
        let file = root.appendingPathComponent(ModelDefaults.modelsFile)
        try "{ \"provider\": \"openai\", ".write(to: file, atomically: true, encoding: .utf8)
        Choices.remember(home: root, place: "bart", Choice(provider: "anthropic", model: "opus", effort: "high"))
        XCTAssertThrowsError(try ModelSettings.save(home: root, patch: ["provider": "openai"])) { XCTAssertTrue("\($0)".contains("model-effort-inline-question.json is not valid JSON")) }
        XCTAssertNotNil(Choices.read(home: root)["bart"])
        let broken = ModelSettings.read(home: root)
        XCTAssertTrue(broken.fileError!.hasPrefix("model-effort-inline-question.json is not valid JSON, so every agent runs on the built-in defaults"))
        XCTAssertEqual(broken.models, Models.normalize(nil))
        try "[]".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertTrue(ModelSettings.read(home: root).fileError!.contains("is not valid JSON"))
    }

    func testLastActionWins() throws {
        let root = tempDir("settings")
        func run(_ place: String) -> ModelsList { ModelSettings.modelsInForce(home: root, place: place) }
        func build(_ place: String) -> String { let c = Models.buildChoices(run(place)); let s = c.providers[c.provider]!.ladder[0]; return "\(c.provider) \(s.model) \(s.effort)" }
        Choices.remember(home: root, place: "bart", Choice(provider: "openai", model: "astra", effort: "xhigh"))
        XCTAssertEqual(steps(run("bart")), ["Astra xhigh"])
        try ModelSettings.save(home: root, patch: ["bart": ["anthropic": ["model": "opus", "effort": "high"]]])
        XCTAssertEqual(Choices.read(home: root)["bart"], Choice(provider: "openai", model: "astra", effort: "xhigh"))
        try ModelSettings.save(home: root, patch: ["bart": ["openai": ["model": "sol", "effort": "medium"]]])
        XCTAssertNil(Choices.read(home: root)["bart"])
        XCTAssertEqual(steps(run("bart")), ["Opus high", "Fable xhigh"])
        Choices.remember(home: root, place: "bart", Choice(provider: "anthropic", model: "sonnet", effort: "medium"))
        XCTAssertEqual(steps(run("bart")), ["Sonnet medium", "Opus high", "Fable xhigh"])
        try ModelSettings.save(home: root, patch: ["provider": "openai"])
        XCTAssertNil(Choices.read(home: root)["bart"]); XCTAssertEqual(steps(run("bart")), ["Sol medium", "Sol high", "Astra xhigh"])
        Choices.remember(home: root, place: "build", Choice(provider: "anthropic", model: "fable", effort: "max"))
        Choices.remember(home: root, place: "quick", Choice(provider: "anthropic", model: "sonnet", effort: "medium"))
        XCTAssertEqual([build("build"), build("quick")], ["anthropic fable max", "anthropic sonnet medium"])
        try ModelSettings.save(home: root, patch: ["build": ["openai": ["model": "sol", "effort": "high"]]])
        XCTAssertEqual(Set(Choices.read(home: root).keys), ["build", "quick"])
        try ModelSettings.save(home: root, patch: ["build": ["anthropic": ["model": "opus", "effort": "xhigh"]]])
        XCTAssertNil(Choices.read(home: root)["build"]); XCTAssertNil(Choices.read(home: root)["quick"])
        XCTAssertEqual([build("build"), build("quick")], ["anthropic opus xhigh", "anthropic opus xhigh"])
        Choices.remember(home: root, place: "quick", Choice(provider: "openai", model: "luna", effort: "medium"))
        try ModelSettings.save(home: root, patch: ["buildProvider": "openai"])
        XCTAssertNil(Choices.read(home: root)["quick"]); XCTAssertEqual(build("quick"), "openai sol high")
        Choices.remember(home: root, place: "bart", Choice(provider: "anthropic", model: "opus", effort: "max"))
        Choices.remember(home: root, place: "build", Choice(provider: "anthropic", model: "opus", effort: "max"))
        try ModelSettings.save(home: root, patch: ["brainstorm": ["anthropic": ["model": "fable", "effort": "high"]], "discover": ["anthropic": ["standard": ["model": "sonnet", "effort": "high"]]]])
        XCTAssertEqual(Set(Choices.read(home: root).keys), ["bart", "build"])
        XCTAssertEqual([Models.readBrainstorm("", run("bart")).steps[0].name, Question.readDiscover("why", run("bart")).steps[0].name], ["Fable", "Sonnet"])
        let after = try ModelSettings.forget(home: root, place: "bart")
        XCTAssertEqual(after.choices, ["build": Choice(provider: "anthropic", model: "opus", effort: "max")])
        XCTAssertEqual(steps(run("bart")), ["Sol medium", "Sol high", "Astra xhigh"])
        XCTAssertThrowsError(try ModelSettings.forget(home: root, place: "elsewhere")) { XCTAssertTrue("\($0)".contains("place must be one of bart, build, quick")) }
    }

    func testIntelligenceRows() {
        let root = tempDir("intel")
        Choices.remember(home: root, place: "bart", Choice(provider: "openai", model: "astra", effort: "high"))
        let s = ModelSettings.read(home: root)
        XCTAssertEqual(Intelligence.shownProviders(s), ["openai", "anthropic"])
        XCTAssertEqual(Intelligence.lastPick(s, "bart")?.label, "Astra High")
        XCTAssertEqual(Intelligence.followedPick(s)?.label, "Codex")
        XCTAssertEqual(Intelligence.stepLabel(DEFAULTS.providers["anthropic"]!.models, Rung(model: "opus", effort: "xhigh")), "Opus Extra high")
        XCTAssertEqual(Intelligence.patchOf("discover", "openai", Rung(model: "sol", effort: "high"), level: "deep"), ["discover": ["openai": ["deep": ["model": "sol", "effort": "high"]]]])
    }
}
