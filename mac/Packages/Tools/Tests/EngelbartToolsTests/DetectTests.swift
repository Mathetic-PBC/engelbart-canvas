import EngelbartCore
import XCTest
@testable import EngelbartTools

// test/tools.test.cjs: detection.
final class DetectTests: XCTestCase {
    typealias A = TableRunner.Answer

    func opts(home: String, systemBins: [String] = SYSTEM_BINS, bundled: String? = nil, prefer: Bool = false, env: [String: String] = [:]) -> DetectOptions {
        var o = DetectOptions()
        o.home = home; o.systemBins = systemBins; o.bundledGit = bundled; o.preferBundledGit = prefer; o.environment = env
        return o
    }

    func testParseLookupListsEveryProgramOnceInPathOrder() {
        let out = parseLookup(["@tool git", "/usr/bin/git", "@tool claude", "/Users/h/.claude-vault/bin/claude", "/Users/h/.local/bin/claude", "/Users/h/.local/bin/claude",
                               "claude: aliased to nope", "@tool codex", "@env DISABLE_AUTOUPDATER=1"].joined(separator: "\n"))
        XCTAssertEqual(out.paths, ["git": ["/usr/bin/git"], "claude": ["/Users/h/.claude-vault/bin/claude", "/Users/h/.local/bin/claude"], "codex": []])
        XCTAssertEqual(out.env, ["DISABLE_AUTOUPDATER": "1"])
        XCTAssertEqual(parseLookup("@tool claude\n@alias claude\n@alias claude\n@alias ls\n").aliases, ["claude"])
        XCTAssertTrue(lookupCommand(fish: false).contains("whence -ap"))
        XCTAssertTrue(lookupCommand(fish: true).contains("command -a -s"))
    }

    func testSourceOf() {
        let dir = temp()
        let versions = "\(dir)/.local/share/claude/versions"
        write("\(versions)/2.1.281", "")
        mkdirs("\(dir)/.local/bin")
        try! FileManager.default.createSymbolicLink(atPath: "\(dir)/.local/bin/claude", withDestinationPath: "\(versions)/2.1.281")
        XCTAssertEqual(sourceOf("claude", "\(dir)/.local/bin/claude"), "native")
        XCTAssertEqual(sourceOf("codex", "/opt/homebrew/Caskroom/codex/0.155.1/bin/codex"), "homebrew")
        XCTAssertEqual(sourceOf("codex", "/Users/h/.codex/packages/standalone/releases/0.155.1/bin/codex"), "standalone")
        XCTAssertEqual(sourceOf("claude", "/Users/h/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "npm")
        XCTAssertEqual(sourceOf("claude", "/Users/h/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js"), "bun")
        XCTAssertEqual(sourceOf("claude", "/Users/h/Library/Application Support/Claude/claude-code/2.1.295/abc/claude.app/Contents/MacOS/claude"), "desktop")
        XCTAssertEqual(sourceOf("git", "/usr/bin/git"), "apple")
        XCTAssertEqual(sourceOf("git", "/opt/homebrew/Cellar/git/2.51.0/bin/git"), "homebrew")
        XCTAssertEqual(sourceOf("git", "/Users/h/bin/git"), "other")
        XCTAssertTrue(knownPlaces("claude", home: "/Users/h").contains("/Users/h/.local/bin/claude"))
        XCTAssertEqual(knownPlaces("git", home: "/Users/h"), [])
    }

    func testKnownPlacesPutsTheNewestNvmLast() {
        let home = temp()
        for v in ["v9.0.0", "v22.1.0", "v18.20.0", "notnode"] { mkdirs("\(home)/.nvm/versions/node/\(v)/bin") }
        let places = knownPlaces("codex", home: home, systemBins: ["/opt/homebrew/bin"])
        XCTAssertEqual(places, ["\(home)/.local/bin/codex", "\(home)/.bun/bin/codex", "\(home)/.npm-global/bin/codex", "\(home)/.volta/bin/codex", "/opt/homebrew/bin/codex",
                                "\(home)/.nvm/versions/node/v22.1.0/bin/codex", "\(home)/.nvm/versions/node/v18.20.0/bin/codex", "\(home)/.nvm/versions/node/v9.0.0/bin/codex"])
    }

    func testDesktopCopiesNewestThreeExecutableOnly() {
        let home = temp()
        let root = "\(home)/Library/Application Support/Claude/claude-code"
        for v in ["2.1.9", "2.1.300", "2.1.295", "2.1.10", "junk"] { write("\(root)/\(v)/h1/claude.app/Contents/MacOS/claude", "#!/bin/sh\n", mode: 0o755) }
        write("\(root)/2.1.300/h2/claude.app/Contents/MacOS/claude", "", mode: 0o644)
        XCTAssertEqual(desktopCopies("claude", home: home).map { $0.replacingOccurrences(of: root, with: "") },
                       ["/2.1.300/h1/claude.app/Contents/MacOS/claude", "/2.1.295/h1/claude.app/Contents/MacOS/claude", "/2.1.10/h1/claude.app/Contents/MacOS/claude"])
        XCTAssertEqual(desktopCopies("codex", home: home), [])
    }

    func testRemovalHints() {
        XCTAssertEqual(removal("claude", "/opt/homebrew/Caskroom/claude-code/2.1.0/claude"), "brew uninstall --cask claude-code")
        XCTAssertEqual(removal("codex", "/opt/homebrew/Cellar/codex/0.1/bin/codex"), "brew uninstall codex")
        XCTAssertEqual(removal("claude", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "npm uninstall -g @anthropic-ai/claude-code")
        XCTAssertNil(removal("claude", "/Users/h/.local/bin/claude"))
    }

    func testNeverRunsApplesGitStubWithoutADeveloperFolder() async {
        let home = temp()
        let runner = TableRunner(lookup: "@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n@env DISABLE_AUTOUPDATER=\n",
                                 exec: ["/usr/bin/xcode-select -p": A(TableRunner.ok("", code: 2, stderr: "xcode-select: error: unable to get active developer directory"))])
        let found = await detectTools(runner: runner, only: ["git"], options: opts(home: home))
        XCTAssertEqual(status(found.tools["git"]), "missing")
        XCTAssertEqual(found.tools["git"]?["installed"], false)
        XCTAssertFalse(runner.calls.contains { $0.kind == "exec" && $0.command.hasPrefix("/usr/bin/git") }, "the stub was not run")
    }

    func testAppleGitFromTheDeveloperFolderAndAnUnacceptedLicense() async {
        let home = temp()
        let developer = "\(temp())/Developer"
        let realGit = "\(developer)/usr/bin/git"
        write(realGit, "#!/bin/sh\n", mode: 0o755)
        let base: [String: A] = ["/usr/bin/xcode-select -p": A(TableRunner.ok("\(developer)\n")), "\(realGit) --version": A(TableRunner.ok("git version 2.50.1 (Apple Git-155)\n"))]
        let lookup = "@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n"
        var good = base; good["/usr/bin/git --version"] = A(TableRunner.ok("git version 2.50.1"))
        let ok = await detectTools(runner: TableRunner(lookup: lookup, exec: good), only: ["git"], options: opts(home: home))
        XCTAssertEqual(ok.tools["git"]?["status"], "ready")
        XCTAssertEqual(ok.tools["git"]?["version"], "2.50.1")
        XCTAssertEqual(ok.tools["git"]?["source"], "apple")
        XCTAssertEqual(ok.tools["git"]?["path"], "/usr/bin/git")
        var license = base; license["/usr/bin/git --version"] = A(TableRunner.ok("", code: 69, stderr: "You have not agreed to the Xcode license agreements."))
        let refused = await detectTools(runner: TableRunner(lookup: lookup, exec: license), only: ["git"], options: opts(home: home))
        XCTAssertEqual(status(refused.tools["git"]), "failed")
        XCTAssertTrue(refused.tools["git"]?["error"]?.string?.contains("license") == true)
    }

    func testBundledGitStandsInAndTheStubIsNeverRun() async {
        let home = temp()
        let bundled = "/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git"
        let runner = TableRunner(lookup: "@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n",
                                 exec: ["/usr/bin/xcode-select -p": A(TableRunner.ok("", code: 2)), "\(bundled) --version": A(TableRunner.ok("git version 2.53.0\n"))])
        let found = await detectTools(runner: runner, only: ["git"], options: opts(home: home, bundled: bundled))
        let git = found.tools["git"]!
        XCTAssertEqual([git["status"], git["installed"], git["source"], git["path"], git["version"], git["onPath"]], ["ready", true, "bundled", .string(bundled), "2.53.0", false])
        XCTAssertFalse(runner.calls.contains { $0.kind == "exec" && $0.command.hasPrefix("/usr/bin/git") })
    }

    func testOwnGitWhenItWorksBundledOnlyWhenBrokenOrOld() async {
        let home = temp()
        let bundled = "/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git"
        let lookup = "@tool git\n/opt/homebrew/bin/git\n@tool claude\n@tool codex\n"
        let answers = { (own: ExecResult) -> [String: A] in ["/opt/homebrew/bin/git --version": A(own), "\(bundled) --version": A(TableRunner.ok("git version 2.53.0"))] }
        let theirs = TableRunner(lookup: lookup, exec: answers(TableRunner.ok("git version 2.51.0")))
        let works = await detectTools(runner: theirs, only: ["git"], options: opts(home: home, bundled: bundled))
        XCTAssertEqual([works.tools["git"]?["source"], works.tools["git"]?["path"], works.tools["git"]?["version"]], ["homebrew", "/opt/homebrew/bin/git", "2.51.0"])
        XCTAssertFalse(theirs.calls.contains { $0.command.hasPrefix(bundled) }, "Engelbart's is not even asked")
        let old = await detectTools(runner: TableRunner(lookup: lookup, exec: answers(TableRunner.ok("git version 2.20.1"))), only: ["git"], options: opts(home: home, bundled: bundled))
        XCTAssertEqual([old.tools["git"]?["status"], old.tools["git"]?["source"]], ["ready", "bundled"], "Build needs 2.30")
        let broken = await detectTools(runner: TableRunner(lookup: lookup, exec: answers(TableRunner.ok("", code: 1, stderr: "dyld: Library not loaded"))), only: ["git"], options: opts(home: home, bundled: bundled))
        XCTAssertEqual([broken.tools["git"]?["status"], broken.tools["git"]?["source"]], ["ready", "bundled"])
        let forced = await detectTools(runner: TableRunner(lookup: lookup, exec: answers(TableRunner.ok("git version 2.51.0"))), only: ["git"], options: opts(home: home, bundled: bundled, prefer: true))
        XCTAssertEqual(forced.tools["git"]?["source"], "bundled", "ENGELBART_GIT=bundled")
        let neither = await detectTools(runner: TableRunner(lookup: "@tool git\n", exec: ["\(bundled) --version": A(TableRunner.ok("", code: 126, stderr: "bad CPU type in executable"))]),
                                        only: ["git"], options: opts(home: home, bundled: bundled))
        XCTAssertEqual([neither.tools["git"]?["status"], neither.tools["git"]?["source"]], ["failed", "bundled"], "the dialog then offers Apple's installer through Try again")
        let brokenBoth = await detectTools(runner: TableRunner(lookup: lookup, exec: ["/opt/homebrew/bin/git --version": A(TableRunner.ok("", code: 1)), "\(bundled) --version": A(TableRunner.ok("", code: 126))]),
                                           only: ["git"], options: opts(home: home, bundled: bundled))
        XCTAssertEqual([brokenBoth.tools["git"]?["status"], brokenBoth.tools["git"]?["path"]], ["failed", "/opt/homebrew/bin/git"], "their own is reported when neither runs")
    }

    func testAnAgentOffThePathIsFoundWhereItsInstallerPutsIt() async {
        let home = temp()
        let claude = "\(home)/.local/bin/claude"
        write(claude, "", mode: 0o755)
        let runner = TableRunner(lookup: "@tool git\n@tool claude\n@tool codex\n", shell: [
            ("--version", A(tool: claude, TableRunner.ok("2.1.281 (Claude Code)\n"))),
            ("auth status --json", A(tool: claude, TableRunner.ok("{\"loggedIn\": false}\n"))),
        ])
        let found = await detectTools(runner: runner, only: ["claude", "codex"], options: opts(home: home, systemBins: []))
        let c = found.tools["claude"]!
        XCTAssertEqual([c["status"], c["path"], c["onPath"], c["signedIn"], c["version"]], ["signed-out", .string(claude), false, false, "2.1.281"])
        XCTAssertEqual(status(found.tools["codex"]), "missing")
    }

    func testCodexSignedInWithAnAPIKeyCountsAsSignedOut() async {
        let home = temp()
        let runner = TableRunner(lookup: "@tool codex\n/opt/homebrew/bin/codex\n", shell: [
            ("--version", A(TableRunner.ok("codex-cli 0.155.1\n"))), ("login status", A(TableRunner.ok("Logged in using an API key - sk-proj-***\n"))),
        ])
        let found = await detectTools(runner: runner, only: ["codex"], options: opts(home: home))
        XCTAssertEqual(status(found.tools["codex"]), "signed-out")
        XCTAssertTrue(found.tools["codex"]?["error"]?.string?.contains("API key") == true)
    }

    func testClaudeAccountIsTheEmailInItsStatusJSON() {
        let read = AuthReaders.claude
        let status: JSONValue = ["loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "someone@example.com", "orgId": "org-1", "subscriptionType": "max"]
        XCTAssertEqual(read("\(status.text(pretty: true))\n"), SignInRead(signedIn: true, account: "someone@example.com"))
        XCTAssertEqual(read("Warning: an update is available\n\(status.text())\n"), SignInRead(signedIn: true, account: "someone@example.com"), "past a line printed in front of it")
        XCTAssertEqual(read("{\"loggedIn\": true, \"authMethod\": \"console\"}"), SignInRead(signedIn: true, account: nil), "signed in, no email")
        XCTAssertEqual(read("{\"loggedIn\": true, \"email\": \"\"}"), SignInRead(signedIn: true, account: nil))
        XCTAssertEqual(read("{\"loggedIn\": true, \"email\": {\"address\": \"x\"}}"), SignInRead(signedIn: true, account: nil), "only a string is an account")
        XCTAssertEqual(read("{\"loggedIn\": false, \"email\": \"someone@example.com\"}"), SignInRead(signedIn: false, account: nil), "signed out: nobody")
        XCTAssertEqual(read("\"loggedIn\": true, \"email\": \"someone@example.com\""), SignInRead(signedIn: true, account: nil), "not JSON: the old reading, and no account")
        XCTAssertEqual(read("{\"loggedIn\": true, \"email\": \"someone@example.com\""), SignInRead(signedIn: true, account: nil), "cut off")
        XCTAssertEqual(read("error: unknown command 'auth'"), SignInRead(signedIn: nil, account: nil))
    }

    static func jwt(_ claims: JSONValue) -> String {
        let payload = Data(claims.text().utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return ["eyJhbGciOiJSUzI1NiJ9", payload, "c2lnbmF0dXJl"].joined(separator: ".")
    }

    func testCodexAccountIsTheEmailClaimOfItsIDToken() {
        let home = temp()
        let auth = "\(home)/.codex/auth.json"
        let writeToken = { (token: JSONValue) in
            write(auth, JSONValue.object(["auth_mode": "chatgpt", "OPENAI_API_KEY": .null, "tokens": ["id_token": token, "access_token": "secret-access", "refresh_token": "secret-refresh", "account_id": "acct-1"]]).text())
        }
        XCTAssertNil(codexAccount(env: [:], home: home), "no auth.json")
        writeToken(.string(Self.jwt(["email": "someone@example.com", "email_verified": true, "sub": "user-1"])))
        XCTAssertEqual(codexAccount(env: [:], home: home), "someone@example.com")
        let custom = "\(home)/elsewhere"
        mkdirs(custom)
        try! FileManager.default.copyItem(atPath: auth, toPath: "\(custom)/auth.json")
        try! FileManager.default.removeItem(atPath: auth)
        XCTAssertEqual(codexAccount(env: ["CODEX_HOME": custom], home: home), "someone@example.com", "$CODEX_HOME first")
        XCTAssertNil(codexAccount(env: [:], home: home), "not in ~/.codex any more")
        let bad: [(JSONValue, String)] = [("not-a-token", "one part"), ("a.%%%.c", "payload not base64url"),
                                          (.string("a.\(Data("{\"email\":".utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")).c"), "payload not JSON"),
                                          (.string(Self.jwt(["sub": "user-1"])), "no email claim"), (.string(Self.jwt(["email": 42])), "email not a string"), (.null, "no id_token")]
        for (token, why) in bad {
            writeToken(token)
            XCTAssertNil(codexAccount(env: [:], home: home), why)
        }
        write(auth, "{ not json")
        XCTAssertNil(codexAccount(env: [:], home: home), "auth.json not JSON")
    }

    func testCodexSignedInWithChatGPTCarriesItsAccountAndNoToken() async {
        let home = temp()
        write("\(home)/.codex/auth.json", JSONValue.object(["auth_mode": "chatgpt", "tokens": ["id_token": .string(Self.jwt(["email": "someone@example.com", "sub": "user-1"])), "access_token": "secret-access", "refresh_token": "secret-refresh"]]).text())
        let status = { (stdout: String) in TableRunner(lookup: "@tool codex\n/opt/homebrew/bin/codex\n", shell: [("--version", A(TableRunner.ok("codex-cli 0.155.1\n"))), ("login status", A(TableRunner.ok(stdout)))]) }
        let found = await detectTools(runner: status("Logged in using ChatGPT\n"), only: ["codex"], options: opts(home: home))
        let c = found.tools["codex"]!
        XCTAssertEqual([c["status"], c["signedIn"], c["account"]], ["ready", true, "someone@example.com"])
        let text = JSONValue.object(found.tools.mapValues { JSONValue.object($0) }).text()
        XCTAssertFalse(text.contains("secret-") || text.contains("eyJ") || text.contains("c2lnbmF0dXJl"), "only the address leaves auth.json")
        let out = await detectTools(runner: status("Not logged in\n"), only: ["codex"], options: opts(home: home))
        XCTAssertEqual([out.tools["codex"]?["status"], out.tools["codex"]?["account"]], ["signed-out", .null], "a left-over auth.json names nobody once the CLI says signed out")
        let key = await detectTools(runner: status("Logged in using an API key - sk-proj-***\n"), only: ["codex"], options: opts(home: home))
        XCTAssertEqual([key.tools["codex"]?["status"], key.tools["codex"]?["account"]], ["signed-out", .null])
        write("\(home)/.codex/auth.json", "{ not json")
        let unread = await detectTools(runner: status("Logged in using ChatGPT\n"), only: ["codex"], options: opts(home: home))
        let u = unread.tools["codex"]!
        XCTAssertEqual([u["status"], u["signedIn"], u["account"], u["error"]], ["ready", true, .null, .null], "an unreadable auth.json is no account, not an error")
    }

    func testCodexKeptInTheKeychainCountsAsNotSignedIn() async {
        let home = temp()
        let runner = TableRunner(lookup: "@tool codex\n/opt/homebrew/bin/codex\n", shell: [("--version", A(TableRunner.ok("codex-cli 0.155.1\n"))), ("login status", A(TableRunner.ok("Logged in using ChatGPT\n")))])
        let found = await detectTools(runner: runner, only: ["codex"], options: opts(home: home))
        XCTAssertEqual(status(found.tools["codex"]), "signed-out")
        XCTAssertEqual(found.tools["codex"]?["error"], "Codex keeps its sign-in in the keychain, where Engelbart’s agents can’t use it. Connect it again.")
    }

    func testAVersionThatNeverAnswersIsRetriedOnceThenReported() async {
        let home = temp()
        var asked = 0
        let runner = TableRunner(lookup: "@tool claude\n/opt/homebrew/bin/claude\n", shell: [("--version", A(make: { asked += 1; return ExecResult(code: nil, timedOut: true, marked: false) }))])
        let found = await detectTools(runner: runner, only: ["claude"], options: opts(home: home))
        XCTAssertEqual(asked, 2)
        XCTAssertEqual(status(found.tools["claude"]), "failed")
        XCTAssertEqual(found.tools["claude"]?["version"], .null)
        XCTAssertTrue(found.tools["claude"]?["error"]?.string?.contains("did not answer --version within 20 seconds") == true)
    }

    func testALoginShellThatDoesNotAnswerIsReported() async {
        let home = temp()
        let runner = TableRunner()
        runner.shellOverride = { _, _ in ExecResult(code: nil, timedOut: true, marked: false) }
        let found = await detectTools(runner: runner, only: ["codex"], options: opts(home: home, systemBins: []))
        XCTAssertEqual(status(found.tools["codex"]), "missing")
        XCTAssertTrue(found.lookupError?.contains("did not answer") == true)
        XCTAssertTrue(found.tools["codex"]?["error"]?.string?.contains("did not answer") == true)
    }

    func testASilentLoginShellSaysWhichLineToGuard() async {
        let home = temp()
        write("\(home)/.local/bin/claude", "", mode: 0o755)
        let runner = TableRunner()
        runner.shellOverride = { _, _ in ExecResult(code: 0, marked: false) }
        let found = await detectTools(runner: runner, only: ["claude"], options: opts(home: home, systemBins: []))
        XCTAssertEqual(status(found.tools["claude"]), "failed")
        XCTAssertEqual(found.tools["claude"]?["error"]?.string, shellSilent(runner))
        XCTAssertTrue(shellSilent(runner).hasPrefix("Your login shell (/bin/zsh) never runs Engelbart's commands: something in your .zshrc starts another program"))
    }

    func testEveryCopyCountsAnOlderOneFirstOnPathIsNamed() async {
        let home = temp()
        let old = "/opt/homebrew/Caskroom/claude-code/2.1.100/claude"
        let fresh = "\(home)/.local/bin/claude"
        write(fresh, "", mode: 0o755)
        let runner = TableRunner(lookup: "@tool claude\n\(old)\n", shell: [
            ("--version", A(tool: old, TableRunner.ok("2.1.100 (Claude Code)\n"))), ("--version", A(tool: fresh, TableRunner.ok("2.1.300 (Claude Code)\n"))),
            ("auth status", A(tool: fresh, TableRunner.ok("{\"loggedIn\": true}"))),
        ])
        let found = await detectTools(runner: runner, only: ["claude"], options: opts(home: home, systemBins: []))
        let c = found.tools["claude"]!
        XCTAssertEqual([c["status"], c["path"], c["onPath"], c["version"]], ["ready", .string(fresh), false, "2.1.300"])
        XCTAssertEqual(c["note"]?.string, "An older Claude Code comes first on your PATH, so typing claude in a terminal runs it; Engelbart uses a newer one. To remove the older one: brew uninstall --cask claude-code. It is at \(old).")
    }

    func testAnotherProgramOfTheSameNameIsPassedOver() async {
        let home = temp()
        let other = "/usr/local/bin/codex"
        let real = "\(home)/.local/bin/codex"
        write(real, "", mode: 0o755)
        write("\(home)/.codex/auth.json", "{}")
        let runner = TableRunner(lookup: "@tool codex\n\(other)\n", shell: [
            ("--version", A(tool: other, TableRunner.ok("codex 1.0.2 - a different tool\n"))), ("--version", A(tool: real, TableRunner.ok("codex-cli 0.155.1\n"))),
            ("login status", A(tool: real, TableRunner.ok("Logged in using ChatGPT"))),
        ])
        let found = await detectTools(runner: runner, only: ["codex"], options: opts(home: home, systemBins: []))
        let c = found.tools["codex"]!
        XCTAssertEqual([c["status"], c["path"], c["untested"]], ["ready", .string(real), false])
        XCTAssertEqual(c["note"]?.string, "Typing codex in a terminal runs another program of the same name; Engelbart runs Codex by its full path. The other one is at /usr/local/bin/codex.")
        let alone = await detectTools(runner: TableRunner(lookup: "@tool codex\n\(other)\n", shell: [("--version", A(TableRunner.ok("codex 1.0.2\n")))]), only: ["codex"], options: opts(home: temp(), systemBins: []))
        XCTAssertEqual(status(alone.tools["codex"]), "missing")
        XCTAssertEqual(alone.tools["codex"]?["error"]?.string, "/usr/local/bin/codex is another program called codex, not Codex (it says \"codex 1.0.2\").")
    }

    func testAWrapperScriptIsSeenThroughForTheSource() async {
        let home = temp()
        let shim = "\(home)/.claude-vault/bin/claude"
        write(shim, "#!/bin/bash\nexec ~/.local/bin/claude \"$@\"\n", mode: 0o755)
        let versions = "\(home)/.local/share/claude/versions"
        write("\(versions)/2.1.281", "binary", mode: 0o755)
        mkdirs("\(home)/.local/bin")
        try! FileManager.default.createSymbolicLink(atPath: "\(home)/.local/bin/claude", withDestinationPath: "\(versions)/2.1.281")
        let runner = TableRunner(lookup: "@tool claude\n\(shim)\n\(home)/.local/bin/claude\n@env DISABLE_AUTOUPDATER=\n",
                                 shell: [("--version", A(TableRunner.ok("2.1.281 (Claude Code)"))), ("auth status", A(TableRunner.ok("{\"loggedIn\": true, \"email\": \"h@example.com\"}")))])
        write("\(home)/.claude.json", "{\"projects\": {}, \"autoUpdates\": false}")
        let found = await detectTools(runner: runner, only: ["claude"], options: opts(home: home))
        let c = found.tools["claude"]!
        XCTAssertEqual([c["path"], c["source"], c["onPath"], c["updaterOff"], c["account"]], [.string(shim), "native", true, true, "h@example.com"],
                       "Hudson's vault shim: the native install behind it; autoUpdates false means ask")
    }

    func testUpdaterOff() {
        let home = temp()
        XCTAssertFalse(updaterOff("claude", env: [:], home: home))
        XCTAssertTrue(updaterOff("claude", env: ["DISABLE_AUTOUPDATER": " Yes "], home: home))
        XCTAssertFalse(updaterOff("claude", env: ["DISABLE_AUTOUPDATER": "0"], home: home))
        write("\(home)/.claude.json", "{\"autoUpdates\" :  false}")
        XCTAssertTrue(updaterOff("claude", env: [:], home: home))
        XCTAssertFalse(updaterOff("codex", env: [:], home: home))
        write("\(home)/.codex/config.toml", "model = \"x\"\n  check_for_update_on_startup = false\n")
        XCTAssertTrue(updaterOff("codex", env: [:], home: home))
        XCTAssertFalse(updaterOff("git", env: ["DISABLE_AUTOUPDATER": "1"], home: home))
    }

    func testTheDesktopAppsCopyCountsOnlyWhenRecentAndIsNeverUpdated() async {
        let home = temp()
        let copy = "\(home)/Library/Application Support/Claude/claude-code/2.1.295/abc/claude.app/Contents/MacOS/claude"
        write(copy, "#!/bin/sh\n", mode: 0o755)
        let recent = TableRunner(lookup: "@tool claude\n", shell: [("--version", A(TableRunner.ok("2.1.295 (Claude Code)"))), ("auth status", A(TableRunner.ok("{\"loggedIn\": true}")))])
        let found = await detectTools(runner: recent, only: ["claude"], options: opts(home: home, systemBins: []))
        XCTAssertEqual([found.tools["claude"]?["status"], found.tools["claude"]?["source"], found.tools["claude"]?["updaterOff"]], ["ready", "desktop", true])
        let old = TableRunner(lookup: "@tool claude\n", shell: [("--version", A(TableRunner.ok("2.1.100 (Claude Code)")))])
        let none = await detectTools(runner: old, only: ["claude"], options: opts(home: home, systemBins: []))
        XCTAssertEqual(status(none.tools["claude"]), "missing", "an old one would stand in the way of installing Claude Code")
    }
}
