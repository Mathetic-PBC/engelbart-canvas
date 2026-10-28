import XCTest
import EngelbartCore
import EngelbartStore
import EngelbartDoc
import EngelbartBuild
@testable import EngelbartPostIts

/// test/post-its.test.cjs (geometry, the trash week, noteName) and the pure parts of the post-it panels.
final class GeometryTests: XCTestCase {
    typealias G = PostItGeometry

    func testWindowClampingPreservesPreferredGeometryAndScalesWithZoom() {
        let layout = CardLayout(nx: 1, ny: 1, width: 600, height: 500)
        XCTAssertEqual(G.cardBounds(layout, viewport: CGSize(width: 400, height: 300)), PRect(x: 8, y: 56, width: 384, height: 236))
        XCTAssertEqual(layout, CardLayout(nx: 1, ny: 1, width: 600, height: 500), "the preferred layout is never written back")
        XCTAssertEqual(G.cardBounds(layout, viewport: CGSize(width: 1200, height: 900)), PRect(x: 592, y: 392, width: 600, height: 500))
        let normal = G.cardBounds(CardLayout(nx: 0.5, ny: 0.5, width: 300, height: 240), viewport: CGSize(width: 1000, height: 800))
        XCTAssertEqual(G.cardBounds(CardLayout(nx: 0.5, ny: 0.5, width: 300, height: 240), viewport: CGSize(width: 2000, height: 1600), zoom: 2),
                       PRect(x: normal.x * 2, y: normal.y * 2, width: 600, height: 480))
        XCTAssertEqual(G.layoutFromBounds(PRect(x: 592, y: 392, width: 600, height: 500), viewport: CGSize(width: 1200, height: 900)), layout)
    }

    func testThrownAwayOverTheTrashAsMeasuredAtAnyZoom() throws {
        let can = try G.trashRect(PRect(x: 40, y: 800, width: 72, height: 72))
        XCTAssertTrue(G.inTrash(CGPoint(x: 60, y: 820), can))
        XCTAssertFalse(G.inTrash(CGPoint(x: 30, y: 820), can), "left of the can")
        XCTAssertFalse(G.inTrash(CGPoint(x: 60, y: 880), can), "under the can")
        XCTAssertTrue(G.inTrash(CGPoint(x: 120, y: 1640), can, zoom: 2), "window points are the rect times the zoom")
        XCTAssertFalse(G.inTrash(CGPoint(x: 60, y: 820), nil), "no workspace on screen: no trash")
        XCTAssertNil(try G.trashRect(nil))
        XCTAssertThrowsError(try G.trashRect(PRect(x: 0, y: 0, width: .nan, height: 10))) { XCTAssertEqual(($0 as? GeometryError)?.message, "Invalid trash rect") }
        XCTAssertThrowsError(try G.trashRect(PRect(x: 0, y: 0, width: 0, height: 10)))
    }

    func testCrumplesNearingTheTrashAndSlidesClearOfTheCan() {
        let can = PRect(x: 40, y: 800, width: 72, height: 72)
        XCTAssertEqual(G.crumpleAmount(CGPoint(x: 76, y: 836), can), 1, "over the can")
        XCTAssertEqual(G.crumpleAmount(CGPoint(x: 112 + G.REACH + 1, y: 836), can), 0, "out of reach")
        let mid = G.crumpleAmount(CGPoint(x: 112 + G.REACH / 2, y: 836), can)
        XCTAssertTrue(mid > 0 && mid < 1)
        XCTAssertEqual(G.crumpleAmount(CGPoint(x: 76, y: 836), nil), 0, "no can on screen")
        let size = CGSize(width: 260, height: 260), grab = CGPoint(x: 0.5, y: 0.1)
        let far = G.draggedBounds(point: CGPoint(x: 600, y: 300), grab: grab, size: size, t: 0, rect: can)
        XCTAssertEqual(far.scale, 1)
        XCTAssertEqual(far.bounds, PRect(x: 470, y: 274, width: 260, height: 260), "the grabbed spot stays under the pointer")
        let over = G.draggedBounds(point: CGPoint(x: 76, y: 836), grab: grab, size: size, t: 1, rect: can)
        XCTAssertEqual(over.scale, G.SMALLEST)
        XCTAssertEqual(over.bounds.width, (260 * G.SMALLEST).rounded())
        XCTAssertGreaterThanOrEqual(over.bounds.x, can.x + can.width, "the crumpled card does not cover the can")
        let zoomed = G.draggedBounds(point: CGPoint(x: 152, y: 1672), grab: grab, size: CGSize(width: 520, height: 520), t: 1, rect: can, zoom: 2)
        XCTAssertGreaterThanOrEqual(zoomed.bounds.x, (can.x + can.width) * 2, "the can is in CSS px, the card in points")
    }

    func testGrowingKeepsTopEdgeUntilTheBottomStopsItOverlapsAndBlockingRects() throws {
        let vp = CGSize(width: 1200, height: 900)
        let row = CardLayout(nx: 0.5, ny: 0.2, width: 260, height: 260)
        let before = G.cardBounds(row, viewport: vp)
        let after = G.cardBounds(G.grown(row, height: 400, viewport: vp), viewport: vp)
        XCTAssertEqual([after.x, after.y, after.height], [before.x, before.y, 400])
        let low = CardLayout(nx: 0.5, ny: 1, width: 260, height: 260)
        let pushed = G.cardBounds(G.grown(low, height: 500, viewport: vp), viewport: vp)
        XCTAssertEqual(pushed.y + pushed.height, 900 - 8, "at the bottom it grows upwards")
        XCTAssertEqual(G.grown(row, height: 5000, viewport: vp).height, G.tallest(viewport: vp), "never taller than the window allows")
        XCTAssertFalse(G.overlaps(PRect(x: 0, y: 0, width: 10, height: 10), PRect(x: 10, y: 0, width: 5, height: 5)), "touching is not overlapping")
        XCTAssertTrue(G.overlaps(PRect(x: 0, y: 0, width: 10, height: 10), PRect(x: 9, y: 9, width: 5, height: 5)))
        XCTAssertEqual(try G.blockingRects([]), [])
        let r = PRect(x: 1, y: 2, width: 3, height: 4)
        XCTAssertEqual(try G.blockingRects([BlockRect(r, cover: true), BlockRect(r)]), [BlockRect(r, cover: true), BlockRect(r)])
        XCTAssertThrowsError(try G.blockingRects(Array(repeating: BlockRect(PRect(x: 0, y: 0, width: 1, height: 1)), count: 65))) {
            XCTAssertTrue(($0 as? GeometryError)?.message.contains("at most 64") == true)
        }
    }

    func testLayoutFromBoundsClampsSizesAndPlaces() {
        let vp = CGSize(width: 1000, height: 800)
        let tiny = G.layoutFromBounds(PRect(x: -50, y: 2000, width: 50, height: 20), viewport: vp)
        XCTAssertEqual(tiny.nx, 0); XCTAssertEqual(tiny.ny, 1)
        XCTAssertEqual(tiny.width, 180); XCTAssertEqual(tiny.height, 140)
        XCTAssertEqual(G.tallest(viewport: CGSize(width: 100, height: 100)), 140)
    }
}

final class WordsTests: XCTestCase {
    func testNoteNameIsTheCardsFirstWords() {
        XCTAssertEqual(PostItWords.noteName("# **Revisit** the migration\nmore"), "Revisit the migration")
        XCTAssertEqual(PostItWords.noteName("\n\n- [ ] call [Sydney](https://x.y) about `fellowship`"), "call Sydney about fellowship")
        XCTAssertEqual(PostItWords.noteName("```\ncode first\n```\nthen words"), "then words")
        XCTAssertNil(PostItWords.noteName("   \n![Attachment 1](img:abc)\n"))
        XCTAssertNil(PostItWords.noteName(""))
        let long = PostItWords.noteName(String(repeating: "word ", count: 30))!
        XCTAssertTrue(long.utf16.count <= 60 && !long.hasSuffix(" "))
        XCTAssertEqual(PostItWords.noteName("1. see @[Thesis](ws:abc) and @[Paper]"), "see Thesis and Paper")
        XCTAssertEqual(PostItWords.noteName("> ~~old~~ __new__"), "old new")
    }

    func testTimeLeftAndPreview() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let day = 24 * 60 * 60.0
        XCTAssertEqual(PostItWords.timeLeft(now.addingTimeInterval(7 * day), now: now), "deleted in 7 days")
        XCTAssertEqual(PostItWords.timeLeft(now.addingTimeInterval(1.5 * day), now: now), "deleted in 2 days")
        XCTAssertEqual(PostItWords.timeLeft(now.addingTimeInterval(0.5 * day), now: now), "deleted within a day")
        XCTAssertEqual(PostItWords.timeLeft(now.addingTimeInterval(-day), now: now), "deleted within a day")
        XCTAssertEqual(PostItWords.preview("# Head\n\n- [x] **done** thing\n> `quote`\nfourth"), "Head · done thing · quote")
        XCTAssertEqual(PostItWords.preview("  \n"), "")
    }

    func testLinksGoToTheStageOnlyOverHttp() throws {
        XCTAssertEqual(try PostItWords.externalURL("https://example.com"), "https://example.com/")
        XCTAssertEqual(try PostItWords.externalURL("http://Example.com/a?b=1#c"), "http://example.com/a?b=1#c")
        XCTAssertThrowsError(try PostItWords.externalURL("file:///etc/passwd"))
        XCTAssertThrowsError(try PostItWords.externalURL("javascript:alert(1)"))
        XCTAssertThrowsError(try PostItWords.externalURL(""))
        XCTAssertThrowsError(try PostItWords.externalURL("https://" + String(repeating: "a", count: 5000)))
    }
}

final class BriefTests: XCTestCase {
    func testTheStateOnACard() {
        XCTAssertTrue(BuildBrief.idle(nil))
        let word = { (status: String) in BuildBrief(id: "abcdef0123", status: status).word }
        XCTAssertEqual(word("discarded"), "")
        XCTAssertEqual(word("accepted"), "Merged")
        for s in ["setting-up", "queued", "running", "accepting"] { XCTAssertEqual(word(s), "Building", s) }
        XCTAssertEqual(word("stopped"), "Stopped"); XCTAssertEqual(word("interrupted"), "Stopped")
        for s in ["escalated", "needs-you", "failed", "review", "conflict"] { XCTAssertEqual(word(s), "Needs you", s) }
        let merged = BuildBrief(id: "abcdef0123", status: "accepted")
        XCTAssertTrue(BuildBrief.idle(merged)); XCTAssertTrue(merged.disabled); XCTAssertFalse(merged.strong)
        let running = BuildBrief(id: "abcdef0123", status: "running")
        XCTAssertFalse(BuildBrief.idle(running)); XCTAssertTrue(running.strong); XCTAssertTrue(running.isWorking)
        let moved = BuildBrief(id: "abcdef0123", status: "running", kind: "build", workspace: "Thesis")
        XCTAssertEqual(moved.word, "Thesis"); XCTAssertFalse(moved.strong); XCTAssertTrue(moved.moved)
        let movedMerged = BuildBrief(id: "abcdef0123", status: "accepted", kind: "build", workspace: "Thesis")
        XCTAssertFalse(BuildBrief.idle(movedMerged), "a merged task added to a workspace keeps its workspace's name, not Build")
        XCTAssertFalse(movedMerged.disabled)
    }

    func testTheTaskCardsWords() {
        XCTAssertEqual(QuickTaskText.message(status: "stopped", error: nil), QuickTaskText.STOPPED)
        XCTAssertEqual(QuickTaskText.message(status: "failed", error: "Git refused."), "This task failed: Git refused. Add it to a workspace below to continue.")
        XCTAssertEqual(QuickTaskText.message(status: "failed", error: nil), "This task failed. Add it to a workspace below to continue.")
        XCTAssertTrue(QuickTaskText.message(status: "conflict", error: nil).contains("could not be merged"))
        XCTAssertEqual(QuickTaskText.message(status: "escalated", error: nil), QuickTaskText.TOO_BIG)
        XCTAssertEqual(QuickTaskText.activity(status: "setting-up", progress: nil), "Setting up its copy of the code")
        XCTAssertEqual(QuickTaskText.activity(status: "queued", progress: ""), "Waiting for a slot")
        XCTAssertEqual(QuickTaskText.activity(status: "running", progress: nil), "Working")
        XCTAssertEqual(QuickTaskText.activity(status: "running", progress: "Reading Card.jsx"), "Reading Card.jsx")
        XCTAssertEqual(QuickTaskText.word("accepting"), "Building")
    }
}

final class PickTests: XCTestCase {
    let models = BuildChoices.defaults

    func testEffortForAndLabels() {
        XCTAssertEqual(ModelPick.providerOf(models, "sol"), "openai")
        XCTAssertEqual(ModelPick.providerOf(models, "nope"), models.provider)
        XCTAssertEqual(ModelPick.effortFor(models, "opus"), "high", "the provider's default step")
        XCTAssertEqual(ModelPick.effortFor(models, "sonnet"), "high", "another model starts on the first step's effort")
        XCTAssertEqual(ModelPick.effortFor(models, "sonnet", efforts: ["sonnet": "max"]), "max", "the effort it was last given")
        XCTAssertEqual(ModelPick.effortFor(models, "sonnet", efforts: ["sonnet": "ultra"]), "high", "one the provider does not offer is ignored")
        XCTAssertEqual(ModelPick.choiceLabel(models, ModelChoice(provider: "anthropic", model: "opus", effort: "xhigh")), "Opus Extra high")
        XCTAssertEqual(ModelPick.choiceLabel(models, ModelChoice(provider: "openai", model: "opus", effort: "high")), "")
        XCTAssertEqual(ModelPick.choiceLabel(nil, nil), "")
    }

    func testStartingChoiceHandsAnOldPickToMainOnce() {
        let defaults = UserDefaults(suiteName: "postits-pick-\(UUID().uuidString)")!
        let memory = PickMemory(defaults: defaults)
        var remembered: [ModelChoice] = []
        XCTAssertEqual(ModelPick.startingChoice(models, kept: memory) { remembered.append($0) }, ModelChoice(provider: "anthropic", model: "opus", effort: "high"))
        XCTAssertTrue(remembered.isEmpty)
        memory.write(["provider": "openai", "model": "luna", "effort": "ultra", "efforts": ["luna": "ultra"]])
        XCTAssertEqual(ModelPick.startingChoice(models, kept: memory) { remembered.append($0) }, ModelChoice(provider: "openai", model: "luna", effort: "ultra"))
        XCTAssertEqual(remembered, [ModelChoice(provider: "openai", model: "luna", effort: "ultra")])
        XCTAssertNil(memory.read()?["provider"], "dropped once handed on")
        XCTAssertEqual(memory.efforts, ["luna": "ultra"], "the efforts stay")
        memory.write(["provider": "openai", "model": "gone", "effort": "high"])
        XCTAssertEqual(ModelPick.startingChoice(models, kept: memory) { remembered.append($0) }.model, "opus", "a pick no longer offered: main's")
    }
}

final class ListTests: XCTestCase {
    func testFlatAndFoundWorkspaces() {
        let all = PostItLists.flatWorkspaces([
            .init(id: "a", name: "Thesis", children: [.init(id: "b", name: "Chapter one", children: [.init(id: "c", name: "Figures")])]),
            .init(id: "d", name: "Reading thesis notes"),
        ])
        XCTAssertEqual(all.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(all[2].above, ["Thesis", "Chapter one"])
        XCTAssertEqual(PostItLists.findWorkspaces(all, "thesis").map(\.id), ["a", "d"])
        XCTAssertEqual(PostItLists.findWorkspaces(all, "notes thesis").map(\.id), ["d"])
        XCTAssertEqual(PostItLists.findWorkspaces(all, "one").map(\.id), ["b"])
        XCTAssertEqual(PostItLists.findWorkspaces(all, "re").map(\.id), ["d", "c"], "names starting with the first word first")
        XCTAssertEqual(PostItLists.findWorkspaces(all, "  "), [])
    }

    func testAttachRows() {
        let t = { (s: Double) in Date(timeIntervalSince1970: s) }
        let library = [
            PickRow(row: LibRow(id: "1", name: "Paper on testing", type: "pdf", tags: ["paper"]), lastEdited: t(10)),
            PickRow(row: LibRow(id: "2", name: "Notes", type: "md", tags: ["note"], summary: "about testing"), lastEdited: t(30)),
            PickRow(row: LibRow(id: "3", name: "A picture", type: "image"), lastEdited: t(40)),
            PickRow(row: LibRow(id: "4", name: "Testing repo", type: "folder", tags: ["git"], url: "https://github.com/a/b"), lastEdited: t(20)),
            PickRow(row: LibRow(id: "5", name: "Draft", type: "md", tags: ["note"]), lastEdited: t(5)),
        ]
        XCTAssertEqual(PostItLists.attachRows(query: "", library: library).map(\.id), ["2", "4", "1", "5"], "newest first, never a picture")
        XCTAssertEqual(PostItLists.attachRows(query: "testing", library: library).map(\.id), ["4", "2", "1"], "names starting with it first, then newest")
        XCTAssertEqual(PostItLists.attachRows(query: "github", library: library).map(\.id), ["4"], "the address counts")
        XCTAssertEqual(PostItLists.attachRows(query: "draft words", library: library, bodies: ["5": "Some WORDS here"]).map(\.id), ["5"], "what it says, after the rest")
        XCTAssertEqual(PostItLists.attachRows(query: "", library: library, taken: ["2"]).map(\.id), ["4", "1", "5"])
        let many = (0..<12).map { PickRow(row: LibRow(id: "\($0)", name: "n\($0)", type: "md"), lastEdited: t(Double($0))) }
        XCTAssertEqual(PostItLists.attachRows(query: "", library: many).count, PostItLists.ATTACH_RECENT)
    }
}

/// The trash keeps a card restorable for a week, then purges it (2026-09-22); cards survive reopening and stay in their
/// project; a late save of a thrown card leaves it in the trash (test/post-its.test.cjs, on the Store's NotesDB).
final class TrashWeekTests: XCTestCase {
    func temp() throws -> String {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("engelbart-post-its-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        addTeardownBlock { NotesDB.close(projectDir: dir); try? FileManager.default.removeItem(atPath: dir) }
        return dir
    }
    let v = { (text: String, z: Double) in PostItValues(text: text, nx: 0.1, ny: 0.1, width: 260, height: 260, z: z) }

    func testCardsSurviveReopeningAndStayInTheirProject() throws {
        let a = try temp(), b = try temp()
        let id = IDs.new()
        let one = try NotesDB.open(projectDir: a).postIts
        try one.create(id: id, PostItValues(text: "", nx: 0.5, ny: 0.25, width: 300, height: 240, z: 1))
        try one.update(id: id, PostItValues(text: "**Keep this**\n- across launches", nx: 0.9, ny: 0.8, width: 420, height: 320, z: 2))
        XCTAssertEqual(try NotesDB.open(projectDir: b).postIts.list().count, 0)
        XCTAssertEqual(try NotesDB.open(projectDir: a).list().count, 0, "post-its are not ordinary titled notes")
        NotesDB.close(projectDir: a)
        let card = try XCTUnwrap(try NotesDB.open(projectDir: a).postIts.list().first)
        XCTAssertEqual([card.text], ["**Keep this**\n- across launches"])
        XCTAssertEqual([card.nx, card.ny, card.width, card.height, card.z], [0.9, 0.8, 420, 320, 2])
        let again = try NotesDB.open(projectDir: a).postIts
        XCTAssertThrowsError(try again.update(id: id, PostItValues(text: "", nx: 0.1, ny: 0.1, width: .nan, height: 240, z: 1)))
        XCTAssertThrowsError(try again.update(id: id, PostItValues(text: "", nx: 2, ny: 0.1, width: 300, height: 240, z: 1)))
        XCTAssertThrowsError(try again.update(id: id, PostItValues(text: String(repeating: "x", count: 400_001), nx: 0.1, ny: 0.1, width: 300, height: 240, z: 1)))
        XCTAssertTrue(try again.remove(id))
        XCTAssertNil(try again.update(id: id, v("late", 1)), "deletion cannot be undone by a late save")
    }

    func testTheTrashKeepsACardForAWeek() throws {
        let dir = try temp()
        let db = try NotesDB.open(projectDir: dir)
        let p = db.postIts
        let ids = [IDs.new(), IDs.new(), IDs.new()]
        for (i, id) in ids.enumerated() { try p.create(id: id, v("card \(i + 1)", Double(i + 1))) }
        XCTAssertNotNil(try p.trash(ids[0]))
        XCTAssertNil(try p.trash(ids[0]), "already in the trash")
        XCTAssertEqual(try p.list().map(\.id), [ids[1], ids[2]])
        XCTAssertEqual(try p.trashed().map(\.id), [ids[0]])
        try p.update(id: ids[0], v("last words", 1))
        XCTAssertEqual(try p.trashed()[0].text, "last words", "a late save of a trashed card keeps its text and leaves it in the trash")
        XCTAssertEqual(try p.purge(before: Date().addingTimeInterval(-7 * 86400)), 0, "thrown away just now: kept")
        XCTAssertNotNil(try p.restore(ids[0]))
        XCTAssertEqual(Set(try p.list().map(\.id)), Set(ids))
        try p.trash(ids[1]); try p.trash(ids[0])
        // Backdate the throw, as a week passing would.
        _ = try db.db.run("update post_its set deleted = ? where id = ?", [.text(Time.iso(Date().addingTimeInterval(-8 * 86400))), .text(ids[1])])
        XCTAssertEqual(try p.purge(before: Date().addingTimeInterval(-7 * 86400)), 1, "a week and a day in the trash: gone")
        XCTAssertEqual(try p.trashed().map(\.id), [ids[0]])
    }
}
