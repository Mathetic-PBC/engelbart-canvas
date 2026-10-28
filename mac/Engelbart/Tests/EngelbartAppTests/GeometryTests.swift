import XCTest
@testable import EngelbartApp

// test/window-edges.test.cjs, test/developer.test.cjs, the placement half of test/windows.test.cjs, ipc-validation.

final class WindowEdgesTests: XCTestCase {
    let start = CGRect(x: 100, y: 50, width: 1200, height: 800)
    let min = CGSize(width: 900, height: 560)

    func testRightEdgeGrowsAndShrinksWidthOnly() {
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .right, dx: 40, dy: 30, min: min), CGRect(x: 100, y: 50, width: 1240, height: 800))
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .right, dx: -100, dy: 0, min: min), CGRect(x: 100, y: 50, width: 1100, height: 800))
    }

    func testLeftEdgeKeepsRightSide() {
        let b = WindowGeometry.resizedBounds(start, edge: .left, dx: -60, dy: 0, min: min)
        XCTAssertEqual(b, CGRect(x: 40, y: 50, width: 1260, height: 800))
        XCTAssertEqual(b.maxX, start.maxX)
    }

    func testBottomCorners() {
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .bottom, dx: 25, dy: 40, min: min), CGRect(x: 100, y: 50, width: 1200, height: 840))
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .bottomRight, dx: 25, dy: 40, min: min), CGRect(x: 100, y: 50, width: 1225, height: 840))
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .bottomLeft, dx: 25, dy: 40, min: min), CGRect(x: 125, y: 50, width: 1175, height: 840))
    }

    func testNeverBelowMinimum() {
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .bottomRight, dx: -900, dy: -900, min: min), CGRect(x: 100, y: 50, width: 900, height: 560))
        XCTAssertEqual(WindowGeometry.resizedBounds(start, edge: .left, dx: 700, dy: 0, min: min), CGRect(x: 400, y: 50, width: 900, height: 800),
                       "the left edge stops instead of sliding the window")
    }

    func testUnknownEdgeRefused() {
        XCTAssertNil(WindowGeometry.Edge(rawValue: "top"), "the top edge is the title bar's")
    }

    func testStripLayout() {
        let rects = Dictionary(uniqueKeysWithValues: EdgeStrips.rects(in: CGSize(width: 1200, height: 800)).map { ($0.0, $0.1) })
        XCTAssertEqual(rects[.left], CGRect(x: 0, y: 54, width: 6, height: 800 - 54 - 14))
        XCTAssertEqual(rects[.right], CGRect(x: 1194, y: 54, width: 6, height: 732))
        XCTAssertEqual(rects[.bottom], CGRect(x: 14, y: 794, width: 1172, height: 6))
        XCTAssertEqual(rects[.bottomLeft], CGRect(x: 0, y: 786, width: 14, height: 14))
        XCTAssertEqual(rects[.bottomRight], CGRect(x: 1186, y: 786, width: 14, height: 14))
    }

    func testYFlip() {
        let r = CGRect(x: 10, y: 20, width: 300, height: 200)
        XCTAssertEqual(WindowGeometry.yUp(WindowGeometry.yDown(r, mainHeight: 900), mainHeight: 900), r)
        XCTAssertEqual(WindowGeometry.yDown(r, mainHeight: 900).minY, 680)
    }
}

final class PlacementTests: XCTestCase {
    let screen = [CGRect(x: 0, y: 0, width: 1440, height: 900)]

    func testPlacement() {
        XCTAssertEqual(WindowGeometry.placement(bounds: CGRect(x: 100, y: 50, width: 1000, height: 700), workAreas: screen),
                       .init(origin: CGPoint(x: 100, y: 50), size: CGSize(width: 1000, height: 700)))
        XCTAssertEqual(WindowGeometry.placement(bounds: CGRect(x: 4000, y: 50, width: 1000, height: 700), workAreas: screen),
                       .init(origin: nil, size: CGSize(width: 1000, height: 700)), "off every screen (a display unplugged): centred")
        XCTAssertEqual(WindowGeometry.placement(bounds: CGRect(x: 0, y: 0, width: 300, height: 200), workAreas: screen),
                       .init(origin: .zero, size: CGSize(width: 900, height: 560)))
        XCTAssertEqual(WindowGeometry.placement(from: CGRect(x: 40, y: 40, width: 1200, height: 800), workAreas: screen),
                       .init(origin: CGPoint(x: 64, y: 64), size: CGSize(width: 1200, height: 800)), "a step from the window it was opened from")
        XCTAssertEqual(WindowGeometry.placement(workAreas: screen), .init(origin: nil, size: CGSize(width: 1440, height: 900)))
    }

    func testCleanPlace() {
        XCTAssertEqual(WindowPlace.clean(projectId: "not an id", workspaceId: "x"), WindowPlace())
        let p = "11111111-2222-4333-8444-555555555555", w = "66666666-7777-4888-8999-000000000000"
        XCTAssertEqual(WindowPlace.clean(projectId: p, workspaceId: w), WindowPlace(projectId: p, workspaceId: w))
        XCTAssertEqual(WindowPlace.clean(projectId: nil, workspaceId: w), WindowPlace(), "no workspace without a project")
        XCTAssertEqual(WindowPlace.clean(projectId: p, workspaceId: "nope"), WindowPlace(projectId: p, workspaceId: nil))
    }

    func testExternalURL() {
        XCTAssertNoThrow(try ExternalURL.parse("https://github.com/login"))
        XCTAssertNoThrow(try ExternalURL.parse("http://localhost:3000"))
        XCTAssertThrowsError(try ExternalURL.parse("file:///etc/passwd")) { XCTAssertEqual($0 as? ExternalURL.Failure, .invalid) }
        XCTAssertThrowsError(try ExternalURL.parse("javascript:alert(1)"))
        XCTAssertThrowsError(try ExternalURL.parse("ftp://example.com")) { XCTAssertEqual($0 as? ExternalURL.Failure, .scheme) }
        XCTAssertThrowsError(try ExternalURL.parse("")) { XCTAssertEqual($0 as? ExternalURL.Failure, .notBounded) }
        XCTAssertThrowsError(try ExternalURL.parse("https://x.com/" + String(repeating: "a", count: 4100))) { XCTAssertEqual($0 as? ExternalURL.Failure, .notBounded) }
    }
}

final class DeveloperTests: XCTestCase {
    func testTestModeOnlyInDeveloperCopies() throws {
        let dist = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-dist-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dist) }
        let write = { (text: String) in try! text.write(to: dist.appendingPathComponent(Developer.buildFile), atomically: true, encoding: .utf8) }
        XCTAssertTrue(Developer.hasTestMode(packaged: false, resources: dist), "swift run")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist), "a bundle with no build.json")
        write("{\"developer\":false}\n")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist), "what ships")
        write("{\"developer\":true}\n")
        XCTAssertTrue(Developer.hasTestMode(packaged: true, resources: dist), "ENGELBART_DEVELOPER=1 bundle.sh")
        write("{\"developer\":\"true\"}\n")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist), "only true itself")
        write("{\"developer\":1}\n")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist), "not a number either")
        write("{\"developer\":tr")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist), "unreadable")
        XCTAssertFalse(Developer.hasTestMode(packaged: false, resources: dist, environment: ["ENGELBART_TEST_MODE": "off"]))
        write("{\"developer\":true}\n")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist, environment: ["ENGELBART_TEST_MODE": "off"]))
        write("{\"developer\":false}\n")
        XCTAssertFalse(Developer.hasTestMode(packaged: true, resources: dist, environment: ["ENGELBART_TEST_MODE": "on"]))
    }

    func testPaths() {
        let home = "/Users/someone"
        let p = AppPaths(environment: ["ENGELBART_HOME_DIR": home])
        XCTAssertEqual(p.dataRoot.path, "\(home)/.engelbart-swift", "never the Electron app's ~/.engelbart")
        XCTAssertEqual(p.testRoot.path, "\(home)/.engelbart-swift/test")
        XCTAssertEqual(AppPaths(environment: ["ENGELBART_ROOT_DIR": "/tmp/eb-root"]).dataRoot.path, "/tmp/eb-root")
        XCTAssertEqual(AppPaths(environment: ["ENGELBART_USER_DATA_DIR": "/tmp/eb-ud"]).userData.path, "/tmp/eb-ud")
        XCTAssertTrue(AppPaths.isElectronRoot(URL(fileURLWithPath: "\(home)/.engelbart"), home: URL(fileURLWithPath: home)))
        XCTAssertTrue(AppPaths.isElectronRoot(URL(fileURLWithPath: "\(home)/.engelbart/test"), home: URL(fileURLWithPath: home)))
        XCTAssertFalse(AppPaths.isElectronRoot(URL(fileURLWithPath: "\(home)/.engelbart-swift"), home: URL(fileURLWithPath: home)))
        XCTAssertEqual(AppPaths.shown(URL(fileURLWithPath: "\(home)/.engelbart-swift/test"), home: home), "~/.engelbart-swift/test")
    }
}
