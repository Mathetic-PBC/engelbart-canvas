import XCTest
@testable import EngelbartTerminal

// test/shell-rc.test.cjs. Every shell here runs detached (a session of its own, no controlling terminal): run from a
// terminal, an interactive zsh reads that terminal's keyboard instead of the input it is given.

final class ShellRCTests: XCTestCase {
    var hasZsh: Bool { FileManager.default.isExecutableFile(atPath: "/bin/zsh") }

    func testTheWrappersAreWrittenOnceAndSessionsLaunchThroughAnExecutableLauncher() throws {
        let userData = temporaryDirectory(self) + "/Application Support/Engelbart Swift"
        let dir = try ShellRC.prepareZshDir(userData: userData)
        XCTAssertEqual(dir, userData + "/zsh")
        for name in [".zshenv", ".zprofile", ".zshrc"] { XCTAssertTrue(FileManager.default.fileExists(atPath: dir + "/" + name), name) }
        let rc = try String(contentsOfFile: dir + "/.zshrc")
        XCTAssertTrue(rc.contains(#"source "$ZDOTDIR/.zshrc""#))
        XCTAssertTrue(rc.contains("precmd_functions+=(engelbart_precmd)"))
        XCTAssertTrue(rc.contains("preexec_functions+=(engelbart_preexec)"))
        let before = try FileManager.default.attributesOfItem(atPath: dir + "/.zshrc")[.modificationDate] as! Date
        Thread.sleep(forTimeInterval: 0.02)
        try ShellRC.prepareZshDir(userData: userData)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: dir + "/.zshrc")[.modificationDate] as! Date, before, "unchanged files are not rewritten")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: dir + "/.zshrc")[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        let env = try ShellRC.environmentForSessions(["PATH": "/usr/bin:/bin", "HOME": "/tmp/x", "SHELL": "/bin/zsh", "CLAUDE_CODE_CHILD_SESSION": "1",
                                                      "CLAUDE_CODE_MESSAGING_TOKEN": "t", "CLAUDE_PID": "9", "CLAUDE_VAULT": "mine", "ANTHROPIC_API_KEY": "k",
                                                      "CODEX_SANDBOX": "seatbelt", "CLAUDE_EFFORT": "high"], userData: userData)
        XCTAssertEqual(env["SHELL"], userData + "/shell/zsh")
        XCTAssertNil(env["CLAUDE_CODE_CHILD_SESSION"]); XCTAssertNil(env["CLAUDE_CODE_MESSAGING_TOKEN"]); XCTAssertNil(env["CLAUDE_PID"])
        XCTAssertNil(env["CODEX_SANDBOX"]); XCTAssertNil(env["CLAUDE_EFFORT"])
        XCTAssertEqual(env["CLAUDE_VAULT"], "mine"); XCTAssertEqual(env["ANTHROPIC_API_KEY"], "k")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: env["SHELL"]!), "launcher is executable")
        let spec = try Launch.createLaunchSpec(.init(provider: "shell", cwd: userData, cols: 80, rows: 24), sourceEnvironment: env)
        XCTAssertEqual(spec.file, env["SHELL"], "the launch rules accept the launcher as the shell")
        XCTAssertEqual(spec.args, ["-il"])
        XCTAssertEqual(spec.env["TERMINAL_USER_SHELL"], env["SHELL"], "the shell that follows an agent uses it too")
    }

    func testThroughTheLauncherZshRunsUserRcFilesHidesThePromptEmitsMarksAndRestoresZdotdirAndShell() throws {
        try XCTSkipUnless(hasZsh)
        let userData = temporaryDirectory(self) + "/Application Support/Engelbart Swift"
        let home = temporaryDirectory(self)
        write("export FROM_ZSHENV=1\n", to: home + "/.zshenv")
        write("export FROM_ZPROFILE=1\n", to: home + "/.zprofile")
        write("export FROM_ZSHRC=1\nPROMPT='user> '\nRPROMPT='right'\nmy_prompt() { PROMPT='again> ' }\nprecmd_functions+=(my_prompt)\n", to: home + "/.zshrc")
        let launcher = try ShellRC.prepareLauncher(userData: userData, realShell: "/bin/zsh")
        let script = [
            "for f in $precmd_functions; do $f; done",
            #"for f in $preexec_functions; do $f "echo hi; ls"; done"#,
            #"print -r -- "env=$FROM_ZSHENV$FROM_ZPROFILE$FROM_ZSHRC prompt=[$PROMPT] rprompt=[$RPROMPT] zdotdir=[${ZDOTDIR-unset}] shell=[$SHELL]""#,
        ].joined(separator: "; ")
        let result = spawnDetached(launcher, ["-ilc", script], env: ["HOME": home, "PATH": "/usr/bin:/bin", "TERM": "dumb"], cwd: home)
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertTrue(result.stdout.contains("env=111 prompt=[] rprompt=[] zdotdir=[unset] shell=[/bin/zsh]"), result.stdout)
        XCTAssertTrue(result.stdout.contains("\u{1b}]633;P;Cwd=\(home)\u{07}\u{1b}]633;A\u{07}"), "prompt mark with the directory: \(result.stdout.debugDescription)")
        XCTAssertTrue(result.stdout.contains("\u{1b}]633;E;echo hi; ls\u{07}\u{1b}]633;C\u{07}"), "command mark with the command line")
    }

    func testTheShellThatReplacesAnAgentWhenItExitsIsIntegratedToo() throws {
        try XCTSkipUnless(hasZsh)
        let userData = temporaryDirectory(self)
        let home = temporaryDirectory(self)
        write("PROMPT='user> '\n", to: home + "/.zshrc")
        let launcher = try ShellRC.prepareLauncher(userData: userData, realShell: "/bin/zsh")
        // What the launch rules run for Claude Code / Codex: `<agent>; …; exec "$TERMINAL_USER_SHELL" -il`.
        let result = spawnDetached(launcher, ["-ilc", #"true; exec "$TERMINAL_USER_SHELL" -il"#],
                                   env: ["HOME": home, "PATH": "/usr/bin:/bin", "TERM": "dumb", "TERMINAL_USER_SHELL": launcher],
                                   input: "print -r -- \"prompt=[$PROMPT]\"\nexit\n")
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertTrue(result.stdout.contains("\u{1b}]633;A\u{07}"), "ready mark from the follow-up shell")
        XCTAssertTrue(result.stdout.contains("prompt=[]"), result.stdout)
    }

    func testAZdotdirTheUserSetsInZshenvIsHonouredAndHandedBack() throws {
        try XCTSkipUnless(hasZsh)
        let userData = temporaryDirectory(self)
        let home = temporaryDirectory(self)
        let custom = home + "/.config/zsh"
        write("export ZDOTDIR=\"\(custom)\"\n", to: home + "/.zshenv")
        write("export FROM_CUSTOM=1\n", to: custom + "/.zshrc")
        let launcher = try ShellRC.prepareLauncher(userData: userData, realShell: "/bin/zsh")
        let result = spawnDetached(launcher, ["-ilc", #"print -r -- "custom=$FROM_CUSTOM zdotdir=[$ZDOTDIR]""#], env: ["HOME": home, "PATH": "/usr/bin:/bin", "TERM": "dumb"])
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertTrue(result.stdout.contains("custom=1 zdotdir=[\(custom)]"), result.stdout)
    }

    func testEngelbartsOwnGitComesFirstOnPathAfterStartupFilesRebuiltItAndOnlyWhileItStandsIn() throws {
        try XCTSkipUnless(hasZsh)
        let userData = temporaryDirectory(self)
        let home = temporaryDirectory(self)
        let bin = temporaryDirectory(self) + "/Application Support/engelbart-bin"
        write("#!/bin/sh\necho engelbart-git\n", to: bin + "/git", mode: 0o755)
        write("export PATH=/usr/bin:/bin:/usr/sbin:/sbin\n", to: home + "/.zshrc")
        let env = ["HOME": home, "PATH": "\(bin):/usr/bin:/bin", "TERM": "dumb", "ENGELBART_GIT_BIN": bin]
        let hidden = spawnDetached("/bin/zsh", Launch.loginShellArgs("/bin/zsh", "command -v git", environment: env), env: env)
        XCTAssertEqual(hidden.status, 0, hidden.stderr)
        XCTAssertEqual(hidden.stdout.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last, bin + "/git", "a hidden run (@bart, Build, summaries)")
        let launcher = try ShellRC.prepareLauncher(userData: userData, realShell: "/bin/zsh")
        let terminal = spawnDetached(launcher, ["-il"], env: env, input: "command -v git\nexit\n")
        XCTAssertEqual(terminal.status, 0, terminal.stderr)
        XCTAssertTrue(terminal.stdout.contains(bin + "/git"), "the terminal: \(terminal.stdout)")
        let without = ["HOME": home, "PATH": "\(bin):/usr/bin:/bin", "TERM": "dumb"]
        XCTAssertEqual(Launch.loginShellArgs("/bin/zsh", "command -v git", environment: without), ["-ilc", "command -v git"])
        let own = spawnDetached(launcher, ["-il"], env: without, input: "command -v git\nexit\n")
        XCTAssertFalse(own.stdout.contains(bin + "/git"), own.stdout)
    }

    func testAnAgentWhoseFolderThePathMissesIsFoundByNameInTheTerminalAndInHiddenRuns() throws {
        try XCTSkipUnless(hasZsh)
        let userData = temporaryDirectory(self)
        let home = temporaryDirectory(self)
        let bin = home + "/.local/bin"
        write("#!/bin/sh\necho engelbart-claude\n", to: bin + "/claude", mode: 0o755)
        write("export PATH=/usr/bin:/bin:/usr/sbin:/sbin\n", to: home + "/.zshrc") // a new account's: no ~/.local/bin
        let env = ["HOME": home, "PATH": "/usr/bin:/bin", "TERM": "dumb", "ENGELBART_AGENT_PATH": bin]
        let hidden = spawnDetached("/bin/zsh", Launch.loginShellArgs("/bin/zsh", "command -v claude", environment: env), env: env)
        XCTAssertEqual(hidden.stdout.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last, bin + "/claude", hidden.stderr)
        let launcher = try ShellRC.prepareLauncher(userData: userData, realShell: "/bin/zsh")
        let terminal = spawnDetached(launcher, ["-il"], env: env, input: "command -v claude\nexit\n")
        XCTAssertEqual(terminal.status, 0, terminal.stderr)
        XCTAssertTrue(terminal.stdout.contains(bin + "/claude"), "the terminal: \(terminal.stdout)")
        let without = spawnDetached(launcher, ["-il"], env: ["HOME": home, "PATH": "/usr/bin:/bin", "TERM": "dumb"], input: "command -v claude || echo none\nexit\n")
        XCTAssertFalse(without.stdout.contains(bin + "/claude"), without.stdout)
    }

    func testBashLauncherReadsTheInitFileOnlyForATerminalsOwnShell() throws {
        let userData = temporaryDirectory(self) + "/with space"
        let home = temporaryDirectory(self)
        write("export FROM_PROFILE=1\nexport PATH=/usr/bin:/bin\n", to: home + "/.bash_profile")
        let bin = home + "/.local/bin"
        write("#!/bin/sh\necho engelbart-claude\n", to: bin + "/claude", mode: 0o755)
        let launcher = try ShellRC.prepareLauncher(userData: userData, realShell: "/bin/bash")
        XCTAssertEqual(launcher, userData + "/shell/bash")
        XCTAssertTrue(FileManager.default.fileExists(atPath: userData + "/bash/init.bash"))
        let env = ["HOME": home, "PATH": "/usr/bin:/bin", "TERM": "dumb", "ENGELBART_AGENT_PATH": bin]
        let terminal = spawnDetached(launcher, ["-il"], env: env, input: "echo \"p=$FROM_PROFILE shell=$SHELL\"; command -v claude\nexit\n")
        XCTAssertEqual(terminal.status, 0, terminal.stderr)
        XCTAssertTrue(terminal.stdout.contains("p=1 shell=/bin/bash"), terminal.stdout)
        XCTAssertTrue(terminal.stdout.contains(bin + "/claude"), terminal.stdout)
        let command = spawnDetached(launcher, ["-c", "echo ran"], env: env)
        XCTAssertEqual(command.stdout, "ran\n")
    }

    // shell-history.cjs

    func testShellHistoryExtendedPrefixesContinuationLinesMetafiedBytesLatestUseOrder() throws {
        XCTAssertEqual(ShellHistory.parse(": 1700000000:0;ls -la\n: 1700000001:0;git status\n: 1700000002:0;ls -la\nplain command\n"), ["git status", "ls -la", "plain command"])
        XCTAssertEqual(ShellHistory.parse(": 1:0;echo one \\\ntwo\n: 2:0;pwd\n"), ["echo one \ntwo", "pwd"])
        XCTAssertEqual(ShellHistory.parse("a\nb\nc\nd\n", limit: 2), ["c", "d"])
        XCTAssertEqual(String(decoding: ShellHistory.unmetafy([0x63, 0x83, 0xc3 ^ 0x20, 0x83, 0xa9 ^ 0x20]), as: UTF8.self), "cé")
        XCTAssertEqual(ShellHistory.parse(String(repeating: "x", count: 2001) + "\nok\n"), ["ok"], "entries over 2000 characters are dropped")
        let home = temporaryDirectory(self)
        write(": 1:0;first\n: 2:0;second\n", to: home + "/.zsh_history")
        XCTAssertEqual(ShellHistory.read(homeDir: home, environment: [:]), ["first", "second"])
        XCTAssertEqual(ShellHistory.read(homeDir: home + "/missing", environment: [:]), [])
        write("from-histfile\n", to: home + "/custom_history")
        XCTAssertEqual(ShellHistory.read(homeDir: home, environment: ["HISTFILE": home + "/custom_history"]), ["from-histfile"])
    }

    func testShellHistoryReadsOnlyTheTailAndDropsThePartialFirstLine() throws {
        let home = temporaryDirectory(self)
        var text = ""
        var n = 0
        while text.utf8.count < 600 * 1024 { text += ": \(n):0;command-\(n)\n"; n += 1 }
        write(text, to: home + "/.zsh_history")
        let list = ShellHistory.read(homeDir: home, environment: [:], limit: 100_000)
        XCTAssertEqual(list.last, "command-\(n - 1)")
        XCTAssertTrue(list.allSatisfy { $0.hasPrefix("command-") }, "no partial first line")
        XCTAssertLessThan(list.count, n)
    }
}
