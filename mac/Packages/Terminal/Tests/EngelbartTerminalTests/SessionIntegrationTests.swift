import Darwin
import XCTest
@testable import EngelbartTerminal

// test/session.integration.cjs: real PTYs through the session manager. Test methods run on the main thread; `wait(for:)`
// spins the main run loop, where the manager's callbacks arrive.

final class SessionIntegrationTests: XCTestCase {
    struct Fixture { var root: String; var home: String; var environment: [String: String] }

    func fixture() -> Fixture {
        let root = temporaryDirectory(self, prefix: "experimental-terminal-pty-")
        let home = root + "/home"
        write("", to: home + "/.zshenv")
        write("", to: home + "/.zprofile")
        write("PROMPT=\"fixture> \"\n", to: home + "/.zshrc")
        write("", to: home + "/.zlogin")
        return Fixture(root: root, home: home, environment: ["HOME": home, "ZDOTDIR": home, "SHELL": "/bin/zsh",
                                                           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"])
    }

    func makeManager(_ configure: (inout SessionManager.Options) -> Void = { _ in }) -> (SessionManager, Fixture) {
        let files = fixture()
        var options = SessionManager.Options(environment: files.environment)
        options.batchDelayMs = 1
        configure(&options)
        let manager = SessionManager(options: options)
        addTeardownBlock {
            let done = XCTestExpectation(description: "shutdown")
            manager.shutdown { done.fulfill() }
            _ = XCTWaiter.wait(for: [done], timeout: 5)
        }
        return (manager, files)
    }

    func marker(_ label: String) -> String { "\(label)_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))" }

    /// Collects a session's output until `predicate` holds. → the output.
    @discardableResult
    func waitForOutput(_ manager: SessionManager, _ id: String, timeout: TimeInterval = 5, after action: () throws -> Void = {},
                       _ predicate: @escaping (String) -> Bool) rethrows -> String {
        var output = ""
        let seen = XCTestExpectation(description: "output")
        var done = false
        let listener = manager.onData { event in
            guard event.id == id, !done else { return }
            output += event.text
            if predicate(output) { done = true; seen.fulfill() }
        }
        try action()
        wait(for: [seen], timeout: timeout)
        manager.off(listener)
        return output
    }

    func waitForProcessToDisappear(_ pid: Int32, timeout: TimeInterval = 3) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if kill(pid, 0) != 0 && errno == ESRCH { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.025))
        }
        XCTFail("Process \(pid) survived PTY closure")
    }

    func close(_ manager: SessionManager, _ id: String) -> Result<Bool, Error> {
        var result: Result<Bool, Error>?
        let done = XCTestExpectation(description: "close")
        manager.close(id) { result = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        return result ?? .failure(TerminalError("close did not finish"))
    }

    func testRealPtyExecutesInputAndReportsAControllingTerminal() throws {
        let (manager, files) = makeManager()
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        let mark = marker("TTY")
        let expected = "\(mark):yes"
        let command = "if test -t 0; then printf '%s:%s\\n' '\(mark)' yes; else printf '%s:%s\\n' '\(mark)' no; fi\n"
        XCTAssertFalse(command.contains(expected))
        let output = try waitForOutput(manager, session.id, after: { try manager.write(session.id, command) }) { $0.contains(expected) }
        XCTAssertTrue(output.contains(expected))
        XCTAssertEqual(session.title, "zsh")
        XCTAssertEqual(session.status, .running)
        XCTAssertEqual(session.provider, .shell)
    }

    func testResizeReachesSttyInsideThePty() throws {
        let (manager, files) = makeManager()
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        try manager.resize(session.id, cols: 91, rows: 33)
        XCTAssertEqual(manager.get(session.id)?.cols, 91)
        let mark = marker("SIZE")
        let expected = "\(mark):33 91"
        let output = try waitForOutput(manager, session.id, after: { try manager.write(session.id, "printf '%s:%s\\n' '\(mark)' \"$(stty size)\"\n") }) { $0.contains(expected) }
        XCTAssertTrue(output.contains(expected))
    }

    func testCtrlCInterruptsAForegroundCommandAndLeavesTheShellUsable() throws {
        let (manager, files) = makeManager()
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        let started = marker("FOREGROUND")
        let pattern = try NSRegularExpression(pattern: "\(started):(\\d+)")
        let startCommand = "sh -c 'printf \"%s:%d\\n\" \"$1\" \"$$\"; exec sleep 10' sh '\(started)'\n"
        let output = try waitForOutput(manager, session.id, after: { try manager.write(session.id, startCommand) }) {
            pattern.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil
        }
        let match = pattern.firstMatch(in: output, range: NSRange(output.startIndex..., in: output))!
        let childPid = Int32(output[Range(match.range(at: 1), in: output)!])!
        XCTAssertEqual(kill(childPid, 0), 0)
        try manager.write(session.id, "\u{3}")
        waitForProcessToDisappear(childPid)
        let recovered = marker("RECOVERED")
        let back = try waitForOutput(manager, session.id, after: { try manager.write(session.id, "printf '%s:%s\\n' '\(recovered)' ready\n") }) { $0.contains("\(recovered):ready") }
        XCTAssertTrue(back.contains("\(recovered):ready"))
    }

    func testShellExitCodeIsRetainedAndEmitted() throws {
        let (manager, files) = makeManager()
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        var exit: SessionExit?
        let exited = XCTestExpectation(description: "exit")
        manager.onExit { if $0.id == session.id { exit = $0; exited.fulfill() } }
        try manager.write(session.id, "exit 7\n")
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(exit?.exitCode, 7)
        XCTAssertNil(exit?.signal)
        XCTAssertEqual(manager.get(session.id)?.status, .exited)
        XCTAssertEqual(manager.get(session.id)?.exitCode, 7)
        XCTAssertThrowsError(try manager.write(session.id, "x")) { XCTAssertEqual(($0 as? TerminalError)?.message, "Session has exited") }
        XCTAssertEqual(manager.runningCount, 0)
    }

    func testTwoSessionsKeepWorkingDirectoriesAndProcessStateIsolated() throws {
        let (manager, files) = makeManager()
        let first = files.root + "/first", second = files.root + "/second"
        try FileManager.default.createDirectory(atPath: first, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: second, withIntermediateDirectories: true)
        let a = try manager.create(.init(provider: .shell, cwd: first, cols: 80, rows: 24))
        let b = try manager.create(.init(provider: .shell, cwd: second, cols: 80, rows: 24))
        let ma = marker("FIRST"), mb = marker("SECOND")
        let outA = try waitForOutput(manager, a.id, after: { try manager.write(a.id, "printf '%s:%s\\n' '\(ma)' \"$PWD\"\n") }) { $0.contains("\(ma):\(first)") }
        let outB = try waitForOutput(manager, b.id, after: { try manager.write(b.id, "printf '%s:%s\\n' '\(mb)' \"$PWD\"\n") }) { $0.contains("\(mb):\(second)") }
        XCTAssertTrue(outA.contains("\(ma):\(first)"))
        XCTAssertTrue(outB.contains("\(mb):\(second)"))
        XCTAssertEqual(manager.list().map(\.id), [a.id, b.id])
    }

    func testReplayIsBoundedAndLifecycleCloseRemovesOnlyTheTargetSession() throws {
        let (manager, files) = makeManager { $0.maxReplayBytes = 160; $0.maxReplayEntries = 3; $0.maxSessions = 2 }
        let first = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        let second = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        XCTAssertThrowsError(try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "At most 2 sessions may be open")
        }
        let mark = marker("REPLAY")
        try waitForOutput(manager, first.id, after: { try manager.write(first.id, "printf '%0600d%s:%s\\n' 0 '\(mark)' done\n") }) { $0.contains("\(mark):done") }
        let snapshot = manager.get(first.id)!
        XCTAssertLessThanOrEqual(snapshot.history.count, 3)
        XCTAssertLessThanOrEqual(snapshot.history.reduce(0) { $0 + $1.data.utf8.count }, 160)
        XCTAssertEqual(try close(manager, first.id).get(), true)
        XCTAssertNil(manager.get(first.id))
        XCTAssertEqual(manager.get(second.id)?.status, .running)
        XCTAssertEqual(try close(manager, "nope").get(), false)
    }

    func testClosingASessionTerminatesItsForegroundChildProcess() throws {
        let (manager, files) = makeManager()
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        let mark = marker("CHILD_PID")
        let pattern = try NSRegularExpression(pattern: "\(mark):(\\d+)")
        let output = try waitForOutput(manager, session.id, after: {
            try manager.write(session.id, "sh -c 'printf \"%s:%d\\n\" \"$1\" \"$$\"; exec sleep 30' sh '\(mark)'\n")
        }) { pattern.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil }
        let match = pattern.firstMatch(in: output, range: NSRange(output.startIndex..., in: output))!
        let childPid = Int32(output[Range(match.range(at: 1), in: output)!])!
        XCTAssertEqual(try close(manager, session.id).get(), true)
        waitForProcessToDisappear(childPid)
        XCTAssertNil(manager.get(session.id))
    }

    func testLargePtyOutputIsEmittedInBoundedBatches() throws {
        let (manager, files) = makeManager { $0.maxOutputBatchBytes = 96 }
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        var sizes: [Int] = []
        manager.onData { if $0.id == session.id { sizes.append($0.bytes.count) } }
        let mark = marker("BATCH_END")
        try waitForOutput(manager, session.id, after: {
            try manager.write(session.id, "head -c 2000 /dev/zero | tr '\\0' z; printf '%s:%s\\n' '\(mark)' done\n")
        }) { $0.contains("\(mark):done") }
        XCTAssertGreaterThan(sizes.count, 2)
        XCTAssertTrue(sizes.allSatisfy { $0 <= 96 }, "oversized batches: \(sizes)")
    }

    func testInputLimitsAndRendererDetachmentReleasePtyBackpressure() throws {
        let (manager, files) = makeManager { $0.maxUnackedBytes = 64; $0.resumeUnackedBytes = 16 }
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        XCTAssertThrowsError(try manager.write(session.id, String(repeating: "x", count: 70_000))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Terminal input must be a string of at most 65536 bytes")
        }
        XCTAssertThrowsError(try manager.resize(session.id, cols: 0, rows: 24)) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "cols must be an integer between 2 and 500")
        }
        XCTAssertFalse(manager.acknowledge(session.id, 999_999))

        func waitForPause() -> Int {
            var last = 0
            let paused = XCTestExpectation(description: "paused")
            var done = false
            let listener = manager.onData { event in
                guard event.id == session.id, !done else { return }
                last = event.sequence
                DispatchQueue.main.async {
                    if !done, manager.flowState(session.id)?.paused == true { done = true; paused.fulfill() }
                }
            }
            wait(for: [paused], timeout: 5)
            manager.off(listener)
            return last
        }
        try manager.write(session.id, "printf '%0200d\\n' 0\n")
        let flood = waitForPause()
        XCTAssertEqual(manager.flowState(session.id)?.paused, true)
        XCTAssertFalse(manager.acknowledge("not-this-session", flood))
        XCTAssertTrue(manager.acknowledge(session.id, flood))
        XCTAssertEqual(manager.flowState(session.id)?.paused, false)

        try manager.write(session.id, "printf '%0200d\\n' 0\n")
        _ = waitForPause()
        XCTAssertEqual(manager.flowState(session.id)?.paused, true)
        manager.detachRenderer()
        XCTAssertEqual(manager.flowState(session.id)?.paused, false)
    }

    func testCloseNeverReportsSuccessWithoutAConfirmedPtyExit() throws {
        let files = fixture()
        let inert = FakeProcess()
        var options = SessionManager.Options(environment: files.environment)
        options.spawn = { _ in inert }
        options.closeTimeoutMs = 5
        options.forceCloseTimeoutMs = 5
        let manager = SessionManager(options: options)
        let session = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        let result = close(manager, session.id)
        XCTAssertThrowsError(try result.get()) { XCTAssertEqual(($0 as? TerminalError)?.message, "PTY did not exit after termination signals") }
        XCTAssertEqual(manager.get(session.id)?.status, .running)
        XCTAssertEqual(inert.killed, [SIGHUP, SIGKILL], "node-pty's default SIGHUP first")
        inert.onExit?(0, nil)
    }

    func testExtraEnvironmentIsReadAtEveryStart() throws {
        let files = fixture()
        var specs: [Launch.Spec] = []
        var extra = ["ENGELBART_GIT_BIN": "/one"]
        var options = SessionManager.Options(environment: files.environment)
        options.extraEnvironment = { extra }
        options.spawn = { specs.append($0); return FakeProcess() }
        let manager = SessionManager(options: options)
        let claude = try manager.create(.init(provider: .claude, cwd: files.root, cols: 80, rows: 24))
        XCTAssertEqual(claude.title, "Claude Code")
        extra["ENGELBART_GIT_BIN"] = "/two"
        _ = try manager.create(.init(provider: .shell, cwd: files.root, cols: 80, rows: 24))
        XCTAssertEqual(specs.map { $0.env["ENGELBART_GIT_BIN"] }, ["/one", "/two"])
    }

    func testSandboxSessionsValidateAndCarryTheirLibraryId() throws {
        let files = fixture()
        let manager = SessionManager(environment: files.environment)
        var request = SandboxSessionRequest(sandboxId: "sbx-1", libraryId: "lib", title: "owner/repo (sandbox)\u{7}", cwd: "/home/user/repo",
                                            envs: ["A": "1"], hint: "npm\ttest\n", hasApiKey: true)
        XCTAssertEqual(try SessionManager.validateSandbox(request), "\u{1b}[2m# Try: npm test\u{1b}[0m\r\n")
        XCTAssertEqual(request.processEnvironment, ["A": "1", "TERM": "xterm-256color", "COLORTERM": "truecolor"])
        var banner: String?
        let process = FakeProcess()
        let session = try manager.createSandbox(request) { banner = $0; return process }
        XCTAssertEqual(banner, "\u{1b}[2m# Try: npm test\u{1b}[0m\r\n")
        XCTAssertEqual(session.provider, .sandbox)
        XCTAssertEqual(session.libraryId, "lib")
        XCTAssertEqual(session.title, "owner/repo (sandbox)")
        XCTAssertEqual(session.shell, "bash")
        XCTAssertEqual([session.cols, session.rows], [100, 30])
        var woke = false
        manager.wake(session.id) { _ in woke = true }
        XCTAssertTrue(process.woken && woke)
        XCTAssertThrowsError(try manager.createSandbox(request) { _ in nil }) { XCTAssertEqual(($0 as? TerminalError)?.message, "Sandbox terminals are unavailable") }
        for (change, message) in [({ (r: inout SandboxSessionRequest) in r.sandboxId = "bad id" }, "Invalid sandbox"),
                                  ({ $0.libraryId = "" }, "Invalid library id"),
                                  ({ $0.cwd = "relative" }, "Invalid sandbox directory"),
                                  ({ $0.hasApiKey = false }, "A sandbox terminal needs the E2B key")] {
            var bad = request
            change(&bad)
            XCTAssertThrowsError(try SessionManager.validateSandbox(bad)) { XCTAssertEqual(($0 as? TerminalError)?.message, message) }
        }
        request.title = nil
        XCTAssertEqual(try manager.createSandbox(request) { _ in FakeProcess() }.title, "Sandbox")
    }

    func testOpenCommandTypesTheCommandOnceTheShellHasGoneQuiet() throws {
        let (manager, files) = makeManager()
        let mark = marker("RUNSTEP")
        let session = try manager.openCommand(cwd: files.root, command: "printf '%s:%s\\n' '\(mark)' ran")
        XCTAssertEqual([session.cols, session.rows], [100, 30])
        let output = try waitForOutput(manager, session.id, timeout: 8) { $0.contains("\(mark):ran") }
        XCTAssertTrue(output.contains("\(mark):ran"))
    }
}

/// node-pty's IPty, inert: what tests hand the manager.
final class FakeProcess: TerminalProcess {
    var pid: Int32 = 12345
    var onData: (([UInt8]) -> Void)?
    var onExit: ((Int32, Int32?) -> Void)?
    var written: [String] = []
    var killed: [Int32] = []
    var woken = false
    func write(_ bytes: [UInt8]) { written.append(String(decoding: bytes, as: UTF8.self)) }
    func resize(cols: Int, rows: Int) {}
    func pause() {}
    func resume() {}
    func kill(_ signal: Int32) { killed.append(signal) }
    func wake(_ done: @escaping (Error?) -> Void) { woken = true; done(nil) }
    func print(_ text: String) { onData?(Array(text.utf8)) }
}
