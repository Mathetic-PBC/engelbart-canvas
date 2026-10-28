import XCTest
import CryptoKit
import EngelbartCore
@testable import EngelbartBuild

/// build-reach.test.cjs and the policy/prompt parts of build.test.cjs: the git ban, papers kept, Engelbart's own tools,
/// the bridge, the policy and the prompt.
final class ReachTests: XCTestCase {
    var host: TestHost!
    override func setUp() { host = TestHost() }
    override func tearDown() { host.cleanup() }

    func run(_ exe: String, _ args: [String], cwd: String, env: [String: String]) -> (status: Int32, out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.environment = env
        let o = Pipe(), e = Pipe()
        p.standardOutput = o; p.standardError = e
        try! p.run()
        let od = o.fileHandleForReading.readDataToEndOfFile(), ed = e.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: od, as: UTF8.self), String(decoding: ed, as: UTF8.self))
    }

    func repositories(_ name: String) -> (repo: String, worktree: String, other: String) {
        let base = "\(host.homeDir)/\(name)", repo = "\(base)/repo"
        try! FS.mkdirs(repo)
        // The person's own name, as the Electron test machine's git has it (`git config user.name` reads it).
        if !FS.exists("\(host.homeDir)/.gitconfig") { Sh.write("\(host.homeDir)/.gitconfig", "[user]\n\tname = Person\n\temail = p@example.com\n") }
        Sh.git(repo, host.homeDir, "init", "-q", "-b", "main")
        Sh.write("\(repo)/a.txt", "a\n")
        Sh.git(repo, host.homeDir, "add", "-A")
        Sh.git(repo, host.homeDir, "commit", "-qm", "one")
        Sh.git(repo, host.homeDir, "config", "core.hooksPath", ".husky")
        Sh.git(repo, host.homeDir, "config", "alias.ci", "commit")
        let worktree = "\(base)/wt"
        Sh.git(repo, host.homeDir, "worktree", "add", "-q", "-b", "engelbart/abc", worktree)
        let other = "\(base)/other"
        try! FS.mkdirs(other)
        Sh.git(other, host.homeDir, "init", "-q", "-b", "main")
        return (repo, worktree, other)
    }

    func testGitGuardRefusesHistoryRefsSettingsAndPushesOnly() throws {
        let (repo, worktree, other) = repositories("guard")
        let guardFiles = try GitGuard.prepare("\(host.homeDir)/guard-files")
        let gitDir = GitGuard.commonDir(worktree)
        XCTAssertEqual(gitDir, NodePath.real("\(repo)/.git"))
        XCTAssertEqual(GitGuard.commonDir(repo), gitDir)
        XCTAssertNil(GitGuard.commonDir(host.homeDir))
        var plain = Sh.env(host.homeDir)
        plain["GIT_AUTHOR_NAME"] = "Person"; plain["GIT_AUTHOR_EMAIL"] = "p@example.com"; plain["GIT_COMMITTER_NAME"] = "Person"; plain["GIT_COMMITTER_EMAIL"] = "p@example.com"
        var env = plain
        env["PATH"] = "\(guardFiles.bin):\(plain["PATH"]!)"
        for (k, v) in GitGuard.environment(guardFiles, gitDir: gitDir!, base: plain) { env[k] = v }
        let git = { (cwd: String, args: [String]) in self.run("/bin/sh", ["-c", "git \"$@\"", "git"] + args, cwd: cwd, env: env) }
        let refused = { (r: (status: Int32, out: String, err: String)) in r.status != 0 && r.err.contains("Engelbart: ") }
        XCTAssertEqual(run("/bin/sh", ["-c", "command -v git"], cwd: worktree, env: env).out.trimmingCharacters(in: .whitespacesAndNewlines), "\(guardFiles.bin)/git", "first on PATH")
        Sh.write("\(worktree)/b.txt", "b\n")
        for args in [["status", "--short"], ["diff"], ["log", "--oneline", "-1"], ["add", "b.txt"], ["branch"], ["branch", "--show-current"], ["config", "user.name"],
                     ["config", "--get", "core.hooksPath"], ["remote", "-v"], ["stash", "list"], ["tag", "-l"], ["reset", "--", "b.txt"], ["checkout", "--", "a.txt"], ["reset", "--hard"], ["--version"]] {
            let r = git(worktree, args)
            XCTAssertEqual(r.status, 0, "git \(args.joined(separator: " ")): \(r.err)")
        }
        Sh.write("\(worktree)/b.txt", "b\n")
        for (cwd, args) in [(worktree, ["commit", "-am", "x"]), (worktree, ["ci", "-m", "x"]), (worktree, ["checkout", "-b", "other"]), (worktree, ["switch", "main"]),
                            (worktree, ["branch", "new"]), (worktree, ["stash"]), (worktree, ["config", "user.name", "Bob"]), (worktree, ["remote", "add", "o", "https://example.com/r.git"]),
                            (worktree, ["reset", "HEAD~1"]), (worktree, ["tag", "v1"]), (worktree, ["merge", "main"]), (worktree, ["rebase", "main"]), (worktree, ["fetch"]),
                            (worktree, ["-C", repo, "commit", "--allow-empty", "-m", "x"]), (repo, ["commit", "--allow-empty", "-m", "x"])] {
            XCTAssertTrue(refused(git(cwd, args)), "git \(args.joined(separator: " ")) in \(NodePath.basename(cwd))")
        }
        XCTAssertTrue(refused(git(other, ["push"])), "nothing is pushed from a Build")
        XCTAssertEqual(Sh.git(worktree, host.homeDir, "rev-parse", "HEAD"), Sh.git(repo, host.homeDir, "rev-parse", "main"), "no commit was made")
        // a git that is not the guard meets the hooks instead
        let real = run("/bin/sh", ["-c", "command -v git"], cwd: worktree, env: plain).out.trimmingCharacters(in: .whitespacesAndNewlines)
        for args in [["commit", "--allow-empty", "-m", "x"], ["branch", "new"], ["-c", "alias.c=commit", "c", "--allow-empty", "-m", "x"]] {
            let r = run(real, args, cwd: worktree, env: env)
            XCTAssertTrue(r.status != 0 && r.err.range(of: #"Engelbart: refs/heads/\S+ cannot change"#, options: .regularExpression) != nil, "\(real) \(args): \(r.err)")
        }
        XCTAssertEqual(run(real, ["reset", "-q", "--hard"], cwd: worktree, env: env).status, 0, "a ref written as it was is not a change")
        let pushed = run(real, ["push", "--no-verify", "https://example.com/nobody/none.git", "HEAD"], cwd: other, env: env)
        XCTAssertTrue(pushed.status != 0 && pushed.err.contains("engelbart-no-push"), "a push to the network fails everywhere")
        Sh.write("\(other)/.git/hooks/pre-commit", "#!/bin/sh\necho own-hook-ran >&2\n")
        chmod("\(other)/.git/hooks/pre-commit", 0o755)
        let own = git(other, ["commit", "--allow-empty", "-m", "mine"])
        XCTAssertEqual(own.status, 0, own.err)
        XCTAssertTrue(own.err.contains("own-hook-ran"), "its own hooks run")
        XCTAssertEqual(git(other, ["config", "user.name", "Bob"]).status, 0)
        XCTAssertEqual(GitGuard.path("/bin/zsh"), "PATH=\"$ENGELBART_BUILD_GUARD:$PATH\"; ")
        XCTAssertEqual(GitGuard.path("/opt/homebrew/bin/fish"), "set -gx PATH $ENGELBART_BUILD_GUARD $PATH; ")
        XCTAssertTrue(GitGuard.environment(guardFiles, gitDir: gitDir!, base: ["GIT_CONFIG_PARAMETERS": "'their.key'='v'"])["GIT_CONFIG_PARAMETERS"]!.hasSuffix(" 'their.key'='v'"))
    }

    func testGitHubCredentialHelperAnswersGitHubAlone() throws {
        let theirs = "\(host.root)/their-helper.sh"
        Sh.write(theirs, "#!/bin/sh\ntest \"$1\" = get && printf \"username=person\\npassword=their-password\\n\"\n")
        chmod(theirs, 0o755)
        Sh.write("\(host.homeDir)/.gitconfig", "[credential]\n\thelper = \(theirs)\n")
        func fill(_ hostName: String, _ extra: [String: String]) -> String? {
            var env = Sh.env(host.homeDir); env["GIT_TERMINAL_PROMPT"] = "0"
            for (k, v) in extra { env[k] = v }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = ["git", "credential", "fill"]; p.environment = env
            let i = Pipe(), o = Pipe()
            p.standardInput = i; p.standardOutput = o; p.standardError = FileHandle.nullDevice
            try! p.run()
            i.fileHandleForWriting.write(Data("protocol=https\nhost=\(hostName)\n\n".utf8)); try? i.fileHandleForWriting.close()
            let out = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
            return p.terminationStatus == 0 ? String(decoding: out, as: UTF8.self) : nil
        }
        var signedIn = BuildGit.credentialEnv(); signedIn["ENGELBART_GITHUB_TOKEN"] = "ghu_test_token"
        XCTAssertTrue(fill("github.com", signedIn)?.contains("username=x-access-token\npassword=ghu_test_token\n") == true)
        XCTAssertNil(fill("example.com", signedIn), "the sign-in goes to github.com alone, and their helper is not asked")
        XCTAssertTrue(fill("example.com", [:])?.contains("password=their-password") == true)
    }

    func testKeepLibraryPutsBackDeletedAndReplacedPapersNotEditedNotes() async throws {
        let project = host.createProject("Keep")
        let pdf = "%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
        let saved = "\(host.dataRoot)/assets/pdfs/saved.pdf", downloaded = "\(host.homeDir)/Downloads/paper.pdf", gonePath = "\(host.homeDir)/Downloads/gone.pdf"
        Sh.write(saved, pdf); Sh.write(downloaded, pdf); Sh.write(gonePath, pdf)
        let savedId = "7a000000-0000-4000-8000-000000000001"
        host.insert(LibraryRow(id: savedId, name: "Saved paper", type: "pdf", path: saved))
        host.insert(LibraryRow(id: "7a000000-0000-4000-8000-000000000002", name: "Downloaded paper", type: "pdf", path: downloaded))
        host.insert(LibraryRow(id: "7a000000-0000-4000-8000-000000000003", name: "Removed by the person", type: "pdf", path: gonePath))
        _ = try await host.createNote(project.id, name: "Edited note", workspaceId: nil, text: "before")
        _ = try await host.createNote(project.id, name: "Deleted note", workspaceId: nil, text: "keep me")
        let ink = "\(host.dataRoot)/annotations/\(savedId).json"
        Sh.write(ink, "{\"marks\":[]}")
        let dir = "\(host.homeDir)/keep-1"
        let keeping = try await LibraryKeep.keep(host: host, dir: dir, kept: ["\(host.dataRoot)/assets"])
        XCTAssertGreaterThanOrEqual(keeping.count, 6)
        XCTAssertTrue(keeping.papers.contains(downloaded) && !keeping.papers.contains(saved))
        // the agent's turn
        FS.remove(saved)
        try FS.write("\(downloaded).new", "not a paper any more")
        try FS.rename("\(downloaded).new", downloaded)
        try FS.write("\(project.dir)/Edited note.md", "after")
        FS.remove("\(project.dir)/Deleted note.md")
        FS.remove(ink)
        FS.remove(gonePath)
        host.removeRow("7a000000-0000-4000-8000-000000000003") // meanwhile the person removed a row
        let back = await keeping.restore()
        XCTAssertEqual(back.map { "\($0.how) \($0.name)" }.sorted(), ["changed Downloaded paper", "deleted Deleted note", "deleted Saved paper", "deleted highlights and notes"])
        XCTAssertEqual(Sh.read(saved), pdf)
        XCTAssertEqual(Sh.read(downloaded), pdf)
        XCTAssertEqual(Sh.read("\(project.dir)/Deleted note.md"), "keep me")
        XCTAssertEqual(Sh.read("\(project.dir)/Edited note.md"), "after", "a note the agent edited is its work")
        XCTAssertEqual(Sh.read(ink), "{\"marks\":[]}")
        XCTAssertFalse(FS.exists(gonePath), "a row the person removed is not put back")
        XCTAssertFalse(FS.exists(dir), "nothing kept stays")
    }

    func testEngelbartToolsMakeLinkedLibraryItemsAndWorkThroughTheBridge() async throws {
        let project = host.createProject("Tools")
        let workspace = host.createWorkspace(project.id, "Feature")
        let (repo, worktree, _) = repositories("tools")
        let task: TaskRecord = ["workspaceId": .string(workspace.id), "worktree": .string(worktree), "cwd": .string(worktree), "repo": .string(repo), "source": .string(repo)]
        let added = LockedStrings()
        let call = EngelbartTools.make(host: host, projectId: project.id, task: task, onAdded: { added.add($0.id) })
        XCTAssertEqual(EngelbartTools.definitions.map(\.name), ["save_file", "duplicate_file", "move_file_into_engelbart"])
        XCTAssertThrowsError(try EngelbartTools.validate("save_file", ["name": "x"])) { XCTAssertEqual($0.text, "Invalid tool arguments") }
        XCTAssertThrowsError(try EngelbartTools.validate("save_file", ["name": "x", "content": "y", "format": "exe"])) { XCTAssertTrue($0.text.hasPrefix("format must be one of")) }
        XCTAssertThrowsError(try EngelbartTools.validate("delete_file", [:])) { XCTAssertTrue($0.text.contains("Unknown")) }
        let note = try await call("save_file", ["name": "Findings", "content": "# Findings\n"])
        XCTAssertEqual(note["type"]?.string, "md")
        XCTAssertEqual(Sh.read(note["path"]!.string!), "# Findings\n")
        XCTAssertEqual(NodePath.dirname(note["path"]!.string!), project.dir)
        let table = try await call("save_file", ["name": "Results", "content": "a,b\n1,2\n", "format": "csv"])
        XCTAssertEqual(table["type"]?.string, "csv")
        XCTAssertTrue(table["path"]!.string!.hasPrefix("\(host.dataRoot)/assets/files/") && table["path"]!.string!.hasSuffix("Results.csv"))
        let copy = try await call("duplicate_file", ["item": note["id"]!])
        XCTAssertEqual(copy["name"]?.string, "Findings copy")
        XCTAssertEqual(Sh.read(copy["path"]!.string!), "# Findings\n")
        let tableCopy = try await call("duplicate_file", ["item": table["path"]!, "name": "Results again"])
        XCTAssertNotEqual(tableCopy["path"], table["path"])
        do { _ = try await call("duplicate_file", ["item": .string("\(worktree)/a.txt")]); XCTFail() } catch { XCTAssertTrue(error.text.contains("not an item of the library")) }
        Sh.write("\(worktree)/downloads/paper.pdf", "%PDF-1.4\n%%EOF\n")
        let paper = try await call("move_file_into_engelbart", ["path": "downloads/paper.pdf", "name": "A paper"])
        XCTAssertEqual([paper["type"]?.string, paper["name"]?.string, paper["original"]?.string], ["pdf", "A paper", "removed"])
        XCTAssertTrue(paper["path"]!.string!.hasPrefix("\(host.dataRoot)/assets/pdfs"))
        XCTAssertFalse(FS.exists("\(worktree)/downloads/paper.pdf"))
        Sh.write("\(repo)/figure.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
        let figure = try await call("move_file_into_engelbart", ["path": .string("\(repo)/figure.svg")])
        XCTAssertEqual(figure["original"]?.string, "kept: it is in the person's own folder")
        XCTAssertTrue(FS.exists("\(repo)/figure.svg"))
        Sh.write("\(host.homeDir)/Desktop/notes.md", "from the desktop")
        let kept = try await call("move_file_into_engelbart", ["path": "~/Desktop/notes.md", "keep_original": true])
        XCTAssertEqual([kept["type"]?.string, kept["original"]?.string], ["md", "kept, as asked"])
        do { _ = try await call("move_file_into_engelbart", ["path": paper["path"]!]); XCTFail() } catch { XCTAssertTrue(error.text.contains("already in the library as “A paper”")) }
        do { _ = try await call("move_file_into_engelbart", ["path": .string("\(worktree)/a.txt")]); XCTFail() } catch { XCTAssertTrue(error.text.contains("does not keep .txt")) }
        let ids = [note, table, copy, tableCopy, paper, figure, kept].compactMap { $0["id"]?.string }
        XCTAssertEqual(ids.count, 7)
        XCTAssertTrue(ids.allSatisfy { (host.workspaceContext[workspace.id] ?? []).contains($0) })
        XCTAssertEqual(added.list, ids)
        // through the bridge, as the MCP server reaches it
        let bridge = try await ToolBridge.open(call)
        let out = try await ToolBridge.use(bridge.connection, "save_file", ["name": "Over the bridge", "content": "hi"])
        XCTAssertEqual(out["name"]?.string, "Over the bridge")
        // refused without the token, and a tool's error comes back as isError
        var bad = bridge.connection; bad.token = String(repeating: "0", count: 64)
        do { _ = try await ToolBridge.post(bad, name: "save_file", args: [:]); XCTFail() } catch { XCTAssertTrue(error.text.contains("unavailable")) }
        let refused = try await ToolBridge.post(bridge.connection, name: "nope", args: [:])
        XCTAssertEqual(refused["isError"]?.bool, true)
        await bridge.close()
        // the MCP server forwards to it, from a connection file
        let file = "\(host.root)/conn.json"
        try FS.write(file, JSONValue.object(["url": .string(bridge.connection.url), "token": .string(bridge.connection.token)]).text())
        XCTAssertNotNil(try BuildMCP.server("engelbart", [file], output: FileHandle.nullDevice))
        XCTAssertNil(try BuildMCP.server("other", [file]))
        try FS.write(file, "{\"url\":\"http://example.com/tools\",\"token\":\"x\"}")
        XCTAssertThrowsError(try BuildMCP.server("run", [file]))
    }

    func testPolicyAndClaudeSettings() {
        let dataRoot = host.dataRoot, project = "\(dataRoot)/p", assets = "\(dataRoot)/assets", paper = "\(host.homeDir)/Downloads/paper.pdf"
        let policy = BuildPolicy.make(projectDir: project, dataRoot: dataRoot, papers: [paper, paper], gitDir: "/repo/.git")
        XCTAssertEqual(policy.folders, [project, assets])
        XCTAssertEqual(policy.writable, [project])
        XCTAssertEqual(policy.kept, [assets, "\(project)/assets"])
        XCTAssertEqual(policy.papers, [paper])
        XCTAssertEqual(policy.gitDir, "/repo/.git")
        XCTAssertTrue(policy.personal && policy.subagents && !policy.computerUse)
        let settings = policy.claudeSettings()
        let deny = settings["permissions"]?["deny"]?.array?.compactMap(\.string) ?? []
        XCTAssertEqual(settings["permissions"]?["allow"], ["mcp__engelbart"])
        for tool in ["Edit", "Write", "NotebookEdit"] {
            for rule in ["/\(assets)/**", "/\(project)/assets/**", "/\(paper)", "/\(project)/builds/**", "/\(project)/notes.pglite/**", "/\(project)/project.json", "/\(project)/**/meta.json", "/\(dataRoot)/library.pglite/**", "/\(dataRoot)/library.sqlite"] {
                XCTAssertTrue(deny.contains("\(tool)(\(rule))"), "\(tool)(\(rule))")
            }
        }
        XCTAssertFalse(deny.contains("Edit(/\(project)/**)"), "notes and workspaces can be written")
        XCTAssertFalse(deny.contains { $0.contains("worktrees") }, "the worktrees under the data root stay writable")
        XCTAssertTrue(deny.contains("mcp__computer-use"))
    }

    func testPromptIsVerbatimAndEndingsAreRead() throws {
        func sha(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
        XCTAssertEqual(sha(BuildPrompt.system), "817ef0c0b50964d1a168cd8c3c37b02e73e7605229255dc8bf6ebf723781a6f1", "the Electron build's text, byte for byte")
        XCTAssertEqual(sha(BuildPrompt.load(dataRoot: host.dataRoot, quick: true)), "822694b74e4c3da54ac749bf5b5931a84763c9711b1bcea8c54e20bf8a274c48")
        XCTAssertEqual(BuildPrompt.readEnding("Did half.\n\nNEEDS YOU: Which database?"), .init(ending: "needs-you", question: "Which database?", why: nil, text: "Did half."))
        XCTAssertEqual(BuildPrompt.readEnding("NEEDS YOU: mid text\nthen more").ending, "done", "only the last line asks")
        XCTAssertEqual(BuildPrompt.readEnding("ESCALATE: too big", quick: true), .init(ending: "escalated", question: nil, why: "too big", text: ""))
        XCTAssertEqual(BuildPrompt.readEnding("ESCALATE: too big").ending, "done", "a Build never escalates")
        XCTAssertEqual(BuildPrompt.readEnding("Done.\nNEEDS YOU: q", quick: true).ending, "escalated", "a quick task asks no questions")
        XCTAssertEqual(BuildPrompt.readEnding("All set.\nNEEDS YOU: `Blue?`").question, "Blue?")
        try FS.mkdirs("\(host.dataRoot)/.context")
        try FS.write("\(host.dataRoot)/.context/build-system-prompt.md", "  Mine.  \n")
        XCTAssertEqual(BuildPrompt.load(dataRoot: host.dataRoot), "Mine.")
        XCTAssertTrue(BuildPrompt.load(dataRoot: host.dataRoot, quick: true).hasPrefix("Mine.\n\n## This is a quick task"))
    }

    func testCheckOutputKeepsTheNamesOfWhatFailed() async {
        let long = ["TAP version 13", "ok 1 - first", "not ok 2 - the shell reads its input", "ok 3 - third", "# Subtest: second", "not ok 4 - second", "  output: \(String(repeating: "x", count: 6000))", "ok 5 - last", "# fail 2"].joined(separator: "\n")
        let out = checkOutput(long)
        XCTAssertTrue(out.hasPrefix("What failed, before what is shown below:\nnot ok 2 - the shell reads its input\nnot ok 4 - second\n\n…"))
        XCTAssertTrue(out.hasSuffix("ok 5 - last\n# fail 2"))
        XCTAssertLessThan(out.count, 4200)
        XCTAssertEqual(checkOutput("ok 1\nnot ok 2 - short"), "ok 1\nnot ok 2 - short")
        XCTAssertTrue(checkOutput("✖ spec: fails\n\(String(repeating: "y", count: 5000))").hasPrefix("What failed, before what is shown below:\n✖ spec: fails\n"))
        // a check runs in a session of its own, in the login shell, with CI=1
        let shell = CheckShell.make(environment: Sh.env(host.homeDir))
        let ran = await shell("echo $CI; ps -o sess= -p $$ >/dev/null; exit 3", host.homeDir, [:])
        XCTAssertFalse(ran.ok)
        XCTAssertTrue(ran.output.contains("1"))
        let fine = await shell("echo fine", host.homeDir, [:])
        XCTAssertTrue(fine.ok)
        XCTAssertTrue(fine.output.contains("fine"))
    }
}

final class LockedStrings: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
    var list: [String] { lock.lock(); defer { lock.unlock() }; return items }
}
