import XCTest
import EngelbartCore
@testable import EngelbartSandbox

/// localStorage, in memory.
final class MemoryStorage: NotificationStorage {
    var values: [String: String] = [:]
    var failing = false
    func getItem(_ key: String) -> String? { values[key] }
    func setItem(_ key: String, _ value: String) throws { if failing { throw SandboxError("Disabled") }; values[key] = value }
}

// test/sandbox-notifications.test.cjs (the model; the markup assertions are the views')
final class NotificationsTests: XCTestCase {
    typealias N = SandboxNotifications
    let root = "/fixture/main"
    func at(_ s: Int) -> String { "2026-09-23T12:00:\(String(format: "%02d", s)).000Z" }
    func run(_ status: String, _ changes: [String: JSONValue] = [:]) -> JSONValue {
        var o: [String: JSONValue] = ["id": "run", "library_id": "repo", "status": .string(status), "created_at": .string(at(0)), "updated_at": .string(at(10)),
                                      "preview_url": status == "ready" ? "https://preview.example/" : .null,
                                      "build_log": status == "ready" ? [["time": .string(at(10)), "message": "Preview ready"]] : []]
        for (k, v) in changes { o[k] = v }
        return .object(o)
    }
    func progress(_ value: JSONValue, _ extra: [String: JSONValue] = [:]) -> N.Action {
        var o: [String: JSONValue] = ["dataRoot": .string(root), "run": value]
        for (k, v) in extra { o[k] = v }
        return .progress(.object(o))
    }
    func readyState() -> SandboxProgressState { N.reduce(SandboxProgressState(dataRoot: root), progress(run("ready"), ["notification": "preview-ready"])) }

    func testPhasesNotifyAndStaleRunsCannotOverwrite() {
        for value in [run("starting"), run("failed"), run("ready", ["preview_url": .null])] {
            let state = N.reduce(SandboxProgressState(dataRoot: root), progress(value))
            XCTAssertEqual(N.available(state.notifications, state.items).count, 1)
            XCTAssertEqual(state.notifications[0].status, value["status"]?.string)
        }
        XCTAssertEqual(N.reduce(SandboxProgressState(dataRoot: root), progress(run("stopped"))).notifications, [])
        var state = readyState()
        XCTAssertEqual(N.reduce(state, .progress(["dataRoot": "/fixture/test", "run": run("ready")])), state)
        state = N.reduce(state, progress(run("starting", ["id": "new-run", "created_at": .string(at(30)), "updated_at": .string(at(30))])))
        XCTAssertEqual(N.reduce(state, progress(run("ready"))), state)
        XCTAssertEqual(state.items["repo"]?.run["id"], "new-run")
        XCTAssertEqual(state.notifications[0].runId, "new-run")
        XCTAssertEqual(state.notifications[0].status, "starting")
    }

    func testReadStateSurvivesReloadsAndStorageIsBounded() {
        let storage = MemoryStorage()
        var state = readyState()
        state = N.reduce(state, .read([state.notifications[0].id]))
        N.write(storage, root, SavedNotifications(notifications: state.notifications, dismissed: state.dismissed))
        XCTAssertFalse(storage.values[N.storageKey(root)]!.contains("preview"))
        state = SandboxProgressState(dataRoot: root, saved: N.read(storage, root))
        state = N.reduce(state, progress(run("ready", ["updated_at": .string(at(40)), "build_log": []])))
        XCTAssertEqual(state.notifications.count, 1)
        XCTAssertTrue(state.notifications[0].read)
        XCTAssertEqual(N.read(storage, "/fixture/test"), SavedNotifications())
        storage.values[N.storageKey(root)] = "{bad"
        XCTAssertEqual(N.read(storage, root), SavedNotifications())
        storage.values[N.storageKey(root)] = "[null,{},5]"
        XCTAssertEqual(N.read(storage, root), SavedNotifications())
        storage.failing = true
        N.write(storage, root, SavedNotifications(notifications: state.notifications))
        for i in 0..<50 { state = N.reduce(state, progress(run("ready", ["id": .string("run-\(i)"), "library_id": .string("repo-\(i)")]))) }
        XCTAssertEqual(state.notifications.count, 40)
    }

    func testReadOneAndRootReset() {
        var state = readyState()
        state = N.reduce(state, progress(run("ready", ["id": "other", "library_id": "other"])))
        state = N.reduce(state, .read([state.notifications[0].id]))
        XCTAssertEqual(state.notifications.filter { !$0.read }.count, 1)
        state = N.reduce(state, .reset(dataRoot: "/fixture/test", saved: nil))
        XCTAssertEqual(state.items, [:])
        XCTAssertEqual(state.notifications, [])
    }

    func testClearingKeepsRunsAndLaterArrivals() {
        var state = readyState()
        let firstId = state.notifications[0].id
        state = N.reduce(state, progress(run("ready", ["id": "other", "library_id": "other"])))
        let items = state.items
        state = N.reduce(state, .clear([firstId]))
        XCTAssertEqual(state.notifications.map(\.libraryId), ["other"])
        XCTAssertFalse(state.notifications[0].read)
        XCTAssertEqual(state.items, items)
        XCTAssertEqual(N.reduce(state, .clear([firstId])), state)
        let visible = state.notifications.map(\.id)
        state = N.reduce(state, progress(run("ready", ["id": "later", "library_id": "later"])))
        state = N.reduce(state, .clear(visible))
        XCTAssertEqual(state.notifications.map(\.libraryId), ["later"])
    }

    func testClearedStayClearedNewCompletionsAlert() {
        let storage = MemoryStorage()
        var state = readyState()
        state = N.reduce(state, .clear(state.notifications.map(\.id)))
        state = N.reduce(state, progress(run("ready"), ["notification": "preview-ready"]))
        XCTAssertEqual(state.notifications, [])
        N.write(storage, root, SavedNotifications(notifications: state.notifications, dismissed: state.dismissed))
        for log in [run("ready")["build_log"]!, JSONValue.array([])] {
            state = SandboxProgressState(dataRoot: root, saved: N.read(storage, root))
            state = N.reduce(state, progress(run("ready", ["updated_at": .string(at(20)), "build_log": log])))
            XCTAssertEqual(state.notifications, [])
            XCTAssertEqual(state.items["repo"]?.run["status"], "ready")
        }
        state = N.reduce(state, progress(run("starting", ["updated_at": .string(at(30))])))
        state = N.reduce(state, progress(run("ready", ["updated_at": .string(at(40)), "build_log": [["time": .string(at(40)), "message": "Preview ready"]]]), ["notification": "preview-ready"]))
        XCTAssertEqual(state.notifications.count, 1)
        XCTAssertEqual(state.notifications[0].at, at(40))
        XCTAssertFalse(state.notifications[0].read)
    }

    func testLegacyArraysAndMalformedDismissals() {
        let notifications = readyState().notifications
        let storage = MemoryStorage()
        storage.values[N.storageKey(root)] = JSONValue.array(notifications.map(\.json)).text()
        XCTAssertEqual(N.read(storage, root), SavedNotifications(notifications: notifications))
        storage.values[N.storageKey(root)] = JSONValue.object(["notifications": .array(notifications.map(\.json)),
                                                               "dismissed": ["repo": .string(at(10)), "bad": "invalid", "null": nil, "numeric": 10]]).text()
        XCTAssertEqual(N.read(storage, root), SavedNotifications(notifications: notifications, dismissed: ["repo": at(10)]))
        for value: JSONValue in [nil, 5, ["notifications": [:], "dismissed": []]] {
            storage.values[N.storageKey(root)] = value.text()
            XCTAssertEqual(N.read(storage, root), SavedNotifications())
        }
    }

    func testBuildingNeverHidesCompletionOrFailure() {
        var state = N.reduce(SandboxProgressState(dataRoot: root), progress(run("starting")))
        state = N.reduce(state, .clear(state.notifications.map(\.id)))
        state = N.reduce(state, progress(run("starting", ["updated_at": .string(at(12))])))
        XCTAssertEqual(state.notifications, [], "progress does not re-alert")
        let failed = N.reduce(state, progress(run("failed", ["updated_at": .string(at(20)), "finished_at": .string(at(20))])))
        XCTAssertEqual(failed.notifications.first?.status, "failed")
        let ready = N.reduce(state, progress(run("ready", ["updated_at": .string(at(20))])))
        XCTAssertEqual(ready.notifications.first?.status, "ready")
    }

    func testSyncTakesOtherWindowsReadsAndDismissals() {
        let state = readyState()
        var other = state.notifications
        other[0].read = true
        let synced = N.reduce(state, .sync(SavedNotifications(notifications: other)))
        XCTAssertTrue(synced.notifications[0].read)
        let dismissed = N.reduce(state, .sync(SavedNotifications(dismissed: ["repo": at(10)])))
        XCTAssertEqual(dismissed.notifications, [])
        XCTAssertEqual(N.reduce(state, .sync(SavedNotifications())), state, "nothing is added")
    }

    func testRepositoryClickPreviewAndFailureReasons() {
        let item = { (r: JSONValue) in SandboxItem(run: r, message: "", sandbox: nil) }
        XCTAssertEqual(N.repositoryClick(item(run("ready"))), "preview")
        XCTAssertEqual(N.repositoryClick(item(run("starting"))), "details")
        XCTAssertEqual(N.repositoryClick(item(run("failed"))), "details")
        XCTAssertNil(N.repositoryClick(nil))
        XCTAssertEqual(N.repositoryClick(item(run("stopped", ["build_log": [["data": ["lifecycle": "expired"]]]]))), "start")
        XCTAssertEqual(N.repositoryClick(item(run("ready", ["kind": "terminal", "preview_url": .null, "terminal": ["cwd": ".", "hint": "x"]]))), "terminal")
        XCTAssertEqual(N.repositoryClick(item(run("ready", ["kind": "both", "terminal": ["cwd": ".", "hint": "x"]]))), "both")
        XCTAssertEqual(N.repositoryClick(item(run("ready", ["kind": "interface"]))), "preview", "runs from before kinds open as previews")
        let items = ["repo": item(run("ready"))]
        XCTAssertEqual(N.previewLibraryId(items, "https://preview.example/page?x=1"), "repo")
        XCTAssertNil(N.previewLibraryId(items, "https://other.example/"))
        XCTAssertNil(N.previewLibraryId(items, "not a url"))
        let reasons: [(String, String)] = [
            ("Setup stopped", "Setup stopped"), ("Setup was interrupted. Retry to start a new run.", "Setup stopped"),
            ("Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it).", "Claude Code not installed"),
            ("Update Claude Code to 2.1.248 or newer for restricted sandbox setup.", "Claude Code not installed"),
            ("Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in).", "Claude Code not signed in"),
            ("Desktop apps are not supported yet: this repository is an Electron app", "Desktop apps not supported yet"),
            ("Claude finished without a verified web preview.", "No web preview found"), ("npm ERR! something", "Setup failed"),
        ]
        for (error, reason) in reasons { XCTAssertEqual(N.failureReason(run("failed", ["error": .string(error)])), reason) }
        XCTAssertEqual(N.failureReason(run("ready")), "")
        XCTAssertEqual(N.sandboxStatus(run("ready"), "asleep"), "Asleep")
        XCTAssertEqual(N.sandboxStatus(run("ready"), "running"), "Running")
        XCTAssertEqual(N.sandboxStatus(run("ready"), nil), "")
        XCTAssertEqual(N.sandboxStatus(run("starting"), "running"), "")
        let carried = N.reduce(N.reduce(SandboxProgressState(dataRoot: root), progress(run("ready"), ["sandbox": "asleep"])), progress(run("ready", ["updated_at": .string(at(11))])))
        XCTAssertEqual(carried.items["repo"]?.sandbox, "asleep", "a later event without a sighting keeps the last")
    }

    func testRestartReplacesCompletionWithBuilding() {
        var state = readyState()
        state = N.reduce(state, progress(run("starting", ["updated_at": .string(at(20)), "build_log": [["time": .string(at(20)), "message": "Restarting", "data": ["lifecycle": "restart"]]]])))
        XCTAssertEqual(state.notifications.map(\.status), ["starting"])
        XCTAssertEqual(state.notifications[0].at, at(20))
    }
}
