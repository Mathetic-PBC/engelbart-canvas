import XCTest
@testable import EngelbartSandbox

final class EngelbartSandboxTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartSandboxModule.name, "EngelbartSandbox") }
}
