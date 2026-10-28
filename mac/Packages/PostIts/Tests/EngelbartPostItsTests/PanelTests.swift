import AppKit
import SwiftUI
import XCTest
import EngelbartCore
import EngelbartUI
import EngelbartStore
import EngelbartBuild
@testable import EngelbartPostIts

/// A card's quick task (Card.jsx state, PostItBuild.jsx, PostItTask.jsx, Workspace.jsx's post-it half).
@MainActor
final class QuickTaskTests: PostItsTestCase {
    func task(_ status: String, card: String, id: String = "abcdef0123", kind: String = "quick", extra: [String: JSONValue] = [:]) -> JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "projectId": .string(project), "kind": .string(kind), "status": .string(status), "postItId": .string(card),
                                      "provider": "anthropic", "model": "opus", "effort": "high", "modelName": "Opus"]
        for (k, v) in extra { o[k] = v }
        return .object(o)
    }

    func testTheCardShowsWhereItsTaskStands() async throws {
        let id = try seed("Fix the thing")
        build.list = [task("failed", card: id, id: "0000000001"), task("running", card: id, id: "0000000002")]
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        XCTAssertEqual(card.stateButton.words, "Building", "a card opened later shows its latest task")
        XCTAssertTrue(card.stateButton.parts.contains(.dots))
        XCTAssertTrue(card.stateButton.strong)
        XCTAssertTrue(card.buildButton.isHidden, "no Build while one is under way")
        events.post("engelbart:build", task("escalated", card: id, id: "0000000002"))
        XCTAssertEqual(card.stateButton.words, "Needs you")
        XCTAssertFalse(card.stateButton.parts.contains(.dots))
        events.post("engelbart:build", task("accepted", card: id, id: "0000000002"))
        XCTAssertEqual(card.stateButton.words, "Merged")
        XCTAssertFalse(card.stateButton.isEnabled)
        XCTAssertFalse(card.stateButton.strong)
        XCTAssertFalse(card.buildButton.isHidden, "merged: Build is back")
        XCTAssertTrue(card.buildButton.isEnabled)
        events.post("engelbart:build", task("discarded", card: id, id: "0000000002"))
        XCTAssertTrue(card.stateButton.isHidden)
        data.names["w1"] = "Thesis"
        events.post("engelbart:build", task("running", card: id, id: "0000000002", kind: "build", extra: ["workspaceId": "w1"]))
        await wait { card.stateButton.words == "Thesis" }
        XCTAssertEqual(card.stateButton.words, "Thesis", "added to a workspace: its name")
        XCTAssertEqual(card.stateButton.parts.first, .icon(PostItLook.workspace))
        XCTAssertFalse(card.stateButton.strong)
        XCTAssertTrue(card.buildButton.isHidden)
        // Another project's Builds are not this window's.
        events.post("engelbart:build", .object(task("stopped", card: id, id: "0000000002").object!.merging(["projectId": "x"]) { $1 }))
        XCTAssertEqual(card.stateButton.words, "Thesis")
    }

    func testTheBuildPopupHangsFromTheButtonAndSendsAQuickTask() async throws {
        let id = try seed("Rename the field", nx: 0.8, ny: 0.3)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        card.buildButton.press()
        let panel = try XCTUnwrap(controller.panels.buildPanel)
        let model = try XCTUnwrap(controller.panels.buildModel)
        await wait { model.models != nil && model.pre != nil }
        XCTAssertEqual(build.askedModels, ["quick"])
        XCTAssertEqual(model.choice, ModelChoice(provider: "anthropic", model: "opus", effort: "high"))
        XCTAssertEqual(model.footLabel, "Opus High · in engelbart")
        XCTAssertTrue(model.ready)
        XCTAssertTrue(window.childWindows?.contains(panel.window) == true, "a child window over the cards: it covers them")
        let button = FloatingPanel.anchorRect(of: card.buildButton)
        let spot = try XCTUnwrap(panel.spot)
        XCTAssertEqual(spot.left + 420, button.maxX, accuracy: 0.5, "aligned to the button's right edge")
        XCTAssertTrue(spot.top == button.maxY + 8 || spot.top + panel.cardSize.height == button.minY - 8, "8 from the button")
        // A second press closes it.
        card.buildButton.press()
        XCTAssertNil(controller.panels.buildPanel)
        card.buildButton.press()
        let again = try XCTUnwrap(controller.panels.buildModel)
        await wait { again.models != nil && again.pre != nil }
        again.choose(ModelChoice(provider: "anthropic", model: "sonnet", effort: "max"))
        await wait { !self.build.remembered.isEmpty }
        XCTAssertEqual(build.remembered.last, "quick:anthropic:sonnet:max", "the next post-it starts here")
        XCTAssertEqual(PickMemory(defaults: defaults).efforts["sonnet"], "max")
        // Context opens beside it, bottoms level; Escape closes it first, then the popup.
        again.ctxOpen = true
        await wait { self.controller.panels.contextPanel != nil }
        let ctx = try XCTUnwrap(controller.panels.contextPanel)
        let main = try XCTUnwrap(controller.panels.buildPanel)
        await wait(0.1)
        XCTAssertEqual(ctx.spot!.top + ctx.cardSize.height, main.spot!.top + main.cardSize.height, accuracy: 1, "bottoms level")
        let right = ctx.spot!.left >= main.spot!.left + 420
        XCTAssertEqual(ctx.spot!.left, right ? main.spot!.left + 420 + 6 : max(8, main.spot!.left - 6 - 290), accuracy: 1)
        XCTAssertTrue(controller.panels.key(key("\u{1b}", 53)))
        await wait { self.controller.panels.contextPanel == nil }
        XCTAssertNil(controller.panels.contextPanel)
        XCTAssertNotNil(controller.panels.buildPanel)
        // ⌘↩ sends: a quick task in the default repo, with the card's text.
        XCTAssertTrue(controller.panels.key(key("\r", 36, .command)))
        await wait { self.controller.panels.buildPanel == nil }
        let sent = try XCTUnwrap(build.started.first)
        XCTAssertEqual(sent["kind"], "quick")
        XCTAssertEqual(sent["postItId"]?.string, id)
        XCTAssertEqual(sent["text"], "Rename the field")
        XCTAssertEqual(sent["model"], "sonnet")
        XCTAssertEqual(sent["effort"], "max")
        XCTAssertEqual(sent["target"], ["kind": "default"])
        XCTAssertEqual(sent["attach"], [])
        XCTAssertEqual(card.stateButton.words, "Building", "the card shows it at once")
    }

    func testAPopupThatCannotBuildSaysWhyAndKeepsAFailedSend() async throws {
        let id = try seed("x")
        build.preflight = ["ok": false, "problems": [["message": "This folder is not a repository"]]]
        await activate()
        controller.card(id)!.buildButton.press()
        let model = try XCTUnwrap(controller.panels.buildModel)
        await wait { model.pre != nil }
        XCTAssertEqual(model.problem, "This folder is not a repository")
        XCTAssertFalse(model.ready)
        build.preflight = ["ok": true]
        await model.load()
        build.startError = GeometryError("Claude Code is signed out")
        await model.send()
        XCTAssertEqual(model.error, "Claude Code is signed out")
        XCTAssertFalse(model.busy)
        XCTAssertNotNil(controller.panels.buildPanel, "it stays open to try again")
        // A press on the workspace closes it; one on a card does not (cards were their own views in Electron).
        let card = controller.card(id)!
        controller.panels.press(mouse(.leftMouseDown, CGPoint(x: card.frame.midX, y: card.frame.midY)))
        XCTAssertNotNil(controller.panels.buildPanel)
        controller.panels.press(mouse(.leftMouseDown, CGPoint(x: 1150, y: 750)))
        XCTAssertNil(controller.panels.buildPanel)
    }

    func testContextPicksFromTheLibraryAndAddsWhatIsTyped() async throws {
        let id = try seed("x")
        var ctx = controller.context
        var library = [PickRow(row: .init(id: "r1", name: "Spec", type: "md", tags: ["note"]), lastEdited: Date(timeIntervalSince1970: 2)),
                       PickRow(row: .init(id: "r2", name: "Paper", type: "pdf"), lastEdited: Date(timeIntervalSince1970: 1))]
        var changed = 0
        ctx.library = { library }
        ctx.addLibraryItem = { input in
            if input == "bad" { throw GeometryError("Not a link or a path") }
            let row = PickRow(row: .init(id: input.hasPrefix("/") ? "r-\(input)" : "r3", name: input, type: "website"), lastEdited: Date())
            library.append(row)
            return row
        }
        ctx.pickPaths = { ["/a.pdf", "/b.pdf"] }
        ctx.libraryChanged = { changed += 1 }
        controller.context = ctx
        await activate()
        controller.card(id)!.buildButton.press()
        let build = try XCTUnwrap(controller.panels.buildModel)
        build.ctxOpen = true
        await wait { self.controller.panels.contextModel != nil }
        let model = try XCTUnwrap(controller.panels.contextModel)
        XCTAssertEqual(model.rows.map(\.id), ["r1", "r2"])
        build.toggle(model.rows[1])
        model.query = "spec"
        XCTAssertEqual(model.rows.map(\.id), ["r1"])
        model.query = ""
        XCTAssertEqual(model.rows.map(\.id), ["r1", "r2"], "a picked row stays listed while nothing is typed")
        model.value = "https://example.com"
        await model.add()
        XCTAssertEqual(build.picked.map(\.id), ["r2", "r3"], "added and picked at once")
        XCTAssertEqual(model.value, "")
        XCTAssertEqual(changed, 1)
        model.value = "bad"
        await model.add()
        XCTAssertEqual(model.error, "Not a link or a path")
        await model.disk()
        XCTAssertEqual(model.error, "", "both paths were added")
        XCTAssertEqual(build.picked.map(\.id), ["r2", "r3", "r-/a.pdf", "r-/b.pdf"])
        build.added([library[0]])
        build.added([library[0]])
        XCTAssertEqual(build.picked.count, 5, "the same row is not picked twice")
        build.toggle(build.picked[0])
        XCTAssertEqual(build.picked.first?.id, "r3")
        XCTAssertEqual(model.rows.prefix(1).map(\.id), ["r-/b.pdf"], "newest first")
    }

    func testTheTaskCardContinuesAQuickTaskInAProject() async throws {
        let id = try seed("Big change")
        await activate()
        events.post("engelbart:build", task("escalated", card: id))
        let card = try XCTUnwrap(controller.card(id))
        card.stateButton.press()
        let model = try XCTUnwrap(controller.panels.taskModel)
        XCTAssertNotNil(controller.panels.taskPanel)
        await wait { model.models != nil }
        XCTAssertEqual(build.askedModels.last, "build")
        XCTAssertEqual(model.word, "Needs you")
        XCTAssertEqual(model.message, QuickTaskText.TOO_BIG)
        XCTAssertEqual(model.workspaceId, "w2", "starts on the project open now")
        XCTAssertEqual(model.chipLabel, "Opus High", "the model the task ran on")
        XCTAssertEqual(model.wsRows.map(\.id), ["w1", "w2"])
        model.wsQuery = "fig"
        XCTAssertEqual(model.wsRows.map(\.id), ["w2"])
        model.pick("w1")
        XCTAssertEqual(model.target?.name, "Thesis")
        XCTAssertFalse(model.wsOpen)
        // Discard asks twice.
        model.discard()
        XCTAssertTrue(model.confirm)
        XCTAssertTrue(build.discarded.isEmpty)
        // The send: promoted on the model picked, the post-it thrown out, and the window goes to the version it was put in as.
        model.modelOpen = true
        await wait { self.controller.panels.modelPanel != nil }
        XCTAssertNotNil(controller.panels.modelPanel, "its grid opens beside the card")
        XCTAssertTrue(controller.panels.key(key("\u{1b}", 53)))
        XCTAssertFalse(model.modelOpen, "Escape shuts the grid first")
        model.choice = ModelChoice(provider: "openai", model: "sol", effort: "xhigh")
        build.promoteResult = ["id": "abcdef0123", "projectId": .string(project), "kind": "build", "status": "running", "workspaceId": "w1",
                               "version": ["file": "2026-10-28T10-00-00Z.md", "title": "Imported from Task: Big change"]]
        await model.promote()
        XCTAssertEqual(build.promoted.first?.workspace, "w1")
        XCTAssertEqual(build.promoted.first?.choice, ["provider": "openai", "model": "sol", "effort": "xhigh"])
        await wait { self.controller.card(id) == nil }
        XCTAssertNil(controller.card(id), "the post-it is thrown out, unasked")
        XCTAssertEqual(try db.trashed().map(\.id), [id])
        XCTAssertEqual(versions.first?.0, "w1")
        XCTAssertEqual(versions.first?.1["title"], "Imported from Task: Big change")
        XCTAssertNil(controller.panels.taskPanel)
    }

    func testWhileItBuildsTheCardSaysWhatItIsDoingAndStops() async throws {
        let id = try seed("x")
        await activate()
        events.post("engelbart:build", task("setting-up", card: id))
        controller.card(id)!.stateButton.press()
        let model = try XCTUnwrap(controller.panels.taskModel)
        XCTAssertEqual(model.word, "Building")
        XCTAssertEqual(model.activity, "Setting up its copy of the code")
        events.post("engelbart:build-progress", ["projectId": .string(project), "id": "abcdef0123", "activity": "Reading Card.jsx"])
        XCTAssertEqual(model.activity, "Reading Card.jsx")
        model.onAction("stop")
        await wait { !self.build.stopped.isEmpty }
        XCTAssertEqual(build.stopped, ["abcdef0123"])
        events.post("engelbart:build", task("stopped", card: id))
        XCTAssertEqual(model.word, "Stopped")
        XCTAssertEqual(model.message, QuickTaskText.STOPPED)
        XCTAssertNil(controller.progress["abcdef0123"], "a turn that ended leaves nothing to show")
        // The state again: closed. A press on the workspace closes it too.
        controller.card(id)!.stateButton.press()
        XCTAssertNil(controller.panels.taskPanel)
        controller.openQuickTask(id: "abcdef0123", postItId: id, anchor: CGRect(x: 40, y: 300, width: 200, height: 30))
        XCTAssertNotNil(controller.panels.taskPanel)
        controller.panels.press(mouse(.leftMouseDown, CGPoint(x: 1150, y: 750)))
        XCTAssertNil(controller.panels.taskPanel)
    }

    func testATaskAddedToAWorkspaceGoesThere() async throws {
        let id = try seed("x")
        await activate()
        data.names["w1"] = "Thesis"
        events.post("engelbart:build", task("running", card: id, kind: "build", extra: ["workspaceId": "w1", "version": ["file": "v.md", "title": "Imported from Task: x"]]))
        let card = try XCTUnwrap(controller.card(id))
        await wait { card.stateButton.words == "Thesis" }
        card.stateButton.press()
        XCTAssertNil(controller.panels.taskPanel)
        XCTAssertEqual(versions.first?.0, "w1")
    }

    func testFromTheAgentsPanelTheStickiesShowAndTheCardOpens() async throws {
        let id = try seed("x")
        await activate()
        events.post("engelbart:build", task("escalated", card: id))
        controller.setHidden(true)
        controller.openQuickTask(id: "abcdef0123", postItId: id, anchor: nil)
        XCTAssertFalse(controller.hidden)
        XCTAssertNotNil(controller.panels.taskPanel)
        controller.openQuickTask(id: "ffffffffff", postItId: nil, anchor: nil)
        XCTAssertNil(controller.panels.taskPanel, "shown only while its record is known")
    }
}

@MainActor
final class TrashPanelTests: PostItsTestCase {
    func testTheTrashPanelListsAndRestores() async throws {
        let a = try seed("# Plan\n- one\n- two\n- three"), b = try seed("")
        await activate()
        _ = try await controller.throwOut(a)
        clock = clock.addingTimeInterval(1)
        _ = try await controller.throwOut(b)
        var restored: [String] = []
        let model = TrashPanelModel(controller: controller, projects: [.init(id: "p1", name: "Old", nested: 2, expires: Date().addingTimeInterval(3 * 86400))], restoreProject: { restored.append($0) })
        await model.load()
        XCTAssertEqual(Set(model.rows?.map(\.id) ?? []), [a, b])
        XCTAssertEqual(model.heading, "Projects and stickies in the trash are deleted a week after they’re thrown away.")
        let host = NSHostingView(rootView: TrashPanelView(model: model))
        host.frame = NSRect(x: 0, y: 0, width: 320, height: 400)
        XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
        await model.restore(a)
        XCTAssertNotNil(controller.card(a))
        XCTAssertEqual(model.rows?.map(\.id), [b])
        await model.bringBack("p1")
        XCTAssertEqual(restored, ["p1"])
        XCTAssertTrue(model.projects.isEmpty)
        XCTAssertEqual(model.heading, "Stickies in the trash are deleted a week after they’re thrown away.")
        // The count changing reads the list again.
        _ = try await controller.throwOut(a)
        await wait { model.rows?.count == 2 }
        XCTAssertEqual(model.rows?.count, 2)
        // Shown from the sidebar: a panel 320 wide, Escape closes it.
        let panel = PostItsTrashPanel.present(in: window, anchor: CGRect(x: 20, y: 700, width: 200, height: 40), model: model)
        XCTAssertTrue(panel.isOpen)
        XCTAssertEqual(panel.cardSize.width, 320)
        panel.close()
        XCTAssertNil(TrashPanelModel(controller: nil).rows)
    }
}

/// The popups' drawing, hosted offscreen and read back.
@MainActor
final class PanelPictureTests: PostItsTestCase {
    func picture<V: View>(_ view: V, width: CGFloat) async -> (rep: NSBitmapImageRep, size: CGSize) {
        let host = NSHostingView(rootView: view)
        let size = host.fittingSize
        host.frame = NSRect(x: 0, y: 0, width: width, height: size.height)
        window.contentView!.addSubview(host)
        host.layoutSubtreeIfNeeded()
        await wait(0.1)
        let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: rep)
        host.removeFromSuperview()
        return (rep, host.bounds.size)
    }
    func count(_ rep: NSBitmapImageRep, near hex: String, tolerance: CGFloat = 0.09) -> Int {
        let want = NSColor(hex: hex).usingColorSpace(.sRGB)!
        var n = 0
        for x in stride(from: 0, to: rep.pixelsWide, by: 1) {
            for y in stride(from: 0, to: rep.pixelsHigh, by: 1) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if abs(c.redComponent - want.redComponent) < tolerance && abs(c.greenComponent - want.greenComponent) < tolerance && abs(c.blueComponent - want.blueComponent) < tolerance { n += 1 }
            }
        }
        let scale = max(1, rep.pixelsWide / max(1, Int(rep.size.width)))
        return n / (scale * scale) // in points
    }

    func testTheBuildPopupsFootAndItsSend() async throws {
        let model = PostItBuildModel(projectId: project, postItId: "c", text: "Do it", build: build, memory: PickMemory(defaults: defaults))
        await model.load()
        XCTAssertTrue(model.ready)
        let ready = await picture(PostItBuildView(model: model), width: 420)
        XCTAssertEqual(ready.size.width, 420)
        XCTAssertGreaterThan(count(ready.rep, near: "#0070f3"), 400, "the round send is blue when it can send")
        XCTAssertGreaterThan(count(ready.rep, near: "#fafafa"), 2000, "the effort column is #fafafa")
        build.preflight = ["ok": false, "problems": [["message": "No repository"]]]
        await model.load()
        let blocked = await picture(PostItBuildView(model: model), width: 420)
        XCTAssertLessThan(count(blocked.rep, near: "#0070f3"), 20, "grey when it cannot")
        XCTAssertGreaterThan(count(blocked.rep, near: "#e70022", tolerance: 0.25), 10, "the problem in red")
        XCTAssertGreaterThan(blocked.size.height, ready.size.height, "the problem line takes room")
    }

    func testTheTaskCardAndTheTrashPanel() async throws {
        let task: JSONValue = ["id": "abcdef0123", "projectId": .string(project), "kind": "quick", "status": "escalated", "provider": "anthropic", "model": "opus", "effort": "high"]
        let model = PostItTaskModel(projectId: project, task: task, progress: nil, postItId: nil, build: build, workspaces: [WorkspaceEntry(id: "w1", name: "Thesis")], hereId: nil)
        await model.load()
        let card = await picture(PostItTaskView(model: model), width: 420)
        XCTAssertEqual(card.size.width, 420)
        XCTAssertGreaterThan(count(card.rep, near: "#0070f3"), 400, "Needs you: the send continues it in Thesis")
        XCTAssertGreaterThan(count(card.rep, near: "#fafafa"), 1000, "the project field")
        let id = try seed("Buy milk")
        await activate()
        _ = try await controller.throwOut(id)
        let trash = TrashPanelModel(controller: controller)
        await trash.load()
        let panel = await picture(TrashPanelView(model: trash), width: 320)
        XCTAssertEqual(panel.size.width, 320)
        XCTAssertGreaterThan(count(panel.rep, near: "#fff2a0", tolerance: 0.06), 80, "the yellow swatch")
    }
}
