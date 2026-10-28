import EngelbartDoc
import XCTest
@testable import EngelbartBart

// Ported from test/bart.test.cjs (models, flags, choices, carried defaults), test/discover-levels.test.cjs and
// test/settings.test.cjs.

func tempDir(_ name: String = "bart") -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-\(name)-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

let DEFAULTS = Models.normalize(nil)
// Most tests were written while Codex was the default provider; they keep Codex as it (bart.test.cjs MODELS).
let MODELS: ModelsList = { var m = DEFAULTS; m.provider = "openai"; return m }()

func ladder(_ text: String, _ models: ModelsList = MODELS) -> [String] { Question.readQuestion(text, models).steps.map { "\($0.name) \($0.effort)" } }

final class ModelsTests: XCTestCase {
    func testLadders() {
        XCTAssertEqual(ladder("why?"), ["Sol medium", "Sol high", "Astra xhigh"])
        var anthropic = MODELS; anthropic.provider = "anthropic"
        XCTAssertEqual(Question.readQuestion("why?", anthropic).steps.map { "\($0.model) \($0.effort)" }, ["claude-sonnet-5-5 high", "opus high", "fable xhigh"])
        XCTAssertFalse(Question.readQuestion("why?", MODELS).pinned)
        XCTAssertEqual(ladder("why?", DEFAULTS), ["Sonnet high", "Opus high", "Fable xhigh"])
        XCTAssertEqual([DEFAULTS.providers["openai"]!.models["sol"]!.id, DEFAULTS.providers["openai"]!.models["luna"]!.id, DEFAULTS.providers["anthropic"]!.models["sonnet"]!.id], ["gpt-6.1-sol", "gpt-6-luna", "claude-sonnet-5-5"])
        XCTAssertEqual(DEFAULTS.providers["anthropic"]!.models.keys, ["haiku", "sonnet", "opus", "fable"], "Haiku first: it ranks lowest")
    }

    func testFlagsLoose() {
        let cases: [(String, String, String)] = [
            ("--fable why", "why", "Fable xhigh"), ("--Opus --Extra-High prove it", "prove it", "Opus xhigh"), ("--extra high how", "how", "Astra xhigh"),
            ("why --sonnet", "why", "Sonnet high"), ("--high hm", "hm", "Sol high"), ("--fable5.1 --XHIGH q", "q", "Fable xhigh"),
            ("--gpt-6-sol --med q", "q", "Sol medium"), ("--claude-opus-5-5 q --max", "q", "Opus max"), ("--sol --ultra q", "q", "Sol ultra"),
            ("--astra --max q", "q", "Astra ultra"), ("--opus --ultra q", "q", "Opus max"), ("--luna --low q", "q", "Luna low"), ("--haiku --low q", "q", "Haiku low"),
        ]
        for (text, question, step) in cases {
            let read = Question.readQuestion(text, MODELS)
            XCTAssertEqual(read.question, question, text)
            XCTAssertTrue(read.pinned, text)
            XCTAssertEqual(read.steps.map { "\($0.name) \($0.effort)" }, [step], text)
        }
        var withoutLow = MODELS
        withoutLow.providers["openai"]!.efforts = ["medium", "high", "xhigh", "ultra"]
        XCTAssertEqual(Question.readQuestion("--luna --low q", withoutLow).steps.map { "\($0.name) \($0.effort)" }, ["Luna medium"])
        let kept = Question.readQuestion("--nope what does --verbose do", MODELS)
        XCTAssertEqual(kept.question, "--nope what does --verbose do"); XCTAssertFalse(kept.pinned)
        XCTAssertEqual(Question.effortOf(" X-High "), "xhigh")
        XCTAssertEqual(Question.modelOf("Fable 5.1", MODELS), ModelPick(provider: "anthropic", model: "fable"))
        XCTAssertNil(Question.modelOf("gemini", MODELS))
    }

    func testFlagSpansAndChoice() {
        func at(_ text: String) -> [String] { Question.readFlags(text, MODELS).spans.map { text.jsSlice($0[0], $0[1]) } }
        XCTAssertEqual(at("--Opus  --Extra-High prove --it"), ["--Opus", "--Extra-High"])
        XCTAssertEqual(at("--extra high how --sonnet"), ["--extra", "high", "--sonnet"])
        XCTAssertEqual(at("--nope what does --verbose do"), [])
        XCTAssertEqual(at("why --gemini --high"), ["--high"])
        XCTAssertEqual(Question.withChoice("--fable why --max", MODELS, model: "luna", effort: "medium"), "--luna --medium why")
        XCTAssertEqual(Question.withChoice("", MODELS, model: "opus", effort: "high"), "--opus --high")
        let read = Question.readQuestion(Question.withChoice("why", MODELS, model: "opus", effort: "xhigh"), MODELS)
        XCTAssertEqual([read.question, read.provider] + read.steps.map { "\($0.name) \($0.effort)" }, ["why", "anthropic", "Opus xhigh"])
    }

    func testBuildFlag() {
        XCTAssertTrue(Question.readBuildFlag("--build add a hello comment to README", MODELS) == (true, "add a hello comment to README"))
        XCTAssertTrue(Question.readBuildFlag("add a hello --Build comment", MODELS) == (true, "add a hello comment"))
        XCTAssertTrue(Question.readBuildFlag("what does --builder do", MODELS) == (false, "what does --builder do"))
        XCTAssertTrue(Question.readBuildFlag("--opus --high --build implement @[Some Note]", MODELS) == (true, "implement @[Some Note]"))
        XCTAssertTrue(Question.readBuildFlag("--build", MODELS) == (true, ""))
        XCTAssertEqual(Question.buildRequestOf(agent: "bart", text: "--build add tests", MODELS), "add tests")
        XCTAssertEqual(Question.buildRequestOf(agent: nil, text: "--build add tests", MODELS), "add tests")
        XCTAssertNil(Question.buildRequestOf(agent: "bart", text: "why is it slow?", MODELS))
        for agent in ["discover", "brainstorm"] { XCTAssertNil(Question.buildRequestOf(agent: agent, text: "--build a parser", MODELS)) }
    }

    func testOnlyProviders() {
        let claude = InForce.onlyProviders(MODELS, ["anthropic"])
        XCTAssertEqual(claude.providers.keys, ["anthropic"]); XCTAssertEqual(claude.provider, "anthropic")
        XCTAssertEqual(ladder("why?", claude), ["Sonnet high", "Opus high", "Fable xhigh"])
        let kept = Question.readQuestion("--sol why?", claude)
        XCTAssertEqual(kept.question, "--sol why?"); XCTAssertFalse(kept.pinned)
        XCTAssertEqual(InForce.onlyProviders(MODELS, ["openai", "anthropic"]).provider, "openai")
        XCTAssertEqual(InForce.onlyProviders(MODELS, []).providers.keys, ["openai", "anthropic"])
        XCTAssertEqual(Models.load(home: tempDir(), only: ["openai"]).providers.keys, ["openai"])
    }

    func testPreferUsable() {
        func start(_ usable: [String]?, _ models: ModelsList = MODELS) -> String { Question.readQuestion("why?", InForce.preferUsable(models, usable)).steps[0].name }
        XCTAssertEqual(start(nil), "Sol"); XCTAssertEqual(start(["codex", "claude"]), "Sol"); XCTAssertEqual(start(["claude"]), "Sonnet")
        XCTAssertEqual(start(["codex"]), "Sol"); XCTAssertEqual(start([]), "Sol")
        var a = MODELS; a.provider = "anthropic"
        XCTAssertEqual(start(["codex"], a), "Sol")
        let picked = Question.readQuestion("--opus why?", InForce.preferUsable(MODELS, ["codex"]))
        XCTAssertEqual(picked.provider, "anthropic"); XCTAssertTrue(picked.pinned)
        XCTAssertEqual(InForce.preferUsable(InForce.onlyProviders(MODELS, ["openai"]), ["claude"]).provider, "openai")
        XCTAssertEqual(start(["codex", "claude"], DEFAULTS), "Sonnet"); XCTAssertEqual(start(["codex"], DEFAULTS), "Sol")
    }

    func testBuildOpening() {
        func opening(_ usable: [String]?, _ models: ModelsList = DEFAULTS) -> String {
            let c = Models.buildChoices(InForce.preferUsable(models, usable)); let s = c.providers[c.provider]!.ladder[0]
            return "\(c.provider) \(s.model) \(s.effort)"
        }
        XCTAssertEqual(opening(nil), "anthropic opus high")
        XCTAssertEqual(opening(["codex", "claude"]), "anthropic opus high")
        XCTAssertEqual(opening(["codex"]), "openai sol high")
        var o = DEFAULTS; o.provider = "openai"
        XCTAssertEqual(opening(["claude"], o), "anthropic opus high")
        let r = Models.resolveBuildChoice(DEFAULTS, provider: "nope", model: "x", effort: "y")
        XCTAssertEqual([r.provider, r.model, r.modelId, r.effort], ["anthropic", "opus", "opus", "high"])
    }

    func testChoices() throws {
        let root = tempDir("choices")
        XCTAssertEqual(Choices.read(home: root), [:])
        XCTAssertEqual(Choices.remember(home: root, place: "bart", Choice(provider: "anthropic", model: "opus", effort: "high")), Choice(provider: "anthropic", model: "opus", effort: "high"))
        Choices.remember(home: root, place: "build", Choice(provider: "openai", model: "astra", effort: "xhigh"))
        XCTAssertNil(Choices.remember(home: root, place: "quick", Choice(provider: "openai", model: "rm -rf", effort: "high")))
        XCTAssertNil(Choices.remember(home: root, place: "elsewhere", Choice(provider: "openai", model: "sol", effort: "high")))
        let held = Choices.read(home: root)
        XCTAssertEqual(held, ["bart": Choice(provider: "anthropic", model: "opus", effort: "high"), "build": Choice(provider: "openai", model: "astra", effort: "xhigh")])
        let file = OJ.read(root.appendingPathComponent(Choices.file))!
        XCTAssertGreaterThan(file["about"]!.string!.count, 50)
        XCTAssertEqual(file.keys, ["about", "bart", "build"])
        XCTAssertEqual(ladder("why?", InForce.startingAt(DEFAULTS, "bart", held["bart"])), ["Opus high", "Fable xhigh"])
        XCTAssertEqual(ladder("why?", InForce.startingAt(DEFAULTS, "bart", Choice(provider: "anthropic", model: "sonnet", effort: "medium"))), ["Sonnet medium", "Sonnet high", "Opus high", "Fable xhigh"])
        XCTAssertEqual(ladder("why?", InForce.startingAt(DEFAULTS, "bart", Choice(provider: "openai", model: "luna", effort: "high"))), ["Luna high", "Sol medium", "Sol high", "Astra xhigh"])
        XCTAssertEqual(ladder("--sonnet why?", InForce.startingAt(DEFAULTS, "bart", held["bart"])), ["Sonnet high"])
        XCTAssertEqual(ladder("--max why?", InForce.startingAt(DEFAULTS, "bart", held["bart"])), ["Opus max"])
        XCTAssertEqual(ladder("why?", InForce.preferUsable(InForce.startingAt(DEFAULTS, "bart", held["bart"]), ["codex"])), ["Sol medium", "Sol high", "Astra xhigh"])
        XCTAssertEqual(ladder("why?", InForce.startingAt(DEFAULTS, "bart", Choice(provider: "anthropic", model: "gone", effort: "high"))), ["Sonnet high", "Opus high", "Fable xhigh"])
        let build = Models.buildChoices(InForce.startingAt(DEFAULTS, "build", held["build"]))
        XCTAssertEqual(build.provider, "openai"); XCTAssertEqual(build.providers["openai"]!.ladder, [Rung(model: "astra", effort: "xhigh")])
        XCTAssertEqual(Models.buildChoices(InForce.startingAt(DEFAULTS, "quick", held["quick"])).providers["anthropic"]!.ladder, [Rung(model: "opus", effort: "high")])
        XCTAssertEqual(Models.buildChoices(InForce.preferUsable(InForce.startingAt(DEFAULTS, "build", held["build"]), ["claude"])).provider, "anthropic")
        XCTAssertTrue(Choices.forget(home: root, place: "bart"))
        XCTAssertFalse(Choices.forget(home: root, place: "bart"))
        // A new place goes last ({ about, ...now, [place]: pick }).
        Choices.remember(home: root, place: "bart", Choice(provider: "openai", model: "sol", effort: "high"))
        XCTAssertEqual(OJ.read(root.appendingPathComponent(Choices.file))!.keys, ["about", "build", "bart"])
    }

    func testModelsFileWrittenEditedBroken() throws {
        let root = tempDir("models")
        XCTAssertEqual(Models.load(home: root), Models.normalize(ModelDefaults.models))
        let file = root.appendingPathComponent(ModelDefaults.modelsFile)
        let written = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(written, ModelDefaults.models.stringify(indent: 2) + "\n")
        XCTAssertTrue(written.hasPrefix("{\n  \"about\": \"Models and efforts for @bart"))
        try #"{"provider":"anthropic","providers":{"anthropic":{"models":{"opus":{"id":"opus"},"bad":{"id":"rm -rf $HOME"}},"ladder":[{"model":"opus","effort":"Extra High"},{"model":"gone","effort":"high"}]}}}"#.write(to: file, atomically: true, encoding: .utf8)
        let edited = Models.load(home: root)
        XCTAssertEqual(edited.provider, "anthropic")
        XCTAssertEqual(edited.providers["anthropic"]!.models.keys, ["opus"])
        XCTAssertEqual(edited.providers["anthropic"]!.ladder, [Rung(model: "opus", effort: "xhigh")])
        XCTAssertEqual(edited.providers["openai"]!.ladder, DEFAULTS.providers["openai"]!.ladder)
        try "{ not json".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(Models.load(home: root).provider, "anthropic")
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{ not json")
    }

    func testDefaultsCarried() throws {
        let root = tempDir("carry")
        let file = root.appendingPathComponent(ModelDefaults.modelsFile)
        _ = Models.load(home: root)
        var given = ModelDefaults.models.setting("provider", "openai")
        given = ModelDefaults.at(given, ["providers", "openai"]) { $0.setting("ladder", [["model": "luna", "effort": "medium"]]) }
        try writeJSONFile(CarryDefaults.baseFile(for: file), given)
        let theirs = ModelDefaults.at(given, ["providers", "anthropic"]) { $0.setting("ladder", [["model": "opus", "effort": "high"]]) }
        try writeJSONFile(file, theirs)
        let loaded = Models.load(home: root)
        XCTAssertEqual(loaded.provider, "anthropic")
        XCTAssertEqual(loaded.providers["openai"]!.ladder, DEFAULTS.providers["openai"]!.ladder)
        XCTAssertEqual(loaded.providers["anthropic"]!.ladder, [Rung(model: "opus", effort: "high")])
        XCTAssertEqual(OJ.read(CarryDefaults.baseFile(for: file)), ModelDefaults.models)
    }

    func testLegacyFileBackedUp() throws {
        let root = tempDir("legacy")
        let file = root.appendingPathComponent(ModelDefaults.modelsFile)
        var legacy = ModelDefaults.past[0]
        legacy = ModelDefaults.at(legacy, ["providers", "openai"]) { $0.setting("efforts", ModelDefaults.models["providers"]!["openai"]!["efforts"]!) }
        legacy = ModelDefaults.at(legacy, ["providers", "anthropic"]) { $0.setting("efforts", ModelDefaults.models["providers"]!["anthropic"]!["efforts"]!) }
        legacy = ModelDefaults.at(legacy, ["providers", "anthropic", "models", "sonnet"]) { $0.setting("use", "My own words.") }
        try writeJSONFile(file, legacy)
        _ = Models.load(home: root)
        let now = OJ.read(file)!
        XCTAssertEqual(now["about"], ModelDefaults.models["about"])
        XCTAssertEqual(now["providers"]!["openai"]!["efforts"], ["low", "medium", "high", "xhigh", "ultra"])
        XCTAssertEqual(now["providers"]!["anthropic"]!["models"]!["sonnet"]!["use"], "My own words.")
        let copies = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".backups").path)
        XCTAssertEqual(copies.count, 1)
        XCTAssertTrue(copies[0].hasPrefix("model-effort-inline-question-"))
        XCTAssertEqual(OJ.read(root.appendingPathComponent(".backups").appendingPathComponent(copies[0]))!["about"], ModelDefaults.past[0]["about"])
    }

    func testOld56ModelsMove() throws {
        let root = tempDir("upgrade")
        let old = ModelDefaults.at(ModelDefaults.past[2], ["providers", "openai", "models", "astra"]) { $0.setting("use", "My own words.") }
        try writeJSONFile(root.appendingPathComponent(ModelDefaults.modelsFile), old)
        let m = Models.load(home: root)
        XCTAssertEqual(m.providers["openai"]!.models["sol"]!.id, "gpt-6.1-sol")
        XCTAssertEqual(m.providers["openai"]!.models["luna"]!.id, "gpt-6-luna")
        XCTAssertEqual(m.providers["openai"]!.models["astra"]!.use, "My own words.")
    }

    func testFile0927Moves() throws {
        for withBase in [true, false] {
            let root = tempDir("0929")
            let shipped = ModelDefaults.past[3]
            let mine = ModelDefaults.at(shipped, ["providers", "openai"]) { $0.setting("ladder", [["model": "luna", "effort": "high"]]) }
            try writeJSONFile(root.appendingPathComponent(ModelDefaults.modelsFile), mine)
            if withBase { try writeJSONFile(root.appendingPathComponent(".defaults").appendingPathComponent(ModelDefaults.modelsFile), shipped) }
            let m = Models.load(home: root)
            XCTAssertEqual([m.provider, m.providers["openai"]!.models["sol"]!.id, m.providers["anthropic"]!.models["sonnet"]!.id], ["anthropic", "gpt-6.1-sol", "claude-sonnet-5-5"])
            XCTAssertEqual(m.providers["anthropic"]!.ladder[0], Rung(model: "sonnet", effort: "high"))
            XCTAssertEqual([m.build!.provider, m.build!.providers["openai"]!.models["sol"]!.id, m.build!.providers["anthropic"]!.models["sonnet"]!.id], ["anthropic", "gpt-6.1-sol", "claude-sonnet-5-5"])
            XCTAssertEqual(m.providers["openai"]!.ladder, [Rung(model: "luna", effort: "high")])
        }
    }

    func testBrainstormStep() {
        func step(_ m: ModelsList) -> String { let r = Models.readBrainstorm("--opus why", m); return "\(r.steps[0].name) \(r.steps[0].effort) \(r.question)" }
        XCTAssertEqual(step(DEFAULTS), "Sonnet high why")
        XCTAssertEqual(step(MODELS), "Sol medium why")
        let n = Models.normalizeBrainstorm(["providers": ["anthropic": ["model": "OPUS", "effort": "Extra High"], "openai": ["model": "gone", "effort": "high"]]], DEFAULTS.providers)
        XCTAssertEqual(n.providers["anthropic"], Rung(model: "opus", effort: "xhigh"))
        XCTAssertEqual(n.providers["openai"], Rung(model: "sol", effort: "medium"))
    }

    func testDiscoverLevels() {
        func lv(_ text: String, _ m: ModelsList = DEFAULTS, _ earlier: [String] = []) -> String {
            let r = Question.readDiscover(text, m, earlier); return "\(r.provider) \(r.steps[0].name) \(r.steps[0].effort) \(r.mode ?? "-") \(r.question)"
        }
        XCTAssertEqual(lv("how do people read"), "anthropic Opus high standard how do people read")
        XCTAssertEqual(lv("--quick how"), "anthropic Sonnet medium quick how")
        XCTAssertEqual(lv("how --deep"), "anthropic Opus max deep how")
        XCTAssertEqual(lv("how --deep", MODELS), "openai Astra ultra deep how")
        XCTAssertEqual(lv("--quick how", MODELS), "openai Sol medium quick how")
        XCTAssertEqual(lv("and then?", DEFAULTS, ["--deep how"]), "anthropic Opus max deep and then?")
        XCTAssertEqual(lv("and then?", DEFAULTS, ["--codex how"]), "openai Astra high standard and then?")
        XCTAssertEqual(lv("--sonnet how --deep"), "anthropic Sonnet high deep how")
        XCTAssertEqual(Question.withMode("how --deep --opus", "quick", DEFAULTS), "how --quick")
        XCTAssertEqual(Question.withMode("how --deep", "standard", DEFAULTS), "how")
        XCTAssertEqual(Question.withMode("how", "deep", DEFAULTS, provider: "openai"), "how --codex --deep")
        let text = "--refine how --deep --codex"
        XCTAssertEqual(Question.discoverSpans(text, DEFAULTS).map { text.jsSlice($0[0], $0[1]) }, ["--refine", "--deep", "--codex"])
    }

    func testDiscoverOneStepShape() throws {
        // A models file left as 2026-09-30 wrote it: the untouched step becomes three levels; one of the person's own is standard.
        let root = tempDir("0930")
        let shipped = ModelDefaults.past[5]
        let mine = ModelDefaults.at(shipped, ["discover", "providers", "anthropic"]) { _ in ["model": "fable", "effort": "high"] }
        try writeJSONFile(root.appendingPathComponent(ModelDefaults.modelsFile), mine)
        let m = Models.load(home: root)
        XCTAssertEqual(m.discover!.providers["anthropic"]!["standard"], Rung(model: "fable", effort: "high"))
        XCTAssertEqual(m.discover!.providers["anthropic"]!["deep"], Rung(model: "opus", effort: "max"))
        XCTAssertEqual(m.discover!.providers["openai"]!["standard"], Rung(model: "astra", effort: "high"))
        let disk = OJ.read(root.appendingPathComponent(ModelDefaults.modelsFile))!
        XCTAssertEqual(disk["discover"]!["providers"]!["anthropic"]!.keys, ["quick", "standard", "deep"], "written in the levels shape (fileShape)")
    }

    func testHaikuAndLow() {
        XCTAssertEqual(ladder("--haiku --low x", DEFAULTS), ["Haiku low"])
        XCTAssertEqual(ladder("why?", InForce.startingAt(DEFAULTS, "bart", Choice(provider: "anthropic", model: "haiku", effort: "low"))), ["Haiku low", "Sonnet high", "Opus high", "Fable xhigh"])
        XCTAssertEqual(DEFAULTS.providers["anthropic"]!.efforts.first, "low")
        XCTAssertEqual(DEFAULTS.providers["openai"]!.efforts.first, "low")
    }
}
