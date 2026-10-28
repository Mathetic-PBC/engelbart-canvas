import AppKit
import EngelbartDoc
import XCTest
@testable import EngelbartScreens

// What a drop on the rail holds (model/drop.js readDrop, read from the drop's item providers).
final class DropReaderTests: XCTestCase {
    func read(_ providers: [NSItemProvider]) -> [Drop.Item] {
        let done = expectation(description: "read")
        var out: [Drop.Item] = []
        DropReader.read(providers) { out = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        return out
    }

    func testFilesFirstAndAloneThenOneLinkThenAPicture() {
        let file = NSItemProvider(object: NSURL(fileURLWithPath: "/Users/h/paper.pdf"))
        let link = NSItemProvider(object: NSURL(string: "https://memex.org/")!)
        XCTAssertEqual(read([file, link]), [.path("/Users/h/paper.pdf")], "files come first and alone")
        XCTAssertEqual(read([link]), [.url("https://memex.org/")])
        let google = NSItemProvider(object: NSURL(string: "https://www.google.com/imgres?imgurl=https://x.org/p.png")!)
        XCTAssertEqual(read([google]), [.url("https://x.org/p.png")], "a Google Images result is the picture behind it")
        let png = NSItemProvider(item: Data([0x89, 0x50, 0x4e, 0x47]) as NSData, typeIdentifier: "public.png")
        XCTAssertEqual(read([png]), [.bytes(Data([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", name: nil)], "a picture with no path: its bytes")
        let html = NSItemProvider(item: Data("<p><img src=\"https://x.org/a.jpg\"></p>".utf8) as NSData, typeIdentifier: "public.html")
        XCTAssertEqual(read([html]), [.url("https://x.org/a.jpg")], "no link: the first picture's address")
        XCTAssertEqual(read([]), [])
    }
}
