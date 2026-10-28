import XCTest
@testable import EngelbartDoc

final class EngelbartDocTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartDocModule.name, "EngelbartDoc") }
}
