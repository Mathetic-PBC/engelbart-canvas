import XCTest
@testable import EngelbartIntegrations

final class EngelbartIntegrationsTests: XCTestCase {
    func testBuilds() { XCTAssertEqual(EngelbartIntegrationsModule.name, "EngelbartIntegrations") }
}
