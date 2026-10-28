import XCTest
import CoreGraphics
import EngelbartCore
@testable import EngelbartDoc

// test/route.test.cjs (the renderer's route.js parts), and the untested corners of the shared models.

final class RouteTests: XCTestCase {
    func testQuestionLine() {
        XCTAssertEqual(Route.questionLine("@bart --opus why does **@[Plan](lib:x)** fail with [this](https://x.y)?\nsecond line"), "why does Plan fail with this?")
        XCTAssertEqual(Route.questionLine("## A heading"), "A heading")
        let long = String(repeating: "word ", count: 40)
        let cut = Route.questionLine(long)
        XCTAssertLessThanOrEqual(cut.len, 80)
        XCTAssertFalse(cut.hasSuffix(" "))
    }

    func testRouteByRule() {
        XCTAssertEqual(Route.routeByRule("  ")?.agent, "brainstorm")
        XCTAssertEqual(Route.routeByRule("--build add tests")?.agent, "build")
        XCTAssertEqual(Route.routeByRule("agents --deep")?.agent, "discover")
        XCTAssertEqual(Route.routeByRule("why", asking: true)?.rule, "answering Discover")
        XCTAssertNil(Route.routeByRule("--sonnet --medium what is it"), "a model flag settles nothing")
        XCTAssertEqual(Route.fallbackAgent("discover"), "chat")
        XCTAssertEqual(Route.fallbackAgent("brainstorm"), "brainstorm")
        XCTAssertEqual(Route.fallbackAgent(nil), "chat")
    }

    func testRouteInputs() {
        let doc = ["# Plan", "intro", "@chat spec?", "bart> here", "bart> ```", "bart> build this", "bart> ```", "bart> *Chat · S · high · 1 s*", "@bart do it"]
        let r = Route.routeInputs(doc, 8)
        XCTAssertEqual(r.spec, "build this")
        XCTAssertTrue(r.specAbove)
        XCTAssertEqual(r.specTitle, "build this")
        XCTAssertEqual(r.current, "chat", "directly under the conversation's last answer")
        XCTAssertEqual(r.threads.map { $0.question }, ["spec?"])
        XCTAssertTrue(r.section.hasPrefix("# Plan"))
        let asking = Route.routeInputs(["@discover agents", "bart> What do you mean?", "bart> *Discover · O · high · 2 s*", "@bart loops"], 3)
        XCTAssertTrue(asking.asking, "Discover still settling what to research")
        XCTAssertEqual(Route.buildTextOf(doc, Doc.threads(doc)[0].turns[0]), "build this")
    }

    func testShadedCardAndMarks() {
        let pane = CGRect(x: 0, y: 0, width: 800, height: 600)
        let at = SelectionCard.shadedPlace(line: CGRect(x: 120, y: 300, width: 200, height: 16), all: nil, pane: pane, size: CGSize(width: 340, height: 60))
        XCTAssertEqual(at, CGRect(x: 96, y: 306, width: 388, height: 108), "the card's place less the shadow's room, the view that room bigger")
        let entry = MarkAnswers.askEntry(id: "a1", question: " why? ", lines: ["bart> because", "bart> *Sol · high · 2 s*"], provider: "openai", name: "Sol", effort: "high", ms: 2000, at: "2026-10-28T00:00:00.000Z", crop: "crops/x1.png")
        XCTAssertEqual(entry["answer"]?.string, "because")
        XCTAssertEqual(entry["meta"]?["foot"]?.string, "Sol · high · 2 s")
        XCTAssertEqual(entry["crop"]?.string, "crops/x1.png")
        let marks: JSONValue = ["3": [["id": "m1", "asks": []]]]
        let added = MarkAnswers.withAsk(marks, page: "3", markId: "m1", entry: entry)
        XCTAssertEqual(added["3"]?[0]?["asks"]?.array?.count, 1)
        XCTAssertEqual(MarkAnswers.withAsk(added, page: "3", markId: "m1", entry: entry), added, "once")
        XCTAssertTrue(AddressKey.isPreviewAddress("http://localhost:3000/x"))
        XCTAssertTrue(AddressKey.isPreviewAddress("https://3000-abc.e2b.app"))
        XCTAssertFalse(AddressKey.isPreviewAddress("https://example.org"))
        XCTAssertEqual(AddressKey.addressKey("https://www.Example.org/a/?utm_source=x&id=2#frag"), "example.org/a?id=2")
    }
}
