import EngelbartCore
import XCTest
@testable import EngelbartTools

// test/tools.test.cjs: installs, rollback, the lock, the repository checks; test/bundled-git.test.cjs.
final class InstallTests: XCTestCase {
    typealias A = TableRunner.Answer

    override func tearDown() {
        freeBytesProvider = { path in
            var stats = statfs()
            guard statfs(path, &stats) == 0 else { return nil }
            return Double(stats.f_bavail) * Double(stats.f_bsize)
        }
    }

    func testClassifyFailureNamesTheCauseInOneLine() {
        XCTAssertEqual(classifyFailure("curl: (6) Could not resolve host: claude.ai", 6).kind, "network")
        XCTAssertEqual(classifyFailure("Received HTTP code 407 from proxy after CONNECT").kind, "proxy")
        XCTAssertEqual(classifyFailure("curl: (60) SSL certificate problem: unable to get local issuer certificate").kind, "network")
        XCTAssertEqual(classifyFailure("mkdir: /Users/h/.local/bin: Permission denied").kind, "permission")
        XCTAssertEqual(classifyFailure("write error: No space left on device").kind, "disk")
        XCTAssertEqual(classifyFailure("npm ERR! code E404").kind, "package-manager")
        let other = classifyFailure("\u{1b}[31msomething odd\u{1b}[0m\n", 1)
        XCTAssertEqual(other.kind, "other")
        XCTAssertEqual(other.error, "It did not finish (something odd).")
        XCTAssertEqual(classifyFailure("", 3).error, "It did not finish (exit status 3).")
        XCTAssertEqual(classifyFailure("curl: (6) Could not resolve host: claude.ai").error, "The installer could not be reached: no internet connection (curl: (6) Could not resolve host: claude.ai).")
    }

    func testRoomForRefusesAnInstallTheDiskCannotHold() {
        XCTAssertNil(roomFor("claude", NSHomeDirectory()), "this machine has a gigabyte free")
        freeBytesProvider = { _ in 100 * 4096 }
        let full = roomFor("git", "/Library")
        XCTAssertEqual(full?.kind, "disk")
        XCTAssertEqual(full?.error, "Git needs about 5.0 GB free; 0.0 GB is left.")
        freeBytesProvider = { _ in nil }
        XCTAssertNil(roomFor("git", "/Library"), "cannot tell: the installer will say")
    }

    func testInstallAgentDownloadsTheInstallerToAFileFirst() async {
        let runner = TableRunner(shell: [("curl -fsSL", A(TableRunner.ok("curl: (6) Could not resolve host: claude.ai", code: 6)))])
        let tmp = temp()
        let out = await ToolInstaller(runner: runner, tmpDir: tmp).installAgent("claude")
        XCTAssertEqual([out.ok ? "ok" : "failed", out.kind], ["failed", "network"])
        let call = runner.calls.first { $0.kind == "shell" }!
        XCTAssertTrue(call.command.contains(#"curl -fsSL --retry 2 --connect-timeout 20 -o "$ENGELBART_INSTALLER" "$ENGELBART_INSTALLER_URL" && bash "$ENGELBART_INSTALLER" < /dev/null 2>&1"#))
        XCTAssertEqual(call.env["ENGELBART_INSTALLER_URL"], "https://claude.ai/install.sh")
        XCTAssertTrue(call.env["ENGELBART_INSTALLER"]!.hasPrefix("\(tmp)/engelbart-claude-install-\(getpid())-"))
        let codexRunner = TableRunner(shell: [("curl -fsSL", A(TableRunner.ok("==> Installed")))])
        let ok = await ToolInstaller(runner: codexRunner, tmpDir: temp()).installAgent("codex")
        XCTAssertTrue(ok.ok)
        let codexCall = codexRunner.calls.first!
        XCTAssertTrue(codexCall.command.contains(#"&& sh "$ENGELBART_INSTALLER""#))
        XCTAssertEqual(codexCall.env["CODEX_NON_INTERACTIVE"], "1")
        XCTAssertEqual(codexCall.env["ENGELBART_INSTALLER_URL"], "https://chatgpt.com/codex/install.sh")
    }

    func testInstallAgentTimeoutAndSilentShell() async {
        let runner = TableRunner()
        runner.shellOverride = { _, _ in ExecResult(code: nil, timedOut: true, marked: false) }
        let out = await ToolInstaller(runner: runner, tmpDir: temp()).installAgent("claude")
        XCTAssertEqual(out.error, "The installer had not finished after 10 minutes.")
        runner.shellOverride = { _, _ in ExecResult(code: 0, marked: false) }
        let silent = await ToolInstaller(runner: runner, tmpDir: temp()).installAgent("claude")
        XCTAssertEqual(silent.error, shellSilent(runner))
    }

    func testUpdatesUseTheCLIsOwnUpdaterAndGitIsNeverOurs() async {
        let runner = TableRunner(shell: [("update", A(TableRunner.ok("Updated")))])
        let actions = ToolInstaller(runner: runner, tmpDir: temp())
        let out = await actions.updateAgent("codex", "/opt/homebrew/bin/codex")
        XCTAssertTrue(out.ok)
        XCTAssertEqual(runner.calls.first?.command, #"exec "$ENGELBART_TOOL" update < /dev/null 2>&1"#)
        XCTAssertEqual(runner.calls.first?.env, ["ENGELBART_TOOL": "/opt/homebrew/bin/codex", "CODEX_NON_INTERACTIVE": "1"])
        let bundled = await actions.updateGit("bundled")
        XCTAssertEqual(bundled.error, "This Git came with Engelbart and is updated with it.")
        let apple = await actions.updateGit("apple")
        XCTAssertEqual(apple.error, "Apple’s Git is updated by macOS: System Settings › General › Software Update.")
        let brew = TableRunner(shell: [("brew upgrade git", A(TableRunner.ok("Error: brew is locked", code: 1)))])
        let failed = await ToolInstaller(runner: brew).updateGit("homebrew")
        XCTAssertEqual(failed.kind, "package-manager")
    }

    final class Clock: @unchecked Sendable {
        let lock = NSLock()
        var value: TimeInterval = 0
        func get() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
        func add(_ t: TimeInterval) { lock.lock(); value += t; lock.unlock() }
        func set(_ t: TimeInterval) { lock.lock(); value = t; lock.unlock() }
    }

    func testInstallGitAppleDialogThenWaiting() async {
        freeBytesProvider = { _ in 1e9 * 4096 }
        let developer = "\(temp())/CommandLineTools"
        let clock = Clock()
        let arrived = ToolInstaller(runner: TableRunner(exec: [
            "/usr/bin/xcode-select --install": A(TableRunner.ok("xcode-select: note: install requested for command line developer tools")),
            "/usr/bin/xcode-select -p": A(make: {
                if clock.get() >= 15 { write("\(developer)/usr/bin/git", "", mode: 0o755); return TableRunner.ok(developer) }
                return TableRunner.ok("", code: 2)
            }),
            "/usr/bin/pgrep": A(TableRunner.ok("")),
        ]), sleep: { clock.add($0) }, now: { clock.get() })
        final class Phases: @unchecked Sendable { var list: [String] = [] }
        let phases = Phases()
        let out = await arrived.installGit { phases.list.append($0) }
        XCTAssertEqual(out, .done)
        XCTAssertEqual(phases.list, ["Waiting for Apple’s installer"])
        clock.set(0)
        let closed = ToolInstaller(runner: TableRunner(exec: [
            "/usr/bin/xcode-select --install": A(TableRunner.ok("install requested")), "/usr/bin/xcode-select -p": A(TableRunner.ok("", code: 2)),
            "/usr/bin/pgrep": A(make: { TableRunner.ok("", code: clock.get() < 10 ? 0 : 1) }),
        ]), sleep: { clock.add($0) }, now: { clock.get() })
        let cancelled = await closed.installGit { _ in }
        XCTAssertEqual([cancelled.ok ? "ok" : "no", cancelled.kind], ["no", "cancelled"])
        XCTAssertEqual(cancelled.error, "Apple’s installer was closed before it finished.")
        clock.set(0)
        let never = ToolInstaller(runner: TableRunner(exec: [
            "/usr/bin/xcode-select --install": A(TableRunner.ok("install requested")), "/usr/bin/xcode-select -p": A(TableRunner.ok("", code: 2)),
            "/usr/bin/pgrep": A(TableRunner.ok("", code: 1)),
        ]), sleep: { clock.add($0) }, now: { clock.get() })
        let notOpened = await never.installGit { _ in }
        XCTAssertEqual(notOpened.error, "Apple’s installer did not open.")
        let refused = ToolInstaller(runner: TableRunner(exec: ["/usr/bin/xcode-select --install": A(TableRunner.ok("", code: 1, stderr: "xcode-select: error: command line tools are already installed"))]),
                                    sleep: { clock.add($0) }, now: { clock.get() })
        let already = await refused.installGit { _ in }
        XCTAssertNotEqual(already.kind, "cancelled", "already installed but no git: it waits for Apple's installer like any other")
    }

    func testRollbackPointsALauncherBackInOneRename() {
        let home = temp()
        let versions = "\(home)/.local/share/claude/versions"
        for v in ["2.1.280", "2.1.281"] { write("\(versions)/\(v)", v) }
        mkdirs("\(home)/.local/bin")
        let launcher = "\(home)/.local/bin/claude"
        try! FileManager.default.createSymbolicLink(atPath: launcher, withDestinationPath: "\(versions)/2.1.280")
        let mark = markRollback("claude", RollbackOptions(home: home, env: [:]))
        XCTAssertEqual(mark?.target, "\(versions)/2.1.280")
        try! FileManager.default.removeItem(atPath: launcher)
        try! FileManager.default.createSymbolicLink(atPath: launcher, withDestinationPath: "\(versions)/2.1.281") // the update moved it
        XCTAssertTrue(rollback(mark))
        XCTAssertEqual(try? String(contentsOfFile: launcher, encoding: .utf8), "2.1.280")
        XCTAssertNil(markRollback("claude", RollbackOptions(home: temp(), env: [:])), "no launcher, nothing to go back to")
        XCTAssertNil(markRollback("git", RollbackOptions(home: home, env: [:])))
        XCTAssertEqual(rollbackPoint("codex", RollbackOptions(home: "/Users/h", env: ["CODEX_HOME": "/x"])), "/x/packages/standalone/current")
        XCTAssertFalse(rollback(nil))
    }

    func testTheLockRunsShareAnUpdateWaitsAndHoldsNewRuns() async {
        let lock = ToolLock()
        final class Order: @unchecked Sendable { let l = NSLock(); var items: [String] = []; func add(_ s: String) { l.lock(); items.append(s); l.unlock() }; var all: [String] { l.lock(); defer { l.unlock() }; return items } }
        let order = Order()
        let release = Once<Void>()
        let started = Once<Void>()
        let run = Task { await lock.shared { order.add("run starts"); started.resolve(()); await release.wait(); order.add("run ends") } }
        await started.wait()
        let update = Task { await lock.exclusive { order.add("update") } }
        while lock.state.waiting < 1 { await Task.yield() }
        let later = Task { await lock.shared { order.add("later run") } }
        while lock.state.waiting < 2 { await Task.yield() }
        XCTAssertEqual(order.all, ["run starts"], "the update waits for the run, the later run waits for the update")
        release.resolve(())
        _ = await (run.value, update.value, later.value)
        XCTAssertEqual(order.all, ["run starts", "run ends", "update", "later run"])
    }

    func testFindBundledGit() {
        let resources = temp()
        let appRoot = temp()
        XCTAssertNil(BundledGit.find(resourcesPath: resources, appRoot: appRoot, platform: "darwin", override: ""), "neither")
        let inCheckout = "\(appRoot)/vendor/git/darwin-arm64/\(BUNDLED_GIT_LAUNCHER)"
        write(inCheckout, "#!/bin/sh\n", mode: 0o755)
        XCTAssertEqual(BundledGit.find(resourcesPath: resources, appRoot: appRoot, arch: "arm64", platform: "darwin", override: ""), inCheckout)
        XCTAssertNil(BundledGit.find(resourcesPath: resources, appRoot: appRoot, arch: "x64", platform: "darwin", override: ""), "the other architecture's is not used")
        let inApp = "\(resources)/git/\(BUNDLED_GIT_LAUNCHER)"
        write(inApp, "#!/bin/sh\n", mode: 0o644)
        XCTAssertEqual(BundledGit.find(resourcesPath: resources, appRoot: appRoot, arch: "arm64", platform: "darwin", override: ""), inCheckout, "not executable: passed over")
        chmod(inApp, 0o755)
        XCTAssertEqual(BundledGit.find(resourcesPath: resources, appRoot: appRoot, arch: "arm64", platform: "darwin", override: ""), inApp)
        XCTAssertNil(BundledGit.find(resourcesPath: resources, appRoot: appRoot, arch: "arm64", platform: "win32", override: ""), "Macs only, for now")
        XCTAssertEqual(BundledGit.find(resourcesPath: nil, appRoot: nil, platform: "darwin", override: "\(resources)/git"), inApp, "ENGELBART_BUNDLED_GIT")
    }

    func testInspectRepositoryReadsEveryCaseBuildMustHandle() throws {
        guard FileManager.default.isExecutableFile(atPath: "/Applications/Xcode.app/Contents/Developer/usr/bin/git") || FileManager.default.isExecutableFile(atPath: "/Library/Developer/CommandLineTools/usr/bin/git") else {
            throw XCTSkip("no developer tools git on this Mac")
        }
        func git(_ cwd: String, _ args: String...) -> String {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: cwd)
            var env = ProcessInfo.processInfo.environment
            for (k, v) in ["GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "t@example.invalid"] { env[k] = v }
            p.environment = env
            let out = Pipe()
            p.standardOutput = out
            p.standardError = Pipe()
            try! p.run()
            p.waitUntilExit()
            return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let plain = temp()
        XCTAssertEqual(inspectRepository(plain).problems.map(\.code), ["not-a-repository"])
        XCTAssertEqual(inspectRepository(plain).problems.first?.message, "This folder has no history yet.")

        let repo = temp()
        _ = git(repo, "init", "-q", "-b", "main")
        XCTAssertEqual([inspectRepository(repo).repository, inspectRepository(repo).commits], [true, false])
        XCTAssertEqual(inspectRepository(repo).branch, "main")
        XCTAssertEqual(inspectRepository(repo).problems.map(\.code), ["no-commits"])
        write("\(repo)/a.txt", "a")
        _ = git(repo, "add", ".")
        _ = git(repo, "commit", "-qm", "first")
        let ready = inspectRepository(repo)
        XCTAssertEqual([ready.commits, ready.detached, ready.locked], [true, false, false])
        XCTAssertNil(ready.operation)
        XCTAssertEqual(ready.problems, [])
        XCTAssertGreaterThan(ready.freeBytes ?? 0, 0)
        mkdirs("\(repo)/deep/er")
        XCTAssertEqual(inspectRepository("\(repo)/deep/er").top, repo, "a folder inside the repository finds its top")

        _ = git(repo, "pack-refs", "--all")
        XCTAssertTrue(inspectRepository(repo).commits, "a branch only in packed-refs still has commits")

        write("\(repo)/.git/index.lock", "")
        write("\(repo)/.git/MERGE_HEAD", git(repo, "rev-parse", "HEAD"))
        XCTAssertEqual(inspectRepository(repo).problems.map(\.code), ["operation", "locked"])
        XCTAssertEqual(inspectRepository(repo).problems.map(\.message), ["A merge is not finished in this folder.", "Git left a lock file (.git/index.lock), usually after a crash."])
        try FileManager.default.removeItem(atPath: "\(repo)/.git/index.lock")
        try FileManager.default.removeItem(atPath: "\(repo)/.git/MERGE_HEAD")

        _ = git(repo, "checkout", "-q", "--detach")
        XCTAssertEqual(inspectRepository(repo).detached, true)
        XCTAssertEqual(inspectRepository(repo).problems.map(\.code), ["detached"])
        _ = git(repo, "checkout", "-q", "main")

        write("\(repo)/.gitmodules", "[submodule \"x\"]\n")
        write("\(repo)/.gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n")
        XCTAssertEqual([inspectRepository(repo).submodules, inspectRepository(repo).lfs], [true, true])

        let linked = "\(temp())/linked"
        _ = git(repo, "worktree", "add", "-q", "-b", "engelbart/test", linked)
        let worktree = inspectRepository(linked)
        XCTAssertEqual(worktree.repository, true)
        XCTAssertEqual(worktree.branch, "engelbart/test")
        XCTAssertEqual(worktree.commits, true, "a linked worktree reads through its .git file")
    }
}
