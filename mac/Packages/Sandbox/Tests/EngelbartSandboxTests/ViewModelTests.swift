import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// SandboxProgress.jsx (snapshot + events, ensure, open/terminal/build, cross-window sync), the touch hooks, and
// EnvironmentPanel.jsx's state (ledger #123–126, #131–134).
@MainActor
final class ViewModelTests: XCTestCase {
    final class Calls: @unchecked Sendable {
        let ensures = Locked(0)
        let touches = Locked<[String]>([])
        let opened = Locked<[(String, Bool)]>([])
        let terminals = Locked<[String]>([])
        let saves = Locked<[[EnvironmentChange]]>([])
        let restarts = Locked<[String]>([])
        let snapshot = Locked<[JSONValue]>([])
        let saved = Locked(EnvironmentDescription(revision: nil, names: [], removed: [], report: nil))
        let saveError = Locked<String?>(nil)
    }

    func api(_ c: Calls) -> SandboxAPI {
        SandboxAPI(runs: { c.snapshot.value }, ensure: { c.ensures.with { $0 += 1 }; return [] },
                   terminal: { id in c.terminals.with { $0.append(id) }; return ["id": "session-1", "provider": "sandbox"] },
                   touch: { id in c.touches.with { $0.append(id) } }, environment: { _ in c.saved.value },
                   saveEnvironment: { _, changes, revision in
                       if let e = c.saveError.value { throw SandboxError(e) }
                       c.saves.with { $0.append(changes) }
                       let names = Set(c.saved.value.names).union(changes.filter { $0.value != nil }.map(\.name)).subtracting(changes.filter { $0.value == nil }.map(\.name))
                       let next = EnvironmentDescription(revision: IDs.new(), names: names.sorted(), removed: changes.filter { $0.value == nil }.map(\.name), report: nil)
                       c.saved.with { $0 = next }
                       return next
                   },
                   restart: { id in c.restarts.with { $0.append(id) } }, openURL: { url, inWorkspace in c.opened.with { $0.append((url, inWorkspace)) } })
    }

    let root = "/fixture/main"
    func run(_ status: String, id: String = "run", library: String = "repo", _ extra: [String: JSONValue] = [:]) -> JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "library_id": .string(library), "status": .string(status), "created_at": "2026-09-23T12:00:00.000Z",
                                      "updated_at": "2026-09-23T12:00:10.000Z", "preview_url": status == "ready" ? "https://preview.example/" : .null,
                                      "build_log": status == "ready" ? [["time": "2026-09-23T12:00:10.000Z", "message": "Preview ready"]] : []]
        for (k, v) in extra { o[k] = v }
        return .object(o)
    }

    func testSnapshotEventsAndEnsure() async throws {
        let c = Calls(), hub = EventHub(), storage = MemoryStorage()
        c.snapshot.with { $0 = [["run": run("starting"), "message": "Creating sandbox", "sandbox": nil]] }
        let model = SandboxProgressModel(dataRoot: root, api: api(c), storage: storage, hub: hub)
        await eventually { model.items["repo"]?.run["status"] == "starting" }
        XCTAssertEqual(model.items["repo"]?.message, "Creating sandbox")
        await eventually { c.ensures.value == 1 }
        hub.post(SandboxService.progressEvent, ["dataRoot": .string(root), "run": run("ready"), "message": "Preview ready", "sandbox": "running", "notification": "preview-ready"])
        hub.post(SandboxService.progressEvent, ["dataRoot": "/fixture/test", "run": run("failed", id: "other", library: "other")])
        await eventually { model.items["repo"]?.run["status"] == "ready" }
        XCTAssertNil(model.items["other"], "another root's events are not this window's")
        XCTAssertEqual(model.unread, 1)
        XCTAssertEqual(model.items["repo"]?.sandbox, "running")
        model.library = [["id": "repo", "name": "owner/app", "url": "https://github.com/owner/app"]]
        await eventually { c.ensures.value == 2 }
        model.setGithubSignedIn(true)
        model.setClaudeSignedIn(true)
        await eventually { c.ensures.value == 4 }
        model.setGithubSignedIn(true)
        await settle()
        XCTAssertEqual(c.ensures.value, 4, "only a change prepares again")
        model.setDataRoot("/fixture/test")
        XCTAssertEqual(model.items, [:])
        XCTAssertEqual(model.notifications, [])
    }

    func testReadsAndClearsArePersistedAndSyncedAcrossWindows() async throws {
        let c = Calls(), hub = EventHub(), storage = MemoryStorage()
        let a = SandboxProgressModel(dataRoot: root, api: api(c), storage: storage, hub: hub)
        let b = SandboxProgressModel(dataRoot: root, api: api(c), storage: storage, hub: hub)
        hub.post(SandboxService.progressEvent, ["dataRoot": .string(root), "run": run("ready"), "message": ""])
        await eventually { a.unread == 1 && b.unread == 1 }
        a.markRead(a.rows.map(\.id))
        XCTAssertEqual(a.unread, 0)
        XCTAssertTrue(storage.values[SandboxNotifications.storageKey(root)]!.contains("\"read\":true"))
        await eventually(3, "the other window reads it too") { b.unread == 0 }
        a.clear(a.rows.map(\.id))
        await eventually(3, "and clears it") { b.rows.isEmpty }
        let reloaded = SandboxProgressModel(dataRoot: root, api: api(c), storage: storage, hub: hub)
        XCTAssertEqual(reloaded.state.dismissed["repo"], "2026-09-23T12:00:10.000Z")
    }

    func testOpenPreviewRepositoryTerminalAndBuild() async throws {
        let c = Calls(), hub = EventHub()
        let model = SandboxProgressModel(dataRoot: root, api: api(c), inWorkspace: false, storage: MemoryStorage(), hub: hub)
        let ready = run("ready", ["kind": "both", "terminal": ["cwd": ".", "hint": "make"]])
        hub.post(SandboxService.progressEvent, ["dataRoot": .string(root), "run": ready, "message": ""])
        await eventually { model.unread == 1 }
        model.open(ready)
        XCTAssertEqual(c.opened.value.map(\.0), ["https://preview.example/"])
        XCTAssertEqual(c.opened.value.map(\.1), [false], "outside a workspace: the default browser")
        XCTAssertEqual(model.unread, 0, "opening marks it read")
        model.open(run("starting"))
        XCTAssertEqual(c.opened.value.count, 1, "only a ready preview opens")
        model.openRepository(["url": "https://github.com/owner/app"])
        XCTAssertEqual(c.opened.value.last?.0, "https://github.com/owner/app")
        model.openTerminal(ready)
        XCTAssertEqual(model.error, "Open a project to use the sandbox terminal.")
        XCTAssertEqual(c.terminals.value, [])
        model.inWorkspace = true
        let shown = Locked<JSONValue?>(nil)
        hub.on(SandboxNotifications.openSandboxTerminal) { p in shown.with { $0 = p } }
        model.openTerminal(ready, show: false)
        await eventually { shown.value != nil }
        XCTAssertEqual(c.terminals.value, ["repo"])
        XCTAssertEqual(shown.value, ["session": ["id": "session-1", "provider": "sandbox"], "show": false])
        XCTAssertEqual(model.busy["run"], false)
        model.open(ready)
        XCTAssertEqual(c.opened.value.last?.1, true, "in a workspace: the Stage")
        model.openTerminal(run("ready"))
        await settle()
        XCTAssertEqual(c.terminals.value.count, 1, "an interface has no terminal")
        model.openBuild(["id": "repo"])
        XCTAssertEqual(model.buildRepoId, "repo")
        model.closeBuild()
        XCTAssertNil(model.buildRepoId)
    }

    func testTouchPingsWhileFocusedAndInFront() async throws {
        let pings = Locked<[String]>([])
        let touch = SandboxTouch(interval: 0.05) { id in pings.with { $0.append(id) } }
        touch.update(libraryId: "repo", focused: false)
        await settle()
        XCTAssertEqual(pings.value, [], "a window without the keyboard pings nothing")
        touch.update(libraryId: "repo", focused: true)
        await eventually { pings.value.count >= 3 }
        touch.update(libraryId: nil, focused: true)
        let stopped = pings.value.count
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertLessThanOrEqual(pings.value.count, stopped + 1, "another tab in front stops it")
        let items = ["repo": SandboxItem(run: run("ready"), message: "", sandbox: nil)]
        pings.with { $0 = [] }
        touch.updatePreview(url: "https://preview.example/page", showing: true, items: items, focused: true)
        await eventually { pings.value.first == "repo" }
        touch.updatePreview(url: "https://elsewhere.example/", showing: true, items: items, focused: true)
        let after = pings.value.count
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertLessThanOrEqual(pings.value.count, after + 1, "a page that is no preview pings nothing")
        touch.stop()
    }

    func testEnvironmentPanelAddSaveRestartAndRows() async throws {
        let c = Calls()
        c.saved.with { $0 = EnvironmentDescription(revision: "r1", names: ["SAVED_KEY"], removed: [], report: nil) }
        let ready = run("ready", ["sandbox_id": "sb", "env_revision": "r1", "env_report": ["variables": [["name": "OPENAI_API_KEY", "status": "missing", "requirement": "required", "group": "required", "public": false]], "missing": [], "local": []]])
        let model = EnvironmentPanelModel(libraryId: "repo", run: ready, api: api(c))
        await eventually { model.saved != nil }
        XCTAssertEqual(model.rows.map(\.name), ["OPENAI_API_KEY", "SAVED_KEY"])
        XCTAssertTrue(model.needsValue(model.rows[0]))
        XCTAssertEqual(model.note(model.rows[0]), "Required · no value")
        XCTAssertEqual(model.note(model.rows[1]), "Saved")
        XCTAssertEqual(model.action(model.rows[1]), "Remove")
        XCTAssertEqual(model.placeholder(model.rows[1]), "Saved · leave unchanged")
        XCTAssertTrue(model.canRestart)
        XCTAssertEqual(model.restartTitle, "Save & restart app")
        model.name = "1BAD"
        model.add()
        XCTAssertEqual(model.error, "Use letters, digits and underscores; do not start with a digit. Runner configuration names are reserved.")
        model.name = "NEW_KEY"; model.value = "v"
        await model.save(restart: false)
        XCTAssertEqual(model.error, "Click Add to include the new variable before saving.")
        model.add()
        XCTAssertEqual(model.changes["NEW_KEY"], .some("v"))
        XCTAssertEqual(model.note(model.rows.first { $0.name == "NEW_KEY" }!), "Unsaved change")
        model.toggle(model.rows.first { $0.name == "SAVED_KEY" }!)
        XCTAssertTrue(model.isRemoving("SAVED_KEY"))
        XCTAssertEqual(model.action(model.rows.first { $0.name == "SAVED_KEY" }!), "Undo")
        XCTAssertEqual(model.placeholder(model.rows.first { $0.name == "SAVED_KEY" }!), "Will be removed")
        await model.save(restart: false)
        XCTAssertEqual(model.notice, "Saved. Restart the app to apply.")
        XCTAssertEqual(c.saves.value.last, [EnvironmentChange(name: "NEW_KEY", value: "v"), EnvironmentChange(name: "SAVED_KEY", value: nil)])
        XCTAssertEqual(model.changes.count, 0)
        XCTAssertTrue(model.pending, "a revision newer than the run's: used on the next launch")
        model.setValue("x", for: "OPENAI_API_KEY")
        await model.save(restart: true)
        XCTAssertEqual(model.notice, "Restarting app…")
        XCTAssertEqual(c.restarts.value, ["repo"])
        model.run = run("ready", ["sandbox_id": "sb", "kind": "terminal", "terminal": ["cwd": ".", "hint": "make"]])
        XCTAssertEqual(model.restartTitle, "Save & restart terminal")
        model.setValue("y", for: "OPENAI_API_KEY")
        await model.save(restart: true)
        XCTAssertEqual(model.notice, "Saved. The next terminal opened has the new values.")
        c.saveError.with { $0 = "Environment changed elsewhere. Reload the environment panel before saving." }
        model.setValue("z", for: "OPENAI_API_KEY")
        await model.save(restart: false)
        XCTAssertEqual(model.error, "Environment changed elsewhere. Reload the environment panel before saving.")
        await model.reload()
        XCTAssertEqual(model.error, "")
        XCTAssertEqual(model.notice, "Reloaded saved names. Review your draft changes before saving.")
        model.run = run("starting")
        XCTAssertFalse(model.canRestart)
    }
}
