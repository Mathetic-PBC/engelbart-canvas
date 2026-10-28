import AppKit
import EngelbartCore
import SwiftUI
import XCTest
@testable import EngelbartTools

// The setup dialog's model (ToolSetup.jsx), the update banner (test/update-banner.test.cjs), the channels and the setup
// from the environment (index.cjs / ipc.cjs). The views are drawn offscreen once each; ENGELBART_TOOLS_SNAPSHOTS=<dir>
// keeps the pictures.
@MainActor
final class ViewTests: XCTestCase {
    final class Calls { var list: [String] = [] }

    func backend(_ calls: Calls, failing: Bool = false) -> ToolSetupBackend {
        ToolSetupBackend(
            install: { calls.list.append("install \($0.joined(separator: ","))"); if failing { throw ToolsChannelError.unknownTool } },
            update: { calls.list.append("update \($0)") }, signIn: { calls.list.append("sign-in \($0)") }, cancelSignIn: { calls.list.append("cancel \($0)") },
            check: { calls.list.append("check") }, skip: { calls.list.append("skip \($0.joined(separator: ","))") }, askAgain: { calls.list.append("ask-again \($0)") },
            setUpdates: { calls.list.append("updates \($0)") }, openPage: { calls.list.append("open \($0)") })
    }

    func snap(_ statuses: [String: String], busy: [String: Busy] = [:], updates: String = "auto", skip: Set<String> = []) -> ToolsSnapshot {
        var tools: [String: ToolSnapshot] = [:]
        for id in TOOL_NAMES {
            var r = ToolRecord(blank: id)
            r.status = statuses[id] ?? "ready"
            r.installed = r.status != "missing"
            r.version = r.status == "missing" ? nil : Requirements[id].minimum
            r.skip = skip.contains(id)
            tools[id] = ToolSnapshot(record: r, busy: busy[id])
        }
        return ToolsSnapshot(checked: true, updates: updates, tools: tools)
    }

    func testTheDialogsButtonsCallWhatToolSetupJsxCalls() {
        let calls = Calls()
        var closed = 0
        let model = ToolSetupModel(snapshot: snap(["git": "missing", "claude": "failed", "codex": "signed-out"]), ids: TOOL_ORDER, backend: backend(calls), onClose: { closed += 1 })
        XCTAssertEqual(model.title, "Set up Engelbart")
        for row in model.rows { model.act(row) }
        XCTAssertEqual(calls.list, ["install git", "check", "sign-in codex"], "retry checks again when it is installed")
        calls.list = []
        model.snapshot = snap(["claude": "failed"].merging(["claude": "missing"]) { $1 }, busy: ["codex": Busy(action: "sign-in", url: "https://x.example/sign")])
        let codex = model.rows.first { $0.id == "codex" }!
        model.act(codex)
        model.openPage(codex.page!)
        model.act(model.rows.first { $0.id == "claude" }!)
        XCTAssertEqual(calls.list, ["cancel codex", "open https://x.example/sign", "install claude"])
        XCTAssertEqual(closed, 0)
        var outdated = snap(["codex": "outdated"])
        outdated.tools["codex"]?.record.version = "0.150.0"
        model.snapshot = outdated
        model.act(model.rows.first { $0.id == "codex" }!)
        XCTAssertEqual(calls.list.last, "update codex")
    }

    func testTheFootersAndSkip() {
        let calls = Calls()
        var closed = 0
        let model = ToolSetupModel(snapshot: snap(["git": "missing", "claude": "missing", "codex": "missing"]), ids: TOOL_ORDER, backend: backend(calls), onClose: { closed += 1 })
        XCTAssertEqual(model.footer, .launch(installAll: true, skip: true))
        model.installAll()
        XCTAssertEqual(calls.list, ["install git,claude,codex"])
        model.skip()
        XCTAssertEqual(model.warning, ["Without Git, Engelbart can’t build or keep your code’s history.", "Without Claude Code or Codex, @bart and summaries can’t run."], "warned first")
        XCTAssertEqual(closed, 0)
        model.back()
        XCTAssertNil(model.warning)
        model.skip()
        model.confirmSkip()
        XCTAssertEqual(calls.list.last, "skip git,claude,codex")
        XCTAssertEqual(closed, 1)

        let one = ToolSetupModel(snapshot: snap(["codex": "missing"]), ids: ["codex"], backend: backend(calls), onClose: { closed += 1 })
        XCTAssertEqual(one.footer, .launch(installAll: false, skip: true), "Install all only for two or more")
        one.skip()
        XCTAssertNil(one.warning, "Claude Code still runs questions: nothing to warn about")
        XCTAssertEqual(calls.list.last, "skip codex")
        XCTAssertEqual(closed, 2)

        XCTAssertEqual(ToolSetupModel(snapshot: snap([:]), ids: ["git", "claude"], backend: backend(calls), onClose: {}).footer, .done)
        let all = ToolSetupModel(snapshot: snap(["git": "missing"], updates: "ask", skip: ["git"]), ids: TOOL_ORDER, mode: .all, backend: backend(calls), onClose: {})
        XCTAssertEqual(all.title, "Tools")
        XCTAssertEqual(all.footer, .all(updatesOn: false))
        all.setUpdates(true)
        all.checkAgain()
        all.askAgain("git")
        XCTAssertEqual(Array(calls.list.suffix(3)), ["updates auto", "check", "ask-again git"])
    }

    func testAnErrorShowsUnderTheRowsAndTheNextActionClearsIt() {
        let calls = Calls()
        let model = ToolSetupModel(snapshot: snap(["git": "missing"]), ids: ["git"], backend: backend(calls, failing: true), onClose: {})
        model.act(model.rows[0])
        XCTAssertEqual(model.error, "Unknown tool")
        model.snapshot = snap(["git": "signed-out"])
        model.act(ToolRow(id: "git", name: "Git", state: "", tone: "", action: "update", detail: nil, detailTone: "error", page: nil, skipped: false, account: nil))
        XCTAssertEqual(model.error, "")
    }

    // MARK: test/update-banner.test.cjs

    func at(_ state: String, percent: Int? = nil, dismissed: Bool = false, enabled: Bool = true) -> UpdateNoticeContent? {
        UpdateNoticeContent(UpdateSnapshot(enabled: enabled, state: state, available: "0.2.0", version: "0.2.0", percent: percent, dismissed: dismissed))
    }

    func testTheUpdateBannerShowsTheDownloadThenRestartAndLaterAndNothingOtherwise() {
        XCTAssertEqual(at("installing"), UpdateNoticeContent(UpdateSnapshot(enabled: true, state: "installing", version: "0.2.0")))
        XCTAssertEqual(at("installing")?.text, "Downloading Engelbart 0.2.0…")
        XCTAssertNil(at("installing")?.percent, "indeterminate until curl gives a percentage")
        XCTAssertEqual(at("installing", percent: 42)?.text, "Downloading Engelbart 0.2.0… 42%")
        XCTAssertEqual(at("installing", percent: 42)?.percent, 42)
        XCTAssertEqual(at("ready")?.kind, .ready)
        XCTAssertEqual(at("ready")?.text, "Engelbart 0.2.0 is ready.")
        XCTAssertNil(at("ready", dismissed: true), "Later: hidden until the state changes")
        for state in ["idle", "checking"] { XCTAssertNil(at(state), state) }
        XCTAssertNil(at("installing", enabled: false), "no updates in this copy")
        XCTAssertEqual(UpdateNoticeContent(UpdateSnapshot(enabled: true, state: "ready"))?.text, "Engelbart is ready.")
        XCTAssertFalse(showsUpdate(nil))
    }

    func testTheBannerKeepsToTheDocumentsCornerElseTheWindows() {
        XCTAssertTrue(updateBannerCorner(window: CGSize(width: 1200, height: 800), column: nil) == (24, 18))
        XCTAssertTrue(updateBannerCorner(window: CGSize(width: 1200, height: 800), column: CGRect(x: 0, y: 0, width: 0, height: 800)) == (24, 18), "a column not laid out")
        XCTAssertTrue(updateBannerCorner(window: CGSize(width: 1200, height: 800), column: CGRect(x: 260, y: 40, width: 500, height: 760)) == (456, 18), "beside the Stage")
        XCTAssertTrue(updateBannerCorner(window: CGSize(width: 1200, height: 800), column: CGRect(x: 260, y: 40, width: 930, height: 700)) == (26, 78))
    }

    func testTheBannerModelFollowsEveryChangeAndLaterHidesItAtOnce() {
        let hub = EventHub()
        var laters = 0, restarts = 0
        let model = UpdateBannerModel(current: { UpdateSnapshot(enabled: true, state: "installing", version: "0.2.0") }, restart: { restarts += 1 }, later: { laters += 1 }, hub: hub)
        XCTAssertEqual(model.content?.kind, .installing)
        hub.post(ToolsEvents.update, UpdateSnapshot(enabled: true, state: "ready", available: "0.2.0", version: "0.2.0").json)
        XCTAssertEqual(model.content?.text, "Engelbart 0.2.0 is ready.")
        model.restart()
        model.later()
        XCTAssertNil(model.content, "hidden here at once")
        XCTAssertEqual([laters, restarts], [1, 1])
        hub.post(ToolsEvents.update, ["enabled": false])
        XCTAssertNil(model.content)
        XCTAssertEqual(UpdateSnapshot(json: UpdateSnapshot(enabled: true, state: "installing", available: "0.2.0", version: "0.2.0", percent: 7).json)?.percent, 7)
    }

    // MARK: channels and setup

    func testChannelsCheckNamesAndAnswerAtOnce() async throws {
        let hub = EventHub()
        var opened = 0
        hub.on(ToolsEvents.toolsOpen) { _ in opened += 1 }
        let fake = FakeTools(#"{"claude":"missing","codex":"missing"}"#, delay: 0, sleep: { _ in })
        let manager = ToolsManager(storage: .memory(), detect: { await fake.detect($0) }, actions: fake, signIn: fake.signInStarter, signOut: fake.signOutRunner)
        let channels = ToolsChannels(manager: manager, hub: hub)
        XCTAssertThrowsError(try channels.install(["vim"])) { XCTAssertEqual($0.localizedDescription, "Unknown tool") }
        XCTAssertThrowsError(try channels.update("Git"))
        XCTAssertEqual(try ToolsChannels.toolNames(["git", "claude", "codex", "git"]), ["git", "claude", "codex"], "at most three")
        await manager.check()
        let answered = try channels.install(["claude"])
        XCTAssertNil(answered.tools["claude"]?.busy, "answered before the install started")
        await eventually { manager.current["claude"].installed }
        try channels.connect("claude")
        await eventually { manager.current["claude"].signedIn == true }
        let out = try await channels.signOut("claude")
        XCTAssertTrue(out.ok)
        XCTAssertEqual(channels.setUpdates("never").updates, "auto")
        XCTAssertEqual(channels.setUpdates("ask").updates, "ask")
        try channels.skip(["codex"])
        XCTAssertTrue(manager.current["codex"].skip)
        try channels.askAgain("codex")
        XCTAssertFalse(manager.current["codex"].skip)
        XCTAssertFalse(try channels.cancelSignIn("claude"))
        channels.openSetup()
        XCTAssertEqual(opened, 1)
    }

    func testTheSetupFromTheEnvironment() async {
        let hub = EventHub()
        var events: [JSONValue] = []
        hub.on(ToolsEvents.tools) { events.append($0) }
        let config = ConfigFile()
        let before = try! String(contentsOfFile: config.file, encoding: .utf8)
        let setup = ToolsSetup(storage: config.storage, environment: ["ENGELBART_TOOLS_FAKE": #"{"git":"missing","claude":"missing","codex":"missing"}"#], resourcesPath: nil, hub: hub)
        XCTAssertNotNil(setup.fake)
        await setup.manager.start()
        await eventually(10) { setup.manager.current["claude"].status == "signed-out" }
        XCTAssertTrue(events.contains { $0["tools"]?["claude"]?["busy"]?["action"] == "install" }, "Claude Code installed at launch on a Mac with neither")
        XCTAssertEqual(try! String(contentsOfFile: config.file, encoding: .utf8), before, "a pretend machine never touches config.json")
        await setup.afterTestReset()
        XCTAssertEqual(setup.manager.current["claude"].status, "missing", "back to its first state")
        await setup.beforeQuit()

        let off = ToolsSetup(storage: ConfigFile().storage, environment: ["ENGELBART_TOOLS": "off", "ENGELBART_TOOLS_FAKE": "{}"], resourcesPath: nil, hub: EventHub())
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(off.manager.checked, "ENGELBART_TOOLS=off skips the launch check")
    }

    // MARK: drawn offscreen

    func render<V: View>(_ view: V, size: CGSize, name: String) {
        ToolsRise.still = true
        defer { ToolsRise.still = false }
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height).background(Color(white: 0.93)))
        renderer.scale = 2
        guard let image = renderer.cgImage else { return XCTFail("nothing drawn") }
        XCTAssertEqual(image.width, Int(size.width * 2))
        if let dir = ProcessInfo.processInfo.environment["ENGELBART_TOOLS_SNAPSHOTS"],
           let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testTheViewsDraw() {
        var s = snap(["git": "missing", "claude": "signed-out", "codex": "outdated"], busy: ["git": Busy(action: "install", phase: "Waiting for Apple’s installer")])
        s.tools["codex"]?.record.version = "0.150.0"
        s.tools["codex"]?.record.error = "The installer could not be reached: no internet connection (curl: (6) Could not resolve host: chatgpt.com)."
        s.tools["claude"]?.busy = Busy(action: "sign-in", url: "https://claude.ai/oauth")
        let launch = ToolSetupModel(snapshot: s, ids: TOOL_ORDER, backend: backend(Calls()), onClose: {})
        render(ToolSetupView(model: launch), size: CGSize(width: 640, height: 420), name: "tool-setup-launch")
        var ready = snap([:], skip: [])
        ready.tools["claude"]?.record.note = "An older Claude Code comes first on your PATH, so typing claude in a terminal runs it; Engelbart uses a newer one. It is at /opt/homebrew/bin/claude."
        ready.tools["git"]?.record.source = "bundled"
        let all = ToolSetupModel(snapshot: ready, ids: TOOL_ORDER, mode: .all, backend: backend(Calls()), onClose: {})
        render(ToolSetupView(model: all), size: CGSize(width: 640, height: 420), name: "tool-setup-all")
        let warn = ToolSetupModel(snapshot: snap(["git": "missing", "claude": "missing", "codex": "missing"]), ids: TOOL_ORDER, backend: backend(Calls()), onClose: {})
        warn.skip()
        render(ToolSetupView(model: warn), size: CGSize(width: 640, height: 320), name: "tool-setup-warning")
        let hub = EventHub()
        let installing = UpdateBannerModel(current: { UpdateSnapshot(enabled: true, state: "installing", version: "0.2.0", percent: 42) }, restart: {}, later: {}, hub: hub)
        render(UpdateBanner(model: installing), size: CGSize(width: 520, height: 120), name: "update-installing")
        let readyBanner = UpdateBannerModel(current: { UpdateSnapshot(enabled: true, state: "ready", version: "0.2.0") }, restart: {}, later: {}, hub: hub)
        render(UpdateBanner(model: readyBanner, column: CGRect(x: 0, y: 0, width: 300, height: 100)), size: CGSize(width: 520, height: 120), name: "update-ready")
    }
}
