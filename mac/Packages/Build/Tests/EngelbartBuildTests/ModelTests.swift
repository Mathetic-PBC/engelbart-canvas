import XCTest
import EngelbartCore
@testable import EngelbartBuild

/// build-diff.test, build-target.test, build-events.test, build-steps.test (time to live), repo-runnables.test, the card
/// (build-card.test) and Review's opening view, as data.
final class ModelTests: XCTestCase {
    static let patch = ["diff --git a/src/a.cjs b/src/a.cjs", "index 1111111..2222222 100644", "--- a/src/a.cjs", "+++ b/src/a.cjs", "@@ -1,3 +1,3 @@ function a()", " keep", "-old", "+new",
                        "\\ No newline at end of file", "diff --git a/logo.png b/logo.png", "new file mode 100644", "index 0000000..3333333", "Binary files /dev/null and b/logo.png differ", ""].joined(separator: "\n")
    static let files: [JSONValue] = [["path": "src/a.cjs", "was": .null, "status": "M", "adds": 1, "dels": 1, "binary": false], ["path": "logo.png", "was": .null, "status": "A", "adds": 0, "dels": 0, "binary": true]]

    func testAPatchBecomesAHeaderPerFileAndItsLines() {
        let (rows, cut, truncated) = BuildDiffRows.rows(["files": .array(ModelTests.files), "patch": .string(ModelTests.patch)])
        XCTAssertEqual(rows.map { [$0.kind, $0.kind == "file" ? $0.path : $0.text] }, [["file", "src/a.cjs"], ["hunk", "@@ -1,3 +1,3 @@ function a()"], ["ctx", " keep"], ["del", "-old"], ["add", "+new"],
                                                                                    ["note", "No newline at end of file"], ["file", "logo.png"], ["note", "Binary file"]])
        XCTAssertTrue(rows[6].binary)
        XCTAssertEqual(cut, 0); XCTAssertFalse(truncated)
        let t = BuildDiffRows.totals(ModelTests.files)
        XCTAssertEqual([t.files, t.adds, t.dels], [2, 1, 1])
    }

    func testALongDiffIsCutAndAnUnreachedFileKeepsItsHeader() {
        let (rows, cut, _) = BuildDiffRows.rows(["files": .array(ModelTests.files + [["path": "late.txt", "adds": 3, "dels": 0]]), "patch": .string(ModelTests.patch), "truncated": true], maxLines: 2)
        XCTAssertEqual(cut, 3)
        XCTAssertEqual(rows.filter { $0.kind == "file" }.map(\.path), ["src/a.cjs", "logo.png", "late.txt"])
        XCTAssertEqual(BuildDiffRows.nextAttachment([], []), 1)
        XCTAssertEqual(BuildDiffRows.nextAttachment([["role": "you", "images": [["n": 1, "id": "a"], ["n": 2, "id": "b"]]], ["role": "agent"]], [3]), 4)
    }

    final class Memory: BuildTarget.Storage {
        var held: [String: String] = [:]
        func get(_ key: String) -> String? { held[key] }
        func set(_ key: String, _ value: String) { held[key] = value }
    }
    static let list: [JSONValue] = [["kind": "default", "name": "repo"], ["kind": "project", "name": "code"], ["kind": "library", "id": "row-1", "name": "owner/app", "place": "github"]]

    func testThePickIsRememberedPerWorkspaceTheDefaultOtherwise() {
        let s = Memory()
        let d = BuildTarget.defaultTarget
        XCTAssertEqual(BuildTarget.picked("p1", "w1", ModelTests.list, storage: s), d)
        BuildTarget.remember("p1", "w1", ["kind": "library", "id": "row-1", "name": "ignored", "folder": "/not/kept"], storage: s)
        XCTAssertEqual(BuildTarget.picked("p1", "w1", ModelTests.list, storage: s), ["kind": "library", "id": "row-1"], "only what names it is kept")
        XCTAssertEqual(BuildTarget.picked("p1", "w2", ModelTests.list, storage: s), d)
        XCTAssertEqual(BuildTarget.picked("p2", "w1", ModelTests.list, storage: s), d)
        XCTAssertEqual(BuildTarget.picked("p1", "w1", Array(ModelTests.list.prefix(2)), storage: s), d, "a row no longer listed")
        XCTAssertEqual(BuildTarget.picked("p1", "w1", [], storage: s), d)
        XCTAssertEqual(BuildTarget.picked("p1", "w1", ModelTests.list, storage: nil), d, "storage that fails changes nothing")
        let old = Memory()
        old.held["engelbart:build-target:p1"] = "{\"kind\":\"project\"}"
        XCTAssertEqual(BuildTarget.picked("p1", "w1", ModelTests.list, storage: old), ["kind": "project"], "the old per-project pick")
        XCTAssertEqual(BuildTarget.picked("p2", "w1", ModelTests.list, storage: old), d)
        XCTAssertEqual(ModelTests.list.map { BuildTarget.tag($0) }, ["default", "project", "github"])
        XCTAssertEqual(BuildTarget.tag(ModelTests.list[2], sandboxed: true), "sandbox")
        XCTAssertEqual(BuildTarget.key(ModelTests.list[2]), "library:row-1")
        XCTAssertTrue(BuildTarget.same(ModelTests.list[2], ["kind": "library", "id": "row-1"]))
        XCTAssertFalse(BuildTarget.same(ModelTests.list[0], ModelTests.list[1]))
    }

    func ev(_ text: String, _ kind: String = "stdout", _ data: [String: JSONValue] = [:]) -> RunEvent { RunEvent(text: text, kind: kind, data: data) }

    func testTerminalLinesProgressFramesNewlinesAndSeparateRecords() {
        XCTAssertEqual(BuildEvents.terminalLines([ev("Resolving deltas: 41% (7/17)\rResolving deltas: 47% (8/17)\r", "status")]), [.init(kind: "status", text: "Resolving deltas: 47% (8/17)")])
        XCTAssertEqual(BuildEvents.terminalLines([ev("10%\r"), ev("50%\r"), ev("100%\nDone\n")]), [.init(kind: "stdout", text: "100%"), .init(kind: "stdout", text: "Done")])
        XCTAssertEqual(BuildEvents.terminalLines([ev("one\r"), ev("\ntw"), ev("o\n\nthree\r\nfour")]).map(\.text), ["one", "two", "", "three", "four"])
        let lines = BuildEvents.terminalLines([ev("10%\r"), ev("Error: permission denied\n", "stderr"), ev("20%\r"), ev("First status", "status"), ev("Second status", "status"),
                                               ev("fatal error\nDetails retained", "error"), ev("install fragment", "stdout", ["stage": "install"]), ev("app fragment", "stdout", ["stage": "app"])])
        XCTAssertEqual(lines.map(\.text), ["10%", "Error: permission denied", "20%", "First status", "Second status", "fatal error", "Details retained", "install fragment", "app fragment"])
        XCTAssertEqual(lines[1].kind, "stderr"); XCTAssertEqual(lines[5].kind, "error")
        XCTAssertEqual(BuildEvents.terminalLines([ev("\u{1b}[32mWorking\u{1b}[0m\r\u{1b}[2KDone\n")]), [.init(kind: "stdout", text: "Done")])
        let run: JSONValue = ["id": "run", "build_log": [
            ["message": "Partial ", "kind": "stdout", "data": ["phase": "log", "stream": "stdout"]], ["message": "line\n10%\r", "kind": "stdout", "data": ["phase": "log", "stream": "stdout"]],
            ["message": "100%\r\n", "kind": "stdout", "data": ["phase": "log", "stream": "stdout"]], ["message": "Legacy first", "kind": "stdout"], ["message": "Legacy second", "kind": "stdout"],
            ["message": "Clone 40%\rClone 100%", "kind": "status"]]]
        XCTAssertEqual(BuildEvents.terminalLines(CanvasBuild.buildEvents(run)).map(\.text), ["Partial line", "100%", "Legacy first", "Legacy second", "Clone 100%"])
        XCTAssertEqual(BuildEvents.plainError("Sandbox failed: [E2B] boom"), "Sandbox failed.")
    }

    static func at(_ s: Int) -> String { Time.iso(Date(timeIntervalSince1970: 1_790_078_400 + Double(s))) } // 2026-09-21T12:00:00Z
    static func entry(_ s: Int, _ message: String, _ data: JSONValue? = nil, _ kind: String = "status") -> JSONValue {
        var e: [String: JSONValue] = ["time": .string(at(s)), "message": .string(message), "kind": .string(kind)]
        if let data { e["data"] = data }
        return .object(e)
    }

    func testTimeToLiveIsWallTimeToTheFirstVerifiedPreviewAndSurvivesRotationAndRestarts() {
        let e = ModelTests.entry
        var run: [String: JSONValue] = ["id": "run", "status": "ready", "sandbox_id": "sandbox", "created_at": .string(ModelTests.at(0)), "build_log": [
            e(1, "Starting repository setup", nil, "status"), e(4, "npm ci", ["phase": "stage", "stage": "install"], "command"), e(6, "Starting agent", ["phase": "agent", "status": "starting"], "status"),
            e(55, "Preview verified", ["phase": "check", "status": "ok"], "status"), e(56, "Preview ready", nil, "status"), e(70, "Agent finished", ["phase": "agent", "status": "done", "elapsed_ms": 64000], "status"),
            e(120, "Preview ready", nil, "status"), e(900, "Application healthy", ["phase": "app_status"], "status")]]
        XCTAssertEqual(CanvasBuild.timeToLive(.object(run)), 56000)
        run["status"] = "failed"
        XCTAssertEqual(CanvasBuild.timeToLive(.object(run)), 56000)
        let history = [e(0, "Starting repository setup", nil, "status"), e(84, "Preview ready", nil, "status")]
        var rotated: [String: JSONValue] = ["id": "run", "status": "ready", "created_at": .string(ModelTests.at(0)), "build_milestones": .object(BuildHistory.collectMilestones(history)),
                                            "build_log": [e(900, "Application output", ["phase": "log"], "stdout")]]
        XCTAssertEqual(CanvasBuild.timeToLive(.object(rotated)), 84000)
        rotated["created_at"] = nil
        XCTAssertEqual(CanvasBuild.timeToLive(.object(rotated)), 84000, "an explicit setup-start event is also evidence")
        var restarted = history + [e(300, "Restarting app", ["lifecycle": "restart", "phase": "setup", "status": "reusing"], "status")]
        XCTAssertNil(CanvasBuild.timeToLive(["id": "run", "status": "starting", "created_at": .string(ModelTests.at(0)), "build_log": .array(restarted)]))
        restarted.append(e(307, "Preview ready", ["phase": "ready"], "status"))
        XCTAssertEqual(CanvasBuild.timeToLive(["id": "run", "status": "ready", "created_at": .string(ModelTests.at(0)), "build_log": .array(restarted)]), 7000)
        XCTAssertNil(CanvasBuild.timeToLive(nil))
        XCTAssertEqual(RunSteps.formatDuration(56000), "56s"); XCTAssertEqual(RunSteps.formatDuration(125_000), "2m 5s")
        let steps = CanvasBuild.steps(.object(run), repoName: "app")
        XCTAssertEqual(steps.map(\.id).first, "sandbox")
        XCTAssertTrue(steps.contains { $0.id == "agent" }, "the setup agent replaces the empty Run Plan")
    }

    func testRunnablesFoldersNamesCommandsAndTheStoreSemantics() async throws {
        XCTAssertEqual(try Runnables.folder(""), ".")
        XCTAssertEqual(try Runnables.folder("apps//desktop/"), "apps/desktop")
        XCTAssertEqual(try Runnables.folder("./web"), "web")
        for bad in ["/etc", "..", "../x", "a/../../b", "a\\b"] { XCTAssertThrowsError(try Runnables.folder(bad), bad) }
        XCTAssertThrowsError(try Runnables.command("  ")) { XCTAssertTrue($0.text.contains("required")) }
        XCTAssertNil(try Runnables.command(nil, optional: true))
        XCTAssertEqual(Runnables.withPort("PORT={port} node server.js --port {port}", 5301), "PORT=5301 node server.js --port 5301")
        let table = MemoryRunnablesTable(knownLibrary: { $0 == "repo" })
        let store = RunnableStore(table)
        let web = try await store.declare("repo", folder: "web/", name: "web", type: "ui")
        XCTAssertEqual([web.folder, web.name, web.type, web.status], ["web", "web", "ui", "pending"])
        let again = try await store.declare("repo", folder: "./web", name: "web", type: "ui")
        XCTAssertEqual(again.id, web.id, "the same folder and name is the same runnable")
        do { _ = try await store.declare("other", folder: nil, name: "x", type: "ui"); XCTFail() } catch { XCTAssertEqual((error as? BuildError)?.code, "23503") }
        do { _ = try await store.verify(web.id, install: nil, run: "npm run dev -- --port 5173", commit: "abc1234"); XCTFail() } catch { XCTAssertTrue(error.text.contains("must hold {port}")) }
        let ok = try await store.verify(web.id, install: "npm ci", run: "npm run dev -- --port {port}", commit: "abc1234")!
        XCTAssertEqual([ok.status, ok.installCommand, ok.runCommand, ok.verifiedCommit], ["verified", "npm ci", "npm run dev -- --port {port}", "abc1234"])
        let bad = try await store.fail(web.id, "Error: Cannot find module vite")!
        XCTAssertEqual([bad.status, bad.runCommand, bad.lastError], ["failed", "npm run dev -- --port {port}", "Error: Cannot find module vite"])
        let moved = try await store.declare("repo", folder: "web", name: "web", type: "app")
        XCTAssertEqual(moved.status, "pending"); XCTAssertNil(moved.runCommand)
        let app = try await store.verify(moved.id, install: nil, run: "npm start", commit: "not a sha")!
        XCTAssertEqual(app.status, "verified"); XCTAssertNil(app.verifiedCommit, "a bad commit is not kept")
        let cli = try await store.declare("repo", folder: nil, name: "cli", type: "terminal")
        XCTAssertEqual(cli.folder, ".")
        let listed = try await store.list("repo")
        XCTAssertEqual(listed.map { "\($0.folder):\($0.name)" }, [".:cli", "web:web"])
    }

    func testTheCardWaitsForTheRunStepAndAnAcceptedBuildOffersStopEach() {
        let working = BuildCardModel(id: "b1", task: ["id": "b1", "title": "Add a page", "status": "review", "modelName": "Opus", "effort": "high", "messages": [],
                                                      "runStep": ["status": "running", "phase": "Starting web", "runnables": [["name": "web", "type": "ui", "status": "checking"]]]])
        XCTAssertEqual(working.status, "Getting it running…")
        XCTAssertEqual(working.runLabel, "Getting it running…"); XCTAssertEqual(working.runNote, "Starting web")
        XCTAssertTrue(working.actions.first { $0.act == "buildpreview" }!.disabled && working.actions.first { $0.act == "buildaccept" }!.disabled)
        XCTAssertTrue(working.runActions.contains { $0.act == "buildrunstop" } && working.actions.contains { $0.act == "buildreject" })
        XCTAssertEqual(working.replyPlaceholder, "Reply…", "a reply still goes (it halts the run step)")
        for status in ["done", "failed", "stopped"] {
            let after = BuildCardModel(id: "b1", task: ["id": "b1", "status": "review", "messages": [], "runStep": ["status": .string(status), "runnables": []]])
            XCTAssertEqual(after.status, "Ready to review")
            XCTAssertFalse(after.actions.first { $0.act == "buildaccept" }!.disabled)
        }
        let runnables: [JSONValue] = [["name": "web", "folder": ".", "type": "ui", "status": "running", "passed": true, "url": "http://localhost:5173/"],
                                      ["name": "cli", "folder": ".", "type": "terminal", "status": "stopped", "passed": true],
                                      ["name": "desk", "folder": "app", "type": "app", "status": "failed", "error": "It exited."]]
        let open = BuildCardModel(id: "b1", task: ["id": "b1", "status": "review", "messages": [], "runStep": ["status": "done", "runnables": .array(runnables)]])
        XCTAssertEqual(open.runLabel, "Run step"); XCTAssertEqual(open.runNote, "Preview opens what runs")
        XCTAssertEqual(open.runRows.map { "\($0.name) \($0.kind) \($0.state)\($0.error.map { " · \($0)" } ?? "")" }, ["web web UI runs at http://localhost:5173/", "cli terminal stopped", "desk desktop app did not run · It exited."])
        XCTAssertTrue(open.runRows.allSatisfy { $0.actions.isEmpty }, "no Open on the card before Accept")
        let kept = BuildCardModel(id: "b1", task: ["id": "b1", "status": "accepted", "final": true, "keptCopy": true, "accepted": ["sha": "abc"], "messages": [], "runStep": ["status": "done", "runnables": .array(runnables)]])
        XCTAssertEqual(kept.runLabel, "Running on what landed")
        XCTAssertEqual(kept.runRows.map(\.name), ["web", "cli"], "what did not run is not listed")
        XCTAssertEqual(kept.runActions.map(\.act) + kept.runRows.flatMap { $0.actions.map { "\($0.act):\($0.run!)" } }, ["buildrunstopall", "buildrunshow:web", "buildrunstopone:web"])
        XCTAssertEqual(kept.actions.map(\.act), ["buildreview"], "stopped first, then removed")
        let released = BuildCardModel(id: "b1", task: ["id": "b1", "status": "accepted", "final": true, "keptCopy": false, "accepted": ["sha": "abc"], "messages": [], "runStep": ["status": "done", "runnables": []]])
        XCTAssertNil(released.runLabel, "nothing runs: no section")
        XCTAssertTrue(released.actions.contains { $0.act == "buildremove" })
        XCTAssertEqual(BuildCardModel(id: "b2", task: ["id": "b2", "status": "review", "messages": [], "postIt": "  "]).prompt, nil)
        XCTAssertEqual(BuildCardModel(id: "b9", task: ["id": "b9", "status": "accepted", "final": true, "messages": [], "postIt": "Add Haiku"]).prompt, "Add Haiku", "in every state")
        XCTAssertTrue(BuildCardModel(id: "zz", task: nil).missing)
        let stopped = BuildCardModel(id: "b3", task: ["id": "b3", "status": "stopped", "messages": [["role": "agent", "text": "x"]], "error": "rate limited"])
        XCTAssertEqual(stopped.actions.map(\.act), ["buildpreview", "buildresume", "buildreject", "buildaccept"])
        XCTAssertEqual(stopped.errorLine, "rate limited")
    }

    func testReviewOpensOnWhatRunsElseTheDiff() {
        let runs = BuildReviewModel(task: ["runStep": ["status": "done", "runnables": [["name": "web", "type": "ui", "status": "running", "url": "http://localhost:5173/"], ["name": "desktop", "type": "app", "status": "failed"]]]])
        XCTAssertEqual(runs.initialView, "running"); XCTAssertTrue(runs.hasTabs)
        XCTAssertEqual(BuildReviewModel.whereText(runs.runnables[0]), "runs at http://localhost:5173/")
        let failed = BuildReviewModel(task: ["runStep": ["status": "done", "runnables": [["name": "desktop", "type": "app", "status": "failed"]]]])
        XCTAssertEqual(failed.initialView, "changes"); XCTAssertTrue(failed.hasTabs, "Running is still there to look at")
        let none = BuildReviewModel(task: ["runStep": ["status": "done", "runnables": []]])
        XCTAssertFalse(none.hasTabs, "nothing ran: no tabs")
        XCTAssertEqual(none.shown("running"), "changes")
        XCTAssertEqual(BuildReviewModel.lineTone("diff --git a/x b/x"), "file"); XCTAssertEqual(BuildReviewModel.lineTone("+++ b/x"), "meta"); XCTAssertEqual(BuildReviewModel.lineTone("+a"), "add")
    }

    func testMilestonesKeepFirstAndLastEvidenceAndTheAgentTail() {
        let entries: [JSONValue] = [["message": "Starting repository setup"], ["message": "npm ci", "kind": "command", "data": ["phase": "stage", "stage": "install"]],
                                    ["message": "out", "kind": "stdout"], ["message": "a", "data": ["phase": "agent", "status": "working"]]]
        let m = BuildHistory.collectMilestones(entries)
        XCTAssertNotNil(m["message:Starting repository setup"])
        XCTAssertNotNil(m["command:install"])
        XCTAssertEqual(m["agent:activity"]?["entries"]?.array?.count, 1)
        XCTAssertNil(BuildHistory.milestoneKey(["message": "out", "kind": "stdout"]))
        XCTAssertEqual(BuildHistory.milestoneKey(["message": "plan · running"]), "plan:::running")
    }
}
