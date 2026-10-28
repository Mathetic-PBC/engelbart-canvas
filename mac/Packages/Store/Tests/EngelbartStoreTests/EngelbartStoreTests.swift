import XCTest
@testable import EngelbartStore

final class EngelbartStoreTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartStoreModule.name, "EngelbartStore") }
}
