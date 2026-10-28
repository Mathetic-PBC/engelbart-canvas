import XCTest
@testable import EngelbartTerminal

final class EngelbartTerminalTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartTerminalModule.name, "EngelbartTerminal") }
}
