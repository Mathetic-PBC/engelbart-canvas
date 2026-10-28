import XCTest
@testable import EngelbartUI

final class EngelbartUITests: XCTestCase {
    func testFontsRegister() {
        Fonts.register()
        XCTAssertEqual(Fonts.caveat(20).familyName, "Caveat")
        XCTAssertEqual(Fonts.mono(12, weight: 500).fontName, "SourceCodeProExtraLight-Medium")
    }

    func testImages() {
        XCTAssertNotNil(Images.named("trash"))
        XCTAssertNotNil(Images.named("yellow-sticky-note.png"))
    }
}
