import EngelbartCore
import XCTest
@testable import EngelbartTools

// The same checks in a real login zsh, with an empty home so nobody's own rc files run (test/tools.test.cjs "real zsh"),
// the hidden sign-in in a real PTY (test/sign-in.integration.cjs), and the runner itself (run.cjs).
final class RealShellTests: XCTestCase {
    struct Shell { let root: String; let bin: String; let env: [String: String]; let runner: ToolRunner }

    /// After /etc/zprofile: its path_helper puts the system's folders first (/opt/homebrew/bin among them), and a Claude Code
    /// installed there was found instead of the one here (2026-09-29). As a person's own .zprofile would, this sets it.
    func realShell() -> Shell {
        let root = temp()
        let bin = "\(root)/bin"
        mkdirs(bin)
        write("\(root)/.zprofile", "export PATH=\"\(bin):/usr/bin:/bin\"\n")
        for file in [".zshenv", ".zlogin"] { write("\(root)/\(file)", "") }
        let env = ["HOME": root, "ZDOTDIR": root, "SHELL": "/bin/zsh", "PATH": "\(bin):/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        return Shell(root: root, bin: bin, env: env, runner: ToolRunner(environment: { env }))
    }

    func opts(_ home: String) -> DetectOptions {
        var o = DetectOptions()
        o.home = home; o.systemBins = []; o.environment = [:]
        return o
    }

    func testTheRunnerMarksAndSanitizes() async {
        let s = realShell()
        write("\(s.root)/.zshrc", "echo noise from the rc file\n")
        let out = await s.runner.shell("echo \"$ENGELBART_X|$TERM|$TERM_PROGRAM\"", env: ["ENGELBART_X": "a b"], timeout: 20)
        XCTAssertEqual(out.marked, true)
        XCTAssertEqual(out.stdout, "a b|xterm-256color|Engelbart\n", "rc noise skipped; values through the environment")
        let missing = await s.runner.exec("/nonexistent/program", [], env: [:], timeout: 5, cwd: nil, input: nil)
        XCTAssertTrue(missing.missing)
        XCTAssertNil(missing.code)
        let slow = await s.runner.exec("/bin/sleep", ["5"], env: [:], timeout: 0.3, cwd: nil, input: nil)
        XCTAssertTrue(slow.timedOut)
        let failing = await s.runner.exec("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], env: [:], timeout: 5, cwd: nil, input: nil)
        XCTAssertEqual([failing.code, failing.stdout, failing.stderr] as [AnyHashable?], [Int32(3), "out\n", "err\n"])
        write("\(s.root)/.zshrc", "exec /bin/cat </dev/null\n")
        let silent = await s.runner.shell("echo hi", env: [:], timeout: 20)
        XCTAssertEqual(silent.marked, false, "a .zshrc that ends in exec never runs the command")
    }

    func testSanitize() {
        let env = ToolShell.sanitize(["CLAUDECODE": "1", "CODEX_THREAD_ID": "x", "ELECTRON_RUN_AS_NODE": "1", "NODE_OPTIONS": "--inspect=9229", "WARP_X": "1", "HOME": "/h", "LC_ALL": "C"])
        XCTAssertEqual(env, ["HOME": "/h", "LC_ALL": "C", "TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "Engelbart", "TERM_PROGRAM_VERSION": "0.1.0"])
        XCTAssertEqual(ToolShell.sanitize(["NODE_OPTIONS": "--max-old-space-size=4096"])["NODE_OPTIONS"], "--max-old-space-size=4096")
        XCTAssertEqual(ToolShell.sanitize([:])["LANG"], "en_US.UTF-8")
        XCTAssertEqual(ToolShell.resolve(["SHELL": "/bin/bash"]), "/bin/bash")
        XCTAssertEqual(ToolShell.resolve(["SHELL": "/usr/bin/python3"]), "/bin/zsh")
        XCTAssertEqual(ToolShell.loginShellArgs("/bin/zsh", "claude", ["ENGELBART_GIT_BIN": "/g", "ENGELBART_AGENT_PATH": "/a"]),
                       ["-ilc", "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; PATH=\"$PATH:$ENGELBART_AGENT_PATH\"; claude"])
        XCTAssertEqual(ToolShell.loginShellArgs("/opt/homebrew/bin/fish", "claude", ["ENGELBART_AGENT_PATH": "/a"]),
                       ["--login", "--interactive", "--command", "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); claude"])
    }

    func testAnAliasIsReportedWithoutItsDefinitionAndAHiddenRunIsNeverGivenOne() async {
        let s = realShell()
        write("\(s.bin)/codex", "#!/bin/sh\ncase \"$1\" in --version) echo \"codex-cli 0.155.1\";; login) echo \"Logged in using ChatGPT\";; esac\n", mode: 0o700)
        write("\(s.root)/.zshrc", "alias claude='printf super-secret-definition'\n")
        write("\(s.root)/.codex/auth.json", "{}") // its sign-in in a file, not only the keychain (2026-10-15)
        let found = await detectTools(runner: s.runner, only: ["claude", "codex"], options: opts(s.root))
        XCTAssertEqual(status(found.tools["claude"]), "missing")
        XCTAssertEqual(found.aliases, ["claude"])
        let c = found.tools["codex"]!
        XCTAssertEqual([c["status"], c["version"], c["signedIn"], c["path"]], ["ready", "0.155.1", true, .string("\(s.bin)/codex")])
        XCTAssertFalse(JSONValue.object(found.tools.mapValues { .object($0) }).text().contains("super-secret-definition"))
        let config = ConfigFile()
        let manager = await MainActor.run { ToolsManager(storage: config.storage, detect: { _ in found }, actions: FakeTools(nil, delay: 0)) }
        await manager.check()
        let menu = await manager.providers(shellPath: "/bin/zsh")
        XCTAssertEqual(menu.first { $0.id == "claude" }, ToolProvider(id: "claude", name: "Claude Code", available: true, path: "shell alias/function", authenticated: nil, checkedAt: found.tools["claude"]?["checkedAt"]?.string))
        let usable = await manager.usableAgents()
        XCTAssertEqual(usable?.contains("claude"), false, "@bart cannot run an alias")
    }

    func testSignInAndTheAccountAreReadFromEachCLIAndNothingElse() async {
        let s = realShell()
        write("\(s.root)/.zshrc", "")
        write("\(s.bin)/claude", "#!/bin/sh\ncase \"$1\" in --version) echo \"2.1.300 (Claude Code)\";; auth) printf '{\"loggedIn\": true, \"email\": \"someone@example.com\", \"orgId\": \"org-private-id\"}\\n';; esac\n", mode: 0o700)
        write("\(s.bin)/codex", "#!/bin/sh\ncase \"$1\" in --version) echo \"codex-cli 0.155.1\";; login) echo \"Not logged in\"; exit 1;; esac\n", mode: 0o700)
        let found = await detectTools(runner: s.runner, only: ["claude", "codex"], options: opts(s.root))
        let c = found.tools["claude"]!, x = found.tools["codex"]!
        XCTAssertEqual([c["status"], c["signedIn"], c["account"]], ["ready", true, "someone@example.com"])
        XCTAssertEqual([x["status"], x["signedIn"], x["account"]], ["signed-out", false, .null])
        XCTAssertFalse(JSONValue.object(found.tools.mapValues { .object($0) }).text().contains("org-private-id"))
    }

    // MARK: the hidden sign-in (test/sign-in.integration.cjs)

    func waitExit(_ run: SignInRun, _ seconds: TimeInterval = 8) async -> SignInExit? {
        let timeout = Once<SignInExit?>()
        Task { timeout.resolve(await run.wait()) }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { timeout.resolve(nil) }
        return await timeout.wait()
    }

    func testSignInAnswersPressEnterPassesThePageOnAndEndsWithTheCLI() async {
        let s = realShell()
        write("\(s.root)/.zshrc", "")
        let cli = "\(s.bin)/claude"
        // Stands in for `claude auth login --claudeai`: refuses to go on until Enter, then prints the page and finishes.
        write(cli, "#!/bin/sh\n[ \"$1 $2 $3\" = \"auth login --claudeai\" ] || exit 9\nprintf \"\\033[1mPress Enter to open your browser\\033[0m\\n\"\nread answer\necho \"If the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&state=abc\"\nsleep 0.2\necho \"Login successful.\"\n", mode: 0o755)
        let start = makeSignInStarter(shell: "/bin/zsh", environment: { s.env }, home: s.root)
        final class Pages: @unchecked Sendable { let l = NSLock(); var list: [String] = []; func add(_ p: String) { l.lock(); list.append(p); l.unlock() } }
        let pages = Pages()
        let run = start("claude", cli) { pages.add($0) }
        let exit = await waitExit(run)
        XCTAssertEqual(exit, SignInExit(code: 0, output: ""))
        XCTAssertEqual(pages.list, ["https://claude.ai/oauth/authorize?code=true&state=abc"])
    }

    func testASignInThatFailsReportsItsLastLineAndCancelEndsOneThatWaits() async {
        let s = realShell()
        write("\(s.root)/.zshrc", "")
        let failing = "\(s.bin)/codex"
        write(failing, "#!/bin/sh\necho \"Error: login server could not bind to port 1455\"\nexit 1\n", mode: 0o755)
        let start = makeSignInStarter(shell: "/bin/zsh", environment: { s.env }, home: s.root)
        let failed = await waitExit(start("codex", failing) { _ in })
        XCTAssertEqual(failed, SignInExit(code: 1, output: "Error: login server could not bind to port 1455"))
        let waiting = "\(s.bin)/waits"
        write(waiting, "#!/bin/sh\necho \"Waiting for the browser…\"\nsleep 60\n", mode: 0o755)
        let run = start("codex", waiting) { _ in }
        try? await Task.sleep(nanoseconds: 300_000_000)
        run.kill()
        let ended = await waitExit(run, 5)
        XCTAssertEqual(ended, SignInExit(code: nil, output: ""), "cancelled, not a success")
    }

    func testACLIFoundWherePathDoesNotReachSignsInWithItsFolderOnPath() async {
        let s = realShell()
        write("\(s.root)/.zshrc", "")
        let away = "\(s.root)/.local/bin"
        let cli = "\(away)/claude"
        // Stands in for Claude Code's own check: its folder has to be on the PATH it was started with.
        write(cli, "#!/bin/sh\ncase \":$PATH:\" in *\":\(away):\"*) echo \"Login successful.\"; exit 0;; esac\necho \"Native installation exists but \(away) is not in your PATH\"\nexit 7\n", mode: 0o755)
        let start = makeSignInStarter(shell: "/bin/zsh", environment: { s.env }, home: s.root)
        let exit = await waitExit(start("claude", cli) { _ in })
        XCTAssertEqual(exit, SignInExit(code: 0, output: ""))
    }

    func testAQuitEndsASignInStillWaitingAndWaitsForItsTerminal() async {
        let s = realShell()
        write("\(s.root)/.zshrc", "")
        let waiting = "\(s.bin)/claude"
        write(waiting, "#!/bin/sh\necho \"Opening the browser to sign in…\"\nsleep 60\n", mode: 0o755)
        let fake = FakeTools("{\"claude\":\"2.1.300 signed-out\",\"codex\":\"missing\"}", delay: 0, sleep: { _ in })
        let real = makeSignInStarter(shell: "/bin/zsh", environment: { s.env }, home: s.root)
        let manager = await MainActor.run {
            ToolsManager(storage: .memory(), detect: { await fake.detect($0) }, actions: fake, signIn: { name, _, onUrl in real(name, waiting, onUrl) }, signOut: fake.signOutRunner)
        }
        await manager.check()
        let pressed = Task { await manager.signIn("claude") }
        try? await Task.sleep(nanoseconds: 400_000_000)
        let busy = await manager.snapshot().tools["claude"]?.busy
        XCTAssertEqual(busy?.action, "sign-in", "waiting in the browser")
        let started = Date()
        let stopped = await manager.stopSignIns()
        XCTAssertEqual(stopped, 1)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        _ = await pressed.value
        let after = await manager.snapshot().tools["claude"]
        XCTAssertNil(after?.busy)
        XCTAssertEqual(after?.status, "signed-out")
    }
}
