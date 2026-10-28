import XCTest
@testable import EngelbartDoc

// main/bart/card.cjs as the editor reads it (Doc/Card.swift): a card out of an answer, its question, an answer line and
// how it reads back, recaps and a result's offer.

final class CardTests: XCTestCase {
    static let mcq = #"{"say":"Two ways in.","card":"questions","questions":{"eyebrow":"FOCUS","items":[{"id":"versions","type":"mcq","title":"Which one?","subtitle":"Pick one","options":[{"label":"Alpha","why":"first"},{"label":"Beta"}]}]},"map":{"settled":[{"text":"a known","from":"you"}],"open":[],"untouched":[]}}"#

    func testCardOfAnswer() {
        let card = Card.cardOfAnswer("```json\n\(CardTests.mcq)\n```")
        XCTAssertNotNil(card)
        let q = Card.questionOf(card)!
        XCTAssertEqual(q.type, "mcq")
        XCTAssertEqual(q.title, "Which one?")
        XCTAssertEqual(q.labels, ["Alpha", "Beta"])
        XCTAssertEqual(q.eyebrow, "FOCUS")
        XCTAssertEqual(card?["say"]?.string, "Two ways in.")
        XCTAssertTrue(Card.mapHolds(card?["map"]))
        XCTAssertNil(Card.cardOfAnswer("Some prose answer."), "prose is no card")
        XCTAssertNil(Card.cardOfAnswer("```json\n{\"card\":\"none\",\"say\":\"done\"}\n```"), "a card that asks nothing is none")
        XCTAssertNil(Card.cardOfAnswer("```json\n{\"card\":\"questions\",\"questions\":{\"items\":[{\"type\":\"mcq\",\"title\":\"x\",\"options\":[{\"label\":\"only\"}]}]}}\n```"), "a choice needs two rows")
        XCTAssertEqual(Card.cardAsText(card), "Two ways in.\nWhich one?\n- Alpha\n- Beta")
    }

    func testFocusCard() {
        let card = Card.readCard(#"Here: {"card":"focus","focus":{"options":[{"label":"One"},{"label":"Two"}]}} after"#)
        let q = Card.questionOf(card)!
        XCTAssertEqual(q.type, "focus")
        XCTAssertEqual(q.title, "What should we focus on?", "an untitled focus card's question")
        XCTAssertTrue(Card.isChoice(q.type))
    }

    func testAnswerLineReadsBack() {
        let card = Card.cardOfAnswer("```json\n\(CardTests.mcq)\n```")
        XCTAssertEqual(Card.answerLine(card, picks: ["Beta", "Nope"]), "picked \"Beta\"", "only the card's own rows")
        XCTAssertEqual(Card.answerLine(card, picks: ["Alpha"], note: " more  words "), "picked \"Alpha\"; note: more words")
        XCTAssertEqual(Card.answerLine(card, picks: []), Card.skipped, "nothing given is Skip")
        XCTAssertEqual(Card.answerLine(card, picks: [], note: "my own"), "my own", "a choice answered in words")
        let a = Card.readAnswer("picked \"Alpha\", \"Beta\"; note: why not", card)
        XCTAssertEqual(a.picks, ["Alpha", "Beta"]); XCTAssertEqual(a.note, "why not"); XCTAssertFalse(a.skipped)
        XCTAssertEqual(Card.readAnswer("beta", card).picks, ["Beta"], "a row named in words is a pick")
        XCTAssertTrue(Card.readAnswer(Card.skipped, card).skipped)
        let w = Card.readAnswer(Card.withWrap("picked \"Alpha\""), card)
        XCTAssertTrue(w.wrap); XCTAssertEqual(w.picks, ["Alpha"])
        XCTAssertEqual(Card.withWrap(Card.skipped), Card.wrap)
        XCTAssertTrue(Card.readAnswer(Card.wrap, card).wrap)
    }

    func testRecapAndResult() {
        XCTAssertEqual(Card.recapLine("What you know: a lot")?.label, "What you know")
        XCTAssertEqual(Card.recapLine("what’s unclear： the end")?.label, "What's unclear", "curly apostrophe, full-width colon, any case")
        XCTAssertNil(Card.recapLine("Nothing here: x"))
        let result = Card.resultText("  A  sentence. ")
        XCTAssertEqual(result, "A sentence.\n\(Card.resultOffer)")
        XCTAssertEqual(Card.resultParts(result), "A sentence.")
        XCTAssertEqual(Card.resultParts("Old one.\n\(Card.oldResultOffer)"), "Old one.", "the offer before @chat was renamed")
        XCTAssertNil(Card.resultParts(Card.resultOffer))
        XCTAssertEqual(Card.resultText(""), Card.leftOpen)
    }
}
