import XCTest
@testable import EngelbartWorkspace

final class EngelbartWorkspaceTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartWorkspaceModule.name, "EngelbartWorkspace") }
}
