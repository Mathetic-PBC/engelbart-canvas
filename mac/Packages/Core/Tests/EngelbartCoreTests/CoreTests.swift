import XCTest
@testable import EngelbartCore

final class CoreTests: XCTestCase {
    func testJSONRoundTrip() throws {
        let v = try JSONValue.parse(#"{"a":[1,2.5,"x",true,null],"b":{"c":"d"}}"#)
        XCTAssertEqual(v["a"]?[1]?.double, 2.5)
        XCTAssertEqual(v["b"]?["c"]?.string, "d")
        XCTAssertEqual(try JSONValue.parse(v.text()), v)
        XCTAssertEqual(JSONValue.number(3).text(), "3")
    }

    func testProcessRunnerLinesAndExit() async throws {
        let r = try await ProcessRunner.run("/bin/sh", ["-c", "printf 'a\\nb\\n'; echo err >&2; exit 3"])
        XCTAssertEqual(r.stdout, "a\nb\n")
        XCTAssertEqual(r.stderr, "err\n")
        XCTAssertEqual(r.exit.status, 3)
        XCTAssertNil(r.exit.signal)
    }

    func testKilledProcessIsNotSuccess() async throws {
        let child = RunningProcess(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["10"])
        try child.start()
        child.terminate(grace: 0.2)
        let exit = await child.wait()
        XCTAssertFalse(exit.succeeded)
        XCTAssertNotNil(exit.signal)
    }

    func testLoginPathFindsShell() {
        XCTAssertNotNil(ShellEnvironment.resolve("sh"))
        XCTAssertTrue(ShellEnvironment.path().contains("/usr/bin"))
    }

    func testAtomicWrite() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let file = dir.appendingPathComponent("x.json")
        try Files.writeJSON(["k": "v"], to: file)
        XCTAssertEqual(try String(contentsOf: file), "{\n  \"k\" : \"v\"\n}\n")
        try? FileManager.default.removeItem(at: dir)
    }
}
