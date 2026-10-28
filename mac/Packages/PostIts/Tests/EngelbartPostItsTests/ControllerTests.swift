import AppKit
import XCTest
import EngelbartCore
import EngelbartUI
import EngelbartStore
import EngelbartEditor
@testable import EngelbartPostIts

/// The cards over a project (views.cjs + Card.jsx), driven in an offscreen window.
@MainActor
final class ControllerTests: PostItsTestCase {
    func testActivateListsTheCardsInStackingOrderPurgesOldTrashAndCountsTheRest() async throws {
        let top = try seed("top", z: 5), bottom = try seed("bottom", z: 2)
        let old = try seed("old", z: 3), recent = try seed("recent", z: 4)
        try db.trash(old); try db.trash(recent)
        _ = try NotesDB.open(projectDir: dir).db.run("update post_its set deleted = ? where id = ?", [.text(Time.iso(clock.addingTimeInterval(-8 * 86400))), .text(old)])
        var counts: [Int] = []
        controller.onTrashCount = { _, n in counts.append(n) }
        await activate()
        XCTAssertEqual(controller.cards.map(\.entryId), [bottom, top])
        XCTAssertEqual(controller.overlay.subviews.compactMap { ($0 as? PostItCardView)?.entryId }, [bottom, top], "the top card is drawn last")
        XCTAssertEqual(controller.trashCount, 1, "a week and a day in the trash: purged when the project opens")
        XCTAssertEqual(counts, [1])
        XCTAssertEqual(try db.trashed().map(\.id), [recent])
        XCTAssertFalse(controller.card(top)!.isHidden)
        // The same project again: nothing changes; none: the cards go.
        let view = controller.card(top)
        await activate()
        XCTAssertTrue(controller.card(top) === view)
        await controller.activate(nil)
        XCTAssertTrue(controller.cards.isEmpty)
        XCTAssertTrue(controller.overlay.subviews.filter { $0 is PostItCardView }.isEmpty)
        XCTAssertNil(controller.projectId)
    }

    func testANewCardIsSquareStaggeredOnTopAndTakesTheKeyboard() async throws {
        do { try await controller.create(); XCTFail("no project open") } catch { XCTAssertEqual(errorText(error), "Open this project before adding a sticky") }
        _ = try seed("one", z: clock.timeIntervalSince1970 * 1000 + 50)
        await activate()
        let id = try await controller.create()
        let row = try XCTUnwrap(controller.row(id))
        XCTAssertEqual([row.width, row.height], [260, 260])
        XCTAssertEqual(row.nx, 0.22 + 0.045, accuracy: 1e-9, "the second card sits a step down and right")
        XCTAssertEqual(row.ny, 0.16 + 0.045, accuracy: 1e-9)
        XCTAssertEqual(row.text, "")
        XCTAssertEqual(controller.cards.last?.entryId, id)
        let card = try XCTUnwrap(controller.card(id))
        XCTAssertEqual(card.frame, PostItGeometry.cardBounds(row.layout, viewport: controller.overlay.bounds.size).cgRect)
        await wait(0.2)
        XCTAssertTrue((window.firstResponder as? NSView)?.isDescendant(of: card) == true, "a fresh card has the caret")
        XCTAssertFalse(card.placeholder.isHidden, "Write something… while it is empty")
        XCTAssertEqual(card.placeholder.stringValue, "Write something…")
        XCTAssertEqual(try db.list().count, 2)
        do { try await controller.create("22222222-2222-4222-8222-222222222222"); XCTFail() } catch {}
    }

    func testEveryEditIsSavedAtOnceAndAFailureShowsOnTheCard() async throws {
        let id = try seed("")
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        card.docEditor(card.editor, changed: "- [ ] buy milk")
        XCTAssertEqual(try db.list().first?.text, "- [ ] buy milk", "no debounce")
        XCTAssertTrue(card.placeholder.isHidden)
        card.docEditor(card.editor, changed: String(repeating: "x", count: 400_001))
        XCTAssertEqual(card.saveError, "Sticky text must be at most 400000 characters")
        XCTAssertFalse(card.errorBox.isHidden)
        XCTAssertEqual(card.errorBox.text, "Couldn’t save: Sticky text must be at most 400000 characters")
        XCTAssertEqual(try db.list().first?.text, "- [ ] buy milk")
        card.docEditor(card.editor, changed: "fixed")
        XCTAssertNil(card.saveError, "the next good save clears it")
        XCTAssertTrue(card.errorBox.isHidden)
    }

    func testDraggingFromWhitespaceMovesTheCardAndKeepsItsPreferredSize() async throws {
        let id = try seed("Hello", nx: 0.2, ny: 0.2, width: 300, height: 300)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        let start = card.frame
        // The body's lower part has no glyphs: a press there is the card's.
        let press = CGPoint(x: start.midX, y: start.minY + 200)
        XCTAssertTrue(hit(press) === card)
        // On the word itself it is the editor's.
        let tv = try XCTUnwrap(card.textView)
        let r = tv.layoutManager!.boundingRect(forGlyphRange: NSRange(location: 1, length: 1), in: tv.textContainer!)
        let glyph = controller.overlay.convert(NSPoint(x: r.midX + tv.textContainerOrigin.x, y: r.midY + tv.textContainerOrigin.y), from: tv)
        XCTAssertTrue(card.frame.contains(glyph))
        XCTAssertTrue(hit(glyph) is NSTextView, "a press on a glyph goes to the text")
        // The footer's buttons are their own.
        XCTAssertTrue(hit(CGPoint(x: start.minX + 21, y: start.maxY - 15)) is PostItButton)
        drag(from: press, to: CGPoint(x: press.x + 200, y: press.y + 100))
        XCTAssertEqual(card.frame.minX, start.minX + 200, accuracy: 1)
        XCTAssertEqual(card.frame.minY, start.minY + 100, accuracy: 1)
        let row = try XCTUnwrap(try db.list().first)
        XCTAssertEqual([row.width, row.height], [300, 300])
        XCTAssertEqual(row.nx, PostItGeometry.layoutFromBounds(PRect(card.frame), viewport: controller.overlay.bounds.size).nx, accuracy: 1e-9)
        XCTAssertGreaterThan(row.nx, 0.2)
        XCTAssertFalse(controller.drag.active)
        XCTAssertFalse(window.firstResponder === tv, "a drag that moved swallows the click: no caret")
        XCTAssertThrowsError(try controller.copy(String(repeating: "x", count: 400_001)), "Copy takes at most 400000 characters")
    }

    func testAPressThatDoesNotMovePutsTheCaretAtTheEnd() async throws {
        let id = try seed("Some words")
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        let p = CGPoint(x: card.frame.midX, y: card.frame.minY + 180)
        drag(from: p, to: CGPoint(x: p.x + 2, y: p.y + 1), steps: 1)
        XCTAssertEqual(card.frame.minX, PostItGeometry.cardBounds(controller.row(id)!.layout, viewport: controller.overlay.bounds.size).x, "under 4 px nothing moves")
        let tv = try XCTUnwrap(card.textView)
        XCTAssertTrue(window.firstResponder === tv)
        XCTAssertEqual(tv.selectedRange().location, (tv.string as NSString).length, "the caret at the end")
    }

    func testDroppedOnTheTrashItCrumplesWarmsAndGoesToTheTrash() async throws {
        let id = try seed("Throw me", nx: 0.5, ny: 0.5)
        await activate()
        controller.trashRect = PRect(x: 20, y: 700, width: 200, height: 40)
        var drags: [PostItDrag] = []
        controller.onDrag = { drags.append($0) }
        let card = try XCTUnwrap(controller.card(id))
        let from = CGPoint(x: card.frame.midX, y: card.frame.minY + 200)
        drag(from: from, to: CGPoint(x: 120, y: 720), release: false)
        XCTAssertTrue(card.overTrash)
        XCTAssertLessThan(card.frame.width, 100, "crumpled to 0.28 of its size")
        XCTAssertEqual(card.bounds.width, 260, accuracy: 0.5, "the face is drawn whole, scaled into the card")
        XCTAssertGreaterThanOrEqual(card.frame.minX, 230, "beside the can, not over it")
        await wait(0.25)
        let warm = pixels(card)
        near(color(warm, warm.w - 3, 2), "#ffd08a")
        XCTAssertEqual(drags.last, PostItDrag(active: true, over: true))
        card.mouseUp(with: mouse(.leftMouseUp, CGPoint(x: 120, y: 720)))
        await wait { self.controller.card(id) == nil }
        XCTAssertNil(controller.card(id))
        XCTAssertEqual(try db.trashed().map(\.id), [id])
        XCTAssertEqual(controller.trashCount, 1)
        XCTAssertEqual(drags.last, PostItDrag(active: false, over: false, thrown: true))
    }

    func testLetGoShortOfTheCanItIsFullSizeAgain() async throws {
        let id = try seed("Keep me", nx: 0.5, ny: 0.5)
        await activate()
        controller.trashRect = PRect(x: 20, y: 700, width: 200, height: 40)
        let card = try XCTUnwrap(controller.card(id))
        let from = CGPoint(x: card.frame.midX, y: card.frame.minY + 200)
        drag(from: from, to: CGPoint(x: 400, y: 600), release: false)
        XCTAssertLessThan(card.frame.width, 260, "near the can it shrinks")
        card.mouseUp(with: mouse(.leftMouseUp, CGPoint(x: 400, y: 600)))
        XCTAssertEqual(card.frame.width, 260)
        XCTAssertNil(card.crumple)
        XCTAssertFalse(card.overTrash)
        XCTAssertEqual(try db.list().map(\.id), [id])
        let face = pixels(card)
        near(color(face, face.w - 3, 2), "#fff2a0")
    }

    func testTheTrashViewIsMeasuredWhereverTheSidebarPutsIt() async throws {
        let id = try seed("x", nx: 0.5, ny: 0.5)
        await activate()
        let foot = NSView(frame: NSRect(x: 10, y: 10, width: 300, height: 40)) // content view is not flipped: 10 from the bottom
        window.contentView!.addSubview(foot, positioned: .below, relativeTo: controller.overlay)
        controller.trashView = foot
        let rect = try XCTUnwrap(controller.currentTrash())
        XCTAssertEqual(rect, PRect(x: 10, y: 800 - 50, width: 300, height: 40))
        foot.isHidden = true
        XCTAssertNil(controller.currentTrash(), "a folded sidebar has no trash")
        _ = id
    }

    func testResizeFromTheCornerAndByKeyboard() async throws {
        let id = try seed("Resize", nx: 0.3, ny: 0.3)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        let corner = CGPoint(x: card.frame.maxX - 13, y: card.frame.maxY - 13)
        XCTAssertTrue(hit(corner) is PostItResizeHandle)
        drag(from: corner, to: CGPoint(x: corner.x + 100, y: corner.y + 60))
        XCTAssertEqual(card.frame.width, 360, accuracy: 1)
        XCTAssertEqual(card.frame.height, 320, accuracy: 1)
        XCTAssertEqual(try db.list().first.map { [$0.width, $0.height] }, [360, 320])
        let corner2 = CGPoint(x: card.frame.maxX - 13, y: card.frame.maxY - 13)
        drag(from: corner2, to: CGPoint(x: corner2.x - 500, y: corner2.y - 500))
        XCTAssertEqual(try db.list().first.map { [$0.width, $0.height] }, [180, 140], "never smaller than 180 × 140")
        card.resizeHandle.keyDown(with: key("", 124))
        card.resizeHandle.keyDown(with: key("", 125))
        XCTAssertEqual(try db.list().first.map { [$0.width, $0.height] }, [200, 160], "arrows resize by 20, each a whole gesture")
        _ = card
    }

    func testAWindowResizePlacesEveryCardAgainFromItsPreferredLayout() async throws {
        let id = try seed("x", nx: 1, ny: 1, width: 600, height: 500)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        XCTAssertEqual(card.frame, CGRect(x: 592, y: 292, width: 600, height: 500))
        window.setContentSize(NSSize(width: 400, height: 300))
        controller.overlay.frame = window.contentView!.bounds
        XCTAssertEqual(card.frame, CGRect(x: 8, y: 56, width: 384, height: 236))
        XCTAssertEqual(controller.row(id)?.width, 600, "clamping never writes back")
        XCTAssertEqual(try db.list().first?.width, 600)
    }

    func testTypingPastTheBottomGrowsTheCardThenShrinksTheType() async throws {
        let id = try seed("one", nx: 0.5, ny: 0.1)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        let lines = (1...14).map { "line \($0)" }.joined(separator: "\n")
        card.editor.setText(lines)
        card.docEditor(card.editor, changed: lines)
        await wait { card.frame.height > 260 }
        XCTAssertGreaterThan(card.frame.height, 260, "it grew")
        XCTAssertEqual(card.frame.minY, PostItGeometry.cardBounds(CardLayout(nx: 0.5, ny: 0.1, width: 260, height: 260), viewport: controller.overlay.bounds.size).y, accuracy: 1, "its top edge kept")
        XCTAssertEqual(card.zoom, 1)
        XCTAssertEqual(try db.list().first?.height ?? 0, Double(card.frame.height), accuracy: 1)
        let many = (1...40).map { "line \($0)" }.joined(separator: "\n")
        card.editor.setText(many)
        card.docEditor(card.editor, changed: many)
        await wait { card.zoom < 1 }
        XCTAssertLessThan(card.zoom, 1, "at the window's height the type gets smaller")
        XCTAssertGreaterThanOrEqual(card.zoom, PostItCardView.SMALLEST)
        XCTAssertEqual(card.frame.maxY, controller.overlay.bounds.height - 8, accuracy: 1, "as tall as the window lets it")
        XCTAssertLessThanOrEqual(card.editor.contentHeight * card.zoom, card.room + 0.5 + 1, "and it fits: a card never scrolls")
        // Shorter again, the type comes back up to full size (the card keeps the height it grew to).
        card.editor.setText("short")
        card.docEditor(card.editor, changed: "short")
        await wait { card.zoom == 1 }
        XCTAssertEqual(card.zoom, 1)
        // Made smaller by hand, it gets smaller type instead.
        card.editor.setText(lines)
        card.docEditor(card.editor, changed: lines)
        await wait(0.2)
        let entry = try XCTUnwrap(controller.entry(id))
        controller.resizeBy(entry, dx: 0, dy: -(Double(card.frame.height) - 200))
        XCTAssertEqual(card.frame.height, 200, accuracy: 1)
        await wait { card.zoom < 1 }
        XCTAssertLessThan(card.zoom, 1, "a card made smaller by hand fits its type")
    }

    func testHideAndShowWriteNothingAndEveryWindowHearsIt() async throws {
        let id = try seed("x")
        await activate()
        let (w2, c2) = makeWindow(); extraWindows.append((w2, c2))
        await activate(c2)
        var heard: [Bool] = []
        controller.onHidden = { heard.append($0) }
        let before = try db.list().first?.lastEdited
        controller.toggleHidden()
        XCTAssertTrue(controller.card(id)!.isHidden)
        XCTAssertTrue(c2.card(id)!.isHidden, "one toggle for every window")
        XCTAssertEqual(defaults.string(forKey: PostItsVisibility.key), "1", "remembered across launches")
        XCTAssertEqual(heard, [true])
        XCTAssertNil(hit(CGPoint(x: controller.card(id)!.frame.midX, y: controller.card(id)!.frame.midY)), "hidden cards take no presses")
        XCTAssertEqual(try db.list().first?.lastEdited, before)
        // Create and Restore show them again.
        _ = try await controller.create()
        XCTAssertFalse(controller.hidden)
        XCTAssertFalse(c2.card(id)!.isHidden)
        XCTAssertEqual(heard, [true, false])
        XCTAssertEqual(PostItsVisibility(defaults: defaults).hidden, false)
    }

    func testRestoreBringsACardBackOnTopAndThrowOutPutsItInTheTrash() async throws {
        let a = try seed("a", z: 1), b = try seed("b", z: 2)
        await activate()
        do { let ok = try await controller.throwOut("33333333-3333-4333-8333-333333333333"); XCTAssertFalse(ok) }
        do { let ok = try await controller.throwOut(a); XCTAssertTrue(ok) }
        XCTAssertNil(controller.card(a))
        XCTAssertEqual(controller.trashCount, 1)
        let listed = await controller.trashed()
        XCTAssertEqual(listed.map(\.id), [a])
        XCTAssertEqual(listed.first?.text, "a")
        let first = try XCTUnwrap(listed.first)
        XCTAssertEqual(first.expires.timeIntervalSince(PostItWords.date(first.deleted)!), 7 * 86400, accuracy: 0.01)
        controller.setHidden(true)
        do { let ok = try await controller.restore(a); XCTAssertTrue(ok) }
        XCTAssertFalse(controller.hidden, "a card brought back while they are hidden shows them all")
        XCTAssertEqual(controller.cards.map(\.entryId), [b, a], "back on top")
        XCTAssertEqual(controller.trashCount, 0)
        do { let ok = try await controller.restore(a); XCTAssertFalse(ok, "not in the trash") }
        await controller.activate(nil)
        do { _ = try await controller.restore(a); XCTFail() } catch { XCTAssertEqual(errorText(error), "Open this project before restoring a sticky") }
        do { _ = try await controller.throwOut(a); XCTFail() } catch { XCTAssertEqual(errorText(error), "Open this project first") }
        let none = await controller.trashed()
        XCTAssertEqual(none, [])
    }

    func testFocusRaisesACardWithoutTakingTheKeyboard() async throws {
        let a = try seed("a", z: 1), b = try seed("b", z: 2)
        await activate()
        let cardA = try XCTUnwrap(controller.card(a))
        let tv = try XCTUnwrap(cardA.textView)
        window.makeFirstResponder(tv)
        await wait { self.controller.cards.last?.entryId == a }
        XCTAssertEqual(controller.cards.map(\.entryId), [b, a], "the card with the caret is on top")
        XCTAssertTrue(window.firstResponder === tv, "re-stacking leaves the keyboard where it was")
        XCTAssertGreaterThanOrEqual(try db.list().first { $0.id == a }!.z, (clock.timeIntervalSince1970 * 1000).rounded(.down))
        // Escape in a card: the keyboard goes back to the window, before the editor sees it.
        XCTAssertFalse(controller.monitors.isEmpty, "the key monitor is in while the overlay is in a window")
        XCTAssertFalse(controller.handleKey(key("a", 0)))
        XCTAssertTrue(controller.handleKey(key("\u{1b}", 53)))
        XCTAssertFalse((window.firstResponder as? NSView)?.isDescendant(of: cardA) == true)
        XCTAssertFalse(controller.handleKey(key("\u{1b}", 53)), "with the keyboard elsewhere Escape is the window's")
    }

    func testCopyNoteAndLinks() async throws {
        let id = try seed("# **Revisit** the migration\nmore")
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        card.copyButton.press()
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "# **Revisit** the migration\nmore")
        XCTAssertEqual(card.copyButton.parts, [.icon(PostItLook.check)], "a check for 1.4 s")
        await wait(1.6)
        XCTAssertEqual(card.copyButton.parts, [.icon(PostItLook.copy)])
        card.noteButton.press()
        await wait { card.noteButton.words == "Opened" }
        XCTAssertEqual(data.notes.first?.name, "Revisit the migration")
        XCTAssertEqual(data.notes.first?.text, "# **Revisit** the migration\nmore")
        XCTAssertEqual(opened.first?.0, project)
        XCTAssertEqual(opened.first?.2, "Revisit the migration")
        XCTAssertEqual(card.noteButton.words, "Opened")
        XCTAssertNotNil(controller.card(id), "the card stays")
        // A card with no words: the first free Untitled Note n.
        try "x".write(toFile: (dir as NSString).appendingPathComponent("Untitled Note 1.md"), atomically: true, encoding: .utf8)
        card.docEditor(card.editor, changed: "")
        _ = try await controller.toNote(controller.entry(id)!)
        XCTAssertEqual(data.notes.last?.name, "Untitled Note 2")
        card.docEditor(card.editor, openLink: "https://example.com", newTab: false, sections: nil)
        card.docEditor(card.editor, openLink: "file:///etc/hosts", newTab: false, sections: nil)
        XCTAssertEqual(links, ["https://example.com/"])
        XCTAssertEqual(errors.last, "URL protocol must be http or https")
    }

    func testThePictureOfACard() async throws {
        let id = try seed("", nx: 0, ny: 0)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        let rep = pixels(card)
        near(color(rep, 5, 5), "#fff2a0")
        near(color(rep, 130, 130), "#fff2a0", 12)
        near(color(rep, 255, 255), "#fff2a0")
        XCTAssertEqual(card.copyButton.frame, CGRect(x: 10, y: 260 - 30 + 4, width: 22, height: 22))
        XCTAssertEqual(card.buildButton.frame.maxX, 260 - 26, accuracy: 0.5, "the words end 26 from the right")
        XCTAssertEqual(card.noteButton.frame.maxX, card.buildButton.frame.minX - 14, accuracy: 0.5, "14 apart")
        XCTAssertFalse(card.buildButton.isEnabled, "Build needs words")
        XCTAssertTrue(card.stateButton.isHidden)
        XCTAssertEqual(card.resizeHandle.frame, CGRect(x: 236, y: 236, width: 22, height: 22))
        XCTAssertEqual(card.editor.frame.minX, 16)
        XCTAssertEqual(card.editor.frame.minY, 14)
        XCTAssertEqual(card.editor.frame.height, 260 - 44)
        XCTAssertTrue(card.editor.compact)
        XCTAssertEqual(card.textView?.accessibilityLabel(), "Sticky")
        XCTAssertEqual(card.textView?.drawsBackground, false, "the editor draws on the yellow")
        // The self-test driver finds the card and its controls by their data-* names.
        let ids = DriveRegistry.ids(in: [window])
        for name in ["post-its", "post-it=\(id)", "copy-post-it", "note-post-it", "build-post-it", "resize-post-it"] { XCTAssertTrue(ids.contains(name), name) }
        // Off the cards, presses reach the workspace.
        XCTAssertNil(hit(CGPoint(x: 900, y: 700)))
    }

    func testTheFootersWordsTheHandleThePlaceholderAndTheErrorBox() async throws {
        let id = try seed("", nx: 0, ny: 0)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        XCTAssertEqual(card.placeholder.frame.origin, CGPoint(x: 16, y: 18), "16 in, 4 below the head")
        XCTAssertEqual(card.placeholder.textColor, PostItLook.placeholder)
        XCTAssertEqual(card.noteButton.color, PostItLook.word, "brown on the yellow")
        card.noteButton.hovering = true
        XCTAssertEqual(card.noteButton.color, PostItLook.ink, "ink under the pointer")
        card.noteButton.hovering = false
        XCTAssertEqual(card.noteButton.gap, 5)
        XCTAssertEqual(card.noteButton.frame.height, 22)
        card.setBuild(BuildBrief(id: "abcdef0123", status: "running"))
        XCTAssertEqual(card.stateButton.color, PostItLook.ink, "a state that asks for attention is ink")
        XCTAssertEqual(card.stateButton.gap, 6)
        let dots = try XCTUnwrap(card.stateButton.subviews.compactMap { $0 as? PostItDots }.first)
        XCTAssertEqual(dots.frame.size, CGSize(width: 18, height: 6))
        let anims = dots.layer!.sublayers!.compactMap { $0.animation(forKey: "pdot") as? CAAnimationGroup }
        XCTAssertEqual(anims.count, 3)
        XCTAssertEqual(anims.map(\.duration), [1.1, 1.1, 1.1])
        XCTAssertEqual(anims[2].beginTime - anims[0].beginTime, 0.3, accuracy: 0.01, "they rise in turn")
        let long = BuildBrief(id: "abcdef0123", status: "running", kind: "build", workspace: String(repeating: "Long name ", count: 10))
        card.setBuild(long)
        XCTAssertEqual(card.stateButton.width(of: .word(long.word)), 120, "a workspace's name is cut at 120")
        // The handle's glyph only under the pointer.
        let quiet = pixels(card.resizeHandle)
        XCTAssertTrue((0..<quiet.w).allSatisfy { x in (0..<quiet.h).allSatisfy { y in quiet.rgb(x, y).r > 200 } }, "nothing drawn at rest")
        card.resizeHandle.hovering = true
        let shown = pixels(card.resizeHandle)
        XCTAssertTrue((0..<shown.w).contains { x in (0..<shown.h).contains { y in shown.rgb(x, y).r < 220 } }, "the glyph under the pointer")
        // A failed save: a white box 12 from the sides, its bottom 30 above the card's.
        card.setError("disk full")
        XCTAssertEqual(card.errorBox.frame.minX, 12)
        XCTAssertEqual(card.errorBox.frame.maxX, 260 - 12)
        XCTAssertEqual(card.errorBox.frame.maxY, 260 - 30)
        XCTAssertLessThanOrEqual(card.errorBox.frame.height, 80)
        // While a card is held, every press over it is its own.
        card.press = (.zero, false, .drag)
        XCTAssertTrue(hit(CGPoint(x: card.frame.minX + 21, y: card.frame.maxY - 15)) === card)
        card.press = nil
    }

    func testBlockingRectsMoveCardsAsideButCoveringOnesDoNot() async throws {
        let id = try seed("x", nx: 0, ny: 0)
        await activate()
        let card = try XCTUnwrap(controller.card(id))
        try controller.setBlocking([BlockRect(PRect(x: 0, y: 0, width: 100, height: 100), cover: true)])
        XCTAssertFalse(card.isHidden, "a covering panel draws over the card")
        try controller.setBlocking([BlockRect(PRect(x: 0, y: 0, width: 100, height: 100))])
        XCTAssertTrue(card.isHidden, "a menu over it moves it aside")
        try controller.setBlocking([BlockRect(PRect(x: 600, y: 600, width: 100, height: 100))])
        XCTAssertFalse(card.isHidden)
        XCTAssertThrowsError(try controller.setBlocking([BlockRect(PRect(x: 0, y: 0, width: -1, height: 1))]))
    }

    func testAGestureEndsWhenTheWindowLosesTheKeyboard() async throws {
        let id = try seed("x", nx: 0.5, ny: 0.5)
        await activate()
        controller.trashRect = PRect(x: 20, y: 700, width: 200, height: 40)
        let card = try XCTUnwrap(controller.card(id))
        let home = card.frame
        drag(from: CGPoint(x: home.midX, y: home.minY + 200), to: CGPoint(x: 150, y: 710), release: false)
        XCTAssertTrue(controller.drag.active)
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
        XCTAssertEqual(card.frame, home, "back where it was")
        XCTAssertFalse(card.overTrash)
        XCTAssertNil(card.crumple)
        XCTAssertFalse(controller.drag.active)
    }
}

/// Two windows on one project (test/windows.test.cjs): each has its own cards; what one saves reaches the other.
@MainActor
final class PeerTests: PostItsTestCase {
    func testACardSavedInOneWindowShowsInEveryOther() async throws {
        let (w2, b) = makeWindow(); extraWindows.append((w2, b))
        await activate()
        await activate(b)
        let id = try await controller.create()
        XCTAssertNotNil(b.card(id), "the other window on the project shows the new card too")
        // Typed in A: B's card gets the text, and its next save carries it.
        let cardA = controller.card(id)!, cardB = b.card(id)!
        cardA.docEditor(cardA.editor, changed: "from window A")
        XCTAssertEqual(b.row(id)?.text, "from window A")
        XCTAssertEqual(cardB.text, "from window A")
        // B moves it; A's row follows, so A never writes the old place back with its next save.
        let from = CGPoint(x: cardB.frame.midX, y: cardB.frame.minY + 200)
        drag(from: from, to: CGPoint(x: from.x + 300, y: from.y + 200), c: b, w: w2)
        XCTAssertEqual(cardA.frame, cardB.frame, "the card stands where it was put in both windows")
        cardA.docEditor(cardA.editor, changed: "again from A")
        let row = try XCTUnwrap(try db.list().first)
        XCTAssertEqual(row.text, "again from A")
        XCTAssertNotEqual(row.nx, 0.22, "B's move was kept by A's later save")
        // Thrown away in B: gone from A, and A's trash counts it.
        do { let ok = try await b.throwOut(id); XCTAssertTrue(ok) }
        XCTAssertNil(controller.card(id))
        XCTAssertEqual(controller.trashCount, 1)
        // Back out of the trash in A: back in B.
        do { let ok = try await controller.restore(id); XCTAssertTrue(ok) }
        XCTAssertNotNil(b.card(id))
        // A window let go: the others stop telling it.
        b.dispose()
        _ = try await controller.create()
        XCTAssertEqual(b.cards.count, 1)
    }

    func testAnotherProjectsChangesAreNotHeard() async throws {
        let other = "22222222-2222-4222-8222-222222222222"
        let otherDir = (NSTemporaryDirectory() as NSString).appendingPathComponent("engelbart-post-its-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: otherDir, withIntermediateDirectories: true)
        defer { NotesDB.close(projectDir: otherDir); try? FileManager.default.removeItem(atPath: otherDir) }
        data.dirs[other] = otherDir
        let (w2, b) = makeWindow(); extraWindows.append((w2, b))
        await activate()
        await b.activate(other)
        _ = try await controller.create()
        XCTAssertTrue(b.cards.isEmpty)
    }
}
