import EngelbartCore
import XCTest
@testable import EngelbartTerminal

// test/launch.test.cjs

final class LaunchTests: XCTestCase {
    func testSanitizeEnvironmentRemovesHostTransientsWithoutChangingItsSource() {
        let source: [String: String] = [
            "HOME": "/Users/tester", "LANG": "en_US.UTF-8", "SSH_AUTH_SOCK": "/private/tmp/ssh.sock",
            "CODEX_HOME": "/Users/tester/.codex-custom", "CLAUDE_CONFIG_DIR": "/Users/tester/.claude-custom",
            "ANTHROPIC_API_KEY": "preserve-anthropic-key", "OPENAI_API_KEY": "preserve-openai-key",
            "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "parent", "CLAUDE_CODE_SESSION_ID": "claude-session", "CLAUDE_AGENT_ID": "agent",
            "CLAUDE_PARENT_SESSION_ID": "parent-session", "CODEX_SESSION_ID": "codex-session", "CODEX_THREAD_ID": "codex-thread",
            "CODEX_CI": "1", "CODEX_VERSION": "9.9.9", "ELECTRON_RUN_AS_NODE": "1", "ELECTRON_NO_ATTACH_CONSOLE": "1",
            "NODE_CHANNEL_FD": "3", "NODE_UNIQUE_ID": "worker", "NODE_OPTIONS": "--inspect=9229", "INSPECT_BRK": "1",
            "WARP_IS_LOCAL_SHELL_SESSION": "1", "NO_COLOR": "1", "TERM": "dumb",
        ]
        let original = source
        let result = Launch.sanitizeEnvironment(source)
        XCTAssertEqual(source, original)
        XCTAssertEqual(result["HOME"], "/Users/tester")
        XCTAssertEqual(result["LANG"], "en_US.UTF-8")
        XCTAssertEqual(result["SSH_AUTH_SOCK"], "/private/tmp/ssh.sock")
        XCTAssertEqual(result["CODEX_HOME"], "/Users/tester/.codex-custom")
        XCTAssertEqual(result["CLAUDE_CONFIG_DIR"], "/Users/tester/.claude-custom")
        XCTAssertEqual(result["ANTHROPIC_API_KEY"], "preserve-anthropic-key")
        XCTAssertEqual(result["OPENAI_API_KEY"], "preserve-openai-key")
        for key in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_ID", "CLAUDE_PARENT_SESSION_ID",
                    "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_VERSION", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE",
                    "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "NODE_OPTIONS", "INSPECT_BRK", "WARP_IS_LOCAL_SHELL_SESSION", "NO_COLOR"] {
            XCTAssertNil(result[key], "\(key) should be removed")
        }
        XCTAssertEqual(result["TERM"], "xterm-256color")
        XCTAssertEqual(result["COLORTERM"], "truecolor")
        XCTAssertEqual(result["TERM_PROGRAM"], "Engelbart")
        XCTAssertEqual(result["TERM_PROGRAM_VERSION"], "0.1.0")
    }

    func testSanitizeEnvironmentRemovesDynamicElectronInspectorAndWarpVariables() {
        let result = Launch.sanitizeEnvironment(["ELECTRON_ENABLE_LOGGING": "1", "NODE_INSPECT_RESUME_ON_START": "1", "INSPECTOR_PORT": "9230",
                                                 "WARP_HONOR_PS1": "1", "USER_SETTING": "retained"])
        XCTAssertNil(result["ELECTRON_ENABLE_LOGGING"])
        XCTAssertNil(result["NODE_INSPECT_RESUME_ON_START"])
        XCTAssertNil(result["INSPECTOR_PORT"])
        XCTAssertNil(result["WARP_HONOR_PS1"])
        XCTAssertEqual(result["USER_SETTING"], "retained")
        XCTAssertEqual(Launch.sanitizeEnvironment(["NODE_OPTIONS": "--max-old-space-size=4096"])["NODE_OPTIONS"], "--max-old-space-size=4096")
        XCTAssertNil(Launch.sanitizeEnvironment(["NODE_OPTIONS": "--foo --inspect-brk"])["NODE_OPTIONS"])
    }

    func testSanitizeEnvironmentSuppliesAUTF8LocaleOnlyWhenTheParentHasNone() {
        XCTAssertEqual(Launch.sanitizeEnvironment(["HOME": "/Users/tester"])["LANG"], "en_US.UTF-8")
        XCTAssertEqual(Launch.sanitizeEnvironment(["LANG": "de_DE.UTF-8"])["LANG"], "de_DE.UTF-8")
        XCTAssertNil(Launch.sanitizeEnvironment(["LC_ALL": "C.UTF-8"])["LANG"])
    }

    func testValidateCreateRequestRejectsProviderTextOutsideTheFixedEnum() {
        let cwd = temporaryDirectory(self)
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "claude; touch /tmp/pwned", cwd: cwd, cols: 80, rows: 24))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Unknown provider")
        }
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "sandbox", cwd: cwd, cols: 80, rows: 24)), "sandbox only through createSandbox")
    }

    func testValidateCreateRequestRequiresAnExistingDirectoryAndBoundedDimensions() throws {
        let cwd = temporaryDirectory(self)
        let file = cwd + "/not-a-directory"
        write("fixture", to: file)
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "shell", cwd: cwd + "/missing", cols: 80, rows: 24))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Working directory does not exist")
        }
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "shell", cwd: file, cols: 80, rows: 24))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Working directory must be a directory")
        }
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "shell", cwd: "", cols: 80, rows: 24))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Working directory must be a valid path")
        }
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "shell", cwd: cwd, cols: 0, rows: 24))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "cols must be an integer between 2 and 500")
        }
        XCTAssertThrowsError(try Launch.validateCreateRequest(.init(provider: "shell", cwd: cwd, cols: 80, rows: 1001))) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "rows must be an integer between 1 and 500")
        }
        XCTAssertEqual(try Launch.validateCreateRequest(.init(provider: "codex", cwd: cwd, cols: 120, rows: 40)),
                       Launch.Validated(provider: .codex, cwd: cwd, cols: 120, rows: 40))
        XCTAssertEqual(try Launch.validateCreateRequest(.init(provider: "shell", cwd: cwd + "/./", cols: 80, rows: 24)).cwd, cwd, "path.resolve")
    }

    func testCreateLaunchSpecUsesLoginInteractiveShellArgsAndFixedProviderCommands() throws {
        let cwd = temporaryDirectory(self)
        let environment = ["HOME": cwd, "SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin"]
        let shell = try Launch.createLaunchSpec(.init(provider: "shell", cwd: cwd, cols: 80, rows: 24), sourceEnvironment: environment)
        XCTAssertEqual(shell.file, "/bin/zsh")
        XCTAssertEqual(shell.args, ["-il"])
        XCTAssertEqual(shell.cwd, cwd)

        let claude = try Launch.createLaunchSpec(.init(provider: "claude", cwd: cwd, cols: 80, rows: 24), sourceEnvironment: environment)
        XCTAssertEqual(claude.file, "/bin/zsh")
        XCTAssertEqual(Array(claude.args.prefix(2)), ["-ilc", #"unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; if [ -n "${ENGELBART_CLAUDE_BIN:-}" ]; then "$ENGELBART_CLAUDE_BIN"; else claude; fi; provider_status=$?; printf "\r\n[Claude Code exited with status %d]\r\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il"#])
        XCTAssertEqual(claude.env["TERMINAL_USER_SHELL"], "/bin/zsh")

        let codex = try Launch.createLaunchSpec(.init(provider: "codex", cwd: cwd, cols: 80, rows: 24), sourceEnvironment: environment)
        XCTAssertEqual(Array(codex.args.prefix(2)), ["-ilc", #"unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; if [ -n "${ENGELBART_CODEX_BIN:-}" ]; then "$ENGELBART_CODEX_BIN"; else codex; fi; provider_status=$?; printf "\r\n[Codex exited with status %d]\r\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il"#])
    }

    func testAnAgentStartedFromTheTerminalGetsEngelbartsOwnGitFirstOnPath() throws {
        let cwd = temporaryDirectory(self)
        let environment = ["HOME": cwd, "SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin", "ENGELBART_GIT_BIN": "/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin"]
        let claude = try Launch.createLaunchSpec(.init(provider: "claude", cwd: cwd, cols: 80, rows: 24), sourceEnvironment: environment)
        XCTAssertEqual(claude.args[0], "-ilc")
        XCTAssertTrue(claude.args[1].hasPrefix(#"PATH="$ENGELBART_GIT_BIN:$PATH"; unset CLAUDECODE "#), claude.args[1])
        XCTAssertEqual(claude.env["ENGELBART_GIT_BIN"], environment["ENGELBART_GIT_BIN"])
        XCTAssertEqual(try Launch.createLaunchSpec(.init(provider: "shell", cwd: cwd, cols: 80, rows: 24), sourceEnvironment: environment).args, ["-il"])
        XCTAssertEqual(Launch.loginShellArgs("/usr/local/bin/fish", "codex", environment: environment), ["--login", "--interactive", "--command", "set -gx PATH $ENGELBART_GIT_BIN $PATH; codex"])
        XCTAssertEqual(Launch.loginShellArgs("/bin/bash", "codex", environment: environment), ["-ilc", #"PATH="$ENGELBART_GIT_BIN:$PATH"; codex"#])
    }

    func testAgentFoldersTheLoginPathMissesGoLastOnPath() throws {
        let cwd = temporaryDirectory(self)
        let environment = ["HOME": cwd, "SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin", "ENGELBART_AGENT_PATH": "\(cwd)/.local/bin"]
        let claude = try Launch.createLaunchSpec(.init(provider: "claude", cwd: cwd, cols: 80, rows: 24), sourceEnvironment: environment)
        XCTAssertTrue(claude.args[1].hasPrefix(#"PATH="$PATH:$ENGELBART_AGENT_PATH"; unset CLAUDECODE "#), claude.args[1])
        XCTAssertEqual(claude.env["ENGELBART_AGENT_PATH"], environment["ENGELBART_AGENT_PATH"])
        XCTAssertEqual(Launch.loginShellArgs("/bin/zsh", "codex", environment: environment.merging(["ENGELBART_GIT_BIN": "/git/bin"]) { _, b in b }),
                       ["-ilc", #"PATH="$ENGELBART_GIT_BIN:$PATH"; PATH="$PATH:$ENGELBART_AGENT_PATH"; codex"#])
        XCTAssertEqual(Launch.loginShellArgs("/usr/local/bin/fish", "codex", environment: environment),
                       ["--login", "--interactive", "--command", "set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); codex"])
        XCTAssertEqual(Launch.loginShellArgs("/bin/zsh", "codex", environment: ["HOME": cwd]), ["-ilc", "codex"])
    }

    func testResolveShellPrefersASupportedExecutableShell() throws {
        XCTAssertEqual(try Launch.resolveShell(["SHELL": "/bin/bash"]), "/bin/bash")
        XCTAssertEqual(try Launch.resolveShell(["SHELL": "/bin/sh"]), "/bin/zsh", "sh is not supported")
        XCTAssertEqual(try Launch.resolveShell(["SHELL": "zsh"]), "/bin/zsh", "relative is not taken")
        XCTAssertEqual(try Launch.resolveShell([:]), "/bin/zsh")
    }

    func testFishProviderScriptUsesFishSyntax() throws {
        let args = Launch.shellArguments("/opt/homebrew/bin/fish", .codex, environment: [:])
        XCTAssertEqual(args[0...2], ["--login", "--interactive", "--command"])
        XCTAssertTrue(args[3].hasPrefix("set -e CLAUDECODE "))
        XCTAssertTrue(args[3].hasSuffix(#"exec "$TERMINAL_USER_SHELL" --login --interactive"#))
        XCTAssertEqual(Launch.shellArguments("/opt/homebrew/bin/fish", .shell, environment: [:]), ["--login", "--interactive"])
    }

    // settings.cjs

    func testNormalizeSettingsClampsCorruptPersistedValuesToAppOwnedDefaults() {
        let home = temporaryDirectory(self)
        XCTAssertEqual(TerminalSettings.normalize(["fontSize": 999, "lastCwd": "/missing/path", "sidebarVisible": "yes"], home: home),
                       TerminalSettings(fontSize: 14, lastCwd: home, sidebarVisible: true))
        XCTAssertEqual(TerminalSettings.normalize(["fontSize": 12.5], home: home).fontSize, 14, "not an integer")
        XCTAssertEqual(TerminalSettings.normalize(nil, home: home), TerminalSettings(fontSize: 14, lastCwd: home, sidebarVisible: true))
    }

    func testMergeSettingsAcceptsOnlySupportedKeysAndValidatesTheWorkingDirectory() throws {
        let home = temporaryDirectory(self)
        let cwd = temporaryDirectory(self)
        let current = TerminalSettings(fontSize: 14, lastCwd: home, sidebarVisible: true)
        XCTAssertEqual(try TerminalSettings.merge(current, patch: ["fontSize": 19, "lastCwd": .string(cwd), "sidebarVisible": false], home: home),
                       TerminalSettings(fontSize: 19, lastCwd: cwd, sidebarVisible: false))
        XCTAssertThrowsError(try TerminalSettings.merge(current, patch: ["fontSize": "large"], home: home)) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "fontSize must be an integer between 10 and 24")
        }
        XCTAssertThrowsError(try TerminalSettings.merge(current, patch: ["lastCwd": .string(home + "/missing")], home: home)) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "lastCwd must be an existing directory")
        }
        XCTAssertThrowsError(try TerminalSettings.merge(current, patch: ["transcript": "not-app-owned"], home: home)) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Unsupported setting: transcript")
        }
        XCTAssertThrowsError(try TerminalSettings.merge(current, patch: ["sidebarVisible": 1], home: home)) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "sidebarVisible must be a boolean")
        }
    }

    func testSettingsStoreWritesPrivatelyAndReadsBack() throws {
        let userData = URL(fileURLWithPath: temporaryDirectory(self)).appendingPathComponent("ud")
        let home = temporaryDirectory(self)
        let cwd = temporaryDirectory(self)
        let store = TerminalSettingsStore(userData: userData, home: home)
        XCTAssertEqual(store.get(), TerminalSettings(fontSize: 14, lastCwd: home, sidebarVisible: true))
        try store.save(["lastCwd": .string(cwd), "fontSize": 16])
        let attributes = try FileManager.default.attributesOfItem(atPath: store.file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let dirAttributes = try FileManager.default.attributesOfItem(atPath: userData.path)
        XCTAssertEqual((dirAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertTrue(try String(contentsOf: store.file).hasSuffix("}\n"))
        XCTAssertEqual(TerminalSettingsStore(userData: userData, home: home).get(), TerminalSettings(fontSize: 16, lastCwd: cwd, sidebarVisible: true))
    }

    func testShouldHideWindowOnClose() {
        XCTAssertTrue(WindowLifecycle.shouldHideWindowOnClose(platformIsMac: true, quitReady: false))
        XCTAssertFalse(WindowLifecycle.shouldHideWindowOnClose(platformIsMac: true, quitReady: true))
        XCTAssertFalse(WindowLifecycle.shouldHideWindowOnClose(platformIsMac: false, quitReady: false))
    }

    func testQuitQuestion() {
        XCTAssertEqual(TerminalQuit.message(running: 1), "Quit and end 1 running terminal session?")
        XCTAssertEqual(TerminalQuit.message(running: 3), "Quit and end 3 running terminal sessions?")
    }

    func testDirectoryPickerStartsInTheTabsDirectoryElseHome() {
        let dir = temporaryDirectory(self)
        XCTAssertEqual(DirectoryPicker.startDirectory(current: dir, home: "/home"), dir)
        XCTAssertEqual(DirectoryPicker.startDirectory(current: dir + "/gone", home: "/home"), "/home")
        XCTAssertEqual(DirectoryPicker.startDirectory(current: nil, home: "/home"), "/home")
    }
}
