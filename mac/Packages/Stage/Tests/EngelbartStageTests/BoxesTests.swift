import XCTest
import EngelbartCore
@testable import EngelbartStage

// test/web-boxes.test.cjs (main's half), test/selection-card.test.cjs, test/browser.test.cjs helpers, ported.

private typealias Item = BrowserRules.BoxReport.Item
private func svgOf(_ css: String) -> String {
    guard let m = SRx(#"url\("data:image\/svg\+xml,([^"]+)"\)"#).match(css), let enc = m[1] else { return "" }
    return enc.removingPercentEncoding ?? ""
}
private func boxMark(_ id: String) -> JSONValue {
    ["id": .string(id), "box": ["x": 0.1, "y": 0.2, "w": 0.5, "h": 0.4, "anchor": ["selector": "#a > img:nth-of-type(1)", "tag": "img", "src": "a.png", "text": ""],
                                "doc": ["x": 10, "y": 20, "w": 30, "h": 40, "width": 1200]], "crop": .string("crops/\(id).png"), "text": "under", "note": .null]
}
private func webMark(_ id: String, _ exact: String) -> JSONValue { ["id": .string(id), "quote": ["exact": .string(exact), "prefix": "", "suffix": ""], "note": .null] }

final class BoxesTests: XCTestCase {
    func testBoxesCssOneRule() {
        XCTAssertEqual(Boxes.boxesCss([]), "")
        let P = Boxes.pad
        XCTAssertTrue(P >= (Boxes.handle / 2).rounded(.up) + 1)
        let css = Boxes.boxesCss([Item(id: "a", x: 100, y: 900, w: 300, h: 200), Item(id: "b", x: 50, y: 1500, w: 100, h: 50)], selected: "b", size: .init(width: 1200, height: 4000))
        XCTAssertTrue(css.hasPrefix("html::after{") && css.hasSuffix("}"))
        let W = 400 - 50 + 2 * P, H = 1550 - 900 + 2 * P
        for part in ["position:absolute !important", "pointer-events:none !important", "z-index:2147483647 !important", "left:\(Int(50 - P))px !important", "top:\(Int(900 - P))px !important", "width:\(Int(W))px !important", "height:\(Int(H))px !important", "content:\"\" !important"] {
            XCTAssertTrue(css.contains(part), part)
        }
        XCTAssertTrue(svgOf(css).hasPrefix("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(Int(W))\" height=\"\(Int(H))\""))
        XCTAssertTrue(Boxes.boxesCss([Item(id: "a", x: 1100, y: 10, w: 100, h: 20)], size: .init(width: 1200, height: 800)).contains("width:\(Int(1200 - (1100 - P)))px"))
        XCTAssertTrue(Boxes.boxesCss([Item(id: "a", x: 0, y: 0, w: 100, h: 20)], selected: "a", size: .init(width: 1200, height: 800)).contains("left:\(Int(-P))px !important;top:\(Int(-P))px"))
    }

    func testBoxesCssLook() {
        let P = Boxes.pad
        let plain = svgOf(Boxes.boxesCss([Item(id: "a", x: 100, y: 200, w: 300, h: 150)]))
        XCTAssertEqual(SRx(#"<rect [^>]*\/>"#).matchAll(plain).map(\.str), [
            "<rect x=\"\(Boxes.fmt(P - 0.5))\" y=\"\(Boxes.fmt(P - 0.5))\" width=\"301\" height=\"151\" fill=\"none\" stroke=\"\(Boxes.halo)\" stroke-width=\"1\"/>",
            "<rect x=\"\(Boxes.fmt(P + 0.5))\" y=\"\(Boxes.fmt(P + 0.5))\" width=\"299\" height=\"149\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1\"/>",
        ])
        let svg = svgOf(Boxes.boxesCss([Item(id: "a", x: 100, y: 200, w: 300, h: 150), Item(id: "b", x: 600, y: 200, w: 40, h: 40)], selected: "a"))
        let rects = SRx(#"<rect [^>]*\/>"#).matchAll(svg).map(\.str)
        XCTAssertEqual(rects.count, 12)
        let handles = rects.filter { $0.contains("fill=\"#fff\"") }
        XCTAssertEqual(handles.count, 8)
        let centres = handles.map { h -> [Double] in let m = SRx(#"x="([\d.-]+)" y="([\d.-]+)""#).match(h)!; return [Double(m[1]!)! + 2, Double(m[2]!)! + 2] }
        XCTAssertEqual(centres, Boxes.handlesOf(x: P, y: P, w: 300, h: 150).map { [$0.x, $0.y] })
        let resizing = svgOf(Boxes.boxesCss([Item(id: "a", x: 100, y: 200, w: 300, h: 150), Item(id: "b", x: 600, y: 200, w: 40, h: 40)], selected: "a", resizing: "a"))
        let shapes = SRx(#"<rect [^>]+>"#).matchAll(resizing).map(\.str)
        XCTAssertEqual(shapes.count, 4)
        XCTAssertTrue(shapes[1].contains("fill=\"\(Boxes.tint)\" stroke=\"#fff\""))
        XCTAssertTrue(shapes[3].contains("fill=\"none\" stroke=\"#fff\""))
    }

    func testReadoutCss() {
        let css = Boxes.readoutCss(x: 100, y: 100, w: 240.4, h: 99.6, viewport: .init(width: 800, height: 600))
        XCTAssertTrue(css.hasPrefix("html::before{"))
        XCTAssertTrue(css.contains("content:\"240\\A 100\" !important"))
        XCTAssertTrue(css.contains("left:110px !important;top:110px !important"))
        XCTAssertTrue(css.contains("transform:scale(1) translate(0,0) !important"))
        let zoomed = Boxes.readoutCss(x: 100, y: 100, w: 200, h: 50, zoom: 1.5, viewport: .init(width: 800, height: 600))
        XCTAssertTrue(zoomed.contains("content:\"300\\A 75\"")); XCTAssertTrue(zoomed.contains("scale(0.6667)"))
        let flipped = Boxes.readoutCss(x: 790, y: 590, w: 10, h: 10, viewport: .init(width: 800, height: 600))
        XCTAssertTrue(flipped.contains("left:780px !important;top:580px")); XCTAssertTrue(flipped.contains("translate(-100%,-100%)"))
        XCTAssertEqual(Boxes.readoutCss(x: .nan, y: 0, w: 1, h: 1), "")
    }

    func testLayerReadouts() {
        XCTAssertEqual(BoxLayerLook.readout(dragging: false, screenX: 812.4, screenY: 301, w: 0, h: 0), ["812", "301"])
        XCTAssertEqual(BoxLayerLook.readout(dragging: true, screenX: 812, screenY: 301, w: 240.6, h: 99.5), ["241", "100"])
        XCTAssertEqual(BoxLayerLook.readout(dragging: true, screenX: 0, screenY: 0, w: 240, h: 100, scale: 2), ["480", "200"])
        let view = CGSize(width: 800, height: 600), size = CGSize(width: 30, height: 26)
        XCTAssertEqual(BoxLayerLook.readoutAt(x: 100, y: 100, size: size, view: view), CGPoint(x: 110, y: 110))
        XCTAssertEqual(BoxLayerLook.readoutAt(x: 790, y: 590, size: size, view: view), CGPoint(x: 750, y: 554))
    }

    func testCardPlace() {
        let page = CGRect(x: 0, y: 40, width: 800, height: 600), size = CGSize(width: 336, height: 120)
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: 90, width: 200, height: 100), page: page, size: size), CGRect(x: 308, y: 90, width: 336, height: 120))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 500, y: 90, width: 200, height: 100), page: page, size: size), CGRect(x: 156, y: 90, width: 336, height: 120))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: 90, width: 650, height: 100), page: page, size: size), CGRect(x: 100, y: 198, width: 336, height: 120))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: 450, width: 650, height: 150), page: page, size: size), CGRect(x: 100, y: 322, width: 336, height: 120))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: 60, width: 650, height: 560), page: page, size: size), CGRect(x: 464, y: 60, width: 336, height: 120))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: 600, width: 100, height: 300), page: page, size: size), CGRect(x: 208, y: 520, width: 336, height: 120))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: -50, width: 100, height: 200), page: page, size: size), CGRect(x: 208, y: 40, width: 336, height: 120))
        XCTAssertNil(Boxes.cardPlace(box: CGRect(x: 100, y: 640, width: 100, height: 100), page: page, size: size))
        XCTAssertNil(Boxes.cardPlace(box: CGRect(x: 100, y: -100, width: 100, height: 140), page: page, size: size))
        XCTAssertEqual(Boxes.cardPlace(box: CGRect(x: 100, y: 100, width: 100, height: 100), page: page, size: CGSize(width: 336, height: 900))?.height, 600)
    }

    func testCropNames() {
        let id = "8a4e"
        XCTAssertEqual(Boxes.nextCropName(["id": .string(id), "crop": .string("crops/\(id).png")]), "crops/\(id)-1.png")
        XCTAssertEqual(Boxes.nextCropName(["id": .string(id), "crop": .string("crops/\(id)-1.png"), "asks": [["crop": .string("crops/\(id).png")], ["crop": .string("crops/\(id)-3.png")]]]), "crops/\(id)-4.png")
        XCTAssertEqual(Boxes.nextCropName(["id": .string(id), "crop": .null]), "crops/\(id)-1.png")
        XCTAssertEqual(Boxes.cropNumber("b1", "crops/b1.png"), 0)
        XCTAssertEqual(Boxes.cropNumber("b1", "crops/b1-12.png"), 12)
        for other in ["crops/b10.png", "crops/b1-x.png", "crops/b1-0.png", "crops/b2-1.png", "../b1-1.png"] { XCTAssertEqual(Boxes.cropNumber("b1", other), -1, other) }
        XCTAssertEqual(Boxes.cropNumber("b1", nil), -1)
        XCTAssertEqual(Boxes.cropsOf(["id": "b1", "crop": "crops/b1-1.png", "asks": [["crop": "crops/b1.png"], ["crop": "crops/b1-1.png"], [:], ["crop": "/etc/x.png"]]]), ["crops/b1-1.png", "crops/b1.png"])
    }

    func testWhatMainTakesFromAPage() {
        let list: [JSONValue] = [webMark("w1", "a passage"), boxMark("b1"), ["id": "b2", "box": ["x": 0, "y": 0, "w": 0, "h": 1, "doc": [:]]], ["id": "b3", "box": "no"], .null]
        let given = BrowserRules.marksForPage(list)
        XCTAssertEqual(given.map { [$0["id"]?.string ?? "", $0["quote"] != nil ? "q" : "", $0["box"] != nil ? "b" : ""] }, [["w1", "q", ""], ["b1", "", "b"]])
        XCTAssertEqual(given[1]["box"], boxMark("b1")["box"])
        XCTAssertTrue(Boxes.isBox(boxMark("b1"))); XCTAssertFalse(Boxes.isBox(webMark("w1", "x")))
        let reply = BrowserRules.boxReplyInput(["nonce": "n", "box": boxMark("x")["box"]!, "text": .string("  lots   of\n text " + String(repeating: "y", count: 3000))])
        XCTAssertEqual(reply?.text.count, Boxes.textMax); XCTAssertTrue(reply?.text.hasPrefix("lots of text ") ?? false)
        XCTAssertNil(BrowserRules.boxReplyInput(["box": ["x": "a"]]))
        var bad = boxMark("x")["box"]!.object!; bad["anchor"] = ["selector": "", "tag": "img"]
        XCTAssertEqual(BrowserRules.boxReplyInput(["box": .object(bad)])?.box["anchor"], .null)
        let report = BrowserRules.boxReportInput(["rects": [["id": "a", "x": 1, "y": 2, "w": 3, "h": 4], ["id": "b", "x": 1, "y": 2, "w": 0, "h": 4], ["id": 5]], "selected": "a", "size": ["width": 10, "height": 20]])
        XCTAssertEqual(report?.rects, [Item(id: "a", x: 1, y: 2, w: 3, h: 4)]); XCTAssertEqual(report?.selected, "a"); XCTAssertNil(report?.resizing)
        XCTAssertNil(BrowserRules.boxReportInput([:]))
        let resizing: JSONValue = ["id": "a", "x": 50, "y": 60, "viewport": ["width": 800, "height": 600]]
        XCTAssertEqual(BrowserRules.boxReportInput(["rects": [["id": "a", "x": 1, "y": 2, "w": 3, "h": 4]], "resizing": resizing])?.resizing?.id, "a")
        XCTAssertNil(BrowserRules.boxReportInput(["rects": [["id": "a", "x": 1, "y": 2, "w": 3, "h": 4]], "resizing": ["id": "zz", "x": 50, "y": 60, "viewport": ["width": 800, "height": 600]]])?.resizing)
        XCTAssertEqual(BrowserRules.boxViewInput(["id": "a", "rect": ["x": 1, "y": 2, "w": 3, "h": 4], "viewport": ["width": 10, "height": 10], "scrolling": true]).scrolling, true)
        XCTAssertNil(BrowserRules.boxViewInput(["id": "a", "rect": ["x": 1, "y": 2, "w": 0, "h": 4], "viewport": ["width": 10, "height": 10]]).id)
        XCTAssertNotNil(BrowserRules.boxResizeInput(["id": "a-1", "rect": ["x": 1, "y": 2, "w": 3, "h": 4], "box": boxMark("x")["box"]!, "text": "t"]))
        XCTAssertNil(BrowserRules.boxResizeInput(["id": "a b", "rect": ["x": 1, "y": 2, "w": 3, "h": 4], "box": boxMark("x")["box"]!]))
    }

    func testShapesMainAcceptsAndGives() {
        XCTAssertEqual(BrowserRules.quoteInput(["exact": "x"]), BrowserRules.Quote(exact: "x"))
        XCTAssertNil(BrowserRules.quoteInput(["exact": "  "]))
        XCTAssertNil(BrowserRules.quoteInput(["exact": .string(String(repeating: "a", count: 5001))]))
        XCTAssertNil(BrowserRules.quoteInput(["exact": "x", "prefix": .string(String(repeating: "a", count: 65))]))
        XCTAssertNil(BrowserRules.quoteInput(["exact": "x", "prefix": .null]))
        XCTAssertEqual(BrowserRules.selectionInput(["quote": ["exact": "x"], "pageText": .string(String(repeating: "a", count: 20000))])?.pageText.count, BrowserRules.maxPageText)
        XCTAssertEqual(BrowserRules.selectionCardInput(["token": .null])?.token, nil)
        XCTAssertNil(BrowserRules.selectionCardInput(["token": "a b", "viewport": ["width": 1, "height": 1]]))
        let offer = BrowserRules.selectionCardInput(["token": "s1", "line": ["x": 1, "y": 2, "w": 3, "h": 4], "rect": .null, "viewport": ["width": 800, "height": 600], "quote": ["exact": "hi"], "pageText": "around"])
        XCTAssertEqual(offer?.quote?.exact, "hi"); XCTAssertNil(offer?.rect); XCTAssertEqual(offer?.pageText, "around")
        XCTAssertEqual(BrowserRules.selectionCardInput(["token": "s2", "viewport": ["width": 8, "height": 6], "markId": "m1"])?.markId, "m1")
        XCTAssertNil(BrowserRules.selectionCardInput(["token": "s2", "viewport": ["width": 8, "height": 6], "markId": ""]))
        XCTAssertTrue(BrowserRules.isNoted(["note": "a"])); XCTAssertFalse(BrowserRules.isNoted(["note": " "]))
        XCTAssertTrue(BrowserRules.isNoted(["asks": [["answer": "yes"]]])); XCTAssertFalse(BrowserRules.isNoted(["asks": [["answer": "yes", "deleted": true]]]))
        XCTAssertEqual(BrowserRules.bartQuestion("@bart what is this?"), "what is this?")
        XCTAssertNil(BrowserRules.bartQuestion("@bartholomew x")); XCTAssertNil(BrowserRules.bartQuestion("@bart   ")); XCTAssertNil(BrowserRules.bartQuestion("a note"))
        let asks = BrowserRules.boxAsksInput([["askId": "a", "markId": "m", "lines": .array((0..<500).map { .string("l\($0)") }), "error": "boom"], ["askId": 3]])
        XCTAssertEqual(asks.count, 1); XCTAssertEqual(asks[0]["lines"]?.array?.count, 400); XCTAssertEqual(asks[0]["error"], "boom")
        XCTAssertEqual(BrowserRules.cardAsks([["id": "1", "question": "q", "answer": "a", "deleted": true], ["id": "2", "question": "q2", "answer": "a2", "meta": ["name": "Sol"]]]).map { $0["id"] }, ["2"])
    }

    func testBrowserHelpers() throws {
        XCTAssertEqual(try BrowserRules.parseBrowserUrl("http://0.0.0.0:3000/x").absoluteString, "http://localhost:3000/x")
        XCTAssertThrowsError(try BrowserRules.parseBrowserUrl("file:///etc/passwd"))
        XCTAssertThrowsError(try BrowserRules.parseBrowserUrl("javascript:alert(1)"))
        XCTAssertThrowsError(try BrowserRules.parseBrowserUrl(""))
        XCTAssertTrue(BrowserRules.isLoopback("localhost")); XCTAssertTrue(BrowserRules.isLoopback("127.0.0.1")); XCTAssertTrue(BrowserRules.isLoopback("[::1]"))
        XCTAssertFalse(BrowserRules.isLoopback("example.org"))
        XCTAssertEqual(BrowserRules.cleanUserAgent("Mozilla/5.0 Chrome/140 Engelbart/0.1.25 Electron/44.4.1 Safari/537.36"), "Mozilla/5.0 Chrome/140 Engelbart/0.1.25 Safari/537.36")
        XCTAssertEqual(try BrowserRules.boundsFrom(CGRect(x: 10.4, y: 20, width: 0, height: 50.6), zoom: 2), CGRect(x: 21, y: 40, width: 1, height: 101))
        XCTAssertThrowsError(try BrowserRules.boundsFrom(CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1)))
        XCTAssertEqual(BrowserRules.externalScheme("slack://open"), "slack:")
        XCTAssertEqual(BrowserRules.externalScheme("mailto:a@b.c"), "mailto:")
        for inside in ["https://a.org", "file:///x", "javascript:1", "data:text/html,x", "about:blank", "engelbart://app"] { XCTAssertEqual(BrowserRules.externalScheme(inside), "", inside) }
        XCTAssertTrue(BrowserRules.fileablePage("https://example.org")); XCTAssertTrue(BrowserRules.fileablePage("file:///Users/h/a.html"))
        XCTAssertFalse(BrowserRules.fileablePage("http://localhost:3000")); XCTAssertFalse(BrowserRules.fileablePage("about:blank"))
    }

    func testPdfHelpers() {
        let headers = BrowserRules.pdfAsDownload(["Content-Type": "application/pdf", "content-disposition": "inline; filename=\"paper.pdf\""])
        XCTAssertEqual(headers?["Content-Disposition"], "attachment; filename=\"paper.pdf\"")
        XCTAssertNil(headers?["content-disposition"])
        XCTAssertEqual(BrowserRules.pdfAsDownload(["content-type": "application/x-pdf"])?["Content-Disposition"], "attachment")
        XCTAssertNil(BrowserRules.pdfAsDownload(["content-type": "text/html"]))
        XCTAssertEqual(BrowserRules.pdfName("paper.pdf", "https://x.org/y.pdf"), "paper")
        XCTAssertEqual(BrowserRules.pdfName("", "https://arxiv.org/pdf/2312.10893"), "2312.10893")
        XCTAssertEqual(BrowserRules.pdfName("", "https://x.org/My%20Paper.PDF"), "My Paper")
        XCTAssertEqual(BrowserRules.pdfName("", "https://x.org/"), "pdf")
        XCTAssertTrue(BrowserRules.pdfAddress("https://x.org/a.pdf?x=1")); XCTAssertFalse(BrowserRules.pdfAddress("https://x.org/a.pdf.html"))
        XCTAssertTrue(BrowserRules.isPDF(mime: "application/octet-stream", fileName: "", url: "https://x.org/a.PDF"))
    }

    func testFileUrlsInsideHomeOnly() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("eb-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("site"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try "<p>hi</p>".write(to: home.appendingPathComponent("site/index.html"), atomically: true, encoding: .utf8)
        XCTAssertNoThrow(try BrowserRules.parseFileUrl(home.appendingPathComponent("site/index.html").absoluteString, root: home.path))
        XCTAssertNoThrow(try BrowserRules.parseFileUrl(home.appendingPathComponent("not-yet.html").absoluteString, root: home.path))
        XCTAssertThrowsError(try BrowserRules.parseFileUrl("file:///etc/hosts", root: home.path)) { XCTAssertEqual($0.localizedDescription, "Only files inside your home directory can be opened") }
        XCTAssertThrowsError(try BrowserRules.parseFileUrl("file://host/x", root: home.path))
        let link = home.appendingPathComponent("escape")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: "/etc")
        XCTAssertThrowsError(try BrowserRules.parseFileUrl(link.appendingPathComponent("hosts").absoluteString, root: home.path))
        let page = home.appendingPathComponent("site/index.html").absoluteString
        XCTAssertTrue(BrowserRules.allowed(page, from: page, root: home.path))
        XCTAssertFalse(BrowserRules.allowed(page, from: "https://evil.example", root: home.path))
        XCTAssertTrue(BrowserRules.allowed("https://a.org", from: page, root: home.path))
        XCTAssertTrue(BrowserRules.allowed("about:blank", from: nil, root: home.path))
    }

    func testSelectionCardPlace() {
        let pane = CGRect(x: 0, y: 0, width: 800, height: 600), size = CGSize(width: 340, height: 120)
        let line = CGRect(x: 100, y: 200, width: 300, height: 20)
        XCTAssertEqual(SelectionCardPlace.place(line: line, all: CGRect(x: 80, y: 160, width: 400, height: 60), pane: pane, size: size), CGRect(x: 100, y: 228, width: 340, height: 120))
        let low = CGRect(x: 100, y: 560, width: 300, height: 20)
        XCTAssertEqual(SelectionCardPlace.place(line: low, all: CGRect(x: 100, y: 520, width: 300, height: 60), pane: pane, size: size), CGRect(x: 100, y: 392, width: 340, height: 120))
        XCTAssertEqual(SelectionCardPlace.place(line: CGRect(x: 700, y: 200, width: 50, height: 20), all: nil, pane: pane, size: size)?.minX, 460)
        XCTAssertNil(SelectionCardPlace.place(line: CGRect(x: 100, y: 700, width: 50, height: 20), all: nil, pane: pane, size: size))
        let shaded = SelectionCardPlace.shaded(line: line, all: nil, pane: pane, size: size)
        XCTAssertEqual(shaded, CGRect(x: 76, y: 210, width: 388, height: 168))
    }
}
