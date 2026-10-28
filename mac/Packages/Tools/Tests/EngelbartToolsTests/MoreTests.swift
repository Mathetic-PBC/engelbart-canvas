import EngelbartCore
import XCTest
@testable import EngelbartTools

// The rest of test/tools.test.cjs (the logout command), and the edges of readVersion and the installers.
final class MoreTests: XCTestCase {
    typealias A = TableRunner.Answer

    func testTheLogoutCommandIsEachCLIsOwnRunInTheLoginShellByFullPath() async {
        XCTAssertEqual(SIGN_OUT_COMMANDS, ["claude": #"exec "$ENGELBART_TOOL" auth logout 2>&1"#, "codex": #"exec "$ENGELBART_TOOL" logout 2>&1"#])
        XCTAssertEqual(SIGN_IN_COMMANDS, ["claude": #"exec "$ENGELBART_TOOL" auth login --claudeai"#, "codex": #"exec "$ENGELBART_TOOL" login -c 'cli_auth_credentials_store="file"'"#])
        final class Answer: @unchecked Sendable { var value = ExecResult(code: 0, stdout: "Successfully logged out from your Anthropic account.\n", marked: true) }
        let answer = Answer()
        let runner = TableRunner()
        runner.shellOverride = { _, _ in answer.value }
        let signOut = makeSignOutRunner(runner: runner)
        let first = await signOut("claude", "/Users/someone/.local/bin/claude")
        XCTAssertEqual(first, SignInExit(code: 0, output: ""))
        XCTAssertEqual(runner.calls.map(\.command), [#"exec "$ENGELBART_TOOL" auth logout 2>&1"#])
        XCTAssertEqual(runner.calls.first?.env, ["ENGELBART_TOOL": "/Users/someone/.local/bin/claude"])
        answer.value = ExecResult(code: 1, stdout: "\u{1b}[31mError:\u{1b}[0m not logged in\nTry codex login\n", marked: true)
        let refused = await signOut("codex", "/opt/homebrew/bin/codex")
        XCTAssertEqual(refused, SignInExit(code: 1, output: "Try codex login"), "the last line, without colour codes")
        XCTAssertEqual(runner.calls[1].command, #"exec "$ENGELBART_TOOL" logout 2>&1"#)
        answer.value = ExecResult(code: 0, marked: false)
        let silent = await signOut("codex", "/opt/homebrew/bin/codex")
        XCTAssertTrue(silent.output.contains("never runs Engelbart's commands"))
        answer.value = ExecResult(code: nil, timedOut: true, marked: false)
        let slow = await signOut("codex", "/opt/homebrew/bin/codex")
        XCTAssertEqual(slow, SignInExit(code: nil, output: "it did not finish within 30 seconds"))
        answer.value = ExecResult(code: 3, stdout: "", marked: true)
        let bare = await signOut("codex", "/opt/homebrew/bin/codex")
        XCTAssertEqual(bare, SignInExit(code: 3, output: "exit status 3"))
    }

    func testReadVersionSaysWhatHappened() async {
        let broken = TableRunner(shell: [("--version", A(TableRunner.ok("dyld: Library not loaded: libnode\nmore", code: 6)))])
        let out = await readVersion(broken, "claude", "/x/claude")
        XCTAssertEqual(out.error, "Claude Code did not start: dyld: Library not loaded: libnode")
        XCTAssertFalse(out.ran)
        let empty = TableRunner(shell: [("--version", A(TableRunner.ok("", code: 2)))])
        let bare = await readVersion(empty, "codex", "/x/codex")
        XCTAssertEqual(bare.error, "Codex did not start: exit status 2")
        let odd = TableRunner(exec: ["/x/git --version": A(TableRunner.ok("git version unknown-build"))])
        let unread = await readVersion(odd, "git", "/x/git", direct: true)
        XCTAssertEqual([unread.ran ? "ran" : "no", unread.error], ["ran", "Could not read the version Git printed: \"git version unknown-build\""])
        let stderr = TableRunner(exec: ["/x/git --version": A(TableRunner.ok("", stderr: "git version 2.44.0\n"))])
        let fromStderr = await readVersion(stderr, "git", "/x/git", direct: true)
        XCTAssertEqual(fromStderr.version, "2.44.0", "a direct run reads stderr too")
    }

    func testTheDownloadedInstallerIsRemovedAfterwards() async {
        let runner = TableRunner()
        final class Seen: @unchecked Sendable { var script: String? }
        let seen = Seen()
        runner.shellOverride = { _, env in
            seen.script = env["ENGELBART_INSTALLER"]
            FileManager.default.createFile(atPath: env["ENGELBART_INSTALLER"]!, contents: Data("#!/bin/sh\n".utf8))
            return ExecResult(code: 0, stdout: "installed", marked: true)
        }
        let result = await ToolInstaller(runner: runner, tmpDir: temp()).installAgent("claude")
        XCTAssertTrue(result.ok)
        XCTAssertNotNil(seen.script)
        XCTAssertFalse(FileManager.default.fileExists(atPath: seen.script!), "downloaded to a file first, and that file removed")
    }

    /// The real tools of this Mac, read only: no install, update or sign-in runs. Opt in with ENGELBART_TOOLS_REAL=1.
    func testTheRealMachineReadOnly() async throws {
        guard ProcessInfo.processInfo.environment["ENGELBART_TOOLS_REAL"] == "1" else { throw XCTSkip("ENGELBART_TOOLS_REAL=1 reads this Mac's own git, claude and codex") }
        let runner = ToolRunner()
        let found = await detectTools(runner: runner)
        for name in TOOL_NAMES {
            let f = found.tools[name] ?? [:]
            print("[real] \(name): status=\(f["status"]?.string ?? "-") version=\(f["version"]?.string ?? "-") source=\(f["source"]?.string ?? "-") path=\(f["path"]?.string ?? "-") onPath=\(f["onPath"].map { $0.text() } ?? "-") signedIn=\(f["signedIn"].map { $0.text() } ?? "-") updaterOff=\(f["updaterOff"].map { $0.text() } ?? "-") note=\(f["note"]?.string ?? "-") error=\(f["error"]?.string ?? "-")")
        }
        print("[real] aliases=\(found.aliases ?? []) lookupError=\(found.lookupError ?? "-") shell=\(runner.shellPath)")
        XCTAssertNil(found.lookupError)
    }
}
