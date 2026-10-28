import XCTest
import EngelbartCore
@testable import EngelbartSandbox

/// An in-process HTTP layer for the real E2B client: every request goes to `FakeE2BServer.handler`. No network.
final class FakeE2BServer: URLProtocol {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: (URLRequest, Data) -> (Int, [Data]) = { _, _ in (404, []) }
    nonisolated(unsafe) static var seen: [(URLRequest, Data)] = []

    static func body(_ request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body = Self.body(request)
        let (status, chunks) = Self.lock.withLock { Self.seen.append((request, body)); return Self.handler(request, body) }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

// The real E2B client against the fake HTTP layer: the REST calls and the envd Connect-RPC streams Engelbart uses.
final class ClientTests: XCTestCase {
    var client: E2BHTTPClient!

    override func setUp() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeE2BServer.self]
        client = E2BHTTPClient(configuration: .init(domain: "e2b.app"), sessionConfiguration: config)
        FakeE2BServer.seen = []
    }

    func json(_ v: JSONValue) -> [Data] { [Data(v.text().utf8)] }

    func testRestCallsAndErrors() async throws {
        FakeE2BServer.handler = { request, body in
            let path = request.url!.path
            switch (request.httpMethod!, path) {
            case ("POST", "/sandboxes"):
                let b = try! JSONValue.parse(body)
                XCTAssertEqual(b["templateID"], "engelbart-runner")
                XCTAssertEqual(b["timeout"], 3600)
                XCTAssertEqual(b["autoPause"], true)
                XCTAssertEqual(b["autoResume"], ["enabled": true])
                XCTAssertEqual(b["metadata"]?["canvasRunId"], "run-1")
                return (201, [Data(#"{"sandboxID":"sb-1","envdVersion":"0.5.7","envdAccessToken":"tok","domain":null}"#.utf8)])
            case ("GET", "/sandboxes/sb-1"): return (200, [Data(#"{"sandboxID":"sb-1","state":"paused","endAt":"2026-10-28T12:00:00.000Z","metadata":{"app":"engelbart-canvas"}}"#.utf8)])
            case ("GET", "/sandboxes/gone"): return (404, [Data(#"{"code":404,"message":"not found"}"#.utf8)])
            case ("DELETE", "/sandboxes/gone"): return (404, [])
            case ("DELETE", "/sandboxes/sb-1"): return (204, [])
            case ("POST", "/sandboxes/sb-1/pause"): return (409, [])
            case ("POST", "/sandboxes/sb-1/timeout"): XCTAssertEqual(try! JSONValue.parse(body)["timeout"], 600); return (204, [])
            case ("POST", "/sandboxes/sb-1/connect"): XCTAssertEqual(try! JSONValue.parse(body)["timeout"], 600); return (200, [Data(#"{"sandboxID":"sb-1","envdVersion":"0.5.7"}"#.utf8)])
            case ("GET", "/v2/sandboxes"): return (200, [Data(#"[{"sandboxID":"sb-9","state":"running"}]"#.utf8)])
            case ("POST", "/sandboxes/bad/timeout"): return (401, [Data(#"{"message":"Invalid API key"}"#.utf8)])
            default: return (500, [])
            }
        }
        let box = try await client.create(template: "engelbart-runner", E2BCreateOptions(timeoutMs: 3_600_000, pauseOnTimeout: true, autoResume: true, metadata: ["canvasRunId": "run-1"]), apiKey: "key-1")
        XCTAssertEqual(box.sandboxId, "sb-1")
        XCTAssertEqual(box.getHost(43110), "43110-sb-1.e2b.app")
        XCTAssertEqual(FakeE2BServer.seen[0].0.value(forHTTPHeaderField: "X-API-KEY"), "key-1")
        XCTAssertEqual(FakeE2BServer.seen[0].0.url?.host, "api.e2b.app")
        let info = try await client.getInfo("sb-1", apiKey: "k", requestTimeoutMs: nil)
        XCTAssertEqual(info.state, "paused")
        XCTAssertEqual(info.metadata, ["app": "engelbart-canvas"])
        do { _ = try await client.getInfo("gone", apiKey: "k", requestTimeoutMs: nil); XCTFail() } catch { XCTAssertTrue(isNotFound(error)) }
        try await assertEqualAsync(try await client.kill("gone", apiKey: "k", requestTimeoutMs: nil), false)
        try await assertEqualAsync(try await client.kill("sb-1", apiKey: "k", requestTimeoutMs: nil), true)
        try await assertEqualAsync(try await client.pause("sb-1", apiKey: "k", requestTimeoutMs: nil), false, "409: already asleep")
        try await client.setTimeout("sb-1", timeoutMs: 600_000, apiKey: "k", requestTimeoutMs: nil)
        _ = try await client.connect("sb-1", apiKey: "k", timeoutMs: 600_000, requestTimeoutMs: nil)
        let listed = try await client.list(metadata: ["canvasRunId": "run-1", "app": "engelbart-canvas"], states: ["running", "paused"], apiKey: "k", requestTimeoutMs: nil)
        XCTAssertEqual(listed.map(\.sandboxId), ["sb-9"])
        let query = FakeE2BServer.seen.last!.0.url!.query!
        XCTAssertTrue(query.contains("state=running,paused"))
        XCTAssertTrue(query.contains("metadata="))
        await assertThrows(try await client.setTimeout("bad", timeoutMs: 1000, apiKey: "k", requestTimeoutMs: nil), "^Unauthorized, please check your credentials\\. - Invalid API key$")
    }

    func envelope(_ v: JSONValue, end: Bool = false) -> Data { ConnectRPC.envelope(v, flags: end ? 2 : 0) }
    func b64(_ s: String) -> JSONValue { .string(Data(s.utf8).base64EncodedString()) }

    func testCommandsStreamOverConnect() async throws {
        FakeE2BServer.handler = { request, body in
            if request.url!.path == "/sandboxes/sb-1/connect" { return (200, [Data(#"{"sandboxID":"sb-1","envdVersion":"0.5.7","envdAccessToken":"tok"}"#.utf8)]) }
            XCTAssertEqual(request.url!.host, "sandbox.e2b.app")
            XCTAssertEqual(request.value(forHTTPHeaderField: "E2b-Sandbox-Id"), "sb-1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "E2b-Sandbox-Port"), "49983")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Access-Token"), "tok")
            switch request.url!.path {
            case "/process.Process/Start":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/connect+json")
                let message = try! JSONValue.parse(body.dropFirst(5))
                let cmd = message["process"]?["args"]?[2]?.string ?? ""
                if cmd == "fail" {
                    let all = self.envelope(["event": ["start": ["pid": 5]]]) + self.envelope(["event": ["data": ["stderr": self.b64("nope\n")]]])
                        + self.envelope(["event": ["end": ["exitCode": 2, "status": "exit status 2"]]]) + self.envelope([:], end: true)
                    return (200, [all])
                }
                XCTAssertEqual(message["process"]?["args"], ["-l", "-c", "echo hé"])
                XCTAssertEqual(message["process"]?["envs"], ["A": "1"])
                let out = self.envelope(["event": ["start": ["pid": 4]]]) + self.envelope(["event": ["data": ["stdout": .string(Data([0x68, 0xC3]).base64EncodedString())]]])
                let rest = self.envelope(["event": ["data": ["stdout": .string(Data([0xA9, 0x0A]).base64EncodedString())]]]) + self.envelope(["event": ["keepalive": [:]]])
                    + self.envelope(["event": ["end": ["exited": true, "status": "exit status 0"]]]) + self.envelope([:], end: true)
                return (200, [out.prefix(7), out.dropFirst(7), rest])
            case "/process.Process/SendInput":
                XCTAssertEqual(try! JSONValue.parse(body)["input"]?["pty"], self.b64("ls\r"))
                return (200, [Data("{}".utf8)])
            case "/process.Process/SendSignal":
                return (404, [Data(#"{"code":"not_found","message":"process 9 not found"}"#.utf8)])
            case "/files":
                if request.httpMethod == "GET" { return (200, [Data(repeating: 65, count: 100)]) }
                XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("print('x')"))
                XCTAssertEqual(request.url!.query, "path=/home/user/.engelbart-canvas/launch.py")
                return (200, [Data(#"[{"name":"launch.py"}]"#.utf8)])
            default: return (500, [])
            }
        }
        let box = try await client.connect("sb-1", apiKey: "k", timeoutMs: nil, requestTimeoutMs: nil)
        let out = Locked("")
        let result = try await box.run("echo hé", CommandOptions(envs: ["A": "1"], onStdout: { t in out.with { $0 += t } }))
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.stdout, "hé\n")
        XCTAssertEqual(out.value, "hé\n", "UTF-8 split across chunks")
        do { _ = try await box.run("fail", CommandOptions()); XCTFail() } catch {
            XCTAssertEqual(exitCodeOf(error), 2)
        }
        try await box.ptySendInput(pid: 4, Data("ls\r".utf8), requestTimeoutMs: nil)
        try await assertEqualAsync(try await box.ptyKill(pid: 9, requestTimeoutMs: nil), false, "a gone process is not an error")
        try await box.writeFile("/home/user/.engelbart-canvas/launch.py", "print('x')")
        try await assertEqualAsync(try await box.readFile("/x", maxBytes: 10, signal: nil, requestTimeoutMs: nil).count, 10)
    }

    func testAStreamDroppedWithoutAnEndIsSleepNotExit() async throws {
        FakeE2BServer.handler = { request, _ in
            if request.url!.path.hasSuffix("/connect") { return (200, [Data(#"{"sandboxID":"sb-1","envdVersion":"0.5.7"}"#.utf8)]) }
            return (200, [self.envelope(["event": ["start": ["pid": 3]]])])
        }
        let box = try await client.connect("sb-1", apiKey: "k", timeoutMs: nil, requestTimeoutMs: nil)
        let handle = try await box.ptyCreate(cols: 80, rows: 24, cwd: "/home/user/repository", envs: [:], timeoutMs: 0, requestTimeoutMs: nil) { _ in }
        XCTAssertEqual(handle.pid, 3)
        do { _ = try await handle.wait(); XCTFail() } catch { XCTAssertNil(exitCodeOf(error), "no exit code: the pty treats it as sleep") }
        let start = FakeE2BServer.seen.last!
        let message = try JSONValue.parse(start.1.dropFirst(5))
        XCTAssertEqual(message["process"]?["args"], ["-i", "-l"])
        XCTAssertEqual(message["process"]?["envs"]?["TERM"], "xterm-256color")
        XCTAssertEqual(message["pty"], ["size": ["cols": 80, "rows": 24]])
        XCTAssertNil(start.0.value(forHTTPHeaderField: "Connect-Timeout-Ms"), "timeoutMs 0: no limit")
    }

    func testVersionsCompare() {
        XCTAssertEqual(compareVersions("0.3.9", "0.4.0"), -1)
        XCTAssertEqual(compareVersions("0.5.7", "0.5.7"), 0)
        XCTAssertEqual(compareVersions("1.0", "0.9.9"), 1)
    }
}

// The Python helpers ship byte-identical; the service's channels; the sandbox-local MCP name.
final class PackagingTests: XCTestCase {
    func testPythonHelpersAreTheElectronOnes() throws {
        let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../src/main/sandbox").standardized
        for name in ["launch.py", "install-job.py", "launch-discovery.py", "npm-audit.py"] {
            let bundled = try XCTUnwrap(SandboxResources.url(name), name)
            let data = try Data(contentsOf: bundled)
            XCTAssertFalse(data.isEmpty)
            if let original = try? Data(contentsOf: src.appendingPathComponent(name)) { XCTAssertEqual(data, original, name) }
        }
    }

    func testServiceOffModeAndValidation() async throws {
        let off = SandboxService(manager: nil, context: { throw SandboxError("no context") })
        try await assertEqualAsync(try await off.runs(), [])
        try await assertEqualAsync(try await off.ensure(), [])
        try await off.touch("id")
        for call in [{ _ = try await off.start("id") }, { _ = try await off.stop("id") }, { _ = try await off.terminal("id") },
                     { _ = try await off.environment("id") }, { _ = try await off.restart("id") }] as [() async throws -> Void] {
            await assertThrows(try await call(), "^Sandboxes are turned off in this copy of Engelbart$")
        }
        XCTAssertThrowsError(try SandboxService.id(String(repeating: "x", count: 65), "library id")) {
            XCTAssertEqual(message(of: $0), "library id must be a string of at most 64 characters")
        }
        XCTAssertNil(SandboxService.makeManager(SandboxManager.Options(notify: { _ in }, launch: { _, _, _ in throw SandboxError("x") }), environment: ["ENGELBART_SANDBOXES": "off"]))
        XCTAssertTrue(SandboxService.startsOnAdd(row: ["tags": ["git"]], value: " https://github.com/owner/app "))
        XCTAssertTrue(SandboxService.startsOnAdd(row: ["tags": ["git"]], value: "git@github.com:owner/app.git"))
        XCTAssertFalse(SandboxService.startsOnAdd(row: ["tags": ["git"]], value: "/Users/me/code/app"), "a local clone starts no remote work")
        XCTAssertFalse(SandboxService.startsOnAdd(row: ["tags": []], value: "https://github.com/owner/app"))
        XCTAssertEqual(SandboxLocalMCP.name, "sandbox-local")
    }

    func testModeChangeRefusesStartsUntilItEnds() async throws {
        let gate = Deferred<Void>()
        let service = SandboxService(manager: nil, context: { throw SandboxError("x") })
        let change = Task { try await service.changeMode { try await gate.wait() } }
        await eventually { service.modeChanging }
        await assertThrows(try await service.queued { 1 }, "Wait for the data mode change to finish")
        await assertThrows(try await service.changeMode { 1 }, "already changing")
        gate.resolve(())
        try await change.value
        try await assertEqualAsync(try await service.queued { 2 }, 2)
    }
}
