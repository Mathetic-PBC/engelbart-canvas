import XCTest
@testable import EngelbartTools

final class EngelbartToolsTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartToolsModule.name, "EngelbartTools") }
}
