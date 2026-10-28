import XCTest
@testable import EngelbartEditor

final class EngelbartEditorTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartEditorModule.name, "EngelbartEditor") }
}
