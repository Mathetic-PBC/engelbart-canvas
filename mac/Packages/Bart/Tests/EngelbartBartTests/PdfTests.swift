import EngelbartDoc
import XCTest
import CoreText
import CoreGraphics
@testable import EngelbartBart

// Ported from test/context.test.cjs and test/pdf-kind.test.cjs: a pdf made here, line by line, read back.

func makePdf(_ path: String, pages: [[(text: String, size: CGFloat)]], title: String? = nil) {
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    var info: [CFString: Any] = [:]
    if let title { info[kCGPDFContextTitle] = title }
    let ctx = CGContext(URL(fileURLWithPath: path) as CFURL, mediaBox: &box, info as CFDictionary)!
    for page in pages {
        ctx.beginPDFPage(nil)
        var y: CGFloat = 740
        for (text, size) in page {
            let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
            ctx.textPosition = CGPoint(x: 72, y: y)
            CTLineDraw(line, ctx)
            y -= size * 1.6
        }
        ctx.endPDFPage()
    }
    ctx.closePDF()
}

final class PdfTests: XCTestCase {
    func testAbstractAndPaper() throws {
        let file = tempDir("pdf").appendingPathComponent("paper.pdf").path
        makePdf(file, pages: [[("A Study of Tutors", 18), ("Abstract", 12), ("Tutors help students learn faster in", 10), ("every setting we measured.", 10),
                               ("1 Introduction", 12), ("Body text here.", 10), ("Keywords: tutoring", 10)],
                              [("More body.", 10), ("References", 12), ("[1] Someone. 2020.", 10)]], title: "A Study of Tutors")
        XCTAssertEqual(try PdfText.extractAbstract(file), "Tutors help students learn faster in every setting we measured.")
        let text = try PdfText.extractText(file)
        XCTAssertTrue(text.contains("Body text here.") && text.contains("References"))
        let s = try PdfKind.signals(file)
        XCTAssertTrue(s.abstract && s.keywords && !s.arxiv)
        XCTAssertEqual(try PdfKind.inspect(file), ["paper"])
        XCTAssertEqual(try PdfKind.title(file), "A Study of Tutors")
        XCTAssertEqual(PdfKind.usableTitle("Microsoft Word - draft.docx"), "")
        XCTAssertEqual(PdfKind.usableTitle("Formatting Instructions For NeurIPS 2026"), "")
        let plain = tempDir("pdf").appendingPathComponent("plain.pdf").path
        makePdf(plain, pages: [[("Shopping list", 12), ("Milk", 10)]])
        XCTAssertNil(try PdfText.extractAbstract(plain))
        XCTAssertEqual(try PdfKind.inspect(plain), [])
        XCTAssertThrowsError(try PdfText.extractText(tempDir("pdf").appendingPathComponent("none.pdf").path))
    }

    func testFindAbstractRules() {
        func l(_ t: String, page: Int = 1, y: Double, h: Double = 10, x: Double = 72) -> PdfLine { PdfLine(page: page, x: x, y: y, h: h, text: t) }
        XCTAssertEqual(PdfText.findAbstract([l("Abstract—We show a thing.", y: 700), l("It works.", y: 688), l("1 Introduction", y: 670)]), "We show a thing. It works.")
        XCTAssertEqual(PdfText.findAbstract([l("ABSTRACT", y: 700, h: 12), l("Prin-", y: 688), l("ciples matter.", y: 676), l("Next column", y: 720, x: 320)]), "Principles matter.")
        XCTAssertNil(PdfText.findAbstract([l("No heading", y: 700)]))
    }
}
