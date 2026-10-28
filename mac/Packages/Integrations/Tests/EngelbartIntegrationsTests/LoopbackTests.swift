import Foundation
import XCTest
@testable import EngelbartIntegrations

final class LoopbackTests: XCTestCase {
    func testServesOneRequestOnLoopback() async throws {
        let server = try await LoopbackServer.start { request in
            .text(200, "\(request.method) \(request.path) \(request.query("a") ?? "") \(request.headers["host"] ?? "")")
        }
        XCTAssertGreaterThan(server.port, 0)
        let response = try await URLSessionHTTPClient().send(HTTPRequest(url: URL(string: "http://127.0.0.1:\(server.port)/x?a=1")!, timeout: 5))
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(response.text, "GET /x 1 127.0.0.1:\(server.port)")
        server.close()
        await assertThrows({ try await URLSessionHTTPClient().send(HTTPRequest(url: URL(string: "http://127.0.0.1:\(server.port)/")!, timeout: 2)) }, ".")
    }
}
