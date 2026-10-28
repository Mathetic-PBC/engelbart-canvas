import XCTest
@testable import EngelbartDoc

// test/bart.test.cjs (the flag parts) and test/discover-levels.test.cjs (question.cjs), ported.

final class QuestionTests: XCTestCase {
    let DEFAULTS = QuestionModels.defaults
    var MODELS: QuestionModels { var m = DEFAULTS; m.provider = "openai"; return m }
    var CLAUDE_ONLY: QuestionModels { var m = DEFAULTS; m.providers = m.providers.filter { $0.key == "anthropic" }; return m }

    func ladder(_ text: String, _ models: QuestionModels? = nil) -> [String] { Question.readQuestion(text, models ?? MODELS).steps.map { "\($0.name) \($0.effort)" } }

    func testLadders() {
        XCTAssertEqual(ladder("why?"), ["Sol medium", "Sol high", "Astra xhigh"])
        var a = MODELS; a.provider = "anthropic"
        XCTAssertEqual(Question.readQuestion("why?", a).steps.map { "\($0.model) \($0.effort)" }, ["claude-sonnet-5-5 high", "opus high", "fable xhigh"])
        XCTAssertFalse(Question.readQuestion("why?", MODELS).pinned)
        XCTAssertEqual(ladder("why?", DEFAULTS), ["Sonnet high", "Opus high", "Fable xhigh"])
    }

    func testFlags() {
        for (text, question, step) in [
            ("--fable why", "why", "Fable xhigh"), ("--Opus --Extra-High prove it", "prove it", "Opus xhigh"), ("--extra high how", "how", "Astra xhigh"),
            ("why --sonnet", "why", "Sonnet high"), ("--high hm", "hm", "Sol high"), ("--fable5.1 --XHIGH q", "q", "Fable xhigh"),
            ("--gpt-6-sol --med q", "q", "Sol medium"), ("--claude-opus-5-5 q --max", "q", "Opus max"), ("--sol --ultra q", "q", "Sol ultra"),
            ("--astra --max q", "q", "Astra ultra"), ("--opus --ultra q", "q", "Opus max"), ("--luna --low q", "q", "Luna low"), ("--haiku --low q", "q", "Haiku low"),
        ] {
            let r = Question.readQuestion(text, MODELS)
            XCTAssertEqual(r.question, question, text); XCTAssertTrue(r.pinned, text)
            XCTAssertEqual(r.steps.map { "\($0.name) \($0.effort)" }, [step], text)
        }
        var withoutLow = MODELS
        withoutLow.providers[0].efforts = ["medium", "high", "xhigh", "ultra"]
        XCTAssertEqual(Question.readQuestion("--luna --low q", withoutLow).steps.map { "\($0.name) \($0.effort)" }, ["Luna medium"])
        let kept = Question.readQuestion("--nope what does --verbose do", MODELS)
        XCTAssertEqual(kept.question, "--nope what does --verbose do"); XCTAssertFalse(kept.pinned)
        XCTAssertEqual(Question.effortOf(" X-High "), "xhigh")
        XCTAssertEqual(Question.modelOf("Fable 5.1", MODELS), .init(provider: "anthropic", model: "fable"))
        XCTAssertNil(Question.modelOf("gemini", MODELS))
    }

    func testSpansAndChoice() {
        func at(_ text: String) -> [String] { Question.readFlags(text, MODELS).spans.map { text.slice($0[0], $0[1]) } }
        XCTAssertEqual(at("--Opus  --Extra-High prove --it"), ["--Opus", "--Extra-High"])
        XCTAssertEqual(at("--extra high how --sonnet"), ["--extra", "high", "--sonnet"])
        XCTAssertEqual(at("--nope what does --verbose do"), [])
        XCTAssertEqual(at("why --gemini --high"), ["--high"])
        XCTAssertEqual(Question.withChoice("--fable why --max", MODELS, model: "luna", effort: "medium"), "--luna --medium why")
        XCTAssertEqual(Question.withChoice("", MODELS, model: "opus", effort: "high"), "--opus --high")
        let r = Question.readQuestion(Question.withChoice("why", MODELS, model: "opus", effort: "xhigh"), MODELS)
        XCTAssertEqual([r.question, "\(r.pinned)", r.provider], ["why", "true", "anthropic"])
        XCTAssertEqual(r.steps.map { "\($0.name) \($0.effort)" }, ["Opus xhigh"])
    }

    func testBuildFlag() {
        func b(_ t: String) -> [String] { let r = Question.readBuildFlag(t, MODELS); return ["\(r.build)", r.rest] }
        XCTAssertEqual(b("--build add a hello comment to README"), ["true", "add a hello comment to README"])
        XCTAssertEqual(b("add a hello --Build comment"), ["true", "add a hello comment"])
        XCTAssertEqual(b("what does --builder do"), ["false", "what does --builder do"])
        XCTAssertEqual(b("--opus --high --build implement @[Some Note]"), ["true", "implement @[Some Note]"])
        XCTAssertEqual(b("--build"), ["true", ""])
        XCTAssertEqual(Question.buildRequestOf(agent: "bart", text: "--build add tests", MODELS), "add tests")
        XCTAssertEqual(Question.buildRequestOf(agent: nil, text: "--build add tests", MODELS), "add tests")
        XCTAssertNil(Question.buildRequestOf(agent: "bart", text: "why is it slow?", MODELS))
        for agent in ["discover", "brainstorm"] { XCTAssertNil(Question.buildRequestOf(agent: agent, text: "--build a parser", MODELS)) }
    }

    func testWithMode() {
        let D = DEFAULTS
        XCTAssertEqual(Question.withMode("how people read", "quick", D), "how people read --quick")
        XCTAssertEqual(Question.withMode("how people read", "standard", D), "how people read")
        XCTAssertEqual(Question.withMode("how people read", "deep", D), "how people read --deep")
        XCTAssertEqual(Question.withMode("--quick how people read", "deep", D), "how people read --deep")
        XCTAssertEqual(Question.withMode("how --deep people read --quick", "standard", D), "how people read")
        XCTAssertEqual(Question.withMode("--opus --high how people read", "deep", D), "how people read --deep")
        XCTAssertEqual(Question.withMode("how people read --high --deep --opus", "quick", D), "how people read --quick")
        XCTAssertEqual(Question.withMode("", "deep", D), "--deep")
        XCTAssertEqual(Question.withMode("", "standard", D), "")
        XCTAssertEqual(Question.withMode("--sonnet", "quick", D), "--quick")
        XCTAssertEqual(Question.withMode("more like these", "standard", D, plainMode: "deep"), "more like these --standard")
        XCTAssertEqual(Question.withMode("more like these", "deep", D, plainMode: "deep"), "more like these")
        XCTAssertEqual(Question.readDiscover(Question.withMode("--opus why", "deep", D), D).steps.map { "\($0.name) \($0.effort)" }, ["Opus max"])
        XCTAssertEqual(Question.withMode("how people read", "deep", D, plainProvider: "anthropic", provider: "openai"), "how people read --codex --deep")
        XCTAssertEqual(Question.withMode("how people read", "standard", D, plainProvider: "anthropic", provider: "openai"), "how people read --codex")
        XCTAssertEqual(Question.withMode("how people read --codex --deep", "standard", D, plainProvider: "anthropic", provider: "anthropic"), "how people read")
        XCTAssertEqual(Question.withMode("--chatgpt how people read --opus", "quick", D, plainProvider: "anthropic", provider: "openai"), "how people read --codex --quick")
        XCTAssertEqual(Question.withMode("how --claude people read", "deep", D, plainProvider: "anthropic"), "how people read --deep")
        XCTAssertEqual(Question.withMode("how people read", "deep", MODELS, provider: "anthropic"), "how people read --claude --deep")
        XCTAssertEqual(Question.withMode("more like these", "standard", D, plainProvider: "openai", provider: "anthropic"), "more like these --claude")
        XCTAssertEqual(Question.withMode("more like these --claude", "standard", D, plainProvider: "openai", provider: "openai"), "more like these")
        XCTAssertEqual(Question.withMode("why", "standard", CLAUDE_ONLY, plainProvider: "anthropic", provider: "openai"), "why")
        XCTAssertEqual(Question.withMode("", "deep", D, plainProvider: "anthropic", provider: "openai"), "--codex --deep")
    }

    func testDiscover() {
        func run(_ text: String, _ models: QuestionModels? = nil, _ earlier: [String] = []) -> [String] {
            let r = Question.readDiscover(text, models ?? DEFAULTS, earlier: earlier)
            return [r.provider, r.mode ?? "", r.question, "\(r.pinned)", r.steps.map { "\($0.name) \($0.effort)" }.joined(separator: ",")]
        }
        XCTAssertEqual(run("why --codex --deep"), ["openai", "deep", "why", "false", "Astra ultra"])
        XCTAssertEqual(run("--chatgpt --quick why"), ["openai", "quick", "why", "false", "Sol medium"])
        XCTAssertEqual(run("why --claude", MODELS), ["anthropic", "standard", "why", "false", "Opus high"])
        XCTAssertEqual(Question.readDiscover("why --codex", DEFAULTS).steps[0].model, "gpt-6-astra")
        XCTAssertEqual(run("picked \"Retries\"", nil, ["agents --codex --deep"]), ["openai", "deep", "picked \"Retries\"", "false", "Astra ultra"])
        XCTAssertEqual(run("more", nil, ["agents --codex", "x --quick"]), ["openai", "quick", "more", "false", "Sol medium"])
        XCTAssertEqual(run("more --claude", nil, ["agents --codex"]), ["anthropic", "standard", "more", "false", "Opus high"])
        XCTAssertEqual(run("more", nil, ["a --claude", "b --codex"])[0], "openai")
        XCTAssertEqual(run("why --codex --deep", CLAUDE_ONLY), ["anthropic", "deep", "why", "false", "Opus max"])
        XCTAssertEqual(run("more", CLAUDE_ONLY, ["agents --codex"])[0], "anthropic")
        XCTAssertEqual(run("--codex --opus why --deep"), ["anthropic", "deep", "why", "true", "Opus high"])
        XCTAssertEqual(run("--codex --high why"), ["openai", "standard", "why", "true", "Sol high"])
        XCTAssertEqual(run("why"), ["anthropic", "standard", "why", "false", "Opus high"])
    }

    func testDiscoverSpans() {
        func at(_ text: String, _ models: QuestionModels?) -> [String] { Question.discoverSpans(text, models).map { text.slice($0[0], $0[1]) } }
        XCTAssertEqual(at("why --deep", DEFAULTS), ["--deep"])
        XCTAssertEqual(at("--quick --opus why --deep", DEFAULTS), ["--quick", "--opus", "--deep"])
        XCTAssertEqual(at("why --high --deep", DEFAULTS), ["--high", "--deep"])
        XCTAssertEqual(at("why --deeper", DEFAULTS), [])
        XCTAssertEqual(at("why --deep", nil), ["--deep"])
        XCTAssertEqual(at("why --codex --deep", DEFAULTS), ["--codex", "--deep"])
        XCTAssertEqual(at("--claude --opus why", DEFAULTS), ["--claude", "--opus"])
        XCTAssertEqual(at("--chatgpt why --high --quick", DEFAULTS), ["--chatgpt", "--high", "--quick"])
        XCTAssertEqual(at("why --codexy", DEFAULTS), [])
        XCTAssertEqual(at("why --codex", nil), ["--codex"])
    }

    func testModelsFromJSON() throws {
        let json = try JSONValueParse(#"{"provider":"openai","providers":{"anthropic":{"name":"Claude Code","models":{"opus":{"id":"opus","name":"Opus"},"sonnet":{"id":"claude-sonnet-5-5","name":"Sonnet"}},"efforts":["medium","high"],"ladder":[{"model":"sonnet","effort":"high"}]},"openai":{"models":{"sol":{"id":"gpt-6.1-sol","name":"Sol"}},"efforts":["medium"],"ladder":[{"model":"sol","effort":"medium"}]}}}"#)
        let m = QuestionModels(json: json)!
        XCTAssertEqual(m.providers.map { $0.key }, ["openai", "anthropic"])
        XCTAssertEqual(m.entry("anthropic")!.models.map { $0.key }, ["sonnet", "opus"], "cheapest first, as the shipped order")
        XCTAssertEqual(m.provider, "openai")
    }
}

import EngelbartCore
func JSONValueParse(_ s: String) throws -> JSONValue { try JSONValue.parse(s) }
